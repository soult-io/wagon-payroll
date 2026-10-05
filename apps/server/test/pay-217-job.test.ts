/**
 * PAY-217 T-21 .. T-23 + R4 — the daily job syncFormerEmployeeLogins.
 * payroll-calc-auditor, fail-first against faad1d9; the coder may not edit
 * this file. Synthetic data only. Legal source + oracle dates:
 * pay-217-harness.ts (TY2026 -> 2027-10-15; corrected 2027-11-10 -> 2028-02-08).
 *
 * Contract assumed (brief §4.4 + SME R4; module per pay-217-harness.ts
 * formerModule(): apps/server/src/auth/former-employee.ts):
 *  - syncFormerEmployeeLogins({ db, config }, { today?, restoreTerminatedBans? })
 *    for every terminated employee with a login, company-local today:
 *      access none, not banned      -> ban "w2_access_ended", delete sessions,
 *                                      auth_events user_disabled, audit
 *                                      employee.w2_access_ended (actor null,
 *                                      after { banReason: "w2_access_ended" })
 *      access none, banned          -> no change (any reason)
 *      access w2_only, banned "w2_access_ended" -> unban, user_enabled,
 *                                      audit employee.w2_access_restored
 *                                      (SME R4: a correction after the window
 *                                      closed re-opens sign-in; independent of OD-1)
 *      access w2_only, banned "employee_terminated" -> OD-1: unban when
 *                                      restoreTerminatedBans is true, else no change
 *      lockout / pending_enrollment -> never lifted
 *    Idempotent; one failing employee is skipped; logs carry no address,
 *    name or user id.
 *  - OD-1 is UNDECIDED (owner): `restoreTerminatedBans` defaults to the
 *    exported constant RESTORE_TERMINATED_BANS (boolean) that Neil's answer
 *    sets; these tests pass the option explicitly for both answers and do
 *    not assume the default.
 *  - annualTick runs the job after reconcileW2Furnishings (so a correction
 *    posted in the same tick re-opens sign-in the same day).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reconcileW2Furnishings } from "../src/filings/w2-furnish.js";
import { annualTick } from "../src/payroll/scheduler.js";
import {
  auditFor,
  authEventCount,
  boot217,
  consenter,
  deps,
  type Emp,
  type Env,
  formerModule,
  furnishings,
  IMPORTANT,
  me,
  mustSignIn,
  need,
  outbox,
  sessionCount,
  setBan,
  signIn,
  terminate,
  userRow,
  yearNotice,
  moveTo,
} from "./pay-217-harness.js";
import { insertRun } from "./w2-state-harness.js";

const JAN_4_2027 = "2027-01-04T16:00:00Z";
const FEB_1_2027 = "2027-02-01T16:00:00Z";

async function sync(env: Env, today: string, restoreTerminatedBans: boolean) {
  const fn = need(await formerModule(), "syncFormerEmployeeLogins");
  return fn({ db: env.t.db, config: env.t.config }, { today, restoreTerminatedBans });
}

async function changeFigures(env: Env, employeeId: number) {
  await insertRun(env as never, employeeId, {
    payDate: "2026-12-31",
    periodStart: "2026-12-31",
    periodEnd: "2026-12-31",
    grossCents: 100_000,
    fitCents: 10_000,
    state: null,
  } as never);
}

/** Former employee: TY2026 online on 2027-01-04, terminated 2027-02-01 (route). */
async function formers(env: Env, labels: string[]): Promise<Record<string, Emp>> {
  const out: Record<string, Emp> = {};
  for (const l of labels) out[l] = await consenter(env, l);
  await yearNotice(env);
  await moveTo(env, FEB_1_2027);
  for (const l of labels) await terminate(env, out[l]!, "2027-01-29");
  return out;
}

async function state(env: Env, x: Emp) {
  return {
    ...(await userRow(env, x.userId!)),
    sessions: await sessionCount(env, x.userId!),
    disabled: await authEventCount(env, x.userId!, "user_disabled"),
    enabled: await authEventCount(env, x.userId!, "user_enabled"),
    ended: (await auditFor(env, "employee.w2_access_ended", x.id)).length,
    restored: (await auditFor(env, "employee.w2_access_restored", x.id)).length,
  };
}

describe("PAY-217 T-21 window closed: the job bans w2_access_ended once", () => {
  let env: Env;
  let e: Record<string, Emp>;
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    e = await formers(env, ["Jb21", "Jb21tick"]);
  }, 300_000);
  afterAll(async () => env.close());

  it("T-21 on 2027-10-16: ban w2_access_ended, sessions deleted, one user_disabled event, one audit row (actor null, banReason only); a second run writes nothing; sign-in refused", async () => {
    await moveTo(env, "2027-10-15T15:00:00Z");
    await mustSignIn(env, e.Jb21!);
    await moveTo(env, "2027-10-16T15:00:00Z");
    await sync(env, "2027-10-16", false);
    const first = await state(env, e.Jb21!);
    const audit = (await auditFor(env, "employee.w2_access_ended", e.Jb21!.id))[0];
    await sync(env, "2027-10-16", false);
    const second = await state(env, e.Jb21!);
    const s = await signIn(env, e.Jb21!.email!);
    expect({
      first,
      audit: audit && { actorId: audit.actorId, after: audit.after },
      secondSame: JSON.stringify(second) === JSON.stringify(first),
      signIn: [s.status, s.code],
    }).toEqual({
      first: {
        banned: true,
        banReason: "w2_access_ended",
        twoFactorEnabled: true,
        sessions: 0,
        disabled: 1,
        enabled: 0,
        ended: 1,
        restored: 0,
      },
      audit: { actorId: null, after: { banReason: "w2_access_ended" } },
      secondSame: true,
      signIn: [403, "BANNED_USER"],
    });
  });

  it("T-21 wiring: annualTick runs the job (2027-10-16)", async () => {
    await moveTo(env, "2027-10-16T16:00:00Z");
    await annualTick({ db: env.t.db, config: env.t.config });
    expect((await userRow(env, e.Jb21tick!.userId!)).banReason).toBe("w2_access_ended");
  });
});

describe("PAY-217 T-22 the job never lifts lockout / pending_enrollment and never touches active employees", () => {
  let env: Env;
  let e: Record<string, Emp>;
  let act: Emp;
  let actLock: Emp;
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    act = await consenter(env, "Jb22act");
    actLock = await consenter(env, "Jb22actlock");
    e = await formers(env, ["Jb22lock", "Jb22pend", "Jb22closedlock"]);
    await setBan(env, e.Jb22lock!.userId!, "lockout");
    await setBan(env, e.Jb22pend!.userId!, "pending_enrollment");
    await setBan(env, e.Jb22closedlock!.userId!, "lockout");
    await setBan(env, actLock.userId!, "lockout");
  }, 300_000);
  afterAll(async () => env.close());

  it("open window (2027-03-01, both OD-1 answers) and closed window (2027-10-16): bans stay as they are, active rows untouched", async () => {
    await moveTo(env, "2027-03-01T17:00:00Z");
    await sync(env, "2027-03-01", true);
    await sync(env, "2027-03-01", false);
    const open = {
      lock: (await userRow(env, e.Jb22lock!.userId!)).banReason,
      pend: (await userRow(env, e.Jb22pend!.userId!)).banReason,
    };
    await moveTo(env, "2027-10-16T15:00:00Z");
    await sync(env, "2027-10-16", true);
    const { sessions: _s, ...activeState } = await state(env, act);
    expect({
      open,
      closedLock: (await userRow(env, e.Jb22closedlock!.userId!)).banReason,
      active: activeState,
      activeLock: (await userRow(env, actLock.userId!)).banReason,
    }).toEqual({
      open: { lock: "lockout", pend: "pending_enrollment" },
      closedLock: "lockout",
      active: {
        banned: false,
        banReason: null,
        twoFactorEnabled: true,
        disabled: 0,
        enabled: 0,
        ended: 0,
        restored: 0,
      },
      activeLock: "lockout",
    });
  });
});

describe("PAY-217 T-23 OD-1 (undecided): a person banned employee_terminated before this release whose window is open", () => {
  let env: Env;
  let e: Record<string, Emp>;
  const logged: string[] = [];
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    // Jb23fail first: it is processed before Jb23 and must not stop it.
    e = await formers(env, ["Jb23fail", "Jb23"]);
    for (const k of ["Jb23fail", "Jb23"]) await setBan(env, e[k]!.userId!, "employee_terminated");
    await env.t.pglite.exec(`
      CREATE OR REPLACE FUNCTION pay217_fail() RETURNS trigger AS $$
      BEGIN
        IF NEW.id = '${e.Jb23fail!.userId}' THEN RAISE EXCEPTION 'synthetic failure'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER pay217_fail BEFORE UPDATE ON "user" FOR EACH ROW EXECUTE FUNCTION pay217_fail();
    `);
    await moveTo(env, "2027-03-01T17:00:00Z");
    for (const m of ["log", "error", "warn", "info"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        logged.push(a.map(String).join(" "));
      });
    }
  }, 300_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await env.close();
  });

  it("the OD-1 constant exists and is a boolean", async () => {
    expect(typeof need(await formerModule(), "RESTORE_TERMINATED_BANS")).toBe("boolean");
  });

  it("OD-1 = no (restoreTerminatedBans false): unchanged", async () => {
    await sync(env, "2027-03-01", false);
    expect(await state(env, e.Jb23!)).toMatchObject({
      banned: true,
      banReason: "employee_terminated",
      enabled: 0,
      restored: 0,
    });
  });

  it("OD-1 = yes (restoreTerminatedBans true): unbanned once (user_enabled + employee.w2_access_restored), W-2 only after sign-in; the failing employee does not stop it; a second run writes nothing; logs name nobody", async () => {
    await sync(env, "2027-03-01", true);
    const first = await state(env, e.Jb23!);
    await sync(env, "2027-03-01", true);
    const second = await state(env, e.Jb23!);
    const s = await signIn(env, e.Jb23!.email!);
    const text = logged.join("\n");
    const leaks = [
      e.Jb23!.email!,
      e.Jb23fail!.email!,
      e.Jb23!.userId!,
      e.Jb23fail!.userId!,
      "Jb23",
      "synthetic failure",
    ].filter((x) => text.includes(x));
    expect({
      first,
      secondSame: JSON.stringify(second) === JSON.stringify(first),
      failing: (await userRow(env, e.Jb23fail!.userId!)).banReason,
      access: s.session
        ? ((await me(env, s.session)).json() as { access?: string }).access
        : `refused ${s.status}`,
      leaks,
    }).toEqual({
      first: {
        banned: false,
        banReason: null,
        twoFactorEnabled: true,
        sessions: 0,
        disabled: 0,
        enabled: 1,
        ended: 0,
        restored: 1,
      },
      secondSame: true,
      failing: "employee_terminated",
      access: "w2_only",
      leaks: [],
    });
  });
});

describe("PAY-217 R4 a correction after the window closed re-opens sign-in (lifts only w2_access_ended)", () => {
  let env: Env;
  let e: Record<string, Emp>;
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    e = await formers(env, ["R4ended", "R4lock", "R4term"]);
    await moveTo(env, "2027-10-16T15:00:00Z");
    // Distinct bans on the closed-window people (set directly so the setup
    // does not depend on the job): w2_access_ended, lockout, employee_terminated.
    await setBan(env, e.R4ended!.userId!, "w2_access_ended");
    await setBan(env, e.R4lock!.userId!, "lockout");
    await setBan(env, e.R4term!.userId!, "employee_terminated");
    for (const k of ["R4ended", "R4lock", "R4term"]) await changeFigures(env, e[k]!.id);
    await moveTo(env, "2027-11-10T18:00:00Z"); // 12:00 CST
  }, 300_000);
  afterAll(async () => env.close());

  it("reconcile on 2027-11-10 posts the correction online (+ IMPORTANT); the job (OD-1 = no) then lifts w2_access_ended only; sign-in -> W-2 only through 2028-02-08", async () => {
    await reconcileW2Furnishings(deps(env), { today: "2027-11-10" });
    await sync(env, "2027-11-10", false);
    const posted = (await furnishings(env, e.R4ended!.id, 2026)).filter(
      (r) => r.method === "portal_notice" && r.corrected,
    );
    const mails = (await outbox(env, e.R4ended!.userId, "w2_changed")).filter((m) =>
      m.subject.startsWith(IMPORTANT),
    );
    const s = await signIn(env, e.R4ended!.email!);
    expect({
      posted: posted.length,
      important: mails.length,
      ended: (await userRow(env, e.R4ended!.userId!)).banReason,
      restoredAudit: (await auditFor(env, "employee.w2_access_restored", e.R4ended!.id)).length,
      lock: (await userRow(env, e.R4lock!.userId!)).banReason,
      term: (await userRow(env, e.R4term!.userId!)).banReason,
      me: s.session ? (await me(env, s.session)).json() : `refused ${s.status} ${s.code}`,
    }).toMatchObject({
      posted: 1,
      important: 1,
      ended: null,
      restoredAudit: 1,
      lock: "lockout",
      term: "employee_terminated",
      me: { access: "w2_only", w2AccessThrough: "2028-02-08" },
    });
  });
});

describe("PAY-217 R4 through annualTick (reconcile, then the job, in one tick)", () => {
  let env: Env;
  let e: Record<string, Emp>;
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    e = await formers(env, ["R4tick"]);
    await moveTo(env, "2027-10-16T15:00:00Z");
    await setBan(env, e.R4tick!.userId!, "w2_access_ended");
    await changeFigures(env, e.R4tick!.id);
    await moveTo(env, "2027-11-10T18:00:00Z");
  }, 300_000);
  afterAll(async () => env.close());

  it("2027-11-10 tick: the correction is posted online and the w2_access_ended ban is lifted", async () => {
    await annualTick({ db: env.t.db, config: env.t.config });
    expect({
      ban: (await userRow(env, e.R4tick!.userId!)).banned,
      corrected: (await furnishings(env, e.R4tick!.id, 2026)).some(
        (r) => r.method === "portal_notice" && r.corrected,
      ),
    }).toEqual({ ban: false, corrected: true });
  });
});

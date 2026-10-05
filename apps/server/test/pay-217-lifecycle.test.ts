/**
 * PAY-217 T-6 .. T-13 — termination, rehire, re-termination, admin reset,
 * unlock and sign-in email change for a former employee.
 * payroll-calc-auditor, fail-first against faad1d9; the coder may not edit
 * this file. Synthetic data only. Legal source + oracle dates:
 * pay-217-harness.ts (TY2026 window 2027-10-15; corrected posting
 * 2027-09-01 -> 2027-11-30).
 *
 * Contract assumed (brief §4.1-§4.6, §6.3):
 *  - POST /api/admin/employees/:id/status {status:"terminated"}: sessions
 *    always deleted; when the person has a year furnished online inside its
 *    window (company-local today) the login is NOT banned, no auth_events
 *    row is written, audit employee.disable after = { status,
 *    terminationDate, w2AccessThrough }; otherwise banned
 *    banReason "employee_terminated" (as today). Response employee +
 *    formerW2Access: { accessThrough, years } | null.
 *  - {status:"active"} (rehire) unbans ONLY banReason employee_terminated /
 *    w2_access_ended; lockout and pending_enrollment stay.
 *  - POST /api/admin/users/:userId/reset and /unlock: 409
 *    { error: "w2_access_ended" } and nothing changed when the user's
 *    employee is terminated with no open window; allowed otherwise, and the
 *    account is W-2-only afterwards.
 *  - PUT /api/admin/employees/:id/sign-in-email: allowed, unchanged (PAY-208).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { employees } from "@payroll/db";
import {
  adminCall,
  auditFor,
  authEventCount,
  consenter,
  correct,
  type Emp,
  type Env,
  errorOf,
  insertFurnishing,
  makeEmp,
  me,
  mustSignIn,
  outbox,
  reloginAdmin,
  resetAndReenroll,
  sessionCount,
  setBan,
  setStatus,
  signIn,
  terminate,
  userRow,
  yearNotice,
  boot217,
  moveTo,
} from "./pay-217-harness.js";
import { insertRun } from "./w2-state-harness.js";

const JAN_4_2027 = "2027-01-04T16:00:00Z";
const FEB_1_2027 = "2027-02-01T16:00:00Z"; // 10:00 CST

type FormerAccess = { accessThrough: string; years: number[] } | null | undefined;

async function profileStatus(env: Env, session: Record<string, string>) {
  const r = await env.t.app.inject({ method: "GET", url: "/api/my/profile", headers: session });
  return [r.statusCode, errorOf(r)];
}

async function access(env: Env, session: Record<string, string>) {
  const r = await me(env, session);
  const b = r.json() as { access?: string; w2AccessThrough?: string };
  return { status: r.statusCode, access: b.access ?? null, through: b.w2AccessThrough ?? null };
}

describe("PAY-217 lifecycle at 2027-02-01 (TY2026 furnished online on 2027-01-04)", () => {
  let env: Env;
  const e: Record<string, Emp> = {};

  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    for (const k of ["t6", "t9", "t9lock", "t9pending", "t11", "t12", "t13"]) {
      e[k] = await consenter(env, `Lc${k}`);
    }
    // T-7: a W-2 employee whose 2026 W-2 never went online (no consent:
    // paper notice) + rows that never count; and a 1099 contractor.
    e.t7 = await makeEmp(env, { label: "Lct7", login: true, years: [2026] });
    e.t7c = await makeEmp(env, { label: "Lct7c", login: true });
    await env.t.db
      .update(employees)
      .set({ employmentType: "1099" })
      .where(eq(employees.id, e.t7c.id));
    e.t11none = await makeEmp(env, { label: "Lct11none", login: true, years: [2026] });
    await yearNotice(env);
    for (const m of ["backfill", "admin_print", "paper_handed"]) {
      await insertFurnishing(env, e.t7.id, 2026, { method: m, at: "2027-01-05T16:00:00Z" });
    }
    await moveTo(env, FEB_1_2027);
  }, 300_000);
  afterAll(async () => env.close());

  it("T-6 terminate with an open window: not banned, sessions deleted, no auth event, audit carries w2AccessThrough; sign-in + TOTP works; /api/me access w2_only through 2027-10-15", async () => {
    const before = await mustSignIn(env, e.t6!);
    const eventsBefore = (
      await env.t.pglite.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM auth_events WHERE user_id = $1",
        [e.t6!.userId],
      )
    ).rows[0]!.n;
    const res = await terminate(env, e.t6!, "2027-01-29");
    const eventsAfter = (
      await env.t.pglite.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM auth_events WHERE user_id = $1",
        [e.t6!.userId],
      )
    ).rows[0]!.n;
    const oldSession = await me(env, before);
    const audit = (await auditFor(env, "employee.disable", e.t6!.id)).at(-1);
    const s = await signIn(env, e.t6!.email!);
    expect({
      formerW2Access: (res.json() as { employee: { formerW2Access?: FormerAccess } }).employee
        .formerW2Access,
      user: await userRow(env, e.t6!.userId!),
      sessionsRightAfter: oldSession.statusCode,
      newAuthEvents: eventsAfter - eventsBefore,
      auditAfter: audit?.after,
      signIn: s.status,
      access: s.session ? await access(env, s.session) : null,
    }).toEqual({
      formerW2Access: { accessThrough: "2027-10-15", years: [2026] },
      user: { banned: false, banReason: null, twoFactorEnabled: true },
      sessionsRightAfter: 401,
      newAuthEvents: 0,
      auditAfter: {
        status: "terminated",
        terminationDate: "2027-01-29",
        w2AccessThrough: "2027-10-15",
      },
      signIn: 200,
      access: { status: 200, access: "w2_only", through: "2027-10-15" },
    });
  });

  it("T-7 terminate with no online row (backfill / admin_print / paper_handed only) or a 1099 contractor: banned employee_terminated, sign-in refused BANNED_USER", async () => {
    const r1 = await terminate(env, e.t7!, "2027-01-29");
    const r2 = await terminate(env, e.t7c!, "2027-01-29");
    const s1 = await signIn(env, e.t7!.email!);
    const s2 = await signIn(env, e.t7c!.email!);
    expect({
      w2: (await userRow(env, e.t7!.userId!)).banReason,
      c1099: (await userRow(env, e.t7c!.userId!)).banReason,
      formerW2Access: [
        (r1.json() as { employee: { formerW2Access?: FormerAccess } }).employee.formerW2Access,
        (r2.json() as { employee: { formerW2Access?: FormerAccess } }).employee.formerW2Access,
      ],
      signIn: [
        [s1.status, s1.code],
        [s2.status, s2.code],
      ],
    }).toEqual({
      w2: "employee_terminated",
      c1099: "employee_terminated",
      formerW2Access: [null, null],
      signIn: [
        [403, "BANNED_USER"],
        [403, "BANNED_USER"],
      ],
    });
  });

  it("T-9 rehire a W-2-only person -> full access; rehire a terminated person banned for lockout or pending_enrollment -> the ban stays", async () => {
    await terminate(env, e.t9!, "2027-01-29");
    const rehire = await setStatus(env, e.t9!, "active");
    const s = await mustSignIn(env, e.t9!);
    await terminate(env, e.t9lock!, "2027-01-29");
    await setBan(env, e.t9lock!.userId!, "lockout");
    const r2 = await setStatus(env, e.t9lock!, "active");
    await terminate(env, e.t9pending!, "2027-01-29");
    await setBan(env, e.t9pending!.userId!, "pending_enrollment");
    const r3 = await setStatus(env, e.t9pending!, "active");
    expect({
      rehire: rehire.statusCode,
      access: (await access(env, s)).access,
      profile: await profileStatus(env, s),
      lockRehire: r2.statusCode,
      lockUser: await userRow(env, e.t9lock!.userId!),
      pendingRehire: r3.statusCode,
      pendingUser: (await userRow(env, e.t9pending!.userId!)).banReason,
    }).toEqual({
      rehire: 200,
      access: "full",
      profile: [200, null],
      lockRehire: 200,
      lockUser: { banned: true, banReason: "lockout", twoFactorEnabled: true },
      pendingRehire: 200,
      pendingUser: "pending_enrollment",
    });
  });

  it("T-11 admin reset of a former employee with an open window -> re-enrollment completes -> W-2 only (not full); reset/unlock with no open window -> 409 w2_access_ended, user row unchanged", async () => {
    await terminate(env, e.t11!, "2027-01-29");
    const done = await resetAndReenroll(env, e.t11!);
    const s = await signIn(env, e.t11!.email!);
    await terminate(env, e.t11none!, "2027-01-29"); // never online -> banned
    const before = await userRow(env, e.t11none!.userId!);
    const reset = await adminCall(env, "POST", `/api/admin/users/${e.t11none!.userId}/reset`, {});
    const unlock = await adminCall(env, "POST", `/api/admin/users/${e.t11none!.userId}/unlock`, {});
    expect({
      reenrolled: done.done,
      signIn: s.status,
      access: s.session ? (await access(env, s.session)).access : null,
      profile: s.session ? await profileStatus(env, s.session) : null,
      reset: [reset.statusCode, errorOf(reset)],
      unlock: [unlock.statusCode, errorOf(unlock)],
      unchanged: (await userRow(env, e.t11none!.userId!)) as unknown,
    }).toEqual({
      reenrolled: true,
      signIn: 200,
      access: "w2_only",
      profile: [403, "w2_access_only"],
      reset: [409, "w2_access_ended"],
      unlock: [409, "w2_access_ended"],
      unchanged: before,
    });
  });

  it("T-12 unlock after a lockout of a former employee -> W-2 only, not full", async () => {
    await terminate(env, e.t12!, "2027-01-29");
    await setBan(env, e.t12!.userId!, "lockout");
    const locked = await signIn(env, e.t12!.email!);
    const unlock = await adminCall(env, "POST", `/api/admin/users/${e.t12!.userId}/unlock`, {});
    const s = await signIn(env, e.t12!.email!);
    expect({
      locked: locked.status,
      unlock: unlock.statusCode,
      signIn: s.status,
      access: s.session ? (await access(env, s.session)).access : null,
      profile: s.session ? await profileStatus(env, s.session) : null,
    }).toEqual({
      locked: 403,
      unlock: 200,
      signIn: 200,
      access: "w2_only",
      profile: [403, "w2_access_only"],
    });
  });

  it("T-13 sign-in email change for a former employee: allowed, notice to the old and the new address, sessions revoked, still W-2 only with the new email", async () => {
    await terminate(env, e.t13!, "2027-01-29");
    const old = await signIn(env, e.t13!.email!);
    await reloginAdmin(env); // fresh admin session (freshAge)
    const newEmail = `pay217-moved-${e.t13!.id}@test.dev`;
    const put = await adminCall(env, "PUT", `/api/admin/employees/${e.t13!.id}/sign-in-email`, {
      email: newEmail,
    });
    const mails = await outbox(env, e.t13!.userId, "sign_in_email_changed");
    const oldAfter = old.session ? (await me(env, old.session)).statusCode : null;
    const s = await signIn(env, newEmail);
    expect({
      oldSignIn: old.status,
      put: [put.statusCode, (put.json() as { changed?: boolean }).changed],
      notices: mails.length,
      toOld: mails.some((m) => m.recipientEmail === e.t13!.email),
      oldSession: oldAfter,
      sessions: s.status === 200 ? "new ok" : `refused ${s.status} ${s.code}`,
      access: s.session ? (await access(env, s.session)).access : null,
    }).toEqual({
      oldSignIn: 200,
      put: [200, true],
      notices: 2,
      toOld: true,
      oldSession: 401,
      sessions: "new ok",
      access: "w2_only",
    });
  });
});

describe("PAY-217 T-8 terminate the day after the window closed -> banned (round 2 N1: w2_access_ended when a W-2 was online, employee_terminated when never online)", () => {
  let env: Env;
  let x: Emp;
  let never: Emp;
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    x = await consenter(env, "Lct8");
    never = await makeEmp(env, { label: "Lct8never", login: true, years: [2026] }); // no consent: paper notice only
    await yearNotice(env);
  }, 240_000);
  afterAll(async () => env.close());

  it("terminated on 2027-10-16 (10:00 CDT): TY2026 was online -> banned w2_access_ended (so a later online correction can re-open sign-in, R4); never online -> employee_terminated; formerW2Access null, sign-in refused for both", async () => {
    await moveTo(env, "2027-10-16T15:00:00Z");
    const res = await terminate(env, x, "2027-10-16");
    const resNever = await terminate(env, never, "2027-10-16");
    const s = await signIn(env, x.email!);
    const sNever = await signIn(env, never.email!);
    const access = (r: typeof res) =>
      (r.json() as { employee: { formerW2Access?: FormerAccess } }).employee.formerW2Access;
    expect({
      ban: (await userRow(env, x.userId!)).banReason,
      banNever: (await userRow(env, never.userId!)).banReason,
      formerW2Access: [access(res), access(resNever)],
      signIn: [
        [s.status, s.code],
        [sNever.status, sNever.code],
      ],
    }).toEqual({
      ban: "w2_access_ended",
      banNever: "employee_terminated",
      formerW2Access: [null, null],
      signIn: [
        [403, "BANNED_USER"],
        [403, "BANNED_USER"],
      ],
    });
  });

  it("…and on 2027-10-15 23:30 Chicago (2027-10-16T04:30Z) the window is still open: a second person is not banned", async () => {
    const y = await consenter(env, "Lct8b");
    await insertFurnishing(env, y.id, 2026, { at: "2027-01-04T16:00:00Z" });
    await moveTo(env, "2027-10-16T04:30:00Z");
    await terminate(env, y, "2027-10-15");
    expect((await userRow(env, y.userId!)).banned).toBe(false);
  });
});

describe("PAY-217 T-10 re-termination after rehire: window recomputed from every furnishing row", () => {
  let env: Env;
  let x: Emp;
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    x = await consenter(env, "Lct10");
    await yearNotice(env);
  }, 240_000);
  afterAll(async () => env.close());

  it("terminated Feb, rehired Mar, a correction posted online while active on 2027-09-01 (12:00 CDT), terminated again 2027-10-20 -> not banned, W-2 only through 2027-11-30", async () => {
    await moveTo(env, FEB_1_2027);
    await terminate(env, x, "2027-01-29");
    await moveTo(env, "2027-03-01T16:00:00Z");
    const rehire = await setStatus(env, x, "active");
    // A late December 2026 run changes the 2026 figures.
    await insertRun(env as never, x.id, {
      payDate: "2026-12-31",
      periodStart: "2026-12-31",
      periodEnd: "2026-12-31",
      grossCents: 100_000,
      fitCents: 10_000,
      state: null,
    } as never);
    await moveTo(env, "2027-09-01T17:00:00Z");
    const posted = await correct(env, x.id, 2026, "2027-09-01");
    await moveTo(env, "2027-10-20T15:00:00Z");
    const res = await terminate(env, x, "2027-10-20");
    const s = await signIn(env, x.email!);
    expect({
      rehire: rehire.statusCode,
      posted,
      user: (await userRow(env, x.userId!)).banned,
      formerW2Access: (res.json() as { employee: { formerW2Access?: FormerAccess } }).employee
        .formerW2Access,
      signIn: s.status,
      access: s.session ? await access(env, s.session) : null,
    }).toEqual({
      rehire: 200,
      posted: "w2_changed_notice_sent",
      user: false,
      formerW2Access: { accessThrough: "2027-11-30", years: [2026] },
      signIn: 200,
      access: { status: 200, access: "w2_only", through: "2027-11-30" },
    });
  });
});

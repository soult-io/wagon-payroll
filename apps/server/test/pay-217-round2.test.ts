/**
 * PAY-217 fix round 2 (Product Lead 2026-10-05, /private/tmp/wagon-pay217-round2.md)
 * — payroll-calc-auditor, fail-first against bd69ff1; the coder may not
 * edit this file. Synthetic data only. Legal source + oracle dates:
 * pay-217-harness.ts.
 *
 * Contract assumed:
 *  - F1: the IMPORTANT w2Changed mail (former AND active consented) says
 *    "Select Download PDF, then print or save it from your PDF reader."
 *    (html and text), as w2Available does.
 *  - N3: the paper sentence follows "left the electronic channel"
 *    (withdrawal OR termination): a consenter who withdrew after the online
 *    W-2 and is still employed gets /paper copy/i in the IMPORTANT mail.
 *  - N1/M2/C2: termination with no open window bans "w2_access_ended" when
 *    the person has any portal_notice / employee_download row (window
 *    closed), else "employee_terminated"; a later online correction then
 *    re-opens sign-in through the daily job (R4) with OD-1 = false.
 *  - L1: rehire unbans only while the ban reason is still
 *    employee_terminated / w2_access_ended at the moment of the write.
 *  - L2/C4: the daily job's ban / unban writes only apply while the user
 *    row still has the banned / banReason the job read; otherwise no
 *    change and no audit row.
 *  - L3: termination revokes outstanding setup links (invite / reset):
 *    POST /api/onboarding/verify-token -> 400 invalid_token.
 *  - C1: figures A -> B -> A for a former employee: A is posted online
 *    again (corrected portal_notice + IMPORTANT mail) and paper is owed again.
 *  - C5: no terminationDate -> the company-local date.
 *  - C6: terminationDate after today (company-local) -> 400
 *    termination_date_in_future, nothing changed.
 *  - C7: termination keeps a lockout / pending_enrollment ban reason; a
 *    rehire then leaves it.
 *  - Outbox: the drain delivers w2_changed / w2_available to a banned
 *    former employee, even with notification settings off (always on).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { emailOutbox, employees, notificationSettings } from "@payroll/db";
import { w2Changed } from "@payroll/notifications";
import { inviteUser } from "../src/auth/users.js";
import { reconcileW2Furnishings } from "../src/filings/w2-furnish.js";
import { drainOutbox } from "../src/notify/outbox.js";
import { ORIGIN } from "./helpers.js";
import { tokenFromLink } from "./flow-helpers.js";
import {
  adminCall,
  adminList,
  auditFor,
  boot217,
  consenter,
  correct,
  deleteConsent,
  deps,
  type Emp,
  type Env,
  errorOf,
  formerModule,
  freshIp,
  furnishings,
  IMPORTANT,
  insertFurnishing,
  makeEmp,
  me,
  moveTo,
  mustSignIn,
  need,
  outbox,
  plain,
  reloginAdmin,
  setBan,
  setStatus,
  signIn,
  terminate,
  userRow,
  yearNotice,
} from "./pay-217-harness.js";
import { insertRun, voidRun } from "./w2-state-harness.js";

const JAN_4_2027 = "2027-01-04T16:00:00Z";
const FEB_1_2027 = "2027-02-01T16:00:00Z";
const DOWNLOAD_SENTENCE = "Select Download PDF, then print or save it from your PDF reader.";

async function sync(env: Env, today: string) {
  const fn = need(await formerModule(), "syncFormerEmployeeLogins");
  return fn({ db: env.t.db, config: env.t.config }, { today, restoreTerminatedBans: false });
}

async function lateRun(env: Env, employeeId: number) {
  return insertRun(env as never, employeeId, {
    payDate: "2026-12-31",
    periodStart: "2026-12-31",
    periodEnd: "2026-12-31",
    grossCents: 100_000,
    fitCents: 10_000,
    state: null,
  } as never);
}

async function importantMails(env: Env, emp: Emp) {
  return (await outbox(env, emp.userId, "w2_changed")).filter((m) =>
    m.subject.startsWith(IMPORTANT),
  );
}

async function verifyToken(env: Env, token: string) {
  const ip = freshIp();
  const r = await env.t.app.inject({
    method: "POST",
    url: "/api/onboarding/verify-token",
    headers: { ...ORIGIN, "x-forwarded-for": ip },
    remoteAddress: ip,
    payload: { token },
  });
  return [r.statusCode, errorOf(r)];
}

// ---------------------------------------------------------------- F1 (template)

describe("PAY-217 R2 F1 the IMPORTANT corrected-W-2 mail tells how to download and print", () => {
  const ctx = {
    companyName: "Synthetic Co",
    brandName: "Wagon Payroll",
    appUrl: "https://payroll.example.test",
  };
  it("F1 former and active consented variants: html and text contain the Download PDF sentence", () => {
    const former = w2Changed(ctx, {
      taxYear: 2026,
      consented: true,
      accessThrough: "2027-10-15",
      former: true,
      paperToo: true,
    } as never);
    const active = w2Changed(ctx, { taxYear: 2026, consented: true, accessThrough: "2027-10-15" });
    expect({
      formerHtml: plain(former.html).includes(DOWNLOAD_SENTENCE),
      formerText: former.text.includes(DOWNLOAD_SENTENCE),
      activeHtml: plain(active.html).includes(DOWNLOAD_SENTENCE),
      activeText: active.text.includes(DOWNLOAD_SENTENCE),
    }).toEqual({ formerHtml: true, formerText: true, activeHtml: true, activeText: true });
  });
});

// ---------------------------------------------------------------- N3

describe("PAY-217 R2 N3 the paper sentence follows leaving the electronic channel, not only termination", () => {
  let env: Env;
  let x: Emp;
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    x = await consenter(env, "N3withdrew");
    await yearNotice(env);
    await moveTo(env, FEB_1_2027);
    await mustSignIn(env, x);
    const del = await deleteConsent(env, x);
    if (del.statusCode !== 200) throw new Error(`withdraw ${del.statusCode}`);
    await lateRun(env, x.id);
  }, 240_000);
  afterAll(async () => env.close());

  it("N3 still employed, withdrew after the online W-2: the correction's IMPORTANT mail says a paper copy is coming", async () => {
    await correct(env, x.id, 2026, "2027-02-01");
    const mails = await importantMails(env, x);
    expect({
      important: mails.length,
      paperLine: mails.map((m) => /paper copy/i.test(plain(m.bodyHtml))),
      download: mails.map((m) => plain(m.bodyHtml).includes(DOWNLOAD_SENTENCE)),
    }).toEqual({ important: 1, paperLine: [true], download: [true] });
  });
});

// ---------------------------------------------------------------- N1 / M2 / C2 + outbox drain

describe("PAY-217 R2 N1/M2/C2 termination after the window closed: w2_access_ended, so a later correction re-opens sign-in", () => {
  let env: Env;
  const e: Record<string, Emp> = {};
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    e.closed = await consenter(env, "N1closed");
    e.never = await makeEmp(env, { label: "N1never", login: true, years: [2026] }); // paper only
    e.lockedClosed = await consenter(env, "N1lockedclosed");
    await yearNotice(env);
    await moveTo(env, "2027-10-16T15:00:00Z"); // window of TY2026 closed (Oct 15)
    await setBan(env, e.lockedClosed.userId!, "lockout");
    for (const k of ["closed", "never", "lockedClosed"]) await terminate(env, e[k]!, "2027-10-16");
  }, 240_000);
  afterAll(async () => env.close());

  it("N1 terminate on 2027-10-16: online row + closed window -> w2_access_ended; never online -> employee_terminated; a lockout stays lockout (C7)", async () => {
    expect({
      closed: (await userRow(env, e.closed!.userId!)).banReason,
      never: (await userRow(env, e.never!.userId!)).banReason,
      lockedClosed: (await userRow(env, e.lockedClosed!.userId!)).banReason,
    }).toEqual({
      closed: "w2_access_ended",
      never: "employee_terminated",
      lockedClosed: "lockout",
    });
  });

  it("N1/R4 a correction on 2027-11-10 is posted online; the outbox drain delivers it (and a w2_available row) to the still-banned person even with settings off; the job then re-opens sign-in through 2028-02-08", async () => {
    await lateRun(env, e.closed!.id);
    await moveTo(env, "2027-11-10T18:00:00Z");
    await reconcileW2Furnishings(deps(env), { today: "2027-11-10" });
    // Always-on W-2 events: a w2_available row too, and the person has turned both off.
    await env.t.db.insert(emailOutbox).values({
      userId: e.closed!.userId!,
      eventType: "w2_available",
      subject: `${IMPORTANT}: Your 2026 W-2 from Synthetic Co`,
      bodyHtml: "<p>synthetic</p>",
    });
    for (const ev of ["w2_changed", "w2_available"]) {
      await env.t.db
        .insert(notificationSettings)
        .values({ userId: e.closed!.userId!, eventType: ev, enabled: false } as never)
        .onConflictDoNothing();
    }
    const bannedAtDrain = (await userRow(env, e.closed!.userId!)).banned;
    const sent: { to: string; subject: string }[] = [];
    await drainOutbox({
      db: env.t.db,
      config: { ...env.t.config, emailMode: "smtp" },
      transport: { sendMail: async (m: { to: string; subject: string }) => void sent.push(m) },
      resolveRecipientEmail: async () => e.closed!.email,
    } as never);
    const toPerson = sent.filter((m) => m.to === e.closed!.email);
    const postedOnline = (await furnishings(env, e.closed!.id, 2026)).some(
      (r) => r.method === "portal_notice" && r.corrected,
    );
    const rows = (
      await env.t.db.select().from(emailOutbox).where(eq(emailOutbox.userId, e.closed!.userId!))
    ).filter((r) => r.eventType === "w2_changed" || r.eventType === "w2_available");
    await sync(env, "2027-11-10");
    const s = await signIn(env, e.closed!.email!);
    expect({
      bannedAtDrain,
      postedOnline,
      delivered: rows.every((r) => toPerson.some((m) => m.subject === r.subject)),
      w2Rows: rows.length >= 2,
      w2AllSent: rows.every((r) => r.status === "sent"),
      ban: (await userRow(env, e.closed!.userId!)).banReason,
      me: s.session ? (await me(env, s.session)).json() : `refused ${s.status} ${s.code}`,
    }).toMatchObject({
      bannedAtDrain: true,
      postedOnline: true,
      delivered: true,
      w2Rows: true,
      w2AllSent: true,
      ban: null,
      me: { access: "w2_only", w2AccessThrough: "2028-02-08" },
    });
  });
});

// ---------------------------------------------------------------- L1

describe("PAY-217 R2 L1 rehire unbans only while the ban is still a termination ban", () => {
  let env: Env;
  let x: Emp;
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    x = await makeEmp(env, { label: "L1race", login: true, years: [2026] }); // never online
    await moveTo(env, FEB_1_2027);
    await terminate(env, x, "2027-01-29"); // banned employee_terminated
    // A lockout written between the route's read and its unban: fires on
    // the employees status update the rehire makes before it touches the login.
    await env.t.pglite.exec(`
      CREATE FUNCTION pay217_l1() RETURNS trigger AS $$
      BEGIN
        UPDATE "user" SET banned = true, "banReason" = 'lockout' WHERE id = NEW.user_id;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER pay217_l1 AFTER UPDATE ON employees FOR EACH ROW
        WHEN (NEW.id = ${x.id} AND NEW.status = 'active') EXECUTE FUNCTION pay217_l1();
    `);
  }, 240_000);
  afterAll(async () => env.close());

  it("L1 a lockout written mid-rehire survives the rehire", async () => {
    const r = await setStatus(env, x, "active");
    expect({ status: r.statusCode, user: await userRow(env, x.userId!) }).toEqual({
      status: 200,
      user: { banned: true, banReason: "lockout", twoFactorEnabled: true },
    });
  });
});

// ---------------------------------------------------------------- L2 / C4

describe("PAY-217 R2 L2/C4 the daily job does not overwrite or clear a ban that changed after its read", () => {
  let env: Env;
  const e: Record<string, Emp> = {};
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    // Processing order is employees.id: A before B, C before D.
    for (const k of ["L2a", "L2b", "L2c", "L2d"]) e[k] = await consenter(env, k);
    await yearNotice(env);
    await moveTo(env, FEB_1_2027);
    for (const k of ["L2a", "L2b", "L2c", "L2d"]) await terminate(env, e[k]!, "2027-01-29");
    // While the job handles A (ban) / C (unban), a lockout lands on B / D.
    await env.t.pglite.exec(`
      CREATE FUNCTION pay217_l2() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'employee.w2_access_ended' AND NEW.entity_id = '${e.L2a!.id}' THEN
          UPDATE "user" SET banned = true, "banReason" = 'lockout' WHERE id = '${e.L2b!.userId}';
        END IF;
        IF NEW.action = 'employee.w2_access_restored' AND NEW.entity_id = '${e.L2c!.id}' THEN
          UPDATE "user" SET banned = true, "banReason" = 'lockout' WHERE id = '${e.L2d!.userId}';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER pay217_l2 AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION pay217_l2();
    `);
  }, 300_000);
  afterAll(async () => env.close());

  it("C4 ban: B read as not banned, locked out while A is processed -> B keeps lockout, no w2_access_ended audit for B", async () => {
    await moveTo(env, "2027-10-16T15:00:00Z");
    await sync(env, "2027-10-16");
    expect({
      a: (await userRow(env, e.L2a!.userId!)).banReason,
      b: (await userRow(env, e.L2b!.userId!)).banReason,
      bAudit: (await auditFor(env, "employee.w2_access_ended", e.L2b!.id)).length,
    }).toEqual({ a: "w2_access_ended", b: "lockout", bAudit: 0 });
  });

  it("C4 unban: D read as banned w2_access_ended, locked out while C is restored -> D keeps lockout, no restore audit for D", async () => {
    // C and D were banned w2_access_ended by the first run; a corrected
    // posting on 2027-11-10 re-opens both windows (through 2028-02-08).
    await setBan(env, e.L2d!.userId!, "w2_access_ended");
    for (const k of ["L2c", "L2d"]) {
      await insertFurnishing(env, e[k]!.id, 2026, { at: "2027-11-10T18:00:00Z", corrected: true });
    }
    await moveTo(env, "2027-11-10T19:00:00Z");
    await sync(env, "2027-11-10");
    expect({
      c: (await userRow(env, e.L2c!.userId!)).banned,
      d: (await userRow(env, e.L2d!.userId!)).banReason,
      dAudit: (await auditFor(env, "employee.w2_access_restored", e.L2d!.id)).length,
    }).toEqual({ c: false, d: "lockout", dAudit: 0 });
  });
});

// ---------------------------------------------------------------- L3 + C7

describe("PAY-217 R2 L3 termination revokes setup links; C7 lockout / pending_enrollment reasons are kept", () => {
  let env: Env;
  const e: Record<string, Emp> = {};
  let inviteToken = "";
  let resetToken = "";
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    // Invited, never enrolled (pending_enrollment), linked to an employee row.
    e.invited = await makeEmp(env, { label: "L3invited", years: [2026] });
    e.reset = await consenter(env, "L3reset");
    e.locked = await makeEmp(env, { label: "C7locked", login: true, years: [2026] });
    await yearNotice(env);
    await moveTo(env, FEB_1_2027);
    const inv = await inviteUser(
      { auth: env.t.auth, db: env.t.db, config: env.t.config },
      { name: "L3invited Synthetic", email: "pay217-l3-invited@test.dev", role: "employee" },
      null,
    );
    inviteToken = tokenFromLink(inv.setupLink);
    await env.t.db
      .update(employees)
      .set({ userId: inv.userId })
      .where(eq(employees.id, e.invited.id));
    e.invited.userId = inv.userId;
    // e.reset: onboarded; an admin reset is outstanding when the job ends (window open).
    // e.locked: active, locked out, never online (C7).
    const rs = await adminCall(env, "POST", `/api/admin/users/${e.reset.userId}/reset`, {});
    resetToken = tokenFromLink((rs.json() as { setupLink: string }).setupLink);
    await setBan(env, e.locked.userId!, "lockout");
  }, 240_000);
  afterAll(async () => env.close());

  it("L3 after termination the outstanding invite link and reset link are refused: 400 invalid_token", async () => {
    const before = [await verifyToken(env, inviteToken), await verifyToken(env, resetToken)];
    await terminate(env, e.invited!, "2027-01-29");
    await terminate(env, e.reset!, "2027-01-29");
    expect({
      before,
      invite: await verifyToken(env, inviteToken),
      reset: await verifyToken(env, resetToken),
    }).toEqual({
      before: [
        [200, null],
        [200, null],
      ],
      invite: [400, "invalid_token"],
      reset: [400, "invalid_token"],
    });
  });

  it("C7 termination keeps lockout and pending_enrollment; rehire leaves them", async () => {
    await terminate(env, e.locked!, "2027-01-29");
    const afterTerm = {
      locked: (await userRow(env, e.locked!.userId!)).banReason,
      invited: (await userRow(env, e.invited!.userId!)).banReason,
    };
    await setStatus(env, e.locked!, "active");
    await setStatus(env, e.invited!, "active");
    expect({
      afterTerm,
      afterRehire: {
        locked: (await userRow(env, e.locked!.userId!)).banReason,
        invited: (await userRow(env, e.invited!.userId!)).banReason,
      },
    }).toEqual({
      afterTerm: { locked: "lockout", invited: "pending_enrollment" },
      afterRehire: { locked: "lockout", invited: "pending_enrollment" },
    });
  });
});

// ---------------------------------------------------------------- C1

describe("PAY-217 R2 C1 figures A -> B -> A for a former employee", () => {
  let env: Env;
  let x: Emp;
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    x = await consenter(env, "C1aba");
    await yearNotice(env); // A online
    await moveTo(env, FEB_1_2027);
    await terminate(env, x, "2027-01-29");
  }, 240_000);
  afterAll(async () => env.close());

  it("B is posted (mail 1), paper for B is handed, then the figures return to A: A is posted again with a second IMPORTANT mail and paper is owed again", async () => {
    const hashA = (await furnishings(env, x.id, 2026)).find(
      (r) => r.method === "portal_notice",
    )!.boxes_hash;
    const run = await lateRun(env, x.id);
    await moveTo(env, "2027-03-01T17:00:00Z");
    await reconcileW2Furnishings(deps(env), { today: "2027-03-01" });
    const paper = await adminCall(
      env,
      "POST",
      `/api/admin/annual-forms/w2/${x.id}/furnished-on-paper?year=2026`,
      {},
    );
    await voidRun(env as never, run.id);
    await moveTo(env, "2027-04-01T16:00:00Z");
    await reconcileW2Furnishings(deps(env), { today: "2027-04-01" });
    const portal = (await furnishings(env, x.id, 2026)).filter((r) => r.method === "portal_notice");
    await reloginAdmin(env);
    const row = (await adminList(env, 2026)).w2s.find((r) => r.employeeId === x.id) as
      | { correctionToFurnish?: boolean }
      | undefined;
    expect({
      paper: paper.statusCode,
      portal: portal.map((r) => [r.boxes_hash === hashA ? "A" : "B", r.corrected]),
      important: (await importantMails(env, x)).length,
      paperOwed: row?.correctionToFurnish,
    }).toEqual({
      paper: 200,
      portal: [
        ["A", false],
        ["B", true],
        ["A", true],
      ],
      important: 2,
      paperOwed: true,
    });
  });
});

// ---------------------------------------------------------------- C5, C6

describe("PAY-217 R2 C5/C6 termination date is company-local and never in the future", () => {
  let env: Env;
  const e: Record<string, Emp> = {};
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    e.future = await makeEmp(env, { label: "C6future", login: true });
    e.dflt = await makeEmp(env, { label: "C5default", login: true });
    e.edge = await makeEmp(env, { label: "C6edge", login: true });
    // 2027-02-01T03:00Z = 2027-01-31 21:00 CST.
    await moveTo(env, "2027-02-01T03:00:00Z");
  }, 240_000);
  afterAll(async () => env.close());

  it("C6 terminationDate 2027-02-01 at 21:00 CST on Jan 31 -> 400 termination_date_in_future, still active", async () => {
    const r = await setStatus(env, e.future!, "terminated", "2027-02-01");
    const row = (await env.t.db.select().from(employees).where(eq(employees.id, e.future!.id)))[0]!;
    expect({
      r: [r.statusCode, errorOf(r)],
      status: row.status,
      ban: (await userRow(env, e.future!.userId!)).banned,
    }).toEqual({
      r: [400, "termination_date_in_future"],
      status: "active",
      ban: false,
    });
  });

  it("C5 no terminationDate at 21:00 CST on Jan 31 -> 2027-01-31; and 2027-01-31 itself is accepted (C6 edge)", async () => {
    const r = await setStatus(env, e.dflt!, "terminated");
    const edge = await setStatus(env, e.edge!, "terminated", "2027-01-31");
    expect({
      date: (r.json() as { employee?: { terminationDate?: string } }).employee?.terminationDate,
      edge: edge.statusCode,
    }).toEqual({ date: "2027-01-31", edge: 200 });
  });
});

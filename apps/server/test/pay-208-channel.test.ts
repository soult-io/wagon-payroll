/**
 * PAY-208 — one year-aware "electronic channel" (A2) and what hangs off it:
 * the year notice (IMPORTANT subject / paper courtesy, always on), the
 * admin list, corrections, the corrected-W-2 access window, a withdrawal
 * before a correction, and undeliverable notices ((j)(5)(ii)).
 * payroll-calc-auditor, fail-first against d0f722f; the coder may not edit
 * this file. Synthetic data only. Legal source: pay-208-harness.ts header.
 *
 * Tests: T6, T7, T8, T13, T14 (+ 2025), DE1 (canSwitchOnline in the paper
 * notice), CW1-CW2 (corrected access window, (j)(6) 2nd sentence), WC1
 * (withdrawal before a correction), UN1 ((j)(5)(ii)).
 *
 * Contract assumed:
 *  - electronicW2Channel(db, employeeIds, taxYear): consent covers taxYear
 *    AND employees.user_id IS NOT NULL AND employees.status = 'active'.
 *  - furnishCorrectionIfNeeded(tx, config, employeeId, taxYear, today) picks
 *    consented/paper with that predicate for the year.
 *  - GET /api/admin/annual-forms/w2 -> + reconsentNeeded, + contactReady,
 *    rows + consentOutdated; `consented` = electronic channel for the year;
 *    + undeliveredNotices: [{ employeeId, legalName }] — consented
 *    w2_available / w2_changed notices of that tax year whose outbox row
 *    ended 'failed' (name only: no email address, no amounts).
 *  - The D9 access window of a year = the later of
 *    electronicW2AccessThrough(year) and (company-local date of the latest
 *    CORRECTED portal_notice row) + 90 days.
 *  - A consenter who withdrew after the original was furnished online and
 *    before a correction: the correction is posted (corrected
 *    portal_notice) with the IMPORTANT w2_changed mail AND the admin row
 *    shows correctionToFurnish (paper owed, (j)(7)).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emailOutbox, employees, notificationSettings } from "@payroll/db";
import { eq, inArray } from "drizzle-orm";
import { sendW2AvailableNotices } from "../src/filings/annual.js";
import { electronicW2Channel } from "../src/filings/w2-consent.js";
import { furnishCorrectionIfNeeded } from "../src/filings/w2-furnish.js";
import { drainOutbox } from "../src/notify/outbox.js";
import {
  adminList,
  boot,
  deleteConsent,
  deps,
  type Emp,
  type Env,
  furnishings,
  hasAmount,
  IMPORTANT,
  makeEmp,
  myPdf,
  myW2,
  NEW_VERSION,
  OLD_VERSION,
  outbox,
  plain,
  relogin,
  reloginAdmin,
  scrub,
  seedContact,
  SSN_FORMS,
} from "./pay-208-harness.js";
import { insertRun } from "./w2-state-harness.js";

const JAN_4_2027 = "2027-01-04T10:00:00Z";

// biome-ignore lint/suspicious/noExplicitAny: the new third argument (taxYear) is the contract under test
const channel = electronicW2Channel as any as (
  db: unknown,
  ids: readonly number[],
  taxYear: number,
) => Promise<Set<number>>;

async function earlierPosting(
  env: Env,
  employeeId: number,
  year: number,
  method = "portal_notice",
) {
  await env.t.pglite.query(
    `INSERT INTO w2_furnishings (employee_id, tax_year, boxes_hash, hash_version, corrected, method, furnished_at)
     VALUES ($1, $2, $3, $4, false, $5, $6)`,
    [employeeId, year, "a".repeat(64), year >= 2026 ? 2 : 1, method, `${year + 1}-01-05T10:00:00Z`],
  );
}

async function correct(env: Env, employeeId: number, year: number, today: string) {
  return env.t.db.transaction((tx) =>
    furnishCorrectionIfNeeded(tx as never, env.t.config, employeeId, year, today),
  );
}

async function legalName(env: Env, id: number): Promise<string> {
  return (await env.t.db.select().from(employees).where(eq(employees.id, id)))[0]!.legalName;
}

// ---------------------------------------------------------------- T6

describe("T6 electronicW2Channel(db, ids, taxYear) — the one predicate (A2)", () => {
  let env: Env;
  const e: Record<string, Emp> = {};
  beforeAll(async () => {
    env = await boot({ now: JAN_4_2027 });
    e.current = await makeEmp(env, { label: "Chcurrent", login: true, consent: NEW_VERSION });
    e.outdated = await makeEmp(env, { label: "Choutdated", login: true, consent: OLD_VERSION });
    e.terminated = await makeEmp(env, {
      label: "Chterm",
      login: true,
      consent: NEW_VERSION,
      terminated: true,
    });
    e.terminatedOld = await makeEmp(env, {
      label: "Chtermold",
      login: true,
      consent: OLD_VERSION,
      terminated: true,
    });
    e.noLogin = await makeEmp(env, { label: "Chnologin", consent: NEW_VERSION });
    e.withdrawn = await makeEmp(env, {
      label: "Chwithdrawn",
      login: true,
      consent: NEW_VERSION,
      withdrawnAt: "2026-11-01T10:00:00Z",
    });
  }, 240_000);
  afterAll(async () => env.close());

  it("2026: only the current, active, logged-in consenter; 2025: current + outdated (active), never terminated / no login / withdrawn", async () => {
    const ids = Object.values(e).map((x) => x.id);
    const names = (s: Set<number>) =>
      Object.entries(e)
        .filter(([, x]) => s.has(x.id))
        .map(([k]) => k)
        .sort();
    expect({
      y2026: names(await channel(env.t.db, ids, 2026)),
      y2025: names(await channel(env.t.db, ids, 2025)),
      y2027: names(await channel(env.t.db, ids, 2027)),
    }).toEqual({
      y2026: ["current"],
      y2025: ["current", "outdated"],
      y2027: ["current"],
    });
  });
});

// ---------------------------------------------------------------- T7 + DE1 + T8

describe("T7 the 2026 year notice by channel ((j)(5)(i)); DE1 paper notice switch line; T8 always on", () => {
  let env: Env;
  const e: Record<string, Emp> = {};
  let firstRun: { sent: number };
  beforeAll(async () => {
    env = await boot({ now: JAN_4_2027 });
    await seedContact(env);
    e.current = await makeEmp(env, {
      label: "Ntcurrent",
      login: true,
      consent: NEW_VERSION,
      years: [2026],
    });
    e.outdated = await makeEmp(env, {
      label: "Ntoutdated",
      login: true,
      consent: OLD_VERSION,
      years: [2026],
    });
    e.terminated = await makeEmp(env, {
      label: "Ntterm",
      login: true,
      consent: NEW_VERSION,
      years: [2026],
      terminated: true,
    });
    e.none = await makeEmp(env, { label: "Ntnone", login: true, years: [2026] });
    // T8: the employee switched the W-2 email off before PAY-208 (an inert row now).
    await env.t.db
      .insert(notificationSettings)
      .values({ userId: e.current.userId!, eventType: "w2_available", enabled: false })
      .onConflictDoUpdate({
        target: [notificationSettings.userId, notificationSettings.eventType],
        set: { enabled: false },
      });
    firstRun = await sendW2AvailableNotices(deps(env), { today: "2027-01-04" });
  }, 240_000);
  afterAll(async () => env.close());

  it("T7 current -> one portal_notice + subject starting IMPORTANT; outdated, terminated, none -> no furnishing row, no phrase", async () => {
    const view = async (x: Emp) => ({
      furnished: (await furnishings(env, x.id, 2026)).map((r) => r.method),
      important: (await outbox(env, x.userId, "w2_available")).map((m) =>
        m.subject.startsWith(IMPORTANT),
      ),
      phraseAnywhere: (await outbox(env, x.userId, "w2_available")).some((m) =>
        `${m.subject} ${m.bodyHtml}`.includes(IMPORTANT),
      ),
    });
    expect({
      current: await view(e.current!),
      outdated: await view(e.outdated!),
      terminated:
        (await view(e.terminated!)).furnished.length +
        Number((await view(e.terminated!)).phraseAnywhere),
      none: await view(e.none!),
    }).toEqual({
      current: { furnished: ["portal_notice"], important: [true], phraseAnywhere: true },
      outdated: { furnished: [], important: [false], phraseAnywhere: false },
      terminated: 0,
      none: { furnished: [], important: [false], phraseAnywhere: false },
    });
  });

  it("T7 the consented notice: access AND print instructions, appUrl, the access date; no amount, no SSN. Paper variant: notice-only, never 'available', paper", async () => {
    const legal = (await outbox(env, e.current!.userId, "w2_available"))[0]!;
    const paper = (await outbox(env, e.outdated!.userId, "w2_available"))[0]!;
    const lt = plain(legal.bodyHtml);
    const pt = plain(paper.bodyHtml);
    expect({
      print: /print/i.test(lt),
      signIn: lt.includes(env.t.config.baseUrl ?? "http://localhost"),
      through: lt.includes("It stays available there through October 15, 2027."),
      legalNoAmount: !hasAmount(scrub(lt)),
      paperSubjectNoAvailable: !/available/i.test(paper.subject),
      paperBodyNoAvailableOnline: !/available online/i.test(pt),
      paperSaysPaper: /paper/i.test(pt),
      noSsn: [legal, paper].every((m) =>
        SSN_FORMS.slice(0, 2).every((s) => !m.bodyHtml.includes(s)),
      ),
      paperNoAmount: !hasAmount(scrub(pt)),
    }).toEqual({
      print: true,
      signIn: true,
      through: true,
      legalNoAmount: true,
      paperSubjectNoAvailable: true,
      paperBodyNoAvailableOnline: true,
      paperSaysPaper: true,
      noSsn: true,
      paperNoAmount: true,
    });
  });

  it("DE1 the paper notice offers the switch online only when the employee can switch (active, sign-in, contact ready)", async () => {
    const appUrl = env.t.config.baseUrl ?? "http://localhost";
    const switchLine = async (x: Emp) => {
      const m = (await outbox(env, x.userId, "w2_available"))[0];
      const text = m ? plain(m.bodyHtml) : "";
      return /online/i.test(text) && text.includes(appUrl);
    };
    expect({
      outdated: await switchLine(e.outdated!),
      none: await switchLine(e.none!),
      terminated: await switchLine(e.terminated!),
    }).toEqual({ outdated: true, none: true, terminated: false });
  });

  it("T7 a rerun adds nothing", async () => {
    const before = (
      await env.t.pglite.query<{ n: number }>("SELECT count(*)::int AS n FROM email_outbox")
    ).rows[0]!.n;
    const again = await sendW2AvailableNotices(deps(env), { today: "2027-01-05" });
    const after = (
      await env.t.pglite.query<{ n: number }>("SELECT count(*)::int AS n FROM email_outbox")
    ).rows[0]!.n;
    expect({ firstSent: firstRun.sent > 0, again: again.sent, added: after - before }).toEqual({
      firstSent: true,
      again: 0,
      added: 0,
    });
  });

  it("T8 a w2_available 'off' setting no longer suppresses the notice: the drain sends it", async () => {
    await drainOutbox({
      db: env.t.db,
      config: { ...env.t.config, emailMode: "log" },
      resolveRecipientEmail: async () => "worker@example.com",
    } as never);
    const rows = await outbox(env, e.current!.userId, "w2_available");
    expect(rows.map((r) => r.status)).toEqual(["sent"]);
  });
});

// ---------------------------------------------------------------- T13

describe("T13 admin W-2 list: consented is year-aware; reconsentNeeded; terminated never counted", () => {
  let env: Env;
  const e: Record<string, Emp> = {};
  beforeAll(async () => {
    env = await boot({ now: JAN_4_2027 });
    await seedContact(env);
    e.outdated = await makeEmp(env, {
      label: "Lsoutdated",
      login: true,
      consent: OLD_VERSION,
      years: [2025, 2026],
    });
    e.current = await makeEmp(env, {
      label: "Lscurrent",
      login: true,
      consent: NEW_VERSION,
      years: [2025, 2026],
    });
    e.termOld = await makeEmp(env, {
      label: "Lstermold",
      login: true,
      consent: OLD_VERSION,
      years: [2025, 2026],
      terminated: true,
    });
    e.termNew = await makeEmp(env, {
      label: "Lstermnew",
      login: true,
      consent: NEW_VERSION,
      years: [2025, 2026],
      terminated: true,
    });
  }, 240_000);
  afterAll(async () => env.close());

  it("2026: outdated row consented false + consentOutdated true, reconsentNeeded 1, contactReady true; 2025: reconsentNeeded 0 and the outdated consenter is online", async () => {
    const l26 = await adminList(env, 2026);
    const l25 = await adminList(env, 2025);
    const row = (l: typeof l26, k: string) => {
      const r = l.w2s.find((x) => x.employeeId === e[k]!.id)!;
      return { consented: r.consented, consentOutdated: r.consentOutdated };
    };
    expect({
      y2026: {
        reconsentNeeded: l26.reconsentNeeded,
        contactReady: l26.contactReady,
        outdated: row(l26, "outdated"),
        current: row(l26, "current"),
        termOld: row(l26, "termOld"),
        termNew: row(l26, "termNew"),
      },
      y2025: {
        reconsentNeeded: l25.reconsentNeeded,
        outdated: row(l25, "outdated").consented,
        current: row(l25, "current").consented,
        termOld: row(l25, "termOld").consented,
        termNew: row(l25, "termNew").consented,
      },
    }).toEqual({
      y2026: {
        reconsentNeeded: 1,
        contactReady: true,
        outdated: { consented: false, consentOutdated: true },
        current: { consented: true, consentOutdated: false },
        termOld: { consented: false, consentOutdated: false },
        termNew: { consented: false, consentOutdated: false },
      },
      y2025: { reconsentNeeded: 0, outdated: true, current: true, termOld: false, termNew: false },
    });
  });
});

// ---------------------------------------------------------------- T14

describe("T14 furnishCorrectionIfNeeded uses the year-aware channel (w2Changed consented/paper)", () => {
  let env: Env;
  const e: Record<string, Emp> = {};
  beforeAll(async () => {
    env = await boot({ now: "2027-02-01T10:00:00Z" });
    await seedContact(env);
    e.outdated = await makeEmp(env, {
      label: "Croutdated",
      login: true,
      consent: OLD_VERSION,
      years: [2026],
    });
    e.current = await makeEmp(env, {
      label: "Crcurrent",
      login: true,
      consent: NEW_VERSION,
      years: [2026],
    });
    e.term = await makeEmp(env, {
      label: "Crterm",
      login: true,
      consent: NEW_VERSION,
      years: [2026],
      terminated: true,
    });
    e.old2025 = await makeEmp(env, {
      label: "Crold25",
      login: true,
      consent: OLD_VERSION,
      years: [2025],
    });
    for (const k of ["outdated", "current", "term"]) await earlierPosting(env, e[k]!.id, 2026);
    await earlierPosting(env, e.old2025!.id, 2025);
  }, 240_000);
  afterAll(async () => env.close());

  // PAY-217 (federal SME ruling 2026-10-05, R1): a correction of a year
  // furnished online is posted online whatever the employment status — the
  // terminated consenter (2026 posted online) now gets the corrected
  // portal_notice + IMPORTANT mail (and is also owed paper, R2).
  it("2026: outdated -> w2_paper_correction_needed, no new portal_notice, no IMPORTANT mail; terminated (year posted online, PAY-217 R1) and current -> w2_changed_notice_sent; 2025 outdated -> w2_changed_notice_sent", async () => {
    const run = async (k: string, year: number) => {
      const before = (await furnishings(env, e[k]!.id, year)).length;
      const out = await correct(env, e[k]!.id, year, "2027-02-01");
      const rows = await furnishings(env, e[k]!.id, year);
      const mails = await outbox(env, e[k]!.userId, "w2_changed");
      return {
        out,
        newPortal: rows.slice(before).filter((r) => r.method === "portal_notice").length,
        important: mails.some((m) => m.subject.startsWith(IMPORTANT)),
      };
    };
    expect({
      outdated: await run("outdated", 2026),
      term: await run("term", 2026),
      current: await run("current", 2026),
      old2025: await run("old2025", 2025),
    }).toEqual({
      outdated: { out: "w2_paper_correction_needed", newPortal: 0, important: false },
      term: { out: "w2_changed_notice_sent", newPortal: 1, important: true },
      current: { out: "w2_changed_notice_sent", newPortal: 1, important: true },
      old2025: { out: "w2_changed_notice_sent", newPortal: 1, important: true },
    });
  });
});

// ---------------------------------------------------------------- CW (corrected access window)

describe("CW corrected W-2 access window: the later of Oct 15 and 90 days after a corrected posting ((j)(6))", () => {
  let env: Env;
  let late: Emp;
  let early: Emp;
  async function correctedPosting(id: number, at: string) {
    await env.t.pglite.query(
      `INSERT INTO w2_furnishings (employee_id, tax_year, boxes_hash, hash_version, corrected, method, furnished_at)
       VALUES ($1, 2026, $2, 2, true, 'portal_notice', $3)`,
      [id, "c".repeat(64), at],
    );
  }
  beforeAll(async () => {
    env = await boot({ now: JAN_4_2027 });
    await seedContact(env);
    late = await makeEmp(env, {
      label: "Cwlate",
      login: true,
      consent: NEW_VERSION,
      years: [2026],
    });
    early = await makeEmp(env, {
      label: "Cwearly",
      login: true,
      consent: NEW_VERSION,
      years: [2026],
    });
    await sendW2AvailableNotices(deps(env), { today: "2027-01-04" });
    env.setNow("2027-02-01T10:00:00Z");
    for (const x of [late, early]) {
      await relogin(env, x);
      const del = await deleteConsent(env, x);
      if (del.statusCode !== 200) throw new Error(`withdraw ${del.statusCode}`);
    }
    // Corrected postings: 2027-09-01 (+90 days = 2027-11-30, after Oct 15)
    // and 2027-05-01 (+90 days = 2027-07-30, before Oct 15).
    await correctedPosting(late.id, "2027-09-01T12:00:00Z");
    await correctedPosting(early.id, "2027-05-01T12:00:00Z");
  }, 240_000);
  afterAll(async () => env.close());

  it("CW1 posted 2027-09-01 -> still downloadable on 2027-11-30, refused from 2027-12-01", async () => {
    env.setNow("2027-11-30T12:00:00Z");
    await relogin(env, late);
    const listNov30 = (await myW2(env, late)).json() as {
      w2s: { year: number; downloadable: boolean }[];
    };
    env.setNow("2027-12-01T12:00:00Z");
    await relogin(env, late);
    const dec1 = await myPdf(env, late, 2026);
    expect({
      nov30: listNov30.w2s.find((r) => r.year === 2026)?.downloadable,
      dec1: [dec1.statusCode, (dec1.json() as { error?: string }).error],
    }).toEqual({ nov30: true, dec1: [409, "consent_required"] });
  });

  it("CW2 posted 2027-05-01 (+90 days before Oct 15) -> the Oct 15 rule holds: refused on 2027-10-16", async () => {
    env.setNow("2027-10-15T12:00:00Z");
    await relogin(env, early);
    const oct15 = (await myW2(env, early)).json() as {
      w2s: { year: number; downloadable: boolean }[];
    };
    env.setNow("2027-10-16T12:00:00Z");
    await relogin(env, early);
    const oct16 = await myPdf(env, early, 2026);
    expect({
      oct15: oct15.w2s.find((r) => r.year === 2026)?.downloadable,
      oct16: oct16.statusCode,
    }).toEqual({ oct15: true, oct16: 409 });
  });
});

// ---------------------------------------------------------------- WC (withdrawal before a correction)

describe("WC withdrawal after the online W-2, before its correction: post online (IMPORTANT) AND paper", () => {
  let env: Env;
  let e: Emp;
  beforeAll(async () => {
    env = await boot({ now: JAN_4_2027 });
    await seedContact(env);
    e = await makeEmp(env, { label: "Wcorr", login: true, consent: NEW_VERSION, years: [2026] });
    await sendW2AvailableNotices(deps(env), { today: "2027-01-04" });
    env.setNow("2027-02-01T10:00:00Z");
    await relogin(env, e);
    const del = await deleteConsent(env, e);
    if (del.statusCode !== 200) throw new Error(`withdraw ${del.statusCode}`);
    // A late December 2026 run changes the figures after the withdrawal.
    await insertRun(env as never, e.id, {
      payDate: "2026-12-31",
      periodStart: "2026-12-31",
      periodEnd: "2026-12-31",
      grossCents: 100_000,
      fitCents: 10_000,
      state: null,
    });
    await reloginAdmin(env);
  }, 240_000);
  afterAll(async () => env.close());

  it("the corrected W-2 is posted (corrected portal_notice) with the IMPORTANT w2_changed mail, and the admin row still asks for a paper copy", async () => {
    const out = await correct(env, e.id, 2026, "2027-02-02");
    const rows = await furnishings(env, e.id, 2026);
    const mails = await outbox(env, e.userId, "w2_changed");
    const row = (await adminList(env, 2026)).w2s.find((r) => r.employeeId === e.id)!;
    expect({
      out: out !== null,
      lastPortalCorrected: rows.filter((r) => r.method === "portal_notice").at(-1)?.corrected,
      portalRows: rows.filter((r) => r.method === "portal_notice").length,
      important: mails.map((m) => m.subject.startsWith(IMPORTANT)),
      paperOwed: row.correctionToFurnish,
    }).toEqual({
      out: true,
      lastPortalCorrected: true,
      portalRows: 2,
      important: [true],
      paperOwed: true,
    });
  });
});

// ---------------------------------------------------------------- UN ((j)(5)(ii))

describe("UN undeliverable consented notices are listed for the admin ((j)(5)(ii))", () => {
  let env: Env;
  const e: Record<string, Emp> = {};
  beforeAll(async () => {
    env = await boot({ now: JAN_4_2027 });
    await seedContact(env);
    e.failedLegal = await makeEmp(env, {
      label: "Unfailed",
      login: true,
      consent: NEW_VERSION,
      years: [2026],
    });
    e.failedPaper = await makeEmp(env, { label: "Unpaper", login: true, years: [2026] });
    e.sentLegal = await makeEmp(env, {
      label: "Unsent",
      login: true,
      consent: NEW_VERSION,
      years: [2026],
    });
    await sendW2AvailableNotices(deps(env), { today: "2027-01-04" });
    await env.t.db
      .update(emailOutbox)
      .set({ status: "failed", attempts: 5, lastError: "550 mailbox unavailable" })
      .where(inArray(emailOutbox.userId, [e.failedLegal!.userId!, e.failedPaper!.userId!]));
    await env.t.db
      .update(emailOutbox)
      .set({ status: "sent" })
      .where(eq(emailOutbox.userId, e.sentLegal!.userId!));
  }, 240_000);
  afterAll(async () => env.close());

  it("2026 list: undeliveredNotices names the consented employee whose w2_available failed — not the paper one, not the delivered one; no email address, no amounts", async () => {
    const l = await adminList(env, 2026);
    const list = (l.undeliveredNotices ?? null) as
      | { employeeId: number; legalName: string }[]
      | null;
    const json = JSON.stringify(list);
    expect({
      ids: list?.map((x) => x.employeeId).sort(),
      name: list?.[0]?.legalName,
      noEmail: !json.includes("@"),
      noAmount: !hasAmount(scrub(json)),
      y2025:
        ((await adminList(env, 2025)).undeliveredNotices as unknown[] | undefined)?.length ?? null,
    }).toEqual({
      ids: [e.failedLegal!.id],
      name: await legalName(env, e.failedLegal!.id),
      noEmail: true,
      noAmount: true,
      y2025: 0,
    });
  });
});

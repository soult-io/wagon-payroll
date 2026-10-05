/**
 * PAY-208 fix round 2 — federal SME (F1, N1-N4) and code-review (C-L5,
 * C-L6, C-L7, company-local date) items (payroll-calc-auditor, fail-first
 * against c761fff; the coder may not edit this file). Synthetic data only.
 * Legal source: 26 CFR 31.6051-1(j) (pay-208-harness.ts header).
 *
 * Tests: F1a-c, N1, N2a-b, N3, N4, CL5, CL6, CL7, LD1-LD3.
 *
 * Contract assumed:
 *  - F1 ((j)(3)(vii)): PUT /api/admin/company that changes the address,
 *    while the W-2 contact is complete and has no address of its own (so
 *    the company address IS the contact's mailing address), queues one
 *    w2_contact_changed per employee with a non-withdrawn consent and a
 *    login — the same recipients as the W-2 contact save. Name-only change,
 *    or a contact with its own address -> no mail.
 *  - N1: GET /api/my/w2 rows carry `accessThrough` (ISO date):
 *    electronicW2AccessThrough(year, company-local date of the latest
 *    corrected portal_notice).
 *  - N2: the consented corrected notice (w2_changed) says "It stays
 *    available there through {long date}." — that same date.
 *  - N3: an employee_download before the withdrawal counts as online
 *    furnishing (correction posted online + paper owed).
 *  - N4: undeliveredNotices rows gain `failedOn` (company-local ISO date of
 *    the failed attempt); a row drops once a paper_handed or admin_print
 *    furnishing for the year is recorded AFTER the failure.
 *  - C-L5: a consent while the year notice is running (paper notice queued,
 *    the year not yet in the notified years) still ends with one
 *    portal_notice and one IMPORTANT mail; finishing the run adds nothing.
 *  - C-L6: two concurrent withdrawals -> one confirmation mail, one audit
 *    row (regression guard: PGlite serialises transactions, so this cannot
 *    fail on the old code here).
 *  - C-L7: after a corrected posting extends the window, a later
 *    correction for an employee who withdrew is still posted online while
 *    inside electronicW2AccessThrough(year, latest corrected posting).
 *  - LD: the January gate in sendW2AvailableNotices (default today),
 *    myUpcomingW2Year / the /api/my/w2 year list and furnishAfterConsent
 *    use the company-local date (config.appTz), not the UTC date.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { appSettings, emailOutbox } from "@payroll/db";
import { sendW2AvailableNotices } from "../src/filings/annual.js";
import { furnishCorrectionIfNeeded } from "../src/filings/w2-furnish.js";
import { insertRun } from "./w2-state-harness.js";
import {
  adminList,
  auditRows,
  boot,
  call,
  CONTACT,
  CONTACT_ADDRESS,
  deleteConsent,
  deps,
  type Emp,
  type Env,
  furnishings,
  IMPORTANT,
  makeEmp,
  myW2,
  NEW_VERSION,
  OLD_VERSION,
  outbox,
  plain,
  postConsent,
  putContact,
  relogin,
  reloginAdmin,
} from "./pay-208-harness.js";

const CONTACT_CHANGED = "w2_contact_changed";
const ADDR_A = {
  line1: "1 Synthetic Plaza",
  city: "Fixtureville",
  state: "TX",
  zip: "75001",
  country: "US",
};
const ADDR_B = {
  line1: "2 Synthetic Plaza",
  city: "Fixtureville",
  state: "TX",
  zip: "75002",
  country: "US",
};

async function rawFurnishing(
  env: Env,
  r: { id: number; year: number; method: string; corrected: boolean; at: string; hash?: string },
) {
  await env.t.pglite.query(
    `INSERT INTO w2_furnishings (employee_id, tax_year, boxes_hash, hash_version, corrected, method, furnished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [r.id, r.year, r.hash ?? "a".repeat(64), r.year >= 2026 ? 2 : 1, r.corrected, r.method, r.at],
  );
}

async function correct(env: Env, id: number, year: number, today: string) {
  return env.t.db.transaction((tx) =>
    furnishCorrectionIfNeeded(tx as never, env.t.config, id, year, today),
  );
}

async function lateRun(env: Env, id: number, cents = 100_000) {
  await insertRun(env as never, id, {
    payDate: "2026-12-31",
    periodStart: "2026-12-31",
    periodEnd: "2026-12-31",
    grossCents: cents,
    fitCents: 10_000,
    state: null,
  });
}

// ---------------------------------------------------------------- F1

describe("F1 a company address change is a W-2 contact change when the contact uses it ((j)(3)(vii))", () => {
  let env: Env;
  const e: Record<string, Emp> = {};
  const count = async (k: string) => (await outbox(env, e[k]!.userId, CONTACT_CHANGED)).length;
  const putCompany = (legalName: string, address: unknown) =>
    call(env, "PUT", "/api/admin/company", env.admin, { legalName, address });
  beforeAll(async () => {
    env = await boot({ now: "2027-01-04T10:00:00Z" });
    await putCompany("Example Corp", ADDR_A);
    await putContact(env, { ...CONTACT, mailingAddress: null });
    e.current = await makeEmp(env, { label: "Fcurrent", login: true, consent: NEW_VERSION });
    e.outdated = await makeEmp(env, { label: "Foutdated", login: true, consent: OLD_VERSION });
    e.withdrawn = await makeEmp(env, {
      label: "Fwithdrawn",
      login: true,
      consent: NEW_VERSION,
      withdrawnAt: "2026-12-01T10:00:00Z",
    });
    e.none = await makeEmp(env, { label: "Fnone", login: true });
    e.noLogin = await makeEmp(env, { label: "Fnologin", consent: NEW_VERSION });
  }, 240_000);
  afterAll(async () => env.close());

  it("F1a address change, contact without own address -> exactly one w2_contact_changed per non-withdrawn consenter with a login, showing the new address", async () => {
    const res = await putCompany("Example Corp", ADDR_B);
    const mail = (await outbox(env, e.current!.userId, CONTACT_CHANGED))[0];
    expect({
      status: res.statusCode,
      current: await count("current"),
      outdated: await count("outdated"),
      withdrawn: await count("withdrawn"),
      none: await count("none"),
      newAddress: plain(mail?.bodyHtml ?? "").includes(ADDR_B.line1),
      contactName: plain(mail?.bodyHtml ?? "").includes(CONTACT.name),
    }).toEqual({
      status: 200,
      current: 1,
      outdated: 1,
      withdrawn: 0,
      none: 0,
      newAddress: true,
      contactName: true,
    });
  });

  it("F1b legal-name-only change (same address) -> no new mail", async () => {
    const before = (await outbox(env, e.current!.userId, CONTACT_CHANGED)).length;
    const res = await putCompany("Example Corp Renamed", ADDR_B);
    expect({ status: res.statusCode, added: (await count("current")) - before }).toEqual({
      status: 200,
      added: 0,
    });
  });

  it("F1c the contact has its own address -> a company address change mails nobody", async () => {
    await putContact(env, { ...CONTACT, mailingAddress: CONTACT_ADDRESS });
    const before = (await outbox(env, e.current!.userId, CONTACT_CHANGED)).length;
    const res = await putCompany("Example Corp Renamed", ADDR_A);
    expect({ status: res.statusCode, added: (await count("current")) - before }).toEqual({
      status: 200,
      added: 0,
    });
  });
});

// ---------------------------------------------------------------- N1, N2

describe("N1 /api/my/w2 accessThrough per year; N2 the corrected notice states it", () => {
  let env: Env;
  let e: Emp;
  let f: Emp;
  beforeAll(async () => {
    env = await boot({ now: "2027-09-02T10:00:00Z" });
    await putContact(env, { ...CONTACT, mailingAddress: CONTACT_ADDRESS });
    e = await makeEmp(env, {
      label: "Accessthrough",
      login: true,
      consent: NEW_VERSION,
      years: [2025, 2026],
    });
    f = await makeEmp(env, {
      label: "Correctednote",
      login: true,
      consent: NEW_VERSION,
      years: [2026],
    });
    // A corrected posting of 2026 on 2027-09-01 (+90 days = 2027-11-30).
    await rawFurnishing(env, {
      id: e.id,
      year: 2026,
      method: "portal_notice",
      corrected: false,
      at: "2027-01-04T10:00:00Z",
    });
    await rawFurnishing(env, {
      id: e.id,
      year: 2026,
      method: "portal_notice",
      corrected: true,
      at: "2027-09-01T10:00:00Z",
      hash: "c".repeat(64),
    });
  }, 240_000);
  afterAll(async () => env.close());

  it("N1 2026 (corrected posted 2027-09-01) -> 2027-11-30; 2025 -> 2026-10-15", async () => {
    const rows = (
      (await myW2(env, e)).json() as { w2s: { year: number; accessThrough?: string }[] }
    ).w2s;
    expect(Object.fromEntries(rows.map((r) => [r.year, r.accessThrough]))).toEqual({
      2025: "2026-10-15",
      2026: "2027-11-30",
    });
  });

  it("N2a a consented correction posted 2027-09-02 (+90 days = Dec 1) says 'It stays available there through December 1, 2027.'", async () => {
    await rawFurnishing(env, {
      id: f.id,
      year: 2026,
      method: "portal_notice",
      corrected: false,
      at: "2027-01-04T10:00:00Z",
    });
    const out = await correct(env, f.id, 2026, "2027-09-02");
    const mail = (await outbox(env, f.userId, "w2_changed")).at(-1);
    expect({
      out,
      important: mail?.subject.startsWith(IMPORTANT),
      line: plain(mail?.bodyHtml ?? "").includes(
        "It stays available there through December 1, 2027.",
      ),
    }).toEqual({ out: "w2_changed_notice_sent", important: true, line: true });
  });
});

describe("N2b a correction posted early in the year keeps the October 15 date", () => {
  let env: Env;
  let e: Emp;
  beforeAll(async () => {
    env = await boot({ now: "2027-02-01T10:00:00Z" });
    await putContact(env, { ...CONTACT, mailingAddress: CONTACT_ADDRESS });
    e = await makeEmp(env, {
      label: "Earlycorr",
      login: true,
      consent: NEW_VERSION,
      years: [2026],
    });
    await rawFurnishing(env, {
      id: e.id,
      year: 2026,
      method: "portal_notice",
      corrected: false,
      at: "2027-01-04T10:00:00Z",
    });
  }, 180_000);
  afterAll(async () => env.close());

  it("posted 2027-02-01 (+90 days before Oct 15) -> 'It stays available there through October 15, 2027.'", async () => {
    const out = await correct(env, e.id, 2026, "2027-02-01");
    const mail = (await outbox(env, e.userId, "w2_changed")).at(-1);
    expect({
      out,
      line: plain(mail?.bodyHtml ?? "").includes(
        "It stays available there through October 15, 2027.",
      ),
    }).toEqual({ out: "w2_changed_notice_sent", line: true });
  });
});

// ---------------------------------------------------------------- N3

describe("N3 an employee_download before the withdrawal counts as online furnishing", () => {
  let env: Env;
  let e: Emp;
  beforeAll(async () => {
    env = await boot({ now: "2027-02-05T10:00:00Z" });
    await putContact(env, { ...CONTACT, mailingAddress: CONTACT_ADDRESS });
    e = await makeEmp(env, {
      label: "Downloadonly",
      login: true,
      consent: NEW_VERSION,
      withdrawnAt: "2027-02-01T10:00:00Z",
      years: [2026],
    });
    // Downloaded online on 2027-01-10 (no portal_notice), then withdrew.
    await rawFurnishing(env, {
      id: e.id,
      year: 2026,
      method: "employee_download",
      corrected: false,
      at: "2027-01-10T10:00:00Z",
    });
  }, 180_000);
  afterAll(async () => env.close());

  it("the correction is posted online (corrected portal_notice + IMPORTANT mail) and paper is owed", async () => {
    const out = await correct(env, e.id, 2026, "2027-02-05");
    const rows = await furnishings(env, e.id, 2026);
    const row = (await adminList(env, 2026)).w2s.find((r) => r.employeeId === e.id)!;
    expect({
      out,
      posted: rows.filter((r) => r.method === "portal_notice" && r.corrected).length,
      important: (await outbox(env, e.userId, "w2_changed")).map((m) =>
        m.subject.startsWith(IMPORTANT),
      ),
      paperOwed: row.correctionToFurnish,
    }).toEqual({ out: "w2_changed_notice_sent", posted: 1, important: [true], paperOwed: true });
  });
});

// ---------------------------------------------------------------- N4

describe("N4 undelivered notices: failure date; dropped once paper is recorded after the failure ((j)(5)(ii))", () => {
  let env: Env;
  const e: Record<string, Emp> = {};
  beforeAll(async () => {
    env = await boot({ now: "2027-01-04T10:00:00Z" });
    await putContact(env, { ...CONTACT, mailingAddress: CONTACT_ADDRESS });
    e.paperBefore = await makeEmp(env, {
      label: "Npaperbefore",
      login: true,
      consent: NEW_VERSION,
      years: [2026],
    });
    e.paperAfter = await makeEmp(env, {
      label: "Npaperafter",
      login: true,
      consent: NEW_VERSION,
      years: [2026],
    });
    e.printAfter = await makeEmp(env, {
      label: "Nprintafter",
      login: true,
      consent: NEW_VERSION,
      years: [2026],
    });
    await sendW2AvailableNotices(deps(env), { today: "2027-01-04" });
    await env.t.db
      .update(emailOutbox)
      .set({
        status: "failed",
        attempts: 5,
        lastError: "550",
        lastAttemptAt: new Date("2027-01-05T10:00:00Z"),
      })
      .where(
        inArray(
          emailOutbox.userId,
          Object.values(e).map((x) => x.userId!),
        ),
      );
    // Paper given BEFORE the failure does not answer it.
    await rawFurnishing(env, {
      id: e.paperBefore!.id,
      year: 2026,
      method: "paper_handed",
      corrected: false,
      at: "2027-01-04T12:00:00Z",
    });
    env.setNow("2027-01-06T10:00:00Z");
    await reloginAdmin(env);
  }, 240_000);
  afterAll(async () => env.close());

  it("paper_handed and admin_print recorded after the failure drop those names; the other stays with failedOn 2027-01-05", async () => {
    const paper = await call(
      env,
      "POST",
      `/api/admin/annual-forms/w2/${e.paperAfter!.id}/furnished-on-paper?year=2026`,
      env.admin,
      {},
    );
    const print = await env.t.app.inject({
      method: "GET",
      url: `/api/admin/annual-forms/w2/${e.printAfter!.id}/print-packet?year=2026`,
      headers: { ...env.admin, "x-forwarded-for": "10.213.0.1" },
      remoteAddress: "10.213.0.1",
    });
    const list = ((await adminList(env, 2026)).undeliveredNotices ?? []) as {
      employeeId: number;
      failedOn?: string;
    }[];
    expect({
      paper: paper.statusCode,
      print: print.statusCode,
      list: list.map((x) => ({ employeeId: x.employeeId, failedOn: x.failedOn })),
    }).toEqual({
      paper: 200,
      print: 200,
      list: [{ employeeId: e.paperBefore!.id, failedOn: "2027-01-05" }],
    });
  });
});

// ---------------------------------------------------------------- C-L5

describe("CL5 consent while the year-notice run is in progress still ends furnished online", () => {
  let env: Env;
  let e: Emp;
  beforeAll(async () => {
    env = await boot({ now: "2027-01-04T10:00:00Z" });
    await putContact(env, { ...CONTACT, mailingAddress: CONTACT_ADDRESS });
    e = await makeEmp(env, { label: "Midrun", login: true, years: [2026] });
    // The run queued this employee's paper notice but has not yet recorded
    // 2026 as notified (simulated: the record is removed).
    await sendW2AvailableNotices(deps(env), { today: "2027-01-04" });
    await env.t.db.delete(appSettings).where(eq(appSettings.key, "w2_available_notified_years"));
  }, 180_000);
  afterAll(async () => env.close());

  it("consent -> one portal_notice + one IMPORTANT mail; the run finishing afterwards adds nothing", async () => {
    const post = await postConsent(env, e);
    const afterConsent = {
      portal: (await furnishings(env, e.id, 2026)).filter((r) => r.method === "portal_notice")
        .length,
      important: (await outbox(env, e.userId, "w2_available")).filter((m) =>
        m.subject.startsWith(IMPORTANT),
      ).length,
    };
    await sendW2AvailableNotices(deps(env), { today: "2027-01-04" });
    expect({
      post: post.statusCode,
      afterConsent,
      afterRun: {
        portal: (await furnishings(env, e.id, 2026)).filter((r) => r.method === "portal_notice")
          .length,
        important: (await outbox(env, e.userId, "w2_available")).filter((m) =>
          m.subject.startsWith(IMPORTANT),
        ).length,
      },
    }).toEqual({
      post: 200,
      afterConsent: { portal: 1, important: 1 },
      afterRun: { portal: 1, important: 1 },
    });
  });
});

// ---------------------------------------------------------------- C-L6

describe("CL6 two concurrent withdrawals (regression guard)", () => {
  let env: Env;
  let e: Emp;
  beforeAll(async () => {
    env = await boot({ now: "2027-01-04T10:00:00Z" });
    await putContact(env, { ...CONTACT, mailingAddress: CONTACT_ADDRESS });
    e = await makeEmp(env, { label: "Doublewd", login: true, consent: NEW_VERSION, years: [2026] });
  }, 180_000);
  afterAll(async () => env.close());

  it("both 200; one w2_consent_withdrawn mail; one w2_consent.withdraw audit row", async () => {
    const out = await Promise.all([deleteConsent(env, e), deleteConsent(env, e)]);
    expect({
      statuses: out.map((r) => r.statusCode),
      mails: (await outbox(env, e.userId, "w2_consent_withdrawn")).length,
      audits: (await auditRows(env, "w2_consent.withdraw", String(e.id))).length,
    }).toEqual({ statuses: [200, 200], mails: 1, audits: 1 });
  });
});

// ---------------------------------------------------------------- C-L7

describe("CL7 the online cutoff for a withdrawn employee follows the extended window", () => {
  let env: Env;
  let e: Emp;
  beforeAll(async () => {
    env = await boot({ now: "2027-11-01T10:00:00Z" });
    await putContact(env, { ...CONTACT, mailingAddress: CONTACT_ADDRESS });
    e = await makeEmp(env, {
      label: "Extendedcut",
      login: true,
      consent: NEW_VERSION,
      withdrawnAt: "2027-02-01T10:00:00Z",
      years: [2026],
    });
    await rawFurnishing(env, {
      id: e.id,
      year: 2026,
      method: "portal_notice",
      corrected: false,
      at: "2027-01-04T10:00:00Z",
    });
    // Corrected posting 2027-09-01 -> window through 2027-11-30.
    await rawFurnishing(env, {
      id: e.id,
      year: 2026,
      method: "portal_notice",
      corrected: true,
      at: "2027-09-01T10:00:00Z",
      hash: "c".repeat(64),
    });
  }, 180_000);
  afterAll(async () => env.close());

  it("a further correction on 2027-11-01 (after Oct 15, inside Nov 30) is posted online with the IMPORTANT notice", async () => {
    const out = await correct(env, e.id, 2026, "2027-11-01");
    expect({
      out,
      important: (await outbox(env, e.userId, "w2_changed")).map((m) =>
        m.subject.startsWith(IMPORTANT),
      ),
    }).toEqual({ out: "w2_changed_notice_sent", important: [true] });
  });
});

// ---------------------------------------------------------------- LD (company-local date)

describe("LD1 Los Angeles, 2027-01-01T03:00Z (still Dec 31 locally): 2026 is not available yet", () => {
  let env: Env;
  let e: Emp;
  beforeAll(async () => {
    env = await boot({ now: "2026-12-31T20:00:00Z", config: { appTz: "America/Los_Angeles" } });
    await putContact(env, { ...CONTACT, mailingAddress: CONTACT_ADDRESS });
    e = await makeEmp(env, { label: "Ladate", login: true, consent: NEW_VERSION, years: [2026] });
    env.setNow("2027-01-01T03:00:00Z");
    await relogin(env, e);
  }, 180_000);
  afterAll(async () => env.close());

  it("sendW2AvailableNotices (default today) sends nothing; /api/my/w2 lists no 2026 row and upcomingYear 2026", async () => {
    const sent = await sendW2AvailableNotices(deps(env));
    const list = (await myW2(env, e)).json() as {
      w2s: { year: number }[];
      upcomingYear: number | null;
    };
    expect({
      sent: sent.sent,
      years: list.w2s.map((r) => r.year),
      upcomingYear: list.upcomingYear,
    }).toEqual({ sent: 0, years: [], upcomingYear: 2026 });
  });
});

describe("LD2 Tokyo, 2026-12-31T20:00Z (already Jan 1 locally): 2026 is available", () => {
  let env: Env;
  let e: Emp;
  beforeAll(async () => {
    env = await boot({ now: "2026-12-31T19:00:00Z", config: { appTz: "Asia/Tokyo" } });
    await putContact(env, { ...CONTACT, mailingAddress: CONTACT_ADDRESS });
    e = await makeEmp(env, {
      label: "Tokyodate",
      login: true,
      consent: NEW_VERSION,
      years: [2026],
    });
    env.setNow("2026-12-31T20:00:00Z");
    await relogin(env, e);
  }, 180_000);
  afterAll(async () => env.close());

  it("sendW2AvailableNotices (default today) furnishes and mails the consenter; /api/my/w2 lists 2026, upcomingYear null", async () => {
    const sent = await sendW2AvailableNotices(deps(env));
    const list = (await myW2(env, e)).json() as {
      w2s: { year: number }[];
      upcomingYear: number | null;
    };
    expect({
      sent: sent.sent,
      portal: (await furnishings(env, e.id, 2026)).map((r) => r.method),
      years: list.w2s.map((r) => r.year),
      upcomingYear: list.upcomingYear,
    }).toEqual({ sent: 1, portal: ["portal_notice"], years: [2026], upcomingYear: null });
  });
});

describe("LD3 Tokyo, local Jan 1: a consent then is furnished (furnishAfterConsent uses the local date)", () => {
  let env: Env;
  let e: Emp;
  beforeAll(async () => {
    env = await boot({ now: "2026-12-31T19:00:00Z", config: { appTz: "Asia/Tokyo" } });
    await putContact(env, { ...CONTACT, mailingAddress: CONTACT_ADDRESS });
    e = await makeEmp(env, { label: "Tokyoconsent", login: true, years: [2026] });
    await env.t.db
      .insert(appSettings)
      .values({ key: "w2_available_notified_years", value: [2026], updatedAt: new Date() })
      .onConflictDoUpdate({ target: [appSettings.key], set: { value: [2026] } });
    env.setNow("2026-12-31T20:00:00Z");
    await relogin(env, e);
  }, 180_000);
  afterAll(async () => env.close());

  it("POST consent -> one portal_notice and one IMPORTANT w2_available mail", async () => {
    const post = await postConsent(env, e);
    expect({
      post: post.statusCode,
      portal: (await furnishings(env, e.id, 2026)).map((r) => r.method),
      important: (await outbox(env, e.userId, "w2_available")).map((m) =>
        m.subject.startsWith(IMPORTANT),
      ),
    }).toEqual({ post: 200, portal: ["portal_notice"], important: [true] });
  });
});

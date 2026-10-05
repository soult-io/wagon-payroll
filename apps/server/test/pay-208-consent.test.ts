/**
 * PAY-208 — W-2 electronic consent v2: disclosure version 2026-10, the
 * re-consent rule, consent naming its version, the contact gate, withdrawal
 * confirmation, admin-recorded withdrawal, late-consent furnishing and the
 * pre-January prompt (payroll-calc-auditor, fail-first against d0f722f; the
 * coder may not edit this file). Synthetic data only. Legal source and
 * decisions: pay-208-harness.ts header.
 *
 * Tests: T2, T3, T4, T5, T9, T10, T11, T12, T15, U1-U3 (2.2b upcomingYear),
 * V1 (versioned disclosures, A4).
 *
 * Contract assumed (build brief §2, §4; copy file):
 *  - w2-consent.ts exports W2_DISCLOSURE_VERSION = "2026-10",
 *    W2_CONSENT_GATE_FROM_TAX_YEAR = 2026, W2_CONSENT_VERSIONS_FROM_2026
 *    (Set, has "2026-10"), consentCoversYear(row | undefined, taxYear),
 *    W2_DISCLOSURES_BY_VERSION { "2025-01", "2026-10" } of
 *    (ctx) => string[]; annual.ts no longer exports hasActiveW2Consent.
 *  - GET /api/my/w2/consent -> { consented, outdated, consentedAt,
 *    withdrawnAt, consentedVersion, disclosureVersion (current),
 *    disclosures (current, rendered), contactReady, contact }.
 *  - POST /api/my/w2/consent body { disclosureVersion, accessCode } -> 409
 *    { error: "disclosure_changed" } unless the version equals the current
 *    one; 409 { error: "w2_contact_missing" } without a complete W-2
 *    contact; 409 access_check_failed (D-B, pay-208-access-check.test.ts).
 *    Precedence: disclosure_changed, then w2_contact_missing, then the
 *    access check; the first two neither consume a code nor count as a
 *    failed attempt.
 *    re-consent of an outdated row updates it, audit "w2_consent.reconsent"
 *    (before.disclosureVersion old, after.disclosureVersion new).
 *  - DELETE /api/my/w2/consent -> + effectiveOn (company-local ISO date);
 *    queues one EVENT_TYPE.w2ConsentWithdrawn = "w2_consent_withdrawn" mail.
 *  - POST/DELETE consent and the admin withdrawal refuse cross-site
 *    (403 { error: "cross_site" }).
 *  - POST /api/admin/employees/:employeeId/w2-consent/withdraw (admin) ->
 *    200 { ..., effectiveOn, confirmation }, confirmation "paper_needed"
 *    when the employee has no login; 404 when no consent is on file.
 *  - GET /api/admin/employees/:employeeId -> w2Consent { state:
 *    none|current|outdated|withdrawn, consentedAt, withdrawnAt } (top level
 *    or inside `employee`).
 *  - GET /api/my/w2 -> + upcomingYear (latest issued year not yet available).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { company, notificationSettings } from "@payroll/db";
import { sendW2AvailableNotices } from "../src/filings/annual.js";
import { drainOutbox } from "../src/notify/outbox.js";
import {
  allOutbox,
  auditRows,
  boot,
  call,
  CONTACT,
  CONTACT_ADDRESS,
  consentModule,
  consentRow,
  deleteConsent,
  deps,
  DISCLOSURES_2025_01,
  type ConsentBody,
  type Emp,
  type Env,
  furnishings,
  getConsent,
  hasAmount,
  IMPORTANT,
  makeEmp,
  myPdf,
  myW2,
  need,
  NEW_VERSION,
  notificationsModule,
  OLD_VERSION,
  outbox,
  plain,
  postConsent,
  relogin,
  scrub,
  seedContact,
  SME_SENTENCE,
  SSN_FORMS,
} from "./pay-208-harness.js";

const W2_WITHDRAWN = "w2_consent_withdrawn";
const JAN_4_2027 = "2027-01-04T10:00:00Z";

async function companyName(env: Env): Promise<string> {
  return (await env.t.db.select({ n: company.legalName }).from(company).limit(1))[0]!.n;
}

type W2Row = { year: number; ready: boolean; downloadable: boolean };
async function myRows(env: Env, emp: Emp): Promise<{ w2s: W2Row[]; upcomingYear?: number | null }> {
  const res = await myW2(env, emp);
  if (res.statusCode !== 200) throw new Error(`GET /api/my/w2 ${res.statusCode}: ${res.body}`);
  return res.json();
}
const dl = (rows: W2Row[], year: number) => rows.find((r) => r.year === year)?.downloadable;

// ---------------------------------------------------------------- T5 + V1 (pure)

describe("T5 consentCoversYear (re-consent rule: Y < 2026 or version 2026-10) + V1 versions", () => {
  it("T5 the rule table", async () => {
    const mod = await consentModule();
    const covers = need(mod, "consentCoversYear") as (
      row: { disclosureVersion: string; withdrawnAt: Date | null } | undefined,
      y: number,
    ) => boolean;
    const active = (v: string) => ({ disclosureVersion: v, withdrawnAt: null });
    const withdrawn = {
      disclosureVersion: NEW_VERSION,
      withdrawnAt: new Date("2026-11-01T00:00:00Z"),
    };
    expect({
      undefined2025: covers(undefined, 2025),
      withdrawn2026: covers(withdrawn, 2026),
      withdrawn2025: covers(withdrawn, 2025),
      old2025: covers(active(OLD_VERSION), 2025),
      old2026: covers(active(OLD_VERSION), 2026),
      new2026: covers(active(NEW_VERSION), 2026),
      new2025: covers(active(NEW_VERSION), 2025),
      bogus2026: covers(active("bogus"), 2026),
      old2027: covers(active(OLD_VERSION), 2027),
      new2027: covers(active(NEW_VERSION), 2027),
    }).toEqual({
      undefined2025: false,
      withdrawn2026: false,
      withdrawn2025: false,
      old2025: true,
      old2026: false,
      new2026: true,
      new2025: true,
      bogus2026: false,
      old2027: false,
      new2027: true,
    });
  });

  it("T5 constants: current version 2026-10, gate year 2026, 2026 set has 2026-10 only (not 2025-01); hasActiveW2Consent is gone (A2)", async () => {
    const mod = await consentModule();
    const set = need(mod, "W2_CONSENT_VERSIONS_FROM_2026") as ReadonlySet<string>;
    const annual = (await import("../src/filings/annual.js")) as Record<string, unknown>;
    expect({
      version: mod.W2_DISCLOSURE_VERSION,
      gate: mod.W2_CONSENT_GATE_FROM_TAX_YEAR,
      hasNew: set.has(NEW_VERSION),
      hasOld: set.has(OLD_VERSION),
      hasActiveW2Consent: typeof annual.hasActiveW2Consent,
    }).toEqual({
      version: NEW_VERSION,
      gate: 2026,
      hasNew: true,
      hasOld: false,
      hasActiveW2Consent: "undefined",
    });
  });

  it("V1 (A4) the 2025-01 text is kept byte-for-byte; versions are exactly 2025-01 and 2026-10", async () => {
    const mod = await consentModule();
    const byVersion = need(mod, "W2_DISCLOSURES_BY_VERSION") as Record<
      string,
      (c: unknown) => string[]
    >;
    const ctx = {
      companyName: "Example Corp",
      legalName: "Example Corp",
      contact: { ...CONTACT, mailingAddress: CONTACT_ADDRESS },
    };
    expect({
      keys: Object.keys(byVersion).sort(),
      old: [...byVersion[OLD_VERSION]!(ctx)],
    }).toEqual({ keys: [OLD_VERSION, NEW_VERSION], old: [...DISCLOSURES_2025_01] });
  });
});

// ---------------------------------------------------------------- T2

describe("T2 no W-2 contact -> consent closed (A6, OD1; (j)(3)(v)(A))", () => {
  let env: Env;
  let e: Emp;
  beforeAll(async () => {
    env = await boot({ now: JAN_4_2027 });
    e = await makeEmp(env, { label: "Nocontact", login: true, years: [2026] });
  }, 180_000);
  afterAll(async () => env.close());

  it("GET contactReady:false, contact:null; POST (current version) -> 409 w2_contact_missing; no row; no audit", async () => {
    const get = await getConsent(env, e);
    const body = get.json() as ConsentBody;
    const post = await postConsent(env, e);
    expect({
      getStatus: get.statusCode,
      contactReady: body.contactReady,
      contact: body.contact,
      disclosureVersion: body.disclosureVersion,
      postStatus: post.statusCode,
      postError: (post.json() as { error?: string }).error,
      rows: (await consentRow(env, e.id)).length,
      audits:
        (await auditRows(env, "w2_consent.consent")).length +
        (await auditRows(env, "w2_consent.reconsent")).length,
    }).toEqual({
      getStatus: 200,
      contactReady: false,
      contact: null,
      disclosureVersion: NEW_VERSION,
      postStatus: 409,
      postError: "w2_contact_missing",
      rows: 0,
      audits: 0,
    });
  });

  it("T2b contact without any mailing address (W-2 contact address null, company address null) is not ready", async () => {
    const put = await call(env, "PUT", "/api/admin/company/w2-contact", env.admin, {
      ...CONTACT,
      mailingAddress: null,
    });
    const body = (await getConsent(env, e)).json() as ConsentBody;
    const post = await postConsent(env, e);
    expect({
      put: put.statusCode,
      contactReady: body.contactReady,
      post: post.statusCode,
      error: (post.json() as { error?: string }).error,
    }).toEqual({ put: 200, contactReady: false, post: 409, error: "w2_contact_missing" });
  });
});

// ---------------------------------------------------------------- T3

describe("T3 consent names the version it agrees to (A5)", () => {
  let env: Env;
  let e: Emp;
  beforeAll(async () => {
    env = await boot({ now: JAN_4_2027 });
    e = await makeEmp(env, { label: "Version", login: true, years: [2026] });
  }, 180_000);
  afterAll(async () => env.close());

  it("POST {} / {2025-01} / {2099-01} -> 409 disclosure_changed, no row; then the current version -> 200 consented, row 2026-10, audit w2_consent.consent", async () => {
    const contactPut = await seedContact(env);
    const bad: unknown[] = [];
    for (const body of [{}, { disclosureVersion: OLD_VERSION }, { disclosureVersion: "2099-01" }]) {
      const r = await postConsent(env, e, body);
      bad.push({ status: r.statusCode, error: (r.json() as { error?: string }).error });
    }
    const rowsAfterBad = (await consentRow(env, e.id)).length;
    const ok = await postConsent(env, e);
    const okBody = ok.json() as ConsentBody;
    const rows = await consentRow(env, e.id);
    const audit = await auditRows(env, "w2_consent.consent", String(e.id));
    expect({
      contactPut,
      bad,
      rowsAfterBad,
      ok: ok.statusCode,
      consented: okBody.consented,
      outdated: okBody.outdated,
      consentedVersion: okBody.consentedVersion,
      rowVersion: rows.map((r) => r.disclosureVersion),
      audits: audit.length,
      auditAfterVersion: (audit[0]?.after as { disclosureVersion?: string } | undefined)
        ?.disclosureVersion,
    }).toEqual({
      contactPut: 200,
      bad: [
        { status: 409, error: "disclosure_changed" },
        { status: 409, error: "disclosure_changed" },
        { status: 409, error: "disclosure_changed" },
      ],
      rowsAfterBad: 0,
      ok: 200,
      consented: true,
      outdated: false,
      consentedVersion: NEW_VERSION,
      rowVersion: [NEW_VERSION],
      audits: 1,
      auditAfterVersion: NEW_VERSION,
    });
  });

  it("GET carries the contact (all four (j)(3)(v)(A) details) and contactReady:true", async () => {
    const body = (await getConsent(env, e)).json() as ConsentBody;
    expect({ contactReady: body.contactReady, contact: body.contact }).toMatchObject({
      contactReady: true,
      contact: { ...CONTACT, mailingAddress: CONTACT_ADDRESS },
    });
  });
});

// ---------------------------------------------------------------- T4

describe("T4 an outdated 2025-01 consent is re-consented in place", () => {
  let env: Env;
  let e: Emp;
  beforeAll(async () => {
    env = await boot({ now: JAN_4_2027 });
    await seedContact(env);
    e = await makeEmp(env, {
      label: "Outdated",
      login: true,
      consent: OLD_VERSION,
      consentedAt: "2025-06-01T10:00:00Z",
      years: [2025, 2026],
    });
  }, 180_000);
  afterAll(async () => env.close());

  it("GET: consented false, outdated true, consentedVersion 2025-01, current version + 2026-10 text (SME sentence)", async () => {
    const body = (await getConsent(env, e)).json() as ConsentBody;
    expect({
      consented: body.consented,
      outdated: body.outdated,
      consentedVersion: body.consentedVersion,
      disclosureVersion: body.disclosureVersion,
      sme: body.disclosures.join(" ").includes(SME_SENTENCE),
    }).toEqual({
      consented: false,
      outdated: true,
      consentedVersion: OLD_VERSION,
      disclosureVersion: NEW_VERSION,
      sme: true,
    });
  });

  it("POST: same row updated to 2026-10, new consented_at, audit w2_consent.reconsent (before 2025-01, after 2026-10); a second POST writes nothing", async () => {
    const first = await postConsent(env, e);
    const rows = await consentRow(env, e.id);
    const audit = await auditRows(env, "w2_consent.reconsent", String(e.id));
    env.tick();
    const second = await postConsent(env, e);
    const rows2 = await consentRow(env, e.id);
    const audit2 = await auditRows(env, "w2_consent.reconsent", String(e.id));
    expect({
      first: first.statusCode,
      consented: (first.json() as ConsentBody).consented,
      outdated: (first.json() as ConsentBody).outdated,
      rows: rows.map((r) => ({
        v: r.disclosureVersion,
        withdrawn: r.withdrawnAt,
        newer: r.consentedAt.getTime() > Date.parse("2025-06-01T10:00:00Z"),
      })),
      audit: audit.map((a) => ({
        actor: a.actor_id,
        before: (a.before as { disclosureVersion?: string }).disclosureVersion,
        after: (a.after as { disclosureVersion?: string }).disclosureVersion,
      })),
      second: second.statusCode,
      unchangedAt: rows2[0]!.consentedAt.getTime() === rows[0]!.consentedAt.getTime(),
      audits2: audit2.length,
      consentAudits: (await auditRows(env, "w2_consent.consent", String(e.id))).length,
    }).toEqual({
      first: 200,
      consented: true,
      outdated: false,
      rows: [{ v: NEW_VERSION, withdrawn: null, newer: true }],
      audit: [{ actor: e.userId, before: OLD_VERSION, after: NEW_VERSION }],
      second: 200,
      unchangedAt: true,
      audits2: 1,
      consentAudits: 0,
    });
  });
});

// ---------------------------------------------------------------- T9

describe("T9 outdated consenter: 2025 stays online, 2026 is paper (rule B)", () => {
  let env: Env;
  let e: Emp;
  beforeAll(async () => {
    env = await boot({ now: JAN_4_2027 });
    await seedContact(env);
    e = await makeEmp(env, {
      label: "Ninegate",
      login: true,
      consent: OLD_VERSION,
      years: [2025, 2026],
    });
  }, 180_000);
  afterAll(async () => env.close());

  it("/api/my/w2: 2025 downloadable, 2026 not; PDF 2026 -> 409 consent_required; PDF 2025 -> 200", async () => {
    const rows = (await myRows(env, e)).w2s;
    const p26 = await myPdf(env, e, 2026);
    const p25 = await myPdf(env, e, 2025);
    expect({
      ready: rows.map((r) => [r.year, r.ready]),
      d2025: dl(rows, 2025),
      d2026: dl(rows, 2026),
      pdf2026: [
        p26.statusCode,
        p26.statusCode === 409 ? (p26.json() as { error: string }).error : null,
      ],
      pdf2025: p25.statusCode,
    }).toEqual({
      ready: [
        [2026, true],
        [2025, true],
      ],
      d2025: true,
      d2026: false,
      pdf2026: [409, "consent_required"],
      pdf2025: 200,
    });
  });
});

// ---------------------------------------------------------------- T10

describe("T10 a W-2 furnished online stays downloadable after withdrawal ((j)(3)(v)(C), (j)(6))", () => {
  let env: Env;
  let e: Emp;
  beforeAll(async () => {
    env = await boot({ now: JAN_4_2027 });
    await seedContact(env);
    e = await makeEmp(env, {
      label: "Tenwindow",
      login: true,
      consent: NEW_VERSION,
      years: [2026],
    });
  }, 180_000);
  afterAll(async () => env.close());

  it("notice 2027-01-04 (portal_notice); DELETE 2027-03-01 (effectiveOn 2027-03-01, rows unchanged); downloadable through 2027-10-15 (Fri); 409 from 2027-10-16", async () => {
    await sendW2AvailableNotices(deps(env), { today: "2027-01-04" });
    const furnished = await furnishings(env, e.id, 2026);
    env.setNow("2027-03-01T10:00:00Z");
    await relogin(env, e);
    const del = await deleteConsent(env, e);
    const afterDelete = await furnishings(env, e.id, 2026);
    const dMarch = dl((await myRows(env, e)).w2s, 2026);

    env.setNow("2027-10-15T12:00:00Z");
    await relogin(env, e);
    const lastDay = await myPdf(env, e, 2026);
    const dLast = dl((await myRows(env, e)).w2s, 2026);

    env.setNow("2027-10-16T12:00:00Z");
    await relogin(env, e);
    const after = await myPdf(env, e, 2026);
    const dAfter = dl((await myRows(env, e)).w2s, 2026);
    const end = await furnishings(env, e.id, 2026);
    expect({
      furnished: furnished.map((r) => r.method),
      del: del.statusCode,
      effectiveOn: (del.json() as ConsentBody).effectiveOn,
      rowsUnchangedByDelete: afterDelete.map((r) => r.id),
      dMarch,
      lastDay: lastDay.statusCode,
      dLast,
      after: [after.statusCode, (after.json() as { error?: string }).error],
      dAfter,
      earlierRowsKept: furnished.every((r) =>
        end.some((x) => x.id === r.id && x.method === r.method),
      ),
    }).toEqual({
      furnished: ["portal_notice"],
      del: 200,
      effectiveOn: "2027-03-01",
      rowsUnchangedByDelete: furnished.map((r) => r.id),
      dMarch: true,
      lastDay: 200,
      dLast: true,
      after: [409, "consent_required"],
      dAfter: false,
      earlierRowsKept: true,
    });
  });
});

// ---------------------------------------------------------------- T11

describe("T11 withdrawal confirmation email ((j)(3)(v)(B)) — company-local effective date", () => {
  let env: Env;
  let e: Emp;
  let co: string;
  beforeAll(async () => {
    // 2027-03-01T05:00Z is still 2027-02-28 in Los Angeles (UTC-8).
    env = await boot({ now: "2027-02-28T20:00:00Z", config: { appTz: "America/Los_Angeles" } });
    await seedContact(env);
    co = await companyName(env);
    e = await makeEmp(env, {
      label: "Elevenmail",
      login: true,
      consent: NEW_VERSION,
      years: [2026],
    });
  }, 180_000);
  afterAll(async () => env.close());

  it("DELETE -> effectiveOn 2027-02-28 and exactly one w2_consent_withdrawn mail: S13 subject, long local date, contact, paper, Oct 15, appUrl only; no $, amounts or SSN; a second DELETE adds none", async () => {
    env.setNow("2027-03-01T05:00:00Z");
    await relogin(env, e);
    const del = await deleteConsent(env, e);
    const again = await deleteConsent(env, e);
    const mails = await outbox(env, e.userId, W2_WITHDRAWN);
    const html = mails[0]?.bodyHtml ?? "";
    const text = plain(html);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
    expect({
      del: del.statusCode,
      effectiveOn: (del.json() as ConsentBody).effectiveOn,
      again: again.statusCode,
      mails: mails.length,
      subject: mails[0]?.subject,
      longLocalDate: text.includes("February 28, 2027"),
      notUtcDate: !text.includes("March 1, 2027") && !text.includes("2027-03-01"),
      noIso: !text.includes("2027-02-28"),
      contact: [CONTACT.name, CONTACT.phone, CONTACT.email].every((s) => text.includes(s)),
      paper: /paper/i.test(text),
      oct15: text.includes("October 15"),
      agreeAgain: /agree/i.test(text),
      hrefsPlain: hrefs.every(
        (h) => !h.includes("?") && !h.includes("/api/") && !h.includes(String(e.id)),
      ),
      noAmount: !hasAmount(scrub(text)),
      noSsn: SSN_FORMS.slice(0, 2).every((s) => !html.includes(s)),
    }).toEqual({
      del: 200,
      effectiveOn: "2027-02-28",
      again: 200,
      mails: 1,
      subject: `${co} — Your online W-2 withdrawal is confirmed`,
      longLocalDate: true,
      notUtcDate: true,
      noIso: true,
      contact: true,
      paper: true,
      oct15: true,
      agreeAgain: true,
      hrefsPlain: true,
      noAmount: true,
      noSsn: true,
    });
  });

  it("the event is always on: w2_consent_withdrawn not in WORKFLOW_EVENTS; a disabled setting row does not suppress it", async () => {
    const n = await notificationsModule();
    await env.t.db
      .insert(notificationSettings)
      .values({ userId: e.userId!, eventType: W2_WITHDRAWN, enabled: false })
      .onConflictDoNothing();
    await drainOutbox({
      db: env.t.db,
      config: { ...env.t.config, emailMode: "log" },
      resolveRecipientEmail: async () => "worker@example.com",
    } as never);
    const rows = await outbox(env, e.userId, W2_WITHDRAWN);
    expect({
      type: (n.EVENT_TYPE as Record<string, string>).w2ConsentWithdrawn,
      workflow: (n.WORKFLOW_EVENTS as string[]).includes(W2_WITHDRAWN),
      statuses: rows.map((r) => r.status),
    }).toEqual({ type: W2_WITHDRAWN, workflow: false, statuses: ["sent"] });
  });
});

// ---------------------------------------------------------------- T12

describe("T12 admin-recorded written withdrawal ((j)(3)(v)(A)/(B), OD3) + consent state on the employee detail + cross-site", () => {
  let env: Env;
  let current: Emp;
  let other: Emp;
  let none: Emp;
  let crossed: Emp;
  let noLogin: Emp;
  let outdated: Emp;
  beforeAll(async () => {
    env = await boot({ now: JAN_4_2027 });
    await seedContact(env);
    current = await makeEmp(env, {
      label: "Adminwd",
      login: true,
      consent: NEW_VERSION,
      years: [2026],
    });
    other = await makeEmp(env, {
      label: "Selfwd",
      login: true,
      consent: NEW_VERSION,
      years: [2026],
    });
    none = await makeEmp(env, { label: "Nowd", login: true, years: [2026] });
    crossed = await makeEmp(env, {
      label: "Crosswd",
      login: true,
      consent: NEW_VERSION,
      years: [2026],
    });
    noLogin = await makeEmp(env, { label: "Nologinwd", consent: NEW_VERSION, years: [2026] });
    outdated = await makeEmp(env, {
      label: "Oldwd",
      login: true,
      consent: OLD_VERSION,
      years: [2026],
    });
  }, 240_000);
  afterAll(async () => env.close());

  const url = (id: number) => `/api/admin/employees/${id}/w2-consent/withdraw`;

  it("admin -> 200, effective today (company-local), confirmation mail to the employee, audit w2_consent.withdraw by the admin", async () => {
    const res = await call(env, "POST", url(current.id), env.admin, {});
    const body = res.json() as { effectiveOn?: string; confirmation?: string };
    const rows = await consentRow(env, current.id);
    const audit = await auditRows(env, "w2_consent.withdraw", String(current.id));
    expect({
      status: res.statusCode,
      effectiveOn: body.effectiveOn,
      confirmation: body.confirmation === "paper_needed",
      withdrawn: rows[0]?.withdrawnAt !== null,
      mails: (await outbox(env, current.userId, W2_WITHDRAWN)).length,
      auditActors: audit.map((a) => a.actor_id),
    }).toEqual({
      status: 200,
      effectiveOn: "2027-01-04",
      confirmation: false,
      withdrawn: true,
      mails: 1,
      auditActors: [env.adminId],
    });
  });

  it("an employee session -> 403; no consent on file -> 404; cross-site -> 403 with no change and no mail", async () => {
    const asEmployee = await call(env, "POST", url(other.id), other.session!, {});
    const missing = await call(env, "POST", url(none.id), env.admin, {});
    const before = (await allOutbox(env, W2_WITHDRAWN)).length;
    const cross = await call(
      env,
      "POST",
      url(crossed.id),
      { ...env.admin, "sec-fetch-site": "cross-site" },
      {},
    );
    expect({
      asEmployee: asEmployee.statusCode,
      otherStillActive: (await consentRow(env, other.id))[0]?.withdrawnAt,
      missing: missing.statusCode,
      cross: [cross.statusCode, (cross.json() as { error?: string }).error],
      crossedStillActive: (await consentRow(env, crossed.id))[0]?.withdrawnAt,
      newMails: (await allOutbox(env, W2_WITHDRAWN)).length - before,
    }).toEqual({
      asEmployee: 403,
      otherStillActive: null,
      missing: 404,
      cross: [403, "cross_site"],
      crossedStillActive: null,
      newMails: 0,
    });
  });

  it("no login -> 200 confirmation 'paper_needed' and no mail", async () => {
    const before = (await allOutbox(env, W2_WITHDRAWN)).length;
    const res = await call(env, "POST", url(noLogin.id), env.admin, {});
    expect({
      status: res.statusCode,
      confirmation: (res.json() as { confirmation?: string }).confirmation,
      withdrawn: (await consentRow(env, noLogin.id))[0]?.withdrawnAt !== null,
      newMails: (await allOutbox(env, W2_WITHDRAWN)).length - before,
    }).toEqual({ status: 200, confirmation: "paper_needed", withdrawn: true, newMails: 0 });
  });

  it("GET /api/admin/employees/:id -> w2Consent.state none|current|outdated|withdrawn (no disclosure text)", async () => {
    const stateOf = async (id: number) => {
      const res = await call(env, "GET", `/api/admin/employees/${id}`, env.admin);
      const b = res.json() as {
        w2Consent?: { state: string };
        employee?: { w2Consent?: { state: string } };
      };
      return (b.w2Consent ?? b.employee?.w2Consent)?.state;
    };
    const detail = await call(env, "GET", `/api/admin/employees/${crossed.id}`, env.admin);
    expect({
      withdrawn: await stateOf(current.id),
      current: await stateOf(crossed.id),
      outdated: await stateOf(outdated.id),
      none: await stateOf(none.id),
      noText: !detail.body.includes("October 15") && !detail.body.includes(CONTACT.email),
    }).toEqual({
      withdrawn: "withdrawn",
      current: "current",
      outdated: "outdated",
      none: "none",
      noText: true,
    });
  });

  it("the employee consent routes refuse cross-site POST and DELETE (403 cross_site, nothing written)", async () => {
    const cross = { "sec-fetch-site": "cross-site" };
    const post = await call(
      env,
      "POST",
      "/api/my/w2/consent",
      { ...none.session!, ...cross },
      {
        disclosureVersion: NEW_VERSION,
      },
    );
    const del = await deleteConsent(env, other, cross);
    expect({
      post: [post.statusCode, (post.json() as { error?: string }).error],
      noneRows: (await consentRow(env, none.id)).length,
      del: [del.statusCode, (del.json() as { error?: string }).error],
      otherStillActive: (await consentRow(env, other.id))[0]?.withdrawnAt,
    }).toEqual({
      post: [403, "cross_site"],
      noneRows: 0,
      del: [403, "cross_site"],
      otherStillActive: null,
    });
  });
});

// ---------------------------------------------------------------- T15

describe("T15 late consent is furnished ((j)(5): posted + notified) — 2.2a", () => {
  let env: Env;
  let late: Emp;
  let reconsent: Emp;
  beforeAll(async () => {
    env = await boot({ now: JAN_4_2027 });
    await seedContact(env);
    late = await makeEmp(env, { label: "Lateconsent", login: true, years: [2026] });
    reconsent = await makeEmp(env, {
      label: "Latereconsent",
      login: true,
      consent: OLD_VERSION,
      years: [2026],
    });
    // 2026 notified on 2027-01-04: both are on paper then (courtesy notice only).
    await sendW2AvailableNotices(deps(env), { today: "2027-01-04" });
  }, 240_000);
  afterAll(async () => env.close());

  it("consent on 2027-01-10 after the paper notice -> one portal_notice + one IMPORTANT w2_available mail; a repeat POST adds nothing", async () => {
    const mailsBefore = await outbox(env, late.userId, "w2_available");
    env.setNow("2027-01-10T10:00:00Z");
    await relogin(env, late);
    const post = await postConsent(env, late);
    const f1 = await furnishings(env, late.id, 2026);
    const m1 = await outbox(env, late.userId, "w2_available");
    env.tick();
    await postConsent(env, late);
    expect({
      before: mailsBefore.map((m) => m.subject.startsWith(IMPORTANT)),
      post: post.statusCode,
      furnished: f1.map((r) => r.method),
      newMails: m1.slice(mailsBefore.length).map((m) => m.subject.startsWith(IMPORTANT)),
      furnishedAfterRepeat: (await furnishings(env, late.id, 2026)).length,
      mailsAfterRepeat: (await outbox(env, late.userId, "w2_available")).length,
    }).toEqual({
      before: [false],
      post: 200,
      furnished: ["portal_notice"],
      newMails: [true],
      furnishedAfterRepeat: 1,
      mailsAfterRepeat: m1.length,
    });
  });

  it("re-consent (2025-01 -> 2026-10) after the paper notice is furnished the same way", async () => {
    await relogin(env, reconsent);
    const before = (await outbox(env, reconsent.userId, "w2_available")).length;
    const post = await postConsent(env, reconsent);
    const mails = await outbox(env, reconsent.userId, "w2_available");
    expect({
      post: post.statusCode,
      furnished: (await furnishings(env, reconsent.id, 2026)).map((r) => r.method),
      newImportant: mails.slice(before).map((m) => m.subject.startsWith(IMPORTANT)),
    }).toEqual({ post: 200, furnished: ["portal_notice"], newImportant: [true] });
  });
});

describe("T15b a year not yet notified gets nothing at consent", () => {
  let env: Env;
  let e: Emp;
  beforeAll(async () => {
    env = await boot({ now: JAN_4_2027 });
    await seedContact(env);
    e = await makeEmp(env, { label: "Unnotified", login: true, years: [2026] });
  }, 180_000);
  afterAll(async () => env.close());

  it("consent with 2026 not in the notified years -> no furnishing row, no w2_available mail", async () => {
    const post = await postConsent(env, e);
    expect({
      post: post.statusCode,
      furnished: (await furnishings(env, e.id)).length,
      mails: (await outbox(env, e.userId, "w2_available")).length,
    }).toEqual({ post: 200, furnished: 0, mails: 0 });
  });
});

// ---------------------------------------------------------------- U (2.2b)

describe("U 2.2b upcomingYear: the consent prompt is reachable before January (OD5)", () => {
  let env: Env;
  let only2026: Emp;
  let both: Emp;
  let noRuns: Emp;
  beforeAll(async () => {
    env = await boot({ now: "2026-10-05T10:00:00Z" });
    await seedContact(env);
    only2026 = await makeEmp(env, { label: "Newhire", login: true, years: [2026] });
    both = await makeEmp(env, { label: "Bothyears", login: true, years: [2025, 2026] });
    noRuns = await makeEmp(env, { label: "Noruns", login: true });
  }, 240_000);
  afterAll(async () => env.close());

  it("U1 2026-only employee on 2026-10-05: { w2s: [], upcomingYear: 2026 }; GET consent 200; POST consent 200 (before January)", async () => {
    const list = await myRows(env, only2026);
    const get = await getConsent(env, only2026);
    const post = await postConsent(env, only2026);
    expect({
      list,
      get: get.statusCode,
      post: post.statusCode,
      consented: (post.json() as ConsentBody).consented,
    }).toEqual({ list: { w2s: [], upcomingYear: 2026 }, get: 200, post: 200, consented: true });
  });

  it("U2 2025 + 2026: w2s [2025], upcomingYear 2026", async () => {
    const list = await myRows(env, both);
    expect({ years: list.w2s.map((r) => r.year), upcomingYear: list.upcomingYear }).toEqual({
      years: [2025],
      upcomingYear: 2026,
    });
  });

  it("U3 no issued runs: upcomingYear null", async () => {
    expect(await myRows(env, noRuns)).toEqual({ w2s: [], upcomingYear: null });
  });
});

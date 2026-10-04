/**
 * PAY-208 D-B — the PDF access check before consent (federal SME minimum
 * design, Product Lead round 3; 26 CFR 31.6051-1(j)(2)(i): consent "in any
 * manner that reasonably demonstrates that the recipient can access the
 * Form W-2 in the electronic format in which it will be furnished").
 * payroll-calc-auditor, fail-first against d0f722f; the coder may not edit
 * this file. Synthetic data only.
 *
 * Tests: AC1-AC9.
 *
 * Contract assumed:
 *  - GET /api/my/w2/consent/test-pdf (employee session): one-page PDF
 *    (Content-Type application/pdf), refuseCrossSite + the PDF rate limit
 *    (20/min per client), no personal data. It shows a 6-character code
 *    (A-Z/2-9 without look-alikes: no 0, 1, O, I, L) drawn as its own text
 *    item with a standard font (text extraction returns it).
 *  - The code is random per request, stored server-side bound to the
 *    employee, single use, expires after ~30 minutes, compared
 *    case-insensitively; after 5 failed attempts it no longer works (a new
 *    test PDF gives a new code). It never appears in a JSON/HTML body, URL,
 *    header, file name or log line.
 *  - POST /api/my/w2/consent { disclosureVersion, accessCode }: missing,
 *    wrong, expired, reused or locked-out code -> 409
 *    { error: "access_check_failed" }, no consent row change, no audit row.
 *    First consent and re-consent both require it. The audit row's `after`
 *    carries accessCheck: "pdf_code".
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { company, employees } from "@payroll/db";
import { eq } from "drizzle-orm";
import {
  auditRows,
  boot,
  call,
  consentRow,
  deleteConsent,
  type Emp,
  type Env,
  makeEmp,
  myW2,
  NEW_VERSION,
  OLD_VERSION,
  seedContact,
  SSN_FORMS,
} from "./pay-208-harness.js";
import { codeFromPdf, fetchTestPdf, pdfStrings, TEST_PDF_URL } from "./w2-consent-fixture.js";
import { SYNTHETIC_EIN } from "./w2-state-harness.js";
import { pdfLib } from "./annual-w2-corrected-harness.js";

const LOGS: string[] = [];
/** Every response body and header value the suite saw, for the leak scan. */
const SEEN: string[] = [];
const CODES: string[] = [];

let env: Env;

function record(res: { body: string; headers: Record<string, unknown> }, pdf = false): void {
  if (!pdf) SEEN.push(res.body);
  for (const [k, v] of Object.entries(res.headers)) SEEN.push(`${k}: ${String(v)}`);
}

async function code(emp: Emp): Promise<string> {
  const res = await fetchTestPdf(env.t, emp.session!);
  record(res, true);
  if (res.statusCode !== 200) throw new Error(`test PDF -> ${res.statusCode}: ${res.body}`);
  const c = await codeFromPdf(res.rawPayload);
  if (c === null) throw new Error("no 6-character code found in the test PDF");
  CODES.push(c);
  return c;
}

async function post(emp: Emp, body: Record<string, unknown>) {
  const res = await call(env, "POST", "/api/my/w2/consent", emp.session!, body);
  record(res);
  return res;
}
const err = (r: { json(): unknown }) => (r.json() as { error?: string }).error;
const wrong = (c: string) => (c[0] === "A" ? "B" : "A") + c.slice(1);

beforeAll(async () => {
  env = await boot({ now: "2027-01-04T10:00:00Z", logStream: { write: (m) => void LOGS.push(m) } });
  await seedContact(env);
}, 180_000);
afterAll(async () => env.close());

describe("PAY-208 D-B PDF access check", () => {
  it("AC1 test PDF: 200 application/pdf, one page, a 6-char code without look-alikes, no personal data, no code in headers/file name; a new code per request; cross-site 403", async () => {
    const e = await makeEmp(env, { label: "Testpdf", login: true, years: [2026] });
    const res = await fetchTestPdf(env.t, e.session!);
    record(res, true);
    const strings = res.statusCode === 200 ? await pdfStrings(res.rawPayload) : [];
    const c = res.statusCode === 200 ? await codeFromPdf(res.rawPayload) : null;
    const second = res.statusCode === 200 ? await code(e) : null;
    const legal = (await env.t.db.select().from(employees).where(eq(employees.id, e.id)))[0]!
      .legalName;
    const cross = await env.t.app.inject({
      method: "GET",
      url: TEST_PDF_URL,
      headers: { ...e.session!, "sec-fetch-site": "cross-site" },
    });
    const headerText = Object.entries(res.headers)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join("\n");
    expect({
      status: res.statusCode,
      type: String(res.headers["content-type"]).startsWith("application/pdf"),
      magic: res.rawPayload.subarray(0, 5).toString(),
      pages:
        res.statusCode === 200 ? (await pdfLib.PDFDocument.load(res.rawPayload)).getPageCount() : 0,
      code: c !== null && /^[A-Z2-9]{6}$/.test(c) && !/[01OIL]/.test(c),
      noCodeInHeaders: c !== null && !headerText.includes(c),
      newCodePerRequest: c !== null && second !== null && second !== c,
      pii: [legal, e.email!, ...SSN_FORMS.slice(0, 2), SYNTHETIC_EIN].filter((s) =>
        strings.some((x) => x.includes(s)),
      ),
      cross: [cross.statusCode, (cross.json() as { error?: string }).error],
    }).toEqual({
      status: 200,
      type: true,
      magic: "%PDF-",
      pages: 1,
      code: true,
      noCodeInHeaders: true,
      newCodePerRequest: true,
      pii: [],
      cross: [403, "cross_site"],
    });
    if (c) CODES.push(c);
  });

  it("AC2 POST without a code, or with a wrong code -> 409 access_check_failed; no row; no audit", async () => {
    const e = await makeEmp(env, { label: "Nocode", login: true, years: [2026] });
    const missing = await post(e, { disclosureVersion: NEW_VERSION });
    const c = await code(e);
    const bad = await post(e, { disclosureVersion: NEW_VERSION, accessCode: wrong(c) });
    expect({
      missing: [missing.statusCode, err(missing)],
      bad: [bad.statusCode, err(bad)],
      rows: (await consentRow(env, e.id)).length,
      audits: (await auditRows(env, "w2_consent.consent", String(e.id))).length,
    }).toEqual({
      missing: [409, "access_check_failed"],
      bad: [409, "access_check_failed"],
      rows: 0,
      audits: 0,
    });
  });

  it("AC3 a code older than 30 minutes is refused", async () => {
    const e = await makeEmp(env, { label: "Expired", login: true, years: [2026] });
    const c = await code(e);
    env.tick(31 * 60 * 1000);
    const res = await post(e, { disclosureVersion: NEW_VERSION, accessCode: c });
    expect({ res: [res.statusCode, err(res)], rows: (await consentRow(env, e.id)).length }).toEqual(
      {
        res: [409, "access_check_failed"],
        rows: 0,
      },
    );
  });

  it("AC4 the code matches case-insensitively; audit w2_consent.consent carries accessCheck 'pdf_code'", async () => {
    const e = await makeEmp(env, { label: "Lowercase", login: true, years: [2026] });
    const c = await code(e);
    const res = await post(e, { disclosureVersion: NEW_VERSION, accessCode: c.toLowerCase() });
    const audit = await auditRows(env, "w2_consent.consent", String(e.id));
    expect({
      status: res.statusCode,
      consented: (res.json() as { consented?: boolean }).consented,
      accessCheck: audit.map((a) => (a.after as { accessCheck?: string }).accessCheck),
    }).toEqual({ status: 200, consented: true, accessCheck: ["pdf_code"] });
  });

  it("AC5 a used code cannot be reused (withdraw, then consent again with the same code -> 409); a new code works", async () => {
    const e = await makeEmp(env, { label: "Reuse", login: true, years: [2026] });
    const c = await code(e);
    const first = await post(e, { disclosureVersion: NEW_VERSION, accessCode: c });
    record(await deleteConsent(env, e));
    const reused = await post(e, { disclosureVersion: NEW_VERSION, accessCode: c });
    const fresh = await post(e, { disclosureVersion: NEW_VERSION, accessCode: await code(e) });
    expect({
      first: first.statusCode,
      reused: [reused.statusCode, err(reused)],
      fresh: fresh.statusCode,
    }).toEqual({ first: 200, reused: [409, "access_check_failed"], fresh: 200 });
  });

  it("AC6 after 5 failed attempts the code no longer works; a new test PDF code does", async () => {
    const e = await makeEmp(env, { label: "Lockout", login: true, years: [2026] });
    const c = await code(e);
    const fails: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      fails.push(
        (await post(e, { disclosureVersion: NEW_VERSION, accessCode: wrong(c) })).statusCode,
      );
    }
    const right = await post(e, { disclosureVersion: NEW_VERSION, accessCode: c });
    const rowsAfterLockout = (await consentRow(env, e.id)).length;
    const fresh = await post(e, { disclosureVersion: NEW_VERSION, accessCode: await code(e) });
    expect({
      fails,
      right: [right.statusCode, err(right)],
      rowsAfterLockout,
      fresh: fresh.statusCode,
    }).toEqual({
      fails: [409, 409, 409, 409, 409],
      right: [409, "access_check_failed"],
      rowsAfterLockout: 0,
      fresh: 200,
    });
  });

  it("AC7 re-consent (2025-01 -> 2026-10) requires the check too; audit w2_consent.reconsent carries accessCheck 'pdf_code'", async () => {
    const e = await makeEmp(env, {
      label: "Reconsentcheck",
      login: true,
      consent: OLD_VERSION,
      years: [2026],
    });
    const missing = await post(e, { disclosureVersion: NEW_VERSION });
    const rowAfterMissing = (await consentRow(env, e.id))[0]?.disclosureVersion;
    const ok = await post(e, { disclosureVersion: NEW_VERSION, accessCode: await code(e) });
    const audit = await auditRows(env, "w2_consent.reconsent", String(e.id));
    expect({
      missing: [missing.statusCode, err(missing)],
      rowAfterMissing,
      ok: ok.statusCode,
      row: (await consentRow(env, e.id))[0]?.disclosureVersion,
      accessCheck: audit.map((a) => (a.after as { accessCheck?: string }).accessCheck),
    }).toEqual({
      missing: [409, "access_check_failed"],
      rowAfterMissing: OLD_VERSION,
      ok: 200,
      row: NEW_VERSION,
      accessCheck: ["pdf_code"],
    });
  });

  it("AC8 the test PDF route is rate limited (20/min per client): the 21st request from one address in a minute -> 429", async () => {
    const e = await makeEmp(env, { label: "Ratelimit", login: true, years: [2026] });
    const statuses: number[] = [];
    for (let i = 0; i < 22; i += 1) {
      statuses.push((await fetchTestPdf(env.t, e.session!, "10.250.0.1")).statusCode);
    }
    expect({ first20: statuses.slice(0, 20).every((s) => s === 200), last: statuses[21] }).toEqual({
      first20: true,
      last: 429,
    });
  });

  it("AC9 no code seen in this suite appears in any JSON/HTML body, header, outbox mail, audit row or log line", async () => {
    // Plus the other employee surfaces, read once more now.
    const e = await makeEmp(env, { label: "Leakscan", login: true, years: [2026] });
    const c = await code(e);
    for (const url of ["/api/my/w2/consent", "/api/my/w2"])
      record(await call(env, "GET", url, e.session!));
    record(await post(e, { disclosureVersion: NEW_VERSION, accessCode: c }));
    record(await myW2(env, e));
    const outbox = (
      await env.t.pglite.query<{ body_html: string; subject: string }>(
        "SELECT subject, body_html FROM email_outbox",
      )
    ).rows.map((r) => `${r.subject}\n${r.body_html}`);
    const audits = (
      await env.t.pglite.query<{ j: string }>(
        "SELECT row_to_json(a)::text AS j FROM audit_events a",
      )
    ).rows.map((r) => r.j);
    const companyRow = JSON.stringify(await env.t.db.select().from(company));
    const haystacks = { responses: SEEN, logs: LOGS, outbox, audits, company: [companyRow] };
    const leaks: string[] = [];
    for (const k of CODES) {
      for (const [where, list] of Object.entries(haystacks)) {
        if (list.some((h) => h.includes(k) || h.includes(k.toLowerCase())))
          leaks.push(`${k} in ${where}`);
      }
    }
    expect({ codesSeen: CODES.length > 0, leaks }).toEqual({ codesSeen: true, leaks: [] });
  });
});

/**
 * PAY-208 T19 — PII probes over every new or changed surface (style of
 * w2-state-pr4-pii.test.ts). payroll-calc-auditor, fail-first against
 * d0f722f; the coder may not edit this file. Synthetic data only (SSN
 * 900-00-0017, EIN 00-0000001, contact w2@example.com / +1 555 0100).
 *
 * Surfaces: GET/POST/DELETE /api/my/w2/consent, GET /api/my/w2, GET/PUT
 * /api/admin/company/w2-contact, GET /api/admin/annual-forms/w2, GET
 * /api/admin/employees/:id, POST .../w2-consent/withdraw, and every mail the
 * flows queue (w2_available both variants, w2_consent_withdrawn,
 * w2_contact_changed). Rules: no SSN or EIN anywhere; no bank data; no
 * amounts outside the admin W-2 list (which carries box figures by design);
 * the contact email/phone and the SSN never reach a log line.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendW2AvailableNotices } from "../src/filings/annual.js";
import {
  boot,
  call,
  CONTACT,
  deleteConsent,
  deps,
  type Emp,
  type Env,
  hasAmount,
  makeEmp,
  NEW_VERSION,
  OLD_VERSION,
  plain,
  postConsent,
  putContact,
  scrub,
  seedContact,
  SSN_FORMS,
} from "./pay-208-harness.js";
import { SYNTHETIC_EIN } from "./w2-state-harness.js";

const LOGS: string[] = [];
const NO_AMOUNT: { where: string; body: string }[] = [];
const FIGURES_OK: { where: string; body: string }[] = [];
let env: Env;
const e: Record<string, Emp> = {};

beforeAll(async () => {
  env = await boot({ now: "2027-01-04T10:00:00Z", logStream: { write: (m) => void LOGS.push(m) } });
  const contactStatus = await seedContact(env);
  NO_AMOUNT.push({
    where: "contact PUT status",
    body: String(contactStatus === 200 ? "" : "missing"),
  });
  e.a = await makeEmp(env, { label: "Piia", login: true, years: [2026] });
  e.b = await makeEmp(env, { label: "Piib", login: true, consent: OLD_VERSION, years: [2026] });
  e.c = await makeEmp(env, { label: "Piic", login: true, consent: NEW_VERSION, years: [2026] });

  const keep = (where: string, r: { body: string }, figures = false) =>
    (figures ? FIGURES_OK : NO_AMOUNT).push({ where, body: r.body });
  keep("GET consent", await call(env, "GET", "/api/my/w2/consent", e.a!.session!));
  keep("POST consent", await postConsent(env, e.a!));
  keep("GET my w2", await call(env, "GET", "/api/my/w2", e.a!.session!));
  keep("GET contact", await call(env, "GET", "/api/admin/company/w2-contact", env.admin));
  keep("PUT contact", await putContact(env, { ...CONTACT, phone: "+1 555 0142" }));
  keep("employee detail", await call(env, "GET", `/api/admin/employees/${e.b!.id}`, env.admin));
  keep(
    "admin withdraw",
    await call(env, "POST", `/api/admin/employees/${e.c!.id}/w2-consent/withdraw`, env.admin, {}),
  );
  keep(
    "admin list",
    await call(env, "GET", "/api/admin/annual-forms/w2?year=2026", env.admin),
    true,
  );
  await sendW2AvailableNotices(deps(env), { today: "2027-01-04" });
  keep("DELETE consent", await deleteConsent(env, e.a!));
  const mails = await env.t.pglite.query<{
    event_type: string;
    subject: string;
    body_html: string;
  }>("SELECT event_type, subject, body_html FROM email_outbox ORDER BY id");
  for (const m of mails.rows) {
    NO_AMOUNT.push({ where: `mail ${m.event_type}`, body: `${m.subject}\n${plain(m.body_html)}` });
  }
}, 240_000);
afterAll(async () => env.close());

describe("PAY-208 T19 PII probes", () => {
  it("the new surfaces exist (the probes below are not vacuous): contact set, PAY-208 mails queued", () => {
    const events = new Set(
      NO_AMOUNT.filter((x) => x.where.startsWith("mail ")).map((x) => x.where),
    );
    expect({
      contact: NO_AMOUNT[0]!.body,
      withdrawnMail: events.has("mail w2_consent_withdrawn"),
      contactMail: [...events].some((w) => /contact/.test(w)),
      availableMail: events.has("mail w2_available"),
    }).toEqual({ contact: "", withdrawnMail: true, contactMail: true, availableMail: true });
  });

  it("no SSN, EIN or bank words in any body or mail; no amounts outside the admin W-2 list", () => {
    const all = [...NO_AMOUNT, ...FIGURES_OK];
    const secrets = [...SSN_FORMS.slice(0, 2), SYNTHETIC_EIN, SYNTHETIC_EIN.replace("-", "")];
    expect({
      secrets: all.filter((x) => secrets.some((s) => x.body.includes(s))).map((x) => x.where),
      bank: all.filter((x) => /routing|account number/i.test(x.body)).map((x) => x.where),
      amounts: NO_AMOUNT.filter((x) => hasAmount(scrub(x.body))).map((x) => x.where),
    }).toEqual({ secrets: [], bank: [], amounts: [] });
  });

  it("no log line carries the contact email or phone, the SSN, or the EIN", () => {
    const needles = [CONTACT.email, CONTACT.phone, "+1 555 0142", "900-00-0017", SYNTHETIC_EIN];
    // The bare 9-digit SSN as its own token (a float such as a response time
    // "12.900000017" is not a leak).
    const bareSsn = /(?<![\d.])900000017(?!\d)/;
    expect({
      logged: LOGS.length > 0,
      leaks: needles.filter((n) => LOGS.some((l) => l.includes(n))),
      bareSsn: LOGS.filter((l) => bareSsn.test(l)).length,
    }).toEqual({ logged: true, leaks: [], bareSsn: 0 });
  });
});

/**
 * PAY-208 (W-2 electronic consent v2) — payroll-calc-auditor test harness.
 * Fail-first: written against origin/main d0f722f (v1.28.0) before the
 * change exists. The coder may not edit this file. Synthetic data only
 * (contact "W-2 Desk", w2@example.com, +1 555 0100; SSN 900-00-0017).
 *
 * Legal source, read 2026-10-04 from the eCFR text at
 * https://www.law.cornell.edu/cfr/text/26/31.6051-1 — 26 CFR 31.6051-1(j):
 *  (j)(2)(i)   affirmative consent; (ii) withdrawal takes effect on receipt
 *              or a later date; a paper request MAY be treated as a
 *              withdrawal; (iii) hardware/software change -> new consent.
 *  (j)(3)(ii)  paper if no consent; (iii) scope and duration;
 *  (j)(3)(iv)  how to get paper after consent + whether that withdraws;
 *  (j)(3)(v)(A) withdraw in writing to a person/department whose name,
 *              mailing address, telephone number and e-mail address are
 *              in the disclosure; (B) written confirmation of the
 *              withdrawal and its effective date; (C) no effect on a
 *              statement furnished electronically before that date;
 *  (j)(3)(vi)  when electronic furnishing stops (e.g. employment ends);
 *  (j)(3)(vii) how to update contact info; employer tells of changes to
 *              its own contact info;
 *  (j)(3)(viii) hardware/software to access, print and retain; the date
 *              it is no longer available; may need to be printed and
 *              attached to a federal, state or local return.
 *  (j)(5)(i)   notice: how to access AND print; "IMPORTANT TAX RETURN
 *              DOCUMENT AVAILABLE." in capitals, on the e-mail subject.
 *  (j)(6)      posted through October 15 of the following year (next
 *              business day when a weekend/legal holiday).
 *
 * Product decisions (build brief, Product Lead 2026-10-04): OD1 contact
 * required (409 w2_contact_missing until filled); OD2 a paper request is
 * NOT a withdrawal; OD3 a written withdrawal takes effect the day the admin
 * records it; OD5 consent prompt before January (upcomingYear); OD6 the
 * year notice is always on; re-consent rule: a consent covers tax year Y
 * when active AND (Y < 2026 OR version "2026-10").
 */

import { vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  company,
  emailOutbox,
  employees,
  seedDatabase,
  type SeedDb,
  w2DeliveryConsents,
} from "@payroll/db";
import { encryptField } from "../src/crypto/field-encryption.js";
import { inviteUser } from "../src/auth/users.js";
import type { AppConfig } from "../src/config.js";
import { createTestApp, ORIGIN, type TestContext } from "./helpers.js";
import { currentTotp, login, sessionHeader, TEST_PASSWORD, tokenFromLink } from "./flow-helpers.js";
import { insertRuns, SYNTHETIC_EIN } from "./w2-state-harness.js";
import { monthly, months } from "./w2-state-oracle.js";
import { accessCodeFor } from "./w2-consent-fixture.js";

// ------------------------------------------------------------------ pinned values

/** The new disclosure version (brief §2.1). */
export const NEW_VERSION = "2026-10";
/** The version every consent on file today carries. */
export const OLD_VERSION = "2025-01";

/** Federal-SME sentence for (j)(3)(viii) — fixed text, verbatim (brief §2.1). */
export const SME_SENTENCE =
  "Your W-2 for a tax year will be posted here by the IRS deadline for giving W-2s to employees (usually January 31 of the following year, or the next business day if January 31 falls on a weekend or legal holiday), and will stay available here through at least October 15 of that following year.";

/** The wrong 2025-01 bullet (Jan 31 is the deadline, not a promise). */
export const OLD_JAN31_PHRASE = "available on or before January 31";

/** (j)(5)(i): the literal capitals required on the subject line. */
export const IMPORTANT = "IMPORTANT TAX RETURN DOCUMENT AVAILABLE";

/** The six 2025-01 bullets, byte-for-byte (A4: kept as the record). */
export const DISCLOSURES_2025_01: readonly string[] = [
  "By consenting, you agree to receive your Form W-2 electronically through this portal instead of as a paper copy.",
  "You may still request a paper copy of any W-2 at any time by asking your payroll administrator; a paper copy will be provided at no charge.",
  "Your consent applies to every future tax year's W-2 until you withdraw it.",
  "You may withdraw your consent at any time on this page. Withdrawal takes effect immediately: future W-2s will be furnished on paper.",
  "To view and print your electronic W-2 you need a device with a PDF reader.",
  "Your W-2 for a tax year will be available on or before January 31 of the following year and remains accessible here through at least October 15 of that year.",
];

/** Synthetic W-2 contact (brief §7). */
export const CONTACT = {
  name: "W-2 Desk",
  phone: "+1 555 0100",
  email: "w2@example.com",
} as const;
export const CONTACT_ADDRESS = {
  line1: "100 Example Street",
  city: "Springfield",
  state: "IL",
  zip: "62701",
  country: "US",
} as const;

/** Synthetic SSN (900-series, never issued). */
export const SSN = "900000017";
export const SSN_FORMS = [SSN, "900-00-0017", "0017"] as const;

/** Each fixture run: $5,000.00 gross, $500.00 FIT (w2-state-oracle defaults). */
export const GROSS_CENTS = 500_000;
/** Amount strings a fixture W-2 could print (12 months). */
export const AMOUNT_STRINGS = [
  "5,000.00",
  "5000.00",
  "60,000.00",
  "60000.00",
  "6,000.00",
  "6000.00",
  "3,720.00",
  "870.00",
] as const;

/** Money-shaped text or a dollar sign. */
export function hasAmount(text: string): boolean {
  return text.includes("$") || /\d[\d,]*\.\d{2}\b/.test(text);
}

/**
 * Timestamps are removed before amount scans: "...T10:15:32.59Z" can look
 * like an amount.
 */
const ISO_TS = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
export function scrub(body: string): string {
  return body.replace(ISO_TS, "<ts>");
}

// ------------------------------------------------------------------ boot

export interface Env {
  t: TestContext;
  admin: Record<string, string>;
  adminId: string;
  companyId: number;
  setNow(iso: string): void;
  /** Move the faked clock forward (TOTP replay guard between logins). */
  tick(ms?: number): void;
  close(): Promise<void>;
}

let seq = 0;
let ipSeq = 0;
function nextIp(): string {
  ipSeq += 1;
  return `10.208.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
}

/** Invite + onboard one user from its own client address; returns a session. */
async function onboarded(
  t: TestContext,
  role: "employee" | "admin",
  label: string,
): Promise<{ userId: string; email: string; ip: string; session: Record<string, string> }> {
  seq += 1;
  const ip = nextIp();
  const headers = { ...ORIGIN, "x-forwarded-for": ip };
  const email = `pay208-${seq}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@test.dev`;
  const invite = await inviteUser(
    { auth: t.auth, db: t.db, config: t.config },
    { name: `${label} ${seq}`, email, role },
    null,
  );
  const token = tokenFromLink(invite.setupLink);
  const step = async (url: string, payload: Record<string, unknown>) => {
    const r = await t.app.inject({ method: "POST", url, headers, remoteAddress: ip, payload });
    if (r.statusCode !== 200) throw new Error(`${url} failed (${r.statusCode}): ${r.body}`);
  };
  await step("/api/onboarding/verify-token", { token });
  await step("/api/onboarding/set-password", { token, password: TEST_PASSWORD });
  await step("/api/onboarding/totp-enable", { token });
  await step("/api/onboarding/totp-verify", { token, code: await currentTotp(t, invite.userId) });
  if (vi.isFakeTimers()) vi.setSystemTime(new Date(Date.now() + 31_000));
  const s = await login(t, email, TEST_PASSWORD, { remoteAddress: ip });
  return { userId: invite.userId, email, ip, session: sessionHeader(s.sessionCookie) };
}

/**
 * Fresh PGlite app with Date faked at `now` (the W-2 January gate and the
 * D9 window both read the clock). Company EIN set (a 2026 W-2 needs it).
 */
export async function boot(opts: {
  now: string;
  config?: Partial<AppConfig>;
  logStream?: { write(m: string): void };
}): Promise<Env> {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(opts.now) });
  const t = await createTestApp(
    { ...(opts.logStream ? { logLevel: "trace" } : {}), ...(opts.config ?? {}) },
    opts.logStream ? { logStream: opts.logStream } : {},
  );
  await seedDatabase(t.db as unknown as SeedDb);
  await t.db.update(company).set({ ein: encryptField(SYNTHETIC_EIN, t.config.encryptionKey) });
  const a = await onboarded(t, "admin", "Admin");
  const rows = await t.db.select({ id: company.id }).from(company).limit(1);
  return {
    t,
    admin: a.session,
    adminId: a.userId,
    companyId: rows[0]?.id ?? 1,
    setNow(iso) {
      vi.setSystemTime(new Date(iso));
    },
    tick(ms = 31_000) {
      vi.setSystemTime(new Date(Date.now() + ms));
    },
    async close() {
      await t.close();
      vi.useRealTimers();
    },
  };
}

// ------------------------------------------------------------------ HTTP

export async function call(
  env: Env,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) {
  return env.t.app.inject({
    method,
    url,
    headers,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

/** PUT /api/admin/company/w2-contact (new, admin). */
export async function putContact(
  env: Env,
  body: Record<string, unknown>,
  headers: Record<string, string> = env.admin,
) {
  return call(env, "PUT", "/api/admin/company/w2-contact", headers, body);
}

/**
 * The synthetic contact, set through the admin route. Returns the status
 * instead of throwing, so a beforeAll on the old code does not skip every
 * test of a block: each test then fails on its own assertion.
 */
export async function seedContact(
  env: Env,
  extra: { mailingAddress?: unknown } = { mailingAddress: CONTACT_ADDRESS },
): Promise<number> {
  const res = await putContact(env, { ...CONTACT, ...extra });
  return res.statusCode;
}

export interface ConsentBody {
  consented: boolean;
  outdated: boolean;
  consentedAt: string | null;
  withdrawnAt: string | null;
  consentedVersion: string | null;
  disclosureVersion: string;
  disclosures: string[];
  contactReady: boolean;
  contact: {
    name: string;
    phone: string;
    email: string;
    mailingAddress: Record<string, string> | null;
  } | null;
  effectiveOn?: string;
  [k: string]: unknown;
}

export async function getConsent(env: Env, emp: Emp) {
  return call(env, "GET", "/api/my/w2/consent", emp.session!);
}

/** A fresh access code from the test PDF (D-B), or undefined (old code / no code). */
export async function accessCode(env: Env, emp: Emp): Promise<string | undefined> {
  return accessCodeFor(env.t, emp.session!);
}

/**
 * POST /api/my/w2/consent. Default body: the current version + a fresh code
 * from the test PDF (D-B). Pass `body` to send exactly that.
 */
export async function postConsent(env: Env, emp: Emp, body?: unknown) {
  let payload = body;
  if (payload === undefined) {
    const code = await accessCode(env, emp);
    payload = {
      disclosureVersion: NEW_VERSION,
      ...(code !== undefined ? { accessCode: code } : {}),
    };
  }
  return call(env, "POST", "/api/my/w2/consent", emp.session!, payload);
}

export async function deleteConsent(env: Env, emp: Emp, extraHeaders: Record<string, string> = {}) {
  return call(env, "DELETE", "/api/my/w2/consent", { ...emp.session!, ...extraHeaders });
}

export async function myW2(env: Env, emp: Emp) {
  return call(env, "GET", "/api/my/w2", emp.session!);
}

export async function myPdf(env: Env, emp: Emp, year: number) {
  const ip = nextIp();
  return env.t.app.inject({
    method: "GET",
    url: `/api/my/w2/${year}/pdf`,
    headers: { ...emp.session!, "x-forwarded-for": ip },
    remoteAddress: ip,
  });
}

export async function adminList(env: Env, year: number) {
  const res = await call(env, "GET", `/api/admin/annual-forms/w2?year=${year}`, env.admin);
  if (res.statusCode !== 200) throw new Error(`admin list ${res.statusCode}: ${res.body}`);
  return res.json() as {
    reconsentNeeded?: number;
    w2s: {
      employeeId: number;
      consented: boolean;
      consentOutdated?: boolean;
      [k: string]: unknown;
    }[];
    [k: string]: unknown;
  };
}

// ------------------------------------------------------------------ fixtures

export interface Emp {
  id: number;
  userId: string | null;
  email: string | null;
  ip: string | null;
  session: Record<string, string> | null;
}

/**
 * Synthetic W-2 employee. `login`: an onboarded account + session.
 * `consent`: a consent row at that version (direct insert — data written
 * by the previous release); `withdrawnAt` withdraws it. `years`: twelve
 * issued monthly runs ($5,000.00) per year. `terminated`: status
 * 'terminated' (the predicate under test reads employees.status).
 */
export async function makeEmp(
  env: Env,
  o: {
    label: string;
    login?: boolean;
    consent?: string | null;
    consentedAt?: string;
    withdrawnAt?: string | null;
    years?: readonly number[];
    terminated?: boolean;
  },
): Promise<Emp> {
  let user: { userId: string; email: string; ip: string; session: Record<string, string> } | null =
    null;
  if (o.login) user = await onboarded(env.t, "employee", o.label);
  const rows = await env.t.db
    .insert(employees)
    .values({
      companyId: env.companyId,
      legalName: `${o.label} Synthetic`,
      hireDate: "2024-01-01",
      taxId: encryptField(SSN, env.t.config.encryptionKey),
      ...(user ? { userId: user.userId } : {}),
      ...(o.terminated ? { status: "terminated", terminationDate: "2026-12-31" } : {}),
    })
    .returning();
  const id = rows[0]!.id;
  if (o.consent) {
    await env.t.db.insert(w2DeliveryConsents).values({
      employeeId: id,
      disclosureVersion: o.consent,
      consentedAt: new Date(o.consentedAt ?? "2025-06-01T10:00:00Z"),
      withdrawnAt: o.withdrawnAt ? new Date(o.withdrawnAt) : null,
    });
  }
  for (const y of o.years ?? []) {
    await insertRuns(
      env as never,
      id,
      months(y, 1, 12).map((m) => monthly(m, null, undefined, { grossCents: GROSS_CENTS })),
    );
  }
  return {
    id,
    userId: user?.userId ?? null,
    email: user?.email ?? null,
    ip: user?.ip ?? null,
    session: user?.session ?? null,
  };
}

/** A new session for an employee (sessions expire after 7 days of faked time). */
export async function relogin(env: Env, emp: Emp): Promise<void> {
  env.tick();
  const s = await login(env.t, emp.email!, TEST_PASSWORD, { remoteAddress: emp.ip! });
  emp.session = sessionHeader(s.sessionCookie);
}

/** A fresh admin session (after a long clock jump). */
export async function reloginAdmin(env: Env): Promise<void> {
  const a = await onboarded(env.t, "admin", "Admin");
  env.admin = a.session;
  env.adminId = a.userId;
}

export async function consentRow(env: Env, employeeId: number) {
  const rows = await env.t.db
    .select()
    .from(w2DeliveryConsents)
    .where(eq(w2DeliveryConsents.employeeId, employeeId));
  return rows;
}

export async function outbox(env: Env, userId: string | null, eventType: string) {
  if (userId === null) return [];
  return env.t.db
    .select()
    .from(emailOutbox)
    .where(and(eq(emailOutbox.userId, userId), eq(emailOutbox.eventType, eventType)))
    .orderBy(emailOutbox.id);
}

export async function allOutbox(env: Env, eventType: string) {
  return env.t.db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.eventType, eventType))
    .orderBy(emailOutbox.id);
}

export interface FurnRow {
  id: number;
  method: string;
  tax_year: number;
  boxes_hash: string;
  corrected: boolean;
}

export async function furnishings(env: Env, employeeId: number, year?: number): Promise<FurnRow[]> {
  const r = await env.t.pglite.query<FurnRow>(
    `SELECT id, method, tax_year, boxes_hash, corrected FROM w2_furnishings
      WHERE employee_id = $1 ${year === undefined ? "" : "AND tax_year = $2"} ORDER BY id`,
    year === undefined ? [employeeId] : [employeeId, year],
  );
  return r.rows;
}

export async function auditRows(env: Env, action: string, entityId?: string) {
  const r = await env.t.pglite.query<{
    action: string;
    actor_id: string | null;
    entity_id: string | null;
    before: unknown;
    after: unknown;
  }>(
    `SELECT action, actor_id, entity_id, before, after FROM audit_events
      WHERE action = $1 ${entityId === undefined ? "" : "AND entity_id = $2"} ORDER BY id`,
    entityId === undefined ? [action] : [action, entityId],
  );
  return r.rows;
}

/** The deps object the filing services take. */
export function deps(env: Env) {
  return { db: env.t.db, config: env.t.config } as never;
}

/** Text of an outbox body (tags removed, whitespace collapsed). */
export function plain(html: string): string {
  let out = html;
  let prev: string;
  do {
    prev = out;
    out = out.replace(/<[^>]+>/g, " ");
  } while (out !== prev);
  // One pass with a lookup map, so "&amp;quot;" decodes to "&quot;" and is
  // never unescaped twice (CodeQL js/double-escaping).
  return out
    .replace(/&(?:amp|quot|#39);/g, (m) => HTML_ENTITIES[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

const HTML_ENTITIES: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&#39;": "'" };

/** Lazily loaded module under test (missing exports fail per test, not per file). */
// biome-ignore lint/suspicious/noExplicitAny: contract-shaped dynamic import
export type Any = any;
export async function consentModule(): Promise<Record<string, Any>> {
  return (await import("../src/filings/w2-consent.js")) as Record<string, Any>;
}
export async function notificationsModule(): Promise<Record<string, Any>> {
  return (await import("@payroll/notifications")) as Record<string, Any>;
}
export function need(mod: Record<string, Any>, name: string): Any {
  const v = mod[name];
  if (v === undefined) throw new Error(`module has no export "${name}"`);
  return v;
}

// ------------------------------------------------------------------ disclosure markers

/**
 * One stable marker per 26 CFR 31.6051-1(j)(3) item (and (j)(2)(iii)),
 * checked by keywords and sentence structure — not by exact UX wording
 * (copy file /private/tmp/wagon-pay208-copy.md S1-a..S1-m; the SME sentence
 * S1-k is the only exact string). `text` = every bullet joined.
 */
export function disclosureMarkers(text: string, companyName: string): Record<string, boolean> {
  const t = text.replace(/[‘’]/g, "'").replace(/\s+/g, " ");
  return {
    // (j)(3)(ii) paper if no consent
    j3ii_paper_if_no_consent: /(don't|do not) agree[^.]*paper/i.test(t),
    // (j)(3)(iii) scope (each W-2 after consent, every tax year) and duration
    j3iii_scope_duration:
      /every W-2/i.test(t) && /tax year/i.test(t) && /until you withdraw/i.test(t),
    // (j)(3)(iv) paper after consent, and that a paper request is NOT a withdrawal (OD2)
    j3iv_paper_after_consent_not_withdrawal:
      /paper copy/i.test(t) &&
      /paper copy[^.]*(does not|doesn't|won't|will not) (withdraw|end|cancel)/i.test(t),
    // (j)(3)(v)(A) withdraw in writing to a named contact: name, mailing address, phone, e-mail
    j3vA_named_contact_all_four:
      /withdraw/i.test(t) &&
      /(write|writing|letter)/i.test(t) &&
      t.includes(CONTACT.name) &&
      t.includes(CONTACT.phone) &&
      t.includes(CONTACT.email) &&
      t.includes(CONTACT_ADDRESS.line1) &&
      t.includes(CONTACT_ADDRESS.city) &&
      t.includes(CONTACT_ADDRESS.zip),
    // (j)(3)(v)(B) written confirmation of the withdrawal and its effective date
    j3vB_confirmation_and_date: /confirm[^.]*withdraw[^.]*(date|day)[^.]*effect/i.test(t),
    // (j)(3)(v)(C) no effect on a W-2 already furnished online
    j3vC_already_furnished_unaffected:
      /withdraw\w*[^.]*(doesn't|does not|won't|will not) (change|affect|apply)/i.test(t),
    // (j)(3)(vi) when online furnishing stops, incl. end of employment
    j3vi_termination_conditions: /stop[^.]*online[^.]*(job|employment)/i.test(t),
    // (j)(2)(iii) hardware/software change -> told first, new agreement
    j2iii_requirements_change_reconsent: /change[^.]*(agree|consent) again/i.test(t),
    // (j)(3)(vii) how to update contact info + employer tells of its own contact changes
    j3vii_update_info: /email address/i.test(t) && /(W-2 )?contact details change/i.test(t),
    // (j)(3)(viii) hardware/software to access, print and retain
    j3viii_hw_sw_access_print_retain:
      /browser/i.test(t) && /PDF/.test(t) && /print/i.test(t) && /(save|keep|retain)/i.test(t),
    // (j)(3)(viii) date no longer available — the SME sentence verbatim
    j3viii_sme_sentence: t.includes(SME_SENTENCE),
    // (j)(3)(viii) may need to be printed and attached to a federal/state/local return
    j3viii_print_attach_return: /print[^.]*attach[^.]*federal, state or local[^.]*return/i.test(t),
    // furnisher named; no unfilled template placeholder
    names_company: t.includes(companyName),
    no_placeholders: !/\{[A-Za-z]+\}/.test(t),
    // the wrong 2025-01 sentence and the old citation are gone
    no_old_jan31_promise: !t.includes(OLD_JAN31_PHRASE),
  };
}

/** Every marker true (for toEqual against the markers object). */
export function allMarkersTrue(m: Record<string, boolean>): Record<string, boolean> {
  return Object.fromEntries(Object.keys(m).map((k) => [k, true]));
}

/**
 * PAY-206 auditor harness (payroll-calc-auditor): CORRECTED employee W-2
 * copies. Shared by the annual-w2-corrected-*.test.ts suites. Synthetic data
 * only. Never imports @payroll/engine.
 *
 * Rulings (federal-payroll-tax-sme, 2026-10-03):
 *  - 2026 General Instructions for Forms W-2 and W-3, p.28, "Correcting
 *    Forms W-2 and W-3": an error found after the W-2 went to the employee
 *    but before it went to SSA -> new W-2 with the correct figures; Copy A to
 *    SSA unmarked; write "CORRECTED" on the employee's new Copies B, C and 2.
 *  - 26 CFR 31.6051-1(j): electronic furnishing = posted + notified, consent
 *    first ((j)(5)); posted W-2s stay available through October 15 of the
 *    following year ((j)(6)).
 *
 * Why tax year 2025: the repo bundles the official fw2 template for 2025
 * only (packages/documents/src/forms/templates.ts). A 2026 W-2 PDF answers
 * 409 form_not_available, so every PDF/furnishing path is exercised on 2025
 * (late issue of a 2025-12-31 run on 2026-01-10).
 *
 * Oracle (independent of the engine), integer cents, half-up:
 *  - FIT: Pub 15-T (2025), Worksheet 1A, 2020+ Form W-4, no Step 2/3/4,
 *    line 1g $8,600 (single), annual STANDARD schedule, Single or MFS
 *    (read 2026-10-03 from irs.gov/pub/irs-prior/p15t--2025.pdf, p.10):
 *      A        B        C            D
 *      0        6,400    0.00         0%
 *      6,400    18,325   0.00         10%
 *      18,325   54,875   1,192.50     12%
 *      54,875   109,750  5,578.50     22%
 *      109,750  203,700  17,651.00    24%
 *      203,700  256,925  40,199.00    32%
 *      256,925  632,750  57,231.00    35%
 *      632,750  -        188,769.75   37%
 *  - FICA: Pub 15 (2025) / SSA 2025 wage base $176,100; SS 6.2%; Medicare
 *    1.45%; Additional Medicare 0.9% over $200,000 (employee only).
 *  - FUTA: 0.6% of the first $7,000 (Pub 15 (2025) §14).
 *  - W-2 boxes (iw2w3 2025, boxes 1-6; no pre-tax deductions in the app):
 *    1 = gross; 2 = FIT withheld; 3 = min(box 1, SS wage base); 4 = SS
 *    withheld; 5 = box 1; 6 = Medicare withheld.
 *
 * Worked values (6,000.00/month, single, no state):
 *   1c 72,000; 1i 63,400; 5,578.50 + 22% x 8,525 = 7,454.00; /12 =
 *   621.1666 -> FIT 621.17; SS 372.00; Medicare 87.00; net 4,919.83;
 *   FUTA Jan 36.00, Feb 6.00, then 0.
 *   Jan-Oct: box1 60,000.00 box2 6,211.70 box3 60,000.00 box4 3,720.00
 *            box5 60,000.00 box6 870.00
 *   Jan-Nov: 66,000.00 / 6,832.87 / 66,000.00 / 4,092.00 / 66,000.00 / 957.00
 *   Jan-Dec: 72,000.00 / 7,454.04 / 72,000.00 / 4,464.00 / 72,000.00 / 1,044.00
 * 16,000.00/month (wage-base crossing):
 *   1i 183,400; 17,651 + 24% x 73,650 = 35,327.00; /12 = 2,943.9166 ->
 *   2,943.92; SS 992.00 Jan-Nov (YTD 176,000.00), Dec 100.00 taxable ->
 *   6.20; Medicare 232.00; box1 192,000.00, box3 176,100.00, box4
 *   10,918.20 (= 176,100 x 6.2%, the maximum), box6 2,784.00.
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appSettings,
  company,
  compensation,
  employees,
  taxFilings,
  w2DeliveryConsents,
} from "@payroll/db";
import { formatCents } from "@payroll/shared";
import { divHalfUp, type OracleRun } from "./pay-193-oracle.js";
import { currentTotp, login, sessionHeader, TEST_PASSWORD, tokenFromLink } from "./flow-helpers.js";
import { inviteUser } from "../src/auth/users.js";
import { ORIGIN } from "./helpers.js";
import { history, type Emp, type L4Env } from "./pay-193-l4-harness.js";
import type { TestContext } from "./helpers.js";

export const Y = 2025;

// ---------------------------------------------------------------- 2025 oracle

/** Pub 15-T (2025) annual STANDARD Single rows, cents: [A, C, pct]. */
const SINGLE_2025: readonly [number, number, number][] = [
  [0, 0, 0],
  [640_000, 0, 10],
  [1_832_500, 119_250, 12],
  [5_487_500, 557_850, 22],
  [10_975_000, 1_765_100, 24],
  [20_370_000, 4_019_900, 32],
  [25_692_500, 5_723_100, 35],
  [63_275_000, 18_876_975, 37],
];
const LINE_1G_SINGLE_2025 = 860_000;
export const SS_WAGE_BASE_2025 = 17_610_000;
const ADDL_MEDICARE_THRESHOLD = 20_000_000;
const FUTA_WAGE_BASE = 700_000;

/** Worksheet 1A (2025), single, no W-4 adjustments. */
export function fit2025Single(grossCents: number, periods = 12): number {
  const line1i = Math.max(0, grossCents * periods - LINE_1G_SINGLE_2025);
  let row = SINGLE_2025[0]!;
  for (const r of SINGLE_2025) if (line1i >= r[0]) row = r;
  const [a, c, pct] = row;
  const units = BigInt(c) * 100n + BigInt(pct) * BigInt(line1i - a);
  return divHalfUp(units, 100n * BigInt(periods));
}

/** One 2025 monthly run, no state income tax. */
export function oracleRun2025(grossCents: number, priorYtdGrossCents = 0): OracleRun {
  const fitCents = fit2025Single(grossCents);
  const ssWagesCents = Math.min(grossCents, Math.max(0, SS_WAGE_BASE_2025 - priorYtdGrossCents));
  const ssCents = divHalfUp(BigInt(ssWagesCents) * 62n, 1000n);
  const over = Math.max(
    0,
    priorYtdGrossCents + grossCents - Math.max(ADDL_MEDICARE_THRESHOLD, priorYtdGrossCents),
  );
  const medCents =
    divHalfUp(BigInt(grossCents) * 145n, 10_000n) + divHalfUp(BigInt(over) * 9n, 1000n);
  const futaWagesCents = Math.min(grossCents, Math.max(0, FUTA_WAGE_BASE - priorYtdGrossCents));
  return {
    grossCents,
    fitCents,
    ssCents,
    ssWagesCents,
    medCents,
    medWagesCents: grossCents,
    stateCents: 0,
    netCents: grossCents - fitCents - ssCents - medCents,
    futaCents: divHalfUp(BigInt(futaWagesCents) * 6n, 1000n),
    futaWagesCents,
  };
}

/** Months 1..`to` of 2025 at a fixed gross (prior YTD carried). */
export function oracleMonths2025(grossCents: number, to: number): OracleRun[] {
  const runs: OracleRun[] = [];
  for (let m = 1; m <= to; m += 1) runs.push(oracleRun2025(grossCents, (m - 1) * grossCents));
  return runs;
}

export interface Boxes {
  box1Cents: number;
  box2Cents: number;
  box3Cents: number;
  box4Cents: number;
  box5Cents: number;
  box6Cents: number;
}

/** W-2 boxes 1-6 from oracle runs (iw2w3: box 3 capped at the SS wage base). */
export function oracleBoxes(runs: readonly OracleRun[], ssBaseCents = SS_WAGE_BASE_2025): Boxes {
  const box1 = runs.reduce((a, r) => a + r.grossCents, 0);
  return {
    box1Cents: box1,
    box2Cents: runs.reduce((a, r) => a + r.fitCents, 0),
    box3Cents: Math.min(box1, ssBaseCents),
    box4Cents: runs.reduce((a, r) => a + r.ssCents, 0),
    box5Cents: box1,
    box6Cents: runs.reduce((a, r) => a + r.medCents, 0),
  };
}

/** Printed strings of the six boxes, in box order. */
export function boxStrings(b: Boxes): string[] {
  return [b.box1Cents, b.box2Cents, b.box3Cents, b.box4Cents, b.box5Cents, b.box6Cents].map(
    formatCents,
  );
}

// ---------------------------------------------------------------- module under test (loaded lazily)

/** The PAY-206 pure core. Loaded per test so a missing module fails each test on its own. */
export interface FurnishModule {
  w2BoxesHash: (employeeId: number, taxYear: number, boxes: Boxes) => string;
  /**
   * Review round D1/D3: `corrected` = any row (any method) with another
   * hash; `correctionToFurnish` = corrected AND the latest DELIVERY row of
   * the employee's channel is not the current figures — consented (active
   * consent + login): `portal_notice`; otherwise `paper_handed`. No such row
   * counts as "not delivered". `latest` = the row with the highest id (any
   * method); furnishedAt never orders.
   */
  furnishingState: (
    rows: readonly { id: number; boxesHash: string; furnishedAt: Date; method: string }[],
    currentHash: string,
    opts: { consented: boolean },
  ) => {
    furnished: boolean;
    corrected: boolean;
    correctionToFurnish: boolean;
    latest: { id: number; boxesHash: string; furnishedAt: Date; method: string } | null;
  };
  /**
   * Review round D9: the last day (ISO date) a year furnished electronically
   * stays downloadable after consent is withdrawn — October 15 of taxYear+1,
   * rolled to the next business day when it falls on a weekend or a federal
   * holiday.
   */
  electronicW2AccessThrough: (taxYear: number) => string;
  reconcileW2Furnishings: (
    deps: { db: TestContext["db"]; config: TestContext["config"] },
    opts?: { today?: string },
  ) => Promise<unknown>;
  backfillW2Furnishings: (
    deps: { db: TestContext["db"]; config: TestContext["config"] },
    opts?: { today?: string },
  ) => Promise<unknown>;
}

export async function furnishModule(): Promise<FurnishModule> {
  return (await import("../src/filings/w2-furnish.js")) as unknown as FurnishModule;
}

export async function hashOf(employeeId: number, year: number, boxes: Boxes): Promise<string> {
  return (await furnishModule()).w2BoxesHash(employeeId, year, boxes);
}

// ---------------------------------------------------------------- DB fixtures

export interface FurnishingRow {
  id: number;
  employee_id: number;
  tax_year: number;
  boxes_hash: string;
  hash_version: number;
  corrected: boolean;
  method: string;
  actor_id: string | null;
  furnished_at: Date;
}

/** w2_furnishings rows of one employee-year, by id (raw SQL: the table is new). */
export async function furnishings(
  t: TestContext,
  employeeId: number,
  year = Y,
): Promise<FurnishingRow[]> {
  const r = await t.pglite.query<FurnishingRow>(
    `SELECT id, employee_id, tax_year, boxes_hash, hash_version, corrected, method, actor_id, furnished_at
       FROM w2_furnishings WHERE employee_id = $1 AND tax_year = $2 ORDER BY id`,
    [employeeId, year],
  );
  return r.rows;
}

/** Compact view of rows for equality checks. */
export function brief(rows: readonly FurnishingRow[]) {
  return rows.map((r) => ({ method: r.method, hash: r.boxes_hash, corrected: r.corrected }));
}

/** Empty everything the PAY-206 paths write (employees and config stay). */
export async function resetW2(t: TestContext): Promise<void> {
  await t.pglite.exec(
    `TRUNCATE tax_deposits, tax_filings, payroll_entries, payroll_runs, email_outbox, audit_events RESTART IDENTITY CASCADE;
     DELETE FROM app_settings WHERE key IN ('w2_available_notified_years', 'w2_furnishings_backfilled');`,
  );
  // Absent before PAY-206: a missing table must not break the reset itself.
  await t.pglite.exec(
    `DO $$ BEGIN
       IF to_regclass('public.w2_furnishings') IS NOT NULL THEN
         EXECUTE 'TRUNCATE w2_furnishings RESTART IDENTITY';
       END IF;
     END $$;`,
  );
}

export async function setNotifiedYears(t: TestContext, years: number[]): Promise<void> {
  await t.db
    .insert(appSettings)
    .values({ key: "w2_available_notified_years", value: years, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [appSettings.key], set: { value: years } });
}

export async function putFiledW2W3(t: TestContext, year: number): Promise<void> {
  await t.db.insert(taxFilings).values({
    formType: "w2_w3",
    year,
    quarter: 0,
    dueDate: `${year + 1}-01-31`,
    status: "filed",
    worksheet: { synthetic: true },
    worksheetHash: "synthetic",
    filedOn: `${year + 1}-01-28`,
    filingMethod: "synthetic",
    createdBy: "pay-206-test",
  });
}

let seq = 0;

/**
 * Invite + onboard + log in one user from its own client address: the
 * auth and onboarding routes rate-limit per IP (10/min), and these suites
 * create many synthetic accounts.
 */
async function onboardedSession(
  t: TestContext,
  n: number,
  role: "employee" | "admin" = "employee",
) {
  const ip = `10.206.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
  const headers = { ...ORIGIN, "x-forwarded-for": ip };
  const email = `pay206-${n}-${Date.now()}@test.dev`;
  const invite = await inviteUser(
    { auth: t.auth, db: t.db, config: t.config },
    { name: `W2 Corrected ${n}`, email, role },
    null,
  );
  const token = tokenFromLink(invite.setupLink);
  const step = async (url: string, payload: Record<string, unknown>) => {
    const r = await t.app.inject({ method: "POST", url, headers, remoteAddress: ip, payload });
    if (r.statusCode !== 200) throw new Error(`${url} failed (${r.statusCode}): ${r.body}`);
    return r.json() as Record<string, unknown>;
  };
  await step("/api/onboarding/verify-token", { token });
  await step("/api/onboarding/set-password", { token, password: TEST_PASSWORD });
  await step("/api/onboarding/totp-enable", { token });
  await step("/api/onboarding/totp-verify", { token, code: await currentTotp(t, invite.userId) });
  const s = await login(t, email, TEST_PASSWORD, { remoteAddress: ip });
  return { userId: invite.userId, session: sessionHeader(s.sessionCookie) };
}

export interface W2Emp extends Emp {
  /** Session headers of the employee's own login (null without a login). */
  session: Record<string, string> | null;
}

/**
 * Synthetic monthly-salaried W-2 employee (no work state, single, no W-4
 * row). `login`: a real onboarded account (needed for /api/my/w2);
 * `consent`: an active electronic-delivery consent.
 */
export async function makeW2Emp(
  env: L4Env,
  o: { grossCents: number; login?: boolean; consent?: boolean; label?: string },
): Promise<W2Emp> {
  seq += 1;
  const t = env.t;
  let userId: string | null = null;
  let session: Record<string, string> | null = null;
  if (o.login) {
    const u = await onboardedSession(t, seq + Math.floor(Math.random() * 50_000));
    userId = u.userId;
    session = u.session;
  }
  const c = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({
      companyId: c[0]!.id,
      legalName: `${o.label ?? "Corrected Synthetic"} ${seq}`,
      hireDate: "2024-01-01",
      ...(userId ? { userId } : {}),
    })
    .returning();
  const id = rows[0]!.id;
  await t.db.insert(compensation).values({
    employeeId: id,
    periodAmount: formatCents(o.grossCents),
    frequency: "monthly",
    effectiveFrom: "2024-01-01",
  });
  if (o.consent) {
    await t.db
      .insert(w2DeliveryConsents)
      .values({ employeeId: id, disclosureVersion: "2025-01", withdrawnAt: null });
  }
  return { id, userId, session };
}

/** Issued 2025 history runs for months 1..runs.length (oracle entries, never the engine's). */
export async function seedHistory2025(env: L4Env, emp: Emp, runs: readonly OracleRun[]) {
  for (let i = 0; i < runs.length; i += 1) {
    const mm = String(i + 1).padStart(2, "0");
    await history(env.t, emp, `2025-${mm}`, `2025-${mm}-25`, runs[i]!, null);
  }
}

/** A fresh onboarded admin session (its own user, so a per-user limit starts at zero). */
export async function freshAdmin(env: L4Env): Promise<Record<string, string>> {
  seq += 1;
  return (await onboardedSession(env.t, seq + Math.floor(Math.random() * 50_000), "admin")).session;
}

// ---------------------------------------------------------------- HTTP helpers

let ipSeq = 0;
/**
 * A new client address per PDF request (review round D10: the two PDF
 * routes rate-limit at 20/min; these suites render many PDFs from one
 * process, so ordinary tests must never share a limiter key). The rate-limit
 * tests pass their own fixed address.
 */
function clientIp(): string {
  ipSeq += 1;
  return `10.207.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
}

export interface PdfReq {
  /** Extra request headers (e.g. sec-fetch-site). */
  headers?: Record<string, string>;
  /** Fixed client address (default: a new one per request). */
  ip?: string;
}

function withIp(base: Record<string, string>, o: PdfReq) {
  const ip = o.ip ?? clientIp();
  return {
    headers: { ...base, "x-forwarded-for": ip, ...(o.headers ?? {}) },
    remoteAddress: ip,
  };
}

export async function myPdf(env: L4Env, emp: W2Emp, year = Y, o: PdfReq = {}) {
  return env.t.app.inject({
    method: "GET",
    url: `/api/my/w2/${year}/pdf`,
    ...withIp(emp.session!, o),
  });
}

export async function myList(env: L4Env, emp: W2Emp) {
  return env.t.app.inject({ method: "GET", url: "/api/my/w2", headers: emp.session! });
}

export async function printPacket(
  env: L4Env,
  employeeId: number,
  year = Y,
  o: PdfReq & { admin?: Record<string, string> } = {},
) {
  return env.t.app.inject({
    method: "GET",
    url: `/api/admin/annual-forms/w2/${employeeId}/print-packet?year=${year}`,
    ...withIp(o.admin ?? env.admin, o),
  });
}

/** The employee withdraws electronic W-2 consent (DELETE /api/my/w2/consent). */
export async function withdrawConsent(env: L4Env, emp: W2Emp): Promise<void> {
  const res = await env.t.app.inject({
    method: "DELETE",
    url: "/api/my/w2/consent",
    headers: emp.session!,
  });
  if (res.statusCode !== 200) throw new Error(`withdraw ${res.statusCode}: ${res.body}`);
}

/**
 * One raw w2_furnishings row with an explicit furnished_at (the table is
 * append-only; INSERT is allowed). Returns the new id.
 */
export async function rawFurnishing(
  t: TestContext,
  r: {
    employeeId: number;
    hash: string;
    method: string;
    corrected: boolean;
    furnishedAt: string;
    year?: number;
  },
): Promise<number> {
  const res = await t.pglite.query<{ id: number }>(
    `INSERT INTO w2_furnishings (employee_id, tax_year, boxes_hash, corrected, method, furnished_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [r.employeeId, r.year ?? Y, r.hash, r.corrected, r.method, r.furnishedAt],
  );
  return res.rows[0]!.id;
}

export async function copyD(env: L4Env, employeeId: number, year = Y) {
  return env.t.app.inject({
    method: "GET",
    url: `/api/admin/annual-forms/w2/${employeeId}/pdf?year=${year}`,
    headers: env.admin,
  });
}

export async function markPaper(env: L4Env, employeeId: number, year = Y) {
  return env.t.app.inject({
    method: "POST",
    url: `/api/admin/annual-forms/w2/${employeeId}/furnished-on-paper?year=${year}`,
    headers: env.admin,
    payload: {},
  });
}

export interface AdminW2Row {
  employeeId: number;
  corrected?: boolean;
  correctionToFurnish?: boolean;
  furnished?: string;
  furnishedOn?: string | null;
  box1Wages: string | null;
  box2FederalWithheld: string | null;
  box3SsWages: string | null;
  box4SsTax: string | null;
  box5MedicareWages: string | null;
  box6MedicareTax: string | null;
  [k: string]: unknown;
}

export async function adminRow(env: L4Env, employeeId: number, year = Y): Promise<AdminW2Row> {
  const res = await env.t.app.inject({
    method: "GET",
    url: `/api/admin/annual-forms/w2?year=${year}`,
    headers: env.admin,
  });
  if (res.statusCode !== 200) throw new Error(`admin list ${res.statusCode}: ${res.body}`);
  const row = (res.json() as { w2s: AdminW2Row[] }).w2s.find((r) => r.employeeId === employeeId);
  if (!row) throw new Error(`no admin W-2 row for employee ${employeeId}`);
  return row;
}

// ---------------------------------------------------------------- independent PDF reader

/**
 * pdf-lib resolved through @payroll/documents (the server package does not
 * depend on it directly). Used only as a PDF parser: the oracle for the mark
 * is this file's own content-stream scan, not the code under test.
 */
function workspaceRoot(from: string): string {
  let dir = from;
  while (!existsSync(resolve(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`pnpm-workspace.yaml not found above ${from}`);
    dir = parent;
  }
  return dir;
}
/** The workspace root (also from a Stryker sandbox nested under apps/server). */
export const ROOT = workspaceRoot(dirname(fileURLToPath(import.meta.url)));
// biome-ignore lint/suspicious/noExplicitAny: pdf-lib types are not resolvable from apps/server
export const pdfLib: any = createRequire(resolve(ROOT, "packages/documents/package.json"))(
  "pdf-lib",
);

/** Every string shown by Tj / TJ in a content stream, decoded (hex or literal). */
export function shownStrings(src: string): string[] {
  const out: string[] = [];
  const lit = (s: string) =>
    s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_m, g: string) =>
      /^[0-7]+$/.test(g)
        ? String.fromCharCode(Number.parseInt(g, 8))
        : (({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[g] ?? g),
    );
  const hex = (h: string) => Buffer.from(h.replace(/\s/g, ""), "hex").toString("latin1");
  const one = /<([0-9A-Fa-f\s]*)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj|\[((?:[^\]])*)\]\s*TJ/g;
  for (const m of src.matchAll(one)) {
    if (m[1] !== undefined) out.push(hex(m[1]));
    else if (m[2] !== undefined) out.push(lit(m[2]));
    else if (m[3] !== undefined) {
      const parts = [...m[3].matchAll(/<([0-9A-Fa-f\s]*)>|\(((?:\\.|[^\\)])*)\)/g)].map((p) =>
        p[1] !== undefined ? hex(p[1]) : lit(p[2] ?? ""),
      );
      out.push(parts.join(""));
    }
  }
  return out;
}

// biome-ignore lint/suspicious/noExplicitAny: pdf-lib objects (see pdfLib)
function decodeStream(stream: any): string {
  const bytes =
    stream instanceof pdfLib.PDFRawStream
      ? pdfLib.decodePDFRawStream(stream).decode()
      : stream.getContents();
  return Buffer.from(bytes).toString("latin1");
}

/** The page's own content streams (not form XObjects), decoded and joined. */
// biome-ignore lint/suspicious/noExplicitAny: pdf-lib objects (see pdfLib)
export function pageContent(doc: any, pageIndex: number): string {
  const contents = doc.getPage(pageIndex).node.Contents();
  if (!contents) return "";
  const streams =
    contents instanceof pdfLib.PDFArray
      ? contents.asArray().map((r: unknown) => doc.context.lookup(r))
      : [contents];
  return streams.map(decodeStream).join("\n");
}

/** Strings shown inside the page's form XObjects (the flattened field values). */
// biome-ignore lint/suspicious/noExplicitAny: pdf-lib objects (see pdfLib)
export function pageXObjectStrings(doc: any, pageIndex: number): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  // biome-ignore lint/suspicious/noExplicitAny: pdf-lib objects (see pdfLib)
  const walk = (resources: any) => {
    const xd = resources?.lookup(pdfLib.PDFName.of("XObject"));
    if (!xd) return;
    for (const [, ref] of xd.entries()) {
      const s = doc.context.lookup(ref);
      if (seen.has(s) || !s || typeof s.getContents !== "function") continue;
      seen.add(s);
      out.push(...shownStrings(decodeStream(s)));
      walk(s.dict.lookup(pdfLib.PDFName.of("Resources")));
    }
  };
  walk(doc.getPage(pageIndex).node.Resources());
  return out;
}

/** 0-based pages whose own content shows the exact string "CORRECTED". */
export async function markedPages(bytes: Uint8Array): Promise<number[]> {
  const doc = await pdfLib.PDFDocument.load(bytes);
  const pages: number[] = [];
  for (let i = 0; i < doc.getPageCount(); i += 1) {
    if (shownStrings(pageContent(doc, i)).some((s: string) => s.trim() === "CORRECTED")) {
      pages.push(i);
    }
  }
  return pages;
}

/** True when `pageIndex` shows each of `values` among its flattened field strings. */
export async function pageShowsAll(
  bytes: Uint8Array,
  pageIndex: number,
  values: readonly string[],
): Promise<boolean> {
  const doc = await pdfLib.PDFDocument.load(bytes);
  const shown = pageXObjectStrings(doc, pageIndex);
  return values.every((v) => shown.includes(v));
}

/** Money-shaped text or a dollar sign. */
export function hasAmount(text: string): boolean {
  return text.includes("$") || /\d+\.\d{2}\b/.test(text);
}

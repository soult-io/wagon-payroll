/**
 * PAY-223 PR-1 (freeze the posted W-2 figures on every furnishing write +
 * the gap sweep) — payroll-calc-auditor test harness. Fail-first: written
 * against origin/main f74b51b (v1.29.0) before the change exists. The coder
 * may not edit this file. Synthetic data only (re-uses the PAY-208/217
 * fixtures: SSN 900-00-0017, EIN 00-0000001, contact "W-2 Desk").
 *
 * Legal source, read 2026-10-06 from https://www.law.cornell.edu/cfr/text/26/31.6051-1
 *  (j)(6) "Forms W-2 furnished on a Web site must be retained on the Web
 *         site through October 15 of the year following the calendar year
 *         to which the Forms W-2 relate (or the first business day after
 *         October 15, if October 15 falls on a Saturday, Sunday, or legal
 *         holiday)"; corrected forms: that date "or the date 90 days after
 *         the corrected forms are posted, whichever is later."
 * Box sources (tax year 2026): IRS 2026 General Instructions for Forms W-2
 * and W-3 (boxes 1-6, 15-17; a second W-2 for a third state line). FICA per
 * run: Social Security 6.2%, Medicare 1.45% (Pub 15 (2026) §§12-13); no
 * fixture reaches the 2026 SSA wage base ($184,500).
 *
 * The oracle (expFrozen / rehash) is the auditor's own: it imports nothing
 * from src/ and nothing from @payroll/engine; integer cents only. The
 * canonical SHA-256 is re-implemented in w2-state-oracle.ts (canonicalSha).
 *
 * Contract assumed (build brief /private/tmp/wagon-pay223-brief.md §4-§5,
 * Product Lead decisions 2026-10-06: OD-3 A, OD-4 every method):
 *  - Migration 0029_w2_furnished_figures: table w2_furnished_figures
 *    (id, employee_id, tax_year, hash_version, boxes_hash, figures jsonb,
 *    box15_ciphertexts jsonb, source, created_at), unique key
 *    (employee_id, tax_year, hash_version, boxes_hash), append-only trigger
 *    raising "w2_furnished_figures is append-only". Drizzle export
 *    `w2FurnishedFigures` from @payroll/db.
 *  - figures = exactly { box1Cents..box6Cents, formCount, stateLines:
 *    [{ state, form, row, box16Cents, box17Cents, stateIdSource,
 *    stateIdDigest }], localLines: [] }; v1 = formCount 1, stateLines [],
 *    localLines []. box15_ciphertexts = { "<STATE>": "enc:v1:…" } for the
 *    entered lines only, else null. source "furnishing" | "reconstructed".
 *  - w2-furnish-core.ts: recordFurnishing(tx, { employeeId, taxYear,
 *    figures, corrected, method, actorId }) computes the hash itself and
 *    freezes in the same transaction (ON CONFLICT DO NOTHING), also when the
 *    furnishing row is deduped; frozenFigures(f) (pure allowlist copy, fixed
 *    TypeError on a non-integer amount); FrozenFiguresRaceError (fixed
 *    message) when an entered ID's stored ciphertext no longer matches the
 *    figures' stateIdDigest.
 *  - company/state-ids.ts: storedEnteredStateIds(db, taxYear, states) — the
 *    entered ciphertexts, nothing decrypted.
 *  - w2-furnish.ts: sweepW2FurnishedFigures({ db, config }, { today? })
 *    -> { frozen, unreconstructable, failed } (the §5.4 gap sweep, any
 *    method, tax years >= 2025). Called at boot (src/index.ts) and on the
 *    daily annualTick after reconcileW2Furnishings.
 */

import { createHash } from "node:crypto";
import { vi } from "vitest";
import { companyStateIds, employees, payrollEntries, payrollRuns } from "@payroll/db";
import { and, eq } from "drizzle-orm";
import { encryptAddress } from "../src/crypto/address-encryption.js";
import { snapshotHash } from "../src/payroll/snapshot.js";
import { markedPages, pageXObjectStrings, pdfLib } from "./annual-w2-corrected-harness.js";
import {
  type Any,
  boot,
  type Emp,
  type Env,
  makeEmp,
  NEW_VERSION,
  relogin,
  reloginAdmin,
  seedContact,
  TZ,
} from "./pay-217-harness.js";
import { insertRuns, snapshotOf } from "./w2-state-harness.js";
import {
  canonicalSha,
  type ExpLine,
  expBoxes,
  expFormCount,
  expLines,
  type FxRun,
  hashV1,
  money,
  monthly,
  months,
  signedMoney,
  st,
} from "./w2-state-oracle.js";

export * from "./pay-217-harness.js";

// ------------------------------------------------------------------ fixtures

/** Synthetic CA box 15 IDs: the one entered at setup, and two re-entries. */
export const CA_ID = "77665544";
export const CA_ID_MID = "77665545";
export const CA_ID_NEW = "77665546";
/** Synthetic employee address (box f) — must never be frozen. */
export const ADDRESS = {
  line1: "742 Fixture Lane",
  city: "Fixtureville",
  state: "TX",
  zip: "75001",
  country: "US",
} as const;

export const CA = st("CA");
export const IL = st("IL");
export const NC = st("NC");

/** 12 CA runs: $5,000.00 gross, $500.00 FIT, $12.34 CA tax each. */
export const caRuns = (year = 2026): FxRun[] =>
  months(year, 1, 12).map((m) => monthly(m, CA, 1234));

/**
 * Three states, one W-2 per two lines (formCount 2): CA (entered ID,
 * $10.00/month), IL (EIN default, $20.00/month), NC (no ID, $0.00 withheld:
 * a warn, not a block).
 */
export const multiRuns = (): FxRun[] => [
  ...months(2026, 1, 4).map((m) => monthly(m, CA, 1000)),
  ...months(2026, 5, 8).map((m) => monthly(m, IL, 2000)),
  ...months(2026, 9, 12).map((m) => monthly(m, NC, 0)),
];

/** A late December CA run that changes boxes 1-6 and the CA line. */
export const lateRun = (): FxRun => ({
  ...monthly("2026-12", CA, 500, { grossCents: 100_000, fitCents: 10_000, payDate: "2026-12-31" }),
  periodStart: "2026-12-31",
  periodEnd: "2026-12-31",
});

/**
 * A synthetic W-2 employee (pay-208 makeEmp: SSN 900-00-0017) with `runs`
 * and an encrypted home address. `consent` true = a 2026-10 consent row.
 */
export async function emp(
  env: Env,
  label: string,
  runs: readonly FxRun[],
  o: { login?: boolean; consent?: boolean } = {},
): Promise<Emp & { runs: FxRun[] }> {
  const e = await makeEmp(env, {
    label,
    login: o.login ?? false,
    consent: o.consent ? NEW_VERSION : null,
    years: [],
  });
  await insertRuns(env as never, e.id, runs);
  await env.t.db
    .update(employees)
    .set({ address: encryptAddress({ ...ADDRESS }, env.t.config.encryptionKey) as never })
    .where(eq(employees.id, e.id));
  return { ...e, runs: [...runs] };
}

/** Enter (insert) or re-enter (update) the CA box 15 ID; returns the stored ciphertext. */
export async function setCaId(env: Env, plain: string): Promise<string> {
  const { encryptField } = await import("../src/crypto/field-encryption.js");
  const ct = encryptField(plain, env.t.config.encryptionKey);
  const existing = await env.t.db
    .select({ id: companyStateIds.id })
    .from(companyStateIds)
    .where(eq(companyStateIds.stateCode, "CA"));
  if (existing.length === 0) {
    await env.t.db.insert(companyStateIds).values({
      companyId: env.companyId,
      stateCode: "CA",
      fromTaxYear: 2026,
      stateId: ct,
      createdBy: "test",
    });
  } else {
    await env.t.db
      .update(companyStateIds)
      .set({ stateId: ct })
      .where(eq(companyStateIds.stateCode, "CA"));
  }
  return ct;
}

/** The stored CA ciphertext right now. */
export async function caCiphertext(env: Env): Promise<string> {
  const rows = await env.t.db
    .select({ stateId: companyStateIds.stateId })
    .from(companyStateIds)
    .where(eq(companyStateIds.stateCode, "CA"));
  if (!rows[0]) throw new Error("no CA state ID");
  return rows[0].stateId;
}

// ------------------------------------------------------------------ oracle

export const FIGURE_KEYS = [
  "box1Cents",
  "box2Cents",
  "box3Cents",
  "box4Cents",
  "box5Cents",
  "box6Cents",
  "formCount",
  "localLines",
  "stateLines",
] as const;
export const LINE_KEYS = [
  "box16Cents",
  "box17Cents",
  "form",
  "row",
  "state",
  "stateIdDigest",
  "stateIdSource",
] as const;

export interface FrozenLine {
  state: string;
  form: number;
  row: number;
  box16Cents: number | null;
  box17Cents: number | null;
  stateIdSource: string | null;
  stateIdDigest: string | null;
}
export interface Frozen {
  box1Cents: number;
  box2Cents: number;
  box3Cents: number;
  box4Cents: number;
  box5Cents: number;
  box6Cents: number;
  formCount: number;
  stateLines: FrozenLine[];
  localLines: unknown[];
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Box 15 identity per state, as the v2 hash covers it (source + ciphertext digest). */
export type Ids = Record<string, { source: "entered" | "ein_default" | null; ct?: string }>;

/**
 * The frozen figures the auditor expects for `runs` in `year`: v1 (< 2026)
 * boxes 1-6 + formCount 1 + no lines; v2 adds the state lines (R2-R5, see
 * w2-state-oracle.ts) with box 15 by source and SHA-256 of the entered ID's
 * stored ciphertext.
 */
export function expFrozen(runs: readonly FxRun[], year: number, ids: Ids = {}): Frozen {
  const b = expBoxes(runs, year);
  const boxes = {
    box1Cents: b.box1,
    box2Cents: b.box2,
    box3Cents: b.box3,
    box4Cents: b.box4,
    box5Cents: b.box5,
    box6Cents: b.box6,
  };
  if (year < 2026) return { ...boxes, formCount: 1, stateLines: [], localLines: [] };
  const lines: ExpLine[] = expLines(runs, year);
  return {
    ...boxes,
    formCount: expFormCount(lines),
    stateLines: lines.map((l) => {
      const id = ids[l.state];
      const source = id?.source ?? null;
      return {
        state: l.state,
        form: l.form,
        row: l.row,
        box16Cents: l.box16,
        box17Cents: l.box17,
        stateIdSource: source,
        stateIdDigest: source === "entered" && id?.ct ? sha256(id.ct) : null,
      };
    }),
    localLines: [],
  };
}

/**
 * Re-hash a frozen figures object with the auditor's own canonical SHA-256:
 * v1 = PAY-206 boxes 1-6; v2 = Spec 24 PR-2 §4 + PR-3 R3 canonical object.
 */
export function rehash(employeeId: number, taxYear: number, version: number, f: Frozen): string {
  if (version === 1) {
    return hashV1(employeeId, taxYear, {
      box1: f.box1Cents,
      box2: f.box2Cents,
      box3: f.box3Cents,
      box4: f.box4Cents,
      box5: f.box5Cents,
      box6: f.box6Cents,
    });
  }
  return canonicalSha({
    v: 2,
    employeeId,
    taxYear,
    box1: f.box1Cents,
    box2: f.box2Cents,
    box3: f.box3Cents,
    box4: f.box4Cents,
    box5: f.box5Cents,
    box6: f.box6Cents,
    formCount: f.formCount,
    stateLines: f.stateLines.map((l) => ({
      state: l.state,
      form: l.form,
      row: l.row,
      box16: l.box16Cents,
      box17: l.box17Cents,
      stateIdSource: l.stateIdSource,
      stateIdDigest: l.stateIdDigest,
    })),
    localLines: [],
  });
}

/** The expected hash of `runs` in `year` (v1 before 2026, v2 from 2026). */
export function expHash(employeeId: number, runs: readonly FxRun[], year: number, ids: Ids = {}) {
  return rehash(employeeId, year, year >= 2026 ? 2 : 1, expFrozen(runs, year, ids));
}

/** Expected box15_ciphertexts: the entered lines' stored ciphertexts, else null. */
export function expBox15(f: Frozen, ids: Ids): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const l of f.stateLines) {
    const ct = ids[l.state]?.ct;
    if (l.stateIdSource === "entered" && ct) out[l.state] = ct;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** Sorted keys of an object (the allowlist checks). */
export function keysOf(v: unknown): string[] {
  return Object.keys((v ?? {}) as object).sort();
}

// ------------------------------------------------------------------ DB readers

export interface FrozenRow {
  id: number;
  employee_id: number;
  tax_year: number;
  hash_version: number;
  boxes_hash: string;
  figures: Frozen;
  box15_ciphertexts: Record<string, string> | null;
  source: string;
}

/** Every frozen row (of one employee, or all), by id. Throws before 0029 (no table). */
export async function frozenRows(env: Env, employeeId?: number): Promise<FrozenRow[]> {
  const r = await env.t.pglite.query<FrozenRow>(
    `SELECT id, employee_id, tax_year, hash_version, boxes_hash, figures, box15_ciphertexts, source
       FROM w2_furnished_figures ${employeeId === undefined ? "" : "WHERE employee_id = $1"}
      ORDER BY id`,
    employeeId === undefined ? [] : [employeeId],
  );
  return r.rows;
}

/** The serialized frozen rows (every column), for the PII scans. */
export async function frozenRowsText(env: Env): Promise<string> {
  const r = await env.t.pglite.query<{ j: unknown }>(
    "SELECT row_to_json(f) AS j FROM w2_furnished_figures f ORDER BY id",
  );
  return JSON.stringify(r.rows.map((x) => x.j));
}

export interface FRow {
  id: number;
  method: string;
  tax_year: number;
  hash_version: number;
  boxes_hash: string;
  corrected: boolean;
}

export async function furnRows(env: Env, employeeId: number, year?: number): Promise<FRow[]> {
  const r = await env.t.pglite.query<FRow>(
    `SELECT id, method, tax_year, hash_version, boxes_hash, corrected FROM w2_furnishings
      WHERE employee_id = $1 ${year === undefined ? "" : "AND tax_year = $2"} ORDER BY id`,
    year === undefined ? [employeeId] : [employeeId, year],
  );
  return r.rows;
}

/** Distinct (tax_year, hash_version, boxes_hash) keys of an employee's furnishing rows. */
export async function furnKeys(env: Env, employeeId: number): Promise<string[]> {
  const rows = await furnRows(env, employeeId);
  return [...new Set(rows.map((r) => `${r.tax_year}:${r.hash_version}:${r.boxes_hash}`))].sort();
}

export function keyOf(r: { tax_year: number; hash_version: number; boxes_hash: string }): string {
  return `${r.tax_year}:${r.hash_version}:${r.boxes_hash}`;
}

/** A w2_furnishings row inserted directly (as v1.29.0 or a rollback window writes it). */
export async function insertRawFurnishing(
  env: Env,
  o: {
    employeeId: number;
    taxYear: number;
    hash: string;
    version?: number;
    method?: string;
    corrected?: boolean;
    at?: string;
  },
): Promise<void> {
  await env.t.pglite.query(
    `INSERT INTO w2_furnishings (employee_id, tax_year, boxes_hash, hash_version, corrected, method, furnished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      o.employeeId,
      o.taxYear,
      o.hash,
      o.version ?? (o.taxYear >= 2026 ? 2 : 1),
      o.corrected ?? false,
      o.method ?? "portal_notice",
      o.at ?? "2027-01-04T16:00:00Z",
    ],
  );
}

// ------------------------------------------------------------------ modules under test

export async function coreModule(): Promise<Record<string, Any>> {
  return (await import("../src/filings/w2-furnish-core.js")) as Record<string, Any>;
}
export async function furnishModule(): Promise<Record<string, Any>> {
  return (await import("../src/filings/w2-furnish.js")) as Record<string, Any>;
}
export async function stateIdsModule(): Promise<Record<string, Any>> {
  return (await import("../src/company/state-ids.js")) as Record<string, Any>;
}

// ================================================================== PR-2 (versions read model, version render, routes)
//
// PAY-223 PR-2 — payroll-calc-auditor additions, fail-first against
// origin/main 9cb9534 (PR-1 merged). The coder may not edit this file.
//
// API contract assumed (build brief §5.2, §5.3, §6, Product Lead decisions
// 2026-10-06, security PR-1 carry-forward):
//  - GET /api/my/w2: each w2s[] item carries `versions` = exactly
//    [{ version, kind: "original" | "corrected", postedOn, current,
//    downloadable }], ordered by version. A version = a distinct
//    (hash_version, boxes_hash) among the employee-year's portal_notice /
//    employee_download rows, numbered 1..k by its first online row (id);
//    kind/postedOn/CORRECTED mark from that first online row (postedOn =
//    company-local date of furnished_at). [] when the year has no online row.
//  - GET /api/my/w2/:year/pdf?version=n: n integer 1..50, else 400
//    { error: "invalid_version" }. Unknown n, a version never online, outside
//    onlineW2Windows, or without a frozen row -> 409 exactly
//    { error: "w2_not_available" }. 200: the employee packet of the frozen
//    figures, CORRECTED on Copies B/C/2 iff the first online row was
//    corrected; content-disposition filename "w2-<year>-v<n>.pdf";
//    cache-control no-store; no w2_furnishings row is written.
//  - GET /api/admin/annual-forms/w2?year=: each row carries `versions` =
//    exactly [{ version, kind, postedOn, via: "online" | "printed" | "paper"
//    | "unknown", current, frozen }] over every method (numbered by the first
//    row of any method; via/kind/postedOn from that row).
//  - GET /api/admin/annual-forms/w2/:employeeId/pdf?year=&version=n: Copy D
//    of the frozen version (never marked), no row written, no window gate;
//    unknown or unfrozen -> 404 { error: "not_found" }; malformed -> 400
//    { error: "invalid_version" }; integrity failure -> 409
//    { error: "w2_version_unreadable" }.
//  - Integrity failure log: the fixed message "[filings] W-2 version: frozen
//    figures failed the integrity check", optionally followed by the error
//    class in parentheses; no figure, hash, ciphertext or id.

export { markedPages };

/**
 * boot217 with a captured log stream (pino lines) and optional extra config
 * (e.g. exportToken). Same faked-clock pin on w2_furnishings.furnished_at.
 */
export async function boot223(
  now: string,
  o: { config?: Record<string, unknown>; logs?: string[] } = {},
): Promise<Env> {
  const logs = o.logs;
  const env = await boot({
    now,
    config: { appTz: TZ, ...(o.config ?? {}) },
    ...(logs ? { logStream: { write: (m: string) => void logs.push(m) } } : {}),
  });
  await env.t.pglite.exec(`
    CREATE TABLE pay217_clock (now timestamptz NOT NULL);
    CREATE FUNCTION pay217_furnished_at() RETURNS trigger AS $$
    BEGIN
      IF NEW.furnished_at = now() THEN
        NEW.furnished_at := (SELECT c.now FROM pay217_clock c LIMIT 1);
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    CREATE TRIGGER pay217_furnished_at BEFORE INSERT ON w2_furnishings
      FOR EACH ROW EXECUTE FUNCTION pay217_furnished_at();
  `);
  await env.t.pglite.query("INSERT INTO pay217_clock (now) VALUES ($1)", [now]);
  const st = await seedContact(env);
  if (st !== 200) throw new Error(`seed contact ${st}`);
  return env;
}

/** Capture console.error/warn/log/info lines (the [filings] logs use console). */
export function captureConsole(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const spies = (["error", "warn", "log", "info"] as const).map((k) =>
    vi.spyOn(console, k).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    }),
  );
  return {
    lines,
    restore() {
      for (const s of spies) s.mockRestore();
    },
  };
}

/** The id of an employee's issued run paid on `payDate`. */
export async function runIdOf(env: Env, employeeId: number, payDate: string): Promise<number> {
  const rows = await env.t.db
    .select({ id: payrollRuns.id })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.employeeId, employeeId), eq(payrollRuns.payDate, payDate)));
  if (rows.length !== 1) throw new Error(`expected one run on ${payDate}, got ${rows.length}`);
  return rows[0]!.id;
}

/**
 * Direct-insert one issued run with explicit entry amounts (cents) — for
 * fixtures whose FICA is not a flat 6.2% of each run (a wage-base crossing).
 */
export async function insertRunWithEntries(
  env: Env,
  employeeId: number,
  r: FxRun,
  entries: Record<string, number>,
): Promise<void> {
  const snapshot = snapshotOf(r);
  const inserted = await env.t.db
    .insert(payrollRuns)
    .values({
      employeeId,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      payDate: r.payDate,
      status: "issued",
      runSnapshot: snapshot,
      snapshotHash: snapshotHash(snapshot as never),
      createdBy: "test",
    })
    .returning();
  const run = inserted[0]!;
  await env.t.db.insert(payrollEntries).values(
    Object.entries(entries).map(([category, cents]) => ({
      runId: run.id,
      category,
      amount: signedMoney(cents),
    })),
  );
}

/** A frozen row inserted directly (tamper / unreadable-version fixtures). */
export async function insertFrozen(
  env: Env,
  o: {
    employeeId: number;
    taxYear: number;
    version: number;
    hash: string;
    figures: unknown;
    box15: Record<string, string> | null;
  },
): Promise<void> {
  await env.t.pglite.query(
    `INSERT INTO w2_furnished_figures (employee_id, tax_year, hash_version, boxes_hash, figures, box15_ciphertexts, source)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'furnishing')`,
    [
      o.employeeId,
      o.taxYear,
      o.version,
      o.hash,
      JSON.stringify(o.figures),
      o.box15 === null ? null : JSON.stringify(o.box15),
    ],
  );
}

// ------------------------------------------------------------------ PR-2 HTTP helpers

let ip223 = 0;
function ip(): string {
  ip223 += 1;
  return `10.223.${Math.floor(ip223 / 250) % 250}.${(ip223 % 250) + 1}`;
}

export interface EmpVersion {
  version: number;
  kind: "original" | "corrected";
  postedOn: string;
  current: boolean;
  downloadable: boolean;
}
export interface AdminVersion {
  version: number;
  kind: "original" | "corrected";
  postedOn: string;
  via: "online" | "printed" | "paper" | "unknown";
  current: boolean;
  frozen: boolean;
}

/** The employee's GET /api/my/w2 body (re-signs in first: sessions expire after 7 faked days). */
export async function myW2Body(
  env: Env,
  e: Emp,
  o: { former?: boolean } = {},
): Promise<{ status: number; body: string; json: Record<string, unknown> }> {
  if (!o.former) await relogin(env, e);
  const res = await env.t.app.inject({ method: "GET", url: "/api/my/w2", headers: e.session! });
  let json: Record<string, unknown> = {};
  try {
    json = res.json() as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.statusCode, body: res.body, json };
}

/** The list item of `year` (or undefined). */
export async function myYear(
  env: Env,
  e: Emp,
  year = 2026,
  o: { former?: boolean } = {},
): Promise<Record<string, unknown> | undefined> {
  const b = await myW2Body(env, e, o);
  const w2s = (b.json.w2s ?? []) as Record<string, unknown>[];
  return w2s.find((w) => w.year === year);
}

/** `versions` of the year's list item (undefined when absent: the old code). */
export async function myVersions(
  env: Env,
  e: Emp,
  year = 2026,
  o: { former?: boolean } = {},
): Promise<unknown> {
  return (await myYear(env, e, year, o))?.versions;
}

/** GET /api/my/w2/:year/pdf?version=n from a new client address (or `o.ip`). */
export async function versionPdf(
  env: Env,
  e: Emp,
  year: number,
  n: string | number | null,
  o: { ip?: string; headers?: Record<string, string>; query?: string } = {},
) {
  const addr = o.ip ?? ip();
  const q = o.query ?? (n === null ? "" : `?version=${encodeURIComponent(String(n))}`);
  return env.t.app.inject({
    method: "GET",
    url: `/api/my/w2/${year}/pdf${q}`,
    headers: { ...e.session!, "x-forwarded-for": addr, ...(o.headers ?? {}) },
    remoteAddress: addr,
  });
}

/** The admin W-2 list row of one employee (re-signs the admin in after a clock jump). */
export async function adminRow223(
  env: Env,
  employeeId: number,
  year = 2026,
): Promise<Record<string, unknown>> {
  let res = await env.t.app.inject({
    method: "GET",
    url: `/api/admin/annual-forms/w2?year=${year}`,
    headers: env.admin,
  });
  if (res.statusCode === 401) {
    await reloginAdmin(env);
    res = await env.t.app.inject({
      method: "GET",
      url: `/api/admin/annual-forms/w2?year=${year}`,
      headers: env.admin,
    });
  }
  if (res.statusCode !== 200) throw new Error(`admin list ${res.statusCode}`);
  const row = (res.json() as { w2s: Record<string, unknown>[] }).w2s.find(
    (r) => r.employeeId === employeeId,
  );
  if (!row) throw new Error(`no admin row for employee ${employeeId}`);
  return row;
}

/** The admin list body (raw text) of a year. */
export async function adminListBody(env: Env, year = 2026): Promise<string> {
  await reloginAdmin(env);
  const res = await env.t.app.inject({
    method: "GET",
    url: `/api/admin/annual-forms/w2?year=${year}`,
    headers: env.admin,
  });
  return res.body;
}

/** GET Copy D, with `?version=n` when n is given. */
export async function copyDOf(
  env: Env,
  employeeId: number,
  year: number,
  n: string | number | null,
  headers?: Record<string, string>,
) {
  const q = n === null ? "" : `&version=${encodeURIComponent(String(n))}`;
  const url = `/api/admin/annual-forms/w2/${employeeId}/pdf?year=${year}${q}`;
  const addr = ip();
  const send = () =>
    env.t.app.inject({
      method: "GET",
      url,
      headers: { ...(headers ?? env.admin), "x-forwarded-for": addr },
      remoteAddress: addr,
    });
  let res = await send();
  if (res.statusCode === 401 && headers === undefined) {
    await reloginAdmin(env);
    res = await send();
  }
  return res;
}

export function bodyError(res: { body: string }): unknown {
  try {
    return JSON.parse(res.body);
  } catch {
    return res.body.slice(0, 80);
  }
}

// ------------------------------------------------------------------ PR-2 PDF oracle

/**
 * Every page of a rendered (flattened) PDF as the non-empty strings its form
 * XObjects show, in field order. Parsed with the auditor's own content-stream
 * reader (annual-w2-corrected-harness.ts), never the code under test.
 */
export async function pageStrings(bytes: Uint8Array): Promise<string[][]> {
  const doc = await pdfLib.PDFDocument.load(bytes);
  const out: string[][] = [];
  for (let i = 0; i < doc.getPageCount(); i += 1) {
    out.push(pageXObjectStrings(doc, i).filter((s: string) => s !== ""));
  }
  return out;
}

/** The identity strings boxes a–f print (D-1: current data at render time). */
export interface Identity {
  ssn: string;
  ein: string;
  employer: string;
  control: string;
  first: string;
  last: string;
  address: string[];
}

/** A pay-223 fixture employee's identity: SSN 900-00-0017, EIN 00-0000001, Example Corp, box f ADDRESS. */
export function identityOf(employeeId: number, label: string): Identity {
  return {
    ssn: "900-00-0017",
    ein: "00-0000001",
    employer: "Example Corp",
    control: String(employeeId),
    first: label,
    last: "Synthetic",
    address: [ADDRESS.line1, `${ADDRESS.city}, ${ADDRESS.state} ${ADDRESS.zip}`],
  };
}

/** Box 15 ID text per state as printed (entered plaintext; IL/NY EIN default = the 9 EIN digits). */
export type IdText = Record<string, string | null>;

/**
 * The strings form `k` of a W-2 shows, in the template's field order (2025
 * and 2026 fw2, measured on the current render at 9cb9534): a, b, c, d,
 * e (first, last), f (lines); boxes 1-6 on form 1 only; then row 1 state,
 * row 1 ID, row 2 state, row 2 ID, box 16 row 1, row 2, box 17 row 1, row 2.
 * Amounts from the frozen cents through the auditor's own money().
 */
export function formStrings(who: Identity, f: Frozen, ids: IdText, k: number): string[] {
  const out = [who.ssn, who.ein, who.employer, who.control, who.first, who.last, ...who.address];
  if (k === 1) {
    out.push(
      money(f.box1Cents),
      money(f.box2Cents),
      money(f.box3Cents),
      money(f.box4Cents),
      money(f.box5Cents),
      money(f.box6Cents),
    );
  }
  const row = (r: number) => f.stateLines.find((l) => l.form === k && l.row === r);
  const r1 = row(1);
  const r2 = row(2);
  for (const l of [r1, r2]) {
    if (!l) continue;
    out.push(l.state);
    const id = ids[l.state];
    if (id) out.push(id);
  }
  for (const v of [r1?.box16Cents, r2?.box16Cents, r1?.box17Cents, r2?.box17Cents]) {
    if (v !== undefined && v !== null) out.push(money(v));
  }
  return out;
}

/** Expected employee packet pages: B×N, Notice, C×N, Instructions, 2×N, Instructions. */
export function expPacket(who: Identity, f: Frozen, ids: IdText): string[][] {
  const forms = Array.from({ length: f.formCount }, (_, i) => formStrings(who, f, ids, i + 1));
  return [...forms, [], ...forms, [], ...forms, []];
}

/** Expected Copy D pages: one per form. */
export function expCopyD(who: Identity, f: Frozen, ids: IdText): string[][] {
  return Array.from({ length: f.formCount }, (_, i) => formStrings(who, f, ids, i + 1));
}

/** 0-based pages that carry CORRECTED in a marked packet of N forms (Copies B, C, 2). */
export function markedOf(formCount: number): number[] {
  const n = formCount;
  const range = (a: number) => Array.from({ length: n }, (_, i) => a + i);
  return [...range(0), ...range(n + 1), ...range(2 * n + 2)];
}

/** A 64-hex run anywhere (a hash must never leave the database). */
export const HEX64 = /[0-9a-f]{64}/i;

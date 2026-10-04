/**
 * Annual forms (PAY-11) — Form 940 (FUTA) worksheet + W-2/W-3 generation and
 * filing tracking, reusing the tax_filings table from PAY-10 (form_type
 * '940' / 'w2_w3', quarter 0 = annual; the schema's check constraint already
 * allows them, so no migration is needed). Record-only, same doctrine as the
 * 941: the app computes and tracks; the admin e-files (IRS e-file for 940,
 * SSA Business Services Online for W-2/W-3) and marks the filing here.
 *
 * Determinism: every figure derives from frozen issued-run payroll_entries —
 * never live config (wage caps/rates come from the year's tax_config row,
 * the same source the runs were computed with). employer_futa entries are
 * the paid-liability truth; the form-derived FUTA tax (wages × 0.6%) is
 * reconciled against them to the cent via a documented rounding delta.
 *
 * W-2/W-3 PDFs render on demand (packages/documents) and are never stored.
 * PII (employee SSN/address, company EIN) is decrypted server-side at render
 * time ONLY — JSON endpoints never carry it. W-2s for a tax year become
 * available on January 1 of the following year (w2AvailableOn gate).
 */

import { and, eq, inArray, is, like, ne, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import {
  appSettings,
  company,
  emailOutbox,
  employees,
  payrollEntries,
  payrollRuns,
  taxConfig,
  taxFilings,
} from "@payroll/db";
import { round2 } from "@payroll/engine/money";
import { effectiveFutaRate } from "@payroll/engine";
import {
  type FormAddress,
  hasTemplate,
  stateIdFitsForm,
  W2FormAmountError,
  W2FormLinesError,
  W2StateIdTooLongError,
  type W2Input,
  type W2LocalLineInput,
  type W2StateLineInput,
  type W3Input,
} from "@payroll/documents";
import {
  EVENT_TYPE,
  type TemplateContext,
  w2Available as tplW2Available,
} from "@payroll/notifications";
import { electronicW2AccessThrough, formatCents, type W2Contact } from "@payroll/shared";
import type { Db } from "../db.js";
import { stateDepositedByYear, stateWithholdingByYear } from "../deposits/service.js";
import {
  EinUnreadableError,
  einReadable,
  probeStateIds,
  resolveStateIds,
  type StateIdSource,
  StateIdUnreadableError,
  stateIdFacts,
} from "../company/state-ids.js";
import type { AppConfig } from "../config.js";
import { templateContext } from "../notify/outbox.js";
import { AddressUnreadableError, w2EmployeeAddressAt } from "../change-requests/address-history.js";
import { decryptField, fieldKey } from "../crypto/field-encryption.js";
import { lockEmployee } from "../payroll/locks.js";
import { furnishCurrent } from "./w2-furnish-core.js";
import { electronicW2Channel, readW2Contact, W2_CONSENT_GATE_FROM_TAX_YEAR } from "./w2-consent.js";
import {
  type Deps,
  errorClass,
  FilingServiceError,
  type TaxFilingRow,
  toMoney,
  todayIso,
  worksheetHash,
} from "./shared.js";
import {
  AnnualFiguresDefectError,
  checkW2Boxes,
  type FicaParams,
  parseRate5,
  sumCents,
  type W2BoxesCents,
  type W2Issue,
  type W2IssueCode,
  type W2Sums,
  w2Boxes,
  w3Totals,
} from "./w2-boxes.js";
import {
  planW2StateLines,
  STATE_BOXES_FROM_YEAR,
  type W2LocalLine,
  type W2StateLine,
  type W2StatePlan,
  type W2StateRun,
} from "./w2-state.js";
import { loadW2StateRuns, loadWorkStateMoves } from "./w2-state-load.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// ---------------------------------------------------------------------------
// Pure date math
// ---------------------------------------------------------------------------

/** Annual-form due date: Jan 31 of the following year, weekend-rolled. */
export function annualDueDate(year: number): string {
  const d = new Date(Date.UTC(year + 1, 1, 0)); // Jan 31 of year + 1
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

/** W-2s for `year` unlock on January 1 of the following year. */
export function w2AvailableOn(year: number): string {
  return `${year + 1}-01-01`;
}

export function isW2Available(year: number, today: string = todayIso()): boolean {
  return today >= w2AvailableOn(year);
}

/** The year's federal caps/rates — the same source the runs computed with. */
async function federalCaps(
  db: Db,
  year: number,
): Promise<{ futaRate: number; futaWageCap: number; sutaCreditRate: number }> {
  const rows = await db
    .select()
    .from(taxConfig)
    .where(and(eq(taxConfig.jurisdiction, "federal"), eq(taxConfig.taxYear, year)))
    .limit(1);
  const row = rows[0];
  // Fallback = engine defaults; in practice a year with issued runs always
  // has a tax_config row (generation requires it).
  const sutaCreditRate = Number(row?.sutaCreditRate ?? 0.054);
  return {
    // PAY-18: the net FUTA rate derives from the configured SUTA credit
    // (0.06 − credit), never from the legacy mirrored futa_rate column.
    futaRate: effectiveFutaRate(sutaCreditRate),
    futaWageCap: Number(row?.futaWageCap ?? 7_000),
    sutaCreditRate,
  };
}

// ---------------------------------------------------------------------------
// PAY-162: fail-closed federal tax_config lookup + W-2 block errors
// ---------------------------------------------------------------------------

/**
 * PAY-162: no federal tax_config row for a year whose W-2s are requested.
 * Fixed message, year only. Every W-2/W-3 surface maps it to 409
 * { error: "missing_tax_config", year }.
 */
export class MissingTaxConfigError extends Error {
  constructor(public readonly year: number) {
    super(`no federal tax config for ${year}`);
    this.name = "MissingTaxConfigError";
  }
}

/**
 * PAY-162: a W-2 (or the W-3 of its year) cannot be issued while a block
 * issue stands. Fixed message; carries issue codes only, never amounts.
 * Deliberately not a FilingServiceError (whose mappers copy err.message).
 */
export class W2BlockedError extends Error {
  constructor(public readonly issues: readonly W2IssueCode[]) {
    super("W-2 not ready");
    this.name = "W2BlockedError";
  }
}

/**
 * PAY-162: the year has no bundled official W-2/W-3 form, so no PDF can be
 * made. Raised before any PII is read. Maps to 409 form_not_available.
 */
export class FormNotAvailableError extends Error {
  constructor(public readonly year: number) {
    super(`no bundled W-2/W-3 form for ${year}`);
    this.name = "FormNotAvailableError";
  }
}

/**
 * Spec 24 (PAY-116) PR-4: the employee's SSN failed to decrypt at render
 * time (the readiness probe passed, then the render read failed). Fixed
 * message; never carries the value or a cause. Maps to 409 ssn_unreadable.
 */
class SsnUnreadableError extends Error {
  constructor() {
    super("SSN could not be decrypted");
    this.name = "SsnUnreadableError";
  }
}

/** A fixed 409 body for a W-2/W-3 refusal: codes and year only, never amounts or ids. */
export type AnnualBlockBody =
  | { error: "missing_tax_config"; year: number }
  | { error: "w2_not_ready"; issues: readonly W2IssueCode[] }
  | { error: "form_not_available"; year: number };

/**
 * PAY-162: the one classifier for W-2/W-3 refusals. Returns the 409 body for
 * a known refusal, or null for anything else (the caller rethrows). Data
 * defects map to w2_not_ready / internal_mismatch so they never 500 and
 * never echo a value.
 */
export function annualBlockBody(err: unknown): AnnualBlockBody | null {
  if (err instanceof MissingTaxConfigError) return { error: "missing_tax_config", year: err.year };
  if (err instanceof W2BlockedError) return { error: "w2_not_ready", issues: err.issues };
  if (
    err instanceof AnnualFiguresDefectError ||
    err instanceof W2FormAmountError ||
    err instanceof W2FormLinesError
  ) {
    return { error: "w2_not_ready", issues: ["internal_mismatch"] };
  }
  // Spec 24 (PAY-116) PR-3 R1/R4/R5: box 15 or the EIN cannot be printed.
  if (err instanceof StateIdUnreadableError) {
    return { error: "w2_not_ready", issues: ["state_id_unreadable"] };
  }
  if (err instanceof EinUnreadableError)
    return { error: "w2_not_ready", issues: ["ein_unreadable"] };
  if (err instanceof W2StateIdTooLongError) {
    return { error: "w2_not_ready", issues: ["state_id_too_long"] };
  }
  // Spec 24 (PAY-116) PR-4: the SSN or box f address does not decrypt.
  if (err instanceof SsnUnreadableError)
    return { error: "w2_not_ready", issues: ["ssn_unreadable"] };
  if (err instanceof AddressUnreadableError) {
    return { error: "w2_not_ready", issues: ["address_unreadable"] };
  }
  if (err instanceof FormNotAvailableError) return { error: "form_not_available", year: err.year };
  return null;
}

/** The federal tax_config row for `year`, or MissingTaxConfigError. */
async function federalConfigRow(db: Pick<Db, "select">, year: number) {
  const rows = await db
    .select()
    .from(taxConfig)
    .where(and(eq(taxConfig.jurisdiction, "federal"), eq(taxConfig.taxYear, year)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new MissingTaxConfigError(year);
  return row;
}

/** PAY-162: throw MissingTaxConfigError unless `year` has a federal tax_config row. */
export async function assertFederalTaxConfig(db: Pick<Db, "select">, year: number): Promise<void> {
  await federalConfigRow(db, year);
}

/**
 * PAY-162: the year's FICA rates/limits as exact integers — the pay year's
 * own tax_config row, never a fallback (fails closed when missing).
 */
async function ficaParams(db: Pick<Db, "select">, year: number): Promise<FicaParams> {
  const row = await federalConfigRow(db, year);
  return {
    ssWageCapCents: sumCents(row.socialSecurityWageCap),
    ssRate5: parseRate5(row.socialSecurityRate),
    medicareRate5: parseRate5(row.medicareRate),
    addlMedicareRate5: parseRate5(row.medicareAdditionalRate),
    addlMedicareThresholdCents: sumCents(row.medicareAdditionalThreshold),
  };
}

/** One employee-year: category sums as SQL numeric text + issued-run count. */
interface EmployeeYearSums {
  sums: Record<string, string>;
  runCount: number;
}

/**
 * Per-employee sums of every entry category, issued runs paid in the year,
 * W-2 employees only. Sums stay SQL text (PAY-162: no Number() of money);
 * runCount = distinct issued runs (the box 4/6 check tolerance).
 */
async function perEmployeeSums(
  db: Pick<Db, "select">,
  year: number,
): Promise<Map<number, EmployeeYearSums>> {
  const inYear = and(
    eq(payrollRuns.status, "issued"),
    eq(employees.employmentType, "w2"),
    sql`${payrollRuns.payDate} >= ${`${year}-01-01`}`,
    sql`${payrollRuns.payDate} <= ${`${year}-12-31`}`,
  );
  const rows = await db
    .select({
      employeeId: payrollRuns.employeeId,
      category: payrollEntries.category,
      total: sql<string>`sum(${payrollEntries.amount})::numeric(14,2)::text`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .innerJoin(employees, eq(payrollRuns.employeeId, employees.id))
    .where(inYear)
    .groupBy(payrollRuns.employeeId, payrollEntries.category);
  const counts = await db
    .select({
      employeeId: payrollRuns.employeeId,
      runCount: sql<number>`count(distinct ${payrollRuns.id})::int`,
    })
    .from(payrollRuns)
    .innerJoin(employees, eq(payrollRuns.employeeId, employees.id))
    .where(inYear)
    .groupBy(payrollRuns.employeeId);
  const runCounts = new Map(counts.map((c) => [c.employeeId, c.runCount]));
  const byEmployee = new Map<number, EmployeeYearSums>();
  for (const row of rows) {
    const entry = byEmployee.get(row.employeeId) ?? {
      sums: {},
      runCount: runCounts.get(row.employeeId) ?? 0,
    };
    entry.sums[row.category] = row.total;
    byEmployee.set(row.employeeId, entry);
  }
  return byEmployee;
}

// ---------------------------------------------------------------------------
// Form 940 (FUTA) worksheet
// ---------------------------------------------------------------------------

export interface Worksheet940 {
  form: "940";
  year: number;
  /** SUTA credit rate configured for the year (PAY-18) — the rate assumption. */
  sutaCreditRate: string;
  /** Net FUTA rate used: statutory 6.0% − sutaCreditRate. */
  futaRate: string;
  /** Line 3 — total payments to all employees (gross). */
  line3TotalPayments: string;
  /** Line 7 — total taxable FUTA wages (first $7,000 per employee). */
  line7FutaTaxableWages: string;
  /** Line 8 — FUTA tax before adjustments (line 7 × net rate). */
  line8FutaTax: string;
  /** Line 12 — total FUTA tax after adjustments (no credit reduction). */
  line12TotalFutaTax: string;
  /** Sum of frozen employer_futa entries — the accrued-liability truth. */
  futaTaxPerFrozenEntries: string;
  /** Cent-level rounding delta: frozen entries minus line 12. */
  roundingDelta: string;
  /**
   * Quarterly deposit rule ($500 threshold): the first quarter whose
   * CUMULATIVE FUTA liability exceeds $500, or null when the annual total
   * stays at or under $500 (then it is paid with the return).
   */
  depositThresholdCrossedQuarter: number | null;
  /** Deposit due date — last day of the month after the crossing quarter. */
  depositDueBy: string | null;
  /** Balance due with the return (no FUTA deposits are tracked in-app). */
  balanceDue: string;
}

/**
 * Compute the annual 940 worksheet from frozen issued-run entries. FUTA
 * taxable wages follow the statutory per-employee $7,000 cap; the resulting
 * tax is reconciled to the cent against the sum of frozen employer_futa
 * entries (per-paycheck rounding delta documented, same doctrine as the
 * 941's line 7). The net FUTA rate is 6.0% − the year's configured SUTA
 * credit (PAY-18): 5.4% credit → 0.6%; no SUTA paid → 6.0%; a partial
 * credit covers credit-reduction states. The assumption is recorded on the
 * worksheet (sutaCreditRate/futaRate) so a wrong assumption is never silent.
 */
export async function compute940Worksheet(db: Db, year: number): Promise<Worksheet940> {
  const caps = await federalCaps(db, year);
  // PAY-162: the 940 keeps its Number arithmetic (cents move is a follow-up),
  // converting the text sums here exactly as before.
  const byEmployee = new Map(
    [...(await perEmployeeSums(db, year))].map(([id, e]) => [
      id,
      Object.fromEntries(Object.entries(e.sums).map(([k, v]) => [k, Number(v)])),
    ]),
  );

  const line3 = round2([...byEmployee.values()].reduce((acc, e) => acc + (e.gross_pay ?? 0), 0));
  const line7 = round2(
    [...byEmployee.values()].reduce(
      (acc, e) => acc + Math.min(e.gross_pay ?? 0, caps.futaWageCap),
      0,
    ),
  );
  const line8 = round2(line7 * caps.futaRate);
  const line12 = line8; // credit already netted in the rate; no further reduction

  // Frozen-entry truth + the quarterly $500 deposit-liability check: sum the
  // employer_futa entries by pay quarter (entries are the validated truth,
  // same doctrine as the 941 worksheet and the export API). W-2 employees
  // only, matching perEmployeeSums — contractors can never hold payroll runs
  // (runs.ts hard-asserts), but the join keeps this module self-consistent.
  const futaRows = await db
    .select({
      quarter: sql<number>`extract(quarter from ${payrollRuns.payDate})::int`,
      total: sql<string>`sum(${payrollEntries.amount})::numeric(14,2)::text`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .innerJoin(employees, eq(payrollRuns.employeeId, employees.id))
    .where(
      and(
        eq(payrollEntries.category, "employer_futa"),
        eq(payrollRuns.status, "issued"),
        eq(employees.employmentType, "w2"),
        sql`${payrollRuns.payDate} >= ${`${year}-01-01`}`,
        sql`${payrollRuns.payDate} <= ${`${year}-12-31`}`,
      ),
    )
    .groupBy(sql`extract(quarter from ${payrollRuns.payDate})`);
  const futaPerQuarter = [1, 2, 3, 4].map((q) =>
    round2(Number(futaRows.find((r) => r.quarter === q)?.total ?? "0")),
  );
  const futaEntries = round2(futaPerQuarter.reduce((acc, n) => acc + n, 0));

  let crossed: number | null = null;
  let cumulative = 0;
  for (let q = 1; q <= 4; q++) {
    cumulative = round2(cumulative + (futaPerQuarter[q - 1] ?? 0));
    if (cumulative > 500 && crossed === null) crossed = q;
  }
  // Deposit due the last day of the month following the crossing quarter.
  const depositDueBy =
    crossed === null
      ? null
      : new Date(Date.UTC(year, crossed * 3 + 1, 0)).toISOString().slice(0, 10);

  return {
    form: "940",
    year,
    sutaCreditRate: String(caps.sutaCreditRate),
    futaRate: String(caps.futaRate),
    line3TotalPayments: toMoney(line3),
    line7FutaTaxableWages: toMoney(line7),
    line8FutaTax: toMoney(line8),
    line12TotalFutaTax: toMoney(line12),
    futaTaxPerFrozenEntries: toMoney(futaEntries),
    roundingDelta: toMoney(round2(futaEntries - line12)),
    depositThresholdCrossedQuarter: crossed,
    depositDueBy,
    balanceDue: toMoney(futaEntries),
  };
}

// ---------------------------------------------------------------------------
// W-2 figures (per employee) + W-3 aggregate worksheet
// ---------------------------------------------------------------------------

/** Six null boxes: the W-2's figures are unreadable or negative (never printed). */
interface W2BoxesWithheld {
  box1Cents: null;
  box2Cents: null;
  box3Cents: null;
  box4Cents: null;
  box5Cents: null;
  box6Cents: null;
}

const WITHHELD_BOXES: W2BoxesWithheld = {
  box1Cents: null,
  box2Cents: null,
  box3Cents: null,
  box4Cents: null,
  box5Cents: null,
  box6Cents: null,
};

/** One W-2 state line (boxes 15–17) with where its box 15 ID comes from (never the ID). */
export interface W2FigureLine extends W2StateLine {
  stateIdSource: StateIdSource | null;
  /**
   * PR-3 R3: SHA-256 of the entered ID's stored ciphertext (furnishing hash
   * only; never in an API body), null for the EIN default or no ID.
   */
  stateIdDigest: string | null;
}

/**
 * Spec 24 (PAY-116): the W-2's state and local lines. Tax years before
 * STATE_BOXES_FROM_YEAR, and W-2s whose boxes are withheld: no lines,
 * formCount 1.
 */
export interface W2StateFields {
  stateLines: W2FigureLine[];
  /** Always [] from Spec 24 (PAY-171 fills it). */
  localLines: W2LocalLine[];
  /** Number of W-2 forms for this employee (two state lines per form). */
  formCount: number;
}

const NO_STATE_LINES: W2StateFields = { stateLines: [], localLines: [], formCount: 1 };

/**
 * One employee's annual W-2 box figures in integer cents — NO PII (PII joins
 * at PDF render). PAY-162: boxes are null when an internal_mismatch or
 * negative_amount issue stands; `issues` carry codes only.
 */
export type W2Figures = {
  employeeId: number;
  legalName: string;
  /** Distinct issued runs in the year (box 4/6 check tolerance). */
  runCount: number;
  issues: W2Issue[];
} & (W2BoxesCents | W2BoxesWithheld) &
  W2StateFields;

/** A W-2 whose boxes can be printed. */
export type ReadableW2Figures = W2Figures & W2BoxesCents;

/** True when any block issue stands (the W-2 cannot be issued). */
export function isW2Blocked(f: Pick<W2Figures, "issues">): boolean {
  return f.issues.some((i) => i.severity === "block");
}

/** The block issue codes of the given W-2s, deduplicated, in first-seen order. */
function blockCodes(figures: readonly Pick<W2Figures, "issues">[]): W2IssueCode[] {
  const codes: W2IssueCode[] = [];
  for (const f of figures) {
    for (const i of f.issues) {
      if (i.severity === "block" && !codes.includes(i.code)) codes.push(i.code);
    }
  }
  return codes;
}

/** Boxes and issues for one employee-year; a data defect is contained per employee. */
function figuresFor(
  sums: EmployeeYearSums,
  params: FicaParams,
): Pick<W2Figures, "issues"> & (W2BoxesCents | W2BoxesWithheld) {
  let boxes: W2BoxesCents;
  try {
    boxes = w2Boxes(sums.sums as W2Sums, params);
  } catch (err) {
    if (!(err instanceof AnnualFiguresDefectError)) throw err;
    return { ...WITHHELD_BOXES, issues: [{ code: "internal_mismatch", severity: "block" }] };
  }
  const issues = checkW2Boxes(boxes, sums.runCount, params);
  if (issues.some((i) => i.code === "negative_amount")) return { ...WITHHELD_BOXES, issues };
  return { ...boxes, issues };
}

type ReadDb = Pick<Db, "select">;

/**
 * Spec 24 (PAY-116): run one W-2 decision (perEmployeeSums, the planner
 * inputs, and the state-withholding reconciliation) against ONE snapshot.
 * Under READ COMMITTED each statement sees its own snapshot, so a run issued
 * between two of the reads could make box 1, the state lines and the W-3
 * reconciliation disagree (a false internal_mismatch or
 * reconciliation_mismatch, or a decision on mixed data). A root handle opens
 * a read-only REPEATABLE READ transaction. A caller's transaction is used as
 * it is: markFiled (filings/service.ts fileableRowUnderLock) holds
 * FILING_CLOSE_LOCK there, and opening a second transaction would read
 * outside its lock.
 */
async function inW2Snapshot<T>(db: ReadDb, fn: (r: ReadDb) => Promise<T>): Promise<T> {
  if (is(db, PgTransaction)) return fn(db);
  const root = db as Partial<Pick<Db, "transaction">>;
  if (typeof root.transaction !== "function") return fn(db);
  return root.transaction((tx) => fn(tx), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

/** The planner's per-year inputs (Spec 24 PR-2 loader). */
interface StatePlanContext {
  year: number;
  runs: Map<number, W2StateRun[]>;
  moves: Map<number, { effectiveFrom: string }[]>;
  stateIds: Record<string, StateIdSource | null>;
  /** PR-3 R3: per state, the digest of the entered ID's ciphertext (or null). */
  stateIdDigests: Record<string, string | null>;
}

/** Load the planner inputs of a year ≥ STATE_BOXES_FROM_YEAR; null before it. */
async function statePlanContext(
  db: Pick<Db, "select">,
  year: number,
): Promise<StatePlanContext | null> {
  if (year < STATE_BOXES_FROM_YEAR) return null;
  const runs = await loadW2StateRuns(db, year);
  const states = new Set<string>();
  for (const list of runs.values()) {
    for (const r of list) if (r.workState !== null) states.add(r.workState);
  }
  const facts = await stateIdFacts(db, year, [...states]);
  const stateIds: Record<string, StateIdSource | null> = {};
  const stateIdDigests: Record<string, string | null> = {};
  for (const [state, fact] of Object.entries(facts)) {
    stateIds[state] = fact.source;
    stateIdDigests[state] = fact.digest;
  }
  return {
    year,
    runs,
    moves: await loadWorkStateMoves(db, [...runs.keys()]),
    stateIds,
    stateIdDigests,
  };
}

/** One employee's plan (S24-D1); box 1 = the value printed as box 1. */
function planFor(ctx: StatePlanContext, employeeId: number, box1Cents: number): W2StatePlan {
  return planW2StateLines({
    taxYear: ctx.year,
    runs: ctx.runs.get(employeeId) ?? [],
    box1Cents,
    stateIds: ctx.stateIds,
    // PR-5 (S24-D7) feeds attributions; none exist before it.
    attributions: {},
    moves: ctx.moves.get(employeeId) ?? [],
  });
}

/** A planner line with its box 15 source and R3 digest. */
function figureLine(ctx: StatePlanContext, line: W2StateLine): W2FigureLine {
  return {
    ...line,
    stateIdSource: ctx.stateIds[line.state] ?? null,
    stateIdDigest: ctx.stateIdDigests[line.state] ?? null,
  };
}

/**
 * Add the state lines to one employee's boxes. A planner internal_mismatch
 * withholds the boxes like PAY-162 and is the only issue (Product Lead
 * ruling 2026-10-04). Withheld boxes → no lines.
 */
function withStateLines(
  boxed: Pick<W2Figures, "issues"> & (W2BoxesCents | W2BoxesWithheld),
  ctx: StatePlanContext | null,
  employeeId: number,
): Pick<W2Figures, "issues"> & (W2BoxesCents | W2BoxesWithheld) & W2StateFields {
  if (ctx === null || boxed.box1Cents === null) return { ...boxed, ...NO_STATE_LINES };
  const plan = planFor(ctx, employeeId, boxed.box1Cents);
  if (plan.issues.some((i) => i.code === "internal_mismatch")) {
    return {
      ...WITHHELD_BOXES,
      issues: [{ code: "internal_mismatch", severity: "block" }],
      ...NO_STATE_LINES,
    };
  }
  return {
    ...boxed,
    issues: [...boxed.issues, ...plan.issues],
    stateLines: plan.lines.map((l) => figureLine(ctx, l)),
    localLines: plan.locals,
    formCount: plan.formCount,
  };
}

/**
 * Spec 24 (PAY-116) A3: every employee's state lines for `year`, from the
 * planner alone (no federal config needed). Employees whose box 1 cannot be
 * read or whose plan is internal_mismatch have none.
 */
export async function w2StateLinesForYear(db: ReadDb, year: number): Promise<W2FigureLine[][]> {
  return [...(await w2StateLinesByEmployee(db, year)).values()];
}

/**
 * w2StateLinesForYear keyed by employee id (Spec 24 (PAY-116) PR-4: the
 * state-ID screen's furnished counts).
 */
export async function w2StateLinesByEmployee(
  db: ReadDb,
  year: number,
): Promise<Map<number, W2FigureLine[]>> {
  return inW2Snapshot(db, (r) => stateLinesIn(r, year));
}

async function stateLinesIn(db: ReadDb, year: number): Promise<Map<number, W2FigureLine[]>> {
  const out = new Map<number, W2FigureLine[]>();
  const ctx = await statePlanContext(db, year);
  if (ctx === null) return out;
  for (const [employeeId, sums] of await perEmployeeSums(db, year)) {
    let box1Cents: number;
    try {
      box1Cents = sumCents(sums.sums.gross_pay);
    } catch (err) {
      if (err instanceof AnnualFiguresDefectError) continue;
      throw err;
    }
    const plan = planFor(ctx, employeeId, box1Cents);
    if (plan.issues.some((i) => i.code === "internal_mismatch")) continue;
    out.set(
      employeeId,
      plan.lines.map((l) => figureLine(ctx, l)),
    );
  }
  return out;
}

/**
 * Annual W-2 figures per W-2 employee from frozen issued-run entries.
 * Contractors never appear (employment_type = 'w2' only). Box 3 applies the
 * pay year's Social Security wage base from tax_config; a year with issued
 * runs and no federal tax_config row throws MissingTaxConfigError (PAY-162).
 * Spec 24 (PAY-116): years ≥ STATE_BOXES_FROM_YEAR add the planner's state
 * lines and issues.
 */
export async function w2FiguresForYear(db: ReadDb, year: number): Promise<W2Figures[]> {
  return inW2Snapshot(db, (r) => figuresIn(r, year));
}

async function figuresIn(db: ReadDb, year: number): Promise<W2Figures[]> {
  const byEmployee = await perEmployeeSums(db, year);
  const employeeIds = [...byEmployee.keys()];
  if (employeeIds.length === 0) return [];
  const params = await ficaParams(db, year);
  const ctx = await statePlanContext(db, year);
  const rows = await db
    .select({ id: employees.id, legalName: employees.legalName })
    .from(employees)
    .where(
      sql`${employees.id} IN (${sql.join(
        employeeIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  const names = new Map(rows.map((r) => [r.id, r.legalName]));

  const figures: W2Figures[] = [];
  for (const [employeeId, sums] of byEmployee) {
    figures.push({
      employeeId,
      legalName: names.get(employeeId) ?? `#${employeeId}`,
      runCount: sums.runCount,
      ...withStateLines(figuresFor(sums, params), ctx, employeeId),
    });
  }
  // Deterministic code-point sort (localeCompare is host-dependent).
  return figures.sort((a, b) =>
    a.legalName < b.legalName ? -1 : a.legalName > b.legalName ? 1 : 0,
  );
}

/** The six W-2 boxes as printed ("8000.00"), via formatCents only. */
export function w2BoxStrings(b: W2BoxesCents): {
  box1Wages: string;
  box2FederalWithheld: string;
  box3SsWages: string;
  box4SsTax: string;
  box5MedicareWages: string;
  box6MedicareTax: string;
} {
  return {
    box1Wages: formatCents(b.box1Cents),
    box2FederalWithheld: formatCents(b.box2Cents),
    box3SsWages: formatCents(b.box3Cents),
    box4SsTax: formatCents(b.box4Cents),
    box5MedicareWages: formatCents(b.box5Cents),
    box6MedicareTax: formatCents(b.box6Cents),
  };
}

/** Spec 24 §7: one state's W-3 reconciliation view (R9). */
export interface W3StateRow {
  state: string;
  /** W-2 rows of this state (a null second row counts). */
  w2Lines: number;
  box16: string;
  box17: string;
  /** state_withholding of the issued runs with this work state, pay-date year. */
  runWithholding: string;
  /** Always "0.00" until PR-5 (S24-D7). */
  attributedLegacy: string;
  reconciled: boolean;
}

/** Spec 24 §7: the W-3 state keys (tax years ≥ STATE_BOXES_FROM_YEAR only). */
export interface W3StateSection {
  /** W-3 box c: number of W-2 forms (S24-D12). */
  w2FormCount: number;
  /** One state across all lines, "X" for more, null for none (R6). */
  box15State: string | null;
  box16StateWages: string;
  box17StateTax: string;
  states: W3StateRow[];
  blockedEmployees: number;
}

export interface WorksheetW3 extends Partial<W3StateSection> {
  form: "w2_w3";
  year: number;
  /** Number of W-2 statements summarized. */
  employeeCount: number;
  box1Wages: string;
  box2FederalWithheld: string;
  box3SsWages: string;
  box4SsTax: string;
  box5MedicareWages: string;
  box6MedicareTax: string;
}

/** The readable W-2s, or W2BlockedError when any W-2's figures are withheld. */
function readableFigures(figures: readonly W2Figures[]): ReadableW2Figures[] {
  const withheld = figures.filter((f) => f.box1Cents === null);
  if (withheld.length > 0) throw new W2BlockedError(blockCodes(withheld));
  return figures as ReadableW2Figures[];
}

type StateAcc = { lines: number; b16: number; b17: number };

/** Per-state sums of the printed lines (null = 0) and the year's totals. */
function sumStateLines(figures: readonly ReadableW2Figures[]) {
  const per = new Map<string, StateAcc>();
  let forms = 0;
  let w16 = 0;
  let w17 = 0;
  for (const f of figures) {
    forms += f.formCount;
    for (const l of f.stateLines) {
      const acc = per.get(l.state) ?? { lines: 0, b16: 0, b17: 0 };
      acc.lines += 1;
      acc.b16 += l.box16Cents ?? 0;
      acc.b17 += l.box17Cents ?? 0;
      per.set(l.state, acc);
      w16 += l.box16Cents ?? 0;
      w17 += l.box17Cents ?? 0;
    }
  }
  return { per, forms, w16, w17 };
}

/** W-3 box c and boxes 15–17 (S24-D12, R6), from the printed W-2 lines. */
type W3StateBoxes = Pick<
  W3StateSection,
  "w2FormCount" | "box15State" | "box16StateWages" | "box17StateTax"
>;

function w3StateBoxes(sums: ReturnType<typeof sumStateLines>): W3StateBoxes {
  const { per, forms, w16, w17 } = sums;
  if (!Number.isSafeInteger(w16) || !Number.isSafeInteger(w17)) {
    throw new AnnualFiguresDefectError();
  }
  const lineStates = [...per.keys()];
  return {
    w2FormCount: forms,
    box15State: lineStates.length > 1 ? "X" : (lineStates[0] ?? null),
    box16StateWages: formatCents(w16),
    box17StateTax: formatCents(w17),
  };
}

/**
 * Spec 24 §7 / S24-D10 / S24-D12: W-3 box c, boxes 15–17 and the per-state
 * reconciliation against the issued runs' state withholding (deposits
 * module; deposit status never enters). A state with run withholding but no
 * W-2 line is listed unreconciled (fail closed).
 */
async function w3StateSection(
  db: Pick<Db, "select">,
  year: number,
  figures: readonly ReadableW2Figures[],
): Promise<W3StateSection> {
  const sums = sumStateLines(figures);
  const boxes = w3StateBoxes(sums);
  const { per } = sums;
  const runs = await stateWithholdingByYear(db, year);
  for (const [state, cents] of runs) {
    if (cents !== 0 && !per.has(state)) per.set(state, { lines: 0, b16: 0, b17: 0 });
  }
  const codes = [...per.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const values = [...per.values()].flatMap((p) => [p.b16, p.b17]);
  if (values.some((v) => !Number.isSafeInteger(v))) throw new AnnualFiguresDefectError();
  return {
    ...boxes,
    states: codes.map((state) => {
      const p = per.get(state) as StateAcc;
      const run = runs.get(state) ?? 0;
      return {
        state,
        w2Lines: p.lines,
        box16: formatCents(p.b16),
        box17: formatCents(p.b17),
        runWithholding: formatCents(run),
        attributedLegacy: "0.00",
        reconciled: p.b17 === run,
      };
    }),
    blockedEmployees: figures.filter(isW2Blocked).length,
  };
}

/**
 * The year's W-3 state section, or null before STATE_BOXES_FROM_YEAR, with
 * no W-2s, or while any W-2 of the year has withheld boxes.
 */
async function yearStateSection(
  db: Pick<Db, "select">,
  year: number,
  figures: readonly W2Figures[],
): Promise<W3StateSection | null> {
  if (year < STATE_BOXES_FROM_YEAR || figures.length === 0) return null;
  if (figures.some((f) => f.box1Cents === null)) return null;
  return w3StateSection(db, year, figures as ReadableW2Figures[]);
}

/**
 * Spec 24 (PAY-116) §5: the year-level reconciliation_mismatch issues, one
 * per unreconciled state. None before STATE_BOXES_FROM_YEAR, and none while
 * any W-2 of the year has withheld boxes (the section is null then: the
 * year is already blocked; Product Lead ruling 2026-10-04).
 */
function yearIssuesOf(section: W3StateSection | null): W2Issue[] {
  if (section === null) return [];
  return section.states
    .filter((s) => !s.reconciled)
    .map((s) => ({ code: "reconciliation_mismatch", severity: "block", state: s.state }));
}

/**
 * Spec 24 (PAY-116) PR-4 (I3): one state's tax check on the admin W-2 list.
 * Admin JSON only. `deposited` is UI-only (S24-D10): never in a worksheet or
 * a hash, and never part of `reconciled`.
 */
export interface W2StateCheck {
  state: string;
  /** Σ box 17 on the year's W-2 lines (a null line counts 0). */
  box17: string;
  /** state_withholding of the issued runs, pay-date year. */
  runWithholding: string;
  /** Always "0.00" until PR-5 (S24-D7). */
  attributedLegacy: string;
  /** Σ tax_deposits rows of the state marked deposited, period start in the year. */
  deposited: string;
  reconciled: boolean;
}

/** The state tax check rows of a year state section ([] for none). */
export async function w2StateChecks(
  db: Pick<Db, "select">,
  year: number,
  section: W3StateSection | null,
): Promise<W2StateCheck[]> {
  if (section === null || section.states.length === 0) return [];
  const deposited = await stateDepositedByYear(db, year);
  return section.states.map((s) => ({
    state: s.state,
    box17: s.box17,
    runWithholding: s.runWithholding,
    attributedLegacy: s.attributedLegacy,
    deposited: formatCents(deposited.get(s.state) ?? 0),
    reconciled: s.reconciled,
  }));
}

/**
 * The year's W-2 figures and year-level issues from one snapshot
 * (inW2Snapshot): the admin list, the W-3 PDF and the block codes decide on
 * both together.
 */
export async function w2FiguresWithYearIssues(
  db: ReadDb,
  year: number,
  opts: { renderChecks?: boolean } = {},
): Promise<{ figures: W2Figures[]; yearIssues: W2Issue[]; stateSection: W3StateSection | null }> {
  return inW2Snapshot(db, async (r) => {
    const figures = await w2FiguresForYear(r, year);
    // Spec 24 (PAY-116) PR-4: the section is returned too, so the admin
    // list's state tax check comes from the same snapshot as the issues.
    const stateSection = await yearStateSection(r, year, figures);
    const yearIssues = yearIssuesOf(stateSection);
    if (opts.renderChecks === false) return { figures, yearIssues, stateSection };
    return { figures: await withRenderChecks(r, year, figures), yearIssues, stateSection };
  });
}

/**
 * Spec 24 (PAY-116) PR-3 R1/R4/R5: hold every W-2 whose PDF could not print
 * — an EIN that does not decrypt (ein_unreadable, any year) and, from
 * STATE_BOXES_FROM_YEAR, a box 15 ID that does not decrypt
 * (state_id_unreadable) or does not fit the form (state_id_too_long). The
 * values are probed and discarded (company/state-ids.ts); the issues carry
 * code, severity and state only. Spec 24 (PAY-116) PR-4: also an employee
 * SSN (ssn_unreadable) or box f address (address_unreadable, the same
 * effective-dated resolution the PDF uses) that does not decrypt — probed
 * only for a year with a bundled W-2 form (a year that cannot print never
 * decrypts an SSN), decrypted and discarded, never logged; those issues
 * carry code and severity only. Every readiness and furnishing path gets
 * its figures with these checks, so no furnishing row or mail exists for
 * such a W-2:
 *  - employeeW2Figures: markFurnishedOnPaper, sendOneW2AvailableNotice
 *    (portal_notice), isMyW2Ready, and in
 *    w2-furnish.ts printableFigures → currentHash (furnishCorrectionIfNeeded
 *    from reconcileW2Furnishings and runs.ts applyLateIssueEffects) and
 *    backfillOneInTx (backfillEmployeeYearIfNeeded, backfillW2Furnishings).
 *  - w2FiguresWithYearIssues: the admin W-2 list, yearW2BlockCodes
 *    (w2sIssuable → sendW2AvailableNotices, markFiled, the filings list).
 *  - Directly, after the form check (round 3 L1): w2InputWithBoxes (Copy D,
 *    furnishAndRender for the employee download and admin print packet)
 *    and w3InputFor.
 * Without checks (`renderChecks: false`, or w2FiguresForYear) only to decide
 * the PAY-162 refusals that come before the form check, and to compute the
 * stored W-3 worksheet (w3WorksheetIn) and backfillOneYear's employee list
 * (each employee then goes through backfillOneInTx).
 */
async function withRenderChecks(
  db: ReadDb,
  year: number,
  figures: W2Figures[],
): Promise<W2Figures[]> {
  if (figures.length === 0) return figures;
  const key = fieldKey();
  const [row] = await db.select({ ein: company.ein }).from(company).limit(1);
  const einOk = einReadable(row?.ein, key);
  const states = [...new Set(figures.flatMap((f) => f.stateLines.map((l) => l.state)))];
  // A year without a bundled form prints nothing (form_not_available): only
  // readability is checked then.
  const fits = (id: string) => !hasTemplate(year, "fw2") || stateIdFitsForm(year, id);
  const problems =
    year >= STATE_BOXES_FROM_YEAR
      ? await probeStateIds(db, key, year, states, fits)
      : new Map<string, never>();
  const pii = hasTemplate(year, "fw2")
    ? await probeEmployeePii(
        db,
        key,
        year,
        figures.map((f) => f.employeeId),
      )
    : new Map<number, W2Issue[]>();
  return figures.map((f) => {
    const extra: W2Issue[] = [];
    if (!einOk) extra.push({ code: "ein_unreadable", severity: "block" });
    extra.push(...(pii.get(f.employeeId) ?? []));
    for (const state of new Set(f.stateLines.map((l) => l.state))) {
      const problem = problems.get(state);
      // An IL/NY default whose EIN does not decrypt: the EIN issue covers it.
      if (problem === undefined || problem === "ein_unreadable") continue;
      extra.push({ code: problem, severity: "block", state });
    }
    return extra.length === 0 ? f : { ...f, issues: [...f.issues, ...extra] };
  });
}

/**
 * Spec 24 (PAY-116) PR-4: per employee, ssn_unreadable when the stored SSN
 * does not decrypt and address_unreadable when the box f address (current
 * value or a history value it resolves through) does not decrypt. One
 * batched employees read; every value is decrypted and discarded — never
 * stored, returned, logged or hashed (the PR-3 probe exception, extended to
 * employee PII by the PR-4 security condition). Employees with no issue are
 * absent from the map.
 */
async function probeEmployeePii(
  db: ReadDb,
  key: string,
  year: number,
  employeeIds: readonly number[],
): Promise<Map<number, W2Issue[]>> {
  const out = new Map<number, W2Issue[]>();
  if (employeeIds.length === 0) return out;
  const rows = await db
    .select({ id: employees.id, taxId: employees.taxId })
    .from(employees)
    .where(inArray(employees.id, [...employeeIds]));
  for (const row of rows) {
    const issues = [...ssnIssues(row.taxId, key), ...(await addressIssues(db, row.id, year, key))];
    if (issues.length > 0) out.set(row.id, issues);
  }
  return out;
}

/** [ssn_unreadable] when a stored SSN does not decrypt; the value is discarded. */
function ssnIssues(taxId: string | null, key: string): W2Issue[] {
  if (!taxId) return [];
  try {
    decryptSsn(taxId, key);
    return [];
  } catch (err) {
    if (!(err instanceof SsnUnreadableError)) throw err;
    return [{ code: "ssn_unreadable", severity: "block" }];
  }
}

/** [address_unreadable] when the box f address does not decrypt; the value is discarded. */
async function addressIssues(
  db: ReadDb,
  employeeId: number,
  year: number,
  key: string,
): Promise<W2Issue[]> {
  try {
    await w2EmployeeAddressAt(db, employeeId, year, key);
    return [];
  } catch (err) {
    if (!(err instanceof AddressUnreadableError)) throw err;
    return [{ code: "address_unreadable", severity: "block" }];
  }
}

/**
 * W-3 transmittal worksheet — the box-by-box aggregate across all W-2s,
 * exact integer sums (PAY-162; keys and value strings unchanged). Throws
 * W2BlockedError while any W-2 has internal_mismatch / negative_amount, so
 * the stored worksheet is not refreshed until the defect is gone. Spec 24:
 * years ≥ STATE_BOXES_FROM_YEAR add the state keys; earlier years are
 * byte-identical (W15).
 */
export async function computeW3Worksheet(db: ReadDb, year: number): Promise<WorksheetW3> {
  return inW2Snapshot(db, (r) => w3WorksheetIn(r, year));
}

async function w3WorksheetIn(db: ReadDb, year: number): Promise<WorksheetW3> {
  const figures = readableFigures(await w2FiguresForYear(db, year));
  const totals = w3Totals(figures);
  const base: WorksheetW3 = {
    form: "w2_w3",
    year,
    employeeCount: totals.employeeCount,
    ...w2BoxStrings(totals),
  };
  if (year < STATE_BOXES_FROM_YEAR) return base;
  return { ...base, ...(await w3StateSection(db, year, figures)) };
}

// ---------------------------------------------------------------------------
// Refresh + sync (daily tick, alongside the quarterly 941 sync)
// ---------------------------------------------------------------------------

/**
 * Recompute and persist the worksheet for an UNFILED annual filing. Returns
 * true when the stored worksheet changed. Filed rows are frozen forever (the
 * caller checks status, same as the 941 path).
 */
export async function refreshAnnualWorksheet(db: Db | Tx, filing: TaxFilingRow): Promise<boolean> {
  let worksheet: Worksheet940 | WorksheetW3;
  if (filing.formType === "940") {
    worksheet = await compute940Worksheet(db, filing.year);
  } else {
    // PAY-162: no refresh while the year's figures cannot be computed — the
    // stored worksheet and hash stay exactly as they were.
    try {
      worksheet = await computeW3Worksheet(db, filing.year);
    } catch (err) {
      if (err instanceof W2BlockedError) return false;
      if (err instanceof MissingTaxConfigError || err instanceof AnnualFiguresDefectError) {
        // Fixed messages only (year, or no detail) — sync never stops here.
        console.warn(`[filings] W-3 worksheet not refreshed: ${err.message}`);
        return false;
      }
      throw err;
    }
  }
  const hash = worksheetHash(worksheet);
  if (hash === filing.worksheetHash) return false;
  // PAY-162: `filing` may be a stale read — a mark-filed that committed
  // since then must never have its frozen worksheet overwritten.
  const updated = await db
    .update(taxFilings)
    .set({ worksheet, worksheetHash: hash, updatedAt: new Date() })
    .where(and(eq(taxFilings.id, filing.id), ne(taxFilings.status, "filed")))
    .returning({ id: taxFilings.id });
  return updated.length > 0;
}

export interface AnnualSyncResult {
  created: number;
  refreshed: number;
}

/**
 * Create (when missing) + refresh one annual filing row; filed rows freeze.
 * `opts.status` is the status a NEW row gets; an existing not_started row is
 * promoted to ready when the caller says the year has closed (PAY-22).
 */
export async function upsertAnnualFiling(
  db: Db,
  formType: "940" | "w2_w3",
  year: number,
  opts: { status: "not_started" | "ready"; createdBy?: string },
): Promise<AnnualSyncResult> {
  const existing = await db
    .select()
    .from(taxFilings)
    .where(
      and(eq(taxFilings.formType, formType), eq(taxFilings.year, year), eq(taxFilings.quarter, 0)),
    )
    .limit(1);
  let row = existing[0];
  let created = 0;
  if (!row) {
    const inserted = await db
      .insert(taxFilings)
      .values({
        formType,
        year,
        quarter: 0,
        dueDate: annualDueDate(year),
        status: opts.status,
        createdBy: opts.createdBy ?? "scheduler",
      })
      .returning();
    row = inserted[0];
    if (!row) throw new Error("tax_filings insert returned no row");
    created = 1;
  } else if (row.status === "not_started" && opts.status === "ready") {
    // Year closed since the row was created in-year (PAY-22): promote to
    // ready — the same gate as the W-2 availability date (Jan 1, year + 1).
    const updated = await db
      .update(taxFilings)
      .set({ status: "ready", updatedAt: new Date() })
      .where(eq(taxFilings.id, row.id))
      .returning();
    row = updated[0] ?? row;
  }
  const refreshed = row.status !== "filed" && (await refreshAnnualWorksheet(db, row)) ? 1 : 0;
  return { created, refreshed };
}

/**
 * Upsert annual tax_filings rows for every calendar year with issued payroll
 * (quarter 0, due Jan 31 of the following year), then refresh unfiled
 * worksheets. Idempotent: the (form_type, year, quarter) unique constraint
 * is the belt.
 *
 * PAY-22: the 940 row exists IN-YEAR as not_started — its live worksheet is
 * the FUTA deposit-liability monitor (the $500 crossing quarter surfaces the
 * moment it happens), so it cannot wait for year-end. It promotes to ready
 * on January 1 of the following year, the same gate as W-2 availability
 * (w2AvailableOn). The w2_w3 row intentionally stays year-close-only: W-2s
 * are never furnished before year-end (w2InputFor / listMyW2Years /
 * sendW2AvailableNotices all gate on Jan 1), so an in-year w2_w3 row would
 * be an unactionable shell.
 */
export async function syncAnnualFilings(
  deps: Deps,
  opts: { today?: string } = {},
): Promise<AnnualSyncResult> {
  const { db } = deps;
  const today = opts.today ?? todayIso();
  const years = await db
    .selectDistinct({ year: sql<number>`extract(year from ${payrollRuns.payDate})::int` })
    .from(payrollRuns)
    .where(eq(payrollRuns.status, "issued"));

  const result: AnnualSyncResult = { created: 0, refreshed: 0 };
  for (const { year } of years) {
    const yearClosed = isW2Available(year, today); // today >= Jan 1 of year + 1
    const plan: Array<{ formType: "940" | "w2_w3"; status: "not_started" | "ready" }> = yearClosed
      ? [
          { formType: "940", status: "ready" },
          { formType: "w2_w3", status: "ready" },
        ]
      : [{ formType: "940", status: "not_started" }];
    for (const { formType, status } of plan) {
      const r = await upsertAnnualFiling(db, formType, year, { status });
      result.created += r.created;
      result.refreshed += r.refreshed;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// PDF input assembly (PII decrypted HERE, at render time only)
// ---------------------------------------------------------------------------

function asAddress(value: unknown): FormAddress | null {
  if (value === null || typeof value !== "object") return null;
  const a = value as Partial<FormAddress>;
  if (!a.line1 || !a.city || !a.state || !a.zip || !a.country) return null;
  return {
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    state: a.state,
    zip: a.zip,
    country: a.country,
  };
}

/** 9 decrypted digits → "123-45-6789" (anything else passes through). */
function formatSsn(plain: string): string {
  return /^(\d{3})(\d{2})(\d{4})$/.exec(plain)?.slice(1).join("-") ?? plain;
}

/** Decrypt an employee SSN; SsnUnreadableError (no value, no cause) on failure (PR-4). */
function decryptSsn(stored: string, key: string): string {
  try {
    return decryptField(stored, key);
  } catch {
    throw new SsnUnreadableError();
  }
}

/** Decrypt the company EIN; EinUnreadableError (no value, no cause) on failure (R4). */
function decryptEin(stored: string, key: string): string {
  try {
    return decryptField(stored, key);
  } catch {
    throw new EinUnreadableError();
  }
}

/**
 * Company header for official IRS forms: legal name, decrypted EIN, address.
 * PR-3 R4: an EIN that does not decrypt throws EinUnreadableError (W-2/W-3
 * paths: 409 ein_unreadable).
 */
export async function employerBlock(
  db: Pick<Db, "select">,
  config: AppConfig,
): Promise<{ legalName: string; ein: string | null; address: FormAddress | null }> {
  const rows = await db.select().from(company).limit(1);
  const row = rows[0];
  return {
    legalName: row?.legalName ?? "Unknown",
    ein: row?.ein ? decryptEin(row.ein, config.encryptionKey) : null,
    address: asAddress(row?.address),
  };
}

/** The W-2's state and local lines as the PDF prints them (IDs decrypted). */
async function pdfLines(
  deps: { db: Pick<Db, "select">; config: AppConfig },
  year: number,
  figures: W2StateFields,
): Promise<{ stateLines: W2StateLineInput[]; localLines: W2LocalLineInput[] }> {
  // Render time only. A value that does not decrypt throws
  // StateIdUnreadableError / EinUnreadableError (409, never a 500).
  const ids = await resolveStateIds(
    deps.db,
    deps.config.encryptionKey,
    year,
    figures.stateLines.map((l) => l.state),
  );
  return {
    stateLines: figures.stateLines.map((l) => ({
      state: l.state,
      stateId: ids.get(l.state) ?? null,
      box16: l.box16Cents === null ? null : formatCents(l.box16Cents),
      box17: l.box17Cents === null ? null : formatCents(l.box17Cents),
      form: l.form,
      row: l.row,
    })),
    localLines: figures.localLines.map((l) => ({
      locality: l.locality,
      box18: formatCents(l.box18Cents),
      box19: formatCents(l.box19Cents),
      form: l.form,
      row: l.row,
    })),
  };
}

/** A W-2 PDF input with the integer-cent figures it was built from (PAY-206 hash). */
export interface W2InputWithBoxes {
  input: W2Input;
  boxes: ReadableW2Figures;
}

/**
 * Assemble the full W-2 PDF input for one employee/year — figures from frozen
 * entries, PII decrypted at this point only. Throws invalid_transition before
 * the January availability gate; not_found when the employee has no W-2 for
 * the year (no issued runs, or a contractor). PAY-206: `deps.db` may be a
 * transaction holding the employee lock; the boxes come back in cents.
 * Spec 24 (PAY-116) PR-3: + the state lines (box 15 IDs decrypted here),
 * local lines and form count; none before STATE_BOXES_FROM_YEAR.
 */
export async function w2InputWithBoxes(
  deps: { db: Pick<Db, "select">; config: AppConfig },
  employeeId: number,
  year: number,
  opts: { today?: string; requireBundledForm?: boolean } = {},
): Promise<W2InputWithBoxes> {
  const { db, config } = deps;
  if (!isW2Available(year, opts.today)) {
    throw new FilingServiceError(
      "invalid_transition",
      `W-2 for ${year} becomes available on ${w2AvailableOn(year)}`,
    );
  }
  // PAY-162 order: missing config / not found / blocked figures first (no
  // decrypt), then the form check — PDF callers stop there when the year
  // has no official form, before any PII is read or decrypted, including
  // the PR-3 render-check probes (round 3 L1) — then the render checks.
  const figures = readableBoxes(
    await employeeW2Figures(db, employeeId, year, { renderChecks: false }),
  );
  if (opts.requireBundledForm && !hasTemplate(year, "fw2")) throw new FormNotAvailableError(year);
  const boxes = readableBoxes((await withRenderChecks(db, year, [figures]))[0] as W2Figures);
  const rows = await db.select().from(employees).where(eq(employees.id, employeeId)).limit(1);
  const employee = rows[0];
  if (!employee) throw new FilingServiceError("not_found", `employee ${employeeId} not found`);

  // Box f (PAY-20): the mailing address effective Dec 31 of the tax year,
  // falling back to the residential address effective at the same date —
  // both resolved through the effective-dated change-request history.
  // Spec 24 (PAY-116) PR-4: a decrypt failure here (after the probe passed)
  // is a typed hold — AddressUnreadableError / SsnUnreadableError, 409.
  const boxFAddress = await w2EmployeeAddressAt(db, employeeId, year, config.encryptionKey);

  const input: W2Input = {
    taxYear: year,
    employer: await employerBlock(db, config),
    employee: {
      legalName: employee.legalName,
      ssn: employee.taxId ? formatSsn(decryptSsn(employee.taxId, config.encryptionKey)) : null,
      address: asAddress(boxFAddress),
    },
    // Box d control number = the employee ID (D5).
    controlNumber: String(employee.id),
    ...w2BoxStrings(boxes),
    ...(await pdfLines(deps, year, boxes)),
    formCount: boxes.formCount,
  };
  return { input, boxes };
}

/** w2InputWithBoxes, the PDF input only. */
export async function w2InputFor(
  deps: Deps,
  employeeId: number,
  year: number,
  opts: { today?: string; requireBundledForm?: boolean } = {},
): Promise<W2Input> {
  return (await w2InputWithBoxes(deps, employeeId, year, opts)).input;
}

/** One employee's W-2 figures for the year; not_found when there is none. */
export async function employeeW2Figures(
  db: Pick<Db, "select">,
  employeeId: number,
  year: number,
  opts: { renderChecks?: boolean } = {},
): Promise<W2Figures> {
  const figures = (await w2FiguresForYear(db, year)).find((f) => f.employeeId === employeeId);
  if (!figures) {
    throw new FilingServiceError("not_found", `no W-2 for employee ${employeeId} in ${year}`);
  }
  if (opts.renderChecks === false) return figures;
  return (await withRenderChecks(db, year, [figures]))[0] as W2Figures;
}

/** PAY-162: the figures of a W-2 that may be issued, or W2BlockedError. */
export function readableBoxes(figures: W2Figures): ReadableW2Figures {
  if (isW2Blocked(figures) || figures.box1Cents === null) {
    throw new W2BlockedError(blockCodes([figures]));
  }
  return figures;
}

/**
 * Spec 24 (PAY-116) PR-3: W-3 box c and boxes 15–19 for a year with state
 * boxes. Box 15 (iw2w3 2026): one state → its code and the employer's state
 * ID (decrypted here, render time only); more than one → "X" and no ID.
 * No state line → boxes 15–17 blank. Boxes 18–19 stay blank (Spec 25).
 */
async function w3StateInput(
  deps: Deps,
  year: number,
  figures: readonly ReadableW2Figures[],
): Promise<Partial<W3Input>> {
  const boxes = w3StateBoxes(sumStateLines(figures));
  const local = { box18LocalWages: null, box19LocalTax: null };
  const state = boxes.box15State;
  if (state === null) {
    return {
      w2FormCount: boxes.w2FormCount,
      box15State: null,
      box15StateId: null,
      box16StateWages: null,
      box17StateTax: null,
      ...local,
    };
  }
  const id =
    state === "X"
      ? null
      : ((await resolveStateIds(deps.db, deps.config.encryptionKey, year, [state])).get(state) ??
        null);
  return { ...boxes, box15StateId: id, ...local };
}

/** Assemble the W-3 transmittal PDF input (admin-only; company PII only). */
export async function w3InputFor(
  deps: Deps,
  year: number,
  opts: { today?: string; requireBundledForm?: boolean } = {},
): Promise<W3Input> {
  const { db, config } = deps;
  if (!isW2Available(year, opts.today)) {
    throw new FilingServiceError(
      "invalid_transition",
      `W-3 for ${year} becomes available on ${w2AvailableOn(year)}`,
    );
  }
  // PAY-162 order: figures and their blocks first (no decrypt), then the
  // form check (before any PII is read or decrypted, round 3 L1), then the
  // PR-3 render checks.
  const { figures, yearIssues } = await w2FiguresWithYearIssues(db, year, {
    renderChecks: false,
  });
  if (figures.length === 0) {
    throw new FilingServiceError("not_found", `no W-2s for ${year}`);
  }
  // PAY-162: no W-3 while any W-2 of the year is blocked.
  const blocked = blockCodes(figures);
  if (blocked.length > 0) throw new W2BlockedError(blocked);
  // Spec 24 (PAY-116) R9: no W-3 while a state does not reconcile.
  if (yearIssues.length > 0) {
    throw new W2BlockedError(["reconciliation_mismatch"]);
  }
  if (opts.requireBundledForm && !hasTemplate(year, "fw3")) throw new FormNotAvailableError(year);
  const checked = await withRenderChecks(db, year, figures);
  const unprintable = blockCodes(checked);
  if (unprintable.length > 0) throw new W2BlockedError(unprintable);
  const readable = readableFigures(checked);
  const totals = w3Totals(readable);
  return {
    taxYear: year,
    employer: await employerBlock(db, config),
    employeeCount: totals.employeeCount,
    ...w2BoxStrings(totals),
    ...(year < STATE_BOXES_FROM_YEAR ? {} : await w3StateInput(deps, year, readable)),
  };
}

// ---------------------------------------------------------------------------
// Employee self-service queries
// ---------------------------------------------------------------------------

/** Tax years with an issued run of the user's W-2 employee record (any availability). */
async function myIssuedYears(db: Db, userId: string): Promise<number[]> {
  const employeeRows = await db
    .select({ id: employees.id })
    .from(employees)
    .where(and(eq(employees.userId, userId), eq(employees.employmentType, "w2")))
    .limit(1);
  const employee = employeeRows[0];
  if (!employee) return [];
  const rows = await db
    .selectDistinct({ year: sql<number>`extract(year from ${payrollRuns.payDate})::int` })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.employeeId, employee.id), eq(payrollRuns.status, "issued")));
  return rows.map((r) => r.year);
}

/**
 * W-2 years available to this user RIGHT NOW: their own issued runs, gated
 * to January of the following year, newest first.
 */
export async function listMyW2Years(
  db: Db,
  userId: string,
  today: string = todayIso(),
): Promise<number[]> {
  return (await myIssuedYears(db, userId))
    .filter((year) => isW2Available(year, today))
    .sort((a, b) => b - a);
}

/**
 * PAY-208 (2.2b, OD5): the latest tax year with issued runs for this user
 * whose W-2 is not available yet (null when none) — so the consent prompt
 * shows before January.
 */
export async function myUpcomingW2Year(
  db: Db,
  userId: string,
  today: string = todayIso(),
): Promise<number | null> {
  const upcoming = (await myIssuedYears(db, userId)).filter((y) => !isW2Available(y, today));
  return upcoming.length > 0 ? Math.max(...upcoming) : null;
}

// ---------------------------------------------------------------------------
// W-2 availability notices (employee email, once per tax year)
// ---------------------------------------------------------------------------

const W2_NOTIFIED_YEARS_KEY = "w2_available_notified_years";

/**
 * The tax years whose w2_available notice already went out. PAY-206: no
 * longer the w2_changed gate (that is the w2_furnishings record); read once
 * by the furnishing backfill.
 */
export async function notifiedYears(db: Pick<Db, "select">): Promise<number[]> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, W2_NOTIFIED_YEARS_KEY))
    .limit(1);
  const value = rows[0]?.value;
  return Array.isArray(value) ? value.filter((n): n is number => Number.isInteger(n)) : [];
}

interface NoticeRecipient {
  userId: string;
  employeeId: number;
  status: string;
}

/** W-2 employees (with a user account) who have issued runs in the year. */
async function w2RecipientsForYear(
  db: Pick<Db, "selectDistinct">,
  year: number,
  employeeId?: number,
): Promise<NoticeRecipient[]> {
  const rows = await db
    .selectDistinct({
      userId: employees.userId,
      employeeId: employees.id,
      status: employees.status,
    })
    .from(payrollRuns)
    .innerJoin(employees, eq(payrollRuns.employeeId, employees.id))
    .where(
      and(
        eq(payrollRuns.status, "issued"),
        eq(employees.employmentType, "w2"),
        sql`${payrollRuns.payDate} >= ${`${year}-01-01`}`,
        sql`${payrollRuns.payDate} <= ${`${year}-12-31`}`,
        sql`${employees.userId} IS NOT NULL`,
        ...(employeeId === undefined ? [] : [eq(employees.id, employeeId)]),
      ),
    )
    .orderBy(employees.id);
  return rows.flatMap((r) =>
    r.userId === null ? [] : [{ userId: r.userId, employeeId: r.employeeId, status: r.status }],
  );
}

/** The outbox marker of a year notice (one per recipient per year). */
function yearNoticeMarker(year: number): string {
  return `<!-- w2-available:${year} -->`;
}

/** True when the user's year notice for `year` is already in the outbox. */
async function yearNoticeQueued(
  db: Pick<Db, "select">,
  userId: string,
  year: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.userId, userId),
        eq(emailOutbox.eventType, EVENT_TYPE.w2Available),
        like(emailOutbox.bodyHtml, `%${yearNoticeMarker(year)}%`),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** What every year notice of one run renders with. */
interface NoticeContext {
  ctx: TemplateContext;
  contact: W2Contact | null;
  contactReady: boolean;
}

async function noticeContext(db: Db, config: AppConfig): Promise<NoticeContext> {
  const { contact, ready } = await readW2Contact(db);
  return { ctx: await templateContext(db, config), contact, contactReady: ready };
}

/**
 * One recipient's year notice, in its own transaction under the employee
 * lock. PAY-206 (R2) + PAY-208 (26 CFR 31.6051-1(j)(5)): a recipient whose
 * electronic channel covers the year (electronicW2Channel: a consent on
 * terms that cover it, a login, status active) is furnished the current
 * figures (portal_notice) and gets the legal notice (IMPORTANT subject,
 * access and print). Anyone else gets the paper courtesy notice and nothing
 * is furnished (they cannot download). Review round D6: a consented
 * recipient whose latest portal_notice already carries the current figures
 * (a rerun after a partial failure) is skipped — no row, no mail; round 3
 * R2: so is a paper recipient whose year notice is already in the outbox.
 * Returns true when a mail was queued.
 */
async function sendOneW2AvailableNotice(
  db: Db,
  recipient: NoticeRecipient,
  year: number,
  notice: NoticeContext,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockEmployee(tx, recipient.employeeId);
    const consented = (await electronicW2Channel(tx, [recipient.employeeId], year)).has(
      recipient.employeeId,
    );
    if (consented) {
      const figures = readableBoxes(await employeeW2Figures(tx, recipient.employeeId, year));
      const { inserted } = await furnishCurrent(tx, {
        employeeId: recipient.employeeId,
        taxYear: year,
        figures,
        method: "portal_notice",
        actorId: null,
      });
      if (!inserted) return false;
    } else if (await yearNoticeQueued(tx, recipient.userId, year)) {
      // Round 3 R2: no furnishing row to dedupe on — the outbox marker is
      // the record that this recipient already got the year's notice.
      return false;
    }
    const rendered = tplW2Available(notice.ctx, {
      taxYear: year,
      consented,
      contact: notice.contact,
      canSwitchOnline: recipient.status === "active" && notice.contactReady,
    });
    await tx.insert(emailOutbox).values({
      userId: recipient.userId,
      eventType: EVENT_TYPE.w2Available,
      subject: rendered.subject,
      bodyHtml: `${rendered.html}${yearNoticeMarker(year)}`,
    });
    return true;
  });
}

/**
 * The year notice to every recipient. PAY-206 review round D5/D6: one
 * failing recipient is rolled back, logged by class and skipped; the caller
 * then leaves the year un-notified so the next tick retries it (recipients
 * already notified are skipped then).
 */
async function sendYearNotices(
  db: Db,
  year: number,
  notice: NoticeContext,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const recipient of await w2RecipientsForYear(db, year)) {
    try {
      if (await sendOneW2AvailableNotice(db, recipient, year, notice)) sent += 1;
    } catch (err) {
      failed += 1;
      console.error(`[filings] W-2 notices: one ${year} recipient failed (${errorClass(err)})`);
    }
  }
  return { sent, failed };
}

/**
 * PAY-208 (2.2a): an employee who agrees (or agrees again) after the year
 * notice went out is furnished then: for each notified year from the gate
 * year that is available, still inside its access window, with issued runs
 * for the employee and a ready W-2, the consented year notice runs now
 * (portal_notice + IMPORTANT mail; furnishCurrent dedupes, so a year
 * already furnished online mails nothing). A failure is logged by error
 * class only and the agreement stands (no scheduler retry yet, brief O3).
 */
export async function furnishAfterConsent(
  deps: Deps,
  employeeId: number,
  today: string = todayIso(),
): Promise<{ sent: number; failed: number }> {
  const { db, config } = deps;
  let sent = 0;
  let failed = 0;
  const years = (await notifiedYears(db)).filter(
    (y) =>
      y >= W2_CONSENT_GATE_FROM_TAX_YEAR &&
      isW2Available(y, today) &&
      today <= electronicW2AccessThrough(y),
  );
  if (years.length === 0) return { sent, failed };
  const notice = await noticeContext(db, config);
  for (const year of years) {
    try {
      const recipient = (await w2RecipientsForYear(db, year, employeeId))[0];
      if (!recipient || (await myW2FormCount(db, employeeId, year)) === null) continue;
      if (await sendOneW2AvailableNotice(db, recipient, year, notice)) sent += 1;
    } catch (err) {
      failed += 1;
      console.error(`[filings] W-2 late consent: one ${year} notice failed (${errorClass(err)})`);
    }
  }
  return { sent, failed };
}

/** PAY-162: every W-2 of the year computes and none is blocked. */
async function w2sIssuable(db: Db, year: number): Promise<boolean> {
  // PAY-162: no notice while the year's official W-2 form is not bundled —
  // the employee could not download it.
  if (!hasTemplate(year, "fw2")) return false;
  try {
    return (await yearW2BlockCodes(db, year)).length === 0;
  } catch (err) {
    if (err instanceof MissingTaxConfigError) return false;
    throw err;
  }
}

/**
 * PAY-162: the block codes standing on any W-2 of the year (empty when every
 * W-2 is issuable). Unreadable config figures count as internal_mismatch.
 * Spec 24: a year-level reconciliation_mismatch adds that code (it holds the
 * W-3 and the notice, S24-D11). MissingTaxConfigError propagates — callers
 * report it on its own.
 */
export async function yearW2BlockCodes(
  db: Pick<Db, "select">,
  year: number,
): Promise<W2IssueCode[]> {
  try {
    const { figures, yearIssues } = await w2FiguresWithYearIssues(db, year);
    const codes = blockCodes(figures);
    if (yearIssues.length > 0) codes.push("reconciliation_mismatch");
    return codes;
  } catch (err) {
    if (err instanceof AnnualFiguresDefectError) return ["internal_mismatch"];
    throw err;
  }
}

/**
 * PAY-162 (D2): the employee's W-2 for the year can be downloaded — it
 * computes, is not blocked, and the year's official form is bundled. A bare
 * boolean: no reason codes reach the employee.
 */
export async function isMyW2Ready(db: Db, employeeId: number, year: number): Promise<boolean> {
  return (await myW2FormCount(db, employeeId, year)) !== null;
}

/**
 * Spec 24 (PAY-116) PR-4 (S3): the number of W-2 forms of a ready W-2 (the
 * isMyW2Ready test), else null. A count only — a W-2 that is not ready never
 * reveals one (no states, no reasons).
 */
export async function myW2FormCount(
  db: Db,
  employeeId: number,
  year: number,
): Promise<number | null> {
  if (!hasTemplate(year, "fw2")) return null;
  try {
    const figures = await employeeW2Figures(db, employeeId, year);
    return figures.box1Cents !== null && !isW2Blocked(figures) ? figures.formCount : null;
  } catch (err) {
    if (
      err instanceof MissingTaxConfigError ||
      err instanceof AnnualFiguresDefectError ||
      (err instanceof FilingServiceError && err.code === "not_found")
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Mail every W-2 employee when their W-2 for a tax year becomes available
 * (January of the following year). Fires at most once per year per employee:
 * notified years persist in app_settings. Content rules hold — the email
 * states the tax year and "log in to download", never amounts or SSN.
 * PAY-206: each consented recipient's notice records a portal_notice
 * furnishing in the same transaction (sendOneW2AvailableNotice). PAY-208:
 * the consented notice carries the (j)(5)(i) IMPORTANT subject; everyone
 * else gets the paper courtesy notice. Always on (not a workflow toggle).
 */
export async function sendW2AvailableNotices(
  deps: Deps,
  opts: { today?: string } = {},
): Promise<{ sent: number }> {
  const { db, config } = deps;
  const today = opts.today ?? todayIso();
  const notified = await notifiedYears(db);

  const years = await db
    .selectDistinct({ year: sql<number>`extract(year from ${payrollRuns.payDate})::int` })
    .from(payrollRuns)
    .where(eq(payrollRuns.status, "issued"));

  const notice = await noticeContext(db, config);

  let sent = 0;
  for (const { year } of years) {
    if (!isW2Available(year, today) || notified.includes(year)) continue;
    // PAY-162: hold the year's notice while any of its W-2s is blocked (or
    // its figures cannot be computed); a later tick sends once resolved.
    if (!(await w2sIssuable(db, year))) continue;
    const out = await sendYearNotices(db, year, notice);
    sent += out.sent;
    if (out.failed > 0) continue;
    notified.push(year);
    await db
      .insert(appSettings)
      .values({ key: W2_NOTIFIED_YEARS_KEY, value: notified, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [appSettings.key],
        set: { value: notified, updatedAt: new Date() },
      });
  }
  return { sent };
}

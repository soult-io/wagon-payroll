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

import { and, eq, sql } from "drizzle-orm";
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
  W2FormAmountError,
  type W2Input,
  type W3Input,
} from "@payroll/documents";
import { EVENT_TYPE, w2Available as tplW2Available } from "@payroll/notifications";
import { formatCents } from "@payroll/shared";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { templateContext } from "../notify/outbox.js";
import { w2EmployeeAddressAt } from "../change-requests/address-history.js";
import { decryptField } from "../crypto/field-encryption.js";
import {
  type Deps,
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
  if (err instanceof AnnualFiguresDefectError || err instanceof W2FormAmountError) {
    return { error: "w2_not_ready", issues: ["internal_mismatch"] };
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
} & (W2BoxesCents | W2BoxesWithheld);

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

/**
 * Annual W-2 figures per W-2 employee from frozen issued-run entries.
 * Contractors never appear (employment_type = 'w2' only). Box 3 applies the
 * pay year's Social Security wage base from tax_config; a year with issued
 * runs and no federal tax_config row throws MissingTaxConfigError (PAY-162).
 */
export async function w2FiguresForYear(db: Pick<Db, "select">, year: number): Promise<W2Figures[]> {
  const byEmployee = await perEmployeeSums(db, year);
  const employeeIds = [...byEmployee.keys()];
  if (employeeIds.length === 0) return [];
  const params = await ficaParams(db, year);
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
      ...figuresFor(sums, params),
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

export interface WorksheetW3 {
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
function readableFigures(figures: readonly W2Figures[]): (W2Figures & W2BoxesCents)[] {
  const withheld = figures.filter((f) => f.box1Cents === null);
  if (withheld.length > 0) throw new W2BlockedError(blockCodes(withheld));
  return figures as (W2Figures & W2BoxesCents)[];
}

/**
 * W-3 transmittal worksheet — the box-by-box aggregate across all W-2s,
 * exact integer sums (PAY-162; keys and value strings unchanged). Throws
 * W2BlockedError while any W-2 has internal_mismatch / negative_amount, so
 * the stored worksheet is not refreshed until the defect is gone.
 */
export async function computeW3Worksheet(db: Db, year: number): Promise<WorksheetW3> {
  const figures = readableFigures(await w2FiguresForYear(db, year));
  const totals = w3Totals(figures);
  return { form: "w2_w3", year, employeeCount: totals.employeeCount, ...w2BoxStrings(totals) };
}

// ---------------------------------------------------------------------------
// Refresh + sync (daily tick, alongside the quarterly 941 sync)
// ---------------------------------------------------------------------------

/**
 * Recompute and persist the worksheet for an UNFILED annual filing. Returns
 * true when the stored worksheet changed. Filed rows are frozen forever (the
 * caller checks status, same as the 941 path).
 */
export async function refreshAnnualWorksheet(db: Db, filing: TaxFilingRow): Promise<boolean> {
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
  await db
    .update(taxFilings)
    .set({ worksheet, worksheetHash: hash, updatedAt: new Date() })
    .where(eq(taxFilings.id, filing.id));
  return true;
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
async function upsertAnnualFiling(
  db: Db,
  formType: "940" | "w2_w3",
  year: number,
  opts: { status: "not_started" | "ready" },
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
        createdBy: "scheduler",
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

/** Company header for official IRS forms: legal name, decrypted EIN, address. */
export async function employerBlock(
  db: Db,
  config: AppConfig,
): Promise<{ legalName: string; ein: string | null; address: FormAddress | null }> {
  const rows = await db.select().from(company).limit(1);
  const row = rows[0];
  return {
    legalName: row?.legalName ?? "Unknown",
    ein: row?.ein ? decryptField(row.ein, config.encryptionKey) : null,
    address: asAddress(row?.address),
  };
}

/**
 * Assemble the full W-2 PDF input for one employee/year — figures from frozen
 * entries, PII decrypted at this point only. Throws invalid_transition before
 * the January availability gate; not_found when the employee has no W-2 for
 * the year (no issued runs, or a contractor).
 */
export async function w2InputFor(
  deps: Deps,
  employeeId: number,
  year: number,
  opts: { today?: string; requireBundledForm?: boolean } = {},
): Promise<W2Input> {
  const { db, config } = deps;
  if (!isW2Available(year, opts.today)) {
    throw new FilingServiceError(
      "invalid_transition",
      `W-2 for ${year} becomes available on ${w2AvailableOn(year)}`,
    );
  }
  const figures = (await w2FiguresForYear(db, year)).find((f) => f.employeeId === employeeId);
  if (!figures) {
    throw new FilingServiceError("not_found", `no W-2 for employee ${employeeId} in ${year}`);
  }
  // PAY-162: a blocked W-2 is never rendered.
  if (isW2Blocked(figures) || figures.box1Cents === null) {
    throw new W2BlockedError(blockCodes([figures]));
  }
  // PAY-162: PDF callers stop here when the year has no official form —
  // before any PII is read or decrypted.
  if (opts.requireBundledForm && !hasTemplate(year, "fw2")) throw new FormNotAvailableError(year);
  const rows = await db.select().from(employees).where(eq(employees.id, employeeId)).limit(1);
  const employee = rows[0];
  if (!employee) throw new FilingServiceError("not_found", `employee ${employeeId} not found`);

  // Box f (PAY-20): the mailing address effective Dec 31 of the tax year,
  // falling back to the residential address effective at the same date —
  // both resolved through the effective-dated change-request history.
  const boxFAddress = await w2EmployeeAddressAt(db, employeeId, year, config.encryptionKey);

  return {
    taxYear: year,
    employer: await employerBlock(db, config),
    employee: {
      legalName: employee.legalName,
      ssn: employee.taxId ? formatSsn(decryptField(employee.taxId, config.encryptionKey)) : null,
      address: asAddress(boxFAddress),
    },
    // Box d control number = the employee ID (D5).
    controlNumber: String(employee.id),
    ...w2BoxStrings(figures),
  };
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
  const figures = await w2FiguresForYear(db, year);
  if (figures.length === 0) {
    throw new FilingServiceError("not_found", `no W-2s for ${year}`);
  }
  // PAY-162: no W-3 while any W-2 of the year is blocked.
  const blocked = blockCodes(figures);
  if (blocked.length > 0) throw new W2BlockedError(blocked);
  if (opts.requireBundledForm && !hasTemplate(year, "fw3")) throw new FormNotAvailableError(year);
  const totals = w3Totals(readableFigures(figures));
  return {
    taxYear: year,
    employer: await employerBlock(db, config),
    employeeCount: totals.employeeCount,
    ...w2BoxStrings(totals),
  };
}

// ---------------------------------------------------------------------------
// Employee self-service queries
// ---------------------------------------------------------------------------

/**
 * W-2 years available to this user RIGHT NOW: their own issued runs, gated
 * to January of the following year, newest first.
 */
export async function listMyW2Years(
  db: Db,
  userId: string,
  today: string = todayIso(),
): Promise<number[]> {
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
  return rows
    .map((r) => r.year)
    .filter((year) => isW2Available(year, today))
    .sort((a, b) => b - a);
}

// ---------------------------------------------------------------------------
// W-2 availability notices (employee email, once per tax year)
// ---------------------------------------------------------------------------

const W2_NOTIFIED_YEARS_KEY = "w2_available_notified_years";

async function notifiedYears(db: Db): Promise<number[]> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, W2_NOTIFIED_YEARS_KEY))
    .limit(1);
  const value = rows[0]?.value;
  return Array.isArray(value) ? value.filter((n): n is number => Number.isInteger(n)) : [];
}

/** W-2 employees (with a user account) who have issued runs in the year. */
async function w2RecipientsForYear(db: Db, year: number): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: employees.userId })
    .from(payrollRuns)
    .innerJoin(employees, eq(payrollRuns.employeeId, employees.id))
    .where(
      and(
        eq(payrollRuns.status, "issued"),
        eq(employees.employmentType, "w2"),
        sql`${payrollRuns.payDate} >= ${`${year}-01-01`}`,
        sql`${payrollRuns.payDate} <= ${`${year}-12-31`}`,
        sql`${employees.userId} IS NOT NULL`,
      ),
    );
  return rows.map((r) => r.userId).filter((id): id is string => id !== null);
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
 * MissingTaxConfigError propagates — callers report it on its own.
 */
export async function yearW2BlockCodes(
  db: Pick<Db, "select">,
  year: number,
): Promise<W2IssueCode[]> {
  try {
    return blockCodes(await w2FiguresForYear(db, year));
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
  if (!hasTemplate(year, "fw2")) return false;
  try {
    const figures = (await w2FiguresForYear(db, year)).find((f) => f.employeeId === employeeId);
    return figures !== undefined && figures.box1Cents !== null && !isW2Blocked(figures);
  } catch (err) {
    if (err instanceof MissingTaxConfigError || err instanceof AnnualFiguresDefectError) {
      return false;
    }
    throw err;
  }
}

/**
 * Mail every W-2 employee when their W-2 for a tax year becomes available
 * (January of the following year). Fires at most once per year per employee:
 * notified years persist in app_settings. Content rules hold — the email
 * states the tax year and "log in to download", never amounts or SSN.
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

  const ctx = await templateContext(db, config);

  let sent = 0;
  for (const { year } of years) {
    if (!isW2Available(year, today) || notified.includes(year)) continue;
    // PAY-162: hold the year's notice while any of its W-2s is blocked (or
    // its figures cannot be computed); a later tick sends once resolved.
    if (!(await w2sIssuable(db, year))) continue;
    const rendered = tplW2Available(ctx, { taxYear: year });
    const marker = `w2-available:${year}`;
    for (const userId of await w2RecipientsForYear(db, year)) {
      await db.insert(emailOutbox).values({
        userId,
        eventType: EVENT_TYPE.w2Available,
        subject: rendered.subject,
        bodyHtml: `${rendered.html}<!-- ${marker} -->`,
      });
      sent += 1;
    }
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

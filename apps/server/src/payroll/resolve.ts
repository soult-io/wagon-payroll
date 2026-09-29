/**
 * Temporal config resolution (spec payroll-engine "Config resolution is
 * temporal"), computed inside the run transaction. Edits to salary/tax tables
 * never mutate existing runs. Which date each resolver takes is fixed by
 * Spec 26 (PAY-173) — see run-dates.ts: tables/YTD/W-4 gate by pay date,
 * certificates by min(period end, pay date), compensation/work state by
 * period start, residence by pay date.
 *
 * All functions accept a drizzle transaction or db handle (PgTransaction
 * compatible).
 */

import { and, asc, desc, eq, gt, gte, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  compensation,
  employeeResidences,
  employeeWorkStates,
  payrollEntries,
  payrollRuns,
  stateTaxBrackets,
  stateTaxConfigs,
  stateWithholdingElections,
  taxBrackets,
  taxConfig,
  w4Elections,
} from "@payroll/db";
import type { Db } from "../db.js";
import { YTD_KEY_MAX_ID, type YtdKey } from "./run-dates.js";
import type {
  SnapshotBracket,
  SnapshotState,
  SnapshotStateElection,
  SnapshotTaxConfig,
  SnapshotW4,
} from "./snapshot.js";

/** drizzle transaction or root db — both expose the query API we use. */
export type DbLike = Pick<Db, "select">;

export type CompensationRow = typeof compensation.$inferSelect;
export type W4Row = typeof w4Elections.$inferSelect;

/** Compensation row effective on `asOf` (effective_from <= asOf < effective_to|∞, matching the [) exclusion constraint). */
export async function resolveCompensation(
  db: DbLike,
  employeeId: number,
  asOf: string,
): Promise<CompensationRow | null> {
  const rows = await db
    .select()
    .from(compensation)
    .where(
      and(
        eq(compensation.employeeId, employeeId),
        lte(compensation.effectiveFrom, asOf),
        or(isNull(compensation.effectiveTo), gt(compensation.effectiveTo, asOf)),
      ),
    )
    .orderBy(desc(compensation.effectiveFrom))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * W-4 certificate for a payment (Spec 26 (PAY-173) D3):
 * 1. candidates: effective_from <= certificateAsOf (= min(period end, pay
 *    date); Treas. Reg. 31.3402(f)(3)-1) AND tax_year's Jan 1 <= payDate (a
 *    W-4 furnished for next year does not apply to payments this year; IRC
 *    3402(f)(2)(C));
 * 2. order: effective start GREATEST(effective_from, tax_year-01-01) DESC,
 *    filed_date DESC, id DESC — so a next-year form beats a mid-year change
 *    on a payment in the new year;
 * 3. exempt lapse, judged by the pay date: an exempt certificate stops
 *    exempting on LEAST(renewal_deadline, Feb 16 of tax_year + 1) — a Feb 15
 *    payment is still exempt (Treas. Reg. 31.3402(f)(4)-1(b)(1); Pub 15).
 */
export async function resolveW4(
  db: DbLike,
  employeeId: number,
  asOf: { certificateAsOf: string; payDate: string },
): Promise<W4Row | null> {
  const taxYearStart = sql`make_date(${w4Elections.taxYear}, 1, 1)`;
  const rows = await db
    .select()
    .from(w4Elections)
    .where(
      and(
        eq(w4Elections.employeeId, employeeId),
        lte(w4Elections.effectiveFrom, asOf.certificateAsOf),
        sql`${taxYearStart} <= ${asOf.payDate}::date`,
      ),
    )
    .orderBy(
      desc(sql`GREATEST(${w4Elections.effectiveFrom}, ${taxYearStart})`),
      desc(w4Elections.filedDate),
      desc(w4Elections.id),
    )
    .limit(1);
  const row = rows[0] ?? null;
  if (row?.federalExempt && exemptLapseDate(row) <= asOf.payDate) {
    return { ...row, federalExempt: false };
  }
  return row;
}

/** LEAST(COALESCE(renewal_deadline, +∞), Feb 16 of tax_year + 1) — the first pay date that is no longer exempt. */
export function exemptLapseDate(row: Pick<W4Row, "renewalDeadline" | "taxYear">): string {
  const statutory = `${row.taxYear + 1}-02-16`;
  return row.renewalDeadline && row.renewalDeadline < statutory ? row.renewalDeadline : statutory;
}

/**
 * Tax config + brackets for a year and filing status. Bracket sets are per
 * filing status via jurisdiction = 'federal:<status>' (spec payroll-engine
 * §3), falling back to the base 'federal' jurisdiction; scalar config falls
 * back the same way.
 */
export async function resolveTaxConfig(
  db: DbLike,
  taxYear: number,
  filingStatus: string,
): Promise<{ config: SnapshotTaxConfig; brackets: SnapshotBracket[] } | null> {
  const jurisdictions = [`federal:${filingStatus}`, "federal"];

  let configRow: typeof taxConfig.$inferSelect | undefined;
  for (const j of jurisdictions) {
    const rows = await db
      .select()
      .from(taxConfig)
      .where(and(eq(taxConfig.jurisdiction, j), eq(taxConfig.taxYear, taxYear)))
      .limit(1);
    if (rows[0]) {
      configRow = rows[0];
      break;
    }
  }
  if (!configRow) return null;

  let bracketRows: (typeof taxBrackets.$inferSelect)[] = [];
  for (const j of jurisdictions) {
    bracketRows = await db
      .select()
      .from(taxBrackets)
      .where(and(eq(taxBrackets.jurisdiction, j), eq(taxBrackets.taxYear, taxYear)))
      .orderBy(taxBrackets.ordinal);
    if (bracketRows.length > 0) break;
  }
  if (bracketRows.length === 0) return null;

  return {
    config: {
      jurisdiction: configRow.jurisdiction,
      taxYear: configRow.taxYear,
      standardDeduction: Number(configRow.standardDeduction),
      socialSecurityRate: Number(configRow.socialSecurityRate),
      socialSecurityWageCap: Number(configRow.socialSecurityWageCap),
      medicareRate: Number(configRow.medicareRate),
      medicareAdditionalRate: Number(configRow.medicareAdditionalRate),
      medicareAdditionalThreshold: Number(configRow.medicareAdditionalThreshold),
      stateWithholdingRate: Number(configRow.stateWithholdingRate),
      employerSocialSecurityRate: Number(configRow.employerSocialSecurityRate),
      employerMedicareRate: Number(configRow.employerMedicareRate),
      futaRate: Number(configRow.futaRate),
      futaWageCap: Number(configRow.futaWageCap),
      sutaCreditRate: Number(configRow.sutaCreditRate),
    },
    brackets: bracketRows.map((b) => ({
      min: Number(b.minAmount),
      max: b.maxAmount === null ? null : Number(b.maxAmount),
      rate: Number(b.rate),
    })),
  };
}

/**
 * Issued runs of the employee paid in the calendar year of `key.payDate` whose
 * D2 key (pay_date, period_start, id) sorts strictly before / after `key`
 * (row comparison mirrors compareYtdKey; null selfRunId = id +∞).
 */
function issuedSameYearRuns(employeeId: number, key: YtdKey, side: "before" | "after") {
  const year = Number(key.payDate.slice(0, 4));
  const op = sql.raw(side === "before" ? "<" : ">");
  return and(
    eq(payrollRuns.employeeId, employeeId),
    eq(payrollRuns.status, "issued"),
    gte(payrollRuns.payDate, `${year}-01-01`),
    lt(payrollRuns.payDate, `${year + 1}-01-01`),
    key.selfRunId === null ? undefined : ne(payrollRuns.id, key.selfRunId),
    sql`(${payrollRuns.payDate}, ${payrollRuns.periodStart}, ${payrollRuns.id}) ${op} (${key.payDate}::date, ${key.periodStart}::date, ${key.selfRunId ?? YTD_KEY_MAX_ID}::integer)`,
  );
}

/** D2 order: (pay_date, period_start, id) ascending. */
const YTD_KEY_ORDER = [asc(payrollRuns.payDate), asc(payrollRuns.periodStart), asc(payrollRuns.id)];

/**
 * Prior YTD of a run (Spec 26 (PAY-173) D2): sums of payroll_entries of the
 * employee's ISSUED runs paid in the calendar year of `key.payDate` whose
 * (pay_date, period_start, id) sorts strictly before the run's key — wages
 * PAID before this payment (IRC 3121(a)(1), 3102(f), 3306(b)(1)). A new draft
 * (selfRunId null) keys as id +∞; a recomputed run passes its id and is
 * excluded. Void runs never count. Amounts in engine units (dollars).
 */
export async function resolvePriorYtd(
  db: DbLike,
  employeeId: number,
  key: YtdKey,
): Promise<{ year: number; byCategory: Map<string, number>; runPublicIds: string[] }> {
  const year = Number(key.payDate.slice(0, 4));
  const where = issuedSameYearRuns(employeeId, key, "before");
  const runs = await db
    .select({ publicId: payrollRuns.publicId })
    .from(payrollRuns)
    .where(where)
    .orderBy(...YTD_KEY_ORDER);
  const sums = await db
    .select({
      category: payrollEntries.category,
      total: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .where(where)
    .groupBy(payrollEntries.category);
  return {
    year,
    byCategory: new Map(sums.map((r) => [r.category, Number(r.total)])),
    runPublicIds: runs.map((r) => r.publicId),
  };
}

/**
 * D6 (Spec 26): the first issued run of the employee, paid in the same
 * calendar year, whose D2 key sorts AFTER `key` — issuing `key` now would
 * leave that run's frozen YTD missing this payment. null = no conflict.
 */
export async function findLaterIssuedRun(
  db: DbLike,
  employeeId: number,
  key: YtdKey,
): Promise<{ publicId: string; payDate: string } | null> {
  const rows = await db
    .select({ publicId: payrollRuns.publicId, payDate: payrollRuns.payDate })
    .from(payrollRuns)
    .where(issuedSameYearRuns(employeeId, key, "after"))
    .orderBy(...YTD_KEY_ORDER)
    .limit(1);
  return rows[0] ?? null;
}

export function toSnapshotW4(row: W4Row): SnapshotW4 {
  return {
    filingStatus: row.filingStatus as SnapshotW4["filingStatus"],
    federalExempt: row.federalExempt,
    multipleJobs: row.multipleJobs,
    dependentsAmount: Number(row.dependentsAmount),
    otherIncome: Number(row.otherIncome),
    deductionsAmount: Number(row.deductionsAmount),
    extraWithholding: Number(row.extraWithholding),
    effectiveFrom: row.effectiveFrom,
    filedDate: row.filedDate,
  };
}

// ---------------------------------------------------------------------------
// PAY-13 phase 1 — per-state withholding resolution
// ---------------------------------------------------------------------------

export type WorkStateRow = typeof employeeWorkStates.$inferSelect;
export type StateElectionRow = typeof stateWithholdingElections.$inferSelect;

/**
 * Work state effective on `asOf`: latest row with effective_from <= asOf whose
 * window is still open (effective_to NULL or > asOf). V1 = single work state;
 * overlapping windows resolve to the most recent effective_from.
 */
export async function resolveWorkState(
  db: DbLike,
  employeeId: number,
  asOf: string,
): Promise<WorkStateRow | null> {
  const rows = await db
    .select()
    .from(employeeWorkStates)
    .where(
      and(
        eq(employeeWorkStates.employeeId, employeeId),
        lte(employeeWorkStates.effectiveFrom, asOf),
        or(isNull(employeeWorkStates.effectiveTo), gt(employeeWorkStates.effectiveTo, asOf)),
      ),
    )
    .orderBy(desc(employeeWorkStates.effectiveFrom))
    .limit(1);
  return rows[0] ?? null;
}

export type ResidenceRow = typeof employeeResidences.$inferSelect;

/**
 * Residence effective on `asOf` (Spec 25 (PAY-120): residence resolves on the
 * PAY date): the row with effective_from <= asOf < effective_to|∞. The
 * exclusion constraint guarantees at most one.
 */
export async function resolveResidence(
  db: DbLike,
  employeeId: number,
  asOf: string,
): Promise<ResidenceRow | null> {
  const rows = await db
    .select()
    .from(employeeResidences)
    .where(
      and(
        eq(employeeResidences.employeeId, employeeId),
        lte(employeeResidences.effectiveFrom, asOf),
        or(isNull(employeeResidences.effectiveTo), gt(employeeResidences.effectiveTo, asOf)),
      ),
    )
    .orderBy(desc(employeeResidences.effectiveFrom))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * State election for (employee, stateCode) as of `certificateAsOf` = min(period
 * end, pay date) (Spec 26 (PAY-173) D3a; NC G.S. 105-163.5(c), 86 Ill. Adm.
 * Code 100.7110, 22 CCR 4340-1): the latest row with effective_from <=
 * certificateAsOf. State exempt elections have no renewal deadline in V1
 * (PAY-189).
 */
export async function resolveStateElection(
  db: DbLike,
  employeeId: number,
  stateCode: string,
  certificateAsOf: string,
): Promise<StateElectionRow | null> {
  const rows = await db
    .select()
    .from(stateWithholdingElections)
    .where(
      and(
        eq(stateWithholdingElections.employeeId, employeeId),
        eq(stateWithholdingElections.stateCode, stateCode),
        lte(stateWithholdingElections.effectiveFrom, certificateAsOf),
      ),
    )
    .orderBy(desc(stateWithholdingElections.effectiveFrom))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * State filing-status mapping: states that don't publish a married-separate
 * table use the single table (same convention as the federal Pub 15-T
 * percentage method). married_joint / head_of_household map to themselves.
 */
export function mapStateFilingStatus(
  filingStatus: SnapshotW4["filingStatus"],
): "single" | "married_joint" | "head_of_household" {
  return filingStatus === "married_separate" ? "single" : filingStatus;
}

export type StateConfigRow = typeof stateTaxConfigs.$inferSelect;
export type StateBracketRow = typeof stateTaxBrackets.$inferSelect;

/**
 * State tax config + brackets for a year and (already mapped) filing status.
 * Jurisdiction fallback '<state>:<status>' → '<state>' mirrors the federal
 * 'federal:<status>' → 'federal' pattern. Returns null when the state has no
 * config row for the year at either jurisdiction — the caller decides whether
 * that is an error (it is, once a work state is set: kind='none' is the
 * explicit zero-tax row, absence means "not configured").
 */
export async function resolveStateTaxConfig(
  db: DbLike,
  stateCode: string,
  taxYear: number,
  mappedStatus: "single" | "married_joint" | "head_of_household",
): Promise<{ config: StateConfigRow; brackets: StateBracketRow[] } | null> {
  const jurisdictions = [`${stateCode}:${mappedStatus}`, stateCode];

  let configRow: StateConfigRow | undefined;
  for (const j of jurisdictions) {
    const rows = await db
      .select()
      .from(stateTaxConfigs)
      .where(and(eq(stateTaxConfigs.jurisdiction, j), eq(stateTaxConfigs.taxYear, taxYear)))
      .limit(1);
    if (rows[0]) {
      configRow = rows[0];
      break;
    }
  }
  if (!configRow) return null;

  // Brackets follow the same fallback but are required only for 'progressive'.
  let bracketRows: StateBracketRow[] = [];
  for (const j of jurisdictions) {
    bracketRows = await db
      .select()
      .from(stateTaxBrackets)
      .where(and(eq(stateTaxBrackets.jurisdiction, j), eq(stateTaxBrackets.taxYear, taxYear)))
      .orderBy(stateTaxBrackets.ordinal);
    if (bracketRows.length > 0) break;
  }
  if (configRow.kind === "progressive" && bracketRows.length === 0) return null;

  return { config: configRow, brackets: bracketRows };
}

/** Freeze a resolved state election for the snapshot. */
export function toSnapshotStateElection(row: StateElectionRow): SnapshotStateElection {
  return {
    filingStatus: row.filingStatus as SnapshotStateElection["filingStatus"],
    allowances: row.allowances,
    additionalAllowances: row.additionalAllowances,
    extraWithholding: Number(row.extraWithholding),
    exempt: row.exempt,
    effectiveFrom: row.effectiveFrom,
    filedDate: row.filedDate,
  };
}

/**
 * Freeze the resolved state input for the snapshot (template 1.2.0). The
 * bracket set is the one actually applied (status-specific when present).
 */
export function toSnapshotState(input: {
  stateCode: string;
  jurisdiction: string;
  taxYear: number;
  config: StateConfigRow;
  brackets: StateBracketRow[];
  election: StateElectionRow | null;
}): SnapshotState {
  const num = (v: string | null): number | null => (v === null ? null : Number(v));
  return {
    workState: input.stateCode,
    jurisdiction: input.jurisdiction,
    taxYear: input.taxYear,
    kind: input.config.kind as SnapshotState["kind"],
    flatRate: num(input.config.flatRate),
    standardDeduction: num(input.config.standardDeduction),
    standardDeductionAlt: num(input.config.standardDeductionAlt),
    altMinAllowances: input.config.altMinAllowances,
    lowIncomeExemption: num(input.config.lowIncomeExemption),
    lowIncomeExemptionAlt: num(input.config.lowIncomeExemptionAlt),
    allowanceDeduction: num(input.config.allowanceDeduction),
    allowanceCredit: num(input.config.allowanceCredit),
    additionalAllowanceDeduction: num(input.config.additionalAllowanceDeduction),
    election: input.election ? toSnapshotStateElection(input.election) : null,
    brackets: input.brackets.map((b) => ({
      min: Number(b.minAmount),
      max: b.maxAmount === null ? null : Number(b.maxAmount),
      rate: Number(b.rate),
    })),
  };
}

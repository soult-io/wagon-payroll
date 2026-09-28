/**
 * Temporal config resolution (spec payroll-engine "Config resolution is
 * temporal"): every lookup is "row effective on the period", computed inside
 * the run transaction. Edits to salary/tax tables never mutate existing runs.
 *
 * All functions accept a drizzle transaction or db handle (PgTransaction
 * compatible).
 */

import { and, desc, eq, gt, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
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
 * W-4 election effective on `periodStart` (latest filed row with
 * effective_from <= period_start). An exempt election whose renewal_deadline
 * has passed no longer exempts (IRC §3402(n)).
 */
export async function resolveW4(
  db: DbLike,
  employeeId: number,
  periodStart: string,
): Promise<W4Row | null> {
  const rows = await db
    .select()
    .from(w4Elections)
    .where(and(eq(w4Elections.employeeId, employeeId), lte(w4Elections.effectiveFrom, periodStart)))
    .orderBy(desc(w4Elections.effectiveFrom))
    .limit(1);
  const row = rows[0] ?? null;
  if (row?.federalExempt && row.renewalDeadline && row.renewalDeadline <= periodStart) {
    return { ...row, federalExempt: false };
  }
  return row;
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
 * Prior-YTD gross: SUM of gross_pay payroll_entries from ISSUED runs in the
 * same calendar year before period_start (spec: never wage × period count).
 */
export async function resolvePriorYtdGross(
  db: DbLike,
  employeeId: number,
  periodStart: string,
): Promise<number> {
  const year = periodStart.slice(0, 4);
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)` })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .where(
      and(
        eq(payrollRuns.employeeId, employeeId),
        eq(payrollRuns.status, "issued"),
        eq(payrollEntries.category, "gross_pay"),
        gte(payrollRuns.periodStart, `${year}-01-01`),
        lt(payrollRuns.periodStart, periodStart),
      ),
    );
  return Number(rows[0]?.total ?? 0);
}

/**
 * Prior-YTD sums per entry category (issued runs, same calendar year, before
 * period_start) — the basis for the snapshot's frozen YTD block (template
 * 1.1.0). Keys are payroll_entries categories.
 */
export async function resolvePriorYtdByCategory(
  db: DbLike,
  employeeId: number,
  periodStart: string,
): Promise<Map<string, number>> {
  const year = periodStart.slice(0, 4);
  const rows = await db
    .select({
      category: payrollEntries.category,
      total: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .where(
      and(
        eq(payrollRuns.employeeId, employeeId),
        eq(payrollRuns.status, "issued"),
        gte(payrollRuns.periodStart, `${year}-01-01`),
        lt(payrollRuns.periodStart, periodStart),
      ),
    )
    .groupBy(payrollEntries.category);
  return new Map(rows.map((r) => [r.category, Number(r.total)]));
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
 * State election for (employee, stateCode) effective on `periodStart` — the
 * latest row with effective_from <= period_start, mirroring resolveW4. State
 * exempt elections have no renewal deadline in V1 (IL-W-4/DE 4 exempt claims
 * are the employee's annual responsibility, not an enforced lapse).
 */
export async function resolveStateElection(
  db: DbLike,
  employeeId: number,
  stateCode: string,
  periodStart: string,
): Promise<StateElectionRow | null> {
  const rows = await db
    .select()
    .from(stateWithholdingElections)
    .where(
      and(
        eq(stateWithholdingElections.employeeId, employeeId),
        eq(stateWithholdingElections.stateCode, stateCode),
        lte(stateWithholdingElections.effectiveFrom, periodStart),
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

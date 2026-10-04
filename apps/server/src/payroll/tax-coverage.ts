/**
 * Tax-table coverage for a pay year (PAY-81, year-rollover guard §4.1).
 *
 * The ONE definition of "the installed tax tables cover year Y". The QA seed
 * uses it to anchor its history window; the missing-tables alert and the
 * admin coverage endpoint must import it too, never re-derive it.
 *
 * covered(Y) = a federal `tax_config` row for Y exists AND a
 * `state_tax_configs` row for Y exists for every work state (effective in Y)
 * of every active W-2 employee whose compensation overlaps Y. An employee
 * with no work state adds nothing (federal only, as computeRun treats them).
 * Local tables are deliberately ignored until the run path requires them.
 *
 * Pure inputs: no clock. Output holds years and USPS codes only (no PII).
 */

import { and, asc, desc, eq, exists, gt, isNull, lt, lte, notExists, or, sql } from "drizzle-orm";
import {
  compensation,
  employees,
  employeeWorkStates,
  stateTaxConfigs,
  taxConfig,
} from "@payroll/db";
import type { Db } from "../db.js";

export interface TaxTableCoverage {
  year: number;
  /** A federal tax_config row exists for the year. */
  federal: boolean;
  /** Sorted USPS codes of work states that need a state table for the year and have none. */
  missingStates: string[];
}

export function isCovered(c: TaxTableCoverage): boolean {
  return c.federal && c.missingStates.length === 0;
}

export async function taxTableCoverage(db: Db, year: number): Promise<TaxTableCoverage> {
  const start = `${year}-01-01`;
  const next = `${year + 1}-01-01`;

  const fed = await db
    .select({ id: taxConfig.id })
    .from(taxConfig)
    .where(and(eq(taxConfig.jurisdiction, "federal"), eq(taxConfig.taxYear, year)))
    .limit(1);

  // Ranges are [effective_from, effective_to) with NULL = open-ended.
  const paidInYear = db
    .select({ one: sql`1` })
    .from(compensation)
    .where(
      and(
        eq(compensation.employeeId, employees.id),
        lt(compensation.effectiveFrom, next),
        or(isNull(compensation.effectiveTo), gt(compensation.effectiveTo, start)),
      ),
    );
  const stateTable = db
    .select({ one: sql`1` })
    .from(stateTaxConfigs)
    .where(
      and(
        eq(stateTaxConfigs.jurisdiction, employeeWorkStates.stateCode),
        eq(stateTaxConfigs.taxYear, year),
      ),
    );
  const missing = await db
    .selectDistinct({ code: employeeWorkStates.stateCode })
    .from(employeeWorkStates)
    .innerJoin(employees, eq(employees.id, employeeWorkStates.employeeId))
    .where(
      and(
        eq(employees.status, "active"),
        eq(employees.employmentType, "w2"),
        lt(employeeWorkStates.effectiveFrom, next),
        or(isNull(employeeWorkStates.effectiveTo), gt(employeeWorkStates.effectiveTo, start)),
        exists(paidInYear),
        notExists(stateTable),
      ),
    )
    .orderBy(asc(employeeWorkStates.stateCode));

  return { year, federal: fed.length > 0, missingStates: missing.map((r) => r.code) };
}

/**
 * The highest federal tax_config year <= `onOrBefore` whose coverage is
 * complete; null when there is none.
 */
export async function latestCoveredYear(db: Db, onOrBefore: number): Promise<number | null> {
  const years = await db
    .selectDistinct({ year: taxConfig.taxYear })
    .from(taxConfig)
    .where(and(eq(taxConfig.jurisdiction, "federal"), lte(taxConfig.taxYear, onOrBefore)))
    .orderBy(desc(taxConfig.taxYear));
  for (const { year } of years) {
    if (isCovered(await taxTableCoverage(db, year))) return year;
  }
  return null;
}

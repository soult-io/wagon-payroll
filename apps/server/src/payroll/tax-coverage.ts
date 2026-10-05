/**
 * Tax-table coverage for a pay year (PAY-81, year-rollover guard §4.1).
 *
 * The ONE definition of "the installed tax tables cover year Y". The QA seed
 * uses it to anchor its history window; the missing-tables alert and the
 * admin coverage endpoint must import it too, never re-derive it.
 *
 * covered(Y) = a federal `tax_config` row for Y exists AND, for every active
 * W-2 employee paid in Y and working in a state in Y, the run's own state
 * lookup (resolveStateTaxConfig: "<state>:<status>", then "<state>"; a
 * progressive config without brackets is not found) finds a table for every
 * filing status that employee has in Y. The status is resolved the way a run
 * resolves it (state election, else the W-4, else "single" as computeRun does
 * with no W-4; mapStateFilingStatus), at the start of the employee's paid time
 * in that state in Y and at every W-4 or state-election change inside it, so
 * a mid-year status change needs both tables. An employee with no work state
 * adds nothing (federal only, as computeRun treats them). Local tables are
 * deliberately ignored until the run path requires them.
 *
 * Pure inputs: no clock. Output holds years and USPS codes only (no PII).
 * Accepts the root db or a transaction.
 */

import { and, eq, gt, isNull, lt, lte, or } from "drizzle-orm";
import {
  compensation,
  employees,
  employeeWorkStates,
  stateWithholdingElections,
  taxConfig,
  w4Elections,
} from "@payroll/db";
import {
  mapStateFilingStatus,
  resolveStateElection,
  resolveStateTaxConfig,
  resolveW4,
  type DbLike,
} from "./resolve.js";

export interface TaxTableCoverage {
  year: number;
  /** A federal tax_config row exists for the year. */
  federal: boolean;
  /** Sorted USPS codes of work states whose table the run lookup cannot find for the year. */
  missingStates: string[];
}

export function isCovered(c: TaxTableCoverage): boolean {
  return c.federal && c.missingStates.length === 0;
}

type FilingStatus = Parameters<typeof mapStateFilingStatus>[0];
type MappedStatus = ReturnType<typeof mapStateFilingStatus>;

const maxIso = (a: string, b: string) => (a > b ? a : b);
const minIso = (a: string, b: string) => (a < b ? a : b);

/**
 * Mapped state filing statuses an employee has while working in `stateCode`
 * on [from, to) of `year`: resolved at `from` and at every W-4 /
 * state-election effective date inside the window.
 */
async function statusesInWindow(
  db: DbLike,
  employeeId: number,
  stateCode: string,
  year: number,
  from: string,
  to: string,
): Promise<Set<MappedStatus>> {
  const w4Changes = await db
    .select({ at: w4Elections.effectiveFrom })
    .from(w4Elections)
    .where(
      and(
        eq(w4Elections.employeeId, employeeId),
        lte(w4Elections.taxYear, year),
        gt(w4Elections.effectiveFrom, from),
        lt(w4Elections.effectiveFrom, to),
      ),
    );
  const electionChanges = await db
    .select({ at: stateWithholdingElections.effectiveFrom })
    .from(stateWithholdingElections)
    .where(
      and(
        eq(stateWithholdingElections.employeeId, employeeId),
        eq(stateWithholdingElections.stateCode, stateCode),
        gt(stateWithholdingElections.effectiveFrom, from),
        lt(stateWithholdingElections.effectiveFrom, to),
      ),
    );
  const points = new Set<string>([from]);
  for (const r of [...w4Changes, ...electionChanges]) points.add(r.at);

  const statuses = new Set<MappedStatus>();
  for (const at of points) {
    const w4 = await resolveW4(db, employeeId, { certificateAsOf: at, payDate: at });
    const election = await resolveStateElection(db, employeeId, stateCode, at);
    // Same precedence as the run: the state election's status, else the
    // W-4's, else "single" (computeRun's default with no W-4).
    const status = (election?.filingStatus ?? w4?.filingStatus ?? "single") as FilingStatus;
    statuses.add(mapStateFilingStatus(status));
  }
  return statuses;
}

export async function taxTableCoverage(db: DbLike, year: number): Promise<TaxTableCoverage> {
  const start = `${year}-01-01`;
  const next = `${year + 1}-01-01`;

  const fed = await db
    .select({ id: taxConfig.id })
    .from(taxConfig)
    .where(and(eq(taxConfig.jurisdiction, "federal"), eq(taxConfig.taxYear, year)))
    .limit(1);

  // Work-state rows overlapping Y of active W-2 employees. Ranges are
  // [effective_from, effective_to) with NULL = open-ended.
  const workRows = await db
    .select({
      employeeId: employeeWorkStates.employeeId,
      stateCode: employeeWorkStates.stateCode,
      from: employeeWorkStates.effectiveFrom,
      to: employeeWorkStates.effectiveTo,
    })
    .from(employeeWorkStates)
    .innerJoin(employees, eq(employees.id, employeeWorkStates.employeeId))
    .where(
      and(
        eq(employees.status, "active"),
        eq(employees.employmentType, "w2"),
        lt(employeeWorkStates.effectiveFrom, next),
        or(isNull(employeeWorkStates.effectiveTo), gt(employeeWorkStates.effectiveTo, start)),
      ),
    );

  const missing = new Set<string>();
  for (const w of workRows) {
    if (missing.has(w.stateCode)) continue;
    const windowFrom = maxIso(start, w.from);
    const windowTo = minIso(next, w.to ?? next);
    // Paid while working there in Y: a compensation row overlapping the window.
    const paid = await db
      .select({ from: compensation.effectiveFrom })
      .from(compensation)
      .where(
        and(
          eq(compensation.employeeId, w.employeeId),
          lt(compensation.effectiveFrom, windowTo),
          or(isNull(compensation.effectiveTo), gt(compensation.effectiveTo, windowFrom)),
        ),
      );
    if (paid.length === 0) continue;
    const from = maxIso(windowFrom, paid.map((p) => p.from).reduce(minIso));
    const statuses = await statusesInWindow(db, w.employeeId, w.stateCode, year, from, windowTo);
    for (const status of statuses) {
      if (!(await resolveStateTaxConfig(db, w.stateCode, year, status))) {
        missing.add(w.stateCode);
        break;
      }
    }
  }

  return { year, federal: fed.length > 0, missingStates: [...missing].sort() };
}

/**
 * The highest federal tax_config year <= `onOrBefore` whose coverage is
 * complete; null when there is none.
 */
export async function latestCoveredYear(db: DbLike, onOrBefore: number): Promise<number | null> {
  const rows = await db
    .select({ year: taxConfig.taxYear })
    .from(taxConfig)
    .where(and(eq(taxConfig.jurisdiction, "federal"), lte(taxConfig.taxYear, onOrBefore)));
  const years = [...new Set(rows.map((r) => r.year))].sort((a, b) => b - a);
  for (const year of years) {
    if (isCovered(await taxTableCoverage(db, year))) return year;
  }
  return null;
}

/**
 * PAY-193 L2 (spec D9.8): the year-end warning window.
 *
 * For tax year Y the window runs from Dec 1 of Y to `closesOn` = the earliest
 * of the federal Q4 941 due date, the W-2/W-3 due date and, for every state
 * an employee works in during Y, that state's Q4 close date. With no entry
 * for the state the fallback is Jan 31 of Y+1 when the table covers Y, and
 * Jan 15 of Y+1 (the earliest TY2026 date) when the table has no entries for
 * Y at all; no weekend roll either way. Dec 1–31 is "december";
 * Jan 1 of Y+1 through closesOn (inclusive) is "after_year_end".
 *
 * The date math is pure (`yearEndCloseDate`, `yearEndCandidate`, `yearEndWindowOpen`); the two DB
 * reads (`yearEndStates`, `yearEndOpenRuns`) are separate. No names, no
 * amounts leave this module.
 */

import { and, gt, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { employeeWorkStates, payrollRuns } from "@payroll/db";
import type { Db } from "../db.js";
import { annualDueDate } from "../filings/annual.js";
import { filingDueDate } from "../filings/service.js";
import { hasStateTableForYear, stateQ4CloseDate } from "../filings/state-q4-due.js";

export type YearEndPhase = "december" | "after_year_end";

export interface YearEndOpenRun {
  publicId: string;
  payDate: string;
  status: string;
}

export interface YearEndStatus {
  today: string;
  year: number | null;
  phase: YearEndPhase | null;
  closesOn: string | null;
  openRuns: YearEndOpenRun[];
}

/** Statuses that can still be issued. */
const OPEN_STATUSES = ["draft", "awaiting_approval", "approved"] as const;

/** closesOn for tax year `year` given the states employees work in during it. */
export function yearEndCloseDate(year: number, states: Iterable<string>): string {
  let earliest = filingDueDate(year, 4);
  const annual = annualDueDate(year);
  if (annual < earliest) earliest = annual;
  // No table for the year: assume the earliest TY2026 date (the safe side).
  const fallback = hasStateTableForYear(year) ? `${year + 1}-01-31` : `${year + 1}-01-15`;
  for (const state of states) {
    const due = stateQ4CloseDate(state, year) ?? fallback;
    if (due < earliest) earliest = due;
  }
  return earliest;
}

/**
 * Which tax year the warning could be about on `today` (company-local ISO
 * date) and in which phase, before closesOn is known: December -> that
 * year; any other month -> the previous year, after year end.
 */
export function yearEndCandidate(today: string): { year: number; phase: YearEndPhase } {
  const year = Number(today.slice(0, 4));
  return today.slice(5, 7) === "12"
    ? { year, phase: "december" }
    : { year: year - 1, phase: "after_year_end" };
}

/** True while the window for the candidate is open on `today`. */
export function yearEndWindowOpen(today: string, phase: YearEndPhase, closesOn: string): boolean {
  return phase === "december" || today <= closesOn;
}

/**
 * States an employee works in during `year`: the work state named by any
 * run paid in the year (the field the state deposit planner reads), plus
 * every work-state row active on some day of the year (effective_to is
 * exclusive, as in resolve.ts).
 */
export async function yearEndStates(db: Db, year: number): Promise<Set<string>> {
  const first = `${year}-01-01`;
  const last = `${year}-12-31`;
  const workState = sql<string>`(${payrollRuns.runSnapshot}#>>'{inputs,state,workState}')`;
  const fromRuns = await db
    .selectDistinct({ state: workState })
    .from(payrollRuns)
    .where(
      and(
        gte(payrollRuns.payDate, first),
        lte(payrollRuns.payDate, last),
        sql`${workState} IS NOT NULL`,
      ),
    );
  const fromRows = await db
    .selectDistinct({ state: employeeWorkStates.stateCode })
    .from(employeeWorkStates)
    .where(
      and(
        lte(employeeWorkStates.effectiveFrom, last),
        or(isNull(employeeWorkStates.effectiveTo), gt(employeeWorkStates.effectiveTo, first)),
      ),
    );
  return new Set([...fromRuns, ...fromRows].map((r) => r.state));
}

/** Runs with a pay date in `year` that can still be issued. */
export async function yearEndOpenRuns(db: Db, year: number): Promise<YearEndOpenRun[]> {
  return db
    .select({
      publicId: payrollRuns.publicId,
      payDate: payrollRuns.payDate,
      status: payrollRuns.status,
    })
    .from(payrollRuns)
    .where(
      and(
        gte(payrollRuns.payDate, `${year}-01-01`),
        lte(payrollRuns.payDate, `${year}-12-31`),
        inArray(payrollRuns.status, [...OPEN_STATUSES]),
      ),
    )
    .orderBy(payrollRuns.payDate, payrollRuns.publicId);
}

/** The full D9.8 body for company-local `today`. */
export async function getYearEndStatus(db: Db, today: string): Promise<YearEndStatus> {
  const closed: YearEndStatus = { today, year: null, phase: null, closesOn: null, openRuns: [] };
  const { year, phase } = yearEndCandidate(today);
  // closesOn is never later than the federal dates: skip the state read
  // for most of the year.
  if (!yearEndWindowOpen(today, phase, yearEndCloseDate(year, []))) return closed;
  const closesOn = yearEndCloseDate(year, await yearEndStates(db, year));
  if (!yearEndWindowOpen(today, phase, closesOn)) return closed;
  return { today, year, phase, closesOn, openRuns: await yearEndOpenRuns(db, year) };
}

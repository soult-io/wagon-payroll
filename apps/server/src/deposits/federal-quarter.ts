/**
 * PAY-226 — federal (Form 941) deposits net within the quarter.
 *
 * IRC 6656(e)(1) and Pub 15 (2026) §11 "Order in which deposits are applied":
 * a federal deposit is applied to the most recent unpaid liability of the
 * same return period (the 941 quarter). So a month deposited above its own
 * liability covers a short month of the same quarter, and no shortfall is
 * owed for it. The pool never leaves the quarter.
 *
 * For each month m of ONE quarter (months with an issued run or a live row):
 *   L[m] = the month's 941 line-16 liability; D[m] = Σ live `deposited` rows;
 *   unpaid[m] = max(0, L[m] − D[m]);  pool = Σ max(0, D[m] − L[m]);
 *   most recent month first: take = min(pool, unpaid[m]); unpaid[m] −= take;
 *   target[m] = unpaid[m]; status none (0) / overdue (past due) / pending.
 * quarterExcessCents = the pool left over: information only, never carried.
 *
 * Pure: no DB, no clock (`today` is an input), integer cents only. Invalid
 * input throws PlanInputError, never clamps.
 */

import { dueDateFor, quarterOfMonth } from "./periods.js";
import { PlanInputError } from "./transition.js";

export interface FederalMonthInput {
  /** First of the month, "YYYY-MM-01". */
  periodStart: string;
  /** The month's liability (issued runs, the five deposit categories). */
  liabilityCents: number;
  /** Σ live deposited rows of the month (any deposited_on). */
  depositedCents: number;
}

export type FederalMonthStatus = "none" | "pending" | "overdue";

export interface FederalMonthPlan {
  periodStart: string;
  /** What is still owed for the month after the quarter's pool. */
  targetCents: number;
  status: FederalMonthStatus;
  dueDate: string;
}

export interface FederalQuarterPlan {
  /** One entry per input month, ascending. */
  months: FederalMonthPlan[];
  /** Σ max(0, D − L) before it is applied (the audit's poolCents). */
  poolCents: number;
  /** Pool left after every month is covered: information only (941 line 15). */
  quarterExcessCents: number;
}

const PERIOD_RE = /^(\d{4})-(\d{2})-01$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertCents(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new PlanInputError(
      "invalid_amount",
      `planFederalQuarter: ${what} must be non-negative integer cents, got ${n}`,
    );
  }
}

/** The (year, quarter) key of a month period, validating its shape. */
function quarterKey(periodStart: string): string {
  const m = PERIOD_RE.exec(periodStart);
  const month = m ? Number(m[2]) : 0;
  if (!m || month < 1 || month > 12) {
    throw new PlanInputError(
      "invalid_period",
      `planFederalQuarter: periodStart must be YYYY-MM-01, got ${periodStart}`,
    );
  }
  return `${m[1]}-Q${quarterOfMonth(month)}`;
}

export function planFederalQuarter(input: {
  months: readonly FederalMonthInput[];
  today: string;
}): FederalQuarterPlan {
  if (!DATE_RE.test(input.today)) {
    throw new PlanInputError("invalid_period", "planFederalQuarter: today must be YYYY-MM-DD");
  }
  const months = [...input.months].sort((a, b) => (a.periodStart < b.periodStart ? -1 : 1));
  let quarter: string | null = null;
  const seen = new Set<string>();
  for (const m of months) {
    const key = quarterKey(m.periodStart);
    if (quarter !== null && key !== quarter) {
      throw new PlanInputError(
        "row_outside_unit",
        `planFederalQuarter: ${m.periodStart} is outside the quarter ${quarter}`,
      );
    }
    quarter = key;
    if (seen.has(m.periodStart)) {
      throw new PlanInputError(
        "duplicate_period",
        `planFederalQuarter: ${m.periodStart} is given twice`,
      );
    }
    seen.add(m.periodStart);
    assertCents(m.liabilityCents, `${m.periodStart} liability`);
    assertCents(m.depositedCents, `${m.periodStart} deposited`);
  }

  const unpaid = months.map((m) => Math.max(0, m.liabilityCents - m.depositedCents));
  const poolCents = months.reduce(
    (s, m) => s + Math.max(0, m.depositedCents - m.liabilityCents),
    0,
  );
  let pool = poolCents;
  for (let i = months.length - 1; i >= 0 && pool > 0; i -= 1) {
    const take = Math.min(pool, unpaid[i] ?? 0);
    unpaid[i] = (unpaid[i] ?? 0) - take;
    pool -= take;
  }

  return {
    months: months.map((m, i) => {
      const dueDate = dueDateFor(
        Number(m.periodStart.slice(0, 4)),
        Number(m.periodStart.slice(5, 7)),
      );
      const targetCents = unpaid[i] ?? 0;
      const status: FederalMonthStatus =
        targetCents === 0 ? "none" : dueDate < input.today ? "overdue" : "pending";
      return { periodStart: m.periodStart, targetCents, status, dueDate };
    }),
    poolCents,
    quarterExcessCents: pool,
  };
}

/**
 * W-4 effective-date write rule (Spec 26 (PAY-173) D3 step 4), shared by
 * POST /api/admin/employees/:id/w4 and the W-4 change-request approval.
 * Sources: Treas. Reg. 31.3402(f)(3)-1; IRC 3402(f)(2)(C), 3402(f)(3)(A)/(B).
 *
 * P(d) = start of the pay period containing d; W = start of the first payroll
 * period ending on or after filed_date + 30 days. Pay periods are calendar
 * months: monthly is the only schedule run generation supports
 * (generateDraftsForPeriod skips every other frequency).
 *
 * - first W-4 (tax_year <= year(filed)):       P(filed) <= effective_from <= filed
 * - replacement (tax_year <= year(filed)):     filed <= effective_from <= W
 * - next-year W-4 (tax_year > year(filed)):    no lower bound (resolveW4's gate
 *   governs); effective start GREATEST(effective_from, tax_year-01-01) <=
 *   GREATEST(tax_year-01-01, W) for a replacement, GREATEST(tax_year-01-01,
 *   filed) for a first W-4.
 */

import { eq } from "drizzle-orm";
import { w4Elections } from "@payroll/db";
import type { DbLike } from "./resolve.js";
import { isIsoDate } from "./run-dates.js";

export interface W4Dates {
  taxYear: number;
  filedDate: string;
  effectiveFrom: string;
}

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const max = (a: string, b: string) => (a > b ? a : b);

function addDays(d: string, days: number): string {
  const date = new Date(`${d}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Pure rule. Returns null when the dates are allowed, else a message naming
 * the allowed window (dates only).
 */
export function w4DateViolation(w: W4Dates, hasEarlierW4: boolean): string | null {
  if (!isIsoDate(w.filedDate) || !isIsoDate(w.effectiveFrom)) {
    return "filedDate and effectiveFrom must be valid YYYY-MM-DD dates";
  }
  const filedYear = Number(w.filedDate.slice(0, 4));
  // Start of the monthly period containing filed + 30 days = first period ending on/after it.
  const window = monthStart(addDays(w.filedDate, 30));
  if (w.taxYear > filedYear) {
    const yearStart = `${w.taxYear}-01-01`;
    const start = max(w.effectiveFrom, yearStart);
    const latest = max(yearStart, hasEarlierW4 ? window : w.filedDate);
    return start <= latest
      ? null
      : `a W-4 for ${w.taxYear} filed on ${w.filedDate} must take effect no later than ${latest}`;
  }
  if (!hasEarlierW4) {
    const earliest = monthStart(w.filedDate);
    return w.effectiveFrom >= earliest && w.effectiveFrom <= w.filedDate
      ? null
      : `a first W-4 filed on ${w.filedDate} must take effect between ${earliest} and ${w.filedDate}`;
  }
  return w.effectiveFrom >= w.filedDate && w.effectiveFrom <= window
    ? null
    : `a replacement W-4 filed on ${w.filedDate} must take effect between ${w.filedDate} and ${window}`;
}

/** The rule against the employee's stored W-4s (any earlier row = replacement). */
export async function validateW4Dates(
  db: DbLike,
  employeeId: number,
  w: W4Dates,
): Promise<string | null> {
  const earlier = await db
    .select({ id: w4Elections.id })
    .from(w4Elections)
    .where(eq(w4Elections.employeeId, employeeId))
    .limit(1);
  return w4DateViolation(w, earlier.length > 0);
}

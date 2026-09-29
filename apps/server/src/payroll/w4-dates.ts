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
import { isIsoDate, localDate } from "./run-dates.js";

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

/** Allowed effective_from range. `earliest` null = no lower bound (next-year W-4). */
export interface W4Window {
  earliest: string | null;
  latest: string;
}

/**
 * The lawful effective_from window for a W-4 filed on `filedDate`. For a
 * next-year W-4 the rule bounds GREATEST(effective_from, tax_year-01-01); the
 * bound is itself >= tax_year-01-01, so it bounds effective_from directly.
 */
export function w4DateWindow(taxYear: number, filedDate: string, hasEarlierW4: boolean): W4Window {
  // Start of the monthly period containing filed + 30 days = first period ending on/after it.
  const w = monthStart(addDays(filedDate, 30));
  if (taxYear > Number(filedDate.slice(0, 4))) {
    return { earliest: null, latest: max(`${taxYear}-01-01`, hasEarlierW4 ? w : filedDate) };
  }
  return hasEarlierW4
    ? { earliest: filedDate, latest: w }
    : { earliest: monthStart(filedDate), latest: filedDate };
}

/** The allowed date nearest to `date`. */
export function clampToW4Window(date: string, window: W4Window): string {
  if (date > window.latest) return window.latest;
  if (window.earliest !== null && date < window.earliest) return window.earliest;
  return date;
}

/**
 * Pure rule. Returns null when the dates are allowed, else a message naming
 * the allowed window (dates only).
 */
export function w4DateViolation(w: W4Dates, hasEarlierW4: boolean): string | null {
  if (!isIsoDate(w.filedDate) || !isIsoDate(w.effectiveFrom)) {
    return 'Enter "Date filed" and "Effective from" as dates (YYYY-MM-DD), then try again.';
  }
  const window = w4DateWindow(w.taxYear, w.filedDate, hasEarlierW4);
  if (clampToW4Window(w.effectiveFrom, window) === w.effectiveFrom) return null;
  if (window.earliest === null) {
    return `a W-4 for ${w.taxYear} filed on ${w.filedDate} must take effect no later than ${window.latest}`;
  }
  const kind = hasEarlierW4 ? "a replacement W-4" : "a first W-4";
  return `${kind} filed on ${w.filedDate} must take effect between ${window.earliest} and ${window.latest}`;
}

export interface W4DateCheck {
  /** null when the dates are allowed. */
  violation: string | null;
  /** null only when filedDate is not a valid date. */
  window: W4Window | null;
}

/** The rule against the employee's stored W-4s (any earlier row = replacement). */
export async function validateW4Dates(
  db: DbLike,
  employeeId: number,
  w: W4Dates,
): Promise<W4DateCheck> {
  const earlier = await db
    .select({ id: w4Elections.id })
    .from(w4Elections)
    .where(eq(w4Elections.employeeId, employeeId))
    .limit(1);
  const hasEarlier = earlier.length > 0;
  return {
    violation: w4DateViolation(w, hasEarlier),
    window: isIsoDate(w.filedDate) ? w4DateWindow(w.taxYear, w.filedDate, hasEarlier) : null,
  };
}

/**
 * A W-4 cannot be filed in the future: true when `filedDate` is after the
 * company's local today (APP_TZ). The 400 names the field only, never a value.
 */
export function isFiledDateInFuture(filedDate: string, now: Date, timeZone: string): boolean {
  return filedDate > localDate(now, timeZone);
}

export const FILED_DATE_IN_FUTURE = {
  error: "filed_date_in_future",
  field: "filedDate",
  message: 'The "Date filed" can\'t be after today. Enter the date the employee signed the W-4.',
} as const;

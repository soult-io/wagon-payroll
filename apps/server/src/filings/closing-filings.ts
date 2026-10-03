/**
 * PAY-193 (D9.4): the federal returns that close a pay date to issue. One
 * function owns the set; the issue path and its tests read it from here.
 */

import { and, eq, or } from "drizzle-orm";
import { taxFilings } from "@payroll/db";
import type { DbLike } from "../payroll/resolve.js";
import type { RunSnapshot } from "../payroll/snapshot.js";

export interface ClosingFiling {
  formType: "941" | "940" | "w2_w3";
  year: number;
  quarter: number;
}

/**
 * Federal returns whose status 'filed' closes a pay date to issue
 * (federal-payroll-tax-sme 2026-09-29): the 941 of the pay date's quarter,
 * then the 940 and the W-2/W-3 of its year. Edit this list only. A filed
 * w2_w3 also freezes W-2 boxes 15–17.
 */
export function closingFilings(payDate: string): ClosingFiling[] {
  const year = Number(payDate.slice(0, 4));
  const quarter = Math.ceil(Number(payDate.slice(5, 7)) / 3);
  return [
    { formType: "941", year, quarter },
    { formType: "940", year, quarter: 0 },
    { formType: "w2_w3", year, quarter: 0 },
  ];
}

/**
 * The members of closingFilings(payDate) whose row is 'filed', in
 * closingFilings order. A missing row counts as not filed. Call it under
 * FILING_CLOSE_LOCK.
 */
export async function filedClosingFilings(tx: DbLike, payDate: string): Promise<ClosingFiling[]> {
  const set = closingFilings(payDate);
  const rows = await tx
    .select({ formType: taxFilings.formType, year: taxFilings.year, quarter: taxFilings.quarter })
    .from(taxFilings)
    .where(
      and(
        eq(taxFilings.status, "filed"),
        or(
          ...set.map((f) =>
            and(
              eq(taxFilings.formType, f.formType),
              eq(taxFilings.year, f.year),
              eq(taxFilings.quarter, f.quarter),
            ),
          ),
        ),
      ),
    );
  return set.filter((f) =>
    rows.some((r) => r.formType === f.formType && r.year === f.year && r.quarter === f.quarter),
  );
}

/** "941:2026-Q1", "940:2026", "w2_w3:2026" — the codes in a pay_period_filed body. */
export function closingFilingCode(f: ClosingFiling): string {
  return f.formType === "941" ? `941:${f.year}-Q${f.quarter}` : `${f.formType}:${f.year}`;
}

/** "Form 941 for Q1 2026", "Form 940 for 2026", "Forms W-2/W-3 for 2026". */
export function closingFilingLabel(f: ClosingFiling): string {
  if (f.formType === "941") return `Form 941 for Q${f.quarter} ${f.year}`;
  if (f.formType === "940") return `Form 940 for ${f.year}`;
  return `Forms W-2/W-3 for ${f.year}`;
}

/**
 * The correction that a payroll added under a filed closing return needs
 * (federal-payroll-tax-sme 2026-10-03; IRS i941x, i940, iw2w3).
 */
export function closingFilingCorrection(f: ClosingFiling): string {
  if (f.formType === "941") return "Form 941-X";
  if (f.formType === "940") return "an amended Form 940";
  return "Forms W-2c and W-3c";
}

/**
 * "a", "a and b", "a, b, and c". The serial comma keeps a three-item list
 * whose last item has its own "and" ("Forms W-2c and W-3c") readable.
 */
export function joinWithAnd(items: string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * PAY-193 L4 (D9.3): the state jurisdictions a late issue asks about — the
 * snapshot's work state, or none. kind 'none' states are included (they may
 * still have SUI). The residence locality joins when Spec 25 local
 * withholding writes one into the snapshot.
 */
export function stateReturnJurisdictions(snapshot: RunSnapshot): string[] {
  const workState = snapshot.inputs.state?.workState;
  return workState ? [workState] : [];
}

/**
 * PAY-119 hook: refuse a late issue for a semiweekly depositor. Always
 * allowed until PAY-119 records the depositor schedule.
 */
export function lateIssueAllowed(): boolean {
  return true;
}

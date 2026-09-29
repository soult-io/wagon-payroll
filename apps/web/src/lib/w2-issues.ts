/**
 * PAY-162: admin copy for W-2 check results and W-2/W-3 block states. Text is
 * built from the fixed code (and year) only — never from a server message,
 * never with an amount.
 */

import type { W2FiguresRow, W2Issue, W2IssueCode } from "./api";

const ISSUE_TEXT: Record<W2IssueCode, string> = {
  internal_mismatch:
    "We couldn't read this employee's payroll totals for the year, so their W-2 is on hold. This is a problem in the app, not something you entered. Contact support, and don't fill in or hand out this W-2 by hand.",
  negative_amount:
    "One of this employee's W-2 totals for the year comes out below zero, and a W-2 can't show a negative number. Their W-2 is on hold. Contact support to find and fix the payroll entry that caused it.",
  box4_over_max:
    "More Social Security tax was withheld from this employee than the yearly limit allows. Their W-2 is on hold so it doesn't go out wrong. Contact support to fix it before you hand out W-2s.",
  box4_without_box3:
    "Social Security tax was withheld from this employee, but their W-2 shows no wages for the year. Their W-2 is on hold. Contact support to fix it.",
  box6_without_box5:
    "Medicare tax was withheld from this employee, but their W-2 shows no wages for the year. Their W-2 is on hold. Contact support to fix it.",
  box4_off_rate:
    "The Social Security tax withheld this year doesn't line up with this employee's wages. The gap is more than rounding would explain. This W-2 isn't on hold and shows what was actually withheld. If you don't know why, contact support before you file the W-3.",
  box6_off_rate:
    "The Medicare tax withheld this year doesn't line up with this employee's wages. The gap is more than rounding would explain. This W-2 isn't on hold and shows what was actually withheld. If you don't know why, contact support before you file the W-3.",
};

const ISSUE_LABEL: Record<W2IssueCode, string> = {
  internal_mismatch: "Totals unreadable",
  negative_amount: "Negative total",
  box4_over_max: "Social Security over limit",
  box4_without_box3: "Social Security tax, no wages",
  box6_without_box5: "Medicare tax, no wages",
  box4_off_rate: "Check Social Security",
  box6_off_rate: "Check Medicare",
};

/** Short chip label for one issue. */
export function w2IssueLabel(issue: W2Issue): string {
  return ISSUE_LABEL[issue.code];
}

/** Full sentence for one issue (shown as visible text). */
export function w2IssueText(issue: W2Issue): string {
  return ISSUE_TEXT[issue.code];
}

/** A row whose totals cannot be read or are negative (its boxes are withheld). */
export function hasUnreadableTotals(row: Pick<W2FiguresRow, "issues">): boolean {
  return row.issues.some((i) => i.code === "internal_mismatch" || i.code === "negative_amount");
}

/** Banner when the year's federal tax settings are missing (409 missing_tax_config). */
export function missingTaxConfigText(year: number): string {
  return `The ${year} federal tax settings haven't been added yet, so the ${year} W-2s and W-3 can't be prepared. Add them in Config → Tax tables (pick ${year} as the tax year). That page starts with last year's numbers, so change every figure that's different for ${year} before you save. Not sure of a figure? Contact support.`;
}

/** Banner when any W-2 of the year is blocked (the W-3, filing and notices are held). */
export function w2BlockedText(year: number): string {
  return `Some ${year} W-2s are on hold. You'll find them under "W-2s that need attention" below. Until every one is fixed, you can't download the W-3 or record this filing, and employees won't get the "your W-2 is ready" email. Don't file the W-3 or hand out W-2s for ${year} yet.`;
}

/** Added to the blocked banner when a W-2's totals cannot be read or are negative. */
export const STALE_TOTALS_TEXT =
  'The W-3 totals on this page may be out of date until the W-2s marked "Totals unreadable" or "Negative total" are fixed. Don\'t copy them onto a form.';

/** Only warnings stand for the year (nothing on hold). */
export function w2WarningsOnlyText(count: number, year: number): string {
  return `${count} W-2s for ${year} have something worth a second look. None of them are on hold.`;
}

/** The year has no bundled official W-2/W-3 form (admin W-2 list formAvailable = false). */
export function formNotAvailableText(year: number): string {
  return `The official ${year} W-2 form isn't in the app yet, so the W-2 and W-3 PDFs can't be made. Contact support to get the ${year} form added.`;
}

/** The admin W-2 list failed to load. */
export function w2LoadErrorText(year: number): string {
  return `We couldn't load the ${year} W-2 list. Reload the page to try again. Until it loads, this page can't show whether any W-2 is on hold.`;
}

/** Employee view: their W-2 for the year is not ready to download (ready = false). */
export function myW2NotReadyText(year: number): string {
  return `Your ${year} W-2 isn't ready to download yet. Your employer is still finishing it. Please check back later, or ask your employer if you need it sooner.`;
}

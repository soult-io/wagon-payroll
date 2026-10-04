/**
 * PAY-162: admin copy for W-2 check results and W-2/W-3 block states. Text is
 * built from the fixed code (and year) only — never from a server message,
 * never with an amount.
 */

import { stateName } from "@payroll/shared";
import { useDates } from "../composables/useDates";
import type { W2FiguresRow, W2Issue, W2IssueCode } from "./api";

const { longDate } = useDates();

/** What an issue sentence may name: the employee, the tax year, the issue's state and date. */
export interface W2IssueContext {
  /** The W-2 row's legal name (year-level issues: none). */
  legalName: string;
  year: number;
}

interface TextParts {
  employee: string;
  year: number;
  state: string;
  date: string;
}

/**
 * Sentences per code. Spec 24 (PAY-116) PR-4: final copy (product-ux-designer
 * and state-local-payroll-sme, 2026-10-04). Settings are named by the labels
 * the owner sees: Config → Company → "Company profile" / "State tax account
 * numbers". No amounts and no tax advice in any string; a hold says when it
 * clears.
 */
const ISSUE_TEXT: Record<W2IssueCode, (p: TextParts) => string> = {
  internal_mismatch: () =>
    "We couldn't read this employee's payroll totals for the year, so their W-2 is on hold. This is a problem in the app, not something you entered. Contact support, and don't fill in or hand out this W-2 by hand.",
  negative_amount: () =>
    "One of this employee's W-2 totals for the year comes out below zero, and a W-2 can't show a negative number. Their W-2 is on hold. Contact support to find and fix the payroll entry that caused it.",
  box4_over_max: () =>
    "More Social Security tax was withheld from this employee than the yearly limit allows. Their W-2 is on hold so it doesn't go out wrong. Contact support to fix it before you hand out W-2s.",
  box4_without_box3: () =>
    "Social Security tax was withheld from this employee, but their W-2 shows no wages for the year. Their W-2 is on hold. Contact support to fix it.",
  box6_without_box5: () =>
    "Medicare tax was withheld from this employee, but their W-2 shows no wages for the year. Their W-2 is on hold. Contact support to fix it.",
  box4_off_rate: () =>
    "The Social Security tax withheld this year doesn't line up with this employee's wages. The gap is more than rounding would explain. This W-2 isn't on hold and shows what was actually withheld. If you don't know why, contact support before you file the W-3.",
  box6_off_rate: () =>
    "The Medicare tax withheld this year doesn't line up with this employee's wages. The gap is more than rounding would explain. This W-2 isn't on hold and shows what was actually withheld. If you don't know why, contact support before you file the W-3.",
  missing_state_id: (p) =>
    `Add your ${p.state} account number. ${p.employee}'s W-2 shows ${p.state} tax withheld, so it needs your ${p.state} employer account number, and we don't have it yet. Add it under Config → Company → State tax account numbers. This hold clears once it's saved.`,
  legacy_state_runs: (p) =>
    `Some of ${p.employee}'s ${p.year} pay runs were made before the app kept track of work states, and they include state tax. We can't tell which state that tax belongs to, and we won't guess. Contact support to finish this W-2.`,
  reconciliation_mismatch: (p) => {
    const s = p.state || "state";
    return `The ${s} tax on your W-2s doesn't match the ${s} tax on your issued pay runs. Don't send these forms yet. Contact support.`;
  },
  local_boxes_pending: (p) =>
    `${p.employee}'s ${p.year} pay runs include local tax, and the app can't put local tax on a W-2 yet, so this W-2 is on hold. Don't fill in or hand out this W-2 by hand. Contact support.`,
  missing_state_id_zero_tax: (p) =>
    `${p.employee} earned wages in ${p.state} with no ${p.state} tax withheld, so this W-2 can go out without a ${p.state} account number. It will show the ${p.state} wages with the number left blank. If ${p.state} gave you an account number, add it under Config → Company → State tax account numbers.`,
  legacy_runs_without_state: (p) =>
    `Some of ${p.employee}'s ${p.year} pay runs have no work state. They had no state tax withheld, so they are not on any state line. If ${p.employee} worked in a state with income tax during those pay periods, check the state lines before you hand out this W-2.`,
  local_tax_md: (p) =>
    `Maryland expects box 17 to include more than state tax: county tax for people who live in Maryland, and a special nonresident tax for people who live in another state and have Maryland tax withheld. This app didn't withhold either one in ${p.year}, so ${p.employee}'s box 17 shows state tax only. If either applies to ${p.employee} for ${p.year}, check what you need to report.`,
  local_tax_ny: (p) =>
    `New York City and Yonkers have their own income tax. This app didn't withhold it in ${p.year}, so boxes 18–20 (local tax) are blank. If ${p.employee} lived in New York City or Yonkers, or worked in Yonkers, in ${p.year}, check what you need to report.`,
  exempt_reciprocity: (p) =>
    `${p.employee} is marked exempt from ${p.state} tax. If that's because they live in a neighboring state, their home state may need its own line on this W-2. This app doesn't add that line yet.`,
  ny_all_wages: (p) =>
    `New York asks for all of ${p.employee}'s ${p.year} wages in box 16, not only the New York part.`,
  period_spans_move: (p) =>
    `${p.employee} changed work state on ${p.date}, partway through a pay period. That whole pay run counts in ${p.state}, where the pay period started.`,
  state_id_unreadable: (p) =>
    `Re-enter your ${p.state} account number. We have a ${p.state} account number saved for your company, but we can't read it, so ${p.employee}'s W-2 is on hold. Go to Config → Company → State tax account numbers, pick ${p.state} and the same "Use from tax year" as the saved number for ${p.year}, type the number again, and select Replace account number. If this message is still here after you save, contact support.`,
  ein_unreadable: (p) =>
    `Re-enter your company's EIN. We have an EIN saved for your company, but we can't read it, so ${p.employee}'s W-2 is on hold. Go to Config → Company → Company profile, type the EIN in the EIN field, and select Save company profile. If this message is still here after you save, contact support.`,
  state_id_too_long: (p) =>
    `Check your ${p.state} account number. It's too long to fit in box 15 of the W-2, so ${p.employee}'s W-2 is on hold. Compare it with the paperwork ${p.state} sent you. If you find a typo or extra characters, go to Config → Company → State tax account numbers, pick ${p.state} and the same "Use from tax year", enter the number again, and select Replace account number. If it matches the paperwork, contact support.`,
  ssn_unreadable: (p) =>
    `Re-enter ${p.employee}'s Social Security number. We have one saved, but we can't read it, so their W-2 is on hold. Go to Employees → ${p.employee} → Profile, select Correct next to Tax ID, and type the number again. If this message is still here after you save, contact support.`,
  address_unreadable: (p) =>
    `We can't read ${p.employee}'s saved address for ${p.year}, so their W-2 is on hold. This is a problem in the app, not something you entered, and typing the address again won't fix it. Contact support, and don't fill in or hand out this W-2 by hand.`,
};

const ISSUE_LABEL: Record<W2IssueCode, string> = {
  internal_mismatch: "Totals unreadable",
  negative_amount: "Negative total",
  box4_over_max: "Social Security over limit",
  box4_without_box3: "Social Security tax, no wages",
  box6_without_box5: "Medicare tax, no wages",
  box4_off_rate: "Check Social Security",
  box6_off_rate: "Check Medicare",
  missing_state_id: "State number missing",
  legacy_state_runs: "Old pay runs with state tax",
  reconciliation_mismatch: "State tax doesn't match",
  local_boxes_pending: "Local tax not supported",
  missing_state_id_zero_tax: "No state number (no tax)",
  legacy_runs_without_state: "Pay runs without a state",
  local_tax_md: "Maryland local tax",
  local_tax_ny: "NYC / Yonkers tax",
  exempt_reciprocity: "Exempt — check home state",
  ny_all_wages: "New York: all wages",
  period_spans_move: "Moved mid-period",
  state_id_unreadable: "State number unreadable",
  ein_unreadable: "EIN unreadable",
  state_id_too_long: "State number too long",
  ssn_unreadable: "SSN unreadable",
  address_unreadable: "Address unreadable",
};

/** Short chip label for one issue. */
export function w2IssueLabel(issue: W2Issue): string {
  return ISSUE_LABEL[issue.code];
}

/** Full sentence for one issue (shown as visible text). */
export function w2IssueText(issue: W2Issue, ctx: W2IssueContext): string {
  return ISSUE_TEXT[issue.code]({
    employee: ctx.legalName,
    year: ctx.year,
    state: issue.state ? stateName(issue.state) : "",
    // Spec 24 (PAY-116) PR-4: the owner reads a long date; the key keeps the raw one.
    date: issue.date ? longDate(issue.date) : "",
  });
}

/** Stable list key for an issue (per-state issues repeat a code). */
export function w2IssueKey(issue: W2Issue): string {
  return `${issue.code}:${issue.state ?? ""}:${issue.date ?? ""}`;
}

/** A row whose totals cannot be read or are negative (its boxes are withheld). */
export function hasUnreadableTotals(row: Pick<W2FiguresRow, "issues">): boolean {
  return row.issues.some((i) => i.code === "internal_mismatch" || i.code === "negative_amount");
}

/**
 * Spec 24 (PAY-116) PR-4 (B3): added after a reconciliation_mismatch line
 * when the State tax check card shows that state's amounts.
 */
export const RECONCILIATION_POINTER_TEXT = "You can see both amounts in the State tax check above.";

/** Banner when the year's federal tax settings are missing (409 missing_tax_config). */
export function missingTaxConfigText(year: number): string {
  return `The ${year} federal tax settings haven't been added yet, so the ${year} W-2s and W-3 can't be prepared. Add them in Config → Tax tables (pick ${year} as the tax year). That page starts with last year's numbers, so change every figure that's different for ${year} before you save. Not sure of a figure? Contact support.`;
}

/**
 * Spec 24 (PAY-116) PR-4 round 4: the state names of year-level issues,
 * sorted by code (code-point) and joined " and "; "state" ("State" with
 * `capital`) when no issue names a state.
 */
export function yearIssueStatesText(issues: readonly W2Issue[], capital = false): string {
  const codes = [...new Set(issues.flatMap((i) => (i.state ? [i.state] : [])))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (codes.length === 0) return capital ? "State" : "state";
  return codes.map(stateName).join(" and ");
}

/**
 * Banner when any W-2 of the year is blocked (the W-3, filing and notices are
 * held). Spec 24 (PAY-116) PR-4 (I4): the last sentence depends on whether
 * the year's "your W-2 is ready" email already went out (`notified`).
 * Round 4: `yearOnlyStates` given = no W-2 is held itself, only the year's
 * state tax check ({States} text, see yearIssueStatesText).
 */
export function w2BlockedText(year: number, notified: boolean, yearOnlyStates?: string): string {
  if (yearOnlyStates !== undefined) {
    const body = `The ${yearOnlyStates} tax on your ${year} W-2s doesn't match your issued pay runs. Until that's fixed, you can't download the W-3 or record this filing. Each W-2 can still be downloaded, but don't file or hand out ${year} W-2s yet. You'll find the details under "W-2s that need attention" below.`;
    const notice = notified
      ? `Employees already got the "your W-2 is ready" email for ${year} and can still download their W-2s, so contact support soon.`
      : `Employees haven't been told their ${year} W-2s are ready. We'll email the employees who get their W-2 online once this is fixed.`;
    return `${body} ${notice}`;
  }
  const body = `Some ${year} W-2s are on hold. You'll find them under "W-2s that need attention" below. Until every one is fixed, you can't download the W-3 or record this filing. Don't file or hand out W-2s for ${year} yet.`;
  const notice = notified
    ? `Employees already got the "your W-2 is ready" email for ${year}. Anyone whose W-2 is on hold can't download it until it's fixed, so fix the items below soon.`
    : `Employees haven't been told their ${year} W-2s are ready. We'll email the employees who get their W-2 online once every W-2 is off hold.`;
  return `${body} ${notice}`;
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

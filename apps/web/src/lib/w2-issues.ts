/**
 * PAY-162: admin copy for W-2 check results and W-2/W-3 block states. Text is
 * built from the fixed code (and year) only — never from a server message,
 * never with an amount. Draft copy, pending product-ux-designer review.
 */

import type { W2Issue, W2IssueCode } from "./api";

const ISSUE_TEXT: Record<W2IssueCode, string> = {
  internal_mismatch:
    "We couldn't read this employee's payroll figures, so this W-2 is on hold. Contact support before issuing it.",
  negative_amount:
    "One of this employee's W-2 amounts comes to less than zero. W-2 amounts can't be negative, so this W-2 is on hold until the payroll runs are corrected.",
  box4_over_max:
    "Social Security tax withheld is more than the most the IRS allows for the year. This W-2 is on hold until the payroll runs are corrected.",
  box4_without_box3:
    "Social Security tax was withheld, but there are no Social Security wages. This W-2 is on hold until the payroll runs are corrected.",
  box6_without_box5:
    "Medicare tax was withheld, but there are no Medicare wages. This W-2 is on hold until the payroll runs are corrected.",
  box4_off_rate:
    "Social Security tax withheld doesn't match the year's rate on these wages by more than normal rounding. Worth a check before you file.",
  box6_off_rate:
    "Medicare tax withheld doesn't match the year's rates on these wages by more than normal rounding. Worth a check before you file.",
};

const ISSUE_LABEL: Record<W2IssueCode, string> = {
  internal_mismatch: "Figures unreadable",
  negative_amount: "Negative amount",
  box4_over_max: "SS tax over maximum",
  box4_without_box3: "SS tax without wages",
  box6_without_box5: "Medicare tax without wages",
  box4_off_rate: "Check SS tax",
  box6_off_rate: "Check Medicare tax",
};

/** Short chip label for one issue. */
export function w2IssueLabel(issue: W2Issue): string {
  return ISSUE_LABEL[issue.code];
}

/** Full sentence for one issue (tooltip / detail). */
export function w2IssueText(issue: W2Issue): string {
  return ISSUE_TEXT[issue.code];
}

/** Banner when the year's federal tax settings are missing (409 missing_tax_config). */
export function missingTaxConfigText(year: number): string {
  return `Federal tax settings for ${year} are missing. W-2s and the W-3 for ${year} can't be prepared until they're added in Configuration → Tax tables.`;
}

/** Banner when any W-2 of the year is blocked (the W-3 and notices are held too). */
export function w2BlockedText(year: number): string {
  return `Some W-2s for ${year} are on hold. The W-3 and the "W-2s are ready" email to employees wait until every W-2 below is fixed.`;
}

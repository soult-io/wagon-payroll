/**
 * PAY-193 L4 (spec D9, addendum L4.2, L4.8): the late predicate and the
 * server-rendered late-issue copy. Pure: no DB, no clock. `today` is always
 * the company-local date (localDate(clock(), config.appTz)); every compare is
 * an ISO string compare.
 */

import { formatMoney, stateName } from "@payroll/shared";
import { quarterEnd } from "../filings/service.js";

/**
 * States whose withholding RETURN can be filed before the quarter ends
 * (state-payroll SME research 2026-10-03, PAY-193 Q-S2). Value = the pay-date
 * months (1–12) in which a monthly return exists; "all" = every month.
 * Edit this table only. Months that end a quarter are already covered by the
 * quarter rule, so "months 1–2" and "Jan–Nov" behave like "all" today; the
 * data stays as researched.
 */
export const MONTHLY_RETURN_STATES: Readonly<Record<string, "all" | readonly number[]>> = {
  CO: "all",
  DE: "all",
  IN: "all",
  MD: "all",
  MI: "all",
  MS: "all",
  NM: "all",
  VA: "all",
  AL: [1, 2, 4, 5, 7, 8, 10, 11],
  MA: [1, 2, 4, 5, 7, 8, 10, 11],
  MO: [1, 2, 4, 5, 7, 8, 10, 11],
  KY: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  NC: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  NY: "all", // NYS-1
  // Monthly zero-required reports.
  AR: "all",
  KS: "all",
  WI: "all",
  PA: "all",
};

export type LateTrigger = "quarter_ended" | "month_ended";

function monthOf(payDate: string): number {
  return Number(payDate.slice(5, 7));
}

function quarterOf(payDate: string): number {
  return Math.ceil(monthOf(payDate) / 3);
}

/** Last day of the pay-date month ("2026-02-10" → "2026-02-28"). */
export function monthEnd(payDate: string): string {
  const d = new Date(Date.UTC(Number(payDate.slice(0, 4)), monthOf(payDate), 0));
  return d.toISOString().slice(0, 10);
}

/** True when `state` files a monthly withholding return for the pay-date month. */
export function filesMonthlyReturn(state: string | null, payDate: string): boolean {
  if (state === null) return false;
  const months = MONTHLY_RETURN_STATES[state];
  if (months === undefined) return false;
  return months === "all" || months.includes(monthOf(payDate));
}

/**
 * Q-N2 = B (Neil 2026-10-01, brain #3940): late when the pay-date quarter has
 * ended. Q-S2: also late when the pay-date month has ended and the work state
 * files monthly returns in that month. Returns null when the run is not late.
 */
export function lateTrigger(
  payDate: string,
  today: string,
  workState: string | null,
): LateTrigger | null {
  if (quarterEnd(Number(payDate.slice(0, 4)), quarterOf(payDate)) < today) return "quarter_ended";
  if (monthEnd(payDate) < today && filesMonthlyReturn(workState, payDate)) return "month_ended";
  return null;
}

// ---------------------------------------------------------------------------
// Copy (product-ux-designer final strings + Product Lead amendments 2026-10-03)
// ---------------------------------------------------------------------------

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** "2026-12-31" → "December 31, 2026" (long US date). */
export function longUsDate(iso: string): string {
  return `${MONTHS[monthOf(iso) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
}

/** Integer cents → "$3,209.74". Audit text only; never in a body, log or mail. */
export function usd(cents: number): string {
  return formatMoney(cents / 100);
}

/** "Illinois" / "Illinois and Maryland" / "Illinois, Maryland and New York". */
export function stateList(codes: readonly string[]): string {
  const names = codes.map(stateName);
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export const ATTESTATION_VERSION = 1;

const ATTESTATION_P1 =
  "The pay date is the day the money was in your employee's account and they could spend it, not the day you sent it and not the date on the pay stub.";

/**
 * LATE_ATTESTATION_V1 with {payDate} filled. `netPay` stays the literal
 * "{netPay}" in the 409 body; the audit row fills it with the typed amount.
 */
export function attestationText(payDate: string, netPay = "{netPay}"): string {
  return (
    `${ATTESTATION_P1}\n\n` +
    `I paid ${netPay} to this employee on ${longUsDate(payDate)}, and that is the day the money was in their account. ` +
    "My business is a monthly schedule depositor for federal payroll taxes: each month's taxes are due by the 15th of the following month. " +
    "Wagon Payroll supports monthly depositors only."
  );
}

export interface StateQuestions {
  jurisdiction: string;
  withholdingReturn: string;
  suiWageReport: string;
  annualReconciliation: string;
}

/**
 * Server-rendered state questions (copy 1.7). `noIncomeTax` = the state
 * config row for the pay-date tax year has kind 'none' (PL amendment 3).
 */
export function stateQuestions(
  jurisdiction: string,
  payDate: string,
  noIncomeTax: boolean,
): StateQuestions {
  const name = stateName(jurisdiction);
  const year = payDate.slice(0, 4);
  const quarter = `Q${quarterOf(payDate)} ${year}`;
  const period = filesMonthlyReturn(jurisdiction, payDate)
    ? `${MONTHS[monthOf(payDate) - 1]} ${year} or ${quarter}`
    : quarter;
  return {
    jurisdiction,
    withholdingReturn: noIncomeTax
      ? `${name} has no state income tax withholding return. Choose "No, not filed".`
      : `Have you filed your ${name} income tax withholding return for ${period}?`,
    suiWageReport: `Have you filed your ${name} unemployment insurance (SUI) wage report for ${quarter}?`,
    annualReconciliation: noIncomeTax
      ? `${name} has no state income tax W-2 filing. Choose "No, not filed".`
      : `Have you filed your ${name} year-end withholding reconciliation or W-2s with the state for ${year}?`,
  };
}

export interface StateReturnAnswer {
  jurisdiction: string;
  withholdingReturnFiled: boolean;
  suiWageReportFiled: boolean;
  annualReconciliationFiled: boolean;
}

const answer = (filed: boolean): string => (filed ? "Yes, filed" : "No, not filed");

/** The state questions with the admin's answers, for the run.issued_late audit row. */
export function stateAttestationText(
  questions: readonly StateQuestions[],
  answers: readonly StateReturnAnswer[],
): string {
  return questions
    .map((q) => {
      const a = answers.find((x) => x.jurisdiction === q.jurisdiction);
      return [
        stateName(q.jurisdiction),
        `${q.withholdingReturn} ${answer(a?.withholdingReturnFiled ?? false)}`,
        `${q.suiWageReport} ${answer(a?.suiWageReportFiled ?? false)}`,
        `${q.annualReconciliation} ${answer(a?.annualReconciliationFiled ?? false)}`,
      ].join("\n");
    })
    .join("\n\n");
}

export function confirmationRequiredMessage(payDate: string): string {
  return `This payroll's pay date, ${longUsDate(payDate)}, is in a tax period that has ended. To add it to ${payDate.slice(0, 4)}, confirm the date and amount you paid, and that the related state returns aren't filed yet.`;
}

export function incompleteMessage(jurisdictions: readonly string[]): string {
  return jurisdictions.length > 0
    ? `Answer every question for each state on this payroll (${stateList(jurisdictions)}). Nothing was issued.`
    : "This payroll has no state questions to answer. Nothing was issued.";
}

export function stateReturnFiledMessage(jurisdictions: readonly string[]): string {
  return `Nothing was issued. You said a return or report for ${stateList(jurisdictions)} that covers this pay date is already filed. Adding this payroll means correcting that filing with a state correction form, which Wagon Payroll doesn't prepare. Keep the pay date as it is. Keep your own record of this payment, and make the correction outside Wagon Payroll or with your tax preparer.`;
}

export const AMOUNT_MISMATCH_MESSAGE =
  "Nothing was issued. The amount you typed doesn't match this payroll's net pay. Check it against your bank record, including cents. If you paid a different amount, the wages and taxes for that payment may be different from this payroll, and Wagon Payroll can't record it as it is. Talk to your tax preparer before you issue it.";

/**
 * Toast + error normalization (UX conventions: every mutation gets feedback).
 */

import { useToast } from "primevue/usetoast";
import { ApiError } from "../lib/api";

/**
 * Spec 26 (PAY-173) §5 copy for the payroll-run refusals. ytd_order_conflict
 * shows the server text when there is any (it names the pay date); the
 * fallback is used only when the server sent none.
 */
const STALE_DRAFT_MESSAGE =
  "This draft is out of date, so it was not approved or issued. Something it depends on changed after it was made — for example, another payroll was issued, or a tax table or W-4 was updated. To fix it, void this draft, then generate it again from Config → Pay schedule → Generate drafts now so the numbers are recalculated.";

const YTD_ORDER_FALLBACK =
  "This employee already has a payroll issued with a later pay date. Payrolls must be issued in the order they are paid. Nothing was approved or issued. Void this draft and generate it again with the date you actually pay it.";

/** PAY-193 (D9.4): the server's text names the pay date and the filed forms. */
const PERIOD_FILED_FALLBACK =
  "Nothing was issued. You've marked a tax return that covers this pay date as filed. If you really paid your team on that date, keep the date. Don't move it to get around this. Adding this payroll means correcting the filed return with a correction form, which Wagon Payroll doesn't prepare. Keep your own record of this payment and make the correction outside Wagon Payroll.";

/** PAY-193 L4: late-issue refusals (copy 2.2–2.4). The server text names the states. */
const LATE_INCOMPLETE_FALLBACK =
  "Answer every question for each state on this payroll. Nothing was issued.";
const STATE_RETURN_FILED_FALLBACK =
  "Nothing was issued. You said a return or report for your state that covers this pay date is already filed. Adding this payroll means correcting that filing with a state correction form, which Wagon Payroll doesn't prepare. Keep the pay date as it is. Keep your own record of this payment, and make the correction outside Wagon Payroll or with your tax preparer.";
const AMOUNT_MISMATCH_FALLBACK =
  "Nothing was issued. The amount you typed doesn't match this payroll's net pay. Check it against your bank record, including cents. If you paid a different amount, the wages and taxes for that payment may be different from this payroll, and Wagon Payroll can't record it as it is. Talk to your tax preparer before you issue it.";
const LATE_NOT_SUPPORTED_FALLBACK =
  "Wagon Payroll can't record a late payroll for your business's deposit schedule yet. Nothing was issued.";

const LATE_FALLBACKS: Record<string, string> = {
  late_payment_incomplete: LATE_INCOMPLETE_FALLBACK,
  late_issue_not_supported: LATE_NOT_SUPPORTED_FALLBACK,
  state_return_filed: STATE_RETURN_FILED_FALLBACK,
  late_payment_amount_mismatch: AMOUNT_MISMATCH_FALLBACK,
};

/** PAY-193 L4: opens the late dialog; never toasted. */
export const LATE_CONFIRMATION_CODE = "late_payment_confirmation_required";

/** PAY-193 (D9.5): mark-as-filed refused because the figures changed. */
const WORKSHEET_CHANGED_FALLBACK =
  "Not recorded yet. The figures on this page changed since you opened it, usually because a payroll was issued or changed. Check the updated figures. If they match what you filed, mark it as filed again. If you already filed different figures, the filed return may need a correction.";

/** The server's own message, or null when the body carried none (err.message is then a generic default). */
function serverMessage(err: ApiError): string | null {
  const message = err.body?.["message"];
  return typeof message === "string" && message.trim() !== "" ? message : null;
}

function payrollRunMessage(err: ApiError): string | null {
  if (err.code === "stale_draft") return STALE_DRAFT_MESSAGE;
  if (err.code === "ytd_order_conflict") return serverMessage(err) ?? YTD_ORDER_FALLBACK;
  if (err.code === "pay_period_filed") return serverMessage(err) ?? PERIOD_FILED_FALLBACK;
  if (err.code === "worksheet_changed") return serverMessage(err) ?? WORKSHEET_CHANGED_FALLBACK;
  const late = LATE_FALLBACKS[err.code];
  if (late) return serverMessage(err) ?? late;
  return null;
}

/** 400 invalid_w4_effective_date: the allowed window (dates only) from the body. */
function w4WindowMessage(err: ApiError): string | null {
  if (err.code !== "invalid_w4_effective_date") return null;
  const allowed = err.body?.["window"] as { earliest?: string | null; latest?: string } | null;
  if (!allowed?.latest) return err.message;
  return allowed.earliest
    ? `The "Effective from" date must be between ${allowed.earliest} and ${allowed.latest}. IRS rules set this range from the date the employee filed this W-4 ("Date filed"). Change "Effective from", or check "Date filed", then try again.`
    : `For a W-4 for next year, the "Effective from" date must be ${allowed.latest} or earlier. Change "Effective from", or check "Date filed" and "Tax year", then try again.`;
}

/**
 * Long refusals that tell the admin what to do next stay on screen until
 * closed (WCAG 2.2.1): a 5-second toast is too short to read them.
 */
const STICKY_ERROR_CODES = new Set([
  "stale_draft",
  "ytd_order_conflict",
  "pay_period_filed",
  "late_payment_incomplete",
  "state_return_filed",
  "late_payment_amount_mismatch",
  "late_issue_not_supported",
  "worksheet_changed",
  "invalid_w4_effective_date",
  "effective_date",
]);

/** Issue refusals: the toast title says the payroll was not issued. */
const ISSUE_REFUSED_CODES = new Set([
  "pay_period_filed",
  "late_payment_incomplete",
  "state_return_filed",
  "late_payment_amount_mismatch",
  "late_issue_not_supported",
]);

export function useNotify() {
  const toast = useToast();

  function success(summary: string, detail?: string) {
    toast.add({ severity: "success", summary, detail, life: 3500 });
  }

  function info(summary: string, detail?: string) {
    toast.add({ severity: "info", summary, detail, life: 4000 });
  }

  /** Info that tells the admin what to do next: stays until closed (no `life`). */
  function stickyInfo(summary: string, detail?: string) {
    toast.add({ severity: "info", summary, detail });
  }

  /** Human message out of ApiError / Error / unknown. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: error-code mapping chain; a lookup table would hide ApiError precedence
  function errorMessage(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.status === 401) return "Your session expired — sign in again.";
      if (err.status === 403) return "You do not have access to that.";
      if (err.status === 404) return "Not found.";
      if (err.code === "duplicate_pending") return "A pending request of this type already exists.";
      // PAY-217: a reset / unlock of a former employee whose W-2 access is over.
      if (err.code === "w2_access_ended")
        return "This person's job has ended and their online W-2 access is over, so they can't sign in. Give them any W-2 they need on paper.";
      if (err.code === "effective_date") return err.message;
      return payrollRunMessage(err) ?? w4WindowMessage(err) ?? err.message;
    }
    if (err instanceof Error) return err.message;
    return "Something went wrong.";
  }

  function error(err: unknown, summary = "Error") {
    // PAY-193 L4 (W-L5): the confirmation request opens the late dialog instead.
    if (err instanceof ApiError && err.code === LATE_CONFIRMATION_CODE) return;
    const sticky = err instanceof ApiError && STICKY_ERROR_CODES.has(err.code);
    const notIssued = err instanceof ApiError && ISSUE_REFUSED_CODES.has(err.code);
    toast.add({
      severity: "error",
      summary: notIssued ? "Payroll not issued" : summary,
      detail: errorMessage(err),
      ...(sticky ? {} : { life: 5000 }),
    });
  }

  return { success, info, stickyInfo, error, errorMessage };
}

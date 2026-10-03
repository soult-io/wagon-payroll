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

const PAST_YEAR_FALLBACK =
  "This payroll's pay date is in a year that has ended. Wagon Payroll can't record a payroll in a past year yet, so nothing was issued. If that's the date you paid your team, keep it. Don't change it. Keep your own record of the payment and make sure it's included in that year's payroll tax filings.";

/** PAY-193 (D9.4): the server's text names the pay date and the filed forms. */
const PERIOD_FILED_FALLBACK =
  "Nothing was issued. You've marked a tax return that covers this pay date as filed. If you really paid your team on that date, keep the date. Don't move it to get around this. Adding this payroll means correcting the filed return with a correction form, which Wagon Payroll doesn't prepare. Keep your own record of this payment and make the correction outside Wagon Payroll.";

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
  if (err.code === "past_pay_date_other_year") return serverMessage(err) ?? PAST_YEAR_FALLBACK;
  if (err.code === "pay_period_filed") return serverMessage(err) ?? PERIOD_FILED_FALLBACK;
  if (err.code === "worksheet_changed") return serverMessage(err) ?? WORKSHEET_CHANGED_FALLBACK;
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
  "past_pay_date_other_year",
  "pay_period_filed",
  "worksheet_changed",
  "invalid_w4_effective_date",
  "effective_date",
]);

export function useNotify() {
  const toast = useToast();

  function success(summary: string, detail?: string) {
    toast.add({ severity: "success", summary, detail, life: 3500 });
  }

  function info(summary: string, detail?: string) {
    toast.add({ severity: "info", summary, detail, life: 4000 });
  }

  /** Human message out of ApiError / Error / unknown. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: error-code mapping chain; a lookup table would hide ApiError precedence
  function errorMessage(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.status === 401) return "Your session expired — sign in again.";
      if (err.status === 403) return "You do not have access to that.";
      if (err.status === 404) return "Not found.";
      if (err.code === "duplicate_pending") return "A pending request of this type already exists.";
      if (err.code === "effective_date") return err.message;
      return payrollRunMessage(err) ?? w4WindowMessage(err) ?? err.message;
    }
    if (err instanceof Error) return err.message;
    return "Something went wrong.";
  }

  function error(err: unknown, summary = "Error") {
    const sticky = err instanceof ApiError && STICKY_ERROR_CODES.has(err.code);
    const pastYear =
      err instanceof ApiError &&
      (err.code === "past_pay_date_other_year" || err.code === "pay_period_filed");
    toast.add({
      severity: "error",
      summary: pastYear ? "Payroll not issued" : summary,
      detail: errorMessage(err),
      ...(sticky ? {} : { life: 5000 }),
    });
  }

  return { success, info, error, errorMessage };
}

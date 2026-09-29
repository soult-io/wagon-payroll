/**
 * Toast + error normalization (UX conventions: every mutation gets feedback).
 */

import { useToast } from "primevue/usetoast";
import { ApiError } from "../lib/api";

/**
 * Spec 26 (PAY-173) §5 copy for the payroll-run refusals. ytd_order_conflict
 * and past_pay_date_other_year keep the server text: it names the pay date
 * and ends with the spec sentence; the fallback is that sentence alone.
 */
const STALE_DRAFT_MESSAGE =
  "This draft is out of date. Something it depends on changed after it was created — for example another payroll was issued, or a tax table or W-4 was updated. Void this draft and generate it again to recalculate.";

function payrollRunMessage(err: ApiError): string | null {
  if (err.code === "stale_draft") return STALE_DRAFT_MESSAGE;
  if (err.code === "ytd_order_conflict") {
    return err.message.includes("Set the pay date")
      ? err.message
      : "Set the pay date to the date this payment is actually made.";
  }
  if (err.code === "past_pay_date_other_year") {
    return err.message.includes("Set the pay date")
      ? err.message
      : "Set the pay date to the actual payment date.";
  }
  return null;
}

/** 400 invalid_w4_effective_date: the allowed window (dates only) from the body. */
function w4WindowMessage(err: ApiError): string | null {
  if (err.code !== "invalid_w4_effective_date") return null;
  const allowed = err.body?.["window"] as { earliest?: string | null; latest?: string } | null;
  if (!allowed?.latest) return err.message;
  return allowed.earliest
    ? `This W-4 must take effect between ${allowed.earliest} and ${allowed.latest}.`
    : `This W-4 must take effect no later than ${allowed.latest}.`;
}

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
    toast.add({ severity: "error", summary, detail: errorMessage(err), life: 5000 });
  }

  return { success, info, error, errorMessage };
}

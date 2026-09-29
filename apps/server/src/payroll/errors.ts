/**
 * Payroll service error (leaf module: no imports), so pure modules such as
 * run-dates.ts can throw it without importing runs.ts.
 */
export class PayrollServiceError extends Error {
  constructor(
    public code:
      | "no_compensation"
      | "no_tax_config"
      | "run_not_found"
      | "invalid_transition"
      | "void_reason_required"
      | "unsupported_frequency"
      | "not_w2_employee"
      | "no_company"
      | "no_state_tax_config"
      | "futa_cap_exceeded"
      // Spec 26 (PAY-173)
      | "invalid_period"
      | "stale_draft"
      | "ytd_order_conflict"
      | "past_pay_date_other_year",
    message: string,
  ) {
    super(message);
  }
}

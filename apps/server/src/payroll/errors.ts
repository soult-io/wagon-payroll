/** PAY-193 L4: one state's server-rendered late-issue questions. */
export interface LateStateQuestions {
  jurisdiction: string;
  withholdingReturn: string;
  suiWageReport: string;
  annualReconciliation: string;
}

/** PAY-193 L4: the attestation in a late_payment_confirmation_required body. No amount. */
export interface LateAttestationBody {
  version: 1;
  text: string;
  stateQuestions: LateStateQuestions[];
}

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
      // PAY-193 (D9.4)
      | "pay_period_filed"
      // PAY-193 L4 (late issue)
      | "late_payment_confirmation_required"
      | "late_payment_incomplete"
      | "state_return_filed"
      | "late_payment_amount_mismatch"
      | "late_issue_not_supported",
    message: string,
    /**
     * Extra body fields (PAY-193 D9.3), spread into the error body before
     * error/message. Never an amount.
     */
    public details?: Readonly<Record<string, string | string[] | LateAttestationBody>>,
  ) {
    super(message);
  }
}

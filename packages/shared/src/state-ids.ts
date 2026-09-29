/**
 * Spec 24 (PAY-116) S24-D2 — the employer's state withholding account
 * number (W-2 box 15): format checks per state and the request schemas of
 * /api/admin/company/state-ids. Shared so the settings screen and the
 * server apply the same rules; the server is the authority.
 *
 * Checked states: spaces and dashes are stripped, then the digits must
 * match the state's pattern; the value is stored as those digits. Any other
 * state: free text, trimmed, 1–20 of [A-Za-z0-9 -], stored as trimmed.
 * Refusal messages are fixed text and never contain the value.
 */

import { z } from "zod";

interface StateIdRule {
  pattern: RegExp;
  /** Fixed refusal text (never the value). */
  message: string;
}

/**
 * Sources (state-local-payroll-sme review 2026-09-27): CA EDD employer
 * registration; NC NCDOR W-2 Format (rev 09-26-2025); MD Comptroller
 * (Central Registration number); IL IL-941 instructions; NY NYS-45-I (1/26).
 */
export const STATE_ID_RULES: Readonly<Record<string, StateIdRule>> = {
  CA: {
    pattern: /^\d{8}$/,
    message:
      "California account numbers have 8 digits. Use the employer payroll tax account number from EDD (California's Employment Development Department)",
  },
  NC: {
    pattern: /^\d{9}$/,
    message:
      'North Carolina withholding account IDs have 9 digits. "APPLIEDFOR" can\'t go on a W-2, so add the number once North Carolina sends it',
  },
  MD: {
    pattern: /^\d{8}$/,
    message:
      "Maryland Central Registration (CR) numbers have 8 digits. Don't use your 10-digit unemployment insurance number or your EIN",
  },
  IL: {
    pattern: /^\d{9}(\d{3})?$/,
    message:
      "Illinois account IDs are your 9-digit EIN, or your EIN followed by the 3-digit number Illinois gave you",
  },
  NY: {
    pattern: /^\d{9}(\d{2})?\d?$/,
    message:
      "New York withholding IDs are your 9-digit EIN plus any suffix New York gave you. Don't use your 7-digit unemployment insurance (UI) number",
  },
};

/** States whose ID defaults to the company EIN when none is entered (S24-D2). */
export const EIN_DEFAULT_STATES = ["IL", "NY"] as const;

/** Input hints per state shown next to the account number field (Spec 24 §9). */
export const STATE_ID_HINTS: Readonly<Record<string, string>> = {
  NY: "Use your New York withholding ID: your 9-digit EIN, plus any suffix New York gave you. Don't use your 7-digit unemployment insurance (UI) employer registration number.",
  IL: "Use your Illinois withholding account ID: your EIN, plus the 3-digit number if Illinois gave you one.",
  MD: "Use your 8-digit Maryland Central Registration (CR) number. Don't use your unemployment insurance number or your EIN.",
};

/** True when the state's ID is digits only (format-checked). */
export function isCheckedStateIdState(stateCode: string): boolean {
  return Object.hasOwn(STATE_ID_RULES, stateCode);
}

const FREE_TEXT = /^[A-Za-z0-9 -]{1,20}$/;
const FREE_TEXT_MESSAGE = "Account numbers can use 1 to 20 letters, digits, spaces or dashes";

export type StateIdResult = { ok: true; value: string } | { ok: false; message: string };

/** Normalize a typed state ID for `stateCode`, or say why it is refused. */
export function normalizeStateId(stateCode: string, raw: string): StateIdResult {
  const rule = Object.hasOwn(STATE_ID_RULES, stateCode) ? STATE_ID_RULES[stateCode] : undefined;
  if (rule) {
    const digits = raw.replace(/[\s-]/g, "");
    return rule.pattern.test(digits)
      ? { ok: true, value: digits }
      : { ok: false, message: rule.message };
  }
  const text = raw.trim();
  return FREE_TEXT.test(text)
    ? { ok: true, value: text }
    : { ok: false, message: FREE_TEXT_MESSAGE };
}

/** First and last tax year a state ID row may start (IDs are not used before 2026, S24-D5). */
export const STATE_ID_MIN_YEAR = 2026;
export const STATE_ID_MAX_YEAR = 2100;

const taxYear = z.number().int().min(STATE_ID_MIN_YEAR).max(STATE_ID_MAX_YEAR);
const stateCodeParam = z.string().regex(/^[A-Z]{2}$/);

/** `:stateCode` of PUT /api/admin/company/state-ids/:stateCode. */
export const stateIdPutParams = z.object({ stateCode: stateCodeParam });

/** `:stateCode/:fromTaxYear` of DELETE /api/admin/company/state-ids/:stateCode/:fromTaxYear. */
export const stateIdDeleteParams = z.object({
  stateCode: stateCodeParam,
  fromTaxYear: z
    .string()
    .regex(/^\d{4}$/)
    .transform(Number)
    .pipe(taxYear),
});

/** Body of PUT /api/admin/company/state-ids/:stateCode (the format check needs the state, see normalizeStateId). */
export const stateIdPutBody = z.strictObject({
  stateId: z.string().max(64),
  fromTaxYear: taxYear.default(STATE_ID_MIN_YEAR),
});

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
  CA: { pattern: /^\d{8}$/, message: "California account numbers are 8 digits" },
  NC: { pattern: /^\d{9}$/, message: "North Carolina withholding account IDs are 9 digits" },
  MD: { pattern: /^\d{8}$/, message: "Maryland Central Registration numbers are 8 digits" },
  IL: {
    pattern: /^\d{9}(\d{3})?$/,
    message: "Illinois account IDs are your 9-digit EIN, optionally followed by 3 digits",
  },
  NY: {
    pattern: /^\d{9}(\d{2})?\d?$/,
    message: "New York withholding IDs are your 9-digit EIN, plus any suffix New York gave you",
  },
};

/** States whose ID defaults to the company EIN when none is entered (S24-D2). */
export const EIN_DEFAULT_STATES = ["IL", "NY"] as const;

/** Input hint shown next to the New York field (Spec 24 §9). */
export const NY_STATE_ID_HINT =
  "Use your New York withholding ID (your EIN, plus any suffix New York gave you) — not your 7-digit UI employer registration number.";

const FREE_TEXT = /^[A-Za-z0-9 -]{1,20}$/;
const FREE_TEXT_MESSAGE = "Use 1 to 20 letters, digits, spaces or dashes";

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

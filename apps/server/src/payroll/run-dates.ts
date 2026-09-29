/**
 * Spec 26 (PAY-173) D1/D2: which date drives which lookup in run generation.
 *
 * Wages are taxed in the calendar year they are PAID (IRC 3402(a)(1),
 * 3121(a)(1), 3102(f), 3306(b)(1)), so tax tables, YTD windows and the W-4
 * next-year gate / exempt lapse follow the pay date. Certificates (W-4, state
 * elections) are selected as of min(period end, pay date). Compensation and
 * work state describe the services performed, so they stay on period start.
 *
 * Pure functions, no DB: one place defines the rule and the snapshot records
 * the result (inputs.resolution, template 1.3.0).
 */

import { PayrollServiceError, type Period } from "./runs.js";

export interface RunDates {
  /** The payment date. As-of for: tax tables (federal + state), YTD window, W-4 next-year gate and exempt lapse, residence. */
  payDate: string;
  /** = min(period.periodEnd, payDate). As-of for W-4 and state-election certificate selection (D3, D3a). */
  certificateAsOf: string;
  /** Calendar year of payDate. Federal tax_config/brackets year, state_tax_configs year, YTD year, FUTA cap year. */
  taxYear: number;
  /** = period.periodStart. As-of for: compensation (earned rate), work state (services performed). */
  earnedAsOf: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written as YYYY-MM-DD. */
export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export function runDates(period: Period): RunDates {
  for (const [name, value] of [
    ["periodStart", period.periodStart],
    ["periodEnd", period.periodEnd],
    ["payDate", period.payDate],
  ] as const) {
    if (!isIsoDate(value)) {
      throw new PayrollServiceError("invalid_period", `${name} is not a valid YYYY-MM-DD date`);
    }
  }
  if (period.periodEnd < period.periodStart) {
    throw new PayrollServiceError("invalid_period", "periodEnd is before periodStart");
  }
  // ISO dates compare correctly as strings.
  const certificateAsOf = period.periodEnd < period.payDate ? period.periodEnd : period.payDate;
  return {
    payDate: period.payDate,
    certificateAsOf,
    taxYear: Number(period.payDate.slice(0, 4)),
    earnedAsOf: period.periodStart,
  };
}

/** D2 ordering key of a run. selfRunId null = a new draft (sorts as id +∞). */
export interface YtdKey {
  payDate: string;
  periodStart: string;
  selfRunId: number | null;
}

/** SQL stand-in for "+∞" in the D2 key: the `serial` maximum. */
export const YTD_KEY_MAX_ID = 2147483647;

/**
 * Total order of D2: (pay_date, period_start, id), null id = +∞. Mirrors the
 * row comparison in resolvePriorYtd's SQL.
 */
export function compareYtdKey(a: YtdKey, b: YtdKey): number {
  if (a.payDate !== b.payDate) return a.payDate < b.payDate ? -1 : 1;
  if (a.periodStart !== b.periodStart) return a.periodStart < b.periodStart ? -1 : 1;
  const ai = a.selfRunId ?? YTD_KEY_MAX_ID;
  const bi = b.selfRunId ?? YTD_KEY_MAX_ID;
  return ai === bi ? 0 : ai < bi ? -1 : 1;
}

/**
 * The company's local calendar date (Spec 26 D9): the instant converted to
 * `timeZone` (APP_TZ), so the Dec 31 / Jan 1 check is not off by one against a
 * UTC server clock.
 */
export function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

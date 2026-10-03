/**
 * PAY-162: W-2 boxes 1–6 and W-3 totals in integer cents. Pure — no DB, no
 * clock, no config. Every amount is integer cents read from SQL numeric text
 * through `sumCents`; strings are produced only by `formatCents` at the API
 * and PDF edge (annual.ts, routes). Errors and issues never carry an amount.
 *
 * Box rules (per employee, issued runs paid in the calendar year):
 *   1 = gross pay; 2 = federal income tax withheld;
 *   3 = min(box 1, the year's Social Security wage base);
 *   4 = Social Security tax withheld (never recomputed);
 *   5 = box 1 (no cap); 6 = Medicare tax withheld, Additional Medicare included.
 * Box 3 = box 5 = box 1 holds only while the app has no pre-tax deductions
 * and no FICA-exempt wages.
 */

import { parseCents } from "@payroll/shared";

/** One employee-year's summed issued-run entries, as SQL numeric text. */
export interface W2Sums {
  gross_pay?: string;
  federal_withholding?: string;
  social_security?: string;
  medicare?: string;
}

export interface W2BoxesCents {
  box1Cents: number;
  box2Cents: number;
  box3Cents: number;
  box4Cents: number;
  box5Cents: number;
  box6Cents: number;
}

/** The year's federal rates/limits, read from tax_config as exact integers. */
export interface FicaParams {
  /** social_security_wage_cap in cents. */
  ssWageCapCents: number;
  /** social_security_rate × 100000 ("0.06200" → 6200). */
  ssRate5: number;
  /** medicare_rate × 100000 ("0.01450" → 1450). */
  medicareRate5: number;
  /** medicare_additional_rate × 100000 ("0.00900" → 900). */
  addlMedicareRate5: number;
  /** medicare_additional_threshold in cents ("200000.00" → 20000000). */
  addlMedicareThresholdCents: number;
}

export type W2IssueCode =
  | "internal_mismatch"
  | "negative_amount"
  | "box4_over_max"
  | "box4_without_box3"
  | "box6_without_box5"
  | "box4_off_rate"
  | "box6_off_rate"
  // Spec 24 (PAY-116): state lines (boxes 15–17).
  | "legacy_state_runs"
  | "missing_state_id"
  | "reconciliation_mismatch"
  | "local_boxes_pending"
  | "missing_state_id_zero_tax"
  | "legacy_runs_without_state"
  | "local_tax_md"
  | "local_tax_ny"
  | "exempt_reciprocity"
  | "ny_all_wages"
  | "period_spans_move";

/**
 * A W-2 check result: code and severity, plus (Spec 24) the state line it
 * belongs to, the move date (period_spans_move) or the legacy runs
 * (legacy_state_runs, the only issue with amounts; admin JSON only).
 * internal_mismatch and local_boxes_pending carry code and severity only.
 */
export interface W2Issue {
  code: W2IssueCode;
  severity: "block" | "warn" | "info";
  state?: string;
  runs?: { runPublicId: string; payDate: string; stateTax: string }[];
  date?: string;
}

export interface W3TotalsCents extends W2BoxesCents {
  employeeCount: number;
}

const DEFECT_MESSAGE = "annual figures: unreadable amount";

/** Fixed-message defect error. Never carries the input value. */
export class AnnualFiguresDefectError extends Error {
  constructor() {
    super(DEFECT_MESSAGE);
    this.name = "AnnualFiguresDefectError";
  }
}

/** SQL numeric text → integer cents; undefined → 0. Throws the fixed-message defect error. */
export function sumCents(text: string | undefined): number {
  if (text === undefined) return 0;
  try {
    return parseCents(text);
  } catch {
    throw new AnnualFiguresDefectError();
  }
}

const RATE_SCALE = 100_000;

/** numeric(6,5) rate text → integer (× 100000). Throws the fixed-message defect error. */
export function parseRate5(text: string): number {
  const m = /^(\d)(?:\.(\d{1,5}))?$/.exec(text);
  if (!m) throw new AnnualFiguresDefectError();
  return Number(m[1]) * RATE_SCALE + Number((m[2] ?? "").padEnd(5, "0"));
}

/**
 * round(cents × rate5 / 100000), half-up, computed in BigInt: the product
 * can exceed Number.MAX_SAFE_INTEGER at the top of the numeric(14,2) range.
 */
export function applyRate(cents: number, rate5: number): number {
  const product = BigInt(cents) * BigInt(rate5);
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const scale = BigInt(RATE_SCALE);
  let q = abs / scale;
  if ((abs % scale) * 2n >= scale) q += 1n;
  return Number(negative ? -q : q);
}

/** The box rules. Negative sums are carried as negative cents (checkW2Boxes blocks them). */
export function w2Boxes(sums: W2Sums, p: FicaParams): W2BoxesCents {
  const box1Cents = sumCents(sums.gross_pay);
  return {
    box1Cents,
    box2Cents: sumCents(sums.federal_withholding),
    box3Cents: Math.min(box1Cents, p.ssWageCapCents),
    box4Cents: sumCents(sums.social_security),
    box5Cents: box1Cents,
    box6Cents: sumCents(sums.medicare),
  };
}

const BOX_KEYS = [
  "box1Cents",
  "box2Cents",
  "box3Cents",
  "box4Cents",
  "box5Cents",
  "box6Cents",
] as const;

/**
 * Box 4 / box 6 reasonableness checks (PAY-162; iw2w3 box 4, Pub 15 §§12–13).
 * A negative box is the only issue reported (W-2 money boxes are unsigned).
 * Off-rate tolerance is ceil(runCount / 2) cents (per-paycheck rounding).
 * The box 6 expectation rounds each term separately, half-up:
 * applyRate(box5, medicare) + applyRate(max(0, box5 − threshold), additional)
 * (payroll-calc-auditor ruling, Form 8959 Part V).
 */
export function checkW2Boxes(b: W2BoxesCents, runCount: number, p: FicaParams): W2Issue[] {
  if (BOX_KEYS.some((k) => b[k] < 0)) return [{ code: "negative_amount", severity: "block" }];
  const issues: W2Issue[] = [];
  if (b.box4Cents > applyRate(p.ssWageCapCents, p.ssRate5)) {
    issues.push({ code: "box4_over_max", severity: "block" });
  }
  if (b.box4Cents > 0 && b.box3Cents === 0) {
    issues.push({ code: "box4_without_box3", severity: "block" });
  }
  if (b.box6Cents > 0 && b.box5Cents === 0) {
    issues.push({ code: "box6_without_box5", severity: "block" });
  }
  const tol = Math.ceil(runCount / 2);
  if (Math.abs(b.box4Cents - applyRate(b.box3Cents, p.ssRate5)) > tol) {
    issues.push({ code: "box4_off_rate", severity: "warn" });
  }
  const expected6 =
    applyRate(b.box5Cents, p.medicareRate5) +
    applyRate(Math.max(0, b.box5Cents - p.addlMedicareThresholdCents), p.addlMedicareRate5);
  if (Math.abs(b.box6Cents - expected6) > tol) {
    issues.push({ code: "box6_off_rate", severity: "warn" });
  }
  return issues;
}

/** W-3 box totals: exact integer sums over the W-2s. */
export function w3Totals(boxes: readonly W2BoxesCents[]): W3TotalsCents {
  const totals: W3TotalsCents = {
    box1Cents: 0,
    box2Cents: 0,
    box3Cents: 0,
    box4Cents: 0,
    box5Cents: 0,
    box6Cents: 0,
    employeeCount: boxes.length,
  };
  for (const b of boxes) {
    for (const k of BOX_KEYS) totals[k] += b[k];
  }
  // Never hand formatCents an unsafe total (its error message carries the value).
  if (BOX_KEYS.some((k) => !Number.isSafeInteger(totals[k]))) throw new AnnualFiguresDefectError();
  return totals;
}

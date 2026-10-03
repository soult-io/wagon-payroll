/**
 * PAY-193 auditor oracle (payroll-calc-auditor). Independent of
 * @payroll/engine: integer cents, half-up, from the published 2026 method.
 * Never import the engine here.
 *
 * Sources (read 2026-10-03):
 *  - FIT: Pub 15-T (2026), Worksheet 1A (Percentage Method Tables for
 *    Automated Payroll Systems), 2020+ Form W-4 with no Step 2/3/4 entries,
 *    line 1g $8,600 (single), monthly (Table 3: 12 periods). Annual table,
 *    STANDARD schedule, Single or Married Filing Separately:
 *      A        B        C            D
 *      0        7,500    0.00         0%
 *      7,500    19,900   0.00         10%
 *      19,900   57,900   1,240.00     12%
 *      57,900   113,200  5,800.00     22%
 *      113,200  209,275  17,966.00    24%
 *      209,275  263,725  41,024.00    32%
 *      263,725  648,100  58,448.00    35%
 *      648,100  -        192,979.25   37%
 *    2h = 2g / 12, rounded to the cent (half-up).
 *  - FICA: Pub 15 (2026) §9: Social Security 6.2% each, wage base $184,500;
 *    Medicare 1.45% each; Additional Medicare 0.9% (employee only) on wages
 *    over $200,000 paid in the calendar year.
 *  - FUTA: Pub 15 (2026) §14 / 2026 Form 940 instr.: 6.0% less the 5.4%
 *    credit = 0.6% of the first $7,000 per employee per year.
 *  - Illinois: Booklet IL-700-T (2026, effective 2026-01-01), automated
 *    formula: 0.0495 x (wages - (IL-W-4 line 1 allowances x $2,925 + line 2
 *    allowances x $1,000) / pay periods).
 *
 * Worked values (cross-checked with a Python decimal script, scratch only):
 *   gross 4,000.00/mo, no prior: 1c 48,000; 1i 39,400; 1,240 + 12% x 19,500 =
 *     3,580.00; /12 = 298.333 -> FIT 298.33; SS 248.00; Medicare 58.00;
 *     IL (4,000 - 243.75) x .0495 = 185.934375 -> 185.93; net 3,209.74;
 *     FUTA 24.00; federal deposit 298.33 + 2 x 248 + 2 x 58 = 910.33.
 *   gross 2,500.00/mo: FIT 118.33, SS 155.00, Medicare 36.25, IL 111.68,
 *     net 2,078.74, deposit 500.83.
 *   gross 16,000.00/mo: 1c 192,000; 1i 183,400; 17,966 + 24% x 70,200 =
 *     34,814.00; /12 = 2,901.1666 -> 2,901.17; IL 15,756.25 x .0495 =
 *     779.934375 -> 779.93; Medicare 232.00; SS 992.00 until the wage base:
 *     December after 176,000.00 YTD -> 8,500.00 taxable -> SS 527.00; net
 *     16,000 - 2,901.17 - 527.00 - 232.00 - 779.93 = 11,559.90. YTD after
 *     December 192,000.00 < 200,000: no Additional Medicare. FUTA: January
 *     42.00 (7,000 x .006), then 0.
 */

export type StateMode = "IL1" | "none";

export interface OracleRun {
  grossCents: number;
  fitCents: number;
  ssCents: number;
  ssWagesCents: number;
  medCents: number;
  medWagesCents: number;
  stateCents: number;
  netCents: number;
  futaCents: number;
  futaWagesCents: number;
}

/** Non-negative a / b rounded half-up, exact (BigInt). */
export function divHalfUp(a: bigint, b: bigint): number {
  if (a < 0n || b <= 0n) throw new Error("divHalfUp: negative or zero divisor");
  let q = a / b;
  if ((a % b) * 2n >= b) q += 1n;
  return Number(q);
}

/** Pub 15-T (2026) annual STANDARD Single rows, cents: [A, C, pct]. */
const SINGLE_2026: readonly [number, number, number][] = [
  [0, 0, 0],
  [750_000, 0, 10],
  [1_990_000, 124_000, 12],
  [5_790_000, 580_000, 22],
  [11_320_000, 1_796_600, 24],
  [20_927_500, 4_102_400, 32],
  [26_372_500, 5_844_800, 35],
  [64_810_000, 19_297_925, 37],
];
const LINE_1G_SINGLE_2026 = 860_000;

/** Worksheet 1A, single, no W-4 adjustments, `periods` per year. */
export function fit2026Single(grossCents: number, periods = 12): number {
  const line1c = grossCents * periods;
  const line1i = Math.max(0, line1c - LINE_1G_SINGLE_2026);
  let row = SINGLE_2026[0]!;
  for (const r of SINGLE_2026) if (line1i >= r[0]) row = r;
  const [a, c, pct] = row;
  // 2g in units of cents x 100: C x 100 + pct x (2a - A).
  const line2gUnits = BigInt(c) * 100n + BigInt(pct) * BigInt(line1i - a);
  return divHalfUp(line2gUnits, 100n * BigInt(periods));
}

const SS_WAGE_BASE_2026 = 18_450_000;
const ADDL_MEDICARE_THRESHOLD = 20_000_000;
const FUTA_WAGE_BASE = 700_000;

export function oracleRun2026(
  grossCents: number,
  priorYtdGrossCents = 0,
  state: StateMode = "IL1",
  periods = 12,
): OracleRun {
  const fitCents = fit2026Single(grossCents, periods);
  const ssWagesCents = Math.min(grossCents, Math.max(0, SS_WAGE_BASE_2026 - priorYtdGrossCents));
  const ssCents = divHalfUp(BigInt(ssWagesCents) * 62n, 1000n);
  const over = Math.max(
    0,
    priorYtdGrossCents + grossCents - Math.max(ADDL_MEDICARE_THRESHOLD, priorYtdGrossCents),
  );
  const medCents =
    divHalfUp(BigInt(grossCents) * 145n, 10_000n) + divHalfUp(BigInt(over) * 9n, 1000n);
  // IL-700-T: (wages x periods - 1 x 292,500) x 495 / (periods x 10,000).
  const stateCents =
    state === "IL1"
      ? divHalfUp(BigInt(grossCents * periods - 292_500) * 495n, BigInt(periods) * 10_000n)
      : 0;
  const futaWagesCents = Math.min(grossCents, Math.max(0, FUTA_WAGE_BASE - priorYtdGrossCents));
  const futaCents = divHalfUp(BigInt(futaWagesCents) * 6n, 1000n);
  return {
    grossCents,
    fitCents,
    ssCents,
    ssWagesCents,
    medCents,
    medWagesCents: grossCents,
    stateCents,
    netCents: grossCents - fitCents - ssCents - medCents - stateCents,
    futaCents,
    futaWagesCents,
  };
}

/** Monthly federal deposit share of a run: FIT + 2 x SS + 2 x Medicare. */
export function fedDepositCents(r: OracleRun): number {
  return r.fitCents + 2 * r.ssCents + 2 * r.medCents;
}

/** Entry amounts (cents) as payroll_entries categories, for seeded history runs. */
export function oracleEntries(r: OracleRun): Record<string, number> {
  return {
    gross_pay: r.grossCents,
    federal_withholding: r.fitCents,
    social_security: r.ssCents,
    medicare: r.medCents,
    state_withholding: r.stateCents,
    net_pay: r.netCents,
    employer_social_security: r.ssCents,
    employer_medicare: r.medCents,
    employer_futa: r.futaCents,
  };
}

/** A year of monthly runs at a fixed gross, months `from`..`to` (1-based, inclusive). */
export function oracleYear(
  grossCents: number,
  from: number,
  to: number,
  state: StateMode = "IL1",
): OracleRun[] {
  const runs: OracleRun[] = [];
  let ytd = 0;
  for (let m = from; m <= to; m += 1) {
    runs.push(oracleRun2026(grossCents, ytd, state));
    ytd += grossCents;
  }
  return runs;
}

export function sum(runs: readonly OracleRun[], key: keyof OracleRun): number {
  return runs.reduce((a, r) => a + r[key], 0);
}

/** Integer cents -> "1234.56". */
export function money(c: number): string {
  const sign = c < 0 ? "-" : "";
  const a = Math.abs(c);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

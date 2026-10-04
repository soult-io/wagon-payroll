/**
 * Spec 24 (PAY-116) PR-2 — payroll-calc-auditor oracle for W-2 boxes 15-17
 * and the W-3 state totals. Independent of the code under test: it imports
 * nothing from src/ and nothing from @payroll/engine. Integer cents only.
 *
 * Rules (each from its published source, tax year 2026):
 *  - Box 16 = state wages; box 17 = state income tax withheld, per state
 *    line (IRS 2026 General Instructions for Forms W-2 and W-3, "Boxes 15
 *    through 20"). The app has no pre-tax deductions, so state wages = gross
 *    pay of the issued runs whose frozen work state is that state (Spec 24
 *    R2, K5). Year = pay-date year (iw2w3: wages are reported when paid; R8).
 *  - New York: an employee with any NY run in the year reports ALL wages of
 *    the year in NY box 16 (NYS TSB-M-02(3)I; Spec 24 R3).
 *  - A state whose every run has kind 'none' (no income tax, e.g. TX) has
 *    no line (R4). 0.00 withheld in a state with income tax still prints a
 *    line (R4).
 *  - Two state lines per W-2; more lines go on additional W-2s (iw2w3 2026
 *    p.24 "prepare a second Form W-2"; R5). Line i -> form floor(i/2)+1,
 *    row (i%2)+1, lines in state-code order.
 *  - W-3 box c = number of W-2 forms (iw2w3 2026 p.25 "Box c"); boxes 16
 *    and 17 = one sum over every W-2 line (p.26 "Boxes 16 through 19");
 *    box 15 = the state when all lines are one state, "X" otherwise (p.26
 *    "Box 15"; R6).
 *  - Reconciliation (R9): per state, sum of box 17 = sum of
 *    state_withholding of the issued runs with that work state paid in the
 *    year.
 *  - FICA on each fixture run (so boxes 1-6 raise no PAY-162 issue): Social
 *    Security 6.2%, Medicare 1.45% (Pub 15 (2026) §§12-13; SSA 2026 wage
 *    base not reached by any fixture), per-run half-up rounding.
 */

import { createHash } from "node:crypto";

export const SS_RATE5 = 6_200; // 6.2% x 100000
export const MEDICARE_RATE5 = 1_450; // 1.45% x 100000

/** round(cents x rate5 / 100000), half-up, integers only. */
export function rateOf(cents: number, rate5: number): number {
  const p = BigInt(cents) * BigInt(rate5);
  let q = p / 100_000n;
  if ((p % 100_000n) * 2n >= 100_000n) q += 1n;
  return Number(q);
}

/** Integer cents -> "1234.56" (own formatter, never formatCents). */
export function money(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("oracle money: bad cents");
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  return `${whole}.${frac < 10 ? "0" : ""}${frac}`;
}

/** Signed integer cents -> "-50.00" / "12.34": fixture entry amounts only (refund runs). */
export function signedMoney(cents: number): string {
  return cents < 0 ? `-${money(-cents)}` : money(cents);
}

/** Last day of the month of an ISO date. */
export function monthEnd(isoMonth: string): string {
  const y = Number(isoMonth.slice(0, 4));
  const m = Number(isoMonth.slice(5, 7));
  const days = [
    31,
    y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return `${isoMonth.slice(0, 7)}-${String(days[m - 1]).padStart(2, "0")}`;
}

export type Kind = "none" | "flat" | "progressive";

/** One fixture run, as the auditor defines it (amounts in cents). */
export interface FxRun {
  payDate: string;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  /** undefined = no state_withholding entry at all. */
  swhCents?: number;
  fitCents: number;
  /** null = legacy run without inputs.state. */
  state: { workState: string; kind: Kind; exempt: boolean } | null;
  /** Present => written as snapshot inputs.locals verbatim. */
  locals?: unknown;
}

/** A monthly run for `month` (YYYY-MM), paid on the 25th unless `payDate` is given. */
export function monthly(
  month: string,
  state: FxRun["state"],
  swhCents: number | undefined,
  opts: { grossCents?: number; payDate?: string; fitCents?: number; locals?: unknown } = {},
): FxRun {
  const run: FxRun = {
    payDate: opts.payDate ?? `${month}-25`,
    periodStart: `${month}-01`,
    periodEnd: monthEnd(`${month}-01`),
    grossCents: opts.grossCents ?? 500_000,
    fitCents: opts.fitCents ?? 50_000,
    state,
  };
  if (swhCents !== undefined) run.swhCents = swhCents;
  if ("locals" in opts) run.locals = opts.locals;
  return run;
}

export function st(workState: string, kind: Kind = "progressive", exempt = false) {
  return { workState, kind, exempt };
}

/** "2026-01" .. "2026-12" for months a..b (1-based, inclusive). */
export function months(year: number, a: number, b: number): string[] {
  const out: string[] = [];
  for (let m = a; m <= b; m++) out.push(`${year}-${String(m).padStart(2, "0")}`);
  return out;
}

/** Entry amounts (cents) the fixture writes for one run. */
export function entriesOf(r: FxRun): Record<string, number> {
  const e: Record<string, number> = {
    gross_pay: r.grossCents,
    federal_withholding: r.fitCents,
    social_security: rateOf(r.grossCents, SS_RATE5),
    medicare: rateOf(r.grossCents, MEDICARE_RATE5),
  };
  if (r.swhCents !== undefined) e.state_withholding = r.swhCents;
  return e;
}

export interface ExpBoxes {
  box1: number;
  box2: number;
  box3: number;
  box4: number;
  box5: number;
  box6: number;
}

/** W-2 boxes 1-6 of the runs paid in `year` (no fixture reaches the SS wage base). */
export function expBoxes(runs: readonly FxRun[], year: number): ExpBoxes {
  const inYear = runs.filter((r) => r.payDate.startsWith(`${year}-`));
  let box1 = 0;
  let box2 = 0;
  let box4 = 0;
  let box6 = 0;
  for (const r of inYear) {
    const e = entriesOf(r);
    box1 += e.gross_pay ?? 0;
    box2 += e.federal_withholding ?? 0;
    box4 += e.social_security ?? 0;
    box6 += e.medicare ?? 0;
  }
  return { box1, box2, box3: box1, box4, box5: box1, box6 };
}

export interface ExpLine {
  state: string;
  box16: number | null;
  box17: number | null;
  form: number;
  row: 1 | 2;
}

/** Expected state lines (R2-R5) for one employee-year. */
export function expLines(runs: readonly FxRun[], year: number): ExpLine[] {
  const inYear = runs.filter((r) => r.payDate.startsWith(`${year}-`));
  const box1 = expBoxes(runs, year).box1;
  const byState = new Map<string, FxRun[]>();
  for (const r of inYear) {
    if (r.state === null) continue;
    const list = byState.get(r.state.workState) ?? [];
    list.push(r);
    byState.set(r.state.workState, list);
  }
  const codes = [...byState.keys()]
    .filter((s) => !(byState.get(s) ?? []).every((r) => r.state?.kind === "none"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return codes.map((state, i) => {
    const list = byState.get(state) ?? [];
    const gross = list.reduce((s, r) => s + r.grossCents, 0);
    const tax = list.reduce((s, r) => s + (r.swhCents ?? 0), 0);
    return {
      state,
      box16: state === "NY" ? box1 : gross,
      box17: tax,
      form: Math.floor(i / 2) + 1,
      row: ((i % 2) + 1) as 1 | 2,
    };
  });
}

export function expFormCount(lines: readonly ExpLine[]): number {
  return Math.max(1, Math.ceil(lines.length / 2));
}

/** The admin list row's state lines as the API prints them. */
export function apiLines(
  lines: readonly ExpLine[],
  source: Record<string, "entered" | "ein_default" | null>,
) {
  return lines.map((l) => ({
    state: l.state,
    box16: l.box16 === null ? null : money(l.box16),
    box17: l.box17 === null ? null : money(l.box17),
    form: l.form,
    row: l.row,
    stateIdSource: source[l.state] ?? null,
  }));
}

/** The six box strings as the list/worksheet print them. */
export function boxStrings(b: ExpBoxes) {
  return {
    box1Wages: money(b.box1),
    box2FederalWithheld: money(b.box2),
    box3SsWages: money(b.box3),
    box4SsTax: money(b.box4),
    box5MedicareWages: money(b.box5),
    box6MedicareTax: money(b.box6),
  };
}

export interface ExpEmployee {
  runs: FxRun[];
  /** Lines override (S1 null row); default expLines(runs, year). */
  lines?: ExpLine[];
  blocked?: boolean;
}

type StateAcc = { lines: number; b16: number; b17: number; runs: number };

/** Add one employee's printed lines to the per-state accumulator; returns its box 16/17 sums. */
function addLines(per: Map<string, StateAcc>, lines: readonly ExpLine[]): [number, number] {
  let w16 = 0;
  let w17 = 0;
  for (const l of lines) {
    w16 += l.box16 ?? 0;
    w17 += l.box17 ?? 0;
    const p = per.get(l.state) ?? { lines: 0, b16: 0, b17: 0, runs: 0 };
    p.lines += 1;
    p.b16 += l.box16 ?? 0;
    p.b17 += l.box17 ?? 0;
    per.set(l.state, p);
  }
  return [w16, w17];
}

/** R9 source: state_withholding of the issued runs with a work state, paid in `year`. */
function addRunWithholding(per: Map<string, StateAcc>, runs: readonly FxRun[], year: number): void {
  for (const r of runs) {
    if (!r.payDate.startsWith(`${year}-`) || r.state === null) continue;
    const p = per.get(r.state.workState);
    if (p) p.runs += r.swhCents ?? 0;
  }
}

/**
 * Expected W-3 worksheet (years >= 2026, Spec 24 §7). `runWithholding`
 * per state is the auditor's own sum of state_withholding over every issued
 * run with that work state paid in the year (R9 source).
 */
export function expW3(year: number, emps: readonly ExpEmployee[]) {
  const totals = { box1: 0, box2: 0, box3: 0, box4: 0, box5: 0, box6: 0 };
  let forms = 0;
  let w16 = 0;
  let w17 = 0;
  const per = new Map<string, StateAcc>();
  for (const e of emps) {
    const b = expBoxes(e.runs, year);
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += b[k];
    const lines = e.lines ?? expLines(e.runs, year);
    forms += expFormCount(lines);
    const [a16, a17] = addLines(per, lines);
    w16 += a16;
    w17 += a17;
    addRunWithholding(per, e.runs, year);
  }
  const codes = [...per.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    form: "w2_w3",
    year,
    employeeCount: emps.length,
    box1Wages: money(totals.box1),
    box2FederalWithheld: money(totals.box2),
    box3SsWages: money(totals.box3),
    box4SsTax: money(totals.box4),
    box5MedicareWages: money(totals.box5),
    box6MedicareTax: money(totals.box6),
    w2FormCount: forms,
    box15State: codes.length === 0 ? null : codes.length === 1 ? codes[0] : "X",
    box16StateWages: money(w16),
    box17StateTax: money(w17),
    states: codes.map((state) => {
      const p = per.get(state) as StateAcc;
      return {
        state,
        w2Lines: p.lines,
        box16: money(p.b16),
        box17: money(p.b17),
        runWithholding: money(p.runs),
        attributedLegacy: "0.00",
        reconciled: p.b17 === p.runs,
      };
    }),
    blockedEmployees: emps.filter((e) => e.blocked === true).length,
  };
}

/**
 * The auditor's own canonical SHA-256 (sorted keys, compact JSON) — the
 * documented worksheet_hash / furnishing-hash construction, re-implemented
 * here so expected hashes do not come from the code under test.
 */
export function canonicalSha(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v !== null && typeof v === "object") {
      const keys = Object.keys(v as Record<string, unknown>).sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      const out: Record<string, unknown> = {};
      for (const k of keys) out[k] = canon((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return createHash("sha256")
    .update(JSON.stringify(canon(value)))
    .digest("hex");
}

/** Furnishing hash v1 (PAY-206): boxes 1-6 only. */
export function hashV1(employeeId: number, taxYear: number, b: ExpBoxes): string {
  return canonicalSha({
    v: 1,
    employeeId,
    taxYear,
    box1: b.box1,
    box2: b.box2,
    box3: b.box3,
    box4: b.box4,
    box5: b.box5,
    box6: b.box6,
  });
}

/** Furnishing hash v2 (PR-2 brief §4): boxes 1-6 + formCount + state lines + local lines. */
export function hashV2(
  employeeId: number,
  taxYear: number,
  b: ExpBoxes,
  formCount: number,
  lines: readonly ExpLine[],
): string {
  return canonicalSha({
    v: 2,
    employeeId,
    taxYear,
    box1: b.box1,
    box2: b.box2,
    box3: b.box3,
    box4: b.box4,
    box5: b.box5,
    box6: b.box6,
    formCount,
    stateLines: lines.map((l) => ({
      state: l.state,
      form: l.form,
      row: l.row,
      box16: l.box16,
      box17: l.box17,
    })),
    localLines: [],
  });
}

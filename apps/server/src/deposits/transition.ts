/**
 * PAY-91 — state deposit period transitions (spec 23 §3 D3/D6, §6).
 *
 * `planStateQuarter` decides, for ONE (state, year, quarter) unit, which live
 * deposit rows to supersede, update and insert so the unit matches the
 * state's schedule for that year:
 *   - quarterly → one live non-deposited quarter row, amount = max(0, ΣL − ΣD)
 *     (Case A merge, Case B credit for deposited months); once the quarter
 *     row is deposited, a shortfall row (next seq) only when ΣL − ΣD > 0;
 *   - monthly / no schedule → month rows, each month's remainder after
 *     deposits are applied earliest-first (Case C).
 * Deposited rows are never touched. Superseded rows are never passed in.
 *
 * Pure: no DB, no clock (`today` is an input), integer cents only. The sync
 * applies the plan; the detail API calls it read-only for credits and
 * overpayment, so the two can never disagree.
 */

import { periodStartFor, stateDueDateFor, type PeriodKind, type StateSchedule } from "./periods.js";

export type OpenStatus = "pending" | "overdue";
export type LiveStatus = OpenStatus | "deposited";

/** A live (non-superseded) deposit row of the unit. */
export interface LiveDepositRow {
  id: number;
  kind: PeriodKind;
  periodStart: string;
  cents: number;
  status: LiveStatus;
  dueDate: string;
  depositedOn: string | null;
  /** PAY-193 D9.6: 0 for a period's first row, N for its Nth shortfall row. */
  seq: number;
}

export interface QuarterInput {
  year: number;
  quarter: number; // 1-4
  /** The state's schedule for `year` (the pay-date year, R1), or null. */
  schedule: StateSchedule | null;
  /** Issued-run state withholding per month of the quarter, in cents. */
  liability: readonly [number, number, number];
  /** Live rows of the state with period_start inside the quarter. */
  live: readonly LiveDepositRow[];
  today: string;
}

/** A deposited row counted against a period. */
export interface DepositCredit {
  depositId: number;
  periodStart: string;
  periodKind: PeriodKind;
  depositedOn: string | null;
  /** The whole payment. */
  amountCents: number;
  /** The part of the payment counted toward the period (≤ amountCents). */
  appliedCents: number;
}

export interface RowUpdate {
  id: number;
  cents: number;
  dueDate: string;
  status: OpenStatus;
}

export interface RowInsert {
  kind: PeriodKind;
  periodStart: string;
  /** 1 + max(seq of the period's live rows), or 0 when it has none (D9.6). */
  seq: number;
  cents: number;
  dueDate: string;
  status: OpenStatus;
}

export interface QuarterPlan {
  supersede: number[];
  updates: RowUpdate[];
  inserts: RowInsert[];
  /** ΣL for the quarter. */
  liabilityCents: number;
  /** Deposits counted toward the quarter as a whole (earliest-first, capped at ΣL). */
  quarterCredits: DepositCredit[];
  /** Per month: deposits applied to that month by D6 step 2 (pool). */
  monthCredits: [DepositCredit[], DepositCredit[], DepositCredit[]];
  /** Σ live deposited amounts in the unit. */
  depositedCents: number;
  overpaidCents: number;
  /**
   * The row that carries the unit's "Overpaid" flag in lists (UX: one per
   * state-quarter, on its latest-period row); null when nothing is overpaid.
   */
  overpaidAnchorId: number | null;
}

export interface Allocation {
  /** Per month: what is still owed after every deposit is applied. */
  rem: [number, number, number];
  monthCredits: [DepositCredit[], DepositCredit[], DepositCredit[]];
  overpaidCents: number;
}

/**
 * Invalid planner input: a data error, never clamped. The sync skips the
 * unit and alerts admins; `code` is safe to log (no amounts, no PII).
 */
export class PlanInputError extends Error {
  constructor(
    public code: "invalid_amount" | "invalid_quarter" | "row_outside_unit",
    message: string,
  ) {
    super(message);
    this.name = "PlanInputError";
  }
}

function assertCents(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new PlanInputError(
      "invalid_amount",
      `planStateQuarter: ${what} must be non-negative integer cents, got ${n}`,
    );
  }
}

function monthIndex(periodStart: string, firstMonth: number): number {
  return Number(periodStart.slice(5, 7)) - firstMonth;
}

function byPeriod(a: LiveDepositRow, b: LiveDepositRow): number {
  if (a.periodStart !== b.periodStart) return a.periodStart < b.periodStart ? -1 : 1;
  if (a.kind !== b.kind) return a.kind === "month" ? -1 : 1;
  return a.id - b.id;
}

function credit(row: LiveDepositRow, appliedCents: number): DepositCredit {
  return {
    depositId: row.id,
    periodStart: row.periodStart,
    periodKind: row.kind,
    depositedOn: row.depositedOn,
    amountCents: row.cents,
    appliedCents,
  };
}

/** Deposited-month total per month of the unit (D6 `own[m]`). */
function ownByMonth(deposited: readonly LiveDepositRow[], firstMonth: number): number[] {
  const own = [0, 0, 0];
  for (const d of deposited) {
    if (d.kind !== "month") continue;
    const m = monthIndex(d.periodStart, firstMonth);
    own[m] = (own[m] ?? 0) + d.cents;
  }
  return own;
}

interface PoolSource {
  row: LiveDepositRow;
  cents: number;
}

/**
 * A month's excess (own − L, if positive), attributed to its deposited month
 * rows latest-first (the earlier rows are taken as paying the month itself).
 */
function excessSources(
  deposited: readonly LiveDepositRow[],
  firstMonth: number,
  m: number,
  excessCents: number,
): PoolSource[] {
  const rows = deposited
    .filter((d) => d.kind === "month" && monthIndex(d.periodStart, firstMonth) === m)
    .sort(byPeriod)
    .reverse();
  const parts: PoolSource[] = [];
  let excess = excessCents;
  for (const d of rows) {
    if (excess === 0) break;
    const part = Math.min(excess, d.cents);
    parts.push({ row: d, cents: part });
    excess -= part;
  }
  return parts.reverse();
}

/** D6 step 2 pool, in order: the quarter payment(s), then each month's excess. */
function poolSources(
  liability: readonly [number, number, number],
  deposited: readonly LiveDepositRow[],
  own: readonly number[],
  firstMonth: number,
): PoolSource[] {
  const sources: PoolSource[] = [...deposited]
    .filter((d) => d.kind === "quarter")
    .sort(byPeriod)
    .map((row) => ({ row, cents: row.cents }));
  for (let m = 0; m < 3; m += 1) {
    const excess = Math.max(0, (own[m] ?? 0) - liability[m]!);
    sources.push(...excessSources(deposited, firstMonth, m, excess));
  }
  return sources;
}

function addCredit(credits: DepositCredit[], row: LiveDepositRow, cents: number): void {
  const existing = credits.find((c) => c.depositId === row.id);
  if (existing) existing.appliedCents += cents;
  else credits.push(credit(row, cents));
}

/**
 * D6 allocation. Each deposited month row pays its own month first; the
 * deposited quarter row plus every month's excess form a pool applied to the
 * remaining need in month order (earliest-first). What is left is overpaid.
 */
export function allocate(
  liability: readonly [number, number, number],
  deposited: readonly LiveDepositRow[],
  firstMonth: number,
): Allocation {
  const own = ownByMonth(deposited, firstMonth);
  const sources = poolSources(liability, deposited, own, firstMonth);
  const rem: [number, number, number] = [0, 0, 0];
  const monthCredits: [DepositCredit[], DepositCredit[], DepositCredit[]] = [[], [], []];
  for (let m = 0; m < 3; m += 1) {
    let left = Math.max(0, liability[m]! - (own[m] ?? 0));
    for (const src of sources) {
      if (left === 0) break;
      const take = Math.min(left, src.cents);
      if (take === 0) continue;
      addCredit(monthCredits[m]!, src.row, take);
      src.cents -= take;
      left -= take;
    }
    rem[m] = left;
  }
  const overpaidCents = sources.reduce((a, s) => a + s.cents, 0);
  return { rem, monthCredits, overpaidCents };
}

/** D5: a 0.00 row has nothing to pay and never goes overdue. */
function statusOf(dueDate: string, cents: number, today: string): OpenStatus {
  if (cents === 0) return "pending";
  return dueDate < today ? "overdue" : "pending";
}

function validate(input: QuarterInput, firstMonth: number): void {
  const { year, quarter, liability, live } = input;
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    throw new PlanInputError(
      "invalid_quarter",
      `planStateQuarter: quarter must be 1-4, got ${quarter}`,
    );
  }
  for (const [m, l] of liability.entries()) assertCents(l, `liability[${m}]`);
  for (const r of live) {
    assertCents(r.cents, `row ${r.id} amount`);
    const m = monthIndex(r.periodStart, firstMonth);
    if (r.periodStart.slice(0, 4) !== String(year) || m < 0 || m > 2) {
      throw new PlanInputError(
        "row_outside_unit",
        `planStateQuarter: row ${r.id} (${r.periodStart}) is outside the unit`,
      );
    }
  }
}

/** Deposits counted toward the quarter as a whole: earliest-first, capped at ΣL. */
function quarterCreditsFor(dep: readonly LiveDepositRow[], liabilityCents: number) {
  const credits: DepositCredit[] = [];
  let cap = liabilityCents;
  for (const d of [...dep].sort(byPeriod)) {
    const applied = Math.min(cap, d.cents);
    cap -= applied;
    credits.push(credit(d, applied));
  }
  return credits;
}

interface Changes {
  supersede: number[];
  updates: RowUpdate[];
  inserts: RowInsert[];
}

interface Ctx {
  input: QuarterInput;
  firstMonth: number;
  dep: LiveDepositRow[];
  open: LiveDepositRow[];
  out: Changes;
}

/** Set an open row to (cents, due, status) — recorded only if a field differs. */
function setRow(ctx: Ctx, row: LiveDepositRow, cents: number, dueDate: string): void {
  const status = statusOf(dueDate, cents, ctx.input.today);
  if (row.cents !== cents || row.dueDate !== dueDate || row.status !== status) {
    ctx.out.updates.push({ id: row.id, cents, dueDate, status });
  }
}

/**
 * Next seq for a period, given that period's live rows: 1 + max(seq), or 0
 * when it has none (D9.6). Shared by the federal sync and the state planner.
 */
export function nextSeq(rows: readonly { seq: number }[]): number {
  let next = 0;
  for (const r of rows) next = Math.max(next, r.seq + 1);
  return next;
}

function insertRow(
  ctx: Ctx,
  kind: PeriodKind,
  periodStart: string,
  cents: number,
  dueDate: string,
) {
  const status = statusOf(dueDate, cents, ctx.input.today);
  const seq = nextSeq(
    ctx.input.live.filter((r) => r.kind === kind && r.periodStart === periodStart),
  );
  ctx.out.inserts.push({ kind, periodStart, seq, cents, dueDate, status });
}

/** Quarterly schedule: one live non-deposited quarter row, no open month rows. */
function planQuarterly(ctx: Ctx, schedule: StateSchedule, liabilityCents: number): void {
  const { dep, open, out, input } = ctx;
  for (const r of open) if (r.kind === "month") out.supersede.push(r.id);
  const [target, ...extra] = open.filter((r) => r.kind === "quarter").sort(byPeriod);
  const quarterPaid = dep.some((r) => r.kind === "quarter");
  if (liabilityCents === 0 && dep.length === 0 && open.length === 0) return;
  for (const r of extra) out.supersede.push(r.id); // defensive: one open quarter row
  const depositedCents = dep.reduce((a, r) => a + r.cents, 0);
  const cents = Math.max(0, liabilityCents - depositedCents);
  const quarterStart = periodStartFor(input.year, ctx.firstMonth);
  const dueDate = stateDueDateFor(schedule, input.year, quarterStart);
  if (target) setRow(ctx, target, cents, dueDate);
  // PAY-193 D9.6: a paid quarter gets a shortfall row only for an amount > 0.
  else if (!quarterPaid || cents > 0) insertRow(ctx, "quarter", quarterStart, cents, dueDate);
}

/** Monthly schedule or no schedule: month rows carry each month's remainder. */
function planMonthly(ctx: Ctx, rem: readonly number[]): void {
  const { open, out, input } = ctx;
  for (const r of open) if (r.kind === "quarter") out.supersede.push(r.id);
  for (let m = 0; m < 3; m += 1) {
    const start = periodStartFor(input.year, ctx.firstMonth + m);
    const cents = rem[m] ?? 0;
    const dueDate = stateDueDateFor(input.schedule, input.year, start);
    const [row, ...extra] = open
      .filter((r) => r.kind === "month" && r.periodStart === start)
      .sort(byPeriod);
    for (const r of extra) out.supersede.push(r.id);
    // PAY-193 D9.6: rem[m] already nets deposits, so a deposited month with
    // more owed gets a shortfall row (seq = 1 + max live seq).
    if (row) setRow(ctx, row, cents, dueDate);
    else if (cents > 0) insertRow(ctx, "month", start, cents, dueDate);
  }
}

/** Last month a row covers, as "YYYY-MM" (a quarter row covers its third month). */
function coversThrough(r: LiveDepositRow): string {
  const month = Number(r.periodStart.slice(5, 7));
  const last = r.kind === "quarter" ? Math.ceil(month / 3) * 3 : month;
  return `${r.periodStart.slice(0, 4)}-${String(last).padStart(2, "0")}`;
}

/**
 * The latest-period live row of a unit: covers the latest month; on a tie an
 * open row beats a deposited one (so "Overpaid" never sits next to a
 * "Deposited" chip while another row exists), then a quarter row, then the
 * newest id.
 */
/** Sort key: latest month covered, then open before deposited, then quarter, then newest id. */
function anchorKey(r: LiveDepositRow): string {
  const open = r.status === "deposited" ? "0" : "1";
  const kind = r.kind === "quarter" ? "1" : "0";
  return `${coversThrough(r)}|${open}|${kind}|${String(r.id).padStart(12, "0")}`;
}

export function overpaidAnchor(live: readonly LiveDepositRow[]): number | null {
  let best: LiveDepositRow | null = null;
  for (const r of live) if (!best || anchorKey(r) > anchorKey(best)) best = r;
  return best?.id ?? null;
}

export function planStateQuarter(input: QuarterInput): QuarterPlan {
  const firstMonth = (input.quarter - 1) * 3 + 1;
  validate(input, firstMonth);
  const { liability, live, schedule } = input;
  const liabilityCents = liability[0] + liability[1] + liability[2];
  const dep = live.filter((r) => r.status === "deposited");
  const open = live.filter((r) => r.status !== "deposited");
  const alloc = allocate(liability, dep, firstMonth);
  const ctx: Ctx = {
    input,
    firstMonth,
    dep,
    open,
    out: { supersede: [], updates: [], inserts: [] },
  };
  if (schedule?.frequency === "quarterly") planQuarterly(ctx, schedule, liabilityCents);
  else planMonthly(ctx, alloc.rem);
  return {
    ...ctx.out,
    liabilityCents,
    quarterCredits: quarterCreditsFor(dep, liabilityCents),
    monthCredits: alloc.monthCredits,
    depositedCents: dep.reduce((a, r) => a + r.cents, 0),
    overpaidCents: alloc.overpaidCents,
    overpaidAnchorId: alloc.overpaidCents > 0 ? overpaidAnchor(live) : null,
  };
}

/** The kind a unit's rows take under a schedule (moved from periodKindForDeposit). */
export function periodKindFor(
  jurisdiction: string,
  schedule: Pick<StateSchedule, "frequency"> | null,
): PeriodKind {
  if (jurisdiction === "federal") return "month";
  return schedule?.frequency === "quarterly" ? "quarter" : "month";
}

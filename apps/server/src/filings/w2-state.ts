/**
 * Spec 24 (PAY-116) S24-D1: the W-2 state-line planner (boxes 15–17) for one
 * employee-year. Pure — no DB, no clock, no config, no Number() of money, no
 * localeCompare. Integer cents in, integer cents out; strings come only from
 * formatCents (the legacy_state_runs list, admin JSON only). Never throws: a
 * box-1 mismatch or an unreadable amount becomes one internal_mismatch issue.
 *
 * Rules (Spec 24 §2 R2–R7, K2, K3, S24-D3, S24-D8):
 *  - effective state = workState ?? attributions[runPublicId] ?? null.
 *  - Null state, tax > 0 → one legacy_state_runs block (lines still computed);
 *    null state, tax = 0 → skipped, plus legacy_runs_without_state warn when
 *    the employee has a run with a state that year.
 *  - A state whose every run has kind 'none' has no line.
 *  - box 16 = Σ gross, box 17 = Σ state tax; NY box 16 = box 1 (R3).
 *  - Lines in state-code order; line i → form floor(i/2)+1, row (i%2)+1.
 *  - Any run with locals (or locals the loader could not read) → one
 *    local_boxes_pending block; plan locals are always [] here.
 */

import { formatCents } from "@payroll/shared";
import type { W2Issue } from "./w2-boxes.js";

/** First tax year whose W-2s carry state lines (S24-D5). */
export const STATE_BOXES_FROM_YEAR = 2026;

/** One local tax on a run. Shape fixed by Spec 25 S25-D15; filled by PAY-168. */
export interface W2RunLocal {
  code: string;
  category: "local_resident_withholding" | "local_work_withholding";
  cents: number;
}

/** One issued run, pay date in the year. */
export interface W2StateRun {
  runPublicId: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  /** Snapshot inputs.state.workState. */
  workState: string | null;
  /** Snapshot inputs.state.kind. */
  stateKind: "none" | "flat" | "progressive" | null;
  /** Snapshot inputs.state.election.exempt ?? false. */
  exempt: boolean;
  grossCents: number;
  /** 0 when the run has no state_withholding entry. */
  stateTaxCents: number;
  /** [] for every run without snapshot inputs.locals. */
  locals: W2RunLocal[];
  /** The loader found inputs.locals present but not an empty array it could read. */
  localsUnreadable: boolean;
}

export type W2StateIdSource = "entered" | "ein_default" | null;

export interface W2StateInput {
  taxYear: number;
  runs: W2StateRun[];
  /** The value printed as box 1 (PAY-162 integer cents). */
  box1Cents: number;
  /** Availability only, never the value. */
  stateIds: Record<string, W2StateIdSource>;
  /** runPublicId → state (S24-D7; {} until PR-5). */
  attributions: Record<string, string>;
  /** Work-state rows, for period_spans_move only. */
  moves: { effectiveFrom: string }[];
}

export interface W2StateLine {
  state: string;
  /** null = box 16 empty on this row (second row of the same state, S1). */
  box16Cents: number | null;
  box17Cents: number | null;
  form: number;
  row: 1 | 2;
}

/** Local line (boxes 18–20). Always [] from Spec 24; PAY-171 fills it. */
export interface W2LocalLine {
  state: string;
  locality: "NYC" | "YONKERS";
  box18Cents: number;
  box19Cents: number;
  row: 1 | 2;
  form: number;
}

export interface W2StatePlan {
  lines: W2StateLine[];
  locals: W2LocalLine[];
  formCount: number;
  issues: W2Issue[];
}

const RECIPROCITY_STATES = ["IL", "MD"];

/** Code-point order (localeCompare is banned). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The plan of a W-2 whose figures cannot be trusted (S24-D1 step 4, M3). */
function mismatchPlan(): W2StatePlan {
  return {
    lines: [],
    locals: [],
    formCount: 1,
    issues: [{ code: "internal_mismatch", severity: "block" }],
  };
}

/** Every amount is a safe integer and the runs' gross adds up to box 1. */
function amountsConsistent(input: W2StateInput): boolean {
  if (!Number.isSafeInteger(input.box1Cents)) return false;
  let gross = 0;
  for (const r of input.runs) {
    if (!Number.isSafeInteger(r.grossCents) || !Number.isSafeInteger(r.stateTaxCents)) {
      return false;
    }
    gross += r.grossCents;
  }
  return Number.isSafeInteger(gross) && gross === input.box1Cents;
}

interface StateGroup {
  runs: { run: W2StateRun; kind: W2StateRun["stateKind"] }[];
}

interface Grouped {
  byState: Map<string, StateGroup>;
  legacyWithTax: W2StateRun[];
  legacyWithoutTax: number;
}

function groupRuns(input: W2StateInput): Grouped {
  const byState = new Map<string, StateGroup>();
  const legacyWithTax: W2StateRun[] = [];
  let legacyWithoutTax = 0;
  for (const run of input.runs) {
    const attributed = run.workState === null ? input.attributions[run.runPublicId] : undefined;
    const state = run.workState ?? attributed ?? null;
    if (state === null) {
      if (run.stateTaxCents > 0) legacyWithTax.push(run);
      else legacyWithoutTax += 1;
      continue;
    }
    const group = byState.get(state) ?? { runs: [] };
    // An attributed legacy run counts as a state with income tax (kind null).
    group.runs.push({ run, kind: run.workState === null ? null : run.stateKind });
    byState.set(state, group);
  }
  return { byState, legacyWithTax, legacyWithoutTax };
}

function yearIssues(input: W2StateInput, g: Grouped): W2Issue[] {
  const issues: W2Issue[] = [];
  if (input.runs.some((r) => r.localsUnreadable || r.locals.length > 0)) {
    issues.push({ code: "local_boxes_pending", severity: "block" });
  }
  if (g.legacyWithTax.length > 0) {
    const runs = [...g.legacyWithTax]
      .sort((a, b) => cmp(a.payDate, b.payDate) || cmp(a.runPublicId, b.runPublicId))
      .map((r) => ({
        runPublicId: r.runPublicId,
        payDate: r.payDate,
        stateTax: formatCents(r.stateTaxCents),
      }));
    issues.push({ code: "legacy_state_runs", severity: "block", runs });
  }
  if (g.legacyWithoutTax > 0 && g.byState.size > 0) {
    issues.push({ code: "legacy_runs_without_state", severity: "warn" });
  }
  return issues;
}

/** Distinct move dates, ascending. */
function moveDates(input: W2StateInput): string[] {
  return [...new Set(input.moves.map((m) => m.effectiveFrom))].sort(cmp);
}

function lineIssues(
  line: W2StateLine,
  group: StateGroup,
  input: W2StateInput,
  moves: readonly string[],
): W2Issue[] {
  const { state } = line;
  const issues: W2Issue[] = [];
  const source = input.stateIds[state] ?? null;
  if (source === null) {
    issues.push(
      (line.box17Cents ?? 0) > 0
        ? { code: "missing_state_id", severity: "block", state }
        : { code: "missing_state_id_zero_tax", severity: "warn", state },
    );
  }
  if (state === "MD") issues.push({ code: "local_tax_md", severity: "warn", state });
  if (state === "NY") {
    issues.push({ code: "local_tax_ny", severity: "warn", state });
    issues.push({ code: "ny_all_wages", severity: "info", state });
  }
  if (RECIPROCITY_STATES.includes(state) && group.runs.some((r) => r.run.exempt)) {
    issues.push({ code: "exempt_reciprocity", severity: "warn", state });
  }
  for (const date of moves) {
    const inside = group.runs.some((r) => r.run.periodStart < date && date <= r.run.periodEnd);
    if (inside) issues.push({ code: "period_spans_move", severity: "info", state, date });
  }
  return issues;
}

/** Plan one employee-year's W-2 state lines. Pure; never throws. */
export function planW2StateLines(input: W2StateInput): W2StatePlan {
  try {
    if (!amountsConsistent(input)) return mismatchPlan();
    const g = groupRuns(input);
    const states = [...g.byState.keys()]
      .filter((s) => !(g.byState.get(s)?.runs ?? []).every((r) => r.kind === "none"))
      .sort(cmp);
    const lines: W2StateLine[] = states.map((state, i) => {
      const runs = g.byState.get(state)?.runs ?? [];
      let gross = 0;
      let tax = 0;
      for (const { run } of runs) {
        gross += run.grossCents;
        tax += run.stateTaxCents;
      }
      return {
        state,
        box16Cents: state === "NY" ? input.box1Cents : gross,
        box17Cents: tax,
        form: Math.floor(i / 2) + 1,
        row: i % 2 === 0 ? 1 : 2,
      };
    });
    const moves = moveDates(input);
    const issues = yearIssues(input, g);
    for (const line of lines) {
      const group = g.byState.get(line.state) ?? { runs: [] };
      issues.push(...lineIssues(line, group, input, moves));
    }
    return {
      lines,
      locals: [],
      formCount: Math.max(1, Math.ceil(lines.length / 2)),
      issues,
    };
  } catch {
    // Defensive: a malformed input never escapes as an exception (M3).
    return mismatchPlan();
  }
}

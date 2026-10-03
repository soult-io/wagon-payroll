/**
 * Spec 24 (PAY-116) PR-2: the planner's inputs, read-only. One row per issued
 * run of a W-2 employee paid in the year: the frozen work state, kind and
 * exempt flag from the run snapshot (live state_tax_configs are never read,
 * W16), the locals marker, and the run's gross pay and state withholding as
 * numeric text read with parseCents. Only the snapshot paths below are
 * selected — never the whole snapshot (it carries names and amounts).
 *
 * Never throws on data: an unreadable amount becomes NaN, which the planner
 * turns into internal_mismatch (M3); an inputs.locals that is present and is
 * anything but an empty array, or a well-formed array of locals, marks the run
 * (S24-D8). Errors and logs never carry a value.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { employees, employeeWorkStates, payrollEntries, payrollRuns } from "@payroll/db";
import { parseCents } from "@payroll/shared";
import type { Db } from "../db.js";
import type { W2RunLocal, W2StateRun } from "./w2-state.js";

/** Money text → cents; null → 0; unreadable → NaN (planner: internal_mismatch). */
function centsOrNaN(text: string | null): number {
  if (text === null) return 0;
  try {
    return parseCents(text);
  } catch {
    return Number.NaN;
  }
}

const LOCAL_CATEGORIES = ["local_resident_withholding", "local_work_withholding"];

function isLocal(v: unknown): v is W2RunLocal {
  if (v === null || typeof v !== "object") return false;
  const l = v as Record<string, unknown>;
  return (
    typeof l.code === "string" &&
    typeof l.category === "string" &&
    LOCAL_CATEGORIES.includes(l.category) &&
    typeof l.cents === "number" &&
    Number.isSafeInteger(l.cents)
  );
}

/** inputs.locals as jsonb text (SQL NULL = absent) → the run's locals fields. */
export function readLocals(text: string | null): {
  locals: W2RunLocal[];
  localsUnreadable: boolean;
} {
  if (text === null) return { locals: [], localsUnreadable: false };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { locals: [], localsUnreadable: true };
  }
  if (!Array.isArray(value)) return { locals: [], localsUnreadable: true };
  if (value.length === 0) return { locals: [], localsUnreadable: false };
  if (!value.every(isLocal)) return { locals: [], localsUnreadable: true };
  return {
    locals: value.map((l) => ({ code: l.code, category: l.category, cents: l.cents })),
    localsUnreadable: false,
  };
}

function kindOf(text: string | null): W2StateRun["stateKind"] {
  return text === "none" || text === "flat" || text === "progressive" ? text : null;
}

/** The issued runs of W-2 employees paid in `year`, by employee. */
export async function loadW2StateRuns(
  db: Pick<Db, "select">,
  year: number,
): Promise<Map<number, W2StateRun[]>> {
  const snap = payrollRuns.runSnapshot;
  const rows = await db
    .select({
      employeeId: payrollRuns.employeeId,
      runPublicId: payrollRuns.publicId,
      payDate: payrollRuns.payDate,
      periodStart: payrollRuns.periodStart,
      periodEnd: payrollRuns.periodEnd,
      workState: sql<string | null>`(${snap} #>> '{inputs,state,workState}')`,
      kind: sql<string | null>`(${snap} #>> '{inputs,state,kind}')`,
      exempt: sql<string | null>`(${snap} #>> '{inputs,state,election,exempt}')`,
      locals: sql<string | null>`((${snap} #> '{inputs,locals}')::text)`,
      gross: sql<
        string | null
      >`(sum(${payrollEntries.amount}) filter (where ${payrollEntries.category} = 'gross_pay'))::numeric(14,2)::text`,
      stateTax: sql<
        string | null
      >`(sum(${payrollEntries.amount}) filter (where ${payrollEntries.category} = 'state_withholding'))::numeric(14,2)::text`,
    })
    .from(payrollRuns)
    .innerJoin(employees, eq(payrollRuns.employeeId, employees.id))
    .leftJoin(payrollEntries, eq(payrollEntries.runId, payrollRuns.id))
    .where(
      and(
        eq(payrollRuns.status, "issued"),
        eq(employees.employmentType, "w2"),
        sql`${payrollRuns.payDate} >= ${`${year}-01-01`}`,
        sql`${payrollRuns.payDate} <= ${`${year}-12-31`}`,
      ),
    )
    .groupBy(payrollRuns.id);
  const out = new Map<number, W2StateRun[]>();
  for (const r of rows) {
    const run: W2StateRun = {
      runPublicId: r.runPublicId,
      payDate: r.payDate,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      workState: r.workState,
      stateKind: kindOf(r.kind),
      exempt: r.exempt === "true",
      grossCents: centsOrNaN(r.gross),
      stateTaxCents: centsOrNaN(r.stateTax),
      ...readLocals(r.locals),
    };
    const list = out.get(r.employeeId) ?? [];
    list.push(run);
    out.set(r.employeeId, list);
  }
  return out;
}

/** Work-state start dates per employee (period_spans_move, info only). */
export async function loadWorkStateMoves(
  db: Pick<Db, "select">,
  employeeIds: readonly number[],
): Promise<Map<number, { effectiveFrom: string }[]>> {
  const out = new Map<number, { effectiveFrom: string }[]>();
  if (employeeIds.length === 0) return out;
  const rows = await db
    .select({
      employeeId: employeeWorkStates.employeeId,
      effectiveFrom: employeeWorkStates.effectiveFrom,
    })
    .from(employeeWorkStates)
    .where(inArray(employeeWorkStates.employeeId, [...employeeIds]));
  for (const r of rows) {
    const list = out.get(r.employeeId) ?? [];
    list.push({ effectiveFrom: r.effectiveFrom });
    out.set(r.employeeId, list);
  }
  return out;
}

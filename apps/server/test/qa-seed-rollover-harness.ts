/**
 * PAY-81 shared helpers for qa-seed-rollover*.test.ts (payroll-calc-auditor;
 * test-only). Boots PGlite WITH btree_gist so migration 0001 applies in full
 * and `compensation_no_overlap` is live — the constraint CI skipped, which is
 * why the year-rollover overlap went unseen.
 */

import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import {
  compensation,
  payrollEntries,
  payrollRuns,
  stateTaxConfigs,
  taxConfig,
  taxDeposits,
  taxFilings,
  w4Elections,
} from "@payroll/db";
import { seedQaDataset, type QaSeedSummary } from "../src/qa/seed-qa.js";
import { createTestApp, type TestContext } from "./helpers.js";

/** The summary fields the brief §4.2 adds (QaSeedSummary.payroll). */
export interface RolloverPayroll {
  issued: number;
  existing: number;
  draftCreated: boolean;
  latestCoveredYear: number;
  historyThrough: string | null;
  draftPeriod: string | null;
}

export type SeedOutcome =
  | { ok: true; summary: QaSeedSummary; payroll: RolloverPayroll }
  | { ok: false; error: string };

/** createTestApp with the overlap constraint live. */
export async function bootWithOverlapConstraint(): Promise<TestContext> {
  return createTestApp({}, { extensions: { btree_gist } });
}

/** Run the seed at `today`; never throws (the outcome carries the message). */
export async function seedAt(
  t: TestContext,
  today: string,
  config = t.config,
): Promise<SeedOutcome> {
  try {
    const summary = await seedQaDataset({ db: t.db, auth: t.auth, config }, { today });
    return { ok: true, summary, payroll: summary.payroll as unknown as RolloverPayroll };
  } catch (err) {
    // drizzle wraps driver errors as "Failed query: …"; the cause carries the
    // Postgres message (e.g. the compensation_no_overlap violation).
    const message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : null;
    return { ok: false, error: cause ? `${message.split("\n")[0]} | cause: ${cause}` : message };
  }
}

/** Unwrap a successful outcome, failing the test with the seed's own message. */
export function mustSeed(outcome: SeedOutcome | undefined): {
  summary: QaSeedSummary;
  payroll: RolloverPayroll;
} {
  if (!outcome) throw new Error("seed did not run");
  if (!outcome.ok) throw new Error(`seed rejected: ${outcome.error}`);
  return outcome;
}

/** "YYYY-MM" list, inclusive. */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export interface BobRow {
  id: number;
  periodAmount: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export async function bobRows(t: TestContext, bobId: number): Promise<BobRow[]> {
  return t.db
    .select({
      id: compensation.id,
      periodAmount: compensation.periodAmount,
      effectiveFrom: compensation.effectiveFrom,
      effectiveTo: compensation.effectiveTo,
    })
    .from(compensation)
    .where(eq(compensation.employeeId, bobId))
    .orderBy(asc(compensation.effectiveFrom));
}

/** Bob's rows without ids (shape only). */
export function bobShape(rows: BobRow[]): Omit<BobRow, "id">[] {
  return rows.map(({ id: _id, ...rest }) => rest);
}

/** Today's live-QA rows (L = 2026): the ladder must reproduce exactly these. */
export const BOB_ROWS_2026 = [
  { periodAmount: "3800.00", effectiveFrom: "2024-11-01", effectiveTo: "2026-07-01" },
  { periodAmount: "4200.00", effectiveFrom: "2026-07-01", effectiveTo: null },
];

/** Ladder at L = 2027: 3800 + 400 × (Y − 2025) on Y-07-01. */
export const BOB_ROWS_2027 = [
  { periodAmount: "3800.00", effectiveFrom: "2024-11-01", effectiveTo: "2026-07-01" },
  { periodAmount: "4200.00", effectiveFrom: "2026-07-01", effectiveTo: "2027-07-01" },
  { periodAmount: "4600.00", effectiveFrom: "2027-07-01", effectiveTo: null },
];

export interface RunFacts {
  /** "YYYY-MM" of issued runs per persona, sorted. */
  issuedMonths: { ada: string[]; bob: string[]; carol: string[] };
  /** Non-issued, non-void runs as "persona:YYYY-MM". */
  open: string[];
  /** Latest pay date over all non-void persona runs. */
  maxPayDate: string | null;
}

export async function runFacts(
  t: TestContext,
  w2: { ada: number; bob: number; carol: number },
): Promise<RunFacts> {
  const rows = await t.db
    .select({
      employeeId: payrollRuns.employeeId,
      periodStart: payrollRuns.periodStart,
      payDate: payrollRuns.payDate,
      status: payrollRuns.status,
    })
    .from(payrollRuns)
    .where(inArray(payrollRuns.employeeId, [w2.ada, w2.bob, w2.carol]));
  const name = (id: number) => (id === w2.ada ? "ada" : id === w2.bob ? "bob" : "carol");
  const issuedMonths = { ada: [] as string[], bob: [] as string[], carol: [] as string[] };
  const open: string[] = [];
  let maxPayDate: string | null = null;
  for (const r of rows) {
    if (r.status === "void") continue;
    if (maxPayDate === null || r.payDate > maxPayDate) maxPayDate = r.payDate;
    if (r.status === "issued") issuedMonths[name(r.employeeId)].push(r.periodStart.slice(0, 7));
    else open.push(`${name(r.employeeId)}:${r.periodStart.slice(0, 7)}`);
  }
  for (const k of ["ada", "bob", "carol"] as const) issuedMonths[k].sort();
  open.sort();
  return { issuedMonths, open, maxPayDate };
}

export async function w4Years(t: TestContext, employeeId: number): Promise<number[]> {
  const rows = await t.db
    .select({ taxYear: w4Elections.taxYear })
    .from(w4Elections)
    .where(eq(w4Elections.employeeId, employeeId));
  return [...new Set(rows.map((r) => r.taxYear))].sort((a, b) => a - b);
}

/** Tax-table years present: federal tax_config, and the max state_tax_configs year. */
export async function tableYears(
  t: TestContext,
): Promise<{ federal: number[]; maxStateYear: number | null }> {
  const fed = await t.db
    .select({ y: taxConfig.taxYear })
    .from(taxConfig)
    .where(eq(taxConfig.jurisdiction, "federal"));
  const [st] = await t.db
    .select({ y: sql<number | null>`max(${stateTaxConfigs.taxYear})` })
    .from(stateTaxConfigs);
  return {
    federal: fed.map((r) => r.y).sort((a, b) => a - b),
    maxStateYear: st?.y ?? null,
  };
}

/** Row counts the idempotency checks compare. */
export async function rowCounts(t: TestContext): Promise<Record<string, number>> {
  const n = async (table: PgTable): Promise<number> => {
    const [row] = await t.db.select({ n: sql<number>`count(*)::int` }).from(table);
    return row?.n ?? 0;
  };
  return {
    runs: await n(payrollRuns),
    entries: await n(payrollEntries),
    compensation: await n(compensation),
    w4: await n(w4Elections),
    deposits: await n(taxDeposits),
    filings: await n(taxFilings),
  };
}

/** One run's status by persona + month. */
export async function runStatus(
  t: TestContext,
  employeeId: number,
  month: string,
): Promise<{ publicId: string; status: string } | null> {
  const [row] = await t.db
    .select({ publicId: payrollRuns.publicId, status: payrollRuns.status })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.employeeId, employeeId), eq(payrollRuns.periodStart, `${month}-01`)))
    .limit(1);
  return row ?? null;
}

/** True when `compensation_no_overlap` exists in the catalog. */
export async function overlapConstraintLive(t: TestContext): Promise<boolean> {
  const res = await t.pglite.query<{ n: number }>(
    "select count(*)::int as n from pg_constraint where conname = 'compensation_no_overlap'",
  );
  return (res.rows[0]?.n ?? 0) === 1;
}

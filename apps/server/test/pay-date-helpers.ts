/**
 * Spec 26 (PAY-173) scenario helpers — shared by the pay-date-basis suites.
 * Synthetic people only ("Ada Test" etc.); money in integer cents, converted
 * to NUMERIC strings with formatCents and back with parseCents (never
 * Math.round(x * 100)). Expected values in the suites are recomputed by the
 * payroll-calc-auditor from the published method, not from the engine.
 */

import { eq } from "drizzle-orm";
import { vi } from "vitest";
import {
  company,
  compensation,
  employeeWorkStates,
  employees,
  payrollEntries,
  payrollRuns,
  stateWithholdingElections,
  w4Elections,
} from "@payroll/db";
import { formatCents, parseCents } from "@payroll/shared";
import { generateDraft, transitionRun, type Period, type RunRow } from "../src/payroll/runs.js";
import type { TestContext } from "./helpers.js";

export type Category =
  | "gross_pay"
  | "federal_withholding"
  | "social_security"
  | "medicare"
  | "state_withholding"
  | "net_pay"
  | "employer_social_security"
  | "employer_medicare"
  | "employer_futa";

/** A JS number in dollars (snapshot field) or a NUMERIC string → integer cents. */
export function cents(v: number | string): number {
  return parseCents(typeof v === "number" ? v.toFixed(2) : v);
}

export function monthPeriod(ym: string, payDate: string): Period {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { periodStart: `${ym}-01`, periodEnd: `${ym}-${String(last).padStart(2, "0")}`, payDate };
}

let seq = 0;
/** Synthetic W-2 employee with a monthly salary (cents) from 2024-01-01. */
export async function createEmployee(
  t: TestContext,
  grossCents: number,
  label = "Ada Test",
): Promise<number> {
  seq += 1;
  const c = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({ companyId: c[0]!.id, legalName: `${label} ${seq}`, hireDate: "2024-01-01" })
    .returning();
  const id = rows[0]!.id;
  await t.db.insert(compensation).values({
    employeeId: id,
    periodAmount: formatCents(grossCents),
    frequency: "monthly",
    effectiveFrom: "2024-01-01",
  });
  return id;
}

/** Issued history run inserted directly with stated entry sums (cents). */
export async function insertIssuedHistoryRun(
  t: TestContext,
  employeeId: number,
  period: Period,
  entries: Partial<Record<Category, number>>,
  opts: { createdBy?: string; runSnapshot?: unknown; status?: string } = {},
): Promise<RunRow> {
  const rows = await t.db
    .insert(payrollRuns)
    .values({
      employeeId,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      payDate: period.payDate,
      status: opts.status ?? "issued",
      runSnapshot: opts.runSnapshot ?? {},
      createdBy: opts.createdBy ?? "test-history",
    })
    .returning();
  const run = rows[0]!;
  for (const [category, amount] of Object.entries(entries)) {
    await t.db
      .insert(payrollEntries)
      .values({ runId: run.id, category, amount: formatCents(amount as number) });
  }
  return run;
}

export async function insertW4(
  t: TestContext,
  employeeId: number,
  w: {
    taxYear: number;
    effectiveFrom: string;
    filedDate: string;
    federalExempt?: boolean;
    renewalDeadline?: string | null;
    extraWithholdingCents?: number;
  },
): Promise<void> {
  await t.db.insert(w4Elections).values({
    employeeId,
    taxYear: w.taxYear,
    filingStatus: "single",
    federalExempt: w.federalExempt ?? false,
    extraWithholding: formatCents(w.extraWithholdingCents ?? 0),
    effectiveFrom: w.effectiveFrom,
    filedDate: w.filedDate,
    renewalDeadline: w.renewalDeadline ?? null,
  });
}

export async function insertWorkState(
  t: TestContext,
  employeeId: number,
  stateCode: string,
  effectiveFrom: string,
  effectiveTo: string | null = null,
): Promise<void> {
  await t.db
    .insert(employeeWorkStates)
    .values({ employeeId, stateCode, effectiveFrom, effectiveTo });
}

export async function insertStateElection(
  t: TestContext,
  employeeId: number,
  e: { stateCode: string; allowances: number; effectiveFrom: string; filedDate: string },
): Promise<void> {
  await t.db.insert(stateWithholdingElections).values({ employeeId, ...e });
}

export function gen(t: TestContext, employeeId: number, period: Period) {
  return generateDraft({ db: t.db, config: t.config }, { employeeId, period, createdBy: "test" });
}

/** Entry amounts of a run, in cents, keyed by category. */
export async function entriesOf(t: TestContext, runId: number): Promise<Record<string, number>> {
  const rows = await t.db.select().from(payrollEntries).where(eq(payrollEntries.runId, runId));
  return Object.fromEntries(rows.map((r) => [r.category, parseCents(r.amount)]));
}

export async function runRow(t: TestContext, runId: number): Promise<RunRow> {
  const rows = await t.db.select().from(payrollRuns).where(eq(payrollRuns.id, runId));
  return rows[0]!;
}

/** Loose view of the snapshot fields the suites read (1.3.0 adds `resolution`). */
export interface SnapView {
  inputs: {
    priorYtdGross: number;
    payDate: string;
    taxConfig: { taxYear: number; socialSecurityWageCap: number; standardDeduction: number };
    w4: { effectiveFrom: string; federalExempt: boolean; extraWithholding: number } | null;
    state?: {
      workState: string;
      taxYear: number;
      election: { effectiveFrom: string; allowances: number } | null;
    };
    resolution?: {
      basis: string;
      payDate: string;
      certificateAsOf: string;
      earnedAsOf: string;
      taxYear: number;
      ytd: {
        year: number;
        before: { payDate: string; periodStart: string; runId: number | null };
        runs: string[];
      };
    };
  };
  ytd?: { gross: number; stateWithholding: number; socialSecurity: number };
  templateVersion: string;
}
export function snap(run: RunRow): SnapView {
  return run.runSnapshot as SnapView;
}

/**
 * Run `fn` with the wall clock fixed at `instant` (ISO, UTC). Only `Date` is
 * faked, so whatever way the code reads "now" (new Date(), Date.now(), an
 * injected clock defaulting to either) sees the instant (D9).
 */
export async function withClock<T>(instant: string, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(instant) });
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

export function transition(
  t: TestContext,
  publicId: string,
  action: "approve" | "issue" | "void",
  reason?: string,
) {
  return transitionRun(
    { db: t.db, config: t.config },
    { publicId, action, actorId: "test-admin", ...(reason ? { reason } : {}) },
  );
}

/** Approve + issue under a fixed "now" (every issuing test injects today, D9). */
export async function approveAndIssue(
  t: TestContext,
  publicId: string,
  instant: string,
): Promise<RunRow> {
  return withClock(instant, async () => {
    await transition(t, publicId, "approve");
    return transition(t, publicId, "issue");
  });
}

/** Settle a promise into { ok, value } | { ok: false, code, message }. */
export async function settle<T>(
  p: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; code: string | undefined; message: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    const e = err as { code?: string; message?: string; cause?: { message?: string } };
    return {
      ok: false,
      code: e.code,
      message: `${e.message ?? String(err)} ${e.cause?.message ?? ""}`,
    };
  }
}

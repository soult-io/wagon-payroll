/**
 * Spec 24 (PAY-116) PR-2 — payroll-calc-auditor integration harness for the
 * W-2 state-line suites (w2-state-*.test.ts). One fresh PGlite app per
 * scenario (isolated fixtures). Runs are direct inserts with literal
 * snapshots (as annual-forms.test.ts does), never generateDraft. Synthetic
 * data only.
 */

import { vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  company,
  companyStateIds,
  employees,
  employeeWorkStates,
  payrollEntries,
  payrollRuns,
  seedDatabase,
  type SeedDb,
  taxConfig,
  taxFilings,
} from "@payroll/db";
import { encryptField } from "../src/crypto/field-encryption.js";
import { snapshotHash } from "../src/payroll/snapshot.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";
import { entriesOf, type FxRun, money } from "./w2-state-oracle.js";

export const SYNTHETIC_EIN = "00-0000001";

export interface Env {
  t: TestContext;
  admin: Record<string, string>;
  companyId: number;
  close(): Promise<void>;
}

let seq = 0;

/** Boot a fresh app + admin session. `now` fakes Date for the whole scenario. */
export async function bootEnv(
  opts: { now?: string; logStream?: { write(msg: string): void } } = {},
): Promise<Env> {
  if (opts.now) vi.useFakeTimers({ toFake: ["Date"], now: new Date(opts.now) });
  const t = opts.logStream
    ? await createTestApp({ logLevel: "trace" }, { logStream: opts.logStream })
    : await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  seq += 1;
  const email = `w2s-admin-${seq}@test.dev`;
  await inviteAndOnboard(t, { email, role: "admin" });
  if (opts.now) vi.setSystemTime(new Date(Date.parse(opts.now) + 31_000));
  const admin = sessionHeader((await login(t, email, TEST_PASSWORD)).sessionCookie);
  const rows = await t.db.select({ id: company.id }).from(company).limit(1);
  return {
    t,
    admin,
    companyId: rows[0]?.id ?? 1,
    async close() {
      await t.close();
      if (opts.now) vi.useRealTimers();
    },
  };
}

/** A federal tax_config row for a year the seed does not carry (2027+). */
export async function federalConfig(env: Env, year: number): Promise<void> {
  await env.t.db
    .insert(taxConfig)
    .values({
      jurisdiction: "federal",
      taxYear: year,
      standardDeduction: "16100.00",
      socialSecurityRate: "0.06200",
      socialSecurityWageCap: "184500.00",
      medicareRate: "0.01450",
      medicareAdditionalRate: "0.00900",
      medicareAdditionalThreshold: "200000.00",
      stateWithholdingRate: "0",
      employerSocialSecurityRate: "0.06200",
      employerMedicareRate: "0.01450",
      futaRate: "0.00600",
      futaWageCap: "7000.00",
      sutaCreditRate: "0.05400",
    })
    .onConflictDoNothing();
}

export async function setEin(env: Env, ein: string | null): Promise<void> {
  await env.t.db
    .update(company)
    .set({ ein: ein === null ? null : encryptField(ein, env.t.config.encryptionKey) });
}

/** An entered box 15 ID (encrypted, as PR-1 stores it). */
export async function enterStateId(
  env: Env,
  stateCode: string,
  plain = "00000001",
  fromTaxYear = 2026,
): Promise<void> {
  await env.t.db.insert(companyStateIds).values({
    companyId: env.companyId,
    stateCode,
    fromTaxYear,
    stateId: encryptField(plain, env.t.config.encryptionKey),
    createdBy: "test",
  });
}

export async function createEmployee(
  env: Env,
  legalName: string,
  extra: { userId?: string; employmentType?: "w2" | "1099" } = {},
): Promise<number> {
  const rows = await env.t.db
    .insert(employees)
    .values({
      companyId: env.companyId,
      legalName,
      hireDate: "2024-01-01",
      ...(extra.userId ? { userId: extra.userId } : {}),
      ...(extra.employmentType ? { employmentType: extra.employmentType } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("employee insert failed");
  return row.id;
}

export async function workState(
  env: Env,
  employeeId: number,
  stateCode: string,
  effectiveFrom: string,
  effectiveTo: string | null = null,
): Promise<void> {
  await env.t.db
    .insert(employeeWorkStates)
    .values({ employeeId, stateCode, effectiveFrom, effectiveTo });
}

/** The literal snapshot of one fixture run. */
export function snapshotOf(r: FxRun): Record<string, unknown> {
  const year = Number(r.payDate.slice(0, 4));
  const inputs: Record<string, unknown> = {
    periodAmount: r.grossCents / 100,
    frequency: "monthly",
    periodsPerYear: 12,
    w4: null,
    taxConfig: {
      jurisdiction: "federal",
      taxYear: year,
      standardDeduction: 0,
      socialSecurityRate: 0.062,
      socialSecurityWageCap: 0,
      medicareRate: 0.0145,
      medicareAdditionalRate: 0.009,
      medicareAdditionalThreshold: 200000,
      stateWithholdingRate: 0,
      employerSocialSecurityRate: 0.062,
      employerMedicareRate: 0.0145,
      futaRate: 0.006,
      futaWageCap: 7000,
    },
    brackets: [],
    priorYtdGross: 0,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    payDate: r.payDate,
    company: { legalName: "Example Corp" },
    employee: { legalName: "Synthetic", preferredName: null },
  };
  if (r.state !== null) {
    inputs.state = {
      workState: r.state.workState,
      jurisdiction: r.state.workState,
      taxYear: year,
      kind: r.state.kind,
      flatRate: null,
      standardDeduction: null,
      standardDeductionAlt: null,
      altMinAllowances: null,
      lowIncomeExemption: null,
      lowIncomeExemptionAlt: null,
      allowanceDeduction: null,
      allowanceCredit: null,
      additionalAllowanceDeduction: null,
      election: {
        filingStatus: "single",
        allowances: 0,
        additionalAllowances: 0,
        extraWithholding: 0,
        exempt: r.state.exempt,
        effectiveFrom: "2024-01-01",
        filedDate: "2024-01-01",
      },
      brackets: [],
    };
  }
  if ("locals" in r) inputs.locals = r.locals;
  return {
    inputs,
    result: {
      grossPay: 0,
      federalWithholding: 0,
      socialSecurity: 0,
      medicare: 0,
      stateWithholding: 0,
      totalDeductions: 0,
      netPay: 0,
      employerSocialSecurity: 0,
      employerMedicare: 0,
      employerFUTA: 0,
      totalEmployerCost: 0,
      ytdGross: 0,
    },
    engineVersion: "test-direct-insert",
    templateVersion: "1.3.0",
  };
}

export interface InsertedRun {
  id: number;
  publicId: string;
  payDate: string;
}

/** Direct-insert one issued run with its entries. */
export async function insertRun(env: Env, employeeId: number, r: FxRun): Promise<InsertedRun> {
  const snapshot = snapshotOf(r);
  const inserted = await env.t.db
    .insert(payrollRuns)
    .values({
      employeeId,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      payDate: r.payDate,
      status: "issued",
      runSnapshot: snapshot,
      snapshotHash: snapshotHash(snapshot as never),
      createdBy: "test",
    })
    .returning();
  const run = inserted[0];
  if (!run) throw new Error("run insert failed");
  await env.t.db.insert(payrollEntries).values(
    Object.entries(entriesOf(r)).map(([category, cents]) => ({
      runId: run.id,
      category,
      amount: money(cents),
    })),
  );
  return { id: run.id, publicId: run.publicId, payDate: r.payDate };
}

export async function insertRuns(
  env: Env,
  employeeId: number,
  runs: readonly FxRun[],
): Promise<InsertedRun[]> {
  const out: InsertedRun[] = [];
  for (const r of runs) out.push(await insertRun(env, employeeId, r));
  return out;
}

/** Void an issued run (the bookkeeping update the immutability trigger allows). */
export async function voidRun(env: Env, runId: number): Promise<void> {
  await env.t.db
    .update(payrollRuns)
    .set({ status: "void", voidedAt: new Date(), voidReason: "test correction" })
    .where(eq(payrollRuns.id, runId));
}

export interface ListRow {
  employeeId: number;
  legalName: string;
  box1Wages: string | null;
  issues: unknown[];
  blocked: boolean;
  stateLines: unknown;
  localLines: unknown;
  formCount: unknown;
  corrected: boolean;
  correctionToFurnish: boolean;
  [k: string]: unknown;
}

export async function list(
  env: Env,
  year: number,
): Promise<{ status: number; body: string; json: { w2s: ListRow[]; yearIssues?: unknown } }> {
  const res = await env.t.app.inject({
    method: "GET",
    url: `/api/admin/annual-forms/w2?year=${year}`,
    headers: env.admin,
  });
  return { status: res.statusCode, body: res.body, json: res.json() };
}

export async function rowOf(env: Env, year: number, employeeId: number): Promise<ListRow> {
  const l = await list(env, year);
  if (l.status !== 200) throw new Error(`list ${year} -> ${l.status}`);
  const row = l.json.w2s.find((r) => r.employeeId === employeeId);
  if (!row) throw new Error(`no row for employee ${employeeId}`);
  return row;
}

/** The fields a state-line assertion compares. */
export function stateView(row: ListRow) {
  return {
    stateLines: row.stateLines,
    localLines: row.localLines,
    formCount: row.formCount,
    issues: row.issues,
    blocked: row.blocked,
  };
}

export async function w2w3Row(env: Env, year: number) {
  const rows = await env.t.db
    .select()
    .from(taxFilings)
    .where(
      and(eq(taxFilings.formType, "w2_w3"), eq(taxFilings.year, year), eq(taxFilings.quarter, 0)),
    );
  return rows[0];
}

export async function get(env: Env, url: string, headers: Record<string, string> = env.admin) {
  return env.t.app.inject({ method: "GET", url, headers });
}

/** An employee user with an active electronic-W-2 consent (employee PDF route). */
export async function consentedEmployee(
  env: Env,
  legalName: string,
): Promise<{ employeeId: number; session: Record<string, string> }> {
  seq += 1;
  const email = `w2s-emp-${seq}@test.dev`;
  const user = await inviteAndOnboard(env.t, { email, name: legalName });
  const employeeId = await createEmployee(env, legalName, { userId: user.userId });
  if (vi.isFakeTimers()) vi.setSystemTime(new Date(Date.now() + 31_000));
  const session = sessionHeader((await login(env.t, email, TEST_PASSWORD)).sessionCookie);
  const res = await env.t.app.inject({
    method: "POST",
    url: "/api/my/w2/consent",
    headers: session,
  });
  if (res.statusCode !== 200) throw new Error(`consent -> ${res.statusCode}`);
  return { employeeId, session };
}

/**
 * Timestamps are removed before amount scans: "...T10:15:32.591Z" can contain
 * a fixture amount (PAY-206 D12).
 */
const ISO_TS = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
export function scrubTimestamps(body: string): string {
  return body.replace(ISO_TS, "<ts>");
}

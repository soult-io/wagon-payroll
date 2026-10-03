/**
 * PAY-193 L4 test harness (payroll-calc-auditor). One PGlite app per test
 * file with an injectable wall clock (`setNow`), an admin session, a reset
 * that empties every table a late issue writes (so tests pass in any order),
 * synthetic employees, and the statement recorder used by the L1 lock tests.
 * Synthetic data only.
 */

import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  company,
  compensation,
  employeeWorkStates,
  employees,
  payrollEntries,
  payrollRuns,
  seedDatabase,
  stateWithholdingElections,
  type SeedDb,
} from "@payroll/db";
import { formatCents, parseCents } from "@payroll/shared";
import { inviteUser } from "../src/auth/users.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";
import { gen, insertIssuedHistoryRun, monthPeriod, type Category } from "./pay-date-helpers.js";
import { seedSyntheticFederal2027 } from "./fixtures/synthetic-2027.js";
import { oracleEntries, type OracleRun } from "./pay-193-oracle.js";

export interface L4Env {
  t: TestContext;
  adminId: string;
  admin: Record<string, string>;
  setNow: (iso: string) => void;
  logs: string[];
}

export async function bootL4(opts: { adminEmail: string; logLevel?: string }): Promise<L4Env> {
  let now = new Date("2026-06-01T10:00:00Z");
  const logs: string[] = [];
  const t = await createTestApp(
    { appTz: "Europe/Madrid", ...(opts.logLevel ? { logLevel: opts.logLevel } : {}) },
    {
      clock: () => now,
      ...(opts.logLevel ? { logStream: { write: (m: string) => void logs.push(m) } } : {}),
    },
  );
  await seedDatabase(t.db as unknown as SeedDb);
  await seedSyntheticFederal2027(t.db);
  const a = await inviteAndOnboard(t, { email: opts.adminEmail, role: "admin" });
  const admin = sessionHeader((await login(t, a.email, TEST_PASSWORD)).sessionCookie);
  return {
    t,
    adminId: a.userId,
    admin,
    setNow: (iso) => {
      now = new Date(iso);
    },
    logs,
  };
}

/** Empty everything a late issue reads or writes (employees and config stay). */
export async function resetL4(t: TestContext): Promise<void> {
  await t.pglite.exec(
    `TRUNCATE tax_deposits, tax_filings, payroll_entries, payroll_runs, email_outbox, audit_events RESTART IDENTITY CASCADE;
     DELETE FROM app_settings WHERE key = 'w2_available_notified_years';`,
  );
}

let empSeq = 0;
export interface Emp {
  id: number;
  userId: string | null;
}

/**
 * Synthetic monthly-salaried W-2 employee. `state`: work state from the hire
 * date. IL gets an IL-W-4 with 1 line-1 allowance; MD/AL get an exempt state
 * certificate (state withholding 0, so the federal oracle alone fixes net
 * pay); TX is kind 'none'. `withUser` links a (never-onboarded) login.
 */
export async function makeEmployee(
  t: TestContext,
  o: {
    grossCents: number;
    state?: "IL" | "MD" | "TX" | "AL" | null;
    withUser?: boolean;
    hireDate?: string;
    label?: string;
  },
): Promise<Emp> {
  empSeq += 1;
  const hire = o.hireDate ?? "2024-01-01";
  let userId: string | null = null;
  if (o.withUser) {
    const inv = await inviteUser(
      { auth: t.auth, db: t.db, config: t.config },
      {
        name: `L4 Worker ${empSeq}`,
        email: `l4-worker-${empSeq}-${Date.now()}@test.dev`,
        role: "employee",
      },
      null,
    );
    userId = inv.userId;
  }
  const c = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({
      companyId: c[0]!.id,
      legalName: `${o.label ?? "L4 Synthetic"} ${empSeq}`,
      hireDate: hire,
      ...(userId ? { userId } : {}),
    })
    .returning();
  const id = rows[0]!.id;
  await t.db.insert(compensation).values({
    employeeId: id,
    periodAmount: formatCents(o.grossCents),
    frequency: "monthly",
    effectiveFrom: hire,
  });
  if (o.state) {
    await t.db
      .insert(employeeWorkStates)
      .values({ employeeId: id, stateCode: o.state, effectiveFrom: hire, effectiveTo: null });
    if (o.state === "IL") {
      await t.db.insert(stateWithholdingElections).values({
        employeeId: id,
        stateCode: "IL",
        allowances: 1,
        effectiveFrom: hire,
        filedDate: hire,
      });
    } else if (o.state === "MD" || o.state === "AL") {
      await t.db.insert(stateWithholdingElections).values({
        employeeId: id,
        stateCode: o.state,
        allowances: 0,
        exempt: true,
        effectiveFrom: hire,
        filedDate: hire,
      });
    }
  }
  return { id, userId };
}

/** Engine-generated draft for month `ym` paid `payDate`; returns publicId + generation hash. */
export async function draft(
  t: TestContext,
  emp: Emp,
  ym: string,
  payDate: string,
): Promise<{ publicId: string; id: number; hash: string | null; snapshot: unknown }> {
  const { run } = await gen(t, emp.id, monthPeriod(ym, payDate));
  return { publicId: run.publicId, id: run.id, hash: run.snapshotHash, snapshot: run.runSnapshot };
}

/** Seed an ISSUED history run with the oracle's entries (never the engine's). */
export async function history(
  t: TestContext,
  emp: Emp,
  ym: string,
  payDate: string,
  r: OracleRun,
  workState: string | null,
): Promise<string> {
  const run = await insertIssuedHistoryRun(
    t,
    emp.id,
    monthPeriod(ym, payDate),
    oracleEntries(r) as Partial<Record<Category, number>>,
    { runSnapshot: workState ? { inputs: { state: { workState } } } : { inputs: {} } },
  );
  return run.publicId;
}

export async function approve(env: L4Env, publicId: string): Promise<void> {
  const res = await env.t.app.inject({
    method: "POST",
    url: `/api/admin/payroll-runs/${publicId}/approve`,
    headers: env.admin,
    payload: {},
  });
  if (res.statusCode !== 200) throw new Error(`approve ${res.statusCode}: ${res.body}`);
}

export interface Res {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}

export async function issue(env: L4Env, publicId: string, payload: unknown = {}): Promise<Res> {
  const res = await env.t.app.inject({
    method: "POST",
    url: `/api/admin/payroll-runs/${publicId}/issue`,
    headers: env.admin,
    payload: payload as Record<string, unknown>,
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown>, raw: res.body };
}

export interface StateAnswer {
  jurisdiction: string;
  withholdingReturnFiled: boolean;
  suiWageReportFiled: boolean;
  annualReconciliationFiled: boolean;
}

export function notFiled(jurisdiction: string): StateAnswer {
  return {
    jurisdiction,
    withholdingReturnFiled: false,
    suiWageReportFiled: false,
    annualReconciliationFiled: false,
  };
}

export function latePayment(netPayCents: number, stateReturns: StateAnswer[]) {
  return { latePayment: { attestationVersion: 1, netPayCents, stateReturns } };
}

export async function runStatus(t: TestContext, publicId: string): Promise<string> {
  const r = await t.db
    .select({ status: payrollRuns.status })
    .from(payrollRuns)
    .where(eq(payrollRuns.publicId, publicId))
    .limit(1);
  return r[0]!.status;
}

export async function runByPublicId(t: TestContext, publicId: string) {
  return (
    await t.db.select().from(payrollRuns).where(eq(payrollRuns.publicId, publicId)).limit(1)
  )[0]!;
}

/** The run's stored net_pay entry, in cents (used only where the oracle is not the subject). */
export async function storedNetPayCents(t: TestContext, publicId: string): Promise<number> {
  const run = await runByPublicId(t, publicId);
  const rows = await t.db
    .select({ amount: payrollEntries.amount })
    .from(payrollEntries)
    .where(and(eq(payrollEntries.runId, run.id), eq(payrollEntries.category, "net_pay")));
  return parseCents(rows[0]!.amount);
}

export async function audits(t: TestContext, action: string, entityId?: string) {
  const rows = await t.db
    .select()
    .from(auditEvents)
    .where(
      entityId
        ? and(eq(auditEvents.action, action), eq(auditEvents.entityId, entityId))
        : eq(auditEvents.action, action),
    )
    .orderBy(auditEvents.id);
  return rows;
}

// ---------------------------------------------------------------- statement recorder (from L1)

export interface Stmt {
  tx: number | null;
  text: string;
  params: unknown[];
}
type RawClient = { query: (text: string, params?: unknown[], opts?: unknown) => Promise<unknown> };

let recording: Stmt[] | null = null;
let txSeq = 0;
const installed = new WeakSet<object>();

export function installRecorder(t: TestContext): void {
  const pg = t.pglite as unknown as {
    query: (text: string, params?: unknown[], opts?: unknown) => Promise<unknown>;
    transaction: (fn: (client: RawClient) => Promise<unknown>) => Promise<unknown>;
  };
  if (installed.has(pg)) return;
  installed.add(pg);
  const origQuery = pg.query.bind(pg);
  const origTx = pg.transaction.bind(pg);
  pg.query = async (text, params, opts) => {
    if (recording) recording.push({ tx: null, text, params: params ?? [] });
    return origQuery(text, params, opts);
  };
  pg.transaction = async (fn) =>
    origTx(async (client) => {
      txSeq += 1;
      const id = txSeq;
      const wrapped = new Proxy(client as object, {
        get(target, prop) {
          if (prop === "query") {
            return async (text: string, params?: unknown[], opts?: unknown) => {
              if (recording) recording.push({ tx: id, text, params: params ?? [] });
              return (target as RawClient).query(text, params, opts);
            };
          }
          const v = Reflect.get(target, prop) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      return fn(wrapped as RawClient);
    });
}

export async function record<T>(fn: () => Promise<T>): Promise<{ value: T; stmts: Stmt[] }> {
  recording = [];
  try {
    const value = await fn();
    return { value, stmts: recording };
  } finally {
    recording = null;
  }
}

export type Label =
  | "employee_lock"
  | "filing_close_lock"
  | "sync_lock"
  | "run_update"
  | "filings_update"
  | "deposits_insert";

export function labelOf(s: Stmt): Label | null {
  const blob = `${s.text} ${JSON.stringify(s.params)}`;
  if (/pg_advisory_xact_lock/i.test(s.text)) {
    if (blob.includes("payroll_run_employee:")) return "employee_lock";
    if (blob.includes("w2_w3_filing_state_ids")) return "filing_close_lock";
    if (blob.includes("tax_deposits_state_sync")) return "sync_lock";
    return null;
  }
  if (/^\s*update\s+"?payroll_runs"?/i.test(s.text)) return "run_update";
  if (/^\s*update\s+"?tax_filings"?/i.test(s.text)) return "filings_update";
  if (/^\s*insert\s+into\s+"?tax_deposits"?/i.test(s.text)) return "deposits_insert";
  return null;
}

/** Transaction id of the first statement carrying `label`. */
export function txOf(stmts: Stmt[], label: Label): number | null {
  return stmts.find((s) => s.tx !== null && labelOf(s) === label)?.tx ?? null;
}

export function labelsIn(stmts: Stmt[], tx: number): Label[] {
  return stmts
    .filter((s) => s.tx === tx)
    .map(labelOf)
    .filter((l): l is Label => l !== null);
}

export function allLabels(stmts: Stmt[]): Set<Label> {
  return new Set(stmts.map(labelOf).filter((l): l is Label => l !== null));
}

// ---------------------------------------------------------------- copy helpers

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-12-31" -> "December 31, 2026" (copy fill convention). */
export function longDate(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
}

export function monthYear(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

/** Money-shaped text or a dollar sign: no amount may appear in a body or mail. */
export function hasAmount(text: string): boolean {
  return text.includes("$") || /\d+\.\d{2}\b/.test(text);
}

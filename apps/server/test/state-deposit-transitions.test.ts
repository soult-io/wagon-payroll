/**
 * PAY-91 / spec 23 (plan/specs/state-deposit-period-transitions.md) — scenario
 * tests T01–T35 for state deposit period transitions (monthly <-> quarterly).
 *
 * Auditor-owned (payroll-calc-auditor). Every expected value below was
 * computed by hand from spec §2 (R1–R5) and §3 D6, not by running the code;
 * weekdays were checked against a real calendar:
 *   2026-08-15 Sat -> 08-17 · 2026-09-20 Sun -> 09-21 · 2026-10-31 Sat -> 11-02 ·
 *   2027-01-31 Sun -> 02-01 · 2027-01-15 Fri · 2027-02-15 Mon · 2027-02-20 Sat
 *   -> 02-22 · 2027-04-30 Fri · 2026-07-31 Fri.
 * Weekend roll only; holidays never roll (V1).
 *
 * Data is synthetic and seeded through the DB (runs as issued rows with a
 * frozen inputs.state.workState, deposits as v1.24/v1.25 wrote them) and the
 * public service functions (syncDeposits, markDeposited, sendDepositReminders,
 * monthCalendar, computeWorksheet) and admin routes. Nothing here imports the
 * planner (deposits/transition.ts). Columns added by migration 0022
 * (period_kind, superseded_at) are read through to_jsonb so the file compiles
 * and runs against the pre-fix schema and fails on the assertions.
 *
 * Amounts are integer cents. Row tuples read "kind start cents due status".
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { InjectOptions } from "fastify";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@payroll/db";
import { company, employees, seedDatabase, type SeedDb } from "@payroll/db";
import { stateName } from "@payroll/shared";
import { loadConfig, type AppConfig } from "../src/config.js";
import type { Db } from "../src/db.js";
import { markDeposited, sendDepositReminders, syncDeposits } from "../src/deposits/service.js";
import { monthCalendar } from "../src/calendar/service.js";
import { computeWorksheet } from "../src/filings/service.js";
import { seedQaDataset } from "../src/qa/seed-qa.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * Walk up to the workspace root (the dir holding pnpm-workspace.yaml), as
 * test/helpers.ts does — a fixed "../../.." misses inside Stryker's sandbox
 * copy under apps/server/.stryker-tmp/ (PAY-108).
 */
function workspaceRoot(from: string): string {
  let dir = from;
  while (!existsSync(resolve(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`pnpm-workspace.yaml not found above ${from}`);
    dir = parent;
  }
  return dir;
}
const REPO = workspaceRoot(HERE);
const DRIZZLE_DIR = resolve(REPO, "packages/db/drizzle");
const SEED_DIR = resolve(REPO, "packages/db/src/seeds/state-taxes");

// ---------------------------------------------------------------------------
// Money (integer cents, exact string parsing — no floats)
// ---------------------------------------------------------------------------

function cents(s: string): number {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(s);
  if (!m) throw new Error(`not a 2dp money string: ${s}`);
  const v = Number(m[2]) * 100 + Number(m[3]);
  return m[1] ? -v : v;
}
function money(c: number): string {
  const sign = c < 0 ? "-" : "";
  const a = Math.abs(c);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}
function addDay(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Env: the shared app (most scenarios) or a migration harness (T16/T18/T28)
// ---------------------------------------------------------------------------

interface Env {
  pg: PGlite;
  db: Db;
  config: AppConfig;
}

let t: TestContext;
let E: Env;
let ADMIN: Record<string, string>;
let adminUserId: string;

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "pay91-auditor@test.dev", role: "admin" });
  adminUserId = admin.userId;
  const session = await login(t, admin.email, TEST_PASSWORD);
  ADMIN = sessionHeader(session.sessionCookie);
  E = { pg: t.pglite, db: t.db, config: t.config };
}, 180_000);

afterAll(async () => {
  await t.close();
});

async function reset(env: Env = E): Promise<void> {
  await env.pg.exec(
    `TRUNCATE tax_deposits, payroll_entries, payroll_runs, state_deposit_schedules, email_outbox RESTART IDENTITY CASCADE`,
  );
}

beforeEach(async () => {
  if (E) await reset(E);
});

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

let empSeq = 0;
async function employee(env: Env, name: string): Promise<number> {
  empSeq += 1;
  const c = await env.db.select({ id: company.id }).from(company).limit(1);
  const rows = await env.db
    .insert(employees)
    .values({ companyId: c[0]!.id, legalName: `${name} ${empSeq}`, hireDate: "2025-01-01" })
    .returning();
  return rows[0]!.id;
}

function lastDayOf(iso: string): string {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), 0));
  return d.toISOString().slice(0, 10);
}

/** Insert an ISSUED run with a frozen work state and one state_withholding entry. */
async function run(
  env: Env,
  employeeId: number,
  state: string,
  payDate: string,
  swhCents: number,
  period?: { start: string; end: string },
): Promise<number> {
  const start = period?.start ?? `${payDate.slice(0, 7)}-01`;
  const end = period?.end ?? lastDayOf(payDate);
  const r = await env.pg.query<{ id: number }>(
    `INSERT INTO payroll_runs (employee_id, period_start, period_end, pay_date, status, run_snapshot, issued_at)
     VALUES ($1, $2, $3, $4, 'issued', $5::jsonb, now()) RETURNING id`,
    [employeeId, start, end, payDate, JSON.stringify({ inputs: { state: { workState: state } } })],
  );
  const id = r.rows[0]!.id;
  await env.pg.query(
    `INSERT INTO payroll_entries (run_id, category, amount) VALUES ($1, 'state_withholding', $2)`,
    [id, money(swhCents)],
  );
  return id;
}

/** DB-level void of an issued run (the immutability trigger allows issued -> void). */
async function voidRun(env: Env, id: number): Promise<void> {
  await env.pg.query(
    `UPDATE payroll_runs SET status='void', voided_at=now(), void_reason='PAY-91 scenario' WHERE id=$1`,
    [id],
  );
}

interface DepositSeed {
  j: string;
  start: string;
  c: number;
  due: string;
  status: "pending" | "overdue" | "deposited";
  on?: string;
  conf?: string;
  reminders?: number[];
}
/** Insert a deposit row exactly as v1.24/v1.25 wrote it (no period_kind column set). */
async function deposit(env: Env, d: DepositSeed): Promise<number> {
  const r = await env.pg.query<{ id: number }>(
    `INSERT INTO tax_deposits (jurisdiction, period_start, amount, due_date, status, deposited_on, eftps_confirmation, reminders_sent, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'scheduler') RETURNING id`,
    [
      d.j,
      d.start,
      money(d.c),
      d.due,
      d.status,
      d.on ?? null,
      d.conf ?? null,
      JSON.stringify(d.reminders ?? []),
    ],
  );
  return r.rows[0]!.id;
}

/** Seed the state's schedule from the committed seed file, the way seedStateTaxes does. */
async function seedSchedule(env: Env, state: string, year: number): Promise<void> {
  const file = JSON.parse(readFileSync(resolve(SEED_DIR, `${state}-${year}.json`), "utf8")) as {
    depositSchedule?: { frequency: string; dueDay?: number | null; note?: string; source?: string };
  };
  const s = file.depositSchedule;
  if (!s) throw new Error(`${state}-${year} has no depositSchedule`);
  await setSchedule(env, state, year, s.frequency as "monthly" | "quarterly", s.dueDay ?? null);
}
async function setSchedule(
  env: Env,
  state: string,
  year: number,
  frequency: "monthly" | "quarterly",
  dueDay: number | null,
): Promise<void> {
  await env.pg.query(
    `INSERT INTO state_deposit_schedules (state_code, tax_year, frequency, due_day, note, source)
     VALUES ($1,$2,$3,$4,'PAY-91 scenario','synthetic')
     ON CONFLICT (state_code, tax_year) DO UPDATE SET frequency=EXCLUDED.frequency, due_day=EXCLUDED.due_day, updated_at=now()`,
    [state, year, frequency, dueDay],
  );
}
async function deleteSchedule(env: Env, state: string, year: number): Promise<void> {
  await env.pg.query(`DELETE FROM state_deposit_schedules WHERE state_code=$1 AND tax_year=$2`, [
    state,
    year,
  ]);
}

// ---------------------------------------------------------------------------
// Reading rows (schema-version tolerant) + invariants
// ---------------------------------------------------------------------------

interface Row {
  id: number;
  j: string;
  start: string;
  kind: string | null;
  c: number;
  due: string;
  status: string;
  on: string | null;
  supAt: string | null;
  raw: string;
}

async function rows(env: Env, j?: string): Promise<Row[]> {
  const r = await env.pg.query<{
    id: number;
    j: string;
    start: string;
    kind: string | null;
    amount: string;
    due: string;
    status: string;
    on: string | null;
    sup_at: string | null;
    raw: string;
  }>(
    `SELECT id, jurisdiction AS j, period_start::text AS start,
            to_jsonb(d)->>'period_kind' AS kind, amount::text AS amount,
            due_date::text AS due, status, deposited_on::text AS on,
            to_jsonb(d)->>'superseded_at' AS sup_at, to_jsonb(d)::text AS raw
       FROM tax_deposits d
      WHERE ($1::text IS NULL OR jurisdiction = $1::text)
      ORDER BY period_start, to_jsonb(d)->>'period_kind' NULLS FIRST, id`,
    [j ?? null],
  );
  return r.rows.map((x) => ({
    id: x.id,
    j: x.j,
    start: x.start,
    kind: x.kind,
    c: cents(x.amount),
    due: x.due,
    status: x.status,
    on: x.on,
    supAt: x.sup_at,
    raw: x.raw,
  }));
}

const tuple = (r: Row) => `${r.kind} ${r.start} ${r.c} ${r.due} ${r.status}`;
async function live(env: Env, j: string): Promise<string[]> {
  return (await rows(env, j)).filter((r) => r.status !== "superseded").map(tuple);
}
async function sup(env: Env, j: string): Promise<string[]> {
  return (await rows(env, j))
    .filter((r) => r.status === "superseded")
    .map((r) => `${r.kind} ${r.start} ${r.c}`);
}
/** Money/date/status first (the behaviour), then the stored period_kind (schema, PR-1). */
const stripKind = (xs: string[]) => xs.map((x) => x.slice(x.indexOf(" ") + 1)).sort();
async function expectLive(env: Env, j: string, expected: string[]): Promise<void> {
  const got = await live(env, j);
  expect(stripKind(got), `${j} live rows (amount/due/status)`).toEqual(stripKind(expected));
  expect([...got].sort(), `${j} live rows (period_kind)`).toEqual([...expected].sort());
}
async function expectSup(env: Env, j: string, expected: string[]): Promise<void> {
  const got = await sup(env, j);
  expect(stripKind(got), `${j} superseded rows (amount)`).toEqual(stripKind(expected));
  expect([...got].sort(), `${j} superseded rows (period_kind)`).toEqual([...expected].sort());
}

async function liveRow(env: Env, j: string, start: string, kind: string): Promise<Row> {
  const r = (await rows(env, j)).find(
    (x) => x.status !== "superseded" && x.start === start && x.kind === kind,
  );
  if (!r) throw new Error(`no live ${j} ${kind} row at ${start}`);
  return r;
}

/** Oracle liability per (year, quarter) for a state: issued runs by PAY DATE (R1). */
async function liability(env: Env, state: string): Promise<Map<string, number>> {
  const r = await env.pg.query<{ y: number; q: number; s: string }>(
    `SELECT extract(year FROM r.pay_date)::int AS y, extract(quarter FROM r.pay_date)::int AS q,
            coalesce(sum(e.amount),0)::numeric(12,2)::text AS s
       FROM payroll_runs r JOIN payroll_entries e ON e.run_id = r.id
      WHERE r.status='issued' AND e.category='state_withholding'
        AND r.run_snapshot#>>'{inputs,state,workState}' = $1
      GROUP BY 1,2`,
    [state],
  );
  return new Map(r.rows.map((x) => [`${x.y}-Q${x.q}`, cents(x.s)]));
}
const unitOf = (start: string) =>
  `${start.slice(0, 4)}-Q${Math.ceil(Number(start.slice(5, 7)) / 3)}`;

let before: Row[] = [];
async function sync(env: Env, today: string) {
  before = await rows(env);
  return syncDeposits({ db: env.db, config: env.config }, { today });
}

/** Spec §8 INV, asserted against the rows as they were before the last sync. */
async function inv(env: Env): Promise<void> {
  const after = await rows(env);
  invRows(after);
  const sched = await env.pg.query<{ state_code: string; tax_year: number; frequency: string }>(
    `SELECT state_code, tax_year, frequency FROM state_deposit_schedules`,
  );
  const states = [...new Set(after.filter((r) => r.j !== "federal").map((r) => r.j))];
  for (const s of states) {
    const L = await liability(env, s);
    const units = new Map<string, Row[]>();
    for (const r of after.filter((x) => x.j === s && x.status !== "superseded")) {
      const u = unitOf(r.start);
      units.set(u, [...(units.get(u) ?? []), r]);
    }
    for (const [u, rs] of units) {
      const quarterly = sched.rows.some(
        (x) =>
          x.state_code === s && x.tax_year === Number(u.slice(0, 4)) && x.frequency === "quarterly",
      );
      invUnit(`${s} ${u}`, rs, quarterly, L.get(u) ?? 0);
    }
  }
}

/** No negative amount; deposited rows byte-identical; superseded rows keep their amount. */
function invRows(after: Row[]): void {
  for (const r of after) expect(r.c, `negative amount on row ${r.id}`).toBeGreaterThanOrEqual(0);
  for (const b of before) {
    const a = after.find((x) => x.id === b.id);
    expect(a, `row ${b.id} deleted`).toBeDefined();
    if (!a) continue;
    if (b.status === "deposited") expect(a.raw, `deposited row ${b.id} changed`).toBe(b.raw);
    if (a.status === "superseded") expect(a.c, `superseded row ${b.id} amount changed`).toBe(b.c);
  }
}

/** One open row under quarterly; no open month next to an open quarter; live sum = max(L, D). */
function invUnit(label: string, rs: Row[], quarterly: boolean, sumL: number): void {
  const open = rs.filter((r) => r.status === "pending" || r.status === "overdue");
  if (quarterly)
    expect(open.length, `${label}: >1 open row under quarterly`).toBeLessThanOrEqual(1);
  if (open.some((r) => r.kind === "quarter")) {
    expect(
      open.filter((r) => r.kind === "month"),
      `${label}: open month overlaps open quarter`,
    ).toEqual([]);
  }
  const sumD = rs.filter((r) => r.status === "deposited").reduce((a, r) => a + r.c, 0);
  const sumLive = rs.reduce((a, r) => a + r.c, 0);
  expect(sumLive, `${label}: live sum != max(L=${sumL}, D=${sumD})`).toBe(Math.max(sumL, sumD));
}

async function api(method: "GET" | "POST", url: string, payload?: Record<string, string>) {
  const opts: InjectOptions = { method, url, headers: ADMIN };
  if (payload) opts.payload = payload;
  return t.app.inject(opts);
}
interface Detail {
  deposit: { status: string; periodKind: string };
  liability?: string;
  credits?: {
    depositId: number;
    periodStart: string;
    periodKind: string;
    depositedOn: string;
    amount: string;
    applied: string;
  }[];
  overpaid?: string;
  replacedBy?: { id: number; periodStart: string; periodKind: string }[];
}
async function detail(id: number): Promise<Detail> {
  const res = await api("GET", `/api/admin/tax-deposits/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Detail;
}

// ---------------------------------------------------------------------------
// Fixture F (CA, synthetic): R-Jul 12,345 · R-Aug 12,345 · R-Sep 13,000
// ---------------------------------------------------------------------------

const JUL = 12345;
const AUG = 12345;
const SEP = 13000;
const CA_Q3_DUE = "2026-11-02"; // Oct 31 2026 is a Saturday
const M_DUE = { jul: "2026-08-17", aug: "2026-09-15", sep: "2026-10-15" }; // Aug 15 Sat -> 17

interface F {
  ada: number;
  rJul?: number;
  rAug?: number;
  rSep?: number;
}
async function fixtureF(env: Env, months: ("jul" | "aug" | "sep")[]): Promise<F> {
  const f: F = { ada: await employee(env, "Ada Test") };
  if (months.includes("jul")) f.rJul = await run(env, f.ada, "CA", "2026-07-15", JUL);
  if (months.includes("aug")) f.rAug = await run(env, f.ada, "CA", "2026-08-14", AUG);
  if (months.includes("sep")) f.rSep = await run(env, f.ada, "CA", "2026-09-15", SEP);
  return f;
}

// Scenario builders (setup + action). Each returns the action's `today`.
async function b01(env = E) {
  const f = await fixtureF(env, ["jul", "aug"]);
  await deposit(env, { j: "CA", start: "2026-07-01", c: JUL, due: M_DUE.jul, status: "overdue" });
  await deposit(env, { j: "CA", start: "2026-08-01", c: AUG, due: M_DUE.aug, status: "pending" });
  await seedSchedule(env, "CA", 2026);
  await sync(env, "2026-09-10");
  return { today: "2026-09-10", f };
}
async function b02(env = E) {
  const { f } = await b01(env);
  f.rSep = await run(env, f.ada, "CA", "2026-09-15", SEP);
  await sync(env, "2026-10-05");
  return { today: "2026-10-05", f };
}
async function b03(env = E) {
  const f = await fixtureF(env, ["jul", "aug", "sep"]);
  const jul = await deposit(env, {
    j: "CA",
    start: "2026-07-01",
    c: JUL,
    due: M_DUE.jul,
    status: "deposited",
    on: "2026-08-14",
    conf: "SYN-0001",
  });
  await deposit(env, { j: "CA", start: "2026-08-01", c: AUG, due: M_DUE.aug, status: "overdue" });
  await deposit(env, { j: "CA", start: "2026-09-01", c: SEP, due: M_DUE.sep, status: "pending" });
  await seedSchedule(env, "CA", 2026);
  await sync(env, "2026-10-01");
  return { today: "2026-10-01", f, jul };
}
async function b04(env = E) {
  const f = await fixtureF(env, ["jul", "aug"]);
  await deposit(env, {
    j: "CA",
    start: "2026-07-01",
    c: JUL,
    due: M_DUE.jul,
    status: "deposited",
    on: "2026-08-14",
    conf: "SYN-0401",
  });
  await deposit(env, {
    j: "CA",
    start: "2026-08-01",
    c: AUG,
    due: M_DUE.aug,
    status: "deposited",
    on: "2026-09-14",
    conf: "SYN-0402",
  });
  await voidRun(env, f.rAug!);
  await run(env, f.ada, "CA", "2026-08-28", 2000);
  await seedSchedule(env, "CA", 2026);
  await sync(env, "2026-09-20");
  return { today: "2026-09-20", f };
}
async function b05(env = E) {
  const { f } = await b04(env);
  f.rSep = await run(env, f.ada, "CA", "2026-09-15", SEP);
  await sync(env, "2026-10-01");
  return { today: "2026-10-01", f };
}
async function b06(env = E) {
  const f = await fixtureF(env, ["jul", "aug"]);
  await deposit(env, {
    j: "CA",
    start: "2026-07-01",
    c: JUL,
    due: M_DUE.jul,
    status: "deposited",
    on: "2026-08-14",
    conf: "SYN-0601",
  });
  await deposit(env, {
    j: "CA",
    start: "2026-08-01",
    c: AUG,
    due: M_DUE.aug,
    status: "deposited",
    on: "2026-09-14",
    conf: "SYN-0602",
  });
  await seedSchedule(env, "CA", 2026);
  await sync(env, "2026-09-20");
  return { today: "2026-09-20", f };
}
async function b07(env = E) {
  const f = await fixtureF(env, ["jul", "aug", "sep"]);
  await seedSchedule(env, "CA", 2026);
  await sync(env, "2026-09-20"); // -> Q3 37,690 · 11-02 · pending
  await setSchedule(env, "CA", 2026, "monthly", 15);
  await sync(env, "2026-10-05");
  return { today: "2026-10-05", f };
}
/** CA quarterly, R-Jul + R-Aug, sync 09-01, Q3 24,690 marked deposited 09-05. */
async function quarterPaid(env = E) {
  const f = await fixtureF(env, ["jul", "aug"]);
  await seedSchedule(env, "CA", 2026);
  await sync(env, "2026-09-01");
  const ca = (await rows(env, "CA")).filter((r) => r.status !== "superseded");
  expect(stripKind(ca.map(tuple))).toEqual([`2026-07-01 24690 ${CA_Q3_DUE} pending`]);
  await markDeposited(
    { db: env.db, config: env.config },
    ca[0]!.id,
    { depositedOn: "2026-09-05", eftpsConfirmation: "SYN-Q3" },
    adminUserId,
  );
  return { f, q: ca[0]!.id };
}
async function b08(env = E) {
  const { f, q } = await quarterPaid(env);
  await run(env, f.ada, "CA", "2026-08-31", 2655, { start: "2026-08-31", end: "2026-08-31" });
  f.rSep = await run(env, f.ada, "CA", "2026-09-15", SEP);
  await setSchedule(env, "CA", 2026, "monthly", 15);
  await sync(env, "2026-10-05");
  return { today: "2026-10-05", f, q };
}
async function b09(env = E) {
  const { f, q } = await quarterPaid(env);
  await voidRun(env, f.rAug!);
  await setSchedule(env, "CA", 2026, "monthly", 15);
  await sync(env, "2026-10-05");
  return { today: "2026-10-05", f, q };
}

// ---------------------------------------------------------------------------
// Class a/f — Case A, B, C (T01–T09)
// ---------------------------------------------------------------------------

describe("PAY-91 Case A — monthly rows merge into one quarter row", () => {
  it("T01: overdue Jul + pending Aug -> SUP both; Q3 24,690 due 11-02 pending", async () => {
    await b01();
    await expectLive(E, "CA", [`quarter 2026-07-01 24690 ${CA_Q3_DUE} pending`]);
    await expectSup(E, "CA", ["month 2026-07-01 12345", "month 2026-08-01 12345"]);
    await inv(E);
  });

  it("T02: R-Sep issued -> Q3 37,690; no Sep month row", async () => {
    await b02();
    await expectLive(E, "CA", [`quarter 2026-07-01 37690 ${CA_Q3_DUE} pending`]);
    expect((await rows(E, "CA")).filter((r) => r.start === "2026-09-01")).toEqual([]);
    await inv(E);
  });
});

describe("PAY-91 Case B — some months already deposited", () => {
  it("T03: Jul deposited -> Q3 25,345 (37,690 - 12,345); credits [Jul 12,345 applied 12,345]", async () => {
    const { jul } = await b03();
    await expectLive(E, "CA", [
      `month 2026-07-01 12345 ${M_DUE.jul} deposited`,
      `quarter 2026-07-01 25345 ${CA_Q3_DUE} pending`,
    ]);
    await expectSup(E, "CA", ["month 2026-08-01 12345", "month 2026-09-01 13000"]);
    const q = await liveRow(E, "CA", "2026-07-01", "quarter");
    const d = await detail(q.id);
    expect(d.liability).toBe("376.90");
    expect(d.overpaid).toBe("0.00");
    expect(d.credits).toEqual([
      {
        depositId: jul,
        periodStart: "2026-07-01",
        periodKind: "month",
        depositedOn: "2026-08-14",
        amount: "123.45",
        applied: "123.45",
      },
    ]);
    await inv(E);
  });

  it("T04: Jul+Aug deposited, Aug re-issued at 2,000 -> Q3 0.00 pending; overpaid 103.45", async () => {
    await b04();
    await expectLive(E, "CA", [
      `month 2026-07-01 12345 ${M_DUE.jul} deposited`,
      `month 2026-08-01 12345 ${M_DUE.aug} deposited`,
      `quarter 2026-07-01 0 ${CA_Q3_DUE} pending`,
    ]);
    const d = await detail((await liveRow(E, "CA", "2026-07-01", "quarter")).id);
    expect(d.liability).toBe("143.45");
    expect(d.overpaid).toBe("103.45");
    // `applied` for the Aug credit is ambiguous in spec §7 (123.45 or 20.00); only amounts asserted.
    expect(d.credits?.map((c) => [c.periodStart, c.amount])).toEqual([
      ["2026-07-01", "123.45"],
      ["2026-08-01", "123.45"],
    ]);
    await inv(E);
  });

  it("T05: then R-Sep 13,000 -> Q3 26.55 (27,345 - 24,690); overpaid 0.00", async () => {
    await b05();
    await expectLive(E, "CA", [
      `month 2026-07-01 12345 ${M_DUE.jul} deposited`,
      `month 2026-08-01 12345 ${M_DUE.aug} deposited`,
      `quarter 2026-07-01 2655 ${CA_Q3_DUE} pending`,
    ]);
    const d = await detail((await liveRow(E, "CA", "2026-07-01", "quarter")).id);
    expect(d.overpaid).toBe("0.00");
    await inv(E);
  });

  it("T06: Jul+Aug deposited exactly -> Q3 0.00; no reminder 10-28/11-02; mark-deposited 409", async () => {
    await b06();
    await expectLive(E, "CA", [
      `month 2026-07-01 12345 ${M_DUE.jul} deposited`,
      `month 2026-08-01 12345 ${M_DUE.aug} deposited`,
      `quarter 2026-07-01 0 ${CA_Q3_DUE} pending`,
    ]);
    await inv(E);
    const q = await liveRow(E, "CA", "2026-07-01", "quarter");
    expect((await detail(q.id)).overpaid).toBe("0.00");
    for (const day of ["2026-10-28", "2026-11-02"]) {
      expect(
        (await sendDepositReminders({ db: E.db, config: E.config }, { today: day })).sent,
      ).toBe(0);
    }
    const res = await api("POST", `/api/admin/tax-deposits/${q.id}/deposit`, {
      depositedOn: "2026-10-28",
      eftpsConfirmation: "SYN-ZERO",
    });
    expect(res.statusCode, res.body).toBe(409);
  });
});

describe("PAY-91 Case C — quarter row, schedule turns monthly", () => {
  it("T07: pending Q3 37,690 -> SUP; Jul/Aug overdue, Sep pending on their own dates", async () => {
    await b07();
    await expectSup(E, "CA", ["quarter 2026-07-01 37690"]);
    await expectLive(E, "CA", [
      `month 2026-07-01 12345 ${M_DUE.jul} overdue`,
      `month 2026-08-01 12345 ${M_DUE.aug} overdue`,
      `month 2026-09-01 13000 ${M_DUE.sep} pending`,
    ]);
    await inv(E);
  });

  it("T08: deposited Q3 24,690 applied earliest-first -> no Jul row; Aug 26.55 overdue; Sep 130.00 pending", async () => {
    const { q } = await b08();
    await expectLive(E, "CA", [
      `quarter 2026-07-01 24690 ${CA_Q3_DUE} deposited`,
      `month 2026-08-01 2655 ${M_DUE.aug} overdue`,
      `month 2026-09-01 13000 ${M_DUE.sep} pending`,
    ]);
    const aug = await liveRow(E, "CA", "2026-08-01", "month");
    const d = await detail(aug.id);
    expect(d.liability).toBe("150.00");
    expect(d.credits?.map((c) => [c.depositId, c.periodKind, c.applied])).toEqual([
      [q, "quarter", "123.45"],
    ]);
    await inv(E);
  });

  it("T09: deposited Q3 24,690, Aug voided -> no month rows; liability 123.45, overpaid 123.45", async () => {
    const { q } = await b09();
    await expectLive(E, "CA", [`quarter 2026-07-01 24690 ${CA_Q3_DUE} deposited`]);
    const d = await detail(q);
    expect(d.liability).toBe("123.45");
    expect(d.overpaid).toBe("123.45");
    await inv(E);
  });
});

// ---------------------------------------------------------------------------
// Class c — idempotency and concurrency (T10, T11)
// ---------------------------------------------------------------------------

describe("PAY-91 re-running the sync", () => {
  const builders: [string, (env?: Env) => Promise<{ today: string }>][] = [
    ["T01", b01],
    ["T02", b02],
    ["T03", b03],
    ["T04", b04],
    ["T05", b05],
    ["T06", b06],
    ["T07", b07],
    ["T08", b08],
    ["T09", b09],
  ];
  it.each(builders)(
    "T10 (%s end): same day and next day -> SyncResult all 0, rows and audit unchanged",
    async (_n, build) => {
      const { today } = await build();
      const snap = (await rows(E)).map((r) => r.raw);
      const audit = await E.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events`);
      for (const day of [today, addDay(today, 1)]) {
        const res = await syncDeposits({ db: E.db, config: E.config }, { today: day });
        expect(
          Object.values(res).every((v) => v === 0),
          JSON.stringify(res),
        ).toBe(true);
      }
      expect((await rows(E)).map((r) => r.raw)).toEqual(snap);
      const audit2 = await E.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events`);
      expect(audit2.rows[0]!.n).toBe(audit.rows[0]!.n);
      const out = await E.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM email_outbox`);
      expect(out.rows[0]!.n).toBe(0);
    },
  );

  it("T11: two syncs in parallel on T01 setup -> exactly one live Q3 24,690, two SUP, no error", async () => {
    await fixtureF(E, ["jul", "aug"]);
    await deposit(E, { j: "CA", start: "2026-07-01", c: JUL, due: M_DUE.jul, status: "overdue" });
    await deposit(E, { j: "CA", start: "2026-08-01", c: AUG, due: M_DUE.aug, status: "pending" });
    await seedSchedule(E, "CA", 2026);
    const deps = { db: E.db, config: E.config };
    await Promise.all([
      syncDeposits(deps, { today: "2026-09-10" }),
      syncDeposits(deps, { today: "2026-09-10" }),
    ]);
    await expectLive(E, "CA", [`quarter 2026-07-01 24690 ${CA_Q3_DUE} pending`]);
    await expectSup(E, "CA", ["month 2026-07-01 12345", "month 2026-08-01 12345"]);
  });
});

// ---------------------------------------------------------------------------
// Class e/g — quarter and year boundaries, multi-state (T12–T15, T30)
// ---------------------------------------------------------------------------

async function b12(env = E, variant = false) {
  const ids: Record<string, number> = {};
  for (const s of ["CA", "NC", "MD", "NY"]) {
    ids[s] = await employee(env, `Q4 ${s}`);
    for (const p of ["2026-10-15", "2026-11-13", "2026-12-15"])
      await run(env, ids[s]!, s, p, 10000);
    await seedSchedule(env, s, 2026);
  }
  if (variant) {
    await deposit(env, {
      j: "CA",
      start: "2026-10-01",
      c: 10000,
      due: "2026-11-16",
      status: "pending",
    });
    await deposit(env, {
      j: "CA",
      start: "2026-11-01",
      c: 10000,
      due: "2026-12-15",
      status: "pending",
    });
    await deposit(env, {
      j: "CA",
      start: "2026-12-01",
      c: 10000,
      due: "2027-01-15",
      status: "pending",
    });
  }
  await sync(env, "2026-12-20");
  return ids;
}
const Q4_DUE: Record<string, string> = {
  CA: "2027-02-01", // Jan 31 2027 is a Sunday
  NC: "2027-02-01",
  MD: "2027-01-15", // dueDay 15, Friday
  NY: "2027-02-01",
};

describe("PAY-91 boundaries and multi-state", () => {
  it("T12: Q4 2026 for CA/NC/MD/NY -> 30,000 each on its own due date; MD overdue on 2027-01-16", async () => {
    await b12();
    for (const s of ["CA", "NC", "MD", "NY"]) {
      await expectLive(E, s, [`quarter 2026-10-01 30000 ${Q4_DUE[s]} pending`]);
    }
    await inv(E);
    await sync(E, "2027-01-16");
    for (const s of ["CA", "NC", "NY"]) {
      await expectLive(E, s, [`quarter 2026-10-01 30000 ${Q4_DUE[s]} pending`]);
    }
    await expectLive(E, "MD", ["quarter 2026-10-01 30000 2027-01-15 overdue"]);
  });

  it("T12 variant: pre-existing CA Oct/Nov/Dec month rows -> SUP, same Q4 row", async () => {
    await b12(E, true);
    await expectLive(E, "CA", ["quarter 2026-10-01 30000 2027-02-01 pending"]);
    await expectSup(E, "CA", [
      "month 2026-10-01 10000",
      "month 2026-11-01 10000",
      "month 2026-12-01 10000",
    ]);
    await inv(E);
  });

  async function b13() {
    const ids = await b12();
    await run(E, ids.CA!, "CA", "2027-01-15", 10000);
    await sync(E, "2027-01-20");
    return ids;
  }
  it("T13: Jan 2027 CA run, no CA-2027 schedule -> fallback M 2027-01 due 02-15; Dec not merged into Jan", async () => {
    await b13();
    await expectLive(E, "CA", [
      "quarter 2026-10-01 30000 2027-02-01 pending",
      "month 2027-01-01 10000 2027-02-15 pending",
    ]);
    await inv(E);
  });

  it("T14: then CA-2027 quarterly seeded -> M 2027-01 SUP; Q1-2027 10,000 due 2027-04-30", async () => {
    await b13();
    await setSchedule(E, "CA", 2027, "quarterly", null);
    await sync(E, "2027-02-01");
    await expectLive(E, "CA", [
      "quarter 2026-10-01 30000 2027-02-01 pending",
      "quarter 2027-01-01 10000 2027-04-30 pending",
    ]);
    await expectSup(E, "CA", ["month 2027-01-01 10000"]);
    await inv(E);
  });

  it("T15: pay 06-30 -> Q2, pay 07-01 (period Jun 16-30) -> Q3 by pay date", async () => {
    const ada = await employee(E, "Ada Test");
    await run(E, ada, "CA", "2026-06-30", 5000, { start: "2026-06-01", end: "2026-06-15" });
    await run(E, ada, "CA", "2026-07-01", 7000, { start: "2026-06-16", end: "2026-06-30" });
    await seedSchedule(E, "CA", 2026);
    await sync(E, "2026-07-10");
    await expectLive(E, "CA", [
      "quarter 2026-04-01 5000 2026-07-31 pending",
      `quarter 2026-07-01 7000 ${CA_Q3_DUE} pending`,
    ]);
    await inv(E);
  });

  it("T30 (R1 pay-date year, d2b12e3): Dec 20-31 period paid 2027-01-05 -> Jan 2027 under the CA-2027 schedule", async () => {
    const ada = await employee(E, "Ada Test");
    await run(E, ada, "CA", "2026-12-15", 3000, { start: "2026-12-01", end: "2026-12-19" });
    await run(E, ada, "CA", "2027-01-05", 4000, { start: "2026-12-20", end: "2026-12-31" });
    await seedSchedule(E, "CA", 2026); // quarterly, last day
    await setSchedule(E, "CA", 2027, "monthly", 20); // synthetic: makes the schedule year observable
    await sync(E, "2027-01-10");
    await expectLive(E, "CA", [
      "quarter 2026-10-01 3000 2027-02-01 pending",
      "month 2027-01-01 4000 2027-02-22 pending", // Feb 20 2027 is a Saturday
    ]);
    await inv(E);
    await setSchedule(E, "CA", 2027, "quarterly", null);
    await sync(E, "2027-01-11");
    await expectLive(E, "CA", [
      "quarter 2026-10-01 3000 2027-02-01 pending",
      "quarter 2027-01-01 4000 2027-04-30 pending",
    ]);
    await expectSup(E, "CA", ["month 2027-01-01 4000"]);
    await inv(E);
  });
});

// ---------------------------------------------------------------------------
// Class b — data written by v1.24 / v1.25; migration 0022 (T16–T19, T28)
// ---------------------------------------------------------------------------

interface Journal {
  entries: { idx: number; tag: string }[];
}
async function migrate(pg: PGlite, filter: (tag: string) => boolean): Promise<void> {
  const journal = JSON.parse(
    readFileSync(resolve(DRIZZLE_DIR, "meta/_journal.json"), "utf8"),
  ) as Journal;
  for (const e of journal.entries.filter((x) => filter(x.tag))) {
    const text = readFileSync(resolve(DRIZZLE_DIR, `${e.tag}.sql`), "utf8");
    for (const part of text.split("--> statement-breakpoint")) {
      const stmt = part.trim();
      if (!stmt) continue;
      try {
        await pg.exec(stmt);
      } catch (err) {
        if (e.tag.startsWith("0001")) continue; // btree_gist, same as helpers.ts
        throw err;
      }
    }
  }
}
const upTo0021 = (tag: string) => tag.slice(0, 4) <= "0021";
const after0021 = (tag: string) => tag.slice(0, 4) > "0021";

async function harness(): Promise<Env> {
  const pg = new PGlite("memory://");
  await migrate(pg, upTo0021);
  const db = drizzle(pg, { schema }) as unknown as Db;
  const config = loadConfig({
    nodeEnv: "test",
    logLevel: "silent",
    baseUrl: "http://localhost",
    sessionSecret: "test-secret-0123456789abcdef0123456789abcdef",
  });
  return { pg, db, config };
}

async function insertV124(env: Env): Promise<void> {
  const fed: [string, string, string][] = [
    ["2026-07-01", "2026-08-17", "2026-08-14"],
    ["2026-08-01", "2026-09-15", "2026-09-14"],
    ["2026-09-01", "2026-10-15", "2026-10-14"],
  ];
  for (const [start, due, on] of fed) {
    await deposit(env, {
      j: "federal",
      start,
      c: 57376,
      due,
      status: "deposited",
      on,
      conf: `FED-${start}`,
    });
  }
  await deposit(env, {
    j: "CA",
    start: "2026-07-01",
    c: JUL,
    due: M_DUE.jul,
    status: "deposited",
    on: "2026-08-14",
    conf: "SYN-0001",
    reminders: [5, 0],
  });
  await deposit(env, {
    j: "CA",
    start: "2026-08-01",
    c: AUG,
    due: M_DUE.aug,
    status: "overdue",
    reminders: [5, 0],
  });
  await deposit(env, { j: "CA", start: "2026-09-01", c: SEP, due: M_DUE.sep, status: "pending" });
  await deposit(env, { j: "IL", start: "2026-07-01", c: 5000, due: M_DUE.jul, status: "pending" });
}

async function oldShape(env: Env) {
  const r = await env.pg.query<{ s: string }>(
    `SELECT json_build_object('id',id,'j',jurisdiction,'start',period_start,'amount',amount::text,'due',due_date,
       'status',status,'on',deposited_on,'conf',eftps_confirmation,'rem',reminders_sent,'by',created_by,
       'c',created_at,'u',updated_at)::text AS s FROM tax_deposits ORDER BY id`,
  );
  return r.rows.map((x) => x.s);
}

describe("PAY-91 v1.24/v1.25 data and migration 0022", () => {
  it("T16: v1.24 rows survive 0022 byte-identical, all period_kind='month', old unique gone, partial index present", async () => {
    const env = await harness();
    try {
      await insertV124(env);
      const pre = await oldShape(env);
      await migrate(env.pg, after0021);
      expect(await oldShape(env)).toEqual(pre);
      const all = await rows(env);
      expect(all).toHaveLength(7);
      expect(all.map((r) => [r.kind, r.supAt])).toEqual(Array(7).fill(["month", null]));
      const con = await env.pg.query(
        `SELECT 1 FROM pg_constraint WHERE conname='tax_deposits_jurisdiction_period_uniq'`,
      );
      expect(con.rows).toHaveLength(0);
      const idx = await env.pg.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname='tax_deposits_live_period_uniq'`,
      );
      expect(idx.rows).toHaveLength(1);
      expect(idx.rows[0]!.indexdef).toMatch(
        /UNIQUE.*jurisdiction.*period_start.*period_kind.*WHERE.*superseded/,
      );
    } finally {
      await env.pg.close();
    }
  });

  async function t17Env() {
    const env = await harness();
    await insertV124(env);
    await migrate(env.pg, after0021);
    await seedDatabase(env.db as unknown as SeedDb);
    await env.pg.exec(`TRUNCATE state_deposit_schedules`);
    await fixtureF(env, ["jul", "aug", "sep"]);
    const il = await employee(env, "IL Test");
    await run(env, il, "IL", "2026-07-15", 5000);
    await seedSchedule(env, "CA", 2026);
    await seedSchedule(env, "IL", 2026);
    return env;
  }

  it("T17: after 0022 + sync 10-01 -> CA = T03 result; IL Jul overdue; federal untouched", async () => {
    const env = await t17Env();
    try {
      const fedBefore = (await rows(env, "federal")).map((r) => r.raw);
      await sync(env, "2026-10-01");
      await expectLive(env, "CA", [
        `month 2026-07-01 12345 ${M_DUE.jul} deposited`,
        `quarter 2026-07-01 25345 ${CA_Q3_DUE} pending`,
      ]);
      await expectLive(env, "IL", [`month 2026-07-01 5000 ${M_DUE.jul} overdue`]);
      const fedAfter = (await rows(env, "federal")).filter((r) => r.c === 57376).map((r) => r.raw);
      expect(fedAfter).toEqual(fedBefore);
      await inv(env);
    } finally {
      await env.pg.close();
    }
  });

  async function t18Env() {
    const env = await harness();
    await deposit(env, {
      j: "CA",
      start: "2026-07-01",
      c: 37690,
      due: M_DUE.jul,
      status: "overdue",
    });
    await deposit(env, { j: "CA", start: "2026-08-01", c: AUG, due: M_DUE.aug, status: "overdue" });
    await deposit(env, { j: "CA", start: "2026-09-01", c: SEP, due: M_DUE.sep, status: "pending" });
    await env.pg.query(
      `INSERT INTO state_deposit_schedules (state_code, tax_year, frequency, due_day) VALUES ('CA',2026,'quarterly',NULL)`,
    );
    await migrate(env.pg, after0021);
    await seedDatabase(env.db as unknown as SeedDb);
    await env.pg.exec(`TRUNCATE state_deposit_schedules`);
    await seedSchedule(env, "CA", 2026);
    await fixtureF(env, ["jul", "aug", "sep"]);
    return env;
  }

  it("T18: v1.25 bug rows (Jul 37,690 + Aug + Sep = 63,035 live) -> 3 SUP, Q3 37,690", async () => {
    const env = await t18Env();
    try {
      await sync(env, "2026-10-01");
      await expectSup(env, "CA", [
        "month 2026-07-01 37690",
        "month 2026-08-01 12345",
        "month 2026-09-01 13000",
      ]);
      await expectLive(env, "CA", [`quarter 2026-07-01 37690 ${CA_Q3_DUE} pending`]);
      await inv(env);
    } finally {
      await env.pg.close();
    }
  });

  it("T19: v1.25 quarter-shaped NY row (24,000 deposited, labelled month) -> Q3 0.00; then monthly -> no Aug/Sep rows", async () => {
    const bob = await employee(E, "Bob Test");
    for (const p of ["2026-07-15", "2026-08-14", "2026-09-15"]) await run(E, bob, "NY", p, 8000);
    const jul = await deposit(E, {
      j: "NY",
      start: "2026-07-01",
      c: 24000,
      due: CA_Q3_DUE,
      status: "deposited",
      on: "2026-10-20",
      conf: "SYN-NY",
    });
    await seedSchedule(E, "NY", 2026);
    await sync(E, "2026-10-25");
    await expectLive(E, "NY", [
      `month 2026-07-01 24000 ${CA_Q3_DUE} deposited`,
      `quarter 2026-07-01 0 ${CA_Q3_DUE} pending`,
    ]);
    expect((await detail((await liveRow(E, "NY", "2026-07-01", "quarter")).id)).overpaid).toBe(
      "0.00",
    );
    await inv(E);
    await setSchedule(E, "NY", 2026, "monthly", null);
    await sync(E, "2026-10-25");
    await expectLive(E, "NY", [`month 2026-07-01 24000 ${CA_Q3_DUE} deposited`]);
    await expectSup(E, "NY", ["quarter 2026-07-01 0"]);
    expect((await detail(jul)).overpaid).toBe("0.00");
    await inv(E);
  });

  it("T28: 941 Q3 2026 line 13 = 1,721.28 (3 x 573.76) after migrate + sync with CA SUP rows present", async () => {
    const env = await t18Env();
    try {
      for (const [start, due, on] of [
        ["2026-07-01", "2026-08-17", "2026-08-14"],
        ["2026-08-01", "2026-09-15", "2026-09-14"],
        ["2026-09-01", "2026-10-15", "2026-10-14"],
      ] as const) {
        await deposit(env, {
          j: "federal",
          start,
          c: 57376,
          due,
          status: "deposited",
          on,
          conf: `FED-${start}`,
        });
      }
      await sync(env, "2026-10-01");
      const ws = await computeWorksheet(env.db, 2026, 3);
      expect(ws.line13Deposits).toBe("1721.28");
    } finally {
      await env.pg.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Class g — monthly states unchanged, no-schedule fallback (T20, T21)
// ---------------------------------------------------------------------------

describe("PAY-91 monthly and no-schedule states", () => {
  it("T20: IL stays monthly; NY merges to Q3 24,000; TX (0.00 SWH) gets no row; federal untouched", async () => {
    const ada = await employee(E, "Ada Test");
    const bob = await employee(E, "Bob Test");
    const cy = await employee(E, "Cy Test");
    for (const p of ["2026-07-15", "2026-08-14", "2026-09-15"]) {
      await run(E, ada, "IL", p, 5000);
      await run(E, bob, "NY", p, 8000);
      await run(E, cy, "TX", p, 0);
    }
    for (const [start, due] of [
      ["2026-07-01", M_DUE.jul],
      ["2026-08-01", M_DUE.aug],
      ["2026-09-01", M_DUE.sep],
    ] as const) {
      await deposit(E, { j: "IL", start, c: 5000, due, status: "pending" });
      await deposit(E, { j: "NY", start, c: 8000, due, status: "pending" });
      await deposit(E, {
        j: "federal",
        start,
        c: 57376,
        due,
        status: "deposited",
        on: start,
        conf: `FED-${start}`,
      });
    }
    await seedSchedule(E, "IL", 2026);
    await seedSchedule(E, "NY", 2026);
    const fedBefore = (await rows(E, "federal")).map((r) => r.raw);
    await sync(E, "2026-09-20");
    await expectLive(E, "IL", [
      `month 2026-07-01 5000 ${M_DUE.jul} overdue`,
      `month 2026-08-01 5000 ${M_DUE.aug} overdue`,
      `month 2026-09-01 5000 ${M_DUE.sep} pending`,
    ]);
    await expectSup(E, "IL", []);
    await expectLive(E, "NY", [`quarter 2026-07-01 24000 ${CA_Q3_DUE} pending`]);
    await expectSup(E, "NY", [
      "month 2026-07-01 8000",
      "month 2026-08-01 8000",
      "month 2026-09-01 8000",
    ]);
    expect(await rows(E, "TX")).toEqual([]);
    expect((await rows(E, "federal")).filter((r) => r.c === 57376).map((r) => r.raw)).toEqual(
      fedBefore,
    );
    await inv(E);
  });

  it("T21: GA (no schedule) monthly fallback; NY schedule deleted -> Q3 SUP, three month rows", async () => {
    const g = await employee(E, "Gia Test");
    await run(E, g, "GA", "2026-07-15", 3000);
    const bob = await employee(E, "Bob Test");
    for (const p of ["2026-07-15", "2026-08-14", "2026-09-15"]) await run(E, bob, "NY", p, 8000);
    await seedSchedule(E, "NY", 2026);
    await sync(E, "2026-09-20");
    await expectLive(E, "NY", [`quarter 2026-07-01 24000 ${CA_Q3_DUE} pending`]);
    await deleteSchedule(E, "NY", 2026);
    await sync(E, "2026-10-01");
    await expectLive(E, "GA", [`month 2026-07-01 3000 ${M_DUE.jul} overdue`]);
    await expectSup(E, "NY", ["quarter 2026-07-01 24000"]);
    await expectLive(E, "NY", [
      `month 2026-07-01 8000 ${M_DUE.jul} overdue`,
      `month 2026-08-01 8000 ${M_DUE.aug} overdue`,
      `month 2026-09-01 8000 ${M_DUE.sep} pending`,
    ]);
    await inv(E);
  });
});

// ---------------------------------------------------------------------------
// Class d — void / re-issue (T22, T23) and due-day change (T24)
// ---------------------------------------------------------------------------

describe("PAY-91 void, re-issue and due-day changes", () => {
  it("T22: Q3 37,690 pending; Aug voided + re-issued 11,000 -> Q3 36,345", async () => {
    const { f } = await b02();
    await voidRun(E, f.rAug!);
    await run(E, f.ada, "CA", "2026-08-28", 11000);
    await sync(E, "2026-10-05");
    await expectLive(E, "CA", [`quarter 2026-07-01 36345 ${CA_Q3_DUE} pending`]);
    await inv(E);
  });

  it("T22 variant (T03 end): Aug voided + re-issued 11,000 -> Q3 24,000 (36,345 - 12,345)", async () => {
    const { f } = await b03();
    await voidRun(E, f.rAug!);
    await run(E, f.ada, "CA", "2026-08-28", 11000);
    await sync(E, "2026-10-05");
    await expectLive(E, "CA", [
      `month 2026-07-01 12345 ${M_DUE.jul} deposited`,
      `quarter 2026-07-01 24000 ${CA_Q3_DUE} pending`,
    ]);
    await inv(E);
  });

  async function b23() {
    const { f } = await b02();
    for (const id of [f.rJul!, f.rAug!, f.rSep!]) await voidRun(E, id);
    await sync(E, "2026-11-03");
    return f;
  }
  it("T23: all three runs voided -> Q3 0.00 pending past its due date; no reminder on 11-02", async () => {
    await b23();
    await expectLive(E, "CA", [`quarter 2026-07-01 0 ${CA_Q3_DUE} pending`]);
    await inv(E);
    expect(
      (await sendDepositReminders({ db: E.db, config: E.config }, { today: "2026-11-02" })).sent,
    ).toBe(0);
  });

  it("T24: IL dueDay 15 -> 20 -> deposited Jul keeps 08-17; pending Aug moves to 09-21", async () => {
    const ada = await employee(E, "Ada Test");
    await run(E, ada, "IL", "2026-07-15", 5000);
    await run(E, ada, "IL", "2026-08-14", 5000);
    await deposit(E, {
      j: "IL",
      start: "2026-07-01",
      c: 5000,
      due: M_DUE.jul,
      status: "deposited",
      on: "2026-08-10",
      conf: "SYN-IL",
    });
    await deposit(E, { j: "IL", start: "2026-08-01", c: 5000, due: M_DUE.aug, status: "pending" });
    await seedSchedule(E, "IL", 2026);
    await setSchedule(E, "IL", 2026, "monthly", 20);
    await sync(E, "2026-09-10");
    await expectLive(E, "IL", [
      `month 2026-07-01 5000 ${M_DUE.jul} deposited`,
      "month 2026-08-01 5000 2026-09-21 pending", // Sep 20 2026 is a Sunday
    ]);
    await inv(E);
  });
});

// ---------------------------------------------------------------------------
// Class f — readers: reminders, calendar, API (T25–T27)
// ---------------------------------------------------------------------------

describe("PAY-91 readers of superseded and zero rows", () => {
  it("T25: reminders on T03 end -> 10-10: 0, 10-15: 0, 10-28: 1 (Q3 2026, $253.45), 11-02: 1; T06 end on 10-28: 0", async () => {
    await b03();
    const deps = { db: E.db, config: E.config };
    const sent: number[] = [];
    for (const day of ["2026-10-10", "2026-10-15", "2026-10-28", "2026-11-02"]) {
      sent.push((await sendDepositReminders(deps, { today: day })).sent);
    }
    expect(sent).toEqual([0, 0, 1, 1]);
    const mail = await E.pg.query<{ subject: string; body_html: string }>(
      `SELECT subject, body_html FROM email_outbox ORDER BY id`,
    );
    // Spec T25 says "subject has Q3 2026"; the template puts the period in the body
    // (subject is "tax deposit due <date>"). Asserted on the body.
    expect(mail.rows[0]!.body_html).toContain("Q3 2026");
    expect(mail.rows[0]!.body_html).toContain("$253.45");
    await reset();
    await b06();
    expect((await sendDepositReminders(deps, { today: "2026-10-28" })).sent).toBe(0);
  });

  it("T26: calendar on T03 end -> Oct: no CA due event; Nov: CA Q3 due 11-02 $253.45; Aug: CA July made 08-14", async () => {
    await b03();
    const caIds = new Set((await rows(E, "CA")).map((r) => r.id));
    const oct = await monthCalendar(E.db, 2026, 10);
    const octCa = oct.filter(
      (e) => e.kind === "deposit_due" && caIds.has(Number(e.link?.params?.id)),
    );
    expect(octCa.map((e) => [e.date, e.label])).toEqual([]);
    const CA = stateName("CA");
    expect(CA).toBe("California"); // pin the shared map so the label oracle stays independent
    const nov = await monthCalendar(E.db, 2026, 11);
    const due = nov.filter((e) => e.kind === "deposit_due" && e.label.startsWith(CA));
    expect(due.map((e) => [e.date, e.label, e.detail])).toEqual([
      ["2026-11-02", `${CA} deposit due — Q3 2026`, "$253.45 · pending"],
    ]);
    const aug = await monthCalendar(E.db, 2026, 8);
    const made = aug.filter((e) => e.kind === "deposit_made" && e.label.startsWith(CA));
    expect(made.map((e) => [e.date, e.label])).toEqual([
      ["2026-08-14", `${CA} deposit made — July 2026`],
    ]);
  });

  it("T27: API on T03 end -> list excludes SUP; SUP detail 200 with replacedBy; 409 on deposit/attach to SUP; 409 on zero row", async () => {
    await b03();
    const list = await api("GET", "/api/admin/tax-deposits?jurisdiction=CA");
    expect(list.statusCode, list.body).toBe(200);
    const listed = (
      list.json() as { deposits: { status: string; periodStart: string; periodKind: string }[] }
    ).deposits;
    expect(listed.map((d) => `${d.periodKind} ${d.periodStart} ${d.status}`).sort()).toEqual([
      "month 2026-07-01 deposited",
      "quarter 2026-07-01 pending",
    ]);
    const supAug = (await rows(E, "CA")).find(
      (r) => r.status === "superseded" && r.start === "2026-08-01",
    );
    expect(supAug, "superseded Aug row").toBeDefined();
    const q = await liveRow(E, "CA", "2026-07-01", "quarter");
    const d = await detail(supAug!.id);
    expect(d.deposit.status).toBe("superseded");
    expect(d.replacedBy).toEqual([{ id: q.id, periodStart: "2026-07-01", periodKind: "quarter" }]);
    const post = await api("POST", `/api/admin/tax-deposits/${supAug!.id}/deposit`, {
      depositedOn: "2026-10-02",
      eftpsConfirmation: "SYN-SUP",
    });
    expect(post.statusCode, post.body).toBe(409);
    const attOpts: InjectOptions = {
      method: "POST",
      url: `/api/admin/tax-deposits/${supAug!.id}/attachments?filename=x.pdf`,
      headers: { ...ADMIN, "content-type": "application/pdf" },
      payload: Buffer.from("%PDF-1.4 synthetic"),
    };
    const att = await t.app.inject(attOpts);
    expect(att.statusCode, att.body).toBe(409);
    await reset();
    await b06();
    const zero = await liveRow(E, "CA", "2026-07-01", "quarter");
    const z = await api("POST", `/api/admin/tax-deposits/${zero.id}/deposit`, {
      depositedOn: "2026-10-02",
      eftpsConfirmation: "SYN-ZERO",
    });
    expect(z.statusCode, z.body).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Auditor coverage additions (GUARDRAILS a–g gaps in the spec 23 matrix)
// ---------------------------------------------------------------------------

describe("PAY-91 auditor additions", () => {
  it("T31 (a,g): work state CA -> NY mid-quarter -> CA Q3 24,690 and NY Q3 13,000; CA v1.24 rows SUP", async () => {
    const ada = await employee(E, "Ada Test");
    await run(E, ada, "CA", "2026-07-15", JUL);
    await run(E, ada, "CA", "2026-08-14", AUG);
    await run(E, ada, "NY", "2026-09-15", SEP);
    await deposit(E, { j: "CA", start: "2026-07-01", c: JUL, due: M_DUE.jul, status: "overdue" });
    await deposit(E, { j: "CA", start: "2026-08-01", c: AUG, due: M_DUE.aug, status: "overdue" });
    await seedSchedule(E, "CA", 2026);
    await seedSchedule(E, "NY", 2026);
    await sync(E, "2026-10-01");
    await expectLive(E, "CA", [`quarter 2026-07-01 24690 ${CA_Q3_DUE} pending`]);
    await expectLive(E, "NY", [`quarter 2026-07-01 13000 ${CA_Q3_DUE} pending`]);
    await expectSup(E, "CA", ["month 2026-07-01 12345", "month 2026-08-01 12345"]);
    await inv(E);
  });

  it("T32 (f): all three months deposited exactly -> Q3 0.00, overpaid 0.00; back to monthly -> Q3 SUP, no new rows", async () => {
    await fixtureF(E, ["jul", "aug", "sep"]);
    await deposit(E, {
      j: "CA",
      start: "2026-07-01",
      c: JUL,
      due: M_DUE.jul,
      status: "deposited",
      on: "2026-08-14",
      conf: "A",
    });
    await deposit(E, {
      j: "CA",
      start: "2026-08-01",
      c: AUG,
      due: M_DUE.aug,
      status: "deposited",
      on: "2026-09-14",
      conf: "B",
    });
    await deposit(E, {
      j: "CA",
      start: "2026-09-01",
      c: SEP,
      due: M_DUE.sep,
      status: "deposited",
      on: "2026-10-14",
      conf: "C",
    });
    await seedSchedule(E, "CA", 2026);
    await sync(E, "2026-10-20");
    const dep = [
      `month 2026-07-01 12345 ${M_DUE.jul} deposited`,
      `month 2026-08-01 12345 ${M_DUE.aug} deposited`,
      `month 2026-09-01 13000 ${M_DUE.sep} deposited`,
    ];
    await expectLive(E, "CA", [...dep, `quarter 2026-07-01 0 ${CA_Q3_DUE} pending`]);
    const d = await detail((await liveRow(E, "CA", "2026-07-01", "quarter")).id);
    expect([d.liability, d.overpaid]).toEqual(["376.90", "0.00"]);
    await inv(E);
    await setSchedule(E, "CA", 2026, "monthly", 15);
    await sync(E, "2026-10-21");
    await expectLive(E, "CA", dep);
    await expectSup(E, "CA", ["quarter 2026-07-01 0"]);
    await inv(E);
  });

  it("T33 (a, D2): T03 end -> monthly -> quarterly again; superseded rows share keys, live sum stays 37,690", async () => {
    await b03();
    await setSchedule(E, "CA", 2026, "monthly", 15);
    await sync(E, "2026-10-05");
    await expectLive(E, "CA", [
      `month 2026-07-01 12345 ${M_DUE.jul} deposited`,
      `month 2026-08-01 12345 ${M_DUE.aug} overdue`,
      `month 2026-09-01 13000 ${M_DUE.sep} pending`,
    ]);
    await expectSup(E, "CA", [
      "quarter 2026-07-01 25345",
      "month 2026-08-01 12345",
      "month 2026-09-01 13000",
    ]);
    await inv(E);
    await seedSchedule(E, "CA", 2026);
    await sync(E, "2026-10-06");
    await expectLive(E, "CA", [
      `month 2026-07-01 12345 ${M_DUE.jul} deposited`,
      `quarter 2026-07-01 25345 ${CA_Q3_DUE} pending`,
    ]);
    expect((await sup(E, "CA")).length).toBe(5);
    await inv(E);
  });

  it("T34 (d): quarter deposited, then a run voided, schedule stays quarterly -> no new row; overpaid 123.45", async () => {
    const { f, q } = await quarterPaid();
    await voidRun(E, f.rAug!);
    await sync(E, "2026-09-20");
    await expectLive(E, "CA", [`quarter 2026-07-01 24690 ${CA_Q3_DUE} deposited`]);
    const d = await detail(q);
    expect([d.liability, d.overpaid]).toEqual(["123.45", "123.45"]);
    await inv(E);
  });

  it("T35 (d,f): T23 0.00 row, then a new Sep run after the due date -> Q3 130.00 overdue", async () => {
    const { f } = await b02();
    for (const id of [f.rJul!, f.rAug!, f.rSep!]) await voidRun(E, id);
    await sync(E, "2026-11-03");
    await expectLive(E, "CA", [`quarter 2026-07-01 0 ${CA_Q3_DUE} pending`]);
    await run(E, f.ada, "CA", "2026-09-30", SEP);
    await sync(E, "2026-11-04");
    await expectLive(E, "CA", [`quarter 2026-07-01 13000 ${CA_Q3_DUE} overdue`]);
    await inv(E);
  });
});

// ---------------------------------------------------------------------------
// T29 — seed-qa on an empty DB (own PGlite; the shared DB is truncated per test)
// ---------------------------------------------------------------------------

describe("PAY-91 T29 seed-qa", () => {
  it("T29: seed-qa (today 2026-08-20) -> 19 federal + 19 IL rows, all month, none superseded", async () => {
    const ctx = await createTestApp();
    try {
      await seedQaDataset(
        { db: ctx.db, auth: ctx.auth, config: ctx.config },
        { today: "2026-08-20" },
      );
      const env: Env = { pg: ctx.pglite, db: ctx.db, config: ctx.config };
      const all = await rows(env);
      expect(all.filter((r) => r.j === "federal")).toHaveLength(19);
      expect(all.filter((r) => r.j === "IL")).toHaveLength(19);
      expect(all.filter((r) => r.j !== "federal" && r.j !== "IL")).toEqual([]);
      expect(new Set(all.map((r) => `${r.kind}|${r.status === "superseded"}`))).toEqual(
        new Set(["month|false"]),
      );
    } finally {
      await ctx.close();
    }
  }, 300_000);
});

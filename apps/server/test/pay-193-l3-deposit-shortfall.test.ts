/**
 * PAY-193 L3 — deposit shortfall rows (spec D9.6, D9.9, D9.11 S-D1…S-D9).
 *
 * Auditor-owned (payroll-calc-auditor). Fail-first: written before the code.
 *
 * Rule under test (D9.6). Once a live row is `deposited` its amount is frozen;
 * a federal `overdue` row is frozen too. Liability beyond the frozen rows goes
 * to a SHORTFALL row: same jurisdiction, period_start and period_kind, the next
 * `seq`, the ORIGINAL due date, `overdue` when that date has passed (due < today)
 * else `pending`. Federal: L = month liability, F = Σ live deposited + overdue,
 * R = L − F; the open pending row P (highest seq) gets max(0, R); no P and R > 0
 * inserts seq = max+1; R < 0 writes nothing. State: an OPEN state row (even an
 * overdue one) keeps taking the remainder (Spec 23); only a deposited period gets
 * a seq+1 row. Every shortfall insert writes one `tax_deposit.shortfall_created`
 * audit row, after = { jurisdiction, periodStart, periodKind, seq, cents }.
 *
 * Reading taken where the spec is silent (named for the tax SME):
 *  - "Shortfall insert" = an insert with seq > 0. The first (seq 0) row of a
 *    period is the ordinary row and writes no shortfall audit row.
 *  - Quarterly "keep or insert one open quarter row with max(0, ΣL − ΣD)":
 *    insert only when the amount is > 0. A paid-in-full quarter gets no 0.00
 *    seq 1 row (the existing Spec 23 test T34 — quarter deposited, run voided,
 *    "no new row" — requires the same).
 *
 * ---------------------------------------------------------------------------
 * Oracle (computed by hand / Python decimal, never from @payroll/engine):
 *
 * Federal FIT — Pub 15-T (2026) Worksheet 1A, Annual Percentage Method,
 * STANDARD schedule, Single, 2020+ Form W-4 with no Step 2/3/4 entries,
 * monthly (1b = 12), line 1g = $8,600. Rounded to the cent, half-up.
 *   A gross 4,000.00: 1c 48,000; 1i 39,400; row 19,900–57,900: 1,240 + 12% x
 *     19,500 = 3,580.00; 2h 3,580 / 12 = 298.333 -> 298.33
 *   B gross 2,500.00: 1c 30,000; 1i 21,400; 1,240 + 12% x 1,500 = 1,420.00;
 *     2h 118.333 -> 118.33
 *   C gross 1,800.00: 1c 21,600; 1i 13,000; row 7,500–19,900: 0 + 10% x 5,500
 *     = 550.00; 2h 45.833 -> 45.83
 *   (Pub 15-T also allows rounding 2h to whole dollars. The deposit sync only
 *   sums stored entries, so that reading does not change any L3 outcome.)
 * FICA — Pub 15 (2026) §9: Social Security 6.2% employee + 6.2% employer,
 * Medicare 1.45% + 1.45%. No wage reaches the 2026 SS wage base ($184,500, SSA)
 * or the $200,000 Additional Medicare threshold.
 *   A: SS 248.00, Medicare 58.00   B: SS 155.00, Medicare 36.25
 *   C: SS 111.60, Medicare 26.10
 * Federal deposit per run (FIT + 2 x SS + 2 x Medicare; employer FUTA excluded):
 *   A 298.33 + 496.00 + 116.00 = 910.33     B 118.33 + 310.00 + 72.50 = 500.83
 *   C 45.83 + 223.20 + 52.20 = 321.23
 *   A+B 1,411.16   B+C 822.06
 * Illinois — Booklet IL-700-T (2026, R-12/25) automated formula: 4.95% x (wages
 * − IL-W-4 line 1 allowances x $2,925 / periods). 1 allowance, monthly:
 * exemption 243.75.
 *   A 4,000.00: 3,756.25 x .0495 = 185.934375 -> 185.93
 *   B 2,500.00: 2,256.25 x .0495 = 111.684375 -> 111.68
 *   C 1,800.00: 1,556.25 x .0495 =  77.034375 ->  77.03
 *   A+B 297.61   3A (Oct, Nov, Dec) 557.79   3A+B 669.47   B+C 188.71
 * Due dates (weekend roll only):
 *   federal Dec 2026 -> 15th of next month = 2027-01-15 (Fri)
 *   IL monthly 2026, dueDay 15 (IL-2026 seed, Pub 131) -> 2027-01-15 (Fri)
 *   IL quarterly variant, dueDay null -> last day of Jan = 2027-01-31 (Sun)
 *     -> 2027-02-01 (Mon)
 * ---------------------------------------------------------------------------
 *
 * Data is synthetic. Runs are seeded as ISSUED rows with frozen entries (the
 * sync reads issued entries only), deposits through syncDeposits/markDeposited.
 * `seq` is read through to_jsonb so the file runs against the pre-L3 schema and
 * fails on the assertions, not on compile.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@payroll/db";
import { company, employees, seedDatabase, type SeedDb } from "@payroll/db";
import { loadConfig, type AppConfig } from "../src/config.js";
import type { Db } from "../src/db.js";
import {
  getDepositDetail,
  listDeposits,
  markDeposited,
  sendDepositReminders,
  syncDeposits,
  type SyncResult,
} from "../src/deposits/service.js";
import { monthCalendar } from "../src/calendar/service.js";
import { createTestApp, runMigrations, type TestContext } from "./helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
function workspaceRoot(from: string): string {
  let dir = from;
  while (!existsSync(resolve(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`pnpm-workspace.yaml not found above ${from}`);
    dir = parent;
  }
  return dir;
}
const DRIZZLE_DIR = resolve(workspaceRoot(HERE), "packages/db/drizzle");

// ---------------------------------------------------------------------------
// Oracle constants (integer cents; derivation in the header)
// ---------------------------------------------------------------------------

interface Pay {
  fit: number;
  ss: number;
  med: number;
  il: number;
}
const A: Pay = { fit: 29833, ss: 24800, med: 5800, il: 18593 };
const B: Pay = { fit: 11833, ss: 15500, med: 3625, il: 11168 };
const C: Pay = { fit: 4583, ss: 11160, med: 2610, il: 7703 };
const fed = (p: Pay) => p.fit + 2 * p.ss + 2 * p.med;

// Cross-check the constants against the hand totals once (no engine involved).
const FED_A = 91033;
const FED_B = 50083;
const FED_C = 32123;
const IL_A = 18593;
const IL_B = 11168;
const IL_C = 7703;

const DEC = "2026-12-01";
const Q4 = "2026-10-01";
const FED_DUE = "2027-01-15";
const IL_M_DUE = "2027-01-15";
const IL_Q_DUE = "2027-02-01";

const SHORTFALL = "tax_deposit.shortfall_created";

// ---------------------------------------------------------------------------
// Money
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

// ---------------------------------------------------------------------------
// Env: one PGlite for the file, reset before each test (shuffle-safe)
// ---------------------------------------------------------------------------

interface Env {
  pg: PGlite;
  db: Db;
  config: AppConfig;
}

function testConfig(): AppConfig {
  return loadConfig({
    nodeEnv: "test",
    logLevel: "silent",
    baseUrl: "http://localhost",
    sessionSecret: "test-secret-0123456789abcdef0123456789abcdef",
  });
}

let E: Env;

beforeAll(async () => {
  const pg = new PGlite("memory://");
  await runMigrations(pg);
  const db = drizzle(pg, { schema }) as unknown as Db;
  await seedDatabase(db as unknown as SeedDb);
  E = { pg, db, config: testConfig() };
}, 180_000);

afterAll(async () => {
  await E?.pg.close();
});

beforeEach(async () => {
  await E.pg.exec(
    `TRUNCATE tax_deposits, payroll_entries, payroll_runs, state_deposit_schedules, email_outbox, audit_events RESTART IDENTITY CASCADE`,
  );
  // IL 2026 monthly, due the 15th (IL-2026 seed: IDOR Pub 131 / IL-501).
  await setSchedule("IL", 2026, "monthly", 15);
});

async function setSchedule(
  state: string,
  year: number,
  frequency: "monthly" | "quarterly",
  dueDay: number | null,
): Promise<void> {
  await E.pg.query(
    `INSERT INTO state_deposit_schedules (state_code, tax_year, frequency, due_day, note, source)
     VALUES ($1,$2,$3,$4,'PAY-193 L3 scenario','synthetic')
     ON CONFLICT (state_code, tax_year) DO UPDATE SET frequency=EXCLUDED.frequency, due_day=EXCLUDED.due_day`,
    [state, year, frequency, dueDay],
  );
}

let empSeq = 0;
async function employee(env: Env = E): Promise<number> {
  empSeq += 1;
  const c = await env.db.select({ id: company.id }).from(company).limit(1);
  const rows = await env.db
    .insert(employees)
    .values({ companyId: c[0]!.id, legalName: `L3 Synthetic ${empSeq}`, hireDate: "2025-01-01" })
    .returning();
  return rows[0]!.id;
}

function lastDayOf(iso: string): string {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), 0));
  return d.toISOString().slice(0, 10);
}

/**
 * One ISSUED monthly run for a new employee with the frozen entries of `p`.
 * `state` adds inputs.state.workState and the state_withholding entry.
 */
async function issue(p: Pay, payDate: string, state: "IL" | null = "IL"): Promise<number> {
  const emp = await employee();
  const snap = state ? { inputs: { state: { workState: state } } } : { inputs: {} };
  const r = await E.pg.query<{ id: number }>(
    `INSERT INTO payroll_runs (employee_id, period_start, period_end, pay_date, status, run_snapshot, issued_at)
     VALUES ($1, $2, $3, $4, 'issued', $5::jsonb, now()) RETURNING id`,
    [emp, `${payDate.slice(0, 7)}-01`, lastDayOf(payDate), payDate, JSON.stringify(snap)],
  );
  const id = r.rows[0]!.id;
  const entries: [string, number][] = [
    ["federal_withholding", p.fit],
    ["social_security", p.ss],
    ["medicare", p.med],
    ["employer_social_security", p.ss],
    ["employer_medicare", p.med],
  ];
  if (state) entries.push(["state_withholding", p.il]);
  for (const [category, c] of entries) {
    await E.pg.query(`INSERT INTO payroll_entries (run_id, category, amount) VALUES ($1,$2,$3)`, [
      id,
      category,
      money(c),
    ]);
  }
  return id;
}

async function voidRun(id: number): Promise<void> {
  await E.pg.query(
    `UPDATE payroll_runs SET status='void', voided_at=now(), void_reason='PAY-193 L3 scenario' WHERE id=$1`,
    [id],
  );
}

async function sync(today: string): Promise<SyncResult> {
  return syncDeposits({ db: E.db, config: E.config }, { today });
}

async function deposit(id: number, on: string, conf: string): Promise<void> {
  await markDeposited(
    { db: E.db, config: E.config },
    id,
    { depositedOn: on, eftpsConfirmation: conf },
    "auditor",
  );
}

// ---------------------------------------------------------------------------
// Reading rows (schema-version tolerant: seq via to_jsonb)
// ---------------------------------------------------------------------------

interface Row {
  id: number;
  j: string;
  start: string;
  kind: string;
  seq: number | null;
  c: number;
  due: string;
  status: string;
  on: string | null;
  conf: string | null;
}

async function rows(j: string, env: Env = E): Promise<Row[]> {
  const r = await env.pg.query<{
    id: number;
    j: string;
    start: string;
    kind: string;
    seq: string | null;
    amount: string;
    due: string;
    status: string;
    on: string | null;
    conf: string | null;
  }>(
    `SELECT id, jurisdiction AS j, period_start::text AS start, period_kind AS kind,
            to_jsonb(d)->>'seq' AS seq, amount::text AS amount, due_date::text AS due,
            status, deposited_on::text AS on, eftps_confirmation AS conf
       FROM tax_deposits d WHERE jurisdiction = $1
      ORDER BY period_start, period_kind, (to_jsonb(d)->>'seq')::int NULLS FIRST, id`,
    [j],
  );
  return r.rows.map((x) => ({
    id: x.id,
    j: x.j,
    start: x.start,
    kind: x.kind,
    seq: x.seq === null ? null : Number(x.seq),
    c: cents(x.amount),
    due: x.due,
    status: x.status,
    on: x.on,
    conf: x.conf,
  }));
}

/**
 * Live rows as "seq kind start cents due status" tuples. A pre-L3 row (no seq
 * column) renders as seq 0, which is what the L3 migration gives it; S-D9
 * asserts the column itself.
 */
async function live(j: string): Promise<string[]> {
  return (await rows(j))
    .filter((r) => r.status !== "superseded")
    .map((r) => `${r.seq ?? 0} ${r.kind} ${r.start} ${r.c} ${r.due} ${r.status}`);
}

async function liveRow(j: string, start: string, seq: number): Promise<Row> {
  const all = (await rows(j)).filter((r) => r.status !== "superseded");
  // Pre-L3 schema has no seq: a seq-0 lookup falls back to the single row.
  const r = all.find((x) => x.start === start && (x.seq ?? 0) === seq);
  if (!r) throw new Error(`no live ${j} row at ${start} seq ${seq}`);
  return r;
}

interface AuditRow {
  action: string;
  after: Record<string, unknown> | null;
}
async function shortfallAudits(): Promise<AuditRow[]> {
  const r = await E.pg.query<AuditRow>(
    `SELECT action, after FROM audit_events WHERE action = $1 ORDER BY id`,
    [SHORTFALL],
  );
  return r.rows;
}

/** Full table image, for idempotence checks. */
async function image(): Promise<string> {
  const r = await E.pg.query<{ s: string }>(
    `SELECT coalesce(json_agg(to_jsonb(d) - 'updated_at' ORDER BY id), '[]')::text AS s FROM tax_deposits d`,
  );
  return r.rows[0]!.s;
}

/** Invariants that hold after every sync. */
async function invariants(): Promise<void> {
  const r = await E.pg.query<{ j: string; start: string; kind: string; n: number }>(
    `SELECT jurisdiction AS j, period_start::text AS start, period_kind AS kind, count(*)::int AS n
       FROM tax_deposits WHERE status = 'pending' GROUP BY 1,2,3 HAVING count(*) > 1`,
  );
  expect(r.rows, "at most one pending row per period").toEqual([]);
  const neg = await E.pg.query(`SELECT id FROM tax_deposits WHERE amount < 0`);
  expect(neg.rows, "no negative amount").toEqual([]);
}

// ---------------------------------------------------------------------------
// Oracle self-check
// ---------------------------------------------------------------------------

describe("oracle constants", () => {
  it("per-run totals match the hand-computed worksheet values", () => {
    expect([fed(A), fed(B), fed(C)]).toEqual([FED_A, FED_B, FED_C]);
    expect([A.il, B.il, C.il]).toEqual([IL_A, IL_B, IL_C]);
    expect(FED_A + FED_B).toBe(141116);
    expect(FED_B + FED_C).toBe(82206);
    expect(IL_A + IL_B).toBe(29761);
    expect(3 * IL_A).toBe(55779);
    expect(3 * IL_A + IL_B).toBe(66947);
  });
});

// ---------------------------------------------------------------------------
// Federal (month 2026-12, due 2027-01-15)
// ---------------------------------------------------------------------------

describe("PAY-193 L3 federal shortfall rows", () => {
  it("S-D1 (guard): seq 0 pending takes the new amount; no new row", async () => {
    await issue(A, "2026-12-15", null);
    await sync("2027-01-10");
    expect(await live("federal")).toEqual([`0 month ${DEC} ${FED_A} ${FED_DUE} pending`]);
    await issue(B, "2026-12-31", null);
    await sync("2027-01-10");
    expect(await live("federal")).toEqual([`0 month ${DEC} ${FED_A + FED_B} ${FED_DUE} pending`]);
    expect(await shortfallAudits()).toEqual([]);
    await invariants();
  });

  it("S-D2: seq 0 overdue (today 2027-01-20) stays; seq 1 overdue holds the added liability, due 2027-01-15; one audit row", async () => {
    await issue(A, "2026-12-15", null);
    await sync("2027-01-20");
    const before = await liveRow("federal", DEC, 0);
    expect([before.c, before.status]).toEqual([FED_A, "overdue"]);

    await issue(B, "2026-12-31", null);
    const res = await sync("2027-01-20");
    expect(await live("federal")).toEqual([
      `0 month ${DEC} ${FED_A} ${FED_DUE} overdue`,
      `1 month ${DEC} ${FED_B} ${FED_DUE} overdue`,
    ]);
    const after0 = await liveRow("federal", DEC, 0);
    expect(after0.id).toBe(before.id);
    expect(res.created).toBe(1);
    expect(await shortfallAudits()).toEqual([
      {
        action: SHORTFALL,
        after: {
          jurisdiction: "federal",
          periodStart: DEC,
          periodKind: "month",
          seq: 1,
          cents: FED_B,
        },
      },
    ]);
    await invariants();
  });

  it("S-D3: seq 0 deposited (today 2027-01-10) -> seq 1 pending, due 2027-01-15; deposited row untouched", async () => {
    await issue(A, "2026-12-15", null);
    await sync("2027-01-08");
    const r0 = await liveRow("federal", DEC, 0);
    await deposit(r0.id, "2027-01-08", "EFTPS-SYN-L3-1");

    await issue(B, "2026-12-31", null);
    await sync("2027-01-10");
    expect(await live("federal")).toEqual([
      `0 month ${DEC} ${FED_A} ${FED_DUE} deposited`,
      `1 month ${DEC} ${FED_B} ${FED_DUE} pending`,
    ]);
    const d0 = await liveRow("federal", DEC, 0);
    expect([d0.on, d0.conf]).toEqual(["2027-01-08", "EFTPS-SYN-L3-1"]);
    expect(await shortfallAudits()).toHaveLength(1);
    expect((await shortfallAudits())[0]!.after).toEqual({
      jurisdiction: "federal",
      periodStart: DEC,
      periodKind: "month",
      seq: 1,
      cents: FED_B,
    });
    await invariants();
  });

  it("S-D4: S-D3 then another December run -> seq 1 grows; still exactly one pending row; no second audit row", async () => {
    await issue(A, "2026-12-15", null);
    await sync("2027-01-08");
    await deposit((await liveRow("federal", DEC, 0)).id, "2027-01-08", "EFTPS-SYN-L3-2");
    await issue(B, "2026-12-31", null);
    await sync("2027-01-10");
    const s1 = await liveRow("federal", DEC, 1);

    await issue(C, "2026-12-31", null);
    await sync("2027-01-11");
    expect(await live("federal")).toEqual([
      `0 month ${DEC} ${FED_A} ${FED_DUE} deposited`,
      `1 month ${DEC} ${FED_B + FED_C} ${FED_DUE} pending`,
    ]);
    expect((await liveRow("federal", DEC, 1)).id).toBe(s1.id);
    expect(await shortfallAudits()).toHaveLength(1);
    await invariants();
  });

  it("S-D4b: seq 1 deposited too, then a third run -> seq 2 (max+1) for the remainder only", async () => {
    await issue(A, "2026-12-15", null);
    await sync("2027-01-08");
    await deposit((await liveRow("federal", DEC, 0)).id, "2027-01-08", "EFTPS-SYN-L3-3");
    await issue(B, "2026-12-31", null);
    await sync("2027-01-10");
    await deposit((await liveRow("federal", DEC, 1)).id, "2027-01-12", "EFTPS-SYN-L3-4");

    await issue(C, "2026-12-31", null);
    await sync("2027-01-13");
    expect(await live("federal")).toEqual([
      `0 month ${DEC} ${FED_A} ${FED_DUE} deposited`,
      `1 month ${DEC} ${FED_B} ${FED_DUE} deposited`,
      `2 month ${DEC} ${FED_C} ${FED_DUE} pending`,
    ]);
    expect((await shortfallAudits()).map((a) => a.after)).toEqual([
      { jurisdiction: "federal", periodStart: DEC, periodKind: "month", seq: 1, cents: FED_B },
      { jurisdiction: "federal", periodStart: DEC, periodKind: "month", seq: 2, cents: FED_C },
    ]);
    await invariants();
  });

  it("F counts overdue: seq 0 deposited + seq 1 overdue, a third run -> seq 2 overdue for that run only", async () => {
    await issue(A, "2026-12-15", null);
    await sync("2027-01-08");
    await deposit((await liveRow("federal", DEC, 0)).id, "2027-01-08", "EFTPS-SYN-L3-5");
    await issue(B, "2026-12-31", null);
    await sync("2027-01-20"); // seq 1 inserted overdue (2027-01-15 has passed)
    expect((await liveRow("federal", DEC, 1)).status).toBe("overdue");

    await issue(C, "2026-12-31", null);
    await sync("2027-01-21");
    expect(await live("federal")).toEqual([
      `0 month ${DEC} ${FED_A} ${FED_DUE} deposited`,
      `1 month ${DEC} ${FED_B} ${FED_DUE} overdue`,
      `2 month ${DEC} ${FED_C} ${FED_DUE} overdue`,
    ]);
    await invariants();
  });

  it("due-date boundary: shortfall on the due date itself is pending; the day after it is overdue; due date never moves", async () => {
    await issue(A, "2026-12-15", null);
    await sync("2027-01-08");
    await deposit((await liveRow("federal", DEC, 0)).id, "2027-01-08", "EFTPS-SYN-L3-6");
    await issue(B, "2026-12-31", null);
    await sync(FED_DUE);
    expect((await live("federal"))[1]).toBe(`1 month ${DEC} ${FED_B} ${FED_DUE} pending`);
    await sync("2027-01-16");
    expect((await live("federal"))[1]).toBe(`1 month ${DEC} ${FED_B} ${FED_DUE} overdue`);
  });

  it("original due date kept long after: shortfall found 2027-03-10 is due 2027-01-15, overdue", async () => {
    await issue(A, "2026-12-15", null);
    await sync("2027-01-08");
    await deposit((await liveRow("federal", DEC, 0)).id, "2027-01-08", "EFTPS-SYN-L3-7");
    await issue(B, "2026-12-31", null);
    await sync("2027-03-10");
    expect(await live("federal")).toEqual([
      `0 month ${DEC} ${FED_A} ${FED_DUE} deposited`,
      `1 month ${DEC} ${FED_B} ${FED_DUE} overdue`,
    ]);
  });

  it("S-D8 (federal): void lowers L below the deposited amount -> R < 0 writes no row; idempotent", async () => {
    await issue(A, "2026-12-15", null);
    const rB = await issue(B, "2026-12-31", null);
    await sync("2027-01-08");
    await deposit((await liveRow("federal", DEC, 0)).id, "2027-01-08", "EFTPS-SYN-L3-8");
    await voidRun(rB); // L = 910.33 < F = 1,411.16 -> R = -500.83

    const first = await sync("2027-01-10");
    const img = await image();
    const second = await sync("2027-01-10");
    expect(await live("federal")).toEqual([`0 month ${DEC} ${FED_A + FED_B} ${FED_DUE} deposited`]);
    expect([first.created, second.created, second.recomputed]).toEqual([0, 0, 0]);
    expect(await image()).toBe(img);
    expect(await shortfallAudits()).toEqual([]);
    await invariants();
  });

  it("S-D8b (federal): open seq 1 shrinks to 0.00 (never negative) when voids drop L to or below F", async () => {
    const rA = await issue(A, "2026-12-15", null);
    await sync("2027-01-08");
    await deposit((await liveRow("federal", DEC, 0)).id, "2027-01-08", "EFTPS-SYN-L3-9");
    const rB = await issue(B, "2026-12-31", null);
    await sync("2027-01-10");
    expect((await liveRow("federal", DEC, 1)).c).toBe(FED_B);

    await voidRun(rB); // R = 0
    await sync("2027-01-11");
    expect(await live("federal")).toEqual([
      `0 month ${DEC} ${FED_A} ${FED_DUE} deposited`,
      `1 month ${DEC} 0 ${FED_DUE} pending`,
    ]);
    await voidRun(rA); // R = -910.33 -> P = max(0, R) = 0
    await sync("2027-01-20");
    expect(await live("federal")).toEqual([
      `0 month ${DEC} ${FED_A} ${FED_DUE} deposited`,
      `1 month ${DEC} 0 ${FED_DUE} pending`,
    ]);
    expect(await shortfallAudits()).toHaveLength(1);
    await invariants();
  });

  it("idempotent: a second sync after a shortfall insert writes nothing and no second audit row", async () => {
    await issue(A, "2026-12-15", null);
    await sync("2027-01-20");
    await issue(B, "2026-12-31", null);
    await sync("2027-01-20");
    const img = await image();
    const again = await sync("2027-01-20");
    expect([again.created, again.recomputed, again.flippedOverdue]).toEqual([0, 0, 0]);
    expect(await image()).toBe(img);
    expect(await live("federal")).toHaveLength(2);
    expect(await shortfallAudits()).toHaveLength(1);
  });

  it("detail and list expose seq so the web can label 'Additional deposit for December 2026'", async () => {
    await issue(A, "2026-12-15", null);
    await sync("2027-01-08");
    await deposit((await liveRow("federal", DEC, 0)).id, "2027-01-08", "EFTPS-SYN-L3-10");
    await issue(B, "2026-12-31", null);
    await sync("2027-01-10");
    const s1 = await liveRow("federal", DEC, 1);
    const d = await getDepositDetail(E.db, s1.id);
    expect(d).not.toBeNull();
    expect((d!.deposit as unknown as { seq?: number }).seq).toBe(1);
    const list = await listDeposits(E.db, { jurisdiction: "federal" });
    expect(list.map((r) => (r as unknown as { seq?: number }).seq).sort()).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// Illinois monthly (2026 schedule: monthly, due the 15th)
// ---------------------------------------------------------------------------

describe("PAY-193 L3 state shortfall rows — IL monthly", () => {
  it("S-D5: IL 2026-12 month row deposited, one more IL December run -> IL seq 1 month row = added IL withholding, due 2027-01-15", async () => {
    await issue(A, "2026-12-15");
    await sync("2027-01-08");
    await deposit((await liveRow("IL", DEC, 0)).id, "2027-01-08", "IL-SYN-L3-1");

    await issue(B, "2026-12-31");
    await sync("2027-01-10");
    expect(await live("IL")).toEqual([
      `0 month ${DEC} ${IL_A} ${IL_M_DUE} deposited`,
      `1 month ${DEC} ${IL_B} ${IL_M_DUE} pending`,
    ]);
    const il = (await shortfallAudits()).filter((a) => a.after?.jurisdiction === "IL");
    expect(il.map((a) => a.after)).toEqual([
      { jurisdiction: "IL", periodStart: DEC, periodKind: "month", seq: 1, cents: IL_B },
    ]);
    await invariants();
  });

  it("S-D5b: after the IL due date the seq 1 month row is inserted overdue on the original date", async () => {
    await issue(A, "2026-12-15");
    await sync("2027-01-08");
    await deposit((await liveRow("IL", DEC, 0)).id, "2027-01-08", "IL-SYN-L3-2");
    await issue(B, "2026-12-31");
    await sync("2027-01-20");
    expect(await live("IL")).toEqual([
      `0 month ${DEC} ${IL_A} ${IL_M_DUE} deposited`,
      `1 month ${DEC} ${IL_B} ${IL_M_DUE} overdue`,
    ]);
  });

  it("S-D5c: IL seq 1 open row grows with a further run; no seq 2 and one IL audit row", async () => {
    await issue(A, "2026-12-15");
    await sync("2027-01-08");
    await deposit((await liveRow("IL", DEC, 0)).id, "2027-01-08", "IL-SYN-L3-3");
    await issue(B, "2026-12-31");
    await sync("2027-01-10");
    await issue(C, "2026-12-31");
    await sync("2027-01-11");
    expect(await live("IL")).toEqual([
      `0 month ${DEC} ${IL_A} ${IL_M_DUE} deposited`,
      `1 month ${DEC} ${IL_B + IL_C} ${IL_M_DUE} pending`,
    ]);
    expect((await shortfallAudits()).filter((a) => a.after?.jurisdiction === "IL")).toHaveLength(1);
    await invariants();
  });

  it("S-D7 (guard): IL month row overdue (open) -> the same row's amount is updated; no seq 1 row", async () => {
    await issue(A, "2026-12-15");
    await sync("2027-01-20");
    const r0 = await liveRow("IL", DEC, 0);
    expect([r0.c, r0.status]).toEqual([IL_A, "overdue"]);

    await issue(B, "2026-12-31");
    await sync("2027-01-20");
    const il = (await rows("IL")).filter((r) => r.status !== "superseded");
    expect(il).toHaveLength(1);
    expect([il[0]!.id, il[0]!.c, il[0]!.due, il[0]!.status]).toEqual([
      r0.id,
      IL_A + IL_B,
      IL_M_DUE,
      "overdue",
    ]);
    expect((await shortfallAudits()).filter((a) => a.after?.jurisdiction === "IL")).toEqual([]);
  });

  it("S-D8 (IL monthly): void lowers L below the deposited amount -> no row, no negative; idempotent", async () => {
    await issue(A, "2026-12-15");
    const rB = await issue(B, "2026-12-31");
    await sync("2027-01-08");
    await deposit((await liveRow("IL", DEC, 0)).id, "2027-01-08", "IL-SYN-L3-4");
    await voidRun(rB);
    await sync("2027-01-10");
    const img = await image();
    const again = await sync("2027-01-10");
    expect(await live("IL")).toEqual([`0 month ${DEC} ${IL_A + IL_B} ${IL_M_DUE} deposited`]);
    expect([again.created, again.recomputed, again.superseded]).toEqual([0, 0, 0]);
    expect(await image()).toBe(img);
    expect((await shortfallAudits()).filter((a) => a.after?.jurisdiction === "IL")).toEqual([]);
    await invariants();
  });

  it("IL idempotent: second sync after the seq 1 insert writes nothing", async () => {
    await issue(A, "2026-12-15");
    await sync("2027-01-08");
    await deposit((await liveRow("IL", DEC, 0)).id, "2027-01-08", "IL-SYN-L3-5");
    await issue(B, "2026-12-31");
    await sync("2027-01-10");
    const img = await image();
    const again = await sync("2027-01-10");
    expect([again.created, again.recomputed, again.superseded]).toEqual([0, 0, 0]);
    expect(await image()).toBe(img);
    expect((await shortfallAudits()).filter((a) => a.after?.jurisdiction === "IL")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Illinois quarterly variant (synthetic schedule: quarterly, last day)
// ---------------------------------------------------------------------------

describe("PAY-193 L3 state shortfall rows — IL quarterly variant", () => {
  async function q4Paid(): Promise<number> {
    await setSchedule("IL", 2026, "quarterly", null);
    await issue(A, "2026-10-30");
    await issue(A, "2026-11-30");
    await issue(A, "2026-12-15");
    await sync("2027-01-08");
    const q = await liveRow("IL", Q4, 0);
    expect([q.kind, q.c, q.due, q.status]).toEqual(["quarter", 3 * IL_A, IL_Q_DUE, "pending"]);
    await deposit(q.id, "2027-01-08", "IL-SYN-Q4-1");
    return q.id;
  }

  it("S-D6: Q4 row deposited, one more IL December run -> IL seq 1 quarter row = ΣL − ΣD, due 2027-02-01", async () => {
    const qId = await q4Paid();
    await issue(B, "2026-12-31");
    await sync("2027-01-10");
    expect(await live("IL")).toEqual([
      `0 quarter ${Q4} ${3 * IL_A} ${IL_Q_DUE} deposited`,
      `1 quarter ${Q4} ${3 * IL_A + IL_B - 3 * IL_A} ${IL_Q_DUE} pending`,
    ]);
    expect((await liveRow("IL", Q4, 0)).id).toBe(qId);
    const il = (await shortfallAudits()).filter((a) => a.after?.jurisdiction === "IL");
    expect(il.map((a) => a.after)).toEqual([
      { jurisdiction: "IL", periodStart: Q4, periodKind: "quarter", seq: 1, cents: IL_B },
    ]);
    // Nothing superseded on the way.
    expect((await rows("IL")).filter((r) => r.status === "superseded")).toEqual([]);
    await invariants();
  });

  it("S-D6b: the open seq 1 quarter row grows with a further run; still one open quarter row", async () => {
    await q4Paid();
    await issue(B, "2026-12-31");
    await sync("2027-01-10");
    await issue(C, "2026-12-31");
    await sync("2027-02-03");
    expect(await live("IL")).toEqual([
      `0 quarter ${Q4} ${3 * IL_A} ${IL_Q_DUE} deposited`,
      `1 quarter ${Q4} ${IL_B + IL_C} ${IL_Q_DUE} overdue`,
    ]);
    expect((await shortfallAudits()).filter((a) => a.after?.jurisdiction === "IL")).toHaveLength(1);
    await invariants();
  });

  it("S-D6c: quarter paid in full (ΣL = ΣD) -> no 0.00 seq 1 row (reading; matches Spec 23 T34)", async () => {
    await q4Paid();
    await sync("2027-01-10");
    expect(await live("IL")).toEqual([`0 quarter ${Q4} ${3 * IL_A} ${IL_Q_DUE} deposited`]);
  });

  it("S-D8 (IL quarterly): seq 1 open, then voids drop ΣL to ΣD -> seq 1 is 0.00, never negative; idempotent", async () => {
    await q4Paid();
    const rB = await issue(B, "2026-12-31");
    await sync("2027-01-10");
    await voidRun(rB);
    await sync("2027-01-11");
    const img = await image();
    await sync("2027-01-11");
    expect(await image()).toBe(img);
    expect(await live("IL")).toEqual([
      `0 quarter ${Q4} ${3 * IL_A} ${IL_Q_DUE} deposited`,
      `1 quarter ${Q4} 0 ${IL_Q_DUE} pending`,
    ]);
    await invariants();
  });
});

// ---------------------------------------------------------------------------
// S-D9 — migration on main-shaped data; rollback hazard query (D9.9)
// ---------------------------------------------------------------------------

interface Journal {
  entries: { idx: number; tag: string }[];
}
/** Last migration on origin/main when L3 started (df027d3). */
const MAIN_LAST = "0025";

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

async function mainShapedDb(): Promise<PGlite> {
  const pg = new PGlite("memory://");
  await migrate(pg, (tag) => tag.slice(0, 4) <= MAIN_LAST);
  const ins = (j: string, start: string, kind: string, c: number, due: string, status: string) =>
    pg.query(
      `INSERT INTO tax_deposits (jurisdiction, period_start, period_kind, amount, due_date, status, superseded_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $6 = 'superseded' THEN now() END, 'scheduler')`,
      [j, start, kind, money(c), due, status],
    );
  await ins("federal", "2026-11-01", "month", 91033, "2026-12-15", "deposited");
  await ins("federal", DEC, "month", 91033, FED_DUE, "pending");
  // Superseded duplicates: two dead rows + one live row on the same key.
  await ins("IL", "2026-07-01", "month", 5000, "2026-08-17", "superseded");
  await ins("IL", "2026-07-01", "month", 5000, "2026-08-17", "superseded");
  await ins("IL", "2026-07-01", "month", 5000, "2026-08-17", "overdue");
  await ins("CA", "2026-07-01", "quarter", 24690, "2026-11-02", "superseded");
  await ins("CA", "2026-07-01", "quarter", 24690, "2026-11-02", "deposited");
  await ins("CA", "2026-08-01", "month", 12345, "2026-09-15", "superseded");
  return pg;
}

describe("S-D9 L3 migration on main-shaped rows", () => {
  it("every row seq = 0; new live index exists, old one gone; seq >= 0 check present", async () => {
    const pg = await mainShapedDb();
    try {
      await migrate(pg, (tag) => tag.slice(0, 4) > MAIN_LAST);
      const all = await pg.query<{ seq: string | null }>(
        `SELECT to_jsonb(d)->>'seq' AS seq FROM tax_deposits d ORDER BY id`,
      );
      expect(all.rows).toHaveLength(8);
      expect(all.rows.map((r) => r.seq)).toEqual(Array(8).fill("0"));

      const col = await pg.query<{
        data_type: string;
        is_nullable: string;
        column_default: string;
      }>(
        `SELECT data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_name = 'tax_deposits' AND column_name = 'seq'`,
      );
      expect(col.rows).toHaveLength(1);
      expect([col.rows[0]!.data_type, col.rows[0]!.is_nullable]).toEqual(["smallint", "NO"]);
      expect(col.rows[0]!.column_default).toMatch(/^0/);

      const idx = await pg.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE tablename = 'tax_deposits'
            AND indexname IN ('tax_deposits_live_period_seq_uniq', 'tax_deposits_live_period_uniq')`,
      );
      expect(idx.rows.map((r) => r.indexname)).toEqual(["tax_deposits_live_period_seq_uniq"]);
      expect(idx.rows[0]!.indexdef).toMatch(
        /UNIQUE INDEX tax_deposits_live_period_seq_uniq ON .*tax_deposits.*\(jurisdiction, period_start, period_kind, seq\) WHERE \(status <> 'superseded'::text\)/,
      );

      const con = await pg.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'tax_deposits_seq_check' AND conrelid = 'tax_deposits'::regclass`,
      );
      expect(con.rows).toHaveLength(1);
      expect(con.rows[0]!.def).toMatch(/CHECK \(\(seq >= 0\)\)/);
    } finally {
      await pg.close();
    }
  });

  it("after migration the key enforces one live row per (j, start, kind, seq); seq -1 is refused", async () => {
    const pg = await mainShapedDb();
    try {
      await migrate(pg, (tag) => tag.slice(0, 4) > MAIN_LAST);
      const put = (seq: number, status = "pending") =>
        pg.query(
          `INSERT INTO tax_deposits (jurisdiction, period_start, period_kind, seq, amount, due_date, status, superseded_at)
           VALUES ('federal', '2026-12-01', 'month', $1, '1.00', '2027-01-15', $2,
                   CASE WHEN $2 = 'superseded' THEN now() END)`,
          [seq, status],
        );
      await expect(put(0)).rejects.toThrow(); // live seq 0 already exists
      await expect(put(1)).resolves.toBeDefined();
      await expect(put(1)).rejects.toThrow(); // live seq 1 already exists
      await expect(put(1, "superseded")).resolves.toBeDefined(); // dead rows are outside the index
      await expect(put(-1)).rejects.toThrow(); // CHECK (seq >= 0)
    } finally {
      await pg.close();
    }
  });

  it("rollback-hazard query counts live federal pending rows with seq > 0 only", async () => {
    const pg = await mainShapedDb();
    try {
      await migrate(pg, (tag) => tag.slice(0, 4) > MAIN_LAST);
      const put = (j: string, start: string, seq: number, status: string) =>
        pg.query(
          `INSERT INTO tax_deposits (jurisdiction, period_start, period_kind, seq, amount, due_date, status, superseded_at)
           VALUES ($1, $2, 'month', $3, '1.00', '2027-01-15', $4,
                   CASE WHEN $4 = 'superseded' THEN now() END)`,
          [j, start, seq, status],
        );
      // The D9.9 pre-rollback check, verbatim.
      const HAZARD_SQL = `SELECT count(*) FROM tax_deposits WHERE jurisdiction = 'federal' AND seq > 0 AND status = 'pending'`;
      const hazard = async () =>
        Number((await pg.query<{ count: number | string }>(HAZARD_SQL)).rows[0]!.count);
      expect(await hazard()).toBe(0); // main-shaped data alone: rollback safe
      await put("federal", "2026-12-01", 1, "pending"); // counts
      await put("federal", "2026-11-01", 1, "pending"); // counts
      await put("federal", "2026-11-01", 2, "overdue"); // overdue: not counted
      await put("federal", "2026-10-01", 1, "deposited"); // deposited: not counted
      await put("IL", "2026-12-01", 1, "pending"); // state: not counted (old planner is safe)
      await put("federal", "2026-09-01", 1, "superseded"); // superseded: not counted
      expect(await hazard()).toBe(2);
    } finally {
      await pg.close();
    }
  });
});

// ===========================================================================
// L3 review round (Product Lead decisions after code review + UX review).
// Fail-first. Interfaces the code must meet:
//
//  R1 getDepositDetail (GET /api/admin/tax-deposits/:id returns it verbatim):
//     siblings: { id: number; seq: number; status: string; amount: "0.00" }[]
//       = the period's OTHER live rows (same jurisdiction, period_start,
//         period_kind; superseded excluded; this row excluded), seq ascending.
//     alreadyDeposited: "0.00" string = Σ siblings with status deposited or
//       overdue (federal F of D9.6). On a seq > 0 row:
//       liability − alreadyDeposited = deposit.amount.
//     additionalDeposit: { id: number; amount: "0.00" } | null — on a seq 0
//       row, its live seq > 0 sibling (null when there is none).
//  R2 syncFederalDeposit's pending-row UPDATE is guarded by status = 'pending':
//     a row deposited between the read and the UPDATE keeps its amount.
//  R3 every seq > 0 insert (federal and state) enqueues one email_outbox row
//     per active admin. Subject (after the "{company} — " prefix every
//     template carries): "Additional {stateName(j)} tax deposit for
//     {periodLabel(start, kind)}" — "Federal" / "Illinois"; "December 2026" /
//     "Q4 2026". Body: the copy sentences, no amount; "It is already past its
//     due date." only when inserted overdue. seq 0 inserts, growth of an open
//     seq > 0 row, and a no-op sync send nothing.
//  R4 calendar labels and the reminder subject of a seq > 0 row start with
//     "Additional " (subject: after the "{company} — " prefix).
//  R5 GET /api/export/tax-deposits rows carry `seq` (number).
//
// Cents below come from the oracle in the header (A/B/C, never the engine).
// ===========================================================================

interface Sibling {
  id: number;
  seq: number;
  status: string;
  amount: string;
}
interface ReviewDetail {
  deposit: { id: number; amount: string; seq?: number };
  liability: string;
  siblings?: Sibling[];
  alreadyDeposited?: string;
  additionalDeposit?: { id: number; amount: string } | null;
}

async function detail(id: number): Promise<ReviewDetail> {
  const d = await getDepositDetail(E.db, id);
  if (!d) throw new Error(`no detail for ${id}`);
  return d as unknown as ReviewDetail;
}

/** Federal: A deposited (seq 0), then B -> seq 1 pending. Returns [seq0 id, seq1 id]. */
async function fedSeq1Pending(): Promise<[number, number]> {
  await issue(A, "2026-12-15", null);
  await sync("2027-01-08");
  const r0 = await liveRow("federal", DEC, 0);
  await deposit(r0.id, "2027-01-08", "EFTPS-SYN-L3-R1");
  await issue(B, "2026-12-31", null);
  await sync("2027-01-10");
  return [r0.id, (await liveRow("federal", DEC, 1)).id];
}

describe("PAY-193 L3 review R1 — detail lists the period's other rows", () => {
  it("federal seq 1: siblings = [seq 0 deposited 910.33]; alreadyDeposited 910.33; liability 1,411.16 − 910.33 = amount 500.83", async () => {
    const [id0, id1] = await fedSeq1Pending();
    const d = await detail(id1);
    expect({
      amount: d.deposit.amount,
      liability: d.liability,
      siblings: d.siblings,
      alreadyDeposited: d.alreadyDeposited,
    }).toEqual({
      amount: money(FED_B),
      liability: money(FED_A + FED_B),
      siblings: [{ id: id0, seq: 0, status: "deposited", amount: money(FED_A) }],
      alreadyDeposited: money(FED_A),
    });
    expect(cents(d.liability) - cents(d.alreadyDeposited ?? "missing")).toBe(
      cents(d.deposit.amount),
    );
  });

  it("federal seq 0 with a live seq 1: additionalDeposit = {seq 1 id, 500.83}; siblings = [seq 1 pending]; alreadyDeposited 0.00", async () => {
    const [id0, id1] = await fedSeq1Pending();
    const d = await detail(id0);
    expect({
      additionalDeposit: d.additionalDeposit,
      siblings: d.siblings,
      alreadyDeposited: d.alreadyDeposited,
    }).toEqual({
      additionalDeposit: { id: id1, amount: money(FED_B) },
      siblings: [{ id: id1, seq: 1, status: "pending", amount: money(FED_B) }],
      alreadyDeposited: "0.00",
    });
  });

  it("federal seq 0 alone: additionalDeposit null, siblings [], alreadyDeposited 0.00", async () => {
    await issue(A, "2026-12-15", null);
    await sync("2027-01-08");
    const d = await detail((await liveRow("federal", DEC, 0)).id);
    expect({
      additionalDeposit: d.additionalDeposit,
      siblings: d.siblings,
      alreadyDeposited: d.alreadyDeposited,
    }).toEqual({ additionalDeposit: null, siblings: [], alreadyDeposited: "0.00" });
  });

  it("federal seq 2: siblings seq 0 + seq 1 deposited; alreadyDeposited 1,411.16; liability 1,732.39 − 1,411.16 = 321.23", async () => {
    const [id0, id1] = await fedSeq1Pending();
    await deposit(id1, "2027-01-12", "EFTPS-SYN-L3-R2");
    await issue(C, "2026-12-31", null);
    await sync("2027-01-13");
    const id2 = (await liveRow("federal", DEC, 2)).id;
    const d = await detail(id2);
    expect({
      amount: d.deposit.amount,
      liability: d.liability,
      siblings: d.siblings,
      alreadyDeposited: d.alreadyDeposited,
    }).toEqual({
      amount: money(FED_C),
      liability: money(FED_A + FED_B + FED_C),
      siblings: [
        { id: id0, seq: 0, status: "deposited", amount: money(FED_A) },
        { id: id1, seq: 1, status: "deposited", amount: money(FED_B) },
      ],
      alreadyDeposited: money(FED_A + FED_B),
    });
  });

  it("federal: an overdue sibling counts as already deposited (F of D9.6) — seq 2 overdue, alreadyDeposited = A + B", async () => {
    const [id0, id1] = await fedSeq1Pending();
    await sync("2027-01-20"); // seq 1 flips overdue
    await issue(C, "2026-12-31", null);
    await sync("2027-01-21");
    const d = await detail((await liveRow("federal", DEC, 2)).id);
    expect({ siblings: d.siblings, alreadyDeposited: d.alreadyDeposited }).toEqual({
      siblings: [
        { id: id0, seq: 0, status: "deposited", amount: money(FED_A) },
        { id: id1, seq: 1, status: "overdue", amount: money(FED_B) },
      ],
      alreadyDeposited: money(FED_A + FED_B),
    });
    expect(cents(d.liability) - cents(d.alreadyDeposited ?? "missing")).toBe(FED_C);
  });

  it("IL monthly seq 1: siblings = [seq 0 deposited 185.93]; liability 297.61 − 185.93 = 111.68", async () => {
    await issue(A, "2026-12-15");
    await sync("2027-01-08");
    const r0 = await liveRow("IL", DEC, 0);
    await deposit(r0.id, "2027-01-08", "IL-SYN-L3-R1");
    await issue(B, "2026-12-31");
    await sync("2027-01-10");
    const id1 = (await liveRow("IL", DEC, 1)).id;
    const d = await detail(id1);
    expect({
      amount: d.deposit.amount,
      liability: d.liability,
      siblings: d.siblings,
      alreadyDeposited: d.alreadyDeposited,
    }).toEqual({
      amount: money(IL_B),
      liability: money(IL_A + IL_B),
      siblings: [{ id: r0.id, seq: 0, status: "deposited", amount: money(IL_A) }],
      alreadyDeposited: money(IL_A),
    });
    const d0 = await detail(r0.id);
    expect(d0.additionalDeposit).toEqual({ id: id1, amount: money(IL_B) });
  });

  it("IL quarterly seq 1: liability 669.47 − alreadyDeposited 557.79 = 111.68; seq 0 quarter row links it", async () => {
    await setSchedule("IL", 2026, "quarterly", null);
    await issue(A, "2026-10-30");
    await issue(A, "2026-11-30");
    await issue(A, "2026-12-15");
    await sync("2027-01-08");
    const q0 = await liveRow("IL", Q4, 0);
    await deposit(q0.id, "2027-01-08", "IL-SYN-Q4-R1");
    await issue(B, "2026-12-31");
    await sync("2027-01-10");
    const q1 = await liveRow("IL", Q4, 1);
    const d = await detail(q1.id);
    expect({
      amount: d.deposit.amount,
      liability: d.liability,
      siblings: d.siblings,
      alreadyDeposited: d.alreadyDeposited,
    }).toEqual({
      amount: money(IL_B),
      liability: money(3 * IL_A + IL_B),
      siblings: [{ id: q0.id, seq: 0, status: "deposited", amount: money(3 * IL_A) }],
      alreadyDeposited: money(3 * IL_A),
    });
    expect((await detail(q0.id)).additionalDeposit).toEqual({ id: q1.id, amount: money(IL_B) });
  });
});

// ---------------------------------------------------------------------------
// R2 — race guard on the federal pending-row UPDATE (recorder/hook pattern of
// pay-193-l1-filed-guard.test.ts; PGlite is one connection, so the hook stands
// in for a markDeposited that lands between the sync's read and its UPDATE).
// ---------------------------------------------------------------------------

type RawClient = { query: (text: string, params?: unknown[], opts?: unknown) => Promise<unknown> };

async function withUpdateHook<T>(
  match: (text: string, params: unknown[]) => boolean,
  run: (client: RawClient) => Promise<void>,
  fn: () => Promise<T>,
): Promise<{ value: T; fired: boolean }> {
  const pg = E.pg as unknown as {
    transaction: (cb: (client: RawClient) => Promise<unknown>) => Promise<unknown>;
  };
  const orig = pg.transaction;
  let fired = false;
  pg.transaction = async (cb) =>
    orig.call(E.pg, async (client: RawClient) => {
      const wrapped = new Proxy(client as object, {
        get(target, prop) {
          if (prop === "query") {
            return async (text: string, params?: unknown[], opts?: unknown) => {
              if (!fired && match(text, params ?? [])) {
                fired = true;
                await run(target as RawClient);
              }
              return (target as RawClient).query(text, params, opts);
            };
          }
          const v = Reflect.get(target, prop) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      return cb(wrapped as RawClient);
    });
  try {
    return { value: await fn(), fired };
  } finally {
    pg.transaction = orig;
  }
}

describe("PAY-193 L3 review R2 — sync never overwrites a row deposited after its read", () => {
  it("seq 0 pending 910.33 is deposited just before the sync's UPDATE to 1,411.16 -> stays 910.33 deposited; next sync puts 500.83 on seq 1", async () => {
    await issue(A, "2026-12-15", null);
    await sync("2027-01-08");
    const r0 = await liveRow("federal", DEC, 0);
    expect([r0.c, r0.status]).toEqual([FED_A, "pending"]);
    await issue(B, "2026-12-31", null);

    const { fired } = await withUpdateHook(
      (text, params) =>
        /^\s*update\s+"?tax_deposits"?/i.test(text) && params.includes(money(FED_A + FED_B)),
      async (client) => {
        await client.query(
          `UPDATE tax_deposits SET status = 'deposited', deposited_on = '2027-01-09',
                  eftps_confirmation = 'EFTPS-SYN-L3-RACE' WHERE id = $1`,
          [r0.id],
        );
      },
      () => sync("2027-01-09"),
    );
    expect(fired, "hook reached the sync's pending-row UPDATE").toBe(true);
    const after = await liveRow("federal", DEC, 0);
    expect([after.id, after.c, after.status, after.on, after.conf]).toEqual([
      r0.id,
      FED_A,
      "deposited",
      "2027-01-09",
      "EFTPS-SYN-L3-RACE",
    ]);

    await sync("2027-01-10");
    expect(await live("federal")).toEqual([
      `0 month ${DEC} ${FED_A} ${FED_DUE} deposited`,
      `1 month ${DEC} ${FED_B} ${FED_DUE} pending`,
    ]);
    await invariants();
  });
});

// ---------------------------------------------------------------------------
// R3 — admin email on shortfall creation
// ---------------------------------------------------------------------------

const OVERDUE_LINE = "It is already past its due date.";

async function ensureAdmins(): Promise<string[]> {
  const put = (id: string, role: string, banned: boolean) =>
    E.pg.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", role, banned)
       VALUES ($1, $1, $1 || '@l3-review.test', true, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [id, role, banned],
    );
  await put("l3-admin-1", "admin", false);
  await put("l3-admin-2", "admin", false);
  await put("l3-admin-banned", "admin", true);
  await put("l3-employee", "user", false);
  const r = await E.pg.query<{ id: string }>(
    `SELECT id FROM "user" WHERE role = 'admin' AND coalesce(banned, false) = false ORDER BY id`,
  );
  return r.rows.map((x) => x.id);
}

interface Mail {
  userId: string;
  subject: string;
  body: string;
}
async function outbox(): Promise<Mail[]> {
  const r = await E.pg.query<Mail>(
    `SELECT user_id AS "userId", subject, body_html AS body FROM email_outbox ORDER BY id`,
  );
  return r.rows;
}

/** Subject without the "{company} — " prefix every template carries. */
function bare(subject: string): string {
  const i = subject.indexOf(" — ");
  return i < 0 ? subject : subject.slice(i + 3);
}

function expectShortfallMail(
  mails: Mail[],
  admins: string[],
  j: string,
  period: string,
  overdue: boolean,
): void {
  expect(mails.map((m) => m.userId).sort()).toEqual([...admins].sort());
  for (const m of mails) {
    expect(bare(m.subject)).toBe(`Additional ${j} tax deposit for ${period}`);
    expect(m.body).toContain(
      `A payroll for ${period} was issued after the ${j} deposit for that period was made.`,
    );
    expect(m.body).toContain("added an additional deposit for the difference.");
    expect(m.body).toContain("Open Tax deposits to see the amount and due date.");
    expect(m.body.includes(OVERDUE_LINE)).toBe(overdue);
    expect(m.body, "no amount in the mail").not.toMatch(/\$/);
    expect(m.body, "no amount in the mail").not.toMatch(/\d+\.\d{2}/);
    expect(m.subject).not.toMatch(/\$|\d+\.\d{2}/);
  }
}

describe("PAY-193 L3 review R3 — admin email when a shortfall row is created", () => {
  it("federal seq 1 inserted pending: one mail per active admin, 'Additional Federal tax deposit for December 2026', no overdue line; seq 0 insert sent none", async () => {
    const admins = await ensureAdmins();
    expect(admins).toEqual(expect.arrayContaining(["l3-admin-1", "l3-admin-2"]));
    await issue(A, "2026-12-15", null);
    await sync("2027-01-08");
    expect(await outbox(), "seq 0 insert sends no shortfall mail").toEqual([]);
    await deposit((await liveRow("federal", DEC, 0)).id, "2027-01-08", "EFTPS-SYN-L3-M1");
    await issue(B, "2026-12-31", null);
    await sync("2027-01-10");
    expectShortfallMail(await outbox(), admins, "Federal", "December 2026", false);
  });

  it("federal seq 1 inserted overdue: body carries 'It is already past its due date.'", async () => {
    const admins = await ensureAdmins();
    await issue(A, "2026-12-15", null);
    await sync("2027-01-20"); // seq 0 overdue, frozen
    await E.pg.exec(`TRUNCATE email_outbox`);
    await issue(B, "2026-12-31", null);
    await sync("2027-01-20");
    expectShortfallMail(await outbox(), admins, "Federal", "December 2026", true);
  });

  it("idempotent: a second sync, and seq 1 growing with a further run, add no mail", async () => {
    const admins = await ensureAdmins();
    await fedSeq1Pending();
    const n = (await outbox()).length;
    expect(n).toBe(admins.length);
    await sync("2027-01-10");
    expect(await outbox()).toHaveLength(n);
    await issue(C, "2026-12-31", null);
    await sync("2027-01-11"); // seq 1 grows, no insert
    expect(await outbox()).toHaveLength(n);
  });

  it("a second shortfall row (seq 2) sends its own mail", async () => {
    const admins = await ensureAdmins();
    const [, id1] = await fedSeq1Pending();
    await deposit(id1, "2027-01-12", "EFTPS-SYN-L3-M2");
    await E.pg.exec(`TRUNCATE email_outbox`);
    await issue(C, "2026-12-31", null);
    await sync("2027-01-13");
    expectShortfallMail(await outbox(), admins, "Federal", "December 2026", false);
  });

  it("IL monthly seq 1: 'Additional Illinois tax deposit for December 2026'; overdue line only when inserted overdue", async () => {
    const admins = await ensureAdmins();
    await issue(A, "2026-12-15");
    await sync("2027-01-08");
    await deposit((await liveRow("IL", DEC, 0)).id, "2027-01-08", "IL-SYN-L3-M1");
    await deposit((await liveRow("federal", DEC, 0)).id, "2027-01-08", "EFTPS-SYN-L3-M3");
    await E.pg.exec(`TRUNCATE email_outbox`);
    await issue(B, "2026-12-31");
    await sync("2027-01-20"); // both seq 1 rows inserted overdue (due 2027-01-15)
    const mails = await outbox();
    expectShortfallMail(
      mails.filter((m) => bare(m.subject).includes("Illinois")),
      admins,
      "Illinois",
      "December 2026",
      true,
    );
    expectShortfallMail(
      mails.filter((m) => bare(m.subject).includes("Federal")),
      admins,
      "Federal",
      "December 2026",
      true,
    );
    expect(mails).toHaveLength(2 * admins.length);
    await sync("2027-01-20");
    expect(await outbox()).toHaveLength(2 * admins.length);
  });

  it("IL quarterly seq 1: 'Additional Illinois tax deposit for Q4 2026', pending (due 2027-02-01)", async () => {
    const admins = await ensureAdmins();
    await setSchedule("IL", 2026, "quarterly", null);
    await issue(A, "2026-10-30", "IL");
    await issue(A, "2026-11-30", "IL");
    await issue(A, "2026-12-15", "IL");
    await sync("2027-01-08");
    await deposit((await liveRow("IL", Q4, 0)).id, "2027-01-08", "IL-SYN-Q4-M1");
    await E.pg.exec(`TRUNCATE email_outbox`);
    await issue(B, "2026-12-31");
    await sync("2027-01-10");
    // Federal December seq 0 is still pending (never deposited): it grows, no mail.
    expectShortfallMail(await outbox(), admins, "Illinois", "Q4 2026", false);
  });
});

// ---------------------------------------------------------------------------
// R4 — calendar labels and reminder subject
// ---------------------------------------------------------------------------

describe("PAY-193 L3 review R4 — 'Additional ' on calendar entries and reminders", () => {
  it("calendar January 2027: seq 1 due -> 'Additional 941 deposit due — December 2026'; seq 0 keeps '941 deposit due — December 2026'", async () => {
    const [, id1] = await fedSeq1Pending();
    const events = await monthCalendar(E.db, 2027, 1);
    const due = events
      .filter((e) => e.kind === "deposit_due")
      .map((e) => [(e.link?.params as { id?: number } | undefined)?.id, e.label]);
    expect(due).toEqual(
      expect.arrayContaining([[id1, "Additional 941 deposit due — December 2026"]]),
    );
    expect(due.filter(([id]) => id !== id1).map(([, l]) => l)).toEqual([
      "941 deposit due — December 2026",
    ]);
  });

  it("calendar: seq 1 made -> 'Additional 941 deposit made — December 2026'; IL seq 1 due -> 'Additional Illinois deposit due — December 2026'", async () => {
    await issue(A, "2026-12-15");
    await sync("2027-01-08");
    await deposit((await liveRow("federal", DEC, 0)).id, "2027-01-08", "EFTPS-SYN-L3-C1");
    await deposit((await liveRow("IL", DEC, 0)).id, "2027-01-08", "IL-SYN-L3-C1");
    await issue(B, "2026-12-31");
    await sync("2027-01-10");
    const f1 = (await liveRow("federal", DEC, 1)).id;
    const il1 = (await liveRow("IL", DEC, 1)).id;
    await deposit(f1, "2027-01-12", "EFTPS-SYN-L3-C2");
    const events = await monthCalendar(E.db, 2027, 1);
    const label = (kind: string, id: number) =>
      events
        .filter(
          (e) => e.kind === kind && (e.link?.params as { id?: number } | undefined)?.id === id,
        )
        .map((e) => e.label);
    expect(label("deposit_made", f1)).toEqual(["Additional 941 deposit made — December 2026"]);
    expect(label("deposit_due", il1)).toEqual(["Additional Illinois deposit due — December 2026"]);
  });

  it("reminder (offset 5, today 2027-01-10) for a seq 1 row: subject starts 'Additional '", async () => {
    const admins = await ensureAdmins();
    await fedSeq1Pending();
    await E.pg.exec(`TRUNCATE email_outbox`);
    const res = await sendDepositReminders({ db: E.db, config: E.config }, { today: "2027-01-10" });
    expect(res.sent).toBe(1);
    const mails = await outbox();
    expect(mails).toHaveLength(admins.length);
    for (const m of mails) expect(bare(m.subject)).toMatch(/^Additional /);
  });

  it("reminder for a seq 0 row does not say 'Additional'", async () => {
    await ensureAdmins();
    await issue(A, "2026-12-15", null);
    await sync("2027-01-08");
    await E.pg.exec(`TRUNCATE email_outbox`);
    await sendDepositReminders({ db: E.db, config: E.config }, { today: "2027-01-10" });
    const mails = await outbox();
    expect(mails.length).toBeGreaterThan(0);
    for (const m of mails) expect(m.subject).not.toMatch(/Additional/);
  });
});

// ---------------------------------------------------------------------------
// R5 — export rows carry seq (own app + DB; synthetic rows)
// ---------------------------------------------------------------------------

describe("PAY-193 L3 review R5 — GET /api/export/tax-deposits includes seq", () => {
  const TOKEN = "test-export-token-pay193-l3-0123456789";
  let t: TestContext;

  beforeAll(async () => {
    t = await createTestApp({ exportToken: TOKEN });
    await t.pglite.query(
      `INSERT INTO tax_deposits (jurisdiction, period_start, period_kind, seq, amount, due_date, status, deposited_on, eftps_confirmation, created_by)
       VALUES ('federal', '2026-12-01', 'month', 0, '910.33', '2027-01-15', 'deposited', '2027-01-08', 'EFTPS-SYN-L3-X1', 'scheduler'),
              ('federal', '2026-12-01', 'month', 1, '500.83', '2027-01-15', 'pending', NULL, NULL, 'scheduler'),
              ('IL', '2026-12-01', 'month', 0, '185.93', '2027-01-15', 'deposited', '2027-01-08', 'IL-SYN-L3-X1', 'scheduler'),
              ('IL', '2026-12-01', 'month', 1, '111.68', '2027-01-15', 'overdue', NULL, NULL, 'scheduler')`,
    );
  }, 180_000);

  afterAll(async () => {
    await t?.close();
  });

  it("every row has seq; (jurisdiction, seq, amountCents) match the stored rows", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/api/export/tax-deposits?from=2026-12-01&to=2026-12-01",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      deposits: { jurisdiction: string; seq?: number; amountCents: number }[];
    };
    expect(
      body.deposits
        .map((d) => [d.jurisdiction, d.seq, d.amountCents])
        .sort((a, b) => (`${a[0]}${a[1]}` < `${b[0]}${b[1]}` ? -1 : 1)),
    ).toEqual([
      ["IL", 0, IL_A],
      ["IL", 1, IL_B],
      ["federal", 0, FED_A],
      ["federal", 1, FED_B],
    ]);
  });
});

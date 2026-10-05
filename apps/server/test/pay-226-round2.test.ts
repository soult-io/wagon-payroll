/**
 * PAY-226 round 2 — review notes R2-1..R2-4 (code-reviewer LOW 3/4/5, federal
 * SME note 1). Auditor-owned (payroll-calc-auditor). Fail-first.
 *
 *  R2-1 The daily sync never moves an overdue row back to pending (only the
 *       late-issue path decides status itself), so a stored due_date that
 *       differs from dueDateFor() cannot make the row flip-flop.
 *  R2-2 Changing the amount of an open (pending/overdue) federal row writes one
 *       `tax_deposit.recomputed` audit row, actor = the sync actor.
 *  R2-3 `tax_deposit.shortfall_superseded` gives a reason PER superseded row:
 *       "no liability for the month" when that month's L = 0 and D = 0, else
 *       the quarter-netting reason.
 *  R2-4 Quarters planned = union of quarters with an issued run OR an open
 *       federal row.
 *
 * Assumed contract (named so the implementer can match it):
 *  - recomputed audit: action 'tax_deposit.recomputed', entity 'tax_deposit',
 *    entity_id = String(row id), actor_id = the sync actor ('scheduler' on the
 *    tick, the confirming admin on the late-issue path);
 *    before ⊇ { cents: old }, after ⊇ { cents: new, poolCents,
 *    months: [{ periodStart, liabilityCents, depositedCents }, …] }.
 *  - superseded audit: after.reasons = [{ id, reason }, …] — one entry per
 *    superseded row id (extra keys allowed).
 *
 * Oracle (integer cents, independent of the app; synthetic figures, see
 * pay-226-federal-quarter-sync.test.ts for the run derivations):
 *   P32 = 71234, P06 = 14074; P32 + P06 = 85308.
 *   Due dates (15th of next month, weekend roll — app V1): Feb 2026 →
 *   2026-03-16, Mar 2026 → 2026-04-15, Jul 2026 → 2026-08-17 (Aug 15 is a Saturday).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@payroll/db";
import { company, employees, seedDatabase, type SeedDb } from "@payroll/db";
import { loadConfig, type AppConfig } from "../src/config.js";
import type { Db } from "../src/db.js";
import { syncDeposits, syncDepositsForPayDate, type SyncResult } from "../src/deposits/service.js";
import { runMigrations } from "./helpers.js";

interface Pay {
  fit: number;
  ss: number;
  med: number;
}
const P32: Pay = { fit: 22274, ss: 19840, med: 4640 }; // 71234
const P06: Pay = { fit: 4894, ss: 3720, med: 870 }; // 14074
const fed = (p: Pay): number => p.fit + 2 * p.ss + 2 * p.med;

const JAN = "2026-01-01";
const FEB = "2026-02-01";
const MAR = "2026-03-01";
const JUL = "2026-07-01";
const AUG = "2026-08-01";

const RECOMPUTED = "tax_deposit.recomputed";
const SUPERSEDED = "tax_deposit.shortfall_superseded";
const NETTING = "covered by deposits for the same quarter (IRC 6656(e); Pub 15 (2026) §11)";
const NO_LIABILITY = "no liability for the month";

function money(c: number): string {
  const a = Math.abs(c);
  return `${c < 0 ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}
function cents(s: string): number {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(s);
  if (!m) throw new Error(`not a 2dp money string: ${s}`);
  const v = Number(m[2]) * 100 + Number(m[3]);
  return m[1] ? -v : v;
}

interface Env {
  pg: PGlite;
  db: Db;
  config: AppConfig;
}
let E: Env;

beforeAll(async () => {
  const pg = new PGlite("memory://");
  await runMigrations(pg);
  const db = drizzle(pg, { schema }) as unknown as Db;
  await seedDatabase(db as unknown as SeedDb);
  E = {
    pg,
    db,
    config: loadConfig({
      nodeEnv: "test",
      logLevel: "silent",
      baseUrl: "http://localhost",
      sessionSecret: "test-secret-0123456789abcdef0123456789abcdef",
    }),
  };
}, 180_000);

afterAll(async () => {
  await E?.pg.close();
});

beforeEach(async () => {
  await E.pg.exec(
    `TRUNCATE tax_deposits, payroll_entries, payroll_runs, state_deposit_schedules, email_outbox,
              audit_events RESTART IDENTITY CASCADE`,
  );
});

let empSeq = 0;
async function employee(): Promise<number> {
  empSeq += 1;
  const c = await E.db.select({ id: company.id }).from(company).limit(1);
  const rows = await E.db
    .insert(employees)
    .values({
      companyId: c[0]!.id,
      legalName: `PAY-226 R2 Synthetic ${empSeq}`,
      hireDate: "2025-01-01",
    })
    .returning();
  return rows[0]!.id;
}

function lastDayOf(iso: string): string {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), 0));
  return d.toISOString().slice(0, 10);
}

async function issue(p: Pay, payDate: string): Promise<number> {
  const emp = await employee();
  const r = await E.pg.query<{ id: number }>(
    `INSERT INTO payroll_runs (employee_id, period_start, period_end, pay_date, status, run_snapshot, issued_at)
     VALUES ($1, $2, $3, $4, 'issued', '{"inputs":{}}'::jsonb, now()) RETURNING id`,
    [emp, `${payDate.slice(0, 7)}-01`, lastDayOf(payDate), payDate],
  );
  const id = r.rows[0]!.id;
  for (const [category, c] of [
    ["federal_withholding", p.fit],
    ["social_security", p.ss],
    ["medicare", p.med],
    ["employer_social_security", p.ss],
    ["employer_medicare", p.med],
  ] as const) {
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
    `UPDATE payroll_runs SET status='void', voided_at=now(), void_reason='PAY-226 R2 scenario' WHERE id=$1`,
    [id],
  );
}

async function fedRow(o: {
  start: string;
  seq?: number;
  c: number;
  due: string;
  status: "pending" | "overdue" | "deposited";
  on?: string;
}): Promise<number> {
  const r = await E.pg.query<{ id: number }>(
    `INSERT INTO tax_deposits (jurisdiction, period_start, period_kind, seq, amount, due_date, status,
                               deposited_on, eftps_confirmation, created_by)
     VALUES ('federal', $1, 'month', $2, $3, $4, $5, $6, $7, 'scheduler') RETURNING id`,
    [
      o.start,
      o.seq ?? 0,
      money(o.c),
      o.due,
      o.status,
      o.status === "deposited" ? (o.on ?? o.due) : null,
      o.status === "deposited" ? `SYN-${o.start}-${o.seq ?? 0}` : null,
    ],
  );
  return r.rows[0]!.id;
}

async function sync(today: string): Promise<SyncResult> {
  return syncDeposits({ db: E.db, config: E.config }, { today });
}

async function lateSync(payDate: string, today: string, actorId: string): Promise<string[]> {
  return E.db.transaction(async (tx) =>
    syncDepositsForPayDate(tx, E.config, { payDate, jurisdictions: [], today, actorId }),
  );
}

interface Row {
  id: number;
  start: string;
  seq: number;
  c: number;
  due: string;
  status: string;
}
async function rowById(id: number): Promise<Row> {
  const r = await E.pg.query<{
    id: number;
    start: string;
    seq: number;
    amount: string;
    due: string;
    status: string;
  }>(
    `SELECT id, period_start::text AS start, seq, amount::text AS amount, due_date::text AS due, status
       FROM tax_deposits WHERE id = $1`,
    [id],
  );
  const x = r.rows[0];
  if (!x) throw new Error(`no row ${id}`);
  return {
    id: x.id,
    start: x.start,
    seq: Number(x.seq),
    c: cents(x.amount),
    due: x.due,
    status: x.status,
  };
}
async function live(): Promise<string[]> {
  const r = await E.pg.query<{ start: string; seq: number; amount: string; status: string }>(
    `SELECT period_start::text AS start, seq, amount::text AS amount, status FROM tax_deposits
      WHERE jurisdiction = 'federal' AND status <> 'superseded' ORDER BY period_start, seq, id`,
  );
  return r.rows.map((x) => `${x.start} ${x.seq} ${cents(x.amount)} ${x.status}`);
}
async function image(): Promise<string> {
  const r = await E.pg.query<{ s: string }>(
    `SELECT coalesce(json_agg(to_jsonb(d) - 'updated_at' ORDER BY id), '[]')::text AS s FROM tax_deposits d`,
  );
  return r.rows[0]!.s;
}

interface Audit {
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}
async function audits(action: string): Promise<Audit[]> {
  const r = await E.pg.query<Audit>(
    `SELECT actor_id AS "actorId", action, entity, entity_id AS "entityId", before, after
       FROM audit_events WHERE action = $1 ORDER BY id`,
    [action],
  );
  return r.rows;
}

function counters(r: SyncResult): number[] {
  return [r.created, r.recomputed, r.flippedOverdue, r.superseded];
}

describe("PAY-226 R2 oracle", () => {
  it("synthetic run totals", () => {
    expect([fed(P32), fed(P06), fed(P32) + fed(P06)]).toEqual([71234, 14074, 85308]);
  });
});

// ---------------------------------------------------------------------------
// R2-1 — the daily sync never moves overdue back to pending
// ---------------------------------------------------------------------------

describe("PAY-226 R2-1 no overdue -> pending on the daily path", () => {
  it("R2-1a: stored due_date 2026-03-10 EARLIER than dueDateFor (2026-03-16), today 2026-03-12: the overdue row stays overdue across two syncs; both syncs write nothing", async () => {
    await issue(P32, "2026-02-15");
    const id = await fedRow({ start: FEB, c: 71234, due: "2026-03-10", status: "overdue" });
    const img = await image();

    const first = await sync("2026-03-12");
    const r1 = await rowById(id);
    expect([r1.c, r1.status, r1.due]).toEqual([71234, "overdue", "2026-03-10"]);
    expect(counters(first)).toEqual([0, 0, 0, 0]);

    const second = await sync("2026-03-12");
    expect((await rowById(id)).status).toBe("overdue");
    expect(counters(second)).toEqual([0, 0, 0, 0]);
    expect(await image()).toBe(img);
    expect(await audits(RECOMPUTED)).toEqual([]);
  });

  it("R2-1b: stored due_date 2026-03-20 LATER than dueDateFor (2026-03-16), today 2026-03-18 between them: an overdue row stays overdue; the second sync's counters are 0", async () => {
    await issue(P32, "2026-02-15");
    const id = await fedRow({ start: FEB, c: 71234, due: "2026-03-20", status: "overdue" });
    await sync("2026-03-18");
    expect((await rowById(id)).status).toBe("overdue");
    const img = await image();
    const second = await sync("2026-03-18");
    expect((await rowById(id)).status).toBe("overdue");
    expect(counters(second)).toEqual([0, 0, 0, 0]);
    expect(await image()).toBe(img);
  });

  it("R2-1c: an overdue row whose amount changes on the daily path keeps status overdue even when dueDateFor is still ahead", async () => {
    // Feb row stored due 2026-03-10 (earlier than dueDateFor 2026-03-16);
    // a second Feb run raises L to 85308; today 2026-03-12.
    await issue(P32, "2026-02-15");
    await issue(P06, "2026-02-20");
    const id = await fedRow({ start: FEB, c: 71234, due: "2026-03-10", status: "overdue" });
    await sync("2026-03-12");
    const r = await rowById(id);
    expect([r.c, r.status, r.due]).toEqual([85308, "overdue", "2026-03-10"]);
    const second = await sync("2026-03-12");
    expect(counters(second)).toEqual([0, 0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// R2-2 — amount changes on open rows are audited
// ---------------------------------------------------------------------------

describe("PAY-226 R2-2 tax_deposit.recomputed", () => {
  it("R2-2a: a pending Jan row raised 71234 -> 85308 by a new run writes one recomputed audit (scheduler, before/after cents, L/D/pool); a repeat sync writes none", async () => {
    await issue(P32, "2026-01-15");
    await sync("2026-01-20");
    expect(await live()).toEqual([`${JAN} 0 71234 pending`]);
    expect(await audits(RECOMPUTED), "an insert is not a recompute").toEqual([]);
    const id = (await E.pg.query<{ id: number }>(`SELECT id FROM tax_deposits`)).rows[0]!.id;

    await issue(P06, "2026-01-30");
    await sync("2026-01-31");
    expect(await live()).toEqual([`${JAN} 0 85308 pending`]);
    const a = await audits(RECOMPUTED);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      actorId: "scheduler",
      entity: "tax_deposit",
      entityId: String(id),
    });
    expect(a[0]!.before).toMatchObject({ cents: 71234 });
    expect(a[0]!.after).toMatchObject({
      cents: 85308,
      poolCents: 0,
      months: [{ periodStart: JAN, liabilityCents: 85308, depositedCents: 0 }],
    });

    await sync("2026-01-31");
    expect(await audits(RECOMPUTED)).toHaveLength(1);
  });

  it("R2-2b: an overdue Feb row cut 71234 -> 41234 by a March over-deposit of 30000 writes one recomputed audit with poolCents 30000", async () => {
    await issue(P32, "2026-01-15");
    await issue(P32, "2026-02-15");
    await issue(P32, "2026-03-15");
    await fedRow({
      start: JAN,
      c: 71234,
      due: "2026-02-16",
      status: "deposited",
      on: "2026-02-10",
    });
    const feb = await fedRow({ start: FEB, c: 71234, due: "2026-03-16", status: "overdue" });
    await fedRow({
      start: MAR,
      c: 101234,
      due: "2026-04-15",
      status: "deposited",
      on: "2026-04-10",
    });

    await sync("2026-04-20");

    const r = await rowById(feb);
    expect([r.c, r.status]).toEqual([41234, "overdue"]);
    const a = await audits(RECOMPUTED);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actorId: "scheduler", entityId: String(feb) });
    expect(a[0]!.before).toMatchObject({ cents: 71234 });
    expect(a[0]!.after).toMatchObject({
      cents: 41234,
      poolCents: 30000,
      months: [
        { periodStart: JAN, liabilityCents: 71234, depositedCents: 71234 },
        { periodStart: FEB, liabilityCents: 71234, depositedCents: 0 },
        { periodStart: MAR, liabilityCents: 71234, depositedCents: 101234 },
      ],
    });
  });

  it("R2-2c: no amount change -> no recomputed audit, including a status-only pending -> overdue flip", async () => {
    await issue(P32, "2026-02-15");
    const id = await fedRow({ start: FEB, c: 71234, due: "2026-03-16", status: "pending" });
    await sync("2026-03-10"); // correct amount, not yet due
    await sync("2026-03-20"); // past due: flipped overdue, amount unchanged
    const r = await rowById(id);
    expect([r.c, r.status]).toEqual([71234, "overdue"]);
    expect(await audits(RECOMPUTED)).toEqual([]);
  });

  it("R2-2d: late issue raising an overdue March row 71234 -> 85308 audits with the confirming admin as actor", async () => {
    await issue(P32, "2026-01-15");
    await issue(P32, "2026-02-15");
    await issue(P32, "2026-03-15");
    await fedRow({
      start: JAN,
      c: 71234,
      due: "2026-02-16",
      status: "deposited",
      on: "2026-02-10",
    });
    await fedRow({
      start: FEB,
      c: 71234,
      due: "2026-03-16",
      status: "deposited",
      on: "2026-03-10",
    });
    const mar = await fedRow({ start: MAR, c: 71234, due: "2026-04-15", status: "overdue" });
    await issue(P06, "2026-03-20"); // the late run

    await lateSync("2026-03-20", "2026-10-05", "r2-admin");

    expect((await rowById(mar)).c).toBe(85308);
    const a = await audits(RECOMPUTED);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actorId: "r2-admin", entityId: String(mar) });
    expect(a[0]!.before).toMatchObject({ cents: 71234 });
    expect(a[0]!.after).toMatchObject({ cents: 85308, poolCents: 0 });
  });
});

// ---------------------------------------------------------------------------
// R2-3 — a reason per superseded row
// ---------------------------------------------------------------------------

function reasonsOf(a: Audit): { id: number; reason: string }[] {
  const r = (a.after as { reasons?: { id: number; reason: string }[] } | null)?.reasons;
  if (!Array.isArray(r)) throw new Error("after.reasons is missing");
  return r.map((x) => ({ id: x.id, reason: x.reason })).sort((p, q) => p.id - q.id);
}

describe("PAY-226 R2-3 per-row supersede reasons", () => {
  it("R2-3a: an old 0.00 pending Jan row (run voided: L = 0, D = 0) -> superseded with 'no liability for the month'", async () => {
    const janRun = await issue(P32, "2026-01-15");
    await voidRun(janRun);
    const jan = await fedRow({ start: JAN, c: 0, due: "2026-02-16", status: "pending" });
    // Feb keeps the quarter planned whatever R2-4 does.
    await issue(P32, "2026-02-15");
    await fedRow({
      start: FEB,
      c: 71234,
      due: "2026-03-16",
      status: "deposited",
      on: "2026-03-10",
    });

    await sync("2026-03-20");

    expect((await rowById(jan)).status).toBe("superseded");
    const sup = await audits(SUPERSEDED);
    expect(sup).toHaveLength(1);
    expect(reasonsOf(sup[0]!)).toEqual([{ id: jan, reason: NO_LIABILITY }]);
  });

  it("R2-3b: one audit row, two reasons — Jan 0.00 row (L = D = 0) 'no liability', Feb seq 1 covered by a March over-deposit -> netting reason", async () => {
    // Feb L 71234, D 64234 (seq 0), seq 1 overdue 7000; Mar L 71234, D 78234 -> pool 7000 covers Feb.
    const janRun = await issue(P32, "2026-01-15");
    await voidRun(janRun);
    const jan = await fedRow({ start: JAN, c: 0, due: "2026-02-16", status: "pending" });
    await issue(P32, "2026-02-15");
    await fedRow({
      start: FEB,
      c: 64234,
      due: "2026-03-16",
      status: "deposited",
      on: "2026-03-10",
    });
    const febS1 = await fedRow({
      start: FEB,
      seq: 1,
      c: 7000,
      due: "2026-03-16",
      status: "overdue",
    });
    await issue(P32, "2026-03-15");
    await fedRow({
      start: MAR,
      c: 78234,
      due: "2026-04-15",
      status: "deposited",
      on: "2026-04-10",
    });

    await sync("2026-04-20");

    expect((await rowById(jan)).status).toBe("superseded");
    expect((await rowById(febS1)).status).toBe("superseded");
    expect(await live()).toEqual([`${FEB} 0 64234 deposited`, `${MAR} 0 78234 deposited`]);
    const sup = await audits(SUPERSEDED);
    expect(sup).toHaveLength(1);
    expect(reasonsOf(sup[0]!)).toEqual(
      [
        { id: jan, reason: NO_LIABILITY },
        { id: febS1, reason: NETTING },
      ].sort((p, q) => p.id - q.id),
    );
  });

  it("R2-3c: a netting-covered row alone keeps the netting reason", async () => {
    await issue(P32, "2026-02-15");
    await fedRow({
      start: FEB,
      c: 64234,
      due: "2026-03-16",
      status: "deposited",
      on: "2026-03-10",
    });
    const febS1 = await fedRow({
      start: FEB,
      seq: 1,
      c: 7000,
      due: "2026-03-16",
      status: "overdue",
    });
    await issue(P32, "2026-03-15");
    await fedRow({
      start: MAR,
      c: 78234,
      due: "2026-04-15",
      status: "deposited",
      on: "2026-04-10",
    });

    await sync("2026-04-20");

    const sup = await audits(SUPERSEDED);
    expect(sup).toHaveLength(1);
    expect(reasonsOf(sup[0]!)).toEqual([{ id: febS1, reason: NETTING }]);
  });
});

// ---------------------------------------------------------------------------
// R2-4 — quarters with an open row but no issued run are planned
// ---------------------------------------------------------------------------

describe("PAY-226 R2-4 a quarter with only voided runs is still planned", () => {
  it("R2-4a: Q3 2026's only run voided after its July row was written -> the open row is superseded ('no liability for the month'); no issued run anywhere", async () => {
    const run = await issue(P32, "2026-07-15");
    await sync("2026-07-20");
    expect(await live()).toEqual([`${JUL} 0 71234 pending`]);
    const id = (await E.pg.query<{ id: number }>(`SELECT id FROM tax_deposits`)).rows[0]!.id;
    await voidRun(run);

    const res = await sync("2026-08-01");

    expect((await rowById(id)).status).toBe("superseded");
    expect(await live()).toEqual([]);
    expect(res.superseded).toBe(1);
    const sup = await audits(SUPERSEDED);
    expect(sup).toHaveLength(1);
    expect(reasonsOf(sup[0]!)).toEqual([{ id, reason: NO_LIABILITY }]);
  });

  it("R2-4b: Q3 runs all voided (July deposited, August overdue) while Q4 has an issued run -> August superseded, July deposited untouched, Q4 planned as usual", async () => {
    const jul = await issue(P32, "2026-07-15");
    const aug = await issue(P32, "2026-08-14");
    await issue(P32, "2026-10-15");
    const julRow = await fedRow({
      start: JUL,
      c: 71234,
      due: "2026-08-17",
      status: "deposited",
      on: "2026-08-10",
    });
    const augRow = await fedRow({ start: AUG, c: 71234, due: "2026-09-15", status: "overdue" });
    await voidRun(jul);
    await voidRun(aug);

    await sync("2026-10-20");

    expect((await rowById(augRow)).status).toBe("superseded");
    const j = await rowById(julRow);
    expect([j.c, j.status]).toEqual([71234, "deposited"]);
    expect(await live()).toEqual([`${JUL} 0 71234 deposited`, `2026-10-01 0 71234 pending`]);
    const sup = await audits(SUPERSEDED);
    expect(sup).toHaveLength(1);
    expect(reasonsOf(sup[0]!)).toEqual([{ id: augRow, reason: NO_LIABILITY }]);
  });

  it("R2-4c (guard): a quarter with only deposited rows and no issued run is left alone (no audit, no change)", async () => {
    const run = await issue(P32, "2026-07-15");
    await fedRow({
      start: JUL,
      c: 71234,
      due: "2026-08-17",
      status: "deposited",
      on: "2026-08-10",
    });
    await voidRun(run);
    const img = await image();
    await sync("2026-10-20");
    expect(await image()).toBe(img);
    expect(await audits(SUPERSEDED)).toEqual([]);
    expect(await audits(RECOMPUTED)).toEqual([]);
  });
});

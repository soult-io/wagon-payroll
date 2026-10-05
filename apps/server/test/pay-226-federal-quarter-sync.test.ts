/**
 * PAY-226 — federal 941 deposits net within the quarter: the deposit sync
 * (daily tick and the PAY-193 L4 late-issue path) on PGlite.
 *
 * Auditor-owned (payroll-calc-auditor). Fail-first: written before the code.
 *
 * Rule (federal SME ruling 2026-10-05; IRC 6656(e)(1); Pub 15 (2026) §11
 * "Order in which deposits are applied"; Form 941 (2026) instructions lines
 * 13–15). Per quarter: L[m] = month liability (issued runs, 5 deposit
 * categories), D[m] = Σ live `deposited` rows of m; unpaid = max(0, L − D);
 * pool = Σ max(0, D − L) applied most recent month first; target[m] = what is
 * left. Only `deposited` rows count as paid — pending AND overdue rows are
 * recalculated (no longer frozen). Per month: target 0 → every open row is
 * superseded (status + superseded_at) with a `tax_deposit.shortfall_superseded`
 * audit row; target > 0 → exactly one open row carries the target, other open
 * rows are superseded, a shortfall row is inserted only when none is open.
 * A superseded row that had been mailed (seq > 0 shortfall) gets ONE
 * cancellation mail per active admin, no amounts. The pool never leaves the
 * quarter. Penalty / interest payments (tax_adjustments) never count. State
 * deposits are unchanged.
 *
 * Assumed contract beyond the brief (named so the implementer can match it):
 *  - audit row: action 'tax_deposit.shortfall_superseded', entity 'tax_deposit',
 *    after ⊇ { superseded: [ids], reason: REASON, poolCents,
 *              months: [{ periodStart, liabilityCents, depositedCents }, …] }
 *    (months ascending; extra keys allowed);
 *  - cancellation mail: email_outbox.event_type 'tax_deposit_shortfall_cancelled';
 *  - SyncResult.superseded counts federal rows superseded by the netting.
 *
 * Oracle (independent Python, integer cents; figures SYNTHETIC — the repo is
 * public, so the production case E1 is reproduced in shape, not in amounts):
 *  Runs (FIT chosen so each month hits the synthetic liability; FICA per
 *  Pub 15 (2026) §9: SS 6.2% + 6.2%, Medicare 1.45% + 1.45%, far below the
 *  2026 SS wage base and the Additional Medicare threshold):
 *   P32 gross 3,200.00: FIT 222.74, SS 198.40, Med 46.40 → 712.34
 *   P41 gross 4,100.00: FIT 296.15, SS 254.20, Med 59.45 → 923.45
 *   P35 gross 3,500.00: FIT 247.21, SS 217.00, Med 50.75 → 782.71
 *   P06 gross   600.00: FIT  48.94, SS  37.20, Med  8.70 → 140.74
 *   P15 gross 1,500.00: FIT  70.50, SS  93.00, Med 21.75 → 300.00
 *   P05 gross   500.00: FIT  23.50, SS  31.00, Med  7.25 → 100.00
 *  Illinois (Booklet IL-700-T 2026: 4.95% × (wages − 1 × $2,925 / 12)):
 *   3,200.00 → 146.33; 4,100.00 → 190.88
 *  E1 shape: L 71234 / 71234 / 92345, D 78271 ×3 (ΣL = ΣD = 234813);
 *   pool 7037 + 7037 = 14074 covers March's 14074 → all targets 0.
 *  v1.28.0 wrote a false March seq 1 row of 14074, overdue (due 2026-04-15).
 * Due dates asserted only where unambiguous: Feb 2026 → 2026-03-16 (Mar 15 is
 * a Sunday), Mar 2026 → 2026-04-15, Dec 2026 → 2027-01-15.
 *
 * Data is synthetic; never read prod.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@payroll/db";
import { company, employees, seedDatabase, type SeedDb } from "@payroll/db";
import { loadConfig, type AppConfig } from "../src/config.js";
import type { Db } from "../src/db.js";
import {
  markDeposited,
  syncDeposits,
  syncDepositsForPayDate,
  type SyncResult,
} from "../src/deposits/service.js";
import { runMigrations } from "./helpers.js";

// ---------------------------------------------------------------------------
// Oracle constants (integer cents; derivation in the header)
// ---------------------------------------------------------------------------

interface Pay {
  fit: number;
  ss: number;
  med: number;
}
const P32: Pay = { fit: 22274, ss: 19840, med: 4640 };
const P41: Pay = { fit: 29615, ss: 25420, med: 5945 };
const P35: Pay = { fit: 24721, ss: 21700, med: 5075 };
const P06: Pay = { fit: 4894, ss: 3720, med: 870 };
const P15: Pay = { fit: 7050, ss: 9300, med: 2175 };
const P05: Pay = { fit: 2350, ss: 3100, med: 725 };
const fed = (p: Pay): number => p.fit + 2 * p.ss + 2 * p.med;
const IL_3200 = 14633;
const IL_4100 = 19088;

const JAN = "2026-01-01";
const FEB = "2026-02-01";
const MAR = "2026-03-01";
const DEC = "2026-12-01";

const SUPERSEDED = "tax_deposit.shortfall_superseded";
const CREATED = "tax_deposit.shortfall_created";
const CANCEL_EVENT = "tax_deposit_shortfall_cancelled";
const SHORTFALL_EVENT = "tax_deposit_shortfall";
const REASON = "covered by deposits for the same quarter (IRC 6656(e); Pub 15 (2026) §11)";

function money(c: number): string {
  const sign = c < 0 ? "-" : "";
  const a = Math.abs(c);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}
function cents(s: string): number {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(s);
  if (!m) throw new Error(`not a 2dp money string: ${s}`);
  const v = Number(m[2]) * 100 + Number(m[3]);
  return m[1] ? -v : v;
}

// ---------------------------------------------------------------------------
// Env: one PGlite for the file, reset before each test
// ---------------------------------------------------------------------------

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
    `TRUNCATE tax_deposits, tax_adjustments, tax_filings, payroll_entries, payroll_runs,
              state_deposit_schedules, email_outbox, audit_events RESTART IDENTITY CASCADE`,
  );
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let empSeq = 0;
async function employee(): Promise<number> {
  empSeq += 1;
  const c = await E.db.select({ id: company.id }).from(company).limit(1);
  const rows = await E.db
    .insert(employees)
    .values({
      companyId: c[0]!.id,
      legalName: `PAY-226 Synthetic ${empSeq}`,
      hireDate: "2025-01-01",
    })
    .returning();
  return rows[0]!.id;
}

function lastDayOf(iso: string): string {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), 0));
  return d.toISOString().slice(0, 10);
}

/** One ISSUED monthly run with frozen entries; `il` adds IL withholding + work state. */
async function issue(p: Pay, payDate: string, il: number | null = null): Promise<number> {
  const emp = await employee();
  const snap = il === null ? { inputs: {} } : { inputs: { state: { workState: "IL" } } };
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
  if (il !== null) entries.push(["state_withholding", il]);
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
    `UPDATE payroll_runs SET status='void', voided_at=now(), void_reason='PAY-226 scenario' WHERE id=$1`,
    [id],
  );
}

/** A federal month row exactly as the previous release (v1.28.0) stored it. */
async function fedRow(o: {
  start: string;
  seq: number;
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
      o.seq,
      money(o.c),
      o.due,
      o.status,
      o.status === "deposited" ? (o.on ?? o.due) : null,
      o.status === "deposited" ? `SYN-${o.start}-${o.seq}` : null,
    ],
  );
  return r.rows[0]!.id;
}

async function sync(today: string): Promise<SyncResult> {
  return syncDeposits({ db: E.db, config: E.config }, { today });
}

async function deposit(id: number, on: string): Promise<void> {
  await markDeposited(
    { db: E.db, config: E.config },
    id,
    { depositedOn: on, eftpsConfirmation: `SYN-${id}` },
    "auditor",
  );
}

async function lateSync(payDate: string, today: string): Promise<string[]> {
  return E.db.transaction(async (tx) =>
    syncDepositsForPayDate(tx, E.config, {
      payDate,
      jurisdictions: [],
      today,
      actorId: "auditor",
    }),
  );
}

async function ensureAdmins(): Promise<string[]> {
  const put = (id: string, role: string, banned: boolean) =>
    E.pg.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", role, banned)
       VALUES ($1, $1, $1 || '@pay-226.test', true, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [id, role, banned],
    );
  await put("p226-admin-1", "admin", false);
  await put("p226-admin-2", "admin", false);
  await put("p226-admin-banned", "admin", true);
  await put("p226-employee", "user", false);
  const r = await E.pg.query<{ id: string }>(
    `SELECT id FROM "user" WHERE role = 'admin' AND coalesce(banned, false) = false ORDER BY id`,
  );
  return r.rows.map((x) => x.id);
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

interface Row {
  id: number;
  start: string;
  kind: string;
  seq: number;
  c: number;
  due: string;
  status: string;
  supersededAt: string | null;
}

async function rows(j = "federal"): Promise<Row[]> {
  const r = await E.pg.query<{
    id: number;
    start: string;
    kind: string;
    seq: number;
    amount: string;
    due: string;
    status: string;
    superseded_at: string | null;
  }>(
    `SELECT id, period_start::text AS start, period_kind AS kind, seq, amount::text AS amount,
            due_date::text AS due, status, superseded_at::text AS superseded_at
       FROM tax_deposits WHERE jurisdiction = $1 ORDER BY period_start, seq, id`,
    [j],
  );
  return r.rows.map((x) => ({
    id: x.id,
    start: x.start,
    kind: x.kind,
    seq: Number(x.seq),
    c: cents(x.amount),
    due: x.due,
    status: x.status,
    supersededAt: x.superseded_at,
  }));
}

/** Live rows as "start seq cents status". */
async function live(j = "federal"): Promise<string[]> {
  return (await rows(j))
    .filter((r) => r.status !== "superseded")
    .map((r) => `${r.start} ${r.seq} ${r.c} ${r.status}`);
}

async function rowById(id: number): Promise<Row> {
  const r = (await rows()).find((x) => x.id === id);
  if (!r) throw new Error(`no federal row ${id}`);
  return r;
}

/** Full table image without updated_at, optionally without some rows. */
async function image(excludeIds: number[] = []): Promise<string> {
  const r = await E.pg.query<{ s: string }>(
    `SELECT coalesce(json_agg(to_jsonb(d) - 'updated_at' ORDER BY id), '[]')::text AS s
       FROM tax_deposits d WHERE NOT (id = ANY($1::int[]))`,
    [excludeIds],
  );
  return r.rows[0]!.s;
}

interface Audit {
  id: number;
  action: string;
  entity: string;
  entityId: string;
  after: Record<string, unknown> | null;
}
async function audits(sinceId = 0): Promise<Audit[]> {
  const r = await E.pg.query<Audit>(
    `SELECT id, action, entity, entity_id AS "entityId", after FROM audit_events WHERE id > $1 ORDER BY id`,
    [sinceId],
  );
  return r.rows;
}
async function maxId(table: "audit_events" | "email_outbox"): Promise<number> {
  const r = await E.pg.query<{ m: number }>(`SELECT coalesce(max(id), 0)::int AS m FROM ${table}`);
  return r.rows[0]!.m;
}

interface Mail {
  userId: string;
  eventType: string;
  subject: string;
  body: string;
}
async function mails(sinceId = 0): Promise<Mail[]> {
  const r = await E.pg.query<Mail>(
    `SELECT user_id AS "userId", event_type AS "eventType", subject, body_html AS body
       FROM email_outbox WHERE id > $1 ORDER BY id`,
    [sinceId],
  );
  return r.rows;
}

function expectNoAmounts(m: Mail): void {
  expect(m.subject, "no amount in the subject").not.toMatch(/\$|\d+\.\d{2}/);
  expect(m.body, "no amount in the body").not.toMatch(/\$/);
  expect(m.body, "no amount in the body").not.toMatch(/\d+\.\d{2}/);
}

// ---------------------------------------------------------------------------
// Oracle self-check
// ---------------------------------------------------------------------------

describe("PAY-226 oracle constants", () => {
  it("per-run federal totals match the hand-computed values", () => {
    expect([fed(P32), fed(P41), fed(P35), fed(P06), fed(P15), fed(P05)]).toEqual([
      71234, 92345, 78271, 14074, 30000, 10000,
    ]);
    // E1 shape: ΣL = ΣD; March short by exactly the Jan + Feb excess.
    expect(2 * fed(P32) + fed(P41)).toBe(3 * 78271);
    expect(fed(P41) - 78271).toBe(2 * (78271 - fed(P32)));
    expect(fed(P35) + fed(P06)).toBe(92345);
  });
});

// ---------------------------------------------------------------------------
// E1 — the production case, as v1.28.0 left it
// ---------------------------------------------------------------------------

/** Q1 2026 with the false March seq 1 row, its audit row and its mail (v1.28.0). */
async function seedE1(admins: string[]): Promise<{ falseId: number; depositedIds: number[] }> {
  await issue(P32, "2026-01-15");
  await issue(P32, "2026-02-15");
  await issue(P41, "2026-03-15");
  const depositedIds = [
    await fedRow({
      start: JAN,
      seq: 0,
      c: 78271,
      due: "2026-02-16",
      status: "deposited",
      on: "2026-02-10",
    }),
    await fedRow({
      start: FEB,
      seq: 0,
      c: 78271,
      due: "2026-03-16",
      status: "deposited",
      on: "2026-03-10",
    }),
    await fedRow({
      start: MAR,
      seq: 0,
      c: 78271,
      due: "2026-04-15",
      status: "deposited",
      on: "2026-04-10",
    }),
  ];
  const falseId = await fedRow({
    start: MAR,
    seq: 1,
    c: 14074,
    due: "2026-04-15",
    status: "overdue",
  });
  await E.pg.query(
    `INSERT INTO audit_events (actor_id, action, entity, entity_id, after)
     VALUES ('scheduler', $1, 'tax_deposit', $2, $3::jsonb)`,
    [
      CREATED,
      String(falseId),
      JSON.stringify({
        jurisdiction: "federal",
        periodStart: MAR,
        periodKind: "month",
        seq: 1,
        cents: 14074,
      }),
    ],
  );
  for (const userId of admins) {
    await E.pg.query(
      `INSERT INTO email_outbox (user_id, event_type, subject, body_html, status)
       VALUES ($1, $2, 'Additional Federal tax deposit for March 2026', '<p>v1.28.0 shortfall mail</p>', 'sent')`,
      [userId, SHORTFALL_EVENT],
    );
  }
  return { falseId, depositedIds };
}

describe("PAY-226 E1 — the false March shortfall row is superseded", () => {
  it("I-E1a: sync at 2026-10-05 supersedes the seq 1 row (superseded_at set, amount kept) and changes no other deposit row", async () => {
    const admins = await ensureAdmins();
    const { falseId } = await seedE1(admins);
    const others = await image([falseId]);
    const before = await rowById(falseId);

    const res = await sync("2026-10-05");

    const after = await rowById(falseId);
    expect(after.status).toBe("superseded");
    expect(after.supersededAt).not.toBeNull();
    expect([after.start, after.seq, after.c, after.due]).toEqual([
      before.start,
      before.seq,
      before.c,
      before.due,
    ]);
    expect(await image([falseId]), "no other deposit row changed").toBe(others);
    expect(await live()).toEqual([
      `${JAN} 0 78271 deposited`,
      `${FEB} 0 78271 deposited`,
      `${MAR} 0 78271 deposited`,
    ]);
    expect(res.created).toBe(0);
    expect(res.superseded).toBe(1);
  });

  it("I-E1b: exactly one tax_deposit.shortfall_superseded audit row with the row id, per-month L/D, the pool and the reason; no other audit row", async () => {
    const admins = await ensureAdmins();
    const { falseId } = await seedE1(admins);
    const since = await maxId("audit_events");

    await sync("2026-10-05");

    const fresh = await audits(since);
    expect(fresh.map((a) => a.action)).toEqual([SUPERSEDED]);
    const a = fresh[0]!;
    expect(a.entity).toBe("tax_deposit");
    expect(a.after).toMatchObject({
      superseded: [falseId],
      reason: REASON,
      poolCents: 14074,
      months: [
        { periodStart: JAN, liabilityCents: 71234, depositedCents: 78271 },
        { periodStart: FEB, liabilityCents: 71234, depositedCents: 78271 },
        { periodStart: MAR, liabilityCents: 92345, depositedCents: 78271 },
      ],
    });
  });

  it("I-E1c: one cancellation mail per active admin (not the banned admin, not employees), naming March 2026, no amounts", async () => {
    const admins = await ensureAdmins();
    expect(admins).toEqual(expect.arrayContaining(["p226-admin-1", "p226-admin-2"]));
    await seedE1(admins);
    const since = await maxId("email_outbox");

    await sync("2026-10-05");

    const fresh = await mails(since);
    expect(fresh.map((m) => m.userId).sort()).toEqual([...admins].sort());
    expect(fresh.map((m) => m.userId)).not.toContain("p226-admin-banned");
    expect(fresh.map((m) => m.userId)).not.toContain("p226-employee");
    for (const m of fresh) {
      expect(m.eventType).toBe(CANCEL_EVENT);
      expect(`${m.subject} ${m.body}`).toContain("March 2026");
      expectNoAmounts(m);
    }
  });

  it("I-E1d: a second sync is a no-op — no row, audit or mail change", async () => {
    const admins = await ensureAdmins();
    await seedE1(admins);
    await sync("2026-10-05");
    const img = await image();
    const a = await maxId("audit_events");
    const o = await maxId("email_outbox");

    const res = await sync("2026-10-05");

    expect(await image()).toBe(img);
    expect(await maxId("audit_events")).toBe(a);
    expect(await maxId("email_outbox")).toBe(o);
    expect([res.created, res.recomputed, res.superseded, res.flippedOverdue]).toEqual([0, 0, 0, 0]);
  });

  it("I-E1e: on a fresh database (no v1.28.0 row) the E1 quarter produces no shortfall row, audit or mail", async () => {
    await ensureAdmins();
    await issue(P32, "2026-01-15");
    await issue(P32, "2026-02-15");
    await issue(P41, "2026-03-15");
    await fedRow({
      start: JAN,
      seq: 0,
      c: 78271,
      due: "2026-02-16",
      status: "deposited",
      on: "2026-02-10",
    });
    await fedRow({
      start: FEB,
      seq: 0,
      c: 78271,
      due: "2026-03-16",
      status: "deposited",
      on: "2026-03-10",
    });
    await fedRow({
      start: MAR,
      seq: 0,
      c: 78271,
      due: "2026-04-15",
      status: "deposited",
      on: "2026-04-10",
    });

    await sync("2026-10-05");

    expect(await live()).toEqual([
      `${JAN} 0 78271 deposited`,
      `${FEB} 0 78271 deposited`,
      `${MAR} 0 78271 deposited`,
    ]);
    expect((await audits()).map((a) => a.action)).not.toContain(CREATED);
    expect(await mails()).toEqual([]);
  });

  it("I-SILENT: an open row that was never mailed (seq 0 pending) is superseded silently when the quarter covers it", async () => {
    await ensureAdmins();
    // Jan L 71234, D 142468 (recorded before a Jan run was voided); Feb L 71234 pending.
    const janVoided = await issue(P32, "2026-01-15");
    await issue(P32, "2026-01-16");
    await issue(P32, "2026-02-15");
    await fedRow({
      start: JAN,
      seq: 0,
      c: 142468,
      due: "2026-02-16",
      status: "deposited",
      on: "2026-02-10",
    });
    const febId = await fedRow({
      start: FEB,
      seq: 0,
      c: 71234,
      due: "2026-03-16",
      status: "pending",
    });
    await voidRun(janVoided);

    await sync("2026-03-01");

    const feb = await rowById(febId);
    expect(feb.status).toBe("superseded");
    expect(feb.supersededAt).not.toBeNull();
    expect(await live()).toEqual([`${JAN} 0 142468 deposited`]);
    expect((await audits()).map((a) => a.action)).toEqual([SUPERSEDED]);
    expect(await mails(), "a row never mailed is superseded silently").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// E2 / E4 — the quarter really is short
// ---------------------------------------------------------------------------

describe("PAY-226 E2 — a short quarter still gets its shortfall row, at the netted amount", () => {
  async function seedE2(): Promise<void> {
    await issue(P32, "2026-01-15");
    await issue(P32, "2026-02-15");
    await issue(P41, "2026-03-15");
    await fedRow({
      start: JAN,
      seq: 0,
      c: 80000,
      due: "2026-02-16",
      status: "deposited",
      on: "2026-02-10",
    });
    await fedRow({
      start: FEB,
      seq: 0,
      c: 71234,
      due: "2026-03-16",
      status: "deposited",
      on: "2026-03-10",
    });
    await fedRow({
      start: MAR,
      seq: 0,
      c: 78271,
      due: "2026-04-15",
      status: "deposited",
      on: "2026-04-08",
    });
  }

  it("I-E2a: sync at 2026-04-10 inserts March seq 1 pending 5308 (14074 − Jan excess 8766), due 2026-04-15, one audit row, one mail per admin", async () => {
    const admins = await ensureAdmins();
    await seedE2();

    await sync("2026-04-10");

    expect(await live()).toEqual([
      `${JAN} 0 80000 deposited`,
      `${FEB} 0 71234 deposited`,
      `${MAR} 0 78271 deposited`,
      `${MAR} 1 5308 pending`,
    ]);
    const s1 = (await rows()).find((r) => r.start === MAR && r.seq === 1)!;
    expect(s1.due).toBe("2026-04-15");
    const created = (await audits()).filter((a) => a.action === CREATED);
    expect(created).toHaveLength(1);
    expect(created[0]!.after).toMatchObject({
      jurisdiction: "federal",
      periodStart: MAR,
      seq: 1,
      cents: 5308,
    });
    const m = await mails();
    expect(m.map((x) => x.userId).sort()).toEqual([...admins].sort());
    for (const x of m) expect(x.eventType).toBe(SHORTFALL_EVENT);
  });

  it("I-E2b: from 2026-04-16 the same row is overdue 5308; a repeat sync is a no-op", async () => {
    await ensureAdmins();
    await seedE2();
    await sync("2026-04-10");
    const id = (await rows()).find((r) => r.start === MAR && r.seq === 1)!.id;

    await sync("2026-04-16");
    const r = await rowById(id);
    expect([r.c, r.status]).toEqual([5308, "overdue"]);
    expect(await live()).toHaveLength(4);

    const img = await image();
    const a = await maxId("audit_events");
    const o = await maxId("email_outbox");
    await sync("2026-04-16");
    expect(await image()).toBe(img);
    expect(await maxId("audit_events")).toBe(a);
    expect(await maxId("email_outbox")).toBe(o);
  });

  it("I-E2c: a v1.28.0 seq 1 row of 14074 (overdue) is recalculated down to 5308, not frozen and not duplicated", async () => {
    await ensureAdmins();
    await seedE2();
    const id = await fedRow({ start: MAR, seq: 1, c: 14074, due: "2026-04-15", status: "overdue" });

    await sync("2026-04-20");

    const r = await rowById(id);
    expect([r.c, r.status]).toEqual([5308, "overdue"]);
    expect(await live()).toEqual([
      `${JAN} 0 80000 deposited`,
      `${FEB} 0 71234 deposited`,
      `${MAR} 0 78271 deposited`,
      `${MAR} 1 5308 overdue`,
    ]);
    expect((await audits()).map((a) => a.action)).not.toContain(CREATED);
  });
});

describe("PAY-226 E4 — overdue rows are money owed, not paid: recalculated when the quarter covers them", () => {
  /** Jan, Feb, Mar R1 = 71234 each; Mar R2 = `extra`. Feb never deposited. */
  async function seedE4(extra: Pay): Promise<{ febId: number; marR2: number }> {
    await issue(P32, "2026-01-15");
    await issue(P32, "2026-02-15");
    await issue(P32, "2026-03-15");
    const marR2 = await issue(extra, "2026-03-20");
    await sync("2026-04-10");
    const all = await rows();
    const id = (start: string) => all.find((r) => r.start === start && r.seq === 0)!.id;
    await deposit(id(JAN), "2026-04-10");
    await deposit(id(MAR), "2026-04-10");
    return { febId: id(FEB), marR2 };
  }

  it("I-E4a (guard): Feb unpaid with nothing to net → Feb overdue 71234 (due 2026-03-16)", async () => {
    await ensureAdmins();
    const { febId } = await seedE4(P15);
    await sync("2026-04-20");
    const feb = await rowById(febId);
    expect([feb.c, feb.status, feb.due]).toEqual([71234, "overdue", "2026-03-16"]);
  });

  it("I-E4b: a later March over-deposit of 30000 (a March run voided after its deposit) cuts the overdue Feb row to 41234, same row", async () => {
    await ensureAdmins();
    const { febId, marR2 } = await seedE4(P15);
    await voidRun(marR2);

    await sync("2026-04-20");

    const feb = await rowById(febId);
    expect([feb.c, feb.status]).toEqual([41234, "overdue"]);
    expect(await live()).toEqual([
      `${JAN} 0 71234 deposited`,
      `${FEB} 0 41234 overdue`,
      `${MAR} 0 101234 deposited`,
    ]);
  });

  it("I-E4c: a March over-deposit of 71234 covers Feb in full → the overdue Feb row is superseded (audited)", async () => {
    await ensureAdmins();
    const { febId, marR2 } = await seedE4(P32);
    await voidRun(marR2);
    const since = await maxId("audit_events");

    await sync("2026-04-20");

    const feb = await rowById(febId);
    expect(feb.status).toBe("superseded");
    expect(feb.supersededAt).not.toBeNull();
    expect(await live()).toEqual([`${JAN} 0 71234 deposited`, `${MAR} 0 142468 deposited`]);
    const sup = (await audits(since)).filter((a) => a.action === SUPERSEDED);
    expect(sup).toHaveLength(1);
    expect(sup[0]!.after).toMatchObject({ superseded: [febId], reason: REASON, poolCents: 71234 });
    // PL decision 3: a seq 0 row that only went overdue in the normal sync was
    // never sent a shortfall mail, so it is superseded without a cancellation mail.
    expect(await mails()).toEqual([]);
  });

  it("I-COLLAPSE: two open rows left by v1.28.0 (Dec seq 0 overdue 71234 + seq 1 overdue 14074) → seq 0 (lowest) kept at 85308, seq 1 superseded; one audit row; no mail", async () => {
    await ensureAdmins();
    await issue(P32, "2026-12-15");
    await issue(P06, "2026-12-31");
    const a = await fedRow({ start: DEC, seq: 0, c: 71234, due: "2027-01-15", status: "overdue" });
    const b = await fedRow({ start: DEC, seq: 1, c: 14074, due: "2027-01-15", status: "overdue" });

    await sync("2027-01-20");

    // PL decision 2: keep the LOWEST-seq open row; supersede the others.
    const kept = await rowById(a);
    expect([kept.c, kept.status, kept.due]).toEqual([85308, "overdue", "2027-01-15"]);
    const other = await rowById(b);
    expect(other.status).toBe("superseded");
    expect(other.supersededAt).not.toBeNull();
    expect(await live()).toEqual([`${DEC} 0 85308 overdue`]);
    // One shortfall_superseded audit row listing the superseded row.
    const sup = (await audits()).filter((x) => x.action === SUPERSEDED);
    expect(sup).toHaveLength(1);
    expect(sup[0]!.after).toMatchObject({ superseded: [b] });
    expect((await audits()).map((x) => x.action)).not.toContain(CREATED);
    // No cancellation mail: the money is still owed.
    expect(await mails()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Quarter and year boundary
// ---------------------------------------------------------------------------

describe("PAY-226 the pool never leaves its quarter", () => {
  it("I-YEAR (guard): a Q4 2026 over-deposit does not cover January 2027 → Jan 2027 overdue 10000; no Q4 row created", async () => {
    await ensureAdmins();
    await issue(P05, "2026-10-15");
    await issue(P05, "2027-01-15");
    await fedRow({
      start: "2026-10-01",
      seq: 0,
      c: 15000,
      due: "2026-11-16",
      status: "deposited",
      on: "2026-11-10",
    });

    await sync("2027-03-01");

    expect(await live()).toEqual(["2026-10-01 0 15000 deposited", "2027-01-01 0 10000 overdue"]);
    expect((await audits()).map((a) => a.action)).not.toContain(SUPERSEDED);
  });
});

// ---------------------------------------------------------------------------
// Late issue (PAY-193 L4) uses the same quarter rule
// ---------------------------------------------------------------------------

describe("PAY-226 late issue (syncDepositsForPayDate) nets within the quarter", () => {
  async function seedQ1(): Promise<void> {
    await issue(P32, "2026-01-15");
    await issue(P32, "2026-02-15");
    await fedRow({
      start: JAN,
      seq: 0,
      c: 78271,
      due: "2026-02-16",
      status: "deposited",
      on: "2026-02-10",
    });
    await fedRow({
      start: FEB,
      seq: 0,
      c: 78271,
      due: "2026-03-16",
      status: "deposited",
      on: "2026-03-10",
    });
  }

  it("I-L4a: a late March run (E1 shape) creates no shortfall row, no follow-up, no audit, no mail", async () => {
    await ensureAdmins();
    await seedQ1();
    await issue(P35, "2026-03-13");
    await fedRow({
      start: MAR,
      seq: 0,
      c: 78271,
      due: "2026-04-15",
      status: "deposited",
      on: "2026-04-10",
    });
    await issue(P06, "2026-03-15"); // the late run: March L becomes 92345
    const img = await image();

    const followUps = await lateSync("2026-03-15", "2026-10-05");

    expect(followUps.filter((c) => c.includes(":federal:"))).toEqual([]);
    expect(await image()).toBe(img);
    expect(await audits()).toEqual([]);
    expect(await mails()).toEqual([]);
  });

  it("I-L4b: a late January run is covered by a March over-deposit (the whole quarter is planned, not only the pay-date month)", async () => {
    await ensureAdmins();
    await issue(P32, "2026-01-15");
    await issue(P32, "2026-02-15");
    await issue(P32, "2026-03-15");
    await fedRow({
      start: JAN,
      seq: 0,
      c: 71234,
      due: "2026-02-16",
      status: "deposited",
      on: "2026-02-10",
    });
    await fedRow({
      start: FEB,
      seq: 0,
      c: 71234,
      due: "2026-03-16",
      status: "deposited",
      on: "2026-03-10",
    });
    await fedRow({
      start: MAR,
      seq: 0,
      c: 85308,
      due: "2026-04-15",
      status: "deposited",
      on: "2026-04-10",
    });
    await issue(P06, "2026-01-20"); // late: Jan L 85308, March over by 14074
    const img = await image();

    const followUps = await lateSync("2026-01-20", "2026-10-05");

    expect(followUps.filter((c) => c.includes(":federal:"))).toEqual([]);
    expect(await image()).toBe(img);
    expect((await audits()).map((a) => a.action)).not.toContain(CREATED);
    expect(await mails()).toEqual([]);
  });

  it("I-L4c (guard): a late March run in a quarter that really is short → March seq 0 overdue 71234 and deposit_overdue:federal:2026-03-01", async () => {
    await ensureAdmins();
    await issue(P32, "2026-01-15");
    await issue(P32, "2026-02-15");
    await fedRow({
      start: JAN,
      seq: 0,
      c: 71234,
      due: "2026-02-16",
      status: "deposited",
      on: "2026-02-10",
    });
    await fedRow({
      start: FEB,
      seq: 0,
      c: 71234,
      due: "2026-03-16",
      status: "deposited",
      on: "2026-03-10",
    });
    await issue(P32, "2026-03-15");

    const followUps = await lateSync("2026-03-15", "2026-10-05");

    expect(followUps).toContain(`deposit_overdue:federal:${MAR}`);
    expect(await live()).toEqual([
      `${JAN} 0 71234 deposited`,
      `${FEB} 0 71234 deposited`,
      `${MAR} 0 71234 overdue`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Guards: state deposits unchanged; penalty / interest never count
// ---------------------------------------------------------------------------

describe("PAY-226 guards", () => {
  it("I-STATE (guard): IL monthly state rows are planned exactly as before while the federal quarter nets", async () => {
    await ensureAdmins();
    // IL 2026 monthly, due the 15th (IDOR Pub 131).
    await E.pg.query(
      `INSERT INTO state_deposit_schedules (state_code, tax_year, frequency, due_day, note, source)
       VALUES ('IL', 2026, 'monthly', 15, 'PAY-226 scenario', 'synthetic')`,
    );
    await issue(P32, "2026-01-15", IL_3200);
    await issue(P32, "2026-02-15", IL_3200);
    await issue(P41, "2026-03-15", IL_4100);
    await fedRow({
      start: JAN,
      seq: 0,
      c: 78271,
      due: "2026-02-16",
      status: "deposited",
      on: "2026-02-10",
    });
    await fedRow({
      start: FEB,
      seq: 0,
      c: 78271,
      due: "2026-03-16",
      status: "deposited",
      on: "2026-03-10",
    });
    await fedRow({
      start: MAR,
      seq: 0,
      c: 78271,
      due: "2026-04-15",
      status: "deposited",
      on: "2026-04-10",
    });

    await sync("2026-10-05");
    const il = (await rows("IL")).filter((r) => r.status !== "superseded");
    expect(il.map((r) => `${r.kind} ${r.start} ${r.seq} ${r.c} ${r.status}`)).toEqual([
      `month ${JAN} 0 ${IL_3200} overdue`,
      `month ${FEB} 0 ${IL_3200} overdue`,
      `month ${MAR} 0 ${IL_4100} overdue`,
    ]);
    expect(il.find((r) => r.start === MAR)!.due).toBe("2026-04-15");
    expect((await rows("IL")).filter((r) => r.status === "superseded")).toEqual([]);

    // A state month does not net like the federal quarter: depositing Jan
    // leaves Feb and Mar exactly as they were.
    await deposit(il[0]!.id, "2026-10-05");
    const ilImg = JSON.stringify(await rows("IL"));
    await sync("2026-10-06");
    expect(JSON.stringify(await rows("IL"))).toBe(ilImg);
    expect((await audits()).map((a) => a.action)).not.toContain("tax_deposit.period_transition");
  });

  it("I-PENALTY (guard): penalty and interest payments on the Q1 941 never count as deposits — Feb stays overdue 71234", async () => {
    await ensureAdmins();
    await issue(P32, "2026-01-15");
    await issue(P32, "2026-02-15");
    await issue(P32, "2026-03-15");
    await fedRow({
      start: JAN,
      seq: 0,
      c: 71234,
      due: "2026-02-16",
      status: "deposited",
      on: "2026-02-10",
    });
    const febId = await fedRow({
      start: FEB,
      seq: 0,
      c: 71234,
      due: "2026-03-16",
      status: "overdue",
    });
    await fedRow({
      start: MAR,
      seq: 0,
      c: 71234,
      due: "2026-04-15",
      status: "deposited",
      on: "2026-04-10",
    });
    const f = await E.pg.query<{ id: number }>(
      `INSERT INTO tax_filings (form_type, year, quarter, due_date) VALUES ('941', 2026, 1, '2026-04-30') RETURNING id`,
    );
    for (const [kind, paid] of [
      ["CP220", 71234],
      ["penalty", 50000],
      ["interest", 1500],
    ] as const) {
      await E.pg.query(
        `INSERT INTO tax_adjustments (filing_id, kind, amount_due, amount_paid, paid_on, note)
         VALUES ($1, $2, $3, $3, '2026-04-18', 'PAY-226 synthetic')`,
        [f.rows[0]!.id, kind, money(paid)],
      );
    }

    await sync("2026-04-20");

    const feb = await rowById(febId);
    expect([feb.c, feb.status]).toEqual([71234, "overdue"]);
    expect((await audits()).map((a) => a.action)).not.toContain(SUPERSEDED);
  });
});

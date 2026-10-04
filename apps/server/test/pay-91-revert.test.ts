/**
 * PAY-91 (spec 23 §10) — packages/db/scripts/pay-91-revert.sql, the emergency
 * image-rollback helper, on the T03 and T07 end states. Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { company, employees, seedDatabase, type SeedDb } from "@payroll/db";
import { syncDeposits } from "../src/deposits/service.js";
import { createTestApp, type TestContext } from "./helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REVERT = readFileSync(
  resolve(HERE, "../../../packages/db/scripts/pay-91-revert.sql"),
  "utf8",
);

let t: TestContext;
beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
}, 180_000);
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.pglite.exec(
    `TRUNCATE tax_deposits, payroll_entries, payroll_runs, state_deposit_schedules RESTART IDENTITY CASCADE`,
  );
});

async function ada(): Promise<number> {
  const c = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({ companyId: c[0]!.id, legalName: "Ada Revert", hireDate: "2025-01-01" })
    .returning();
  return rows[0]!.id;
}

async function run(emp: number, payDate: string, amount: string): Promise<void> {
  const r = await t.pglite.query<{ id: number }>(
    `INSERT INTO payroll_runs (employee_id, period_start, period_end, pay_date, status, run_snapshot, issued_at)
     VALUES ($1, $2, $3, $4, 'issued', '{"inputs":{"state":{"workState":"CA"}}}'::jsonb, now()) RETURNING id`,
    [emp, `${payDate.slice(0, 7)}-01`, `${payDate.slice(0, 7)}-28`, payDate],
  );
  await t.pglite.query(
    `INSERT INTO payroll_entries (run_id, category, amount) VALUES ($1, 'state_withholding', $2)`,
    [r.rows[0]!.id, amount],
  );
}

async function schedule(frequency: string, dueDay: number | null): Promise<void> {
  await t.pglite.query(
    `INSERT INTO state_deposit_schedules (state_code, tax_year, frequency, due_day) VALUES ('CA', 2026, $1, $2)
     ON CONFLICT (state_code, tax_year) DO UPDATE SET frequency = EXCLUDED.frequency, due_day = EXCLUDED.due_day`,
    [frequency, dueDay],
  );
}

/**
 * The CA rows as "kind period amount status[ sup_at]". An open row reads
 * 'open' only when its status matches the overdue rule (past due AND amount
 * > 0) evaluated at `asOf` — the same date the last writer used: the `today`
 * passed to syncDeposits, or `dbToday()` after the revert SQL (which uses
 * Postgres current_date). Never the real clock against a fixed sync date
 * (PAY-219: that went red on 2026-10-16 and 2026-11-03).
 */
async function caRows(asOf: string): Promise<string[]> {
  const r = await t.pglite.query<{ s: string }>(
    `SELECT period_kind || ' ' || period_start || ' ' || amount || ' ' ||
            CASE WHEN status IN ('pending','overdue')
                 THEN (CASE WHEN status = (CASE WHEN due_date < $1::date AND amount > 0 THEN 'overdue' ELSE 'pending' END)
                            THEN 'open' ELSE 'open-wrong-status' END)
                 ELSE status END ||
            CASE WHEN superseded_at IS NULL THEN '' ELSE ' sup_at' END AS s
       FROM tax_deposits WHERE jurisdiction = 'CA' ORDER BY period_start, period_kind, id`,
    [asOf],
  );
  return r.rows.map((x) => x.s);
}

/** Postgres current_date — the date the revert SQL classifies restored rows with. */
async function dbToday(): Promise<string> {
  const r = await t.pglite.query<{ d: string }>(`SELECT current_date::text AS d`);
  return r.rows[0]!.d;
}

async function threeRuns(): Promise<number> {
  const emp = await ada();
  await run(emp, "2026-07-15", "123.45");
  await run(emp, "2026-08-14", "123.45");
  await run(emp, "2026-09-15", "130.00");
  return emp;
}

describe("pay-91-revert.sql", () => {
  it("T03 end: deletes the scheduler's pending Q3 row and restores the superseded months", async () => {
    await threeRuns();
    await t.pglite.query(
      `INSERT INTO tax_deposits (jurisdiction, period_start, amount, due_date, status, deposited_on, eftps_confirmation, created_by)
       VALUES ('CA','2026-07-01','123.45','2026-08-17','deposited','2026-08-14','SYN-0001','scheduler'),
              ('CA','2026-08-01','123.45','2026-09-15','overdue',NULL,NULL,'scheduler'),
              ('CA','2026-09-01','130.00','2026-10-15','pending',NULL,NULL,'scheduler')`,
    );
    await schedule("quarterly", null);
    await syncDeposits({ db: t.db, config: t.config }, { today: "2026-10-01" });
    expect(await caRows("2026-10-01")).toEqual([
      "month 2026-07-01 123.45 deposited",
      "quarter 2026-07-01 253.45 open",
      "month 2026-08-01 123.45 superseded sup_at",
      "month 2026-09-01 130.00 superseded sup_at",
    ]);
    await t.pglite.exec(REVERT);
    expect(await caRows(await dbToday())).toEqual([
      "month 2026-07-01 123.45 deposited",
      "month 2026-08-01 123.45 open",
      "month 2026-09-01 130.00 open",
    ]);
  });

  it("T07 end (Case C month rows): aborts, changing nothing", async () => {
    await threeRuns();
    await schedule("quarterly", null);
    await syncDeposits({ db: t.db, config: t.config }, { today: "2026-09-20" });
    await schedule("monthly", 15);
    await syncDeposits({ db: t.db, config: t.config }, { today: "2026-10-05" });
    const before = await caRows("2026-10-05");
    expect(before).toEqual([
      "month 2026-07-01 123.45 open",
      "quarter 2026-07-01 376.90 superseded sup_at",
      "month 2026-08-01 123.45 open",
      "month 2026-09-01 130.00 open",
    ]);
    await expect(t.pglite.exec(REVERT)).rejects.toThrow(/month rows replaced a quarter row/);
    await t.pglite.exec("ROLLBACK").catch(() => undefined);
    expect(await caRows("2026-10-05")).toEqual(before);
  });

  it("T33 shape (quarterly, monthly, quarterly again): month rows back, every quarter row gone", async () => {
    await threeRuns();
    await t.pglite.query(
      `INSERT INTO tax_deposits (jurisdiction, period_start, amount, due_date, status, deposited_on, eftps_confirmation, created_by, created_at)
       VALUES ('CA','2026-07-01','123.45','2026-08-17','deposited','2026-08-14','SYN-0001','scheduler', now() - interval '1 day'),
              ('CA','2026-08-01','123.45','2026-09-15','overdue',NULL,NULL,'scheduler', now() - interval '1 day'),
              ('CA','2026-09-01','130.00','2026-10-15','pending',NULL,NULL,'scheduler', now() - interval '1 day')`,
    );
    const deps = { db: t.db, config: t.config };
    await schedule("quarterly", null);
    await syncDeposits(deps, { today: "2026-10-01" });
    await schedule("monthly", 15);
    await syncDeposits(deps, { today: "2026-10-05" });
    await schedule("quarterly", null);
    await syncDeposits(deps, { today: "2026-10-06" });
    await t.pglite.exec(REVERT);
    const after = await caRows(await dbToday());
    expect(after.filter((r) => !r.includes("superseded"))).toEqual([
      "month 2026-07-01 123.45 deposited",
      "month 2026-08-01 123.45 open",
      "month 2026-09-01 130.00 open",
    ]);
    expect(after.filter((r) => r.startsWith("quarter"))).toEqual([]);
  });

  it("aborts, changing nothing, when a quarter row to delete has an attachment", async () => {
    await threeRuns();
    await schedule("quarterly", null);
    await syncDeposits({ db: t.db, config: t.config }, { today: "2026-10-01" });
    await t.pglite.exec(
      `INSERT INTO deposit_attachments (deposit_id, filename, size_bytes, data, uploaded_by)
       SELECT id, 'x.pdf', 1, '\\x00'::bytea, 'synthetic' FROM tax_deposits WHERE period_kind = 'quarter'`,
    );
    const before = await caRows("2026-10-01");
    await expect(t.pglite.exec(REVERT)).rejects.toThrow(/quarter row to delete has an attachment/);
    await t.pglite.exec("ROLLBACK").catch(() => undefined);
    expect(await caRows("2026-10-01")).toEqual(before);
  });

  it("a restored 0.00 month row past its due date is pending, never overdue", async () => {
    await t.pglite.exec(
      `INSERT INTO tax_deposits (jurisdiction, period_start, amount, due_date, status, superseded_at, created_by)
       VALUES ('CA', '2026-01-01', '0.00', '2026-02-17', 'superseded', now(), 'scheduler')`,
    );
    await t.pglite.exec(REVERT);
    const r = await t.pglite.query<{ status: string }>(
      `SELECT status FROM tax_deposits WHERE jurisdiction = 'CA' AND period_start = '2026-01-01'`,
    );
    expect(r.rows).toEqual([{ status: "pending" }]);
  });

  it("takes an EXCLUSIVE lock and says the app must be stopped", () => {
    expect(REVERT).toMatch(/BEGIN;\s+LOCK TABLE tax_deposits IN EXCLUSIVE MODE;/);
    expect(REVERT).toMatch(/STOP THE APP FIRST/);
  });

  it("aborts, changing nothing, when a quarter row is deposited", async () => {
    await threeRuns();
    await schedule("quarterly", null);
    await syncDeposits({ db: t.db, config: t.config }, { today: "2026-10-01" });
    await t.pglite.exec(
      `UPDATE tax_deposits SET status='deposited', deposited_on='2026-10-02' WHERE period_kind='quarter'`,
    );
    const before = await caRows("2026-10-01");
    await expect(t.pglite.exec(REVERT)).rejects.toThrow(/quarter row is deposited/);
    await t.pglite.exec("ROLLBACK").catch(() => undefined);
    expect(await caRows("2026-10-01")).toEqual(before);
  });
});

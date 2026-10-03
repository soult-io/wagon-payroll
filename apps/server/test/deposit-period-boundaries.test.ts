/**
 * PAY-93 surviving mutants (Stryker baseline on main), now in
 * deposits/periods.ts, deposits/transition.ts and the service's unit queries:
 *  (1) monthly December due date must land in January of the NEXT year
 *      (`year + 1` -> `year`);
 *  (2) a quarter's first month is (q-1)*3+1: Q3 is exactly Jul–Sep, and May/
 *      June runs must never be counted in it (`(q-1)*3+1` -> `-1`).
 * Exact dates (weekday-checked) and exact cents. Synthetic data only.
 *   2027-01-15 Fri · 2027-01-31 Sun -> 02-01 Mon · 2026-07-31 Fri ·
 *   2026-10-31 Sat -> 11-02 Mon
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { company, employees, seedDatabase, type SeedDb } from "@payroll/db";
import { dueDateFor, stateDueDateFor, statePeriodStartFor } from "../src/deposits/periods.js";
import { planStateQuarter } from "../src/deposits/transition.js";
import { getDepositDetail, syncDeposits } from "../src/deposits/service.js";
import { createTestApp, type TestContext } from "./helpers.js";

describe("(1) December under a monthly state schedule", () => {
  it("due date is in January of the next year", () => {
    expect(stateDueDateFor({ frequency: "monthly", dueDay: 15 }, 2026, "2026-12-01")).toBe(
      "2027-01-15",
    );
    expect(stateDueDateFor({ frequency: "monthly", dueDay: null }, 2026, "2026-12-01")).toBe(
      "2027-02-01",
    );
    expect(stateDueDateFor(null, 2026, "2026-12-01")).toBe("2027-01-15");
    expect(dueDateFor(2026, 12)).toBe("2027-01-15");
    // Quarterly Q4 rolls into the next year too.
    expect(stateDueDateFor({ frequency: "quarterly", dueDay: 15 }, 2026, "2026-10-01")).toBe(
      "2027-01-15",
    );
  });

  it("the planner inserts the December month row due 2027-01-15", () => {
    const p = planStateQuarter({
      year: 2026,
      quarter: 4,
      schedule: { frequency: "monthly", dueDay: 15 },
      liability: [0, 0, 4321],
      live: [],
      today: "2026-12-20",
    });
    expect(p.inserts).toEqual([
      {
        kind: "month",
        periodStart: "2026-12-01",
        seq: 0,
        cents: 4321,
        dueDate: "2027-01-15",
        status: "pending",
      },
    ]);
  });
});

describe("(2) quarter range is exactly its three months", () => {
  it("statePeriodStartFor maps every month to its own quarter's first month", () => {
    const q = { frequency: "quarterly" } as const;
    expect([5, 6, 7, 8, 9, 10].map((m) => statePeriodStartFor(q, 2026, m))).toEqual([
      "2026-04-01",
      "2026-04-01",
      "2026-07-01",
      "2026-07-01",
      "2026-07-01",
      "2026-10-01",
    ]);
  });

  it("the planner's Q3 month rows are Jul, Aug, Sep", () => {
    const p = planStateQuarter({
      year: 2026,
      quarter: 3,
      schedule: null,
      liability: [100, 200, 300],
      live: [],
      today: "2026-07-01",
    });
    expect(p.inserts.map((i) => [i.periodStart, i.cents, i.dueDate])).toEqual([
      ["2026-07-01", 100, "2026-08-17"],
      ["2026-08-01", 200, "2026-09-15"],
      ["2026-09-01", 300, "2026-10-15"],
    ]);
    // A May row can never enter the Q3 unit.
    expect(() =>
      planStateQuarter({
        year: 2026,
        quarter: 3,
        schedule: null,
        liability: [0, 0, 0],
        live: [
          {
            id: 1,
            kind: "month",
            periodStart: "2026-05-01",
            cents: 1,
            dueDate: "2026-06-15",
            status: "pending",
            depositedOn: null,
            seq: 0,
          },
        ],
        today: "2026-07-01",
      }),
    ).toThrow(/outside the unit/);
  });

  describe("integration: May + June runs, then Q3", () => {
    let t: TestContext;
    beforeAll(async () => {
      t = await createTestApp();
      await seedDatabase(t.db as unknown as SeedDb);
      await t.pglite.exec(`TRUNCATE tax_deposits, payroll_entries, payroll_runs RESTART IDENTITY CASCADE;
        DELETE FROM state_deposit_schedules;
        INSERT INTO state_deposit_schedules (state_code, tax_year, frequency, due_day) VALUES ('CA', 2026, 'quarterly', NULL);`);
      const c = await t.db.select({ id: company.id }).from(company).limit(1);
      const emp = (
        await t.db
          .insert(employees)
          .values({ companyId: c[0]!.id, legalName: "Ada Range", hireDate: "2025-01-01" })
          .returning()
      )[0]!.id;
      const runs: [string, string][] = [
        ["2026-05-15", "111.11"],
        ["2026-06-15", "222.22"],
        ["2026-07-15", "123.45"],
        ["2026-08-14", "123.45"],
        ["2026-09-15", "130.00"],
      ];
      for (const [payDate, swh] of runs) {
        const r = await t.pglite.query<{ id: number }>(
          `INSERT INTO payroll_runs (employee_id, period_start, period_end, pay_date, status, run_snapshot, issued_at)
           VALUES ($1, $2, $3, $4, 'issued', '{"inputs":{"state":{"workState":"CA"}}}'::jsonb, now()) RETURNING id`,
          [emp, `${payDate.slice(0, 7)}-01`, `${payDate.slice(0, 7)}-28`, payDate],
        );
        await t.pglite.query(
          `INSERT INTO payroll_entries (run_id, category, amount) VALUES ($1, 'state_withholding', $2)`,
          [r.rows[0]!.id, swh],
        );
      }
      // Deposited month rows as v1.24 wrote them: May (Q2) and July (Q3).
      await t.pglite.exec(`INSERT INTO tax_deposits (jurisdiction, period_start, amount, due_date, status, deposited_on, eftps_confirmation, created_by)
        VALUES ('CA', '2026-05-01', '30.00', '2026-06-15', 'deposited', '2026-06-10', 'SYN-MAY', 'scheduler'),
               ('CA', '2026-07-01', '50.00', '2026-08-17', 'deposited', '2026-08-10', 'SYN-JUL', 'scheduler');`);
      await syncDeposits({ db: t.db, config: t.config }, { today: "2026-07-10" });
    }, 180_000);
    afterAll(async () => {
      await t.close();
    });

    it("Q2 = May+June only (333.33 - 30.00, due 07-31); Q3 = Jul–Sep only (376.90 - 50.00, due 11-02)", async () => {
      const r = await t.pglite.query<{ s: string }>(
        `SELECT period_kind || ' ' || period_start || ' ' || amount || ' ' || due_date || ' ' || status AS s
           FROM tax_deposits WHERE jurisdiction = 'CA' ORDER BY period_start, period_kind`,
      );
      expect(r.rows.map((x) => x.s)).toEqual([
        "quarter 2026-04-01 303.33 2026-07-31 pending",
        "month 2026-05-01 30.00 2026-06-15 deposited",
        "month 2026-07-01 50.00 2026-08-17 deposited",
        "quarter 2026-07-01 326.90 2026-11-02 pending",
      ]);
    });

    it("the Q3 detail counts only Jul–Sep runs", async () => {
      const id = (
        await t.pglite.query<{ id: number }>(
          `SELECT id FROM tax_deposits WHERE jurisdiction = 'CA' AND period_start = '2026-07-01' AND period_kind = 'quarter'`,
        )
      ).rows[0]!.id;
      const d = await getDepositDetail(t.db, id);
      expect(d!.liability).toBe("376.90");
      // Only the July payment is credited; the May payment belongs to Q2.
      expect(d!.credits.map((c) => [c.periodStart, c.amount, c.applied])).toEqual([
        ["2026-07-01", "50.00", "50.00"],
      ]);
      expect(d!.breakdown).toEqual([{ category: "state_withholding", amount: "376.90" }]);
      expect(d!.runs.map((x) => [x.payDate, x.amount])).toEqual([
        ["2026-07-15", "123.45"],
        ["2026-08-14", "123.45"],
        ["2026-09-15", "130.00"],
      ]);
    });
  });
});

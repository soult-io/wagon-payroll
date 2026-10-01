/**
 * Spec 26 (PAY-173) §8 S-4 — regression guard: deposits, the 941 and the W-2
 * already group by PAY date (R6/R7, S7). A December 2026 period paid
 * 2027-01-05 lands in the 2027-01 deposits, 941 Q1 2027 and the 2027 W-2,
 * never in 2026. Reconciled as "sum of runs = form line" (auditor method).
 *
 * The IL 2027 deposit schedule is SYNTHETIC (fixtures/synthetic-2027.ts).
 * W-2 boxes 16/17 do not exist on main 1fbd87e (Spec 24 / PAY-116 not built);
 * the state side is checked on the IL deposit row instead.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { seedDatabase, taxDeposits, type SeedDb } from "@payroll/db";
import { formatCents } from "@payroll/shared";
import { syncDeposits } from "../src/deposits/service.js";
import { w2FiguresForYear } from "../src/filings/annual.js";
import { computeWorksheet } from "../src/filings/service.js";
import { createTestApp, type TestContext } from "./helpers.js";
import {
  seedSyntheticFederal2027,
  seedSyntheticIl2027,
  seedSyntheticIlDepositSchedule2027,
} from "./fixtures/synthetic-2027.js";
import {
  approveAndIssue,
  cents,
  createEmployee,
  entriesOf,
  gen,
  insertWorkState,
  monthPeriod,
} from "./pay-date-helpers.js";

let t: TestContext;
let emp = 0;
let nov: Record<string, number> = {};
let jan: Record<string, number> = {};

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  await seedSyntheticFederal2027(t.db);
  await seedSyntheticIl2027(t.db);
  await seedSyntheticIlDepositSchedule2027(t.db);
  emp = await createEmployee(t, 500_000);
  await insertWorkState(t, emp, "IL", "2024-01-01");
  const novRun = (await gen(t, emp, monthPeriod("2026-11", "2026-11-15"))).run;
  await approveAndIssue(t, novRun.publicId, "2026-11-10T12:00:00Z");
  const decRun = (await gen(t, emp, monthPeriod("2026-12", "2027-01-05"))).run;
  await approveAndIssue(t, decRun.publicId, "2026-12-20T12:00:00Z");
  nov = await entriesOf(t, novRun.id);
  jan = await entriesOf(t, decRun.id);
  await syncDeposits({ db: t.db, config: t.config }, { today: "2027-01-10" });
}, 120_000);

afterAll(async () => {
  await t.close();
});

async function liveDeposit(jurisdiction: string, periodStart: string): Promise<number | null> {
  const rows = await t.db
    .select({ amount: taxDeposits.amount })
    .from(taxDeposits)
    .where(
      and(
        eq(taxDeposits.jurisdiction, jurisdiction),
        eq(taxDeposits.periodStart, periodStart),
        sql`${taxDeposits.status} <> 'superseded'`,
      ),
    );
  return rows[0] ? cents(rows[0].amount) : null;
}

const fed941 = (e: Record<string, number>) =>
  (e.federal_withholding ?? 0) +
  (e.social_security ?? 0) +
  (e.employer_social_security ?? 0) +
  (e.medicare ?? 0) +
  (e.employer_medicare ?? 0);

describe("S-4: deposits, 941 and W-2 follow the pay date", () => {
  it("IL deposit 2027-01 = the Jan-5 payment's state withholding; IL 2026-12 holds none of it", async () => {
    expect({
      il202701: await liveDeposit("IL", "2027-01-01"),
      il202612: (await liveDeposit("IL", "2026-12-01")) ?? 0,
      il202611: await liveDeposit("IL", "2026-11-01"),
    }).toEqual({ il202701: jan.state_withholding, il202612: 0, il202611: nov.state_withholding });
  });

  it("federal deposit 2027-01 = FIT + SS×2 + Medicare×2 of the Jan-5 payment", async () => {
    expect({
      fed202701: await liveDeposit("federal", "2027-01-01"),
      fed202612: (await liveDeposit("federal", "2026-12-01")) ?? 0,
    }).toEqual({ fed202701: fed941(jan), fed202612: 0 });
  });

  it("941 Q1 2027 line 2 / 3 = the Jan-5 payment; 941 Q4 2026 = the Nov payment only", async () => {
    const q1 = await computeWorksheet(t.db, 2027, 1);
    const q4 = await computeWorksheet(t.db, 2026, 4);
    expect({
      q1Wages: q1.line2Wages,
      q1Fit: q1.line3FederalWithheld,
      q4Wages: q4.line2Wages,
      q4Fit: q4.line3FederalWithheld,
    }).toEqual({
      q1Wages: formatCents(jan.gross_pay!),
      q1Fit: formatCents(jan.federal_withholding!),
      q4Wages: formatCents(nov.gross_pay!),
      q4Fit: formatCents(nov.federal_withholding!),
    });
  });

  it("W-2 2027 box 1/2/4 include the Jan-5 payment; W-2 2026 excludes it", async () => {
    const pick = async (year: number) => {
      const f = (await w2FiguresForYear(t.db, year)).find((r) => r.employeeId === emp);
      return f ? { box1: f.box1Cents, box2: f.box2Cents, box4: f.box4Cents } : null;
    };
    expect({ w2027: await pick(2027), w2026: await pick(2026) }).toEqual({
      w2027: { box1: jan.gross_pay, box2: jan.federal_withholding, box4: jan.social_security },
      w2026: { box1: nov.gross_pay, box2: nov.federal_withholding, box4: nov.social_security },
    });
  });
});

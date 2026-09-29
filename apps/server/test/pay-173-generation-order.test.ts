/**
 * Spec 26 (PAY-173) D6 at draft generation (Product Lead ruling on the
 * auditor's T2 gap): when an issued run of the same pay-date year already
 * sorts after the new draft, the DB FUTA trigger (0025, sums every issued run
 * of the year) can reject the draft's employer_futa entry although the app
 * guard (prior YTD by key) accepts it. Generation must answer with the fixed
 * 409 ytd_order_conflict, never a raw database error, and write nothing.
 * Synthetic people; money in integer cents.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import { payrollRuns, seedDatabase, type SeedDb } from "@payroll/db";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";
import {
  createEmployee,
  gen,
  insertIssuedHistoryRun,
  monthPeriod,
  settle,
} from "./pay-date-helpers.js";

let t: TestContext;
let ADMIN: Record<string, string>;

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "pay-173-gen-admin@test.dev", role: "admin" });
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);
}, 120_000);

afterAll(async () => {
  await t.close();
});

async function runsOf(emp: number): Promise<number> {
  const rows = await t.db
    .select({ n: count() })
    .from(payrollRuns)
    .where(eq(payrollRuns.employeeId, emp));
  return Number(rows[0]?.n ?? 0);
}

/**
 * June (paid 06-15, FUTA 3,000) and November (paid 12-04, FUTA 1,200) issued:
 * the 2026 FUTA base is used up. An October draft paid 12-04 sorts before
 * November, so its prior YTD is June only (500,000 gross, FUTA 3,000) and it
 * accrues FUTA 1,200 (200,000 × 0.6 %) — the app guard allows 4,200, the
 * trigger sees 4,200 issued + 1,200.
 */
async function outOfOrderSetup(): Promise<number> {
  const emp = await createEmployee(t, 500_000);
  await insertIssuedHistoryRun(t, emp, monthPeriod("2026-06", "2026-06-15"), {
    gross_pay: 500_000,
    employer_futa: 3_000,
  });
  await insertIssuedHistoryRun(t, emp, monthPeriod("2026-11", "2026-12-04"), {
    gross_pay: 500_000,
    employer_futa: 1_200,
  });
  return emp;
}

describe("D6 at generation", () => {
  it("generateDraft → ytd_order_conflict naming the later pay date; no run written", async () => {
    const emp = await outOfOrderSetup();
    const res = await settle(gen(t, emp, monthPeriod("2026-10", "2026-12-04")));
    expect({
      ok: res.ok,
      code: res.ok ? null : res.code,
      namesPayDate: res.ok ? false : res.message.includes("2026-12-04"),
      noAmounts: res.ok ? false : !/\d+\.\d{2}/.test(res.message),
      runs: await runsOf(emp),
    }).toEqual({
      ok: false,
      code: "ytd_order_conflict",
      namesPayDate: true,
      noAmounts: true,
      runs: 2,
    });
  });

  it("POST /api/admin/payroll-runs/generate reports it as skipped (201), not a 500", async () => {
    const emp = await createEmployee(t, 500_000);
    await insertIssuedHistoryRun(t, emp, monthPeriod("2026-06", "2026-06-15"), {
      gross_pay: 500_000,
      employer_futa: 3_000,
    });
    // November period paid in advance on 2026-10-20: the seeded monthly
    // schedule pays October on 2026-10-15, which sorts before it.
    await insertIssuedHistoryRun(t, emp, monthPeriod("2026-11", "2026-10-20"), {
      gross_pay: 500_000,
      employer_futa: 1_200,
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/api/admin/payroll-runs/generate",
      headers: ADMIN,
      payload: { year: 2026, month: 10, employeeId: emp },
    });
    const body = res.json() as { generated: unknown[]; skipped: { reason: string }[] };
    expect({
      status: res.statusCode,
      generated: body.generated.length,
      skipped: body.skipped.map((x) => x.reason),
      runs: await runsOf(emp),
    }).toEqual({ status: 201, generated: 0, skipped: ["ytd_order_conflict"], runs: 2 });
  });
});

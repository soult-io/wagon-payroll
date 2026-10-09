/**
 * PAY-247 — Form 941 lines 5a/5c column 1 come from WAGES PAID, not from the
 * withheld tax back-solved through the combined rate. Per-paycheck cent
 * rounding lands on line 7 (fractions of cents).
 *
 * Source: 2026 Instructions for Form 941 (Revised 03/2026):
 *   - Line 5a: "Enter the total wages ... subject to social security tax you
 *     paid to your employees" ... "Stop paying social security tax on and
 *     entering an employee's wages on line 5a when the employee's taxable
 *     wages and tips reach $184,500 for the year." Column 2 = col 1 × 0.124.
 *   - Line 5c: "Enter all wages ... that are subject to Medicare tax." No
 *     wage base. Column 2 = col 1 × 0.029.
 *   - Line 7: "adjustments for fractions of cents (due to rounding) ... The
 *     employee share of amounts shown in column 2 of lines 5a–5d may differ
 *     slightly from amounts actually withheld ... may be a positive or a
 *     negative adjustment."
 * The app's line 7 default (D4) reconciles line 6 to the exact entry-derived
 * liability (fed + SS EE+ER + Medicare EE+ER), so line 12 = that liability.
 *
 * Every run here is inserted directly as an issued (or void/draft) row with
 * hand-picked entry amounts, so every expected figure below is hand
 * arithmetic on those amounts — nothing is produced by engine/service code.
 * Each scenario gets its own PGlite database so quarters never bleed
 * between scenarios. All figures are synthetic.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  company,
  employees,
  payrollEntries,
  payrollRuns,
  seedDatabase,
  type SeedDb,
} from "@payroll/db";
import { computeWorksheet, worksheetHash } from "../src/filings/service.js";
import { createTestApp, type TestContext } from "./helpers.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Boot a fresh PGlite app (migrations + seed: company, 2025/2026 tax_config). */
function useFreshDb(): { ctx: () => TestContext } {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestApp();
    await seedDatabase(t.db as unknown as SeedDb);
  }, 120_000);
  afterAll(async () => {
    await t.close();
  });
  return { ctx: () => t };
}

let employeeSeq = 0;
async function createEmployee(t: TestContext): Promise<number> {
  employeeSeq += 1;
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({
      companyId: companyRows[0]!.id,
      legalName: `PAY-247 Synthetic Employee ${employeeSeq}`,
      hireDate: "2025-01-01",
    })
    .returning();
  return rows[0]!.id;
}

interface RunSpec {
  employeeId: number;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  status?: "issued" | "void" | "draft";
  gross: string;
  fed: string;
  /** Employee SS; employer SS is the same amount (6.2% each side). */
  ss: string;
  /** Employee Medicare; employer Medicare is the same amount (1.45% each side). */
  med: string;
}

/** Insert a run row + its entry snapshot exactly as given (no engine). */
async function insertRun(t: TestContext, r: RunSpec): Promise<void> {
  const status = r.status ?? "issued";
  const rows = await t.db
    .insert(payrollRuns)
    .values({
      employeeId: r.employeeId,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      payDate: r.payDate,
      status,
      runSnapshot: { synthetic: "PAY-247" },
      createdBy: "test",
      ...(status === "issued" ? { issuedAt: new Date(`${r.payDate}T12:00:00Z`) } : {}),
      ...(status === "void"
        ? { voidedAt: new Date(`${r.payDate}T12:00:00Z`), voidReason: "PAY-247 test" }
        : {}),
    })
    .returning();
  const runId = rows[0]!.id;
  // net = gross − fed − SS EE − Medicare EE, in integer cents.
  const cents = (s: string) => Math.round(Number(s) * 100);
  const net = (cents(r.gross) - cents(r.fed) - cents(r.ss) - cents(r.med)) / 100;
  await t.db.insert(payrollEntries).values([
    { runId, category: "gross_pay", amount: r.gross },
    { runId, category: "federal_withholding", amount: r.fed },
    { runId, category: "social_security", amount: r.ss },
    { runId, category: "employer_social_security", amount: r.ss },
    { runId, category: "medicare", amount: r.med },
    { runId, category: "employer_medicare", amount: r.med },
    { runId, category: "net_pay", amount: net.toFixed(2) },
  ]);
}

/** Monthly run paid on the 15th of `month`. */
function monthly(
  employeeId: number,
  year: number,
  month: number,
  gross: string,
  fed: string,
  ss: string,
  med: string,
  status: RunSpec["status"] = "issued",
): RunSpec {
  const mm = String(month).padStart(2, "0");
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    employeeId,
    periodStart: `${year}-${mm}-01`,
    periodEnd: `${year}-${mm}-${last}`,
    payDate: `${year}-${mm}-15`,
    status,
    gross,
    fed,
    ss,
    med,
  };
}

interface Expected {
  line2: string;
  line3: string;
  line5aWages: string;
  line5aTax: string;
  line5cWages: string;
  line5cTax: string;
  line5e: string;
  line6: string;
  line7: string;
  line12: string;
}

async function expectWorksheet(t: TestContext, year: number, quarter: number, e: Expected) {
  const w = await computeWorksheet(t.db, year, quarter);
  expect({
    line2: w.line2Wages,
    line3: w.line3FederalWithheld,
    line5aWages: w.line5aTaxableSsWages,
    line5aTax: w.line5aTax,
    line5cWages: w.line5cTaxableMedicareWages,
    line5cTax: w.line5cTax,
    line5e: w.line5eTotal,
    line6: w.line6TotalTaxes,
    line7: w.line7FractionsOfCents,
    line12: w.line12TotalAfterCredits,
  }).toEqual(e);
  // Line 7 default tracks the computed delta; 5d is out of scope and stays 0.
  expect(w.line7Computed).toBe(e.line7);
  expect(w.line5dAdditionalMedicare).toBe("0.00");
  return w;
}

// ---------------------------------------------------------------------------
// 1. Round-up: per-run Medicare rounds UP (the reported bug)
// ---------------------------------------------------------------------------

describe("PAY-247 scenario 1 — per-run Medicare rounds up", () => {
  const { ctx } = useFreshDb();

  it("5c col 1 = wages paid, col 2 = wages × 2.9%, rounding delta on line 7", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    // Per run: gross 2,250.00
    //   SS     2,250.00 × 6.2%  = 139.50 exact (EE and ER)
    //   Med    2,250.00 × 1.45% = 32.625 → 32.63 (EE and ER)
    //   Fed    150.00 (synthetic)
    for (const m of [1, 2, 3])
      await insertRun(t, monthly(e, 2026, m, "2250.00", "150.00", "139.50", "32.63"));

    // line 2  = 3 × 2,250.00 = 6,750.00 ; line 3 = 3 × 150.00 = 450.00
    // 5a wages = 6,750.00 (YTD far below 184,500) ; 5a tax = 6,750.00 × 0.124 = 837.00
    // 5c wages = 6,750.00 ; 5c tax = 6,750.00 × 0.029 = 195.75
    // 5e = 837.00 + 195.75 = 1,032.75 ; line 6 = 450.00 + 1,032.75 = 1,482.75
    // exact = 450.00 + 6 × 139.50 (837.00) + 6 × 32.63 (195.78) = 1,482.78
    // line 7 = 1,482.78 − 1,482.75 = 0.03 ; line 12 = 1,482.78
    // (Old code: 195.78 / 0.029 = 6,751.03 in 5c col 1, line 7 = 0.00.)
    await expectWorksheet(t, 2026, 1, {
      line2: "6750.00",
      line3: "450.00",
      line5aWages: "6750.00",
      line5aTax: "837.00",
      line5cWages: "6750.00",
      line5cTax: "195.75",
      line5e: "1032.75",
      line6: "1482.75",
      line7: "0.03",
      line12: "1482.78",
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Round-down: per-run Medicare rounds DOWN → negative line 7
// ---------------------------------------------------------------------------

describe("PAY-247 scenario 2 — per-run Medicare rounds down", () => {
  const { ctx } = useFreshDb();

  it("line 7 is negative when withheld Medicare is below wages × 2.9%", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    // Jan, Feb: gross 2,145.00 → SS 132.99 exact ; Med 31.1025 → 31.10 (down)
    // Mar:      gross 2,140.00 → SS 132.68 exact ; Med 31.03 exact
    // Fed 100.00 each run.
    await insertRun(t, monthly(e, 2026, 1, "2145.00", "100.00", "132.99", "31.10"));
    await insertRun(t, monthly(e, 2026, 2, "2145.00", "100.00", "132.99", "31.10"));
    await insertRun(t, monthly(e, 2026, 3, "2140.00", "100.00", "132.68", "31.03"));

    // line 2 = 2,145 + 2,145 + 2,140 = 6,430.00 ; line 3 = 300.00
    // 5a = 6,430.00 × 0.124 = 797.32 ; SS entries = 2 × (132.99+132.99+132.68) = 797.32
    // 5c = 6,430.00 × 0.029 = 186.47 ; Med entries = 2 × (31.10+31.10+31.03) = 186.46
    // 5e = 983.79 ; line 6 = 1,283.79 ; exact = 300 + 797.32 + 186.46 = 1,283.78
    // line 7 = 1,283.78 − 1,283.79 = −0.01 ; line 12 = 1,283.78
    // (Old code: 186.46 / 0.029 = 6,429.66 in 5c col 1, line 7 = 0.00.)
    await expectWorksheet(t, 2026, 1, {
      line2: "6430.00",
      line3: "300.00",
      line5aWages: "6430.00",
      line5aTax: "797.32",
      line5cWages: "6430.00",
      line5cTax: "186.47",
      line5e: "983.79",
      line6: "1283.79",
      line7: "-0.01",
      line12: "1283.78",
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Clean: no rounding anywhere (regression) + empty quarter
// ---------------------------------------------------------------------------

describe("PAY-247 scenario 3 — no rounding (regression)", () => {
  const { ctx } = useFreshDb();

  it("5a/5c = gross, line 7 = 0.00", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    // Gross 4,000.00: SS 248.00 exact, Med 58.00 exact; fed 310.13.
    for (const m of [1, 2, 3])
      await insertRun(t, monthly(e, 2026, m, "4000.00", "310.13", "248.00", "58.00"));

    // line 2 = 12,000.00 ; line 3 = 3 × 310.13 = 930.39
    // 5a tax = 12,000 × 0.124 = 1,488.00 (= 6 × 248.00)
    // 5c tax = 12,000 × 0.029 = 348.00 (= 6 × 58.00)
    // 5e = 1,836.00 ; line 6 = 2,766.39 ; line 7 = 0.00 ; line 12 = 2,766.39
    await expectWorksheet(t, 2026, 1, {
      line2: "12000.00",
      line3: "930.39",
      line5aWages: "12000.00",
      line5aTax: "1488.00",
      line5cWages: "12000.00",
      line5cTax: "348.00",
      line5e: "1836.00",
      line6: "2766.39",
      line7: "0.00",
      line12: "2766.39",
    });
  });

  it("a quarter with no issued runs is all zero", async () => {
    await expectWorksheet(ctx(), 2026, 4, {
      line2: "0.00",
      line3: "0.00",
      line5aWages: "0.00",
      line5aTax: "0.00",
      line5cWages: "0.00",
      line5cTax: "0.00",
      line5e: "0.00",
      line6: "0.00",
      line7: "0.00",
      line12: "0.00",
    });
  });
});

// ---------------------------------------------------------------------------
// 4. SS rounding too: gross where 6.2% has a half cent
// ---------------------------------------------------------------------------

describe("PAY-247 scenario 4 — per-run SS has a half cent", () => {
  const { ctx } = useFreshDb();

  it("5a col 1 = wages paid; SS and Medicare deltas both land on line 7", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    // Gross 2,252.50:
    //   SS  2,252.50 × 6.2%  = 139.655  → 139.66 (half-up)
    //   Med 2,252.50 × 1.45% = 32.66125 → 32.66
    //   Fed 150.00
    for (const m of [1, 2, 3])
      await insertRun(t, monthly(e, 2026, m, "2252.50", "150.00", "139.66", "32.66"));

    // line 2 = 6,757.50 ; line 3 = 450.00
    // 5a tax = 6,757.50 × 0.124 = 837.93 ; SS entries = 6 × 139.66 = 837.96 (+0.03)
    // 5c tax = 6,757.50 × 0.029 = 195.9675 → 195.97 ; Med entries = 6 × 32.66 = 195.96 (−0.01)
    // 5e = 1,033.90 ; line 6 = 1,483.90 ; exact = 450 + 837.96 + 195.96 = 1,483.92
    // line 7 = +0.02 ; line 12 = 1,483.92
    // (Old code: 5a col 1 = 837.96 / 0.124 = 6,757.74; 5c col 1 = 195.96 / 0.029 = 6,757.24.)
    await expectWorksheet(t, 2026, 1, {
      line2: "6757.50",
      line3: "450.00",
      line5aWages: "6757.50",
      line5aTax: "837.93",
      line5cWages: "6757.50",
      line5cTax: "195.97",
      line5e: "1033.90",
      line6: "1483.90",
      line7: "0.02",
      line12: "1483.92",
    });
  });
});

// ---------------------------------------------------------------------------
// 5. SS wage base crossed mid-quarter (class e) + calendar-year YTD reset
// ---------------------------------------------------------------------------

describe("PAY-247 scenario 5 — 2026 SS wage base ($184,500) crossed mid-quarter", () => {
  const { ctx } = useFreshDb();

  beforeAll(async () => {
    const t = ctx();
    const e = await createEmployee(t);
    // Prior year (pay date 2025-12-15): gross 100,000 — must NOT count toward
    // 2026 YTD (wage base is per calendar year of payment).
    await insertRun(t, monthly(e, 2025, 12, "100000.00", "20000.00", "6200.00", "1450.00"));
    // Q1 2026: 3 × 50,000.00 → YTD 150,000. SS 3,100.00, Med 725.00, fed 12,000.00.
    for (const m of [1, 2, 3])
      await insertRun(t, monthly(e, 2026, m, "50000.00", "12000.00", "3100.00", "725.00"));
    // Q2 2026 (YTD never exceeds 200,000 → no Additional Medicare):
    //   Apr 20,000 → YTD 170,000, SS-taxable 20,000 → SS 1,240.00 ; Med 290.00
    //   May 20,000 → YTD 190,000, SS-taxable 184,500 − 170,000 = 14,500 → SS 899.00 ; Med 290.00
    //   Jun 10,000 → YTD 200,000, SS-taxable 0 → SS 0.00 ; Med 145.00
    await insertRun(t, monthly(e, 2026, 4, "20000.00", "4000.00", "1240.00", "290.00"));
    await insertRun(t, monthly(e, 2026, 5, "20000.00", "4000.00", "899.00", "290.00"));
    await insertRun(t, monthly(e, 2026, 6, "10000.00", "1800.00", "0.00", "145.00"));
  });

  it("Q1: under the base, the prior-year run does not reduce 2026 room", async () => {
    // 5a = min(150,000, 184,500 − 0) = 150,000 (a 2025 run counted as 2026
    // YTD would cap this at 84,500).
    // 5a tax = 150,000 × 0.124 = 18,600.00 ; 5c tax = 150,000 × 0.029 = 4,350.00
    // line 6 = 36,000 + 18,600 + 4,350 = 58,950.00 ; line 7 = 0.00
    await expectWorksheet(ctx(), 2026, 1, {
      line2: "150000.00",
      line3: "36000.00",
      line5aWages: "150000.00",
      line5aTax: "18600.00",
      line5cWages: "150000.00",
      line5cTax: "4350.00",
      line5e: "22950.00",
      line6: "58950.00",
      line7: "0.00",
      line12: "58950.00",
    });
  });

  it("Q2: 5a capped at the remaining base, 5c uncapped", async () => {
    // Q2 gross = 50,000.00 ; prior YTD before Apr 1 = 150,000.00
    // 5a = min(50,000, max(0, 184,500 − 150,000)) = 34,500.00
    // 5a tax = 34,500 × 0.124 = 4,278.00 (= 2 × (1,240 + 899 + 0))
    // 5c = 50,000.00 ; 5c tax = 1,450.00 (= 2 × (290 + 290 + 145))
    // line 3 = 4,000 + 4,000 + 1,800 = 9,800.00
    // 5e = 5,728.00 ; line 6 = 15,528.00 ; line 7 = 0.00 ; line 12 = 15,528.00
    await expectWorksheet(ctx(), 2026, 2, {
      line2: "50000.00",
      line3: "9800.00",
      line5aWages: "34500.00",
      line5aTax: "4278.00",
      line5cWages: "50000.00",
      line5cTax: "1450.00",
      line5e: "5728.00",
      line6: "15528.00",
      line7: "0.00",
      line12: "15528.00",
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Two employees: one crosses the base in the quarter, one does not
// ---------------------------------------------------------------------------

describe("PAY-247 scenario 6 — two employees, one capped", () => {
  const { ctx } = useFreshDb();

  it("caps per employee, not company-wide; Medicare rounding still on line 7", async () => {
    const t = ctx();
    const a = await createEmployee(t);
    const b = await createEmployee(t);
    // A: Jan–Jun 6 × 30,000 → YTD 180,000 (SS 1,860.00, Med 435.00, fed 7,000.00).
    for (const m of [1, 2, 3, 4, 5, 6])
      await insertRun(t, monthly(a, 2026, m, "30000.00", "7000.00", "1860.00", "435.00"));
    // A in Q3: Jul 15,000 → SS-taxable 184,500 − 180,000 = 4,500 → SS 279.00, Med 217.50
    //          Aug  5,000 → YTD 200,000, SS 0.00, Med 72.50 (no Additional Medicare)
    await insertRun(t, monthly(a, 2026, 7, "15000.00", "3000.00", "279.00", "217.50"));
    await insertRun(t, monthly(a, 2026, 8, "5000.00", "1000.00", "0.00", "72.50"));
    // B in Q3: 3 × 2,250.00 (SS 139.50, Med 32.625 → 32.63, fed 150.00).
    for (const m of [7, 8, 9])
      await insertRun(t, monthly(b, 2026, m, "2250.00", "150.00", "139.50", "32.63"));

    // line 2 = 15,000 + 5,000 + 6,750 = 26,750.00 ; line 3 = 3,000 + 1,000 + 450 = 4,450.00
    // 5a = A min(20,000, 4,500) + B min(6,750, 184,500) = 4,500 + 6,750 = 11,250.00
    // 5a tax = 11,250 × 0.124 = 1,395.00 (= 2 × (279 + 0 + 3 × 139.50))
    // 5c = 26,750.00 ; 5c tax = 26,750 × 0.029 = 775.75
    // Med entries = 2 × (217.50 + 72.50 + 3 × 32.63) = 775.78
    // 5e = 2,170.75 ; line 6 = 6,620.75 ; exact = 4,450 + 1,395 + 775.78 = 6,620.78
    // line 7 = 0.03 ; line 12 = 6,620.78
    const w = await expectWorksheet(t, 2026, 3, {
      line2: "26750.00",
      line3: "4450.00",
      line5aWages: "11250.00",
      line5aTax: "1395.00",
      line5cWages: "26750.00",
      line5cTax: "775.75",
      line5e: "2170.75",
      line6: "6620.75",
      line7: "0.03",
      line12: "6620.78",
    });
    expect(w.line1Employees).toBe(2); // both paid for the period including Jul 12
  });
});

// ---------------------------------------------------------------------------
// 7. Void / draft runs excluded (class d), recompute idempotent (class c)
// ---------------------------------------------------------------------------

describe("PAY-247 scenario 7 — void/draft excluded, hash stable", () => {
  const { ctx } = useFreshDb();

  it("void and draft runs in the quarter never count; recompute is stable", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    const other = await createEmployee(t);
    for (const m of [1, 2, 3])
      await insertRun(t, monthly(e, 2026, m, "2250.00", "150.00", "139.50", "32.63"));
    // Voided Feb run for the same employee (gross 9,999.00) — excluded.
    await insertRun(t, monthly(e, 2026, 2, "9999.00", "999.00", "619.94", "144.99", "void"));
    // Draft Mar run for another employee (gross 5,000.00) — excluded.
    await insertRun(t, monthly(other, 2026, 3, "5000.00", "500.00", "310.00", "72.50", "draft"));

    // Same arithmetic as scenario 1.
    const expected: Expected = {
      line2: "6750.00",
      line3: "450.00",
      line5aWages: "6750.00",
      line5aTax: "837.00",
      line5cWages: "6750.00",
      line5cTax: "195.75",
      line5e: "1032.75",
      line6: "1482.75",
      line7: "0.03",
      line12: "1482.78",
    };
    const w1 = await expectWorksheet(t, 2026, 1, expected);
    const w2 = await expectWorksheet(t, 2026, 1, expected);
    expect(worksheetHash(w1)).toBe(worksheetHash(w2));
    expect(w1.line1Employees).toBe(1);
  });

  it("void and draft runs in a prior quarter do not consume the wage base", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    // Q1: issued 3 × 50,000 → YTD 150,000 (SS 3,100.00, Med 725.00, fed 12,000.00).
    for (const m of [1, 2, 3])
      await insertRun(t, monthly(e, 2026, m, "50000.00", "12000.00", "3100.00", "725.00"));
    // A voided Jan run of 50,000 — if counted, YTD would be 200,000 and Q2 5a 0.
    await insertRun(t, monthly(e, 2026, 1, "50000.00", "12000.00", "3100.00", "725.00", "void"));
    // A draft run (own period) of 50,000 paid 2026-03-28 — must not count either.
    await insertRun(t, {
      employeeId: e,
      periodStart: "2026-03-16",
      periodEnd: "2026-03-31",
      payDate: "2026-03-28",
      status: "draft",
      gross: "50000.00",
      fed: "12000.00",
      ss: "3100.00",
      med: "725.00",
    });
    // Q2: Apr 20,000 → YTD 170,000, fully SS-taxable → SS 1,240.00, Med 290.00.
    // This context's Q2 holds only this run (scenario-7 quarter is Q1).
    await insertRun(t, monthly(e, 2026, 4, "20000.00", "4000.00", "1240.00", "290.00"));

    // 5a = min(20,000, 184,500 − 150,000) = 20,000 ; 5a tax = 2,480.00
    // 5c = 20,000 ; 5c tax = 580.00 ; line 6 = 4,000 + 2,480 + 580 = 7,060.00 ; line 7 = 0.00
    await expectWorksheet(t, 2026, 2, {
      line2: "20000.00",
      line3: "4000.00",
      line5aWages: "20000.00",
      line5aTax: "2480.00",
      line5cWages: "20000.00",
      line5cTax: "580.00",
      line5e: "3060.00",
      line6: "7060.00",
      line7: "0.00",
      line12: "7060.00",
    });
  });
});

// ---------------------------------------------------------------------------
// 8. Quarter and year boundaries by PAY DATE (class e)
// ---------------------------------------------------------------------------

describe("PAY-247 scenario 8 — quarter/year boundaries by pay date", () => {
  const { ctx } = useFreshDb();

  beforeAll(async () => {
    const t = ctx();
    const e = await createEmployee(t);
    const run = (periodStart: string, periodEnd: string, payDate: string): RunSpec => ({
      employeeId: e,
      periodStart,
      periodEnd,
      payDate,
      gross: "2250.00",
      fed: "150.00",
      ss: "139.50",
      med: "32.63",
    });
    await insertRun(t, run("2025-12-01", "2025-12-31", "2025-12-31")); // Q4 2025 (last day of year)
    await insertRun(t, run("2026-01-01", "2026-01-31", "2026-01-30")); // Q1
    await insertRun(t, run("2026-02-01", "2026-02-28", "2026-02-27")); // Q1
    await insertRun(t, run("2026-03-01", "2026-03-15", "2026-03-31")); // Q1 (last day of quarter)
    await insertRun(t, run("2026-03-16", "2026-03-31", "2026-04-01")); // Q2 (first day of next quarter)
  });

  it("Q1 2026 holds exactly the Jan 30 / Feb 27 / Mar 31 runs", async () => {
    // Same arithmetic as scenario 1: 3 × 2,250.00.
    await expectWorksheet(ctx(), 2026, 1, {
      line2: "6750.00",
      line3: "450.00",
      line5aWages: "6750.00",
      line5aTax: "837.00",
      line5cWages: "6750.00",
      line5cTax: "195.75",
      line5e: "1032.75",
      line6: "1482.75",
      line7: "0.03",
      line12: "1482.78",
    });
  });

  it("Q2 2026 holds the Apr 1 run (period in March, paid in April)", async () => {
    // 5a tax = 2,250 × 0.124 = 279.00 ; 5c tax = 2,250 × 0.029 = 65.25
    // Med entries 2 × 32.63 = 65.26 → line 7 = 0.01
    // line 6 = 150 + 279 + 65.25 = 494.25 ; line 12 = 494.26
    await expectWorksheet(ctx(), 2026, 2, {
      line2: "2250.00",
      line3: "150.00",
      line5aWages: "2250.00",
      line5aTax: "279.00",
      line5cWages: "2250.00",
      line5cTax: "65.25",
      line5e: "344.25",
      line6: "494.25",
      line7: "0.01",
      line12: "494.26",
    });
  });

  it("Q4 2025 holds the Dec 31 run (2025 wage base year)", async () => {
    await expectWorksheet(ctx(), 2025, 4, {
      line2: "2250.00",
      line3: "150.00",
      line5aWages: "2250.00",
      line5aTax: "279.00",
      line5cWages: "2250.00",
      line5cTax: "65.25",
      line5e: "344.25",
      line6: "494.25",
      line7: "0.01",
      line12: "494.26",
    });
  });
});

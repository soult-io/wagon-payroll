/**
 * PAY-98 — Form 941 line 5d (Additional Medicare Tax withholding).
 *
 * Published rule (Instructions for Form 941 Rev. 03/2026, lines 5c/5d/5e/7;
 * Pub 15 (2026) §9 "Additional Medicare Tax withholding" and §15; IRS
 * Questions and Answers for the Additional Medicare Tax). Same rule in 2025.
 *   - Line 5d column 1: per employee, Medicare wages PAID in the quarter in
 *     excess of $200,000 paid year-to-date in the calendar year by this
 *     employer. Per pay date:
 *       excess = max(0, min(this pay's Medicare wages, YTD after this pay − 200,000)).
 *     Exactly $200,000 YTD is not "in excess". YTD resets Jan 1. Pay-date
 *     basis (same as lines 2–5c). Employees are never combined.
 *   - Column 2 = column 1 × 0.009, rounded to the cent (half-up). Employee
 *     share only; no employer match.
 *   - Line 5d col 1 ≤ line 5c col 1. Line 5e = 5a col 2 + 5c col 2 + 5d col 2.
 *     Line 6 = line 3 + line 5e.
 *   - Line 7 covers only rounding between column 2 of 5a–5d and what was
 *     withheld. The app's line 7 default (D4) reconciles line 6 to the
 *     entry-derived liability (fed + SS EE+ER + Medicare EE+ER). The employee
 *     "medicare" entry INCLUDES the 0.9% withheld, so with correct entries
 *     line 7 is cent-level rounding and line 12 equals that liability.
 *
 * Seeded tax_config (packages/db/src/seed.ts from packages/engine
 * TAX_CONFIG / TAX_CONFIG_2025): medicare_additional_threshold 200000.00 and
 * medicare_additional_rate 0.00900 for both 2025 and 2026; SS wage base
 * 176,100 (2025) / 184,500 (2026).
 *
 * Medicare wages = the gross_pay entry (no pre-tax deductions modelled).
 * Every run is inserted directly as an issued (or void/draft) row with
 * hand-picked entry amounts. Per-run entries follow the published per-check
 * method: SS = round(SS wages × 6.2%), Medicare EE = round(gross × 1.45%) +
 * round(excess × 0.9%), Medicare ER = round(gross × 1.45%), all half-up.
 * Every expected figure is hand arithmetic, shown in comments, and was
 * cross-checked by an independent decimal script — never from engine or
 * service output. Each scenario gets its own PGlite database. All figures
 * are synthetic.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  company,
  employees,
  payrollEntries,
  payrollRuns,
  seedDatabase,
  taxConfig,
  taxFilings,
  type SeedDb,
} from "@payroll/db";
import { and, eq } from "drizzle-orm";
import { computeWorksheet, syncFilings, worksheetHash } from "../src/filings/service.js";
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
      legalName: `PAY-98 Synthetic Employee ${employeeSeq}`,
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
  /** Employee Medicare INCLUDING any 0.9% Additional Medicare withheld. */
  med: string;
  /** Employer Medicare (1.45% only). Defaults to `med` (no excess on this pay). */
  medEr?: string;
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
      runSnapshot: { synthetic: "PAY-98" },
      createdBy: "test",
      ...(status === "issued" ? { issuedAt: new Date(`${r.payDate}T12:00:00Z`) } : {}),
      ...(status === "void"
        ? { voidedAt: new Date(`${r.payDate}T12:00:00Z`), voidReason: "PAY-98 test" }
        : {}),
    })
    .returning();
  const runId = rows[0]!.id;
  const cents = (s: string) => Math.round(Number(s) * 100);
  const net = (cents(r.gross) - cents(r.fed) - cents(r.ss) - cents(r.med)) / 100;
  await t.db.insert(payrollEntries).values([
    { runId, category: "gross_pay", amount: r.gross },
    { runId, category: "federal_withholding", amount: r.fed },
    { runId, category: "social_security", amount: r.ss },
    { runId, category: "employer_social_security", amount: r.ss },
    { runId, category: "medicare", amount: r.med },
    { runId, category: "employer_medicare", amount: r.medEr ?? r.med },
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
  medEr?: string,
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
    ...(medEr !== undefined ? { medEr } : {}),
  };
}

interface Expected {
  line2: string;
  line3: string;
  line5aWages: string;
  line5aTax: string;
  line5cWages: string;
  line5cTax: string;
  line5dWages: string;
  line5dTax: string;
  line5e: string;
  line6: string;
  line7: string;
  line12: string;
}

type WorksheetWith5d = Awaited<ReturnType<typeof computeWorksheet>> & {
  line5dAdditionalMedicareWages?: string;
};

const MONEY_RE = /^-?\d+\.\d{2}$/;
const toCents = (s: string) => {
  const neg = s.startsWith("-");
  const [i, f] = (neg ? s.slice(1) : s).split(".");
  const c = Number(i) * 100 + Number(f);
  return neg ? -c : c;
};

/**
 * Scenario 10 invariant, applied on EVERY worksheet this file computes:
 * 5d col 1 is a money string and never exceeds 5c col 1.
 */
function expect5dInvariant(w: WorksheetWith5d): void {
  const col1 = w.line5dAdditionalMedicareWages;
  expect(col1, "line5dAdditionalMedicareWages present").toMatch(MONEY_RE);
  expect(toCents(col1!)).toBeGreaterThanOrEqual(0);
  expect(toCents(col1!)).toBeLessThanOrEqual(toCents(w.line5cTaxableMedicareWages));
}

async function expectWorksheet(
  t: TestContext,
  year: number,
  quarter: number,
  e: Expected,
): Promise<WorksheetWith5d> {
  const w = (await computeWorksheet(t.db, year, quarter)) as WorksheetWith5d;
  expect({
    line2: w.line2Wages,
    line3: w.line3FederalWithheld,
    line5aWages: w.line5aTaxableSsWages,
    line5aTax: w.line5aTax,
    line5cWages: w.line5cTaxableMedicareWages,
    line5cTax: w.line5cTax,
    line5dWages: w.line5dAdditionalMedicareWages,
    line5dTax: w.line5dAdditionalMedicare,
    line5e: w.line5eTotal,
    line6: w.line6TotalTaxes,
    line7: w.line7FractionsOfCents,
    line12: w.line12TotalAfterCredits,
  }).toEqual(e);
  expect(w.line7Computed).toBe(e.line7);
  expect5dInvariant(w);
  return w;
}

// ---------------------------------------------------------------------------
// 0. Seeded config values the rule reads (threshold + rate per year)
// ---------------------------------------------------------------------------

describe("PAY-98 seed — tax_config Additional Medicare threshold and rate", () => {
  const { ctx } = useFreshDb();

  it("2025 and 2026 federal rows carry 200,000.00 and 0.9%", async () => {
    const rows = await ctx()
      .db.select({
        year: taxConfig.taxYear,
        threshold: taxConfig.medicareAdditionalThreshold,
        rate: taxConfig.medicareAdditionalRate,
      })
      .from(taxConfig)
      .where(eq(taxConfig.jurisdiction, "federal"));
    const byYear = Object.fromEntries(rows.map((r) => [r.year, [r.threshold, r.rate]]));
    expect(byYear[2025]).toEqual(["200000.00", "0.00900"]);
    expect(byYear[2026]).toEqual(["200000.00", "0.00900"]);
  });
});

// ---------------------------------------------------------------------------
// 1. Crosses $200k mid-quarter: only the excess counts
// ---------------------------------------------------------------------------

describe("PAY-98 scenario 1 — crosses $200,000 mid-quarter (class: threshold crossing)", () => {
  const { ctx } = useFreshDb();

  beforeAll(async () => {
    const t = ctx();
    const e = await createEmployee(t);
    // Q1: 3 × 50,000 → YTD 150,000. SS 3,100.00, Med 725.00, fed 12,000.00.
    for (const m of [1, 2, 3])
      await insertRun(t, monthly(e, 2026, m, "50000.00", "12000.00", "3100.00", "725.00"));
    // Apr 40,000 → YTD 190,000; excess 0. SS-taxable 184,500 − 150,000 = 34,500 → 2,139.00
    //   Med 40,000 × 1.45% = 580.00.
    await insertRun(t, monthly(e, 2026, 4, "40000.00", "8000.00", "2139.00", "580.00"));
    // May 25,000 → YTD 215,000; excess = min(25,000, 15,000) = 15,000. SS 0.00.
    //   Med ER 362.50 ; Med EE 362.50 + 15,000 × 0.9% (135.00) = 497.50.
    await insertRun(t, monthly(e, 2026, 5, "25000.00", "5000.00", "0.00", "497.50", "362.50"));
  });

  it("Q2: 5d col 1 = 15,000.00 (excess only), col 2 = 135.00", async () => {
    // line 2 = 65,000.00 ; line 3 = 13,000.00
    // 5a = 34,500.00 → × 0.124 = 4,278.00 ; 5c = 65,000.00 → × 0.029 = 1,885.00
    // 5d = 15,000.00 → × 0.009 = 135.00
    // 5e = 4,278.00 + 1,885.00 + 135.00 = 6,298.00 ; line 6 = 19,298.00
    // exact = 13,000 + 2 × 2,139.00 + (580.00 + 497.50) + (580.00 + 362.50) = 19,298.00
    // line 7 = 0.00 ; line 12 = 19,298.00
    // (Current code: 5e 6,163.00, line 7 absorbs 135.00.)
    await expectWorksheet(ctx(), 2026, 2, {
      line2: "65000.00",
      line3: "13000.00",
      line5aWages: "34500.00",
      line5aTax: "4278.00",
      line5cWages: "65000.00",
      line5cTax: "1885.00",
      line5dWages: "15000.00",
      line5dTax: "135.00",
      line5e: "6298.00",
      line6: "19298.00",
      line7: "0.00",
      line12: "19298.00",
    });
  });

  it("Q1: under the threshold all quarter → 5d 0.00 / 0.00", async () => {
    // 5a = 150,000 → 18,600.00 ; 5c → 4,350.00 ; 5e 22,950.00 ; line 6 = 36,000 + 22,950 = 58,950.00
    await expectWorksheet(ctx(), 2026, 1, {
      line2: "150000.00",
      line3: "36000.00",
      line5aWages: "150000.00",
      line5aTax: "18600.00",
      line5cWages: "150000.00",
      line5cTax: "4350.00",
      line5dWages: "0.00",
      line5dTax: "0.00",
      line5e: "22950.00",
      line6: "58950.00",
      line7: "0.00",
      line12: "58950.00",
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Crossed in an earlier quarter: all of this quarter's wages count
// ---------------------------------------------------------------------------

describe("PAY-98 scenario 2 — crossed in an earlier quarter (class: prior-quarter crossing)", () => {
  const { ctx } = useFreshDb();

  beforeAll(async () => {
    const t = ctx();
    const e = await createEmployee(t);
    // Jan 70,000 (YTD 70k) SS 4,340.00 Med 1,015.00 ; Feb 70,000 (YTD 140k) same.
    await insertRun(t, monthly(e, 2026, 1, "70000.00", "15000.00", "4340.00", "1015.00"));
    await insertRun(t, monthly(e, 2026, 2, "70000.00", "15000.00", "4340.00", "1015.00"));
    // Mar 70,000 → YTD 210,000 ; excess = min(70,000, 10,000) = 10,000.
    //   SS-taxable 184,500 − 140,000 = 44,500 → 2,759.00
    //   Med ER 1,015.00 ; EE 1,015.00 + 90.00 = 1,105.00
    await insertRun(
      t,
      monthly(e, 2026, 3, "70000.00", "15000.00", "2759.00", "1105.00", "1015.00"),
    );
    // Q2: 3 × 20,000, all excess. SS 0. Med ER 290.00 ; EE 290.00 + 180.00 = 470.00.
    for (const m of [4, 5, 6])
      await insertRun(t, monthly(e, 2026, m, "20000.00", "4000.00", "0.00", "470.00", "290.00"));
  });

  it("Q1 (crossing quarter): 5d col 1 = 10,000.00, col 2 = 90.00", async () => {
    // 5a = 184,500 → 22,878.00 ; 5c = 210,000 → 6,090.00 ; 5d = 10,000 → 90.00
    // 5e = 29,058.00 ; line 6 = 45,000 + 29,058 = 74,058.00
    // exact = 45,000 + 2 × 11,439.00 + 3,135.00 + 3,045.00 = 74,058.00 → line 7 0.00
    await expectWorksheet(ctx(), 2026, 1, {
      line2: "210000.00",
      line3: "45000.00",
      line5aWages: "184500.00",
      line5aTax: "22878.00",
      line5cWages: "210000.00",
      line5cTax: "6090.00",
      line5dWages: "10000.00",
      line5dTax: "90.00",
      line5e: "29058.00",
      line6: "74058.00",
      line7: "0.00",
      line12: "74058.00",
    });
  });

  it("Q2: every Medicare wage dollar counts → 5d 60,000.00 / 540.00", async () => {
    // 5a = 0 ; 5c = 60,000 → 1,740.00 ; 5d = 60,000 → 540.00 ; 5e = 2,280.00
    // line 6 = 12,000 + 2,280 = 14,280.00 ; exact = 12,000 + 3 × 470 + 3 × 290 = 14,280.00
    await expectWorksheet(ctx(), 2026, 2, {
      line2: "60000.00",
      line3: "12000.00",
      line5aWages: "0.00",
      line5aTax: "0.00",
      line5cWages: "60000.00",
      line5cTax: "1740.00",
      line5dWages: "60000.00",
      line5dTax: "540.00",
      line5e: "2280.00",
      line6: "14280.00",
      line7: "0.00",
      line12: "14280.00",
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Stays under $200k all year (ends at 199,999.99)
// ---------------------------------------------------------------------------

describe("PAY-98 scenario 3 — stays under $200,000 all year (class: below threshold)", () => {
  const { ctx } = useFreshDb();

  it("Q4 with year-end YTD 199,999.99: 5d 0.00 / 0.00", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    // Jan–Sep 9 × 18,000 → YTD 162,000 (SS 1,116.00, Med 261.00, fed 3,000.00).
    for (const m of [1, 2, 3, 4, 5, 6, 7, 8, 9])
      await insertRun(t, monthly(e, 2026, m, "18000.00", "3000.00", "1116.00", "261.00"));
    // Oct 18,000 → YTD 180,000: SS 1,116.00
    // Nov 18,000 → YTD 198,000: SS-taxable 184,500 − 180,000 = 4,500 → 279.00
    // Dec 1,999.99 → YTD 199,999.99: SS 0 ; Med 1,999.99 × 1.45% = 28.999855 → 29.00
    await insertRun(t, monthly(e, 2026, 10, "18000.00", "3000.00", "1116.00", "261.00"));
    await insertRun(t, monthly(e, 2026, 11, "18000.00", "3000.00", "279.00", "261.00"));
    await insertRun(t, monthly(e, 2026, 12, "1999.99", "300.00", "0.00", "29.00"));

    // line 2 = 37,999.99 ; line 3 = 6,300.00
    // 5a = 22,500.00 → 2,790.00 ; 5c = 37,999.99 × 0.029 = 1,101.99971 → 1,102.00
    // 5d = 0 ; 5e = 3,892.00 ; line 6 = 10,192.00
    // exact = 6,300 + 2 × 1,395.00 + 2 × 551.00 = 10,192.00 → line 7 0.00
    await expectWorksheet(t, 2026, 4, {
      line2: "37999.99",
      line3: "6300.00",
      line5aWages: "22500.00",
      line5aTax: "2790.00",
      line5cWages: "37999.99",
      line5cTax: "1102.00",
      line5dWages: "0.00",
      line5dTax: "0.00",
      line5e: "3892.00",
      line6: "10192.00",
      line7: "0.00",
      line12: "10192.00",
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Several employees, only one over
// ---------------------------------------------------------------------------

describe("PAY-98 scenario 4 — several employees, only one over (class: per-employee, no combining)", () => {
  const { ctx } = useFreshDb();

  it("only A's excess counts; B + C (270,000 combined) never cross", async () => {
    const t = ctx();
    const a = await createEmployee(t);
    const b = await createEmployee(t);
    const c = await createEmployee(t);
    // A: Jan 100,000 (SS 6,200.00) ; Feb 100,000 → YTD exactly 200,000 → excess 0,
    //    SS-taxable 84,500 → 5,239.00 ; Mar 30,000 → YTD 230,000 → excess 30,000,
    //    SS 0, Med ER 435.00, EE 435.00 + 270.00 = 705.00.
    await insertRun(t, monthly(a, 2026, 1, "100000.00", "25000.00", "6200.00", "1450.00"));
    await insertRun(t, monthly(a, 2026, 2, "100000.00", "25000.00", "5239.00", "1450.00"));
    await insertRun(t, monthly(a, 2026, 3, "30000.00", "7000.00", "0.00", "705.00", "435.00"));
    // B: 3 × 50,000 (YTD 150,000) ; C: 3 × 40,000 (YTD 120,000).
    for (const m of [1, 2, 3]) {
      await insertRun(t, monthly(b, 2026, m, "50000.00", "12000.00", "3100.00", "725.00"));
      await insertRun(t, monthly(c, 2026, m, "40000.00", "9000.00", "2480.00", "580.00"));
    }

    // line 2 = 230,000 + 150,000 + 120,000 = 500,000.00 ; line 3 = 57,000 + 36,000 + 27,000 = 120,000.00
    // 5a = 184,500 + 150,000 + 120,000 = 454,500 → 56,358.00
    // 5c = 500,000 → 14,500.00 ; 5d = 30,000 (A only) → 270.00
    // 5e = 71,128.00 ; line 6 = 191,128.00
    // exact = 120,000 + 56,358 + Med EE 7,520.00 + Med ER 7,250.00 = 191,128.00 → line 7 0.00
    await expectWorksheet(t, 2026, 1, {
      line2: "500000.00",
      line3: "120000.00",
      line5aWages: "454500.00",
      line5aTax: "56358.00",
      line5cWages: "500000.00",
      line5cTax: "14500.00",
      line5dWages: "30000.00",
      line5dTax: "270.00",
      line5e: "71128.00",
      line6: "191128.00",
      line7: "0.00",
      line12: "191128.00",
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Already past the threshold at the quarter's start
// ---------------------------------------------------------------------------

describe("PAY-98 scenario 5 — already past $200,000 at quarter start (class: prior YTD > threshold)", () => {
  const { ctx } = useFreshDb();

  beforeAll(async () => {
    const t = ctx();
    const e = await createEmployee(t);
    // Jan–Apr 4 × 40,000 → YTD 160,000 (SS 2,480.00, Med 580.00, fed 10,000.00).
    for (const m of [1, 2, 3, 4])
      await insertRun(t, monthly(e, 2026, m, "40000.00", "10000.00", "2480.00", "580.00"));
    // May 40,000 → YTD exactly 200,000 → excess 0 ; SS-taxable 24,500 → 1,519.00.
    await insertRun(t, monthly(e, 2026, 5, "40000.00", "10000.00", "1519.00", "580.00"));
    // Jun 40,000 → YTD 240,000 → excess 40,000 ; SS 0 ; Med EE 580 + 360 = 940.00.
    await insertRun(t, monthly(e, 2026, 6, "40000.00", "10000.00", "0.00", "940.00", "580.00"));
    // Q3 (YTD 240,000 at start): Jul/Aug 12,345.67, Sep 12,345.66 — all excess.
    //   12,345.67 × 1.45% = 179.012215 → 179.01 ; × 0.9% = 111.11103 → 111.11
    //   12,345.66 × 1.45% = 179.01207  → 179.01 ; × 0.9% = 111.11094 → 111.11
    //   Med ER 179.01 ; EE 290.12. SS 0.
    await insertRun(t, monthly(e, 2026, 7, "12345.67", "2000.00", "0.00", "290.12", "179.01"));
    await insertRun(t, monthly(e, 2026, 8, "12345.67", "2000.00", "0.00", "290.12", "179.01"));
    await insertRun(t, monthly(e, 2026, 9, "12345.66", "2000.00", "0.00", "290.12", "179.01"));
  });

  it("Q2: exactly 200,000 in May is not excess; June counts → 40,000.00 / 360.00", async () => {
    // 5a = 40,000 + 24,500 = 64,500 → 7,998.00 ; 5c = 120,000 → 3,480.00 ; 5d → 360.00
    // 5e = 11,838.00 ; line 6 = 30,000 + 11,838 = 41,838.00
    // exact = 30,000 + 2 × 3,999.00 + 2,100.00 + 1,740.00 = 41,838.00
    await expectWorksheet(ctx(), 2026, 2, {
      line2: "120000.00",
      line3: "30000.00",
      line5aWages: "64500.00",
      line5aTax: "7998.00",
      line5cWages: "120000.00",
      line5cTax: "3480.00",
      line5dWages: "40000.00",
      line5dTax: "360.00",
      line5e: "11838.00",
      line6: "41838.00",
      line7: "0.00",
      line12: "41838.00",
    });
  });

  it("Q3: all 37,037.00 counts; col 2 333.33; per-check rounding → line 7 −0.01", async () => {
    // 5c = 37,037.00 × 0.029 = 1,074.073 → 1,074.07 ; 5d = 37,037.00 × 0.009 = 333.333 → 333.33
    // 5e = 1,407.40 ; line 6 = 6,000 + 1,407.40 = 7,407.40
    // Med entries = 3 × 290.12 + 3 × 179.01 = 870.36 + 537.03 = 1,407.39
    // exact = 6,000 + 1,407.39 = 7,407.39 ; line 7 = −0.01 ; line 12 = 7,407.39
    // (Current code: line 7 = 333.32.)
    await expectWorksheet(ctx(), 2026, 3, {
      line2: "37037.00",
      line3: "6000.00",
      line5aWages: "0.00",
      line5aTax: "0.00",
      line5cWages: "37037.00",
      line5cTax: "1074.07",
      line5dWages: "37037.00",
      line5dTax: "333.33",
      line5e: "1407.40",
      line6: "7407.40",
      line7: "-0.01",
      line12: "7407.39",
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Boundary: exactly 200,000.00, the next cent, half-up rounding
// ---------------------------------------------------------------------------

describe("PAY-98 scenario 6 — boundary at exactly $200,000.00 (class: edge + rounding)", () => {
  const { ctx } = useFreshDb();

  beforeAll(async () => {
    const t = ctx();
    const e = await createEmployee(t);
    // Jan 100,000 (SS 6,200.00) ; Feb 100,000 → YTD 200,000.00 exactly (SS-taxable 84,500 → 5,239.00).
    await insertRun(t, monthly(e, 2026, 1, "100000.00", "25000.00", "6200.00", "1450.00"));
    await insertRun(t, monthly(e, 2026, 2, "100000.00", "25000.00", "5239.00", "1450.00"));
    // Apr 0.01 → YTD 200,000.01 → excess 0.01. Med 0.000145 → 0.00 ; 0.9% 0.00009 → 0.00.
    await insertRun(t, monthly(e, 2026, 4, "0.01", "0.00", "0.00", "0.00"));
    // Jul 1,005.00 → all excess. Med 14.5725 → 14.57 ; 0.9% = 9.045 → 9.05 (half-up) ; EE 23.62.
    await insertRun(t, monthly(e, 2026, 7, "1005.00", "100.00", "0.00", "23.62", "14.57"));
  });

  it("Q1: YTD reaches exactly 200,000.00 → 5d 0.00 / 0.00", async () => {
    // 5a = 184,500 → 22,878.00 ; 5c = 200,000 → 5,800.00 ; 5e = 28,678.00
    // line 6 = 50,000 + 28,678 = 78,678.00 = exact
    await expectWorksheet(ctx(), 2026, 1, {
      line2: "200000.00",
      line3: "50000.00",
      line5aWages: "184500.00",
      line5aTax: "22878.00",
      line5cWages: "200000.00",
      line5cTax: "5800.00",
      line5dWages: "0.00",
      line5dTax: "0.00",
      line5e: "28678.00",
      line6: "78678.00",
      line7: "0.00",
      line12: "78678.00",
    });
  });

  it("Q2: next cent (YTD 200,000.01) counts → col 1 0.01, col 2 0.00", async () => {
    // 5c = 0.01 × 0.029 = 0.00029 → 0.00 ; 5d = 0.01 × 0.009 = 0.00009 → 0.00
    await expectWorksheet(ctx(), 2026, 2, {
      line2: "0.01",
      line3: "0.00",
      line5aWages: "0.00",
      line5aTax: "0.00",
      line5cWages: "0.01",
      line5cTax: "0.00",
      line5dWages: "0.01",
      line5dTax: "0.00",
      line5e: "0.00",
      line6: "0.00",
      line7: "0.00",
      line12: "0.00",
    });
  });

  it("Q3: col 1 × 0.009 ends in exactly half a cent → rounds up (9.045 → 9.05)", async () => {
    // 5c = 1,005.00 × 0.029 = 29.145 → 29.15 ; 5d = 1,005.00 × 0.009 = 9.045 → 9.05
    // (half-even would give 9.04)
    // 5e = 38.20 ; line 6 = 138.20 ; exact = 100 + 23.62 + 14.57 = 138.19 → line 7 −0.01
    await expectWorksheet(ctx(), 2026, 3, {
      line2: "1005.00",
      line3: "100.00",
      line5aWages: "0.00",
      line5aTax: "0.00",
      line5cWages: "1005.00",
      line5cTax: "29.15",
      line5dWages: "1005.00",
      line5dTax: "9.05",
      line5e: "38.20",
      line6: "138.20",
      line7: "-0.01",
      line12: "138.19",
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Year boundary + pay-date basis
// ---------------------------------------------------------------------------

describe("PAY-98 scenario 7 — calendar-year reset, pay-date basis (class: year boundary)", () => {
  const { ctx } = useFreshDb();

  beforeAll(async () => {
    const t = ctx();
    const e = await createEmployee(t);
    // Period Dec 1–15 paid 2025-12-15 (last run of 2025): 300,000 → 2025 YTD 300,000,
    //   excess 100,000. 2025 SS wage base 176,100 → 10,918.20 ; Med ER 4,350.00 ;
    //   EE 4,350 + 900 = 5,250.00.
    await insertRun(t, {
      employeeId: e,
      periodStart: "2025-12-01",
      periodEnd: "2025-12-15",
      payDate: "2025-12-15",
      gross: "300000.00",
      fed: "70000.00",
      ss: "10918.20",
      med: "5250.00",
      medEr: "4350.00",
    });
    // Period Dec 16–31 2025 paid 2026-01-05 (first run of 2026): counts in 2026.
    //   150,000 → 2026 YTD 150,000 ; SS 9,300.00 ; Med 2,175.00 ; no excess.
    await insertRun(t, {
      employeeId: e,
      periodStart: "2025-12-16",
      periodEnd: "2025-12-31",
      payDate: "2026-01-05",
      gross: "150000.00",
      fed: "35000.00",
      ss: "9300.00",
      med: "2175.00",
    });
    // Feb 60,000 → YTD 210,000 → excess 10,000 ; SS-taxable 34,500 → 2,139.00 ;
    //   Med ER 870.00 ; EE 870 + 90 = 960.00.
    await insertRun(t, monthly(e, 2026, 2, "60000.00", "14000.00", "2139.00", "960.00", "870.00"));
    // Mar 5,000 → excess 5,000 ; SS 0 ; Med ER 72.50 ; EE 72.50 + 45 = 117.50.
    await insertRun(t, monthly(e, 2026, 3, "5000.00", "1000.00", "0.00", "117.50", "72.50"));
  });

  it("Q4 2025: 2025 YTD only → 5d 100,000.00 / 900.00 (2025 tax_config)", async () => {
    // 5a = 176,100 → 21,836.40 ; 5c = 300,000 → 8,700.00 ; 5d = 100,000 → 900.00
    // 5e = 31,436.40 ; line 6 = 101,436.40 ; exact = 70,000 + 21,836.40 + 5,250 + 4,350 = 101,436.40
    await expectWorksheet(ctx(), 2025, 4, {
      line2: "300000.00",
      line3: "70000.00",
      line5aWages: "176100.00",
      line5aTax: "21836.40",
      line5cWages: "300000.00",
      line5cTax: "8700.00",
      line5dWages: "100000.00",
      line5dTax: "900.00",
      line5e: "31436.40",
      line6: "101436.40",
      line7: "0.00",
      line12: "101436.40",
    });
  });

  it("Q1 2026: Dec 2025 pay ignored; Jan 5 (Dec period) counts → 15,000.00 / 135.00", async () => {
    // If 2025 wages counted toward 2026, col 1 would be 215,000. If the Jan 5 run were
    // assigned by period (2025), 2026 YTD would be 65,000 and col 1 0.
    // 5a = 184,500 → 22,878.00 ; 5c = 215,000 → 6,235.00 ; 5d = 15,000 → 135.00
    // 5e = 29,248.00 ; line 6 = 79,248.00
    // exact = 50,000 + 22,878 + Med EE 3,252.50 + Med ER 3,117.50 = 79,248.00
    await expectWorksheet(ctx(), 2026, 1, {
      line2: "215000.00",
      line3: "50000.00",
      line5aWages: "184500.00",
      line5aTax: "22878.00",
      line5cWages: "215000.00",
      line5cTax: "6235.00",
      line5dWages: "15000.00",
      line5dTax: "135.00",
      line5e: "29248.00",
      line6: "79248.00",
      line7: "0.00",
      line12: "79248.00",
    });
  });
});

// ---------------------------------------------------------------------------
// 8. Void and draft runs excluded from YTD and the quarter
// ---------------------------------------------------------------------------

describe("PAY-98 scenario 8 — void and draft runs excluded (class: run status)", () => {
  const { ctx } = useFreshDb();

  it("void/draft never add to YTD or to the quarter's excess", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    // Q1 issued: 3 × 60,000 → YTD 180,000 (SS 3,720.00, Med 870.00, fed 14,000.00).
    for (const m of [1, 2, 3])
      await insertRun(t, monthly(e, 2026, m, "60000.00", "14000.00", "3720.00", "870.00"));
    // Void Feb 60,000 — if counted, YTD before Q2 = 240,000.
    await insertRun(
      t,
      monthly(e, 2026, 2, "60000.00", "14000.00", "3720.00", "870.00", undefined, "void"),
    );
    // Draft run paid 2026-03-28 (own period) — excluded.
    await insertRun(t, {
      employeeId: e,
      periodStart: "2026-03-16",
      periodEnd: "2026-03-31",
      payDate: "2026-03-28",
      status: "draft",
      gross: "60000.00",
      fed: "14000.00",
      ss: "3720.00",
      med: "870.00",
    });
    // Q2 issued: Apr 30,000 → YTD 210,000 → excess 10,000 ; SS-taxable 4,500 → 279.00 ;
    //   Med ER 435.00 ; EE 435 + 90 = 525.00.
    await insertRun(t, monthly(e, 2026, 4, "30000.00", "7000.00", "279.00", "525.00", "435.00"));
    // Void Apr 50,000 and draft May 50,000 inside Q2 — excluded.
    await insertRun(
      t,
      monthly(e, 2026, 4, "50000.00", "9000.00", "0.00", "1175.00", "725.00", "void"),
    );
    await insertRun(
      t,
      monthly(e, 2026, 5, "50000.00", "9000.00", "0.00", "1175.00", "725.00", "draft"),
    );

    // 5a = 4,500 → 558.00 ; 5c = 30,000 → 870.00 ; 5d = 10,000 → 90.00 ; 5e = 1,518.00
    // line 6 = 7,000 + 1,518 = 8,518.00 ; exact = 7,000 + 558 + 525 + 435 = 8,518.00
    await expectWorksheet(t, 2026, 2, {
      line2: "30000.00",
      line3: "7000.00",
      line5aWages: "4500.00",
      line5aTax: "558.00",
      line5cWages: "30000.00",
      line5cTax: "870.00",
      line5dWages: "10000.00",
      line5dTax: "90.00",
      line5e: "1518.00",
      line6: "8518.00",
      line7: "0.00",
      line12: "8518.00",
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Line 7 / totals: Additional Medicare no longer absorbed by line 7
// ---------------------------------------------------------------------------

describe("PAY-98 scenario 9 — line 7 is rounding only; line 12 = entry liability (class: totals)", () => {
  const { ctx } = useFreshDb();

  it("two employees each cross with excess 1,995.00 (0.9% = 17.955 → 17.96 per check)", async () => {
    const t = ctx();
    for (let i = 0; i < 2; i++) {
      const e = await createEmployee(t);
      // Q1: Jan 100,000 (SS 6,200.00, Med 1,450.00) ; Feb 99,995 → YTD 199,995.00
      //   (SS-taxable 84,500 → 5,239.00 ; Med 1,449.9275 → 1,449.93).
      await insertRun(t, monthly(e, 2026, 1, "100000.00", "20000.00", "6200.00", "1450.00"));
      await insertRun(t, monthly(e, 2026, 2, "99995.00", "20000.00", "5239.00", "1449.93"));
      // Apr 2,000 → YTD 201,995 → excess 1,995.00 ; Med 29.00 ; 0.9% 17.955 → 17.96 ; EE 46.96
      await insertRun(t, monthly(e, 2026, 4, "2000.00", "300.00", "0.00", "46.96", "29.00"));
      // May, Jun 2,000 → all excess ; 0.9% 18.00 ; EE 47.00
      await insertRun(t, monthly(e, 2026, 5, "2000.00", "300.00", "0.00", "47.00", "29.00"));
      await insertRun(t, monthly(e, 2026, 6, "2000.00", "300.00", "0.00", "47.00", "29.00"));
    }

    // line 2 = 12,000.00 ; line 3 = 6 × 300 = 1,800.00 ; 5a = 0
    // 5c = 12,000 → 348.00 ; 5d col 1 = 2 × (1,995 + 2,000 + 2,000) = 11,990.00
    // 5d col 2 = 11,990.00 × 0.009 = 107.91
    // 5e = 348.00 + 107.91 = 455.91 ; line 6 = 2,255.91
    // Med EE = 2 × (46.96 + 47.00 + 47.00) = 281.92 ; Med ER = 6 × 29.00 = 174.00
    // exact (line 12) = 1,800.00 + 0.00 + 281.92 + 174.00 = 2,255.92
    // line 7 = 2,255.92 − 2,255.91 = +0.01 (2 × 0.005 per-check rounding of 17.955)
    const w = await expectWorksheet(t, 2026, 2, {
      line2: "12000.00",
      line3: "1800.00",
      line5aWages: "0.00",
      line5aTax: "0.00",
      line5cWages: "12000.00",
      line5cTax: "348.00",
      line5dWages: "11990.00",
      line5dTax: "107.91",
      line5e: "455.91",
      line6: "2255.91",
      line7: "0.01",
      line12: "2255.92",
    });
    // 5e is the sum of the three column-2 figures.
    expect(toCents(w.line5eTotal)).toBe(
      toCents(w.line5aTax) + toCents(w.line5cTax) + toCents(w.line5dAdditionalMedicare),
    );
    // Current code: 5d = 0, 5e = 348.00, line 6 = 2,148.00, so line 7 absorbs
    // 2,255.92 − 2,148.00 = 107.92 (= 5d col 2 107.91 + 0.01 rounding).
    expect(w.line7FractionsOfCents).not.toBe("107.92");
  });
});

// ---------------------------------------------------------------------------
// 10. 5d col 1 ≤ 5c col 1 across every quarter of a mixed dataset
// ---------------------------------------------------------------------------

describe("PAY-98 scenario 10 — 5d col 1 ≤ 5c col 1 invariant (class: invariant)", () => {
  const { ctx } = useFreshDb();

  it("holds for 2025 Q4 and every 2026 quarter; col 2 = col 1 × 0.009 half-up", async () => {
    const t = ctx();
    const hi = await createEmployee(t);
    const lo = await createEmployee(t);
    // hi: 2025 Dec 250,000 ; 2026 monthly 30,000 × 12 (crosses in Jul: YTD 180k → 210k).
    await insertRun(
      t,
      monthly(hi, 2025, 12, "250000.00", "50000.00", "10918.20", "4075.00", "3625.00"),
    );
    for (let m = 1; m <= 12; m++)
      await insertRun(t, monthly(hi, 2026, m, "30000.00", "6000.00", "0.00", "435.00"));
    // (hi/lo entry amounts are not reconciled here; only 5d is asserted.)
    // lo: 2026 monthly 3,000 × 12 (never crosses).
    for (let m = 1; m <= 12; m++)
      await insertRun(t, monthly(lo, 2026, m, "3000.00", "200.00", "186.00", "43.50"));

    // Hand figures for col 1 (hi only): 2025 Q4 = 50,000 ; 2026 Q1/Q2 = 0 ;
    // Q3: Jul 30,000 → YTD 210,000 → 10,000 ; Aug, Sep 30,000 each → 70,000 ; Q4 = 90,000.
    const expectedCol1: Record<string, [string, string]> = {
      "2025-4": ["50000.00", "450.00"],
      "2026-1": ["0.00", "0.00"],
      "2026-2": ["0.00", "0.00"],
      "2026-3": ["70000.00", "630.00"],
      "2026-4": ["90000.00", "810.00"],
    };
    for (const [key, [col1, col2]] of Object.entries(expectedCol1)) {
      const [y, q] = key.split("-").map(Number) as [number, number];
      const w = (await computeWorksheet(t.db, y, q)) as WorksheetWith5d;
      expect5dInvariant(w);
      expect([key, w.line5dAdditionalMedicareWages, w.line5dAdditionalMedicare]).toEqual([
        key,
        col1,
        col2,
      ]);
      // col 2 = round_half_up(col1_cents × 9 / 1000) cents
      const c1 = toCents(w.line5dAdditionalMedicareWages!);
      expect(toCents(w.line5dAdditionalMedicare)).toBe(Math.floor((c1 * 9 + 500) / 1000));
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Re-run: computeWorksheet / syncFilings idempotent
// ---------------------------------------------------------------------------

describe("PAY-98 scenario 11 — recompute and re-sync are idempotent (class: idempotency)", () => {
  const { ctx } = useFreshDb();

  it("computeWorksheet twice → identical; syncFilings twice → second refreshes nothing", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    // Same runs as scenario 1.
    for (const m of [1, 2, 3])
      await insertRun(t, monthly(e, 2026, m, "50000.00", "12000.00", "3100.00", "725.00"));
    await insertRun(t, monthly(e, 2026, 4, "40000.00", "8000.00", "2139.00", "580.00"));
    await insertRun(t, monthly(e, 2026, 5, "25000.00", "5000.00", "0.00", "497.50", "362.50"));

    const w1 = (await computeWorksheet(t.db, 2026, 2)) as WorksheetWith5d;
    const w2 = (await computeWorksheet(t.db, 2026, 2)) as WorksheetWith5d;
    expect(w2).toEqual(w1);
    expect(worksheetHash(w2)).toBe(worksheetHash(w1));
    expect(w1.line5dAdditionalMedicareWages).toBe("15000.00");
    expect(w1.line5dAdditionalMedicare).toBe("135.00");

    await syncFilings({ db: t.db, config: t.config }, { today: "2026-07-15" });
    const readQ2 = async () =>
      (
        await t.db
          .select()
          .from(taxFilings)
          .where(
            and(
              eq(taxFilings.formType, "941"),
              eq(taxFilings.year, 2026),
              eq(taxFilings.quarter, 2),
            ),
          )
      )[0]!;
    const first = await readQ2();
    const second = await syncFilings({ db: t.db, config: t.config }, { today: "2026-07-15" });
    const after = await readQ2();
    expect(second).toEqual({ created: 0, refreshed: 0 });
    expect(after.worksheet).toEqual(first.worksheet);
    expect(after.worksheetHash).toBe(first.worksheetHash);
    expect(after.fractionsOfCents).toBe("0.00");
    const stored = after.worksheet as WorksheetWith5d;
    expect(stored.line5dAdditionalMedicareWages).toBe("15000.00");
    expect(stored.line5dAdditionalMedicare).toBe("135.00");
    expect(stored.line7FractionsOfCents).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// 12. Previous-release data: filed worksheet frozen; unfiled row upgraded
// ---------------------------------------------------------------------------

describe("PAY-98 scenario 12 — previous-release worksheets (class: data compatibility)", () => {
  const { ctx } = useFreshDb();

  /** A worksheet in the pre-PAY-98 shape: no line5dAdditionalMedicareWages, 5d = 0. */
  function oldShapeWorksheet(quarter: number): Record<string, unknown> {
    return {
      form: "941",
      year: 2026,
      quarter,
      line1Employees: 1,
      line2Wages: "65000.00",
      line3FederalWithheld: "13000.00",
      line5aTaxableSsWages: "34500.00",
      line5aTax: "4278.00",
      line5cTaxableMedicareWages: "65000.00",
      line5cTax: "1885.00",
      line5dAdditionalMedicare: "0.00",
      line5eTotal: "6163.00",
      line6TotalTaxes: "19163.00",
      line7FractionsOfCents: "135.00",
      line7Computed: "135.00",
      line10TotalAfterAdjustments: "19298.00",
      line11ResearchCredit: "0.00",
      line12TotalAfterCredits: "19298.00",
      line13Deposits: "0.00",
      line14BalanceDue: "19298.00",
      line15Overpayment: "0.00",
      line16: { month1: "0.00", month2: "0.00", month3: "0.00", deMinimis: false },
    };
  }

  it("filed Q2 row lacking the new field is untouched; unfiled Q3 row gains it", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    // Scenario 1 runs (Q2 crossing) + Q3 Jul 10,000 all excess:
    //   SS 0 ; Med ER 145.00 ; EE 145.00 + 90.00 = 235.00.
    for (const m of [1, 2, 3])
      await insertRun(t, monthly(e, 2026, m, "50000.00", "12000.00", "3100.00", "725.00"));
    await insertRun(t, monthly(e, 2026, 4, "40000.00", "8000.00", "2139.00", "580.00"));
    await insertRun(t, monthly(e, 2026, 5, "25000.00", "5000.00", "0.00", "497.50", "362.50"));
    await insertRun(t, monthly(e, 2026, 7, "10000.00", "2000.00", "0.00", "235.00", "145.00"));

    const filedWs = oldShapeWorksheet(2);
    await t.db.insert(taxFilings).values({
      formType: "941",
      year: 2026,
      quarter: 2,
      dueDate: "2026-07-31",
      status: "filed",
      worksheet: filedWs,
      worksheetHash: "pre-pay-98-synthetic",
      fractionsOfCents: "135.00",
      filedOn: "2026-07-20",
      filingMethod: "synthetic",
      createdBy: "pay-98-test",
    });
    const readyWs = { ...oldShapeWorksheet(3) };
    await t.db.insert(taxFilings).values({
      formType: "941",
      year: 2026,
      quarter: 3,
      dueDate: "2026-11-02",
      status: "ready",
      worksheet: readyWs,
      worksheetHash: "pre-pay-98-synthetic-q3",
      fractionsOfCents: "135.00",
      createdBy: "pay-98-test",
    });

    await syncFilings({ db: t.db, config: t.config }, { today: "2026-10-15" });
    await syncFilings({ db: t.db, config: t.config }, { today: "2026-10-15" });

    const rows = await t.db.select().from(taxFilings).where(eq(taxFilings.formType, "941"));
    const q2 = rows.find((r) => r.year === 2026 && r.quarter === 2)!;
    expect(q2.status).toBe("filed");
    expect(q2.worksheet).toEqual(filedWs);
    expect(q2.worksheet).not.toHaveProperty("line5dAdditionalMedicareWages");
    expect(q2.worksheetHash).toBe("pre-pay-98-synthetic");
    expect(q2.fractionsOfCents).toBe("135.00");

    // Q3 (unfiled, old shape, line 7 "135.00" equalled the old line7Computed →
    // tracks the default, not an admin override): refreshed to the new shape.
    // 5c = 10,000 → 290.00 ; 5d = 10,000 → 90.00 ; 5e = 380.00 ; line 6 = 2,380.00
    // exact = 2,000 + 235.00 + 145.00 = 2,380.00 → line 7 0.00
    const q3 = rows.find((r) => r.year === 2026 && r.quarter === 3)!;
    const w3 = q3.worksheet as WorksheetWith5d;
    expect(w3.line5dAdditionalMedicareWages).toBe("10000.00");
    expect(w3.line5dAdditionalMedicare).toBe("90.00");
    expect(w3.line5eTotal).toBe("380.00");
    expect(w3.line6TotalTaxes).toBe("2380.00");
    expect(w3.line7FractionsOfCents).toBe("0.00");
    expect(w3.line12TotalAfterCredits).toBe("2380.00");
    expect(q3.fractionsOfCents).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// 13. Threshold and rate are read from tax_config, not hard-coded
// ---------------------------------------------------------------------------

describe("PAY-98 scenario 13 — threshold/rate come from tax_config (class: config-driven)", () => {
  const { ctx } = useFreshDb();

  it("a synthetic 2026 threshold of 150,000 moves the crossing point", async () => {
    const t = ctx();
    await t.db
      .update(taxConfig)
      .set({ medicareAdditionalThreshold: "150000.00" })
      .where(and(eq(taxConfig.jurisdiction, "federal"), eq(taxConfig.taxYear, 2026)));
    const e = await createEmployee(t);
    // Q1 3 × 50,000 → YTD exactly 150,000 (not in excess). Q2 Apr 40,000 + May 25,000
    // → all 65,000 is over the synthetic threshold. col 2 = 65,000 × 0.009 = 585.00.
    // (Entries here are not reconciled; only 5d is asserted.)
    for (const m of [1, 2, 3])
      await insertRun(t, monthly(e, 2026, m, "50000.00", "12000.00", "3100.00", "725.00"));
    await insertRun(t, monthly(e, 2026, 4, "40000.00", "8000.00", "2139.00", "580.00"));
    await insertRun(t, monthly(e, 2026, 5, "25000.00", "5000.00", "0.00", "362.50"));

    const q1 = (await computeWorksheet(t.db, 2026, 1)) as WorksheetWith5d;
    const q2 = (await computeWorksheet(t.db, 2026, 2)) as WorksheetWith5d;
    expect([q1.line5dAdditionalMedicareWages, q1.line5dAdditionalMedicare]).toEqual([
      "0.00",
      "0.00",
    ]);
    expect([q2.line5dAdditionalMedicareWages, q2.line5dAdditionalMedicare]).toEqual([
      "65000.00",
      "585.00",
    ]);
  });
});

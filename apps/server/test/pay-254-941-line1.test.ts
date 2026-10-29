/**
 * PAY-254 — Form 941 line 1 counts employees on the payroll for the pay
 * period including the 12th of the quarter's LAST month.
 *
 * Source: Instructions for Form 941 (Rev. 03/2026), line 1: "Enter the number
 * of employees on your payroll for the pay period including March 12, June
 * 12, September 12, or December 12, for the quarter indicated at the top of
 * Form 941. Don't include: ... Employees in nonpay status for the pay period".
 *
 * Rule under test (settled spec, PAY-254):
 *   R1 key day = Mar 12 / Jun 12 / Sep 12 / Dec 12 for Q1..Q4.
 *   R2 count of DISTINCT employees with an issued run whose period includes
 *      the key day (periodStart <= key day <= periodEnd, both inclusive),
 *      selected by pay period only, whatever the pay date. Lines 2–15 keep
 *      the pay-date basis.
 *   R3 counted only if the sum of gross_pay across that employee's issued
 *      covering runs is > 0 (sum <= 0, or no gross_pay entry = nonpay status).
 *   R4 status 'issued' only.
 *
 * Every run is inserted directly with hand-picked entries, so each expected
 * count below is read off the fixture against R1–R4 — nothing comes from
 * engine or service code. Each scenario gets its own PGlite database so the
 * company-wide count never mixes scenarios. All figures are synthetic.
 */

import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  company,
  contractorDetails,
  contractorInvoices,
  contractorPayments,
  employees,
  payrollEntries,
  payrollRuns,
  seedDatabase,
  type SeedDb,
} from "@payroll/db";
import { computeWorksheet } from "../src/filings/service.js";
import { ROOT } from "./annual-w2-corrected-harness.js";
import { createTestApp, type TestContext } from "./helpers.js";

// ---------------------------------------------------------------------------
// Harness (same shape as pay-247-941-taxable-wages.test.ts)
// ---------------------------------------------------------------------------

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
async function createEmployee(
  t: TestContext,
  opts: { hireDate?: string; terminationDate?: string; employmentType?: "w2" | "1099" } = {},
): Promise<number> {
  employeeSeq += 1;
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({
      companyId: companyRows[0]!.id,
      legalName: `PAY-254 Synthetic Worker ${employeeSeq}`,
      hireDate: opts.hireDate ?? "2025-01-01",
      employmentType: opts.employmentType ?? "w2",
      ...(opts.terminationDate
        ? { terminationDate: opts.terminationDate, status: "terminated" }
        : {}),
    })
    .returning();
  return rows[0]!.id;
}

type RunStatus = "issued" | "void" | "draft" | "awaiting_approval" | "approved";

interface RunSpec {
  employeeId: number;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  status?: RunStatus;
  /** Gross pay; null = the run has NO gross_pay entry at all. */
  gross: string | null;
}

/**
 * Insert a run + entry snapshot exactly as given (no engine). Taxes are flat
 * round figures (fed 10%, SS 6.2%, Medicare 1.45% of gross, exact to the
 * cent for the round grosses used here); line 1 depends on gross only.
 */
async function insertRun(t: TestContext, r: RunSpec): Promise<void> {
  const status = r.status ?? "issued";
  const at = new Date(`${r.payDate}T12:00:00Z`);
  const rows = await t.db
    .insert(payrollRuns)
    .values({
      employeeId: r.employeeId,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      payDate: r.payDate,
      status,
      runSnapshot: { synthetic: "PAY-254" },
      createdBy: "test",
      ...(status === "approved" || status === "issued"
        ? { approvedBy: "test", approvedAt: at }
        : {}),
      ...(status === "issued" ? { issuedAt: at } : {}),
      ...(status === "void" ? { voidedAt: at, voidReason: "PAY-254 test" } : {}),
    })
    .returning();
  const runId = rows[0]!.id;
  if (r.gross === null) {
    await t.db.insert(payrollEntries).values([{ runId, category: "net_pay", amount: "0.00" }]);
    return;
  }
  const g = Math.round(Number(r.gross) * 100); // integer cents
  const pct = (perTenThousand: number) =>
    (Math.round((g * perTenThousand) / 10000) / 100).toFixed(2);
  const fed = pct(1000);
  const ss = pct(620);
  const med = pct(145);
  const net =
    (g -
      Math.round(Number(fed) * 100) -
      Math.round(Number(ss) * 100) -
      Math.round(Number(med) * 100)) /
    100;
  await t.db.insert(payrollEntries).values([
    { runId, category: "gross_pay", amount: r.gross },
    { runId, category: "federal_withholding", amount: fed },
    { runId, category: "social_security", amount: ss },
    { runId, category: "employer_social_security", amount: ss },
    { runId, category: "medicare", amount: med },
    { runId, category: "employer_medicare", amount: med },
    { runId, category: "net_pay", amount: net.toFixed(2) },
  ]);
}

/** Calendar-month run for `month` of `year`, paid on `payDay` of that month. */
function monthRun(
  employeeId: number,
  year: number,
  month: number,
  gross: string | null,
  opts: { payDay?: number; status?: RunStatus } = {},
): RunSpec {
  const mm = String(month).padStart(2, "0");
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const dd = String(opts.payDay ?? 15).padStart(2, "0");
  return {
    employeeId,
    periodStart: `${year}-${mm}-01`,
    periodEnd: `${year}-${mm}-${last}`,
    payDate: `${year}-${mm}-${dd}`,
    gross,
    ...(opts.status ? { status: opts.status } : {}),
  };
}

async function line1(t: TestContext, year: number, quarter: number): Promise<number> {
  return (await computeWorksheet(t.db, year, quarter)).line1Employees;
}

// ---------------------------------------------------------------------------
// Scenarios A–K — Q2 2026, key day 2026-06-12
// ---------------------------------------------------------------------------

describe("PAY-254 A — biweekly period covering Jun 12, paid in the quarter", () => {
  const { ctx } = useFreshDb();

  it("is counted", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    // Jun 6 <= Jun 12 <= Jun 19, issued, gross 2,000.00 > 0 → 1.
    await insertRun(t, {
      employeeId: e,
      periodStart: "2026-06-06",
      periodEnd: "2026-06-19",
      payDate: "2026-06-26",
      gross: "2000.00",
    });
    expect(await line1(t, 2026, 2)).toBe(1);
  });
});

describe("PAY-254 B — period covering Jun 12, paid in the next quarter", () => {
  const { ctx } = useFreshDb();

  beforeAll(async () => {
    const t = ctx();
    const e = await createEmployee(t);
    // Period Jun 1–Jun 15 includes Jun 12; pay date Jul 2 is in Q3.
    await insertRun(t, {
      employeeId: e,
      periodStart: "2026-06-01",
      periodEnd: "2026-06-15",
      payDate: "2026-07-02",
      gross: "2000.00",
    });
  });

  it("is counted on Q2 line 1 (pay period basis, whatever the pay date)", async () => {
    expect(await line1(ctx(), 2026, 2)).toBe(1);
  });

  it("is not counted on Q3 line 1, but its wages are on Q3 line 2 (pay-date basis)", async () => {
    const w = await computeWorksheet(ctx().db, 2026, 3);
    // Sep 12 is outside Jun 1–Jun 15 → 0.
    expect(w.line1Employees).toBe(0);
    // Paid Jul 2 → Q3 wages: 2,000.00.
    expect(w.line2Wages).toBe("2000.00");
  });

  it("Q2 line 2 stays on the pay-date basis (nothing paid in Q2)", async () => {
    const w = await computeWorksheet(ctx().db, 2026, 2);
    expect(w.line2Wages).toBe("0.00");
  });
});

describe("PAY-254 C — monthly run plus an off-cycle bonus run, both covering Jun 12", () => {
  const { ctx } = useFreshDb();

  it("counts the employee once", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    await insertRun(t, monthRun(e, 2026, 6, "3000.00", { payDay: 30 }));
    // Off-cycle bonus: its own period (unique index is employee + period start).
    await insertRun(t, {
      employeeId: e,
      periodStart: "2026-06-12",
      periodEnd: "2026-06-12",
      payDate: "2026-06-19",
      gross: "500.00",
    });
    // Two covering runs, sum 3,500.00 > 0, one distinct employee → 1.
    expect(await line1(t, 2026, 2)).toBe(1);
  });
});

describe("PAY-254 D — unpaid leave over Jun 12 (nonpay status)", () => {
  const { ctx } = useFreshDb();

  it("a covering run with gross 0.00 is not counted", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    // Paid normally in April and May (Apr 12 is NOT the Q2 key day).
    await insertRun(t, monthRun(e, 2026, 4, "3000.00"));
    await insertRun(t, monthRun(e, 2026, 5, "3000.00"));
    // June: on unpaid leave — the covering run pays 0.00 → nonpay → 0.
    await insertRun(t, monthRun(e, 2026, 6, "0.00"));
    expect(await line1(t, 2026, 2)).toBe(0);
  });

  it("a covering run with no gross_pay entry is not counted", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    await insertRun(t, monthRun(e, 2026, 4, "3000.00"));
    // Covering run carries no gross_pay entry → nonpay → still 0 company-wide.
    await insertRun(t, monthRun(e, 2026, 6, null));
    expect(await line1(t, 2026, 2)).toBe(0);
  });
});

describe("PAY-254 E — the only covering run is void", () => {
  const { ctx } = useFreshDb();

  it("is not counted", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    await insertRun(t, monthRun(e, 2026, 4, "3000.00"));
    await insertRun(t, monthRun(e, 2026, 5, "3000.00"));
    await insertRun(t, monthRun(e, 2026, 6, "3000.00", { status: "void" }));
    // Void is not 'issued' (R4) → 0.
    expect(await line1(t, 2026, 2)).toBe(0);
  });
});

describe("PAY-254 F — covering run not yet issued", () => {
  const { ctx } = useFreshDb();

  it("draft, awaiting_approval and approved runs are not counted", async () => {
    const t = ctx();
    for (const status of ["draft", "awaiting_approval", "approved"] as const) {
      const e = await createEmployee(t);
      await insertRun(t, monthRun(e, 2026, 4, "3000.00"));
      await insertRun(t, monthRun(e, 2026, 5, "3000.00"));
      await insertRun(t, monthRun(e, 2026, 6, "3000.00", { status }));
    }
    // Three employees, none with an ISSUED covering run → 0.
    expect(await line1(t, 2026, 2)).toBe(0);
  });
});

describe("PAY-254 G — hired after Jun 12", () => {
  const { ctx } = useFreshDb();

  it("first period Jun 15–Jun 28 is not counted", async () => {
    const t = ctx();
    const e = await createEmployee(t, { hireDate: "2026-06-15" });
    await insertRun(t, {
      employeeId: e,
      periodStart: "2026-06-15",
      periodEnd: "2026-06-28",
      payDate: "2026-06-30",
      gross: "2000.00",
    });
    // Jun 12 < Jun 15 → no covering run → 0, though paid in Q2.
    expect(await line1(t, 2026, 2)).toBe(0);
  });
});

describe("PAY-254 H/I — key day on a period edge (inclusive)", () => {
  const { ctx } = useFreshDb();

  it("H period May 30–Jun 12 (key day = period end) is counted", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    await insertRun(t, {
      employeeId: e,
      periodStart: "2026-05-30",
      periodEnd: "2026-06-12",
      payDate: "2026-06-19",
      gross: "2000.00",
    });
    expect(await line1(t, 2026, 2)).toBe(1);
  });

  it("I period Jun 12–Jun 25 (key day = period start) is counted", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    await insertRun(t, {
      employeeId: e,
      periodStart: "2026-06-12",
      periodEnd: "2026-06-25",
      payDate: "2026-06-30",
      gross: "2000.00",
    });
    // H's employee + I's employee → 2.
    expect(await line1(t, 2026, 2)).toBe(2);
  });

  it("periods ending Jun 11 and starting Jun 13 are not counted", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    await insertRun(t, {
      employeeId: e,
      periodStart: "2026-05-29",
      periodEnd: "2026-06-11",
      payDate: "2026-06-18",
      gross: "2000.00",
    });
    await insertRun(t, {
      employeeId: e,
      periodStart: "2026-06-13",
      periodEnd: "2026-06-26",
      payDate: "2026-07-03",
      gross: "2000.00",
    });
    // Neither period includes Jun 12 → count stays at H + I = 2.
    expect(await line1(t, 2026, 2)).toBe(2);
  });
});

describe("PAY-254 J — terminated May 31, paid in Q2", () => {
  const { ctx } = useFreshDb();

  it("is not on line 1; the wages stay on lines 2, 5a and 5c", async () => {
    const t = ctx();
    const e = await createEmployee(t, { terminationDate: "2026-05-31" });
    await insertRun(t, monthRun(e, 2026, 4, "3000.00"));
    await insertRun(t, monthRun(e, 2026, 5, "3000.00"));
    const w = await computeWorksheet(t.db, 2026, 2);
    // No period includes Jun 12 → 0.
    expect(w.line1Employees).toBe(0);
    // Pay-date basis unchanged: 3,000.00 + 3,000.00 = 6,000.00, YTD far below
    // the 2026 SS wage base ($184,500).
    expect(w.line2Wages).toBe("6000.00");
    expect(w.line5aTaxableSsWages).toBe("6000.00");
    expect(w.line5cTaxableMedicareWages).toBe("6000.00");
  });
});

describe("PAY-254 K — two covering runs that net to zero", () => {
  const { ctx } = useFreshDb();

  // The schema allows this: payroll_entries.amount is NUMERIC(12,2) with no
  // sign CHECK. No app path writes a negative gross_pay today.
  it("+1,000.00 and −1,000.00 over Jun 12 (sum 0) is not counted", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    await insertRun(t, monthRun(e, 2026, 4, "1000.00"));
    await insertRun(t, monthRun(e, 2026, 6, "1000.00"));
    await insertRun(t, {
      employeeId: e,
      periodStart: "2026-06-12",
      periodEnd: "2026-06-12",
      payDate: "2026-06-30",
      gross: "-1000.00",
    });
    // Sum of gross over issued covering runs = 0.00 → not > 0 → 0.
    expect(await line1(t, 2026, 2)).toBe(0);
  });

  it("a covering sum that stays positive is counted", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    await insertRun(t, monthRun(e, 2026, 6, "1000.00"));
    await insertRun(t, {
      employeeId: e,
      periodStart: "2026-06-12",
      periodEnd: "2026-06-12",
      payDate: "2026-06-30",
      gross: "-999.99",
    });
    // Sum 0.01 > 0 → this employee counts; the first one still does not → 1.
    expect(await line1(t, 2026, 2)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Contractors are never on line 1
// ---------------------------------------------------------------------------

describe("PAY-254 — a contractor paid across Jun 12 is not counted", () => {
  const { ctx } = useFreshDb();

  // Contractors are paid through contractor_invoices / contractor_payments,
  // never payroll_runs (runs.ts refuses a non-W-2 employee: not_w2_employee),
  // so a contractor has no pay period. The closest shape: an invoice for June
  // services dated Jun 12 and paid Jun 12.
  it("only the W-2 employee counts", async () => {
    const t = ctx();
    const w2 = await createEmployee(t);
    await insertRun(t, monthRun(w2, 2026, 6, "3000.00"));
    const c = await createEmployee(t, { employmentType: "1099" });
    await t.db.insert(contractorDetails).values({
      employeeId: c,
      taxStatus: "us_person",
      entityType: "individual",
      taxForm: "w9",
      formCollectedAt: "2026-01-02",
      servicesLocation: "us",
    });
    const inv = await t.db
      .insert(contractorInvoices)
      .values({
        employeeId: c,
        description: "PAY-254 synthetic services 2026-06-01 to 2026-06-30",
        amount: "4000.00",
        invoiceDate: "2026-06-12",
        status: "paid",
      })
      .returning();
    await t.db.insert(contractorPayments).values({
      invoiceId: inv[0]!.id,
      payDate: "2026-06-12",
      amount: "4000.00",
      method: "ach",
    });
    // W-2 employee (Jun 1–30 covers Jun 12) → 1; contractor → 0. Total 1.
    expect(await line1(t, 2026, 2)).toBe(1);
  });
});

describe("PAY-254 — a 1099 worker with an issued payroll run is not counted", () => {
  const { ctx } = useFreshDb();

  // runs.ts refuses to create a run for a non-W-2 employee today, so this row
  // can only exist if inserted directly. It pins line 1's W-2 filter in case
  // that refusal ever goes away: the 1099 run is issued, covers Jun 12 and has
  // gross > 0, so only employment_type keeps it off line 1.
  it("only the W-2 employee counts", async () => {
    const t = ctx();
    const w2 = await createEmployee(t);
    await insertRun(t, monthRun(w2, 2026, 6, "3000.00"));
    const c = await createEmployee(t, { employmentType: "1099" });
    await insertRun(t, monthRun(c, 2026, 6, "4000.00"));
    // W-2 employee (Jun 1–30, issued, 3,000.00) → 1; 1099 worker → 0. Total 1.
    expect(await line1(t, 2026, 2)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// All of A–K plus mixed frequencies in one database: distinct count
// ---------------------------------------------------------------------------

describe("PAY-254 — scenarios A–K together", () => {
  const { ctx } = useFreshDb();

  it("counts exactly A, B, C, H, I (= 5)", async () => {
    const t = ctx();
    // A biweekly Jun 6–19, paid Jun 26 → counted
    const a = await createEmployee(t);
    await insertRun(t, {
      employeeId: a,
      periodStart: "2026-06-06",
      periodEnd: "2026-06-19",
      payDate: "2026-06-26",
      gross: "2000.00",
    });
    // B Jun 1–15, paid Jul 2 → counted
    const b = await createEmployee(t);
    await insertRun(t, {
      employeeId: b,
      periodStart: "2026-06-01",
      periodEnd: "2026-06-15",
      payDate: "2026-07-02",
      gross: "2000.00",
    });
    // C monthly + bonus → counted once
    const c = await createEmployee(t);
    await insertRun(t, monthRun(c, 2026, 6, "3000.00", { payDay: 30 }));
    await insertRun(t, {
      employeeId: c,
      periodStart: "2026-06-12",
      periodEnd: "2026-06-12",
      payDate: "2026-06-19",
      gross: "500.00",
    });
    // D gross 0 over Jun 12 → not counted
    const d = await createEmployee(t);
    await insertRun(t, monthRun(d, 2026, 4, "3000.00"));
    await insertRun(t, monthRun(d, 2026, 6, "0.00"));
    // E void → not counted
    const e = await createEmployee(t);
    await insertRun(t, monthRun(e, 2026, 4, "3000.00"));
    await insertRun(t, monthRun(e, 2026, 6, "3000.00", { status: "void" }));
    // F draft / awaiting_approval / approved → not counted
    for (const status of ["draft", "awaiting_approval", "approved"] as const) {
      const f = await createEmployee(t);
      await insertRun(t, monthRun(f, 2026, 4, "3000.00"));
      await insertRun(t, monthRun(f, 2026, 6, "3000.00", { status }));
    }
    // G hired Jun 15 → not counted
    const g = await createEmployee(t, { hireDate: "2026-06-15" });
    await insertRun(t, {
      employeeId: g,
      periodStart: "2026-06-15",
      periodEnd: "2026-06-28",
      payDate: "2026-06-30",
      gross: "2000.00",
    });
    // H May 30–Jun 12 → counted ; I Jun 12–25 → counted
    const h = await createEmployee(t);
    await insertRun(t, {
      employeeId: h,
      periodStart: "2026-05-30",
      periodEnd: "2026-06-12",
      payDate: "2026-06-19",
      gross: "2000.00",
    });
    const i = await createEmployee(t);
    await insertRun(t, {
      employeeId: i,
      periodStart: "2026-06-12",
      periodEnd: "2026-06-25",
      payDate: "2026-06-30",
      gross: "2000.00",
    });
    // J terminated May 31 → not counted
    const j = await createEmployee(t, { terminationDate: "2026-05-31" });
    await insertRun(t, monthRun(j, 2026, 4, "3000.00"));
    await insertRun(t, monthRun(j, 2026, 5, "3000.00"));
    // K +1,000 / −1,000 over Jun 12 → not counted
    const k = await createEmployee(t);
    await insertRun(t, monthRun(k, 2026, 6, "1000.00"));
    await insertRun(t, {
      employeeId: k,
      periodStart: "2026-06-12",
      periodEnd: "2026-06-12",
      payDate: "2026-06-30",
      gross: "-1000.00",
    });

    const w = await computeWorksheet(t.db, 2026, 2);
    expect(w.line1Employees).toBe(5);
    // Line 2 (pay-date basis, Apr 1–Jun 30 pay dates, issued only):
    //   A 2,000 + C (3,000 + 500) + D (3,000 + 0) + E 3,000 (Apr; Jun void)
    //   + F 3 × 3,000 (Apr; Jun not issued) + G 2,000 + H 2,000 + I 2,000
    //   + J (3,000 + 3,000) + K (1,000 − 1,000)
    //   = 2,000 + 3,500 + 3,000 + 3,000 + 9,000 + 2,000 + 2,000 + 2,000
    //   + 6,000 + 0 = 32,500.00 (B is paid Jul 2 → Q3).
    expect(w.line2Wages).toBe("32500.00");
  });
});

// ---------------------------------------------------------------------------
// Customer-zero shape: one employee, calendar-month periods paid the 15th
// ---------------------------------------------------------------------------

describe("PAY-254 — customer-zero shape", () => {
  const { ctx } = useFreshDb();

  beforeAll(async () => {
    const t = ctx();
    const e = await createEmployee(t);
    for (let m = 1; m <= 12; m += 1) await insertRun(t, monthRun(e, 2026, m, "4000.00"));
  });

  for (const q of [1, 2, 3, 4]) {
    it(`Q${q} 2026 line 1 = 1 (the last month's period includes the 12th)`, async () => {
      expect(await line1(ctx(), 2026, q)).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Q1 / Q3 / Q4 key days: Mar 12, Sep 12, Dec 12 — never the first month's 12th
// ---------------------------------------------------------------------------

describe("PAY-254 — Q1/Q3/Q4 key days", () => {
  const { ctx } = useFreshDb();
  let lastMonthOnly = 0;

  beforeAll(async () => {
    const t = ctx();
    // Paid only in the first two months of Q1, Q3, Q4 (periods include
    // Jan/Feb 12, Jul/Aug 12, Oct/Nov 12 — never the key day).
    const early = await createEmployee(t);
    for (const m of [1, 2, 7, 8, 10, 11]) await insertRun(t, monthRun(early, 2026, m, "3000.00"));
    lastMonthOnly = await createEmployee(t);
  });

  it("first/second-month-only runs are not counted: Q1, Q3, Q4 = 0", async () => {
    const t = ctx();
    expect(await line1(t, 2026, 1)).toBe(0); // Mar 12 not covered
    expect(await line1(t, 2026, 3)).toBe(0); // Sep 12 not covered
    expect(await line1(t, 2026, 4)).toBe(0); // Dec 12 not covered
  });

  it("a last-month run covering Mar 12 / Sep 12 / Dec 12 is counted: Q1, Q3, Q4 = 1", async () => {
    const t = ctx();
    for (const m of [3, 9, 12]) await insertRun(t, monthRun(lastMonthOnly, 2026, m, "3000.00"));
    expect(await line1(t, 2026, 1)).toBe(1);
    expect(await line1(t, 2026, 3)).toBe(1);
    expect(await line1(t, 2026, 4)).toBe(1);
  });

  it("Q4: a period covering Dec 12 paid in January of the next year is counted on Q4", async () => {
    const t = ctx();
    const e = await createEmployee(t);
    await insertRun(t, {
      employeeId: e,
      periodStart: "2026-12-12",
      periodEnd: "2026-12-25",
      payDate: "2027-01-02",
      gross: "2000.00",
    });
    // lastMonthOnly (Dec 1–31) + this employee (Dec 12–25) → 2.
    const w = await computeWorksheet(t.db, 2026, 4);
    expect(w.line1Employees).toBe(2);
    // Pay-date basis: Q4 2026 wages = Oct 3,000 + Nov 3,000 (early) + Dec
    // 3,000 (lastMonthOnly) = 9,000.00; the Jan 2 run is not in Q4 wages.
    expect(w.line2Wages).toBe("9000.00");
  });
});

// ---------------------------------------------------------------------------
// Label on the filing page / recompute dialog (spec: WORKSHEET_941_FIELDS)
// ---------------------------------------------------------------------------

describe("PAY-254 — line 1 label", () => {
  it("names the 12th of the quarter's last month", async () => {
    const mod = (await import(
      /* @vite-ignore */ resolve(ROOT, "apps/web/src/lib/worksheet-labels.ts")
    )) as { WORKSHEET_941_FIELDS: Record<string, { line: string; label: string } | null> };
    expect(mod.WORKSHEET_941_FIELDS.line1Employees).toMatchObject({
      line: "1",
      label:
        "Employees paid in the pay period including the 12th of the quarter's last month (Mar/Jun/Sep/Dec 12)",
    });
  });
});

/**
 * PAY-162 review round 1 (Product Lead decisions D1-D4, reviewer R5):
 * - D1 mark-filed refuses a w2_w3 row while any W-2 of the year is blocked
 *   or its worksheet was never computed.
 * - D2 GET /api/my/w2 carries `ready` per year (no reason codes).
 * - D3 the admin W-2 list carries `formAvailable` for the year.
 * - D4 the tax-filings list tags a w2_w3 row with a blocked W-2.
 * - R5 a year with no bundled official W-2/W-3 form answers 409
 *   form_not_available on every PDF route.
 *
 * Years and fixtures (synthetic, direct-insert runs with exact amounts):
 * 2022 negative Social Security from the first sync (worksheet stays null);
 * 2023 box 4 one cent over the 2023 maximum (160,200.00 x 6.2% = 9,932.40);
 * 2024 consistent figures, no bundled W-2 form; 2025 consistent, bundled.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  company,
  employees,
  payrollEntries,
  payrollRuns,
  seedDatabase,
  type SeedDb,
  taxConfig,
  taxFilings,
} from "@payroll/db";
import { syncAnnualFilings } from "../src/filings/annual.js";
import { snapshotHash, type RunSnapshot } from "../src/payroll/snapshot.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

const TODAY = "2026-09-29";

let t: TestContext;
let ADMIN: Record<string, string>;
let good: { employeeId: number; session: Record<string, string> };
let overMax: { employeeId: number; session: Record<string, string> };

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "review-admin@test.dev", role: "admin" });
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);

  await insertFederalConfig(2022, "147000.00", "12950.00");
  await insertFederalConfig(2023, "160200.00", "13850.00");
  await insertFederalConfig(2024, "168600.00", "14600.00");

  good = await linkedEmployee("review-good@test.dev", "Review Good");
  for (const payDate of ["2024-03-15", "2025-03-15"]) {
    await insertIssuedRun(good.employeeId, payDate, {
      gross_pay: "1000.00",
      federal_withholding: "0.00",
      social_security: "62.00",
      medicare: "14.50",
      employer_futa: "6.00",
    });
  }

  overMax = await linkedEmployee("review-overmax@test.dev", "Review Over Max");
  await insertIssuedRun(overMax.employeeId, "2023-06-15", {
    gross_pay: "170000.00",
    federal_withholding: "0.00",
    social_security: "9932.41",
    medicare: "2465.00",
    employer_futa: "42.00",
  });

  const negativeId = await createEmployee("Review Negative");
  await insertIssuedRun(negativeId, "2022-04-15", {
    gross_pay: "1000.00",
    federal_withholding: "0.00",
    social_security: "-0.01",
    medicare: "14.50",
  });

  await syncAnnualFilings({ db: t.db, config: t.config }, { today: TODAY });
}, 300_000);

afterAll(async () => {
  await t.close();
});

async function insertFederalConfig(year: number, cap: string, standardDeduction: string) {
  await t.db
    .insert(taxConfig)
    .values({
      jurisdiction: "federal",
      taxYear: year,
      standardDeduction,
      socialSecurityRate: "0.06200",
      socialSecurityWageCap: cap,
      medicareRate: "0.01450",
      medicareAdditionalRate: "0.00900",
      medicareAdditionalThreshold: "200000.00",
      stateWithholdingRate: "0",
      employerSocialSecurityRate: "0.06200",
      employerMedicareRate: "0.01450",
      futaRate: "0.00600",
      futaWageCap: "7000.00",
      sutaCreditRate: "0.05400",
    })
    .onConflictDoNothing();
}

async function createEmployee(legalName: string, userId?: string): Promise<number> {
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({
      companyId: companyRows[0]?.id ?? 1,
      legalName,
      hireDate: "2022-01-01",
      ...(userId ? { userId } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("employee insert failed");
  return row.id;
}

async function linkedEmployee(email: string, name: string) {
  const user = await inviteAndOnboard(t, { email, name });
  const employeeId = await createEmployee(name, user.userId);
  const session = sessionHeader((await login(t, email, TEST_PASSWORD)).sessionCookie);
  const consent = await t.app.inject({
    method: "POST",
    url: "/api/my/w2/consent",
    headers: session,
  });
  expect(consent.statusCode, consent.body).toBe(200);
  return { employeeId, session };
}

async function insertIssuedRun(
  employeeId: number,
  payDate: string,
  entries: Record<string, string>,
): Promise<void> {
  const month = payDate.slice(0, 7);
  const periodStart = `${month}-01`;
  const periodEnd = `${month}-28`;
  const snapshot: RunSnapshot = {
    inputs: {
      periodAmount: Number(entries.gross_pay ?? "0"),
      frequency: "monthly",
      periodsPerYear: 12,
      w4: null,
      taxConfig: {
        jurisdiction: "federal",
        taxYear: Number(payDate.slice(0, 4)),
        standardDeduction: 0,
        socialSecurityRate: 0.062,
        socialSecurityWageCap: 0,
        medicareRate: 0.0145,
        medicareAdditionalRate: 0.009,
        medicareAdditionalThreshold: 200000,
        stateWithholdingRate: 0,
        employerSocialSecurityRate: 0.062,
        employerMedicareRate: 0.0145,
        futaRate: 0.006,
        futaWageCap: 7000,
      },
      brackets: [],
      priorYtdGross: 0,
      periodStart,
      periodEnd,
      payDate,
      company: { legalName: "Example Corp" },
      employee: { legalName: "Synthetic", preferredName: null },
    },
    result: {
      grossPay: 0,
      federalWithholding: 0,
      socialSecurity: 0,
      medicare: 0,
      stateWithholding: 0,
      totalDeductions: 0,
      netPay: 0,
      employerSocialSecurity: 0,
      employerMedicare: 0,
      employerFUTA: 0,
      totalEmployerCost: 0,
      ytdGross: 0,
    },
    engineVersion: "test-direct-insert",
    templateVersion: "1.1.0",
  };
  const inserted = await t.db
    .insert(payrollRuns)
    .values({
      employeeId,
      periodStart,
      periodEnd,
      payDate,
      status: "issued",
      runSnapshot: snapshot,
      snapshotHash: snapshotHash(snapshot),
      createdBy: "test",
    })
    .returning();
  const runId = inserted[0]?.id;
  if (!runId) throw new Error("run insert failed");
  await t.db
    .insert(payrollEntries)
    .values(Object.entries(entries).map(([category, amount]) => ({ runId, category, amount })));
}

async function w2w3Row(year: number) {
  const rows = await t.db
    .select()
    .from(taxFilings)
    .where(
      and(eq(taxFilings.formType, "w2_w3"), eq(taxFilings.year, year), eq(taxFilings.quarter, 0)),
    );
  const row = rows[0];
  if (!row) throw new Error(`no w2_w3 row for ${year}`);
  return row;
}

function get(url: string, headers: Record<string, string> = ADMIN) {
  return t.app.inject({ method: "GET", url, headers });
}

describe("D2 employee W-2 list carries ready per year, no reason codes", () => {
  it("ready only when the W-2 is issuable and the year's form is bundled", async () => {
    const res = await get("/api/my/w2", good.session);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      w2s: [
        { year: 2025, availableOn: "2026-01-01", ready: true },
        { year: 2024, availableOn: "2025-01-01", ready: false },
      ],
    });
  });

  it("a blocked W-2 is listed as not ready", async () => {
    const res = await get("/api/my/w2", overMax.session);
    expect(res.json()).toEqual({ w2s: [{ year: 2023, availableOn: "2024-01-01", ready: false }] });
  });
});

describe("D3 admin W-2 list carries formAvailable", () => {
  it("true for a bundled year, false otherwise", async () => {
    const bundled = await get("/api/admin/annual-forms/w2?year=2025");
    expect(bundled.statusCode, bundled.body).toBe(200);
    expect((bundled.json() as { formAvailable: boolean }).formAvailable).toBe(true);
    const missing = await get("/api/admin/annual-forms/w2?year=2024");
    expect((missing.json() as { formAvailable: boolean }).formAvailable).toBe(false);
  });
});

describe("R5 no bundled form -> 409 form_not_available on every PDF route", () => {
  it("admin Copy D, print packet, W-3 and the employee PDF", async () => {
    for (const url of [
      `/api/admin/annual-forms/w2/${good.employeeId}/pdf?year=2024`,
      `/api/admin/annual-forms/w2/${good.employeeId}/print-packet?year=2024`,
      "/api/admin/annual-forms/w3/pdf?year=2024",
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(409);
      expect(res.json(), url).toEqual({ error: "form_not_available", year: 2024 });
    }
    const mine = await get("/api/my/w2/2024/pdf", good.session);
    expect(mine.statusCode).toBe(409);
    // PAY-162 round 2 (S1): the employee gets the bare w2_not_ready body.
    expect(mine.json()).toEqual({ error: "w2_not_ready" });
  });
});

describe("D4 filings list tags a w2_w3 row with a blocked W-2", () => {
  it("w2_blocked issue on 2022 (null worksheet) and 2023; none on 2024", async () => {
    const res = await get("/api/admin/tax-filings?formType=w2_w3");
    expect(res.statusCode, res.body).toBe(200);
    const rows = (res.json() as { filings: Record<string, unknown>[] }).filings;
    const byYear = (year: number) => rows.find((r) => r.year === year);
    for (const year of [2022, 2023]) {
      expect(byYear(year)?.issues, String(year)).toEqual([
        { code: "w2_blocked", severity: "block", year },
      ]);
    }
    expect(byYear(2022)?.worksheet).toBeNull();
    expect(byYear(2023)?.worksheet).not.toBeNull();
    expect(byYear(2024)?.issues).toEqual([]);
  });
});

describe("D1 mark-filed refuses a w2_w3 row while a W-2 is blocked", () => {
  const filedBody = { filedOn: "2026-01-30", filingMethod: "ssa-bso", filingReference: "D1" };

  for (const year of [2022, 2023]) {
    it(`${year}: 409 w2_not_ready, status stays not filed`, async () => {
      const row = await w2w3Row(year);
      const res = await t.app.inject({
        method: "POST",
        url: `/api/admin/tax-filings/${row.id}/file`,
        headers: ADMIN,
        payload: filedBody,
      });
      expect(res.statusCode, res.body).toBe(409);
      expect((res.json() as { error: string }).error).toBe("w2_not_ready");
      const after = await w2w3Row(year);
      expect(after.status).not.toBe("filed");
      expect(after.filedOn).toBeNull();
    });
  }

  it("a year with no blocked W-2 and a computed worksheet can be recorded", async () => {
    const row = await w2w3Row(2024);
    const res = await t.app.inject({
      method: "POST",
      url: `/api/admin/tax-filings/${row.id}/file`,
      headers: ADMIN,
      payload: filedBody,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await w2w3Row(2024)).status).toBe("filed");
  });
});

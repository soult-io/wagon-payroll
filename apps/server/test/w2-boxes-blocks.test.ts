/**
 * PAY-162 auditor-owned scenario tests (payroll-calc-auditor) — fail-closed
 * and blocking paths. All tests here must FAIL on origin/main
 * 1fbd87e40a701e026709726a8a2716df924310d1 (behaviour is new):
 * - T09 missing federal tax_config for a year with issued runs -> 409
 *   `missing_tax_config` on every admin W-2/W-3 surface (P162-D3), list
 *   stays 200. The employee PDF route refuses with exactly
 *   { error: "w2_not_ready" } (Product Lead 2026-09-29: employees never see
 *   reason codes).
 * - T15 a negative box -> `negative_amount` block, boxes null, PDFs 409, W-3
 *   worksheet not refreshed (P162-D2/D5); documents money() is unsigned.
 * - T16 box 4 over the year's maximum -> `box4_over_max` block, PDFs 409,
 *   W-2 notices held until corrected (P162-D7). Runs in 2025, a year with a
 *   bundled fw2 template, so the notice can be sent once corrected.
 * - T16b the "W-2s are ready" notice is also held for a year with no
 *   bundled fw2 template, even when every W-2 is clean (Product Lead
 *   2026-09-29). 2024 has no bundled fw2.
 *
 * Each scenario runs in its own past tax year with its own federal
 * tax_config row (SSA wage bases: 2021 142,800; 2022 147,000; 2023 160,200;
 * 2024 168,600). The runs are direct inserts so exact entry amounts can be
 * set (the pattern annual-forms.test.ts uses for its legacy contractor run).
 * T16 hand figures (2025, seeded config, SSA base 176,100): box 3 =
 * min(180,000.00, 176,100.00) = 176,100.00; box 4 max = 176,100.00 x 6.2%
 * = 10,918.20 (iw2w3 2025 box 4 "should not exceed $10,918.20"); 10,918.21
 * is 1c over and 1c off 6.2% x box 3 (tol ceil(1/2) = 1c: no off-rate
 * warn). Box 6 = 180,000 x 1.45% = 2,610.00 (under $200,000: no Additional
 * Medicare). T16b 2024: 1,000.00 wages, 62.00 SS (6.2%), 14.50 Medicare
 * (1.45%): no issue. Synthetic data only.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import {
  company,
  emailOutbox,
  employees,
  payrollEntries,
  payrollRuns,
  seedDatabase,
  type SeedDb,
  taxConfig,
  taxFilings,
} from "@payroll/db";
import { prepareW2AdminCopyD, type W2Input, w2FieldMap } from "@payroll/documents";
import { sendW2AvailableNotices, syncAnnualFilings } from "../src/filings/annual.js";
import { snapshotHash, type RunSnapshot } from "../src/payroll/snapshot.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

const TODAY = "2026-09-29";

let t: TestContext;
let ADMIN: Record<string, string>;

/** T09: one account-linked employee with runs in 2021 (filed variant) and 2022 (unfiled). */
let t09: { employeeId: number; session: Record<string, string> };
/** T15: negative social_security in 2023. */
let t15EmployeeId: number;
/** T16: box 4 over the 2025 maximum (bundled fw2 year). */
let t16: { employeeId: number; userId: string; session: Record<string, string>; ssEntryId: number };
/** T16b: a clean 2024 W-2 (no bundled fw2 for 2024). */
let t16b: { employeeId: number; userId: string };

const T09_AMOUNTS = ["5432.10", "5432.1", "432.10", "336.79", "78.77", "32.59"];

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "blocks-admin@test.dev", role: "admin" });
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);

  await insertFederalConfig(2021, "142800.00", "12550.00");
  await insertFederalConfig(2022, "147000.00", "12950.00");
  await insertFederalConfig(2023, "160200.00", "13850.00");
  await insertFederalConfig(2024, "168600.00", "14600.00");

  // T09 employee: 2021-03 and 2022-03 runs, consented to electronic W-2s.
  {
    const user = await inviteAndOnboard(t, { email: "blocks-t09@test.dev", name: "Blocks T09" });
    const employeeId = await createEmployee("Blocks T09", user.userId);
    const session = sessionHeader(
      (await login(t, "blocks-t09@test.dev", TEST_PASSWORD)).sessionCookie,
    );
    await consent(session);
    for (const payDate of ["2021-03-15", "2022-03-15"]) {
      await insertIssuedRun(employeeId, payDate, {
        gross_pay: "5432.10",
        federal_withholding: "432.10",
        social_security: "336.79",
        medicare: "78.77",
        employer_futa: "32.59",
      });
    }
    t09 = { employeeId, session };
  }

  // T15 employee: a normal April 2023 run.
  t15EmployeeId = await createEmployee("Blocks T15 Negative");
  await insertIssuedRun(t15EmployeeId, "2023-04-15", {
    gross_pay: "1000.00",
    federal_withholding: "0.00",
    social_security: "62.00",
    medicare: "14.50",
    employer_futa: "6.00",
  });

  // T16 employee: 180,000.00 wages in one 2025 run, box 4 withheld 1c over the max.
  {
    const user = await inviteAndOnboard(t, { email: "blocks-t16@test.dev", name: "Blocks T16" });
    const employeeId = await createEmployee("Blocks T16 Over Max", user.userId);
    const session = sessionHeader(
      (await login(t, "blocks-t16@test.dev", TEST_PASSWORD)).sessionCookie,
    );
    await consent(session);
    const ids = await insertIssuedRun(employeeId, "2025-06-15", {
      gross_pay: "180000.00",
      federal_withholding: "0.00",
      social_security: "10918.21",
      medicare: "2610.00",
      employer_futa: "42.00",
    });
    t16 = { employeeId, userId: user.userId, session, ssEntryId: ids.social_security ?? -1 };
  }

  // T16b employee: a clean 2024 W-2, consented, account-linked.
  {
    const user = await inviteAndOnboard(t, { email: "blocks-t16b@test.dev", name: "Blocks T16b" });
    const employeeId = await createEmployee("Blocks T16b No Form", user.userId);
    const session = sessionHeader(
      (await login(t, "blocks-t16b@test.dev", TEST_PASSWORD)).sessionCookie,
    );
    await consent(session);
    await insertIssuedRun(employeeId, "2024-06-15", {
      gross_pay: "1000.00",
      federal_withholding: "0.00",
      social_security: "62.00",
      medicare: "14.50",
      employer_futa: "6.00",
    });
    t16b = { employeeId, userId: user.userId };
  }

  // Year-closed rows for 2021-2025 (940 + w2_w3), all with config present.
  await syncAnnualFilings({ db: t.db, config: t.config }, { today: TODAY });
}, 300_000);

afterAll(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      hireDate: "2021-01-01",
      ...(userId ? { userId } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("employee insert failed");
  return row.id;
}

async function consent(session: Record<string, string>) {
  const res = await t.app.inject({ method: "POST", url: "/api/my/w2/consent", headers: session });
  expect(res.statusCode, res.body).toBe(200);
}

/** Direct-insert an issued run with exact entry amounts. Returns entry ids by category. */
async function insertIssuedRun(
  employeeId: number,
  payDate: string,
  entries: Record<string, string>,
): Promise<Record<string, number>> {
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
  const rows = await t.db
    .insert(payrollEntries)
    .values(Object.entries(entries).map(([category, amount]) => ({ runId, category, amount })))
    .returning();
  return Object.fromEntries(rows.map((r) => [r.category, r.id]));
}

async function get(url: string, headers: Record<string, string> = ADMIN) {
  return t.app.inject({ method: "GET", url, headers });
}

async function w2w3Row(year: number) {
  const rows = await t.db
    .select()
    .from(taxFilings)
    .where(
      and(eq(taxFilings.formType, "w2_w3"), eq(taxFilings.year, year), eq(taxFilings.quarter, 0)),
    );
  return rows[0];
}

async function f940Row(year: number) {
  const rows = await t.db
    .select()
    .from(taxFilings)
    .where(
      and(eq(taxFilings.formType, "940"), eq(taxFilings.year, year), eq(taxFilings.quarter, 0)),
    );
  return rows[0];
}

/**
 * PAY-206 D12: ISO / Postgres timestamps are removed first — "…T10:15:32.591Z" or
 * "…:32.591Z" (seconds.millis) can contain an amount string such as "32.59"
 * and made T09(c) flaky. No amount is ever written in timestamp form.
 */
const ISO_TS = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
function noAmounts(body: string, amounts: readonly string[]) {
  const text = body.replace(ISO_TS, "<ts>");
  for (const a of amounts) expect(text, `body leaks ${a}`).not.toContain(a);
}

const BOX_FIELDS = [
  "box1Wages",
  "box2FederalWithheld",
  "box3SsWages",
  "box4SsTax",
  "box5MedicareWages",
  "box6MedicareTax",
];

// ---------------------------------------------------------------------------
// T09 — missing tax_config fails closed (P162-D3)
// ---------------------------------------------------------------------------

describe("T09 missing federal tax_config -> 409 missing_tax_config everywhere (fail first)", () => {
  let filed2021Id: number;
  let unfiled2022Id: number;
  let stored2021: { worksheet: unknown; hash: string | null };
  let stored2022: { worksheet: unknown; hash: string | null };

  beforeAll(async () => {
    const r2021 = await w2w3Row(2021);
    const r2022 = await w2w3Row(2022);
    if (!r2021 || !r2022) throw new Error("T09 setup: w2_w3 rows missing");
    // The filed variant is recorded while the config still exists.
    const filed = await t.app.inject({
      method: "POST",
      url: `/api/admin/tax-filings/${r2021.id}/file`,
      headers: ADMIN,
      payload: { filedOn: "2022-01-28", filingMethod: "ssa-bso", filingReference: "T09" },
    });
    expect(filed.statusCode, filed.body).toBe(200);
    filed2021Id = r2021.id;
    unfiled2022Id = r2022.id;
    const a = await w2w3Row(2021);
    const b = await w2w3Row(2022);
    stored2021 = { worksheet: a?.worksheet, hash: a?.worksheetHash ?? null };
    stored2022 = { worksheet: b?.worksheet, hash: b?.worksheetHash ?? null };
    expect(stored2022.hash).toMatch(/^[0-9a-f]{64}$/);
    await t.db
      .delete(taxConfig)
      .where(and(eq(taxConfig.jurisdiction, "federal"), eq(taxConfig.taxYear, 2021)));
    await t.db
      .delete(taxConfig)
      .where(and(eq(taxConfig.jurisdiction, "federal"), eq(taxConfig.taxYear, 2022)));
  });

  for (const year of [2021, 2022]) {
    it(`(a) ${year}: W-2 list and the three admin PDF routes -> 409 { error, year }, no amounts`, async () => {
      for (const url of [
        `/api/admin/annual-forms/w2?year=${year}`,
        `/api/admin/annual-forms/w2/${t09.employeeId}/pdf?year=${year}`,
        `/api/admin/annual-forms/w2/${t09.employeeId}/print-packet?year=${year}`,
        `/api/admin/annual-forms/w3/pdf?year=${year}`,
      ]) {
        const res = await get(url);
        expect(res.statusCode, url).toBe(409);
        expect(res.json(), url).toEqual({ error: "missing_tax_config", year });
        noAmounts(res.body, T09_AMOUNTS);
      }
    });

    it(`(a) ${year}: employee W-2 PDF -> 409 exactly { error: w2_not_ready } (no reason code), no amounts`, async () => {
      const res = await get(`/api/my/w2/${year}/pdf`, t09.session);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "w2_not_ready" });
      noAmounts(res.body, T09_AMOUNTS);
    });
  }

  it("(a) GET /api/admin/tax-filings/:id -> 409 for the filed and the unfiled w2_w3 row", async () => {
    for (const [id, year] of [
      [filed2021Id, 2021],
      [unfiled2022Id, 2022],
    ] as const) {
      const res = await get(`/api/admin/tax-filings/${id}`);
      expect(res.statusCode, String(year)).toBe(409);
      expect(res.json()).toEqual({ error: "missing_tax_config", year });
      noAmounts(res.body, T09_AMOUNTS);
    }
  });

  it("(a) recompute GET/POST on the filed row -> 409 missing_tax_config, nothing written", async () => {
    const preview = await get(`/api/admin/tax-filings/${filed2021Id}/recompute`);
    expect(preview.statusCode).toBe(409);
    expect(preview.json()).toEqual({ error: "missing_tax_config", year: 2021 });
    noAmounts(preview.body, T09_AMOUNTS);
    const commit = await t.app.inject({
      method: "POST",
      url: `/api/admin/tax-filings/${filed2021Id}/recompute`,
      headers: ADMIN,
      payload: { reason: "T09" },
    });
    expect(commit.statusCode).toBe(409);
    expect(commit.json()).toEqual({ error: "missing_tax_config", year: 2021 });
    noAmounts(commit.body, T09_AMOUNTS);
    const row = await w2w3Row(2021);
    expect(row?.worksheetHash).toBe(stored2021.hash);
  });

  it("(a) recompute GET/POST on the unfiled row -> 409, no amounts", async () => {
    const preview = await get(`/api/admin/tax-filings/${unfiled2022Id}/recompute`);
    expect(preview.statusCode).toBe(409);
    noAmounts(preview.body, T09_AMOUNTS);
    const commit = await t.app.inject({
      method: "POST",
      url: `/api/admin/tax-filings/${unfiled2022Id}/recompute`,
      headers: ADMIN,
      payload: { reason: "T09" },
    });
    expect(commit.statusCode).toBe(409);
    noAmounts(commit.body, T09_AMOUNTS);
  });

  it("(b) mark-filed on the unfiled row -> 409 missing_tax_config; status stays not filed", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: `/api/admin/tax-filings/${unfiled2022Id}/file`,
      headers: ADMIN,
      payload: { filedOn: "2023-01-30", filingMethod: "ssa-bso", filingReference: "T09" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "missing_tax_config", year: 2022 });
    const row = await w2w3Row(2022);
    expect(row?.status).not.toBe("filed");
    expect(row?.filedOn ?? null).toBeNull();
  });

  it("(c) GET /api/admin/tax-filings stays 200; affected w2_w3 rows carry worksheet null + the block issue only", async () => {
    const res = await get("/api/admin/tax-filings");
    expect(res.statusCode, res.body).toBe(200);
    const filings = (res.json() as { filings: Record<string, unknown>[] }).filings;
    for (const year of [2021, 2022]) {
      const row = filings.find((f) => f.formType === "w2_w3" && f.year === year);
      expect(row, String(year)).toBeDefined();
      expect(row?.worksheet, String(year)).toBeNull();
      expect(row?.issues, String(year)).toEqual([
        { code: "missing_tax_config", severity: "block", year },
      ]);
    }
    // Other filings of other years are unaffected.
    const ok = filings.find((f) => f.formType === "w2_w3" && f.year === 2024);
    expect(ok?.worksheet).not.toBeNull();
    const t09Rows = filings.filter(
      (f) => f.formType === "w2_w3" && (f.year === 2021 || f.year === 2022),
    );
    noAmounts(JSON.stringify(t09Rows), T09_AMOUNTS);
  });

  it("(d) syncAnnualFilings completes; the 940 still refreshes; the w2_w3 worksheets and hashes are byte-unchanged", async () => {
    // A new issued 2022 run changes both 2022 worksheets' inputs.
    await insertIssuedRun(t09.employeeId, "2022-06-15", {
      gross_pay: "1000.00",
      federal_withholding: "0.00",
      social_security: "62.00",
      medicare: "14.50",
      employer_futa: "6.00",
    });
    const before940 = (await f940Row(2022))?.worksheetHash;
    const result = await syncAnnualFilings({ db: t.db, config: t.config }, { today: TODAY });
    expect(result.refreshed).toBeGreaterThanOrEqual(1);
    expect((await f940Row(2022))?.worksheetHash).not.toBe(before940);
    const a = await w2w3Row(2021);
    const b = await w2w3Row(2022);
    // Precondition: the 2022 row is still unfiled ((b) must not have filed it),
    // so an unchanged hash here means the refresh was skipped, not frozen.
    expect(b?.status).not.toBe("filed");
    expect(a?.worksheet).toEqual(stored2021.worksheet);
    expect(a?.worksheetHash).toBe(stored2021.hash);
    expect(b?.worksheet).toEqual(stored2022.worksheet);
    expect(b?.worksheetHash).toBe(stored2022.hash);
  });
});

// ---------------------------------------------------------------------------
// T15 — negative box (P162-D2, D5)
// ---------------------------------------------------------------------------

describe("T15 negative social_security sum -> negative_amount block (fail first)", () => {
  let storedHash: string | null;
  let storedWorksheet: unknown;

  beforeAll(async () => {
    const row = await w2w3Row(2023);
    storedHash = row?.worksheetHash ?? null;
    storedWorksheet = row?.worksheet;
    expect(storedHash).toMatch(/^[0-9a-f]{64}$/);
    // An adjustment-style run over-refunds Social Security: sum = 62.00 - 62.01 = -0.01.
    await insertIssuedRun(t15EmployeeId, "2023-05-15", {
      gross_pay: "0.00",
      federal_withholding: "0.00",
      social_security: "-62.01",
      medicare: "0.00",
    });
  });

  it("list 200: the row's six boxes are null, exactly one negative_amount block, blocked", async () => {
    const res = await get("/api/admin/annual-forms/w2?year=2023");
    expect(res.statusCode, res.body).toBe(200);
    const row = (res.json() as { w2s: Record<string, unknown>[] }).w2s.find(
      (w) => w.employeeId === t15EmployeeId,
    );
    for (const k of BOX_FIELDS) expect(row?.[k], k).toBeNull();
    expect(row?.issues).toEqual([{ code: "negative_amount", severity: "block" }]);
    expect(row?.blocked).toBe(true);
    noAmounts(res.body, ["-0.01", "62.01", "1000.00"]);
  });

  it("admin W-2 PDFs and the W-3 PDF -> 409 w2_not_ready, no amounts", async () => {
    for (const url of [
      `/api/admin/annual-forms/w2/${t15EmployeeId}/pdf?year=2023`,
      `/api/admin/annual-forms/w2/${t15EmployeeId}/print-packet?year=2023`,
      "/api/admin/annual-forms/w3/pdf?year=2023",
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(409);
      const body = res.json() as { error: string; issues?: string[] };
      expect(body.error, url).toBe("w2_not_ready");
      expect(body.issues ?? ["negative_amount"], url).toContain("negative_amount");
      noAmounts(res.body, ["-0.01", "62.01", "1000.00"]);
    }
  });

  it("sync leaves the stored W-3 worksheet and hash unchanged while the defect exists", async () => {
    await syncAnnualFilings({ db: t.db, config: t.config }, { today: TODAY });
    const row = await w2w3Row(2023);
    expect(row?.worksheetHash).toBe(storedHash);
    expect(row?.worksheet).toEqual(storedWorksheet);
  });

  it("documents money(): W-2 boxes are strings; '-0.01' is rejected with a message that does not echo it", async () => {
    const input = (box4: string) =>
      ({
        taxYear: 2025,
        employer: { legalName: "Example Corp", ein: null, address: null },
        employee: { legalName: "Synthetic Person", ssn: null, address: null },
        controlNumber: "1",
        box1Wages: "1000.00",
        box2FederalWithheld: "0.00",
        box3SsWages: "1000.00",
        box4SsTax: box4,
        box5MedicareWages: "1000.00",
        box6MedicareTax: "14.50",
      }) as unknown as W2Input;
    const doc = await (await import("@payroll/documents")).prepareW2AdminCopyD(input("62.00"));
    const map = w2FieldMap("CopyD");
    expect(doc.getForm().getTextField(map.box4SsTax).getText()).toBe("62.00");
    expect(doc.getForm().getTextField(map.box1Wages).getText()).toBe("1000.00");

    let caught: unknown;
    try {
      await prepareW2AdminCopyD(input("-0.01"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as Error).message).not.toContain("0.01");
  });
});

// ---------------------------------------------------------------------------
// T16 — box 4 over the maximum blocks issuing (P162-D7)
// ---------------------------------------------------------------------------

describe("T16 box4_over_max blocks the W-2, the W-3 PDF and the notices (fail first)", () => {
  // Order-safe: the notices test corrects the entry; every T16 test starts
  // from the blocked state (10,918.21 withheld, 1c over the 2025 maximum).
  beforeEach(async () => {
    await t.db
      .update(payrollEntries)
      .set({ amount: "10918.21" })
      .where(eq(payrollEntries.id, t16.ssEntryId));
  });

  it("list 200: blocked, the single box4_over_max issue, amounts still shown to the admin", async () => {
    const res = await get("/api/admin/annual-forms/w2?year=2025");
    expect(res.statusCode, res.body).toBe(200);
    const row = (res.json() as { w2s: Record<string, unknown>[] }).w2s.find(
      (w) => w.employeeId === t16.employeeId,
    );
    expect(row?.blocked).toBe(true);
    expect(row?.issues).toEqual([{ code: "box4_over_max", severity: "block" }]);
    expect(row?.box3SsWages).toBe("176100.00");
    expect(row?.box4SsTax).toBe("10918.21");
    expect(row?.box6MedicareTax).toBe("2610.00");
  });

  it("admin PDFs 409 { error: w2_not_ready, issues: [box4_over_max] }; employee PDF 409 exactly { error: w2_not_ready }; W-3 PDF 409", async () => {
    for (const url of [
      `/api/admin/annual-forms/w2/${t16.employeeId}/pdf?year=2025`,
      `/api/admin/annual-forms/w2/${t16.employeeId}/print-packet?year=2025`,
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(409);
      expect(res.json(), url).toEqual({ error: "w2_not_ready", issues: ["box4_over_max"] });
    }
    const mine = await get("/api/my/w2/2025/pdf", t16.session);
    expect(mine.statusCode).toBe(409);
    expect(mine.json()).toEqual({ error: "w2_not_ready" });
    const w3 = await get("/api/admin/annual-forms/w3/pdf?year=2025");
    expect(w3.statusCode).toBe(409);
    expect((w3.json() as { error: string }).error).toBe("w2_not_ready");
  });

  it("the W-3 worksheet still refreshes for a box-4 block (figures readable)", async () => {
    // Put a different value in the stored row first, so only a refresh
    // performed while the W-2 is blocked can produce 10918.21.
    const before = await w2w3Row(2025);
    if (!before) throw new Error("2025 w2_w3 row missing");
    await t.db
      .update(taxFilings)
      .set({ worksheet: { stale: true }, worksheetHash: "stale" })
      .where(eq(taxFilings.id, before.id));
    await syncAnnualFilings({ db: t.db, config: t.config }, { today: TODAY });
    const row = await w2w3Row(2025);
    expect((row?.worksheet as Record<string, unknown> | null)?.box4SsTax).toBe("10918.21");
  });

  // One test on purpose: hold -> correct -> send -> not again is a sequence,
  // and "not again" depends on the notified-years record the send writes.
  it("notices: 2025 held while blocked, sent once corrected; 2024 (no bundled fw2) held although clean", async () => {
    const notices = async (userId: string, year: number) =>
      t.db
        .select({ id: emailOutbox.id })
        .from(emailOutbox)
        .where(
          and(eq(emailOutbox.userId, userId), like(emailOutbox.bodyHtml, `%w2-available:${year}%`)),
        );

    // T16b precondition: the 2024 W-2 is clean, so only the missing form can hold it.
    const list2024 = await get("/api/admin/annual-forms/w2?year=2024");
    const row2024 = (list2024.json() as { w2s: Record<string, unknown>[] }).w2s.find(
      (w) => w.employeeId === t16b.employeeId,
    );
    expect(row2024?.issues).toEqual([]);
    expect(row2024?.blocked).toBe(false);

    await sendW2AvailableNotices({ db: t.db, config: t.config }, { today: TODAY });
    expect(await notices(t16.userId, 2025)).toHaveLength(0);
    expect(await notices(t16b.userId, 2024)).toHaveLength(0);

    await t.db
      .update(payrollEntries)
      .set({ amount: "10918.20" })
      .where(eq(payrollEntries.id, t16.ssEntryId));

    await sendW2AvailableNotices({ db: t.db, config: t.config }, { today: TODAY });
    expect(await notices(t16.userId, 2025)).toHaveLength(1);
    expect(await notices(t16b.userId, 2024)).toHaveLength(0);
    const res = await get("/api/admin/annual-forms/w2?year=2025");
    const row = (res.json() as { w2s: Record<string, unknown>[] }).w2s.find(
      (w) => w.employeeId === t16.employeeId,
    );
    expect(row?.issues).toEqual([]);
    expect(row?.blocked).toBe(false);

    // Idempotent: a third pass sends nothing new for either year.
    await sendW2AvailableNotices({ db: t.db, config: t.config }, { today: TODAY });
    expect(await notices(t16.userId, 2025)).toHaveLength(1);
    expect(await notices(t16b.userId, 2024)).toHaveLength(0);
  });
});

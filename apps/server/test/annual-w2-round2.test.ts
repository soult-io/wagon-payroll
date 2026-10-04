/**
 * PAY-162 review round 2 (Product Lead S1-S4, R2, R3, R5; quality S3):
 * - S1 every refusal of the employee W-2 PDF is exactly 409
 *   { error: "w2_not_ready" } — blocked, figures defect, unprintable
 *   amount, missing tax config, no bundled form, no W-2 for the employee.
 * - S3 w3Totals refuses a total that is not a safe integer with the
 *   fixed-message defect error.
 * - S4 with a figures defect armed, the employee list/PDF, the filings
 *   list/detail and mark-filed carry no fixture amount and no ids.
 * - R2 a second mark-filed is refused and writes no second audit row.
 * - R3 a clean year whose W-3 worksheet is null cannot be marked filed.
 * - R5 a filed w2_w3 row is never tagged w2_blocked.
 *
 * Test doubles: `parseCents` (@payroll/shared) fails on the defect
 * employee's gross ("7777.77", unique in the fixture) while armed;
 * `renderW2EmployeePacket` (@payroll/documents) throws the documents
 * W2FormAmountError while armed. Synthetic data only.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  company,
  employees,
  payrollEntries,
  payrollRuns,
  seedDatabase,
  type SeedDb,
  taxConfig,
  taxFilings,
} from "@payroll/db";
import { refreshAnnualWorksheet, syncAnnualFilings } from "../src/filings/annual.js";
import { AnnualFiguresDefectError, w3Totals } from "../src/filings/w2-boxes.js";
import { snapshotHash, type RunSnapshot } from "../src/payroll/snapshot.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

const doubles = vi.hoisted(() => ({ defect: false, badAmount: false, target: "7777.77" }));

vi.mock("@payroll/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@payroll/shared")>();
  return {
    ...actual,
    parseCents: (value: string) =>
      doubles.defect && value === doubles.target
        ? actual.parseCents("x")
        : actual.parseCents(value),
  };
});

vi.mock("@payroll/documents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@payroll/documents")>();
  return {
    ...actual,
    renderW2EmployeePacket: (input: Parameters<typeof actual.renderW2EmployeePacket>[0]) => {
      if (doubles.badAmount) throw new actual.W2FormAmountError();
      return actual.renderW2EmployeePacket(input);
    },
  };
});

const TODAY = "2026-09-29";
/** The defect employee's amounts: never in any checked body. */
const DEFECT_AMOUNTS = ["7777.77", "482.22", "112.78"];
const MONEY_SHAPED = /\d+\.\d{2}(?!\d)/;

let t: TestContext;
let ADMIN: Record<string, string>;
/** 2025 figures defect (armed) — also the S4 leak subject. */
let defect: { employeeId: number; session: Record<string, string> };
/** 2025 clean W-2 — the unprintable-amount double. */
let clean: { employeeId: number; session: Record<string, string> };
/** 2023 box 4 over the maximum. */
let blocked: { employeeId: number; session: Record<string, string> };
/** 2021 without federal tax_config; 2024 clean without a bundled form. */
let other: { employeeId: number; session: Record<string, string> };

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "round2-admin@test.dev", role: "admin" });
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);

  await insertFederalConfig(2023, "160200.00", "13850.00");
  await insertFederalConfig(2024, "168600.00", "14600.00");

  defect = await linkedEmployee("round2-defect@test.dev", "Round2 Defect");
  await insertIssuedRun(defect.employeeId, "2025-05-15", {
    gross_pay: "7777.77",
    federal_withholding: "0.00",
    social_security: "482.22",
    medicare: "112.78",
  });
  clean = await linkedEmployee("round2-clean@test.dev", "Round2 Clean");
  await insertIssuedRun(clean.employeeId, "2025-05-15", consistentRun());

  blocked = await linkedEmployee("round2-blocked@test.dev", "Round2 Blocked");
  await insertIssuedRun(blocked.employeeId, "2023-06-15", {
    gross_pay: "170000.00",
    federal_withholding: "0.00",
    social_security: "9932.41",
    medicare: "2465.00",
  });

  other = await linkedEmployee("round2-other@test.dev", "Round2 Other");
  await insertIssuedRun(other.employeeId, "2021-03-15", consistentRun());
  await insertIssuedRun(other.employeeId, "2024-03-15", consistentRun());

  // Armed before the first sync: the 2025 W-3 worksheet is never computed.
  doubles.defect = true;
  await syncAnnualFilings({ db: t.db, config: t.config }, { today: TODAY });
}, 300_000);

afterAll(async () => {
  doubles.defect = false;
  doubles.badAmount = false;
  await t.close();
});

function consistentRun(): Record<string, string> {
  return {
    gross_pay: "1000.00",
    federal_withholding: "0.00",
    social_security: "62.00",
    medicare: "14.50",
  };
}

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

async function linkedEmployee(email: string, name: string) {
  const user = await inviteAndOnboard(t, { email, name });
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({
      companyId: companyRows[0]?.id ?? 1,
      legalName: name,
      hireDate: "2021-01-01",
      userId: user.userId,
    })
    .returning();
  const employeeId = rows[0]?.id;
  if (!employeeId) throw new Error("employee insert failed");
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
      periodAmount: 0,
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

function markFiled(id: number) {
  return t.app.inject({
    method: "POST",
    url: `/api/admin/tax-filings/${id}/file`,
    headers: ADMIN,
    payload: { filedOn: "2026-01-30", filingMethod: "ssa-bso", filingReference: "R2" },
  });
}

/** No defect amount, no money-shaped string, no id-bearing key or value. */
function expectBare(body: string, ids: number[] = []) {
  for (const a of DEFECT_AMOUNTS) expect(body, `leaks ${a}`).not.toContain(a);
  expect(body).not.toMatch(MONEY_SHAPED);
  expect(body).not.toMatch(/employeeId|"id"/);
  for (const id of ids) expect(body).not.toMatch(new RegExp(`\\b${id}\\b`));
}

describe("S1 every employee PDF refusal is exactly 409 { error: w2_not_ready }", () => {
  const cases: Array<[string, () => { session: Record<string, string> }, number]> = [
    ["blocked (box4_over_max)", () => blocked, 2023],
    ["figures defect (internal_mismatch)", () => defect, 2025],
    ["no bundled W-2 form", () => other, 2024],
    ["no W-2 for the employee in the year", () => other, 2023],
  ];
  for (const [name, who, year] of cases) {
    it(name, async () => {
      const res = await get(`/api/my/w2/${year}/pdf`, who().session);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toEqual({ error: "w2_not_ready" });
    });
  }

  it("missing federal tax config", async () => {
    const res = await get("/api/my/w2/2021/pdf", other.session);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toEqual({ error: "w2_not_ready" });
  });

  it("unprintable amount (documents W2FormAmountError)", async () => {
    doubles.badAmount = true;
    try {
      const res = await get("/api/my/w2/2025/pdf", clean.session);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toEqual({ error: "w2_not_ready" });
    } finally {
      doubles.badAmount = false;
    }
  });
});

describe("S3 w3Totals refuses an unsafe total with the fixed-message defect error", () => {
  it("throws AnnualFiguresDefectError, message carries no value", () => {
    const big = Number.MAX_SAFE_INTEGER;
    const b = {
      box1Cents: big,
      box2Cents: 0,
      box3Cents: 0,
      box4Cents: 0,
      box5Cents: 0,
      box6Cents: 0,
    };
    let caught: unknown;
    try {
      w3Totals([b, b]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AnnualFiguresDefectError);
    expect((caught as Error).message).toBe("annual figures: unreadable amount");
  });
});

describe("S4 figures defect: no amounts or ids in the employee and filing bodies", () => {
  it("GET /api/my/w2 lists the year as not ready, nothing else", async () => {
    const res = await get("/api/my/w2", defect.session);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      w2s: [
        {
          year: 2025,
          availableOn: "2026-01-01",
          ready: false,
          corrected: false,
          downloadable: false,
          formCount: null,
        },
      ],
    });
    expectBare(res.body, [defect.employeeId]);
  });

  it("GET /api/my/w2/2025/pdf", async () => {
    const res = await get("/api/my/w2/2025/pdf", defect.session);
    expect(res.statusCode).toBe(409);
    expectBare(res.body, [defect.employeeId]);
  });

  it("GET /api/admin/tax-filings: the 2025 w2_w3 row carries a code-only issue, no defect amount", async () => {
    const res = await get("/api/admin/tax-filings?year=2025&formType=w2_w3");
    expect(res.statusCode).toBe(200);
    const [row] = (res.json() as { filings: Record<string, unknown>[] }).filings;
    expect(row?.worksheet).toBeNull();
    expect(row?.issues).toEqual([{ code: "w2_blocked", severity: "block", year: 2025 }]);
    for (const a of DEFECT_AMOUNTS) expect(res.body).not.toContain(a);
    expect(res.body).not.toContain("employeeId");
  });

  it("GET /api/admin/tax-filings/:id: no worksheet, no defect amount, no employee ids", async () => {
    const row = await w2w3Row(2025);
    const res = await get(`/api/admin/tax-filings/${row.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { filing: { worksheet: unknown } }).filing.worksheet).toBeNull();
    for (const a of DEFECT_AMOUNTS) expect(res.body).not.toContain(a);
    expect(res.body).not.toContain("employeeId");
  });

  it("POST /api/admin/tax-filings/:id/file -> 409 w2_not_ready, bare body", async () => {
    const row = await w2w3Row(2025);
    const res = await markFiled(row.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "w2_not_ready", issues: ["internal_mismatch"] });
    expectBare(res.body, [row.id, defect.employeeId]);
  });
});

/**
 * A clean W-2 year of its own: federal config, one unlinked employee with a
 * consistent run, synced so the w2_w3 row has a computed worksheet. Each
 * mark-filed test below uses its own year, so no test depends on another's
 * state or on test order.
 */
async function cleanYear(year: number, cap: string) {
  await insertFederalConfig(year, cap, "12000.00");
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({
      companyId: companyRows[0]?.id ?? 1,
      legalName: `Round2 Clean ${year}`,
      hireDate: `${year}-01-01`,
    })
    .returning();
  const employeeId = rows[0]?.id;
  if (!employeeId) throw new Error("employee insert failed");
  await insertIssuedRun(employeeId, `${year}-03-15`, consistentRun());
  await syncAnnualFilings({ db: t.db, config: t.config }, { today: TODAY });
  const row = await w2w3Row(year);
  expect(row.worksheet).not.toBeNull();
  expect(row.status).not.toBe("filed");
  return { employeeId, row };
}

describe("R3 / R2 / R5 mark-filed on a clean year (each test owns its year)", () => {
  it("R3 no blocks but a null worksheet -> 409 worksheet_changed; the worksheet is computed, not filed", async () => {
    const { row } = await cleanYear(2019, "132900.00");
    await t.db
      .update(taxFilings)
      .set({ worksheet: null, worksheetHash: null })
      .where(eq(taxFilings.id, row.id));
    // PAY-193 (G-9): markFiled refreshes under the lock; the stored (null)
    // hash differs from the fresh one, so the null worksheet is never filed.
    const res = await markFiled(row.id);
    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { error: string }).error).toBe("worksheet_changed");
    const after = await w2w3Row(2019);
    expect(after.status).not.toBe("filed");
    expect(after.worksheet).not.toBeNull();
  });

  it("R2 a second mark-filed is refused and writes no second audit row", async () => {
    const { row } = await cleanYear(2022, "147000.00");
    const audits = async () =>
      (
        await t.db
          .select({ id: auditEvents.id })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.action, "tax_filing.file"),
              eq(auditEvents.entityId, String(row.id)),
            ),
          )
      ).length;
    const first = await markFiled(row.id);
    expect(first.statusCode, first.body).toBe(200);
    expect(await audits()).toBe(1);
    const second = await markFiled(row.id);
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: string }).error).toBe("invalid_transition");
    expect(await audits()).toBe(1);
  });

  it("R5 a filed w2_w3 row is not tagged w2_blocked when a W-2 later blocks", async () => {
    const { employeeId, row } = await cleanYear(2020, "137700.00");
    const filed = await markFiled(row.id);
    expect(filed.statusCode, filed.body).toBe(200);
    // A later over-refund makes 2020 Social Security negative.
    await insertIssuedRun(employeeId, "2020-09-15", {
      gross_pay: "0.00",
      federal_withholding: "0.00",
      social_security: "-62.01",
      medicare: "0.00",
    });
    const res = await get("/api/admin/tax-filings?year=2020&formType=w2_w3");
    const [listed] = (res.json() as { filings: Record<string, unknown>[] }).filings;
    expect(listed?.status).toBe("filed");
    expect(listed?.issues).toEqual([]);
  });

  it("a refresh from a stale read never overwrites a worksheet filed since", async () => {
    const { employeeId, row: stale } = await cleanYear(2018, "128400.00");
    // Sequential stand-in for the race: the admin records the filing after
    // the refresh read the row, then new figures arrive for the year.
    const filed = await markFiled(stale.id);
    expect(filed.statusCode, filed.body).toBe(200);
    await insertIssuedRun(employeeId, "2018-06-15", consistentRun());
    expect(await refreshAnnualWorksheet(t.db, stale)).toBe(false);
    const after = await w2w3Row(2018);
    expect(after.status).toBe("filed");
    expect(after.worksheetHash).toBe(stale.worksheetHash);
    expect(after.worksheet).toEqual(stale.worksheet);
  });
});

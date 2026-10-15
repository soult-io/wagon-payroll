/**
 * PAY-248 — the filed-worksheet correction on the W-2/W-3 path.
 *
 * recomputeFiledWorksheet takes FILING_CLOSE_LOCK, then the row lock, then
 * recomputes inside the transaction and compares with expectedWorksheetHash.
 * Covered here for form_type 'w2_w3':
 *   1. a filed W-3 row tampered out-of-band: preview → POST with the
 *      preview's afterHash → 200, stored worksheet = the hand-computed boxes,
 *      one tax_filing.correct_worksheet audit row;
 *   2. the year's figures become uncomputable between preview and commit —
 *      (a) a W-2 is blocked (negative box 4 → negative_amount),
 *      (b) the year's federal tax_config row is missing — → POST 409 and
 *      nothing written (worksheet, hash, audit rows unchanged).
 *
 * Tax year 2025 (seeded federal config, SSA wage base $176,100; 2025 has no
 * W-3 state section). Runs are direct inserts with exact entry amounts (the
 * w2-boxes-blocks.test.ts pattern); every expected box is hand arithmetic.
 *
 * Sources: Pub 15 (2025) SS 6.2% / Medicare 1.45%; 2025 General
 * Instructions for Forms W-2 and W-3: box 1 = wages, box 2 = FIT withheld,
 * box 3 = SS wages up to the wage base, box 4 = SS withheld, box 5 =
 * Medicare wages, box 6 = Medicare withheld; W-3 boxes 1–6 = totals of
 * the W-2s.
 *
 * Independent arithmetic (Python decimal, half-up), synthetic employees:
 *   E1 two runs (2025-05-15, 2025-06-15), gross 3,210.45, FIT 288.00,
 *      SS 3,210.45 × 0.062 = 199.0479 → 199.05,
 *      Med 3,210.45 × 0.0145 = 46.551525 → 46.55
 *   E2 one run (2025-11-14), gross 1,875.30, FIT 61.00,
 *      SS 116.2686 → 116.27, Med 27.19185 → 27.19
 *   W-3: count 2 ; box 1 = 6,420.90 + 1,875.30 = 8,296.20 ;
 *        box 2 = 576.00 + 61.00 = 637.00 ; box 3 = 8,296.20 (both under
 *        176,100) ; box 4 = 398.10 + 116.27 = 514.37 ; box 5 = 8,296.20 ;
 *        box 6 = 93.10 + 27.19 = 120.29.
 * All data is synthetic.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import type { WorksheetW3 } from "../src/filings/annual.js";
import { worksheetHash } from "../src/filings/service.js";
import { snapshotHash, type RunSnapshot } from "../src/payroll/snapshot.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

const YEAR = 2025;
const REASON = "W-3 worksheet corrected to the forms as filed (synthetic test)";

const EXPECTED_W3: WorksheetW3 = {
  form: "w2_w3",
  year: YEAR,
  employeeCount: 2,
  box1Wages: "8296.20",
  box2FederalWithheld: "637.00",
  box3SsWages: "8296.20",
  box4SsTax: "514.37",
  box5MedicareWages: "8296.20",
  box6MedicareTax: "120.29",
};

/** Out-of-band tamper: box 6 digits transposed, box 4 off by a cent. */
const TAMPERED_W3: WorksheetW3 = { ...EXPECTED_W3, box4SsTax: "514.38", box6MedicareTax: "120.92" };

interface Fixture {
  t: TestContext;
  admin: Record<string, string>;
  adminUserId: string;
  filingId: number;
  e2: number;
  tamperedHash: string;
}

async function insertIssuedRun(
  t: TestContext,
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
  const runId = inserted[0]!.id;
  await t.db
    .insert(payrollEntries)
    .values(Object.entries(entries).map(([category, amount]) => ({ runId, category, amount })));
}

async function createEmployee(t: TestContext, legalName: string): Promise<number> {
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({ companyId: companyRows[0]!.id, legalName, hireDate: "2025-01-01" })
    .returning();
  return rows[0]!.id;
}

async function filingRow(t: TestContext, id: number) {
  return (await t.db.select().from(taxFilings).where(eq(taxFilings.id, id)).limit(1))[0];
}

/** Fresh DB → two employees' 2025 runs → W-3 row computed, filed, tampered. */
async function bootFiledW3(tag: string): Promise<Fixture> {
  const t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  const adminUser = await inviteAndOnboard(t, {
    email: `recompute-w3-${tag}@test.dev`,
    role: "admin",
  });
  const admin = sessionHeader((await login(t, adminUser.email, TEST_PASSWORD)).sessionCookie);

  const e1 = await createEmployee(t, "Riley Examplestone");
  const e2 = await createEmployee(t, "Morgan Fixturewell");
  for (const payDate of ["2025-05-15", "2025-06-15"]) {
    await insertIssuedRun(t, e1, payDate, {
      gross_pay: "3210.45",
      federal_withholding: "288.00",
      social_security: "199.05",
      medicare: "46.55",
      employer_futa: "19.26",
    });
  }
  await insertIssuedRun(t, e2, "2025-11-14", {
    gross_pay: "1875.30",
    federal_withholding: "61.00",
    social_security: "116.27",
    medicare: "27.19",
    employer_futa: "11.25",
  });

  const inserted = await t.db
    .insert(taxFilings)
    .values({ formType: "w2_w3", year: YEAR, quarter: 0, dueDate: "2026-02-02", status: "ready" })
    .returning({ id: taxFilings.id });
  const filingId = inserted[0]!.id;

  // Detail read computes the unfiled worksheet; it must match the hand boxes.
  const detail = await t.app.inject({
    method: "GET",
    url: `/api/admin/tax-filings/${filingId}`,
    headers: admin,
  });
  expect(detail.statusCode, detail.body).toBe(200);
  const computed = (await filingRow(t, filingId))!;
  expect(computed.worksheet).toEqual(EXPECTED_W3);
  expect(computed.worksheetHash).toBe(worksheetHash(EXPECTED_W3));

  // Recorded as filed directly (this file tests the correction path, not
  // mark-filed, whose W-2 readiness checks need SSNs/addresses), then the
  // frozen worksheet is tampered out-of-band with its hash.
  const tamperedHash = worksheetHash(TAMPERED_W3);
  await t.db
    .update(taxFilings)
    .set({
      status: "filed",
      filedOn: "2026-01-20",
      filingMethod: "mail",
      filingReference: "SYNTH-W3-2025",
      worksheet: TAMPERED_W3,
      worksheetHash: tamperedHash,
    })
    .where(eq(taxFilings.id, filingId));

  return { t, admin, adminUserId: adminUser.userId, filingId, e2, tamperedHash };
}

async function correctionAudits(f: Fixture) {
  return f.t.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, "tax_filing.correct_worksheet"),
        eq(auditEvents.entityId, String(f.filingId)),
      ),
    );
}

async function preview(f: Fixture) {
  const res = await f.t.app.inject({
    method: "GET",
    url: `/api/admin/tax-filings/${f.filingId}/recompute`,
    headers: f.admin,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as {
    beforeWorksheet: WorksheetW3;
    afterWorksheet: WorksheetW3;
    beforeHash: string | null;
    afterHash: string;
  };
}

function commit(f: Fixture, expectedWorksheetHash: string) {
  return f.t.app.inject({
    method: "POST",
    url: `/api/admin/tax-filings/${f.filingId}/recompute`,
    headers: f.admin,
    payload: { reason: REASON, expectedWorksheetHash },
  });
}

async function expectMetadataUnchanged(f: Fixture) {
  const row = (await filingRow(f.t, f.filingId))!;
  expect(row.status).toBe("filed");
  expect(row.filedOn).toBe("2026-01-20");
  expect(row.filingMethod).toBe("mail");
  expect(row.filingReference).toBe("SYNTH-W3-2025");
}

async function expectUntouched(f: Fixture) {
  const row = (await filingRow(f.t, f.filingId))!;
  expect(row.worksheet).toEqual(TAMPERED_W3);
  expect(row.worksheetHash).toBe(f.tamperedHash);
  await expectMetadataUnchanged(f);
  expect(await correctionAudits(f)).toHaveLength(0);
}

describe("W-3 2025 correction — preview, commit with the preview hash", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await bootFiledW3("ok");
  }, 120_000);
  afterAll(async () => {
    await f.t.close();
  });

  it("W3-1 preview shows the tampered boxes vs the hand-computed boxes; commit stores them with one audit row", async () => {
    const p = await preview(f);
    expect(p.beforeHash).toBe(f.tamperedHash);
    expect(p.beforeWorksheet).toEqual(TAMPERED_W3);
    expect(p.afterWorksheet).toEqual(EXPECTED_W3);
    expect(p.afterHash).toBe(worksheetHash(EXPECTED_W3));

    const res = await commit(f, p.afterHash);
    expect(res.statusCode, res.body).toBe(200);
    const row = (await filingRow(f.t, f.filingId))!;
    expect(row.worksheet).toEqual(EXPECTED_W3);
    expect(row.worksheetHash).toBe(worksheetHash(EXPECTED_W3));
    await expectMetadataUnchanged(f);

    const audits = await correctionAudits(f);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(f.adminUserId);
    expect((audits[0]!.before as { worksheetHash: string }).worksheetHash).toBe(f.tamperedHash);
    const after = audits[0]!.after as { worksheetHash: string; reason: string };
    expect(after.worksheetHash).toBe(p.afterHash);
    expect(after.reason).toBe(REASON);
  });
});

describe("W-3 2025 correction — a W-2 becomes blocked after the preview", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await bootFiledW3("blocked");
  }, 120_000);
  afterAll(async () => {
    await f.t.close();
  });

  it("W3-2a POST → 409 w2_not_ready (negative_amount), nothing written", async () => {
    const p = await preview(f);
    expect(p.afterWorksheet).toEqual(EXPECTED_W3);
    // An adjustment-style run over-refunds E2's Social Security:
    // box 4 = 116.27 − 116.28 = −0.01 → negative_amount block.
    await insertIssuedRun(f.t, f.e2, "2025-12-15", {
      gross_pay: "0.00",
      federal_withholding: "0.00",
      social_security: "-116.28",
      medicare: "0.00",
    });
    const res = await commit(f, p.afterHash);
    expect(res.statusCode, res.body).toBe(409);
    const body = res.json() as { error: string; issues?: string[] };
    expect(body.error).toBe("w2_not_ready");
    expect(body.issues).toContain("negative_amount");
    await expectUntouched(f);
  });
});

describe("W-3 2025 correction — the year's federal tax_config goes missing after the preview", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await bootFiledW3("noconfig");
  }, 120_000);
  afterAll(async () => {
    await f.t.close();
  });

  it("W3-2b POST → 409 missing_tax_config, nothing written", async () => {
    const p = await preview(f);
    expect(p.afterWorksheet).toEqual(EXPECTED_W3);
    await f.t.db
      .delete(taxConfig)
      .where(and(eq(taxConfig.jurisdiction, "federal"), eq(taxConfig.taxYear, YEAR)));
    const res = await commit(f, p.afterHash);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toEqual({ error: "missing_tax_config", year: YEAR });
    await expectUntouched(f);
  });
});

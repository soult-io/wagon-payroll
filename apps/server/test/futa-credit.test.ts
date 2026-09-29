/**
 * PAY-18 integration tests — configurable SUTA credit on the Form 940
 * worksheet. Real SQL via the PGlite harness; config changes go through the
 * admin PUT /api/admin/tax-config route (the established tax-table edit
 * pattern, audited), runs through the generate/approve/issue flow.
 *
 * Fixture: two W-2 employees at $8,000/mo with January runs in four years —
 * 2025 (seeded default 5.4% credit), 2027 (0% credit — no SUTA paid, the
 * SOULT IO pattern), 2028 (5.1% partial credit — the credit-reduction-state
 * shape). Each year's credit is set BEFORE that year's runs issue, so the
 * per-paycheck accrual and the worksheet always reconcile to the cent.
 *
 * Covers: default/zero/partial credit arithmetic ($42/$420/$63 per employee),
 * per-year isolation, the futa_rate mirror written by the PUT route, the
 * $500 deposit-threshold branches, the rate assumption recorded on the
 * worksheet JSON, W-2 figures and the export API provably unaffected by a
 * credit change (FUTA is employer-side), and 940-relevant audit output.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  company,
  compensation,
  employees,
  payrollRuns,
  seedDatabase,
  taxConfig,
  type SeedDb,
} from "@payroll/db";
import { TAX_CONFIG } from "@payroll/engine";
import { compute940Worksheet, w2FiguresForYear } from "../src/filings/annual.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

const EXPORT_TOKEN = "test-export-token-futa-credit";

let t: TestContext;
let ADMIN: Record<string, string>;
let adminUserId: string;
const employeeIds: number[] = [];

/** Full scalar config for a year, derived from the vendored 2026 constants. */
function scalarConfig(sutaCreditRate: number) {
  return {
    standardDeduction: TAX_CONFIG.standardDeduction,
    socialSecurityRate: TAX_CONFIG.socialSecurityRate,
    socialSecurityWageCap: TAX_CONFIG.socialSecurityWageCap,
    medicareRate: TAX_CONFIG.medicareRate,
    medicareAdditionalRate: TAX_CONFIG.medicareAdditionalRate,
    medicareAdditionalThreshold: TAX_CONFIG.medicareAdditionalThreshold,
    stateWithholdingRate: 0,
    employerSocialSecurityRate: TAX_CONFIG.employerSocialSecurityRate,
    employerMedicareRate: TAX_CONFIG.employerMedicareRate,
    sutaCreditRate,
    futaWageCap: TAX_CONFIG.futaWageCap,
  };
}

/** Zero-withholding brackets keep the fixture arithmetic FUTA-only. */
const ZERO_BRACKET = [{ ordinal: 1, minAmount: 0, maxAmount: null, rate: 0 }];

async function putTaxConfig(taxYear: number, sutaCreditRate: number) {
  return t.app.inject({
    method: "PUT",
    url: "/api/admin/tax-config",
    headers: ADMIN,
    payload: {
      jurisdiction: "federal",
      taxYear,
      config: scalarConfig(sutaCreditRate),
      brackets: ZERO_BRACKET,
    },
  });
}

/** Generate → approve → issue a January run per fixture employee. */
async function issueJanuaryRuns(year: number) {
  for (const employeeId of employeeIds) {
    const gen = await t.app.inject({
      method: "POST",
      url: "/api/admin/payroll-runs/generate",
      headers: ADMIN,
      payload: { year, month: 1, employeeId },
    });
    expect(gen.statusCode, gen.body).toBe(201);
    const run = (gen.json() as { generated: (typeof payrollRuns.$inferSelect)[] }).generated[0];
    if (!run) throw new Error(`no run generated: ${gen.body}`);
    for (const action of ["approve", "issue"] as const) {
      const res = await t.app.inject({
        method: "POST",
        url: `/api/admin/payroll-runs/${run.publicId}/${action}`,
        headers: ADMIN,
        payload: {},
      });
      expect(res.statusCode, res.body).toBe(200);
    }
  }
}

async function exportRuns(from: string, to: string): Promise<string> {
  const res = await t.app.inject({
    method: "GET",
    url: `/api/export/payroll-runs?from=${from}&to=${to}`,
    headers: { authorization: `Bearer ${EXPORT_TOKEN}` },
  });
  expect(res.statusCode, res.body).toBe(200);
  return JSON.stringify(res.json());
}

// History runs paid in 2025 are issued "in" late 2025: issuing a past pay
// date in another calendar year is refused (Spec 26 (PAY-173) D9).
const ISSUE_CLOCK = () => new Date("2025-12-31T12:00:00Z");

beforeAll(async () => {
  t = await createTestApp({ exportToken: EXPORT_TOKEN }, { clock: ISSUE_CLOCK });
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "futa-admin@test.dev", role: "admin" });
  adminUserId = admin.userId;
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);

  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  for (const name of ["Futa One", "Futa Two"]) {
    const rows = await t.db
      .insert(employees)
      .values({ companyId: companyRows[0]?.id ?? 1, legalName: name, hireDate: "2025-01-01" })
      .returning();
    const id = rows[0]?.id;
    if (!id) throw new Error("employee insert failed");
    employeeIds.push(id);
    await t.db.insert(compensation).values({
      employeeId: id,
      periodAmount: "8000",
      frequency: "monthly",
      effectiveFrom: "2025-01-01",
      effectiveTo: null,
    });
  }

  // 2025: seeded default (5.4% credit). 2027: 0% credit. 2028: 5.1% credit.
  // Each year's credit is configured BEFORE that year's runs issue.
  await issueJanuaryRuns(2025);
  expect((await putTaxConfig(2027, 0)).statusCode).toBe(200);
  await issueJanuaryRuns(2027);
  expect((await putTaxConfig(2028, 0.051)).statusCode).toBe(200);
  await issueJanuaryRuns(2028);
}, 120_000);

afterAll(async () => {
  await t.close();
});

describe("940 worksheet — configured SUTA credit", () => {
  it("default full credit (5.4%) → 0.6% net, $42 per employee", async () => {
    const w = await compute940Worksheet(t.db, 2025);
    expect(w.sutaCreditRate).toBe("0.054");
    expect(w.futaRate).toBe("0.006");
    expect(w.line7FutaTaxableWages).toBe("14000.00"); // 2 × $7,000 cap
    expect(w.line8FutaTax).toBe("84.00"); // 2 × $42
    expect(w.line12TotalFutaTax).toBe("84.00");
    expect(w.futaTaxPerFrozenEntries).toBe("84.00"); // reconciles to the cent
    expect(w.roundingDelta).toBe("0.00");
    expect(w.depositThresholdCrossedQuarter).toBeNull(); // $84 ≤ $500
    expect(w.depositDueBy).toBeNull();
  });

  it("zero credit → 6.0% net, $420 per employee (the actually-filed 940 shape)", async () => {
    const w = await compute940Worksheet(t.db, 2027);
    expect(w.sutaCreditRate).toBe("0");
    expect(w.futaRate).toBe("0.06");
    expect(w.line7FutaTaxableWages).toBe("14000.00");
    expect(w.line8FutaTax).toBe("840.00"); // 2 × $420
    expect(w.futaTaxPerFrozenEntries).toBe("840.00"); // accrual used the same rate
    expect(w.roundingDelta).toBe("0.00");
    // $840 crosses the $500 deposit threshold in Q1.
    expect(w.depositThresholdCrossedQuarter).toBe(1);
    expect(w.depositDueBy).toBe("2027-04-30");
    expect(w.balanceDue).toBe("840.00");
  });

  it("partial credit (5.1%, credit-reduction shape) → 0.9% net, $63 per employee", async () => {
    const w = await compute940Worksheet(t.db, 2028);
    expect(w.sutaCreditRate).toBe("0.051");
    expect(w.futaRate).toBe("0.009");
    expect(w.line8FutaTax).toBe("126.00"); // 2 × $63
    expect(w.futaTaxPerFrozenEntries).toBe("126.00");
    expect(w.roundingDelta).toBe("0.00");
    expect(w.depositThresholdCrossedQuarter).toBeNull();
  });

  it("isolates the rate per year — changing 2027/2028 never touches 2025", async () => {
    const w2025 = await compute940Worksheet(t.db, 2025);
    const w2027 = await compute940Worksheet(t.db, 2027);
    expect(w2025.futaRate).toBe("0.006");
    expect(w2025.line8FutaTax).toBe("84.00");
    expect(w2027.futaRate).toBe("0.06");
    expect(w2027.line8FutaTax).toBe("840.00");

    const configs = await t.db
      .select()
      .from(taxConfig)
      .where(eq(taxConfig.jurisdiction, "federal"));
    const byYear = new Map(configs.map((c) => [c.taxYear, c]));
    expect(byYear.get(2025)?.sutaCreditRate).toBe("0.05400");
    expect(byYear.get(2027)?.sutaCreditRate).toBe("0.00000");
    expect(byYear.get(2028)?.sutaCreditRate).toBe("0.05100");
  });
});

describe("PUT /api/admin/tax-config — credit is the input, futa_rate is derived", () => {
  it("mirrors the net rate into futa_rate and audits the change", async () => {
    const row = (
      await t.db
        .select()
        .from(taxConfig)
        .where(and(eq(taxConfig.jurisdiction, "federal"), eq(taxConfig.taxYear, 2027)))
    )[0];
    expect(row?.sutaCreditRate).toBe("0.00000");
    expect(row?.futaRate).toBe("0.06000"); // 6.0% − 0 credit, mirrored for accrual

    const row2028 = (
      await t.db
        .select()
        .from(taxConfig)
        .where(and(eq(taxConfig.jurisdiction, "federal"), eq(taxConfig.taxYear, 2028)))
    )[0];
    expect(row2028?.futaRate).toBe("0.00900");

    const audits = await t.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, "tax_config.upsert"), eq(auditEvents.entityId, "federal:2027")),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0]?.actorId).toBe(adminUserId);
  });

  it("rejects a credit above the statutory rate", async () => {
    const res = await putTaxConfig(2029, 0.07);
    expect(res.statusCode).toBe(400);
  });
});

describe("FUTA is employer-side — W-2s and exports are unaffected", () => {
  it("W-2 figures and the export payload are identical across a credit change", async () => {
    const figuresBefore = await w2FiguresForYear(t.db, 2027);
    const exportBefore = await exportRuns("2027-01-01", "2027-12-31");

    // Flip 2027 to a partial credit, then flip back to zero.
    expect((await putTaxConfig(2027, 0.03)).statusCode).toBe(200);
    expect((await putTaxConfig(2027, 0)).statusCode).toBe(200);

    const figuresAfter = await w2FiguresForYear(t.db, 2027);
    const exportAfter = await exportRuns("2027-01-01", "2027-12-31");
    expect(figuresAfter).toEqual(figuresBefore);
    expect(exportAfter).toBe(exportBefore);

    // And the worksheet still reflects the restored zero credit.
    const w = await compute940Worksheet(t.db, 2027);
    expect(w.line8FutaTax).toBe("840.00");
  });
});

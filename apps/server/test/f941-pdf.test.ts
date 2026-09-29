/**
 * PAY-16 integration tests — the filled official Form 941 PDF, rendered on
 * demand from a filing's frozen quarterly worksheet snapshot. Real SQL via
 * the PGlite harness; the route goes through app.inject with real sessions;
 * the renderer is exercised both against the real fixture worksheet and
 * against synthetic inputs (de minimis / no-balance branches, both bundled
 * revisions).
 *
 * Fixture: one $8,000/mo W-2 employee with issued January–March 2025 runs,
 * the company EIN/address on file, and the 2025 Q1 941 filing row (worksheet
 * computed via the detail read). Q1 liability is far above $2,500 → the
 * monthly-schedule line-16 branch; no deposits → a balance due → the 941-V
 * voucher is filled.
 *
 * Covers: input assembly (worksheet figures + decrypted EIN + address),
 * line-for-line AcroForm placement (split dollars/cents boxes), quarter
 * checkboxes on both pages, line-16 monthly vs de minimis, the voucher
 * filled only with a balance due, Part 5 signature area provably blank
 * (wet-sign journey), byte-stability across renders, flattened 3-page
 * output, both bundled template revisions + checksums, the route (content
 * type, filename, RBAC, non-941 400, unknown 404).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  company,
  compensation,
  employees,
  type payrollRuns,
  seedDatabase,
  taxFilings,
  type SeedDb,
} from "@payroll/db";
import {
  f941FieldMap,
  type F941Input,
  type MoneyField,
  pdfStructure,
  prepareF941,
  renderF941Pdf,
  splitEin,
  splitMoneyPair,
  templateBytes,
} from "@payroll/documents";
import { encryptField } from "../src/crypto/field-encryption.js";
import { f941PdfInputFor } from "../src/filings/form-941-pdf.js";
import { worksheetHash, type Worksheet941 } from "../src/filings/service.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

let t: TestContext;
let ADMIN: Record<string, string>;
let EMPLOYEE: Record<string, string>;
let filingId: number;
let worksheet: Worksheet941;

const EMPLOYER = {
  legalName: "Example Corp",
  ein: "12-3456789",
  address: { line1: "100 Main St", city: "Austin", state: "TX", zip: "78701", country: "US" },
};

/** Synthetic worksheet-shaped input for branch coverage. */
function syntheticInput(overrides: Partial<F941Input> = {}): F941Input {
  return {
    taxYear: 2025,
    quarter: 1,
    employer: { legalName: EMPLOYER.legalName, ein: EMPLOYER.ein, address: EMPLOYER.address },
    line1Employees: 1,
    line2Wages: "24000.00",
    line3FederalWithheld: "1200.00",
    line5aTaxableSsWages: "24000.00",
    line5aTax: "2976.00",
    line5cTaxableMedicareWages: "24000.00",
    line5cTax: "696.00",
    line5dAdditionalMedicare: "0.00",
    line5eTotal: "3672.00",
    line6TotalTaxes: "4872.00",
    line7FractionsOfCents: "-0.02",
    line10TotalAfterAdjustments: "4871.98",
    line11ResearchCredit: "0.00",
    line12TotalAfterCredits: "4871.98",
    line13Deposits: "0.00",
    line14BalanceDue: "4871.98",
    line15Overpayment: "0.00",
    line16: { month1: "1624.00", month2: "1624.00", month3: "1623.98", deMinimis: false },
    ...overrides,
  };
}

function textOf(doc: Awaited<ReturnType<typeof prepareF941>>, name: string) {
  return doc.getForm().getTextField(name).getText() ?? null;
}

function expectMoney(
  doc: Awaited<ReturnType<typeof prepareF941>>,
  field: MoneyField,
  value: string,
) {
  const { dollars, cents } = splitMoneyPair(value);
  expect(textOf(doc, field.dollars)).toBe(dollars);
  expect(textOf(doc, field.cents)).toBe(cents);
}

// History runs paid in 2025 are issued "in" late 2025: issuing a past pay
// date in another calendar year is refused (Spec 26 (PAY-173) D9).
const ISSUE_CLOCK = () => new Date("2025-12-31T12:00:00Z");

beforeAll(async () => {
  t = await createTestApp({}, { clock: ISSUE_CLOCK });
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "f941-admin@test.dev", role: "admin" });
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);
  const employee = await inviteAndOnboard(t, { email: "f941-emp@test.dev", role: "employee" });
  EMPLOYEE = sessionHeader((await login(t, employee.email, TEST_PASSWORD)).sessionCookie);

  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const companyId = companyRows[0]?.id ?? 1;
  await t.db
    .update(company)
    .set({
      ein: encryptField(EMPLOYER.ein, t.config.encryptionKey),
      address: EMPLOYER.address,
    })
    .where(eq(company.id, companyId));

  const inserted = await t.db
    .insert(employees)
    .values({ companyId, legalName: "F941 One", hireDate: "2025-01-01" })
    .returning();
  const employeeId = inserted[0]?.id;
  if (!employeeId) throw new Error("employee insert failed");
  await t.db.insert(compensation).values({
    employeeId,
    periodAmount: "8000",
    frequency: "monthly",
    effectiveFrom: "2025-01-01",
    effectiveTo: null,
  });

  // January–March 2025 runs → the Q1 941 worksheet.
  for (const month of [1, 2, 3]) {
    const gen = await t.app.inject({
      method: "POST",
      url: "/api/admin/payroll-runs/generate",
      headers: ADMIN,
      payload: { year: 2025, month, employeeId },
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

  const filing = await t.db
    .insert(taxFilings)
    .values({ formType: "941", year: 2025, quarter: 1, dueDate: "2025-04-30", status: "ready" })
    .returning({ id: taxFilings.id });
  filingId = filing[0]?.id ?? -1;

  // The detail read computes + freezes the unfiled worksheet.
  const detail = await t.app.inject({
    method: "GET",
    url: `/api/admin/tax-filings/${filingId}`,
    headers: ADMIN,
  });
  expect(detail.statusCode, detail.body).toBe(200);
  const row = (await t.db.select().from(taxFilings).where(eq(taxFilings.id, filingId)).limit(1))[0];
  worksheet = row?.worksheet as Worksheet941;
  expect(worksheet.line16.deMinimis).toBe(false); // Q1 liability > $2,500
  expect(Number(worksheet.line14BalanceDue)).toBeGreaterThan(0); // no deposits
}, 120_000);

afterAll(async () => {
  await t.close();
});

describe("input assembly — worksheet figures + company header", () => {
  it("mirrors the stored worksheet and decrypts the EIN at render time", async () => {
    const input = await f941PdfInputFor({ db: t.db, config: t.config }, filingId);
    expect(input.taxYear).toBe(2025);
    expect(input.quarter).toBe(1);
    expect(input.employer.legalName).toBe("Example Corp");
    expect(input.employer.ein).toBe("12-3456789");
    expect(input.employer.address?.city).toBe("Austin");
    // Every figure comes straight from the stored snapshot (hash-linked).
    expect(input.line2Wages).toBe(worksheet.line2Wages);
    expect(input.line12TotalAfterCredits).toBe(worksheet.line12TotalAfterCredits);
    expect(input.line16).toEqual(worksheet.line16);
    const row = (
      await t.db.select().from(taxFilings).where(eq(taxFilings.id, filingId)).limit(1)
    )[0];
    expect(row?.worksheetHash).toBe(worksheetHash(worksheet));
  });

  it("rejects non-941 filings", async () => {
    const other = await t.db
      .insert(taxFilings)
      .values({ formType: "940", year: 2025, quarter: 0, dueDate: "2026-02-02" })
      .returning({ id: taxFilings.id });
    await expect(
      f941PdfInputFor({ db: t.db, config: t.config }, other[0]?.id ?? -1),
    ).rejects.toThrow("not a Form 941 filing");
  });
});

describe("AcroForm placement — the worksheet, line for line", () => {
  it("fills every computed line into the exact 2025-revision fields", async () => {
    const input = await f941PdfInputFor({ db: t.db, config: t.config }, filingId);
    const doc = await prepareF941(input);
    const map = f941FieldMap(2025);

    // Entity area — EIN split across the two boxes, name + address.
    expect(textOf(doc, map.einFirst2)).toBe("12");
    expect(textOf(doc, map.einLast7)).toBe("3456789");
    expect(textOf(doc, map.legalName)).toBe("Example Corp");
    expect(textOf(doc, map.street)).toBe("100 Main St");
    expect(textOf(doc, map.city)).toBe("Austin");
    expect(textOf(doc, map.state)).toBe("TX");
    expect(textOf(doc, map.zip)).toBe("78701");
    const quarterChecks = map.quarterCheckboxes.map((n) =>
      doc.getForm().getCheckBox(n).isChecked(),
    );
    expect(quarterChecks).toEqual([true, false, false, false]); // Q1

    // Part 1 — to the cent, IRS dollars/cents split.
    expect(textOf(doc, map.line1Employees)).toBe(String(worksheet.line1Employees));
    expectMoney(doc, map.line2Wages, worksheet.line2Wages);
    expectMoney(doc, map.line3FederalWithheld, worksheet.line3FederalWithheld);
    expect(doc.getForm().getCheckBox(map.line4Checkbox).isChecked()).toBe(false);
    expectMoney(doc, map.line5aWages, worksheet.line5aTaxableSsWages);
    expectMoney(doc, map.line5aTax, worksheet.line5aTax);
    expectMoney(doc, map.line5cWages, worksheet.line5cTaxableMedicareWages);
    expectMoney(doc, map.line5cTax, worksheet.line5cTax);
    expectMoney(doc, map.line5dTax, worksheet.line5dAdditionalMedicare);
    expectMoney(doc, map.line5eTotal, worksheet.line5eTotal);
    expectMoney(doc, map.line6TotalTaxes, worksheet.line6TotalTaxes);
    expectMoney(doc, map.line7FractionsOfCents, worksheet.line7FractionsOfCents);
    expectMoney(doc, map.line10TotalAfterAdjustments, worksheet.line10TotalAfterAdjustments);
    expectMoney(doc, map.line11ResearchCredit, worksheet.line11ResearchCredit);
    expectMoney(doc, map.line12TotalAfterCredits, worksheet.line12TotalAfterCredits);
    expectMoney(doc, map.line13Deposits, worksheet.line13Deposits);
    expectMoney(doc, map.line14BalanceDue, worksheet.line14BalanceDue);
    expectMoney(doc, map.line15Overpayment, worksheet.line15Overpayment);

    // Lines the worksheet does not carry stay blank.
    for (const blank of [
      map.line5bTips,
      map.line5bTax,
      map.line5dWages,
      map.line5f3121q,
      map.line8SickPay,
      map.line9TipsGtl,
    ]) {
      expect(textOf(doc, blank.dollars)).toBeNull();
      expect(textOf(doc, blank.cents)).toBeNull();
    }
    // The overpayment election is made at signing time — never pre-checked.
    expect(doc.getForm().getCheckBox(map.overpaymentApplyToNext).isChecked()).toBe(false);
    expect(doc.getForm().getCheckBox(map.overpaymentSendRefund).isChecked()).toBe(false);

    // Page 2 header + line 16 monthly schedule (liability > $2,500).
    expect(textOf(doc, map.page2Name)).toBe("Example Corp");
    expect(textOf(doc, map.page2EinFirst2)).toBe("12");
    expect(textOf(doc, map.page2EinLast7)).toBe("3456789");
    expect(doc.getForm().getCheckBox(map.line16DeMinimis).isChecked()).toBe(false);
    expect(doc.getForm().getCheckBox(map.line16Monthly).isChecked()).toBe(true);
    expect(doc.getForm().getCheckBox(map.line16Semiweekly).isChecked()).toBe(false);
    expectMoney(doc, map.line16Month1, worksheet.line16.month1);
    expectMoney(doc, map.line16Month2, worksheet.line16.month2);
    expectMoney(doc, map.line16Month3, worksheet.line16.month3);
    const total = (
      Number(worksheet.line16.month1) +
      Number(worksheet.line16.month2) +
      Number(worksheet.line16.month3)
    ).toFixed(2);
    expectMoney(doc, map.line16Total, total);

    // Page 3 — 941-V voucher filled (balance due).
    expect(textOf(doc, map.voucherEinFirst2)).toBe("12");
    expect(textOf(doc, map.voucherEinLast7)).toBe("3456789");
    expectMoney(doc, map.voucherAmount, worksheet.line14BalanceDue);
    const voucherQuarter = map.voucherQuarterCheckboxes.map((n) =>
      doc.getForm().getCheckBox(n).isChecked(),
    );
    expect(voucherQuarter).toEqual([true, false, false, false]);
    expect(textOf(doc, map.voucherName)).toBe("Example Corp");
    expect(textOf(doc, map.voucherStreet)).toBe("100 Main St");
    expect(textOf(doc, map.voucherCityStateZip)).toBe("Austin, TX 78701");

    // Part 5 signature journey: print name/title/phone stay blank (the
    // signature/date boxes are not AcroForm fields at all — wet signature).
    const P2 = "topmostSubform[0].Page2[0]";
    expect(textOf(doc, `${P2}.f2_13[0]`)).toBeNull(); // print your name
    expect(textOf(doc, `${P2}.f2_14[0]`)).toBeNull(); // print your title
    expect(textOf(doc, `${P2}.f2_15[0]`)).toBeNull(); // best daytime phone
  });

  it("checks the de minimis line-16 branch without the monthly breakdown", async () => {
    const doc = await prepareF941(
      syntheticInput({
        line16: { month1: "0.00", month2: "0.00", month3: "0.00", deMinimis: true },
      }),
    );
    const map = f941FieldMap(2025);
    expect(doc.getForm().getCheckBox(map.line16DeMinimis).isChecked()).toBe(true);
    expect(doc.getForm().getCheckBox(map.line16Monthly).isChecked()).toBe(false);
    expect(textOf(doc, map.line16Month1.dollars)).toBeNull();
    expect(textOf(doc, map.line16Total.dollars)).toBeNull();
  });

  it("leaves the voucher blank when no balance is due", async () => {
    const doc = await prepareF941(syntheticInput({ line14BalanceDue: "0.00" }));
    const map = f941FieldMap(2025);
    expect(textOf(doc, map.voucherAmount.dollars)).toBeNull();
    expect(textOf(doc, map.voucherName)).toBeNull();
    expect(doc.getForm().getCheckBox(map.voucherQuarterCheckboxes[0]).isChecked()).toBe(false);
  });

  it("fills the 2026 revision (Q3, renumbered checkboxes + voucher fields)", async () => {
    const doc = await prepareF941(syntheticInput({ taxYear: 2026, quarter: 3 }));
    const map = f941FieldMap(2026);
    const quarterChecks = map.quarterCheckboxes.map((n) =>
      doc.getForm().getCheckBox(n).isChecked(),
    );
    expect(quarterChecks).toEqual([false, false, true, false]); // Q3
    expect(textOf(doc, map.einFirst2)).toBe("12");
    expectMoney(doc, map.line12TotalAfterCredits, "4871.98");
    expectMoney(doc, map.voucherAmount, "4871.98");
    const voucherQuarter = map.voucherQuarterCheckboxes.map((n) =>
      doc.getForm().getCheckBox(n).isChecked(),
    );
    expect(voucherQuarter).toEqual([false, false, true, false]);
  });
});

describe("rendering — flattened, byte-stable, template-pinned", () => {
  it("renders a flattened 3-page PDF (941 pages 1–2 + 941-V voucher)", async () => {
    const pdf = await renderF941Pdf(syntheticInput());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(await pdfStructure(pdf)).toEqual({ pageCount: 3, fieldCount: 0 });
  });

  it("is byte-identical across renders of the same worksheet", async () => {
    const input = await f941PdfInputFor({ db: t.db, config: t.config }, filingId);
    const a = await renderF941Pdf(input);
    const b = await renderF941Pdf(input);
    expect(a.equals(b)).toBe(true);
  });

  it("loads both bundled revisions by checksum and rejects unbundled years", () => {
    expect(templateBytes(2025, "f941").subarray(0, 5).toString()).toBe("%PDF-");
    expect(templateBytes(2026, "f941").subarray(0, 5).toString()).toBe("%PDF-");
    expect(() => templateBytes(2024, "f941")).toThrow("no bundled IRS f941 template");
  });
});

describe("formatting helpers", () => {
  it("splits money into the dollars/cents boxes, negatives on the dollars box", () => {
    expect(splitMoneyPair("1234.56")).toEqual({ dollars: "1234", cents: "56" });
    expect(splitMoneyPair("0.00")).toEqual({ dollars: "0", cents: "00" });
    expect(splitMoneyPair("-0.02")).toEqual({ dollars: "-0", cents: "02" });
    expect(splitMoneyPair("42")).toEqual({ dollars: "42", cents: "00" });
  });

  it("splits the EIN across the two boxes, formatted or plain", () => {
    expect(splitEin("12-3456789")).toEqual({ first2: "12", last7: "3456789" });
    expect(splitEin("123456789")).toEqual({ first2: "12", last7: "3456789" });
  });
});

describe("GET /api/admin/tax-filings/:id/941-pdf", () => {
  it("serves the filled PDF inline with a per-quarter filename", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-filings/${filingId}/941-pdf`,
      headers: ADMIN,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain("f941-2025-q1.pdf");
    expect(await pdfStructure(res.rawPayload)).toEqual({ pageCount: 3, fieldCount: 0 });
  });

  it("is admin-only", async () => {
    const asEmployee = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-filings/${filingId}/941-pdf`,
      headers: EMPLOYEE,
    });
    expect(asEmployee.statusCode).toBe(403);
    const anon = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-filings/${filingId}/941-pdf`,
    });
    expect(anon.statusCode).toBe(401);
  });

  it("400s non-941 filings and 404s unknown filings", async () => {
    const other = await t.db
      .select({ id: taxFilings.id })
      .from(taxFilings)
      .where(eq(taxFilings.formType, "940"))
      .limit(1);
    const not941 = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-filings/${other[0]?.id ?? -1}/941-pdf`,
      headers: ADMIN,
    });
    expect(not941.statusCode).toBe(400);
    const missing = await t.app.inject({
      method: "GET",
      url: "/api/admin/tax-filings/999999/941-pdf",
      headers: ADMIN,
    });
    expect(missing.statusCode).toBe(404);
  });
});

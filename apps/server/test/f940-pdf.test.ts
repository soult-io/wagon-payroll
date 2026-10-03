/**
 * PAY-33 integration tests — the filled official Form 940 PDF, rendered on
 * demand from a filing's frozen annual FUTA worksheet snapshot. Real SQL
 * via the PGlite harness; the route goes through app.inject with real
 * sessions; the renderer is exercised against the real fixture worksheet
 * (full SUTA credit branch) and synthetic inputs (no-SUTA line-9 branch,
 * partial-credit line-10 branch, no-balance voucher).
 *
 * Fixture: one $8,000/mo W-2 employee with an issued January 2025 run
 * (seeded 5.4% credit → 0.6% net FUTA), company EIN/address on file, and
 * the 2025 940 filing row (worksheet computed via the detail read):
 * line 3 = 8000.00, line 7 = 7000.00 (capped), line 8/12 = 42.00,
 * balance due 42.00 (no deposits tracked) → the 940-V voucher is filled.
 *
 * Covers: input assembly (worksheet figures + decrypted EIN + address),
 * line-for-line AcroForm placement (split dollars/cents), the line-8-is-
 * always-×0.006 form rule with the credit delta in Part 3 (all three
 * branches), blank Part 1/4e/5/6/7 boxes, voucher filled only with a
 * balance due, byte-stability, flattened 3-page output, template checksum,
 * and the route (200 + filename, 403/401, 400 non-940, 404 unknown).
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
  F940_FIELD_MAP,
  type F940Input,
  type MoneyField,
  pdfStructure,
  prepareF940,
  renderF940Pdf,
  splitMoneyPair,
  templateBytes,
} from "@payroll/documents";
import { encryptField } from "../src/crypto/field-encryption.js";
import type { Worksheet940 } from "../src/filings/annual.js";
import { f940PdfInputFor } from "../src/filings/form-940-pdf.js";
import { worksheetHash } from "../src/filings/service.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

let t: TestContext;
let ADMIN: Record<string, string>;
let EMPLOYEE: Record<string, string>;
let filingId: number;
let worksheet: Worksheet940;

const EMPLOYER = {
  legalName: "Example Corp",
  ein: "12-3456789",
  address: { line1: "100 Main St", city: "Austin", state: "TX", zip: "78701", country: "US" },
};

/** Synthetic worksheet-shaped input for the Part 3 branch coverage. */
function syntheticInput(overrides: Partial<F940Input> = {}): F940Input {
  return {
    taxYear: 2025,
    employer: { legalName: EMPLOYER.legalName, ein: EMPLOYER.ein, address: EMPLOYER.address },
    sutaCreditRate: "0.054",
    line3TotalPayments: "96000.00",
    line7FutaTaxableWages: "7000.00",
    line12TotalFutaTax: "42.00",
    balanceDue: "42.00",
    ...overrides,
  };
}

function textOf(doc: Awaited<ReturnType<typeof prepareF940>>, name: string) {
  return doc.getForm().getTextField(name).getText() ?? null;
}

function expectMoney(
  doc: Awaited<ReturnType<typeof prepareF940>>,
  field: MoneyField,
  value: string,
) {
  const { dollars, cents } = splitMoneyPair(value);
  expect(textOf(doc, field.dollars)).toBe(dollars);
  expect(textOf(doc, field.cents)).toBe(cents);
}

// Runs are issued on their pay date (issueOn): a run whose pay-date quarter
// has ended is late and needs the PAY-193 L4 confirmation. Outside an issue
// the clock stays at late 2025.
let issueOn: string | null = null;
const ISSUE_CLOCK = () => new Date(`${issueOn ?? "2025-12-31"}T12:00:00Z`);

beforeAll(async () => {
  t = await createTestApp({}, { clock: ISSUE_CLOCK });
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "f940-admin@test.dev", role: "admin" });
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);
  const employee = await inviteAndOnboard(t, { email: "f940-emp@test.dev", role: "employee" });
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
    .values({ companyId, legalName: "F940 One", hireDate: "2025-01-01" })
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

  const gen = await t.app.inject({
    method: "POST",
    url: "/api/admin/payroll-runs/generate",
    headers: ADMIN,
    payload: { year: 2025, month: 1, employeeId },
  });
  expect(gen.statusCode, gen.body).toBe(201);
  const run = (gen.json() as { generated: (typeof payrollRuns.$inferSelect)[] }).generated[0];
  if (!run) throw new Error(`no run generated: ${gen.body}`);
  issueOn = run.payDate;
  for (const action of ["approve", "issue"] as const) {
    const res = await t.app.inject({
      method: "POST",
      url: `/api/admin/payroll-runs/${run.publicId}/${action}`,
      headers: ADMIN,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  issueOn = null;

  const filing = await t.db
    .insert(taxFilings)
    .values({ formType: "940", year: 2025, quarter: 0, dueDate: "2026-02-02", status: "ready" })
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
  worksheet = row?.worksheet as Worksheet940;
  expect(worksheet.sutaCreditRate).toBe("0.054"); // seeded 2025 default
  expect(worksheet.line3TotalPayments).toBe("8000.00");
  expect(worksheet.line7FutaTaxableWages).toBe("7000.00"); // FUTA cap
  expect(worksheet.line12TotalFutaTax).toBe("42.00");
  expect(Number(worksheet.balanceDue)).toBeGreaterThan(0); // voucher filled
}, 120_000);

afterAll(async () => {
  await t.close();
});

describe("input assembly — worksheet figures + company header", () => {
  it("mirrors the stored worksheet and decrypts the EIN at render time", async () => {
    const input = await f940PdfInputFor({ db: t.db, config: t.config }, filingId);
    expect(input.taxYear).toBe(2025);
    expect(input.employer.legalName).toBe("Example Corp");
    expect(input.employer.ein).toBe("12-3456789");
    expect(input.employer.address?.city).toBe("Austin");
    expect(input.sutaCreditRate).toBe(worksheet.sutaCreditRate);
    expect(input.line3TotalPayments).toBe(worksheet.line3TotalPayments);
    expect(input.line12TotalFutaTax).toBe(worksheet.line12TotalFutaTax);
    expect(input.balanceDue).toBe(worksheet.balanceDue);
    const row = (
      await t.db.select().from(taxFilings).where(eq(taxFilings.id, filingId)).limit(1)
    )[0];
    expect(row?.worksheetHash).toBe(worksheetHash(worksheet));
  });

  it("rejects non-940 filings", async () => {
    const other = await t.db
      .insert(taxFilings)
      .values({ formType: "941", year: 2025, quarter: 1, dueDate: "2025-04-30" })
      .returning({ id: taxFilings.id });
    await expect(
      f940PdfInputFor({ db: t.db, config: t.config }, other[0]?.id ?? -1),
    ).rejects.toThrow("not a Form 940 filing");
  });
});

describe("AcroForm placement — the worksheet, line for line", () => {
  it("fills the full-credit branch: no Part 3 adjustments, line 12 = line 8", async () => {
    const input = await f940PdfInputFor({ db: t.db, config: t.config }, filingId);
    const doc = await prepareF940(input);
    const map = F940_FIELD_MAP;

    // Entity area — EIN split across the two boxes, name + address.
    expect(textOf(doc, map.einFirst2)).toBe("12");
    expect(textOf(doc, map.einLast7)).toBe("3456789");
    expect(textOf(doc, map.legalName)).toBe("Example Corp");
    expect(textOf(doc, map.street)).toBe("100 Main St");
    expect(textOf(doc, map.city)).toBe("Austin");
    expect(textOf(doc, map.state)).toBe("TX");
    expect(textOf(doc, map.zip)).toBe("78701");

    // Part 1 state questions stay blank (the worksheet carries no state).
    expect(textOf(doc, map.line1aStateFirst)).toBeNull();
    expect(doc.getForm().getCheckBox(map.line1bMultiState).isChecked()).toBe(false);
    expect(doc.getForm().getCheckBox(map.line2CreditReduction).isChecked()).toBe(false);

    // Part 2 — line 5/6 derived (line 3 − line 7), line 8 = line 7 × 0.006.
    expectMoney(doc, map.line3TotalPayments, "8000.00");
    expect(textOf(doc, map.line4ExemptPayments.dollars)).toBeNull();
    expectMoney(doc, map.line5ExcessWages, "1000.00");
    expectMoney(doc, map.line6Subtotal, "1000.00");
    expectMoney(doc, map.line7FutaTaxableWages, "7000.00");
    expectMoney(doc, map.line8FutaTax, "42.00");

    // Part 3 — full 5.4% credit → every adjustment line blank.
    expect(textOf(doc, map.line9AllExcludedFromSuta.dollars)).toBeNull();
    expect(textOf(doc, map.line10SomeExcludedOrLateSuta.dollars)).toBeNull();
    expect(textOf(doc, map.line11CreditReduction.dollars)).toBeNull();

    // Part 4 — line 12 = worksheet, line 13 = 0 (no deposits), 14 = due.
    expectMoney(doc, map.line12TotalFutaTax, worksheet.line12TotalFutaTax);
    expectMoney(doc, map.line13Deposited, "0.00");
    expectMoney(doc, map.line14BalanceDue, worksheet.balanceDue);
    expect(textOf(doc, map.line15aOverpayment.dollars)).toBeNull();
    expect(doc.getForm().getCheckBox(map.overpaymentApplyToNext).isChecked()).toBe(false);
    expect(doc.getForm().getCheckBox(map.overpaymentSendRefund).isChecked()).toBe(false);

    // Page 2 header; Part 5 quarterly liability stays blank (line 12 ≤ 500).
    expect(textOf(doc, map.page2Name)).toBe("Example Corp");
    expect(textOf(doc, map.page2EinFirst2)).toBe("12");
    expect(textOf(doc, map.page2EinLast7)).toBe("3456789");
    expect(textOf(doc, map.line16aQ1.dollars)).toBeNull();
    expect(textOf(doc, map.line17TotalLiability.dollars)).toBeNull();

    // Part 7 print-name/title/phone blank (wet-signature journey).
    const P2 = "topmostSubform[0].Page2[0]";
    expect(textOf(doc, `${P2}.f2_14[0]`)).toBeNull(); // print your name
    expect(textOf(doc, `${P2}.f2_15[0]`)).toBeNull(); // print your title
    expect(textOf(doc, `${P2}.f2_16[0]`)).toBeNull(); // best daytime phone

    // Page 3 — 940-V voucher filled (balance due).
    expect(textOf(doc, map.voucherEinFirst2)).toBe("12");
    expect(textOf(doc, map.voucherEinLast7)).toBe("3456789");
    expectMoney(doc, map.voucherAmount, worksheet.balanceDue);
    expect(textOf(doc, map.voucherName)).toBe("Example Corp");
    expect(textOf(doc, map.voucherStreet)).toBe("100 Main St");
    expect(textOf(doc, map.voucherCityStateZip)).toBe("Austin, TX 78701");
  });

  it("no SUTA paid (0 credit) → line 9 = line 7 × 0.054, line 12 = 6.0% (the SOULT IO shape)", async () => {
    const doc = await prepareF940(
      syntheticInput({ sutaCreditRate: "0", line12TotalFutaTax: "420.00", balanceDue: "420.00" }),
    );
    const map = F940_FIELD_MAP;
    expectMoney(doc, map.line8FutaTax, "42.00"); // form line 8 is always ×0.006
    expectMoney(doc, map.line9AllExcludedFromSuta, "378.00"); // 7000 × 0.054
    expect(textOf(doc, map.line10SomeExcludedOrLateSuta.dollars)).toBeNull();
    expectMoney(doc, map.line12TotalFutaTax, "420.00"); // 8 + 9 = worksheet
  });

  it("partial credit → line 10 carries the delta to the worksheet's line 12", async () => {
    const doc = await prepareF940(
      syntheticInput({ sutaCreditRate: "0.051", line12TotalFutaTax: "63.00", balanceDue: "63.00" }),
    );
    const map = F940_FIELD_MAP;
    expect(textOf(doc, map.line9AllExcludedFromSuta.dollars)).toBeNull();
    expectMoney(doc, map.line10SomeExcludedOrLateSuta, "21.00"); // 63.00 − 42.00
    expectMoney(doc, map.line12TotalFutaTax, "63.00");
  });

  it("leaves the voucher blank when no balance is due", async () => {
    const doc = await prepareF940(syntheticInput({ balanceDue: "0.00" }));
    const map = F940_FIELD_MAP;
    expect(textOf(doc, map.voucherAmount.dollars)).toBeNull();
    expect(textOf(doc, map.voucherName)).toBeNull();
  });
});

describe("rendering — flattened, byte-stable, template-pinned", () => {
  it("renders a flattened 3-page PDF (940 pages 1–2 + 940-V voucher)", async () => {
    const pdf = await renderF940Pdf(syntheticInput());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(await pdfStructure(pdf)).toEqual({ pageCount: 3, fieldCount: 0 });
  });

  it("is byte-identical across renders of the same worksheet", async () => {
    const input = await f940PdfInputFor({ db: t.db, config: t.config }, filingId);
    const a = await renderF940Pdf(input);
    const b = await renderF940Pdf(input);
    expect(a.equals(b)).toBe(true);
  });

  it("loads the bundled 2025 template by checksum; 2026 is not bundled yet", () => {
    expect(templateBytes(2025, "f940").subarray(0, 5).toString()).toBe("%PDF-");
    expect(() => templateBytes(2026, "f940")).toThrow("no bundled IRS f940 template");
  });
});

describe("GET /api/admin/tax-filings/:id/940-pdf", () => {
  it("serves the filled PDF inline with a per-year filename", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-filings/${filingId}/940-pdf`,
      headers: ADMIN,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain("f940-2025.pdf");
    expect(await pdfStructure(res.rawPayload)).toEqual({ pageCount: 3, fieldCount: 0 });
  });

  it("is admin-only", async () => {
    const asEmployee = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-filings/${filingId}/940-pdf`,
      headers: EMPLOYEE,
    });
    expect(asEmployee.statusCode).toBe(403);
    const anon = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-filings/${filingId}/940-pdf`,
    });
    expect(anon.statusCode).toBe(401);
  });

  it("400s non-940 filings and 404s unknown filings", async () => {
    const other = await t.db
      .select({ id: taxFilings.id })
      .from(taxFilings)
      .where(eq(taxFilings.formType, "941"))
      .limit(1);
    const not940 = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-filings/${other[0]?.id ?? -1}/940-pdf`,
      headers: ADMIN,
    });
    expect(not940.statusCode).toBe(400);
    const missing = await t.app.inject({
      method: "GET",
      url: "/api/admin/tax-filings/999999/940-pdf",
      headers: ADMIN,
    });
    expect(missing.statusCode).toBe(404);
  });
});

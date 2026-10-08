/**
 * PAY-11 + PAY-19 integration tests — annual forms: Form 940 (FUTA) worksheet
 * + W-2/W-3 generation and filing tracking, official-template W-2/W-3 PDF
 * rendering, and electronic-delivery consent. Real SQL via the PGlite
 * harness; sync and reminder functions are called directly (pg-boss needs a
 * real Postgres), the admin/employee routes go through app.inject with real
 * sessions.
 *
 * Fixture (built once in beforeAll): thirteen W-2 employees with issued 2025
 * runs — twelve at $8,000/mo (January only; FUTA-capped at $7,000, enough to
 * cross the $500 quarterly deposit threshold in Q1) and one at $1,111.11/mo
 * for the full year (exercises the per-paycheck FUTA rounding delta). Two of
 * the capped employees are linked to real user accounts (W-2 self-service +
 * availability notices + the consent flow). The rounding employee also has a
 * January 2026 run so "year not ended / W-2 not yet available" branches are
 * exercised. A contractor with a (legacy-style, direct-insert) issued run
 * proves the employment_type='w2' joins exclude contractors everywhere.
 *
 * Covers: annual due-date math (weekend roll), the 940 worksheet line-by-line
 * with reconciliation to the cent against frozen entries + the export API +
 * the sum of quarterly 941 worksheets, W-2 box figures and the W-3 aggregate,
 * official-form PDF rendering (exact AcroForm field placement pre-flatten,
 * flattened page/field structure, PII in the document only — never in JSON),
 * the January availability gate, sync (create/refresh/freeze), admin +
 * employee routes incl. RBAC, the consent gate (409 before consent, withdraw
 * re-gates, audit trail), tax_filing_due reminders for annual rows, and the
 * once-per-year w2_available notices.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  appSettings,
  auditEvents,
  company,
  compensation,
  emailOutbox,
  employees,
  payrollEntries,
  payrollRuns,
  seedDatabase,
  taxConfig,
  taxFilings,
  w2DeliveryConsents,
  type SeedDb,
} from "@payroll/db";
import { effectiveFutaRate } from "@payroll/engine";
import { round2 } from "@payroll/engine/money";
import { EVENT_TYPE } from "@payroll/notifications";
import { formatCents } from "@payroll/shared";
import {
  pdfStructure,
  prepareW2EmployeePacket,
  prepareW3,
  renderW2AdminCopyD,
  renderW2EmployeePacket,
  renderW3Pdf,
  w2FieldMap,
  W3_CHECKBOXES,
  W3_FIELD_MAP,
} from "@payroll/documents";
import { computeWorksheet, sendFilingReminders } from "../src/filings/service.js";
import {
  annualDueDate,
  compute940Worksheet,
  computeW3Worksheet,
  isW2Available,
  sendW2AvailableNotices,
  syncAnnualFilings,
  w2AvailableOn,
  w2FiguresForYear,
  w2InputFor,
  w3InputFor,
  type Worksheet940,
  type WorksheetW3,
} from "../src/filings/annual.js";
import { worksheetHash } from "../src/filings/shared.js";
import { encryptField } from "../src/crypto/field-encryption.js";
import { snapshotHash, type RunSnapshot } from "../src/payroll/snapshot.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";
import {
  allMarkersTrue,
  CONTACT,
  CONTACT_ADDRESS,
  disclosureMarkers,
  NEW_VERSION,
  OLD_JAN31_PHRASE,
  SME_SENTENCE,
} from "./pay-208-harness.js";
import { accessCodeFor } from "./w2-consent-fixture.js";
import { expMyVersions } from "./pay-223-versions-oracle.js";

const EXPORT_TOKEN = "test-export-token-0123456789abcdef";

let t: TestContext;
let ADMIN: Record<string, string>;
/** Account-linked employee (January 2025 run) — self-service fixture. */
let acctA: { userId: string; email: string; employeeId: number };
/** Second account-linked employee — consent-flow fixture (PAY-19). */
let acctB: { userId: string; email: string; employeeId: number };
let contractorUser: { userId: string; email: string };
let contractorEmployeeId: number;
/** All thirteen 2025 W-2 fixture employee ids (pre late-run). */
const fixtureEmployeeIds: number[] = [];

// Runs are issued on their pay date (issueOn): a run whose pay-date quarter
// has ended is late and needs the PAY-193 L4 confirmation. Outside an issue
// the clock stays at late 2025.
let issueOn: string | null = null;
const ISSUE_CLOCK = () => new Date(`${issueOn ?? "2025-12-31"}T12:00:00Z`);

beforeAll(async () => {
  t = await createTestApp({ exportToken: EXPORT_TOKEN }, { clock: ISSUE_CLOCK });
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "annual-admin@test.dev", role: "admin" });
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);

  // Ten plain capped employees + two account-linked ones, $8,000/mo, Jan 2025.
  for (let i = 1; i <= 10; i += 1) {
    const id = await createEmployee(`Annual Cap ${String(i).padStart(2, "0")}`);
    await addCompensation(id, 8000);
    await issueRun(id, 2025, 1);
    fixtureEmployeeIds.push(id);
  }
  for (const [email, name] of [
    ["annual-acct-a@test.dev", "Annual Acct A"],
    ["annual-acct-b@test.dev", "Annual Acct B"],
  ] as const) {
    const user = await inviteAndOnboard(t, { email, name });
    const id = await createEmployee(name, { userId: user.userId });
    await addCompensation(id, 8000);
    await issueRun(id, 2025, 1);
    fixtureEmployeeIds.push(id);
    if (email.endsWith("-a@test.dev")) acctA = { userId: user.userId, email, employeeId: id };
    if (email.endsWith("-b@test.dev")) acctB = { userId: user.userId, email, employeeId: id };
  }

  // Rounding employee: $1,111.11/mo all of 2025 (per-paycheck FUTA rounding
  // delta) + January 2026 (a year that has NOT ended / W-2 not available).
  const rounding = await createEmployee("Annual Rounding");
  await addCompensation(rounding, 1111.11);
  for (let month = 1; month <= 12; month += 1) await issueRun(rounding, 2025, month);
  await issueRun(rounding, 2026, 1);
  fixtureEmployeeIds.push(rounding);

  // A contractor (1099) with a user account — never a W-2 recipient.
  contractorUser = await inviteAndOnboard(t, {
    email: "annual-contractor@test.dev",
    name: "Annual Contractor",
  });
  contractorEmployeeId = await createEmployee("Annual Contractor", {
    userId: contractorUser.userId,
    employmentType: "1099",
  });
}, 240_000);

afterAll(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createEmployee(
  legalName: string,
  opts: { userId?: string; employmentType?: string } = {},
): Promise<number> {
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({
      companyId: companyRows[0]?.id ?? 1,
      legalName,
      hireDate: "2025-01-01",
      ...(opts.userId ? { userId: opts.userId } : {}),
      ...(opts.employmentType ? { employmentType: opts.employmentType } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("employee insert failed");
  return row.id;
}

async function addCompensation(employeeId: number, periodAmount: number): Promise<void> {
  await t.db.insert(compensation).values({
    employeeId,
    periodAmount: String(periodAmount),
    frequency: "monthly",
    effectiveFrom: "2025-01-01",
    effectiveTo: null,
  });
}

/** Generate → approve → issue a monthly run (the filings.test.ts pattern). */
async function issueRun(employeeId: number, year: number, month: number) {
  const gen = await t.app.inject({
    method: "POST",
    url: "/api/admin/payroll-runs/generate",
    headers: ADMIN,
    payload: { year, month, employeeId },
  });
  expect(gen.statusCode, gen.body).toBe(201);
  const run = (gen.json() as { generated: (typeof payrollRuns.$inferSelect)[] }).generated[0];
  if (!run) throw new Error("no run generated");
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
}

async function api(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
): ReturnType<typeof t.app.inject> {
  return t.app.inject({
    method,
    url,
    headers: ADMIN,
    ...(payload !== undefined ? { payload } : {}),
  });
}

/** One login per user per file — the auth rate limiter 429s burst sign-ins. */
const sessionCache = new Map<string, Record<string, string>>();
async function sessionFor(email: string): Promise<Record<string, string>> {
  const cached = sessionCache.get(email);
  if (cached) return cached;
  const header = sessionHeader((await login(t, email, TEST_PASSWORD)).sessionCookie);
  sessionCache.set(email, header);
  return header;
}

/** Sum one entry category for the year — W-2 employees only (mirrors production). */
async function categorySum(year: number, category: string): Promise<number> {
  const rows = await t.db
    .select({
      total: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)::numeric(14,2)::text`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .innerJoin(employees, eq(payrollRuns.employeeId, employees.id))
    .where(
      and(
        eq(payrollEntries.category, category),
        eq(payrollRuns.status, "issued"),
        eq(employees.employmentType, "w2"),
        sql`${payrollRuns.payDate} >= ${`${year}-01-01`}`,
        sql`${payrollRuns.payDate} <= ${`${year}-12-31`}`,
      ),
    );
  return Number(rows[0]?.total ?? "0");
}

/** Per-employee sum of one category (W-2 only), keyed by employee id. */
async function perEmployeeCategory(year: number, category: string): Promise<Map<number, number>> {
  const rows = await t.db
    .select({
      employeeId: payrollRuns.employeeId,
      total: sql<string>`sum(${payrollEntries.amount})::numeric(14,2)::text`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .innerJoin(employees, eq(payrollRuns.employeeId, employees.id))
    .where(
      and(
        eq(payrollEntries.category, category),
        eq(payrollRuns.status, "issued"),
        eq(employees.employmentType, "w2"),
        sql`${payrollRuns.payDate} >= ${`${year}-01-01`}`,
        sql`${payrollRuns.payDate} <= ${`${year}-12-31`}`,
      ),
    )
    .groupBy(payrollRuns.employeeId);
  return new Map(rows.map((r) => [r.employeeId, Number(r.total)]));
}

async function annualFilingRow(formType: "940" | "w2_w3", year: number) {
  const rows = await t.db
    .select()
    .from(taxFilings)
    .where(
      and(eq(taxFilings.formType, formType), eq(taxFilings.year, year), eq(taxFilings.quarter, 0)),
    );
  return rows[0];
}

/** A legacy-style issued contractor run (direct insert — the service layer hard-blocks these). */
async function insertContractorLegacyRun(): Promise<void> {
  const snapshot: RunSnapshot = {
    inputs: {
      periodAmount: 5000,
      frequency: "monthly",
      periodsPerYear: 12,
      w4: null,
      taxConfig: {
        jurisdiction: "federal",
        taxYear: 2025,
        standardDeduction: 15000,
        socialSecurityRate: 0.062,
        socialSecurityWageCap: 176100,
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
      periodStart: "2025-02-01",
      periodEnd: "2025-02-28",
      payDate: "2025-02-15",
      company: { legalName: "Example Corp" },
      employee: { legalName: "Annual Contractor", preferredName: null },
    },
    result: {
      grossPay: 5000,
      federalWithholding: 0,
      socialSecurity: 0,
      medicare: 0,
      stateWithholding: 0,
      totalDeductions: 0,
      netPay: 5000,
      employerSocialSecurity: 0,
      employerMedicare: 0,
      employerFUTA: 30,
      totalEmployerCost: 5030,
      ytdGross: 5000,
    },
    engineVersion: "legacy-import",
    templateVersion: "1.1.0",
  };
  const inserted = await t.db
    .insert(payrollRuns)
    .values({
      employeeId: contractorEmployeeId,
      periodStart: "2025-02-01",
      periodEnd: "2025-02-28",
      payDate: "2025-02-15",
      status: "issued",
      runSnapshot: snapshot,
      snapshotHash: snapshotHash(snapshot),
      createdBy: "legacy-import",
    })
    .returning();
  const runId = inserted[0]?.id;
  if (!runId) throw new Error("contractor run insert failed");
  await t.db.insert(payrollEntries).values([
    { runId, category: "gross_pay", amount: "5000.00" },
    { runId, category: "federal_withholding", amount: "0.00" },
    { runId, category: "social_security", amount: "0.00" },
    { runId, category: "medicare", amount: "0.00" },
    { runId, category: "state_withholding", amount: "0.00" },
    { runId, category: "net_pay", amount: "5000.00" },
    { runId, category: "employer_social_security", amount: "0.00" },
    { runId, category: "employer_medicare", amount: "0.00" },
    { runId, category: "employer_futa", amount: "30.00" },
  ]);
}

// ---------------------------------------------------------------------------
// Pure date math
// ---------------------------------------------------------------------------

describe("annualDueDate + W-2 availability (PAY-11 domain rules)", () => {
  it("is Jan 31 of the following year, weekend-rolled", () => {
    expect(annualDueDate(2024)).toBe("2025-01-31"); // Friday — no roll
    expect(annualDueDate(2025)).toBe("2026-02-02"); // Jan 31 2026 is a Saturday
    expect(annualDueDate(2026)).toBe("2027-02-01"); // Jan 31 2027 is a Sunday
  });

  it("W-2s unlock on January 1 of the following year", () => {
    expect(w2AvailableOn(2025)).toBe("2026-01-01");
    expect(isW2Available(2025, "2025-12-31")).toBe(false);
    expect(isW2Available(2025, "2026-01-01")).toBe(true);
    expect(isW2Available(2026, "2026-12-31")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Form 940 worksheet — deterministic, reconciles to the cent
// ---------------------------------------------------------------------------

describe("compute940Worksheet", () => {
  it("computes all lines from frozen entries; reconciles three ways", async () => {
    const w = await compute940Worksheet(t.db, 2025);

    // PAY-18: expected FUTA derives from the year's CONFIGURED SUTA credit
    // (net rate = 6.0% − credit), never a hardcoded 0.6%.
    const configRows = await t.db
      .select()
      .from(taxConfig)
      .where(and(eq(taxConfig.jurisdiction, "federal"), eq(taxConfig.taxYear, 2025)));
    const sutaCredit = Number(configRows[0]?.sutaCreditRate ?? 0.054);
    const netFutaRate = effectiveFutaRate(sutaCredit);
    expect(w.sutaCreditRate).toBe(String(sutaCredit));
    expect(w.futaRate).toBe(String(netFutaRate));

    // Line 3 — total payments: 12 × $8,000 + 12 × $1,111.11.
    expect(w.line3TotalPayments).toBe("109333.32");
    // Line 7 — every fixture employee exceeds the $7,000 FUTA cap.
    expect(w.line7FutaTaxableWages).toBe("91000.00"); // 13 × 7,000
    // Line 8/12 — line 7 × the configured net rate (5.4% credit → 0.6%).
    const expectedLine8 = round2(Number(w.line7FutaTaxableWages) * netFutaRate).toFixed(2);
    expect(w.line8FutaTax).toBe(expectedLine8);
    expect(w.line8FutaTax).toBe("546.00"); // 91,000 × 0.6%
    expect(w.line12TotalFutaTax).toBe(expectedLine8); // no further reduction

    // Frozen-entry truth (accrued liability): the DB sum of employer_futa.
    // 12 × 42.00 (capped month 1) + the rounding employee's 42.02.
    const futaEntries = await categorySum(2025, "employer_futa");
    expect(w.futaTaxPerFrozenEntries).toBe(futaEntries.toFixed(2));
    expect(futaEntries.toFixed(2)).toBe("546.02");

    // Rounding delta (941 line-7 doctrine): frozen entries − line 12, to the cent.
    const delta = round2(futaEntries - Number(w.line12TotalFutaTax));
    expect(w.roundingDelta).toBe(delta.toFixed(2));
    expect(delta.toFixed(2)).toBe("0.02"); // per-paycheck rounding, non-zero by fixture design

    // $500 quarterly deposit rule: 12 × 42.00 + 6.67 = $510.67 in Q1 → crossed.
    expect(w.depositThresholdCrossedQuarter).toBe(1);
    expect(w.depositDueBy).toBe("2025-04-30"); // last day of month after Q1

    // Balance due = frozen-entry truth (no FUTA deposits tracked in-app).
    expect(w.balanceDue).toBe(w.futaTaxPerFrozenEntries);

    // Reconciliation 1: 940 line 3 == sum of the year's quarterly 941 line 2.
    let sum941 = 0;
    for (const quarter of [1, 2, 3, 4]) {
      const q = await computeWorksheet(t.db, 2025, quarter);
      sum941 = round2(sum941 + Number(q.line2Wages));
    }
    expect(w.line3TotalPayments).toBe(sum941.toFixed(2));

    // Reconciliation 2: frozen FUTA entries == the export API's figures.
    const res = await t.app.inject({
      method: "GET",
      url: "/api/export/payroll-runs?from=2025-01-01&to=2025-12-31",
      headers: { authorization: `Bearer ${EXPORT_TOKEN}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { runs } = res.json() as { runs: { entries: Record<string, string | null> }[] };
    const exportFuta = round2(
      runs.reduce((acc, r) => acc + Number(r.entries.employer_futa ?? "0"), 0),
    );
    expect(w.futaTaxPerFrozenEntries).toBe(exportFuta.toFixed(2));
  });

  it("snapshot hash is stable across recomputation with the same inputs", async () => {
    const w1 = await compute940Worksheet(t.db, 2025);
    const w2 = await compute940Worksheet(t.db, 2025);
    expect(worksheetHash(w1)).toBe(worksheetHash(w2));
  });

  it("an empty year yields zeros and no deposit obligation", async () => {
    const w = await compute940Worksheet(t.db, 2020);
    expect(w.line3TotalPayments).toBe("0.00");
    expect(w.line7FutaTaxableWages).toBe("0.00");
    expect(w.line12TotalFutaTax).toBe("0.00");
    expect(w.futaTaxPerFrozenEntries).toBe("0.00");
    expect(w.roundingDelta).toBe("0.00");
    expect(w.depositThresholdCrossedQuarter).toBeNull();
    expect(w.depositDueBy).toBeNull();
    expect(w.balanceDue).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// W-2 figures + W-3 aggregate — contractors excluded everywhere
// ---------------------------------------------------------------------------

describe("W-2 figures and the W-3 worksheet", () => {
  it("computes the six boxes per employee; contractors never appear", async () => {
    // A legacy-style contractor run (direct insert — service blocks these)
    // must not leak into any annual-form figure.
    await insertContractorLegacyRun();

    const figures = await w2FiguresForYear(t.db, 2025);
    expect(figures).toHaveLength(13);
    expect(figures.some((f) => f.employeeId === contractorEmployeeId)).toBe(false);

    const gross = await perEmployeeCategory(2025, "gross_pay");
    const fed = await perEmployeeCategory(2025, "federal_withholding");
    const ss = await perEmployeeCategory(2025, "social_security");
    const medicare = await perEmployeeCategory(2025, "medicare");
    const byId = new Map(figures.map((f) => [f.employeeId, f]));
    // PAY-162: boxes are integer cents; compare as printed strings.
    const printed = (cents: number | null) => (cents === null ? null : formatCents(cents));
    const dollars = (n: number) => round2(n).toFixed(2);
    for (const [employeeId, box1] of gross) {
      const f = byId.get(employeeId);
      if (!f) throw new Error(`missing W-2 figures for employee ${employeeId}`);
      expect(printed(f.box1Cents)).toBe(dollars(box1));
      expect(printed(f.box2Cents)).toBe(dollars(fed.get(employeeId) ?? 0));
      // Box 3 applies the 2025 SS wage cap ($176,100 — nobody here reaches it).
      expect(printed(f.box3Cents)).toBe(dollars(Math.min(box1, 176_100)));
      expect(printed(f.box4Cents)).toBe(dollars(ss.get(employeeId) ?? 0));
      expect(printed(f.box5Cents)).toBe(dollars(box1)); // Medicare wages are uncapped
      expect(printed(f.box6Cents)).toBe(dollars(medicare.get(employeeId) ?? 0));
    }

    // W-3 = the box-by-box aggregate across all W-2s.
    const w3 = await computeW3Worksheet(t.db, 2025);
    expect(w3.employeeCount).toBe(13);
    const sum = (pick: (f: (typeof figures)[number]) => number | null) =>
      formatCents(figures.reduce((acc, f) => acc + (pick(f) ?? 0), 0));
    expect(w3.box1Wages).toBe(sum((f) => f.box1Cents));
    expect(w3.box2FederalWithheld).toBe(sum((f) => f.box2Cents));
    expect(w3.box3SsWages).toBe(sum((f) => f.box3Cents));
    expect(w3.box4SsTax).toBe(sum((f) => f.box4Cents));
    expect(w3.box5MedicareWages).toBe(sum((f) => f.box5Cents));
    expect(w3.box6MedicareTax).toBe(sum((f) => f.box6Cents));
    // The contractor's $5,000 legacy gross is excluded from the aggregate.
    expect(w3.box1Wages).toBe("109333.32");
  });
});

// ---------------------------------------------------------------------------
// W-2/W-3 PDFs — official AcroForm templates, filled + flattened (PAY-19)
// ---------------------------------------------------------------------------

describe("W-2/W-3 PDF rendering", () => {
  it("assembles the W-2 input with PII decrypted at render time", async () => {
    await t.db
      .update(company)
      .set({
        ein: encryptField("12-3456789", t.config.encryptionKey),
        address: { line1: "100 Main St", city: "Austin", state: "TX", zip: "78701", country: "US" },
      })
      .where(eq(company.id, 1));
    await t.db
      .update(employees)
      .set({
        taxId: encryptField("123456789", t.config.encryptionKey),
        address: {
          line1: "1 Infinite Loop",
          line2: "Apt 4",
          city: "Cupertino",
          state: "CA",
          zip: "95014",
          country: "US",
        },
      })
      .where(eq(employees.id, acctA.employeeId));

    const input = await w2InputFor({ db: t.db, config: t.config }, acctA.employeeId, 2025);
    expect(input.taxYear).toBe(2025);
    expect(input.employer.legalName).toBe("Example Corp");
    expect(input.employer.ein).toBe("12-3456789");
    expect(input.employee.ssn).toBe("123-45-6789"); // 9 stored digits → ###-##-####
    expect(input.employee.legalName).toBe("Annual Acct A");
    expect(input.controlNumber).toBe(String(acctA.employeeId)); // box d (D5)
    expect(input.box1Wages).toBe("8000.00");
  });

  it("places every figure in the exact AcroForm fields, pre-flatten", async () => {
    const input = await w2InputFor({ db: t.db, config: t.config }, acctA.employeeId, 2025);
    const doc = await prepareW2EmployeePacket(input);
    const form = doc.getForm();
    const text = (name: string) => form.getTextField(name).getText() ?? null;

    for (const copy of ["CopyB", "CopyC", "Copy2"] as const) {
      const map = w2FieldMap(copy);
      // PII + identity boxes, decrypted at render time only.
      expect(text(map.ssn)).toBe("123-45-6789");
      expect(text(map.ein)).toBe("12-3456789");
      expect(text(map.employerNameAddress)).toContain("Example Corp");
      expect(text(map.employerNameAddress)).toContain("100 Main St");
      expect(text(map.employerNameAddress)).toContain("Austin, TX 78701");
      expect(text(map.controlNumber)).toBe(String(acctA.employeeId));
      expect(text(map.employeeFirstName)).toBe("Annual Acct");
      expect(text(map.employeeLastName)).toBe("A");
      expect(text(map.employeeAddress)).toContain("1 Infinite Loop");
      expect(text(map.employeeAddress)).toContain("Apt 4");
      expect(text(map.employeeAddress)).toContain("Cupertino, CA 95014");
      // Money boxes — to the cent, IRS convention (no $, no commas).
      expect(text(map.box1Wages)).toBe(input.box1Wages);
      expect(text(map.box2FederalWithheld)).toBe(input.box2FederalWithheld);
      expect(text(map.box3SsWages)).toBe(input.box3SsWages);
      expect(text(map.box4SsTax)).toBe(input.box4SsTax);
      expect(text(map.box5MedicareWages)).toBe(input.box5MedicareWages);
      expect(text(map.box6MedicareTax)).toBe(input.box6MedicareTax);
    }
  });

  it("renders the flattened employee packet (B/C/2 + instructions) and Copy D", async () => {
    const input = await w2InputFor({ db: t.db, config: t.config }, acctA.employeeId, 2025);

    const packet = await renderW2EmployeePacket(input);
    expect(packet.subarray(0, 5).toString()).toBe("%PDF-");
    // Copy B + Notice + Copy C + Instructions + Copy 2 + Instructions cont.
    expect(await pdfStructure(packet)).toEqual({ pageCount: 6, fieldCount: 0 });

    const copyD = await renderW2AdminCopyD(input);
    expect(copyD.subarray(0, 5).toString()).toBe("%PDF-");
    expect(await pdfStructure(copyD)).toEqual({ pageCount: 1, fieldCount: 0 });
  });

  it("renders the W-3 transmittal with the aggregate and the count", async () => {
    const input = await w3InputFor({ db: t.db, config: t.config }, 2025);
    expect(input.taxYear).toBe(2025);
    expect(input.employeeCount).toBe(13);
    expect(input.box1Wages).toBe("109333.32");

    const doc = await prepareW3(input);
    const form = doc.getForm();
    const text = (name: string) => form.getTextField(name).getText() ?? null;
    expect(text(W3_FIELD_MAP.w2Count)).toBe("13");
    expect(text(W3_FIELD_MAP.ein)).toBe("12-3456789");
    expect(text(W3_FIELD_MAP.employerName)).toBe("Example Corp");
    expect(text(W3_FIELD_MAP.employerAddress)).toContain("Austin, TX 78701");
    expect(text(W3_FIELD_MAP.box1Wages)).toBe("109333.32");
    // Kind of payer 941 + kind of employer None apply (regular 941 corp, D5).
    for (const name of Object.values(W3_CHECKBOXES)) {
      expect(form.getCheckBox(name).isChecked()).toBe(true);
    }

    const pdf = await renderW3Pdf(input);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(await pdfStructure(pdf)).toEqual({ pageCount: 1, fieldCount: 0 });
  });

  it("enforces the availability gate and not-found rules", async () => {
    // Not yet available (explicit today; also holds for the real clock).
    await expect(
      w2InputFor({ db: t.db, config: t.config }, acctA.employeeId, 2026, { today: "2026-06-01" }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    // A contractor has no W-2 even with legacy runs on file.
    await expect(
      w2InputFor({ db: t.db, config: t.config }, contractorEmployeeId, 2025),
    ).rejects.toMatchObject({ code: "not_found" });
    // No issued runs in the year.
    await expect(
      w2InputFor({ db: t.db, config: t.config }, acctA.employeeId, 2020),
    ).rejects.toMatchObject({ code: "not_found" });
    // W-3 for an empty year.
    await expect(w3InputFor({ db: t.db, config: t.config }, 2020)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

// ---------------------------------------------------------------------------
// syncAnnualFilings — creates at year end, refreshes unfiled, freezes filed
// ---------------------------------------------------------------------------

describe("syncAnnualFilings", () => {
  it("creates quarter-0 rows with worksheets once the year has ended", async () => {
    const sync = await syncAnnualFilings({ db: t.db, config: t.config }, { today: "2026-01-15" });
    // PAY-22: 940 + W-2/W-3 for 2025 (ended) + the in-year 940 for 2026.
    expect(sync.created).toBe(3);
    expect(sync.refreshed).toBe(3); // worksheets written on creation

    for (const formType of ["940", "w2_w3"] as const) {
      const row = await annualFilingRow(formType, 2025);
      if (!row) throw new Error(`no ${formType} row`);
      expect(row.status).toBe("ready");
      expect(row.quarter).toBe(0);
      expect(row.dueDate).toBe("2026-02-02"); // weekend-rolled Jan 31
      expect(row.worksheetHash).toBe(worksheetHash(row.worksheet));
    }
    const w940 = (await annualFilingRow("940", 2025))?.worksheet as Worksheet940;
    expect(w940.line3TotalPayments).toBe("109333.32");
    const w3 = (await annualFilingRow("w2_w3", 2025))?.worksheet as WorksheetW3;
    expect(w3.employeeCount).toBe(13);

    // PAY-22: the in-progress year gets a not_started 940 (live deposit
    // monitor) but no w2_w3 row until the year closes.
    const inYear = await annualFilingRow("940", 2026);
    expect(inYear?.status).toBe("not_started");
    expect(inYear?.worksheetHash).toBe(worksheetHash(inYear?.worksheet));
    expect(await annualFilingRow("w2_w3", 2026)).toBeUndefined();
  });

  it("is idempotent and refreshes when a late run issues", async () => {
    const noop = await syncAnnualFilings({ db: t.db, config: t.config }, { today: "2026-01-16" });
    expect(noop).toEqual({ created: 0, refreshed: 0 });

    // A fourteenth employee's March 2025 run issues late — both annual
    // worksheets recompute (gross + boxes change; employee count changes).
    const late = await createEmployee("Annual Late");
    await addCompensation(late, 2000);
    await issueRun(late, 2025, 3);
    const refresh = await syncAnnualFilings(
      { db: t.db, config: t.config },
      { today: "2026-04-01" },
    );
    expect(refresh.created).toBe(0);
    expect(refresh.refreshed).toBe(2);

    const w940 = (await annualFilingRow("940", 2025))?.worksheet as Worksheet940;
    expect(w940.line3TotalPayments).toBe("111333.32");
    const w3 = (await annualFilingRow("w2_w3", 2025))?.worksheet as WorksheetW3;
    expect(w3.employeeCount).toBe(14);
  });

  it("never rewrites a filed worksheet", async () => {
    const row = await annualFilingRow("940", 2025);
    if (!row) throw new Error("no 940 row");
    const res = await api("POST", `/api/admin/tax-filings/${row.id}/file`, {
      filedOn: "2026-01-20",
      filingMethod: "efile",
      filingReference: "IRS-940-ACK-1",
    });
    expect(res.statusCode, res.body).toBe(200);

    const hash = (await annualFilingRow("940", 2025))?.worksheetHash;
    const sync = await syncAnnualFilings({ db: t.db, config: t.config }, { today: "2026-04-02" });
    expect(sync.refreshed).toBe(0); // w2_w3 unchanged too — no new runs
    expect((await annualFilingRow("940", 2025))?.worksheetHash).toBe(hash);
  });
});

// ---------------------------------------------------------------------------
// Admin routes — W-2 list (no PII), on-demand PDFs, RBAC
// ---------------------------------------------------------------------------

describe("admin annual-form routes", () => {
  it("lists per-employee W-2 figures without any PII", async () => {
    const res = await api("GET", "/api/admin/annual-forms/w2?year=2025");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      year: number;
      available: boolean;
      availableOn: string;
      w2s: { employeeId: number; box1Wages: number; consented: boolean }[];
    };
    expect(body.year).toBe(2025);
    expect(body.available).toBe(true);
    expect(body.availableOn).toBe("2026-01-01");
    expect(body.w2s).toHaveLength(14);
    // Nobody has consented yet at this point in the suite.
    expect(body.w2s.every((row) => row.consented === false)).toBe(true);
    // Content rules: no SSN/address/EIN in the JSON channel, ever.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("123-45-6789");
    expect(raw).not.toContain("12-3456789");
    expect(raw).not.toContain("Infinite Loop");
    expect(raw).not.toContain("ssn");

    const future = await api("GET", "/api/admin/annual-forms/w2?year=2099");
    expect((future.json() as { available: boolean }).available).toBe(false);

    const bad = await api("GET", "/api/admin/annual-forms/w2?year=abc");
    expect(bad.statusCode).toBe(400);
  });

  it("serves W-2 (Copy D + print packet) and W-3 PDFs on demand", async () => {
    // Copy D — the employer-records copy.
    const w2 = await api("GET", `/api/admin/annual-forms/w2/${acctA.employeeId}/pdf?year=2025`);
    expect(w2.statusCode, w2.body).toBe(200);
    expect(w2.headers["content-type"]).toContain("application/pdf");
    expect(w2.headers["content-disposition"]).toContain("copy-d");
    expect(w2.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect(await pdfStructure(w2.rawPayload)).toEqual({ pageCount: 1, fieldCount: 0 });

    // Print packet — the physical-furnishing route, consent-independent.
    const packet = await api(
      "GET",
      `/api/admin/annual-forms/w2/${acctA.employeeId}/print-packet?year=2025`,
    );
    expect(packet.statusCode, packet.body).toBe(200);
    expect(packet.headers["content-disposition"]).toContain("print-packet");
    expect(packet.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect(await pdfStructure(packet.rawPayload)).toEqual({ pageCount: 6, fieldCount: 0 });

    const w3 = await api("GET", "/api/admin/annual-forms/w3/pdf?year=2025");
    expect(w3.statusCode, w3.body).toBe(200);
    expect(w3.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect(await pdfStructure(w3.rawPayload)).toEqual({ pageCount: 1, fieldCount: 0 });

    // Gated + not-found paths.
    const gated = await api("GET", `/api/admin/annual-forms/w2/${acctA.employeeId}/pdf?year=2099`);
    expect(gated.statusCode).toBe(409);
    expect(gated.json()).toMatchObject({ error: "invalid_transition" });
    const missing = await api("GET", "/api/admin/annual-forms/w2/999999/pdf?year=2025");
    expect(missing.statusCode).toBe(404);
    const missingPacket = await api(
      "GET",
      "/api/admin/annual-forms/w2/999999/print-packet?year=2025",
    );
    expect(missingPacket.statusCode).toBe(404);
    const noYear = await api("GET", "/api/admin/annual-forms/w3/pdf?year=2020");
    expect(noYear.statusCode).toBe(404);
  });

  it("403s non-admins", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/api/admin/annual-forms/w2?year=2025",
      headers: await sessionFor(acctA.email),
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// W-2 electronic-delivery consent (PAY-19, D4; PAY-208: 26 CFR 31.6051-1(j))
// ---------------------------------------------------------------------------

/** PAY-208 (A6, OD1): the W-2 contact, set through the admin route. */
async function seedW2Contact() {
  return api("PUT", "/api/admin/company/w2-contact", {
    ...CONTACT,
    mailingAddress: CONTACT_ADDRESS,
  });
}

/** PAY-208 (A5): consent names the disclosure version it agrees to. */
const CONSENT_BODY = { disclosureVersion: NEW_VERSION };

/** PAY-208 (A5 + D-B): the version + a fresh code from the test PDF. */
async function consentBody(session: Record<string, string>) {
  const code = await accessCodeFor(t, session);
  return { ...CONSENT_BODY, ...(code !== undefined ? { accessCode: code } : {}) };
}

describe("W-2 electronic-delivery consent", () => {
  it("gates the PDF on consent, records it, and re-gates on withdrawal", async () => {
    const session = await sessionFor(acctA.email);

    // PAY-208 T1: the contact exists before the terms are read (A6); the
    // rendered 2026-10 terms name it ((j)(3)(v)(A)).
    // The status is asserted after the disclosure checks, so on the old code
    // this test fails on the disclosure text first.
    const contactPut = await seedW2Contact();

    // Status: not consented; the (j)(3) disclosures ride along, PII-free.
    const before = await t.app.inject({
      method: "GET",
      url: "/api/my/w2/consent",
      headers: session,
    });
    expect(before.statusCode, before.body).toBe(200);
    const beforeBody = before.json() as {
      consented: boolean;
      consentedAt: string | null;
      disclosureVersion: string;
      disclosures: string[];
    };
    expect(beforeBody.consented).toBe(false);
    expect(beforeBody.consentedAt).toBeNull();
    // PAY-208 T1 (fail-first): version "2026-10"; the federal-SME sentence
    // verbatim replaces the wrong "available on or before January 31" bullet;
    // one marker per 26 CFR 31.6051-1(j)(3)(ii)-(viii) item (+ (j)(2)(iii)).
    expect(beforeBody.disclosureVersion).toBe(NEW_VERSION);
    expect(beforeBody.disclosures.length).toBeGreaterThanOrEqual(9);
    const text = beforeBody.disclosures.join(" ");
    expect(text).toContain(SME_SENTENCE);
    expect(text).not.toContain(OLD_JAN31_PHRASE);
    expect(text).not.toContain("Pub 1141");
    const companyName = (await t.db.select({ n: company.legalName }).from(company).limit(1))[0]!.n;
    const markers = disclosureMarkers(text, companyName);
    expect(markers).toEqual(allMarkersTrue(markers));
    expect(contactPut.statusCode, contactPut.body).toBe(200);
    expect(JSON.stringify(beforeBody)).not.toContain("123-45-6789");

    // No consent → the download 409s with consent_required.
    const gated = await t.app.inject({
      method: "GET",
      url: "/api/my/w2/2025/pdf",
      headers: session,
    });
    expect(gated.statusCode).toBe(409);
    expect(gated.json()).toMatchObject({ error: "consent_required" });

    // Consent → active, timestamped, versioned, audited.
    const consented = await t.app.inject({
      method: "POST",
      url: "/api/my/w2/consent",
      headers: session,
      payload: await consentBody(session),
    });
    expect(consented.statusCode, consented.body).toBe(200);
    const consentedBody = consented.json() as { consented: boolean; consentedAt: string | null };
    expect(consentedBody.consented).toBe(true);
    expect(consentedBody.consentedAt).not.toBeNull();
    const rows = await t.db
      .select()
      .from(w2DeliveryConsents)
      .where(eq(w2DeliveryConsents.employeeId, acctA.employeeId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.withdrawnAt).toBeNull();
    expect(rows[0]?.disclosureVersion).toBe(NEW_VERSION);

    // The admin list reflects the flag (acctB stays paper).
    const adminList = await api("GET", "/api/admin/annual-forms/w2?year=2025");
    const adminRows = (adminList.json() as { w2s: { employeeId: number; consented: boolean }[] })
      .w2s;
    expect(adminRows.find((r) => r.employeeId === acctA.employeeId)?.consented).toBe(true);
    expect(adminRows.find((r) => r.employeeId === acctB.employeeId)?.consented).toBe(false);

    // The download works now — the flattened 6-page employee packet.
    const pdf = await t.app.inject({ method: "GET", url: "/api/my/w2/2025/pdf", headers: session });
    expect(pdf.statusCode, pdf.body).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect(await pdfStructure(pdf.rawPayload)).toEqual({ pageCount: 6, fieldCount: 0 });

    // Withdrawal: recorded at once (D4 consent); the download rule follows.
    const withdrawn = await t.app.inject({
      method: "DELETE",
      url: "/api/my/w2/consent",
      headers: session,
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect((withdrawn.json() as { consented: boolean }).consented).toBe(false);
    // PAY-206 review round D9 (26 CFR 31.6051-1(j)(6)): a year furnished
    // electronically (the download above) stays downloadable after withdrawal
    // through October 15 of the following year (next business day:
    // 2026-10-15, a Thursday); any year never furnished electronically is
    // re-gated at once. "Today" is the app clock (ISSUE_CLOCK), company-local.
    const reGatedOther = await t.app.inject({
      method: "GET",
      url: "/api/my/w2/2024/pdf",
      headers: session,
    });
    expect(reGatedOther.statusCode).toBe(409);
    expect(reGatedOther.json()).toMatchObject({ error: "consent_required" });
    const today = ISSUE_CLOCK().toISOString().slice(0, 10);
    expect(today <= "2026-10-15").toBe(true);
    const stillPosted = await t.app.inject({
      method: "GET",
      url: "/api/my/w2/2025/pdf",
      headers: session,
    });
    expect(stillPosted.statusCode, stillPosted.body).toBe(200);

    // Audit trail: consent + withdraw events for this employee.
    const audit = await t.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entity, "w2_consent"),
          eq(auditEvents.entityId, String(acctA.employeeId)),
        ),
      );
    expect(audit.map((a) => a.action)).toEqual(["w2_consent.consent", "w2_consent.withdraw"]);
  });

  it("is idempotent on repeat consent/withdraw and 404s for contractors", async () => {
    const session = await sessionFor(acctB.email);

    // Withdraw before any consent → not_found.
    const early = await t.app.inject({
      method: "DELETE",
      url: "/api/my/w2/consent",
      headers: session,
    });
    expect(early.statusCode).toBe(404);

    for (let i = 0; i < 2; i += 1) {
      const res = await t.app.inject({
        method: "POST",
        url: "/api/my/w2/consent",
        headers: session,
        payload: await consentBody(session),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as { consented: boolean }).consented).toBe(true);
    }
    for (let i = 0; i < 2; i += 1) {
      const res = await t.app.inject({
        method: "DELETE",
        url: "/api/my/w2/consent",
        headers: session,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as { consented: boolean }).consented).toBe(false);
    }
    // Repeat consent/withdraw did not stack duplicate audit rows: the second
    // consent was a no-op (already consented), the second withdraw too.
    const audit = await t.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entity, "w2_consent"),
          eq(auditEvents.entityId, String(acctB.employeeId)),
        ),
      );
    expect(audit.map((a) => a.action)).toEqual(["w2_consent.consent", "w2_consent.withdraw"]);

    // Contractors have no W-2 employee row → 404 on all consent endpoints.
    const contractor = await sessionFor(contractorUser.email);
    for (const method of ["GET", "POST", "DELETE"] as const) {
      const res = await t.app.inject({
        method,
        url: "/api/my/w2/consent",
        headers: contractor,
        ...(method === "POST" ? { payload: CONSENT_BODY } : {}),
      });
      expect(res.statusCode).toBe(404);
    }

    // No session → 401.
    const anon = await t.app.inject({ method: "GET", url: "/api/my/w2/consent" });
    expect(anon.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Employee self-service routes — own W-2 only, January gate
// ---------------------------------------------------------------------------

describe("my W-2 routes", () => {
  it("lists available years and serves the PDF for the employee's own W-2", async () => {
    const session = await sessionFor(acctA.email);

    // Consent first (withdrawn in the consent suite above) — idempotent.
    const consent = await t.app.inject({
      method: "POST",
      url: "/api/my/w2/consent",
      headers: session,
      payload: await consentBody(session),
    });
    expect(consent.statusCode, consent.body).toBe(200);

    const list = await t.app.inject({ method: "GET", url: "/api/my/w2", headers: session });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toEqual({
      w2s: [
        {
          year: 2025,
          availableOn: "2026-01-01",
          ready: true,
          corrected: false,
          downloadable: true,
          formCount: 1,
          // PAY-208 N1 ((j)(6)): Oct 15, 2026 is a Thursday; no corrected posting.
          accessThrough: "2026-10-15",
          // PAY-223 PR-2 (D-4): every version posted online.
          versions: await expMyVersions(t, acctA.employeeId, 2025, {
            current: "last",
            downloadable: true,
          }),
        },
      ],
      // PAY-208 (2.2b, OD5): no issued year still waiting for January.
      upcomingYear: null,
    });

    const pdf = await t.app.inject({
      method: "GET",
      url: "/api/my/w2/2025/pdf",
      headers: session,
    });
    expect(pdf.statusCode, pdf.body).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");

    // PAY-162: a year without runs and a not-yet-available year both answer
    // the same bare 409 (no enumeration, no ids).
    const noRuns = await t.app.inject({
      method: "GET",
      url: "/api/my/w2/2020/pdf",
      headers: session,
    });
    expect(noRuns.statusCode).toBe(409);
    expect(noRuns.json()).toEqual({ error: "w2_not_ready" });
    const gated = await t.app.inject({
      method: "GET",
      url: "/api/my/w2/2099/pdf",
      headers: session,
    });
    expect(gated.statusCode).toBe(409);
  });

  it("contractors see nothing and cannot fetch a W-2", async () => {
    const session = await sessionFor(contractorUser.email);
    const list = await t.app.inject({ method: "GET", url: "/api/my/w2", headers: session });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toEqual({ w2s: [], upcomingYear: null });
    const pdf = await t.app.inject({
      method: "GET",
      url: "/api/my/w2/2025/pdf",
      headers: session,
    });
    expect(pdf.statusCode).toBe(404);
  });

  it("401s without a session", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/my/w2" });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Reminders — annual rows fire tax_filing_due like any other filing
// ---------------------------------------------------------------------------

describe("annual filing reminders", () => {
  it("mails admins on the configured offsets and dedupes", async () => {
    // The W-2/W-3 row (due 2026-02-02) is unfiled; the 940 row is filed and
    // must never remind. Default offsets [14, 7, 0] → fire dates
    // 2026-01-19, 2026-01-26, 2026-02-02.
    const outboxCount = async () =>
      (
        await t.db
          .select()
          .from(emailOutbox)
          .where(eq(emailOutbox.eventType, EVENT_TYPE.taxFilingDue))
      ).length;

    expect(
      (await sendFilingReminders({ db: t.db, config: t.config }, { today: "2026-01-18" })).sent,
    ).toBe(0); // not a fire date
    expect(
      (await sendFilingReminders({ db: t.db, config: t.config }, { today: "2026-01-19" })).sent,
    ).toBe(1); // offset 14
    expect(
      (await sendFilingReminders({ db: t.db, config: t.config }, { today: "2026-01-19" })).sent,
    ).toBe(0); // re-tick: never twice
    expect(
      (await sendFilingReminders({ db: t.db, config: t.config }, { today: "2026-01-26" })).sent,
    ).toBe(1); // offset 7
    expect(
      (await sendFilingReminders({ db: t.db, config: t.config }, { today: "2026-02-02" })).sent,
    ).toBe(1); // offset 0 (due date)

    expect(await outboxCount()).toBe(3);
    const mails = await t.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.eventType, EVENT_TYPE.taxFilingDue));
    expect(mails[0]?.subject).toContain("W-2/W-3");
    expect(mails[0]?.subject).toContain("2025");
    expect((await annualFilingRow("w2_w3", 2025))?.remindersSent).toEqual([14, 7, 0]);
  });
});

// ---------------------------------------------------------------------------
// W-2 availability notices — once per tax year, employees only, no amounts
// ---------------------------------------------------------------------------

describe("sendW2AvailableNotices", () => {
  it("mails every W-2 employee with an account, exactly once per year", async () => {
    const sent = await sendW2AvailableNotices(
      { db: t.db, config: t.config },
      {
        today: "2026-01-05",
      },
    );
    expect(sent.sent).toBe(2); // the two account-linked employees; contractor excluded

    const mails = await t.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.eventType, EVENT_TYPE.w2Available));
    expect(mails).toHaveLength(2);
    expect(mails[0]?.subject).toContain("2025");
    expect(mails[0]?.bodyHtml).toContain("w2-available:2025");
    // Content rules: the notice states the year + log-in — never amounts/SSN.
    expect(mails[0]?.bodyHtml).not.toContain("8,000");
    expect(mails[0]?.bodyHtml).not.toContain("123-45-6789");
    // PAY-208 (j)(5)(i): acctA (consent "2026-10", covers 2025) gets the legal
    // notice — subject starts with the capitals phrase; acctB (withdrawn) gets
    // the paper courtesy notice — no phrase.
    const subjectOf = (userId: string) => mails.find((m) => m.userId === userId)?.subject ?? "";
    expect(subjectOf(acctA.userId).startsWith("IMPORTANT TAX RETURN DOCUMENT AVAILABLE")).toBe(
      true,
    );
    expect(subjectOf(acctB.userId)).not.toContain("IMPORTANT TAX RETURN DOCUMENT AVAILABLE");

    // Once per year: the dedupe record lives in app_settings.
    const again = await sendW2AvailableNotices(
      { db: t.db, config: t.config },
      {
        today: "2026-01-06",
      },
    );
    expect(again.sent).toBe(0);
    const settings = await t.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, "w2_available_notified_years"));
    expect(settings[0]?.value).toEqual([2025]); // 2026 has runs but is NOT yet available
  });
});

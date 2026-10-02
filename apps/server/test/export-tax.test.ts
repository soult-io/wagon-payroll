/**
 * PAY-197: tax-deposits + tax-filings export endpoints for the Accountant's
 * read-only MCP (mcp-wagon-payroll). Same bearer token, read-only, audited.
 * Covers: auth (401/503), superseded excluded by default, federal → form 941
 * and state → null, exact integer cents (0.29, 1234567.89), EFTPS
 * confirmation verbatim (leading zero), derived periodEnd (month, quarter,
 * leap February), canonical order and byte-determinism, range echo,
 * annual quarter → null, adjustment `note` absent, no EIN, audit rows.
 * All data is synthetic. Real SQL via the PGlite harness.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditEvents, company, taxAdjustments, taxDeposits, taxFilings } from "@payroll/db";
import { encryptField } from "../src/crypto/field-encryption.js";
import { EXPORT_ACTOR } from "../src/routes/export.js";
import { createTestApp, type TestContext } from "./helpers.js";

const TOKEN = "test-export-token-pay197-0123456789";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const EIN = "98-7654321";

let t: TestContext;

const WS_941_Q3 = {
  form: "941",
  year: 2026,
  quarter: 3,
  line1Employees: 1,
  line2Wages: "12000.00",
  line3FederalWithheld: "930.39",
  line16: { month1: "1234.56", month2: "1234.56", month3: "1234.56", deMinimis: false },
};
const WS_940 = { form: "940", year: 2026, futaRate: "0.006", line3TotalPayments: "48000.00" };

async function get(url: string) {
  return t.app.inject({ method: "GET", url, headers: AUTH });
}

beforeAll(async () => {
  t = await createTestApp({ exportToken: TOKEN });
  await t.db.insert(company).values({
    legalName: "Example Corp",
    ein: encryptField(EIN, t.config.encryptionKey),
  });

  // Inserted out of canonical order on purpose: the endpoint must sort.
  await t.db.insert(taxDeposits).values([
    {
      jurisdiction: "federal",
      periodStart: "2026-09-01",
      periodKind: "month",
      amount: "1234567.89",
      dueDate: "2026-10-15",
      status: "pending",
      remindersSent: [5],
      createdBy: "scheduler",
    },
    {
      jurisdiction: "federal",
      periodStart: "2026-08-01",
      periodKind: "month",
      amount: "1234.56",
      dueDate: "2026-09-15",
      status: "deposited",
      depositedOn: "2026-08-20",
      // Synthetic acknowledgment number; the leading zero must survive.
      eftpsConfirmation: "012345678901234",
      createdBy: "scheduler",
    },
    {
      jurisdiction: "CA",
      periodStart: "2026-07-01",
      periodKind: "quarter",
      amount: "0.29",
      dueDate: "2026-10-31",
      status: "overdue",
      createdBy: "scheduler",
    },
    {
      jurisdiction: "CA",
      periodStart: "2026-07-01",
      periodKind: "month",
      amount: "10.00",
      dueDate: "2026-08-15",
      status: "superseded",
      supersededAt: new Date("2026-08-02T03:04:05.000Z"),
      createdBy: "scheduler",
    },
    {
      jurisdiction: "federal",
      periodStart: "2026-07-01",
      periodKind: "month",
      amount: "0.00",
      dueDate: "2026-08-17",
      status: "deposited",
      depositedOn: "2026-08-14",
      eftpsConfirmation: "270000000000001",
      createdBy: "scheduler",
    },
    {
      jurisdiction: "NY",
      periodStart: "2026-10-01",
      periodKind: "quarter",
      amount: "5.00",
      dueDate: "2027-01-31",
      status: "pending",
      createdBy: "scheduler",
    },
    {
      jurisdiction: "federal",
      periodStart: "2028-02-01",
      periodKind: "month",
      amount: "1.00",
      dueDate: "2028-03-15",
      status: "pending",
      createdBy: "scheduler",
    },
  ]);

  const filings = await t.db
    .insert(taxFilings)
    .values([
      {
        formType: "w2_w3",
        year: 2026,
        quarter: 0,
        dueDate: "2027-02-01",
        status: "not_started",
        createdBy: "scheduler",
      },
      {
        formType: "941",
        year: 2026,
        quarter: 3,
        dueDate: "2026-11-02",
        status: "ready",
        worksheet: WS_941_Q3,
        worksheetHash: "a".repeat(64),
        createdBy: "scheduler",
      },
      {
        formType: "941",
        year: 2026,
        quarter: 2,
        dueDate: "2026-07-31",
        status: "filed",
        worksheet: { form: "941", year: 2026, quarter: 2 },
        worksheetHash: "b".repeat(64),
        filedOn: "2026-07-20",
        filingMethod: "letterstream",
        filingReference: "LS-000123",
        createdBy: "scheduler",
      },
      {
        formType: "940",
        year: 2026,
        quarter: 0,
        dueDate: "2027-02-01",
        status: "ready",
        worksheet: WS_940,
        worksheetHash: "c".repeat(64),
        createdBy: "scheduler",
      },
      {
        formType: "941",
        year: 2025,
        quarter: 4,
        dueDate: "2026-02-02",
        status: "filed",
        createdBy: "scheduler",
      },
    ])
    .returning({ id: taxFilings.id, formType: taxFilings.formType, quarter: taxFilings.quarter });
  const q2 = filings.find((f) => f.formType === "941" && f.quarter === 2)!.id;

  await t.db.insert(taxAdjustments).values([
    {
      filingId: q2,
      kind: "penalty",
      noticeDate: null,
      amountDue: "1.00",
      note: "SECRET-NOTE-TEXT",
    },
    {
      filingId: q2,
      kind: "CP220",
      noticeDate: "2026-09-10",
      amountDue: "1234567.89",
      abatedAmount: "0.29",
      amountPaid: "100.10",
      paidOn: "2026-09-20",
      eftpsConfirmation: "001112223334445",
      note: "SECRET-NOTE-TEXT",
    },
    {
      filingId: q2,
      kind: "interest",
      noticeDate: "2026-08-01",
      amountDue: "2.50",
      note: "",
    },
  ]);
});

afterAll(async () => {
  await t.close();
});

describe("tax export auth", () => {
  for (const path of ["/api/export/tax-deposits", "/api/export/tax-filings?year=2026"]) {
    it(`${path}: 401 without a token or with a wrong token`, async () => {
      const none = await t.app.inject({ method: "GET", url: path });
      expect(none.statusCode).toBe(401);
      const wrong = await t.app.inject({
        method: "GET",
        url: path,
        headers: { authorization: "Bearer nope" },
      });
      expect(wrong.statusCode).toBe(401);
    });

    it(`${path}: 503 when no export-token is configured`, async () => {
      const unconfigured = await createTestApp();
      try {
        const res = await unconfigured.app.inject({ method: "GET", url: path, headers: AUTH });
        expect(res.statusCode).toBe(503);
        expect(res.json().error).toBe("export_disabled");
      } finally {
        await unconfigured.close();
      }
    });
  }
});

describe("GET /api/export/tax-deposits", () => {
  it("returns live rows in canonical order with exact cents, form, periodEnd, confirmation", async () => {
    const res = await get("/api/export/tax-deposits?from=2026-07-01&to=2026-09-30");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const body = res.json();
    expect(body.range).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(body.deposits).toEqual([
      {
        jurisdiction: "CA",
        form: null,
        periodKind: "quarter",
        periodStart: "2026-07-01",
        periodEnd: "2026-09-30",
        amountCents: 29,
        dueDate: "2026-10-31",
        status: "overdue",
        depositedOn: null,
        confirmation: null,
        supersededAt: null,
      },
      {
        jurisdiction: "federal",
        form: "941",
        periodKind: "month",
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
        amountCents: 0,
        dueDate: "2026-08-17",
        status: "deposited",
        depositedOn: "2026-08-14",
        confirmation: "270000000000001",
        supersededAt: null,
      },
      {
        jurisdiction: "federal",
        form: "941",
        periodKind: "month",
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
        amountCents: 123456,
        dueDate: "2026-09-15",
        status: "deposited",
        depositedOn: "2026-08-20",
        confirmation: "012345678901234",
        supersededAt: null,
      },
      {
        jurisdiction: "federal",
        form: "941",
        periodKind: "month",
        periodStart: "2026-09-01",
        periodEnd: "2026-09-30",
        amountCents: 123456789,
        dueDate: "2026-10-15",
        status: "pending",
        depositedOn: null,
        confirmation: null,
        supersededAt: null,
      },
    ]);
  });

  it("range is inclusive on period_start at both ends", async () => {
    const body = (await get("/api/export/tax-deposits?from=2026-08-01&to=2026-09-01")).json();
    expect(body.deposits.map((d: { periodStart: string }) => d.periodStart)).toEqual([
      "2026-08-01",
      "2026-09-01",
    ]);
  });

  it("derives periodEnd for a Q4 quarter row and a leap-year February", async () => {
    const body = (await get("/api/export/tax-deposits?from=2026-10-01&to=2028-12-31")).json();
    expect(
      body.deposits.map((d: { periodStart: string; periodEnd: string }) => [
        d.periodStart,
        d.periodEnd,
      ]),
    ).toEqual([
      ["2026-10-01", "2026-12-31"],
      ["2028-02-01", "2028-02-29"],
    ]);
  });

  it("omitted from/to: all live rows, range echoes null", async () => {
    const body = (await get("/api/export/tax-deposits")).json();
    expect(body.range).toEqual({ from: null, to: null });
    expect(body.deposits).toHaveLength(6);
    expect(body.deposits.some((d: { status: string }) => d.status === "superseded")).toBe(false);
  });

  it("superseded rows only with includeSuperseded=true, with supersededAt", async () => {
    const body = (
      await get("/api/export/tax-deposits?from=2026-07-01&to=2026-07-01&includeSuperseded=true")
    ).json();
    expect(
      body.deposits.map((d: { jurisdiction: string; periodKind: string }) => [
        d.jurisdiction,
        d.periodKind,
      ]),
    ).toEqual([
      ["CA", "month"],
      ["CA", "quarter"],
      ["federal", "month"],
    ]);
    expect(body.deposits[0]).toMatchObject({
      status: "superseded",
      amountCents: 1000,
      supersededAt: "2026-08-02T03:04:05.000Z",
    });
    const off = (
      await get("/api/export/tax-deposits?from=2026-07-01&to=2026-07-01&includeSuperseded=false")
    ).json();
    expect(off.deposits).toHaveLength(2);
  });

  it("filters by jurisdiction", async () => {
    const fed = (await get("/api/export/tax-deposits?jurisdiction=federal")).json();
    expect(fed.deposits).toHaveLength(4);
    expect(fed.deposits.every((d: { form: string }) => d.form === "941")).toBe(true);
    const ca = (await get("/api/export/tax-deposits?jurisdiction=CA")).json();
    expect(ca.deposits).toHaveLength(1);
    expect(ca.deposits[0].form).toBeNull();
  });

  it("carries no internal ids, reminders, creator, or EIN", async () => {
    const res = await get("/api/export/tax-deposits?includeSuperseded=true");
    for (const d of res.json().deposits) {
      expect(Object.keys(d).sort()).toEqual(
        [
          "amountCents",
          "confirmation",
          "depositedOn",
          "dueDate",
          "form",
          "jurisdiction",
          "periodEnd",
          "periodKind",
          "periodStart",
          "status",
          "supersededAt",
        ].sort(),
      );
    }
    expect(res.body).not.toContain(EIN);
    expect(res.body).not.toContain("scheduler");
    expect(res.body).not.toContain("legalName");
  });

  it("is byte-deterministic across identical calls", async () => {
    const url = "/api/export/tax-deposits?includeSuperseded=true";
    expect((await get(url)).body).toBe((await get(url)).body);
  });

  it("rejects bad dates, inverted ranges, bad jurisdiction, bad includeSuperseded", async () => {
    const cases: [string, string][] = [
      ["/api/export/tax-deposits?from=2026-1-1", "invalid_date"],
      ["/api/export/tax-deposits?to=20260930", "invalid_date"],
      ["/api/export/tax-deposits?from=2026-09-30&to=2026-07-01", "invalid_range"],
      ["/api/export/tax-deposits?jurisdiction=ca", "invalid_jurisdiction"],
      ["/api/export/tax-deposits?jurisdiction=FEDERAL", "invalid_jurisdiction"],
      ["/api/export/tax-deposits?jurisdiction=CAL", "invalid_jurisdiction"],
      ["/api/export/tax-deposits?includeSuperseded=yes", "invalid_include_superseded"],
    ];
    for (const [url, code] of cases) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error, url).toBe(code);
    }
  });

  it("each successful call writes one audit row with the row count", async () => {
    const before = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actorId, EXPORT_ACTOR));
    await get("/api/export/tax-deposits?from=2026-08-01&to=2026-08-31&jurisdiction=federal");
    const after = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actorId, EXPORT_ACTOR));
    expect(after).toHaveLength(before.length + 1);
    const row = after.find((r) => !before.some((b) => b.id === r.id))!;
    expect(row).toMatchObject({
      action: "export.tax_deposits",
      entity: "export",
      entityId: "2026-08-01..2026-08-31",
    });
    expect(row.after).toEqual({
      jurisdiction: "federal",
      includeSuperseded: false,
      depositCount: 1,
    });
  });

  it("a rejected request writes no audit row", async () => {
    const before = await t.db.select().from(auditEvents);
    await get("/api/export/tax-deposits?jurisdiction=zz");
    const after = await t.db.select().from(auditEvents);
    expect(after).toHaveLength(before.length);
  });
});

describe("GET /api/export/tax-filings", () => {
  it("returns the year's rows ordered by form, quarter; annual quarter is null", async () => {
    const res = await get("/api/export/tax-filings?year=2026");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.year).toBe(2026);
    expect(
      body.filings.map((f: { form: string; quarter: number | null }) => [f.form, f.quarter]),
    ).toEqual([
      ["940", null],
      ["941", 2],
      ["941", 3],
      ["w2_w3", null],
    ]);
    expect(body.filings.every((f: { year: number }) => f.year === 2026)).toBe(true);
  });

  it("passes the frozen worksheet and hash through verbatim", async () => {
    const body = (await get("/api/export/tax-filings?year=2026&form=941")).json();
    expect(body.filings).toHaveLength(2);
    expect(body.filings[1]).toEqual({
      form: "941",
      year: 2026,
      quarter: 3,
      dueDate: "2026-11-02",
      status: "ready",
      filedOn: null,
      filingMethod: null,
      filingReference: null,
      worksheetHash: "a".repeat(64),
      worksheet: WS_941_Q3,
      adjustments: [],
    });
    const fed940 = (await get("/api/export/tax-filings?year=2026&form=940")).json();
    expect(fed940.filings[0].worksheet).toEqual(WS_940);
    const w3 = (await get("/api/export/tax-filings?year=2026&form=w2_w3")).json();
    expect(w3.filings[0]).toMatchObject({ worksheet: null, worksheetHash: null, quarter: null });
  });

  it("filed row carries filing fields; adjustments in cents, ordered, without note", async () => {
    const res = await get("/api/export/tax-filings?year=2026&form=941");
    const q2 = res.json().filings[0];
    expect(q2).toMatchObject({
      quarter: 2,
      status: "filed",
      filedOn: "2026-07-20",
      filingMethod: "letterstream",
      filingReference: "LS-000123",
    });
    expect(q2.adjustments).toEqual([
      {
        kind: "interest",
        noticeDate: "2026-08-01",
        amountDueCents: 250,
        abatedAmountCents: 0,
        amountPaidCents: 0,
        paidOn: null,
        confirmation: null,
      },
      {
        kind: "CP220",
        noticeDate: "2026-09-10",
        amountDueCents: 123456789,
        abatedAmountCents: 29,
        amountPaidCents: 10010,
        paidOn: "2026-09-20",
        confirmation: "001112223334445",
      },
      {
        kind: "penalty",
        noticeDate: null,
        amountDueCents: 100,
        abatedAmountCents: 0,
        amountPaidCents: 0,
        paidOn: null,
        confirmation: null,
      },
    ]);
    expect(res.body).not.toContain("SECRET-NOTE-TEXT");
    expect(res.body).not.toContain('"note"');
    expect(res.body).not.toContain(EIN);
    expect(res.body).not.toContain("scheduler");
  });

  it("a year with no rows returns an empty list", async () => {
    const body = (await get("/api/export/tax-filings?year=2024")).json();
    expect(body).toEqual({ year: 2024, filings: [] });
  });

  it("is byte-deterministic across identical calls", async () => {
    const url = "/api/export/tax-filings?year=2026";
    expect((await get(url)).body).toBe((await get(url)).body);
  });

  it("rejects a missing or bad year and a bad form", async () => {
    const cases: [string, string][] = [
      ["/api/export/tax-filings", "invalid_year"],
      ["/api/export/tax-filings?year=26", "invalid_year"],
      ["/api/export/tax-filings?year=2026x", "invalid_year"],
      ["/api/export/tax-filings?year=2026&form=w2", "invalid_form"],
      ["/api/export/tax-filings?year=2026&form=1099", "invalid_form"],
    ];
    for (const [url, code] of cases) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error, url).toBe(code);
    }
  });

  it("each successful call writes one audit row with the filing count", async () => {
    const before = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actorId, EXPORT_ACTOR));
    await get("/api/export/tax-filings?year=2026&form=941");
    const after = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actorId, EXPORT_ACTOR));
    expect(after).toHaveLength(before.length + 1);
    const row = after.find((r) => !before.some((b) => b.id === r.id))!;
    expect(row).toMatchObject({ action: "export.tax_filings", entity: "export", entityId: "2026" });
    expect(row.after).toEqual({ year: 2026, form: "941", filingCount: 2 });
  });
});

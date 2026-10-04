/**
 * PAY-40 integration tests — the admin calendar aggregation endpoint
 * (GET /api/admin/calendar?year=&month=). Real SQL via the PGlite harness;
 * fixtures are direct row inserts (the endpoint is read-only), the route
 * goes through app.inject with real sessions.
 *
 * Covers: RBAC (401/403), query validation (400), the seeded company pay
 * schedule projected onto any month, payroll-run pay dates (void excluded,
 * link to the run detail), per-employee schedule overrides, contractor
 * recurring templates (invoice generation day — fixed and last_day — and
 * the following-month payment-due day, with the starts_on/ends_on window
 * mirrored from the daily sweep), deposit due/deposited dates across month
 * boundaries, filing due/filed dates (941 quarterly + 940 annual labels),
 * projected filing events (generates + due for quarters without tax_filings),
 * W-8 expiries, and date-sorted output.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  company,
  contractorDetails,
  contractorRecurringInvoices,
  employees,
  payrollRuns,
  paySchedules,
  seedDatabase,
  taxDeposits,
  taxFilings,
  type SeedDb,
} from "@payroll/db";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";
import { annualDueDate } from "../src/filings/annual.js";

interface TestEvent {
  date: string;
  kind: string;
  label: string;
  detail?: string;
  link: { name: string; params?: Record<string, string | number> } | null;
}

let t: TestContext;
let ADMIN: Record<string, string>;

let employeeAId: number;
let contractorBId: number;
let runPublicId: string;
let filing940Id: number;
let depositFebId: number;

async function calendar(
  year: number | string,
  month: number | string,
): Promise<{ statusCode: number; events: TestEvent[]; body: string }> {
  const res = await t.app.inject({
    method: "GET",
    url: `/api/admin/calendar?year=${year}&month=${month}`,
    headers: ADMIN,
  });
  const events = res.statusCode === 200 ? (res.json() as { events: TestEvent[] }).events : [];
  return { statusCode: res.statusCode, events, body: res.body };
}

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "calendar-admin@test.dev", role: "admin" });
  const session = await login(t, admin.email, TEST_PASSWORD);
  ADMIN = sessionHeader(session.sessionCookie);

  const companyId = (await t.db.select({ id: company.id }).from(company).limit(1))[0]!.id;

  // Employee A — W-2, has an issued March run + a schedule override.
  employeeAId = (
    await t.db
      .insert(employees)
      .values({ companyId, legalName: "Calendar Employee A", hireDate: "2025-01-01" })
      .returning()
  )[0]!.id;

  const run = (
    await t.db
      .insert(payrollRuns)
      .values({
        employeeId: employeeAId,
        periodStart: "2026-03-01",
        periodEnd: "2026-03-31",
        payDate: "2026-03-15",
        status: "issued",
        runSnapshot: {},
      })
      .returning()
  )[0]!;
  runPublicId = run.publicId;

  // A void run never lands on the calendar (it releases the period slot).
  await t.db.insert(payrollRuns).values({
    employeeId: employeeAId,
    periodStart: "2026-02-01",
    periodEnd: "2026-02-28",
    payDate: "2026-03-20",
    status: "void",
    runSnapshot: {},
  });

  // Per-employee schedule override: paid on the 25th.
  await t.db.insert(paySchedules).values({
    employeeId: employeeAId,
    frequency: "monthly",
    draftDayOfMonth: 15,
    payDayOfMonth: 25,
    active: true,
  });

  // Contractor B — active fixed-day template + expiring W-8BEN.
  contractorBId = (
    await t.db
      .insert(employees)
      .values({
        companyId,
        legalName: "Calendar Contractor B",
        hireDate: "2025-01-01",
        employmentType: "1099",
      })
      .returning()
  )[0]!.id;
  await t.db.insert(contractorDetails).values({
    employeeId: contractorBId,
    taxStatus: "nonresident",
    entityType: "individual",
    taxForm: "w8ben",
    formCollectedAt: "2023-04-01",
    formExpiresAt: "2026-03-31",
  });
  await t.db.insert(contractorRecurringInvoices).values({
    employeeId: contractorBId,
    description: "Monthly retainer — {month}",
    amount: "2000.00",
    invoiceDay: "fixed",
    invoiceDayOfMonth: 10,
    payDayOfMonth: 5,
    active: true,
    startsOn: "2026-01-01",
  });

  // Contractor C — last_day template that has not started yet in Q1 2026.
  const contractorCId = (
    await t.db
      .insert(employees)
      .values({
        companyId,
        legalName: "Calendar Contractor C",
        hireDate: "2025-01-01",
        employmentType: "1099",
      })
      .returning()
  )[0]!.id;
  await t.db.insert(contractorRecurringInvoices).values({
    employeeId: contractorCId,
    description: "Design — {month}",
    amount: "1500.00",
    invoiceDay: "last_day",
    payDayOfMonth: 12,
    active: true,
    startsOn: "2026-02-01",
    endsOn: "2026-02-15", // ends mid-February: Feb's last-day invoice (28th) is out of window
  });

  // Deposits: February period pending (due in March); January period
  // deposited late (due in February, deposited in March).
  depositFebId = (
    await t.db
      .insert(taxDeposits)
      .values({
        jurisdiction: "federal",
        periodStart: "2026-02-01",
        amount: "1234.56",
        dueDate: "2026-03-16",
        status: "pending",
      })
      .returning()
  )[0]!.id;
  await t.db.insert(taxDeposits).values({
    jurisdiction: "federal",
    periodStart: "2026-01-01",
    amount: "1111.00",
    dueDate: "2026-02-16",
    status: "deposited",
    depositedOn: "2026-03-02",
    eftpsConfirmation: "EFTPS-JAN",
  });

  // Filings: 2025 Form 940 (annual, quarter 0) filed late January, due
  // February 2; 2026 Q1 Form 941 due April 30.
  filing940Id = (
    await t.db
      .insert(taxFilings)
      .values({
        formType: "940",
        year: 2025,
        quarter: 0,
        dueDate: "2026-02-02",
        status: "filed",
        filedOn: "2026-01-28",
        filingMethod: "letterstream",
        filingReference: "LS-940-2025",
      })
      .returning()
  )[0]!.id;
  await t.db.insert(taxFilings).values({
    formType: "941",
    year: 2026,
    quarter: 1,
    dueDate: "2026-04-30",
    status: "not_started",
  });
}, 120_000);

afterAll(async () => {
  await t.close();
});

describe("GET /api/admin/calendar — access and validation", () => {
  it("401s without a session and 403s non-admins", async () => {
    const anon = await t.app.inject({
      method: "GET",
      url: "/api/admin/calendar?year=2026&month=3",
    });
    expect(anon.statusCode).toBe(401);

    const employee = await inviteAndOnboard(t, { email: "calendar-employee@test.dev" });
    const session = await login(t, employee.email, TEST_PASSWORD);
    const res = await t.app.inject({
      method: "GET",
      url: "/api/admin/calendar?year=2026&month=3",
      headers: sessionHeader(session.sessionCookie),
    });
    expect(res.statusCode).toBe(403);
  });

  it("400s on missing or out-of-range year/month", async () => {
    for (const url of [
      "/api/admin/calendar",
      "/api/admin/calendar?year=2026",
      "/api/admin/calendar?month=3",
      "/api/admin/calendar?year=2026&month=13",
      "/api/admin/calendar?year=2026&month=0",
      "/api/admin/calendar?year=abc&month=3",
      "/api/admin/calendar?year=2019&month=3",
    ]) {
      const res = await t.app.inject({ method: "GET", url, headers: ADMIN });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error).toBe("invalid_query");
    }
  });
});

describe("GET /api/admin/calendar — aggregation", () => {
  it("projects the current pay schedules onto an otherwise empty month", async () => {
    // Schedules are CURRENT config projected onto any month — the company
    // default (15th) and employee A's override (25th) both appear, even for
    // a month long before the fixtures existed.
    const { statusCode, events } = await calendar(2020, 1);
    expect(statusCode).toBe(200);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      date: "2020-01-15",
      kind: "payday_scheduled",
      label: "Scheduled payday (company schedule)",
      link: { name: "admin-payroll" },
    });
    expect(events[1]).toMatchObject({
      date: "2020-01-25",
      kind: "payday_scheduled",
      label: "Scheduled payday — Calendar Employee A",
    });
  });

  it("aggregates March 2026 across every source, date-sorted", async () => {
    const { statusCode, events, body } = await calendar(2026, 3);
    expect(statusCode, body).toBe(200);

    // Sorted by date ascending.
    const dates = events.map((e) => e.date);
    expect(dates).toEqual([...dates].sort());
    for (const date of dates) expect(date.startsWith("2026-03-")).toBe(true);

    // Contractor payment due on the 5th (February period's pay day).
    expect(events).toContainEqual(
      expect.objectContaining({
        date: "2026-03-05",
        kind: "contractor_payment",
        label: "Contractor payment due — Calendar Contractor B",
        link: expect.objectContaining({
          name: "admin-contractor-detail",
          params: { employeeId: contractorBId },
        }),
      }),
    );

    // Invoice generation day (fixed day 10).
    const invoice = events.find((e) => e.kind === "contractor_invoice");
    expect(invoice).toMatchObject({
      date: "2026-03-10",
      label: "Invoice generates — Calendar Contractor B",
      detail: "Monthly retainer — March",
    });

    // Scheduled paydays: company default (15th) + employee override (25th).
    const scheduled = events.filter((e) => e.kind === "payday_scheduled");
    expect(scheduled.map((e) => e.date).sort()).toEqual(["2026-03-15", "2026-03-25"]);
    const override = scheduled.find((e) => e.date === "2026-03-25");
    expect(override).toMatchObject({
      label: "Scheduled payday — Calendar Employee A",
      link: { name: "admin-employee-detail", params: { employeeId: employeeAId } },
    });

    // The issued run's pay date links to the run detail; the void run
    // (pay date 2026-03-20) never appears.
    const runEvent = events.find((e) => e.kind === "payday_run");
    expect(runEvent).toMatchObject({
      date: "2026-03-15",
      label: "Payday — Calendar Employee A",
      detail: "Run issued",
      link: { name: "admin-payroll-run", params: { publicId: runPublicId } },
    });
    expect(events.some((e) => e.date === "2026-03-20")).toBe(false);

    // Deposits: February period due the 16th; January period deposited late.
    expect(events).toContainEqual(
      expect.objectContaining({
        date: "2026-03-16",
        kind: "deposit_due",
        label: "941 deposit due — February 2026",
        // PAY-36: deposit events open the deposit detail view.
        link: { name: "admin-deposit-detail", params: { id: depositFebId } },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        date: "2026-03-02",
        kind: "deposit_made",
        label: "941 deposit made — January 2026",
        detail: "EFTPS EFTPS-JAN",
      }),
    );

    // W-8BEN expiry on the last day of March.
    expect(events).toContainEqual(
      expect.objectContaining({
        date: "2026-03-31",
        kind: "w8_expiry",
        label: "W-8BEN expires — Calendar Contractor B",
      }),
    );

    // Contractor C's template is out of window in March (ended 2026-02-15).
    expect(events.some((e) => e.label.includes("Contractor C"))).toBe(false);
  });

  it("shows filing due/filed dates in their own months with per-form labels", async () => {
    const jan = await calendar(2026, 1);
    expect(jan.events).toContainEqual(
      expect.objectContaining({
        date: "2026-01-28",
        kind: "filing_filed",
        label: "Form 940 2025 filed",
        detail: "LS-940-2025",
        link: { name: "admin-filing", params: { id: filing940Id } },
      }),
    );

    const feb = await calendar(2026, 2);
    expect(feb.events).toContainEqual(
      expect.objectContaining({
        date: "2026-02-02",
        kind: "filing_due",
        label: "Form 940 2025 due",
        detail: "filed",
      }),
    );
    // January deposit was due in February.
    expect(feb.events).toContainEqual(
      expect.objectContaining({ date: "2026-02-16", kind: "deposit_due" }),
    );
    // Contractor C's last_day template never fires: the Feb invoice date
    // (2026-02-28) falls after ends_on (2026-02-15).
    expect(feb.events.some((e) => e.label.includes("Contractor C"))).toBe(false);

    const apr = await calendar(2026, 4);
    expect(apr.events).toContainEqual(
      expect.objectContaining({
        date: "2026-04-30",
        kind: "filing_due",
        label: "Form 941 Q1 2026 due",
      }),
    );
  });

  describe("projected filing events", () => {
    // PAY-219: the service decides "future" from the real clock, so these
    // cases pin it (Date only) and use literal years. Expected due dates come
    // from the Form 941 rule, not the app: Q1 is due April 30; a due date on
    // a Saturday, Sunday or legal holiday moves to the next business day
    // (Instructions for Form 941, "When Must You File?"; IRC 7503).
    // 2027-04-30 is a Friday -> 2027-04-30. 2028-04-30 is a Sunday -> Monday
    // 2028-05-01 (not a federal legal holiday).
    const PINNED_NOW = new Date("2026-10-04T12:00:00Z");
    async function futureQ1Run(year: number, legalName: string): Promise<void> {
      const companyId = (await t.db.select({ id: company.id }).from(company).limit(1))[0]!.id;
      const employeeId = (
        await t.db
          .insert(employees)
          .values({ companyId, legalName, hireDate: "2025-01-01" })
          .returning()
      )[0]!.id;
      await t.db.insert(payrollRuns).values({
        employeeId,
        periodStart: `${year}-01-01`,
        periodEnd: `${year}-03-31`,
        payDate: `${year}-02-15`,
        status: "issued",
        runSnapshot: {},
      });
    }

    it("FUTURE quarter with issued run and no tax_filings row: filing_generates on quarterEnd+1 and filing_due_projected in due month", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: PINNED_NOW });
      try {
        const year = 2027;
        const quarter = 1;
        const generatesDate = "2027-04-01";
        const dueDate = "2027-04-30";
        expect(new Date(`${dueDate}T00:00:00Z`).getUTCDay()).toBe(5); // Friday: no roll

        await futureQ1Run(year, "Future Employee");

        const apr = await calendar(year, 4);
        expect(apr.events).toContainEqual(
          expect.objectContaining({
            date: generatesDate,
            kind: "filing_generates",
            label: `Form 941 Q${quarter} ${year} generates`,
            detail: "Created by the daily filing sync",
          }),
        );
        expect(apr.events).toContainEqual(
          expect.objectContaining({
            date: dueDate,
            kind: "filing_due_projected",
            label: `Form 941 Q${quarter} ${year} due (projected)`,
            detail: "Projected — filing not generated yet",
          }),
        );

        expect(apr.events.filter((e) => e.kind === "filing_due_projected")).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("FUTURE quarter whose April 30 is a Sunday (Q1 2028): projected due rolls to Monday May 1", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: PINNED_NOW });
      try {
        const year = 2028;
        const quarter = 1;
        const generatesDate = "2028-04-01";
        const dueDate = "2028-05-01";
        expect(new Date("2028-04-30T00:00:00Z").getUTCDay()).toBe(0); // Sunday
        expect(new Date(`${dueDate}T00:00:00Z`).getUTCDay()).toBe(1); // Monday

        await futureQ1Run(year, "Future Employee 2028");

        const apr = await calendar(year, 4);
        expect(apr.events).toContainEqual(
          expect.objectContaining({
            date: generatesDate,
            kind: "filing_generates",
            label: `Form 941 Q${quarter} ${year} generates`,
          }),
        );
        expect(apr.events.filter((e) => e.kind === "filing_due_projected")).toHaveLength(0);

        const may = await calendar(year, 5);
        expect(may.events).toContainEqual(
          expect.objectContaining({
            date: dueDate,
            kind: "filing_due_projected",
            label: `Form 941 Q${quarter} ${year} due (projected)`,
            detail: "Projected — filing not generated yet",
          }),
        );
        expect(may.events.filter((e) => e.kind === "filing_due_projected")).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("Same quarter WITH a tax_filings row: no filing_generates / filing_due_projected, only real filing_due", async () => {
      const companyId = (await t.db.select({ id: company.id }).from(company).limit(1))[0]!.id;
      const futureEmployeeId = (
        await t.db
          .insert(employees)
          .values({ companyId, legalName: "Future Employee 2", hireDate: "2025-01-01" })
          .returning()
      )[0]!.id;

      const year = new Date().getFullYear() + 1;
      const quarter = 2;
      const payDate = `${year}-05-15`;
      const periodStart = `${year}-04-01`;
      const periodEnd = `${year}-06-30`;
      const dueDate = `${year}-07-31`;

      await t.db.insert(payrollRuns).values({
        employeeId: futureEmployeeId,
        periodStart,
        periodEnd,
        payDate,
        status: "issued",
        runSnapshot: {},
      });

      await t.db.insert(taxFilings).values({
        formType: "941",
        year,
        quarter,
        dueDate,
        status: "not_started",
      });

      const jun = await calendar(year, 6);
      expect(jun.events.filter((e) => e.kind === "filing_generates")).toHaveLength(0);
      expect(jun.events.filter((e) => e.kind === "filing_due_projected")).toHaveLength(0);

      const jul = await calendar(year, 7);
      expect(jul.events).toContainEqual(
        expect.objectContaining({
          date: dueDate,
          kind: "filing_due",
          label: `Form 941 Q${quarter} ${year} due`,
        }),
      );
      expect(jul.events.filter((e) => e.kind === "filing_due_projected")).toHaveLength(0);
    });

    it("Quarter with no issued runs: no projected events", async () => {
      const year = new Date().getFullYear() + 1;
      const quarter = 3;

      const aug = await calendar(year, 8);
      expect(aug.events.filter((e) => e.kind === "filing_generates")).toHaveLength(0);
      expect(aug.events.filter((e) => e.kind === "filing_due_projected")).toHaveLength(0);

      const sep = await calendar(year, 9);
      expect(sep.events.filter((e) => e.kind === "filing_generates")).toHaveLength(0);
      expect(sep.events.filter((e) => e.kind === "filing_due_projected")).toHaveLength(0);

      const oct = await calendar(year, 10);
      expect(oct.events.filter((e) => e.kind === "filing_due_projected")).toHaveLength(0);
    });

    it("PAST quarter with issued run, no tax_filings row: no filing_generates, but filing_due_projected present", async () => {
      const companyId = (await t.db.select({ id: company.id }).from(company).limit(1))[0]!.id;
      const pastEmployeeId = (
        await t.db
          .insert(employees)
          .values({ companyId, legalName: "Past Employee", hireDate: "2025-01-01" })
          .returning()
      )[0]!.id;

      const year = 2024;
      const quarter = 1;
      const quarterEnd = "2024-03-31";
      const dueDate = "2024-04-30";

      await t.db.insert(payrollRuns).values({
        employeeId: pastEmployeeId,
        periodStart: "2024-01-01",
        periodEnd: "2024-03-31",
        payDate: "2024-02-15",
        status: "issued",
        runSnapshot: {},
      });

      const mar = await calendar(year, 3);
      expect(mar.events.filter((e) => e.kind === "filing_generates")).toHaveLength(0);

      const apr = await calendar(year, 4);
      expect(apr.events).toContainEqual(
        expect.objectContaining({
          date: dueDate,
          kind: "filing_due_projected",
          label: `Form 941 Q${quarter} ${year} due (projected)`,
          detail: "Projected — filing not generated yet",
        }),
      );
    });

    it("Year with issued runs and no w2_w3 row: W-2/W-3 generates on Jan 1 of year+1 and due on annualDueDate", async () => {
      const companyId = (await t.db.select({ id: company.id }).from(company).limit(1))[0]!.id;
      const futureEmployeeId = (
        await t.db
          .insert(employees)
          .values({ companyId, legalName: "Future Employee W2", hireDate: "2025-01-01" })
          .returning()
      )[0]!.id;

      // Current year keeps the Jan-1 generates date in the future regardless of
      // when the suite runs (mirrors the dynamic year in the 941 tests above).
      const year = new Date().getFullYear();
      const payDate = `${year}-03-15`;
      const generatesDate = `${year + 1}-01-01`;
      const dueDate = annualDueDate(year);
      const dueMonth = Number(dueDate.slice(5, 7));

      await t.db.insert(payrollRuns).values({
        employeeId: futureEmployeeId,
        periodStart: `${year}-01-01`,
        periodEnd: `${year}-03-31`,
        payDate,
        status: "issued",
        runSnapshot: {},
      });

      const jan = await calendar(year + 1, 1);
      expect(jan.events).toContainEqual(
        expect.objectContaining({
          date: generatesDate,
          kind: "filing_generates",
          label: `W-2/W-3 ${year} generates`,
          detail: "Created by the daily filing sync",
        }),
      );
      const dueCal = await calendar(year + 1, dueMonth);
      expect(dueCal.events).toContainEqual(
        expect.objectContaining({
          date: dueDate,
          kind: "filing_due_projected",
          label: `W-2/W-3 ${year} due (projected)`,
          detail: "Projected — filing not generated yet",
        }),
      );
    });

    it("Same year WITH w2_w3 tax_filings row: no W-2/W-3 projected events, only real filing_due", async () => {
      const companyId = (await t.db.select({ id: company.id }).from(company).limit(1))[0]!.id;
      const futureEmployeeId = (
        await t.db
          .insert(employees)
          .values({ companyId, legalName: "Future Employee W2 2", hireDate: "2025-01-01" })
          .returning()
      )[0]!.id;

      const year = 2027;
      const payDate = "2027-03-15";
      const dueDate = annualDueDate(year);

      await t.db.insert(payrollRuns).values({
        employeeId: futureEmployeeId,
        periodStart: "2027-01-01",
        periodEnd: "2027-03-31",
        payDate,
        status: "issued",
        runSnapshot: {},
      });

      await t.db.insert(taxFilings).values({
        formType: "w2_w3",
        year,
        quarter: 0,
        dueDate,
        status: "not_started",
      });

      const jan = await calendar(year + 1, 1);
      expect(jan.events.filter((e) => e.kind === "filing_generates")).toHaveLength(0);
      // The 940 projection for the same year legitimately coexists — scope to W-2/W-3.
      expect(
        jan.events.filter((e) => e.kind === "filing_due_projected" && e.label.includes("W-2/W-3")),
      ).toHaveLength(0);

      expect(jan.events).toContainEqual(
        expect.objectContaining({
          date: dueDate,
          kind: "filing_due",
          label: `W-2/W-3 ${year} due`,
          detail: "not_started",
        }),
      );
    });

    it("Year with issued runs and no 940 row: Form 940 due projected", async () => {
      const companyId = (await t.db.select({ id: company.id }).from(company).limit(1))[0]!.id;
      const futureEmployeeId = (
        await t.db
          .insert(employees)
          .values({ companyId, legalName: "Future Employee 940", hireDate: "2025-01-01" })
          .returning()
      )[0]!.id;

      const year = 2029;
      const payDate = "2029-03-15";
      const dueDate = annualDueDate(year);

      await t.db.insert(payrollRuns).values({
        employeeId: futureEmployeeId,
        periodStart: "2029-01-01",
        periodEnd: "2029-03-31",
        payDate,
        status: "issued",
        runSnapshot: {},
      });

      const jan = await calendar(year + 1, 1);
      expect(jan.events).toContainEqual(
        expect.objectContaining({
          date: dueDate,
          kind: "filing_due_projected",
          label: `Form 940 ${year} due (projected)`,
          detail: "Projected — filing not generated yet",
        }),
      );
    });

    it("Year with 940 row: no Form 940 projected event", async () => {
      const companyId = (await t.db.select({ id: company.id }).from(company).limit(1))[0]!.id;
      const futureEmployeeId = (
        await t.db
          .insert(employees)
          .values({ companyId, legalName: "Future Employee 940 2", hireDate: "2025-01-01" })
          .returning()
      )[0]!.id;

      const year = 2029;
      const payDate = "2029-03-15";
      const dueDate = annualDueDate(year);

      await t.db.insert(payrollRuns).values({
        employeeId: futureEmployeeId,
        periodStart: "2029-01-01",
        periodEnd: "2029-03-31",
        payDate,
        status: "issued",
        runSnapshot: {},
      });

      await t.db.insert(taxFilings).values({
        formType: "940",
        year,
        quarter: 0,
        dueDate,
        status: "not_started",
      });

      const jan = await calendar(year + 1, 1);
      expect(
        jan.events.filter((e) => e.kind === "filing_due_projected" && e.label.includes("940")),
      ).toHaveLength(0);
    });
  });
});

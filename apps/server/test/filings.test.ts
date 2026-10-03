/**
 * PAY-10 integration tests — quarterly Form 941 filings. Real SQL via the
 * PGlite harness; syncFilings / sendFilingReminders are called directly
 * (pg-boss needs a real Postgres), the admin routes go through app.inject
 * with a real admin session.
 *
 * Covers: due-date calc incl. weekend roll and year rollover, the worksheet
 * line-by-line (line 16 equals the deposit computation, line 13 includes
 * deposits + adjustment payments, line 7 fractions-of-cents default and
 * admin override, snapshot-hash stability), syncFilings (creates when the
 * quarter ends, refreshes while unfiled, never rewrites filed), the
 * mark-filed flow (200 + audit + double-file rejected), adjustments CRUD,
 * the reminder schedule setting, the reminder sweep (fires per offsets,
 * never twice), and RBAC.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import {
  auditEvents,
  company,
  compensation,
  emailOutbox,
  employees,
  payrollEntries,
  payrollRuns,
  seedDatabase,
  taxDeposits,
  taxFilings,
  type SeedDb,
} from "@payroll/db";
import { round2 } from "@payroll/engine/money";
import { EVENT_TYPE } from "@payroll/notifications";
import { computeDepositAmount } from "../src/deposits/service.js";
import {
  computeWorksheet,
  filingDueDate,
  sendFilingReminders,
  syncFilings,
  worksheetHash,
  type Worksheet941,
} from "../src/filings/service.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

let t: TestContext;
let ADMIN: Record<string, string>;
let adminUserId: string;

// Runs are issued on their pay date (issueOn): a run whose pay-date quarter
// has ended is late and needs the PAY-193 L4 confirmation. Outside an issue
// the clock is the real one.
let issueOn: string | null = null;
const ISSUE_CLOCK = () => (issueOn ? new Date(`${issueOn}T12:00:00Z`) : new Date());

beforeAll(async () => {
  t = await createTestApp({}, { clock: ISSUE_CLOCK });
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "filings-admin@test.dev", role: "admin" });
  adminUserId = admin.userId;
  const session = await login(t, admin.email, TEST_PASSWORD);
  ADMIN = sessionHeader(session.sessionCookie);
}, 120_000);

afterAll(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let employeeSeq = 0;
async function createEmployee(): Promise<number> {
  employeeSeq += 1;
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({
      companyId: companyRows[0]!.id,
      legalName: `Filing Test Employee ${employeeSeq}`,
      hireDate: "2025-01-01",
    })
    .returning();
  return rows[0]!.id;
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

/** Generate → approve → issue a monthly run; returns the run row. */
async function issueRun(employeeId: number, year: number, month: number) {
  const gen = await t.app.inject({
    method: "POST",
    url: "/api/admin/payroll-runs/generate",
    headers: ADMIN,
    payload: { year, month, employeeId },
  });
  expect(gen.statusCode, gen.body).toBe(201);
  const run = (gen.json() as { generated: (typeof payrollRuns.$inferSelect)[] }).generated[0]!;
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
  const rows = await t.db.select().from(payrollRuns).where(eq(payrollRuns.id, run.id));
  expect(rows[0]!.status).toBe("issued");
  return rows[0]!;
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

async function filingRow(year: number, quarter: number) {
  const rows = await t.db
    .select()
    .from(taxFilings)
    .where(
      and(
        eq(taxFilings.formType, "941"),
        eq(taxFilings.year, year),
        eq(taxFilings.quarter, quarter),
      ),
    );
  return rows[0];
}

async function filingReminderOutbox() {
  return t.db.select().from(emailOutbox).where(eq(emailOutbox.eventType, EVENT_TYPE.taxFilingDue));
}

/** Exact liability from the DB itself: fed + both sides of SS + Medicare. */
async function exactLiability(year: number, quarter: number): Promise<string> {
  const firstMonth = (quarter - 1) * 3 + 1;
  const months = [firstMonth, firstMonth + 1, firstMonth + 2].map(
    (m) => `${year}-${String(m).padStart(2, "0")}`,
  );
  const runs = await t.db.select().from(payrollRuns).where(eq(payrollRuns.status, "issued"));
  const inQuarter = runs.filter((r) => months.some((m) => r.payDate.startsWith(m)));
  let total = 0;
  for (const run of inQuarter) {
    const entries = await t.db
      .select()
      .from(payrollEntries)
      .where(eq(payrollEntries.runId, run.id));
    for (const e of entries) {
      if (
        [
          "federal_withholding",
          "social_security",
          "medicare",
          "employer_social_security",
          "employer_medicare",
        ].includes(e.category)
      ) {
        total += Number(e.amount);
      }
    }
  }
  return round2(total).toFixed(2);
}

// ---------------------------------------------------------------------------
// filingDueDate — pure date math
// ---------------------------------------------------------------------------

describe("filingDueDate (PAY-10 domain rules)", () => {
  it("is Apr 30 / Jul 31 / Oct 31 / Jan 31, incl. year rollover", () => {
    expect(filingDueDate(2026, 1)).toBe("2026-04-30"); // Thursday
    expect(filingDueDate(2026, 2)).toBe("2026-07-31"); // Friday
    expect(filingDueDate(2023, 4)).toBe("2024-01-31"); // Wednesday — Q4 rolls into the next year
  });

  it("rolls weekend due dates forward to the next business day", () => {
    expect(filingDueDate(2025, 4)).toBe("2026-02-02"); // Jan 31 2026 is a Saturday
    expect(filingDueDate(2026, 3)).toBe("2026-11-02"); // Oct 31 2026 is a Saturday
  });
});

// ---------------------------------------------------------------------------
// The worksheet — deterministic, reconciles to the cent
// ---------------------------------------------------------------------------

describe("computeWorksheet", () => {
  it("computes all lines from issued runs; line 12 equals exact liability to the cent", async () => {
    const a = await createEmployee();
    await addCompensation(a, 4000);
    for (const month of [1, 2, 3]) await issueRun(a, 2026, month);

    const w = await computeWorksheet(t.db, 2026, 1);
    expect(w.line1Employees).toBe(1);
    expect(Number(w.line2Wages)).toBeGreaterThan(0);
    // D4: default line 7 makes the form's totals chain land exactly on the
    // entry-derived liability.
    expect(w.line12TotalAfterCredits).toBe(await exactLiability(2026, 1));
    // Line 16 monthly breakdown = the deposit computation, NOT deposits made.
    expect(w.line16.month1).toBe(await computeDepositAmount(t.db, 2026, 1));
    expect(w.line16.month2).toBe(await computeDepositAmount(t.db, 2026, 2));
    expect(w.line16.month3).toBe(await computeDepositAmount(t.db, 2026, 3));
    expect(w.line16.deMinimis).toBe(Number(w.line12TotalAfterCredits) < 2500);
  });

  it("snapshot hash is stable across recomputation with the same inputs", async () => {
    const w1 = await computeWorksheet(t.db, 2026, 1);
    const w2 = await computeWorksheet(t.db, 2026, 1);
    expect(worksheetHash(w1)).toBe(worksheetHash(w2));
  });

  it("draft/void runs never count", async () => {
    const b = await createEmployee();
    await addCompensation(b, 9999);
    // Draft only — never issued.
    const gen = await t.app.inject({
      method: "POST",
      url: "/api/admin/payroll-runs/generate",
      headers: ADMIN,
      payload: { year: 2026, month: 4, employeeId: b },
    });
    expect(gen.statusCode).toBe(201);
    const w = await computeWorksheet(t.db, 2026, 2);
    expect(w.line2Wages).toBe("0.00");
    expect(w.line1Employees).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// syncFilings — creates on quarter end, refreshes unfiled, freezes filed
// ---------------------------------------------------------------------------

describe("syncFilings", () => {
  it("creates a ready row with the worksheet once the quarter has ended", async () => {
    const sync = await syncFilings({ db: t.db, config: t.config }, { today: "2026-04-15" });
    expect(sync.created).toBe(1); // Q1 only — Q2 hasn't ended
    const q1 = await filingRow(2026, 1);
    expect(q1!.status).toBe("ready");
    expect(q1!.dueDate).toBe("2026-04-30");
    expect(q1!.worksheetHash).toBe(worksheetHash(q1!.worksheet as Worksheet941));
    expect((q1!.worksheet as Worksheet941).line12TotalAfterCredits).toBe(
      await exactLiability(2026, 1),
    );
  });

  it("does not create rows for a quarter that has not ended", async () => {
    expect(await filingRow(2026, 2)).toBeUndefined();
  });

  it("is idempotent and refreshes the worksheet when more runs issue", async () => {
    const noop = await syncFilings({ db: t.db, config: t.config }, { today: "2026-04-15" });
    expect(noop.created).toBe(0);
    expect(noop.refreshed).toBe(0);

    // A second employee issues in Q1 — the unfiled worksheet refreshes.
    const c = await createEmployee();
    await addCompensation(c, 1000);
    await issueRun(c, 2026, 3);
    const refresh = await syncFilings({ db: t.db, config: t.config }, { today: "2026-04-16" });
    expect(refresh.created).toBe(0);
    expect(refresh.refreshed).toBe(1);
    const q1 = await filingRow(2026, 1);
    expect((q1!.worksheet as Worksheet941).line12TotalAfterCredits).toBe(
      await exactLiability(2026, 1),
    );
  });
});

// ---------------------------------------------------------------------------
// Admin routes — list, detail, mark filed, fractions, adjustments, schedule
// ---------------------------------------------------------------------------

describe("admin filing routes", () => {
  it("lists filings newest first and filters by year/status/form", async () => {
    const res = await api("GET", "/api/admin/tax-filings");
    expect(res.statusCode, res.body).toBe(200);
    const { filings } = res.json() as { filings: (typeof taxFilings.$inferSelect)[] };
    expect(filings).toHaveLength(1);

    const filtered = await api("GET", "/api/admin/tax-filings?year=2025");
    expect((filtered.json() as { filings: unknown[] }).filings).toHaveLength(0);
    const filed = await api("GET", "/api/admin/tax-filings?status=filed");
    expect((filed.json() as { filings: unknown[] }).filings).toHaveLength(0);

    const bad = await api("GET", "/api/admin/tax-filings?year=abc");
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "invalid_query" });
  });

  it("returns the detail with the worksheet and adjustments", async () => {
    const q1 = (await filingRow(2026, 1))!;
    const res = await api("GET", `/api/admin/tax-filings/${q1.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      filing: typeof taxFilings.$inferSelect;
      adjustments: unknown[];
    };
    expect(body.filing.id).toBe(q1.id);
    expect((body.filing.worksheet as Worksheet941).form).toBe("941");
    expect(body.adjustments).toHaveLength(0);

    const missing = await api("GET", "/api/admin/tax-filings/999999");
    expect(missing.statusCode).toBe(404);
  });

  it("adds an adjustment; its payment feeds worksheet line 13", async () => {
    const q1 = (await filingRow(2026, 1))!;
    const res = await api("POST", `/api/admin/tax-filings/${q1.id}/adjustments`, {
      kind: "CP220",
      noticeDate: "2026-06-22",
      amountDue: "28.27",
      abatedAmount: "11.68",
      amountPaid: "16.59",
      paidOn: "2026-06-15",
      eftpsConfirmation: "270656663211429",
      note: "FTA letter: late penalty removed, interest reduced",
    });
    expect(res.statusCode, res.body).toBe(201);

    // Deposit the three months, then line 13 = deposits + adjustment payment.
    for (const m of [1, 2, 3]) {
      await t.db.insert(taxDeposits).values({
        jurisdiction: "federal",
        periodStart: `2026-${String(m).padStart(2, "0")}-01`,
        amount: "100.00",
        dueDate: "2026-04-15",
        status: "deposited",
        depositedOn: "2026-04-15",
        eftpsConfirmation: `EFTPS-Q1-${m}`,
        createdBy: "test",
      });
    }
    const detail = await api("GET", `/api/admin/tax-filings/${q1.id}`);
    const { filing } = detail.json() as { filing: typeof taxFilings.$inferSelect };
    const w = filing.worksheet as Worksheet941;
    expect(w.line13Deposits).toBe(round2(300 + 16.59).toFixed(2));

    const bad = await api("POST", `/api/admin/tax-filings/${q1.id}/adjustments`, {
      kind: "CP220",
      amountDue: "-5",
    });
    expect(bad.statusCode).toBe(400);
  });

  it("updates and deletes adjustments, audit-logged", async () => {
    const q1 = (await filingRow(2026, 1))!;
    const detail = (
      (await api("GET", `/api/admin/tax-filings/${q1.id}`)).json() as {
        adjustments: { id: number; amountPaid: string }[];
      }
    ).adjustments;
    const adjId = detail[0]!.id;

    const upd = await api("PUT", `/api/admin/tax-filings/${q1.id}/adjustments/${adjId}`, {
      kind: "CP220",
      amountDue: "28.27",
      abatedAmount: "11.68",
      amountPaid: "20.00",
      paidOn: "2026-06-15",
    });
    expect(upd.statusCode, upd.body).toBe(200);
    expect((upd.json() as { adjustment: { amountPaid: string } }).adjustment.amountPaid).toBe(
      "20.00",
    );

    const afterUpd = (
      (await api("GET", `/api/admin/tax-filings/${q1.id}`)).json() as {
        filing: typeof taxFilings.$inferSelect;
      }
    ).filing.worksheet as Worksheet941;
    expect(afterUpd.line13Deposits).toBe(round2(300 + 20).toFixed(2));

    const del = await api("DELETE", `/api/admin/tax-filings/${q1.id}/adjustments/${adjId}`);
    expect(del.statusCode).toBe(200);
    const afterDel = (
      (await api("GET", `/api/admin/tax-filings/${q1.id}`)).json() as {
        filing: typeof taxFilings.$inferSelect;
      }
    ).filing.worksheet as Worksheet941;
    expect(afterDel.line13Deposits).toBe("300.00");

    const audits = await t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entity, "tax_adjustment"), eq(auditEvents.entityId, String(adjId))))
      .orderBy(desc(auditEvents.id));
    expect(audits.map((a) => a.action)).toEqual([
      "tax_adjustment.delete",
      "tax_adjustment.update",
      "tax_adjustment.create",
    ]);
  });

  it("sets line 7 fractions-of-cents (D4) and re-renders the totals chain", async () => {
    const q1 = (await filingRow(2026, 1))!;
    const before = (q1.worksheet as Worksheet941).line7FractionsOfCents;
    const res = await api("PUT", `/api/admin/tax-filings/${q1.id}/fractions-of-cents`, {
      amount: "0.05",
    });
    expect(res.statusCode, res.body).toBe(200);
    const { filing } = res.json() as { filing: typeof taxFilings.$inferSelect };
    expect(filing.fractionsOfCents).toBe("0.05");
    const w = filing.worksheet as Worksheet941;
    expect(w.line7FractionsOfCents).toBe("0.05");
    // The totals chain moves with the override.
    const expected10 = round2(Number(w.line6TotalTaxes) + 0.05).toFixed(2);
    expect(w.line10TotalAfterAdjustments).toBe(expected10);

    // A sync refresh must PRESERVE the admin override (not reset to computed).
    const sync = await syncFilings({ db: t.db, config: t.config }, { today: "2026-04-17" });
    const after = (await filingRow(2026, 1))!;
    expect(after.fractionsOfCents).toBe("0.05");
    expect((after.worksheet as Worksheet941).line7FractionsOfCents).toBe("0.05");
    expect(before).not.toBe("0.05"); // sanity: the override actually differs

    const bad = await api("PUT", `/api/admin/tax-filings/${q1.id}/fractions-of-cents`, {
      amount: "abc",
    });
    expect(bad.statusCode).toBe(400);
  });

  it("marks a filing filed — status, reference, audit; double-file rejected", async () => {
    const q1 = (await filingRow(2026, 1))!;
    const res = await api("POST", `/api/admin/tax-filings/${q1.id}/file`, {
      filedOn: "2026-04-20",
      filingMethod: "letterstream",
      filingReference: "14227289",
    });
    expect(res.statusCode, res.body).toBe(200);
    const { filing } = res.json() as { filing: typeof taxFilings.$inferSelect };
    expect(filing.status).toBe("filed");
    expect(filing.filedOn).toBe("2026-04-20");
    expect(filing.filingReference).toBe("14227289");

    const audits = await t.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, "tax_filing.file"), eq(auditEvents.entityId, String(q1.id))),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(adminUserId);

    const again = await api("POST", `/api/admin/tax-filings/${q1.id}/file`, {
      filedOn: "2026-04-21",
      filingMethod: "letterstream",
      filingReference: "999",
    });
    expect(again.statusCode).toBe(409);

    // Filed = frozen: adjustments and line 7 are locked.
    const adj = await api("POST", `/api/admin/tax-filings/${q1.id}/adjustments`, {
      kind: "other",
      amountDue: "1.00",
    });
    expect(adj.statusCode).toBe(409);
    const frac = await api("PUT", `/api/admin/tax-filings/${q1.id}/fractions-of-cents`, {
      amount: "0.00",
    });
    expect(frac.statusCode).toBe(409);

    // And a later sync never rewrites the frozen worksheet.
    const hash = (await filingRow(2026, 1))!.worksheetHash;
    await syncFilings({ db: t.db, config: t.config }, { today: "2026-04-18" });
    expect((await filingRow(2026, 1))!.worksheetHash).toBe(hash);
  });

  it("403s non-admins", async () => {
    const employee = await inviteAndOnboard(t, { email: "filings-employee@test.dev" });
    const session = await login(t, employee.email, TEST_PASSWORD);
    const res = await t.app.inject({
      method: "GET",
      url: "/api/admin/tax-filings",
      headers: sessionHeader(session.sessionCookie),
    });
    expect(res.statusCode).toBe(403);
  });

  it("reads the default reminder schedule and saves custom offsets", async () => {
    const initial = await api("GET", "/api/admin/tax-filings/reminder-schedule");
    expect(initial.json()).toMatchObject({ offsets: [14, 7, 0], defaultOffsets: [14, 7, 0] });

    const put = await api("PUT", "/api/admin/tax-filings/reminder-schedule", {
      offsets: [10, 3, 0],
    });
    expect(put.statusCode, put.body).toBe(200);
    const after = await api("GET", "/api/admin/tax-filings/reminder-schedule");
    expect(after.json()).toMatchObject({ offsets: [10, 3, 0] });

    const bad = await api("PUT", "/api/admin/tax-filings/reminder-schedule", { offsets: [99] });
    expect(bad.statusCode).toBe(400);

    // Restore defaults for the reminder sweep below.
    await api("PUT", "/api/admin/tax-filings/reminder-schedule", { offsets: [14, 7, 0] });
  });
});

// ---------------------------------------------------------------------------
// Reminder sweep — fires per offsets, never twice
// ---------------------------------------------------------------------------

describe("sendFilingReminders", () => {
  it("mails admins on the configured offsets and dedupes", async () => {
    // A fresh unfiled Q2 filing due 2026-07-31 (offsets [14, 7, 0] → fire
    // dates 2026-07-17, 2026-07-24, 2026-07-31).
    const d = await createEmployee();
    await addCompensation(d, 3000);
    for (const month of [4, 5, 6]) await issueRun(d, 2026, month);
    await syncFilings({ db: t.db, config: t.config }, { today: "2026-07-01" });
    const q2 = (await filingRow(2026, 2))!;
    expect(q2.status).toBe("ready");

    expect(
      (await sendFilingReminders({ db: t.db, config: t.config }, { today: "2026-07-16" })).sent,
    ).toBe(0); // not a fire date
    expect(
      (await sendFilingReminders({ db: t.db, config: t.config }, { today: "2026-07-17" })).sent,
    ).toBe(1); // offset 14
    // Re-tick: no double-mail.
    expect(
      (await sendFilingReminders({ db: t.db, config: t.config }, { today: "2026-07-17" })).sent,
    ).toBe(0);
    expect(
      (await sendFilingReminders({ db: t.db, config: t.config }, { today: "2026-07-31" })).sent,
    ).toBe(1); // offset 0 (7 was skipped — no tick on the 24th in this test)

    const outbox = await filingReminderOutbox();
    expect(outbox.length).toBe(2);
    expect(outbox[0]!.subject).toContain("Form 941");
    expect(outbox[0]!.subject).toContain("Q2 2026");
    expect((await filingRow(2026, 2))!.remindersSent).toEqual([14, 0]);
  });

  it("never reminds for a filed filing", async () => {
    // Q1 is filed (previous describe). Its remaining fire dates must not mail.
    const before = (await filingReminderOutbox()).length;
    await sendFilingReminders({ db: t.db, config: t.config }, { today: "2026-04-30" });
    expect((await filingReminderOutbox()).length).toBe(before);
  });
});

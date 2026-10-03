/**
 * PAY-9 integration tests — monthly federal tax deposits. Real SQL via the
 * PGlite harness; syncDeposits / sendDepositReminders are called directly
 * (pg-boss needs a real Postgres), the admin routes go through app.inject
 * with a real admin session.
 *
 * Covers: due-date calc incl. weekend roll and year rollover, amount
 * derivation from issued runs to the cent (draft/void runs excluded,
 * employer_futa excluded), syncDeposits idempotency + pending-row
 * recomputation when a late run issues + the overdue flip, the mark-deposited
 * flow (200 + audit event + status change; invalid confirmation and double
 * deposit rejected; RBAC), the reminder schedule setting (default [5,0],
 * custom offsets, validation), and the reminder sweep (fires on the right
 * dates, never twice for the same offset, custom offsets honored).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import {
  auditEvents,
  company,
  compensation,
  emailOutbox,
  employees,
  payrollEntries,
  payrollRuns,
  seedDatabase,
  stateDepositSchedules,
  taxDeposits,
  type SeedDb,
} from "@payroll/db";
import { round2 } from "@payroll/engine/money";
import { EVENT_TYPE } from "@payroll/notifications";
import {
  computeDepositAmount,
  DEFAULT_REMINDER_OFFSETS,
  DEPOSIT_CATEGORIES,
  dueDateFor,
  getDepositDetail,
  listDeposits,
  periodStartFor,
  quarterOfMonth,
  sendDepositReminders,
  stateDueDateFor,
  statePeriodStartFor,
  syncDeposits,
} from "../src/deposits/service.js";
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
  const admin = await inviteAndOnboard(t, { email: "deposits-admin@test.dev", role: "admin" });
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
      legalName: `Deposit Test Employee ${employeeSeq}`,
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
  method: "GET" | "POST" | "PUT",
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

async function depositRow(periodStart: string) {
  const rows = await t.db
    .select()
    .from(taxDeposits)
    .where(and(eq(taxDeposits.jurisdiction, "federal"), eq(taxDeposits.periodStart, periodStart)));
  return rows[0];
}

/** Assign an effective-dated work state via the admin route (PAY-13). */
async function assignWorkState(employeeId: number, stateCode: string, effectiveFrom: string) {
  // PAY-163: a New York work state answers the Yonkers question (here: no).
  const locality = stateCode === "NY" ? { localityCode: null } : {};
  const res = await api("PUT", `/api/admin/employees/${employeeId}/work-state`, {
    stateCode,
    effectiveFrom,
    ...locality,
  });
  expect(res.statusCode, res.body).toBe(201);
}

/** Get a deposit row by jurisdiction and periodStart. */
async function stateDepositRow(jurisdiction: string, periodStart: string) {
  const rows = await t.db
    .select()
    .from(taxDeposits)
    .where(
      and(eq(taxDeposits.jurisdiction, jurisdiction), eq(taxDeposits.periodStart, periodStart)),
    );
  return rows[0];
}

async function depositReminderOutbox() {
  return t.db.select().from(emailOutbox).where(eq(emailOutbox.eventType, EVENT_TYPE.taxDepositDue));
}

/** Expected deposit amount: the five categories summed from the DB itself. */
async function expectedAmount(year: number, month: number): Promise<string> {
  const mm = String(month).padStart(2, "0");
  const runs = await t.db
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.status, "issued")));
  const inMonth = runs.filter((r) => r.payDate.startsWith(`${year}-${mm}-`));
  let total = 0;
  for (const run of inMonth) {
    const entries = await t.db
      .select()
      .from(payrollEntries)
      .where(eq(payrollEntries.runId, run.id));
    for (const e of entries) {
      if ((DEPOSIT_CATEGORIES as readonly string[]).includes(e.category)) {
        total += Number(e.amount);
      }
    }
  }
  return round2(total).toFixed(2);
}

// ---------------------------------------------------------------------------
// dueDateFor — pure date math
// ---------------------------------------------------------------------------

describe("dueDateFor (PAY-9 domain rules)", () => {
  it("is the 15th of the following month, incl. year rollover", () => {
    expect(dueDateFor(2026, 4)).toBe("2026-05-15"); // Friday — no roll
    expect(dueDateFor(2025, 12)).toBe("2026-01-15"); // December → January
  });

  it("rolls weekend due dates forward to the next business day", () => {
    // 2026-08-15 is a Saturday → Monday the 17th (ticket example).
    expect(dueDateFor(2026, 7)).toBe("2026-08-17");
    // 2026-02-15 is a Sunday → Monday the 16th.
    expect(dueDateFor(2026, 1)).toBe("2026-02-16");
  });
});

// ---------------------------------------------------------------------------
// computeDepositAmount — issued runs only, to the cent
// ---------------------------------------------------------------------------

describe("computeDepositAmount", () => {
  it("sums the five deposit categories across issued runs in the pay month", async () => {
    const a = await createEmployee();
    await addCompensation(a, 4000);
    await issueRun(a, 2026, 3);

    const amount = await computeDepositAmount(t.db, 2026, 3);
    expect(amount).toBe(await expectedAmount(2026, 3));
    expect(Number(amount)).toBeGreaterThan(0);
  });

  it("excludes draft and void runs, and employer_futa", async () => {
    const b = await createEmployee();
    await addCompensation(b, 5000);

    // Draft (awaiting approval) run in April — must not count.
    const gen = await t.app.inject({
      method: "POST",
      url: "/api/admin/payroll-runs/generate",
      headers: ADMIN,
      payload: { year: 2026, month: 4, employeeId: b },
    });
    expect(gen.statusCode, gen.body).toBe(201);
    const draft = (gen.json() as { generated: (typeof payrollRuns.$inferSelect)[] }).generated[0]!;

    const before = await computeDepositAmount(t.db, 2026, 4);
    expect(before).toBe("0.00");

    // Void the draft: still excluded afterwards.
    const voided = await t.app.inject({
      method: "POST",
      url: `/api/admin/payroll-runs/${draft.publicId}/void`,
      headers: ADMIN,
      payload: { reason: "test void" },
    });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(await computeDepositAmount(t.db, 2026, 4)).toBe("0.00");

    // Issue it properly (fresh run after void) and it counts.
    await issueRun(b, 2026, 4);
    const amount = await computeDepositAmount(t.db, 2026, 4);
    expect(amount).toBe(await expectedAmount(2026, 4));
    expect(Number(amount)).toBeGreaterThan(0);

    // employer_futa is never part of the deposit (Form 940, out of scope).
    const runs = await t.db
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.employeeId, b), eq(payrollRuns.status, "issued")));
    const entries = await t.db
      .select()
      .from(payrollEntries)
      .where(eq(payrollEntries.runId, runs[0]!.id));
    const futa = entries.find((e) => e.category === "employer_futa");
    expect(futa).toBeDefined();
    const withoutFuta = round2(
      entries
        .filter((e) => (DEPOSIT_CATEGORIES as readonly string[]).includes(e.category))
        .reduce((sum, e) => sum + Number(e.amount), 0),
    ).toFixed(2);
    expect(amount).toBe(withoutFuta);
  });
});

// ---------------------------------------------------------------------------
// syncDeposits — idempotent upsert, recomputation, overdue flip
// ---------------------------------------------------------------------------

describe("syncDeposits", () => {
  it("upserts pending rows for completed months AND the current month, idempotently", async () => {
    // 2026-03 (completed) and 2026-04 (current on 2026-04-10) both have issued
    // runs from the tests above — PAY-14: the current month's row appears as
    // soon as a run issues in it, no month-end wait.
    const first = await syncDeposits({ db: t.db, config: t.config }, { today: "2026-04-10" });
    expect(first.created).toBe(2);

    const march = await depositRow("2026-03-01");
    expect(march).toBeDefined();
    expect(march!.status).toBe("pending");
    expect(march!.amount).toBe(await expectedAmount(2026, 3));
    expect(march!.dueDate).toBe("2026-04-15");
    expect(march!.jurisdiction).toBe("federal");

    const april = await depositRow("2026-04-01");
    expect(april).toBeDefined();
    expect(april!.status).toBe("pending");
    expect(april!.amount).toBe(await expectedAmount(2026, 4));
    expect(april!.dueDate).toBe("2026-05-15");

    // Second run: no new rows, no rewrites — one row per (jurisdiction, period).
    const second = await syncDeposits({ db: t.db, config: t.config }, { today: "2026-04-10" });
    expect(second.created).toBe(0);
    expect(second.recomputed).toBe(0);
    const all = await t.db.select().from(taxDeposits);
    expect(all.filter((d) => d.periodStart === "2026-03-01")).toHaveLength(1);
    expect(all.filter((d) => d.periodStart === "2026-04-01")).toHaveLength(1);
  });

  it("recomputes the amount of a pending row when a late run issues", async () => {
    const c = await createEmployee();
    await addCompensation(c, 6000);
    // A second employee's March run issued AFTER the first sync.
    await issueRun(c, 2026, 3);

    const sync = await syncDeposits({ db: t.db, config: t.config }, { today: "2026-04-12" });
    expect(sync.recomputed).toBe(1);
    const march = await depositRow("2026-03-01");
    expect(march!.amount).toBe(await expectedAmount(2026, 3));
  });

  it("flips pending rows to overdue once the due date passes", async () => {
    // April's row already exists (PAY-14: created while April was the current
    // month) and May has no issued runs, so nothing new is created. March is
    // past due (due 2026-04-15) and flips.
    const sync = await syncDeposits({ db: t.db, config: t.config }, { today: "2026-05-01" });
    expect(sync.created).toBe(0);
    expect(sync.flippedOverdue).toBe(1); // March
    const march = await depositRow("2026-03-01");
    expect(march!.status).toBe("overdue");
    const april = await depositRow("2026-04-01");
    expect(april!.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Admin routes — list + mark deposited + reminder schedule
// ---------------------------------------------------------------------------

describe("admin deposit routes", () => {
  it("lists deposits newest period first", async () => {
    const res = await api("GET", "/api/admin/tax-deposits");
    expect(res.statusCode, res.body).toBe(200);
    const { deposits } = res.json() as { deposits: (typeof taxDeposits.$inferSelect)[] };
    expect(deposits.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < deposits.length; i++) {
      expect(deposits[i - 1]!.periodStart >= deposits[i]!.periodStart).toBe(true);
    }
  });

  it("marks a deposit as deposited — status change + audit event", async () => {
    const april = await depositRow("2026-04-01");
    expect(april).toBeDefined();

    const res = await api("POST", `/api/admin/tax-deposits/${april!.id}/deposit`, {
      depositedOn: "2026-05-14",
      eftpsConfirmation: "EFTPS-123456789",
    });
    expect(res.statusCode, res.body).toBe(200);
    const { deposit } = res.json() as { deposit: typeof taxDeposits.$inferSelect };
    expect(deposit.status).toBe("deposited");
    expect(deposit.depositedOn).toBe("2026-05-14");
    expect(deposit.eftpsConfirmation).toBe("EFTPS-123456789");

    const audits = await t.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "tax_deposit.deposit"),
          eq(auditEvents.entityId, String(april!.id)),
        ),
      )
      .orderBy(desc(auditEvents.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(adminUserId);
    expect((audits[0]!.after as { status: string }).status).toBe("deposited");
  });

  it("rejects an invalid confirmation and a double deposit", async () => {
    const march = await depositRow("2026-03-01");
    const bad = await api("POST", `/api/admin/tax-deposits/${march!.id}/deposit`, {
      depositedOn: "2026-05-14",
      eftpsConfirmation: "   ",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "invalid_body" });

    const badDate = await api("POST", `/api/admin/tax-deposits/${march!.id}/deposit`, {
      depositedOn: "14/05/2026",
      eftpsConfirmation: "EFTPS-1",
    });
    expect(badDate.statusCode).toBe(400);

    const ok = await api("POST", `/api/admin/tax-deposits/${march!.id}/deposit`, {
      depositedOn: "2026-05-15",
      eftpsConfirmation: "EFTPS-2",
    });
    expect(ok.statusCode, ok.body).toBe(200);

    const again = await api("POST", `/api/admin/tax-deposits/${march!.id}/deposit`, {
      depositedOn: "2026-05-15",
      eftpsConfirmation: "EFTPS-3",
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "invalid_transition" });
  });

  it("404s unknown deposits and 403s non-admins", async () => {
    const missing = await api("POST", "/api/admin/tax-deposits/999999/deposit", {
      depositedOn: "2026-05-15",
      eftpsConfirmation: "EFTPS-1",
    });
    expect(missing.statusCode).toBe(404);

    const employee = await inviteAndOnboard(t, { email: "deposits-employee@test.dev" });
    const session = await login(t, employee.email, TEST_PASSWORD);
    const res = await t.app.inject({
      method: "GET",
      url: "/api/admin/tax-deposits",
      headers: sessionHeader(session.sessionCookie),
    });
    expect(res.statusCode).toBe(403);
  });

  it("reads the default reminder schedule and saves custom offsets", async () => {
    const initial = await api("GET", "/api/admin/tax-deposits/reminder-schedule");
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()).toMatchObject({ offsets: [...DEFAULT_REMINDER_OFFSETS] });

    const put = await api("PUT", "/api/admin/tax-deposits/reminder-schedule", {
      offsets: [10, 3, 0],
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ offsets: [10, 3, 0] });

    const after = await api("GET", "/api/admin/tax-deposits/reminder-schedule");
    expect(after.json()).toMatchObject({ offsets: [10, 3, 0] });

    // Restore the default for the reminder-sweep tests below.
    const restore = await api("PUT", "/api/admin/tax-deposits/reminder-schedule", {
      offsets: [5, 0],
    });
    expect(restore.statusCode, restore.body).toBe(200);
  });

  it("rejects invalid reminder schedules", async () => {
    for (const offsets of [[], [31], [-1], [1.5], Array(11).fill(1)]) {
      const res = await api("PUT", "/api/admin/tax-deposits/reminder-schedule", { offsets });
      expect(res.statusCode, `offsets ${JSON.stringify(offsets)}`).toBe(400);
      expect(res.json()).toMatchObject({ error: "invalid_body" });
    }
  });
});

// ---------------------------------------------------------------------------
// sendDepositReminders — right dates, never twice per offset
// ---------------------------------------------------------------------------

describe("sendDepositReminders", () => {
  it("fires each configured offset once, on due_date minus offset", async () => {
    // Fresh period so reminders_sent starts empty: May 2026, due 2026-06-15.
    const d = await createEmployee();
    await addCompensation(d, 3500);
    await issueRun(d, 2026, 5);
    await syncDeposits({ db: t.db, config: t.config }, { today: "2026-06-01" });
    const may = await depositRow("2026-05-01");
    expect(may!.status).toBe("pending");
    expect(may!.dueDate).toBe("2026-06-15"); // Monday — no roll

    // Default schedule [5, 0]: offset 5 fires on 2026-06-10.
    const before10 = await depositReminderOutbox();
    const on10 = await sendDepositReminders(
      { db: t.db, config: t.config },
      { today: "2026-06-10" },
    );
    expect(on10.sent).toBe(1);
    const after10 = await depositReminderOutbox();
    expect(after10.length - before10.length).toBe(1); // one admin recipient

    // Same day again: nothing.
    const again10 = await sendDepositReminders(
      { db: t.db, config: t.config },
      { today: "2026-06-10" },
    );
    expect(again10.sent).toBe(0);

    // Offset 0 fires on the due date itself, then never again.
    const on15 = await sendDepositReminders(
      { db: t.db, config: t.config },
      { today: "2026-06-15" },
    );
    expect(on15.sent).toBe(1);
    const again15 = await sendDepositReminders(
      { db: t.db, config: t.config },
      { today: "2026-06-15" },
    );
    expect(again15.sent).toBe(0);

    const row = await depositRow("2026-05-01");
    expect((row!.remindersSent as number[]).sort()).toEqual([0, 5]);
  });

  it("email body carries jurisdiction, period, amount, due date, and the eftps pointer", async () => {
    const outbox = await depositReminderOutbox();
    const latest = outbox.sort((a, b) => b.id - a.id)[0]!;
    expect(latest.bodyHtml).toContain("Federal");
    expect(latest.bodyHtml).toContain("May 2026");
    expect(latest.bodyHtml).toContain("2026-06-15");
    expect(latest.bodyHtml).toContain("eftps.gov");
    expect(latest.bodyHtml).toContain("<!-- deposit-reminder:");
    const may = await depositRow("2026-05-01");
    const amountLabel = `$${Number(may!.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
    expect(latest.bodyHtml).toContain(amountLabel);
  });

  it("honors custom offsets", async () => {
    const e = await createEmployee();
    await addCompensation(e, 4500);
    await issueRun(e, 2026, 6);
    await syncDeposits({ db: t.db, config: t.config }, { today: "2026-07-01" });

    await api("PUT", "/api/admin/tax-deposits/reminder-schedule", { offsets: [2] });
    // June deposit is due 2026-07-15; offset 2 fires on 2026-07-13 only.
    const on12 = await sendDepositReminders(
      { db: t.db, config: t.config },
      { today: "2026-07-12" },
    );
    const on13 = await sendDepositReminders(
      { db: t.db, config: t.config },
      { today: "2026-07-13" },
    );
    expect(on12.sent).toBe(0);
    expect(on13.sent).toBeGreaterThanOrEqual(1);
    const june = await depositRow("2026-06-01");
    expect(june!.remindersSent as number[]).toEqual([2]);

    await api("PUT", "/api/admin/tax-deposits/reminder-schedule", { offsets: [5, 0] });
  });

  it("never reminds for deposited rows", async () => {
    const april = await depositRow("2026-04-01");
    expect(april!.status).toBe("deposited");
    // April was due 2026-05-15 — replaying that date must not fire for it.
    const res = await sendDepositReminders({ db: t.db, config: t.config }, { today: "2026-05-15" });
    expect(res.sent).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PAY-14 — the current month's row exists as soon as a run issues in it
// ---------------------------------------------------------------------------

describe("PAY-14 current-month rows", () => {
  it("creates the row mid-month, never flips it overdue, recomputes on a second run", async () => {
    // July 2026 has no runs yet; issue one and sync with `today` still inside
    // July. (This also flips the still-pending May/June rows overdue — their
    // due dates have passed — which no later test depends on.)
    const f = await createEmployee();
    await addCompensation(f, 7000);
    await issueRun(f, 2026, 7);

    const first = await syncDeposits({ db: t.db, config: t.config }, { today: "2026-07-20" });
    expect(first.created).toBeGreaterThanOrEqual(1);
    const july = await depositRow("2026-07-01");
    expect(july).toBeDefined();
    expect(july!.status).toBe("pending");
    // Due date is relative to the FOLLOWING month; 2026-08-15 is a Saturday.
    expect(july!.dueDate).toBe("2026-08-17");
    expect(july!.amount).toBe(await expectedAmount(2026, 7));

    // A second run issuing in the SAME current month recomputes the pending row.
    const g = await createEmployee();
    await addCompensation(g, 7000);
    await issueRun(g, 2026, 7);
    const second = await syncDeposits({ db: t.db, config: t.config }, { today: "2026-07-21" });
    expect(second.created).toBe(0);
    expect(second.recomputed).toBe(1);
    const julyAfter = await depositRow("2026-07-01");
    expect(julyAfter!.amount).toBe(await expectedAmount(2026, 7));
    expect(julyAfter!.status).toBe("pending");

    // The current-month pending row never reminds: its fire dates
    // (2026-08-12 and 2026-08-17 under the default [5, 0]) are in the future,
    // and everything earlier is deposited or already past its fire dates.
    const reminders = await sendDepositReminders(
      { db: t.db, config: t.config },
      { today: "2026-07-21" },
    );
    expect(reminders.sent).toBe(0);
    expect((await depositRow("2026-07-01"))!.remindersSent).toEqual([]);
  });

  it("never rewrites a deposited current-month row when more runs issue", async () => {
    // The owner's pattern: the FTD is paid the day payroll runs. Mark July
    // deposited, then issue a third July run — the recorded row must stay
    // exactly as entered (amount, date, confirmation).
    const july = await depositRow("2026-07-01");
    const res = await api("POST", `/api/admin/tax-deposits/${july!.id}/deposit`, {
      depositedOn: "2026-07-15",
      eftpsConfirmation: "EFTPS-CURRENT-MONTH",
    });
    expect(res.statusCode, res.body).toBe(200);

    const h = await createEmployee();
    await addCompensation(h, 7000);
    await issueRun(h, 2026, 7);
    const sync = await syncDeposits({ db: t.db, config: t.config }, { today: "2026-07-22" });
    expect(sync.recomputed).toBe(0);
    const after = await depositRow("2026-07-01");
    expect(after!.status).toBe("deposited");
    expect(after!.amount).toBe(july!.amount);
    expect(after!.depositedOn).toBe("2026-07-15");
    expect(after!.eftpsConfirmation).toBe("EFTPS-CURRENT-MONTH");
  });
});

// ---------------------------------------------------------------------------
// PAY-15 — list filters: year paging + status
// ---------------------------------------------------------------------------

describe("admin deposit list filters (PAY-15)", () => {
  it("filters by year, status, and rejects invalid queries", async () => {
    // A prior-year row so the year filter has something to exclude.
    await t.db.insert(taxDeposits).values({
      jurisdiction: "federal",
      periodStart: "2025-12-01",
      amount: "785.63",
      dueDate: "2026-01-15",
      status: "deposited",
      depositedOn: "2025-12-18",
      eftpsConfirmation: "EFTPS-2025",
      createdBy: "test",
    });

    type Row = typeof taxDeposits.$inferSelect;
    const all = ((await api("GET", "/api/admin/tax-deposits")).json() as { deposits: Row[] })
      .deposits;
    expect(all.some((d) => d.periodStart.startsWith("2025-"))).toBe(true);
    expect(all.some((d) => d.periodStart.startsWith("2026-"))).toBe(true);

    // Year filter: only that year's rows, none from other years.
    const y2026 = (
      (await api("GET", "/api/admin/tax-deposits?year=2026")).json() as { deposits: Row[] }
    ).deposits;
    expect(y2026.length).toBe(all.length - 1);
    expect(y2026.every((d) => d.periodStart.startsWith("2026-"))).toBe(true);

    const y2025 = (
      (await api("GET", "/api/admin/tax-deposits?year=2025")).json() as { deposits: Row[] }
    ).deposits;
    expect(y2025).toHaveLength(1);
    expect(y2025[0]!.periodStart).toBe("2025-12-01");

    // Status filter: every returned row carries the requested status.
    const deposited = (
      (await api("GET", "/api/admin/tax-deposits?status=deposited")).json() as {
        deposits: Row[];
      }
    ).deposits;
    expect(deposited.length).toBeGreaterThan(0);
    expect(deposited.every((d) => d.status === "deposited")).toBe(true);

    // Combined: 2025 + deposited → just the seeded row.
    const combined = (
      (await api("GET", "/api/admin/tax-deposits?year=2025&status=deposited")).json() as {
        deposits: Row[];
      }
    ).deposits;
    expect(combined).toHaveLength(1);
    expect(combined[0]!.eftpsConfirmation).toBe("EFTPS-2025");

    // Invalid queries 400.
    const badYear = await api("GET", "/api/admin/tax-deposits?year=abc");
    expect(badYear.statusCode).toBe(400);
    expect(badYear.json()).toMatchObject({ error: "invalid_query" });
    const badStatus = await api("GET", "/api/admin/tax-deposits?status=nope");
    expect(badStatus.statusCode).toBe(400);
    expect(badStatus.json()).toMatchObject({ error: "invalid_query" });
  });
});

// ---------------------------------------------------------------------------
// PAY-36 — deposit detail endpoint
// ---------------------------------------------------------------------------

describe("admin deposit detail endpoint (PAY-36)", () => {
  it("returns 404 for unknown deposit id", async () => {
    const res = await api("GET", "/api/admin/tax-deposits/999999");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "not_found" });
  });

  it("returns deposit detail for existing id", async () => {
    // Use August 2026 — untouched by earlier tests in this shared DB, so the
    // deposit amount is computed fresh by our sync below (earlier tests froze
    // the March deposit by marking it deposited).
    const employee = await createEmployee();
    await addCompensation(employee, 4000);
    const run = await issueRun(employee, 2026, 8);

    await syncDeposits({ db: t.db, config: t.config }, { today: "2026-09-01" });

    // Get the deposit ID from the list response
    const listRes = await api("GET", "/api/admin/tax-deposits");
    expect(listRes.statusCode).toBe(200);
    const deposits = (listRes.json() as { deposits: { id: number; periodStart: string }[] })
      .deposits;
    const deposit = deposits.find((d) => d.periodStart === "2026-08-01");

    if (!deposit) {
      throw new Error("Could not find test deposit");
    }

    const res = await api("GET", `/api/admin/tax-deposits/${deposit.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const detail = res.json() as {
      deposit: { id: number; periodStart: string; amount: string };
      breakdown: { category: string; amount: string }[];
      runs: { publicId: string }[];
    };

    expect(detail.deposit.id).toBe(deposit.id);
    expect(detail.deposit.periodStart).toBe("2026-08-01");
    expect(detail.breakdown).toHaveLength(5);
    expect(detail.runs).toHaveLength(1);

    // Check that all categories are present in breakdown
    const categories = detail.breakdown.map((b) => b.category);
    expect(categories).toEqual([
      "federal_withholding",
      "social_security",
      "medicare",
      "employer_social_security",
      "employer_medicare",
    ]);

    // Assert the breakdown amounts sum exactly to deposit.amount
    const total = detail.breakdown.reduce((sum, row) => sum + Number(row.amount), 0);
    expect(total).toBeCloseTo(Number(detail.deposit.amount));

    // Assert runs contains the issued fixture run's publicId
    expect(detail.runs.map((r) => r.publicId)).toContain(run.publicId);
  });
});

// ---------------------------------------------------------------------------
// PAY-13 — state deposits
// ---------------------------------------------------------------------------

describe("PAY-13 state deposits", () => {
  it("creates a state deposit row for a (state, month) with issued state-withholding runs", async () => {
    const employee = await createEmployee();
    await addCompensation(employee, 3500);
    await assignWorkState(employee, "IL", "2026-01-01");

    const run = await issueRun(employee, 2026, 7);
    const expected = await stateWithholdingForRunId(run.id);
    // The frozen snapshot is the jurisdiction source.
    const snapshot = run.runSnapshot as { inputs: { state?: { workState?: string } } };
    expect(snapshot.inputs.state?.workState).toBe("IL");

    await syncDeposits({ db: t.db, config: t.config }, { today: "2026-08-10" });

    const row = await stateDepositRow("IL", "2026-07-01");
    expect(row).toBeDefined();
    expect(row!.amount).toBe(expected);
    expect(row!.dueDate).toBe(dueDateFor(2026, 7));
    expect(row!.status).toBe("pending");
    expect(row!.createdBy).toBe("scheduler");
  });

  it("creates separate rows for two work states in the same month; federal row unaffected", async () => {
    const ilEmployee = await createEmployee();
    const caEmployee = await createEmployee();
    await addCompensation(ilEmployee, 3500);
    await addCompensation(caEmployee, 4500);
    await assignWorkState(ilEmployee, "IL", "2026-01-01");
    await assignWorkState(caEmployee, "CA", "2026-01-01");

    const ilRun = await issueRun(ilEmployee, 2026, 8);
    const caRun = await issueRun(caEmployee, 2026, 8);
    const ilExpected = await stateWithholdingForRunId(ilRun.id);
    const caExpected = await stateWithholdingForRunId(caRun.id);

    await syncDeposits({ db: t.db, config: t.config }, { today: "2026-09-10" });

    const il = await stateDepositRow("IL", "2026-08-01");
    const ca = await stateDepositRow("CA", "2026-07-01");
    expect(il!.amount).toBe(ilExpected);
    expect(ca!.amount).toBe(caExpected);

    // The federal row for the month still sums only the five federal categories.
    const federal = await stateDepositRow("federal", "2026-08-01");
    expect(federal!.amount).toBe(await computeDepositAmount(t.db, 2026, 8));
  });

  it("creates NO state row when runs have no snapshot state", async () => {
    const employee = await createEmployee();
    await addCompensation(employee, 3500);
    await issueRun(employee, 2026, 9); // no work state assigned

    await syncDeposits({ db: t.db, config: t.config }, { today: "2026-10-10" });

    const stateRows = await t.db
      .select()
      .from(taxDeposits)
      .where(
        and(ne(taxDeposits.jurisdiction, "federal"), eq(taxDeposits.periodStart, "2026-09-01")),
      );
    expect(stateRows).toHaveLength(0);
  });

  it("is idempotent: re-sync creates nothing, pending rows recompute, deposited rows untouched", async () => {
    const first = await createEmployee();
    await addCompensation(first, 3500);
    await assignWorkState(first, "IL", "2026-01-01");
    const run1 = await issueRun(first, 2026, 10);
    const amount1 = await stateWithholdingForRunId(run1.id);

    await syncDeposits({ db: t.db, config: t.config }, { today: "2026-11-10" });
    const sync2 = await syncDeposits({ db: t.db, config: t.config }, { today: "2026-11-10" });
    expect(sync2.created).toBe(0);
    expect(sync2.recomputed).toBe(0);
    let row = await stateDepositRow("IL", "2026-10-01");
    expect(row!.amount).toBe(amount1);

    // A late-issued second IL run in the same month recomputes the pending row.
    const second = await createEmployee();
    await addCompensation(second, 2000);
    await assignWorkState(second, "IL", "2026-01-01");
    const run2 = await issueRun(second, 2026, 10);
    const amount2 = await stateWithholdingForRunId(run2.id);

    const sync3 = await syncDeposits({ db: t.db, config: t.config }, { today: "2026-11-11" });
    row = await stateDepositRow("IL", "2026-10-01");
    expect(row!.amount).toBe(round2(Number(amount1) + Number(amount2)).toFixed(2));
    expect(sync3.recomputed).toBeGreaterThanOrEqual(1);

    // Once deposited, the row is never rewritten.
    await api("POST", `/api/admin/tax-deposits/${row!.id}/deposit`, {
      depositedOn: "2026-11-12",
      eftpsConfirmation: "IL-CONF-123",
    });
    const third = await createEmployee();
    await addCompensation(third, 1000);
    await assignWorkState(third, "IL", "2026-01-01");
    await issueRun(third, 2026, 10);
    await syncDeposits({ db: t.db, config: t.config }, { today: "2026-11-12" });

    row = await stateDepositRow("IL", "2026-10-01");
    expect(row!.status).toBe("deposited");
    expect(row!.amount).toBe(round2(Number(amount1) + Number(amount2)).toFixed(2));
  });

  // ---------------------------------------------------------------------------
  // Tests for jurisdiction filter (PAY-13 state deposits)
  // ---------------------------------------------------------------------------

  it("GET /api/admin/tax-deposits?jurisdiction=IL returns only IL rows while the unfiltered list includes federal too", async () => {
    // Use November 2026 (not used by other tests in the block)
    const employee = await createEmployee();
    await addCompensation(employee, 3500);
    await assignWorkState(employee, "IL", "2026-01-01");

    const run = await issueRun(employee, 2026, 11);
    const expected = await stateWithholdingForRunId(run.id);

    await syncDeposits({ db: t.db, config: t.config }, { today: "2026-12-10" });

    // Check that we have both IL and federal deposit rows
    const allDeposits = (
      (await api("GET", "/api/admin/tax-deposits")).json() as {
        deposits: { jurisdiction: string }[];
      }
    ).deposits;
    const hasFederal = allDeposits.some((d) => d.jurisdiction === "federal");
    const hasIL = allDeposits.some((d) => d.jurisdiction === "IL");
    expect(hasFederal).toBe(true);
    expect(hasIL).toBe(true);

    // Filter by jurisdiction IL — the shared test DB already holds IL rows from
    // other months, so assert every returned row is IL and find ours by period.
    const ilDeposits = (
      (await api("GET", "/api/admin/tax-deposits?jurisdiction=IL")).json() as {
        deposits: { jurisdiction: string; periodStart: string; amount: string }[];
      }
    ).deposits;
    expect(ilDeposits.length).toBeGreaterThan(0);
    expect(ilDeposits.every((d) => d.jurisdiction === "IL")).toBe(true);
    const ours = ilDeposits.find((d) => d.periodStart === "2026-11-01");
    expect(ours?.amount).toBe(expected);
  });

  it("GET /api/admin/tax-deposits/:id for a state row returns the single-category state_withholding breakdown and only that state's runs in the runs array", async () => {
    // Use December 2026 — the filter test above already occupies November, and a
    // second IL run in the same month would legitimately recompute that row.
    const ilEmployee = await createEmployee();
    const caEmployee = await createEmployee();
    await addCompensation(ilEmployee, 3500);
    await addCompensation(caEmployee, 4500);
    await assignWorkState(ilEmployee, "IL", "2026-01-01");
    await assignWorkState(caEmployee, "CA", "2026-01-01");

    const ilRun = await issueRun(ilEmployee, 2026, 12);
    await issueRun(caEmployee, 2026, 12);
    const ilExpected = await stateWithholdingForRunId(ilRun.id);

    await syncDeposits({ db: t.db, config: t.config }, { today: "2027-01-10" });

    // Get the IL deposit ID from the list response
    const listRes = await api("GET", "/api/admin/tax-deposits");
    expect(listRes.statusCode).toBe(200);
    const deposits = (
      listRes.json() as { deposits: { id: number; jurisdiction: string; periodStart: string }[] }
    ).deposits;
    const ilDeposit = deposits.find(
      (d) => d.jurisdiction === "IL" && d.periodStart === "2026-12-01",
    );

    if (!ilDeposit) {
      throw new Error("Could not find IL test deposit");
    }

    const detailRes = await api("GET", `/api/admin/tax-deposits/${ilDeposit.id}`);
    expect(detailRes.statusCode, detailRes.body).toBe(200);
    const detail = detailRes.json() as {
      deposit: { id: number; jurisdiction: string; amount: string };
      breakdown: { category: string; amount: string }[];
      runs: { publicId: string }[];
    };

    // Check that it's an IL deposit
    expect(detail.deposit.jurisdiction).toBe("IL");

    // Check breakdown has only one category (state_withholding)
    expect(detail.breakdown).toHaveLength(1);
    expect(detail.breakdown[0]!.category).toBe("state_withholding");
    expect(detail.breakdown[0]!.amount).toBe(ilExpected);

    // Check that runs only contain IL runs (not CA runs)
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]!.publicId).toBe(ilRun.publicId);
  });

  // PAY-48 — quarterly-frequency states (NY seeded quarterly, due last day of
  // the month following quarter end). Uses NY + Q1 2026, which no other test
  // in this file touches (the shared PGlite instance makes cross-test state
  // visible — CA Q3/Q4 and IL months are already taken).
  it("quarterly state (NY): one row per quarter aggregating all months, created on the first run, recomputed while pending", async () => {
    const first = await createEmployee();
    await addCompensation(first, 4000);
    await assignWorkState(first, "NY", "2026-01-01");
    const janRun = await issueRun(first, 2026, 1);
    const janExpected = await stateWithholdingForRunId(janRun.id);

    // The row appears as soon as the quarter's first issued run lands.
    await syncDeposits({ db: t.db, config: t.config }, { today: "2026-01-20" });
    let row = await stateDepositRow("NY", "2026-01-01");
    expect(row).toBeDefined();
    expect(row!.amount).toBe(janExpected);
    // Q1 2026 → due last day of the month following quarter end; 2026-04-30
    // is a Thursday, so no weekend roll.
    expect(row!.dueDate).toBe("2026-04-30");
    expect(row!.status).toBe("pending");

    // A second NY run in March of the SAME quarter aggregates into the same
    // row — no separate March row, amount is the Jan+Mar sum.
    const second = await createEmployee();
    await addCompensation(second, 2500);
    await assignWorkState(second, "NY", "2026-01-01");
    const marRun = await issueRun(second, 2026, 3);
    const marExpected = await stateWithholdingForRunId(marRun.id);

    await syncDeposits({ db: t.db, config: t.config }, { today: "2026-04-10" });
    const quarterTotal = round2(Number(janExpected) + Number(marExpected)).toFixed(2);
    row = await stateDepositRow("NY", "2026-01-01");
    expect(row!.amount).toBe(quarterTotal);

    const nyRows = await t.db.select().from(taxDeposits).where(eq(taxDeposits.jurisdiction, "NY"));
    expect(nyRows).toHaveLength(1);

    // periodKind surfaces through the list payload.
    const list = await listDeposits(t.db, { jurisdiction: "NY" });
    expect(list).toHaveLength(1);
    expect(list[0]!.periodKind).toBe("quarter");

    // The detail view spans the whole quarter: one state_withholding
    // breakdown row with the quarter sum, both contributing runs listed.
    const detail = await getDepositDetail(t.db, row!.id);
    expect(detail).not.toBeNull();
    expect(detail!.deposit.periodKind).toBe("quarter");
    expect(detail!.breakdown).toHaveLength(1);
    expect(detail!.breakdown[0]!.category).toBe("state_withholding");
    expect(detail!.breakdown[0]!.amount).toBe(quarterTotal);
    expect(detail!.runs.map((r) => r.publicId).sort()).toEqual(
      [janRun.publicId, marRun.publicId].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Defect fixes and periodKind tests
// ---------------------------------------------------------------------------

describe("state Due Date Tests (golden dates)", () => {
  it("IL monthly dueDay 15: Aug 2026 (15th Saturday) → 17th Monday", () => {
    const schedule = { frequency: "monthly" as const, dueDay: 15 };
    const due = stateDueDateFor(schedule, 2026, "2026-07-01");
    expect(due).toBe("2026-08-17");
  });

  it("IL monthly dueDay 15: Sep 2026 (15th Tuesday) → 15th (no roll)", () => {
    const schedule = { frequency: "monthly" as const, dueDay: 15 };
    const due = stateDueDateFor(schedule, 2026, "2026-08-01");
    expect(due).toBe("2026-09-15");
  });

  it("CA quarterly last day: Q3 (Oct 31 Saturday) → Nov 2 Monday", () => {
    const schedule = { frequency: "quarterly" as const, dueDay: null };
    const due = stateDueDateFor(schedule, 2026, "2026-07-01");
    expect(due).toBe("2026-11-02");
  });

  it("CA quarterly last day: Q1 (Apr 30 Thursday) → Apr 30 (no roll)", () => {
    const schedule = { frequency: "quarterly" as const, dueDay: null };
    const due = stateDueDateFor(schedule, 2026, "2026-01-01");
    expect(due).toBe("2026-04-30");
  });

  it("NY quarterly last day: Q2 (Jul 31 Friday) → Jul 31 (no roll)", () => {
    const schedule = { frequency: "quarterly" as const, dueDay: null };
    const due = stateDueDateFor(schedule, 2026, "2026-04-01");
    expect(due).toBe("2026-07-31");
  });

  it("MD quarterly dueDay 15: Q2 (Jul 15 Wednesday) → Jul 15 (no roll)", () => {
    const schedule = { frequency: "quarterly" as const, dueDay: 15 };
    const due = stateDueDateFor(schedule, 2026, "2026-04-01");
    expect(due).toBe("2026-07-15");
  });

  it("NC quarterly last day: Q4 (Jan 31 Sunday) → Feb 1 Monday", () => {
    const schedule = { frequency: "quarterly" as const, dueDay: null };
    const due = stateDueDateFor(schedule, 2026, "2026-10-01");
    expect(due).toBe("2027-02-01");
  });

  it("GA (no schedule) uses federal fallback: Aug 2026 (15th Saturday) → 17th Monday", () => {
    const due = stateDueDateFor(null, 2026, "2026-07-01");
    expect(due).toBe("2026-08-17");
  });
});

describe("quarterOfMonth helper", () => {
  it("maps months 1-12 to quarters 1-4", () => {
    expect(quarterOfMonth(1)).toBe(1);
    expect(quarterOfMonth(3)).toBe(1);
    expect(quarterOfMonth(4)).toBe(2);
    expect(quarterOfMonth(6)).toBe(2);
    expect(quarterOfMonth(7)).toBe(3);
    expect(quarterOfMonth(9)).toBe(3);
    expect(quarterOfMonth(10)).toBe(4);
    expect(quarterOfMonth(12)).toBe(4);
  });
});

describe("statePeriodStartFor helper", () => {
  it("returns monthly period for monthly schedule or no schedule", () => {
    expect(statePeriodStartFor(null, 2026, 7)).toBe("2026-07-01");
    expect(statePeriodStartFor({ frequency: "monthly" }, 2026, 7)).toBe("2026-07-01");
  });

  it("returns quarter start for quarterly schedule", () => {
    expect(statePeriodStartFor({ frequency: "quarterly" }, 2026, 1)).toBe("2026-01-01");
    expect(statePeriodStartFor({ frequency: "quarterly" }, 2026, 3)).toBe("2026-01-01");
    expect(statePeriodStartFor({ frequency: "quarterly" }, 2026, 4)).toBe("2026-04-01");
    expect(statePeriodStartFor({ frequency: "quarterly" }, 2026, 6)).toBe("2026-04-01");
    expect(statePeriodStartFor({ frequency: "quarterly" }, 2026, 7)).toBe("2026-07-01");
    expect(statePeriodStartFor({ frequency: "quarterly" }, 2026, 9)).toBe("2026-07-01");
    expect(statePeriodStartFor({ frequency: "quarterly" }, 2026, 10)).toBe("2026-10-01");
    expect(statePeriodStartFor({ frequency: "quarterly" }, 2026, 12)).toBe("2026-10-01");
  });
});

async function stateWithholdingFor(
  arg1: number | { id: number },
  year?: number,
  month?: number,
): Promise<string> {
  let employeeId: number;
  let runYear: number;
  let runMonth: number;

  if (typeof arg1 === "number") {
    employeeId = arg1;
    runYear = year!;
    runMonth = month!;
  } else {
    const emp = arg1;
    const runs = await t.db
      .select()
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.employeeId, emp.id),
          sql`date_trunc('month', ${payrollRuns.payDate})::date = ${periodStartFor(year!, month!)}::date`,
          eq(payrollRuns.status, "issued"),
        ),
      );
    const run = runs[0];
    if (!run) {
      throw new Error(`No issued run found for employee ${emp.id} in ${year}-${month}`);
    }
    const rows = await t.db
      .select({ amount: payrollEntries.amount })
      .from(payrollEntries)
      .where(
        and(eq(payrollEntries.runId, run.id), eq(payrollEntries.category, "state_withholding")),
      );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.amount)).toBeGreaterThan(0);
    return rows[0]!.amount;
  }

  const runs = await t.db
    .select()
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.employeeId, employeeId),
        sql`date_trunc('month', ${payrollRuns.payDate})::date = ${periodStartFor(runYear, runMonth)}::date`,
        eq(payrollRuns.status, "issued"),
      ),
    );
  const run = runs[0];
  if (!run) {
    throw new Error(`No issued run found for employee ${employeeId} in ${runYear}-${runMonth}`);
  }
  const rows = await t.db
    .select({ amount: payrollEntries.amount })
    .from(payrollEntries)
    .where(and(eq(payrollEntries.runId, run.id), eq(payrollEntries.category, "state_withholding")));
  expect(rows).toHaveLength(1);
  expect(Number(rows[0]!.amount)).toBeGreaterThan(0);
  return rows[0]!.amount;
}

async function stateWithholdingForRunId(runId: number): Promise<string> {
  const rows = await t.db
    .select({ amount: payrollEntries.amount })
    .from(payrollEntries)
    .where(and(eq(payrollEntries.runId, runId), eq(payrollEntries.category, "state_withholding")));
  expect(rows).toHaveLength(1);
  expect(Number(rows[0]!.amount)).toBeGreaterThan(0);
  return rows[0]!.amount;
}

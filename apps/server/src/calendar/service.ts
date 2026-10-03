/**
 * PAY-40 — admin calendar aggregation: one month of company date obligations
 * across the existing record-only tables, returned as a flat, date-sorted
 * event list for the month-grid UI.
 *
 * Sources (all date-typed columns — date-only semantics, no TZ math anywhere;
 * every comparison is an ISO "YYYY-MM-DD" string compare):
 *
 * - pay_schedules (active, monthly — the only frequency the run generator
 *   supports): the projected payday for the requested month, one event for
 *   the company-wide default row and one per employee override.
 * - payroll_runs.pay_date: actual runs in the month (void excluded — a void
 *   releases the period slot), labelled with the run status.
 * - contractor_recurring_invoices: the invoice-generation day (invoice_day
 *   'last_day' | fixed invoice_day_of_month) and the payment-due day
 *   (pay_day_of_month of the FOLLOWING month — so the requested month's
 *   payment events derive from the PREVIOUS period's invoice window). The
 *   starts_on/ends_on window is evaluated exactly like the daily sweep
 *   (generateRecurringInvoices): generate when starts_on <= invoice date <=
 *   ends_on.
 * - tax_deposits: due_date (the obligation) and deposited_on (the actual).
 * - tax_filings: due_date and filed_on (941 quarterly; 940 / w2_w3 annual).
 * - contractor_details.form_expires_at: W-8BEN / W-8BEN-E expiries (W-9 has
 *   no expiry and never produces an event).
 *
 * Events are read-only and carry a router link (route name + params) to the
 * matching admin detail view; the web app resolves them with vue-router.
 */

import { and, asc, eq, gte, inArray, isNotNull, lte, ne, sql, type SQLWrapper } from "drizzle-orm";
import {
  contractorDetails,
  contractorRecurringInvoices,
  employees,
  payrollRuns,
  paySchedules,
  taxDeposits,
  taxFilings,
} from "@payroll/db";
import type { Db } from "../db.js";
import {
  filingDueDate as filingsFilingDueDate,
  quarterEnd as filingsQuarterEnd,
} from "../filings/service.js";
import { annualDueDate, w2AvailableOn } from "../filings/annual.js";
import { stateName } from "@payroll/shared";
import { liveDeposit } from "../deposits/service.js";
import { periodLabel as depositPeriodLabel } from "../deposits/periods.js";
import { interpolateDescription, invoiceDateFor } from "../contractors/recurring.js";

export type CalendarEventKind =
  | "payday_scheduled"
  | "payday_run"
  | "contractor_invoice"
  | "contractor_payment"
  | "deposit_due"
  | "deposit_made"
  | "filing_due"
  | "filing_filed"
  | "filing_generates"
  | "filing_due_projected"
  | "w8_expiry";

export interface CalendarEvent {
  /** "YYYY-MM-DD" — always inside the requested month. */
  date: string;
  kind: CalendarEventKind;
  label: string;
  detail?: string | undefined;
  /** vue-router target: { name: "admin-filing", params: { id: 3 } }. */
  link: { name: string; params?: Record<string, string | number> } | null;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "2026-08-01" → "August 2026" (period_start is always the first). */
function periodLabel(periodStart: string): string {
  return `${MONTH_NAMES[Number(periodStart.slice(5, 7)) - 1] ?? periodStart} ${periodStart.slice(0, 4)}`;
}

function filingLabel(formType: string, year: number, quarter: number): string {
  if (formType === "941") return `Form 941 Q${quarter} ${year}`;
  if (formType === "940") return `Form 940 ${year}`;
  return `W-2/W-3 ${year}`;
}

/** The template's invoice window test, mirroring generateOne in recurring.ts. */
function withinTemplateWindow(
  template: { startsOn: string; endsOn: string | null },
  invoiceDate: string,
): boolean {
  if (invoiceDate < template.startsOn) return false;
  if (template.endsOn && invoiceDate > template.endsOn) return false;
  return true;
}

/** Deterministic code-point compare (localeCompare is host-dependent). */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** [monthStart, monthEnd] ISO bounds for the requested month (date-only). */
function monthBounds(year: number, month: number): { monthStart: string; monthEnd: string } {
  // Day 0 of the following month = last day of this month.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    monthStart: `${year}-${pad2(month)}-01`,
    monthEnd: `${year}-${pad2(month)}-${pad2(lastDay)}`,
  };
}

function inMonth(col: SQLWrapper, monthStart: string, monthEnd: string) {
  return and(gte(col, monthStart), lte(col, monthEnd));
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Per-source collectors
// ---------------------------------------------------------------------------

/**
 * Projected payday from the CURRENT schedule config (monthly only — the run
 * generator skips other frequencies). One event for the company-wide default
 * row, one per employee override.
 */
async function scheduledPaydays(db: Db, year: number, month: number): Promise<CalendarEvent[]> {
  const schedules = await db
    .select()
    .from(paySchedules)
    .where(and(eq(paySchedules.active, true), eq(paySchedules.frequency, "monthly")))
    .orderBy(asc(paySchedules.id));
  const overrideIds = schedules.map((s) => s.employeeId).filter((id): id is number => id !== null);
  const overrideNames = new Map<number, string>();
  if (overrideIds.length > 0) {
    const rows = await db
      .select({ id: employees.id, legalName: employees.legalName })
      .from(employees);
    for (const row of rows) {
      if (overrideIds.includes(row.id)) overrideNames.set(row.id, row.legalName);
    }
  }
  const events: CalendarEvent[] = [];
  for (const schedule of schedules) {
    const date = `${year}-${pad2(month)}-${pad2(schedule.payDayOfMonth)}`;
    if (schedule.employeeId === null) {
      events.push({
        date,
        kind: "payday_scheduled",
        label: "Scheduled payday (company schedule)",
        link: { name: "admin-payroll" },
      });
      continue;
    }
    const name = overrideNames.get(schedule.employeeId);
    if (!name) continue; // override for a deleted employee — skip
    events.push({
      date,
      kind: "payday_scheduled",
      label: `Scheduled payday — ${name}`,
      link: { name: "admin-employee-detail", params: { employeeId: schedule.employeeId } },
    });
  }
  return events;
}

/** Actual payroll-run pay dates in the month (void excluded). */
async function runPaydays(db: Db, monthStart: string, monthEnd: string): Promise<CalendarEvent[]> {
  const runs = await db
    .select({
      publicId: payrollRuns.publicId,
      payDate: payrollRuns.payDate,
      status: payrollRuns.status,
      legalName: employees.legalName,
    })
    .from(payrollRuns)
    .innerJoin(employees, eq(employees.id, payrollRuns.employeeId))
    .where(and(ne(payrollRuns.status, "void"), inMonth(payrollRuns.payDate, monthStart, monthEnd)))
    .orderBy(asc(payrollRuns.payDate));
  return runs.map((run) => ({
    date: run.payDate,
    kind: "payday_run" as const,
    label: `Payday — ${run.legalName}`,
    detail: `Run ${run.status}`,
    link: { name: "admin-payroll-run", params: { publicId: run.publicId } },
  }));
}

/**
 * Contractor recurring templates: the invoice-generation day in the
 * requested month, plus the payment-due day (pay_day_of_month of the month
 * FOLLOWING the invoice period — so payment events here derive from the
 * previous period's window).
 */
async function contractorEvents(db: Db, year: number, month: number): Promise<CalendarEvent[]> {
  const templates = await db
    .select({ template: contractorRecurringInvoices, legalName: employees.legalName })
    .from(contractorRecurringInvoices)
    .innerJoin(employees, eq(employees.id, contractorRecurringInvoices.employeeId))
    .where(eq(contractorRecurringInvoices.active, true))
    .orderBy(asc(contractorRecurringInvoices.id));
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const events: CalendarEvent[] = [];
  for (const { template, legalName } of templates) {
    const link = { name: "admin-contractor-detail", params: { employeeId: template.employeeId } };
    const invoiceDate = invoiceDateFor(template, year, month);
    if (withinTemplateWindow(template, invoiceDate)) {
      events.push({
        date: invoiceDate,
        kind: "contractor_invoice",
        label: `Invoice generates — ${legalName}`,
        detail: interpolateDescription(template.description, year, month),
        link,
      });
    }
    const prevInvoiceDate = invoiceDateFor(template, prevYear, prevMonth);
    if (withinTemplateWindow(template, prevInvoiceDate)) {
      events.push({
        date: `${year}-${pad2(month)}-${pad2(template.payDayOfMonth)}`,
        kind: "contractor_payment",
        label: `Contractor payment due — ${legalName}`,
        detail: interpolateDescription(template.description, prevYear, prevMonth),
        link,
      });
    }
  }
  return events;
}

/**
 * Spec 23 §7: federal rows keep "941 deposit due — August 2026"; state rows
 * read "California deposit due — Q3 2026" / "Illinois deposit due — July 2026", the label
 * built from the stored period_kind.
 */
function depositLabel(
  deposit: { jurisdiction: string; periodStart: string; periodKind: string; seq: number },
  what: "due" | "made",
): string {
  // PAY-193: an additional (seq > 0) deposit for an already-paid period.
  const prefix = deposit.seq > 0 ? "Additional " : "";
  if (deposit.jurisdiction === "federal") {
    return `${prefix}941 deposit ${what} — ${periodLabel(deposit.periodStart)}`;
  }
  const kind = deposit.periodKind === "quarter" ? "quarter" : "month";
  return `${prefix}${stateName(deposit.jurisdiction)} deposit ${what} — ${depositPeriodLabel(deposit.periodStart, kind)}`;
}

/** Deposit obligations (due_date) and actuals (deposited_on) in the month. */
async function depositEvents(
  db: Db,
  monthStart: string,
  monthEnd: string,
): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  const due = await db
    .select()
    .from(taxDeposits)
    .where(and(inMonth(taxDeposits.dueDate, monthStart, monthEnd), liveDeposit))
    .orderBy(asc(taxDeposits.dueDate));
  for (const deposit of due) {
    events.push({
      date: deposit.dueDate,
      kind: "deposit_due",
      label: depositLabel(deposit, "due"),
      // A 0.00 row has nothing to pay (spec 23 D5): say so, not "$0.00 · pending".
      detail: /^0+(\.0+)?$/.test(deposit.amount)
        ? "Nothing left to pay"
        : `$${deposit.amount} · ${deposit.status}`,
      link: { name: "admin-deposit-detail", params: { id: deposit.id } },
    });
  }
  const made = await db
    .select()
    .from(taxDeposits)
    .where(
      and(
        isNotNull(taxDeposits.depositedOn),
        inMonth(taxDeposits.depositedOn, monthStart, monthEnd),
      ),
    )
    .orderBy(asc(taxDeposits.depositedOn));
  for (const deposit of made) {
    if (!deposit.depositedOn) continue;
    events.push({
      date: deposit.depositedOn,
      kind: "deposit_made",
      label: depositLabel(deposit, "made"),
      detail: deposit.eftpsConfirmation ? `EFTPS ${deposit.eftpsConfirmation}` : undefined,
      link: { name: "admin-deposit-detail", params: { id: deposit.id } },
    });
  }
  return events;
}

/** Filing deadlines (due_date) and filing records (filed_on) in the month. */
async function filingEvents(
  db: Db,
  monthStart: string,
  monthEnd: string,
): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  const due = await db
    .select()
    .from(taxFilings)
    .where(inMonth(taxFilings.dueDate, monthStart, monthEnd))
    .orderBy(asc(taxFilings.dueDate));
  for (const filing of due) {
    events.push({
      date: filing.dueDate,
      kind: "filing_due",
      label: `${filingLabel(filing.formType, filing.year, filing.quarter)} due`,
      detail: filing.status,
      link: { name: "admin-filing", params: { id: filing.id } },
    });
  }
  const filed = await db
    .select()
    .from(taxFilings)
    .where(and(isNotNull(taxFilings.filedOn), inMonth(taxFilings.filedOn, monthStart, monthEnd)))
    .orderBy(asc(taxFilings.filedOn));
  for (const filing of filed) {
    if (!filing.filedOn) continue;
    events.push({
      date: filing.filedOn,
      kind: "filing_filed",
      label: `${filingLabel(filing.formType, filing.year, filing.quarter)} filed`,
      detail: filing.filingReference ?? filing.filingMethod ?? undefined,
      link: { name: "admin-filing", params: { id: filing.id } },
    });
  }
  return events;
}

/** W-8BEN / W-8BEN-E form expiries in the month (W-9 never expires). */
async function w8Expiries(db: Db, monthStart: string, monthEnd: string): Promise<CalendarEvent[]> {
  const rows = await db
    .select({
      employeeId: contractorDetails.employeeId,
      taxForm: contractorDetails.taxForm,
      formExpiresAt: contractorDetails.formExpiresAt,
      legalName: employees.legalName,
    })
    .from(contractorDetails)
    .innerJoin(employees, eq(employees.id, contractorDetails.employeeId))
    .where(
      and(
        isNotNull(contractorDetails.formExpiresAt),
        inMonth(contractorDetails.formExpiresAt, monthStart, monthEnd),
      ),
    )
    .orderBy(asc(contractorDetails.formExpiresAt));
  const events: CalendarEvent[] = [];
  for (const row of rows) {
    if (!row.formExpiresAt) continue;
    events.push({
      date: row.formExpiresAt,
      kind: "w8_expiry",
      label: `${row.taxForm === "w8ben_e" ? "W-8BEN-E" : "W-8BEN"} expires — ${row.legalName}`,
      link: { name: "admin-contractor-detail", params: { employeeId: row.employeeId } },
    });
  }
  return events;
}

/** Projected filing events for quarters with issued runs but no tax_filings row. */
async function projectedFilingEvents(
  db: Db,
  monthStart: string,
  monthEnd: string,
): Promise<CalendarEvent[]> {
  const today = new Date().toISOString().slice(0, 10);
  const events: CalendarEvent[] = [];

  const quartersWithRuns = await db
    .selectDistinct({
      year: sql<number>`extract(year from ${payrollRuns.payDate})::int`,
      quarter: sql<number>`extract(quarter from ${payrollRuns.payDate})::int`,
    })
    .from(payrollRuns)
    .where(eq(payrollRuns.status, "issued"));

  const existingFilings = await db
    .select({
      year: taxFilings.year,
      quarter: taxFilings.quarter,
    })
    .from(taxFilings)
    .where(eq(taxFilings.formType, "941"));

  const existingMap = new Set(existingFilings.map((f) => `${f.year}-${f.quarter}`));

  for (const { year, quarter } of quartersWithRuns) {
    const key = `${year}-${quarter}`;
    if (existingMap.has(key)) continue;

    const qEnd = filingsQuarterEnd(year, quarter);
    const dueDate = filingsFilingDueDate(year, quarter);

    const generatesDate = addDays(qEnd, 1);
    if (generatesDate > today && generatesDate >= monthStart && generatesDate <= monthEnd) {
      events.push({
        date: generatesDate,
        kind: "filing_generates",
        label: `Form 941 Q${quarter} ${year} generates`,
        detail: "Created by the daily filing sync",
        link: null,
      });
    }

    if (dueDate >= monthStart && dueDate <= monthEnd) {
      events.push({
        date: dueDate,
        kind: "filing_due_projected",
        label: `Form 941 Q${quarter} ${year} due (projected)`,
        detail: "Projected — filing not generated yet",
        link: null,
      });
    }
  }

  return events;
}

/**
 * Projected annual-form events (PAY-52). The w2_w3 row is year-close-only by
 * design, so without projection the January calendar never shows the W-2/W-3
 * deadline until the row already exists; the 940 row appears in-year but only
 * after the sync has seen the year's first issued run.
 */
async function projectedAnnualFilingEvents(
  db: Db,
  monthStart: string,
  monthEnd: string,
): Promise<CalendarEvent[]> {
  const today = new Date().toISOString().slice(0, 10);

  const yearsWithRuns = await db
    .selectDistinct({ year: sql<number>`extract(year from ${payrollRuns.payDate})::int` })
    .from(payrollRuns)
    .where(eq(payrollRuns.status, "issued"));

  const annualRows = await db
    .select({ year: taxFilings.year, formType: taxFilings.formType })
    .from(taxFilings)
    .where(and(inArray(taxFilings.formType, ["940", "w2_w3"]), eq(taxFilings.quarter, 0)));

  const existingByYear = new Map<number, Set<string>>();
  for (const row of annualRows) {
    const forms = existingByYear.get(row.year) ?? new Set<string>();
    forms.add(row.formType);
    existingByYear.set(row.year, forms);
  }

  const candidates: CalendarEvent[] = [];
  for (const { year } of yearsWithRuns) {
    const existing = existingByYear.get(year) ?? new Set<string>();
    const dueDate = annualDueDate(year);

    if (!existing.has("w2_w3")) {
      candidates.push(
        {
          date: w2AvailableOn(year),
          kind: "filing_generates",
          label: `W-2/W-3 ${year} generates`,
          detail: "Created by the daily filing sync",
          link: null,
        },
        {
          date: dueDate,
          kind: "filing_due_projected",
          label: `W-2/W-3 ${year} due (projected)`,
          detail: "Projected — filing not generated yet",
          link: null,
        },
      );
    }

    if (!existing.has("940")) {
      candidates.push({
        date: dueDate,
        kind: "filing_due_projected",
        label: `Form 940 ${year} due (projected)`,
        detail: "Projected — filing not generated yet",
        link: null,
      });
    }
  }

  return candidates.filter(
    (e) =>
      e.date >= monthStart &&
      e.date <= monthEnd &&
      (e.kind !== "filing_generates" || e.date > today),
  );
}

/**
 * Every calendar event falling inside (year, month), sorted by date then
 * kind then label for a stable grid rendering.
 */
export async function monthCalendar(db: Db, year: number, month: number): Promise<CalendarEvent[]> {
  const { monthStart, monthEnd } = monthBounds(year, month);
  // Sequential: PGlite (the test harness) is single-connection.
  const events = [
    ...(await scheduledPaydays(db, year, month)),
    ...(await runPaydays(db, monthStart, monthEnd)),
    ...(await contractorEvents(db, year, month)),
    ...(await depositEvents(db, monthStart, monthEnd)),
    ...(await filingEvents(db, monthStart, monthEnd)),
    ...(await projectedFilingEvents(db, monthStart, monthEnd)),
    ...(await projectedAnnualFilingEvents(db, monthStart, monthEnd)),
    ...(await w8Expiries(db, monthStart, monthEnd)),
  ];
  events.sort(
    (a, b) => compare(a.date, b.date) || compare(a.kind, b.kind) || compare(a.label, b.label),
  );
  return events;
}

/**
 * Quarterly Form 941 filings (PAY-10) — computed worksheet, filing-status
 * tracking, due-date reminders, and per-filing adjustment/notice records.
 * Record-only (D2): the app computes and tracks; the admin files by mail
 * (Letterstream) or e-file and marks the filing here.
 *
 * Determinism: every figure on the worksheet derives from frozen issued-run
 * entry snapshots (pay dates in the quarter) and deposited tax_deposits rows
 * — never live config. The worksheet JSON + SHA-256 hash make the figures
 * provably frozen; recomputation with the same inputs reproduces the same
 * hash. Once a filing is marked filed, the worksheet is never rewritten.
 *
 * Line 7 (fractions of cents, D4): per-paycheck rounding means the form's
 * wage-derived tax lines (5a/5c) can differ from the exact entry sums by a
 * cent or two. The default line 7 is that computed delta so line 12 equals
 * the true liability to the cent; the value is admin-editable while unfiled.
 *
 * All business logic lives here and is integration-tested WITHOUT pg-boss
 * (which needs a real Postgres) — payroll/scheduler.ts only wires the queue.
 */

import { and, asc, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import {
  appSettings,
  auditEvents,
  authUser,
  emailOutbox,
  payrollRuns,
  taxAdjustments,
  taxDeposits,
  taxFilings,
} from "@payroll/db";
import { round2 } from "@payroll/engine/money";
import { EVENT_TYPE, taxFilingDue as tplTaxFilingDue } from "@payroll/notifications";
import type { Db } from "../db.js";
import { templateContext } from "../notify/outbox.js";
import { computeDepositAmount, periodStartFor } from "../deposits/service.js";
import { compute940Worksheet, computeW3Worksheet, refreshAnnualWorksheet } from "./annual.js";
import {
  addDays,
  DATE_RE,
  type Deps,
  FilingServiceError,
  MONEY_RE,
  sumCategory,
  type TaxAdjustmentRow,
  type TaxFilingRow,
  W2W3_FILING_LOCK,
  toMoney,
  todayIso,
  worksheetHash,
} from "./shared.js";

// Re-exported: existing tests + routes import these from service.js.
export {
  DATE_RE,
  FilingServiceError,
  MONEY_RE,
  type TaxAdjustmentRow,
  type TaxFilingRow,
  worksheetHash,
} from "./shared.js";

/** D1 (filings): default reminder offsets — 2 weeks, 1 week, due day. */
export const DEFAULT_FILING_REMINDER_OFFSETS: readonly number[] = [14, 7, 0];
export const FILING_REMINDER_OFFSETS_SETTING_KEY = "tax_filing_reminder_offsets";
export const FILING_REMINDER_OFFSET_MAX = 30;
export const FILING_REMINDER_OFFSET_MAX_ENTRIES = 10;

const SS_COMBINED_RATE = 0.124; // Form 941 line 5a column 2 rate
const MEDICARE_COMBINED_RATE = 0.029; // line 5c column 2 rate
/** Line 12 under this → the line-16 de minimis box (no monthly breakdown owed). */
const DE_MINIMIS_THRESHOLD = 2500;

// ---------------------------------------------------------------------------
// Quarter math (pure)
// ---------------------------------------------------------------------------

/** [year, month] pairs for a quarter (month is 1-based). */
export function quarterMonths(year: number, quarter: number): [number, number][] {
  const first = (quarter - 1) * 3 + 1;
  return [
    [year, first],
    [year, first + 1],
    [year, first + 2],
  ];
}

/** Last day of the quarter ("2026-03-31"). */
export function quarterEnd(year: number, quarter: number): string {
  const d = new Date(Date.UTC(year, quarter * 3, 0)); // day 0 of the following month
  return d.toISOString().slice(0, 10);
}

/**
 * Filing due date for a quarter: Apr 30 / Jul 31 / Oct 31 / Jan 31 (Q4 rolls
 * into the next year), rolled forward to the next business day on weekends
 * (federal-holiday roll is out of scope, same as deposits).
 */
export function filingDueDate(year: number, quarter: number): string {
  const dueMonth: Record<number, [number, number]> = {
    1: [year, 4],
    2: [year, 7],
    3: [year, 10],
    4: [year + 1, 1],
  };
  const [y, m] = dueMonth[quarter]!;
  const last = new Date(Date.UTC(y, m, 0));
  while (last.getUTCDay() === 0 || last.getUTCDay() === 6) {
    last.setUTCDate(last.getUTCDate() + 1);
  }
  return last.toISOString().slice(0, 10);
}

/** "Q1 2026" — display label for a filing period. */
export function filingPeriodLabel(year: number, quarter: number): string {
  return quarter === 0 ? String(year) : `Q${quarter} ${year}`;
}

export function formLabel(formType: string): string {
  return formType === "941" ? "Form 941" : formType === "940" ? "Form 940" : "Forms W-2/W-3";
}

// ---------------------------------------------------------------------------
// The 941 worksheet — deterministic line-by-line computation
// ---------------------------------------------------------------------------

/**
 * The frozen worksheet shape. Fixed key order + no timestamps → the SHA-256
 * of JSON.stringify(worksheet) is stable across recomputation with the same
 * inputs (the spec's snapshot-hash stability rule).
 */
export interface Worksheet941 {
  form: "941";
  year: number;
  quarter: number;
  /** Pay period including the 12th of the quarter's first month. */
  line1Employees: number;
  line2Wages: string;
  line3FederalWithheld: string;
  line5aTaxableSsWages: string;
  line5aTax: string;
  line5cTaxableMedicareWages: string;
  line5cTax: string;
  line5dAdditionalMedicare: string;
  line5eTotal: string;
  line6TotalTaxes: string;
  line7FractionsOfCents: string;
  /**
   * The computed rounding delta (what line 7 would be without an admin
   * override). Stored alongside the effective value so refreshWorksheet can
   * tell "admin overrode line 7" apart from "still tracking the default".
   */
  line7Computed: string;
  line10TotalAfterAdjustments: string;
  line11ResearchCredit: string;
  line12TotalAfterCredits: string;
  /** Deposits for the quarter + adjustment payments linked to the filing. */
  line13Deposits: string;
  line14BalanceDue: string;
  line15Overpayment: string;
  line16: { month1: string; month2: string; month3: string; deMinimis: boolean };
}

/**
 * Compute the quarterly 941 worksheet from issued-run entry snapshots with
 * pay dates in the quarter. fractionsOfCents defaults to the computed delta
 * (D4); pass an override to re-render the totals chain with an admin-set
 * value (the override lives on the tax_filings row).
 */
export async function computeWorksheet(
  db: Db,
  year: number,
  quarter: number,
  opts: { filingId?: number; fractionsOfCents?: string } = {},
): Promise<Worksheet941> {
  const months = quarterMonths(year, quarter);
  const firstDay = periodStartFor(...months[0]!);
  const lastDay = quarterEnd(year, quarter);

  const runs = await db
    .select()
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.status, "issued"),
        sql`${payrollRuns.payDate} >= ${firstDay}`,
        sql`${payrollRuns.payDate} <= ${lastDay}`,
      ),
    );
  const runIds = runs.map((r) => r.id);

  // Line 1 — employees paid in the pay period including the 12th of the
  // quarter's first month.
  const periodKeyDay = `${firstDay.slice(0, 8)}12`;
  const line1 = new Set(
    runs
      .filter((r) => r.periodStart <= periodKeyDay && r.periodEnd >= periodKeyDay)
      .map((r) => r.employeeId),
  ).size;

  const [gross, fed, ssEE, ssER, medEE, medER] = await Promise.all([
    sumCategory(db, runIds, "gross_pay"),
    sumCategory(db, runIds, "federal_withholding"),
    sumCategory(db, runIds, "social_security"),
    sumCategory(db, runIds, "employer_social_security"),
    sumCategory(db, runIds, "medicare"),
    sumCategory(db, runIds, "employer_medicare"),
  ]);

  // Lines 5a/5c — derive taxable wages from the exact tax sums, then tax at
  // the combined statutory rate. Any cent-level difference vs the exact
  // entry sums lands in line 7 (fractions of cents).
  const ssTotal = round2(ssEE + ssER);
  const medTotal = round2(medEE + medER);
  const ssWages = round2(ssTotal / SS_COMBINED_RATE);
  const medWages = round2(medTotal / MEDICARE_COMBINED_RATE);
  const line5aTax = round2(ssWages * SS_COMBINED_RATE);
  const line5cTax = round2(medWages * MEDICARE_COMBINED_RATE);
  const line5d = 0; // Additional Medicare — zero at current salaries
  const line5e = round2(line5aTax + line5cTax + line5d);
  const line6 = round2(fed + line5e);

  // D4: default line 7 reconciles line 6 to the exact entry-derived
  // liability (fed + ss + med) to the cent; admin-editable while unfiled.
  const computedFractions = round2(fed + ssTotal + medTotal - line6);
  const line7 =
    opts.fractionsOfCents !== undefined ? Number(opts.fractionsOfCents) : computedFractions;

  const line10 = round2(line6 + line7); // lines 8/9 (other adjustments) = 0
  const line11 = 0; // R&D credit (no Form 8974)
  const line12 = round2(line10 - line11);

  // Line 13 — deposits for the quarter's months + adjustment payments.
  const depositRows = await db
    .select()
    .from(taxDeposits)
    .where(
      and(
        eq(taxDeposits.jurisdiction, "federal"),
        eq(taxDeposits.status, "deposited"),
        sql`${taxDeposits.periodStart} >= ${firstDay}`,
        sql`${taxDeposits.periodStart} <= ${lastDay}`,
      ),
    );
  let line13Total = depositRows.reduce((acc, d) => acc + Number(d.amount), 0);
  if (opts.filingId !== undefined) {
    const adjs = await db
      .select()
      .from(taxAdjustments)
      .where(eq(taxAdjustments.filingId, opts.filingId));
    line13Total += adjs.reduce((acc, a) => acc + Number(a.amountPaid), 0);
  }
  const line13 = round2(line13Total);

  const diff = round2(line12 - line13);
  const line14 = diff > 0 ? diff : 0;
  const line15 = diff < 0 ? -diff : 0;

  // Line 16 — monthly liability breakdown (same figures as the deposit
  // computation — liability by pay month, NOT deposits made).
  const [m1 = "0.00", m2 = "0.00", m3 = "0.00"] = await Promise.all(
    months.map(([y, m]) => computeDepositAmount(db, y, m)),
  );
  const line16 = {
    month1: m1,
    month2: m2,
    month3: m3,
    deMinimis: line12 < DE_MINIMIS_THRESHOLD,
  };

  return {
    form: "941",
    year,
    quarter,
    line1Employees: line1,
    line2Wages: toMoney(gross),
    line3FederalWithheld: toMoney(fed),
    line5aTaxableSsWages: toMoney(ssWages),
    line5aTax: toMoney(line5aTax),
    line5cTaxableMedicareWages: toMoney(medWages),
    line5cTax: toMoney(line5cTax),
    line5dAdditionalMedicare: toMoney(line5d),
    line5eTotal: toMoney(line5e),
    line6TotalTaxes: toMoney(line6),
    line7FractionsOfCents: toMoney(line7),
    line7Computed: toMoney(computedFractions),
    line10TotalAfterAdjustments: toMoney(line10),
    line11ResearchCredit: toMoney(line11),
    line12TotalAfterCredits: toMoney(line12),
    line13Deposits: toMoney(line13),
    line14BalanceDue: toMoney(line14),
    line15Overpayment: toMoney(line15),
    line16,
  };
}

// ---------------------------------------------------------------------------
// Reminder-offsets setting (D1 — admin-editable, app_settings key/value row)
// ---------------------------------------------------------------------------

function isValidOffsets(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= FILING_REMINDER_OFFSET_MAX_ENTRIES &&
    value.every((n) => Number.isInteger(n) && n >= 0 && n <= FILING_REMINDER_OFFSET_MAX)
  );
}

/** Stored offsets, or the default [14, 7, 0] when no row exists yet. */
export async function getFilingReminderOffsets(db: Db): Promise<number[]> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, FILING_REMINDER_OFFSETS_SETTING_KEY))
    .limit(1);
  const value = rows[0]?.value;
  return isValidOffsets(value)
    ? [...value].sort((a, b) => b - a)
    : [...DEFAULT_FILING_REMINDER_OFFSETS];
}

/** Persist a new reminder schedule (audit-logged like every admin mutation). */
export async function setFilingReminderOffsets(
  deps: Deps,
  offsets: number[],
  actorId: string,
): Promise<number[]> {
  const { db } = deps;
  if (!isValidOffsets(offsets)) {
    throw new FilingServiceError(
      "invalid_input",
      `offsets must be 1-${FILING_REMINDER_OFFSET_MAX_ENTRIES} integers between 0 and ${FILING_REMINDER_OFFSET_MAX}`,
    );
  }
  const normalized = [...new Set(offsets)].sort((a, b) => b - a);
  const before = await getFilingReminderOffsets(db);
  await db.transaction(async (tx) => {
    await tx
      .insert(appSettings)
      .values({
        key: FILING_REMINDER_OFFSETS_SETTING_KEY,
        value: normalized,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [appSettings.key],
        set: { value: normalized, updatedAt: new Date() },
      });
    await tx.insert(auditEvents).values({
      actorId,
      action: "settings.tax_filing_reminders",
      entity: "app_settings",
      entityId: FILING_REMINDER_OFFSETS_SETTING_KEY,
      before: { offsets: before },
      after: { offsets: normalized },
    });
  });
  return normalized;
}

// ---------------------------------------------------------------------------
// Filing sync (daily tick) — create ready rows for ended quarters + refresh
// ---------------------------------------------------------------------------

export interface FilingSyncResult {
  created: number;
  refreshed: number;
}

interface FreshWorksheet {
  worksheet: unknown;
  hash: string;
  /** 941 only: the fractions_of_cents value to persist alongside. */
  fractionsOfCents?: string;
}

/**
 * Compute the worksheet as it would look if recomputed NOW from frozen
 * issued-run entries + current config — read-only (no writes). Shared by the
 * unfiled-row refresh and the PAY-25 filed-row correction path. 941 line 7
 * stays admin-controlled: if the row's fractions_of_cents differs from the
 * last computed default, a human set it — preserve it.
 */
async function computeFreshWorksheet(db: Db, filing: TaxFilingRow): Promise<FreshWorksheet> {
  // PAY-11: annual forms (940 / W-2-W-3) compute through their own module.
  if (filing.formType !== "941") {
    const worksheet =
      filing.formType === "940"
        ? await compute940Worksheet(db, filing.year)
        : await computeW3Worksheet(db, filing.year);
    return { worksheet, hash: worksheetHash(worksheet) };
  }
  const base = await computeWorksheet(db, filing.year, filing.quarter, { filingId: filing.id });
  const previous = filing.worksheet as Worksheet941 | null;
  const adminOverride = previous !== null && filing.fractionsOfCents !== previous.line7Computed;
  const fractions = adminOverride ? filing.fractionsOfCents : base.line7FractionsOfCents;
  const worksheet =
    fractions === base.line7FractionsOfCents
      ? base
      : await computeWorksheet(db, filing.year, filing.quarter, {
          filingId: filing.id,
          fractionsOfCents: fractions,
        });
  return { worksheet, hash: worksheetHash(worksheet), fractionsOfCents: fractions };
}

/**
 * Recompute and persist the worksheet for an UNFILED filing. Line 7 stays
 * admin-controlled: if the row's fractions_of_cents still equals the
 * previously computed default it tracks the new computation; an overridden
 * value is preserved.
 */
async function refreshWorksheet(db: Db, filing: TaxFilingRow): Promise<boolean> {
  // PAY-11: annual forms (940 / W-2-W-3) refresh through their own module.
  if (filing.formType !== "941") return refreshAnnualWorksheet(db, filing);
  const fresh = await computeFreshWorksheet(db, filing);
  const fractions = fresh.fractionsOfCents ?? filing.fractionsOfCents;
  if (fresh.hash === filing.worksheetHash && filing.fractionsOfCents === fractions) return false;
  await db
    .update(taxFilings)
    .set({
      worksheet: fresh.worksheet,
      worksheetHash: fresh.hash,
      ...(fresh.fractionsOfCents !== undefined ? { fractionsOfCents: fresh.fractionsOfCents } : {}),
      updatedAt: new Date(),
    })
    .where(eq(taxFilings.id, filing.id));
  return true;
}

/**
 * Upsert a tax_filings row for every ENDED quarter with issued payroll
 * history (status not_started → ready with the computed worksheet), then
 * refresh worksheets for unfiled rows so late-issued runs and new deposits /
 * adjustments keep line 13 current. Filed rows are frozen forever.
 * Idempotent: the (form_type, year, quarter) unique constraint is the belt.
 */
export async function syncFilings(
  deps: Deps,
  opts: { today?: string } = {},
): Promise<FilingSyncResult> {
  const { db } = deps;
  const today = opts.today ?? todayIso();

  const quarters = await db
    .selectDistinct({
      year: sql<number>`extract(year from ${payrollRuns.payDate})::int`,
      quarter: sql<number>`extract(quarter from ${payrollRuns.payDate})::int`,
    })
    .from(payrollRuns)
    .where(eq(payrollRuns.status, "issued"));

  const result: FilingSyncResult = { created: 0, refreshed: 0 };

  for (const { year, quarter } of quarters) {
    if (quarterEnd(year, quarter) >= today) continue; // quarter not ended yet
    const dueDate = filingDueDate(year, quarter);

    const existing = await db
      .select()
      .from(taxFilings)
      .where(
        and(
          eq(taxFilings.formType, "941"),
          eq(taxFilings.year, year),
          eq(taxFilings.quarter, quarter),
        ),
      )
      .limit(1);
    let row = existing[0];

    if (!row) {
      const inserted = await db
        .insert(taxFilings)
        .values({
          formType: "941",
          year,
          quarter,
          dueDate,
          status: "ready",
          createdBy: "scheduler",
        })
        .returning();
      row = inserted[0]!;
      result.created += 1;
    }
    if (row.status !== "filed") {
      if (await refreshWorksheet(db, row)) result.refreshed += 1;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Admin queries + mutations
// ---------------------------------------------------------------------------

/** Filings, newest period first (admin list). Optional year/status/form filters. */
export async function listFilings(
  db: Db,
  filter: {
    year?: number | undefined;
    status?: "not_started" | "ready" | "filed" | undefined;
    formType?: "941" | "940" | "w2_w3" | undefined;
  } = {},
): Promise<TaxFilingRow[]> {
  const conditions = [];
  if (filter.year) conditions.push(eq(taxFilings.year, filter.year));
  if (filter.status) conditions.push(eq(taxFilings.status, filter.status));
  if (filter.formType) conditions.push(eq(taxFilings.formType, filter.formType));
  return db
    .select()
    .from(taxFilings)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(taxFilings.year), desc(taxFilings.quarter), desc(taxFilings.id));
}

/** Filing + its adjustment records (admin detail view). */
export async function getFilingDetail(
  db: Db,
  filingId: number,
): Promise<{
  filing: TaxFilingRow;
  adjustments: TaxAdjustmentRow[];
  corrections: CorrectionRow[];
}> {
  const rows = await db.select().from(taxFilings).where(eq(taxFilings.id, filingId)).limit(1);
  let filing = rows[0];
  if (!filing) throw new FilingServiceError("not_found", `tax filing ${filingId} not found`);
  // Reads refresh the worksheet while unfiled: line 13 tracks deposits and
  // adjustment payments recorded since the last daily sync, so the page the
  // admin looks at is never stale. Filed rows are frozen forever.
  if (filing.status !== "filed" && (await refreshWorksheet(db, filing))) {
    filing = (await db.select().from(taxFilings).where(eq(taxFilings.id, filingId)).limit(1))[0]!;
  }
  const adjustments = await db
    .select()
    .from(taxAdjustments)
    .where(eq(taxAdjustments.filingId, filingId))
    .orderBy(asc(taxAdjustments.noticeDate), asc(taxAdjustments.id));
  // PAY-25: past worksheet corrections surface on the detail page — a
  // corrected filing is never silently different from what was filed.
  const corrections = await db
    .select({
      id: sql<string>`${auditEvents.id}::text`,
      actorId: auditEvents.actorId,
      before: auditEvents.before,
      after: auditEvents.after,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entity, "tax_filing"),
        eq(auditEvents.entityId, String(filingId)),
        eq(auditEvents.action, "tax_filing.correct_worksheet"),
      ),
    )
    .orderBy(desc(auditEvents.id));
  return { filing, adjustments, corrections };
}

/** One worksheet-correction audit row, as shown on the filing detail page. */
export interface CorrectionRow {
  id: string;
  actorId: string;
  before: unknown;
  after: unknown;
  createdAt: Date | null;
}

export interface MarkFiledInput {
  filedOn: string;
  filingMethod: string;
  filingReference: string;
}

/**
 * Record a filing (D2 track-only). Filing is idempotent per row: an
 * already-filed row rejects with invalid_transition. Audit-logged in the
 * same transaction.
 */
export async function markFiled(
  deps: Deps,
  filingId: number,
  input: MarkFiledInput,
  actorId: string,
): Promise<TaxFilingRow> {
  const { db } = deps;
  if (!DATE_RE.test(input.filedOn)) {
    throw new FilingServiceError("invalid_input", "filedOn must be YYYY-MM-DD");
  }
  const method = input.filingMethod.trim();
  if (!method || method.length > 50) {
    throw new FilingServiceError("invalid_input", "filingMethod is required (max 50 characters)");
  }
  const reference = input.filingReference.trim();
  if (reference.length > 100) {
    throw new FilingServiceError("invalid_input", "filingReference max 100 characters");
  }

  const rows = await db.select().from(taxFilings).where(eq(taxFilings.id, filingId)).limit(1);
  const before = rows[0];
  if (!before) throw new FilingServiceError("not_found", `tax filing ${filingId} not found`);
  if (before.status === "filed") {
    throw new FilingServiceError("invalid_transition", "filing is already recorded");
  }

  return db.transaction(async (tx) => {
    // Spec 24 (PAY-116): state ID writes check filed w2_w3 years under this lock.
    if (before.formType === "w2_w3") await tx.execute(W2W3_FILING_LOCK);
    const updated = await tx
      .update(taxFilings)
      .set({
        status: "filed",
        filedOn: input.filedOn,
        filingMethod: method,
        filingReference: reference || null,
        updatedAt: new Date(),
      })
      .where(eq(taxFilings.id, filingId))
      .returning();

    await tx.insert(auditEvents).values({
      actorId,
      action: "tax_filing.file",
      entity: "tax_filing",
      entityId: String(filingId),
      before: { status: before.status, dueDate: before.dueDate },
      after: {
        status: "filed",
        filedOn: input.filedOn,
        filingMethod: method,
        filingReference: reference || null,
      },
    });
    return updated[0]!;
  });
}

// ---------------------------------------------------------------------------
// PAY-25: audited worksheet correction for FILED filings
// ---------------------------------------------------------------------------

export interface WorksheetRecomputePreview {
  beforeWorksheet: unknown;
  afterWorksheet: unknown;
  beforeHash: string | null;
  afterHash: string;
}

async function filedFilingForRecompute(db: Db, filingId: number): Promise<TaxFilingRow> {
  const rows = await db.select().from(taxFilings).where(eq(taxFilings.id, filingId)).limit(1);
  const filing = rows[0];
  if (!filing) throw new FilingServiceError("not_found", `tax filing ${filingId} not found`);
  if (filing.status !== "filed") {
    throw new FilingServiceError(
      "invalid_transition",
      "only filed filings can be recomputed — unfiled worksheets refresh automatically",
    );
  }
  return filing;
}

/**
 * Read-only preview for the correction dialog: what the worksheet would look
 * like recomputed from frozen issued-run entries + current config. Filed
 * rows only (the unfiled worksheet already tracks the data on every read).
 */
export async function previewWorksheetRecompute(
  db: Db,
  filingId: number,
): Promise<WorksheetRecomputePreview> {
  const filing = await filedFilingForRecompute(db, filingId);
  const fresh = await computeFreshWorksheet(db, filing);
  return {
    beforeWorksheet: filing.worksheet,
    afterWorksheet: fresh.worksheet,
    beforeHash: filing.worksheetHash,
    afterHash: fresh.hash,
  };
}

/**
 * Recompute a FILED filing's worksheet in place — the supported correction
 * path for a worksheet that froze with figures that never matched the actual
 * filing (precedent: the 2025 940 corrected out-of-band on 2026-09-03 with
 * the same tax_filing.correct_worksheet audit action). Requires a mandatory
 * free-text reason; writes the audit row (old hash → new hash + reason +
 * actor) in the same transaction as the update. Filing metadata — status,
 * filed_on, method, reference — is deliberately untouched: the correction
 * changes the worksheet record, never the fact or manner of the filing.
 */
export async function recomputeFiledWorksheet(
  deps: Deps,
  filingId: number,
  reason: string,
  actorId: string,
): Promise<TaxFilingRow> {
  const { db } = deps;
  const trimmed = reason.trim();
  if (!trimmed || trimmed.length > 500) {
    throw new FilingServiceError(
      "invalid_input",
      "a reason is required for a worksheet correction (max 500 characters)",
    );
  }
  const filing = await filedFilingForRecompute(db, filingId);
  const fresh = await computeFreshWorksheet(db, filing);

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(taxFilings)
      .set({
        worksheet: fresh.worksheet,
        worksheetHash: fresh.hash,
        ...(fresh.fractionsOfCents !== undefined
          ? { fractionsOfCents: fresh.fractionsOfCents }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(taxFilings.id, filingId))
      .returning();
    await tx.insert(auditEvents).values({
      actorId,
      action: "tax_filing.correct_worksheet",
      entity: "tax_filing",
      entityId: String(filingId),
      before: { worksheetHash: filing.worksheetHash },
      after: { worksheetHash: fresh.hash, reason: trimmed },
    });
    return updated[0]!;
  });
}

/**
 * D4: set Form 941 line 7 (fractions of cents). Allowed while unfiled; the
 * worksheet's totals chain is re-rendered with the value (new hash). Once
 * filed the worksheet is frozen.
 */
export async function setFractionsOfCents(
  deps: Deps,
  filingId: number,
  amount: string,
  actorId: string,
): Promise<TaxFilingRow> {
  const { db } = deps;
  if (!MONEY_RE.test(amount)) {
    throw new FilingServiceError("invalid_input", "amount must be a decimal, e.g. 0.01 or -0.02");
  }
  const normalized = round2(Number(amount)).toFixed(2);

  const { filing } = await getFilingDetail(db, filingId);
  if (filing.status === "filed") {
    throw new FilingServiceError(
      "invalid_transition",
      "filing is already recorded — worksheet frozen",
    );
  }

  const worksheet = await computeWorksheet(db, filing.year, filing.quarter, {
    filingId: filing.id,
    fractionsOfCents: normalized,
  });
  const hash = worksheetHash(worksheet);

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(taxFilings)
      .set({
        fractionsOfCents: normalized,
        worksheet,
        worksheetHash: hash,
        updatedAt: new Date(),
      })
      .where(eq(taxFilings.id, filingId))
      .returning();
    await tx.insert(auditEvents).values({
      actorId,
      action: "tax_filing.fractions_of_cents",
      entity: "tax_filing",
      entityId: String(filingId),
      before: { fractionsOfCents: filing.fractionsOfCents },
      after: { fractionsOfCents: normalized },
    });
    return updated[0]!;
  });
}

// ---------------------------------------------------------------------------
// Adjustments (D3 — first-class notice/penalty records)
// ---------------------------------------------------------------------------

export interface AdjustmentInput {
  kind: string;
  noticeDate?: string | undefined;
  amountDue: string;
  abatedAmount?: string | undefined;
  amountPaid?: string | undefined;
  paidOn?: string | undefined;
  eftpsConfirmation?: string | undefined;
  note?: string | undefined;
}

interface NormalizedAdjustment {
  kind: string;
  noticeDate?: string | undefined;
  amountDue: string;
  abatedAmount: string;
  amountPaid: string;
  paidOn?: string | undefined;
  eftpsConfirmation?: string | undefined;
  note: string;
}

function checkNonNegMoney(field: string, value: string): void {
  if (!MONEY_RE.test(value) || value.startsWith("-")) {
    throw new FilingServiceError("invalid_input", `${field} must be a non-negative decimal`);
  }
}

function checkIsoDate(field: string, value: string | undefined): void {
  if (value !== undefined && value !== "" && !DATE_RE.test(value)) {
    throw new FilingServiceError("invalid_input", `${field} must be YYYY-MM-DD`);
  }
}

function moneyField(value: string | undefined): string {
  return round2(Number(value ?? "0")).toFixed(2);
}

function validateAdjustment(input: AdjustmentInput): NormalizedAdjustment {
  const kind = input.kind.trim();
  if (!kind || kind.length > 50) {
    throw new FilingServiceError("invalid_input", "kind is required (max 50 characters)");
  }
  checkNonNegMoney("amountDue", input.amountDue);
  checkNonNegMoney("abatedAmount", input.abatedAmount ?? "0");
  checkNonNegMoney("amountPaid", input.amountPaid ?? "0");
  checkIsoDate("noticeDate", input.noticeDate);
  checkIsoDate("paidOn", input.paidOn);
  return {
    kind,
    amountDue: moneyField(input.amountDue),
    abatedAmount: moneyField(input.abatedAmount),
    amountPaid: moneyField(input.amountPaid),
    noticeDate: input.noticeDate || undefined,
    paidOn: input.paidOn || undefined,
    eftpsConfirmation: input.eftpsConfirmation?.trim() || undefined,
    note: input.note ?? "",
  };
}

/** Add a notice/adjustment to a filing; the worksheet's line 13 refreshes. */
export async function addAdjustment(
  deps: Deps,
  filingId: number,
  input: AdjustmentInput,
  actorId: string,
): Promise<TaxAdjustmentRow> {
  const { db } = deps;
  const { filing } = await getFilingDetail(db, filingId);
  if (filing.status === "filed") {
    throw new FilingServiceError("invalid_transition", "filing is already recorded");
  }
  const v = validateAdjustment(input);
  const created = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(taxAdjustments)
      .values({
        filingId,
        kind: v.kind,
        noticeDate: v.noticeDate ?? null,
        amountDue: v.amountDue,
        abatedAmount: v.abatedAmount,
        amountPaid: v.amountPaid,
        paidOn: v.paidOn ?? null,
        eftpsConfirmation: v.eftpsConfirmation ?? null,
        note: v.note ?? "",
        createdBy: actorId,
      })
      .returning();
    await tx.insert(auditEvents).values({
      actorId,
      action: "tax_adjustment.create",
      entity: "tax_adjustment",
      entityId: String(rows[0]!.id),
      before: null,
      after: { filingId, kind: v.kind, amountDue: v.amountDue, amountPaid: v.amountPaid },
    });
    return rows[0]!;
  });
  await refreshWorksheet(db, filing);
  return created;
}

/** Update an adjustment (e.g. record an abatement or a payment later). */
export async function updateAdjustment(
  deps: Deps,
  filingId: number,
  adjustmentId: number,
  input: AdjustmentInput,
  actorId: string,
): Promise<TaxAdjustmentRow> {
  const { db } = deps;
  const { filing } = await getFilingDetail(db, filingId);
  if (filing.status === "filed") {
    throw new FilingServiceError("invalid_transition", "filing is already recorded");
  }
  const existing = await db
    .select()
    .from(taxAdjustments)
    .where(and(eq(taxAdjustments.id, adjustmentId), eq(taxAdjustments.filingId, filingId)))
    .limit(1);
  const before = existing[0];
  if (!before) throw new FilingServiceError("not_found", `adjustment ${adjustmentId} not found`);
  const v = validateAdjustment(input);
  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(taxAdjustments)
      .set({
        kind: v.kind,
        noticeDate: v.noticeDate ?? null,
        amountDue: v.amountDue,
        abatedAmount: v.abatedAmount,
        amountPaid: v.amountPaid,
        paidOn: v.paidOn ?? null,
        eftpsConfirmation: v.eftpsConfirmation ?? null,
        note: v.note ?? "",
        updatedAt: new Date(),
      })
      .where(eq(taxAdjustments.id, adjustmentId))
      .returning();
    await tx.insert(auditEvents).values({
      actorId,
      action: "tax_adjustment.update",
      entity: "tax_adjustment",
      entityId: String(adjustmentId),
      before: {
        kind: before.kind,
        amountDue: before.amountDue,
        abatedAmount: before.abatedAmount,
        amountPaid: before.amountPaid,
      },
      after: {
        kind: v.kind,
        amountDue: v.amountDue,
        abatedAmount: v.abatedAmount,
        amountPaid: v.amountPaid,
      },
    });
    return rows[0]!;
  });
  await refreshWorksheet(db, filing);
  return updated;
}

/** Remove an adjustment recorded in error. */
export async function deleteAdjustment(
  deps: Deps,
  filingId: number,
  adjustmentId: number,
  actorId: string,
): Promise<void> {
  const { db } = deps;
  const { filing } = await getFilingDetail(db, filingId);
  if (filing.status === "filed") {
    throw new FilingServiceError("invalid_transition", "filing is already recorded");
  }
  const existing = await db
    .select()
    .from(taxAdjustments)
    .where(and(eq(taxAdjustments.id, adjustmentId), eq(taxAdjustments.filingId, filingId)))
    .limit(1);
  const before = existing[0];
  if (!before) throw new FilingServiceError("not_found", `adjustment ${adjustmentId} not found`);
  await db.transaction(async (tx) => {
    await tx.delete(taxAdjustments).where(eq(taxAdjustments.id, adjustmentId));
    await tx.insert(auditEvents).values({
      actorId,
      action: "tax_adjustment.delete",
      entity: "tax_adjustment",
      entityId: String(adjustmentId),
      before: {
        filingId,
        kind: before.kind,
        amountDue: before.amountDue,
        amountPaid: before.amountPaid,
      },
      after: null,
    });
  });
  await refreshWorksheet(db, filing);
}

// ---------------------------------------------------------------------------
// Due-date reminders (D1) — each configured offset fires at most once
// ---------------------------------------------------------------------------

async function adminUserIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(
      and(eq(authUser.role, "admin"), or(isNull(authUser.banned), eq(authUser.banned, false))),
    );
  return rows.map((r) => r.id);
}

/**
 * Send due-date reminders: for every unfiled filing and every configured
 * offset, mail all admins when today == due_date − offset and that offset has
 * not fired yet. reminders_sent is the dedupe record — re-ticks never
 * double-mail, and each offset fires at most once per filing.
 */
export async function sendFilingReminders(
  deps: Deps,
  opts: { today?: string } = {},
): Promise<{ sent: number }> {
  const { db, config } = deps;
  const today = opts.today ?? todayIso();
  const offsets = await getFilingReminderOffsets(db);

  const filings = await db
    .select()
    .from(taxFilings)
    .where(ne(taxFilings.status, "filed"))
    .orderBy(taxFilings.year, taxFilings.quarter);
  if (filings.length === 0) return { sent: 0 };

  const ctx = await templateContext(db, config);
  const admins = await adminUserIds(db);
  let sent = 0;

  for (const filing of filings) {
    const fired = new Set((filing.remindersSent as number[] | null) ?? []);
    for (const offset of offsets) {
      if (fired.has(offset)) continue;
      if (addDays(filing.dueDate, -offset) !== today) continue;

      const rendered = tplTaxFilingDue(ctx, {
        formLabel: formLabel(filing.formType),
        periodLabel: filingPeriodLabel(filing.year, filing.quarter),
        dueDate: filing.dueDate,
      });
      const marker = `filing-reminder:${filing.id}:${offset}`;
      for (const adminId of admins) {
        await db.insert(emailOutbox).values({
          userId: adminId,
          eventType: EVENT_TYPE.taxFilingDue,
          subject: rendered.subject,
          bodyHtml: `${rendered.html}<!-- ${marker} -->`,
        });
      }
      await db
        .update(taxFilings)
        .set({ remindersSent: [...fired, offset], updatedAt: new Date() })
        .where(eq(taxFilings.id, filing.id));
      fired.add(offset);
      sent += 1;
    }
  }
  return { sent };
}

/**
 * Monthly tax deposits (PAY-9 federal, PAY-47 state) — computed schedule,
 * due-date reminders, deposit tracking. Record-only (D3): EFTPS has no API,
 * so the app computes the amount, reminds admins, and records the deposit
 * date + confirmation number; the payment itself always happens on
 * eftps.gov (or the state equivalent).
 *
 * Monthly-depositor rule: the federal deposit for a month = employee
 * federal_withholding + social_security + medicare + employer_social_security
 * + employer_medicare across ISSUED payroll runs with pay_date in that month
 * (frozen entry snapshots, never live config — recomputation reproduces the
 * same amount to the cent). employer_futa is Form 940, out of scope. Due the
 * 15th of the following month, rolled forward off weekends (federal-holiday
 * roll deferred, V1).
 *
 * State rows (PAY-47): one row per work state per month from the frozen run
 * snapshots (inputs.state.workState), amount = the month's state_withholding
 * sum for that state; states with zero withholding get no row. Same due-date
 * convention V1 (15th of the following month, informational — real per-state
 * schedules differ and are a future refinement). The (jurisdiction,
 * period_start) unique constraint makes the daily sync idempotent.
 *
 * All business logic lives here and is integration-tested WITHOUT pg-boss
 * (which needs a real Postgres) — payroll/scheduler.ts only wires the queue.
 */

import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql, type SQLWrapper } from "drizzle-orm";
import {
  appSettings,
  auditEvents,
  authUser,
  emailOutbox,
  employees,
  payrollEntries,
  payrollRuns,
  stateDepositSchedules,
  taxDeposits,
} from "@payroll/db";
import { formatCents, formatMoney, parseCents, stateName } from "@payroll/shared";
import {
  EVENT_TYPE,
  taxDepositDue as tplTaxDepositDue,
  taxDepositShortfall as tplTaxDepositShortfall,
  taxDepositSyncFailed as tplTaxDepositSyncFailed,
  type TemplateContext,
} from "@payroll/notifications";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { templateContext } from "../notify/outbox.js";
import { filingDueDate } from "../filings/shared.js";
import {
  dueDateFor,
  periodLabel,
  periodStartFor,
  quarterOfMonth,
  stateDueDateFor,
  statePeriodStartFor,
  type PeriodKind,
  type StateSchedule,
} from "./periods.js";
import {
  nextSeq,
  PlanInputError,
  planStateQuarter,
  type DepositCredit,
  type LiveDepositRow,
  type QuarterPlan,
} from "./transition.js";

export {
  dueDateFor,
  periodLabel,
  periodStartFor,
  quarterOfMonth,
  stateDueDateFor,
  statePeriodStartFor,
  type PeriodKind,
  type StateSchedule,
};

export interface TaxDepositWithPeriodKind extends TaxDepositRow {
  periodKind: PeriodKind;
}

export type TaxDepositRow = typeof taxDeposits.$inferSelect;

/**
 * Spec 23 §5: a "live" deposit row is any row that has not been replaced by a
 * period transition. EVERY total, list or sum over tax_deposits must filter
 * on this fragment — superseded rows are kept for audit and are never counted.
 */
export const liveDeposit = sql`${taxDeposits.status} <> 'superseded'`;

/** The stored period_kind column, narrowed (the DB check keeps it to these two). */
export function withPeriodKind(row: TaxDepositRow): TaxDepositWithPeriodKind {
  return { ...row, periodKind: row.periodKind === "quarter" ? "quarter" : "month" };
}

/** PAY-36 — detail payload for GET /api/admin/tax-deposits/:id. */
interface DepositDetailBase {
  deposit: TaxDepositWithPeriodKind;
  breakdown: { category: string; amount: string }[];
  runs: { publicId: string; payDate: string; employeeName: string; amount: string }[];
}

/** A deposited row counted against this row's period (spec 23 §7). */
export interface DepositCreditRow {
  depositId: number;
  periodStart: string;
  periodKind: PeriodKind;
  depositedOn: string;
  /** The whole payment. */
  amount: string;
  /** The part of the payment counted toward THIS row (≤ amount). */
  applied: string;
}

/** PAY-36 detail + PAY-91 transition fields. All money as "0.00" strings. */
export interface DepositDetailRow extends DepositDetailBase {
  /** The unit's liability for this row's period (month or quarter). */
  liability: string;
  credits: DepositCreditRow[];
  /** Unit overpayment (D6); "0.00" normally. The explanatory note may use it on any row. */
  overpaid: string;
  /** True on the one row per state-quarter that carries the "Overpaid" chip. */
  overpaidAnchor: boolean;
  /** True when the period's payments could not be worked out (data error). */
  paymentsUnavailable: boolean;
  /** Superseded rows only: the live rows that replaced it. */
  replacedBy: { id: number; periodStart: string; periodKind: PeriodKind }[];
  /** PAY-193: the period's OTHER live rows (same jurisdiction, period, kind), seq ascending. */
  siblings: DepositSibling[];
  /** PAY-193: Σ siblings that are deposited or overdue (D9.6 F). */
  alreadyDeposited: string;
  /** PAY-193: on a seq 0 row, its live seq > 0 row (the highest seq); else null. */
  additionalDeposit: { id: number; amount: string } | null;
  /** PAY-193: federal rows — the Form 941 due date of the row's quarter; null for state rows. */
  form941DueDate: string | null;
}

export interface DepositSibling {
  id: number;
  seq: number;
  status: string;
  amount: string;
}

/** Live tax deposit row as listed (spec 23 §7: `overpaid` drives the list chip). */
export interface TaxDepositListRow extends TaxDepositWithPeriodKind {
  /** The state-quarter's overpayment — on its latest-period (anchor) row only; else "0.00". */
  overpaid: string;
  /** True when the period's payments could not be worked out (data error). */
  paymentsUnavailable: boolean;
}

export class DepositServiceError extends Error {
  constructor(
    public code: "not_found" | "invalid_input" | "invalid_transition",
    message: string,
  ) {
    super(message);
  }
}

interface Deps {
  db: Db;
  config: AppConfig;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Entry categories summed into the monthly deposit (NOT employer_futa). */
export const DEPOSIT_CATEGORIES = [
  "federal_withholding",
  "social_security",
  "medicare",
  "employer_social_security",
  "employer_medicare",
] as const;

/** D1: default reminder offsets (days before the due date) — the 10th + due day. */
export const DEFAULT_REMINDER_OFFSETS: readonly number[] = [5, 0];
export const REMINDER_OFFSETS_SETTING_KEY = "tax_deposit_reminder_offsets";
export const REMINDER_OFFSET_MAX = 30;
export const REMINDER_OFFSET_MAX_ENTRIES = 10;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** UTC-safe day arithmetic on ISO dates (no server-local timezone leakage). */
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The deposit amount for a month: the five deposit categories summed across
 * ISSUED runs with pay_date in the month. Draft/void/awaiting runs never
 * count. NUMERIC sum in SQL — exact decimal math, no floats, to the cent.
 */
export async function computeDepositAmount(
  db: Pick<Db, "select">,
  year: number,
  month: number,
): Promise<string> {
  const periodStart = periodStartFor(year, month);
  const rows = await db
    .select({
      total: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)::numeric(12,2)::text`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .where(
      and(
        eq(payrollRuns.status, "issued"),
        sql`date_trunc('month', ${payrollRuns.payDate})::date = ${periodStart}::date`,
        sql`${payrollEntries.category} IN (${sql.join(
          DEPOSIT_CATEGORIES.map((c) => sql`${c}`),
          sql`, `,
        )})`,
      ),
    );
  return rows[0]?.total ?? "0.00";
}

// ---------------------------------------------------------------------------
// Reminder-offsets setting (D1 — admin-editable, app_settings key/value row)
// ---------------------------------------------------------------------------

function isValidOffsets(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= REMINDER_OFFSET_MAX_ENTRIES &&
    value.every((n) => Number.isInteger(n) && n >= 0 && n <= REMINDER_OFFSET_MAX)
  );
}

/** Stored offsets, or the D1 default [5, 0] when no row exists yet. */
export async function getReminderOffsets(db: Db): Promise<number[]> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, REMINDER_OFFSETS_SETTING_KEY))
    .limit(1);
  const value = rows[0]?.value;
  return isValidOffsets(value) ? [...value].sort((a, b) => b - a) : [...DEFAULT_REMINDER_OFFSETS];
}

/** Persist a new reminder schedule (audit-logged like every admin mutation). */
export async function setReminderOffsets(
  deps: Deps,
  offsets: number[],
  actorId: string,
): Promise<number[]> {
  const { db } = deps;
  if (!isValidOffsets(offsets)) {
    throw new DepositServiceError(
      "invalid_input",
      `offsets must be 1-${REMINDER_OFFSET_MAX_ENTRIES} integers between 0 and ${REMINDER_OFFSET_MAX}`,
    );
  }
  const normalized = [...new Set(offsets)].sort((a, b) => b - a);
  const before = await getReminderOffsets(db);
  await db.transaction(async (tx) => {
    await tx
      .insert(appSettings)
      .values({ key: REMINDER_OFFSETS_SETTING_KEY, value: normalized, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [appSettings.key],
        set: { value: normalized, updatedAt: new Date() },
      });
    await tx.insert(auditEvents).values({
      actorId,
      action: "settings.tax_deposit_reminders",
      entity: "app_settings",
      entityId: REMINDER_OFFSETS_SETTING_KEY,
      before: { offsets: before },
      after: { offsets: normalized },
    });
  });
  return normalized;
}

function toStateSchedule(row: typeof stateDepositSchedules.$inferSelect): StateSchedule {
  const frequency = row.frequency as "monthly" | "quarterly";
  return {
    frequency,
    dueDay: row.dueDay,
  };
}

/** Load all state deposit schedules into a Map keyed by "stateCode:taxYear". */
async function loadStateSchedules(db: Pick<Db, "select">): Promise<Map<string, StateSchedule>> {
  const rows = await db.select().from(stateDepositSchedules);
  const map = new Map<string, StateSchedule>();
  for (const row of rows) {
    const key = `${row.stateCode}:${row.taxYear}`;
    map.set(key, toStateSchedule(row));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Deposit sync (daily tick) — federal upsert + state period planner (PAY-91)
// ---------------------------------------------------------------------------

export interface SyncResult {
  created: number;
  recomputed: number;
  flippedOverdue: number;
  /** PAY-91: rows replaced by a monthly <-> quarterly period transition. */
  superseded: number;
  /** PAY-91: state units skipped because their data could not be planned. */
  failedUnits: number;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** PAY-193 D9.6: the audit row written for every shortfall insert (seq > 0). */
async function auditShortfall(
  db: Tx,
  id: number,
  row: {
    jurisdiction: string;
    periodStart: string;
    periodKind: PeriodKind;
    seq: number;
    cents: number;
  },
): Promise<void> {
  await db.insert(auditEvents).values({
    actorId: "scheduler",
    action: "tax_deposit.shortfall_created",
    entity: "tax_deposit",
    entityId: String(id),
    after: {
      jurisdiction: row.jurisdiction,
      periodStart: row.periodStart,
      periodKind: row.periodKind,
      seq: row.seq,
      cents: row.cents,
    },
  });
}

/**
 * PAY-193: one email_outbox row per active admin for a new shortfall row
 * (seq > 0). No amounts; "already past its due date" when inserted overdue.
 */
async function mailShortfall(
  db: Tx,
  config: AppConfig,
  row: { jurisdiction: string; periodStart: string; periodKind: PeriodKind; overdue: boolean },
): Promise<void> {
  const ctx = await templateContext(db, config);
  const rendered = tplTaxDepositShortfall(ctx, {
    jurisdictionLabel: stateName(row.jurisdiction),
    periodLabel: periodLabel(row.periodStart, row.periodKind),
    overdue: row.overdue,
  });
  for (const userId of await adminUserIds(db)) {
    await db.insert(emailOutbox).values({
      userId,
      eventType: EVENT_TYPE.taxDepositShortfall,
      subject: rendered.subject,
      bodyHtml: rendered.html,
    });
  }
}

/**
 * Federal (PAY-9, PAY-193 D9.6): one month row per pay month, plus shortfall
 * rows. Deposited and overdue rows are frozen. L = the month's liability,
 * F = Σ live deposited + overdue rows, R = L − F. The open pending row (at
 * most one, the highest seq) takes max(0, R); with no pending row and R > 0 a
 * shortfall row (seq = max + 1) is inserted on the ORIGINAL due date,
 * overdue if that date has passed. R < 0 writes nothing (overpayment is out
 * of scope). The first row of a month (seq 0) is inserted as before.
 */
async function syncFederalDeposit(
  db: Tx,
  config: AppConfig,
  periodStart: string,
  today: string,
  result: SyncResult,
) {
  const year = Number(periodStart.slice(0, 4));
  const month = Number(periodStart.slice(5, 7));
  const amount = await computeDepositAmount(db, year, month);
  const dueDate = dueDateFor(year, month);

  const live = await db
    .select()
    .from(taxDeposits)
    .where(
      and(
        eq(taxDeposits.jurisdiction, "federal"),
        eq(taxDeposits.periodStart, periodStart),
        eq(taxDeposits.periodKind, "month"),
        liveDeposit,
      ),
    )
    .orderBy(desc(taxDeposits.seq), desc(taxDeposits.id));

  if (live.length === 0) {
    await db.insert(taxDeposits).values({
      jurisdiction: "federal",
      periodStart,
      amount,
      dueDate,
      status: "pending",
      createdBy: "scheduler",
    });
    result.created += 1;
    return;
  }

  let frozen = 0;
  for (const r of live) if (r.status !== "pending") frozen += parseCents(r.amount);
  const remainder = parseCents(amount) - frozen;
  const pending = live.find((r) => r.status === "pending");
  if (pending) {
    const target = formatCents(Math.max(0, remainder));
    if (pending.amount !== target) {
      // Race guard: a row recorded as deposited since the read keeps its amount.
      const updated = await db
        .update(taxDeposits)
        .set({ amount: target, updatedAt: new Date() })
        .where(and(eq(taxDeposits.id, pending.id), eq(taxDeposits.status, "pending")))
        .returning({ id: taxDeposits.id });
      result.recomputed += updated.length;
    }
    return;
  }
  if (remainder <= 0) return;
  const seq = nextSeq(live);
  const status = dueDate < today ? "overdue" : "pending";
  const inserted = await db
    .insert(taxDeposits)
    .values({
      jurisdiction: "federal",
      periodStart,
      seq,
      amount: formatCents(remainder),
      dueDate,
      status,
      createdBy: "scheduler",
    })
    .returning({ id: taxDeposits.id });
  result.created += 1;
  for (const { id } of inserted) {
    await auditShortfall(db, id, {
      jurisdiction: "federal",
      periodStart,
      periodKind: "month",
      seq,
      cents: remainder,
    });
    await mailShortfall(db, config, {
      jurisdiction: "federal",
      periodStart,
      periodKind: "month",
      overdue: status === "overdue",
    });
  }
}

/** One (state, year, quarter) planning unit (spec 23 §6). */
interface StateUnit {
  state: string;
  year: number;
  quarter: number;
  liability: [number, number, number];
  live: LiveDepositRow[];
}

function unitKey(state: string, year: number, quarter: number): string {
  return `${state}:${year}:${quarter}`;
}

function toLiveRow(row: TaxDepositRow): LiveDepositRow {
  return {
    id: row.id,
    kind: withPeriodKind(row).periodKind,
    periodStart: row.periodStart,
    cents: parseCents(row.amount),
    status: row.status as LiveDepositRow["status"],
    dueDate: row.dueDate,
    depositedOn: row.depositedOn,
    seq: row.seq,
  };
}

/**
 * Issued-run state withholding in cents per (state, pay month). Year and
 * quarter come from the PAY DATE (R1); the work state from the frozen run
 * snapshot. Exact NUMERIC sums, parsed to cents.
 */
async function loadStateLiability(
  db: Pick<Db, "select">,
  filter?: { state: string; year: number; quarter: number },
): Promise<{ state: string; month: string; cents: number }[]> {
  const workState = sql<string>`(${payrollRuns.runSnapshot}#>>'{inputs,state,workState}')`;
  const month = sql<string>`to_char(date_trunc('month', ${payrollRuns.payDate})::date, 'YYYY-MM-DD')`;
  const conditions: SQLWrapper[] = [
    eq(payrollRuns.status, "issued"),
    eq(payrollEntries.category, "state_withholding"),
    sql`${workState} IS NOT NULL`,
  ];
  if (filter) {
    const first = periodStartFor(filter.year, (filter.quarter - 1) * 3 + 1);
    conditions.push(sql`${workState} = ${filter.state}`);
    conditions.push(sql`date_trunc('quarter', ${payrollRuns.payDate})::date = ${first}::date`);
  }
  const rows = await db
    .select({
      state: workState,
      month,
      amount: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)::numeric(12,2)::text`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .where(and(...conditions))
    .groupBy(workState, month);
  return rows.map((r) => ({ state: r.state, month: r.month, cents: parseCents(r.amount) }));
}

function unitFor(units: Map<string, StateUnit>, state: string, periodStart: string): StateUnit {
  const year = Number(periodStart.slice(0, 4));
  const quarter = quarterOfMonth(Number(periodStart.slice(5, 7)));
  const key = unitKey(state, year, quarter);
  let unit = units.get(key);
  if (!unit) {
    unit = { state, year, quarter, liability: [0, 0, 0], live: [] };
    units.set(key, unit);
  }
  return unit;
}

/** Units = DISTINCT (state, year, quarter) of issued state runs ∪ live state rows. */
async function loadStateUnits(
  db: Pick<Db, "select">,
  filter?: { state: string; year: number; quarter: number },
): Promise<StateUnit[]> {
  const units = new Map<string, StateUnit>();
  for (const l of await loadStateLiability(db, filter)) {
    const unit = unitFor(units, l.state, l.month);
    const m = (Number(l.month.slice(5, 7)) - 1) % 3;
    unit.liability[m] = (unit.liability[m] ?? 0) + l.cents;
  }
  const conditions: SQLWrapper[] = [sql`${taxDeposits.jurisdiction} <> 'federal'`, liveDeposit];
  if (filter) {
    const first = periodStartFor(filter.year, (filter.quarter - 1) * 3 + 1);
    conditions.push(eq(taxDeposits.jurisdiction, filter.state));
    conditions.push(sql`date_trunc('quarter', ${taxDeposits.periodStart})::date = ${first}::date`);
  }
  const rows = await db
    .select()
    .from(taxDeposits)
    .where(and(...conditions))
    .orderBy(taxDeposits.id);
  for (const row of rows) {
    unitFor(units, row.jurisdiction, row.periodStart).live.push(toLiveRow(row));
  }
  return [...units.values()].sort((a, b) =>
    unitKey(a.state, a.year, a.quarter) < unitKey(b.state, b.year, b.quarter) ? -1 : 1,
  );
}

function planUnit(
  unit: StateUnit,
  schedules: Map<string, StateSchedule>,
  today: string,
): QuarterPlan {
  return planStateQuarter({
    year: unit.year,
    quarter: unit.quarter,
    // Schedule by pay-date year (R1): the unit's year.
    schedule: schedules.get(`${unit.state}:${unit.year}`) ?? null,
    liability: unit.liability,
    live: unit.live,
    today,
  });
}

/** Apply one unit's plan: supersede, then update, then insert (the index needs that order). */
async function applyPlan(
  tx: Tx,
  config: AppConfig,
  unit: StateUnit,
  plan: QuarterPlan,
  result: SyncResult,
): Promise<void> {
  const now = new Date();
  const open = ["pending", "overdue"];
  const superseded = plan.supersede.length
    ? await tx
        .update(taxDeposits)
        .set({ status: "superseded", supersededAt: now, updatedAt: now })
        // Guard: a deposited row is never superseded.
        .where(and(inArray(taxDeposits.id, plan.supersede), inArray(taxDeposits.status, open)))
        .returning({ id: taxDeposits.id })
    : [];
  for (const u of plan.updates) {
    await tx
      .update(taxDeposits)
      .set({ amount: formatCents(u.cents), dueDate: u.dueDate, status: u.status, updatedAt: now })
      .where(and(eq(taxDeposits.id, u.id), inArray(taxDeposits.status, open)));
  }
  const inserted = plan.inserts.length
    ? await tx
        .insert(taxDeposits)
        .values(
          plan.inserts.map((i) => ({
            jurisdiction: unit.state,
            periodStart: i.periodStart,
            periodKind: i.kind,
            seq: i.seq,
            amount: formatCents(i.cents),
            dueDate: i.dueDate,
            status: i.status,
            createdBy: "scheduler",
          })),
        )
        .returning({ id: taxDeposits.id })
    : [];
  result.superseded += superseded.length;
  result.recomputed += plan.updates.length;
  result.created += inserted.length;
  for (const [n, r] of inserted.entries()) {
    const i = plan.inserts[n];
    if (!i || i.seq === 0) continue;
    await auditShortfall(tx, r.id, {
      jurisdiction: unit.state,
      periodStart: i.periodStart,
      periodKind: i.kind,
      seq: i.seq,
      cents: i.cents,
    });
    await mailShortfall(tx, config, {
      jurisdiction: unit.state,
      periodStart: i.periodStart,
      periodKind: i.kind,
      overdue: i.status === "overdue",
    });
  }

  if (superseded.length > 0) {
    const beforeRows = unit.live.filter((r) => plan.supersede.includes(r.id));
    await tx.insert(auditEvents).values({
      actorId: "scheduler",
      action: "tax_deposit.period_transition",
      entity: "tax_deposit",
      entityId: `${unit.state}:${unit.year}-Q${unit.quarter}`,
      before: { rows: beforeRows },
      after: {
        superseded: superseded.map((r) => r.id),
        updated: plan.updates,
        inserted: inserted.map((r, n) => ({ id: r.id, ...plan.inserts[n] })),
        liabilityCents: plan.liabilityCents,
        creditsCents: plan.depositedCents,
        overpaidCents: plan.overpaidCents,
      },
    });
  }
}

/** Serialises the deposit sync (daily tick, seed-qa, e2e serve) — spec 23 §6. */
const SYNC_LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('tax_deposits_state_sync'))`;

/**
 * Upsert the computed deposit schedule for every pay month with issued
 * payroll history — INCLUDING the current month (PAY-14): the row appears as
 * soon as a run issues, because deposits are typically paid right after
 * payroll, weeks before the due date. Then flip past-due pending rows with
 * something to pay to 'overdue'.
 *
 * Federal rows: one per month (PAY-9), pending amounts recomputed.
 * State rows (PAY-47/48/91): one plan per (state, year, quarter) unit from
 * `planStateQuarter` — quarterly schedules merge into one quarter row,
 * monthly (or no schedule) keep month rows, and a schedule change supersedes
 * the replaced rows (kept for audit, never counted). Deposited rows are
 * never touched. The whole sync runs in one transaction under an advisory
 * lock; re-running it is a no-op (the planner writes only changed fields).
 */
export async function syncDeposits(deps: Deps, opts: { today?: string } = {}): Promise<SyncResult> {
  const { db } = deps;
  const today = opts.today ?? todayIso();
  const result: SyncResult = {
    created: 0,
    recomputed: 0,
    flippedOverdue: 0,
    superseded: 0,
    failedUnits: 0,
  };
  const failed: FailedUnit[] = [];

  await db.transaction(async (tx) => {
    // The federal loop shares the lock: two concurrent syncs would otherwise
    // both insert the same new federal month (select-then-insert).
    await tx.execute(SYNC_LOCK);
    const months = await tx
      .selectDistinct({
        periodStart: sql<string>`to_char(date_trunc('month', ${payrollRuns.payDate})::date, 'YYYY-MM-DD')`,
      })
      .from(payrollRuns)
      .where(eq(payrollRuns.status, "issued"))
      .orderBy(sql`1`);
    for (const { periodStart } of months) {
      await syncFederalDeposit(tx, deps.config, periodStart, today, result);
    }

    const schedules = await loadStateSchedules(tx);
    for (const unit of await loadStateUnits(tx)) {
      // One bad unit never stops the federal rows or the other units: each
      // unit runs in its own savepoint and is skipped (and reported) on error.
      const unitResult: SyncResult = { ...EMPTY_RESULT };
      try {
        await tx.transaction(async (sp) => {
          await applyPlan(sp, deps.config, unit, planUnit(unit, schedules, today), unitResult);
        });
      } catch (err) {
        failed.push({ unit, code: failureCode(err) });
        continue;
      }
      result.created += unitResult.created;
      result.recomputed += unitResult.recomputed;
      result.superseded += unitResult.superseded;
    }

    const flipped = await tx
      .update(taxDeposits)
      .set({ status: "overdue", updatedAt: new Date() })
      .where(
        and(
          eq(taxDeposits.status, "pending"),
          lt(taxDeposits.dueDate, today),
          sql`${taxDeposits.amount} > 0`,
        ),
      )
      .returning({ id: taxDeposits.id });
    result.flippedOverdue = flipped.length;

    // Report skipped units while still holding the advisory lock, so two
    // concurrent syncs cannot both alert. Each report has its own savepoint:
    // an alert failure is logged (unit label only) and never fails the tick.
    for (const f of failed) {
      const label = unitLabel(f.unit);
      console.warn(`[deposits] state unit ${label} skipped (${f.code})`);
      try {
        await tx.transaction(async (sp) => {
          await reportFailedUnit(sp, deps.config, f, today);
        });
      } catch {
        console.warn(`[deposits] alert for state unit ${label} failed`);
      }
    }
  });

  result.failedUnits = failed.length;
  return result;
}

const EMPTY_RESULT: SyncResult = {
  created: 0,
  recomputed: 0,
  flippedOverdue: 0,
  superseded: 0,
  failedUnits: 0,
};

interface FailedUnit {
  unit: StateUnit;
  /** Safe to log: no amounts, no PII. */
  code: string;
}

/**
 * Safe-to-log failure code: the planner's code, else the SQLSTATE of a
 * database error, else the error class. Never the message or detail (they
 * can carry amounts or row data).
 */
export function failureCode(err: unknown): string {
  if (err instanceof PlanInputError) return err.code;
  for (let e: unknown = err, depth = 0; e && depth < 5; depth += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return `sqlstate_${code}`;
    e = (e as { cause?: unknown }).cause;
  }
  if (!(err instanceof Error)) return "unexpected_error";
  const name = err.constructor.name;
  return /^[A-Za-z]{1,40}$/.test(name) ? `error_${name}` : "unexpected_error";
}

function unitLabel(unit: { state: string; year: number; quarter: number }): string {
  return `${unit.state}:${unit.year}-Q${unit.quarter}`;
}

/**
 * A skipped state unit (spec 23): once per unit per day, record an audit
 * event and mail every admin through the outbox. Runs inside the sync
 * transaction, under the advisory lock, in its own savepoint (the caller
 * logs the unit and swallows a failure here).
 */
async function reportFailedUnit(
  tx: Tx,
  config: AppConfig,
  f: FailedUnit,
  today: string,
): Promise<void> {
  const entityId = unitLabel(f.unit);
  const seen = await tx
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, "tax_deposit.sync_failed"),
        eq(auditEvents.entityId, entityId),
        sql`${auditEvents.after}->>'day' = ${today}`,
      ),
    )
    .limit(1);
  if (seen.length > 0) return;
  const ctx = await templateContext(tx, config);
  const admins = await adminUserIds(tx);
  const rendered = tplTaxDepositSyncFailed(ctx, {
    jurisdictionLabel: stateName(f.unit.state),
    periodLabel: `Q${f.unit.quarter} ${f.unit.year}`,
  });
  await tx.insert(auditEvents).values({
    actorId: "scheduler",
    action: "tax_deposit.sync_failed",
    entity: "tax_deposit",
    entityId,
    before: null,
    after: { day: today, code: f.code },
  });
  for (const userId of admins) {
    await tx.insert(emailOutbox).values({
      userId,
      eventType: EVENT_TYPE.taxDepositSyncFailed,
      subject: rendered.subject,
      bodyHtml: rendered.html, // dedupe is the audit event, not a marker
    });
  }
}

// ---------------------------------------------------------------------------
// Admin queries + the mark-deposited mutation
// ---------------------------------------------------------------------------

/** Deposits, newest period first (admin list). PAY-15: optional year/status filters. */
export async function listDeposits(
  db: Db,
  filter: {
    year?: number | undefined;
    status?: "pending" | "deposited" | "overdue" | undefined;
    jurisdiction?: string | undefined;
  } = {},
): Promise<TaxDepositListRow[]> {
  const conditions: SQLWrapper[] = [liveDeposit];
  if (filter.year) {
    conditions.push(sql`${taxDeposits.periodStart} >= ${`${filter.year}-01-01`}`);
    conditions.push(sql`${taxDeposits.periodStart} <= ${`${filter.year}-12-31`}`);
  }
  if (filter.status) conditions.push(eq(taxDeposits.status, filter.status));
  if (filter.jurisdiction) conditions.push(eq(taxDeposits.jurisdiction, filter.jurisdiction));
  const rows = await db
    .select()
    .from(taxDeposits)
    .where(and(...conditions))
    .orderBy(desc(taxDeposits.periodStart), desc(taxDeposits.id));
  const units = rows.some((r) => r.jurisdiction !== "federal")
    ? await unitOverpayments(db)
    : new Map<string, UnitOverpayment>();
  return rows.map((row) => {
    const unit = units.get(
      unitKey(
        row.jurisdiction,
        Number(row.periodStart.slice(0, 4)),
        quarterOfMonth(Number(row.periodStart.slice(5, 7))),
      ),
    );
    const anchored = unit?.anchorId === row.id;
    return {
      ...withPeriodKind(row),
      overpaid: formatCents(anchored ? (unit?.cents ?? 0) : 0),
      paymentsUnavailable: unit?.failed ?? false,
    };
  });
}

type UnitOverpayment =
  | { failed: false; cents: number; anchorId: number | null }
  | { failed: true; cents: 0; anchorId: null };

/**
 * Overpayment (D6) and its anchor row per state unit, from the planner run
 * read-only. A unit whose data cannot be planned is flagged, never a 500.
 */
async function unitOverpayments(db: Db): Promise<Map<string, UnitOverpayment>> {
  const schedules = await loadStateSchedules(db);
  const today = todayIso();
  const out = new Map<string, UnitOverpayment>();
  for (const unit of await loadStateUnits(db)) {
    const key = unitKey(unit.state, unit.year, unit.quarter);
    try {
      const plan = planUnit(unit, schedules, today);
      out.set(key, { failed: false, cents: plan.overpaidCents, anchorId: plan.overpaidAnchorId });
    } catch {
      out.set(key, { failed: true, cents: 0, anchorId: null });
    }
  }
  return out;
}

export interface MarkDepositedInput {
  depositedOn: string;
  eftpsConfirmation: string;
}

/**
 * Record an EFTPS deposit (D3 record-only). Depositing is idempotent per row:
 * an already-deposited row rejects with invalid_transition. Audit-logged in
 * the same transaction.
 */
export async function markDeposited(
  deps: Deps,
  depositId: number,
  input: MarkDepositedInput,
  actorId: string,
): Promise<TaxDepositWithPeriodKind> {
  const { db } = deps;
  if (!DATE_RE.test(input.depositedOn)) {
    throw new DepositServiceError("invalid_input", "depositedOn must be YYYY-MM-DD");
  }
  const confirmation = input.eftpsConfirmation.trim();
  if (!confirmation || confirmation.length > 100) {
    throw new DepositServiceError(
      "invalid_input",
      "eftpsConfirmation is required (max 100 characters)",
    );
  }

  const rows = await db.select().from(taxDeposits).where(eq(taxDeposits.id, depositId)).limit(1);
  const before = rows[0];
  if (!before) {
    throw new DepositServiceError("not_found", `tax deposit ${depositId} not found`);
  }
  if (before.status === "deposited") {
    throw new DepositServiceError("invalid_transition", "deposit is already recorded");
  }
  // Spec 23 §5 / D5: a replaced row, or a 0.00 row, has nothing to pay.
  if (before.status === "superseded" || parseCents(before.amount) === 0) {
    throw new DepositServiceError("invalid_transition", "This deposit has nothing left to record.");
  }

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(taxDeposits)
      .set({
        status: "deposited",
        depositedOn: input.depositedOn,
        eftpsConfirmation: confirmation,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(taxDeposits.id, depositId),
          inArray(taxDeposits.status, ["pending", "overdue"]),
          // Race guard: the sync may have set the row to 0.00 since the read.
          sql`${taxDeposits.amount} > 0`,
        ),
      )
      .returning();
    const row = updated[0];
    if (!row) {
      // Lost a race with the sync (superseded) or another recorder.
      throw new DepositServiceError(
        "invalid_transition",
        "This deposit has nothing left to record.",
      );
    }

    await tx.insert(auditEvents).values({
      actorId,
      action: "tax_deposit.deposit",
      entity: "tax_deposit",
      entityId: String(depositId),
      before: { status: before.status, amount: before.amount, dueDate: before.dueDate },
      after: {
        status: "deposited",
        depositedOn: input.depositedOn,
        eftpsConfirmation: confirmation,
      },
    });
    return withPeriodKind(row);
  });
}

// ---------------------------------------------------------------------------
// Due-date reminders (D1) — each configured offset fires at most once
// ---------------------------------------------------------------------------

async function adminUserIds(db: Pick<Db, "select">): Promise<string[]> {
  const rows = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(
      and(eq(authUser.role, "admin"), or(isNull(authUser.banned), eq(authUser.banned, false))),
    );
  return rows.map((r) => r.id);
}

async function processDepositReminders(
  db: Db,
  ctx: TemplateContext,
  admins: string[],
  deposit: TaxDepositRow,
  offsets: number[],
  today: string,
): Promise<number> {
  const periodStart = deposit.periodStart;
  const { periodKind } = withPeriodKind(deposit);

  let sent = 0;
  const fired = new Set((deposit.remindersSent as number[] | null) ?? []);

  for (const offset of offsets) {
    if (fired.has(offset)) continue;
    if (addDays(deposit.dueDate, -offset) !== today) continue;

    const rendered = tplTaxDepositDue(ctx, {
      jurisdiction: stateName(deposit.jurisdiction),
      periodLabel: periodLabel(periodStart, periodKind),
      amountLabel: formatMoney(Number(deposit.amount)),
      dueDate: deposit.dueDate,
      additional: deposit.seq > 0,
    });
    const marker = `deposit-reminder:${deposit.id}:${offset}`;
    for (const adminId of admins) {
      await db.insert(emailOutbox).values({
        userId: adminId,
        eventType: EVENT_TYPE.taxDepositDue,
        subject: rendered.subject,
        bodyHtml: `${rendered.html}<!-- ${marker} -->`,
      });
    }
    await db
      .update(taxDeposits)
      .set({ remindersSent: [...fired, offset], updatedAt: new Date() })
      .where(eq(taxDeposits.id, deposit.id));
    fired.add(offset);
    sent += 1;
  }
  return sent;
}

/**
 * Send due-date reminders: for every undeposited row and every configured
 * offset, mail all admins when today == due_date − offset and that offset has
 * not fired yet. reminders_sent is the dedupe record — re-ticks never
 * double-mail, and each offset fires at most once per deposit.
 *
 * For quarterly state deposits, the period label shows Q<quarter> <year>.
 */
export async function sendDepositReminders(
  deps: Deps,
  opts: { today?: string } = {},
): Promise<{ sent: number }> {
  const { db, config } = deps;
  const today = opts.today ?? todayIso();
  const offsets = await getReminderOffsets(db);

  // Spec 23 §5 / D5: only open rows with something to pay are reminded.
  const deposits = await db
    .select()
    .from(taxDeposits)
    .where(and(inArray(taxDeposits.status, ["pending", "overdue"]), sql`${taxDeposits.amount} > 0`))
    .orderBy(taxDeposits.periodStart);
  if (deposits.length === 0) return { sent: 0 };

  const ctx = await templateContext(db, config);
  const admins = await adminUserIds(db);
  let totalSent = 0;

  for (const deposit of deposits) {
    const sent = await processDepositReminders(db, ctx, admins, deposit, offsets, today);
    totalSent += sent;
  }
  return { sent: totalSent };
}

async function getFederalOrMonthlyDepositDetail(
  db: Db,
  deposit: TaxDepositRow,
  periodStart: string,
): Promise<DepositDetailBase> {
  let sqlCategoryFilter: SQLWrapper;

  if (deposit.jurisdiction === "federal") {
    sqlCategoryFilter = sql`${payrollEntries.category} IN (${sql.join(
      DEPOSIT_CATEGORIES.map((c) => sql`${c}`),
      sql`, `,
    )})`;
  } else {
    sqlCategoryFilter = eq(payrollEntries.category, "state_withholding");
  }

  const breakdownRows = await db
    .select({
      category: payrollEntries.category,
      amount: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)::numeric(12,2)::text`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .where(
      and(
        eq(payrollRuns.status, "issued"),
        sql`date_trunc('month', ${payrollRuns.payDate})::date = ${periodStart}::date`,
        sqlCategoryFilter,
        ...(deposit.jurisdiction !== "federal"
          ? [
              sql`(${payrollRuns.runSnapshot}#>>'{inputs,state,workState}') = ${deposit.jurisdiction}`,
            ]
          : []),
      ),
    )
    .groupBy(payrollEntries.category);

  const breakdown: DepositDetailBase["breakdown"] = [];
  if (deposit.jurisdiction === "federal") {
    for (const category of DEPOSIT_CATEGORIES) {
      const row = breakdownRows.find((r) => r.category === category);
      breakdown.push({
        category,
        amount: row ? row.amount : "0.00",
      });
    }
  } else {
    const row = breakdownRows.find((r) => r.category === "state_withholding");
    breakdown.push({
      category: "state_withholding",
      amount: row ? row.amount : "0.00",
    });
  }

  const runsCategoryFilter =
    deposit.jurisdiction === "federal"
      ? sql`${payrollEntries.category} IN (${sql.join(
          DEPOSIT_CATEGORIES.map((c) => sql`${c}`),
          sql`, `,
        )})`
      : eq(payrollEntries.category, "state_withholding");

  const runs = await db
    .select({
      publicId: payrollRuns.publicId,
      payDate: payrollRuns.payDate,
      employeeName: employees.legalName,
      amount: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)::numeric(12,2)::text`,
    })
    .from(payrollRuns)
    .innerJoin(payrollEntries, eq(payrollEntries.runId, payrollRuns.id))
    .innerJoin(employees, eq(payrollRuns.employeeId, employees.id))
    .where(
      and(
        eq(payrollRuns.status, "issued"),
        sql`date_trunc('month', ${payrollRuns.payDate})::date = ${periodStart}::date`,
        runsCategoryFilter,
        ...(deposit.jurisdiction !== "federal"
          ? [
              sql`(${payrollRuns.runSnapshot}#>>'{inputs,state,workState}') = ${deposit.jurisdiction}`,
            ]
          : []),
      ),
    )
    .groupBy(payrollRuns.publicId, payrollRuns.payDate, employees.legalName)
    .orderBy(payrollRuns.payDate);

  return {
    deposit: withPeriodKind(deposit),
    breakdown,
    runs: runs.map((row) => ({
      publicId: row.publicId,
      payDate: row.payDate,
      employeeName: row.employeeName,
      amount: row.amount,
    })),
  };
}

async function getQuarterlyDepositDetail(
  db: Db,
  deposit: TaxDepositWithPeriodKind,
  periodStart: string,
): Promise<DepositDetailBase> {
  const year = Number(periodStart.slice(0, 4));
  const quarter = quarterOfMonth(Number(periodStart.slice(5, 7)));
  const firstMonth = (quarter - 1) * 3 + 1;
  const lastMonth = quarter * 3;
  const firstPeriod = periodStartFor(year, firstMonth);
  const lastPeriod = periodStartFor(year, lastMonth);

  const breakdownRows = await db
    .select({
      category: payrollEntries.category,
      amount: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)::numeric(12,2)::text`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .where(
      and(
        eq(payrollRuns.status, "issued"),
        sql`date_trunc('month', ${payrollRuns.payDate})::date >= ${firstPeriod}::date`,
        sql`date_trunc('month', ${payrollRuns.payDate})::date <= ${lastPeriod}::date`,
        eq(payrollEntries.category, "state_withholding"),
        sql`(${payrollRuns.runSnapshot}#>>'{inputs,state,workState}') = ${deposit.jurisdiction}`,
      ),
    )
    .groupBy(payrollEntries.category);

  const breakdown: DepositDetailBase["breakdown"] = [];
  const row = breakdownRows.find((r) => r.category === "state_withholding");
  breakdown.push({
    category: "state_withholding",
    amount: row ? row.amount : "0.00",
  });

  const runs = await db
    .select({
      publicId: payrollRuns.publicId,
      payDate: payrollRuns.payDate,
      employeeName: employees.legalName,
      amount: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)::numeric(12,2)::text`,
    })
    .from(payrollRuns)
    .innerJoin(payrollEntries, eq(payrollEntries.runId, payrollRuns.id))
    .innerJoin(employees, eq(payrollRuns.employeeId, employees.id))
    .where(
      and(
        eq(payrollRuns.status, "issued"),
        sql`date_trunc('month', ${payrollRuns.payDate})::date >= ${firstPeriod}::date`,
        sql`date_trunc('month', ${payrollRuns.payDate})::date <= ${lastPeriod}::date`,
        eq(payrollEntries.category, "state_withholding"),
        sql`(${payrollRuns.runSnapshot}#>>'{inputs,state,workState}') = ${deposit.jurisdiction}`,
      ),
    )
    .groupBy(payrollRuns.publicId, payrollRuns.payDate, employees.legalName)
    .orderBy(payrollRuns.payDate);

  return {
    deposit: { ...deposit, periodKind: "quarter" },
    breakdown,
    runs: runs.map((row) => ({
      publicId: row.publicId,
      payDate: row.payDate,
      employeeName: row.employeeName,
      amount: row.amount,
    })),
  };
}

/**
 * Fetch a deposit with its detail data for the admin view.
 * Returns null when no deposit with id exists.
 */
export async function getDepositDetail(db: Db, id: number): Promise<DepositDetailRow | null> {
  const depositRows = await db.select().from(taxDeposits).where(eq(taxDeposits.id, id)).limit(1);
  const deposit = depositRows[0];
  if (!deposit) return null;

  // Spec 23 §5: the kind is the stored column, never today's schedule. A
  // superseded row is still returned (audit).
  const withKind = withPeriodKind(deposit);
  const base =
    withKind.periodKind === "quarter"
      ? await getQuarterlyDepositDetail(db, withKind, deposit.periodStart)
      : await getFederalOrMonthlyDepositDetail(db, deposit, deposit.periodStart);
  const total = base.breakdown.reduce((a, b) => a + parseCents(b.amount), 0);
  return {
    ...base,
    ...(await transitionDetail(db, withKind, formatCents(total))),
    ...(await periodRows(db, withKind)),
  };
}

/**
 * PAY-193: the period's other live rows (same jurisdiction, period_start and
 * period_kind; superseded excluded), what they already cover, and — on a
 * seq 0 row — the additional deposit that follows it.
 */
async function periodRows(
  db: Db,
  deposit: TaxDepositWithPeriodKind,
): Promise<
  Pick<DepositDetailRow, "siblings" | "alreadyDeposited" | "additionalDeposit" | "form941DueDate">
> {
  const rows = await db
    .select()
    .from(taxDeposits)
    .where(
      and(
        eq(taxDeposits.jurisdiction, deposit.jurisdiction),
        eq(taxDeposits.periodStart, deposit.periodStart),
        eq(taxDeposits.periodKind, deposit.periodKind),
        liveDeposit,
        ne(taxDeposits.id, deposit.id),
      ),
    )
    .orderBy(asc(taxDeposits.seq), asc(taxDeposits.id));
  const siblings = rows.map((r) => ({ id: r.id, seq: r.seq, status: r.status, amount: r.amount }));
  const covered = siblings
    .filter((r) => r.status === "deposited" || r.status === "overdue")
    .reduce((a, r) => a + parseCents(r.amount), 0);
  const additional = deposit.seq === 0 ? siblings.filter((r) => r.seq > 0).at(-1) : undefined;
  const year = Number(deposit.periodStart.slice(0, 4));
  const quarter = quarterOfMonth(Number(deposit.periodStart.slice(5, 7)));
  return {
    siblings,
    alreadyDeposited: formatCents(covered),
    additionalDeposit: additional ? { id: additional.id, amount: additional.amount } : null,
    form941DueDate: deposit.jurisdiction === "federal" ? filingDueDate(year, quarter) : null,
  };
}

function toCreditRow(c: DepositCredit): DepositCreditRow {
  return {
    depositId: c.depositId,
    periodStart: c.periodStart,
    periodKind: c.periodKind,
    depositedOn: c.depositedOn ?? "",
    amount: formatCents(c.amountCents),
    applied: formatCents(c.appliedCents),
  };
}

/**
 * Spec 23 §7: liability, credits, overpayment and replacement for one row,
 * derived by the same pure planner the sync uses (read-only here), so the
 * sync and the API can never disagree.
 */
async function transitionDetail(
  db: Db,
  deposit: TaxDepositWithPeriodKind,
  breakdownTotal: string,
): Promise<
  Pick<
    DepositDetailRow,
    "liability" | "credits" | "overpaid" | "overpaidAnchor" | "paymentsUnavailable" | "replacedBy"
  >
> {
  const year = Number(deposit.periodStart.slice(0, 4));
  const month = Number(deposit.periodStart.slice(5, 7));
  const none = { credits: [], overpaid: "0.00", overpaidAnchor: false, replacedBy: [] };
  if (deposit.jurisdiction === "federal") {
    return {
      ...none,
      liability: await computeDepositAmount(db, year, month),
      paymentsUnavailable: false,
    };
  }
  const quarter = quarterOfMonth(month);
  const filter = { state: deposit.jurisdiction, year, quarter };
  const unit = (await loadStateUnits(db, filter))[0] ?? {
    ...filter,
    liability: [0, 0, 0] as [number, number, number],
    live: [],
  };
  const replacedBy =
    deposit.status === "superseded"
      ? unit.live
          .filter((r) => r.kind !== deposit.periodKind)
          .map((r) => ({ id: r.id, periodStart: r.periodStart, periodKind: r.kind }))
      : [];
  let plan: QuarterPlan;
  try {
    plan = planUnit(unit, await loadStateSchedules(db), todayIso());
  } catch {
    // Data error in this period: show the row, without the payment figures.
    return { ...none, liability: breakdownTotal, paymentsUnavailable: true, replacedBy };
  }
  const m = (month - 1) % 3;
  const isQuarter = deposit.periodKind === "quarter";
  const credits = (isQuarter ? plan.quarterCredits : (plan.monthCredits[m] ?? []))
    .filter((c) => c.depositId !== deposit.id)
    .map(toCreditRow);
  return {
    liability: formatCents(isQuarter ? plan.liabilityCents : (unit.liability[m] ?? 0)),
    credits,
    overpaid: formatCents(plan.overpaidCents),
    overpaidAnchor: plan.overpaidAnchorId === deposit.id,
    paymentsUnavailable: false,
    replacedBy,
  };
}

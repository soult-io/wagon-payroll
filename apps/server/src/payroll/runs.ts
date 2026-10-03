/**
 * Payroll run lifecycle (spec payroll-engine D6): draft generation with
 * temporal config resolution + idempotency, and the state machine
 * draft→awaiting_approval→approved→issued (void pre-issued only).
 * Every mutation writes audit_events in the same transaction.
 */

import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import {
  auditEvents,
  authUser,
  company,
  emailOutbox,
  employees,
  payrollEntries,
  payrollRuns,
  paySchedules,
} from "@payroll/db";
import {
  calculatePayroll,
  ENGINE_VERSION,
  PERIODS_PER_YEAR,
  type PayFrequency,
  type StateElectionInput,
  type StateTaxConfig,
  type TaxConfig,
} from "@payroll/engine";
import { round2 } from "@payroll/engine/money";
import {
  EVENT_TYPE,
  payrollDraftReady as tplPayrollDraftReady,
  payslipIssued as tplPayslipIssued,
  type TemplateContext,
} from "@payroll/notifications";
import { parseCents } from "@payroll/shared";
import type { Db } from "../db.js";
import { isUniqueViolation } from "../db.js";
import type { AppConfig } from "../config.js";
import { templateContext } from "../notify/outbox.js";
import {
  mapStateFilingStatus,
  findLaterIssuedRun,
  resolveCompensation,
  resolvePriorYtd,
  resolveStateElection,
  resolveStateTaxConfig,
  resolveTaxConfig,
  resolveW4,
  resolveWorkState,
  toSnapshotState,
  toSnapshotW4,
  type DbLike,
} from "./resolve.js";
import { PayrollServiceError } from "./errors.js";
import {
  closingFilingCode,
  closingFilingCorrection,
  closingFilingLabel,
  filedClosingFilings,
  joinWithAnd,
  lateIssueAllowed,
  stateReturnJurisdictions,
} from "../filings/closing-filings.js";
import { furnishCorrectionIfNeeded } from "../filings/w2-furnish.js";
import { refreshFilingsForPayDate } from "../filings/service.js";
import { FILING_CLOSE_LOCK } from "../filings/shared.js";
import { lockEmployee } from "./locks.js";
import { syncDepositsForPayDate } from "../deposits/service.js";
import {
  AMOUNT_MISMATCH_MESSAGE,
  ATTESTATION_VERSION,
  attestationText,
  confirmationRequiredMessage,
  incompleteMessage,
  LATE_ISSUE_NOT_SUPPORTED_MESSAGE,
  type LateTrigger,
  lateTrigger,
  type StateQuestions,
  stateAttestationText,
  stateQuestions,
  type StateReturnAnswer,
  stateReturnFiledMessage,
  usd,
} from "./late-issue.js";
import { localDate, type Period, type RunDates, runDates, ytdKeyOf } from "./run-dates.js";
import {
  fingerprintDiff,
  SNAPSHOT_TEMPLATE_VERSION,
  snapshotHash,
  type RunSnapshot,
  type RunSnapshotYtd,
} from "./snapshot.js";

// Re-exported: callers and tests import these from runs.js.
export { PayrollServiceError };
export type { Period };

/** Monthly schedule → period = calendar month; pay_date = pay_day_of_month. */
export function monthlyPeriod(year: number, month: number, payDayOfMonth: number): Period {
  const mm = String(month).padStart(2, "0");
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    periodStart: `${year}-${mm}-01`,
    periodEnd: `${year}-${mm}-${String(lastDay).padStart(2, "0")}`,
    payDate: `${year}-${mm}-${String(payDayOfMonth).padStart(2, "0")}`,
  };
}

export type RunRow = typeof payrollRuns.$inferSelect;

interface GenerateDeps {
  db: Db;
  config: AppConfig;
  /**
   * Wall clock for the D9 "today" check (Spec 26 (PAY-173)); defaults to
   * `new Date()`. The instant is converted to the company's local date
   * (config.appTz) before comparing years.
   */
  clock?: () => Date;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** D6 message: names the conflicting run's pay date only. */
function ytdOrderConflict(later: { payDate: string }): PayrollServiceError {
  return new PayrollServiceError(
    "ytd_order_conflict",
    `This employee already has a payroll issued with a later pay date (${later.payDate}). Payrolls must be issued in the order they are paid, or that later payslip's year-to-date totals would leave this payment out. Nothing was approved or issued. Void this draft and generate it again with the date you actually pay it.`,
  );
}

/** True when `err` is the FUTA cap trigger (migrations 0017, 0025)'s RAISE EXCEPTION. */
function isFutaCapTriggerError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && message.includes("employer_futa annual cap exceeded")) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function notifyDraftReady(
  tx: DbLike & Pick<Db, "insert">,
  ctx: TemplateContext,
  run: RunRow,
  employeeName: string,
): Promise<void> {
  const rendered = tplPayrollDraftReady(ctx, {
    employeeName,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    payDate: run.payDate,
  });
  const admins = await tx
    .select({ id: authUser.id, email: authUser.email })
    .from(authUser)
    .where(
      and(eq(authUser.role, "admin"), or(isNull(authUser.banned), eq(authUser.banned, false))),
    );
  for (const admin of admins) {
    await tx.insert(emailOutbox).values({
      userId: admin.id,
      eventType: EVENT_TYPE.payrollDraftReady,
      subject: rendered.subject,
      bodyHtml: rendered.html,
    });
  }
}

const ENTRY_CATEGORIES = [
  "gross_pay",
  "federal_withholding",
  "social_security",
  "medicare",
  "state_withholding",
  "net_pay",
  "employer_social_security",
  "employer_medicare",
  "employer_futa",
] as const;

type EntryCategory = (typeof ENTRY_CATEGORIES)[number];

function entryAmounts(result: RunSnapshot["result"]): [EntryCategory, number][] {
  const byCategory: Record<EntryCategory, number> = {
    gross_pay: result.grossPay,
    federal_withholding: result.federalWithholding,
    social_security: result.socialSecurity,
    medicare: result.medicare,
    state_withholding: result.stateWithholding,
    net_pay: result.netPay,
    employer_social_security: result.employerSocialSecurity,
    employer_medicare: result.employerMedicare,
    employer_futa: result.employerFUTA,
  };
  return ENTRY_CATEGORIES.map((c) => [c, byCategory[c]]);
}

/** State engine input + snapshot block for the employee's work state. */
function stateEngineInput(
  stateCode: string,
  stateTax: NonNullable<Awaited<ReturnType<typeof resolveStateTaxConfig>>>,
  stateElection: Awaited<ReturnType<typeof resolveStateElection>>,
): { config: StateTaxConfig; election?: StateElectionInput } {
  const cfg = stateTax.config;
  // exactOptionalPropertyTypes: nullable columns become absent keys via
  // conditional spread — a state only models the fields its form uses.
  return {
    config: {
      state: stateCode,
      year: cfg.taxYear,
      kind: cfg.kind as StateTaxConfig["kind"],
      ...(cfg.flatRate === null ? {} : { flatRate: Number(cfg.flatRate) }),
      ...(cfg.standardDeduction === null
        ? {}
        : { standardDeduction: Number(cfg.standardDeduction) }),
      ...(cfg.standardDeductionAlt === null
        ? {}
        : { standardDeductionAlt: Number(cfg.standardDeductionAlt) }),
      ...(cfg.altMinAllowances === null ? {} : { altMinAllowances: cfg.altMinAllowances }),
      ...(cfg.lowIncomeExemption === null
        ? {}
        : { lowIncomeExemption: Number(cfg.lowIncomeExemption) }),
      ...(cfg.lowIncomeExemptionAlt === null
        ? {}
        : { lowIncomeExemptionAlt: Number(cfg.lowIncomeExemptionAlt) }),
      ...(cfg.allowanceDeduction === null
        ? {}
        : { allowanceDeduction: Number(cfg.allowanceDeduction) }),
      ...(cfg.allowanceCredit === null ? {} : { allowanceCredit: Number(cfg.allowanceCredit) }),
      ...(cfg.additionalAllowanceDeduction === null
        ? {}
        : { additionalAllowanceDeduction: Number(cfg.additionalAllowanceDeduction) }),
      ...(stateTax.brackets.length > 0
        ? {
            brackets: stateTax.brackets.map((b) => ({
              min: Number(b.minAmount),
              max: b.maxAmount === null ? Infinity : Number(b.maxAmount),
              rate: Number(b.rate),
            })),
          }
        : {}),
    },
    ...(stateElection
      ? {
          election: {
            allowances: stateElection.allowances,
            additionalAllowances: stateElection.additionalAllowances,
            extraWithholding: Number(stateElection.extraWithholding),
            exempt: stateElection.exempt,
          },
        }
      : {}),
  };
}

/**
 * State withholding from the employee's effective-dated WORK state
 * (services performed → period start, Spec 26 S4). PAY-13: no work-state row
 * → legacy flat stateWithholdingRate path (both results undefined,
 * bit-identical for every run predating PAY-13). A work state with no config
 * for the pay-date year fails loudly — kind='none' (TX) is the explicit
 * zero-tax row; absence never silently means $0 (Spec 26 S2).
 */
async function resolveStateInput(
  tx: DbLike,
  employeeId: number,
  dates: RunDates,
  federalFilingStatus: string,
): Promise<{
  stateInput: { config: StateTaxConfig; election?: StateElectionInput } | undefined;
  stateSnapshot: RunSnapshot["inputs"]["state"];
}> {
  const workState = await resolveWorkState(tx, employeeId, dates.earnedAsOf);
  if (!workState) return { stateInput: undefined, stateSnapshot: undefined };
  const stateElection = await resolveStateElection(
    tx,
    employeeId,
    workState.stateCode,
    dates.certificateAsOf,
  );
  // Filing status: the state election's own status when filed, else the
  // federal W-4's; married_separate falls back to the single table.
  const mappedStatus = mapStateFilingStatus(
    (stateElection?.filingStatus ?? federalFilingStatus) as Parameters<
      typeof mapStateFilingStatus
    >[0],
  );
  const taxYear = dates.taxYear;
  const stateTax = await resolveStateTaxConfig(tx, workState.stateCode, taxYear, mappedStatus);
  if (!stateTax) {
    throw new PayrollServiceError(
      "no_state_tax_config",
      `no state tax config/brackets for ${workState.stateCode} in ${taxYear} (employee ${employeeId} works there) — seed or configure state_tax_configs; use kind='none' for explicit zero-tax states`,
    );
  }
  return {
    stateInput: stateEngineInput(workState.stateCode, stateTax, stateElection),
    stateSnapshot: toSnapshotState({
      stateCode: workState.stateCode,
      jurisdiction: stateTax.config.jurisdiction,
      taxYear: stateTax.config.taxYear,
      config: stateTax.config,
      brackets: stateTax.brackets,
      election: stateElection,
    }),
  };
}

/** Engine TaxConfig from the resolved federal tax_config row + brackets. */
function engineTaxConfig(
  tax: NonNullable<Awaited<ReturnType<typeof resolveTaxConfig>>>,
): TaxConfig {
  return {
    year: tax.config.taxYear,
    standardDeduction: tax.config.standardDeduction,
    federalBrackets: tax.brackets.map((b) => ({
      min: b.min,
      max: b.max ?? Infinity,
      rate: b.rate,
    })),
    socialSecurityRate: tax.config.socialSecurityRate,
    socialSecurityWageCap: tax.config.socialSecurityWageCap,
    medicareRate: tax.config.medicareRate,
    medicareAdditionalRate: tax.config.medicareAdditionalRate,
    medicareAdditionalThreshold: tax.config.medicareAdditionalThreshold,
    stateWithholdingRate: tax.config.stateWithholdingRate,
    employerSocialSecurityRate: tax.config.employerSocialSecurityRate,
    employerMedicareRate: tax.config.employerMedicareRate,
    futaRate: tax.config.futaRate,
    futaWageCap: tax.config.futaWageCap,
    sutaCreditRate: tax.config.sutaCreditRate,
  };
}

/**
 * PAY-26: per-employee annual employer_futa must never exceed
 * futaWageCap × futaRate for the run's tax year (the PAY-date year, Spec 26
 * R4). The engine formula is correct, but a misconfigured rate (PAY-18/22
 * incident: 0.6% instead of 6%) would silently write wrong entries — assert
 * the invariant at write time against issued-run YTD + this run.
 */
function assertFutaCap(input: {
  employeeId: number;
  taxYear: number;
  engineConfig: TaxConfig;
  periodsPerYear: number;
  priorYtd: Map<string, number>;
  result: RunSnapshot["result"];
}): void {
  const { employeeId, taxYear, engineConfig, periodsPerYear, priorYtd, result } = input;
  const futaAnnualCap = round2(engineConfig.futaWageCap * engineConfig.futaRate);
  // Per-period cent rounding can accumulate up to half a cent per period
  // past the exact cap (the 940 worksheet reconciles this as
  // roundingDelta) — the guard targets material violations like the
  // incident's 10× rate error, not rounding noise.
  const futaCapTolerance = round2(0.005 * periodsPerYear);
  const priorFutaYtd = priorYtd.get("employer_futa") ?? 0;
  const projectedFuta = round2(priorFutaYtd + result.employerFUTA);
  if (projectedFuta > futaAnnualCap + futaCapTolerance) {
    throw new PayrollServiceError(
      "futa_cap_exceeded",
      `employer_futa annual cap exceeded for employee ${employeeId} in ${taxYear}: ` +
        `${projectedFuta.toFixed(2)} (issued YTD ${priorFutaYtd.toFixed(2)} + this run ${result.employerFUTA.toFixed(2)}) ` +
        `> cap ${futaAnnualCap.toFixed(2)} (futa_wage_cap × futa_rate, +${futaCapTolerance.toFixed(2)} rounding tolerance) — check tax_config for ${taxYear}`,
    );
  }
}

/** Engine W-4 inputs; no W-4 on file = not exempt, all amounts 0. */
function w4EngineInput(w4Row: Awaited<ReturnType<typeof resolveW4>>) {
  return {
    federalExempt: w4Row?.federalExempt ?? false,
    w4: {
      dependentsAmount: w4Row ? Number(w4Row.dependentsAmount) : 0,
      otherIncome: w4Row ? Number(w4Row.otherIncome) : 0,
      deductionsAmount: w4Row ? Number(w4Row.deductionsAmount) : 0,
      extraWithholding: w4Row ? Number(w4Row.extraWithholding) : 0,
    },
  };
}

/** Snapshot YTD THROUGH this run: prior issued YTD per category + this run. */
function ytdThrough(priorYtd: Map<string, number>, result: RunSnapshot["result"]): RunSnapshotYtd {
  const priorYtdGross = priorYtd.get("gross_pay") ?? 0;
  return {
    gross: round2(priorYtdGross + result.grossPay),
    federalWithholding: round2(
      (priorYtd.get("federal_withholding") ?? 0) + result.federalWithholding,
    ),
    socialSecurity: round2((priorYtd.get("social_security") ?? 0) + result.socialSecurity),
    medicare: round2((priorYtd.get("medicare") ?? 0) + result.medicare),
    stateWithholding: round2((priorYtd.get("state_withholding") ?? 0) + result.stateWithholding),
    totalDeductions: round2(
      priorYtdGross - (priorYtd.get("net_pay") ?? 0) + result.totalDeductions,
    ),
    netPay: round2((priorYtd.get("net_pay") ?? 0) + result.netPay),
  };
}

export interface ComputedRun {
  snapshot: RunSnapshot;
  entries: [EntryCategory, number][];
  employee: typeof employees.$inferSelect;
  companyRow: typeof company.$inferSelect;
}

/**
 * Read-and-compute part of run generation (Spec 26 (PAY-173) D4): resolves
 * every input with the date runDates() assigns it and runs the engine. No
 * writes. `selfRunId` = null for a new draft; the run's own id when a stored
 * draft is recomputed for the freshness check.
 */
export async function computeRun(
  tx: DbLike,
  input: { employeeId: number; period: Period; selfRunId: number | null },
): Promise<ComputedRun> {
  const { period, employeeId } = input;
  const dates = runDates(period);

  const employeeRows = await tx
    .select()
    .from(employees)
    .where(eq(employees.id, employeeId))
    .limit(1);
  const employee = employeeRows[0];
  if (!employee) throw new PayrollServiceError("run_not_found", `employee ${employeeId} not found`);
  // Spec 10 §4: only W-2 employees produce payroll drafts — hard assertion
  // so a 1099 contractor can never enter payroll_runs even by accident.
  if (employee.employmentType !== "w2") {
    throw new PayrollServiceError(
      "not_w2_employee",
      `employee ${employeeId} is employment_type='${employee.employmentType}' — contractors are paid via invoices, never payroll runs (spec 10 §4)`,
    );
  }
  const companyRows = await tx.select().from(company).limit(1);
  const companyRow = companyRows[0];
  if (!companyRow) throw new PayrollServiceError("no_company", "company row missing — run seeds");

  // Earned rate: services performed → period start (wage-hour; kept).
  const comp = await resolveCompensation(tx, employeeId, dates.earnedAsOf);
  if (!comp) {
    throw new PayrollServiceError(
      "no_compensation",
      `no compensation effective on ${dates.earnedAsOf} for employee ${employeeId}`,
    );
  }
  const frequency = comp.frequency as PayFrequency;
  const periodsPerYear = PERIODS_PER_YEAR[frequency];
  if (!periodsPerYear) {
    throw new PayrollServiceError(
      "unsupported_frequency",
      `frequency ${comp.frequency} not supported`,
    );
  }

  // Spec 26 D3: certificate as of min(period end, pay date); next-year gate
  // and exempt lapse by pay date.
  const w4Row = await resolveW4(tx, employeeId, {
    certificateAsOf: dates.certificateAsOf,
    payDate: dates.payDate,
  });
  const filingStatus = w4Row?.filingStatus ?? "single";
  // Spec 26 R1/D8: the table year is the PAY-date year; no fallback.
  const taxYear = dates.taxYear;
  const tax = await resolveTaxConfig(tx, taxYear, filingStatus);
  if (!tax) {
    throw new PayrollServiceError("no_tax_config", `no federal tax config/brackets for ${taxYear}`);
  }
  // Spec 26 D2: wages PAID earlier in the pay-date year, by (pay_date, period_start, id).
  const ytdKey = ytdKeyOf(period, input.selfRunId);
  const prior = await resolvePriorYtd(tx, employeeId, ytdKey);
  const priorYtd = prior.byCategory;
  const priorYtdGross = priorYtd.get("gross_pay") ?? 0;

  // PAY-13 / Spec 26 S4: work state by period start; undefined = legacy flat rate.
  const { stateInput, stateSnapshot } = await resolveStateInput(
    tx,
    employeeId,
    dates,
    filingStatus,
  );

  // Spec 26 D5: a table year other than the pay-date year is a programming error.
  if (tax.config.taxYear !== taxYear || (stateSnapshot && stateSnapshot.taxYear !== taxYear)) {
    throw new Error(`resolved table year does not match the pay-date year ${taxYear}`);
  }

  const engineConfig = engineTaxConfig(tax);

  const periodAmount = Number(comp.periodAmount);
  const result = calculatePayroll({
    monthlySalary: periodAmount,
    periodsPerYear: periodsPerYear as 12 | 24 | 26 | 52,
    priorYtdGross,
    taxConfig: engineConfig,
    ...w4EngineInput(w4Row),
    // Absent when no work state → legacy flat-rate path, bit-identical.
    ...(stateInput ? { state: stateInput } : {}),
  });

  // PAY-26: employer_futa annual cap for the pay-date year (Spec 26 R4).
  assertFutaCap({ employeeId, taxYear, engineConfig, periodsPerYear, priorYtd, result });

  const snapshot: RunSnapshot = {
    inputs: {
      periodAmount,
      frequency,
      periodsPerYear,
      w4: w4Row ? toSnapshotW4(w4Row) : null,
      taxConfig: tax.config,
      brackets: tax.brackets,
      ...(stateSnapshot ? { state: stateSnapshot } : {}),
      priorYtdGross,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      payDate: period.payDate,
      company: { legalName: companyRow.legalName },
      employee: { legalName: employee.legalName, preferredName: employee.preferredName },
      resolution: {
        basis: "pay_date",
        payDate: dates.payDate,
        certificateAsOf: dates.certificateAsOf,
        earnedAsOf: dates.earnedAsOf,
        taxYear,
        ytd: {
          year: prior.year,
          before: {
            payDate: ytdKey.payDate,
            periodStart: ytdKey.periodStart,
            runId: ytdKey.selfRunId,
          },
          runs: prior.runPublicIds,
        },
      },
    },
    result,
    engineVersion: ENGINE_VERSION,
    templateVersion: SNAPSHOT_TEMPLATE_VERSION,
    ytd: ytdThrough(priorYtd, result),
  };

  return { snapshot, entries: entryAmounts(result), employee, companyRow };
}

/**
 * Generate one draft run (status='awaiting_approval') for an employee and
 * period, resolving all config inside the transaction with the dates
 * runDates() assigns (Spec 26 (PAY-173)). Idempotent: UNIQUE(employee_id,
 * period_start) — a repeat returns the existing run with created=false.
 */
export async function generateDraft(
  deps: GenerateDeps,
  input: { employeeId: number; period: Period; createdBy: string },
): Promise<{ run: RunRow; created: boolean }> {
  const { db } = deps;
  const { period } = input;

  const existing = await db
    .select()
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.employeeId, input.employeeId),
        eq(payrollRuns.periodStart, period.periodStart),
        // Void runs release the (employee, period) slot — regenerating after a
        // void creates a NEW run row (spec payroll-engine).
        ne(payrollRuns.status, "void"),
      ),
    )
    .limit(1);
  if (existing[0]) return { run: existing[0], created: false };

  try {
    return await db.transaction(async (tx) => {
      await lockEmployee(tx, input.employeeId);
      const { snapshot, entries, employee, companyRow } = await computeRun(tx, {
        employeeId: input.employeeId,
        period,
        selfRunId: null,
      });
      // D6: an issued run of the same pay-date year already sorts after this
      // one. The draft may still be generated (its YTD is correct as of now;
      // approve/issue refuse it), but when the DB FUTA trigger — which sums
      // every issued run of the year — rejects its entries, answer with the
      // same 409 instead of a raw database error.
      const laterIssued = await findLaterIssuedRun(tx, input.employeeId, ytdKeyOf(period, null));

      const inserted = await tx
        .insert(payrollRuns)
        .values({
          employeeId: input.employeeId,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          payDate: period.payDate,
          status: "awaiting_approval",
          runSnapshot: snapshot,
          snapshotHash: snapshotHash(snapshot),
          createdBy: input.createdBy,
        })
        .returning();
      const run = inserted[0]!;

      try {
        await tx.insert(payrollEntries).values(
          entries.map(([category, amount]) => ({
            runId: run.id,
            category,
            amount: String(amount),
          })),
        );
      } catch (err) {
        if (laterIssued && isFutaCapTriggerError(err)) throw ytdOrderConflict(laterIssued);
        throw err;
      }

      const tplCtx = await templateContext(tx, deps.config, companyRow.legalName);
      await notifyDraftReady(tx as DbLike & Pick<Db, "insert">, tplCtx, run, employee.legalName);
      return { run, created: true };
    });
  } catch (err) {
    // Unique race (scheduler retry / double click): someone else created it.
    if (isUniqueViolation(err)) {
      const rows = await db
        .select()
        .from(payrollRuns)
        .where(
          and(
            eq(payrollRuns.employeeId, input.employeeId),
            eq(payrollRuns.periodStart, period.periodStart),
            ne(payrollRuns.status, "void"),
          ),
        )
        .limit(1);
      if (rows[0]) return { run: rows[0], created: false };
    }
    throw err;
  }
}

/** Resolve the schedule row for an employee (per-employee overrides company default). */
export async function resolveSchedule(
  db: DbLike,
  employeeId: number,
): Promise<typeof paySchedules.$inferSelect | null> {
  const rows = await db
    .select()
    .from(paySchedules)
    .where(
      and(
        eq(paySchedules.active, true),
        or(eq(paySchedules.employeeId, employeeId), isNull(paySchedules.employeeId)),
      ),
    );
  const perEmployee = rows.find((r) => r.employeeId === employeeId);
  return perEmployee ?? rows.find((r) => r.employeeId === null) ?? null;
}

/**
 * Generate drafts for a period across employees. Scheduler path passes
 * autoDraftOnly=true (skips employees whose schedule disabled auto-draft);
 * the manual "generate draft now" endpoint passes false (off-cycle allowed).
 */
export async function generateDraftsForPeriod(
  deps: GenerateDeps,
  input: {
    year: number;
    month: number;
    employeeId?: number;
    autoDraftOnly: boolean;
    createdBy: string;
  },
): Promise<{ generated: RunRow[]; skipped: { employeeId: number; reason: string }[] }> {
  const { db } = deps;
  // Spec 10 §4: the bulk path filters to W-2 employees outright; the single-
  // employee path keeps the full row so generateDraft's assertion reports
  // not_w2_employee in `skipped` instead of silently dropping the worker.
  const employeeRows = input.employeeId
    ? await db.select().from(employees).where(eq(employees.id, input.employeeId))
    : await db
        .select()
        .from(employees)
        .where(and(eq(employees.status, "active"), eq(employees.employmentType, "w2")));

  const generated: RunRow[] = [];
  const skipped: { employeeId: number; reason: string }[] = [];
  for (const employee of employeeRows) {
    const schedule = await resolveSchedule(db, employee.id);
    if (!schedule) {
      skipped.push({ employeeId: employee.id, reason: "no_schedule" });
      continue;
    }
    if (input.autoDraftOnly && !schedule.autoDraft) {
      skipped.push({ employeeId: employee.id, reason: "auto_draft_off" });
      continue;
    }
    if (schedule.frequency !== "monthly") {
      skipped.push({ employeeId: employee.id, reason: "unsupported_frequency" });
      continue;
    }
    const period = monthlyPeriod(input.year, input.month, schedule.payDayOfMonth);
    try {
      const { run } = await generateDraft(deps, {
        employeeId: employee.id,
        period,
        createdBy: input.createdBy,
      });
      generated.push(run);
    } catch (err) {
      if (err instanceof PayrollServiceError) {
        skipped.push({ employeeId: employee.id, reason: err.code });
        continue;
      }
      throw err;
    }
  }
  return { generated, skipped };
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/** Statuses a run can still be issued (or voided) from. */
export const OPEN_RUN_STATUSES = ["draft", "awaiting_approval", "approved"] as const;

const TRANSITIONS: Record<string, { from: readonly string[]; to: string }> = {
  approve: { from: ["draft", "awaiting_approval"], to: "approved" },
  issue: { from: ["approved"], to: "issued" },
  // Spec: void pre-issued only. (The DB immutability trigger additionally
  // permits issued→void bookkeeping; the app is stricter per spec.)
  void: { from: OPEN_RUN_STATUSES, to: "void" },
};

export type RunAction = keyof typeof TRANSITIONS;

async function notifyPayslipIssued(
  tx: DbLike & Pick<Db, "insert">,
  ctx: TemplateContext,
  run: RunRow,
): Promise<void> {
  const rows = await tx.select().from(employees).where(eq(employees.id, run.employeeId)).limit(1);
  const employee = rows[0];
  if (!employee?.userId) return;
  // Spec: period + "log in to view/download" — no net pay, no attachment.
  const rendered = tplPayslipIssued(ctx, {
    periodLabel: `${run.periodStart} → ${run.periodEnd}`,
    payDate: run.payDate,
  });
  await tx.insert(emailOutbox).values({
    userId: employee.userId,
    eventType: EVENT_TYPE.payslipIssued,
    subject: rendered.subject,
    bodyHtml: rendered.html,
  });
}

/** D4 refusal carrying the differing field names for the audit row. */
class StaleDraftError extends PayrollServiceError {
  constructor(
    public fields: string[],
    public runPublicId: string,
  ) {
    super(
      "stale_draft",
      `This draft is out of date: something it depends on changed after it was created (for example another payroll was issued, or a tax table or W-4 was updated). Void this draft and generate it again to recalculate. Changed: ${fields.join(", ")}.`,
    );
  }
}

/**
 * PAY-193 L4 (L4.6): a late-issue refusal written to audit_events after the
 * rollback (run.late_issue_refused). Never carries the typed amount.
 */
class LateIssueRefusedError extends PayrollServiceError {
  constructor(
    code: "late_payment_incomplete" | "state_return_filed" | "late_payment_amount_mismatch",
    message: string,
    details: Readonly<Record<string, string | string[]>>,
    public runPublicId: string,
    public payDate: string,
    public jurisdictions?: string[],
  ) {
    super(code, message, details);
  }
}

/** PAY-193 L4: the admin's confirmation of a late issue (request body `latePayment`). */
export interface LatePaymentInput {
  attestationVersion: 1;
  netPayCents: number;
  stateReturns: StateReturnAnswer[];
}

/** What a late issue needs after the checks pass (L4.4). */
interface LateIssueContext {
  trigger: LateTrigger;
  taxYear: number;
  questions: StateQuestions[];
  latePayment: LatePaymentInput;
}

/** The company-local date of the request (computed once per request). */
function localToday(deps: GenerateDeps): string {
  return localDate((deps.clock ?? (() => new Date()))(), deps.config.appTz);
}

/**
 * PAY-193 (D9.4, D9.5): a past pay date whose federal closing filing is
 * filed cannot be issued. Takes FILING_CLOSE_LOCK after the employee lock
 * (global order: employee → FILING_CLOSE_LOCK → SYNC_LOCK), so a concurrent
 * markFiled either commits first (refused here) or waits for this issue.
 */
async function assertPayPeriodOpen(tx: Tx, payDate: string): Promise<void> {
  await tx.execute(FILING_CLOSE_LOCK);
  const filed = await filedClosingFilings(tx, payDate);
  if (filed.length === 0) return;
  throw new PayrollServiceError(
    "pay_period_filed",
    `Nothing was issued. You've marked ${joinWithAnd(filed.map(closingFilingLabel))} as filed, and that covers the pay date ${payDate}. If you really paid your team on that date, keep the date. Don't move it to get around this. Adding this payroll means correcting the filed return with ${joinWithAnd(filed.map(closingFilingCorrection))}, which Wagon Payroll doesn't prepare. Keep your own record of this payment and make the correction outside Wagon Payroll.`,
    { payDate, forms: filed.map(closingFilingCode) },
  );
}

/**
 * Spec 26 (PAY-173) checks before approve/issue, inside the locked
 * transaction: PAY-193 filed-return guard (issue with a past pay date only,
 * first); D6 — an issued run of the same pay-date year already sorts after
 * this one; D4 — recompute the draft (read-only) and refuse when it no
 * longer matches the stored snapshot.
 */
async function assertRunCurrent(
  tx: Tx,
  run: RunRow,
  action: RunAction,
  today: string,
): Promise<void> {
  if (action === "issue" && run.payDate < today) await assertPayPeriodOpen(tx, run.payDate);
  const later = await findLaterIssuedRun(tx, run.employeeId, ytdKeyOf(run, run.id));
  if (later) throw ytdOrderConflict(later);

  const recomputed = await computeRun(tx, {
    employeeId: run.employeeId,
    period: { periodStart: run.periodStart, periodEnd: run.periodEnd, payDate: run.payDate },
    selfRunId: run.id,
  });
  const fields = fingerprintDiff(run.runSnapshot as RunSnapshot, recomputed.snapshot);
  if (fields.length > 0) throw new StaleDraftError(fields, run.publicId);
}

/** The run's stored net_pay entry in cents (NUMERIC string, exact; no floats). */
async function storedNetPayCents(tx: DbLike, runId: number): Promise<number | null> {
  const rows = await tx
    .select({ amount: payrollEntries.amount })
    .from(payrollEntries)
    .where(and(eq(payrollEntries.runId, runId), eq(payrollEntries.category, "net_pay")))
    .limit(1);
  return rows[0] ? parseCents(rows[0].amount) : null;
}

/**
 * PAY-193 L4 checks 4–9 (L4.4), after D4: null when the run is not late
 * (any `latePayment` is then ignored); else the confirmation, the state
 * answers and the net-pay match, in that order.
 */
async function assertLateIssueConfirmed(
  tx: Tx,
  run: RunRow,
  today: string,
  latePayment: LatePaymentInput | undefined,
): Promise<LateIssueContext | null> {
  const snapshot = run.runSnapshot as RunSnapshot;
  const trigger = lateTrigger(run.payDate, today, snapshot.inputs.state?.workState ?? null);
  if (trigger === null) return null;
  const payDate = run.payDate;
  // LI-16: fail closed before any write when the depositor schedule is not supported.
  if (!lateIssueAllowed()) {
    throw new PayrollServiceError("late_issue_not_supported", LATE_ISSUE_NOT_SUPPORTED_MESSAGE, {
      payDate,
    });
  }
  const taxYear = snapshot.inputs.resolution?.taxYear ?? Number(payDate.slice(0, 4));
  const jurisdictions = stateReturnJurisdictions(snapshot);
  // PL amendment 3 / LI-17: the no-income-tax variant follows the state
  // config the run was computed with (snapshot kind), never the live table.
  const noIncomeTax = snapshot.inputs.state?.kind === "none";
  const questions = jurisdictions.map((j) => stateQuestions(j, payDate, noIncomeTax));

  if (!latePayment) {
    throw new PayrollServiceError(
      "late_payment_confirmation_required",
      confirmationRequiredMessage(payDate),
      {
        payDate,
        attestation: {
          version: ATTESTATION_VERSION,
          text: attestationText(payDate),
          stateQuestions: questions,
        },
        stateJurisdictions: jurisdictions,
      },
    );
  }

  const answered = latePayment.stateReturns.map((r) => r.jurisdiction);
  const exact =
    new Set(answered).size === answered.length &&
    answered.length === jurisdictions.length &&
    jurisdictions.every((j) => answered.includes(j));
  if (!exact) {
    throw new LateIssueRefusedError(
      "late_payment_incomplete",
      incompleteMessage(jurisdictions),
      { payDate, stateJurisdictions: jurisdictions },
      run.publicId,
      payDate,
    );
  }

  const filed = latePayment.stateReturns
    .filter((r) => r.withholdingReturnFiled || r.suiWageReportFiled || r.annualReconciliationFiled)
    .map((r) => r.jurisdiction);
  if (filed.length > 0) {
    throw new LateIssueRefusedError(
      "state_return_filed",
      stateReturnFiledMessage(filed),
      { payDate, jurisdictions: filed },
      run.publicId,
      payDate,
      filed,
    );
  }

  if ((await storedNetPayCents(tx, run.id)) !== latePayment.netPayCents) {
    throw new LateIssueRefusedError(
      "late_payment_amount_mismatch",
      AMOUNT_MISMATCH_MESSAGE,
      { payDate },
      run.publicId,
      payDate,
    );
  }
  return { trigger, taxYear, questions, latePayment };
}

/**
 * L4.5 steps 6–9 for a late run, after the run.issue audit: refresh the
 * unfiled closing worksheets, sync the pay-date period's deposits under
 * SYNC_LOCK, send the W-2 changed notice, and write run.issued_late.
 */
async function applyLateIssueEffects(
  tx: Tx,
  config: AppConfig,
  run: RunRow,
  late: LateIssueContext,
  today: string,
  actorId: string,
): Promise<string[]> {
  await refreshFilingsForPayDate(tx, run.payDate);
  const followUps = await syncDepositsForPayDate(tx, config, {
    payDate: run.payDate,
    jurisdictions: late.questions.map((q) => q.jurisdiction),
    today,
    actorId,
  });
  // PAY-206 (R6): the gate is the furnishing record, not the notified-years
  // proxy — only an employee who could hold a copy with other figures gets
  // a follow-up (the run's own employee lock is held).
  const w2Code = await furnishCorrectionIfNeeded(tx, config, run.employeeId, late.taxYear, today);
  if (w2Code) followUps.push(w2Code);
  const { latePayment } = late;
  await tx.insert(auditEvents).values({
    actorId,
    action: "run.issued_late",
    entity: "payroll_run",
    entityId: run.publicId,
    before: null,
    after: {
      payDate: run.payDate,
      taxYear: late.taxYear,
      localToday: today,
      trigger: late.trigger,
      attestationVersion: latePayment.attestationVersion,
      attestationText: attestationText(run.payDate, usd(latePayment.netPayCents)),
      netPayCents: latePayment.netPayCents,
      stateReturns: latePayment.stateReturns,
      stateAttestationText: stateAttestationText(late.questions, latePayment.stateReturns),
      followUps,
    },
  });
  return followUps;
}

/** Status precondition of the transition, and void's required reason. */
function assertTransitionAllowed(
  rule: { from: readonly string[] },
  run: RunRow,
  input: { action: RunAction; reason?: string },
): void {
  if (!rule.from.includes(run.status)) {
    throw new PayrollServiceError(
      "invalid_transition",
      `cannot ${input.action} a run in status '${run.status}'`,
    );
  }
  if (input.action === "void" && !input.reason?.trim()) {
    throw new PayrollServiceError("void_reason_required", "voiding a run requires a reason");
  }
}

/** Column patch for the transition (void's reason is checked by assertTransitionAllowed). */
function transitionPatch(
  input: { action: RunAction; actorId: string; reason?: string },
  now: Date,
) {
  return input.action === "approve"
    ? { status: "approved", approvedBy: input.actorId, approvedAt: now, updatedAt: now }
    : input.action === "issue"
      ? { status: "issued", issuedAt: now, updatedAt: now }
      : { status: "void", voidedAt: now, voidReason: input.reason!.trim(), updatedAt: now };
}

export interface TransitionInput {
  publicId: string;
  action: RunAction;
  actorId: string;
  reason?: string;
  /** PAY-193 L4: the late-issue confirmation; ignored unless the run is late. */
  latePayment?: LatePaymentInput;
}

export interface TransitionResult {
  run: RunRow;
  /** PAY-193 L4: set only on a late issue. Codes only, no amounts. */
  lateIssue?: { taxYear: number; followUps: string[] };
}

/** Audit rows written after the rollback (D4 run.stale_detected, L4 run.late_issue_refused). */
async function auditRefusal(db: Db, actorId: string, err: unknown): Promise<void> {
  let row: { action: string; entityId: string; after: Record<string, unknown> } | null = null;
  if (err instanceof StaleDraftError) {
    row = {
      action: "run.stale_detected",
      entityId: err.runPublicId,
      after: { fields: err.fields },
    };
  } else if (err instanceof LateIssueRefusedError) {
    row = {
      action: "run.late_issue_refused",
      entityId: err.runPublicId,
      after: {
        payDate: err.payDate,
        reason: err.code,
        ...(err.jurisdictions ? { jurisdictions: err.jurisdictions } : {}),
      },
    };
  }
  if (!row) return;
  try {
    await db.insert(auditEvents).values({
      actorId,
      action: row.action,
      entity: "payroll_run",
      entityId: row.entityId,
      before: null,
      after: row.after,
    });
  } catch (auditErr) {
    // Error class only: a driver message can carry query parameters.
    console.warn(
      `[payroll] ${row.action} audit write failed for run ${row.entityId} (${auditErr instanceof Error ? auditErr.name : "unknown"})`,
    );
  }
}

/**
 * The conditional status update and its run.<action> audit row. Conditional
 * on the status read: a writer outside the lock can never be overwritten
 * (e.g. an issued run turned void).
 */
async function writeTransition(
  tx: Tx,
  run: RunRow,
  input: TransitionInput,
  late: boolean,
): Promise<RunRow> {
  const updated = await tx
    .update(payrollRuns)
    .set(transitionPatch(input, new Date()))
    .where(and(eq(payrollRuns.id, run.id), eq(payrollRuns.status, run.status)))
    .returning();
  const next = updated[0];
  if (!next) {
    throw new PayrollServiceError(
      "invalid_transition",
      `cannot ${input.action} this run: its status changed from '${run.status}' while the request was running; reload and try again`,
    );
  }
  await tx.insert(auditEvents).values({
    actorId: input.actorId,
    action: `run.${input.action}`,
    entity: "payroll_run",
    entityId: run.publicId,
    before: { status: run.status },
    after: {
      status: next.status,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(late ? { late: true } : {}),
    },
  });
  return next;
}

/** One transition inside its transaction (lock order: employee → FILING_CLOSE_LOCK → SYNC_LOCK). */
async function applyTransition(
  tx: Tx,
  deps: GenerateDeps,
  rule: { from: readonly string[] },
  input: TransitionInput,
  today: string,
): Promise<TransitionResult> {
  const found = await getRunByPublicId(tx, input.publicId);
  if (!found) throw new PayrollServiceError("run_not_found", `run ${input.publicId} not found`);
  await lockEmployee(tx, found.employeeId);
  // Re-read under the lock: a parallel issue may have changed it.
  const run = (await getRunByPublicId(tx, input.publicId)) ?? found;
  assertTransitionAllowed(rule, run, input);
  if (input.action === "void") return { run: await writeTransition(tx, run, input, false) };
  await assertRunCurrent(tx, run, input.action, today);
  if (input.action === "approve") return { run: await writeTransition(tx, run, input, false) };

  const late = await assertLateIssueConfirmed(tx, run, today, input.latePayment);
  const next = await writeTransition(tx, run, input, late !== null);
  const followUps = late
    ? await applyLateIssueEffects(tx, deps.config, next, late, today, input.actorId)
    : null;
  const tplCtx = await templateContext(tx as DbLike, deps.config);
  await notifyPayslipIssued(tx as DbLike & Pick<Db, "insert">, tplCtx, next);
  return late && followUps
    ? { run: next, lateIssue: { taxYear: late.taxYear, followUps } }
    : { run: next };
}

/**
 * Apply a state-machine transition with audit_events in the same transaction.
 * Every action takes the per-employee lock; approve and issue then run the
 * Spec 26 checks (assertRunCurrent); a late issue (PAY-193 L4) also needs
 * the admin's confirmation and updates worksheets, deposits and the W-2
 * notice in the same transaction. Issue inserts the payslip_issued outbox row.
 */
export async function transitionRunDetailed(
  deps: GenerateDeps,
  input: TransitionInput,
): Promise<TransitionResult> {
  const rule = TRANSITIONS[input.action];
  if (!rule) throw new PayrollServiceError("invalid_transition", `unknown action ${input.action}`);
  const today = localToday(deps);
  try {
    return await deps.db.transaction((tx) => applyTransition(tx, deps, rule, input, today));
  } catch (err) {
    // D4 / L4: the refusal rolled the transaction back; record it on its
    // own. A failed audit write is logged and never replaces the 409.
    await auditRefusal(deps.db, input.actorId, err);
    throw err;
  }
}

/** transitionRunDetailed, returning the run only. */
export async function transitionRun(deps: GenerateDeps, input: TransitionInput): Promise<RunRow> {
  return (await transitionRunDetailed(deps, input)).run;
}

/**
 * PAY-193 L4 (EF-11): who confirmed a late issue and when — from the newest
 * run.issued_late audit row; null for any other run.
 */
export async function lateIssueOf(
  db: DbLike,
  publicId: string,
): Promise<{ confirmedBy: string; confirmedAt: Date } | null> {
  const rows = await db
    .select({ actorId: auditEvents.actorId, createdAt: auditEvents.createdAt })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, "run.issued_late"), eq(auditEvents.entityId, publicId)))
    .orderBy(desc(auditEvents.id))
    .limit(1);
  const row = rows[0];
  return row?.createdAt ? { confirmedBy: row.actorId, confirmedAt: row.createdAt } : null;
}

export async function getRunByPublicId(db: DbLike, publicId: string): Promise<RunRow | null> {
  const rows = await db
    .select()
    .from(payrollRuns)
    .where(eq(payrollRuns.publicId, publicId))
    .limit(1);
  return rows[0] ?? null;
}

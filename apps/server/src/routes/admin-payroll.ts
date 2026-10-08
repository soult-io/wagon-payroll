/**
 * Admin payroll routes (spec payroll-engine D6 + data-model): run listing,
 * generation, state-machine transitions, pay-schedule config, and
 * effective-dated compensation / W-4 / tax-table CRUD with audit_events.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, gte, lte, isNull, type SQL } from "drizzle-orm";
import {
  auditEvents,
  compensation,
  payrollRuns,
  paySchedules,
  taxBrackets,
  taxConfig,
  w4Elections,
} from "@payroll/db";
import { effectiveFutaRate } from "@payroll/engine";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import type { Guards } from "../plugins/guards.js";
import { FILED_DATE_IN_FUTURE, isFiledDateInFuture, validateW4Dates } from "../payroll/w4-dates.js";
import {
  generateDraftsForPeriod,
  getRunByPublicId,
  lateIssueOf,
  PayrollServiceError,
  transitionRunDetailed,
  type RunAction,
  type TransitionInput,
} from "../payroll/runs.js";
import { localDate } from "../payroll/run-dates.js";
import { FrozenFiguresRaceError } from "../filings/w2-furnish-core.js";
import { getYearEndStatus } from "../payroll/year-end.js";
import { latestCoveredYear, taxTableCoverage } from "../payroll/tax-coverage.js";
import { coverageYears } from "../payroll/tax-alert.js";

interface AdminPayrollDeps {
  db: Db;
  config: AppConfig;
  guards: Guards;
  /** Re-register pg-boss cron after a pay-schedule change (no-op without scheduler). */
  onScheduleChange?: () => Promise<void>;
  /**
   * Wall clock for the issue-time pay-date check (Spec 26 (PAY-173) D9) and
   * the year-end warning (PAY-193 D9.8); default now.
   */
  clock?: () => Date;
  /**
   * PAY-103 R18 (D3-a): constructor-only clock for the tax-table coverage
   * endpoint (the ephemeral e2e boot passes the process clock); falls back to
   * `clock`, then the process clock. Never read from env or a request.
   */
  coverageClock?: () => Date;
}

/** Exhaustive: a new PayrollServiceError code must be given a status here. */
function payrollErrorStatus(err: PayrollServiceError): number {
  switch (err.code) {
    case "run_not_found":
      return 404;
    case "invalid_transition":
    case "void_reason_required":
    // Spec 26 (PAY-173) D4 / D6: fixed bodies, field names and dates only.
    case "stale_draft":
    case "ytd_order_conflict":
    // PAY-193 (D9.4): body carries payDate and form codes only.
    case "pay_period_filed":
    // PAY-193 L4: payDate, jurisdiction codes and server-rendered text; never an amount.
    case "late_payment_confirmation_required":
    case "late_payment_incomplete":
    case "state_return_filed":
    case "late_payment_amount_mismatch":
    case "late_issue_not_supported":
      return 409;
    case "no_compensation":
    case "no_tax_config":
    case "unsupported_frequency":
    case "not_w2_employee":
    case "no_company":
    case "no_state_tax_config":
    case "futa_cap_exceeded":
    case "invalid_period":
      return 400;
  }
}

const serviceError = (
  err: unknown,
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) => {
  if (err instanceof PayrollServiceError) {
    return reply
      .code(payrollErrorStatus(err))
      .send({ ...err.details, error: err.code, message: err.message });
  }
  // PAY-223: a state ID re-entered while a late run posts its W-2
  // correction rolls the issue back; the admin retries.
  if (err instanceof FrozenFiguresRaceError) return reply.code(409).send({ error: "w2_not_ready" });
  throw err;
};

/**
 * PAY-193 L4 (L4.3): the issue body. Strict at every level; a malformed body
 * is a bare 400 invalid_body (no zod issues: they could echo the amount).
 */
const latePaymentSchema = z
  .object({
    attestationVersion: z.literal(1),
    netPayCents: z.number().int().nonnegative().max(1e10),
    stateReturns: z
      .array(
        z
          .object({
            jurisdiction: z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,12})?$/),
            withholdingReturnFiled: z.boolean(),
            suiWageReportFiled: z.boolean(),
            annualReconciliationFiled: z.boolean(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
const issueBody = z
  .object({ reason: z.string().max(500).optional(), latePayment: latePaymentSchema.optional() })
  .strict();
const reasonBody = z.object({ reason: z.string().max(500).optional() });

/** Issue has its own strict schema (PAY-193 L4); approve and void keep { reason }. Null = invalid. */
function parseTransitionBody(action: RunAction, raw: unknown): z.infer<typeof issueBody> | null {
  const parsed =
    action === "issue" ? issueBody.safeParse(raw ?? {}) : reasonBody.safeParse(raw ?? {});
  return parsed.success ? parsed.data : null;
}

function transitionInput(
  publicId: string,
  action: RunAction,
  actorId: string,
  body: z.infer<typeof issueBody>,
): TransitionInput {
  return {
    publicId,
    action,
    actorId,
    ...(body.reason !== undefined ? { reason: body.reason } : {}),
    ...(body.latePayment ? { latePayment: body.latePayment } : {}),
  };
}

export function registerAdminPayrollRoutes(app: FastifyInstance, deps: AdminPayrollDeps): void {
  const { db, config, guards } = deps;
  const now = deps.clock ?? (() => new Date());
  const coverageNow = deps.coverageClock ?? now;
  const admin = guards.requireRole("admin");

  async function audit(
    actorId: string,
    action: string,
    entity: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ) {
    await db.insert(auditEvents).values({ actorId, action, entity, entityId, before, after });
  }

  // ------------------------------------------------------------------ runs

  app.get("/api/admin/payroll-runs", { preHandler: admin }, async (req) => {
    const q = z
      .object({
        status: z.enum(["draft", "awaiting_approval", "approved", "issued", "void"]).optional(),
        employeeId: z.coerce.number().int().optional(),
        year: z.coerce.number().int().min(2020).max(2100).optional(),
      })
      .parse(req.query);
    const conditions: SQL[] = [];
    if (q.status) conditions.push(eq(payrollRuns.status, q.status));
    if (q.employeeId) conditions.push(eq(payrollRuns.employeeId, q.employeeId));
    // Spec 26 (PAY-173): `year` is the PAY-date year, like the W-2, 941, 940
    // and export.
    if (q.year) {
      conditions.push(gte(payrollRuns.payDate, `${q.year}-01-01`));
      conditions.push(lte(payrollRuns.payDate, `${q.year}-12-31`));
    }
    const rows = await db
      .select({
        publicId: payrollRuns.publicId,
        employeeId: payrollRuns.employeeId,
        periodStart: payrollRuns.periodStart,
        periodEnd: payrollRuns.periodEnd,
        payDate: payrollRuns.payDate,
        status: payrollRuns.status,
        snapshotHash: payrollRuns.snapshotHash,
        createdBy: payrollRuns.createdBy,
        createdAt: payrollRuns.createdAt,
        // Included for the row-expansion entries breakdown (admin-only data).
        runSnapshot: payrollRuns.runSnapshot,
      })
      .from(payrollRuns)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(payrollRuns.payDate), desc(payrollRuns.periodStart), desc(payrollRuns.id));
    return { runs: rows };
  });

  // PAY-193 (D9.8): year-end warning window. Registered before /:publicId.
  app.get("/api/admin/payroll-runs/year-end", { preHandler: admin }, async () => {
    const today = localDate(now(), config.appTz);
    return getYearEndStatus(db, today);
  });

  app.get("/api/admin/payroll-runs/:publicId", { preHandler: admin }, async (req, reply) => {
    const { publicId } = req.params as { publicId: string };
    const run = await getRunByPublicId(db, publicId);
    if (!run) return reply.code(404).send({ error: "not_found" });
    // PAY-193 L4 (EF-11): who confirmed a late issue, from its audit row.
    return { run, lateIssue: await lateIssueOf(db, publicId) };
  });

  app.post("/api/admin/payroll-runs/generate", { preHandler: admin }, async (req, reply) => {
    const body = z
      .object({
        year: z.number().int().min(2020).max(2100),
        month: z.number().int().min(1).max(12),
        employeeId: z.number().int().optional(),
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
    const result = await generateDraftsForPeriod(
      { db, config },
      {
        year: body.data.year,
        month: body.data.month,
        ...(body.data.employeeId !== undefined ? { employeeId: body.data.employeeId } : {}),
        // Manual "generate draft now" (off-cycle allowed): not limited to auto-draft.
        autoDraftOnly: false,
        createdBy: req.authUser!.id,
      },
    );
    await audit(
      req.authUser!.id,
      "run.generate",
      "payroll_run",
      `${body.data.year}-${String(body.data.month).padStart(2, "0")}`,
      null,
      { generated: result.generated.map((r) => r.publicId), skipped: result.skipped },
    );
    return reply.code(201).send(result);
  });

  for (const action of ["approve", "issue", "void"] as const satisfies RunAction[]) {
    app.post(
      `/api/admin/payroll-runs/:publicId/${action}`,
      { preHandler: admin },
      async (req, reply) => {
        const { publicId } = req.params as { publicId: string };
        const body = parseTransitionBody(action, req.body);
        if (!body) return reply.code(400).send({ error: "invalid_body" });
        try {
          const result = await transitionRunDetailed(
            { db, config, ...(deps.clock ? { clock: deps.clock } : {}) },
            transitionInput(publicId, action, req.authUser!.id, body),
          );
          // PAY-193 L4: `lateIssue` only on a late issue.
          return result.lateIssue ? result : { run: result.run };
        } catch (err) {
          return serviceError(err, reply);
        }
      },
    );
  }

  // ------------------------------------------------------------ pay schedules

  app.get("/api/admin/pay-schedules", { preHandler: admin }, async () => {
    const rows = await db.select().from(paySchedules).orderBy(paySchedules.id);
    return { schedules: rows };
  });

  app.put("/api/admin/pay-schedules", { preHandler: admin }, async (req, reply) => {
    const body = z
      .object({
        draftDayOfMonth: z.number().int().min(1).max(28).default(15),
        payDayOfMonth: z.number().int().min(1).max(28).default(15),
        autoDraft: z.boolean().default(true),
        active: z.boolean().default(true),
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });

    // Upsert the company-wide default row (employee_id NULL).
    const existing = await db
      .select()
      .from(paySchedules)
      .where(isNull(paySchedules.employeeId))
      .limit(1);
    const before = existing[0] ?? null;
    let row: typeof paySchedules.$inferSelect;
    if (before) {
      const updated = await db
        .update(paySchedules)
        .set({ ...body.data, frequency: "monthly", updatedAt: new Date() })
        .where(eq(paySchedules.id, before.id))
        .returning();
      row = updated[0]!;
    } else {
      const inserted = await db
        .insert(paySchedules)
        .values({ ...body.data, employeeId: null, frequency: "monthly" })
        .returning();
      row = inserted[0]!;
    }
    await audit(
      req.authUser!.id,
      "pay_schedule.update",
      "pay_schedules",
      String(row.id),
      before,
      row,
    );
    await deps.onScheduleChange?.();
    return { schedule: row };
  });

  // ------------------------------------------------------------ compensation

  app.get("/api/admin/employees/:employeeId/compensation", { preHandler: admin }, async (req) => {
    const employeeId = Number((req.params as { employeeId: string }).employeeId);
    const rows = await db
      .select()
      .from(compensation)
      .where(eq(compensation.employeeId, employeeId))
      .orderBy(desc(compensation.effectiveFrom));
    return { compensation: rows };
  });

  app.post(
    "/api/admin/employees/:employeeId/compensation",
    { preHandler: admin },
    async (req, reply) => {
      const employeeId = Number((req.params as { employeeId: string }).employeeId);
      const body = z
        .object({
          periodAmount: z.number().positive(),
          frequency: z.enum(["weekly", "biweekly", "semimonthly", "monthly"]).default("monthly"),
          effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          effectiveTo: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .nullable()
            .optional(),
        })
        .safeParse(req.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
      const inserted = await db
        .insert(compensation)
        .values({
          employeeId,
          periodAmount: String(body.data.periodAmount),
          frequency: body.data.frequency,
          effectiveFrom: body.data.effectiveFrom,
          effectiveTo: body.data.effectiveTo ?? null,
        })
        .returning();
      await audit(
        req.authUser!.id,
        "compensation.create",
        "compensation",
        String(inserted[0]!.id),
        null,
        inserted[0],
      );
      return reply.code(201).send({ compensation: inserted[0] });
    },
  );

  // ------------------------------------------------------------------- W-4

  app.get("/api/admin/employees/:employeeId/w4", { preHandler: admin }, async (req) => {
    const employeeId = Number((req.params as { employeeId: string }).employeeId);
    const rows = await db
      .select()
      .from(w4Elections)
      .where(eq(w4Elections.employeeId, employeeId))
      .orderBy(desc(w4Elections.effectiveFrom));
    return { w4Elections: rows };
  });

  // Append-only per data-model: new elections are new rows; no update/delete.
  app.post("/api/admin/employees/:employeeId/w4", { preHandler: admin }, async (req, reply) => {
    const employeeId = Number((req.params as { employeeId: string }).employeeId);
    const body = z
      .object({
        taxYear: z.number().int().min(2020).max(2100),
        filingStatus: z
          .enum(["single", "married_joint", "married_separate", "head_of_household"])
          .default("single"),
        federalExempt: z.boolean().default(false),
        multipleJobs: z.boolean().default(false),
        dependentsAmount: z.number().min(0).default(0),
        otherIncome: z.number().min(0).default(0),
        deductionsAmount: z.number().min(0).default(0),
        extraWithholding: z.number().min(0).default(0),
        effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        filedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        renewalDeadline: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
        note: z.string().max(500).default(""),
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
    if (isFiledDateInFuture(body.data.filedDate, now(), config.appTz)) {
      return reply.code(400).send(FILED_DATE_IN_FUTURE);
    }
    // Spec 26 (PAY-173) D3 step 4: effective date inside the lawful window.
    const check = await validateW4Dates(db, employeeId, body.data);
    if (check.violation) {
      return reply.code(400).send({
        error: "invalid_w4_effective_date",
        message: check.violation,
        window: check.window,
      });
    }
    const inserted = await db
      .insert(w4Elections)
      .values({
        employeeId,
        taxYear: body.data.taxYear,
        filingStatus: body.data.filingStatus,
        federalExempt: body.data.federalExempt,
        multipleJobs: body.data.multipleJobs,
        dependentsAmount: String(body.data.dependentsAmount),
        otherIncome: String(body.data.otherIncome),
        deductionsAmount: String(body.data.deductionsAmount),
        extraWithholding: String(body.data.extraWithholding),
        effectiveFrom: body.data.effectiveFrom,
        filedDate: body.data.filedDate,
        renewalDeadline: body.data.renewalDeadline ?? null,
        note: body.data.note,
      })
      .returning();
    await audit(
      req.authUser!.id,
      "w4.create",
      "w4_elections",
      String(inserted[0]!.id),
      null,
      inserted[0],
    );
    return reply.code(201).send({ w4: inserted[0] });
  });

  // -------------------------------------------------------------- tax tables

  // Read-only coverage of the installed tax tables (PAY-225). Lists the
  // current year, plus next year from Dec 1 (company-local date). Each entry
  // comes from taxTableCoverage, the one coverage definition. No PII.
  app.get("/api/admin/tax-tables/coverage", { preHandler: admin }, async () => {
    const today = localDate(coverageNow(), config.appTz);
    const year = Number(today.slice(0, 4));
    const coverage = [];
    for (const y of coverageYears(today)) coverage.push(await taxTableCoverage(db, y));
    return { today, latestCoveredYear: await latestCoveredYear(db, year), years: coverage };
  });

  app.get("/api/admin/tax-config", { preHandler: admin }, async (req) => {
    const q = z
      .object({
        year: z.coerce.number().int().optional(),
        jurisdiction: z.string().optional(),
      })
      .parse(req.query);
    const conditions: SQL[] = [];
    if (q.year) conditions.push(eq(taxConfig.taxYear, q.year));
    if (q.jurisdiction) conditions.push(eq(taxConfig.jurisdiction, q.jurisdiction));
    const configs = await db
      .select()
      .from(taxConfig)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(taxConfig.taxYear, taxConfig.jurisdiction);
    const bracketConditions: SQL[] = [];
    if (q.year) bracketConditions.push(eq(taxBrackets.taxYear, q.year));
    if (q.jurisdiction) bracketConditions.push(eq(taxBrackets.jurisdiction, q.jurisdiction));
    const brackets = await db
      .select()
      .from(taxBrackets)
      .where(bracketConditions.length ? and(...bracketConditions) : undefined)
      .orderBy(taxBrackets.taxYear, taxBrackets.jurisdiction, taxBrackets.ordinal);
    return { taxConfig: configs, taxBrackets: brackets };
  });

  app.put("/api/admin/tax-config", { preHandler: admin }, async (req, reply) => {
    const scalar = z.object({
      standardDeduction: z.number().min(0),
      socialSecurityRate: z.number().min(0).max(1),
      socialSecurityWageCap: z.number().min(0),
      medicareRate: z.number().min(0).max(1),
      medicareAdditionalRate: z.number().min(0).max(1),
      medicareAdditionalThreshold: z.number().min(0),
      stateWithholdingRate: z.number().min(0).max(1).default(0),
      employerSocialSecurityRate: z.number().min(0).max(1),
      employerMedicareRate: z.number().min(0).max(1),
      /**
       * PAY-18: the SUTA credit is the configured input; the net FUTA rate
       * (6.0% − credit) is derived and mirrored into futa_rate so payroll
       * runs accrue the same rate the 940 worksheet computes with.
       */
      sutaCreditRate: z.number().min(0).max(0.06),
      futaWageCap: z.number().min(0),
    });
    const body = z
      .object({
        jurisdiction: z.string().min(1).default("federal"),
        taxYear: z.number().int().min(2020).max(2100),
        config: scalar,
        brackets: z
          .array(
            z.object({
              ordinal: z.number().int().min(1),
              minAmount: z.number().min(0),
              maxAmount: z.number().min(0).nullable(),
              rate: z.number().min(0).max(1),
            }),
          )
          .min(1),
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });

    const { jurisdiction, taxYear } = body.data;
    const beforeConfig = await db
      .select()
      .from(taxConfig)
      .where(and(eq(taxConfig.jurisdiction, jurisdiction), eq(taxConfig.taxYear, taxYear)))
      .limit(1);

    const c = body.data.config;
    const values = {
      jurisdiction,
      taxYear,
      standardDeduction: String(c.standardDeduction),
      socialSecurityRate: String(c.socialSecurityRate),
      socialSecurityWageCap: String(c.socialSecurityWageCap),
      medicareRate: String(c.medicareRate),
      medicareAdditionalRate: String(c.medicareAdditionalRate),
      medicareAdditionalThreshold: String(c.medicareAdditionalThreshold),
      stateWithholdingRate: String(c.stateWithholdingRate),
      employerSocialSecurityRate: String(c.employerSocialSecurityRate),
      employerMedicareRate: String(c.employerMedicareRate),
      futaRate: String(effectiveFutaRate(c.sutaCreditRate)),
      futaWageCap: String(c.futaWageCap),
      sutaCreditRate: String(c.sutaCreditRate),
    };
    const upserted = await db
      .insert(taxConfig)
      .values(values)
      .onConflictDoUpdate({
        target: [taxConfig.jurisdiction, taxConfig.taxYear],
        set: values,
      })
      .returning();

    // Replace the bracket set atomically: delete + insert in one transaction.
    await db.transaction(async (tx) => {
      await tx
        .delete(taxBrackets)
        .where(and(eq(taxBrackets.jurisdiction, jurisdiction), eq(taxBrackets.taxYear, taxYear)));
      await tx.insert(taxBrackets).values(
        body.data.brackets.map((b) => ({
          jurisdiction,
          taxYear,
          ordinal: b.ordinal,
          minAmount: String(b.minAmount),
          maxAmount: b.maxAmount === null ? null : String(b.maxAmount),
          rate: String(b.rate),
        })),
      );
    });

    await audit(
      req.authUser!.id,
      "tax_config.upsert",
      "tax_config",
      `${jurisdiction}:${taxYear}`,
      beforeConfig[0] ?? null,
      { config: upserted[0], brackets: body.data.brackets },
    );
    return { config: upserted[0] };
  });
}

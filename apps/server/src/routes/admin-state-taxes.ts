/**
 * PAY-13 phase 1 — admin routes for per-state withholding: state tax config /
 * bracket management (mirror of the federal /api/admin/tax-config pair),
 * employee work-state assignment (effective-dated; assigning closes the
 * previous open row), and state withholding elections (the IL-W-4 / DE 4
 * mirror of the W-4 routes).
 *
 * PAY-8 approval flow: V1 writes are admin-direct with audit_events, same as
 * the federal tax-config and W-4 admin routes; employee-initiated change
 * requests for state elections are a phase-2 concern.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import {
  auditEvents,
  employees,
  employeeWorkStates,
  stateTaxBrackets,
  stateTaxConfigs,
  stateWithholdingElections,
} from "@payroll/db";
import { WORK_LOCALITY_STATES, workStateInput } from "@payroll/shared";
import type { Db } from "../db.js";
import type { Guards } from "../plugins/guards.js";
import { NOT_FOUND, parseEmployeeId, safeIssues } from "./params.js";

interface AdminStateTaxDeps {
  db: Db;
  guards: Guards;
}

const stateCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, "state code must be a 2-letter uppercase USPS code");

const filingStatusSchema = z.enum([
  "single",
  "married_joint",
  "married_separate",
  "head_of_household",
]);

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export function registerAdminStateTaxRoutes(app: FastifyInstance, deps: AdminStateTaxDeps): void {
  const { db, guards } = deps;
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

  async function employeeExists(employeeId: number): Promise<boolean> {
    const rows = await db
      .select({ id: employees.id })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);
    return rows.length > 0;
  }

  // ------------------------------------------------------- state tax config

  app.get("/api/admin/state-tax-config", { preHandler: admin }, async (req) => {
    const q = z
      .object({
        year: z.coerce.number().int().optional(),
        jurisdiction: z.string().optional(),
      })
      .parse(req.query);
    const conditions: SQL[] = [];
    if (q.year) conditions.push(eq(stateTaxConfigs.taxYear, q.year));
    if (q.jurisdiction) conditions.push(eq(stateTaxConfigs.jurisdiction, q.jurisdiction));
    const configs = await db
      .select()
      .from(stateTaxConfigs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(stateTaxConfigs.taxYear, stateTaxConfigs.jurisdiction);
    const bracketConditions: SQL[] = [];
    if (q.year) bracketConditions.push(eq(stateTaxBrackets.taxYear, q.year));
    if (q.jurisdiction) bracketConditions.push(eq(stateTaxBrackets.jurisdiction, q.jurisdiction));
    const brackets = await db
      .select()
      .from(stateTaxBrackets)
      .where(bracketConditions.length ? and(...bracketConditions) : undefined)
      .orderBy(stateTaxBrackets.taxYear, stateTaxBrackets.jurisdiction, stateTaxBrackets.ordinal);
    return { stateTaxConfig: configs, stateTaxBrackets: brackets };
  });

  app.put("/api/admin/state-tax-config", { preHandler: admin }, async (req, reply) => {
    const scalar = z.object({
      kind: z.enum(["none", "flat", "progressive"]),
      flatRate: z.number().min(0).max(1).nullish(),
      standardDeduction: z.number().min(0).nullish(),
      standardDeductionAlt: z.number().min(0).nullish(),
      altMinAllowances: z.number().int().min(0).nullish(),
      lowIncomeExemption: z.number().min(0).nullish(),
      lowIncomeExemptionAlt: z.number().min(0).nullish(),
      allowanceDeduction: z.number().min(0).nullish(),
      allowanceCredit: z.number().min(0).nullish(),
      additionalAllowanceDeduction: z.number().min(0).nullish(),
      note: z.string().max(500).default(""),
    });
    const body = z
      .object({
        jurisdiction: z.string().min(1).max(32),
        taxYear: z.number().int().min(2020).max(2100),
        config: scalar,
        /** Required (min 1) for kind='progressive'; ignored otherwise. */
        brackets: z
          .array(
            z.object({
              ordinal: z.number().int().min(1),
              minAmount: z.number().min(0),
              maxAmount: z.number().min(0).nullable(),
              rate: z.number().min(0).max(1),
            }),
          )
          .default([]),
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
    if (body.data.config.kind === "progressive" && body.data.brackets.length === 0) {
      return reply
        .code(400)
        .send({ error: "invalid_body", message: "kind='progressive' requires at least 1 bracket" });
    }
    if (body.data.config.kind === "flat" && body.data.config.flatRate == null) {
      return reply
        .code(400)
        .send({ error: "invalid_body", message: "kind='flat' requires flatRate" });
    }

    const { jurisdiction, taxYear } = body.data;
    const beforeConfig = await db
      .select()
      .from(stateTaxConfigs)
      .where(
        and(eq(stateTaxConfigs.jurisdiction, jurisdiction), eq(stateTaxConfigs.taxYear, taxYear)),
      )
      .limit(1);

    const c = body.data.config;
    const str = (v: number | null | undefined): string | null => (v == null ? null : String(v));
    const values = {
      jurisdiction,
      taxYear,
      kind: c.kind,
      flatRate: str(c.flatRate),
      standardDeduction: str(c.standardDeduction),
      standardDeductionAlt: str(c.standardDeductionAlt),
      altMinAllowances: c.altMinAllowances ?? null,
      lowIncomeExemption: str(c.lowIncomeExemption),
      lowIncomeExemptionAlt: str(c.lowIncomeExemptionAlt),
      allowanceDeduction: str(c.allowanceDeduction),
      allowanceCredit: str(c.allowanceCredit),
      additionalAllowanceDeduction: str(c.additionalAllowanceDeduction),
      note: c.note,
      updatedAt: new Date(),
    };
    const upserted = await db
      .insert(stateTaxConfigs)
      .values(values)
      .onConflictDoUpdate({
        target: [stateTaxConfigs.jurisdiction, stateTaxConfigs.taxYear],
        set: values,
      })
      .returning();

    // Replace the bracket set atomically: delete + insert in one transaction.
    await db.transaction(async (tx) => {
      await tx
        .delete(stateTaxBrackets)
        .where(
          and(
            eq(stateTaxBrackets.jurisdiction, jurisdiction),
            eq(stateTaxBrackets.taxYear, taxYear),
          ),
        );
      if (body.data.brackets.length > 0) {
        await tx.insert(stateTaxBrackets).values(
          body.data.brackets.map((b) => ({
            jurisdiction,
            taxYear,
            ordinal: b.ordinal,
            minAmount: String(b.minAmount),
            maxAmount: b.maxAmount === null ? null : String(b.maxAmount),
            rate: String(b.rate),
          })),
        );
      }
    });

    await audit(
      req.authUser!.id,
      "state_tax_config.upsert",
      "state_tax_config",
      `${jurisdiction}:${taxYear}`,
      beforeConfig[0] ?? null,
      { config: upserted[0], brackets: body.data.brackets },
    );
    return { config: upserted[0] };
  });

  // ------------------------------------------------------------ work states

  app.get(
    "/api/admin/employees/:employeeId/work-state",
    { preHandler: admin },
    async (req, reply) => {
      const employeeId = parseEmployeeId(req.params);
      if (employeeId === null || !(await employeeExists(employeeId))) {
        return reply.code(404).send(NOT_FOUND);
      }
      const rows = await db
        .select()
        .from(employeeWorkStates)
        .where(eq(employeeWorkStates.employeeId, employeeId))
        .orderBy(desc(employeeWorkStates.effectiveFrom));
      return { workStates: rows };
    },
  );

  /**
   * Assign a work state effective from a date. The previous open row (if any)
   * is closed at the new effective_from in the same transaction — windows are
   * [effective_from, effective_to), matching the resolver's semantics.
   *
   * PAY-163 (Spec 25 (PAY-120)): New York and Maryland rows answer the
   * work-locality question (`localityCode`: Yonkers or null for New York, the
   * county for Maryland); the answer marks the new row confirmed.
   */
  app.put(
    "/api/admin/employees/:employeeId/work-state",
    { preHandler: admin },
    async (req, reply) => {
      const employeeId = parseEmployeeId(req.params);
      if (employeeId === null) return reply.code(404).send(NOT_FOUND);
      const body = workStateInput.safeParse(req.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_body", details: safeIssues(body.error) });
      if (!(await employeeExists(employeeId))) return reply.code(404).send(NOT_FOUND);
      const answersLocality = WORK_LOCALITY_STATES.includes(body.data.stateCode);

      const open = await db
        .select()
        .from(employeeWorkStates)
        .where(
          and(
            eq(employeeWorkStates.employeeId, employeeId),
            isNull(employeeWorkStates.effectiveTo),
          ),
        )
        .orderBy(desc(employeeWorkStates.effectiveFrom))
        .limit(1);
      const previous = open[0];
      if (previous && body.data.effectiveFrom <= previous.effectiveFrom) {
        return reply.code(409).send({
          error: "invalid_effective_from",
          message: `effectiveFrom must be after the current open window's start (${previous.effectiveFrom})`,
        });
      }

      const inserted = await db.transaction(async (tx) => {
        if (previous) {
          await tx
            .update(employeeWorkStates)
            .set({ effectiveTo: body.data.effectiveFrom })
            .where(eq(employeeWorkStates.id, previous.id));
        }
        const rows = await tx
          .insert(employeeWorkStates)
          .values({
            employeeId,
            stateCode: body.data.stateCode,
            effectiveFrom: body.data.effectiveFrom,
            ...(answersLocality
              ? {
                  localityCode: body.data.localityCode ?? null,
                  localityConfirmedAt: new Date(),
                  localityConfirmedBy: req.authUser?.id ?? null,
                }
              : {}),
          })
          .returning();
        // PAY-163: the audit row commits (or rolls back) with the change.
        await tx.insert(auditEvents).values({
          actorId: req.authUser?.id ?? "unknown",
          action: "employee_work_state.assign",
          entity: "employee",
          entityId: String(employeeId),
          before: previous ?? null,
          after: rows[0],
        });
        return rows;
      });
      return reply.code(201).send({ workState: inserted[0] });
    },
  );

  // -------------------------------------------------------- state elections

  app.get(
    "/api/admin/employees/:employeeId/state-elections",
    { preHandler: admin },
    async (req, reply) => {
      const employeeId = Number((req.params as { employeeId: string }).employeeId);
      if (!(await employeeExists(employeeId))) return reply.code(404).send({ error: "not_found" });
      const q = z.object({ state: stateCodeSchema.optional() }).parse(req.query);
      const conditions: SQL[] = [eq(stateWithholdingElections.employeeId, employeeId)];
      if (q.state) conditions.push(eq(stateWithholdingElections.stateCode, q.state));
      const rows = await db
        .select()
        .from(stateWithholdingElections)
        .where(and(...conditions))
        .orderBy(desc(stateWithholdingElections.effectiveFrom));
      return { elections: rows };
    },
  );

  app.post(
    "/api/admin/employees/:employeeId/state-elections",
    { preHandler: admin },
    async (req, reply) => {
      const employeeId = Number((req.params as { employeeId: string }).employeeId);
      const body = z
        .object({
          stateCode: stateCodeSchema,
          filingStatus: filingStatusSchema.default("single"),
          allowances: z.number().int().min(0).max(99).default(0),
          additionalAllowances: z.number().int().min(0).max(99).default(0),
          extraWithholding: z.number().min(0).default(0),
          exempt: z.boolean().default(false),
          effectiveFrom: dateSchema,
          filedDate: dateSchema,
          note: z.string().max(500).optional(),
        })
        .safeParse(req.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
      if (!(await employeeExists(employeeId))) return reply.code(404).send({ error: "not_found" });

      // Exempt elections cannot claim allowances or extra withholding — the
      // form's exempt claim supersedes the worksheet (IL-W-4 line 5 / DE 4).
      if (body.data.exempt && (body.data.allowances > 0 || body.data.extraWithholding > 0)) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "an exempt election cannot also claim allowances or extra withholding",
        });
      }

      const inserted = await db
        .insert(stateWithholdingElections)
        .values({
          employeeId,
          stateCode: body.data.stateCode,
          filingStatus: body.data.filingStatus,
          allowances: body.data.allowances,
          additionalAllowances: body.data.additionalAllowances,
          extraWithholding: String(body.data.extraWithholding),
          exempt: body.data.exempt,
          effectiveFrom: body.data.effectiveFrom,
          filedDate: body.data.filedDate,
          note: body.data.note ?? "",
        })
        .returning();

      await audit(
        req.authUser!.id,
        "state_election.create",
        "employee",
        String(employeeId),
        null,
        inserted[0],
      );
      return reply.code(201).send({ election: inserted[0] });
    },
  );
}

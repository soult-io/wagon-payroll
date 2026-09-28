/**
 * Spec 24 (PAY-116) §7 "State IDs" — the employer's state tax account
 * numbers (W-2 box 15). Admin only; write-only values.
 *
 * - GET    /api/admin/company/state-ids — entered rows (masked), the IL/NY
 *   EIN defaults (masked) and the states that still need a number.
 * - PUT    /api/admin/company/state-ids/:stateCode — body
 *   `{ stateId, fromTaxYear? = 2026 }`; upsert, 200 with the masked row.
 * - DELETE /api/admin/company/state-ids/:stateCode/:fromTaxYear — 204; no
 *   such row → 404 NOT_FOUND and no audit row.
 *
 * Params and body are parsed before any query (M1); a failure is 400 with
 * `safeIssues` only, never the submitted value. PUT and DELETE are refused
 * with 409 state_id_year_filed when they would change the ID of a filed
 * W-2/W-3 year (company/state-ids.ts). Plaintext never leaves the server.
 */

import type { FastifyInstance } from "fastify";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { company, companyStateIds, employees, payrollEntries, payrollRuns } from "@payroll/db";
import {
  EIN_DEFAULT_STATES,
  normalizeStateId,
  STATE_ID_MIN_YEAR,
  stateIdDeleteParams,
  stateIdPutBody,
  stateIdPutParams,
} from "@payroll/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import type { Guards } from "../plugins/guards.js";
import {
  deleteStateId,
  maskEinDefault,
  maskStateId,
  stateIdSourceFor,
  writeStateId,
} from "../company/state-ids.js";
import { actorOf, NOT_FOUND, safeIssues } from "./params.js";

interface Deps {
  db: Db;
  config: AppConfig;
  guards: Guards;
}

/** Code-point order (localeCompare is banned in this repo). */
function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function registerAdminStateIdRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, config, guards } = deps;
  const admin = guards.requireRole("admin");
  const key = config.encryptionKey;

  async function theCompany() {
    const rows = await db.select({ id: company.id, ein: company.ein }).from(company).limit(1);
    return rows[0] ?? null;
  }

  /**
   * States on a 2026+ W-2 without a box 15 ID: issued runs of W-2 employees,
   * grouped by the frozen work state and pay-date year, dropping a state
   * whose runs are all `kind = 'none'`. Runs without a work state are not
   * attributable here (Spec 24 R7).
   */
  async function statesWithWages() {
    const workState = sql<string>`${payrollRuns.runSnapshot} #>> '{inputs,state,workState}'`;
    const taxYear = sql<number>`extract(year FROM ${payrollRuns.payDate})::int`;
    return db
      .select({
        stateCode: workState,
        taxYear,
        withheld: sql<boolean>`coalesce(sum(${payrollEntries.amount}), 0) > 0`,
      })
      .from(payrollRuns)
      .innerJoin(
        employees,
        and(eq(employees.id, payrollRuns.employeeId), eq(employees.employmentType, "w2")),
      )
      .leftJoin(
        payrollEntries,
        and(
          eq(payrollEntries.runId, payrollRuns.id),
          eq(payrollEntries.category, "state_withholding"),
        ),
      )
      .where(
        and(
          eq(payrollRuns.status, "issued"),
          gte(payrollRuns.payDate, `${STATE_ID_MIN_YEAR}-01-01`),
          sql`${workState} IS NOT NULL`,
        ),
      )
      .groupBy(workState, taxYear)
      .having(
        sql`NOT bool_and(coalesce(${payrollRuns.runSnapshot} #>> '{inputs,state,kind}', '') = 'none')`,
      );
  }

  app.get("/api/admin/company/state-ids", { preHandler: admin }, async (_req, reply) => {
    const owner = await theCompany();
    if (!owner) return reply.code(404).send({ error: "no_company" });

    const rows = await db
      .select()
      .from(companyStateIds)
      .where(eq(companyStateIds.companyId, owner.id))
      .orderBy(asc(companyStateIds.stateCode), asc(companyStateIds.fromTaxYear));
    const yearsByState = new Map<string, number[]>();
    for (const r of rows) {
      yearsByState.set(r.stateCode, [...(yearsByState.get(r.stateCode) ?? []), r.fromTaxYear]);
    }
    const ein = owner.ein || null;

    const stateIds = rows.map((r) => ({
      stateCode: r.stateCode,
      fromTaxYear: r.fromTaxYear,
      idMasked: maskStateId(r.stateId, key),
      source: "entered" as const,
    }));

    // Listed while some year from 2026 on still uses the EIN (no row from 2026).
    const defaults = ein
      ? EIN_DEFAULT_STATES.filter(
          (s) =>
            stateIdSourceFor(s, STATE_ID_MIN_YEAR, yearsByState.get(s) ?? [], true) ===
            "ein_default",
        ).map((stateCode) => ({
          stateCode,
          idMasked: maskEinDefault(ein, key),
          source: "ein_default" as const,
        }))
      : [];

    const needed = (await statesWithWages())
      .filter(
        (w) =>
          stateIdSourceFor(
            w.stateCode,
            w.taxYear,
            yearsByState.get(w.stateCode) ?? [],
            ein !== null,
          ) === null,
      )
      .map((w) => ({
        stateCode: w.stateCode,
        taxYear: Number(w.taxYear),
        reason: w.withheld ? ("tax_withheld" as const) : ("wages_only" as const),
      }))
      .sort((a, b) => byCode(a.stateCode, b.stateCode) || a.taxYear - b.taxYear);

    return { stateIds, defaults, needed };
  });

  app.put("/api/admin/company/state-ids/:stateCode", { preHandler: admin }, async (req, reply) => {
    const params = stateIdPutParams.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid_params", details: safeIssues(params.error) });
    }
    const body = stateIdPutBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", details: safeIssues(body.error) });
    }
    const { stateCode } = params.data;
    const normalized = normalizeStateId(stateCode, body.data.stateId);
    if (!normalized.ok) {
      return reply.code(400).send({
        error: "invalid_body",
        details: [{ path: ["stateId"], code: "custom", message: normalized.message }],
      });
    }

    const owner = await theCompany();
    if (!owner) return reply.code(404).send({ error: "no_company" });
    const target = { companyId: owner.id, stateCode, fromTaxYear: body.data.fromTaxYear };
    const result = await writeStateId(db, key, target, normalized.value, actorOf(req));
    if (result.status === 409) return reply.code(409).send({ error: result.error });
    if (result.status !== 200) throw new Error("unexpected state ID write result");
    return {
      stateId: {
        stateCode,
        fromTaxYear: target.fromTaxYear,
        idMasked: result.idMasked,
        source: "entered" as const,
      },
    };
  });

  app.delete(
    "/api/admin/company/state-ids/:stateCode/:fromTaxYear",
    { preHandler: admin },
    async (req, reply) => {
      const params = stateIdDeleteParams.safeParse(req.params);
      if (!params.success) {
        return reply.code(400).send({ error: "invalid_params", details: safeIssues(params.error) });
      }
      const owner = await theCompany();
      if (!owner) return reply.code(404).send(NOT_FOUND);
      const result = await deleteStateId(
        db,
        key,
        { companyId: owner.id, ...params.data },
        actorOf(req),
      );
      if (result.status === 409) return reply.code(409).send({ error: result.error });
      if (result.status === 404) return reply.code(404).send(NOT_FOUND);
      return reply.code(204).send();
    },
  );
}

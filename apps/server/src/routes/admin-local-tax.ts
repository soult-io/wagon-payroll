/**
 * Spec 25 (PAY-120), PAY-163 (step G1) — capture where each employee lives
 * and works for local income tax, and report what the local-tax guard would
 * say. Nothing here blocks a pay run: enforcement is step G2.
 *
 * - GET/PUT /api/admin/employees/:employeeId/residence — effective-dated
 *   residence (country, state, NYC / Yonkers / Maryland county). The GET's
 *   address hint decrypts the home address server-side and returns only its
 *   2-letter US state (or null); street, city and ZIP never leave.
 * - PUT /api/admin/employees/:employeeId/residence with the open row's start
 *   date corrects that row (audit employee_residence.correct);
 *   `sameAsBefore` re-confirms it from today (audit employee_residence.confirm).
 * - PUT /api/admin/employees/:employeeId/work-state/locality — answer the
 *   work-locality question on the work-state row in force on `effectiveOn`
 *   (default today); a row that ended before today is refused
 *   (work_state_ended). Rows written before PAY-163 are unconfirmed.
 * - Writes live in payroll/local-tax-writes.ts: each reads its row inside
 *   the transaction (FOR UPDATE) and audits from that read.
 * - GET /api/admin/local-tax/check?payDate= — per active W-2 employee: ok or
 *   the reason codes a pay run would be held for, the place code behind a
 *   hold and the work state code. `enforced` is false in G1.
 *
 * Audit events carry codes and dates only. Error bodies carry codes only.
 */

import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { employeeResidences, employees } from "@payroll/db";
import {
  type AddressPayload,
  isoDate,
  normalizeUsState,
  residenceInput,
  workLocalityInput,
} from "@payroll/shared";
import type { AppConfig } from "../config.js";
import { decryptAddress } from "../crypto/address-encryption.js";
import type { Db } from "../db.js";
import { todayIso } from "../filings/shared.js";
import { checkLocalTaxSupport, holdPlace } from "../payroll/local-guard.js";
import {
  loadLocalConfigYears,
  loadLocalCoverage,
  localGuardInputFor,
} from "../payroll/local-guard-inputs.js";
import { answerWorkLocality, writeResidence } from "../payroll/local-tax-writes.js";
import type { ResidenceRow } from "../payroll/resolve.js";
import type { Guards } from "../plugins/guards.js";
import { actorOf, NOT_FOUND, parseEmployeeId, safeIssues } from "./params.js";

interface AdminLocalTaxDeps {
  db: Db;
  config: AppConfig;
  guards: Guards;
}

/** API view of a residence row (no created_by). */
function residenceView(row: ResidenceRow) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    country: row.country,
    stateCode: row.stateCode,
    localityCode: row.localityCode,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    source: row.source,
    createdAt: row.createdAt,
  };
}

/** Country + normalized US state of the home address; never street, city or ZIP. */
function addressHint(
  address: AddressPayload | null,
): { country: string; state: string | null } | null {
  if (!address || typeof address.country !== "string") return null;
  const country = address.country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return null;
  const state =
    country === "US" && typeof address.state === "string" ? normalizeUsState(address.state) : null;
  return { country, state };
}

function effectiveOn(row: ResidenceRow, day: string): boolean {
  return row.effectiveFrom <= day && (row.effectiveTo === null || row.effectiveTo > day);
}

export function registerAdminLocalTaxRoutes(app: FastifyInstance, deps: AdminLocalTaxDeps): void {
  const { db, config, guards } = deps;
  const admin = guards.requireRole("admin");

  async function findEmployee(employeeId: number) {
    const rows = await db
      .select({ id: employees.id, address: employees.address })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);
    return rows[0] ?? null;
  }

  // ------------------------------------------------------------- residence

  app.get(
    "/api/admin/employees/:employeeId/residence",
    { preHandler: admin },
    async (req, reply) => {
      const employeeId = parseEmployeeId(req.params);
      const employee = employeeId === null ? null : await findEmployee(employeeId);
      if (!employee) return reply.code(404).send(NOT_FOUND);

      const rows = await db
        .select()
        .from(employeeResidences)
        .where(eq(employeeResidences.employeeId, employee.id))
        .orderBy(desc(employeeResidences.effectiveFrom));
      const today = todayIso();
      const current = rows.find((r) => effectiveOn(r, today)) ?? null;

      let address: AddressPayload | null = null;
      try {
        address = decryptAddress(employee.address, config.encryptionKey);
      } catch {
        address = null; // unreadable ciphertext: no hint, never an error body
      }
      return {
        current: current ? residenceView(current) : null,
        history: rows.map(residenceView),
        addressHint: addressHint(address),
      };
    },
  );

  app.put(
    "/api/admin/employees/:employeeId/residence",
    { preHandler: admin },
    async (req, reply) => {
      const employeeId = parseEmployeeId(req.params);
      if (employeeId === null) return reply.code(404).send(NOT_FOUND);
      const body = residenceInput.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: "invalid_body", details: safeIssues(body.error) });
      }
      if (!(await findEmployee(employeeId))) return reply.code(404).send(NOT_FOUND);
      const result = await writeResidence(db, employeeId, body.data, actorOf(req), todayIso());
      if (result.status === 409) return reply.code(409).send({ error: result.error });
      return reply.code(result.status).send({ residence: residenceView(result.row) });
    },
  );

  // --------------------------------------------------- work-state locality

  app.put(
    "/api/admin/employees/:employeeId/work-state/locality",
    { preHandler: admin },
    async (req, reply) => {
      const employeeId = parseEmployeeId(req.params);
      if (employeeId === null) return reply.code(404).send(NOT_FOUND);
      const body = workLocalityInput.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: "invalid_body", details: safeIssues(body.error) });
      }
      if (!(await findEmployee(employeeId))) return reply.code(404).send(NOT_FOUND);

      // The row in force on the given day (default today) — not only the open
      // row: a future-dated row can close the row that applies today.
      const today = todayIso();
      const result = await answerWorkLocality(
        db,
        employeeId,
        { localityCode: body.data.localityCode, effectiveOn: body.data.effectiveOn ?? today },
        actorOf(req),
        today,
      );
      if (result.status === 409) return reply.code(409).send({ error: result.error });
      if (result.status === 400) {
        return reply.code(400).send({
          error: "invalid_body",
          details: [{ path: ["localityCode"], code: "custom", message: result.problem }],
        });
      }
      return { workState: result.row };
    },
  );

  // ------------------------------------------------------ read-only check

  app.get("/api/admin/local-tax/check", { preHandler: admin }, async (req, reply) => {
    const query = z.object({ payDate: isoDate.optional() }).safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({ error: "invalid_query", details: safeIssues(query.error) });
    }
    const payDate = query.data.payDate ?? todayIso();

    const people = await db
      .select({
        id: employees.id,
        legalName: employees.legalName,
        employmentType: employees.employmentType,
      })
      .from(employees)
      .where(and(eq(employees.status, "active"), eq(employees.employmentType, "w2")))
      .orderBy(asc(employees.legalName), asc(employees.id));
    const shared = {
      coverage: await loadLocalCoverage(db),
      localConfigYears: loadLocalConfigYears(),
    };

    const results = [];
    for (const person of people) {
      const input = await localGuardInputFor(
        db,
        person,
        { payDate, workStateAsOf: payDate },
        shared,
      );
      const result = checkLocalTaxSupport(input);
      results.push({
        employeeId: person.id,
        name: person.legalName,
        status: result.ok ? ("ok" as const) : ("blocked" as const),
        reasons: result.ok ? [] : result.reasons,
        // State or locality code behind a hold about a place (for the message).
        place: holdPlace(input),
        // Work state in force (code only): lets the admin tell "add a work
        // state" apart from "works in another state".
        workState: input.workState?.stateCode ?? null,
      });
    }
    return { enforced: false, payDate, employees: results };
  });
}

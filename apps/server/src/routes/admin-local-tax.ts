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
 *   (default today). Rows written before PAY-163 are unconfirmed.
 * - GET /api/admin/local-tax/check?payDate= — per active W-2 employee: ok or
 *   the reason codes a pay run would be held for, the place code behind a
 *   hold and the work state code. `enforced` is false in G1.
 *
 * Audit events carry codes and dates only. Error bodies carry codes only.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { auditEvents, employeeResidences, employeeWorkStates, employees } from "@payroll/db";
import {
  type AddressPayload,
  isoDate,
  normalizeUsState,
  type ResidenceInput,
  residenceInput,
  workLocalityInput,
  workLocalityProblem,
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
import { type ResidenceRow, resolveWorkState } from "../payroll/resolve.js";
import type { Guards } from "../plugins/guards.js";
import { NOT_FOUND, parseEmployeeId, safeIssues } from "./params.js";

interface AdminLocalTaxDeps {
  db: Db;
  config: AppConfig;
  guards: Guards;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type WorkStateRow = typeof employeeWorkStates.$inferSelect;

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

/** Audit payload for a residence: codes and dates only. */
function residenceAudit(row: ResidenceRow) {
  return {
    country: row.country,
    stateCode: row.stateCode,
    localityCode: row.localityCode,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    source: row.source,
  };
}

/** Audit payload for a work-state locality: codes and dates only. */
function workLocalityAudit(row: WorkStateRow) {
  return {
    stateCode: row.stateCode,
    localityCode: row.localityCode,
    localityConfirmed: row.localityConfirmedAt !== null,
    effectiveFrom: row.effectiveFrom,
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

/**
 * Why a residence cannot be written against the open row, or null. "Still
 * the same" must repeat the open row's place; a new row must not start before
 * the open row (the same start date corrects the open row instead).
 */
function residenceConflict(
  previous: ResidenceRow | undefined,
  input: ResidenceInput,
): "not_same_as_before" | "invalid_effective_from" | null {
  if (input.sameAsBefore) {
    const same =
      previous !== undefined &&
      previous.country === input.country &&
      previous.stateCode === input.stateCode &&
      previous.localityCode === input.localityCode;
    if (!same) return "not_same_as_before";
  }
  if (!previous) return null;
  if (input.effectiveFrom < previous.effectiveFrom) return "invalid_effective_from";
  // Confirming "still the same" on the day the open row starts has nothing to confirm.
  if (input.sameAsBefore && input.effectiveFrom === previous.effectiveFrom) {
    return "invalid_effective_from";
  }
  return null;
}

/** The admin behind a request (requireRole guarantees a session). */
function actorOf(req: FastifyRequest): string {
  const user = req.authUser;
  if (!user) throw new Error("admin route reached without a session");
  return user.id;
}

/** The single row an INSERT/UPDATE … RETURNING must produce. */
function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error("expected one row");
  return row;
}

/** Postgres unique / exclusion violations → the caller's 409. */
function isWindowConflict(err: unknown): boolean {
  const code =
    (err as { code?: string; cause?: { code?: string } })?.cause?.code ??
    (err as { code?: string })?.code;
  return code === "23505" || code === "23P01";
}

export function registerAdminLocalTaxRoutes(app: FastifyInstance, deps: AdminLocalTaxDeps): void {
  const { db, config, guards } = deps;
  const admin = guards.requireRole("admin");

  async function audit(
    tx: Tx | Db,
    actorId: string,
    action: string,
    employeeId: number,
    before: unknown,
    after: unknown,
  ) {
    await tx.insert(auditEvents).values({
      actorId,
      action,
      entity: "employee",
      entityId: String(employeeId),
      before,
      after,
    });
  }

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
      const input = body.data;

      const open = await db
        .select()
        .from(employeeResidences)
        .where(
          and(
            eq(employeeResidences.employeeId, employeeId),
            isNull(employeeResidences.effectiveTo),
          ),
        )
        .orderBy(desc(employeeResidences.effectiveFrom))
        .limit(1);
      const previous = open[0];
      // "Still the same" is always a confirmation from today (server clock).
      const request = input.sameAsBefore ? { ...input, effectiveFrom: todayIso() } : input;
      const conflict = residenceConflict(previous, request);
      if (conflict) return reply.code(409).send({ error: conflict });

      const actorId = actorOf(req);
      try {
        if (previous && previous.effectiveFrom === request.effectiveFrom) {
          const corrected = await correctResidence(previous, request, actorId);
          return reply.code(200).send({ residence: residenceView(corrected) });
        }
        const inserted = await addResidence(employeeId, previous, request, actorId);
        return reply.code(201).send({ residence: residenceView(inserted) });
      } catch (err) {
        if (isWindowConflict(err)) return reply.code(409).send({ error: "invalid_effective_from" });
        throw err;
      }
    },
  );

  /** New residence from `request.effectiveFrom`; closes the open row there. */
  async function addResidence(
    employeeId: number,
    previous: ResidenceRow | undefined,
    request: ResidenceInput,
    actorId: string,
  ): Promise<ResidenceRow> {
    return db.transaction(async (tx) => {
      if (previous) {
        await tx
          .update(employeeResidences)
          .set({ effectiveTo: request.effectiveFrom })
          .where(eq(employeeResidences.id, previous.id));
      }
      const rows = await tx
        .insert(employeeResidences)
        .values({
          employeeId,
          country: request.country,
          stateCode: request.stateCode,
          localityCode: request.localityCode,
          effectiveFrom: request.effectiveFrom,
          source: "admin",
          createdBy: actorId,
        })
        .returning();
      const row = one(rows);
      await audit(
        tx,
        actorId,
        request.sameAsBefore ? "employee_residence.confirm" : "employee_residence.assign",
        employeeId,
        previous ? residenceAudit(previous) : null,
        residenceAudit(row),
      );
      return row;
    });
  }

  /** Same start date as the open row: fix that row's place in place (a data-entry correction). */
  async function correctResidence(
    previous: ResidenceRow,
    request: ResidenceInput,
    actorId: string,
  ): Promise<ResidenceRow> {
    return db.transaction(async (tx) => {
      const rows = await tx
        .update(employeeResidences)
        .set({
          country: request.country,
          stateCode: request.stateCode,
          localityCode: request.localityCode,
          source: "admin",
        })
        .where(eq(employeeResidences.id, previous.id))
        .returning();
      const row = one(rows);
      await audit(
        tx,
        actorId,
        "employee_residence.correct",
        previous.employeeId,
        residenceAudit(previous),
        residenceAudit(row),
      );
      return row;
    });
  }

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
      const row = await resolveWorkState(db, employeeId, body.data.effectiveOn ?? todayIso());
      if (!row) return reply.code(409).send({ error: "no_open_work_state" });
      const problem = workLocalityProblem(row.stateCode, body.data.localityCode);
      if (problem) {
        return reply.code(400).send({
          error: "invalid_body",
          details: [{ path: ["localityCode"], code: "custom", message: problem }],
        });
      }

      const actorId = actorOf(req);
      const updated = await db.transaction(async (tx) => {
        const rows = await tx
          .update(employeeWorkStates)
          .set({
            localityCode: body.data.localityCode,
            localityConfirmedAt: new Date(),
            localityConfirmedBy: actorId,
          })
          .where(eq(employeeWorkStates.id, row.id))
          .returning();
        const after = one(rows);
        await audit(
          tx,
          actorId,
          "employee_work_state.locality",
          employeeId,
          workLocalityAudit(row),
          workLocalityAudit(after),
        );
        return after;
      });
      return { workState: updated };
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

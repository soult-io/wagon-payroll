/**
 * Change-request routes (spec 4 API). External id is the non-enumerable
 * publicId; cross-tenant access gets 404. Payload validation uses the shared
 * Zod schemas (same as the web form — they can never drift).
 *
 * Bank details: encrypted at rest in the payload column (spec "Sensitive-data
 * handling"), masked (••••1234) in every API response.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, desc, eq, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  authUser,
  auditEvents,
  changeRequestComments,
  changeRequests,
  employees,
} from "@payroll/db";
import { changeRequestPayloads, changeRequestType, isoDate } from "@payroll/shared";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import type { Guards } from "../plugins/guards.js";
import {
  addComment,
  approveRequest,
  ChangeRequestError,
  denyRequest,
  employeeForUser,
  submitRequest,
  withdrawRequest,
  type ChangeRequestRow,
} from "../change-requests/service.js";
import { decryptField, maskLast4 } from "../crypto/field-encryption.js";
import { decryptAddress } from "../crypto/address-encryption.js";

interface Deps {
  db: Db;
  config: AppConfig;
  guards: Guards;
}

/**
 * Never leak sensitive payloads: bank routing + account and the tax_id TIN
 * are masked (••••1234) in every API response — never ciphertext, never clear.
 */
function maskPayload(requestType: string, payload: unknown, key: string): unknown {
  // PAY-21: address payloads are ciphertext strings at rest; authorized
  // viewers (admin, or the owning employee) get the decrypted object —
  // the same visible shape as before encryption landed.
  if (requestType === "address" || requestType === "mailing_address") {
    return decryptAddress(payload, key);
  }
  if (!payload || typeof payload !== "object") return payload;
  if (requestType === "bank_details") {
    const bank = payload as Record<string, unknown>;
    return {
      ...bank,
      routing: typeof bank.routing === "string" ? maskLast4(bank.routing, key) : null,
      account: typeof bank.account === "string" ? maskLast4(bank.account, key) : null,
    };
  }
  if (requestType === "tax_id") {
    const tin = payload as Record<string, unknown>;
    return { taxId: typeof tin.taxId === "string" ? maskLast4(tin.taxId, key) : null };
  }
  return payload;
}

function requestView(row: ChangeRequestRow, key: string, employeeName?: string) {
  return {
    publicId: row.publicId,
    employeeId: row.employeeId,
    ...(employeeName !== undefined ? { employeeName } : {}),
    requestType: row.requestType,
    payload: maskPayload(row.requestType, row.payload, key),
    effectiveFrom: row.effectiveFrom,
    status: row.status,
    submittedAt: row.submittedAt,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    appliedAt: row.appliedAt,
  };
}

function errorStatus(err: ChangeRequestError): number {
  switch (err.code) {
    case "not_found":
    case "forbidden": // cross-tenant: 404, no enumeration
      return 404;
    case "duplicate_pending":
    case "not_pending":
    case "effective_date":
      return 409;
    case "reason_required":
    case "invalid_w4_effective_date":
      return 400;
  }
}

function serviceError(err: unknown, reply: FastifyReply): unknown {
  if (err instanceof ChangeRequestError) {
    return reply
      .code(errorStatus(err))
      .send({ ...err.details, error: err.code, message: err.message });
  }
  throw err;
}

export function registerChangeRequestRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, config, guards } = deps;
  const admin = guards.requireRole("admin");

  /** Participant-or-admin check. Returns the employee row when participant. */
  async function canAccess(req: FastifyRequest, request: ChangeRequestRow): Promise<boolean> {
    if (req.authUser?.role === "admin") return true;
    const employee = await employeeForUser(db, req.authUser!.id);
    return employee?.id === request.employeeId;
  }

  async function byPublicId(publicId: string): Promise<ChangeRequestRow | null> {
    const rows = await db
      .select()
      .from(changeRequests)
      .where(eq(changeRequests.publicId, publicId))
      .limit(1);
    return rows[0] ?? null;
  }

  // Employee: submit. An admin without an employees row cannot submit.
  app.post("/api/change-requests", { preHandler: guards.requireAuth }, async (req, reply) => {
    const body = z
      .object({
        requestType: changeRequestType,
        payload: z.record(z.string(), z.unknown()),
        effectiveFrom: isoDate,
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });

    const employee = await employeeForUser(db, req.authUser!.id);
    if (!employee) return reply.code(403).send({ error: "no_employee_record" });

    const { requestType, effectiveFrom } = body.data;
    const parsed = changeRequestPayloads[requestType].safeParse(body.data.payload);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", details: parsed.error.issues });
    }
    // Top-level effective_from is authoritative (W-4 / state-election payloads carry one too).
    const payload =
      requestType === "w4" || requestType === "state_election"
        ? { ...parsed.data, effectiveFrom }
        : (parsed.data as Record<string, unknown>);

    try {
      const row = await submitRequest(
        { db, config },
        {
          employeeId: employee.id,
          employeeName: employee.legalName,
          requestType,
          payload,
          effectiveFrom,
        },
      );
      return reply.code(201).send({ request: requestView(row, config.encryptionKey) });
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  // Employee: own requests; admin: all (+ status/requestType filters).
  app.get("/api/change-requests", { preHandler: guards.requireAuth }, async (req) => {
    const q = z
      .object({
        status: z.enum(["pending", "approved", "denied", "withdrawn"]).optional(),
        requestType: changeRequestType.optional(),
      })
      .parse(req.query);

    const conditions: SQL[] = [];
    if (q.status) conditions.push(eq(changeRequests.status, q.status));
    if (q.requestType) conditions.push(eq(changeRequests.requestType, q.requestType));

    if (req.authUser?.role === "admin") {
      const rows = await db
        .select({ request: changeRequests, employeeName: employees.legalName })
        .from(changeRequests)
        .innerJoin(employees, eq(employees.id, changeRequests.employeeId))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(changeRequests.submittedAt));
      return {
        requests: rows.map((r) => requestView(r.request, config.encryptionKey, r.employeeName)),
      };
    }

    const employee = await employeeForUser(db, req.authUser!.id);
    if (!employee) return { requests: [] };
    const rows = await db
      .select()
      .from(changeRequests)
      .where(
        and(
          eq(changeRequests.employeeId, employee.id),
          ...(conditions.length ? [and(...conditions)!] : []),
        ),
      )
      .orderBy(desc(changeRequests.submittedAt));
    return { requests: rows.map((r) => requestView(r, config.encryptionKey)) };
  });

  // Participant or admin: detail + full comment thread.
  app.get(
    "/api/change-requests/:publicId",
    { preHandler: guards.requireAuth },
    async (req, reply) => {
      const { publicId } = req.params as { publicId: string };
      const request = await byPublicId(publicId);
      if (!request || !(await canAccess(req, request))) {
        return reply.code(404).send({ error: "not_found" });
      }
      const comments = await db
        .select({
          id: changeRequestComments.id,
          authorId: changeRequestComments.authorId,
          authorName: authUser.name,
          body: changeRequestComments.body,
          createdAt: changeRequestComments.createdAt,
        })
        .from(changeRequestComments)
        .innerJoin(authUser, eq(authUser.id, changeRequestComments.authorId))
        .where(eq(changeRequestComments.requestId, request.id))
        .orderBy(asc(changeRequestComments.id));
      return { request: requestView(request, config.encryptionKey), comments };
    },
  );

  // Participant or admin: append to the thread (open until decided; spec
  // allows comments "any state until decided" — we allow them after too, the
  // thread is the permanent record).
  app.post(
    "/api/change-requests/:publicId/comments",
    { preHandler: guards.requireAuth },
    async (req, reply) => {
      const { publicId } = req.params as { publicId: string };
      const body = z.object({ body: z.string().trim().min(1).max(4000) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      const request = await byPublicId(publicId);
      if (!request || !(await canAccess(req, request))) {
        return reply.code(404).send({ error: "not_found" });
      }
      await addComment(
        { db, config },
        { requestId: request.id, authorId: req.authUser!.id, body: body.data.body },
      );
      return reply.code(201).send({ ok: true });
    },
  );

  // Admin: reveal-on-demand for a tax_id request (spec 11 D21). The ONLY
  // endpoint that ever returns the clear TIN — deliberate, admin-gated, and
  // audit-logged (the audit row records the reveal, never the value).
  app.get(
    "/api/change-requests/:publicId/reveal-tax-id",
    { preHandler: admin },
    async (req, reply) => {
      const { publicId } = req.params as { publicId: string };
      const request = await byPublicId(publicId);
      if (!request) return reply.code(404).send({ error: "not_found" });
      if (request.requestType !== "tax_id") {
        return reply.code(409).send({ error: "not_tax_id", message: "not a tax_id request" });
      }
      const payload = request.payload as { taxId?: unknown };
      if (typeof payload.taxId !== "string") {
        return reply.code(409).send({ error: "no_tax_id", message: "payload carries no TIN" });
      }
      await db.insert(auditEvents).values({
        actorId: req.authUser!.id,
        action: "change_request.reveal_tax_id",
        entity: "change_request",
        entityId: request.publicId,
        before: null,
        after: { revealed: true },
      });
      return { taxId: decryptField(payload.taxId, config.encryptionKey) };
    },
  );

  // Admin: approve + apply in one transaction. Optional note (thread) and
  // effective-date override (audited).
  app.post("/api/change-requests/:publicId/approve", { preHandler: admin }, async (req, reply) => {
    const { publicId } = req.params as { publicId: string };
    const body = z
      .object({ note: z.string().max(4000).optional(), effectiveFromOverride: isoDate.optional() })
      .safeParse(req.body ?? {});
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
    try {
      const row = await approveRequest(
        { db, config },
        {
          publicId,
          adminId: req.authUser!.id,
          ...(body.data.note !== undefined ? { note: body.data.note } : {}),
          ...(body.data.effectiveFromOverride !== undefined
            ? { effectiveFromOverride: body.data.effectiveFromOverride }
            : {}),
        },
      );
      return { request: requestView(row, config.encryptionKey) };
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  // Admin: deny — reason REQUIRED (lands in the thread).
  app.post("/api/change-requests/:publicId/deny", { preHandler: admin }, async (req, reply) => {
    const { publicId } = req.params as { publicId: string };
    const body = z.object({ reason: z.string().trim().min(1).max(4000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "reason_required" });
    try {
      const row = await denyRequest(
        { db, config },
        { publicId, adminId: req.authUser!.id, reason: body.data.reason },
      );
      return { request: requestView(row, config.encryptionKey) };
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  // Employee owner: withdraw, pre-decision only.
  app.post(
    "/api/change-requests/:publicId/withdraw",
    { preHandler: guards.requireAuth },
    async (req, reply) => {
      const { publicId } = req.params as { publicId: string };
      try {
        const row = await withdrawRequest({ db, config }, { publicId, userId: req.authUser!.id });
        return { request: requestView(row, config.encryptionKey) };
      } catch (err) {
        return serviceError(err, reply);
      }
    },
  );
}

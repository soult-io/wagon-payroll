/**
 * Admin employee-directory routes (frontend spec /admin/employees): list,
 * detail (with linked user), create, invite-or-resend (links the user to the
 * employee record), and disable/enable (employee status + auth ban stay in
 * sync). Every mutation writes audit_events.
 *
 * PAY-208: the detail carries the W-2 delivery state (w2Consent: none,
 * current, outdated, withdrawn — no disclosure text); an admin records a
 * written withdrawal ((j)(3)(v)(A), effective the day it is recorded, OD3)
 * and changes an employee's sign-in email (D-A: a fresh admin session,
 * masked audit, a notice to the old AND the new address).
 */

import type { FastifyInstance } from "fastify";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  auditEvents,
  authUser,
  changeRequests,
  company,
  emailOutbox,
  employees,
} from "@payroll/db";
import { EVENT_TYPE, signInEmailChanged } from "@payroll/notifications";
import { isoDate } from "@payroll/shared";
import type { Auth } from "../auth/auth.js";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import type { Guards } from "../plugins/guards.js";
import { inviteUser, resendInvite, UserServiceError } from "../auth/users.js";
import { AUTH_EVENT, requestContext, writeAuthEvent } from "../auth/audit.js";
import { toHeaders } from "../plugins/guards.js";
import { encryptField, maskLast4 } from "../crypto/field-encryption.js";
import { addressForStorage, decryptAddress, encryptAddress } from "../crypto/address-encryption.js";
import { PDF_RATE_LIMIT, refuseCrossSite } from "../plugins/fetch-site.js";
import { revokeOutstandingSetupTokens } from "../auth/tokens.js";
import { w2ConsentState, withdrawW2Consent } from "../filings/w2-consent.js";
import { FilingServiceError } from "../filings/shared.js";
import { templateContext } from "../notify/outbox.js";

/** The admin signed in within FRESH_SESSION_MS (Better Auth freshAge). */
function sessionIsFresh(createdAt: Date | string | undefined): boolean {
  if (createdAt === undefined) return false;
  return Date.now() - new Date(createdAt).getTime() <= FRESH_SESSION_MS;
}

/** Postgres unique_violation (23505), wherever the driver puts the code. */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; i += 1) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Better Auth session.freshAge (auth.ts): a sensitive action needs a sign-in this recent. */
export const FRESH_SESSION_MS = 60 * 60 * 1000;

/** "renamed@example.com" → "r***@example.com" (audit rows never hold a full address). */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

interface Deps {
  auth: Auth;
  db: Db;
  config: AppConfig;
  guards: Guards;
}

const addressSchema = z.object({
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  state: z.string().min(1).max(100),
  zip: z.string().min(1).max(20),
  country: z.string().min(2).max(2),
});

export function registerAdminEmployeeRoutes(app: FastifyInstance, deps: Deps): void {
  const { auth, db, config, guards } = deps;
  const admin = guards.requireRole("admin");

  async function audit(
    actorId: string,
    action: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ) {
    await db
      .insert(auditEvents)
      .values({ actorId, action, entity: "employee", entityId, before, after });
  }

  async function employeeWithUser(employeeId: number) {
    const rows = await db
      .select({
        employee: employees,
        userEmail: authUser.email,
        userBanned: authUser.banned,
        userBanReason: authUser.banReason,
      })
      .from(employees)
      .leftJoin(authUser, eq(authUser.id, employees.userId))
      .where(eq(employees.id, employeeId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const { employee, userEmail, userBanned, userBanReason } = row;
    // tax_id and bank_details never leave the server through the directory API.
    const { taxId: _taxId, bankDetails: _bankDetails, ...safeEmployee } = employee;
    return {
      ...safeEmployee,
      // PAY-21: addresses are ciphertext at rest; authorized admin reads get
      // the decrypted object (decryptAddress tolerates plaintext legacy rows).
      address: decryptAddress(employee.address, config.encryptionKey),
      mailingAddress: decryptAddress(employee.mailingAddress, config.encryptionKey),
      // Presence flag only (spec 11 D20a) — the masked value stays server-side.
      hasTaxId: Boolean(employee.taxId),
      // PAY-208 (S16): the W-2 delivery state — dates only, no terms text.
      w2Consent: await w2ConsentState(db, employee.id),
      user: employee.userId
        ? { id: employee.userId, email: userEmail, banned: userBanned, banReason: userBanReason }
        : null,
    };
  }

  app.get("/api/admin/employees", { preHandler: admin }, async () => {
    const rows = await db
      .select({
        id: employees.id,
        userId: employees.userId,
        legalName: employees.legalName,
        preferredName: employees.preferredName,
        employmentType: employees.employmentType,
        hireDate: employees.hireDate,
        terminationDate: employees.terminationDate,
        status: employees.status,
        userEmail: authUser.email,
        userBanned: authUser.banned,
      })
      .from(employees)
      .leftJoin(authUser, eq(authUser.id, employees.userId))
      .where(ne(employees.employmentType, "1099"))
      .orderBy(employees.legalName);
    return { employees: rows };
  });

  app.get("/api/admin/employees/:employeeId", { preHandler: admin }, async (req, reply) => {
    const employeeId = Number((req.params as { employeeId: string }).employeeId);
    const detail = await employeeWithUser(employeeId);
    if (!detail) return reply.code(404).send({ error: "not_found" });
    return { employee: detail };
  });

  app.post("/api/admin/employees", { preHandler: admin }, async (req, reply) => {
    const body = z
      .object({
        legalName: z.string().trim().min(1).max(200),
        preferredName: z.string().trim().max(200).optional(),
        employmentType: z.enum(["w2", "1099"]).default("w2"),
        hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        address: addressSchema.optional(),
        taxId: z
          .string()
          .regex(/^\d{9}$/, "tax id must be 9 digits")
          .optional(),
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });

    const companyRows = await db.select({ id: company.id }).from(company).limit(1);
    const companyRow = companyRows[0];
    if (!companyRow)
      return reply
        .code(409)
        .send({ error: "no_company", message: "company row missing — run seeds" });

    const inserted = await db
      .insert(employees)
      .values({
        companyId: companyRow.id,
        legalName: body.data.legalName,
        preferredName: body.data.preferredName ?? null,
        employmentType: body.data.employmentType,
        hireDate: body.data.hireDate,
        address: body.data.address ? encryptAddress(body.data.address, config.encryptionKey) : null,
        // SSN is encrypted at rest the moment it enters the system.
        taxId: body.data.taxId ? encryptField(body.data.taxId, config.encryptionKey) : null,
      })
      .returning();
    const row = inserted[0]!;
    await audit(req.authUser!.id, "employee.create", String(row.id), null, {
      legalName: row.legalName,
      employmentType: row.employmentType,
      hireDate: row.hireDate,
    });
    return reply.code(201).send({ employee: await employeeWithUser(row.id) });
  });

  /**
   * Spec 11 (D20a): admin direct-set of the employee TIN for backfill/
   * corrections. Same validation + encryption as the create path; write-only
   * (the directory API never returns the value, masked or otherwise) and the
   * audit event carries masked before/after only.
   *
   * PAY-20: the same endpoint also accepts `mailingAddress` (+ optional
   * `effectiveFrom`, default today). A direct edit writes an ALREADY-APPROVED
   * change_requests row plus a `change_request.approve`-shaped audit event, so
   * the effective-dated W-2 history (change-requests/address-history.ts) sees
   * one uniform history source regardless of which flow made the change.
   */
  app.patch("/api/admin/employees/:employeeId", { preHandler: admin }, async (req, reply) => {
    const employeeId = Number((req.params as { employeeId: string }).employeeId);
    const body = z
      .object({
        taxId: z
          .string()
          .regex(/^\d{9}$/, "tax id must be 9 digits")
          .optional(),
        mailingAddress: addressSchema.optional(),
        effectiveFrom: isoDate.optional(),
      })
      .refine((d) => d.taxId !== undefined || d.mailingAddress !== undefined, {
        message: "provide taxId and/or mailingAddress",
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });

    const rows = await db.select().from(employees).where(eq(employees.id, employeeId)).limit(1);
    const employee = rows[0];
    if (!employee) return reply.code(404).send({ error: "not_found" });

    if (body.data.taxId !== undefined) {
      const encrypted = encryptField(body.data.taxId, config.encryptionKey);
      await db
        .update(employees)
        .set({ taxId: encrypted, updatedAt: new Date() })
        .where(eq(employees.id, employeeId));
      await audit(
        req.authUser!.id,
        "employee.set_tax_id",
        String(employeeId),
        { taxIdMasked: maskLast4(employee.taxId, config.encryptionKey) },
        { taxIdMasked: maskLast4(encrypted, config.encryptionKey) },
      );
    }

    if (body.data.mailingAddress !== undefined) {
      // PAY-21: the change_request payload, the target field, and the audit
      // after-value all carry the stored (encrypted) form — same doctrine as
      // the approve flow in change-requests/service.ts.
      const stored = addressForStorage(body.data.mailingAddress, config.encryptionKey);
      const effectiveFrom = body.data.effectiveFrom ?? new Date().toISOString().slice(0, 10);
      const now = new Date();
      await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(changeRequests)
          .values({
            employeeId,
            requestType: "mailing_address",
            payload: stored,
            effectiveFrom,
            status: "approved",
            submittedAt: now,
            decidedBy: req.authUser!.id,
            decidedAt: now,
            appliedAt: now,
          })
          .returning();
        const request = inserted[0]!;
        await tx
          .update(employees)
          .set({ mailingAddress: stored, updatedAt: now })
          .where(eq(employees.id, employeeId));
        await tx.insert(auditEvents).values({
          actorId: req.authUser!.id,
          action: "change_request.approve",
          entity: "change_request",
          entityId: request.publicId,
          before: { mailingAddress: employee.mailingAddress },
          after: { applied: stored, effectiveFrom },
        });
      });
    }

    return { employee: await employeeWithUser(employeeId) };
  });

  /**
   * Invite the employee's user and link the records, or resend the invite
   * when the linked user never completed onboarding.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: route handler with linear validation guard chain
  app.post("/api/admin/employees/:employeeId/invite", { preHandler: admin }, async (req, reply) => {
    const employeeId = Number((req.params as { employeeId: string }).employeeId);
    const rows = await db.select().from(employees).where(eq(employees.id, employeeId)).limit(1);
    const employee = rows[0];
    if (!employee) return reply.code(404).send({ error: "not_found" });
    const auditCtx = requestContext(toHeaders(req));

    try {
      if (employee.userId) {
        // Linked already — only a resend makes sense, and only pre-enrollment.
        const result = await resendInvite(deps, employee.userId, req.authUser!.id, auditCtx);
        return { ...result, resent: true };
      }
      const body = z
        .object({
          email: z.string().email().max(320),
          name: z.string().trim().min(1).max(200).default(employee.legalName),
        })
        .safeParse(req.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_body", details: body.error.issues });

      const result = await inviteUser(
        deps,
        { name: body.data.name, email: body.data.email, role: "employee" },
        req.authUser!.id,
        auditCtx,
      );
      await db
        .update(employees)
        .set({ userId: result.userId, updatedAt: new Date() })
        .where(eq(employees.id, employeeId));
      await audit(
        req.authUser!.id,
        "employee.link_user",
        String(employeeId),
        { userId: null },
        { userId: result.userId },
      );
      return reply.code(201).send({ ...result, resent: false });
    } catch (err) {
      if (err instanceof UserServiceError) {
        const status =
          err.code === "email_exists" ? 409 : err.code === "not_pending_enrollment" ? 409 : 404;
        return reply.code(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  /** Disable (terminate + ban linked user) or re-enable. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: route handler with linear validation guard chain
  app.post("/api/admin/employees/:employeeId/status", { preHandler: admin }, async (req, reply) => {
    const employeeId = Number((req.params as { employeeId: string }).employeeId);
    const body = z
      .object({
        status: z.enum(["active", "terminated"]),
        terminationDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });

    const rows = await db.select().from(employees).where(eq(employees.id, employeeId)).limit(1);
    const employee = rows[0];
    if (!employee) return reply.code(404).send({ error: "not_found" });
    if (employee.status === body.data.status) {
      return reply
        .code(409)
        .send({ error: "no_op", message: `employee is already '${employee.status}'` });
    }

    const terminating = body.data.status === "terminated";
    const updated = await db
      .update(employees)
      .set({
        status: body.data.status,
        terminationDate: terminating
          ? (body.data.terminationDate ?? new Date().toISOString().slice(0, 10))
          : null,
        updatedAt: new Date(),
      })
      .where(eq(employees.id, employeeId))
      .returning();

    // Auth stays in sync: terminated employees lose access immediately.
    if (employee.userId) {
      const ctx = await auth.$context;
      if (terminating) {
        await ctx.internalAdapter.updateUser(employee.userId, {
          banned: true,
          banReason: "employee_terminated",
        });
        await ctx.internalAdapter.deleteUserSessions(employee.userId);
      } else {
        await ctx.internalAdapter.updateUser(employee.userId, { banned: false, banReason: null });
      }
    }

    await audit(
      req.authUser!.id,
      terminating ? "employee.disable" : "employee.enable",
      String(employeeId),
      { status: employee.status },
      { status: updated[0]!.status, terminationDate: updated[0]!.terminationDate },
    );
    return { employee: await employeeWithUser(employeeId) };
  });
  /**
   * PAY-208 ((j)(3)(v)(A)/(B), OD3): record a withdrawal the employee asked
   * for in writing. Effective today (company-local), never back-dated; the
   * same confirmation mail as a withdrawal on the consent page, or
   * confirmation "paper_needed" when the employee has no sign-in. 404 when
   * no consent is on file.
   */
  app.post(
    "/api/admin/employees/:employeeId/w2-consent/withdraw",
    { preHandler: [refuseCrossSite, admin] },
    async (req, reply) => {
      const employeeId = Number((req.params as { employeeId: string }).employeeId);
      if (!Number.isInteger(employeeId) || employeeId <= 0) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      try {
        const out = await withdrawW2Consent({ db, config }, employeeId, req.authUser!.id);
        return {
          w2Consent: await w2ConsentState(db, employeeId),
          effectiveOn: out.effectiveOn,
          confirmation: out.confirmation,
        };
      } catch (err) {
        if (err instanceof FilingServiceError) return reply.code(404).send({ error: "not_found" });
        throw err;
      }
    },
  );

  /**
   * The employee's login for a sign-in email change, or null (no login).
   * S-H1: pendingEnrollment — the user is still enrolling, so the admin
   * re-sends the invite to the new address (nothing is sent automatically).
   */
  async function signInTarget(
    employeeId: number,
  ): Promise<{ userId: string; oldEmail: string; pendingEnrollment: boolean } | null> {
    const rows = await db
      .select({ userId: employees.userId, email: authUser.email, banReason: authUser.banReason })
      .from(employees)
      .leftJoin(authUser, eq(authUser.id, employees.userId))
      .where(eq(employees.id, employeeId))
      .limit(1);
    const row = rows[0];
    if (!row?.userId || !row.email) return null;
    return {
      userId: row.userId,
      oldEmail: row.email,
      pendingEnrollment: row.banReason === "pending_enrollment",
    };
  }

  /** Another user signs in with `email` (case-insensitive). */
  async function emailTakenByOther(email: string, userId: string): Promise<boolean> {
    const taken = await db
      .select({ id: authUser.id })
      .from(authUser)
      .where(and(sql`lower(${authUser.email}) = ${email}`, ne(authUser.id, userId)))
      .limit(1);
    return taken.length > 0;
  }

  /**
   * D-A: the sign-in email change itself. One transaction: the new address,
   * S-H1 revocation of every outstanding setup link, the masked audit row
   * and the notice to the new and the old address. False when another
   * change took the address first (S-L1: unique violation, no detail
   * logged). After the commit, S-M2: every session of the user ends
   * (R3-1: sessionsRevoked false when that fails).
   */
  async function applySignInEmailChange(c: {
    employeeId: number;
    userId: string;
    oldEmail: string;
    newEmail: string;
    actorId: string;
    headers: Headers;
  }): Promise<{ sessionsRevoked: boolean } | null> {
    const rendered = signInEmailChanged(await templateContext(db, config));
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(authUser)
          .set({ email: c.newEmail, updatedAt: new Date() })
          .where(eq(authUser.id, c.userId));
        await revokeOutstandingSetupTokens(tx, c.userId);
        await tx.insert(auditEvents).values({
          actorId: c.actorId,
          action: "employee.sign_in_email_change",
          entity: "employee",
          entityId: String(c.employeeId),
          before: { email: maskEmail(c.oldEmail) },
          after: { email: maskEmail(c.newEmail), setupLinksRevoked: true },
        });
        const notice = {
          userId: c.userId,
          eventType: EVENT_TYPE.signInEmailChanged,
          subject: rendered.subject,
          bodyHtml: rendered.html,
        };
        await tx.insert(emailOutbox).values([notice, { ...notice, recipientEmail: c.oldEmail }]);
      });
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
    // R3-1: the change stands even when ending the sessions fails — the
    // admin is told (sessionsRevoked: false); the log names the error class
    // only (never its message, which may carry an address).
    try {
      const ctx = await auth.$context;
      await ctx.internalAdapter.deleteUserSessions(c.userId);
      await writeAuthEvent(db, AUTH_EVENT.sessionRevoked, c.userId, requestContext(c.headers));
      return { sessionsRevoked: true };
    } catch (err) {
      const cls = err instanceof Error ? err.constructor.name || "Error" : typeof err;
      console.error(`[auth] sign-in email change: session revocation failed (${cls})`);
      return { sessionsRevoked: false };
    }
  }

  /**
   * PAY-208 D-A ((j)(3)(vii): how an employee's W-2 email address is
   * updated): change the email the employee signs in with. Needs a fresh
   * admin session (signed in within FRESH_SESSION_MS — Better Auth's
   * freshAge), refuses cross-site; 409 when another user has the address
   * (any case), 404 when the employee has no sign-in. Audited with both
   * addresses masked. The notice goes to the NEW address (user-id lookup)
   * and the OLD one (the outbox recipient override, cleared once sent).
   */
  app.put(
    "/api/admin/employees/:employeeId/sign-in-email",
    // S-L2: 20 per minute per client, like the PDF routes.
    { preHandler: [refuseCrossSite, admin], config: { rateLimit: PDF_RATE_LIMIT } },
    async (req, reply) => {
      const employeeId = Number((req.params as { employeeId: string }).employeeId);
      if (!Number.isInteger(employeeId) || employeeId <= 0) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      if (!sessionIsFresh(req.authSession?.createdAt)) {
        return reply.code(403).send({ error: "session_not_fresh" });
      }
      const body = z
        .object({ email: z.string().trim().max(254).pipe(z.email()) })
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      const newEmail = body.data.email.toLowerCase();
      const target = await signInTarget(employeeId);
      if (!target) return reply.code(404).send({ error: "not_found" });
      const { userId, oldEmail, pendingEnrollment } = target;
      if (await emailTakenByOther(newEmail, userId)) {
        return reply.code(409).send({ error: "email_exists" });
      }
      if (oldEmail.toLowerCase() === newEmail) {
        return { changed: false, pendingEnrollment, sessionsRevoked: false };
      }
      const done = await applySignInEmailChange({
        employeeId,
        userId,
        oldEmail,
        newEmail,
        actorId: req.authUser!.id,
        headers: toHeaders(req),
      });
      if (!done) return reply.code(409).send({ error: "email_exists" });
      return { changed: true, pendingEnrollment, sessionsRevoked: done.sessionsRevoked };
    },
  );
}

/**
 * Admin user-management routes (spec 3): invite, reset, unlock.
 * Real admin screens arrive with the frontend step; these prove the flows.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Auth } from "../auth/auth.js";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import type { Guards } from "../plugins/guards.js";
import { inviteUser, initiateReset, unlockUser, UserServiceError } from "../auth/users.js";
import { requestContext } from "../auth/audit.js";
import { toHeaders } from "../plugins/guards.js";
import { w2AccessEnded } from "../auth/former-employee.js";
import { localDate } from "../payroll/run-dates.js";

interface AdminDeps {
  auth: Auth;
  db: Db;
  config: AppConfig;
  guards: Guards;
  /** Test override: the wall clock for the (j)(6) window (PAY-217). */
  clock?: () => Date;
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { guards, db, config } = deps;
  const admin = guards.requireRole("admin");

  /**
   * PAY-217 (brief §4.5): a reset or unlock of a former employee whose
   * (j)(6) windows have all closed would lead nowhere (the guard refuses
   * every request) — 409 w2_access_ended, nothing changed.
   */
  async function accessEnded(userId: string): Promise<boolean> {
    const now = deps.clock ?? (() => new Date());
    return w2AccessEnded(db, userId, localDate(now(), config.appTz), config.appTz);
  }

  app.post("/api/admin/users", { preHandler: admin }, async (req, reply) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(200),
        email: z.string().email().max(320),
        role: z.enum(["admin", "employee"]).default("employee"),
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
    try {
      const result = await inviteUser(
        deps,
        body.data,
        req.authUser!.id,
        requestContext(toHeaders(req)),
      );
      if (result.smtpMissing) {
        req.log.warn(
          { setupLink: result.setupLink },
          "SMTP not configured — setup link must be copied manually",
        );
      }
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof UserServiceError && err.code === "email_exists") {
        return reply.code(409).send({ error: "email_exists" });
      }
      throw err;
    }
  });

  app.post("/api/admin/users/:userId/reset", { preHandler: admin }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    if (await accessEnded(userId)) return reply.code(409).send({ error: "w2_access_ended" });
    try {
      const result = await initiateReset(
        deps,
        userId,
        req.authUser!.id,
        requestContext(toHeaders(req)),
      );
      if (result.smtpMissing) {
        req.log.warn(
          { setupLink: result.setupLink },
          "SMTP not configured — reset link must be copied manually",
        );
      }
      return result;
    } catch (err) {
      if (err instanceof UserServiceError && err.code === "not_found") {
        return reply.code(404).send({ error: "not_found" });
      }
      throw err;
    }
  });

  app.post("/api/admin/users/:userId/unlock", { preHandler: admin }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    if (await accessEnded(userId)) return reply.code(409).send({ error: "w2_access_ended" });
    try {
      await unlockUser(deps, userId, req.authUser!.id, requestContext(toHeaders(req)));
      return { ok: true };
    } catch (err) {
      if (err instanceof UserServiceError && err.code === "not_found") {
        return reply.code(404).send({ error: "not_found" });
      }
      throw err;
    }
  });
}

/**
 * Employee-self routes (frontend spec: /my/profile + /my/settings).
 *
 * - GET /api/my/profile — read-only current info with sensitive fields masked
 *   (bank account ••••1234, tax id last-4 only; tax ID is NOT requestable per
 *   spec 4 so it is display-only here).
 * - GET/PUT /api/my/notification-settings — the toggleable workflow events
 *   only (WORKFLOW_EVENTS); security events are always on and rejected here.
 */

import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { authTwoFactor, notificationSettings, w4Elections } from "@payroll/db";
import { WORKFLOW_EVENTS, workflowEventsFor } from "@payroll/notifications";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import type { Guards } from "../plugins/guards.js";
import { employeeForUser } from "../change-requests/service.js";
import { maskLast4 } from "../crypto/field-encryption.js";
import { decryptAddress } from "../crypto/address-encryption.js";
import { decodeCodeHashes, encodeCodeHashes, generateBackupCodes } from "../auth/backup-codes.js";
import { passkeyCount } from "../auth/passkey-policy.js";
import { passkeyPromptDue, recordPasskeyPromptChoice } from "../auth/passkey-prompt.js";

interface Deps {
  db: Db;
  config: AppConfig;
  guards: Guards;
  /** Test override: the wall clock for the passkey prompt's 30-day snooze. */
  clock?: () => Date;
}

interface BankDetailsStored {
  routing?: string;
  account?: string;
  type?: string;
}

export function registerMyRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, config, guards } = deps;
  const now = deps.clock ?? (() => new Date());

  app.get("/api/my/profile", { preHandler: guards.requireAuth }, async (req, reply) => {
    const employee = await employeeForUser(db, req.authUser!.id);
    if (!employee) return reply.code(403).send({ error: "no_employee_record" });

    const key = config.encryptionKey;
    const bank = (employee.bankDetails ?? null) as BankDetailsStored | null;

    // Latest W-4 election by effective date (summary only).
    const w4Rows = await db
      .select()
      .from(w4Elections)
      .where(eq(w4Elections.employeeId, employee.id))
      .orderBy(desc(w4Elections.effectiveFrom), desc(w4Elections.id))
      .limit(1);
    const w4 = w4Rows[0];

    return {
      profile: {
        legalName: employee.legalName,
        preferredName: employee.preferredName,
        employmentType: employee.employmentType,
        hireDate: employee.hireDate,
        status: employee.status,
        address: decryptAddress(employee.address, key),
        mailingAddress: decryptAddress(employee.mailingAddress, key),
        bankDetails: bank
          ? {
              type: bank.type ?? null,
              routingMasked: maskLast4(bank.routing ?? null, key),
              accountMasked: maskLast4(bank.account ?? null, key),
            }
          : null,
        taxIdMasked: maskLast4(employee.taxId, key),
        w4: w4
          ? {
              taxYear: w4.taxYear,
              filingStatus: w4.filingStatus,
              federalExempt: w4.federalExempt,
              dependentsAmount: w4.dependentsAmount,
              otherIncome: w4.otherIncome,
              deductionsAmount: w4.deductionsAmount,
              extraWithholding: w4.extraWithholding,
              effectiveFrom: w4.effectiveFrom,
            }
          : null,
      },
    };
  });

  /**
   * Security posture for the settings page: 2FA status + remaining backup
   * codes. Active sessions come from Better Auth's own /api/auth/list-sessions.
   */
  app.get("/api/my/security", { preHandler: guards.requireAuth }, async (req) => {
    const rows = await db
      .select()
      .from(authTwoFactor)
      .where(eq(authTwoFactor.userId, req.authUser!.id))
      .limit(1);
    const twoFactor = rows[0];
    return {
      twoFactorEnabled: Boolean(req.authUser!.twoFactorEnabled),
      backupCodesRemaining: twoFactor ? decodeCodeHashes(twoFactor.backupCodes).length : 0,
      passkeyCount: await passkeyCount(db, req.authUser!.id),
      passkeyPromptDue: await passkeyPromptDue(db, req.authUser!.id, now()),
    };
  });

  /** PAY-267: the answer to the dashboard's "add a passkey" card. */
  app.post("/api/my/passkey-prompt", { preHandler: guards.requireAuth }, async (req, reply) => {
    const body = z.object({ choice: z.enum(["not_now", "never"]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    await recordPasskeyPromptChoice(db, req.authUser!.id, body.data.choice, now());
    return { ok: true };
  });

  /**
   * Regenerate backup codes (spec 3 storage: hashed at rest, shown once).
   * Replaces ALL existing codes — the plain codes are returned exactly once.
   */
  app.post("/api/my/backup-codes", { preHandler: guards.requireAuth }, async (req, reply) => {
    const rows = await db
      .select()
      .from(authTwoFactor)
      .where(eq(authTwoFactor.userId, req.authUser!.id))
      .limit(1);
    const twoFactor = rows[0];
    if (!twoFactor || !req.authUser!.twoFactorEnabled) {
      return reply.code(409).send({ error: "totp_not_enrolled" });
    }
    const backupCodes = generateBackupCodes(10);
    await db
      .update(authTwoFactor)
      .set({ backupCodes: encodeCodeHashes(backupCodes) })
      .where(eq(authTwoFactor.id, twoFactor.id));
    return { backupCodes };
  });

  app.get("/api/my/notification-settings", { preHandler: guards.requireAuth }, async (req) => {
    const rows = await db
      .select()
      .from(notificationSettings)
      .where(eq(notificationSettings.userId, req.authUser!.id));
    const byEvent = new Map(rows.map((r) => [r.eventType, r.enabled]));
    // PAY-8: only surface events that can ever fire for this caller —
    // admin events for admins, worker-type events for the matching type.
    const employee = await employeeForUser(db, req.authUser!.id);
    const visible = workflowEventsFor({
      isAdmin: req.authUser!.role === "admin",
      employmentType: employee?.employmentType ?? null,
    });
    // Default enabled (spec): a missing row means on.
    return {
      settings: visible.map((eventType) => ({
        eventType,
        enabled: byEvent.get(eventType) ?? true,
      })),
    };
  });

  app.put(
    "/api/my/notification-settings",
    { preHandler: guards.requireAuth },
    async (req, reply) => {
      const body = z
        .object({
          settings: z.array(z.object({ eventType: z.string(), enabled: z.boolean() })).max(50),
        })
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });

      const employee = await employeeForUser(db, req.authUser!.id);
      const toggleable = new Set<string>(
        workflowEventsFor({
          isAdmin: req.authUser!.role === "admin",
          employmentType: employee?.employmentType ?? null,
        }),
      );
      const known = new Set<string>(WORKFLOW_EVENTS);
      for (const item of body.data.settings) {
        // Security events are always on — not settable (spec notifications).
        if (!known.has(item.eventType)) {
          return reply.code(400).send({ error: "not_toggleable", eventType: item.eventType });
        }
        // PAY-8: a workflow event outside the caller's audience (e.g. an
        // admin event toggled by a non-admin) is not settable either.
        if (!toggleable.has(item.eventType)) {
          return reply.code(400).send({ error: "not_applicable", eventType: item.eventType });
        }
      }
      for (const item of body.data.settings) {
        await db
          .insert(notificationSettings)
          .values({ userId: req.authUser!.id, eventType: item.eventType, enabled: item.enabled })
          .onConflictDoUpdate({
            target: [notificationSettings.userId, notificationSettings.eventType],
            set: { enabled: item.enabled },
          });
      }
      return { ok: true };
    },
  );
}

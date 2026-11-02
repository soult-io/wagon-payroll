/**
 * Onboarding routes (public, setup-token-gated — spec 3).
 *
 * The setup token permits ONLY these endpoints until enrollment completes —
 * it acts as the "setup session" of the spec. Steps (state machine via side
 * effects, token consumed only at completion):
 *   verify-token → set-password → totp-enable → totp-verify (issues backup
 *   codes, unbans the user, consumes the token).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import zxcvbn from "zxcvbn";
import { createOTP } from "@better-auth/utils/otp";
import { generateRandomString, symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import type { Auth } from "../auth/auth.js";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { notificationSettings } from "@payroll/db";
import { WORKFLOW_EVENTS } from "@payroll/notifications";
import { consumeSetupToken, findValidSetupToken } from "../auth/tokens.js";
import { PASSWORD_MIN_LENGTH, PASSWORD_MIN_ZXCVBN_SCORE, hashPassword } from "../auth/password.js";
import { encodeCodeHashes, generateBackupCodes } from "../auth/backup-codes.js";
import { writeAuthEvent, AUTH_EVENT, requestContext } from "../auth/audit.js";
import { wipePasskeys } from "../auth/passkey-policy.js";
import { toHeaders, type Guards } from "../plugins/guards.js";

const tokenBody = z.object({ token: z.string().min(1) });

interface OnboardingDeps {
  auth: Auth;
  db: Db;
  config: AppConfig;
  guards: Guards;
}

export function registerOnboardingRoutes(app: FastifyInstance, deps: OnboardingDeps): void {
  const { auth, db, config } = deps;
  const rateLimit = { max: 10, timeWindow: "1 minute" };

  /** Resolve token → row + user, or reply 400. */
  async function resolveToken(token: string) {
    const row = await findValidSetupToken(db, token);
    if (!row) return null;
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.findUserById(row.userId);
    if (!user) return null;
    return { row, user };
  }

  app.post("/api/onboarding/verify-token", { config: { rateLimit } }, async (req, reply) => {
    const body = tokenBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_token" });
    const resolved = await resolveToken(body.data.token);
    if (!resolved) return reply.code(400).send({ error: "invalid_token" });
    return {
      email: resolved.user.email,
      name: resolved.user.name,
      purpose: resolved.row.purpose,
    };
  });

  app.post("/api/onboarding/set-password", { config: { rateLimit } }, async (req, reply) => {
    const body = z.object({ token: z.string().min(1), password: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_token" });
    const resolved = await resolveToken(body.data.token);
    if (!resolved) return reply.code(400).send({ error: "invalid_token" });

    const { password } = body.data;
    if (password.length < PASSWORD_MIN_LENGTH) {
      return reply.code(400).send({
        error: "weak_password",
        message: `password must be at least ${PASSWORD_MIN_LENGTH} characters`,
      });
    }
    const strength = zxcvbn(password);
    if (strength.score < PASSWORD_MIN_ZXCVBN_SCORE) {
      return reply.code(400).send({
        error: "weak_password",
        message: strength.feedback.warning || "password is too weak",
        suggestions: strength.feedback.suggestions,
      });
    }

    const ctx = await auth.$context;
    // Create-or-update the credential account. Invited users have no account
    // yet (its existence marks "password step done" for step-order
    // enforcement); reset users already have one.
    const hashed = await hashPassword(password);
    const account = await ctx.adapter.findOne<{ id: string }>({
      model: "account",
      where: [
        { field: "userId", value: resolved.user.id },
        { field: "providerId", value: "credential" },
      ],
    });
    if (account) {
      await ctx.internalAdapter.updatePassword(resolved.user.id, hashed);
    } else {
      await ctx.internalAdapter.createAccount({
        userId: resolved.user.id,
        accountId: resolved.user.id,
        providerId: "credential",
        password: hashed,
      });
    }

    if (resolved.row.purpose === "reset") {
      // Reset forces re-enrollment: kill sessions, wipe TOTP (spec 3).
      await ctx.internalAdapter.deleteUserSessions(resolved.user.id);
      await ctx.internalAdapter.updateUser(resolved.user.id, {
        banned: true,
        banReason: "pending_enrollment",
        twoFactorEnabled: false,
      });
      await ctx.adapter.deleteMany({
        model: "twoFactor",
        where: [{ field: "userId", value: resolved.user.id }],
      });
      // PAY-259: and the passkeys (a passkey added after the reset was issued).
      await wipePasskeys(db, resolved.user.id, requestContext(toHeaders(req)));
    }
    return { ok: true, next: "totp" };
  });

  app.post("/api/onboarding/totp-enable", { config: { rateLimit } }, async (req, reply) => {
    const body = tokenBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_token" });
    const resolved = await resolveToken(body.data.token);
    if (!resolved) return reply.code(400).send({ error: "invalid_token" });

    const ctx = await auth.$context;
    // Enforce step order: password must already be set.
    const account = await ctx.adapter.findOne<{ password: string | null }>({
      model: "account",
      where: [
        { field: "userId", value: resolved.user.id },
        { field: "providerId", value: "credential" },
      ],
    });
    if (!account?.password) return reply.code(400).send({ error: "password_first" });

    // Fresh secret per enrollment (replaces any previous one).
    const secret = generateRandomString(32);
    const encryptedSecret = await symmetricEncrypt({
      key: ctx.secretConfig ?? config.sessionSecret,
      data: secret,
    });
    await ctx.adapter.deleteMany({
      model: "twoFactor",
      where: [{ field: "userId", value: resolved.user.id }],
    });
    await ctx.adapter.create({
      model: "twoFactor",
      data: {
        userId: resolved.user.id,
        secret: encryptedSecret,
        backupCodes: "[]",
      },
    });
    const totpURI = createOTP(secret, { digits: 6, period: 30 }).url(
      config.totpIssuer,
      resolved.user.email,
    );
    return { totpURI };
  });

  app.post("/api/onboarding/totp-verify", { config: { rateLimit } }, async (req, reply) => {
    const body = z
      .object({ token: z.string().min(1), code: z.string().min(1) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_token" });
    const resolved = await resolveToken(body.data.token);
    if (!resolved) return reply.code(400).send({ error: "invalid_token" });

    const ctx = await auth.$context;
    const twoFactor = await ctx.adapter.findOne<{ id: string; secret: string }>({
      model: "twoFactor",
      where: [{ field: "userId", value: resolved.user.id }],
    });
    if (!twoFactor) return reply.code(400).send({ error: "totp_not_started" });

    const secret = await symmetricDecrypt({
      key: ctx.secretConfig ?? config.sessionSecret,
      data: twoFactor.secret,
    });
    const valid = await createOTP(secret, { digits: 6, period: 30 }).verify(body.data.code);
    if (!valid) return reply.code(400).send({ error: "invalid_code" });

    // Enrollment completes here: enable 2FA, unban (account becomes ACTIVE),
    // issue backup codes (shown once, hashed at rest), consume the token.
    await ctx.internalAdapter.updateUser(resolved.user.id, {
      twoFactorEnabled: true,
      banned: false,
      banReason: null,
    });
    const backupCodes = generateBackupCodes(10);
    await ctx.adapter.update({
      model: "twoFactor",
      update: { backupCodes: encodeCodeHashes(backupCodes), verified: true },
      where: [{ field: "id", value: twoFactor.id }],
    });
    await consumeSetupToken(db, resolved.row.id);

    // Default notification settings: all workflow events enabled (spec 6).
    // onConflictDoNothing — a password reset must not clobber existing toggles.
    await db
      .insert(notificationSettings)
      .values(
        WORKFLOW_EVENTS.map((eventType) => ({
          userId: resolved.user.id,
          eventType,
          enabled: true,
        })),
      )
      .onConflictDoNothing({
        target: [notificationSettings.userId, notificationSettings.eventType],
      });

    const auditCtx = requestContext(toHeaders(req));
    await writeAuthEvent(
      db,
      resolved.row.purpose === "invite" ? AUTH_EVENT.inviteAccepted : AUTH_EVENT.passwordReset,
      resolved.user.id,
      auditCtx,
    );
    return { ok: true, backupCodes };
  });
}

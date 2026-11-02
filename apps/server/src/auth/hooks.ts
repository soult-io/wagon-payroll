/**
 * Better Auth hooks — auth_events audit (spec 3) + account lockout after 10
 * consecutive password failures (spec: "admin unlock or timed backoff"; we
 * implement admin unlock: the account is banned with reason 'lockout').
 */

import { createAuthMiddleware, APIError } from "better-auth/api";
import { and, desc, eq, or } from "drizzle-orm";
import { authEvents, authUser } from "@payroll/db";
import { writeAuthEvent, AUTH_EVENT, requestContext } from "./audit.js";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { trackDevice } from "../notify/device.js";
import { passkeyOwner, passkeyResponseOverride } from "./passkey-policy.js";

export const LOCKOUT_THRESHOLD = 10;

/** Count consecutive login_failure events since the last login_success for a user. */
async function consecutiveFailures(db: Db, userId: string): Promise<number> {
  const rows = await db
    .select({ event: authEvents.event })
    .from(authEvents)
    .where(
      and(
        eq(authEvents.userId, userId),
        or(
          eq(authEvents.event, AUTH_EVENT.loginSuccess),
          eq(authEvents.event, AUTH_EVENT.loginFailure),
        ),
      ),
    )
    .orderBy(desc(authEvents.id))
    .limit(LOCKOUT_THRESHOLD + 1);
  let count = 0;
  for (const row of rows) {
    if (row.event === AUTH_EVENT.loginFailure) count++;
    else break;
  }
  return count;
}

/** The user a sign-in endpoint returned ({ user: { id } }), if any. */
function returnedUserId(returned: unknown): string | null {
  return (returned as { user?: { id?: string } } | undefined)?.user?.id ?? null;
}

async function findUserIdByEmail(db: Db, email: string): Promise<string | null> {
  const rows = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email.toLowerCase()))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * after-hook: writes audit events for BA-owned flows and applies lockout.
 * Passkey events never touch the password lockout counter (PAY-259):
 * consecutiveFailures reads only login_success / login_failure.
 * Failure detection: BA's dispatcher catches endpoint APIErrors into
 * `ctx.context.returned` and still runs after-hooks (see dispatch.mjs).
 */
export function createAuditHook(deps: {
  db: Db;
  config: AppConfig;
  lockout: (
    userId: string,
    auditCtx: { ip?: string | null; userAgent?: string | null },
  ) => Promise<void>;
}) {
  const { db } = deps;

  /** security_login_new_device on a completed 2FA challenge (spec 6, always on). */
  async function trackNewDevice(
    userId: string | null,
    auditCtx: { ip?: string | null; userAgent?: string | null },
  ) {
    if (!userId) return;
    try {
      await trackDevice(
        { db, config: deps.config },
        { userId, userAgent: auditCtx.userAgent ?? null, ip: auditCtx.ip ?? null },
      );
    } catch (err) {
      // Device tracking must never break a successful login.
      console.error("[device-track] failed:", err);
    }
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: auth middleware guard chain; kept linear intentionally
  return createAuthMiddleware(async (ctx) => {
    const auditCtx = requestContext(ctx.headers ?? new Headers());
    const returned = ctx.context.returned;
    const isFailure = returned instanceof APIError;
    const sessionUser = (ctx.context.session?.user ?? null) as {
      id?: string;
      email?: string;
    } | null;
    const body = (ctx.body ?? {}) as Record<string, unknown>;

    // PAY-259: the one response this hook changes (sign-in options ask for UV).
    const override = isFailure ? null : passkeyResponseOverride(ctx.path, returned);
    if (override) return ctx.json(override);

    switch (ctx.path) {
      case "/sign-in/email": {
        const email = typeof body.email === "string" ? body.email : null;
        const userId = email ? await findUserIdByEmail(db, email) : null;
        if (isFailure) {
          await writeAuthEvent(db, AUTH_EVENT.loginFailure, userId, auditCtx);
          // Only credential failures count toward lockout (not "user banned" etc.).
          const code = (returned as APIError).body?.code ?? "";
          if (userId && code === "INVALID_EMAIL_OR_PASSWORD") {
            if ((await consecutiveFailures(db, userId)) >= LOCKOUT_THRESHOLD) {
              await deps.lockout(userId, auditCtx);
            }
          }
        } else {
          await writeAuthEvent(db, AUTH_EVENT.loginSuccess, userId, auditCtx);
        }
        break;
      }
      case "/two-factor/verify-totp": {
        const userId = sessionUser?.id ?? returnedUserId(returned);
        await writeAuthEvent(
          db,
          isFailure ? AUTH_EVENT.mfaFail : AUTH_EVENT.mfaPass,
          userId,
          auditCtx,
        );
        if (!isFailure) await trackNewDevice(userId, auditCtx);
        break;
      }
      case "/backup-code/verify": {
        // The backup-code plugin writes its own mfa_pass/mfa_fail events;
        // here we only track the device on a completed sign-in.
        if (!isFailure) await trackNewDevice(sessionUser?.id ?? returnedUserId(returned), auditCtx);
        break;
      }
      case "/passkey/verify-authentication": {
        if (isFailure) {
          const response = body.response as { id?: unknown } | undefined;
          const ownerId = await passkeyOwner(db, response?.id);
          await writeAuthEvent(db, AUTH_EVENT.passkeyLoginFailure, ownerId, auditCtx);
          break;
        }
        const userId = returnedUserId(returned);
        await writeAuthEvent(db, AUTH_EVENT.passkeyLoginSuccess, userId, auditCtx);
        await trackNewDevice(userId, auditCtx);
        break;
      }
      case "/passkey/verify-registration": {
        const event = isFailure ? AUTH_EVENT.passkeyAddFailed : AUTH_EVENT.passkeyAdded;
        await writeAuthEvent(db, event, sessionUser?.id ?? null, auditCtx);
        break;
      }
      case "/passkey/update-passkey": {
        if (!isFailure) {
          await writeAuthEvent(db, AUTH_EVENT.passkeyRenamed, sessionUser?.id ?? null, auditCtx);
        }
        break;
      }
      case "/passkey/delete-passkey": {
        if (!isFailure) {
          await writeAuthEvent(db, AUTH_EVENT.passkeyRemoved, sessionUser?.id ?? null, auditCtx);
        }
        break;
      }
      case "/change-password": {
        if (!isFailure) {
          await writeAuthEvent(db, AUTH_EVENT.passwordChange, sessionUser?.id ?? null, auditCtx);
        }
        break;
      }
      case "/sign-out":
      case "/revoke-session":
      case "/revoke-sessions":
      case "/revoke-other-sessions": {
        if (!isFailure) {
          await writeAuthEvent(db, AUTH_EVENT.sessionRevoked, sessionUser?.id ?? null, auditCtx);
        }
        break;
      }
      case "/admin/set-role": {
        if (!isFailure) {
          const targetId = typeof body.userId === "string" ? body.userId : null;
          await writeAuthEvent(db, AUTH_EVENT.roleChange, targetId, auditCtx);
        }
        break;
      }
      case "/admin/ban-user": {
        if (!isFailure) {
          const targetId = typeof body.userId === "string" ? body.userId : null;
          await writeAuthEvent(db, AUTH_EVENT.userDisabled, targetId, auditCtx);
        }
        break;
      }
      case "/admin/unban-user": {
        if (!isFailure) {
          const targetId = typeof body.userId === "string" ? body.userId : null;
          await writeAuthEvent(db, AUTH_EVENT.userEnabled, targetId, auditCtx);
        }
        break;
      }
      default:
        break;
    }
  });
}

/** Ban a user after lockout threshold and kill all sessions (spec: instant revocation). */
export async function lockoutUser(
  db: Db,
  internalAdapter: {
    updateUser: (id: string, data: Record<string, unknown>) => Promise<unknown>;
    deleteUserSessions: (id: string) => Promise<void>;
  },
  userId: string,
  auditCtx: { ip?: string | null; userAgent?: string | null } = {},
): Promise<void> {
  await internalAdapter.updateUser(userId, { banned: true, banReason: "lockout" });
  await internalAdapter.deleteUserSessions(userId);
  await writeAuthEvent(db, AUTH_EVENT.lockout, userId, auditCtx);
  await writeAuthEvent(db, AUTH_EVENT.userDisabled, userId, auditCtx);
}

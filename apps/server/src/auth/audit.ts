/**
 * auth_events — append-only audit trail (spec 3, spec 1 §6).
 * Every authentication-relevant event lands here with user, IP, user-agent.
 */

import { isIP } from "node:net";
import { authEvents } from "@payroll/db";
import type { Db } from "../db.js";

export const AUTH_EVENT = {
  loginSuccess: "login_success",
  loginFailure: "login_failure",
  mfaPass: "mfa_pass",
  mfaFail: "mfa_fail",
  passwordChange: "password_change",
  passwordReset: "password_reset",
  inviteCreated: "invite_created",
  inviteAccepted: "invite_accepted",
  sessionRevoked: "session_revoked",
  roleChange: "role_change",
  userDisabled: "user_disabled",
  userEnabled: "user_enabled",
  lockout: "lockout",
  // PAY-259 passkeys. Never carry the credential ID, public key or name.
  passkeyAdded: "passkey_added",
  passkeyAddFailed: "passkey_add_failed",
  passkeyRenamed: "passkey_renamed",
  passkeyRemoved: "passkey_removed",
  passkeyLoginSuccess: "passkey_login_success",
  passkeyLoginFailure: "passkey_login_failure",
  passkeysReset: "passkeys_reset",
} as const;

export type AuthEventName = (typeof AUTH_EVENT)[keyof typeof AUTH_EVENT];

export interface AuthEventContext {
  ip?: string | null;
  userAgent?: string | null;
}

export async function writeAuthEvent(
  db: Db,
  event: AuthEventName,
  userId: string | null,
  ctx: AuthEventContext = {},
): Promise<void> {
  await db.insert(authEvents).values({
    userId,
    event,
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
  });
}

/** Extract client IP / UA from Fastify request or Better Auth headers. */
export function requestContext(headers: { get(name: string): string | null }): AuthEventContext {
  const fwd = headers.get("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim() ?? headers.get("x-real-ip");
  return {
    // Client-supplied: auth_events.ip is inet, so a non-address would make the audit write throw.
    ip: ip && isIP(ip) ? ip : null,
    userAgent: headers.get("user-agent") ?? null,
  };
}

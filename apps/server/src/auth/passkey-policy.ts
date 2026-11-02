/**
 * PAY-259: our rules around Better Auth's passkey plugin (spec §13 S1–S12).
 *
 * - User verification is required: a passkey counts as MFA only when the
 *   device checked its PIN or biometric. The plugin verifies with
 *   requireUserVerification false, so the afterVerification hooks refuse a
 *   response without the UV flag before any row or session is written, and
 *   the sign-in options ask the browser for "required".
 * - Step-up: adding or removing a passkey needs a sign-in on this session
 *   within the last 5 minutes, by password + authenticator code or by
 *   passkey. A backup-code session must sign in again with the code first.
 * - Registration never creates a session; the WebAuthn user name stays the
 *   email (the `name` query parameter is refused); passkey names are 1–64
 *   characters after trim; at most 10 passkeys per user.
 */

import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { count, eq } from "drizzle-orm";
import { authPasskey } from "@payroll/db";
import type { Db } from "../db.js";
import { AUTH_EVENT, type AuthEventContext, writeAuthEvent } from "./audit.js";
import { AUTH_METHOD } from "./session-method.js";

/** Step-up window for adding or removing a passkey (S1). */
export const PASSKEY_STEP_UP_MS = 5 * 60 * 1000;
export const MAX_PASSKEYS_PER_USER = 10;
export const MAX_PASSKEY_NAME_LENGTH = 64;

/** Sign-in methods that count as a step-up (not a backup code, not legacy). */
const STEP_UP_METHODS: ReadonlySet<string> = new Set([
  AUTH_METHOD.passwordTotp,
  AUTH_METHOD.passkey,
]);

const STEP_UP_PATHS: ReadonlySet<string> = new Set([
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/delete-passkey",
]);

function refuse(
  status: "BAD_REQUEST" | "UNAUTHORIZED" | "FORBIDDEN",
  code: string,
  message: string,
): never {
  throw new APIError(status, { code, message });
}

/** The trimmed name, or a 400 when it is not 1–64 characters. */
function validName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length === 0 || trimmed.length > MAX_PASSKEY_NAME_LENGTH) {
    refuse(
      "BAD_REQUEST",
      "PASSKEY_NAME_INVALID",
      `Passkey name must be 1–${MAX_PASSKEY_NAME_LENGTH} characters`,
    );
  }
  return trimmed;
}

async function passkeyCount(db: Db, userId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(authPasskey)
    .where(eq(authPasskey.userId, userId));
  return rows[0]?.n ?? 0;
}

/** hooks.before: S1, S3, S4 and the name / count limits. */
export function createPasskeyPolicyHook(deps: { db: Db }) {
  return createAuthMiddleware(async (ctx) => {
    if (!ctx.path.startsWith("/passkey/")) return;
    const body = (ctx.body ?? {}) as Record<string, unknown>;

    if (ctx.path === "/passkey/generate-register-options" && ctx.query?.name !== undefined) {
      refuse("BAD_REQUEST", "PASSKEY_NAME_IN_QUERY", "Send the passkey name when you save it");
    }
    if (ctx.path === "/passkey/verify-registration" && body.createSession === true) {
      refuse(
        "BAD_REQUEST",
        "PASSKEY_CREATE_SESSION_NOT_ALLOWED",
        "Adding a passkey never signs you in",
      );
    }
    let name: string | undefined;
    if (ctx.path === "/passkey/update-passkey") name = validName(body.name);
    if (ctx.path === "/passkey/verify-registration" && body.name !== undefined) {
      name = validName(body.name);
    }

    if (STEP_UP_PATHS.has(ctx.path)) {
      const session = await getSessionFromCtx(ctx);
      // No session: the plugin's own session middleware answers 401.
      if (session) {
        const signedInAt = new Date(session.session.createdAt).getTime();
        const method = (session.session as { authMethod?: unknown }).authMethod;
        if (
          Date.now() - signedInAt > PASSKEY_STEP_UP_MS ||
          typeof method !== "string" ||
          !STEP_UP_METHODS.has(method)
        ) {
          refuse("FORBIDDEN", "SESSION_NOT_FRESH", "Sign in again to change your passkeys");
        }
        if (
          ctx.path !== "/passkey/delete-passkey" &&
          (await passkeyCount(deps.db, session.user.id)) >= MAX_PASSKEYS_PER_USER
        ) {
          refuse(
            "BAD_REQUEST",
            "PASSKEY_LIMIT_REACHED",
            `You can have at most ${MAX_PASSKEYS_PER_USER} passkeys`,
          );
        }
      }
    }

    if (name !== undefined) return { context: { body: { ...body, name } } };
  });
}

/** passkey() registration.afterVerification: no row without user verification. */
export function requireRegistrationUV(input: {
  verification: { registrationInfo?: { userVerified?: boolean } };
}): void {
  if (input.verification.registrationInfo?.userVerified !== true) {
    refuse(
      "BAD_REQUEST",
      "PASSKEY_USER_VERIFICATION_REQUIRED",
      "Your device did not confirm it is you",
    );
  }
}

/** passkey() authentication.afterVerification: no session without user verification. */
export function requireAuthenticationUV(input: {
  verification: { authenticationInfo?: { userVerified?: boolean } };
}): void {
  if (input.verification.authenticationInfo?.userVerified !== true) {
    refuse(
      "UNAUTHORIZED",
      "PASSKEY_USER_VERIFICATION_REQUIRED",
      "Your device did not confirm it is you",
    );
  }
}

/**
 * The sign-in options with userVerification "required". A hint so the
 * authenticator asks for the PIN or biometric; the server check is
 * requireAuthenticationUV. Anything that is not an options object passes.
 */
export function withRequiredUserVerification(returned: unknown): Record<string, unknown> | null {
  if (returned === null || typeof returned !== "object" || !("challenge" in returned)) return null;
  return { ...(returned as Record<string, unknown>), userVerification: "required" };
}

/** The passkey a sign-in response names (by credential ID), if any. */
export async function passkeyByCredential(
  db: Db,
  credentialId: unknown,
): Promise<{ userId: string; counter: number } | null> {
  if (typeof credentialId !== "string" || credentialId.length === 0) return null;
  const rows = await db
    .select({ userId: authPasskey.userId, counter: authPasskey.counter })
    .from(authPasskey)
    .where(eq(authPasskey.credentialID, credentialId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The signature counter in a sign-in response's authenticatorData
 * (bytes 33–36, big-endian), or null when it cannot be read.
 */
export function assertionSignCount(response: unknown): number | null {
  const data = (response as { response?: { authenticatorData?: unknown } } | null)?.response
    ?.authenticatorData;
  if (typeof data !== "string") return null;
  const bytes = Buffer.from(data, "base64url");
  return bytes.length >= 37 ? bytes.readUInt32BE(33) : null;
}

/**
 * A reset means "start over": a lost or stolen device's passkey must not
 * survive it. Deletes the user's passkeys; passkeys_reset when any existed.
 */
export async function wipePasskeys(
  db: Db,
  userId: string,
  auditCtx: AuthEventContext = {},
): Promise<void> {
  const deleted = await db
    .delete(authPasskey)
    .where(eq(authPasskey.userId, userId))
    .returning({ id: authPasskey.id });
  if (deleted.length > 0) await writeAuthEvent(db, AUTH_EVENT.passkeysReset, userId, auditCtx);
}

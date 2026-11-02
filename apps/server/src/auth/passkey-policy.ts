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
 *   A session rotated by /change-password keeps the sign-in time of the one
 *   it replaced (session-method.ts), so a password alone never counts.
 * - Registration never creates a session; the WebAuthn user name stays the
 *   email (the `name` query parameter is refused); passkey names are 1–64
 *   characters after trim; credential IDs at most 1023 bytes (WebAuthn L3
 *   §7.1); at most 10 passkeys per user.
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
/** WebAuthn L3 §7.1 steps 25–26: credential IDs longer than this are refused. */
export const MAX_CREDENTIAL_ID_BYTES = 1023;

/** Sign-in methods that count as a step-up (not a backup code, not legacy). */
const STEP_UP_METHODS: ReadonlySet<string> = new Set([
  AUTH_METHOD.passwordTotp,
  AUTH_METHOD.passkey,
]);

/** Paths that need a step-up; the ones that add a passkey also check the cap. */
const STEP_UP_PATHS: ReadonlySet<string> = new Set([
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/delete-passkey",
]);
const ADD_PATHS: ReadonlySet<string> = new Set([
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
]);

type Refusal = "BAD_REQUEST" | "UNAUTHORIZED" | "FORBIDDEN";

function refuse(status: Refusal, code: string, message: string): never {
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

/** The user's passkey count (the cap here; /api/my/security). */
export async function passkeyCount(db: Db, userId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(authPasskey)
    .where(eq(authPasskey.userId, userId));
  return rows[0]?.n ?? 0;
}

/** S3, S4, S5: request shapes refused before any work. */
function rejectRequestShape(path: string, query: unknown, body: Record<string, unknown>): void {
  if (
    path === "/passkey/generate-register-options" &&
    (query as { name?: unknown })?.name !== undefined
  ) {
    refuse("BAD_REQUEST", "PASSKEY_NAME_IN_QUERY", "Send the passkey name when you save it");
  }
  if (path !== "/passkey/verify-registration") return;
  if (body.createSession === true) {
    refuse(
      "BAD_REQUEST",
      "PASSKEY_CREATE_SESSION_NOT_ALLOWED",
      "Adding a passkey never signs you in",
    );
  }
  const id = (body.response as { id?: unknown } | undefined)?.id;
  if (typeof id === "string" && Buffer.from(id, "base64url").length > MAX_CREDENTIAL_ID_BYTES) {
    refuse("BAD_REQUEST", "PASSKEY_CREDENTIAL_ID_TOO_LONG", "This passkey cannot be used");
  }
}

/** The trimmed name to store, when the request carries one (required on rename). */
function normalizedName(path: string, body: Record<string, unknown>): string | undefined {
  if (path === "/passkey/update-passkey") return validName(body.name);
  if (path === "/passkey/verify-registration" && body.name !== undefined) {
    return validName(body.name);
  }
  return undefined;
}

/** True when the session was signed in with a step-up method in the last 5 minutes. */
function isSteppedUp(session: { createdAt: Date | string; authMethod?: unknown }): boolean {
  const signedInAt = new Date(session.createdAt).getTime();
  return (
    Number.isFinite(signedInAt) &&
    Date.now() - signedInAt <= PASSKEY_STEP_UP_MS &&
    typeof session.authMethod === "string" &&
    STEP_UP_METHODS.has(session.authMethod)
  );
}

/** S1 step-up and the 10-passkey cap. No session: the plugin answers 401. */
async function enforceStepUp(db: Db, ctx: Parameters<typeof getSessionFromCtx>[0]): Promise<void> {
  const session = await getSessionFromCtx(ctx);
  if (!session) return;
  if (!isSteppedUp(session.session)) {
    refuse("FORBIDDEN", "SESSION_NOT_FRESH", "Sign in again to change your passkeys");
  }
  if (
    ADD_PATHS.has(ctx.path) &&
    (await passkeyCount(db, session.user.id)) >= MAX_PASSKEYS_PER_USER
  ) {
    refuse(
      "BAD_REQUEST",
      "PASSKEY_LIMIT_REACHED",
      `You can have at most ${MAX_PASSKEYS_PER_USER} passkeys`,
    );
  }
}

/** hooks.before: the request rules above, for /passkey/* only. */
export function createPasskeyPolicyHook(deps: { db: Db }) {
  return createAuthMiddleware(async (ctx) => {
    if (!ctx.path.startsWith("/passkey/")) return;
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    rejectRequestShape(ctx.path, ctx.query, body);
    const name = normalizedName(ctx.path, body);
    if (STEP_UP_PATHS.has(ctx.path)) await enforceStepUp(deps.db, ctx);
    if (name !== undefined) return { context: { body: { ...body, name } } };
  });
}

/**
 * The after-hook's passkey work that is not an audit event: the sign-in
 * options ask the authenticator for a PIN or biometric. A hint; the server
 * check is requireAuthenticationUV. Returns the replacement options, or
 * null to leave the response as it is.
 */
export function passkeyResponseOverride(
  path: string,
  returned: unknown,
): Record<string, unknown> | null {
  if (path !== "/passkey/generate-authenticate-options") return null;
  if (returned === null || typeof returned !== "object" || !("challenge" in returned)) return null;
  return { ...(returned as Record<string, unknown>), userVerification: "required" };
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
 * The owner of the passkey a failed sign-in names, for passkey_login_failure
 * (null when no passkey has that credential ID). The claimed signature
 * counter is not used: SimpleWebAuthn checks the counter before the
 * signature, so a counter-regression event could be forged by anyone who
 * knows a credential ID (S6 needs a signature check first; follow-up).
 */
export async function passkeyOwner(db: Db, credentialId: unknown): Promise<string | null> {
  if (typeof credentialId !== "string" || credentialId.length === 0) return null;
  const rows = await db
    .select({ userId: authPasskey.userId })
    .from(authPasskey)
    .where(eq(authPasskey.credentialID, credentialId))
    .limit(1);
  return rows[0]?.userId ?? null;
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

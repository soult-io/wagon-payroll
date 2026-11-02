/**
 * PAY-259: how a session was signed in, stored on session."authMethod".
 *
 * Better Auth runs `setAuthMethod` (databaseHooks.session.create.before) for
 * every new session and records the endpoint that created it. PR 1 writes
 * the marker only; the guards still check user.twoFactorEnabled. A later PR
 * makes them accept only the MFA methods.
 */

export const AUTH_METHOD = {
  passwordTotp: "password_totp",
  passwordBackupCode: "password_backup_code",
  passkey: "passkey",
  /** Sessions alive when migration 0030 ran (all came from TOTP or a backup code). */
  legacyMfa: "legacy_mfa",
  none: "none",
} as const;

const METHOD_BY_PATH: Record<string, string> = {
  "/two-factor/verify-totp": AUTH_METHOD.passwordTotp,
  "/backup-code/verify": AUTH_METHOD.passwordBackupCode,
  "/passkey/verify-authentication": AUTH_METHOD.passkey,
};

/**
 * The sign-in method for a session created at `path`. /change-password
 * rotates the session, so the replacement keeps the method of the session
 * it replaces (`current`). Any other path is "none".
 */
export function authMethodForPath(path: string | undefined, current?: string | null): string {
  if (path === undefined) return AUTH_METHOD.none;
  if (path === "/change-password") {
    return typeof current === "string" && current.length > 0 ? current : AUTH_METHOD.none;
  }
  return METHOD_BY_PATH[path] ?? AUTH_METHOD.none;
}

/** The slice of Better Auth's endpoint context the hook reads. */
interface SessionCreateContext {
  path?: string;
  context?: { session?: { session?: Record<string, unknown> } | null };
}

/** databaseHooks.session.create.before: stamp the sign-in method on the new session. */
export async function setAuthMethod(
  _session: unknown,
  ctx: SessionCreateContext | null | undefined,
): Promise<{ data: { authMethod: string } }> {
  const current = ctx?.context?.session?.session?.authMethod;
  return {
    data: {
      authMethod: authMethodForPath(ctx?.path, typeof current === "string" ? current : null),
    },
  };
}

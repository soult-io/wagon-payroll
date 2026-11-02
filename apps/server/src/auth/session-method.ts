/**
 * PAY-259: how a session was signed in, stored on session."authMethod".
 *
 * Better Auth runs `setAuthMethod` (databaseHooks.session.create.before) for
 * every new session and records the endpoint that created it. Both guards
 * (plugins/guards.ts requireAuth, the /api/auth mount) accept a session only
 * when `isMfaSession` holds: default-deny for every other session path.
 */

export const AUTH_METHOD = {
  passwordTotp: "password_totp",
  passwordBackupCode: "password_backup_code",
  passkey: "passkey",
  /** Sessions of TOTP-enrolled users alive when migration 0030 ran. */
  legacyMfa: "legacy_mfa",
  none: "none",
} as const;

export type AuthMethod = (typeof AUTH_METHOD)[keyof typeof AUTH_METHOD];

/** Sign-in methods that passed a second factor (or a user-verified passkey). */
export const MFA_METHODS: ReadonlySet<string> = new Set<AuthMethod>([
  AUTH_METHOD.passwordTotp,
  AUTH_METHOD.passwordBackupCode,
  AUTH_METHOD.passkey,
  AUTH_METHOD.legacyMfa,
]);

/**
 * PAY-240 + PAY-259: the user has TOTP on and this session was signed in
 * with an MFA method. "none", NULL (written by an image older than 0030)
 * and anything unknown are refused.
 */
export function isMfaSession(
  user: { twoFactorEnabled?: boolean | null | undefined },
  session: { authMethod?: string | null | undefined },
): boolean {
  return (
    user.twoFactorEnabled === true &&
    typeof session.authMethod === "string" &&
    MFA_METHODS.has(session.authMethod)
  );
}

const METHOD_BY_PATH: Record<string, AuthMethod> = {
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

/**
 * PAY-259: passkey limits and session sign-in methods, shared so the server's
 * rules and the web's copy and controls always agree.
 */

/** How a session was signed in, stored on session."authMethod". */
export const AUTH_METHOD = {
  passwordTotp: "password_totp",
  passwordBackupCode: "password_backup_code",
  passkey: "passkey",
  /** Sessions of TOTP-enrolled users alive when migration 0030 ran. */
  legacyMfa: "legacy_mfa",
  none: "none",
} as const;

export type AuthMethod = (typeof AUTH_METHOD)[keyof typeof AUTH_METHOD];

export const MAX_PASSKEYS_PER_USER = 10;
/** Passkey names are 1–64 characters after trim. */
export const MAX_PASSKEY_NAME_LENGTH = 64;

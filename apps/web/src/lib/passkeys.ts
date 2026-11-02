/**
 * PAY-259: passkey management calls and copy for My settings.
 *
 * The plugin's typed client sends the passkey name as a query parameter of
 * generate-register-options, which the server refuses (spec §13 S4: personal
 * data stays out of URLs and proxy logs). So a passkey is added without a
 * name and, when the user typed one, renamed right after; the name only ever
 * travels in a POST body. List, rename and remove go through $fetch with
 * explicit types (the client plugin carries no server endpoint types).
 */

import { authClient } from "./auth-client";
import { authenticatorName } from "./passkey-names";

export const MAX_PASSKEY_NAME_LENGTH = 64;
export const MAX_PASSKEYS = 10;

/** The fields the web shows; the list endpoint also returns the public key. */
export interface PasskeyRow {
  id: string;
  name?: string | null;
  createdAt: string;
  backedUp: boolean;
  aaguid?: string | null;
}

export interface PasskeyError {
  code?: string | undefined;
  message?: string | undefined;
  status: number;
}

export type PasskeyResult = { error: PasskeyError | null };

/** The stored name, else the provider's name from the AAGUID, else "Passkey". */
export function passkeyLabel(row: PasskeyRow): string {
  return row.name?.trim() || authenticatorName(row.aaguid) || "Passkey";
}

export async function listPasskeys(): Promise<{ data: PasskeyRow[]; error: PasskeyError | null }> {
  const { data, error } = await authClient.$fetch<PasskeyRow[]>("/passkey/list-user-passkeys", {
    method: "GET",
  });
  return { data: data ?? [], error: error ?? null };
}

export async function renamePasskey(id: string, name: string): Promise<PasskeyResult> {
  const { error } = await authClient.$fetch("/passkey/update-passkey", {
    method: "POST",
    body: { id, name },
  });
  return { error: error ?? null };
}

export async function removePasskey(id: string): Promise<PasskeyResult> {
  const { error } = await authClient.$fetch("/passkey/delete-passkey", {
    method: "POST",
    body: { id },
  });
  return { error: error ?? null };
}

/**
 * Register a passkey on this device. `renameError` is set when the passkey
 * was added but the typed name could not be saved.
 */
export async function addPasskey(
  name: string,
): Promise<PasskeyResult & { renameError?: PasskeyError }> {
  const res = await authClient.passkey.addPasskey();
  if (res.error) return { error: res.error };
  if (name === "") return { error: null };
  const { error } = await renamePasskey(res.data.id, name);
  return error ? { error: null, renameError: error } : { error: null };
}

/**
 * The browser prompt was cancelled or timed out. SimpleWebAuthn reports a
 * NotAllowedError as a pass-through and an abort as ERROR_CEREMONY_ABORTED.
 */
export function isCancelled(error: PasskeyError): boolean {
  return (
    error.code === "ERROR_CEREMONY_ABORTED" || error.code === "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY"
  );
}

export function isNotFresh(error: PasskeyError): boolean {
  return error.code === "SESSION_NOT_FRESH";
}

const ADD_ERRORS: Record<string, string> = {
  ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED:
    "This device already has a passkey for your account. You don't need to add another one here.",
  PASSKEY_LIMIT_REACHED: `You've added the most passkeys allowed (${MAX_PASSKEYS}). Remove one you no longer use, then try again.`,
  PASSKEY_USER_VERIFICATION_REQUIRED:
    "Your device didn't ask for your fingerprint, face, or device PIN, so the passkey wasn't added. Turn on a screen lock on this device, then try again.",
};
const NAME_INVALID = `Use a name between 1 and ${MAX_PASSKEY_NAME_LENGTH} characters.`;

export function addErrorText(error: PasskeyError): string {
  return (
    ADD_ERRORS[error.code ?? ""] ??
    "Something went wrong and the passkey wasn't added. Please try again."
  );
}

export function renameErrorText(error: PasskeyError): string {
  return error.code === "PASSKEY_NAME_INVALID"
    ? NAME_INVALID
    : "Something went wrong and the name wasn't changed. Please try again.";
}

export const REMOVE_ERROR =
  "Something went wrong and the passkey wasn't removed. Please try again.";

/** Active sessions "Signed in with" cell, from session.authMethod. */
const AUTH_METHOD_LABELS: Record<string, string> = {
  password_totp: "Password + code",
  password_backup_code: "Backup code",
  passkey: "Passkey",
  legacy_mfa: "Earlier sign-in",
};

export function authMethodLabel(method: string | null | undefined): string | null {
  return method ? (AUTH_METHOD_LABELS[method] ?? null) : null;
}

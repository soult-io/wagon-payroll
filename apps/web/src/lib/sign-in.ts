/**
 * PAY-259: sign-in copy shared by the password and passkey paths, and the
 * passkey sign-in itself (the "Sign in with a passkey" button and the email
 * field's passkey suggestions). Password and passkey sign-in share one
 * rate limit, so a throttle reads the same on both.
 */

import { authClient } from "./auth-client";
import type { PasskeyError } from "./passkeys";

export const ACCOUNT_DISABLED = "This account is disabled. Contact your administrator.";
export const TOO_MANY_ATTEMPTS = "Too many sign-in attempts. Wait a minute, then try again.";
const NETWORK_ERROR = "We couldn't reach the server. Check your connection and try again.";
const PASSKEY_FAILED =
  "We couldn't sign you in with a passkey. Try again, or sign in with your password.";
export const PASSKEY_CANCELLED =
  "Passkey sign-in was cancelled. You can try again, or sign in with your password.";

/** Copy for a refused sign-in request that depends only on its status, or null. */
export function credentialStatusText(status: number): string | null {
  if (status === 403) return ACCOUNT_DISABLED;
  if (status === 429) return TOO_MANY_ATTEMPTS;
  return null;
}

/** How a passkey sign-in attempt ended, for the login page. */
export type PasskeySignIn =
  | { kind: "signed-in" }
  /** Replaced by another attempt, or autofill that failed before anyone picked a passkey. */
  | { kind: "silent" }
  | { kind: "cancelled"; text: string }
  | { kind: "error"; text: string };

/**
 * Refusals that mean the person did pick a passkey (from the button or the
 * suggestions), so autofill reports them too. Anything else from autofill
 * (an options request throttled or failing, a challenge that expired) ends
 * silently: nobody asked for it.
 */
const PICKED_PASSKEY_ERRORS: Record<string, string> = {
  PASSKEY_NOT_FOUND:
    "This passkey is no longer linked to your account. Sign in with your password.",
  PASSKEY_USER_VERIFICATION_REQUIRED:
    "Your device didn't confirm it's you (fingerprint, face, or device PIN). Try again, or sign in with your password.",
  BANNED_USER: ACCOUNT_DISABLED,
};

/** A 403 from the gateway (not BANNED_USER): this browser holds a session that isn't a full sign-in. */
function isStaleSession(error: PasskeyError): boolean {
  return error.status === 403 && error.code !== "BANNED_USER";
}

function errorText(error: PasskeyError): string {
  const picked = PICKED_PASSKEY_ERRORS[error.code ?? ""];
  if (picked) return picked;
  return error.status === 429 ? TOO_MANY_ATTEMPTS : PASSKEY_FAILED;
}

async function attempt(autoFill: boolean): Promise<{ error: PasskeyError | null } | "network"> {
  try {
    const { error } = await authClient.signIn.passkey(autoFill ? { autoFill: true } : undefined);
    return { error: (error as PasskeyError | null) ?? null };
  } catch {
    return "network";
  }
}

/**
 * Sign in with a passkey. `autoFill` starts the email field's passkey
 * suggestions (conditional UI): it waits until the person picks one. A
 * newer attempt (the button, or the next autofill) aborts it, which ends
 * silently.
 */
export async function signInWithPasskey(autoFill = false, retried = false): Promise<PasskeySignIn> {
  const result = await attempt(autoFill);
  if (result === "network") {
    return autoFill ? { kind: "silent" } : { kind: "error", text: NETWORK_ERROR };
  }
  const { error } = result;
  if (!error) return { kind: "signed-in" };
  // A session left over from before (not a full sign-in) makes the gateway
  // refuse passkey requests: clear it and try once more.
  if (isStaleSession(error) && !retried) {
    await authClient.signOut();
    return signInWithPasskey(autoFill, true);
  }
  // Aborted by a newer attempt.
  if (error.code === "ERROR_CEREMONY_ABORTED") return { kind: "silent" };
  // NotAllowedError (cancelled or timed out on the device), or the plugin's own cancel.
  if (error.code === "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY" || error.code === "AUTH_CANCELLED") {
    return autoFill ? { kind: "silent" } : { kind: "cancelled", text: PASSKEY_CANCELLED };
  }
  if (autoFill && !PICKED_PASSKEY_ERRORS[error.code ?? ""]) return { kind: "silent" };
  return { kind: "error", text: errorText(error) };
}

/** True when the browser can offer passkeys from the email field's suggestions. */
export async function canAutofillPasskeys(): Promise<boolean> {
  try {
    return (await window.PublicKeyCredential?.isConditionalMediationAvailable?.()) === true;
  } catch {
    return false;
  }
}

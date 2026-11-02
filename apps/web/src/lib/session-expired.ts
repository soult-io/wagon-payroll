/**
 * PAY-6: single registration point for "session expired" handling.
 *
 * Both API clients (the typed wrapper in lib/api.ts and the Better Auth
 * client in lib/auth-client.ts) call notifySessionExpired() on an
 * unexpected 401. main.ts registers the handler — it clears the stale
 * session and redirects straight to /login, so an expired session never
 * surfaces as a pile of error toasts.
 *
 * PAY-259: a 403 { error: "mfa_required" } gets the same treatment. The
 * session was not signed in with an MFA method (for example one created
 * while an older release was running), so the user signs in again.
 */

let handler: (() => void) | null = null;

export function setSessionExpiredHandler(h: () => void): void {
  handler = h;
}

export function notifySessionExpired(): void {
  handler?.();
}

/** True only for the server's MFA refusal: 403 { error: "mfa_required" }. */
export function isMfaRequired(status: number, body: unknown): boolean {
  if (status !== 403 || typeof body !== "object" || body === null) return false;
  return (body as { error?: unknown }).error === "mfa_required";
}

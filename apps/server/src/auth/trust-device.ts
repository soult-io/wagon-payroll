/**
 * PAY-261: better-auth's two-factor "trust device" must never keep a
 * password-only sign-in session (PAY-240: every session passes TOTP).
 * Every request headed for Better Auth drops the trust_device cookie
 * (toHeaders) and the trustDevice body flag (the /api/auth mount).
 */

/** better-auth's two-factor "trust device" cookie, with or without the cookie prefix / __Secure-. */
const TRUST_DEVICE_COOKIE = /^(?:__Secure-|__Host-)?(?:[^=]+\.)?trust_device$/;

/**
 * PAY-261: the Cookie header without any trust_device cookie (undefined
 * when nothing is left). With it, twoFactor keeps a password-only sign-in
 * session for 30 days, so it never reaches Better Auth.
 */
export function withoutTrustDeviceCookie(cookie: string | undefined): string | undefined {
  if (cookie === undefined) return undefined;
  const kept = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !TRUST_DEVICE_COOKIE.test(part.split("=")[0]!.trim()));
  return kept.length > 0 ? kept.join("; ") : undefined;
}

/** PAY-261: drop `trustDevice` so verify-totp never mints a trust_device cookie. */
export function withoutTrustDevice(body: unknown): unknown {
  if (body === null || typeof body !== "object" || !("trustDevice" in body)) return body;
  const { trustDevice: _dropped, ...rest } = body as Record<string, unknown>;
  return rest;
}

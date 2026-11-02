/**
 * PAY-259: passkey relying-party settings, derived only from BASE_URL
 * (D39: anyone who self-hosts picks their own address; no hostname in code).
 *
 * - rpID is the BASE_URL hostname, never a parent domain, so a sibling site
 *   (QA) can never request assertions that are valid for prod.
 * - origin is the BASE_URL origin, set explicitly so the plugin never falls
 *   back to the request's Origin header. The Vite dev server's origin is
 *   added outside production only (same rule as trustedOrigins).
 * - Browsers refuse WebAuthn on an IP-address RP ID, and outside localhost
 *   only over https. Where that fails the passkey endpoints stay disabled
 *   and the web app shows no passkey UI. Changing BASE_URL's hostname later
 *   means every user re-enrolls their passkeys.
 */

/** The Vite dev server's origin, trusted outside production only (auth.ts trustedOrigins too). */
export const DEV_VITE_ORIGIN = "http://localhost:5173";

function isIpLiteral(hostname: string): boolean {
  // URL keeps IPv6 hosts in brackets ("[::1]").
  return hostname.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

export function passkeyRpId(baseUrl: string): string {
  return new URL(baseUrl).hostname;
}

export function passkeyOrigins(baseUrl: string, nodeEnv: string): string[] {
  const origin = new URL(baseUrl).origin;
  return nodeEnv === "production" || origin === DEV_VITE_ORIGIN
    ? [origin]
    : [origin, DEV_VITE_ORIGIN];
}

/** True when a browser will run WebAuthn for this BASE_URL. */
export function passkeysAvailable(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (isIpLiteral(url.hostname)) return false;
  return url.protocol === "https:" || url.hostname === "localhost";
}

/**
 * PAY-217: a former employee (GET /api/me access "w2_only") keeps sign-in
 * only to download the W-2s already given to them online, through the
 * 26 CFR 31.6051-1(j)(6) window. The SPA shows them one screen, the W-2
 * card; the server refuses everything else (403 w2_access_only). Pure
 * helpers, no Vue — the router guard and the API client use them.
 */

/** The former employee's only screen (route path /my/w2). */
export const FORMER_W2_ROUTE_NAME = "my-w2-access";

export type Access = "full" | "w2_only";

/**
 * Where a navigation goes for this access: a W-2-only user is sent to the
 * W-2 screen from every non-public route; anyone else is never redirected.
 */
export function formerEmployeeRedirect(
  access: Access | string | null | undefined,
  to: { name?: string | symbol | null | undefined; meta?: Record<string, unknown> | undefined },
): { name: typeof FORMER_W2_ROUTE_NAME } | null {
  if (access !== "w2_only") return null;
  if (to.meta?.public) return null;
  if (to.name === FORMER_W2_ROUTE_NAME) return null;
  return { name: FORMER_W2_ROUTE_NAME };
}

/** True only for the server's former-employee refusal: 403 { error: "w2_access_only" }. */
export function isW2AccessOnly(status: number, body: unknown): boolean {
  if (status !== 403 || typeof body !== "object" || body === null) return false;
  return (body as { error?: unknown }).error === "w2_access_only";
}

let handler: (() => void) | null = null;

/** main.ts registers the redirect to the W-2 screen. */
export function setW2AccessOnlyHandler(h: () => void): void {
  handler = h;
}

export function notifyW2AccessOnly(): void {
  handler?.();
}

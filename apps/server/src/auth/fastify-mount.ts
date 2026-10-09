/**
 * Mount Better Auth at /api/auth/* (spec 3). Converts Fastify requests to Fetch
 * Requests for auth.handler and streams the response back, preserving Set-Cookie.
 *
 * PAY-217 (brief D217-4): a session whose user is a former employee (W-2
 * only, or no open window) reaches only sign-in, the TOTP / backup-code
 * steps, get-session and sign-out; every other Better Auth path —
 * change-password, update-user, two-factor management, session lists,
 * /admin/*, any future plugin path — answers 403 w2_access_only. A request
 * without a session passes unchanged (sign-in must keep working).
 *
 * PAY-240: a session whose user has no TOTP reaches only sign-in,
 * get-session and sign-out (not the TOTP / backup-code steps, which could
 * enroll TOTP outside onboarding); every other path answers 403 mfa_required.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Auth } from "../auth/auth.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import { formerEmployeeAccess } from "./former-employee.js";
import { type SessionUser, toHeaders } from "../plugins/guards.js";
import { localDate } from "../payroll/run-dates.js";

/** PAY-240: the Better Auth calls a session without TOTP may make (method + exact path). */
const NO_MFA_SESSION_AUTH_PATHS: ReadonlySet<string> = new Set([
  "POST /sign-in/email",
  "GET /get-session",
  "POST /sign-out",
]);

/** PAY-217: the Better Auth calls a former employee's session may make (method + exact path). */
const FORMER_EMPLOYEE_AUTH_PATHS: ReadonlySet<string> = new Set([
  ...NO_MFA_SESSION_AUTH_PATHS,
  "POST /two-factor/verify-totp",
  "POST /backup-code/verify",
]);

/** "METHOD /path" of a request under /api/auth, without the query string. */
function authPathKey(req: FastifyRequest): string {
  const url = req.raw.url ?? "";
  const path = url.split("?")[0]!.slice("/api/auth".length);
  return `${req.method} ${path}`;
}

function toFetchRequest(req: FastifyRequest, config: AppConfig): Request {
  const url = new URL(req.raw.url ?? "/", config.baseUrl);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(","));
  }
  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined) {
    init.body = JSON.stringify(req.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  return new Request(url, init);
}

async function sendFetchResponse(reply: FastifyReply, response: Response): Promise<void> {
  reply.code(response.status);
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") reply.header(key, value);
  });
  for (const cookie of response.headers.getSetCookie()) {
    reply.header("set-cookie", cookie);
  }
  const body = await response.text();
  await reply.send(body.length > 0 ? body : null);
}

export function mountBetterAuth(
  app: FastifyInstance,
  deps: { auth: Auth; db: Db; config: AppConfig; clock?: () => Date },
): void {
  const { auth, db, config } = deps;
  const clock = deps.clock ?? (() => new Date());

  /**
   * The refusal for this request's session on `pathKey` (never one of
   * NO_MFA_SESSION_AUTH_PATHS); null = allowed or no session.
   */
  async function sessionRefusal(
    req: FastifyRequest,
    pathKey: string,
  ): Promise<"mfa_required" | "w2_access_only" | null> {
    const session = await auth.api.getSession({ headers: toHeaders(req) });
    if (!session) return null;
    // Auth's static type omits plugin fields; guards.ts reads the same shape.
    if ((session.user as SessionUser).twoFactorEnabled !== true) return "mfa_required";
    // verify-totp and backup-code/verify (the rest of the set is skipped by the caller).
    if (FORMER_EMPLOYEE_AUTH_PATHS.has(pathKey)) return null;
    const today = localDate(clock(), config.appTz);
    const access = await formerEmployeeAccess(db, session.user.id, today, config.appTz);
    return access.kind === "full" ? null : "w2_access_only";
  }
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    config: {
      rateLimit: {
        max: 10,
        timeWindow: "1 minute",
        // Rate limit applies to credential/MFA endpoints only (spec 3:
        // login + reset + invite-accept). Session reads stay unlimited.
        allowList: (req) => {
          const url = req.raw.url ?? "";
          const sensitive =
            url.includes("/api/auth/sign-in") ||
            url.includes("/api/auth/forget-password") ||
            url.includes("/api/auth/reset-password") ||
            url.includes("/api/auth/two-factor") ||
            url.includes("/api/auth/backup-code");
          return !sensitive;
        },
      },
    },
    handler: async (req, reply) => {
      const pathKey = authPathKey(req);
      // Paths open to every session (no TOTP and former employees alike) skip the lookup.
      if (!NO_MFA_SESSION_AUTH_PATHS.has(pathKey)) {
        const refused = await sessionRefusal(req, pathKey);
        if (refused) return reply.code(403).send({ error: refused });
      }
      const response = await auth.handler(toFetchRequest(req, config));
      await sendFetchResponse(reply, response);
    },
  });
}

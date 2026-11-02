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
 * PAY-240 + PAY-259: a session that is not an MFA session (user without
 * TOTP, or a session not signed in with an MFA method) reaches only sign-in,
 * get-session and sign-out (not the TOTP / backup-code steps, which could
 * enroll TOTP outside onboarding); every other path answers 403 mfa_required.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { normalizeIP } from "@fastify/rate-limit";
import type { Auth } from "../auth/auth.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import { formerEmployeeAccess } from "./former-employee.js";
import { withoutTrustDevice } from "./trust-device.js";
import { type SessionInfo, type SessionUser, toHeaders } from "../plugins/guards.js";
import { isMfaSession } from "./session-method.js";
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
  // PAY-259 (S7): sign in with an existing passkey during the W-2 window;
  // passkey management stays refused (w2_access_only).
  "GET /passkey/generate-authenticate-options",
  "POST /passkey/verify-authentication",
]);

/** PAY-259: passkey sign-in options, limited in their own bucket (one per login page load). */
const PASSKEY_OPTIONS_PATH = "/api/auth/passkey/generate-authenticate-options";

/** Credential / MFA endpoints: 10 per minute per address (spec 3). */
const CREDENTIAL_PATH_PREFIXES = [
  "/api/auth/sign-in",
  "/api/auth/forget-password",
  "/api/auth/reset-password",
  "/api/auth/two-factor",
  "/api/auth/backup-code",
  "/api/auth/passkey/verify-authentication",
];

/** The request path without the query string, exactly as sent. */
function rawPath(req: FastifyRequest): string {
  return (req.raw.url ?? "").split("?")[0] ?? "";
}

/**
 * PAY-259: true when the path is already in normal form. Better Auth
 * resolves "." / ".." segments (new URL), so "/api/auth/./sign-in/email"
 * would reach sign-in while matching none of the rules below; such a path
 * is refused (400) and never reaches Better Auth.
 */
function isNormalPath(path: string): boolean {
  return new URL(path, "http://localhost").pathname === path;
}

function isPasskeyOptionsPath(path: string): boolean {
  return path === PASSKEY_OPTIONS_PATH;
}

/** Rate limited: credential endpoints, and any path not in normal form (fail closed). */
function isCredentialPath(path: string): boolean {
  return !isNormalPath(path) || CREDENTIAL_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** "METHOD /path" of a request under /api/auth, without the query string. */
function authPathKey(req: FastifyRequest): string {
  return `${req.method} ${rawPath(req).slice("/api/auth".length)}`;
}

function toFetchRequest(req: FastifyRequest, config: AppConfig): Request {
  const url = new URL(req.raw.url ?? "/", config.baseUrl);
  const headers = toHeaders(req);
  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined) {
    init.body = JSON.stringify(withoutTrustDevice(req.body));
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
    if (!isMfaSession(session.user as SessionUser, session.session as SessionInfo)) {
      return "mfa_required";
    }
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
        // Rate limit applies to credential/MFA endpoints only (spec 3:
        // login + reset + invite-accept). Session reads stay unlimited.
        // PAY-259: passkey sign-in options (each writes a verification row)
        // get 30 per minute in a bucket of their own. Keys keep the
        // plugin's default grouping (IPv6 by /64).
        max: (req) => (isPasskeyOptionsPath(rawPath(req)) ? 30 : 10),
        timeWindow: "1 minute",
        keyGenerator: (req) => {
          const ip = normalizeIP(req.ip);
          return isPasskeyOptionsPath(rawPath(req)) ? `${ip}:passkey-options` : ip;
        },
        allowList: (req) => {
          const path = rawPath(req);
          return !(isCredentialPath(path) || isPasskeyOptionsPath(path));
        },
      },
    },
    handler: async (req, reply) => {
      if (!isNormalPath(rawPath(req))) return reply.code(400).send({ error: "invalid_path" });
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

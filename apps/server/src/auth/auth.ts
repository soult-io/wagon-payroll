/**
 * Better Auth factory (spec 3).
 *
 * - emailAndPassword with sign-up DISABLED (invite-only), min 12-char
 *   passwords, Argon2id (OWASP params) via custom hash/verify hooks.
 * - Server-side sessions in Postgres; opaque cookie HttpOnly + SameSite=Lax
 *   (+ Secure in production). Absolute lifetime 7d (session refresh disabled
 *   so expiresAt is fixed at creation); idle 12h enforced by the app's
 *   requireAuth guard (see plugins/guards.ts).
 * - Plugins: twoFactor() (TOTP), admin() (user management; impersonation
 *   paths disabled), payrollBackupCodes() (hashed-at-rest backup codes).
 * - after-hook writes auth_events + applies lockout.
 *
 * `buildAuthOptions` is shared with the schema-generation script
 * (scripts/gen-better-auth-sql.ts) so the generated SQL always matches the
 * runtime configuration.
 */

import { betterAuth, type BetterAuthOptions } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { admin } from "better-auth/plugins";
import type { Dialect } from "kysely";
import { hashPassword, verifyPassword } from "./password.js";
import { payrollBackupCodes } from "./backup-codes.js";
import { createAuditHook, lockoutUser } from "./hooks.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";

/**
 * Paths we hard-disable (spec: invite-only; impersonation OFF; BA backup-code
 * paths replaced by ours). PAY-240: TOTP is enrolled only through onboarding
 * (routes/onboarding.ts, via the adapter) and removed only by an admin reset,
 * so BA's own enable / disable / get-totp-uri paths are off.
 */
const DISABLED_PATHS = [
  "/sign-up/email",
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
  "/two-factor/verify-backup-code",
  "/two-factor/generate-backup-codes",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/get-totp-uri",
];

export interface AuthDeps {
  config: AppConfig;
  db: Db;
  dialect: Dialect;
}

export function buildAuthOptions(deps: AuthDeps): BetterAuthOptions {
  const { config, db } = deps;
  const secure = config.nodeEnv === "production";
  return {
    appName: config.totpIssuer,
    baseURL: config.baseUrl,
    secret: config.sessionSecret,
    database: { dialect: deps.dialect, type: "postgres" },
    emailAndPassword: {
      enabled: true,
      // Invite-only: self-registration disabled at code level (spec 3).
      disableSignUp: true,
      requireEmailVerification: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      password: { hash: hashPassword, verify: verifyPassword },
    },
    session: {
      // Absolute 7-day lifetime; refresh disabled so expiresAt is fixed at
      // creation. Idle 12h is enforced in the app guard (spec 3).
      expiresIn: 7 * 24 * 60 * 60,
      disableSessionRefresh: true,
      freshAge: 60 * 60,
    },
    advanced: {
      useSecureCookies: secure,
      cookiePrefix: "payroll",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure,
      },
      ipAddress: {
        ipAddressHeaders: ["x-forwarded-for", "x-real-ip"],
      },
    },
    trustedOrigins:
      config.nodeEnv === "production"
        ? [config.baseUrl]
        : // Dev convenience: the Vite dev server proxies /api but keeps its own Origin.
          [config.baseUrl, "http://localhost:5173"],
    disabledPaths: DISABLED_PATHS,
    plugins: [
      twoFactor({
        issuer: config.totpIssuer,
      }),
      admin({
        defaultRole: "employee",
        adminRoles: ["admin"],
      }),
      payrollBackupCodes({ db }),
    ],
    hooks: {
      after: createAuditHook({
        db,
        config,
        lockout: async (userId, auditCtx) => {
          const ctx = await authContext();
          await lockoutUser(db, ctx.internalAdapter, userId, auditCtx);
        },
      }),
    },
    logger: {
      level: "warn",
    },
  };
}

// The audit hook's lockout path needs the internal adapter, which only exists
// after the auth instance is created. Late-bind via a module-scoped resolver.
let authContextResolver: (() => Auth["$context"]) | null = null;
function authContext() {
  if (!authContextResolver) throw new Error("auth not initialized");
  return authContextResolver();
}

export type Auth = ReturnType<typeof betterAuth>;

export function createAuth(deps: AuthDeps): Auth {
  const options = buildAuthOptions(deps);
  const auth = betterAuth(options);
  authContextResolver = () => auth.$context;
  return auth;
}

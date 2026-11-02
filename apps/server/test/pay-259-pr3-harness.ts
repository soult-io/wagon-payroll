/**
 * PAY-259 PR 3 (passkey server enablement) — shared test harness for
 * pay-259-pr3.test.ts and pay-259-pr3-lifecycle.test.ts.
 *
 * Test author: fail-first against origin/main 735271d; the coder may not edit
 * this file. Synthetic data only (example.com users, generated keys). Never
 * log or snapshot credential bytes: compare, never print.
 */

import { randomUUID } from "node:crypto";
import { company, employees, w2Furnishings } from "@payroll/db";
import { cookieValue, ORIGIN, type TestContext } from "./helpers.js";
import { currentTotp, login, sessionHeader, TEST_PASSWORD, tokenFromLink } from "./flow-helpers.js";
import { inviteUser } from "../src/auth/users.js";
import { formerEmployeeAccess } from "../src/auth/former-employee.js";
import {
  type CeremonyOverrides,
  PASSKEY_CHALLENGE_COOKIE,
  rawCookiePair,
  SoftAuthenticator,
} from "./webauthn-soft-authenticator.js";

export { TEST_PASSWORD, sessionHeader };
export type Res = Awaited<ReturnType<TestContext["app"]["inject"]>>;

/** WebAuthn RP for the test app (helpers.ts baseUrl "http://localhost"). */
export const RP_ID = "localhost";
export const RP_ORIGIN = "http://localhost";

export const PASSKEY_ENDPOINTS: { method: "GET" | "POST"; path: string }[] = [
  { method: "GET", path: "/passkey/generate-register-options" },
  { method: "POST", path: "/passkey/verify-registration" },
  { method: "GET", path: "/passkey/generate-authenticate-options" },
  { method: "POST", path: "/passkey/verify-authentication" },
  { method: "GET", path: "/passkey/list-user-passkeys" },
  { method: "POST", path: "/passkey/delete-passkey" },
  { method: "POST", path: "/passkey/update-passkey" },
];

export function newAuthenticator(origin = RP_ORIGIN, rpId = RP_ID): SoftAuthenticator {
  return new SoftAuthenticator(rpId, origin);
}

/** A per-file client-address factory (every test uses its own addresses: rate limits). */
export function ipFactory(second: number): () => string {
  let seq = 0;
  return () => {
    seq += 1;
    return `10.${second}.${Math.floor(seq / 250) % 250}.${(seq % 250) + 1}`;
  };
}

/** Better Auth APIError body.code, else the app's { error } value. */
export function codeOf(res: { body: string }): unknown {
  try {
    const j = JSON.parse(res.body) as { code?: unknown; error?: unknown };
    return j.code ?? j.error;
  } catch {
    return undefined;
  }
}

export function tokenOf(cookie: string): string {
  return cookie.split(".")[0]!;
}

export interface Harness {
  t: TestContext;
  ip: () => string;
  /** Request under /api/auth with optional session cookie and extra raw cookie pair. */
  auth(
    method: "GET" | "POST",
    path: string,
    o?: { cookie?: string; extra?: string | null; ip?: string; ua?: string; payload?: unknown },
  ): Promise<Res>;
  onboard(
    email: string,
    role?: "admin" | "employee",
  ): Promise<{ userId: string; backupCodes: string[] }>;
  /** Onboard + password/TOTP sign-in (a fresh password_totp session). */
  totpUser(
    email: string,
    role?: "admin" | "employee",
  ): Promise<{ userId: string; cookie: string; backupCodes: string[] }>;
  backupCodeSignIn(email: string, code: string): Promise<string>;
  /** Insert a passkey row for the authenticator's real key (bypasses registration). */
  seedPasskey(
    userId: string,
    a: SoftAuthenticator,
    o?: { counter?: number; name?: string },
  ): Promise<string>;
  register(
    cookie: string,
    a: SoftAuthenticator,
    o?: {
      name?: unknown;
      createSession?: boolean;
      overrides?: CeremonyOverrides;
      query?: string;
      ip?: string;
      between?: () => Promise<void>;
    },
  ): Promise<{ opt: Res; res: Res | null }>;
  passkeySignIn(
    a: SoftAuthenticator,
    o?: { overrides?: CeremonyOverrides; ip?: string; ua?: string; cookie?: string },
  ): Promise<{ opt: Res; res: Res; session: string | null; challenge: string | null }>;
  passkeys(
    userId: string,
  ): Promise<
    { id: string; name: string | null; credentialID: string; counter: number; publicKey: string }[]
  >;
  events(
    userId: string | null,
    event?: string,
  ): Promise<{ event: string; user_id: string | null }[]>;
  sessionCount(userId: string): Promise<number>;
  sessionRow(cookie: string): Promise<{ authMethod: string | null; userId: string } | null>;
  ageSession(cookie: string, minutes: number): Promise<void>;
  setMethod(cookie: string, method: string): Promise<void>;
  makeFormerW2Only(userId: string, legalName: string, today: string): Promise<number>;
}

export function harness(t: TestContext, ipSecond: number): Harness {
  const ip = ipFactory(ipSecond);

  const h: Harness = {
    t,
    ip,

    async auth(method, path, o = {}) {
      const addr = o.ip ?? ip();
      const cookies = [
        o.cookie ? `payroll.session_token=${o.cookie}` : null,
        o.extra ?? null,
      ].filter((c): c is string => typeof c === "string");
      return t.app.inject({
        method,
        url: `/api/auth${path}`,
        headers: {
          ...ORIGIN,
          "x-forwarded-for": addr,
          ...(o.ua ? { "user-agent": o.ua } : {}),
          ...(cookies.length > 0 ? { cookie: cookies.join("; ") } : {}),
        },
        remoteAddress: addr,
        ...(method === "POST" ? { payload: (o.payload ?? {}) as object } : {}),
      });
    },

    async onboard(email, role = "employee") {
      const invite = await inviteUser(
        { auth: t.auth, db: t.db, config: t.config },
        { name: email.split("@")[0]!, email, role },
        null,
      );
      const token = tokenFromLink(invite.setupLink);
      const post = (url: string, payload: unknown) => {
        const addr = ip();
        return t.app.inject({
          method: "POST",
          url,
          headers: { ...ORIGIN, "x-forwarded-for": addr },
          remoteAddress: addr,
          payload: payload as object,
        });
      };
      for (const [url, payload] of [
        ["/api/onboarding/verify-token", { token }],
        ["/api/onboarding/set-password", { token, password: TEST_PASSWORD }],
        ["/api/onboarding/totp-enable", { token }],
      ] as const) {
        const res = await post(url, payload);
        if (res.statusCode !== 200) throw new Error(`${url} ${res.statusCode}: ${res.body}`);
      }
      const code = await currentTotp(t, invite.userId);
      const verify = await post("/api/onboarding/totp-verify", { token, code });
      if (verify.statusCode !== 200)
        throw new Error(`totp-verify ${verify.statusCode}: ${verify.body}`);
      const { backupCodes } = verify.json() as { backupCodes: string[] };
      return { userId: invite.userId, backupCodes };
    },

    async totpUser(email, role = "employee") {
      const { userId, backupCodes } = await h.onboard(email, role);
      const { sessionCookie } = await login(t, email, TEST_PASSWORD, { remoteAddress: ip() });
      return { userId, cookie: sessionCookie, backupCodes };
    },

    async backupCodeSignIn(email, code) {
      const addr = ip();
      const signIn = await t.app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { ...ORIGIN, "x-forwarded-for": addr },
        remoteAddress: addr,
        payload: { email, password: TEST_PASSWORD },
      });
      const twoFactor = cookieValue(signIn.headers["set-cookie"], "payroll.two_factor");
      if (!twoFactor) throw new Error(`no 2FA challenge: ${signIn.statusCode}`);
      const addr2 = ip();
      const res = await t.app.inject({
        method: "POST",
        url: "/api/auth/backup-code/verify",
        headers: { ...ORIGIN, "x-forwarded-for": addr2, cookie: `payroll.two_factor=${twoFactor}` },
        remoteAddress: addr2,
        payload: { code },
      });
      const cookie = cookieValue(res.headers["set-cookie"], "payroll.session_token");
      if (res.statusCode !== 200 || !cookie) throw new Error(`backup-code ${res.statusCode}`);
      return cookie;
    },

    async seedPasskey(userId, a, o = {}) {
      const id = randomUUID();
      await t.pglite.query(
        `insert into "passkey" ("id","name","publicKey","userId","credentialID","counter","deviceType","backedUp","transports","createdAt")
         values ($1,$2,$3,$4,$5,$6,'singleDevice',false,'internal',now())`,
        [id, o.name ?? null, a.storedPublicKey, userId, a.id, o.counter ?? 0],
      );
      a.signCount = o.counter ?? 0;
      return id;
    },

    async register(cookie, a, o = {}) {
      const addr = o.ip ?? ip();
      const opt = await h.auth("GET", `/passkey/generate-register-options${o.query ?? ""}`, {
        cookie,
        ip: addr,
      });
      if (opt.statusCode !== 200) return { opt, res: null };
      const challenge = rawCookiePair(opt.headers["set-cookie"], PASSKEY_CHALLENGE_COOKIE);
      if (!challenge) throw new Error("no passkey challenge cookie on generate-register-options");
      await o.between?.();
      const payload: Record<string, unknown> = {
        response: a.register(opt.json() as { challenge: string }, o.overrides),
      };
      if (o.name !== undefined) payload.name = o.name;
      if (o.createSession !== undefined) payload.createSession = o.createSession;
      const res = await h.auth("POST", "/passkey/verify-registration", {
        cookie,
        extra: challenge,
        ip: addr,
        payload,
      });
      return { opt, res };
    },

    async passkeySignIn(a, o = {}) {
      const addr = o.ip ?? ip();
      const opt = await h.auth("GET", "/passkey/generate-authenticate-options", {
        ip: addr,
        ...(o.ua ? { ua: o.ua } : {}),
        ...(o.cookie ? { cookie: o.cookie } : {}),
      });
      if (opt.statusCode !== 200) {
        throw new Error(
          `generate-authenticate-options ${opt.statusCode}: ${opt.body.slice(0, 80)}`,
        );
      }
      const challenge = rawCookiePair(opt.headers["set-cookie"], PASSKEY_CHALLENGE_COOKIE);
      const res = await h.auth("POST", "/passkey/verify-authentication", {
        ip: addr,
        extra: challenge,
        ...(o.ua ? { ua: o.ua } : {}),
        ...(o.cookie ? { cookie: o.cookie } : {}),
        payload: { response: a.assert(opt.json() as { challenge: string }, o.overrides) },
      });
      return {
        opt,
        res,
        session: cookieValue(res.headers["set-cookie"], "payroll.session_token"),
        challenge,
      };
    },

    async passkeys(userId) {
      const r = await t.pglite.query<{
        id: string;
        name: string | null;
        credentialID: string;
        counter: number;
        publicKey: string;
      }>(
        `select "id","name","credentialID","counter","publicKey" from "passkey" where "userId" = $1 order by "createdAt","id"`,
        [userId],
      );
      return r.rows;
    },

    async events(userId, event) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (userId === null) where.push(`user_id is null`);
      else {
        params.push(userId);
        where.push(`user_id = $${params.length}`);
      }
      if (event) {
        params.push(event);
        where.push(`event = $${params.length}`);
      }
      const r = await t.pglite.query<{ event: string; user_id: string | null }>(
        `select event, user_id from auth_events where ${where.join(" and ")} order by id`,
        params,
      );
      return r.rows;
    },

    async sessionCount(userId) {
      const r = await t.pglite.query<{ n: number }>(
        `select count(*)::int as n from "session" where "userId" = $1`,
        [userId],
      );
      return r.rows[0]!.n;
    },

    async sessionRow(cookie) {
      const r = await t.pglite.query<{ authMethod: string | null; userId: string }>(
        `select "authMethod", "userId" from "session" where "token" = $1`,
        [tokenOf(cookie)],
      );
      return r.rows[0] ?? null;
    },

    async ageSession(cookie, minutes) {
      const at = new Date(Date.now() - minutes * 60_000);
      const r = await t.pglite.query(`update "session" set "createdAt" = $1 where "token" = $2`, [
        at,
        tokenOf(cookie),
      ]);
      if (r.affectedRows !== 1) throw new Error("ageSession: no session row");
    },

    async setMethod(cookie, method) {
      const r = await t.pglite.query(`update "session" set "authMethod" = $1 where "token" = $2`, [
        method,
        tokenOf(cookie),
      ]);
      if (r.affectedRows !== 1) throw new Error("setMethod: no session row");
    },

    async makeFormerW2Only(userId, legalName, today) {
      const [co] = await t.db.insert(company).values({ legalName: "Test Co" }).returning();
      const [emp] = await t.db
        .insert(employees)
        .values({
          userId,
          companyId: co!.id,
          legalName,
          hireDate: "2025-01-01",
          status: "terminated",
          terminationDate: "2025-12-31",
        })
        .returning();
      await t.db.insert(w2Furnishings).values({
        employeeId: emp!.id,
        taxYear: 2025,
        boxesHash: "a".repeat(64),
        corrected: false,
        method: "portal_notice",
        furnishedAt: new Date("2026-01-15T15:00:00Z"),
      });
      const access = await formerEmployeeAccess(t.db, userId, today, t.config.appTz);
      if (access.kind !== "w2_only") throw new Error(`fixture not w2_only: ${access.kind}`);
      return emp!.id;
    },
  };
  return h;
}

/**
 * PAY-259 PR 1 — passkeys: schema + inert plugin + per-session sign-in marker.
 *
 * - T11 / T10 / unit: every new session row records how it was signed in
 *   (session."authMethod"): password+TOTP, password+backup code, passkey,
 *   change-password carries the current session's method forward, anything
 *   else "none". The marker is written, not enforced: sign-in still reaches
 *   GET /api/me.
 * - T16: the @better-auth/passkey plugin is registered; on an IP-literal
 *   BASE_URL (passkeys unavailable, PAY-259 PR 3) every one of its
 *   seven paths is disabled (404 through /api/auth, nothing written), and the
 *   Better Auth endpoint inventory is pinned.
 * - T20: passkey table constraints (unique credentialID, cascade on user delete).
 * - T21: no drift between the checked-in Better Auth SQL and the runtime options.
 * - T22: migration 0030 applies on a pre-0030 database holding a live session
 *   (backfilled to 'legacy_mfa' for a TOTP-enrolled user, else 'none') and
 *   touches no app table.
 * - update-session cannot set authMethod (input:false).
 *
 * Test author: fail-first against 42d2ed9; the coder may not edit this file.
 * Synthetic data only (example.com users).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as dbSchema from "@payroll/db";
import { authTwoFactor, authUser } from "@payroll/db";
import { createTestApp, cookieValue, ORIGIN, workspaceRoot, type TestContext } from "./helpers.js";
import {
  currentTotp,
  inviteAndOnboard,
  login,
  sessionHeader,
  TEST_PASSWORD,
  tokenFromLink,
} from "./flow-helpers.js";
import { inviteUser } from "../src/auth/users.js";

const ROOT = workspaceRoot(dirname(fileURLToPath(import.meta.url)));
const DRIZZLE_DIR = resolve(ROOT, "packages/db/drizzle");
const NEW_PASSWORD = "violet-anchor-quarry-lantern-42";

// Contract modules are loaded lazily so each test reports its own failure.
type SessionMethodModule = {
  AUTH_METHOD: Record<string, string>;
  authMethodForPath: (path: string | undefined, current?: string | null) => string;
};
type BaSchemaModule = {
  BA_MIGRATIONS: string[];
  pendingBetterAuthSql: () => Promise<string>;
};
const loadSessionMethod = () =>
  import("../src/auth/session-method.js") as unknown as Promise<SessionMethodModule>;
const loadBaSchema = () => import("../scripts/ba-schema.js") as unknown as Promise<BaSchemaModule>;

const PASSKEY_ENDPOINTS: { method: "GET" | "POST"; path: string }[] = [
  { method: "GET", path: "/passkey/generate-register-options" },
  { method: "POST", path: "/passkey/verify-registration" },
  { method: "GET", path: "/passkey/generate-authenticate-options" },
  { method: "POST", path: "/passkey/verify-authentication" },
  { method: "GET", path: "/passkey/list-user-passkeys" },
  { method: "POST", path: "/passkey/delete-passkey" },
  { method: "POST", path: "/passkey/update-passkey" },
];

/**
 * Enabled Better Auth endpoint paths (auth.api paths minus disabledPaths),
 * computed from origin/main 42d2ed9, plus the seven passkey paths PAY-259
 * PR 3 enables on http://localhost. A new plugin path, or a disabled path
 * coming back, must change this list on purpose.
 */
const ENABLED_AUTH_PATHS = [
  "/account-info",
  "/admin/ban-user",
  "/admin/create-user",
  "/admin/get-user",
  "/admin/has-permission",
  "/admin/list-user-sessions",
  "/admin/list-users",
  "/admin/remove-user",
  "/admin/revoke-user-session",
  "/admin/revoke-user-sessions",
  "/admin/set-role",
  "/admin/set-user-password",
  "/admin/unban-user",
  "/admin/update-user",
  "/backup-code/verify",
  "/callback/:id",
  "/change-email",
  "/change-password",
  "/delete-user",
  "/delete-user/callback",
  "/error",
  "/get-access-token",
  "/get-session",
  "/link-social",
  "/list-accounts",
  "/list-sessions",
  "/ok",
  "/passkey/delete-passkey",
  "/passkey/generate-authenticate-options",
  "/passkey/generate-register-options",
  "/passkey/list-user-passkeys",
  "/passkey/update-passkey",
  "/passkey/verify-authentication",
  "/passkey/verify-registration",
  "/refresh-token",
  "/request-password-reset",
  "/reset-password",
  "/reset-password/:token",
  "/revoke-other-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/send-verification-email",
  "/sign-in/email",
  "/sign-in/social",
  "/sign-out",
  "/two-factor/verify-totp",
  "/unlink-account",
  "/update-session",
  "/update-user",
  "/verify-email",
  "/verify-password",
];

// ---------------------------------------------------------------- helpers

let ipSeq = 0;
function freshIp(): string {
  ipSeq += 1;
  return `10.59.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
}

/** The session row's id part of a signed cookie value ("<token>.<sig>"). */
function tokenOf(cookie: string): string {
  return cookie.split(".")[0]!;
}

async function sessionMethodByCookie(t: TestContext, cookie: string): Promise<unknown> {
  const r = await t.pglite.query<{ authMethod: unknown }>(
    `select "authMethod" from "session" where "token" = $1`,
    [tokenOf(cookie)],
  );
  if (r.rows.length !== 1) throw new Error(`expected one session row, got ${r.rows.length}`);
  return r.rows[0]!.authMethod;
}

async function sessionExists(t: TestContext, cookie: string): Promise<boolean> {
  const r = await t.pglite.query(`select 1 from "session" where "token" = $1`, [tokenOf(cookie)]);
  return r.rows.length === 1;
}

async function countRows(t: TestContext, table: string): Promise<number> {
  const r = await t.pglite.query<{ n: number }>(`select count(*)::int as n from "${table}"`);
  return r.rows[0]!.n;
}

async function me(t: TestContext, cookie: string) {
  return t.app.inject({ method: "GET", url: "/api/me", headers: sessionHeader(cookie) });
}

async function challenge(t: TestContext, email: string): Promise<string> {
  const ip = freshIp();
  const res = await t.app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { ...ORIGIN, "x-forwarded-for": ip },
    remoteAddress: ip,
    payload: { email, password: TEST_PASSWORD },
  });
  const c = cookieValue(res.headers["set-cookie"], "payroll.two_factor");
  if (!c) throw new Error(`no 2FA challenge: ${res.statusCode} ${res.body}`);
  return c;
}

async function outcome(pg: PGlite, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await pg.query(sql, params);
    return "ok";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

interface Journal {
  entries: { idx: number; tag: string }[];
}
function journal(): Journal {
  return JSON.parse(readFileSync(resolve(DRIZZLE_DIR, "meta/_journal.json"), "utf8")) as Journal;
}
function statementsOf(tag: string): string[] {
  return readFileSync(resolve(DRIZZLE_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
/** Strip SQL line comments so a leading header comment does not hide the statement. */
function sqlBody(stmt: string): string {
  return stmt
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .trim();
}
async function applyTag(pg: PGlite, tag: string): Promise<void> {
  for (const stmt of statementsOf(tag)) {
    try {
      await pg.exec(stmt);
    } catch (err) {
      // Same carve-out as helpers.runMigrations: PGlite lacks btree_gist for 0001.
      if (tag.startsWith("0001")) continue;
      throw err;
    }
  }
}

// ---------------------------------------------------------------- shared app

let t: TestContext;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

// ---------------------------------------------------------------- unit

describe("authMethodForPath (session-method.ts)", () => {
  it("AUTH_METHOD holds the five marker values", async () => {
    const { AUTH_METHOD } = await loadSessionMethod();
    expect(AUTH_METHOD).toEqual({
      passwordTotp: "password_totp",
      passwordBackupCode: "password_backup_code",
      passkey: "passkey",
      legacyMfa: "legacy_mfa",
      none: "none",
    });
  });

  it("maps each sign-in path to its method", async () => {
    const { authMethodForPath } = await loadSessionMethod();
    expect(authMethodForPath("/two-factor/verify-totp")).toBe("password_totp");
    expect(authMethodForPath("/backup-code/verify")).toBe("password_backup_code");
    expect(authMethodForPath("/passkey/verify-authentication")).toBe("passkey");
    // `current` is ignored outside /change-password.
    expect(authMethodForPath("/two-factor/verify-totp", "passkey")).toBe("password_totp");
    expect(authMethodForPath("/backup-code/verify", "password_totp")).toBe("password_backup_code");
  });

  it("/change-password carries the current session's method, else 'none'", async () => {
    const { authMethodForPath } = await loadSessionMethod();
    expect(authMethodForPath("/change-password", "password_totp")).toBe("password_totp");
    expect(authMethodForPath("/change-password", "password_backup_code")).toBe(
      "password_backup_code",
    );
    expect(authMethodForPath("/change-password", "passkey")).toBe("passkey");
    expect(authMethodForPath("/change-password", "legacy_mfa")).toBe("legacy_mfa");
    expect(authMethodForPath("/change-password", null)).toBe("none");
    expect(authMethodForPath("/change-password", undefined)).toBe("none");
    expect(authMethodForPath("/change-password", "")).toBe("none");
    expect(authMethodForPath("/change-password")).toBe("none");
  });

  it("any other path, or no path, is 'none'", async () => {
    const { authMethodForPath } = await loadSessionMethod();
    expect(authMethodForPath(undefined)).toBe("none");
    expect(authMethodForPath(undefined, "password_totp")).toBe("none");
    expect(authMethodForPath("")).toBe("none");
    expect(authMethodForPath("/sign-in/email")).toBe("none");
    expect(authMethodForPath("/sign-in/email", "password_totp")).toBe("none");
    expect(authMethodForPath("/admin/impersonate-user")).toBe("none");
    expect(authMethodForPath("/passkey/verify-registration")).toBe("none");
    expect(authMethodForPath("/two-factor/verify-totp/")).toBe("none");
    expect(authMethodForPath("/api/auth/two-factor/verify-totp")).toBe("none");
  });
});

// ---------------------------------------------------------------- schema exports

describe("@payroll/db exports the new columns/tables", () => {
  it("authSession.authMethod and authPasskey exist", () => {
    const schema = dbSchema as Record<string, unknown>;
    expect(schema.authPasskey).toBeDefined();
    expect((schema.authSession as Record<string, unknown>).authMethod).toBeDefined();
    const passkey = schema.authPasskey as Record<string, unknown> | undefined;
    for (const col of [
      "id",
      "name",
      "publicKey",
      "userId",
      "credentialID",
      "counter",
      "deviceType",
      "backedUp",
      "transports",
      "createdAt",
      "aaguid",
    ]) {
      expect(passkey?.[col], `authPasskey.${col}`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------- T11

describe("T11 sign-in writes session.authMethod (marker written, not enforced)", () => {
  it("password + TOTP → 'password_totp'; /api/me 200", async () => {
    const { email } = await inviteAndOnboard(t, { email: "pay259-totp@example.com" });
    const { sessionCookie } = await login(t, email, TEST_PASSWORD, { remoteAddress: freshIp() });
    expect((await me(t, sessionCookie)).statusCode).toBe(200);
    expect(await sessionMethodByCookie(t, sessionCookie)).toBe("password_totp");
  });

  it("password + backup code → 'password_backup_code'; /api/me 200", async () => {
    const email = "pay259-backup@example.com";
    const { backupCodes } = await inviteAndOnboard(t, { email });
    const twoFactorCookie = await challenge(t, email);
    const ip = freshIp();
    const ok = await t.app.inject({
      method: "POST",
      url: "/api/auth/backup-code/verify",
      headers: {
        ...ORIGIN,
        "x-forwarded-for": ip,
        cookie: `payroll.two_factor=${twoFactorCookie}`,
      },
      remoteAddress: ip,
      payload: { code: backupCodes[0] },
    });
    expect(ok.statusCode).toBe(200);
    const cookie = cookieValue(ok.headers["set-cookie"], "payroll.session_token");
    expect(cookie).toBeTruthy();
    expect((await me(t, cookie!)).statusCode).toBe(200);
    expect(await sessionMethodByCookie(t, cookie!)).toBe("password_backup_code");
  });

  it("a bare /sign-in/email session (user without TOTP) → 'none'", async () => {
    const email = "pay259-bare@example.com";
    const { userId } = await inviteAndOnboard(t, { email });
    // PAY-240 fixture: put the user in the "2FA off" state so BA issues the session directly.
    await t.db.update(authUser).set({ twoFactorEnabled: false }).where(eq(authUser.id, userId));
    await t.db.delete(authTwoFactor).where(eq(authTwoFactor.userId, userId));
    const ip = freshIp();
    const res = await t.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { ...ORIGIN, "x-forwarded-for": ip },
      remoteAddress: ip,
      payload: { email, password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const cookie = cookieValue(res.headers["set-cookie"], "payroll.session_token");
    expect(cookie).toBeTruthy();
    expect(await sessionMethodByCookie(t, cookie!)).toBe("none");
  });

  it("the 2FA challenge itself leaves no session behind", async () => {
    const email = "pay259-challenge@example.com";
    const { userId } = await inviteAndOnboard(t, { email });
    await challenge(t, email);
    const r = await t.pglite.query(`select 1 from "session" where "userId" = $1`, [userId]);
    expect(r.rows.length).toBe(0);
    // And the column exists (fails before migration 0030).
    expect(await outcome(t.pglite, `select "authMethod" from "session" limit 1`)).toBe("ok");
  });
});

// ---------------------------------------------------------------- T10

describe("T10 /change-password carries the method to the replacement session", () => {
  it("revokeOtherSessions:true from a password_totp session → new row 'password_totp'; /api/me 200", async () => {
    const { email } = await inviteAndOnboard(t, { email: "pay259-chpw@example.com" });
    const { sessionCookie: oldCookie } = await login(t, email, TEST_PASSWORD, {
      remoteAddress: freshIp(),
    });
    const ip = freshIp();
    const res = await t.app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { ...sessionHeader(oldCookie), "x-forwarded-for": ip },
      remoteAddress: ip,
      payload: {
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
        revokeOtherSessions: true,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const newCookie = cookieValue(res.headers["set-cookie"], "payroll.session_token");
    expect(newCookie).toBeTruthy();
    expect(tokenOf(newCookie!)).not.toBe(tokenOf(oldCookie));
    expect(await sessionExists(t, oldCookie)).toBe(false);
    expect((await me(t, newCookie!)).statusCode).toBe(200);
    expect(await sessionMethodByCookie(t, newCookie!)).toBe("password_totp");
  });
});

// ---------------------------------------------------------------- update-session

describe("authMethod is not client-settable", () => {
  it("POST /update-session {authMethod:'passkey'} from a password_totp session → 4xx; row unchanged", async () => {
    const { email } = await inviteAndOnboard(t, { email: "pay259-updsess@example.com" });
    const { sessionCookie } = await login(t, email, TEST_PASSWORD, { remoteAddress: freshIp() });
    expect(await sessionMethodByCookie(t, sessionCookie)).toBe("password_totp");
    const ip = freshIp();
    const res = await t.app.inject({
      method: "POST",
      url: "/api/auth/update-session",
      headers: { ...sessionHeader(sessionCookie), "x-forwarded-for": ip },
      remoteAddress: ip,
      payload: { authMethod: "passkey" },
    });
    expect(await sessionMethodByCookie(t, sessionCookie)).toBe("password_totp");
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    expect(res.statusCode, res.body).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------- T16

describe("T16 passkey plugin is registered but inert where passkeys are unavailable", () => {
  // PAY-259 PR 3: passkeys open only on an https host or localhost. On an IP
  // literal BASE_URL the seven paths stay disabled.
  const IP_BASE = "http://127.0.0.1:8927";
  const IP_ORIGIN = { origin: IP_BASE };
  let u: TestContext;
  beforeAll(async () => {
    u = await createTestApp({ baseUrl: IP_BASE });
  });
  afterAll(async () => {
    await u.close();
  });

  function post(url: string, payload: unknown, cookie?: string) {
    const ip = freshIp();
    return u.app.inject({
      method: "POST",
      url,
      headers: { ...IP_ORIGIN, "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) },
      remoteAddress: ip,
      payload: payload as object,
    });
  }

  /** Invite + onboarding + password/TOTP sign-in on the IP-literal app. */
  async function ipSession(email: string): Promise<string> {
    const invite = await inviteUser(
      { auth: u.auth, db: u.db, config: u.config },
      { name: email.split("@")[0]!, email, role: "employee" },
      null,
    );
    const token = tokenFromLink(invite.setupLink);
    for (const [url, payload] of [
      ["/api/onboarding/verify-token", { token }],
      ["/api/onboarding/set-password", { token, password: TEST_PASSWORD }],
      ["/api/onboarding/totp-enable", { token }],
    ] as const) {
      const res = await post(url, payload);
      if (res.statusCode !== 200) throw new Error(`${url} ${res.statusCode}: ${res.body}`);
    }
    const enrol = await post("/api/onboarding/totp-verify", {
      token,
      code: await currentTotp(u, invite.userId),
    });
    if (enrol.statusCode !== 200) throw new Error(`totp-verify ${enrol.statusCode}`);
    const signIn = await post("/api/auth/sign-in/email", { email, password: TEST_PASSWORD });
    const twoFactor = cookieValue(signIn.headers["set-cookie"], "payroll.two_factor");
    if (!twoFactor) throw new Error(`no 2FA challenge: ${signIn.statusCode} ${signIn.body}`);
    const verify = await post(
      "/api/auth/two-factor/verify-totp",
      { code: await currentTotp(u, invite.userId) },
      `payroll.two_factor=${twoFactor}`,
    );
    const cookie = cookieValue(verify.headers["set-cookie"], "payroll.session_token");
    if (!cookie) throw new Error(`verify-totp ${verify.statusCode}: ${verify.body}`);
    return cookie;
  }

  it("the plugin is registered and all seven paths are in disabledPaths", () => {
    const api = u.auth.api as unknown as Record<string, { path?: unknown }>;
    const registered = new Set(
      Object.values(api)
        .map((e) => e?.path)
        .filter((p): p is string => typeof p === "string"),
    );
    const disabled = new Set(u.auth.options.disabledPaths ?? []);
    const pluginIds = (u.auth.options.plugins ?? []).map((p) => p.id);
    expect(pluginIds).toContain("passkey");
    for (const { path } of PASSKEY_ENDPOINTS) {
      expect(registered.has(path), `registered ${path}`).toBe(true);
      expect(disabled.has(path), `disabled ${path}`).toBe(true);
    }
  });

  it("each passkey path answers 404 through /api/auth, with and without a session, and writes nothing", async () => {
    const sessionCookie = await ipSession("pay259-passkey@example.com");
    const passkeyBefore = await outcome(u.pglite, `select 1 from "passkey" limit 1`);
    const verificationBefore = await countRows(u, "verification");

    for (const withSession of [false, true]) {
      for (const { method, path } of PASSKEY_ENDPOINTS) {
        const ip = freshIp();
        const headers = withSession
          ? {
              ...IP_ORIGIN,
              cookie: `payroll.session_token=${sessionCookie}`,
              "x-forwarded-for": ip,
            }
          : { ...IP_ORIGIN, "x-forwarded-for": ip };
        const res = await u.app.inject({
          method,
          url: `/api/auth${path}`,
          headers,
          remoteAddress: ip,
          ...(method === "POST"
            ? {
                payload: {
                  id: "x",
                  name: "x",
                  response: { id: "x", rawId: "x", type: "public-key", response: {} },
                },
              }
            : {}),
        });
        expect(res.statusCode, `${method} ${path} session=${withSession}`).toBe(404);
      }
    }

    expect(passkeyBefore).toBe("ok"); // table exists (migration 0030)
    expect(await countRows(u, "passkey")).toBe(0);
    expect(await countRows(u, "verification")).toBe(verificationBefore);
    // The session survives and still works.
    const meRes = await u.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { ...IP_ORIGIN, cookie: `payroll.session_token=${sessionCookie}` },
    });
    expect(meRes.statusCode).toBe(200);
  });
});

describe("T16 Better Auth endpoint inventory (passkeys available on http://localhost)", () => {
  it("endpoint inventory: enabled Better Auth paths equal the checked-in allowlist", () => {
    const api = t.auth.api as unknown as Record<string, { path?: unknown }>;
    const disabled = new Set(t.auth.options.disabledPaths ?? []);
    const enabled = [
      ...new Set(
        Object.values(api)
          .map((e) => e?.path)
          .filter((p): p is string => typeof p === "string"),
      ),
    ]
      .filter((p) => !disabled.has(p))
      .sort();
    expect(enabled).toEqual(ENABLED_AUTH_PATHS);
    for (const { path } of PASSKEY_ENDPOINTS) expect(enabled).toContain(path);
  });
});

// ---------------------------------------------------------------- T20

describe("T20 passkey table constraints", () => {
  async function insertUser(id: string): Promise<void> {
    await t.pglite.query(
      `insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       values ($1, $1, $2, false, now(), now())`,
      [id, `${id}@example.com`],
    );
  }
  const insertPasskey = (id: string, userId: string, credentialID: string) =>
    outcome(
      t.pglite,
      `insert into "passkey" ("id", "name", "publicKey", "userId", "credentialID", "counter", "deviceType", "backedUp", "transports", "createdAt", "aaguid")
       values ($1, 'Synthetic key', 'pk-synthetic', $2, $3, 0, 'singleDevice', false, 'internal', now(), null)`,
      [id, userId, credentialID],
    );

  it("unique credentialID across users; many per user; cascade on user delete", async () => {
    await insertUser("pay259-t20-a");
    await insertUser("pay259-t20-b");

    expect(await insertPasskey("pk-a1", "pay259-t20-a", "cred-1")).toBe("ok");
    expect(await insertPasskey("pk-b1", "pay259-t20-b", "cred-1")).toMatch(/duplicate key|unique/i);
    expect(await insertPasskey("pk-a2", "pay259-t20-a", "cred-2")).toBe("ok");

    const before = await t.pglite.query<{ n: number }>(
      `select count(*)::int as n from "passkey" where "userId" = 'pay259-t20-a'`,
    );
    expect(before.rows[0]!.n).toBe(2);

    await t.pglite.query(`delete from "user" where "id" = 'pay259-t20-a'`);
    const after = await t.pglite.query<{ n: number }>(
      `select count(*)::int as n from "passkey" where "userId" = 'pay259-t20-a'`,
    );
    expect(after.rows[0]!.n).toBe(0);
  });

  it("required columns are NOT NULL and userId must reference a user", async () => {
    await insertUser("pay259-t20-c");
    expect(await insertPasskey("pk-orphan", "pay259-no-such-user", "cred-orphan")).toMatch(
      /foreign key/i,
    );
    expect(
      await outcome(
        t.pglite,
        `insert into "passkey" ("id", "userId", "credentialID", "counter", "deviceType", "backedUp")
         values ('pk-nopub', 'pay259-t20-c', 'cred-nopub', 0, 'singleDevice', false)`,
      ),
    ).toMatch(/null value/i);
    const idx = await t.pglite.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where tablename = 'passkey' order by indexname`,
    );
    const byName = Object.fromEntries(idx.rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.passkey_userId_idx).toBeDefined();
    expect(byName.passkey_credentialID_idx).toMatch(/UNIQUE/);
  });
});

// ---------------------------------------------------------------- T21

describe("T21 Better Auth schema drift", () => {
  it("BA_MIGRATIONS lists the Better Auth-owned migrations", async () => {
    const { BA_MIGRATIONS } = await loadBaSchema();
    expect(BA_MIGRATIONS).toEqual(["0002_better_auth_tables.sql", "0030_passkey.sql"]);
  });

  it("pendingBetterAuthSql() is empty for the runtime options", async () => {
    const { pendingBetterAuthSql } = await loadBaSchema();
    const pending = await pendingBetterAuthSql();
    expect(pending.trim()).toBe("");
  }, 120_000);
});

// ---------------------------------------------------------------- T22

describe("T22 migration 0030 on a pre-0030 database", () => {
  it("journal lists 0030_passkey as the entry after 0029", () => {
    const entries = journal().entries;
    const i29 = entries.findIndex((e) => e.tag === "0029_w2_furnished_figures");
    expect(i29).toBeGreaterThanOrEqual(0);
    expect(entries[i29 + 1]).toMatchObject({ idx: 30, tag: "0030_passkey" });
  });

  it("0030 touches only the Better Auth session/passkey tables", () => {
    const allowed = [
      /^alter table "session" add column "authMethod" text;?$/i,
      /^update "session" set "authMethod" = case when "userId" in \(select "id" from "user" where "twoFactorEnabled" = true\) then 'legacy_mfa' else 'none' end where "authMethod" is null;?$/i,
      /^create table "passkey" \(/i,
      /^create (unique )?index "passkey_[A-Za-z]+_idx" on "passkey" \(/i,
    ];
    const stmts = statementsOf("0030_passkey")
      .map(sqlBody)
      .filter((s) => s.length > 0);
    expect(stmts.length).toBe(5);
    for (const s of stmts) {
      expect(
        allowed.some((re) => re.test(s)),
        `unexpected statement: ${s.slice(0, 80)}`,
      ).toBe(true);
    }
    // The only foreign reference is to "user".
    const createTable = stmts.find((s) => /^create table "passkey"/i.test(s))!;
    const refs = [...createTable.matchAll(/references\s+"([^"]+)"/gi)].map((m) => m[1]);
    expect(refs).toEqual(["user"]);
  });

  it("live sessions from before 0030 are backfilled: TOTP user 'legacy_mfa', twoFactorEnabled false/NULL 'none'; passkey table created empty", async () => {
    const pg = new PGlite("memory://");
    try {
      const entries = journal().entries;
      const stop = entries.findIndex((e) => e.tag === "0029_w2_furnished_figures");
      expect(stop).toBeGreaterThanOrEqual(0);
      for (const e of entries.slice(0, stop + 1)) await applyTag(pg, e.tag);

      // Prior-release state: no authMethod column, no passkey table.
      expect(await outcome(pg, `select "authMethod" from "session"`)).toMatch(/authMethod/);
      expect(await outcome(pg, `select 1 from "passkey"`)).toMatch(/passkey/);

      // Three prior-release users, one live session each: TOTP on, TOTP off, flag NULL.
      const priorUsers: [string, boolean | null][] = [
        ["pay259-t22-user", true],
        ["pay259-t22-nomfa", false],
        ["pay259-t22-nullmfa", null],
      ];
      for (const [id, twoFactorEnabled] of priorUsers) {
        await pg.query(
          `insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "twoFactorEnabled")
           values ($1, 'T22 Synthetic', $2, true, now(), now(), $3)`,
          [id, `${id}@example.com`, twoFactorEnabled],
        );
      }
      const priorSessions: [string, string][] = [
        ["pay259-t22-sess", "pay259-t22-user"],
        ["pay259-t22-sess-nomfa", "pay259-t22-nomfa"],
        ["pay259-t22-sess-nullmfa", "pay259-t22-nullmfa"],
      ];
      for (const [id, userId] of priorSessions) {
        await pg.query(
          `insert into "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")
           values ($1, now() + interval '7 days', $2, now(), now(), $3)`,
          [id, `${id}-token`, userId],
        );
      }

      await applyTag(pg, "0030_passkey");

      const s = await pg.query<{ id: string; authMethod: string | null }>(
        `select "id", "authMethod" from "session" where "id" like 'pay259-t22-sess%' order by "id"`,
      );
      expect(Object.fromEntries(s.rows.map((r) => [r.id, r.authMethod]))).toEqual({
        "pay259-t22-sess": "legacy_mfa",
        "pay259-t22-sess-nomfa": "none",
        "pay259-t22-sess-nullmfa": "none",
      });
      const p = await pg.query<{ n: number }>(`select count(*)::int as n from "passkey"`);
      expect(p.rows[0]!.n).toBe(0);
      // The column is nullable (no default): a row inserted afterwards without it stays null
      // until Better Auth's create hook writes it.
      await pg.query(
        `insert into "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")
         values ('pay259-t22-sess2', now() + interval '7 days', 'pay259-t22-token2', now(), now(), 'pay259-t22-user')`,
      );
      const s2 = await pg.query<{ authMethod: string | null }>(
        `select "authMethod" from "session" where "id" = 'pay259-t22-sess2'`,
      );
      expect(s2.rows[0]?.authMethod).toBeNull();
    } finally {
      await pg.close();
    }
  }, 180_000);
});

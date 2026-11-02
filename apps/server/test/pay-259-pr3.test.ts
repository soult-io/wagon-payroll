/**
 * PAY-259 PR 3 — passkey server enablement (no UI), part 1 of 2.
 *
 * Contract sections covered here:
 * A  the seven /passkey/* paths are enabled when passkeys are available;
 *    endpoint inventory pinned.
 * B  plugin options: rpID / origin from BASE_URL (never the request Origin;
 *    http://localhost:5173 only outside production); authenticatorSelection
 *    { residentKey: "required", userVerification: "required" }.
 * F  passkey-config.ts (passkeyRpId / passkeyOrigins / passkeysAvailable);
 *    unavailable → the seven paths stay disabled; runtime-config flag.
 * C  user verification required on registration and sign-in.
 * D  policy before-hook (passkey-policy.ts): step-up, name rules, no
 *    createSession, name-in-query refused, 10-passkey cap.
 * E  audit events; event rows carry no credential material; passkey events
 *    leave the password lockout counter alone.
 * Part 2 (pay-259-pr3-lifecycle.test.ts): G–M.
 *
 * Test author: fail-first against origin/main 735271d; the coder may not edit
 * this file. Synthetic data only (example.com users, generated keys).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, ORIGIN, type TestContext } from "./helpers.js";
import { buildAuthOptions } from "../src/auth/auth.js";
import {
  codeOf,
  harness,
  type Harness,
  newAuthenticator,
  PASSKEY_ENDPOINTS,
  RP_ID,
  RP_ORIGIN,
  TEST_PASSWORD,
} from "./pay-259-pr3-harness.js";

type PasskeyConfigModule = {
  passkeyRpId: (baseUrl: string) => string;
  passkeyOrigins: (baseUrl: string, nodeEnv: string) => string | string[];
  passkeysAvailable: (baseUrl: string) => boolean;
};
const loadPasskeyConfig = () =>
  import("../src/auth/passkey-config.js") as unknown as Promise<PasskeyConfigModule>;

/**
 * Enabled Better Auth endpoint paths with passkeys available: the PR 1
 * inventory (origin/main 735271d) plus the seven passkey paths. A new
 * plugin path, or a disabled path coming back, must change this on purpose.
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

let t: TestContext;
let h: Harness;
beforeAll(async () => {
  t = await createTestApp();
  h = harness(t, 203);
});
afterAll(async () => {
  await t.close();
});

function enabledPaths(ctx: TestContext): string[] {
  const api = ctx.auth.api as unknown as Record<string, { path?: unknown }>;
  const disabled = new Set(ctx.auth.options.disabledPaths ?? []);
  return [
    ...new Set(
      Object.values(api)
        .map((e) => e?.path)
        .filter((p): p is string => typeof p === "string"),
    ),
  ]
    .filter((p) => !disabled.has(p))
    .sort();
}

function passkeyPluginOptions(opts: { plugins?: { id: string; options?: unknown }[] }) {
  const p = (opts.plugins ?? []).find((x) => x.id === "passkey");
  if (!p) throw new Error("passkey plugin not registered");
  return p.options as {
    rpID?: unknown;
    origin?: unknown;
    authenticatorSelection?: unknown;
  };
}

function asList(v: unknown): string[] {
  return (Array.isArray(v) ? v : [v]) as string[];
}

// ---------------------------------------------------------------- A

describe("A passkey endpoints enabled", () => {
  it("none of the seven passkey paths is in disabledPaths (http://localhost)", () => {
    const disabled = new Set(t.auth.options.disabledPaths ?? []);
    for (const { path } of PASSKEY_ENDPOINTS) expect(disabled.has(path), path).toBe(false);
  });

  it("endpoint inventory: enabled paths equal the PR 1 list plus the seven passkey paths", () => {
    expect(enabledPaths(t)).toEqual([...ENABLED_AUTH_PATHS].sort());
  });

  it("without a session the passkey paths answer, not 404 (options 200; session-only paths 401)", async () => {
    const opt = await h.auth("GET", "/passkey/generate-authenticate-options");
    expect(opt.statusCode).toBe(200);
    for (const path of ["/passkey/generate-register-options", "/passkey/list-user-passkeys"]) {
      const res = await h.auth("GET", path);
      expect(res.statusCode, path).toBe(401);
    }
  });
});

// ---------------------------------------------------------------- B

describe("B plugin options from BASE_URL", () => {
  it("rpID = BASE_URL hostname; origin = BASE_URL origin + dev Vite origin (non-production)", () => {
    const o = passkeyPluginOptions(t.auth.options as never);
    expect(o.rpID).toBe(RP_ID);
    expect(asList(o.origin).sort()).toEqual([RP_ORIGIN, "http://localhost:5173"].sort());
  });

  it("authenticatorSelection requires a resident key and user verification", () => {
    const o = passkeyPluginOptions(t.auth.options as never);
    expect(o.authenticatorSelection).toMatchObject({
      residentKey: "required",
      userVerification: "required",
    });
  });

  it("production: origin is the BASE_URL origin only (path and trailing slash stripped)", () => {
    const config = {
      ...t.config,
      nodeEnv: "production",
      baseUrl: "https://payroll.example.com/app/",
    } as typeof t.config;
    const opts = buildAuthOptions({ config, db: t.db, dialect: {} as never });
    const o = passkeyPluginOptions(opts as never);
    expect(o.rpID).toBe("payroll.example.com");
    expect(asList(o.origin)).toEqual(["https://payroll.example.com"]);
  });

  it("generate-register-options returns rp.id localhost and the required selection", async () => {
    const { cookie } = await h.totpUser("pr3-b-regopts@example.com");
    const res = await h.auth("GET", "/passkey/generate-register-options", { cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      rp: { id: string };
      authenticatorSelection: { residentKey?: string; userVerification?: string };
    };
    expect(body.rp.id).toBe(RP_ID);
    expect(body.authenticatorSelection).toMatchObject({
      residentKey: "required",
      userVerification: "required",
    });
  });

  it("a sign-in whose clientDataJSON origin is the dev Vite origin is accepted outside production", async () => {
    const { userId } = await h.onboard("pr3-b-vite@example.com");
    const a = newAuthenticator("http://localhost:5173");
    await h.seedPasskey(userId, a);
    const { res, session } = await h.passkeySignIn(a);
    expect(res.statusCode).toBe(200);
    expect(session).not.toBeNull();
  });
});

// ---------------------------------------------------------------- F

describe("F passkey-config.ts", () => {
  it("passkeysAvailable: https host or localhost, never an IP literal", async () => {
    const { passkeysAvailable } = await loadPasskeyConfig();
    expect({
      https: passkeysAvailable("https://payroll.example.com"),
      localhost: passkeysAvailable("http://localhost:8927"),
      ipv4: passkeysAvailable("http://192.168.1.5:8927"),
      ipv6: passkeysAvailable("http://[::1]:8927"),
      httpHost: passkeysAvailable("http://payroll.example.com"),
      httpsIp: passkeysAvailable("https://192.168.1.5"),
    }).toEqual({
      https: true,
      localhost: true,
      ipv4: false,
      ipv6: false,
      httpHost: false,
      httpsIp: false,
    });
  });

  it("passkeyRpId is the hostname; passkeyOrigins strips path / trailing slash and adds Vite only outside production", async () => {
    const { passkeyRpId, passkeyOrigins } = await loadPasskeyConfig();
    expect(passkeyRpId("https://payroll.example.com/app/")).toBe("payroll.example.com");
    expect(passkeyRpId("http://localhost:8927")).toBe("localhost");
    expect(asList(passkeyOrigins("https://payroll.example.com/app/", "production"))).toEqual([
      "https://payroll.example.com",
    ]);
    expect(asList(passkeyOrigins("https://payroll.example.com/", "development")).sort()).toEqual(
      ["https://payroll.example.com", "http://localhost:5173"].sort(),
    );
    expect(asList(passkeyOrigins("http://localhost:8927/", "test")).sort()).toEqual(
      ["http://localhost:8927", "http://localhost:5173"].sort(),
    );
  });

  it("GET /api/runtime-config reports passkeysAvailable true for http://localhost", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/runtime-config" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { passkeysAvailable?: unknown }).passkeysAvailable).toBe(true);
  });

  describe("BASE_URL on an IP literal (passkeys unavailable)", () => {
    let u: TestContext;
    beforeAll(async () => {
      u = await createTestApp({ baseUrl: "http://192.168.1.5:8927" });
    });
    afterAll(async () => {
      await u.close();
    });

    it("the seven paths stay in disabledPaths and answer 404; runtime-config false", async () => {
      const disabled = new Set(u.auth.options.disabledPaths ?? []);
      for (const { path } of PASSKEY_ENDPOINTS) expect(disabled.has(path), path).toBe(true);
      for (const { method, path } of PASSKEY_ENDPOINTS) {
        const res = await u.app.inject({
          method,
          url: `/api/auth${path}`,
          headers: { origin: "http://192.168.1.5:8927", "x-forwarded-for": "10.204.0.1" },
          remoteAddress: "10.204.0.1",
          ...(method === "POST" ? { payload: { id: "x", name: "x", response: { id: "x" } } } : {}),
        });
        expect(res.statusCode, `${method} ${path}`).toBe(404);
      }
      const rc = await u.app.inject({ method: "GET", url: "/api/runtime-config" });
      expect((rc.json() as { passkeysAvailable?: unknown }).passkeysAvailable).toBe(false);
    });
  });
});

// ---------------------------------------------------------------- C

describe("C user verification is required", () => {
  it("registration without UV → 400 PASSKEY_USER_VERIFICATION_REQUIRED, no row, passkey_add_failed", async () => {
    const { userId, cookie } = await h.totpUser("pr3-c-reg-nouv@example.com");
    const a = newAuthenticator();
    const { opt, res } = await h.register(cookie, a, { overrides: { uv: false } });
    expect(opt.statusCode).toBe(200);
    expect(res?.statusCode).toBe(400);
    expect(codeOf(res!)).toBe("PASSKEY_USER_VERIFICATION_REQUIRED");
    expect(await h.passkeys(userId)).toEqual([]);
    expect((await h.events(userId, "passkey_add_failed")).length).toBe(1);
    expect(await h.events(userId, "passkey_added")).toEqual([]);
  });

  it("registration with UV → 200, row stored, passkey_added", async () => {
    const { userId, cookie } = await h.totpUser("pr3-c-reg-uv@example.com");
    const a = newAuthenticator();
    const { res } = await h.register(cookie, a, { name: "Work laptop" });
    expect(res?.statusCode).toBe(200);
    const rows = await h.passkeys(userId);
    expect(rows.map((r) => [r.credentialID, r.name])).toEqual([[a.id, "Work laptop"]]);
    expect((await h.events(userId, "passkey_added")).length).toBe(1);
  });

  it("generate-authenticate-options asks for userVerification 'required'", async () => {
    const res = await h.auth("GET", "/passkey/generate-authenticate-options");
    expect(res.statusCode).toBe(200);
    expect((res.json() as { userVerification?: unknown }).userVerification).toBe("required");
  });

  it("sign-in without UV → 401 PASSKEY_USER_VERIFICATION_REQUIRED; no session; counter unchanged; failure audited to the owner", async () => {
    const { userId } = await h.onboard("pr3-c-signin-nouv@example.com");
    const a = newAuthenticator();
    await h.seedPasskey(userId, a, { counter: 3 });
    const before = await h.sessionCount(userId);
    const { res, session } = await h.passkeySignIn(a, { overrides: { uv: false } });
    expect(res.statusCode).toBe(401);
    expect(codeOf(res)).toBe("PASSKEY_USER_VERIFICATION_REQUIRED");
    expect(session).toBeNull();
    expect(await h.sessionCount(userId)).toBe(before);
    expect((await h.passkeys(userId))[0]!.counter).toBe(3);
    expect((await h.events(userId, "passkey_login_failure")).length).toBe(1);
    expect(await h.events(userId, "passkey_login_success")).toEqual([]);
  });
});

// ---------------------------------------------------------------- D

describe("D step-up for passkey management", () => {
  it("a fresh password_totp session may get register options", async () => {
    const { cookie } = await h.totpUser("pr3-d-fresh@example.com");
    const res = await h.auth("GET", "/passkey/generate-register-options", { cookie });
    expect(res.statusCode).toBe(200);
  });

  it("a password_totp session older than 5 minutes → 403 SESSION_NOT_FRESH on register options", async () => {
    const { cookie } = await h.totpUser("pr3-d-stale@example.com");
    await h.ageSession(cookie, 6);
    const res = await h.auth("GET", "/passkey/generate-register-options", { cookie });
    expect([res.statusCode, codeOf(res)]).toEqual([403, "SESSION_NOT_FRESH"]);
  });

  it("verify-registration from a session that went stale after the options → 403 SESSION_NOT_FRESH, no row", async () => {
    const { userId, cookie } = await h.totpUser("pr3-d-stale-verify@example.com");
    const { opt, res } = await h.register(cookie, newAuthenticator(), {
      between: () => h.ageSession(cookie, 6),
    });
    expect(opt.statusCode).toBe(200);
    expect([res?.statusCode, codeOf(res!)]).toEqual([403, "SESSION_NOT_FRESH"]);
    expect(await h.passkeys(userId)).toEqual([]);
  });

  it("a seconds-old password_backup_code session → 403 SESSION_NOT_FRESH", async () => {
    const email = "pr3-d-backup@example.com";
    const { backupCodes } = await h.onboard(email);
    const cookie = await h.backupCodeSignIn(email, backupCodes[0]!);
    expect((await h.sessionRow(cookie))?.authMethod).toBe("password_backup_code");
    const res = await h.auth("GET", "/passkey/generate-register-options", { cookie });
    expect([res.statusCode, codeOf(res)]).toEqual([403, "SESSION_NOT_FRESH"]);
  });

  it("a fresh legacy_mfa session → 403 SESSION_NOT_FRESH", async () => {
    const { cookie } = await h.totpUser("pr3-d-legacy@example.com");
    await h.setMethod(cookie, "legacy_mfa");
    const res = await h.auth("GET", "/passkey/generate-register-options", { cookie });
    expect([res.statusCode, codeOf(res)]).toEqual([403, "SESSION_NOT_FRESH"]);
  });

  it("a fresh passkey session may register another passkey", async () => {
    const { userId } = await h.onboard("pr3-d-passkey-session@example.com");
    const first = newAuthenticator();
    await h.seedPasskey(userId, first);
    const { session } = await h.passkeySignIn(first);
    expect(session).not.toBeNull();
    expect((await h.sessionRow(session!))?.authMethod).toBe("passkey");
    const { res } = await h.register(session!, newAuthenticator(), { name: "Phone" });
    expect(res?.statusCode).toBe(200);
    expect((await h.passkeys(userId)).length).toBe(2);
  });

  it("delete-passkey: stale session → 403 SESSION_NOT_FRESH and the row stays; fresh → removed + passkey_removed", async () => {
    const { userId, cookie } = await h.totpUser("pr3-d-delete@example.com");
    const id = await h.seedPasskey(userId, newAuthenticator());
    await h.ageSession(cookie, 6);
    const stale = await h.auth("POST", "/passkey/delete-passkey", { cookie, payload: { id } });
    expect([stale.statusCode, codeOf(stale)]).toEqual([403, "SESSION_NOT_FRESH"]);
    expect((await h.passkeys(userId)).length).toBe(1);
    await h.ageSession(cookie, 0);
    const fresh = await h.auth("POST", "/passkey/delete-passkey", { cookie, payload: { id } });
    expect(fresh.statusCode).toBe(200);
    expect(await h.passkeys(userId)).toEqual([]);
    expect((await h.events(userId, "passkey_removed")).length).toBe(1);
  });

  it("update-passkey (rename) needs no step-up: a stale session renames; name stored trimmed; passkey_renamed", async () => {
    const { userId, cookie } = await h.totpUser("pr3-d-rename@example.com");
    const id = await h.seedPasskey(userId, newAuthenticator(), { name: "Old" });
    await h.ageSession(cookie, 30);
    const res = await h.auth("POST", "/passkey/update-passkey", {
      cookie,
      payload: { id, name: "  Desk key  " },
    });
    expect(res.statusCode).toBe(200);
    expect((await h.passkeys(userId))[0]!.name).toBe("Desk key");
    expect((await h.events(userId, "passkey_renamed")).length).toBe(1);
  });
});

describe("D request rules", () => {
  it("generate-register-options with a name query parameter → 400 PASSKEY_NAME_IN_QUERY", async () => {
    const { cookie } = await h.totpUser("pr3-d-namequery@example.com");
    const res = await h.auth("GET", "/passkey/generate-register-options?name=alice%40example.com", {
      cookie,
    });
    expect([res.statusCode, codeOf(res)]).toEqual([400, "PASSKEY_NAME_IN_QUERY"]);
  });

  it("verify-registration with createSession:true → 400 PASSKEY_CREATE_SESSION_NOT_ALLOWED; no row, no new session", async () => {
    const { userId, cookie } = await h.totpUser("pr3-d-createsession@example.com");
    const before = await h.sessionCount(userId);
    const { res } = await h.register(cookie, newAuthenticator(), { createSession: true });
    expect([res?.statusCode, codeOf(res!)]).toEqual([400, "PASSKEY_CREATE_SESSION_NOT_ALLOWED"]);
    expect(await h.passkeys(userId)).toEqual([]);
    expect(await h.sessionCount(userId)).toBe(before);
  });

  it("verify-registration name: optional; trimmed; 64 chars ok; blank or 65 chars → 400 PASSKEY_NAME_INVALID", async () => {
    const { userId, cookie } = await h.totpUser("pr3-d-regname@example.com");
    const noName = await h.register(cookie, newAuthenticator());
    expect(noName.res?.statusCode).toBe(200);
    const trimmed = await h.register(cookie, newAuthenticator(), { name: "  Tablet  " });
    expect(trimmed.res?.statusCode).toBe(200);
    const max = await h.register(cookie, newAuthenticator(), { name: "k".repeat(64) });
    expect(max.res?.statusCode).toBe(200);
    for (const name of ["", "   ", "k".repeat(65)]) {
      const bad = await h.register(cookie, newAuthenticator(), { name });
      expect([bad.res?.statusCode, codeOf(bad.res!)], JSON.stringify(name.length)).toEqual([
        400,
        "PASSKEY_NAME_INVALID",
      ]);
    }
    const names = (await h.passkeys(userId)).map((r) => r.name);
    expect(names.length).toBe(3);
    expect(names).toContain("Tablet");
    expect(names).toContain("k".repeat(64));
    expect(names.filter((n) => n === null || n === "").length).toBe(1);
  });

  it("update-passkey name required, 1–64 after trim; else 400 PASSKEY_NAME_INVALID and the row is unchanged", async () => {
    const { userId, cookie } = await h.totpUser("pr3-d-updname@example.com");
    const id = await h.seedPasskey(userId, newAuthenticator(), { name: "Keep" });
    for (const payload of [
      { id },
      { id, name: "" },
      { id, name: "   " },
      { id, name: "x".repeat(65) },
    ]) {
      const res = await h.auth("POST", "/passkey/update-passkey", { cookie, payload });
      expect([res.statusCode, codeOf(res)], JSON.stringify(Object.keys(payload))).toEqual([
        400,
        "PASSKEY_NAME_INVALID",
      ]);
    }
    expect((await h.passkeys(userId))[0]!.name).toBe("Keep");
    const ok = await h.auth("POST", "/passkey/update-passkey", {
      cookie,
      payload: { id, name: "y".repeat(64) },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("cap: 10 passkeys → generate-register-options 400 PASSKEY_LIMIT_REACHED", async () => {
    const { userId, cookie } = await h.totpUser("pr3-d-cap@example.com");
    for (let i = 0; i < 10; i++) await h.seedPasskey(userId, newAuthenticator());
    const res = await h.auth("GET", "/passkey/generate-register-options", { cookie });
    expect([res.statusCode, codeOf(res)]).toEqual([400, "PASSKEY_LIMIT_REACHED"]);
  });

  it("cap: the 10th passkey added between options and verify → verify-registration 400 PASSKEY_LIMIT_REACHED", async () => {
    const { userId, cookie } = await h.totpUser("pr3-d-cap-verify@example.com");
    for (let i = 0; i < 9; i++) await h.seedPasskey(userId, newAuthenticator());
    const { opt, res } = await h.register(cookie, newAuthenticator(), {
      between: async () => {
        await h.seedPasskey(userId, newAuthenticator());
      },
    });
    expect(opt.statusCode).toBe(200);
    expect([res?.statusCode, codeOf(res!)]).toEqual([400, "PASSKEY_LIMIT_REACHED"]);
    expect((await h.passkeys(userId)).length).toBe(10);
  });
});

// ---------------------------------------------------------------- E

describe("E audit events", () => {
  it("passkey_login_success on a passkey sign-in, with new-device tracking", async () => {
    const { userId } = await h.onboard("pr3-e-success@example.com");
    const a = newAuthenticator();
    await h.seedPasskey(userId, a);
    const devicesBefore = await t.pglite.query<{ n: number }>(
      `select count(*)::int as n from user_devices where user_id = $1`,
      [userId],
    );
    const { res } = await h.passkeySignIn(a, { ip: "10.205.77.9", ua: "pr3-e-device-agent/1.0" });
    expect(res.statusCode).toBe(200);
    expect((await h.events(userId, "passkey_login_success")).length).toBe(1);
    const devicesAfter = await t.pglite.query<{ n: number }>(
      `select count(*)::int as n from user_devices where user_id = $1`,
      [userId],
    );
    expect(devicesAfter.rows[0]!.n).toBe(devicesBefore.rows[0]!.n + 1);
  });

  it("unknown credential → passkey_login_failure with a null userId", async () => {
    const before = (await h.events(null, "passkey_login_failure")).length;
    const { res } = await h.passkeySignIn(newAuthenticator());
    expect(res.statusCode).toBe(401);
    expect((await h.events(null, "passkey_login_failure")).length).toBe(before + 1);
  });

  it("counter regression → failure, passkey_login_failure + passkey_counter_regression to the owner; passkey kept, counter unchanged", async () => {
    const { userId } = await h.onboard("pr3-e-counter@example.com");
    const a = newAuthenticator();
    await h.seedPasskey(userId, a, { counter: 5 });
    for (const signCount of [5, 3]) {
      const { res, session } = await h.passkeySignIn(a, { overrides: { signCount } });
      expect([400, 401], `signCount ${signCount}`).toContain(res.statusCode);
      expect(session).toBeNull();
    }
    expect((await h.events(userId, "passkey_counter_regression")).length).toBe(2);
    expect((await h.events(userId, "passkey_login_failure")).length).toBe(2);
    const rows = await h.passkeys(userId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.counter).toBe(5);
    // Not disabled: a correct, higher counter still signs in.
    const ok = await h.passkeySignIn(a, { overrides: { signCount: 6 } });
    expect(ok.res.statusCode).toBe(200);
  });

  it("auth_events keeps its columns; no event row carries the credential id, public key or passkey name", async () => {
    const cols = await t.pglite.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'auth_events' order by column_name`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual([
      "created_at",
      "event",
      "id",
      "ip",
      "user_agent",
      "user_id",
    ]);
    const { userId, cookie } = await h.totpUser("pr3-e-nomaterial@example.com");
    const a = newAuthenticator();
    const name = "pr3-unique-passkey-label";
    const { res } = await h.register(cookie, a, { name });
    expect(res?.statusCode).toBe(200);
    const pk = (await h.passkeys(userId))[0]!;
    await h.auth("POST", "/passkey/update-passkey", {
      cookie,
      payload: { id: pk.id, name: `${name}-2` },
    });
    await h.passkeySignIn(a);
    await h.passkeySignIn(a, { overrides: { uv: false } });
    const dump = await t.pglite.query<{ j: string }>(
      `select row_to_json(e)::text as j from auth_events e where user_id = $1 or user_id is null`,
      [userId],
    );
    const text = dump.rows.map((r) => r.j).join("\n");
    expect(text.includes(a.id)).toBe(false);
    expect(text.includes(pk.publicKey)).toBe(false);
    expect(text.includes(name)).toBe(false);
    const kinds = new Set((await h.events(userId)).map((e) => e.event));
    for (const e of [
      "passkey_added",
      "passkey_renamed",
      "passkey_login_success",
      "passkey_login_failure",
    ]) {
      expect(kinds.has(e), e).toBe(true);
    }
  });

  it("lockout counter: a passkey success between password failures does not reset it (10 failures still lock)", async () => {
    const email = "pr3-e-lockout@example.com";
    const { userId } = await h.onboard(email);
    const a = newAuthenticator();
    await h.seedPasskey(userId, a);
    const fail = () => {
      const addr = h.ip();
      return t.app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { ...ORIGIN, "x-forwarded-for": addr },
        remoteAddress: addr,
        payload: { email, password: `${TEST_PASSWORD}-wrong` },
      });
    };
    for (let i = 0; i < 9; i++) await fail();
    const { res } = await h.passkeySignIn(a);
    expect(res.statusCode).toBe(200);
    const banned0 = await t.pglite.query<{ banned: boolean | null }>(
      `select banned from "user" where id = $1`,
      [userId],
    );
    expect(banned0.rows[0]!.banned).not.toBe(true);
    await fail();
    const banned = await t.pglite.query<{ banned: boolean | null; banReason: string | null }>(
      `select banned, "banReason" from "user" where id = $1`,
      [userId],
    );
    expect(banned.rows[0]).toEqual({ banned: true, banReason: "lockout" });
  });

  it("passkey failures do not count toward the password lockout", async () => {
    const { userId } = await h.onboard("pr3-e-nolock@example.com");
    const a = newAuthenticator();
    await h.seedPasskey(userId, a);
    for (let i = 0; i < 10; i++) {
      const { res } = await h.passkeySignIn(a, { overrides: { uv: false } });
      expect(res.statusCode).toBe(401);
    }
    const r = await t.pglite.query<{ banned: boolean | null }>(
      `select banned from "user" where id = $1`,
      [userId],
    );
    expect(r.rows[0]!.banned).not.toBe(true);
    expect((await h.events(userId, "login_failure")).length).toBe(0);
  });
});

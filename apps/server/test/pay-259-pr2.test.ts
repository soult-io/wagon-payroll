/**
 * PAY-259 PR 2 — default-deny MFA guard on session."authMethod".
 *
 * Contract:
 * - session-method.ts exports MFA_METHODS (password_totp, password_backup_code,
 *   passkey, legacy_mfa) and isMfaSession(user, session) =
 *   user.twoFactorEnabled === true && MFA_METHODS.has(session.authMethod).
 * - requireAuth: !isMfaSession → 403 mfa_required, after banned + idle, before
 *   the updatedAt touch and the PAY-217 former-employee scope.
 * - /api/auth mount sessionRefusal: !isMfaSession → mfa_required;
 *   get-session / sign-in / sign-out stay open.
 *
 * T8: a session whose marker is 'none' or NULL (deploy window: old image wrote
 * no marker) is refused even though its user has TOTP on. Real sign-in flows
 * (password+TOTP, backup code, change-password) keep working end to end.
 *
 * Test author: fail-first against 685fd2e; the coder may not edit this file.
 * Synthetic data only (example.com users).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { authUser, company, employees, w2Furnishings } from "@payroll/db";
import { createTestApp, cookieValue, ORIGIN, type TestContext, workspaceRoot } from "./helpers.js";
import { currentTotp, login, sessionHeader, TEST_PASSWORD, tokenFromLink } from "./flow-helpers.js";
import { inviteUser } from "../src/auth/users.js";
import { formerEmployeeAccess } from "../src/auth/former-employee.js";

/** Fixed company-local clock for the PAY-217 window (TY2025 online through 2026-10-15). */
const NOW = new Date("2026-03-02T15:00:00Z");
const TODAY = "2026-03-02";
const NEW_PASSWORD = "violet-anchor-quarry-lantern-42";
const MFA = ["password_totp", "password_backup_code", "passkey", "legacy_mfa"] as const;

type SessionMethodModule = {
  MFA_METHODS: ReadonlySet<string>;
  isMfaSession: (
    user: { twoFactorEnabled?: boolean | null },
    session: { authMethod?: string | null },
  ) => boolean;
};
const loadSessionMethod = () =>
  import("../src/auth/session-method.js") as unknown as Promise<SessionMethodModule>;

let t: TestContext;
beforeAll(async () => {
  t = await createTestApp({}, { clock: () => NOW });
});
afterAll(async () => {
  await t.close();
});

// ---------------------------------------------------------------- helpers

let ipSeq = 0;
function freshIp(): string {
  ipSeq += 1;
  return `10.159.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
}

/** The session row token of a signed cookie value ("<token>.<sig>"). */
function tokenOf(cookie: string): string {
  return cookie.split(".")[0]!;
}

async function setMethod(cookie: string, method: string | null): Promise<void> {
  const r = await t.pglite.query(`update "session" set "authMethod" = $1 where "token" = $2`, [
    method,
    tokenOf(cookie),
  ]);
  if (r.affectedRows !== 1) throw new Error(`expected one session row, got ${r.affectedRows}`);
}

async function sessionRow(
  cookie: string,
): Promise<{ authMethod: string | null; updatedAt: Date } | null> {
  const r = await t.pglite.query<{ authMethod: string | null; updatedAt: Date }>(
    `select "authMethod", "updatedAt" from "session" where "token" = $1`,
    [tokenOf(cookie)],
  );
  return r.rows[0] ?? null;
}

async function setUpdatedAt(cookie: string, at: Date): Promise<void> {
  await t.pglite.query(`update "session" set "updatedAt" = $1 where "token" = $2`, [
    at,
    tokenOf(cookie),
  ]);
}

function get(url: string, cookie: string) {
  return t.app.inject({ method: "GET", url, headers: sessionHeader(cookie) });
}

function authPost(path: string, cookie: string, payload: unknown) {
  const ip = freshIp();
  return t.app.inject({
    method: "POST",
    url: `/api/auth${path}`,
    headers: { ...sessionHeader(cookie), "x-forwarded-for": ip },
    remoteAddress: ip,
    payload,
  });
}

function errorOf(res: { body: string }): unknown {
  try {
    return (JSON.parse(res.body) as { error?: unknown }).error;
  } catch {
    return undefined;
  }
}

/**
 * Invite (service call) + full TOTP enrollment over HTTP, each step from a
 * fresh client address (the onboarding routes are rate limited per address).
 */
async function inviteAndOnboard(
  _t: TestContext,
  input: { email: string; role?: "admin" | "employee" },
): Promise<{ userId: string; backupCodes: string[] }> {
  const invite = await inviteUser(
    { auth: t.auth, db: t.db, config: t.config },
    { name: input.email.split("@")[0]!, email: input.email, role: input.role ?? "employee" },
    null,
  );
  const token = tokenFromLink(invite.setupLink);
  const post = (url: string, payload: unknown) => {
    const ip = freshIp();
    return t.app.inject({
      method: "POST",
      url,
      headers: { ...ORIGIN, "x-forwarded-for": ip },
      remoteAddress: ip,
      payload,
    });
  };
  const steps: [string, unknown][] = [
    ["/api/onboarding/verify-token", { token }],
    ["/api/onboarding/set-password", { token, password: TEST_PASSWORD }],
    ["/api/onboarding/totp-enable", { token }],
  ];
  for (const [url, payload] of steps) {
    const res = await post(url, payload);
    if (res.statusCode !== 200) throw new Error(`${url} ${res.statusCode}: ${res.body}`);
  }
  const code = await currentTotp(t, invite.userId);
  const verify = await post("/api/onboarding/totp-verify", { token, code });
  if (verify.statusCode !== 200)
    throw new Error(`totp-verify ${verify.statusCode}: ${verify.body}`);
  const { backupCodes } = verify.json() as { backupCodes: string[] };
  return { userId: invite.userId, backupCodes };
}

/** Onboard (invite + TOTP enrollment) and sign in with password + TOTP. */
async function totpSession(
  email: string,
  role: "admin" | "employee" = "employee",
): Promise<{ userId: string; cookie: string; backupCodes: string[] }> {
  const { userId, backupCodes } = await inviteAndOnboard(t, { email, role });
  const { sessionCookie } = await login(t, email, TEST_PASSWORD, { remoteAddress: freshIp() });
  return { userId, cookie: sessionCookie, backupCodes };
}

/** Password step → 2FA challenge cookie. */
async function challenge(email: string): Promise<string> {
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

/** Password + backup code sign-in → session cookie. */
async function backupCodeSignIn(email: string, code: string): Promise<string> {
  const twoFactorCookie = await challenge(email);
  const ip = freshIp();
  const res = await t.app.inject({
    method: "POST",
    url: "/api/auth/backup-code/verify",
    headers: { ...ORIGIN, "x-forwarded-for": ip, cookie: `payroll.two_factor=${twoFactorCookie}` },
    remoteAddress: ip,
    payload: { code },
  });
  if (res.statusCode !== 200) throw new Error(`backup-code ${res.statusCode}: ${res.body}`);
  const cookie = cookieValue(res.headers["set-cookie"], "payroll.session_token");
  if (!cookie) throw new Error("no session cookie after backup-code verify");
  return cookie;
}

/** Terminated employee with a TY2025 W-2 furnished online → PAY-217 "w2_only" on TODAY. */
async function makeFormerW2Only(userId: string, legalName: string): Promise<number> {
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
  const access = await formerEmployeeAccess(t.db, userId, TODAY, t.config.appTz);
  if (access.kind !== "w2_only") throw new Error(`fixture not w2_only: ${access.kind}`);
  return emp!.id;
}

// ---------------------------------------------------------------- unit

describe("isMfaSession / MFA_METHODS (session-method.ts)", () => {
  it("MFA_METHODS holds exactly the four MFA methods", async () => {
    const { MFA_METHODS } = await loadSessionMethod();
    expect(MFA_METHODS).toBeInstanceOf(Set);
    expect([...MFA_METHODS].sort()).toEqual([...MFA].sort());
  });

  it("each MFA method with TOTP on → true", async () => {
    const { isMfaSession } = await loadSessionMethod();
    for (const m of MFA) {
      expect(isMfaSession({ twoFactorEnabled: true }, { authMethod: m }), m).toBe(true);
    }
  });

  it("'none', null, undefined, '', wrong case and unknown strings → false even with TOTP on", async () => {
    const { isMfaSession } = await loadSessionMethod();
    for (const m of ["none", null, undefined, "", "PASSWORD_TOTP", "legacy", "password_totp "]) {
      expect(isMfaSession({ twoFactorEnabled: true }, { authMethod: m }), String(m)).toBe(false);
    }
    expect(isMfaSession({ twoFactorEnabled: true }, {})).toBe(false);
  });

  it("every method with twoFactorEnabled false / null / absent → false", async () => {
    const { isMfaSession } = await loadSessionMethod();
    for (const m of [...MFA, "none", null]) {
      expect(isMfaSession({ twoFactorEnabled: false }, { authMethod: m }), `false ${m}`).toBe(
        false,
      );
      expect(isMfaSession({ twoFactorEnabled: null }, { authMethod: m }), `null ${m}`).toBe(false);
      expect(isMfaSession({}, { authMethod: m }), `absent ${m}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- T8

describe("T8 a session without an MFA marker is refused (user has TOTP on)", () => {
  for (const marker of ["none", null] as const) {
    it(`authMethod ${marker === null ? "NULL" : `'${marker}'`} → /api/me, admin route, list-sessions 403 mfa_required; get-session and sign-out still work`, async () => {
      const tag = marker === null ? "null" : marker;
      const { cookie } = await totpSession(`pay259pr2-t8-${tag}@example.com`, "admin");
      // Proper sign-in works before the marker is changed.
      expect((await get("/api/me", cookie)).statusCode).toBe(200);
      await setMethod(cookie, marker);

      const meRes = await get("/api/me", cookie);
      const admin = await get("/api/admin/ping", cookie);
      const list = await get("/api/auth/list-sessions", cookie);
      const session = await get("/api/auth/get-session", cookie);
      expect({
        me: [meRes.statusCode, errorOf(meRes)],
        admin: [admin.statusCode, errorOf(admin)],
        list: [list.statusCode, errorOf(list)],
        getSession: session.statusCode,
      }).toEqual({
        me: [403, "mfa_required"],
        admin: [403, "mfa_required"],
        list: [403, "mfa_required"],
        getSession: 200,
      });

      const out = await authPost("/sign-out", cookie, {});
      expect(out.statusCode).toBe(200);
      expect(await sessionRow(cookie)).toBeNull();
    });
  }

  it("idle still wins: a 'none' session idle > 12 h → 401 session_expired and the row is deleted", async () => {
    const { cookie } = await totpSession("pay259pr2-idle@example.com");
    await setMethod(cookie, "none");
    await setUpdatedAt(cookie, new Date(Date.now() - 13 * 60 * 60 * 1000));
    const res = await get("/api/me", cookie);
    expect([res.statusCode, errorOf(res)]).toEqual([401, "session_expired"]);
    expect(await sessionRow(cookie)).toBeNull();
  });

  it("a refused 'none' session's updatedAt is not touched", async () => {
    const { cookie } = await totpSession("pay259pr2-notouch@example.com");
    await setMethod(cookie, "none");
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    await setUpdatedAt(cookie, fiveMinutesAgo);
    const before = (await sessionRow(cookie))!.updatedAt;

    const res = await get("/api/me", cookie);

    const after = (await sessionRow(cookie))!.updatedAt;
    expect(new Date(after).getTime()).toBe(new Date(before).getTime());
    expect([res.statusCode, errorOf(res)]).toEqual([403, "mfa_required"]);
  });

  it("the user check is kept: a password_totp session whose user turns TOTP off → 403 mfa_required on both guards", async () => {
    const { userId, cookie } = await totpSession("pay259pr2-userflip@example.com");
    expect((await sessionRow(cookie))!.authMethod).toBe("password_totp");
    await t.db.update(authUser).set({ twoFactorEnabled: false }).where(eq(authUser.id, userId));
    const meRes = await get("/api/me", cookie);
    const list = await get("/api/auth/list-sessions", cookie);
    expect({
      me: [meRes.statusCode, errorOf(meRes)],
      list: [list.statusCode, errorOf(list)],
    }).toEqual({ me: [403, "mfa_required"], list: [403, "mfa_required"] });
  });
});

// ---------------------------------------------------------------- allowed markers

describe("MFA markers are accepted", () => {
  for (const marker of MFA) {
    it(`authMethod '${marker}' → /api/me 200 and list-sessions 200`, async () => {
      const { cookie } = await totpSession(`pay259pr2-ok-${marker}@example.com`);
      await setMethod(cookie, marker);
      const meRes = await get("/api/me", cookie);
      const list = await get("/api/auth/list-sessions", cookie);
      expect({ me: meRes.statusCode, list: list.statusCode }).toEqual({ me: 200, list: 200 });
    });
  }
});

// ---------------------------------------------------------------- no lockout

describe("no lockout on real sign-in flows (no DB edits)", () => {
  it("password + TOTP sign-in → /api/me 200", async () => {
    const { cookie } = await totpSession("pay259pr2-flow-totp@example.com");
    expect((await get("/api/me", cookie)).statusCode).toBe(200);
    expect((await get("/api/auth/list-sessions", cookie)).statusCode).toBe(200);
  });

  it("password + backup code sign-in → /api/me 200", async () => {
    const email = "pay259pr2-flow-backup@example.com";
    const { backupCodes } = await inviteAndOnboard(t, { email });
    const cookie = await backupCodeSignIn(email, backupCodes[0]!);
    expect((await get("/api/me", cookie)).statusCode).toBe(200);
  });

  it("change-password with revokeOtherSessions from a TOTP session → new cookie, /api/me 200", async () => {
    const { cookie: oldCookie } = await totpSession("pay259pr2-flow-chpw@example.com");
    const res = await authPost("/change-password", oldCookie, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    const newCookie = cookieValue(res.headers["set-cookie"], "payroll.session_token");
    expect(newCookie).toBeTruthy();
    expect(tokenOf(newCookie!)).not.toBe(tokenOf(oldCookie));
    expect((await sessionRow(newCookie!))!.authMethod).toBe("password_totp");
    expect((await get("/api/me", newCookie!)).statusCode).toBe(200);
  });

  it("change-password from a backup-code session → new session 'password_backup_code', /api/me 200", async () => {
    const email = "pay259pr2-flow-chpw-backup@example.com";
    const { backupCodes } = await inviteAndOnboard(t, { email });
    const oldCookie = await backupCodeSignIn(email, backupCodes[0]!);
    const res = await authPost("/change-password", oldCookie, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    const newCookie = cookieValue(res.headers["set-cookie"], "payroll.session_token");
    expect(newCookie).toBeTruthy();
    expect((await sessionRow(newCookie!))!.authMethod).toBe("password_backup_code");
    expect((await get("/api/me", newCookie!)).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------- PAY-217

describe("PAY-217 former employee: the MFA refusal precedes the W-2 scope", () => {
  it("W-2-only former employee with a 'none' session → mfa_required on /api/my/w2 and on a non-W-2 route", async () => {
    const email = "pay259pr2-former-none@example.com";
    const { userId } = await inviteAndOnboard(t, { email });
    const employeeId = await makeFormerW2Only(userId, "Former None");
    const { sessionCookie: cookie } = await login(t, email, TEST_PASSWORD, {
      remoteAddress: freshIp(),
    });
    await setMethod(cookie, "none");
    const w2 = await get("/api/my/w2", cookie);
    const other = await get(`/api/employees/${employeeId}/ping`, cookie);
    expect({
      w2: [w2.statusCode, errorOf(w2)],
      other: [other.statusCode, errorOf(other)],
    }).toEqual({ w2: [403, "mfa_required"], other: [403, "mfa_required"] });
  });

  it("W-2-only former employee with a password_totp session → /api/my/w2 200, non-W-2 route 403 w2_access_only", async () => {
    const email = "pay259pr2-former-totp@example.com";
    const { userId } = await inviteAndOnboard(t, { email });
    const employeeId = await makeFormerW2Only(userId, "Former Totp");
    const { sessionCookie: cookie } = await login(t, email, TEST_PASSWORD, {
      remoteAddress: freshIp(),
    });
    expect((await sessionRow(cookie))!.authMethod).toBe("password_totp");
    const w2 = await get("/api/my/w2", cookie);
    const other = await get(`/api/employees/${employeeId}/ping`, cookie);
    expect({
      w2: w2.statusCode,
      other: [other.statusCode, errorOf(other)],
    }).toEqual({ w2: 200, other: [403, "w2_access_only"] });
  });
});

// ---------------------------------------------------------------- web (SPA)
//
// The web app has no test runner (same method as pay-217-web.test.ts): the
// pure helper is imported by path, the wiring is checked in the source.
// Contract: 403 { error: "mfa_required" } is handled like an expired session.

const ROOT = workspaceRoot(dirname(fileURLToPath(import.meta.url)));
const SESSION_LIB = "apps/web/src/lib/session-expired.ts";
const webSrc = (p: string) =>
  existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p), "utf8") : "";

describe("web: the SPA treats 403 mfa_required like an expired session", () => {
  it("isMfaRequired: true only for 403 { error: 'mfa_required' }", async () => {
    const mod = (await import(/* @vite-ignore */ resolve(ROOT, SESSION_LIB))) as {
      isMfaRequired?: (status: number, body: unknown) => boolean;
    };
    expect(typeof mod.isMfaRequired, `${SESSION_LIB} exports isMfaRequired`).toBe("function");
    const f = mod.isMfaRequired!;
    expect({
      mfa: f(403, { error: "mfa_required" }),
      mfaExtra: f(403, { error: "mfa_required", message: "x" }),
      w2: f(403, { error: "w2_access_only" }),
      forbidden: f(403, { error: "forbidden" }),
      status401: f(401, { error: "mfa_required" }),
      status400: f(400, { error: "mfa_required" }),
      status200: f(200, { error: "mfa_required" }),
      noBody: f(403, undefined),
      nullBody: f(403, null),
      stringBody: f(403, "mfa_required"),
      jsonString: f(403, '{"error":"mfa_required"}'),
      emptyObject: f(403, {}),
      wrongCase: f(403, { error: "MFA_REQUIRED" }),
    }).toEqual({
      mfa: true,
      mfaExtra: true,
      w2: false,
      forbidden: false,
      status401: false,
      status400: false,
      status200: false,
      noBody: false,
      nullBody: false,
      stringBody: false,
      jsonString: false,
      emptyObject: false,
      wrongCase: false,
    });
  });

  it("api.ts routes mfa_required to notifySessionExpired; 401 (outside onboarding) and w2_access_only handling kept", () => {
    const api = webSrc("apps/web/src/lib/api.ts");
    expect(api.length, "apps/web/src/lib/api.ts exists").toBeGreaterThan(0);
    // Imports the helper and the notifier from the session-expired module.
    expect(api).toMatch(
      /import\s*\{[^}]*\bisMfaRequired\b[^}]*\}\s*from\s*["']\.\/session-expired["']/,
    );
    expect(api).toMatch(
      /import\s*\{[^}]*\bnotifySessionExpired\b[^}]*\}\s*from\s*["']\.\/session-expired["']/,
    );
    // An `if` whose condition calls isMfaRequired(...) and whose branch calls notifySessionExpired().
    expect(api).toMatch(/if\s*\([^{;]*\bisMfaRequired\([^{;]*\)\s*\{?\s*notifySessionExpired\(\)/);
    // 401 outside /api/onboarding/ still expires the session.
    expect(api).toMatch(
      /status\s*===\s*401\s*&&\s*!\s*path\.startsWith\(\s*["']\/api\/onboarding\/["']\s*\)/,
    );
    // w2_access_only still goes to the W-2 screen.
    expect(api).toMatch(/if\s*\(\s*isW2AccessOnly\([^)]*\)\s*\)\s*\{?\s*notifyW2AccessOnly\(\)/);
  });

  it("auth-client.ts onError calls notifySessionExpired for 401 or isMfaRequired(status, ctx.error)", () => {
    const client = webSrc("apps/web/src/lib/auth-client.ts");
    expect(client.length, "apps/web/src/lib/auth-client.ts exists").toBeGreaterThan(0);
    expect(client).toMatch(
      /import\s*\{[^}]*\bisMfaRequired\b[^}]*\}\s*from\s*["']\.\/session-expired["']/,
    );
    const onError = client.slice(client.indexOf("onError"));
    expect(client.indexOf("onError"), "onError handler present").toBeGreaterThanOrEqual(0);
    expect(onError).toMatch(
      /if\s*\([^{;]*ctx\.response\.status\s*===\s*401[^{;]*\|\|[^{;]*isMfaRequired\(\s*ctx\.response\.status\s*,\s*ctx\.error\s*\)[^{;]*\)\s*\{?\s*notifySessionExpired\(\)/,
    );
  });
});

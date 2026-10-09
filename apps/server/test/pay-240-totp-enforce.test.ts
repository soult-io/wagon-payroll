/**
 * PAY-240: TOTP is required for every session.
 *
 * - Better Auth's two-factor management paths (disable, enable,
 *   get-totp-uri) are disabled: a full session with the right password
 *   cannot change or read the user's TOTP enrollment.
 * - requireAuth refuses a session whose user has twoFactorEnabled !== true
 *   with 403 mfa_required, on every guard class (requireAuth, requireRole,
 *   requireEmployeeSelf, PAY-217 formerEmployeeW2 opt-in routes).
 * - The /api/auth mount gives such a session only sign-in, get-session and
 *   sign-out (not the TOTP / backup-code verify paths of the PAY-217
 *   former-employee allowlist); any other Better Auth path answers 403
 *   mfa_required and changes nothing.
 * - Such a session still meets the 12h idle revocation (401 session_expired
 *   before the MFA refusal), and BA's email-OTP paths (send-otp, verify-otp)
 *   are disabled.
 * - Regression: onboarding enrollment, admin reset + re-enrollment, and a
 *   fully enrolled user's session keep working.
 *
 * Synthetic data only (example.com users).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  authAccount,
  authEvents,
  authSession,
  authTwoFactor,
  authUser,
  company,
  employees,
  w2Furnishings,
} from "@payroll/db";
import { generateRandomString, symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import { createTestApp, cookieValue, ORIGIN, type TestContext } from "./helpers.js";
import { currentTotp, login, sessionHeader, TEST_PASSWORD, tokenFromLink } from "./flow-helpers.js";
import { inviteUser } from "../src/auth/users.js";
import { formerEmployeeAccess } from "../src/auth/former-employee.js";

/**
 * Fixed company-local wall clock for the PAY-217 (j)(6) window: TY2025 is
 * online through 2026-10-15, so a terminated employee with a TY2025
 * portal_notice is "w2_only" on this date.
 */
const NOW = new Date("2026-03-02T15:00:00Z");
const TODAY = "2026-03-02";
const NEW_PASSWORD = "violet-anchor-quarry-lantern-42";

let t: TestContext;
beforeAll(async () => {
  t = await createTestApp({}, { clock: () => NOW });
});
afterAll(async () => {
  await t.close();
});

// Every credential / onboarding route is rate limited per client address;
// give each call its own address so the file's many sign-ins never trip it.
let ipSeq = 0;
function freshIp(): string {
  ipSeq += 1;
  return `10.240.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
}
function ipHeaders(ip: string) {
  return { ...ORIGIN, "x-forwarded-for": ip };
}

/** Onboarding via HTTP for an invite or reset token (verify-token → totp-verify). */
async function enrollWithToken(token: string, userId: string): Promise<void> {
  const ip = freshIp();
  const post = (url: string, payload: unknown) =>
    t.app.inject({ method: "POST", url, headers: ipHeaders(ip), remoteAddress: ip, payload });
  const steps: [string, unknown][] = [
    ["/api/onboarding/verify-token", { token }],
    ["/api/onboarding/set-password", { token, password: TEST_PASSWORD }],
    ["/api/onboarding/totp-enable", { token }],
  ];
  for (const [url, payload] of steps) {
    const res = await post(url, payload);
    if (res.statusCode !== 200) throw new Error(`${url} ${res.statusCode}: ${res.body}`);
  }
  const code = await currentTotp(t, userId);
  const verify = await post("/api/onboarding/totp-verify", { token, code });
  if (verify.statusCode !== 200)
    throw new Error(`totp-verify ${verify.statusCode}: ${verify.body}`);
}

/** Invite (service call) + full enrollment over HTTP. */
async function onboard(email: string, role: "admin" | "employee" = "employee"): Promise<string> {
  const invite = await inviteUser(
    { auth: t.auth, db: t.db, config: t.config },
    { name: email.split("@")[0]!, email, role },
    null,
  );
  await enrollWithToken(tokenFromLink(invite.setupLink), invite.userId);
  return invite.userId;
}

/** Full password + TOTP login from a fresh address. */
async function fullLogin(email: string, password = TEST_PASSWORD): Promise<string> {
  const { sessionCookie } = await login(t, email, password, { remoteAddress: freshIp() });
  return sessionCookie;
}

/** Put the user in the "2FA off" state: flag false, no twoFactor row. */
async function strip2fa(userId: string): Promise<void> {
  await t.db.update(authUser).set({ twoFactorEnabled: false }).where(eq(authUser.id, userId));
  await t.db.delete(authTwoFactor).where(eq(authTwoFactor.userId, userId));
}

/** POST /sign-in/email for a user without 2FA: Better Auth issues the session directly. */
async function passwordOnlySignIn(email: string, password = TEST_PASSWORD) {
  const ip = freshIp();
  return t.app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: ipHeaders(ip),
    remoteAddress: ip,
    payload: { email, password },
  });
}

/** A password-only session cookie for a freshly onboarded user. */
async function passwordOnlySession(
  email: string,
  role: "admin" | "employee" = "employee",
): Promise<{ userId: string; cookie: string }> {
  const userId = await onboard(email, role);
  await strip2fa(userId);
  const res = await passwordOnlySignIn(email);
  if (res.statusCode !== 200) throw new Error(`sign-in ${res.statusCode}: ${res.body}`);
  if ((res.json() as { twoFactorRedirect?: boolean }).twoFactorRedirect === true) {
    throw new Error("expected no 2FA challenge for a user without 2FA");
  }
  const cookie = cookieValue(res.headers["set-cookie"], "payroll.session_token");
  if (!cookie) throw new Error("no session cookie from password-only sign-in");
  return { userId, cookie };
}

async function linkEmployee(
  userId: string,
  legalName: string,
  status: "active" | "terminated" = "active",
): Promise<number> {
  const [co] = await t.db.insert(company).values({ legalName: "Test Co" }).returning();
  const [emp] = await t.db
    .insert(employees)
    .values({
      userId,
      companyId: co!.id,
      legalName,
      hireDate: "2025-01-01",
      status,
      ...(status === "terminated" ? { terminationDate: "2025-12-31" } : {}),
    })
    .returning();
  return emp!.id;
}

/** Terminated employee with a TY2025 W-2 furnished online → PAY-217 "w2_only" on TODAY. */
async function makeFormerW2Only(userId: string, legalName: string): Promise<void> {
  const employeeId = await linkEmployee(userId, legalName, "terminated");
  await t.db.insert(w2Furnishings).values({
    employeeId,
    taxYear: 2025,
    boxesHash: "a".repeat(64),
    corrected: false,
    method: "portal_notice",
    furnishedAt: new Date("2026-01-15T15:00:00Z"),
  });
  const access = await formerEmployeeAccess(t.db, userId, TODAY, t.config.appTz);
  if (access.kind !== "w2_only") throw new Error(`fixture not w2_only: ${access.kind}`);
}

async function userRow(userId: string) {
  const [u] = await t.db.select().from(authUser).where(eq(authUser.id, userId));
  return u!;
}
async function twoFactorRows(userId: string) {
  return t.db.select().from(authTwoFactor).where(eq(authTwoFactor.userId, userId));
}
async function passwordHash(userId: string): Promise<string | null> {
  const [a] = await t.db
    .select({ password: authAccount.password })
    .from(authAccount)
    .where(eq(authAccount.userId, userId));
  return a?.password ?? null;
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
function get(url: string, cookie: string) {
  return t.app.inject({ method: "GET", url, headers: sessionHeader(cookie) });
}

// ---------------------------------------------------------------------------
// 1. Two-factor management paths are disabled
// ---------------------------------------------------------------------------

describe("PAY-240 two-factor management paths are disabled", () => {
  it("POST /two-factor/disable with a full session and the right password changes nothing", async () => {
    const email = "pay240-disable@example.com";
    const userId = await onboard(email);
    const cookie = await fullLogin(email);
    const before = await twoFactorRows(userId);
    expect(before).toHaveLength(1);

    const res = await authPost("/two-factor/disable", cookie, { password: TEST_PASSWORD });

    expect((await userRow(userId)).twoFactorEnabled).toBe(true);
    const after = await twoFactorRows(userId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[0]!.secret).toBe(before[0]!.secret);
    // Repo convention for a Better Auth disabled path (it answers 404).
    expect([403, 404]).toContain(res.statusCode);
  });

  it("POST /two-factor/enable with a full session and the right password changes nothing", async () => {
    const email = "pay240-enable@example.com";
    const userId = await onboard(email);
    const cookie = await fullLogin(email);
    const before = await twoFactorRows(userId);

    const res = await authPost("/two-factor/enable", cookie, { password: TEST_PASSWORD });

    expect(res.body).not.toContain("otpauth://");
    expect((await userRow(userId)).twoFactorEnabled).toBe(true);
    const after = await twoFactorRows(userId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[0]!.secret).toBe(before[0]!.secret);
    expect(after[0]!.backupCodes).toBe(before[0]!.backupCodes);
    expect([403, 404]).toContain(res.statusCode);
  });

  it("POST /two-factor/get-totp-uri with a full session and the right password reveals no secret", async () => {
    const email = "pay240-uri@example.com";
    const userId = await onboard(email);
    const cookie = await fullLogin(email);
    const before = await twoFactorRows(userId);
    const ctx = await t.auth.$context;
    const secret = await symmetricDecrypt({ key: ctx.secretConfig, data: before[0]!.secret });

    const res = await authPost("/two-factor/get-totp-uri", cookie, { password: TEST_PASSWORD });

    expect(res.body).not.toContain("otpauth://");
    expect(res.body).not.toContain(secret);
    expect((await userRow(userId)).twoFactorEnabled).toBe(true);
    const after = await twoFactorRows(userId);
    expect(after[0]!.secret).toBe(before[0]!.secret);
    expect([403, 404]).toContain(res.statusCode);
  });
});

// ---------------------------------------------------------------------------
// 2. requireAuth refuses a session without 2FA
// ---------------------------------------------------------------------------

describe("PAY-240 requireAuth refuses a session whose user has no 2FA", () => {
  it("employee route GET /api/me → 403 mfa_required", async () => {
    const { cookie } = await passwordOnlySession("pay240-po-me@example.com");
    const res = await get("/api/me", cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "mfa_required" });
  });

  it("employee-self route (requireEmployeeSelf) → 403 mfa_required", async () => {
    const { userId, cookie } = await passwordOnlySession("pay240-po-self@example.com");
    const employeeId = await linkEmployee(userId, "Po Self");
    const res = await get(`/api/employees/${employeeId}/ping`, cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "mfa_required" });
  });

  it("admin route (requireRole admin) GET /api/admin/ping → 403 mfa_required", async () => {
    const { cookie } = await passwordOnlySession("pay240-po-admin@example.com", "admin");
    const res = await get("/api/admin/ping", cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "mfa_required" });
  });

  it("formerEmployeeW2 route GET /api/my/w2 for a W-2-only former employee → 403 mfa_required", async () => {
    const { userId, cookie } = await passwordOnlySession("pay240-po-former@example.com");
    await makeFormerW2Only(userId, "Po Former");
    const res = await get("/api/my/w2", cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "mfa_required" });
    const me = await get("/api/me", cookie);
    expect(me.statusCode).toBe(403);
    expect(me.json()).toEqual({ error: "mfa_required" });
  });

  it("formerEmployeeW2 route GET /api/my/w2 for an active employee → 403 mfa_required", async () => {
    const { userId, cookie } = await passwordOnlySession("pay240-po-w2@example.com");
    await linkEmployee(userId, "Po Active W2");
    const res = await get("/api/my/w2", cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "mfa_required" });
  });

  it("a session issued with 2FA is refused once the user's twoFactorEnabled is false", async () => {
    const email = "pay240-flip@example.com";
    const userId = await onboard(email);
    const cookie = await fullLogin(email);
    expect((await get("/api/me", cookie)).statusCode).toBe(200);

    await t.db.update(authUser).set({ twoFactorEnabled: false }).where(eq(authUser.id, userId));
    const res = await get("/api/me", cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "mfa_required" });
  });
});

// ---------------------------------------------------------------------------
// 3. /api/auth mount: a session without 2FA reaches only the allowlist
// ---------------------------------------------------------------------------

describe("PAY-240 /api/auth mount limits a session without 2FA", () => {
  it("POST /change-password → 403 mfa_required and the password is unchanged", async () => {
    const email = "pay240-po-chpw@example.com";
    const { userId, cookie } = await passwordOnlySession(email);
    const hashBefore = await passwordHash(userId);
    expect(hashBefore).toBeTruthy();

    const res = await authPost("/change-password", cookie, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(await passwordHash(userId)).toBe(hashBefore);
    expect((await passwordOnlySignIn(email, TEST_PASSWORD)).statusCode).toBe(200);
    expect((await passwordOnlySignIn(email, NEW_PASSWORD)).statusCode).not.toBe(200);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "mfa_required" });
  });

  it("GET /get-session and POST /sign-out still answer 200", async () => {
    const { userId, cookie } = await passwordOnlySession("pay240-po-allow@example.com");
    const session = await get("/api/auth/get-session", cookie);
    expect(session.statusCode).toBe(200);
    expect((session.json() as { user?: { id?: string } }).user?.id).toBe(userId);

    const out = await authPost("/sign-out", cookie, {});
    expect(out.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 4. Regression: enrollment and admin reset + re-enrollment keep working
// ---------------------------------------------------------------------------

describe("PAY-240 regression: enrollment and re-enrollment", () => {
  it("onboarding enrolls TOTP; full sessions reach /api/me and /api/admin/ping", async () => {
    const empEmail = "pay240-enrolled-emp@example.com";
    const empId = await onboard(empEmail);
    expect((await userRow(empId)).twoFactorEnabled).toBe(true);
    const empCookie = await fullLogin(empEmail);
    const me = await get("/api/me", empCookie);
    expect(me.statusCode).toBe(200);
    expect(me.json().user.twoFactorEnabled).toBe(true);

    const admEmail = "pay240-enrolled-adm@example.com";
    const admId = await onboard(admEmail, "admin");
    expect((await userRow(admId)).twoFactorEnabled).toBe(true);
    const admCookie = await fullLogin(admEmail);
    const ping = await get("/api/admin/ping", admCookie);
    expect(ping.statusCode).toBe(200);
    expect(ping.json().scope).toBe("admin");
  });

  it("admin reset → the user re-enrolls through the setup link and signs in with 2FA", async () => {
    const admEmail = "pay240-reset-adm@example.com";
    await onboard(admEmail, "admin");
    const admCookie = await fullLogin(admEmail);

    const email = "pay240-reset-user@example.com";
    const userId = await onboard(email);
    const oldCookie = await fullLogin(email);

    const reset = await t.app.inject({
      method: "POST",
      url: `/api/admin/users/${userId}/reset`,
      headers: sessionHeader(admCookie),
    });
    expect(reset.statusCode).toBe(200);
    const { setupLink } = reset.json() as { setupLink: string };
    expect((await userRow(userId)).twoFactorEnabled).toBe(false);
    expect((await get("/api/me", oldCookie)).statusCode).toBe(401);

    await enrollWithToken(tokenFromLink(setupLink), userId);
    expect((await userRow(userId)).twoFactorEnabled).toBe(true);
    const cookie = await fullLogin(email);
    const me = await get("/api/me", cookie);
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(userId);
  });
});

// ---------------------------------------------------------------------------
// 5. A fully enrolled user's session is not refused by the new check
// ---------------------------------------------------------------------------

describe("PAY-240 a fully enrolled session is not refused", () => {
  it("passes requireAuth, requireEmployeeSelf and the formerEmployeeW2 route", async () => {
    const email = "pay240-full@example.com";
    const userId = await onboard(email);
    const employeeId = await linkEmployee(userId, "Full Enrolled");
    const cookie = await fullLogin(email);

    expect((await get("/api/me", cookie)).statusCode).toBe(200);
    const self = await get(`/api/employees/${employeeId}/ping`, cookie);
    expect(self.statusCode).toBe(200);
    expect(self.json().scope).toBe("employee-self");
    expect((await get("/api/my/w2", cookie)).statusCode).toBe(200);
    const session = await get("/api/auth/get-session", cookie);
    expect(session.statusCode).toBe(200);
  });

  it("a W-2-only former employee with 2FA still reaches /api/me and /api/my/w2 (PAY-217)", async () => {
    const email = "pay240-full-former@example.com";
    const userId = await onboard(email);
    await makeFormerW2Only(userId, "Full Former");
    const cookie = await fullLogin(email);

    const me = await get("/api/me", cookie);
    expect(me.statusCode).toBe(200);
    expect(me.json().access).toBe("w2_only");
    expect((await get("/api/my/w2", cookie)).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Round 2 A. A session without 2FA cannot use the TOTP / backup-code verify paths
// ---------------------------------------------------------------------------

describe("PAY-240 round 2: verify paths are closed to a session without 2FA", () => {
  it("POST /two-factor/verify-totp with a valid code for an unverified row → 403 mfa_required, 2FA stays off", async () => {
    const { userId, cookie } = await passwordOnlySession("pay240-r2-vtotp@example.com");
    // An unverified twoFactor row whose secret the test knows (same shape as
    // onboarding's totp-enable writes).
    const ctx = await t.auth.$context;
    const secret = generateRandomString(32);
    await ctx.adapter.create({
      model: "twoFactor",
      data: {
        userId,
        secret: await symmetricEncrypt({ key: ctx.secretConfig, data: secret }),
        backupCodes: "[]",
        verified: false,
      },
    });
    const code = await createOTP(secret, { digits: 6, period: 30 }).totp();

    const res = await authPost("/two-factor/verify-totp", cookie, { code });

    expect((await userRow(userId)).twoFactorEnabled).not.toBe(true);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "mfa_required" });
  });

  it("POST /backup-code/verify → 403 mfa_required, backup codes unchanged", async () => {
    const email = "pay240-r2-bcode@example.com";
    const userId = await onboard(email);
    // 2FA flag off but the enrolled row (with its backup codes) kept.
    await t.db.update(authUser).set({ twoFactorEnabled: false }).where(eq(authUser.id, userId));
    const signIn = await passwordOnlySignIn(email);
    const cookie = cookieValue(signIn.headers["set-cookie"], "payroll.session_token");
    if (!cookie) throw new Error(`no session cookie: ${signIn.body}`);
    const [before] = await twoFactorRows(userId);

    const res = await authPost("/backup-code/verify", cookie, { code: "AAAAA-BBBBB" });

    const [after] = await twoFactorRows(userId);
    expect(after!.backupCodes).toBe(before!.backupCodes);
    expect(cookieValue(res.headers["set-cookie"], "payroll.session_token")).toBeNull();
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "mfa_required" });
  });
});

// ---------------------------------------------------------------------------
// Round 2 B. Idle revocation applies before the MFA refusal
// ---------------------------------------------------------------------------

describe("PAY-240 round 2: idle revocation for a session without 2FA", () => {
  it("a no-2FA session idle for more than 12h → 401 session_expired, row deleted, session_revoked event", async () => {
    const { userId, cookie } = await passwordOnlySession("pay240-r2-idle@example.com");
    const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60 * 1000);
    await t.db
      .update(authSession)
      .set({ updatedAt: thirteenHoursAgo })
      .where(eq(authSession.userId, userId));

    const res = await get("/api/me", cookie);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "session_expired" });
    const sessions = await t.db.select().from(authSession).where(eq(authSession.userId, userId));
    expect(sessions).toHaveLength(0);
    const revoked = await t.db
      .select()
      .from(authEvents)
      .where(and(eq(authEvents.userId, userId), eq(authEvents.event, "session_revoked")));
    expect(revoked.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Round 2 C. Better Auth's email-OTP two-factor paths are disabled
// ---------------------------------------------------------------------------

describe("PAY-240 round 2: two-factor OTP paths are disabled", () => {
  it("POST /two-factor/send-otp with a full session → disabled, 2FA unchanged", async () => {
    const email = "pay240-r2-sendotp@example.com";
    const userId = await onboard(email);
    const cookie = await fullLogin(email);
    const [before] = await twoFactorRows(userId);

    const res = await authPost("/two-factor/send-otp", cookie, {});

    expect((await userRow(userId)).twoFactorEnabled).toBe(true);
    const [after] = await twoFactorRows(userId);
    expect(after!.secret).toBe(before!.secret);
    // Repo convention for a Better Auth disabled path (it answers 404).
    expect([403, 404]).toContain(res.statusCode);
  });

  it("POST /two-factor/verify-otp with a full session → disabled, 2FA unchanged", async () => {
    const email = "pay240-r2-verifyotp@example.com";
    const userId = await onboard(email);
    const cookie = await fullLogin(email);
    const [before] = await twoFactorRows(userId);

    const res = await authPost("/two-factor/verify-otp", cookie, { code: "123456" });

    expect((await userRow(userId)).twoFactorEnabled).toBe(true);
    const [after] = await twoFactorRows(userId);
    expect(after!.secret).toBe(before!.secret);
    expect([403, 404]).toContain(res.statusCode);
  });
});

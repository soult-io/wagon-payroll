/**
 * PAY-261: Better Auth's two-factor "trust device" must never let a
 * password-only sign-in skip TOTP (PAY-240: every session passes TOTP).
 *
 * better-auth 1.7.14: verify-totp with `trustDevice: true` sets a signed
 * `trust_device` cookie (30 days). On a later /sign-in/email from a browser
 * holding it, the twoFactor after-hook returns early and keeps the
 * password-only session. The web client never sends trustDevice, but any
 * client could.
 *
 * - verify-totp through the /api/auth mount sets no trust_device cookie,
 *   even when the body asks for one.
 * - A valid trust_device cookie (minted straight from Better Auth, bypassing
 *   the mount, as an older build or a crafted client could have) is ignored
 *   by the mount: sign-in still answers with the 2FA challenge and no session.
 * - The __Secure- (production) cookie name is ignored the same way.
 * - Regression: other cookies in the same header still reach Better Auth.
 *
 * Synthetic data only (example.com users).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, cookieValue, ORIGIN, type TestContext } from "./helpers.js";
import {
  currentTotp,
  inviteAndOnboard,
  login,
  TEST_PASSWORD,
  userIdByEmail,
} from "./flow-helpers.js";
import { withoutTrustDeviceCookie } from "../src/auth/fastify-mount.js";

let t: TestContext;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

let ipSeq = 0;
function freshIp(): string {
  ipSeq += 1;
  return `10.61.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
}
function ipHeaders(ip: string) {
  return { ...ORIGIN, "x-forwarded-for": ip };
}

/** Password step through the mount; returns the two_factor challenge cookie value. */
async function passwordStep(email: string, ip: string, cookie?: string) {
  return t.app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { ...ipHeaders(ip), ...(cookie ? { cookie } : {}) },
    remoteAddress: ip,
    payload: { email, password: TEST_PASSWORD },
  });
}

/**
 * A valid trust_device cookie straight from Better Auth (not through the
 * mount): password step + verify-totp with trustDevice: true.
 */
async function mintTrustCookie(email: string): Promise<string> {
  const ip = freshIp();
  const signIn = await passwordStep(email, ip);
  const challenge = cookieValue(signIn.headers["set-cookie"], "payroll.two_factor");
  if (!challenge) throw new Error(`no 2FA challenge: ${signIn.body}`);
  const code = await currentTotp(t, await userIdByEmail(t, email));
  const res = await t.auth.handler(
    new Request(new URL("/api/auth/two-factor/verify-totp", t.config.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN.origin,
        "x-forwarded-for": ip,
        cookie: `payroll.two_factor=${challenge}`,
      },
      body: JSON.stringify({ code, trustDevice: true }),
    }),
  );
  if (res.status !== 200) throw new Error(`direct verify-totp ${res.status}: ${await res.text()}`);
  const trust = cookieValue(res.headers.getSetCookie(), "payroll.trust_device");
  if (!trust) throw new Error("Better Auth set no trust_device cookie");
  return trust;
}

describe("PAY-261 verify-totp through the mount sets no trust_device cookie", () => {
  it("trustDevice: true in the body → session issued, no trust_device cookie", async () => {
    const { email } = await inviteAndOnboard(t, { email: "pay261-a@example.com" });
    const ip = freshIp();
    const signIn = await passwordStep(email, ip);
    const challenge = cookieValue(signIn.headers["set-cookie"], "payroll.two_factor");
    expect(challenge).toBeTruthy();
    const code = await currentTotp(t, await userIdByEmail(t, email));
    const verify = await t.app.inject({
      method: "POST",
      url: "/api/auth/two-factor/verify-totp",
      headers: { ...ipHeaders(ip), cookie: `payroll.two_factor=${challenge}` },
      remoteAddress: ip,
      payload: { code, trustDevice: true },
    });
    expect(verify.statusCode).toBe(200);
    expect(cookieValue(verify.headers["set-cookie"], "payroll.session_token")).toBeTruthy();
    expect(cookieValue(verify.headers["set-cookie"], "payroll.trust_device")).toBeNull();
  });
});

describe("PAY-261 a valid trust_device cookie does not skip TOTP", () => {
  it("sign-in with the trust cookie → 2FA challenge, no session cookie", async () => {
    const { email } = await inviteAndOnboard(t, { email: "pay261-b@example.com" });
    const trust = await mintTrustCookie(email);
    const res = await passwordStep(email, freshIp(), `payroll.trust_device=${trust}`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    // twoFactor deletes the password-only session and expires its cookie (empty value).
    expect(cookieValue(res.headers["set-cookie"], "payroll.session_token") ?? "").toBe("");
    expect(cookieValue(res.headers["set-cookie"], "payroll.two_factor")).toBeTruthy();
  });

  it("the TOTP step after it still completes the sign-in (regression)", async () => {
    const { email } = await inviteAndOnboard(t, { email: "pay261-c@example.com" });
    await mintTrustCookie(email);
    const { sessionCookie } = await login(t, email, TEST_PASSWORD, { remoteAddress: freshIp() });
    expect(sessionCookie).toBeTruthy();
  });
});

describe("PAY-261 withoutTrustDeviceCookie", () => {
  it("drops the plain and __Secure- trust_device cookies", () => {
    expect(withoutTrustDeviceCookie("payroll.trust_device=abc")).toBeUndefined();
    expect(withoutTrustDeviceCookie("__Secure-payroll.trust_device=abc")).toBeUndefined();
  });

  it("keeps every other cookie, in order", () => {
    expect(
      withoutTrustDeviceCookie(
        "payroll.session_token=s1; payroll.trust_device=abc; payroll.two_factor=t1",
      ),
    ).toBe("payroll.session_token=s1; payroll.two_factor=t1");
    expect(withoutTrustDeviceCookie("a=1; b=2")).toBe("a=1; b=2");
    expect(withoutTrustDeviceCookie("not_trust_device=1")).toBe("not_trust_device=1");
  });

  it("passes a missing header through", () => {
    expect(withoutTrustDeviceCookie(undefined)).toBeUndefined();
  });
});

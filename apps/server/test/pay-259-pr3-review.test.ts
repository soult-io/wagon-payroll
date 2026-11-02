/**
 * PAY-259 PR 3 — review-round contract (code-reviewer + security).
 *
 * H1 (step-up) a session rotated by /change-password keeps the replaced
 *    session's createdAt, so a password change does not refresh step-up.
 * H2 any /api/auth path not in normal form → 400 { error: "invalid_path" },
 *    never reaches Better Auth, and counts in the 10/min credential bucket.
 * Rate-limit buckets: the query string cannot move a request into another
 *    bucket; sign-in (10/min) and passkey options (30/min) are separate;
 *    IPv6 clients are grouped by /64.
 * S5 verify-registration with a credential id over 1023 bytes →
 *    400 PASSKEY_CREDENTIAL_ID_TOO_LONG.
 *
 * Test author; the coder may not edit this file. Synthetic data only.
 */

import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, cookieValue, ORIGIN, type TestContext } from "./helpers.js";
import {
  codeOf,
  harness,
  type Harness,
  newAuthenticator,
  type Res,
  sessionHeader,
  TEST_PASSWORD,
  tokenOf,
} from "./pay-259-pr3-harness.js";
import { b64url, PASSKEY_CHALLENGE_COOKIE, rawCookiePair } from "./webauthn-soft-authenticator.js";

const NEW_PASSWORD = "violet-anchor-quarry-lantern-42";

let t: TestContext;
let h: Harness;
let port = 0;
beforeAll(async () => {
  t = await createTestApp();
  h = harness(t, 208);
  await t.app.listen({ port: 0, host: "127.0.0.1" });
  port = (t.app.server.address() as AddressInfo).port;
});
afterAll(async () => {
  await t.close();
});

async function createdAt(cookie: string): Promise<number> {
  const r = await t.pglite.query<{ createdAt: Date }>(
    `select "createdAt" from "session" where "token" = $1`,
    [tokenOf(cookie)],
  );
  if (r.rows.length !== 1) throw new Error("no session row");
  return new Date(r.rows[0]!.createdAt).getTime();
}

async function changePassword(
  cookie: string,
  newPassword: string,
): Promise<{ res: Res; cookie: string }> {
  const res = await h.auth("POST", "/change-password", {
    cookie,
    payload: { currentPassword: TEST_PASSWORD, newPassword, revokeOtherSessions: true },
  });
  const next = cookieValue(res.headers["set-cookie"], "payroll.session_token");
  if (res.statusCode !== 200 || !next) {
    throw new Error(`change-password ${res.statusCode}: ${res.body.slice(0, 120)}`);
  }
  return { res, cookie: next };
}

async function countRows(table: string): Promise<number> {
  const r = await t.pglite.query<{ n: number }>(`select count(*)::int as n from "${table}"`);
  return r.rows[0]!.n;
}

interface RawRes {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  json: () => unknown;
}

/**
 * A request sent over a real socket with the path exactly as given.
 * app.inject (light-my-request) resolves "." / ".." segments through
 * new URL() before the app sees them, so it cannot send a non-normal path.
 */
function raw(method: "GET" | "POST", url: string, ip: string, payload?: unknown): Promise<RawRes> {
  const body = method === "POST" ? JSON.stringify(payload ?? {}) : undefined;
  return new Promise((resolveRes, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path: url,
        headers: {
          ...ORIGIN,
          host: "localhost",
          "x-forwarded-for": ip,
          ...(body
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolveRes({
            statusCode: res.statusCode ?? 0,
            body: text,
            headers: res.headers,
            json: () => JSON.parse(text),
          });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const BAD_LOGIN = { email: "pr3-nobody@example.com", password: "not-the-password-0000" };

// ---------------------------------------------------------------- H1

describe("H1 /change-password keeps the replaced session's createdAt", () => {
  it("a 30-minute-old session → change-password 200 → new row keeps createdAt → register options 403 SESSION_NOT_FRESH; verify-registration refused, no row", async () => {
    const { userId, cookie } = await h.totpUser("pr3-r-cp-stale@example.com");
    // Challenge issued while fresh, so verify-registration can be tried after the rotation.
    const a = newAuthenticator();
    const opt = await h.auth("GET", "/passkey/generate-register-options", { cookie });
    expect(opt.statusCode).toBe(200);
    const challenge = rawCookiePair(opt.headers["set-cookie"], PASSKEY_CHALLENGE_COOKIE);
    await h.ageSession(cookie, 30);
    const oldCreatedAt = await createdAt(cookie);

    const rotated = await changePassword(cookie, NEW_PASSWORD);
    expect(tokenOf(rotated.cookie)).not.toBe(tokenOf(cookie));
    expect(await createdAt(rotated.cookie)).toBe(oldCreatedAt);

    const again = await h.auth("GET", "/passkey/generate-register-options", {
      cookie: rotated.cookie,
    });
    expect([again.statusCode, codeOf(again)]).toEqual([403, "SESSION_NOT_FRESH"]);

    const verify = await h.auth("POST", "/passkey/verify-registration", {
      cookie: rotated.cookie,
      extra: challenge,
      payload: { response: a.register(opt.json() as { challenge: string }) },
    });
    expect([verify.statusCode, codeOf(verify)]).toEqual([403, "SESSION_NOT_FRESH"]);
    expect(await h.passkeys(userId)).toEqual([]);
  });

  it("a seconds-old session → change-password → register options still 200", async () => {
    const { cookie } = await h.totpUser("pr3-r-cp-fresh@example.com");
    const before = await createdAt(cookie);
    const rotated = await changePassword(cookie, NEW_PASSWORD);
    expect(await createdAt(rotated.cookie)).toBe(before);
    const opt = await h.auth("GET", "/passkey/generate-register-options", {
      cookie: rotated.cookie,
    });
    expect(opt.statusCode).toBe(200);
  });

  it("the rotated session reaches /api/me (no lockout, still an MFA session)", async () => {
    const { userId, cookie } = await h.totpUser("pr3-r-cp-me@example.com");
    await h.ageSession(cookie, 30);
    const rotated = await changePassword(cookie, NEW_PASSWORD);
    const me = await t.app.inject({
      method: "GET",
      url: "/api/me",
      headers: sessionHeader(rotated.cookie),
    });
    expect(me.statusCode).toBe(200);
    expect((await h.sessionRow(rotated.cookie))?.authMethod).toBe("password_totp");
    const u = await t.pglite.query<{ banned: boolean | null }>(
      `select banned from "user" where id = $1`,
      [userId],
    );
    expect(u.rows[0]!.banned).not.toBe(true);
  });
});

// ---------------------------------------------------------------- H2

describe("H2 /api/auth paths must be in normal form", () => {
  const CASES: { method: "GET" | "POST"; url: string; payload?: unknown }[] = [
    { method: "GET", url: "/api/auth/./passkey/generate-authenticate-options" },
    {
      method: "POST",
      url: "/api/auth/x/../passkey/verify-authentication",
      payload: { response: { id: "x", rawId: "x", type: "public-key", response: {} } },
    },
    { method: "POST", url: "/api/auth/./sign-in/email", payload: BAD_LOGIN },
  ];

  for (const c of CASES) {
    it(`${c.method} ${c.url} → 400 invalid_path; Better Auth not reached`, async () => {
      const verification = await countRows("verification");
      const events = await countRows("auth_events");
      const res = await raw(c.method, c.url, h.ip(), c.payload);
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error?: unknown }).error).toBe("invalid_path");
      expect(rawCookiePair(res.headers["set-cookie"], PASSKEY_CHALLENGE_COOKIE)).toBeNull();
      expect(await countRows("verification")).toBe(verification);
      expect(await countRows("auth_events")).toBe(events);
    });
  }

  it("non-normal paths count in the 10/min credential bucket: the 11th → 429 (even for the options path)", async () => {
    const ip = h.ip();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push(
        (await raw("GET", "/api/auth/./passkey/generate-authenticate-options", ip)).statusCode,
      );
    }
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(400));
    expect(codes[10]).toBe(429);
  });

  it("mixed non-normal paths share that bucket with sign-in: 10 bad paths then a real sign-in → 429", async () => {
    const ip = h.ip();
    for (let i = 0; i < 10; i++) {
      const c = CASES[i % CASES.length]!;
      expect((await raw(c.method, c.url, ip, c.payload)).statusCode).toBe(400);
    }
    expect((await raw("POST", "/api/auth/sign-in/email", ip, BAD_LOGIN)).statusCode).toBe(429);
  });
});

// ---------------------------------------------------------------- buckets

describe("rate-limit buckets", () => {
  it("the query string cannot move sign-in into the 30/min options bucket: the 11th → 429", async () => {
    const ip = h.ip();
    const url = "/api/auth/sign-in/email?x=/api/auth/passkey/generate-authenticate-options";
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await raw("POST", url, ip, BAD_LOGIN)).statusCode);
    expect(codes.slice(0, 10).every((c) => c !== 429)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it("10 sign-ins do not consume the options bucket's 30", async () => {
    const ip = h.ip();
    for (let i = 0; i < 10; i++) {
      expect((await raw("POST", "/api/auth/sign-in/email", ip, BAD_LOGIN)).statusCode).not.toBe(
        429,
      );
    }
    const codes: number[] = [];
    for (let i = 0; i < 30; i++) {
      codes.push(
        (await raw("GET", "/api/auth/passkey/generate-authenticate-options", ip)).statusCode,
      );
    }
    expect(codes).toEqual(Array(30).fill(200));
  });

  it("30 options calls do not consume sign-in's 10", async () => {
    const ip = h.ip();
    for (let i = 0; i < 30; i++) {
      expect(
        (await raw("GET", "/api/auth/passkey/generate-authenticate-options", ip)).statusCode,
      ).toBe(200);
    }
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) {
      codes.push((await raw("POST", "/api/auth/sign-in/email", ip, BAD_LOGIN)).statusCode);
    }
    expect(codes.filter((c) => c === 429)).toEqual([]);
  });

  it("IPv6: two addresses in one /64 share the verify-authentication bucket; another /64 is unaffected", async () => {
    const body = { response: { id: "x", rawId: "x", type: "public-key", response: {} } };
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const ip = i % 2 === 0 ? "2001:db8:1:2::1" : "2001:db8:1:2::2";
      codes.push(
        (await raw("POST", "/api/auth/passkey/verify-authentication", ip, body)).statusCode,
      );
    }
    expect(codes.slice(0, 10).every((c) => c !== 429)).toBe(true);
    expect(codes[10]).toBe(429);
    const other = await raw(
      "POST",
      "/api/auth/passkey/verify-authentication",
      "2001:db8:1:3::1",
      body,
    );
    expect(other.statusCode).not.toBe(429);
  });
});

// ---------------------------------------------------------------- S5

describe("S5 credential id length", () => {
  it("verify-registration with a response.id over 1023 bytes → 400 PASSKEY_CREDENTIAL_ID_TOO_LONG, no row", async () => {
    const { userId, cookie } = await h.totpUser("pr3-r-longid@example.com");
    const { res } = await h.register(cookie, newAuthenticator(), {
      overrides: { id: b64url(randomBytes(1024)) },
    });
    expect([res?.statusCode, codeOf(res!)]).toEqual([400, "PASSKEY_CREDENTIAL_ID_TOO_LONG"]);
    expect(await h.passkeys(userId)).toEqual([]);
  });

  it("a 1023-byte id is not refused for its length", async () => {
    const { cookie } = await h.totpUser("pr3-r-maxid@example.com");
    const { res } = await h.register(cookie, newAuthenticator(), {
      overrides: { id: b64url(randomBytes(1023)) },
    });
    expect(codeOf(res!)).not.toBe("PASSKEY_CREDENTIAL_ID_TOO_LONG");
  });
});

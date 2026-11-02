/**
 * PAY-259 PR 3 — passkey server enablement (no UI), part 2 of 2.
 *
 * G  passkey sign-in: session authMethod 'passkey' reaches /api/me; banned
 *    user refused; consumed challenge, foreign origin, unknown credential.
 * H  lifecycle: admin reset, onboarding set-password (reset) and the PAY-217
 *    "w2_access_ended" ban delete the user's passkeys (+ passkeys_reset);
 *    user delete cascades.
 * I  PAY-217 former employees: passkey sign-in reaches /api/my/w2; the
 *    sign-in pair is in FORMER_EMPLOYEE_AUTH_PATHS; passkey management is
 *    w2_access_only.
 * J  cross-user: no rename / delete / list of another user's passkey.
 * K  rate limits on generate-authenticate-options (30/min) and
 *    verify-authentication (10/min) per client address.
 * L  GET /api/my/security passkeyCount.
 * M  a failed verification logs no credential id or clientDataJSON.
 *
 * Test author: fail-first against origin/main 735271d; the coder may not edit
 * this file. Synthetic data only (example.com users, generated keys).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestApp, ORIGIN, type TestContext } from "./helpers.js";
import { initiateReset } from "../src/auth/users.js";
import { syncFormerEmployeeLogins } from "../src/auth/former-employee.js";
import { tokenFromLink } from "./flow-helpers.js";
import {
  codeOf,
  harness,
  type Harness,
  newAuthenticator,
  type Res,
  sessionHeader,
} from "./pay-259-pr3-harness.js";
import { PASSKEY_CHALLENGE_COOKIE, rawCookiePair } from "./webauthn-soft-authenticator.js";

const NEW_PASSWORD = "violet-anchor-quarry-lantern-42";

let t: TestContext;
let h: Harness;
beforeAll(async () => {
  t = await createTestApp();
  h = harness(t, 206);
});
afterAll(async () => {
  await t.close();
});

function get(url: string, cookie: string) {
  return t.app.inject({ method: "GET", url, headers: sessionHeader(cookie) });
}

// ---------------------------------------------------------------- G

describe("G passkey sign-in session", () => {
  it("verify-authentication creates an authMethod 'passkey' session that reaches /api/me; counter advances", async () => {
    const { userId } = await h.onboard("pr3-g-signin@example.com");
    const a = newAuthenticator();
    await h.seedPasskey(userId, a, { counter: 1 });
    const { res, session } = await h.passkeySignIn(a, { overrides: { signCount: 2 } });
    expect(res.statusCode).toBe(200);
    expect(session).not.toBeNull();
    expect(await h.sessionRow(session!)).toEqual({ authMethod: "passkey", userId });
    expect((await get("/api/me", session!)).statusCode).toBe(200);
    expect((await h.passkeys(userId))[0]!.counter).toBe(2);
  });

  it("a banned (lockout) user → 403 BANNED_USER and no session", async () => {
    const { userId } = await h.onboard("pr3-g-banned@example.com");
    const a = newAuthenticator();
    await h.seedPasskey(userId, a);
    await t.pglite.query(`update "user" set banned = true, "banReason" = 'lockout' where id = $1`, [
      userId,
    ]);
    const before = await h.sessionCount(userId);
    const { res, session } = await h.passkeySignIn(a);
    expect([res.statusCode, codeOf(res)]).toEqual([403, "BANNED_USER"]);
    expect(session).toBeNull();
    expect(await h.sessionCount(userId)).toBe(before);
  });

  it("replaying a consumed challenge → 400 CHALLENGE_NOT_FOUND", async () => {
    const { userId } = await h.onboard("pr3-g-replay@example.com");
    const a = newAuthenticator();
    await h.seedPasskey(userId, a);
    const ip = h.ip();
    const opt = await h.auth("GET", "/passkey/generate-authenticate-options", { ip });
    expect(opt.statusCode).toBe(200);
    const challenge = rawCookiePair(opt.headers["set-cookie"], PASSKEY_CHALLENGE_COOKIE);
    const options = opt.json() as { challenge: string };
    const first = await h.auth("POST", "/passkey/verify-authentication", {
      ip,
      extra: challenge,
      payload: { response: a.assert(options) },
    });
    expect(first.statusCode).toBe(200);
    const sessions = await h.sessionCount(userId);
    const replay = await h.auth("POST", "/passkey/verify-authentication", {
      ip,
      extra: challenge,
      payload: { response: a.assert(options) },
    });
    expect([replay.statusCode, codeOf(replay)]).toEqual([400, "CHALLENGE_NOT_FOUND"]);
    expect(await h.sessionCount(userId)).toBe(sessions);
  });

  it("clientDataJSON origin https://evil.example → 400, no session", async () => {
    const { userId } = await h.onboard("pr3-g-evil@example.com");
    const a = newAuthenticator();
    await h.seedPasskey(userId, a);
    const before = await h.sessionCount(userId);
    const { res, session } = await h.passkeySignIn(a, {
      overrides: { origin: "https://evil.example" },
    });
    expect(res.statusCode).toBe(400);
    expect(session).toBeNull();
    expect(await h.sessionCount(userId)).toBe(before);
  });

  it("a passkey signed for another RP ID → 400, no session", async () => {
    const { userId } = await h.onboard("pr3-g-rpid@example.com");
    const a = newAuthenticator();
    await h.seedPasskey(userId, a);
    const { res, session } = await h.passkeySignIn(a, { overrides: { rpId: "evil.example" } });
    expect(res.statusCode).toBe(400);
    expect(session).toBeNull();
  });

  it("an unknown credential → 401 PASSKEY_NOT_FOUND", async () => {
    const { res, session } = await h.passkeySignIn(newAuthenticator());
    expect([res.statusCode, codeOf(res)]).toEqual([401, "PASSKEY_NOT_FOUND"]);
    expect(session).toBeNull();
  });
});

// ---------------------------------------------------------------- H

async function seedTwo(userId: string): Promise<void> {
  await h.seedPasskey(userId, newAuthenticator());
  await h.seedPasskey(userId, newAuthenticator());
}

describe("H lifecycle deletes passkeys", () => {
  it("admin reset (initiateReset) deletes the user's passkeys and writes passkeys_reset", async () => {
    const { userId } = await h.onboard("pr3-h-reset@example.com");
    const other = await h.onboard("pr3-h-reset-other@example.com");
    await seedTwo(userId);
    await h.seedPasskey(other.userId, newAuthenticator());
    await initiateReset({ auth: t.auth, db: t.db, config: t.config }, userId, null);
    expect(await h.passkeys(userId)).toEqual([]);
    expect((await h.passkeys(other.userId)).length).toBe(1);
    expect((await h.events(userId, "passkeys_reset")).length).toBe(1);
  });

  it("a reset with no passkeys writes no passkeys_reset", async () => {
    const { userId } = await h.onboard("pr3-h-reset-none@example.com");
    await initiateReset({ auth: t.auth, db: t.db, config: t.config }, userId, null);
    expect(await h.events(userId, "passkeys_reset")).toEqual([]);
  });

  it("onboarding set-password with a reset token deletes passkeys added after the reset (+ passkeys_reset)", async () => {
    const { userId } = await h.onboard("pr3-h-setpw@example.com");
    const reset = await initiateReset({ auth: t.auth, db: t.db, config: t.config }, userId, null);
    await seedTwo(userId);
    const resetEventsBefore = (await h.events(userId, "passkeys_reset")).length;
    const token = tokenFromLink(reset.setupLink);
    for (const [url, payload] of [
      ["/api/onboarding/verify-token", { token }],
      ["/api/onboarding/set-password", { token, password: NEW_PASSWORD }],
    ] as const) {
      const ip = h.ip();
      const res = await t.app.inject({
        method: "POST",
        url,
        headers: { ...ORIGIN, "x-forwarded-for": ip },
        remoteAddress: ip,
        payload,
      });
      expect(res.statusCode, url).toBe(200);
    }
    expect(await h.passkeys(userId)).toEqual([]);
    expect((await h.events(userId, "passkeys_reset")).length).toBe(resetEventsBefore + 1);
  });

  it("syncFormerEmployeeLogins banning with w2_access_ended deletes that user's passkeys", async () => {
    const { userId } = await h.onboard("pr3-h-ended@example.com");
    const kept = await h.onboard("pr3-h-ended-active@example.com");
    // TY2025 furnished online; its window is open on 2026-03-02 and closed by 2027-06-01.
    await h.makeFormerW2Only(userId, "Ended Former", "2026-03-02");
    await seedTwo(userId);
    await h.seedPasskey(kept.userId, newAuthenticator());
    await syncFormerEmployeeLogins({ db: t.db, config: t.config }, { today: "2027-06-01" });
    const u = await t.pglite.query<{ banned: boolean | null; banReason: string | null }>(
      `select banned, "banReason" from "user" where id = $1`,
      [userId],
    );
    expect(u.rows[0]).toEqual({ banned: true, banReason: "w2_access_ended" });
    expect(await h.passkeys(userId)).toEqual([]);
    expect((await h.passkeys(kept.userId)).length).toBe(1);
  });

  it("deleting a user cascades to its passkeys", async () => {
    const { userId } = await h.onboard("pr3-h-delete@example.com");
    await seedTwo(userId);
    await t.pglite.query(`delete from "session" where "userId" = $1`, [userId]);
    await t.pglite.query(`delete from "user" where id = $1`, [userId]);
    expect(await h.passkeys(userId)).toEqual([]);
  });
});

// ---------------------------------------------------------------- I

describe("I PAY-217 former employees", () => {
  const NOW = new Date("2026-03-02T15:00:00Z");
  const TODAY = "2026-03-02";
  let f: TestContext;
  let fh: Harness;
  beforeAll(async () => {
    f = await createTestApp({}, { clock: () => NOW });
    fh = harness(f, 207);
  });
  afterAll(async () => {
    await f.close();
  });

  it("a W-2-only former employee signs in with a passkey → /api/my/w2 200; list-user-passkeys 403 w2_access_only", async () => {
    const { userId } = await fh.onboard("pr3-i-former@example.com");
    const a = newAuthenticator();
    await fh.seedPasskey(userId, a);
    await fh.makeFormerW2Only(userId, "Former Passkey", TODAY);
    const { res, session } = await fh.passkeySignIn(a);
    expect(res.statusCode).toBe(200);
    expect(session).not.toBeNull();
    const w2 = await f.app.inject({
      method: "GET",
      url: "/api/my/w2",
      headers: sessionHeader(session!),
    });
    expect(w2.statusCode).toBe(200);
    const list = await fh.auth("GET", "/passkey/list-user-passkeys", { cookie: session! });
    expect([list.statusCode, codeOf(list)]).toEqual([403, "w2_access_only"]);
  });

  it("with a live former-employee session the sign-in pair stays open (FORMER_EMPLOYEE_AUTH_PATHS)", async () => {
    const email = "pr3-i-former-session@example.com";
    const { userId, cookie } = await fh.totpUser(email);
    const a = newAuthenticator();
    await fh.seedPasskey(userId, a);
    await fh.makeFormerW2Only(userId, "Former Session", TODAY);
    const { opt, res } = await fh.passkeySignIn(a, { cookie });
    expect(opt.statusCode).toBe(200);
    expect(res.statusCode).toBe(200);
  });

  it("passkey management from a former employee's session → 403 w2_access_only", async () => {
    const { userId, cookie } = await fh.totpUser("pr3-i-former-manage@example.com");
    const id = await fh.seedPasskey(userId, newAuthenticator(), { name: "Keep" });
    await fh.makeFormerW2Only(userId, "Former Manage", TODAY);
    const reg = await fh.auth("GET", "/passkey/generate-register-options", { cookie });
    const upd = await fh.auth("POST", "/passkey/update-passkey", {
      cookie,
      payload: { id, name: "Changed" },
    });
    const del = await fh.auth("POST", "/passkey/delete-passkey", { cookie, payload: { id } });
    expect([reg, upd, del].map((r) => [r.statusCode, codeOf(r)])).toEqual([
      [403, "w2_access_only"],
      [403, "w2_access_only"],
      [403, "w2_access_only"],
    ]);
    expect((await fh.passkeys(userId))[0]!.name).toBe("Keep");
  });
});

// ---------------------------------------------------------------- J

describe("J cross-user isolation", () => {
  it("user A cannot rename or delete user B's passkey; A's list shows only A's own", async () => {
    const A = await h.totpUser("pr3-j-a@example.com");
    const B = await h.onboard("pr3-j-b@example.com");
    const aId = await h.seedPasskey(A.userId, newAuthenticator(), { name: "A key" });
    const bId = await h.seedPasskey(B.userId, newAuthenticator(), { name: "B key" });

    const rename = await h.auth("POST", "/passkey/update-passkey", {
      cookie: A.cookie,
      payload: { id: bId, name: "Taken" },
    });
    const del = await h.auth("POST", "/passkey/delete-passkey", {
      cookie: A.cookie,
      payload: { id: bId },
    });
    expect(rename.statusCode).toBeGreaterThanOrEqual(400);
    expect(del.statusCode).toBeGreaterThanOrEqual(400);
    const bRows = await h.passkeys(B.userId);
    expect(bRows.map((r) => [r.id, r.name])).toEqual([[bId, "B key"]]);
    expect(await h.events(A.userId, "passkey_renamed")).toEqual([]);
    expect(await h.events(A.userId, "passkey_removed")).toEqual([]);

    const list = await h.auth("GET", "/passkey/list-user-passkeys", { cookie: A.cookie });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { id: string }[]).map((p) => p.id)).toEqual([aId]);
  });
});

// ---------------------------------------------------------------- K

describe("K rate limits per client address", () => {
  it("generate-authenticate-options: 30 per minute, the 31st → 429; another address is unaffected", async () => {
    const ip = h.ip();
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) {
      codes.push(
        (await h.auth("GET", "/passkey/generate-authenticate-options", { ip })).statusCode,
      );
    }
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes[30]).toBe(429);
    expect((await h.auth("GET", "/passkey/generate-authenticate-options")).statusCode).toBe(200);
  });

  it("verify-authentication: 10 per minute, the 11th → 429", async () => {
    const ip = h.ip();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push(
        (
          await h.auth("POST", "/passkey/verify-authentication", {
            ip,
            payload: { response: { id: "x", rawId: "x", type: "public-key", response: {} } },
          })
        ).statusCode,
      );
    }
    expect(codes.slice(0, 10).every((c) => c !== 429 && c !== 404)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

// ---------------------------------------------------------------- L

describe("L /api/my/security", () => {
  it("reports passkeyCount for the signed-in user only", async () => {
    const A = await h.totpUser("pr3-l-a@example.com");
    const B = await h.totpUser("pr3-l-b@example.com");
    await seedTwo(A.userId);
    const a = await get("/api/my/security", A.cookie);
    const b = await get("/api/my/security", B.cookie);
    expect(a.statusCode).toBe(200);
    expect((a.json() as { passkeyCount?: unknown }).passkeyCount).toBe(2);
    expect((b.json() as { passkeyCount?: unknown }).passkeyCount).toBe(0);
  });
});

// ---------------------------------------------------------------- M

describe("M failed verifications log no credential material", () => {
  function captureConsole() {
    const out: string[] = [];
    const spies = (["error", "warn", "log", "info", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        out.push(
          args
            .map((a) =>
              a instanceof Error
                ? `${a.message}\n${a.stack ?? ""}`
                : typeof a === "string"
                  ? a
                  : JSON.stringify(a),
            )
            .join(" "),
        );
      }),
    );
    return {
      text: () => out.join("\n"),
      restore: () => {
        for (const s of spies) s.mockRestore();
      },
    };
  }

  it("verify-registration with a crafted bad response: no console output holds the credential id or clientDataJSON", async () => {
    const { userId, cookie } = await h.totpUser("pr3-m-reg@example.com");
    const a = newAuthenticator();
    const opt = await h.auth("GET", "/passkey/generate-register-options", { cookie });
    expect(opt.statusCode).toBe(200);
    const challenge = rawCookiePair(opt.headers["set-cookie"], PASSKEY_CHALLENGE_COOKIE);
    // The credential type field carries the credential id: the library echoes it in its error.
    const response = a.register(opt.json() as { challenge: string }, { credentialType: a.id });
    const cap = captureConsole();
    let res: Res | undefined;
    try {
      res = await h.auth("POST", "/passkey/verify-registration", {
        cookie,
        extra: challenge,
        payload: { response },
      });
    } finally {
      cap.restore();
    }
    expect(res?.statusCode).toBeGreaterThanOrEqual(400);
    expect(await h.passkeys(userId)).toEqual([]);
    expect(cap.text().includes(a.id)).toBe(false);
    expect(cap.text().includes(response.response.clientDataJSON)).toBe(false);
  });

  it("verify-authentication with a crafted bad response: no console output holds the credential id or clientDataJSON", async () => {
    const { userId } = await h.onboard("pr3-m-auth@example.com");
    const a = newAuthenticator();
    await h.seedPasskey(userId, a);
    const ip = h.ip();
    const opt = await h.auth("GET", "/passkey/generate-authenticate-options", { ip });
    expect(opt.statusCode).toBe(200);
    const challenge = rawCookiePair(opt.headers["set-cookie"], PASSKEY_CHALLENGE_COOKIE);
    const response = a.assert(opt.json() as { challenge: string }, { credentialType: a.id });
    const cap = captureConsole();
    let res: Res | undefined;
    try {
      res = await h.auth("POST", "/passkey/verify-authentication", {
        ip,
        extra: challenge,
        payload: { response },
      });
    } finally {
      cap.restore();
    }
    expect(res?.statusCode).toBeGreaterThanOrEqual(400);
    expect(cap.text().includes(a.id)).toBe(false);
    expect(cap.text().includes(response.response.clientDataJSON)).toBe(false);
  });
});

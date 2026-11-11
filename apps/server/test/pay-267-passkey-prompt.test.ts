/**
 * PAY-267: the post-sign-in passkey prompt, server side.
 *
 * A  GET /api/my/security passkeyPromptDue: true by default, false with a
 *    passkey, keeps the existing fields.
 * B  POST /api/my/passkey-prompt "not_now": snooze for exactly 30 days from the
 *    injected clock; the boundary is inclusive (due AT now+30d, not 1 ms before).
 * C  "never": final, past any snooze and after a later "not_now".
 * D  idempotent upsert (one row), per-user isolation.
 * E  refusals: invalid body 400, no session 401, CSRF origin check, PAY-217
 *    former employee 403 w2_access_only.
 * F  user delete cascades the row.
 * G  GET /api/admin/users/passkey-counts: shape, no credential material,
 *    non-admin 403, no session 401.
 * H  migration 0031: additive, applies on a pre-0031 database holding a user,
 *    no backfill; Drizzle snapshot chained and matching.
 *
 * Test author: fail-first against origin/main 979b44d; the coder may not edit
 * this file. Synthetic data only (example.com users, generated keys). Credential
 * material is compared, never printed (S11).
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, ORIGIN, type TestContext, workspaceRoot } from "./helpers.js";
import {
  codeOf,
  harness,
  type Harness,
  newAuthenticator,
  sessionHeader,
} from "./pay-259-pr3-harness.js";

const PROMPT_URL = "/api/my/passkey-prompt";
const SECURITY_URL = "/api/my/security";
const COUNTS_URL = "/api/admin/users/passkey-counts";

/** Fixed test clock. Inside the PAY-217 W-2-only window of makeFormerW2Only's fixture. */
const BASE_MS = Date.parse("2026-03-02T15:00:00.000Z");
const FORMER_TODAY = "2026-03-02";
const DAY_MS = 86_400_000;
const SNOOZE_MS = 30 * DAY_MS;

let nowMs = BASE_MS;
let t: TestContext;
let h: Harness;

beforeAll(async () => {
  t = await createTestApp({}, { clock: () => new Date(nowMs) });
  h = harness(t, 209);
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  nowMs = BASE_MS;
});

function security(cookie: string) {
  return t.app.inject({ method: "GET", url: SECURITY_URL, headers: sessionHeader(cookie) });
}

async function due(cookie: string): Promise<unknown> {
  const res = await security(cookie);
  expect(res.statusCode).toBe(200);
  return (res.json() as { passkeyPromptDue?: unknown }).passkeyPromptDue;
}

function choose(cookie: string, choice: "not_now" | "never") {
  return t.app.inject({
    method: "POST",
    url: PROMPT_URL,
    headers: sessionHeader(cookie),
    payload: { choice },
  });
}

async function chooseOk(cookie: string, choice: "not_now" | "never"): Promise<void> {
  const res = await choose(cookie, choice);
  expect([res.statusCode, res.json()]).toEqual([200, { ok: true }]);
}

interface StateRow {
  snoozed_until: Date | string | null;
  dismissed_at: Date | string | null;
}

async function stateRows(userId: string): Promise<StateRow[]> {
  const r = await t.pglite.query<StateRow>(
    `select snoozed_until, dismissed_at from passkey_prompt_state where user_id = $1`,
    [userId],
  );
  return r.rows;
}

function ms(value: Date | string | null | undefined): number | null {
  return value === null || value === undefined ? null : new Date(value).getTime();
}

// ---------------------------------------------------------------- A

describe("A GET /api/my/security passkeyPromptDue", () => {
  it("is true by default for a user with 0 passkeys; the existing fields stay", async () => {
    const { cookie } = await h.totpUser("pay267-a-default@example.com");
    const res = await security(cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.passkeyPromptDue).toBe(true);
    expect(body.twoFactorEnabled).toBe(true);
    expect(typeof body.backupCodesRemaining).toBe("number");
    expect(body.passkeyCount).toBe(0);
  });

  it("is false with a passkey row, and true again once it is gone", async () => {
    const { userId, cookie } = await h.totpUser("pay267-a-passkey@example.com");
    const id = await h.seedPasskey(userId, newAuthenticator());
    expect(await due(cookie)).toBe(false);
    await t.pglite.query(`delete from "passkey" where "id" = $1`, [id]);
    expect(await due(cookie)).toBe(true);
  });

  it("stays false with a passkey after a snooze has expired", async () => {
    const { userId, cookie } = await h.totpUser("pay267-a-passkey-snooze@example.com");
    await chooseOk(cookie, "not_now");
    await h.seedPasskey(userId, newAuthenticator());
    nowMs = BASE_MS + SNOOZE_MS + DAY_MS;
    expect(await due(cookie)).toBe(false);
  });
});

// ---------------------------------------------------------------- B

describe('B POST /api/my/passkey-prompt "not_now"', () => {
  it("answers { ok: true }, stores now + 30 days, and the prompt is no longer due", async () => {
    const { userId, cookie } = await h.totpUser("pay267-b-snooze@example.com");
    await chooseOk(cookie, "not_now");
    expect(await due(cookie)).toBe(false);
    const rows = await stateRows(userId);
    expect(rows.length).toBe(1);
    expect(ms(rows[0]!.snoozed_until)).toBe(BASE_MS + SNOOZE_MS);
    expect(rows[0]!.dismissed_at).toBeNull();
  });

  it("boundary: 1 ms before now + 30 days it is not due; at exactly now + 30 days it is", async () => {
    const { cookie } = await h.totpUser("pay267-b-boundary@example.com");
    await chooseOk(cookie, "not_now");
    nowMs = BASE_MS + SNOOZE_MS - 1;
    expect(await due(cookie)).toBe(false);
    nowMs = BASE_MS + SNOOZE_MS;
    expect(await due(cookie)).toBe(true);
    nowMs = BASE_MS + SNOOZE_MS + 1;
    expect(await due(cookie)).toBe(true);
  });

  it("a later not_now restarts the 30 days from the new now", async () => {
    const { userId, cookie } = await h.totpUser("pay267-b-resnooze@example.com");
    await chooseOk(cookie, "not_now");
    nowMs = BASE_MS + 10 * DAY_MS;
    await chooseOk(cookie, "not_now");
    expect(ms((await stateRows(userId))[0]!.snoozed_until)).toBe(nowMs + SNOOZE_MS);
    nowMs = BASE_MS + SNOOZE_MS + DAY_MS;
    expect(await due(cookie)).toBe(false);
  });
});

// ---------------------------------------------------------------- C

describe('C POST /api/my/passkey-prompt "never"', () => {
  it("stores dismissed_at = now and is never due again, however long it has been", async () => {
    const { userId, cookie } = await h.totpUser("pay267-c-never@example.com");
    await chooseOk(cookie, "never");
    expect(await due(cookie)).toBe(false);
    const rows = await stateRows(userId);
    expect(rows.length).toBe(1);
    expect(ms(rows[0]!.dismissed_at)).toBe(BASE_MS);
    for (const later of [SNOOZE_MS, SNOOZE_MS + 1, 365 * DAY_MS, 3650 * DAY_MS]) {
      nowMs = BASE_MS + later;
      expect(await due(cookie)).toBe(false);
    }
  });

  it("a later not_now does not clear the dismissal, even past its 30 days", async () => {
    const { userId, cookie } = await h.totpUser("pay267-c-never-then-snooze@example.com");
    await chooseOk(cookie, "never");
    nowMs = BASE_MS + 31 * DAY_MS;
    await chooseOk(cookie, "not_now");
    expect(await due(cookie)).toBe(false);
    expect(ms((await stateRows(userId))[0]!.dismissed_at)).toBe(BASE_MS);
    nowMs = BASE_MS + 31 * DAY_MS + SNOOZE_MS + DAY_MS;
    expect(await due(cookie)).toBe(false);
  });

  it("never after not_now wins once the snooze has expired", async () => {
    const { cookie } = await h.totpUser("pay267-c-snooze-then-never@example.com");
    await chooseOk(cookie, "not_now");
    await chooseOk(cookie, "never");
    nowMs = BASE_MS + SNOOZE_MS + DAY_MS;
    expect(await due(cookie)).toBe(false);
  });
});

// ---------------------------------------------------------------- D

describe("D upsert and isolation", () => {
  it("repeated calls leave one row and keep answering 200", async () => {
    const { userId, cookie } = await h.totpUser("pay267-d-idempotent@example.com");
    for (const choice of ["not_now", "not_now", "never", "never", "not_now"] as const) {
      await chooseOk(cookie, choice);
    }
    expect((await stateRows(userId)).length).toBe(1);
  });

  it("one user's choice never touches another's", async () => {
    const A = await h.totpUser("pay267-d-a@example.com");
    const B = await h.totpUser("pay267-d-b@example.com");
    const C = await h.totpUser("pay267-d-c@example.com");
    await chooseOk(A.cookie, "never");
    expect(await due(B.cookie)).toBe(true);
    expect((await stateRows(B.userId)).length).toBe(0);
    await chooseOk(B.cookie, "not_now");
    expect(await due(C.cookie)).toBe(true);
    const aRows = await stateRows(A.userId);
    expect(aRows[0]!.snoozed_until).toBeNull();
    nowMs = BASE_MS + SNOOZE_MS;
    expect(await due(A.cookie)).toBe(false);
    expect(await due(B.cookie)).toBe(true);
  });
});

// ---------------------------------------------------------------- E

describe("E refusals", () => {
  it.each([
    ["an empty object", {}],
    ["an unknown choice", { choice: "later" }],
    ["a null choice", { choice: null }],
    ["a number", { choice: 1 }],
    ["a wrapped choice", { choice: ["never"] }],
    ["the wrong case", { choice: "NEVER" }],
    ["an array body", ["never"]],
  ])("%s → 400 invalid_body, nothing stored", async (label, payload) => {
    const slug = label.replace(/[^a-z]+/g, "-");
    const { userId, cookie } = await h.totpUser(`pay267-e-invalid${slug}@example.com`);
    const res = await t.app.inject({
      method: "POST",
      url: PROMPT_URL,
      headers: sessionHeader(cookie),
      payload: payload as object,
    });
    expect([res.statusCode, res.json()]).toEqual([400, { error: "invalid_body" }]);
    expect((await stateRows(userId)).length).toBe(0);
    expect(await due(cookie)).toBe(true);
  });

  it("no session → 401", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: PROMPT_URL,
      headers: ORIGIN,
      payload: { choice: "never" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("a session without Origin, or with a foreign Origin → 403 CSRF, nothing stored", async () => {
    const { userId, cookie } = await h.totpUser("pay267-e-csrf@example.com");
    const session = { cookie: `payroll.session_token=${cookie}` };
    const foreign = await t.app.inject({
      method: "POST",
      url: PROMPT_URL,
      headers: { ...session, origin: "https://evil.example.com" },
      payload: { choice: "never" },
    });
    const missing = await t.app.inject({
      method: "POST",
      url: PROMPT_URL,
      headers: session,
      payload: { choice: "never" },
    });
    for (const res of [foreign, missing]) {
      expect([res.statusCode, codeOf(res)]).toEqual([403, "csrf_origin_check_failed"]);
    }
    expect((await stateRows(userId)).length).toBe(0);
  });

  it("a PAY-217 former employee (W-2 only) → 403 w2_access_only, nothing stored", async () => {
    const { userId, cookie } = await h.totpUser("pay267-e-former@example.com");
    await h.makeFormerW2Only(userId, "Former Prompt", FORMER_TODAY);
    for (const choice of ["not_now", "never"] as const) {
      const res = await choose(cookie, choice);
      expect([res.statusCode, codeOf(res)]).toEqual([403, "w2_access_only"]);
    }
    expect((await stateRows(userId)).length).toBe(0);
  });
});

// ---------------------------------------------------------------- F

describe("F user delete", () => {
  it("cascades the prompt state row", async () => {
    const { userId, cookie } = await h.totpUser("pay267-f-delete@example.com");
    await chooseOk(cookie, "never");
    expect((await stateRows(userId)).length).toBe(1);
    await t.pglite.query(`delete from "user" where "id" = $1`, [userId]);
    expect((await stateRows(userId)).length).toBe(0);
  });
});

// ---------------------------------------------------------------- G

describe("G GET /api/admin/users/passkey-counts", () => {
  it("lists only users with a passkey; numbers only; no credential material", async () => {
    const admin = await h.totpUser("pay267-g-admin@example.com", "admin");
    const two = await h.totpUser("pay267-g-two@example.com");
    const one = await h.totpUser("pay267-g-one@example.com");
    const zero = await h.totpUser("pay267-g-zero@example.com");
    const keys = [newAuthenticator(), newAuthenticator(), newAuthenticator()];
    const name = "PAY267 Private Device Name";
    await h.seedPasskey(two.userId, keys[0]!, { name });
    await h.seedPasskey(two.userId, keys[1]!, { name });
    await h.seedPasskey(one.userId, keys[2]!, { name });

    const res = await t.app.inject({
      method: "GET",
      url: COUNTS_URL,
      headers: sessionHeader(admin.cookie),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { counts: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(["counts"]);
    expect(body.counts[two.userId]).toBe(2);
    expect(body.counts[one.userId]).toBe(1);
    expect(Object.hasOwn(body.counts, zero.userId)).toBe(false);
    expect(Object.hasOwn(body.counts, admin.userId)).toBe(false);
    for (const value of Object.values(body.counts)) {
      expect(Number.isInteger(value) && (value as number) >= 1).toBe(true);
    }

    // Booleans only: a failing comparison must not print key material (S11).
    expect(res.body.includes(name)).toBe(false);
    const stored = [...(await h.passkeys(two.userId)), ...(await h.passkeys(one.userId))];
    expect(stored.length).toBe(3);
    for (const row of stored) {
      expect(res.body.includes(row.id)).toBe(false);
      expect(res.body.includes(row.credentialID)).toBe(false);
      expect(res.body.includes(row.publicKey)).toBe(false);
    }
    for (const word of ["credentialID", "publicKey", "name"]) {
      expect(res.body.includes(word)).toBe(false);
    }
  });

  it("a non-admin → 403", async () => {
    const { cookie } = await h.totpUser("pay267-g-employee@example.com");
    const res = await t.app.inject({
      method: "GET",
      url: COUNTS_URL,
      headers: sessionHeader(cookie),
    });
    expect(res.statusCode).toBe(403);
  });

  it("no session → 401", async () => {
    const res = await t.app.inject({ method: "GET", url: COUNTS_URL, headers: ORIGIN });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------- H

const DRIZZLE = resolve(workspaceRoot(import.meta.dirname), "packages/db/drizzle");

function journalEntries(): { idx: number; tag: string }[] {
  const text = readFileSync(resolve(DRIZZLE, "meta/_journal.json"), "utf8");
  return (JSON.parse(text) as { entries: { idx: number; tag: string }[] }).entries;
}

function statementsOf(tag: string): string[] {
  return readFileSync(resolve(DRIZZLE, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((s) =>
      s
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0);
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

function tag0031(): string {
  const tag = journalEntries().find((e) => e.tag.startsWith("0031"))?.tag;
  if (!tag) throw new Error("0031 is not in the journal");
  return tag;
}

function snapshot(n: string): SnapshotShape {
  return JSON.parse(readFileSync(resolve(DRIZZLE, `meta/${n}_snapshot.json`), "utf8"));
}

interface SnapshotShape {
  id: string;
  prevId: string;
  tables: Record<
    string,
    {
      columns: Record<string, { primaryKey: boolean; notNull: boolean }>;
      foreignKeys: Record<string, unknown>;
    }
  >;
}

const SYNTHETIC_USER = "pay267-h-user";

describe("H migration 0031", () => {
  it("is journaled once, directly after 0030, as one file", () => {
    const entries = journalEntries();
    const i30 = entries.findIndex((e) => e.tag === "0030_passkey");
    expect(i30).toBeGreaterThanOrEqual(0);
    expect(entries[i30 + 1]?.idx).toBe(31);
    expect(entries[i30 + 1]?.tag).toBe(tag0031());
    expect(entries.filter((e) => e.tag.startsWith("0031")).length).toBe(1);
    expect(readdirSync(DRIZZLE).filter((f) => f.startsWith("0031")).length).toBe(1);
  });

  it("is additive: only creates passkey_prompt_state and its foreign key", () => {
    const allowed = [
      /^create table "passkey_prompt_state" \(/i,
      /^alter table "passkey_prompt_state" add constraint "[a-z_]+" foreign key \("user_id"\) references "public"\."user"\("id"\) on delete cascade/i,
    ];
    const stmts = statementsOf(tag0031());
    expect(stmts.length).toBeGreaterThan(0);
    for (const s of stmts) {
      expect(
        allowed.some((re) => re.test(s)),
        `unexpected statement: ${s.slice(0, 80)}`,
      ).toBe(true);
      const plain = s.replace(/on (delete|update) (no action|cascade)/gi, "");
      expect(/\b(update|delete|drop|rename|truncate|insert)\b/i.test(plain)).toBe(false);
    }
  });

  it("applies on data written by the previous release; no backfill; existing rows unchanged", async () => {
    const pg = new PGlite("memory://");
    try {
      const entries = journalEntries();
      const i30 = entries.findIndex((e) => e.tag === "0030_passkey");
      for (const e of entries.slice(0, i30 + 1)) await applyTag(pg, e.tag);

      await pg.query(
        `insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "twoFactorEnabled")
         values ($1, 'PAY267 Synthetic', 'pay267-h@example.com', true, now(), now(), true)`,
        [SYNTHETIC_USER],
      );
      await pg.query(
        `insert into "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId", "authMethod")
         values ('pay267-h-sess', now() + interval '7 days', 'pay267-h-token', now(), now(), $1, 'password_totp')`,
        [SYNTHETIC_USER],
      );
      const beforeUser = await pg.query(`select * from "user" order by "id"`);
      const beforeSession = await pg.query(`select * from "session" order by "id"`);

      await applyTag(pg, tag0031());

      const afterUser = await pg.query(`select * from "user" order by "id"`);
      const afterSession = await pg.query(`select * from "session" order by "id"`);
      expect(JSON.stringify(afterUser.rows) === JSON.stringify(beforeUser.rows)).toBe(true);
      expect(JSON.stringify(afterSession.rows) === JSON.stringify(beforeSession.rows)).toBe(true);

      const count = await pg.query<{ n: number }>(
        `select count(*)::int as n from passkey_prompt_state`,
      );
      expect(count.rows[0]!.n).toBe(0);

      const columns = await pg.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
         where table_name = 'passkey_prompt_state' order by column_name`,
      );
      expect(
        columns.rows.map((c) => [c.column_name, c.data_type, c.is_nullable, c.column_default]),
      ).toEqual([
        ["dismissed_at", "timestamp with time zone", "YES", null],
        ["snoozed_until", "timestamp with time zone", "YES", null],
        ["updated_at", "timestamp with time zone", "NO", "now()"],
        ["user_id", "text", "NO", null],
      ]);

      // A row needs only the user id; the key is the user; the FK is live.
      await pg.query(`insert into passkey_prompt_state (user_id) values ($1)`, [SYNTHETIC_USER]);
      await expect(
        pg.query(`insert into passkey_prompt_state (user_id) values ($1)`, [SYNTHETIC_USER]),
      ).rejects.toThrow(/duplicate key/i);
      await expect(
        pg.query(`insert into passkey_prompt_state (user_id) values ('pay267-no-such-user')`),
      ).rejects.toThrow(/foreign key/i);
      const row = await pg.query<{
        snoozed_until: unknown;
        dismissed_at: unknown;
        updated_at: unknown;
      }>(`select snoozed_until, dismissed_at, updated_at from passkey_prompt_state`);
      expect(row.rows[0]!.snoozed_until).toBeNull();
      expect(row.rows[0]!.dismissed_at).toBeNull();
      expect(row.rows[0]!.updated_at).not.toBeNull();

      await pg.query(`delete from "user" where "id" = $1`, [SYNTHETIC_USER]);
      const gone = await pg.query<{ n: number }>(
        `select count(*)::int as n from passkey_prompt_state`,
      );
      expect(gone.rows[0]!.n).toBe(0);
    } finally {
      await pg.close();
    }
  }, 180_000);

  it("Drizzle snapshot: 0031 chains to 0030, keeps every table, and describes the migrated columns", () => {
    const prev = snapshot("0030");
    const snap = snapshot("0031");
    expect(snap.prevId).toBe(prev.id);
    for (const name of Object.keys(prev.tables)) {
      expect(Object.hasOwn(snap.tables, name)).toBe(true);
    }
    const table = snap.tables["public.passkey_prompt_state"];
    expect(table).toBeDefined();
    expect(Object.keys(table!.columns).sort()).toEqual([
      "dismissed_at",
      "snoozed_until",
      "updated_at",
      "user_id",
    ]);
    expect(table!.columns.user_id!.primaryKey).toBe(true);
    expect(table!.columns.updated_at!.notNull).toBe(true);
    expect(table!.columns.snoozed_until!.notNull).toBe(false);
    expect(table!.columns.dismissed_at!.notNull).toBe(false);
    // "user" is a Better Auth table, outside the Drizzle schema: as with every
    // reference to it, the FK lives in the SQL only (tested on the migrated
    // database above), so the snapshot has none.
    expect(Object.keys(table!.foreignKeys)).toEqual([]);
  });
});

/**
 * PAY-208 — the W-2 contact (OD1, (j)(3)(v)(A), (j)(3)(vii) 2nd sentence),
 * migration 0028, and D-A: the admin "Change sign-in email" action
 * ((j)(3)(vii) procedure for updating the address the employer uses).
 * payroll-calc-auditor, fail-first against d0f722f; the coder may not edit
 * this file. Synthetic data only.
 *
 * Tests: T16a-d, T17a-b, DA1-DA3.
 *
 * Contract assumed:
 *  - GET/PUT /api/admin/company/w2-contact (admin; PUT refuses cross-site).
 *    PUT body { name 1-200, phone 7-30 chars of [0-9+().\-\s], email (zod
 *    email, <= 254), mailingAddress?: company-address shape | null }.
 *    400 on invalid input. Audit "company.w2_contact.update" (before/after).
 *    When any field actually changes, one EVENT_TYPE.w2ContactChanged mail
 *    to every employee with an active consent (any version) and a login.
 *  - contactReady = name AND phone AND email AND (contact address OR
 *    company address); contact.mailingAddress resolves to the company
 *    address when the contact's own is null.
 *  - Migration 0028 (the only new file): additive — ADD COLUMN (nullable,
 *    no default) / CREATE TABLE / CREATE INDEX only; company gains
 *    w2_contact_name/phone/email text and w2_contact_address jsonb.
 *  - D-A: PUT /api/admin/employees/:employeeId/sign-in-email { email }
 *    (admin; refuses cross-site). Requires a FRESH admin session — the
 *    app's existing sensitive-action rule is Better Auth's session.freshAge
 *    (60 min, apps/server/src/auth/auth.ts); a session older than that ->
 *    403. Invalid email -> 400; an address another user has
 *    (case-insensitive) -> 409; employee without a login -> 404. Audit row
 *    (action containing "email") with both addresses masked, never in full.
 *    A notice (EVENT_TYPE.signInEmailChanged) reaches BOTH the old and the
 *    new address through the normal drainOutbox(deps) — the recipient of
 *    the old-address copy cannot come from the scheduler's user-id lookup,
 *    which already returns the new address.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { authUser } from "@payroll/db";
import { drainOutbox } from "../src/notify/outbox.js";
import { login, TEST_PASSWORD } from "./flow-helpers.js";
import { ROOT } from "./annual-w2-corrected-harness.js";
import {
  allOutbox,
  auditRows,
  boot,
  call,
  CONTACT,
  CONTACT_ADDRESS,
  type ConsentBody,
  type Emp,
  type Env,
  getConsent,
  hasAmount,
  makeEmp,
  NEW_VERSION,
  notificationsModule,
  OLD_VERSION,
  outbox,
  plain,
  putContact,
  reloginAdmin,
  scrub,
} from "./pay-208-harness.js";

const DRIZZLE = resolve(ROOT, "packages/db/drizzle");

async function eventType(key: string, fallback: string): Promise<string> {
  const n = await notificationsModule();
  return (n.EVENT_TYPE as Record<string, string>)[key] ?? fallback;
}

// ---------------------------------------------------------------- T16

describe("T16 the W-2 contact", () => {
  let env: Env;
  let probe: Emp;
  const e: Record<string, Emp> = {};
  beforeAll(async () => {
    env = await boot({ now: "2027-01-04T10:00:00Z" });
    probe = await makeEmp(env, { label: "Ctprobe", login: true, years: [2026] });
  }, 180_000);
  afterAll(async () => env.close());

  it("T16a invalid bodies -> 400; an employee -> 403; cross-site -> 403; nothing stored", async () => {
    const bad = [
      { ...CONTACT, email: "not-an-email" },
      { ...CONTACT, phone: "call me" },
      { ...CONTACT, phone: "12" },
      { ...CONTACT, name: "" },
      { ...CONTACT, email: `${"a".repeat(250)}@example.com` },
    ];
    const statuses: number[] = [];
    for (const b of bad) statuses.push((await putContact(env, b)).statusCode);
    const asEmployee = await putContact(env, { ...CONTACT }, probe.session!);
    const cross = await putContact(
      env,
      { ...CONTACT },
      { ...env.admin, "sec-fetch-site": "cross-site" },
    );
    const status = (await getConsent(env, probe)).json() as ConsentBody;
    expect({
      statuses,
      asEmployee: asEmployee.statusCode,
      cross: [cross.statusCode, (cross.json() as { error?: string }).error],
      contactReady: status.contactReady,
    }).toEqual({
      statuses: [400, 400, 400, 400, 400],
      asEmployee: 403,
      cross: [403, "cross_site"],
      contactReady: false,
    });
  });

  it("T16b a valid PUT -> 200; GET returns it; audit company.w2_contact.update; employees see it", async () => {
    const put = await putContact(env, { ...CONTACT, mailingAddress: CONTACT_ADDRESS });
    const get = await call(env, "GET", "/api/admin/company/w2-contact", env.admin);
    const audit = await auditRows(env, "company.w2_contact.update");
    const status = (await getConsent(env, probe)).json() as ConsentBody;
    expect({
      put: put.statusCode,
      get: get.statusCode,
      getHas: [CONTACT.name, CONTACT.phone, CONTACT.email, CONTACT_ADDRESS.line1].every((s) =>
        get.body.includes(s),
      ),
      audits: audit.length,
      auditAfterHasEmail: JSON.stringify(audit[0]?.after ?? null).includes(CONTACT.email),
      contactReady: status.contactReady,
      contact: status.contact,
    }).toEqual({
      put: 200,
      get: 200,
      getHas: true,
      audits: 1,
      auditAfterHasEmail: true,
      contactReady: true,
      contact: { ...CONTACT, mailingAddress: CONTACT_ADDRESS },
    });
  });

  it("T16c a changed contact mails the new details to every active consenter with a login (both versions) — once; an unchanged save mails nobody", async () => {
    e.current = await makeEmp(env, { label: "Ctcurrent", login: true, consent: NEW_VERSION });
    e.outdated = await makeEmp(env, { label: "Ctoutdated", login: true, consent: OLD_VERSION });
    e.withdrawn = await makeEmp(env, {
      label: "Ctwithdrawn",
      login: true,
      consent: NEW_VERSION,
      withdrawnAt: "2026-12-01T10:00:00Z",
    });
    e.none = await makeEmp(env, { label: "Ctnone", login: true });
    e.noLogin = await makeEmp(env, { label: "Ctnologin", consent: NEW_VERSION });
    const ev = await eventType("w2ContactChanged", "w2_contact_changed");
    const before = (await allOutbox(env, ev)).length;
    const changed = await putContact(env, {
      ...CONTACT,
      phone: "+1 555 0199",
      mailingAddress: CONTACT_ADDRESS,
    });
    const count = async (k: string) => (await outbox(env, e[k]!.userId, ev)).length;
    const mail = (await outbox(env, e.current!.userId, ev))[0];
    const afterChange = (await allOutbox(env, ev)).length;
    const same = await putContact(env, {
      ...CONTACT,
      phone: "+1 555 0199",
      mailingAddress: CONTACT_ADDRESS,
    });
    expect({
      changed: changed.statusCode,
      current: await count("current"),
      outdated: await count("outdated"),
      withdrawn: await count("withdrawn"),
      none: await count("none"),
      total: afterChange - before,
      newPhone: plain(mail?.bodyHtml ?? "").includes("+1 555 0199"),
      noAmount: !hasAmount(scrub(plain(mail?.bodyHtml ?? "x 1.00"))),
      same: same.statusCode,
      afterSame: (await allOutbox(env, ev)).length - afterChange,
    }).toEqual({
      changed: 200,
      current: 1,
      outdated: 1,
      withdrawn: 0,
      none: 0,
      total: 2,
      newPhone: true,
      noAmount: true,
      same: 200,
      afterSame: 0,
    });
  });

  it("T16d mailingAddress null -> the company address is used; with no company address the contact is not ready", async () => {
    const put = await putContact(env, { ...CONTACT, mailingAddress: null });
    const notReady = (await getConsent(env, probe)).json() as ConsentBody;
    const companyAddress = {
      line1: "1 Synthetic Plaza",
      city: "Fixtureville",
      state: "TX",
      zip: "75001",
      country: "US",
    };
    const co = await call(env, "PUT", "/api/admin/company", env.admin, {
      legalName: "Example Corp",
      address: companyAddress,
    });
    const ready = (await getConsent(env, probe)).json() as ConsentBody;
    expect({
      put: put.statusCode,
      notReady: notReady.contactReady,
      co: co.statusCode,
      ready: ready.contactReady,
      mailingAddress: ready.contact?.mailingAddress,
    }).toEqual({
      put: 200,
      notReady: false,
      co: 200,
      ready: true,
      mailingAddress: companyAddress,
    });
  });
});

// ---------------------------------------------------------------- T17

interface Journal {
  entries: { idx: number; tag: string }[];
}
function journal(): Journal {
  return JSON.parse(readFileSync(resolve(DRIZZLE, "meta/_journal.json"), "utf8")) as Journal;
}
async function migrate(pg: PGlite, filter: (tag: string) => boolean): Promise<void> {
  for (const e of journal().entries.filter((x) => filter(x.tag))) {
    const text = readFileSync(resolve(DRIZZLE, `${e.tag}.sql`), "utf8");
    for (const part of text.split("--> statement-breakpoint")) {
      const stmt = part.trim();
      if (!stmt) continue;
      try {
        await pg.exec(stmt);
      } catch (err) {
        if (e.tag.startsWith("0001")) continue; // btree_gist, as helpers.ts
        throw err;
      }
    }
  }
}

describe("T17 migration 0028 on data written by v1.28.0 (0027)", () => {
  it("T17a 0028 exists, is journaled, and is additive only", () => {
    const tags = journal().entries.map((e) => e.tag);
    const t28 = tags.filter((t) => t.startsWith("0028"));
    const files = readdirSync(DRIZZLE).filter((f) => f.startsWith("0028") && f.endsWith(".sql"));
    const sql = files.length === 1 ? readFileSync(resolve(DRIZZLE, files[0]!), "utf8") : "";
    const stmts = sql
      .split("--> statement-breakpoint")
      .map((s) => s.replace(/--[^\n]*\n?/g, "").trim())
      .filter(Boolean);
    const notAdditive = stmts.filter(
      (s) =>
        !(
          /^ALTER TABLE "\w+" ADD COLUMN "\w+" \w+;?$/i.test(s) ||
          /^CREATE (UNIQUE )?INDEX /i.test(s) ||
          /^CREATE TABLE /i.test(s) ||
          /^ALTER TABLE "\w+" ADD CONSTRAINT "\w+" FOREIGN KEY/i.test(s)
        ),
    );
    expect({
      journaled: t28.length,
      files: files.length,
      companyColumns: [
        /ADD COLUMN "w2_contact_name" text/i,
        /ADD COLUMN "w2_contact_phone" text/i,
        /ADD COLUMN "w2_contact_email" text/i,
        /ADD COLUMN "w2_contact_address" jsonb/i,
      ].map((r) => r.test(sql)),
      notAdditive,
      noRewrite: !/\b(UPDATE|DELETE|DROP|RENAME|ALTER COLUMN|SET NOT NULL|TRUNCATE)\b/i.test(sql),
    }).toEqual({
      journaled: 1,
      files: 1,
      companyColumns: [true, true, true, true],
      notAdditive: [],
      noRewrite: true,
    });
  });

  it("T17b a 0027 database with a company row -> 0028 applies; the four columns are nullable and null; existing values intact; consent rows untouched", async () => {
    const pg = new PGlite("memory://");
    try {
      await migrate(pg, (tag) => tag.slice(0, 4) <= "0027");
      await pg.query(`INSERT INTO company (legal_name, ein, address) VALUES ($1, $2, $3::jsonb)`, [
        "Example Corp",
        "enc:v1:synthetic",
        JSON.stringify({ line1: "1 Synthetic Plaza", city: "Fixtureville" }),
      ]);
      await pg.query(
        `INSERT INTO employees (company_id, legal_name, hire_date) VALUES (1, 'Upgrade Synthetic', '2024-01-01')`,
      );
      await pg.query(
        `INSERT INTO w2_delivery_consents (employee_id, disclosure_version) VALUES (1, '2025-01')`,
      );
      await migrate(pg, (tag) => tag.slice(0, 4) > "0027");
      const cols = await pg.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_name = 'company' AND column_name LIKE 'w2_contact_%' ORDER BY column_name`,
      );
      const row = await pg.query<Record<string, unknown>>(`SELECT * FROM company`);
      const consent = await pg.query<{ disclosure_version: string; withdrawn_at: unknown }>(
        `SELECT disclosure_version, withdrawn_at FROM w2_delivery_consents`,
      );
      expect({
        cols: cols.rows,
        values: [
          "w2_contact_name",
          "w2_contact_phone",
          "w2_contact_email",
          "w2_contact_address",
        ].map((c) => row.rows[0]?.[c]),
        kept: [
          row.rows[0]?.legal_name,
          row.rows[0]?.ein,
          (row.rows[0]?.address as { line1?: string })?.line1,
        ],
        consent: consent.rows,
      }).toEqual({
        cols: [
          {
            column_name: "w2_contact_address",
            data_type: "jsonb",
            is_nullable: "YES",
            column_default: null,
          },
          {
            column_name: "w2_contact_email",
            data_type: "text",
            is_nullable: "YES",
            column_default: null,
          },
          {
            column_name: "w2_contact_name",
            data_type: "text",
            is_nullable: "YES",
            column_default: null,
          },
          {
            column_name: "w2_contact_phone",
            data_type: "text",
            is_nullable: "YES",
            column_default: null,
          },
        ],
        values: [null, null, null, null],
        kept: ["Example Corp", "enc:v1:synthetic", "1 Synthetic Plaza"],
        consent: [{ disclosure_version: "2025-01", withdrawn_at: null }],
      });
    } finally {
      await pg.close();
    }
  });
});

// ---------------------------------------------------------------- D-A

describe("DA admin 'Change sign-in email' (D-A)", () => {
  let env: Env;
  let e: Emp;
  let other: Emp;
  let noLogin: Emp;
  const NEW_EMAIL = "renamed-synthetic@example.com";
  const url = (id: number) => `/api/admin/employees/${id}/sign-in-email`;
  beforeAll(async () => {
    env = await boot({ now: "2027-01-04T10:00:00Z" });
    e = await makeEmp(env, { label: "Darename", login: true, consent: NEW_VERSION, years: [2026] });
    other = await makeEmp(env, { label: "Daother", login: true });
    noLogin = await makeEmp(env, { label: "Danologin" });
  }, 180_000);
  afterAll(async () => env.close());

  async function emailOf(userId: string): Promise<string | undefined> {
    return (
      await env.t.db.select({ email: authUser.email }).from(authUser).where(eq(authUser.id, userId))
    )[0]?.email;
  }

  it("DA1 employee -> 403; invalid -> 400; another user's address (any case) -> 409; no login -> 404; cross-site -> 403; nothing changes", async () => {
    const asEmployee = await call(env, "PUT", url(e.id), e.session!, { email: NEW_EMAIL });
    const invalid = await call(env, "PUT", url(e.id), env.admin, { email: "nope" });
    const dup = await call(env, "PUT", url(e.id), env.admin, { email: other.email!.toUpperCase() });
    const none = await call(env, "PUT", url(noLogin.id), env.admin, {
      email: "x-synthetic@example.com",
    });
    const cross = await call(
      env,
      "PUT",
      url(e.id),
      { ...env.admin, "sec-fetch-site": "cross-site" },
      {
        email: NEW_EMAIL,
      },
    );
    expect({
      asEmployee: asEmployee.statusCode,
      invalid: invalid.statusCode,
      dup: dup.statusCode,
      none: none.statusCode,
      cross: cross.statusCode,
      email: await emailOf(e.userId!),
    }).toEqual({ asEmployee: 403, invalid: 400, dup: 409, none: 404, cross: 403, email: e.email });
  });

  it("DA2 an admin session older than the fresh window (60 min) -> 403, unchanged; a fresh admin session -> 200", async () => {
    env.tick(2 * 60 * 60 * 1000);
    const stale = await call(env, "PUT", url(e.id), env.admin, { email: NEW_EMAIL });
    const unchanged = await emailOf(e.userId!);
    await reloginAdmin(env);
    const fresh = await call(env, "PUT", url(e.id), env.admin, { email: NEW_EMAIL });
    expect({
      stale: stale.statusCode,
      unchanged,
      fresh: fresh.statusCode,
      now: await emailOf(e.userId!),
    }).toEqual({
      stale: 403,
      unchanged: e.email,
      fresh: 200,
      now: NEW_EMAIL,
    });
  });

  it("DA3 sign-in works with the new address only; audit masks both; the notice reaches the old AND the new address; no amounts", async () => {
    env.tick();
    const newLogin = await login(env.t, NEW_EMAIL, TEST_PASSWORD, { remoteAddress: e.ip! }).then(
      () => true,
      () => false,
    );
    env.tick();
    const oldLogin = await login(env.t, e.email!, TEST_PASSWORD, { remoteAddress: e.ip! }).then(
      () => true,
      () => false,
    );
    const audits = (
      await env.t.pglite.query<{ action: string; actor_id: string; j: string }>(
        `SELECT action, actor_id, row_to_json(a)::text AS j FROM audit_events a WHERE action ILIKE '%email%'`,
      )
    ).rows;
    const sent: { to: string; subject: string; html: string }[] = [];
    await drainOutbox({
      db: env.t.db,
      config: { ...env.t.config, emailMode: "smtp" },
      transport: {
        sendMail: async (m: { to: string; subject: string; html: string }) => void sent.push(m),
      },
      // The scheduler's resolver (apps/server/src/payroll/scheduler.ts).
      resolveRecipientEmail: async (userId: string) => (await emailOf(userId)) ?? null,
    } as never);
    const ev = await eventType("signInEmailChanged", "sign_in_email_changed");
    const notices = await outbox(env, e.userId, ev);
    const recipients = sent
      .filter((m) => notices.some((n) => n.subject === m.subject))
      .map((m) => m.to.toLowerCase())
      .sort();
    expect({
      newLogin,
      oldLogin,
      audits: audits.length,
      auditActor: audits[0]?.actor_id,
      auditNoFullAddress: audits.every((a) => !a.j.includes(NEW_EMAIL) && !a.j.includes(e.email!)),
      recipients,
      noAmount: notices.every((n) => !hasAmount(scrub(plain(n.bodyHtml)))),
    }).toEqual({
      newLogin: true,
      oldLogin: false,
      audits: 1,
      auditActor: env.adminId,
      auditNoFullAddress: true,
      recipients: [e.email!.toLowerCase(), NEW_EMAIL].sort(),
      noAmount: true,
    });
  });
});

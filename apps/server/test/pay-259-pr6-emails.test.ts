/**
 * PAY-259 PR 6 — always-on security emails when a passkey is added or removed.
 *
 * A  event catalog: both event types are security events, never workflow ones.
 * B  templates: subject / html / text, fallbacks, escaping, company and brand.
 * C  a successful add or remove queues exactly one row for the session user.
 * D  no row on a failed or refused change, a rename, a sign-in or an admin reset.
 * E  the email never holds the passkey's name, credential ID or public key.
 * F  a failed queue never fails the request (real SQL failure: a trigger).
 * G  notification settings do not suppress the emails.
 *
 * Test author: the coder may not edit this file. Synthetic data only
 * (example.com users, generated keys). Credential values are compared by
 * boolean checks and never printed.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { authUser, notificationSettings } from "@payroll/db";
import {
  EVENT_TYPE,
  SECURITY_EVENTS,
  securityPasskeyAdded,
  securityPasskeyRemoved,
  type TemplateContext,
  WORKFLOW_EVENTS,
} from "@payroll/notifications";
import { createTestApp, type TestContext } from "./helpers.js";
import { sessionHeader } from "./flow-helpers.js";
import { usableIp } from "../src/auth/audit.js";
import { initiateReset } from "../src/auth/users.js";
import { drainOutbox, type MailTransport } from "../src/notify/outbox.js";
import { queuePasskeyEmail } from "../src/notify/passkey-email.js";
import { codeOf, harness, type Harness, newAuthenticator } from "./pay-259-pr3-harness.js";
import {
  PASSKEY_CHALLENGE_COOKIE,
  rawCookiePair,
  type SoftAuthenticator,
} from "./webauthn-soft-authenticator.js";

const ADDED = "security_passkey_added";
const REMOVED = "security_passkey_removed";
const PASSKEY_NAME = "pr6-distinctive-passkey-label-7f3a";

const CTX: TemplateContext = {
  companyName: "Acme Co",
  brandName: "Wagon Payroll",
  appUrl: "http://localhost",
};
const FOOTER =
  "Sent by Wagon Payroll on behalf of Acme Co. This is an automated message — please don't reply. Questions? Contact Acme Co directly.";
const DATA = { userAgent: "Firefox", ip: "203.0.113.9", at: "2026-09-26T10:00:00.000Z" };

const TEMPLATES = [
  ["securityPasskeyAdded", securityPasskeyAdded],
  ["securityPasskeyRemoved", securityPasskeyRemoved],
] as const;

interface OutboxRow {
  user_id: string;
  event_type: string;
  subject: string;
  body_html: string;
  status: string;
}

let t: TestContext;
let h: Harness;

beforeAll(async () => {
  t = await createTestApp({
    emailMode: "smtp",
    smtp: { host: "smtp.test", port: 587, user: "", from: "payroll@example.test", secure: false },
  });
  h = harness(t, 211);
});
afterAll(async () => {
  await t.close();
});

/** The user's passkey email rows, oldest first. The event names are literal on purpose. */
async function passkeyMail(userId: string): Promise<OutboxRow[]> {
  const r = await t.pglite.query<OutboxRow>(
    `select user_id, event_type, subject, body_html, status from email_outbox
     where user_id = $1 and event_type in ('${ADDED}', '${REMOVED}') order by id`,
    [userId],
  );
  return r.rows;
}

async function mailKinds(userId: string): Promise<string[]> {
  return (await passkeyMail(userId)).map((m) => m.event_type);
}

async function countMail(userId: string, eventType: string): Promise<number> {
  const r = await t.pglite.query<{ n: number }>(
    `select count(*)::int as n from email_outbox where user_id = $1 and event_type = $2`,
    [userId, eventType],
  );
  return r.rows[0]!.n;
}

function deletePasskey(cookie: string, id: string) {
  return h.auth("POST", "/passkey/delete-passkey", { cookie, payload: { id } });
}

/** A full registration that sends a chosen user agent (the harness register does not). */
async function registerFrom(cookie: string, a: SoftAuthenticator, ua: string, ip: string) {
  const opt = await h.auth("GET", "/passkey/generate-register-options", { cookie, ip, ua });
  expect(opt.statusCode).toBe(200);
  return h.auth("POST", "/passkey/verify-registration", {
    cookie,
    ip,
    ua,
    extra: rawCookiePair(opt.headers["set-cookie"], PASSKEY_CHALLENGE_COOKIE),
    payload: { response: a.register(opt.json() as { challenge: string }) },
  });
}

// ---------------------------------------------------------------- A

describe("A event catalog", () => {
  it("the two event types carry their stored names", () => {
    expect(EVENT_TYPE.securityPasskeyAdded).toBe(ADDED);
    expect(EVENT_TYPE.securityPasskeyRemoved).toBe(REMOVED);
  });

  it("both are security events and neither is a workflow event", () => {
    for (const event of [ADDED, REMOVED]) {
      expect((SECURITY_EVENTS as readonly string[]).includes(event), event).toBe(true);
      expect((WORKFLOW_EVENTS as readonly string[]).includes(event), event).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- B

describe.each(TEMPLATES)("B template %s", (_name, render) => {
  it("returns subject, html and text holding the device, IP and time", () => {
    const r = render(CTX, DATA);
    for (const part of [r.html, r.text]) {
      expect(part).toContain("Firefox");
      expect(part).toContain("203.0.113.9");
      expect(part).toContain("2026-09-26T10:00:00.000Z");
      expect(part).toMatch(/passkey/i);
    }
    expect(r.subject).toMatch(/passkey/i);
  });

  it("subject leads with the employer and holds no product name or request detail", () => {
    const { subject } = render(CTX, DATA);
    expect(subject.startsWith("Acme Co — ")).toBe(true);
    expect(subject).not.toContain("Wagon Payroll");
    expect(subject).not.toContain("Firefox");
    expect(subject).not.toContain("203.0.113.9");
  });

  it("company and brand names render; the footer ends html and text", () => {
    const r = render(CTX, DATA);
    expect(r.html).toContain('<h2 style="margin:0 0 16px">Acme Co</h2>');
    expect(r.html).toContain("Wagon Payroll");
    expect(r.html).toContain(FOOTER);
    expect(r.text).toContain("Acme Co");
    expect(r.text.endsWith(FOOTER)).toBe(true);
  });

  it("tells the reader to contact the employer if the change was not theirs", () => {
    const r = render(CTX, DATA);
    expect(r.html).toContain("contact Acme Co");
    expect(r.text).toContain("contact Acme Co");
  });

  // A passkey signs in with no password: a new password alone leaves an intruder's passkey working.
  it("tells the reader to review their passkeys before the password step", () => {
    const r = render(CTX, DATA);
    for (const part of [r.html, r.text]) {
      const review = part.indexOf("Remove any passkey you don");
      const password = part.indexOf("choose a new password");
      expect(review).toBeGreaterThanOrEqual(0);
      expect(password).toBeGreaterThan(review);
      expect(part.slice(0, review)).toContain("Passkeys");
    }
  });

  it("gives the settings page as a full address, with no menu names", () => {
    const r = render(CTX, DATA);
    for (const part of [r.html, r.text]) {
      expect(part).toContain(
        "Go to http://localhost/my/settings, then Sign-in and security → Passkeys.",
      );
      expect(part).not.toContain("My settings");
      expect(part).not.toContain("Open Settings");
      expect(part).not.toContain("My payroll → Settings");
    }
  });

  it("a trailing slash on the app address gives no double slash", () => {
    const r = render({ ...CTX, appUrl: "https://pay.example.com/" }, DATA);
    for (const part of [r.html, r.text]) {
      expect(part).toContain("Go to https://pay.example.com/my/settings, then");
      expect(part).not.toContain("//my/settings");
    }
  });

  it("another company and brand replace the names everywhere", () => {
    const r = render({ ...CTX, companyName: "Bravo LLC", brandName: "Other Pay" }, DATA);
    for (const part of [r.subject, r.html, r.text]) {
      expect(part).toContain("Bravo LLC");
      expect(part).not.toContain("Acme Co");
      expect(part).not.toContain("Wagon Payroll");
    }
  });

  it("a null user agent and IP render a fallback, never null or undefined", () => {
    const r = render(CTX, { userAgent: null, ip: null, at: DATA.at });
    for (const part of [r.html, r.text]) {
      expect(part).not.toMatch(/\bnull\b|\bundefined\b/);
      expect(part).toMatch(/unknown device/i);
      expect(part).toMatch(/unknown IP/i);
    }
  });

  it("escapes the user agent, IP, company and brand in html", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const r = render(
      { ...CTX, companyName: "<b>Co</b>", brandName: "<i>Brand</i>" },
      { userAgent: hostile, ip: "<u>ip</u>", at: DATA.at },
    );
    expect(r.html).not.toContain("<img");
    expect(r.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(r.html).not.toContain("<u>ip</u>");
    expect(r.html).toContain("&lt;u&gt;ip&lt;/u&gt;");
    expect(r.html).not.toContain("<b>Co</b>");
    expect(r.html).not.toContain("<i>Brand</i>");
  });

  it("never glues the company name to 'Payroll'", () => {
    const r = render(CTX, DATA);
    for (const part of [r.subject, r.html, r.text]) {
      expect(part).not.toContain("Acme Co Payroll");
    }
  });
});

describe("B the two templates differ", () => {
  it("added and removed have different subjects, html and text", () => {
    const added = securityPasskeyAdded(CTX, DATA);
    const removed = securityPasskeyRemoved(CTX, DATA);
    expect(added.subject).not.toBe(removed.subject);
    expect(added.html).not.toBe(removed.html);
    expect(added.text).not.toBe(removed.text);
  });
});

// ---------------------------------------------------------------- C

describe("C a successful change queues one email", () => {
  it("verify-registration → one pending security_passkey_added row, for the session user only", async () => {
    const { userId, cookie } = await h.totpUser("pr6-c-add@example.com");
    const bystander = await h.totpUser("pr6-c-add-bystander@example.com");
    const { res } = await h.register(cookie, newAuthenticator());
    expect(res?.statusCode).toBe(200);
    const rows = await passkeyMail(userId);
    expect(rows.map((r) => [r.user_id === userId, r.event_type, r.status])).toEqual([
      [true, ADDED, "pending"],
    ]);
    expect(await mailKinds(bystander.userId)).toEqual([]);
  });

  it("each added passkey queues its own email", async () => {
    const { userId, cookie } = await h.totpUser("pr6-c-add-two@example.com");
    expect((await h.register(cookie, newAuthenticator())).res?.statusCode).toBe(200);
    expect((await h.register(cookie, newAuthenticator())).res?.statusCode).toBe(200);
    expect(await mailKinds(userId)).toEqual([ADDED, ADDED]);
  });

  it("delete-passkey → one pending security_passkey_removed row, for the session user only", async () => {
    const { userId, cookie } = await h.totpUser("pr6-c-del@example.com");
    const bystander = await h.totpUser("pr6-c-del-bystander@example.com");
    const id = await h.seedPasskey(userId, newAuthenticator());
    const res = await deletePasskey(cookie, id);
    expect(res.statusCode).toBe(200);
    expect(await h.passkeys(userId)).toEqual([]);
    const rows = await passkeyMail(userId);
    expect(rows.map((r) => [r.user_id === userId, r.event_type, r.status])).toEqual([
      [true, REMOVED, "pending"],
    ]);
    expect(await mailKinds(bystander.userId)).toEqual([]);
  });

  it("add then remove queues one of each, in order", async () => {
    const { userId, cookie } = await h.totpUser("pr6-c-both@example.com");
    expect((await h.register(cookie, newAuthenticator())).res?.statusCode).toBe(200);
    const [pk] = await h.passkeys(userId);
    expect((await deletePasskey(cookie, pk!.id)).statusCode).toBe(200);
    expect(await mailKinds(userId)).toEqual([ADDED, REMOVED]);
  });

  it("the row reports the request's device and IP, with the user agent escaped", async () => {
    const { userId, cookie } = await h.totpUser("pr6-c-context@example.com");
    const ip = h.ip();
    const ua = "pr6-agent/1.0 <img src=x>";
    const res = await registerFrom(cookie, newAuthenticator(), ua, ip);
    expect(res.statusCode).toBe(200);
    const [row] = await passkeyMail(userId);
    expect(row?.body_html).toContain("pr6-agent/1.0 &lt;img src=x&gt;");
    expect(row?.body_html).not.toContain("<img");
    expect(row?.body_html).toContain(ip);
    // The server passes a readable UTC time, not an ISO timestamp.
    expect(row?.body_html).toMatch(/[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M UTC/);
    expect(row?.body_html).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

// ---------------------------------------------------------------- D

describe("D no email without a completed change", () => {
  it("registration without user verification → 400, no row", async () => {
    const { userId, cookie } = await h.totpUser("pr6-d-nouv@example.com");
    const { res } = await h.register(cookie, newAuthenticator(), { overrides: { uv: false } });
    expect(res?.statusCode).toBe(400);
    expect(await h.passkeys(userId)).toEqual([]);
    expect(await mailKinds(userId)).toEqual([]);
  });

  it("registration from a session that went stale → 403, no row", async () => {
    const { userId, cookie } = await h.totpUser("pr6-d-stale-add@example.com");
    const { res } = await h.register(cookie, newAuthenticator(), {
      between: () => h.ageSession(cookie, 6),
    });
    expect([res?.statusCode, codeOf(res!)]).toEqual([403, "SESSION_NOT_FRESH"]);
    expect(await mailKinds(userId)).toEqual([]);
  });

  it("registration refused by the policy hook (createSession, bad name) → 400, no row", async () => {
    const { userId, cookie } = await h.totpUser("pr6-d-policy@example.com");
    const a = await h.register(cookie, newAuthenticator(), { createSession: true });
    const b = await h.register(cookie, newAuthenticator(), { name: "k".repeat(65) });
    expect([a.res?.statusCode, b.res?.statusCode]).toEqual([400, 400]);
    expect(await h.passkeys(userId)).toEqual([]);
    expect(await mailKinds(userId)).toEqual([]);
  });

  it("delete from a stale session → 403, the passkey stays, no row", async () => {
    const { userId, cookie } = await h.totpUser("pr6-d-stale-del@example.com");
    const id = await h.seedPasskey(userId, newAuthenticator());
    await h.ageSession(cookie, 6);
    const res = await deletePasskey(cookie, id);
    expect([res.statusCode, codeOf(res)]).toEqual([403, "SESSION_NOT_FRESH"]);
    expect((await h.passkeys(userId)).length).toBe(1);
    expect(await mailKinds(userId)).toEqual([]);
  });

  it("delete of another user's passkey → refused, it stays, no row for either user", async () => {
    const attacker = await h.totpUser("pr6-d-cross-a@example.com");
    const owner = await h.onboard("pr6-d-cross-b@example.com");
    const id = await h.seedPasskey(owner.userId, newAuthenticator());
    const res = await deletePasskey(attacker.cookie, id);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect((await h.passkeys(owner.userId)).length).toBe(1);
    expect(await mailKinds(attacker.userId)).toEqual([]);
    expect(await mailKinds(owner.userId)).toEqual([]);
  });

  it("delete of an unknown passkey id → refused, no row", async () => {
    const { userId, cookie } = await h.totpUser("pr6-d-unknown@example.com");
    const res = await deletePasskey(cookie, randomUUID());
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await mailKinds(userId)).toEqual([]);
  });

  it("a rename (update-passkey) → 200, no row", async () => {
    const { userId, cookie } = await h.totpUser("pr6-d-rename@example.com");
    const id = await h.seedPasskey(userId, newAuthenticator(), { name: "Old" });
    const res = await h.auth("POST", "/passkey/update-passkey", {
      cookie,
      payload: { id, name: "New" },
    });
    expect(res.statusCode).toBe(200);
    expect((await h.passkeys(userId))[0]!.name).toBe("New");
    expect(await mailKinds(userId)).toEqual([]);
  });

  it("a passkey sign-in queues the new-device email and no passkey email", async () => {
    const { userId } = await h.onboard("pr6-d-signin@example.com");
    const a = newAuthenticator();
    await h.seedPasskey(userId, a);
    const before = await countMail(userId, EVENT_TYPE.securityLoginNewDevice);
    const { res } = await h.passkeySignIn(a, { ua: "pr6-signin-agent/1.0" });
    expect(res.statusCode).toBe(200);
    expect(await countMail(userId, EVENT_TYPE.securityLoginNewDevice)).toBe(before + 1);
    expect(await mailKinds(userId)).toEqual([]);
  });

  it("an admin reset wipes the passkeys and queues no passkey email", async () => {
    const { userId } = await h.onboard("pr6-d-reset@example.com");
    await h.seedPasskey(userId, newAuthenticator());
    await h.seedPasskey(userId, newAuthenticator());
    await initiateReset({ auth: t.auth, db: t.db, config: t.config }, userId, null);
    expect(await h.passkeys(userId)).toEqual([]);
    expect(await mailKinds(userId)).toEqual([]);
  });
});

// ---------------------------------------------------------------- E

function holdsCredentialMaterial(
  row: OutboxRow,
  secrets: { name: string; credentialID: string; publicKey: string },
): boolean {
  return [row.subject, row.body_html].some(
    (part) =>
      part.includes(secrets.name) ||
      part.includes(secrets.credentialID) ||
      part.includes(secrets.publicKey),
  );
}

describe("E no passkey details in the email", () => {
  it("added: subject and html hold no name, credential ID or public key", async () => {
    const { userId, cookie } = await h.totpUser("pr6-e-add@example.com");
    const a = newAuthenticator();
    const { res } = await h.register(cookie, a, { name: PASSKEY_NAME });
    expect(res?.statusCode).toBe(200);
    const [pk] = await h.passkeys(userId);
    // The name really was stored, so its absence from the email is meaningful.
    expect(pk?.name === PASSKEY_NAME).toBe(true);
    const rows = await passkeyMail(userId);
    expect(rows.length).toBe(1);
    expect(
      holdsCredentialMaterial(rows[0]!, {
        name: PASSKEY_NAME,
        credentialID: a.id,
        publicKey: pk!.publicKey,
      }),
    ).toBe(false);
  });

  it("removed: subject and html hold no name, credential ID or public key", async () => {
    const { userId, cookie } = await h.totpUser("pr6-e-del@example.com");
    const a = newAuthenticator();
    const id = await h.seedPasskey(userId, a, { name: PASSKEY_NAME });
    const [pk] = await h.passkeys(userId);
    expect(pk?.name === PASSKEY_NAME).toBe(true);
    expect((await deletePasskey(cookie, id)).statusCode).toBe(200);
    const rows = await passkeyMail(userId);
    expect(rows.length).toBe(1);
    expect(
      holdsCredentialMaterial(rows[0]!, {
        name: PASSKEY_NAME,
        credentialID: a.id,
        publicKey: pk!.publicKey,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------- F

/**
 * Makes matching inserts into `table` fail in Postgres for the length of
 * `fn`, whichever code path writes them. Console output is captured, not shown.
 */
async function withInsertFailing(
  table: string,
  when: string,
  fn: (logged: () => string) => Promise<void>,
): Promise<void> {
  await t.pglite.exec(`
    create function pr6_fail_insert() returns trigger language plpgsql as $$
    begin raise exception 'pr6 synthetic insert failure'; end $$;
    create trigger pr6_fail_insert before insert on ${table} for each row
      when (${when}) execute function pr6_fail_insert();
  `);
  const out: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    out.push(
      args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(" "),
    );
  });
  try {
    await fn(() => out.join("\n"));
  } finally {
    spy.mockRestore();
    await t.pglite.exec(`
      drop trigger pr6_fail_insert on ${table};
      drop function pr6_fail_insert();
    `);
  }
}

function withOutboxFailing(fn: (logged: () => string) => Promise<void>): Promise<void> {
  return withInsertFailing("email_outbox", "new.event_type like 'security_passkey_%'", fn);
}

function withAuditFailing(fn: (logged: () => string) => Promise<void>): Promise<void> {
  return withInsertFailing("auth_events", "new.event in ('passkey_added', 'passkey_removed')", fn);
}

describe("F a failed queue never fails the request", () => {
  it("the failure seam really rejects a passkey email insert", async () => {
    const { userId } = await h.onboard("pr6-f-seam@example.com");
    await withOutboxFailing(async () => {
      await expect(
        t.pglite.query(
          `insert into email_outbox (user_id, event_type, subject, body_html) values ($1, '${ADDED}', 's', 'b')`,
          [userId],
        ),
      ).rejects.toThrow();
    });
    expect(await mailKinds(userId)).toEqual([]);
  });

  it("registration: 200, the passkey row and audit event are saved, no email row", async () => {
    const { userId, cookie } = await h.totpUser("pr6-f-add@example.com");
    const a = newAuthenticator();
    await withOutboxFailing(async (logged) => {
      const { res } = await h.register(cookie, a, { name: PASSKEY_NAME });
      expect(res?.statusCode).toBe(200);
      expect(logged().includes(PASSKEY_NAME)).toBe(false);
      expect(logged().includes(a.id)).toBe(false);
    });
    expect((await h.passkeys(userId)).map((p) => p.credentialID === a.id)).toEqual([true]);
    expect((await h.events(userId, "passkey_added")).length).toBe(1);
    expect(await mailKinds(userId)).toEqual([]);
  });

  it("delete: 200, the passkey row is gone, the audit event is saved, no email row", async () => {
    const { userId, cookie } = await h.totpUser("pr6-f-del@example.com");
    const a = newAuthenticator();
    const id = await h.seedPasskey(userId, a, { name: PASSKEY_NAME });
    await withOutboxFailing(async (logged) => {
      expect((await deletePasskey(cookie, id)).statusCode).toBe(200);
      expect(logged().includes(PASSKEY_NAME)).toBe(false);
      expect(logged().includes(a.id)).toBe(false);
    });
    expect(await h.passkeys(userId)).toEqual([]);
    expect((await h.events(userId, "passkey_removed")).length).toBe(1);
    expect(await mailKinds(userId)).toEqual([]);
  });

  it("after a failed queue the next change queues normally", async () => {
    const { userId, cookie } = await h.totpUser("pr6-f-recover@example.com");
    await withOutboxFailing(async () => {
      expect((await h.register(cookie, newAuthenticator())).res?.statusCode).toBe(200);
    });
    expect((await h.register(cookie, newAuthenticator())).res?.statusCode).toBe(200);
    expect(await mailKinds(userId)).toEqual([ADDED]);
  });
});

// ---------------------------------------------------------------- G

class StubTransport implements MailTransport {
  messages: { from: string; to: string; subject: string; html: string; text: string }[] = [];
  async sendMail(message: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }) {
    this.messages.push(message);
    return { messageId: `stub-${this.messages.length}` };
  }
}

async function resolveRecipientEmail(userId: string): Promise<string | null> {
  const rows = await t.db
    .select({ email: authUser.email })
    .from(authUser)
    .where(eq(authUser.id, userId))
    .limit(1);
  return rows[0]?.email ?? null;
}

async function clearPending(): Promise<void> {
  await t.pglite.query(`update email_outbox set status = 'sent' where status = 'pending'`);
}

describe("G notification settings do not suppress", () => {
  it("a disabled settings row neither stops the queue nor the send, for either event", async () => {
    const email = "pr6-g-optout@example.com";
    const { userId, cookie } = await h.totpUser(email);
    await t.db.insert(notificationSettings).values([
      { userId, eventType: ADDED, enabled: false },
      { userId, eventType: REMOVED, enabled: false },
    ]);
    await clearPending();

    expect((await h.register(cookie, newAuthenticator())).res?.statusCode).toBe(200);
    const [pk] = await h.passkeys(userId);
    expect((await deletePasskey(cookie, pk!.id)).statusCode).toBe(200);
    expect(await mailKinds(userId)).toEqual([ADDED, REMOVED]);

    const transport = new StubTransport();
    const result = await drainOutbox({
      db: t.db,
      config: t.config,
      transport,
      resolveRecipientEmail,
    });
    expect(result.suppressed).toBe(0);
    expect(result.sent).toBe(2);
    expect((await passkeyMail(userId)).map((r) => r.status)).toEqual(["sent", "sent"]);
    expect(transport.messages.map((m) => m.to)).toEqual([email, email]);
  });

  it("the settings API neither lists nor accepts them", async () => {
    const { cookie } = await h.totpUser("pr6-g-api@example.com", "admin");
    const get = await t.app.inject({
      method: "GET",
      url: "/api/my/notification-settings",
      headers: sessionHeader(cookie),
    });
    expect(get.statusCode).toBe(200);
    const listed = (get.json() as { settings: { eventType: string }[] }).settings.map(
      (s) => s.eventType,
    );
    expect(listed).not.toContain(ADDED);
    expect(listed).not.toContain(REMOVED);

    for (const eventType of [ADDED, REMOVED]) {
      const put = await t.app.inject({
        method: "PUT",
        url: "/api/my/notification-settings",
        headers: sessionHeader(cookie),
        payload: { settings: [{ eventType, enabled: false }] },
      });
      expect(put.statusCode, eventType).toBe(400);
    }
  });
});

// ---------------------------------------------------------------- H

describe("H the plain text actually sent", () => {
  it("the added email's flattened text holds the checkbox phrase and no HTML entity", async () => {
    const email = "pr6-h-text@example.com";
    const { cookie } = await h.totpUser(email);
    await clearPending();
    expect((await h.register(cookie, newAuthenticator())).res?.statusCode).toBe(200);

    const transport = new StubTransport();
    await drainOutbox({ db: t.db, config: t.config, transport, resolveRecipientEmail });
    const sent = transport.messages.filter((m) => m.to === email);
    expect(sent.length).toBe(1);
    expect(sent[0]!.text).toContain("Also sign me out on all other devices");
    expect(sent[0]!.text).not.toContain("&quot;");
  });
});

// ---------------------------------------------------------------- I

describe("I client-chosen request values are bounded", () => {
  const deps = () => ({ db: t.db, config: t.config });

  it("through the request: a user agent over 200 characters is cut to 200", async () => {
    const { userId, cookie } = await h.totpUser("pr6-i-request@example.com");
    const ua = `pr6-long-agent/${"x".repeat(300)}`;
    const res = await registerFrom(cookie, newAuthenticator(), ua, h.ip());
    expect(res.statusCode).toBe(200);
    const [row] = await passkeyMail(userId);
    expect(row?.body_html).toContain(`Device: ${ua.slice(0, 200)}<`);
  });

  // The client chooses X-Forwarded-For, so an intruder must not be able to skip the warning with it.
  it("through the request: a non-IP X-Forwarded-For still answers 200, queues the email and shows the fallback", async () => {
    const { userId, cookie } = await h.totpUser("pr6-i-non-ip@example.com");
    const res = await registerFrom(cookie, newAuthenticator(), "pr6", "attacker-chosen-text");
    const rows = await passkeyMail(userId);
    expect({
      status: res.statusCode,
      passkeys: (await h.passkeys(userId)).length,
      emails: rows.length,
      fallback: rows[0]?.body_html.includes("IP: unknown IP<") ?? false,
    }).toEqual({ status: 200, passkeys: 1, emails: 1, fallback: true });
  });

  // node's isIP accepts an IPv6 zone ID; Postgres inet does not.
  it.each(["fe80::1%a", "::1%x"])(
    "through the request: X-Forwarded-For %s → 200, audit row with a null IP, email with the fallback",
    async (ip) => {
      const { userId, cookie } = await h.totpUser(`pr6-i-zone-${ip.length}@example.com`);
      const res = await registerFrom(cookie, newAuthenticator(), "pr6", ip);
      const audit = await t.pglite.query<{ ip: string | null }>(
        `select ip from auth_events where user_id = $1 and event = 'passkey_added'`,
        [userId],
      );
      const rows = await passkeyMail(userId);
      expect({
        status: res.statusCode,
        auditIps: audit.rows.map((r) => r.ip),
        emails: rows.length,
        fallback: rows[0]?.body_html.includes("IP: unknown IP<") ?? false,
      }).toEqual({ status: 200, auditIps: [null], emails: 1, fallback: true });
    },
  );

  it("usableIp keeps a real address and drops everything else", () => {
    for (const ip of ["203.0.113.9", "2001:db8::1", "::1"]) expect(usableIp(ip), ip).toBe(ip);
    for (const ip of [
      null,
      undefined,
      "",
      "fe80::1%a",
      "::1%x",
      "attacker-chosen-text",
      "999.1.1.1",
      "203.0.113.9 extra",
    ]) {
      expect(usableIp(ip), String(ip)).toBeNull();
    }
  });

  it("a user agent of exactly 200 characters is kept whole", async () => {
    const { userId } = await h.onboard("pr6-i-boundary@example.com");
    const ua = "y".repeat(200);
    await queuePasskeyEmail(deps(), { userId, kind: "added", userAgent: ua, ip: null });
    const [row] = await passkeyMail(userId);
    expect(row?.body_html).toContain(`Device: ${ua}<`);
  });

  it("only a real IPv4 or IPv6 address is shown", async () => {
    const { userId } = await h.onboard("pr6-i-ip@example.com");
    const cases = [
      ["203.0.113.9", "203.0.113.9"],
      ["2001:db8::1", "2001:db8::1"],
      ["attacker-chosen-text", "unknown IP"],
      ["fe80::1%a", "unknown IP"],
      ["::1%x", "unknown IP"],
      ["999.1.1.1", "unknown IP"],
      ["203.0.113.9 extra", "unknown IP"],
      ["", "unknown IP"],
    ] as const;
    for (const [ip] of cases) {
      await queuePasskeyEmail(deps(), { userId, kind: "removed", userAgent: "pr6", ip });
    }
    const rows = await passkeyMail(userId);
    expect(rows.length).toBe(cases.length);
    cases.forEach(([ip, shown], i) => {
      expect(rows[i]!.body_html.includes(`IP: ${shown}<`), ip).toBe(true);
    });
  });
});

// ---------------------------------------------------------------- J

describe("J a failed audit write does not suppress the email", () => {
  it("the failure seam really rejects a passkey audit insert", async () => {
    const { userId } = await h.onboard("pr6-j-seam@example.com");
    await withAuditFailing(async () => {
      await expect(
        t.pglite.query(`insert into auth_events (user_id, event) values ($1, 'passkey_added')`, [
          userId,
        ]),
      ).rejects.toThrow();
    });
    expect(await h.events(userId, "passkey_added")).toEqual([]);
  });

  it("registration: 200, the passkey is saved, no audit row, the email is queued", async () => {
    const { userId, cookie } = await h.totpUser("pr6-j-add@example.com");
    await withAuditFailing(async () => {
      expect((await h.register(cookie, newAuthenticator())).res?.statusCode).toBe(200);
    });
    expect((await h.passkeys(userId)).length).toBe(1);
    expect(await h.events(userId, "passkey_added")).toEqual([]);
    expect(await mailKinds(userId)).toEqual([ADDED]);
  });

  it("delete: 200, the passkey is gone, no audit row, the email is queued", async () => {
    const { userId, cookie } = await h.totpUser("pr6-j-del@example.com");
    const id = await h.seedPasskey(userId, newAuthenticator());
    await withAuditFailing(async () => {
      expect((await deletePasskey(cookie, id)).statusCode).toBe(200);
    });
    expect(await h.passkeys(userId)).toEqual([]);
    expect(await h.events(userId, "passkey_removed")).toEqual([]);
    expect(await mailKinds(userId)).toEqual([REMOVED]);
  });
});

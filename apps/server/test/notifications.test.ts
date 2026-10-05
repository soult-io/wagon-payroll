/**
 * Notification integration tests (spec 6, step 4). Real SQL via the PGlite
 * harness; only the SMTP TRANSPORT is stubbed (the DB never is).
 *
 * Covers: outbox drain (send, exponential backoff, 5-attempt failure,
 * opt-out suppression, security-event bypass), template content rules
 * (no amounts / no net pay / no bank-SSN), per-user settings (defaults on
 * activation, PUT toggles, security events not toggleable), new-device
 * detection, and the admin observability endpoints.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  authUser,
  company,
  emailOutbox,
  employees,
  notificationSettings,
  seedDatabase,
  userDevices,
  type SeedDb,
} from "@payroll/db";
import {
  changeRequestApproved,
  changeRequestDenied,
  changeRequestSubmitted,
  EVENT_TYPE,
  payslipIssued,
  WORKFLOW_EVENTS,
  workflowEventsFor,
} from "@payroll/notifications";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";
import { drainOutbox, MAX_ATTEMPTS, type MailTransport } from "../src/notify/outbox.js";

let t: TestContext;
let userA: { userId: string; email: string };
let cookieA: string;
let admin: { userId: string; email: string };
let adminCookie: string;

const CTX = { companyName: "Test Co", brandName: "Wagon Payroll", appUrl: "http://localhost" };

class StubTransport implements MailTransport {
  messages: { from: string; to: string; subject: string; html: string; text: string }[] = [];
  failWith: string | null = null;
  async sendMail(message: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }) {
    if (this.failWith) throw new Error(this.failWith);
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

/** Mark everything pending as sent so each drain test starts from a clean slate. */
async function clearOutbox(): Promise<void> {
  await t.db.update(emailOutbox).set({ status: "sent" }).where(eq(emailOutbox.status, "pending"));
}

async function insertOutbox(userId: string, eventType: string, subject: string): Promise<number> {
  const rows = await t.db
    .insert(emailOutbox)
    .values({ userId, eventType, subject, bodyHtml: `<p>${subject}</p>` })
    .returning();
  return rows[0]!.id;
}

async function outboxRow(id: number) {
  const rows = await t.db.select().from(emailOutbox).where(eq(emailOutbox.id, id));
  return rows[0]!;
}

beforeAll(async () => {
  t = await createTestApp({
    emailMode: "smtp",
    smtp: { host: "smtp.test", port: 587, user: "", from: "payroll@example.test", secure: false },
  });
  await seedDatabase(t.db as unknown as SeedDb);

  userA = await inviteAndOnboard(t, { email: "notif-a@example.com", role: "employee" });
  cookieA = (await login(t, userA.email, TEST_PASSWORD)).sessionCookie;

  admin = await inviteAndOnboard(t, { email: "notif-admin@example.com", role: "admin" });
  adminCookie = (await login(t, admin.email, TEST_PASSWORD)).sessionCookie;
});

afterAll(async () => {
  await t.close();
});

describe("outbox drain", () => {
  it("sends pending rows via the injected transport and marks them sent", async () => {
    await clearOutbox();
    const transport = new StubTransport();
    const id = await insertOutbox(userA.userId, EVENT_TYPE.payslipIssued, "drain-send");

    const result = await drainOutbox({
      db: t.db,
      config: t.config,
      transport,
      resolveRecipientEmail,
    });
    expect(result.sent).toBe(1);

    const row = await outboxRow(id);
    expect(row.status).toBe("sent");
    expect(row.attempts).toBe(1);
    expect(row.sentAt).not.toBeNull();

    expect(transport.messages).toHaveLength(1);
    expect(transport.messages[0]).toMatchObject({
      from: "payroll@example.test",
      to: userA.email,
      subject: "drain-send",
    });
    expect(transport.messages[0]!.text.length).toBeGreaterThan(0); // text/plain fallback
  });

  it("backs off exponentially and fails permanently after 5 attempts", async () => {
    await clearOutbox();
    const transport = new StubTransport();
    transport.failWith = "SMTP connection refused";
    const id = await insertOutbox(userA.userId, EVENT_TYPE.payslipIssued, "drain-fail");

    const first = await drainOutbox({
      db: t.db,
      config: t.config,
      transport,
      resolveRecipientEmail,
    });
    expect(first.failed).toBe(1);
    let row = await outboxRow(id);
    expect(row.status).toBe("pending"); // attempts 1 < 5: still retryable
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe("SMTP connection refused");
    expect(row.lastAttemptAt).not.toBeNull();

    // Exponential backoff: an immediate second drain skips the row.
    const second = await drainOutbox({
      db: t.db,
      config: t.config,
      transport,
      resolveRecipientEmail,
    });
    expect(second.retriedLater).toBe(1);
    expect(second.failed).toBe(0);
    expect((await outboxRow(id)).attempts).toBe(1);

    // Simulate the 5th attempt being due (attempts=4, last attempt long ago).
    await t.db
      .update(emailOutbox)
      .set({
        attempts: MAX_ATTEMPTS - 1,
        lastAttemptAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      })
      .where(eq(emailOutbox.id, id));
    const final = await drainOutbox({
      db: t.db,
      config: t.config,
      transport,
      resolveRecipientEmail,
    });
    expect(final.failed).toBe(1);
    row = await outboxRow(id);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.lastError).toBe("SMTP connection refused");
  });

  it("suppresses workflow events the user opted out of", async () => {
    await clearOutbox();
    const transport = new StubTransport();
    await t.db
      .insert(notificationSettings)
      .values({ userId: userA.userId, eventType: EVENT_TYPE.payslipIssued, enabled: false })
      .onConflictDoUpdate({
        target: [notificationSettings.userId, notificationSettings.eventType],
        set: { enabled: false },
      });

    const id = await insertOutbox(userA.userId, EVENT_TYPE.payslipIssued, "drain-suppress");
    const result = await drainOutbox({
      db: t.db,
      config: t.config,
      transport,
      resolveRecipientEmail,
    });
    expect(result.suppressed).toBe(1);
    expect((await outboxRow(id)).status).toBe("suppressed");
    expect(transport.messages).toHaveLength(0);

    // Restore the default for later tests.
    await t.db
      .update(notificationSettings)
      .set({ enabled: true })
      .where(
        and(
          eq(notificationSettings.userId, userA.userId),
          eq(notificationSettings.eventType, EVENT_TYPE.payslipIssued),
        ),
      );
  });

  it("security events bypass notification settings (always on)", async () => {
    await clearOutbox();
    const transport = new StubTransport();
    // Even a (hypothetical) disabled row must not stop a security email.
    await t.db
      .insert(notificationSettings)
      .values({
        userId: userA.userId,
        eventType: EVENT_TYPE.securityLoginNewDevice,
        enabled: false,
      })
      .onConflictDoNothing();

    const id = await insertOutbox(
      userA.userId,
      EVENT_TYPE.securityLoginNewDevice,
      "drain-security",
    );
    const result = await drainOutbox({
      db: t.db,
      config: t.config,
      transport,
      resolveRecipientEmail,
    });
    expect(result.sent).toBe(1);
    expect((await outboxRow(id)).status).toBe("sent");
    expect(transport.messages).toHaveLength(1);
  });

  it("log mode marks rows sent without a transport (dev flag)", async () => {
    await clearOutbox();
    const id = await insertOutbox(userA.userId, EVENT_TYPE.payslipIssued, "drain-log");
    const result = await drainOutbox({
      db: t.db,
      config: { ...t.config, emailMode: "log" },
      resolveRecipientEmail,
    });
    expect(result.logged).toBe(1);
    expect((await outboxRow(id)).status).toBe("sent");
  });
});

describe("template content rules", () => {
  it("payslip_issued states the period and never net pay", () => {
    const rendered = payslipIssued(CTX, {
      periodLabel: "2025-06-01 → 2025-06-30",
      payDate: "2025-06-15",
    });
    expect(rendered.text).toContain("2025-06-01");
    expect(rendered.text).toContain("2025-06-15");
    expect(rendered.html).not.toMatch(/net pay/i);
    expect(rendered.html).not.toContain("$");
    expect(rendered.html).not.toMatch(/attach/i);
  });

  it("change_request_* emails never include amounts", () => {
    const submitted = changeRequestSubmitted(CTX, {
      employeeName: "Jane Doe",
      requestType: "bank_details",
    });
    const approved = changeRequestApproved(CTX, { requestType: "w4", effectiveFrom: "2025-08-01" });
    const denied = changeRequestDenied(CTX, { requestType: "address" });
    for (const r of [submitted, approved, denied]) {
      expect(r.html).not.toContain("$");
      expect(r.html).not.toMatch(/amount|net pay|gross/i);
      expect(r.text).not.toContain("$");
    }
    expect(submitted.html).toContain("Jane Doe");
    expect(approved.html).toContain("2025-08-01");
  });

  it("no template ever includes bank or SSN data", () => {
    const rendered = [
      payslipIssued(CTX, { periodLabel: "2025-06", payDate: "2025-06-15" }),
      changeRequestSubmitted(CTX, { employeeName: "Jane", requestType: "bank_details" }),
      changeRequestApproved(CTX, { requestType: "bank_details", effectiveFrom: "2025-08-01" }),
      changeRequestDenied(CTX, { requestType: "bank_details" }),
    ];
    for (const r of rendered) {
      expect(r.html).not.toMatch(/routing|account number|\bssn\b|social security number/i);
    }
  });
});

describe("per-user settings", () => {
  it("activation seeds the workflow events enabled by default", async () => {
    const rows = await t.db
      .select()
      .from(notificationSettings)
      .where(eq(notificationSettings.userId, userA.userId));
    // (The security-bypass drain test added a security_event row for this user
    // directly in the DB — assert on the workflow rows only.)
    const workflow = rows.filter((r) =>
      (WORKFLOW_EVENTS as readonly string[]).includes(r.eventType),
    );
    expect(workflow.map((r) => r.eventType).sort()).toEqual([...WORKFLOW_EVENTS].sort());
    expect(workflow.every((r) => r.enabled)).toBe(true);
  });

  it("GET/PUT /api/my/notification-settings toggles workflow events only", async () => {
    const get1 = await t.app.inject({
      method: "GET",
      url: "/api/my/notification-settings",
      headers: sessionHeader(cookieA),
    });
    expect(get1.statusCode).toBe(200);
    const before = get1.json() as { settings: { eventType: string; enabled: boolean }[] };
    // PAY-8: a non-admin without a linked employee record sees every
    // non-admin workflow event (worker-type events stay visible until the
    // record exists); admin events never surface for non-admins.
    expect(before.settings.map((s) => s.eventType).sort()).toEqual(
      [...workflowEventsFor({ isAdmin: false, employmentType: null })].sort(),
    );

    const put = await t.app.inject({
      method: "PUT",
      url: "/api/my/notification-settings",
      headers: sessionHeader(cookieA),
      payload: { settings: [{ eventType: EVENT_TYPE.changeRequestApproved, enabled: false }] },
    });
    expect(put.statusCode).toBe(200);

    const get2 = await t.app.inject({
      method: "GET",
      url: "/api/my/notification-settings",
      headers: sessionHeader(cookieA),
    });
    const after = get2.json() as { settings: { eventType: string; enabled: boolean }[] };
    expect(
      after.settings.find((s) => s.eventType === EVENT_TYPE.changeRequestApproved)?.enabled,
    ).toBe(false);

    // Security events are not toggleable through the API.
    const reject = await t.app.inject({
      method: "PUT",
      url: "/api/my/notification-settings",
      headers: sessionHeader(cookieA),
      payload: { settings: [{ eventType: EVENT_TYPE.securityInvite, enabled: false }] },
    });
    expect(reject.statusCode).toBe(400);
  });
});

describe("PAY-8 audience scoping", () => {
  let w2Cookie: string;
  let contractorCookie: string;

  beforeAll(async () => {
    const w2 = await inviteAndOnboard(t, { email: "notif-w2@example.com", role: "employee" });
    const contractor = await inviteAndOnboard(t, {
      email: "notif-1099@example.com",
      role: "employee",
    });
    const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
    await t.db.insert(employees).values([
      {
        companyId: companyRows[0]!.id,
        employmentType: "w2",
        legalName: "Wanda W2",
        hireDate: "2026-01-05",
        userId: w2.userId,
      },
      {
        companyId: companyRows[0]!.id,
        employmentType: "1099",
        legalName: "Carl Contractor",
        hireDate: "2026-01-05",
        userId: contractor.userId,
      },
    ]);
    w2Cookie = (await login(t, w2.email, TEST_PASSWORD)).sessionCookie;
    contractorCookie = (await login(t, contractor.email, TEST_PASSWORD)).sessionCookie;
  });

  async function getSettings(cookie: string): Promise<string[]> {
    const res = await t.app.inject({
      method: "GET",
      url: "/api/my/notification-settings",
      headers: sessionHeader(cookie),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { settings: { eventType: string }[] };
    return body.settings.map((s) => s.eventType);
  }

  it("a W-2 employee sees w2 + shared events — never admin or contractor events", async () => {
    const events = await getSettings(w2Cookie);
    expect(events).toContain(EVENT_TYPE.payslipIssued);
    expect(events).toContain(EVENT_TYPE.changeRequestApproved);
    expect(events).toContain(EVENT_TYPE.changeRequestDenied);
    expect(events).not.toContain(EVENT_TYPE.payrollDraftReady);
    expect(events).not.toContain(EVENT_TYPE.changeRequestSubmitted);
    expect(events).not.toContain(EVENT_TYPE.contractorInvoiceReviewed);
    expect(events).not.toContain(EVENT_TYPE.contractorInvoicePaid);
  });

  // PAY-208 (OD6, A7; 26 CFR 31.6051-1(j)(5)(i)): the W-2 year notice is the
  // legal notice of an online W-2 — always on, never a toggle (fail-first).
  it("PAY-208 T8: w2_available is not a toggleable workflow event on any settings surface", async () => {
    expect((WORKFLOW_EVENTS as readonly string[]).includes(EVENT_TYPE.w2Available)).toBe(false);
    expect(await getSettings(w2Cookie)).not.toContain(EVENT_TYPE.w2Available);
    expect(await getSettings(adminCookie)).not.toContain(EVENT_TYPE.w2Available);
  });

  it("a contractor sees contractor + shared events — never admin or w2 events", async () => {
    const events = await getSettings(contractorCookie);
    expect(events).toContain(EVENT_TYPE.contractorInvoiceReviewed);
    expect(events).toContain(EVENT_TYPE.contractorInvoicePaid);
    expect(events).toContain(EVENT_TYPE.changeRequestApproved);
    expect(events).toContain(EVENT_TYPE.changeRequestDenied);
    expect(events).not.toContain(EVENT_TYPE.payrollDraftReady);
    expect(events).not.toContain(EVENT_TYPE.changeRequestSubmitted);
    expect(events).not.toContain(EVENT_TYPE.payslipIssued);
  });

  it("an admin still sees the full workflow list", async () => {
    const events = await getSettings(adminCookie);
    expect(events.sort()).toEqual([...WORKFLOW_EVENTS].sort());
  });

  it("a non-admin cannot toggle an admin event (not_applicable)", async () => {
    const put = await t.app.inject({
      method: "PUT",
      url: "/api/my/notification-settings",
      headers: sessionHeader(w2Cookie),
      payload: { settings: [{ eventType: EVENT_TYPE.payrollDraftReady, enabled: false }] },
    });
    expect(put.statusCode).toBe(400);
    expect(put.json()).toMatchObject({ error: "not_applicable" });
  });

  it("a W-2 employee cannot toggle a contractor event (not_applicable)", async () => {
    const put = await t.app.inject({
      method: "PUT",
      url: "/api/my/notification-settings",
      headers: sessionHeader(w2Cookie),
      payload: { settings: [{ eventType: EVENT_TYPE.contractorInvoicePaid, enabled: false }] },
    });
    expect(put.statusCode).toBe(400);
    expect(put.json()).toMatchObject({ error: "not_applicable" });
  });
});

describe("new-device detection", () => {
  it("first login from a fingerprint queues the security email; repeat does not", async () => {
    const fresh = await inviteAndOnboard(t, {
      email: "notif-device@example.com",
      role: "employee",
    });

    await clearOutbox();
    await login(t, fresh.email, TEST_PASSWORD, { remoteAddress: "203.0.113.10" });

    const devices = await t.db
      .select()
      .from(userDevices)
      .where(eq(userDevices.userId, fresh.userId));
    expect(devices).toHaveLength(1);

    const mails = await t.db
      .select()
      .from(emailOutbox)
      .where(
        and(
          eq(emailOutbox.userId, fresh.userId),
          eq(emailOutbox.eventType, EVENT_TYPE.securityLoginNewDevice),
        ),
      );
    expect(mails).toHaveLength(1);
    expect(mails[0]!.bodyHtml).toContain("203.0.113.10");

    // Same fingerprint again → no new row, no new email.
    await login(t, fresh.email, TEST_PASSWORD, { remoteAddress: "203.0.113.10" });
    const devices2 = await t.db
      .select()
      .from(userDevices)
      .where(eq(userDevices.userId, fresh.userId));
    expect(devices2).toHaveLength(1);
    const mails2 = await t.db
      .select()
      .from(emailOutbox)
      .where(
        and(
          eq(emailOutbox.userId, fresh.userId),
          eq(emailOutbox.eventType, EVENT_TYPE.securityLoginNewDevice),
          eq(emailOutbox.status, "pending"),
        ),
      );
    expect(mails2).toHaveLength(1); // still just the first one
  });
});

describe("admin observability", () => {
  it("outbox health endpoint reports per-status counts and recent failures", async () => {
    await clearOutbox();
    const failId = await insertOutbox(admin.userId, EVENT_TYPE.payslipIssued, "observability-fail");
    await t.db
      .update(emailOutbox)
      .set({ status: "failed", attempts: MAX_ATTEMPTS, lastError: "boom" })
      .where(eq(emailOutbox.id, failId));

    const res = await t.app.inject({
      method: "GET",
      url: "/api/admin/notifications/outbox",
      headers: sessionHeader(adminCookie),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      counts: Record<string, number>;
      recentFailures: { id: number; lastError: string }[];
      emailMode: string;
    };
    expect(body.counts["failed"]).toBeGreaterThanOrEqual(1);
    expect(body.counts["sent"]).toBeGreaterThanOrEqual(1);
    expect(body.recentFailures.some((f) => f.id === failId && f.lastError === "boom")).toBe(true);
    expect(body.emailMode).toBe("smtp");

    // Employees cannot see it.
    const forbidden = await t.app.inject({
      method: "GET",
      url: "/api/admin/notifications/outbox",
      headers: sessionHeader(cookieA),
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("test-email button queues an admin_test_email to the requester", async () => {
    await clearOutbox();
    const res = await t.app.inject({
      method: "POST",
      url: "/api/admin/settings/test-email",
      headers: sessionHeader(adminCookie),
    });
    expect(res.statusCode).toBe(202);

    const rows = await t.db
      .select()
      .from(emailOutbox)
      .where(
        and(
          eq(emailOutbox.userId, admin.userId),
          eq(emailOutbox.eventType, EVENT_TYPE.adminTestEmail),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.bodyHtml).toContain(admin.email);
  });
});

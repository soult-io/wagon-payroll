/**
 * Step-5 server additions for the frontend: admin employee directory
 * (list/detail/create/invite/resend/status), company profile, audit viewers,
 * and /api/my/security. Real SQL via the PGlite harness.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { authUser, emailOutbox, employees, seedDatabase, type SeedDb } from "@payroll/db";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";
import { decryptField } from "../src/crypto/field-encryption.js";

let t: TestContext;
let adminCookie: string;
let employeeCookie: string;
let employeeUserId: string;

function adminReq(method: string, url: string, payload?: unknown) {
  return t.app.inject({
    method: method as "GET",
    url,
    headers: sessionHeader(adminCookie),
    ...(payload !== undefined ? { payload } : {}),
  });
}

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "dir-admin@example.com", role: "admin" });
  adminCookie = (await login(t, admin.email, TEST_PASSWORD)).sessionCookie;
  const employee = await inviteAndOnboard(t, {
    email: "dir-employee@example.com",
    role: "employee",
  });
  employeeUserId = employee.userId;
  employeeCookie = (await login(t, employee.email, TEST_PASSWORD)).sessionCookie;
});

afterAll(async () => {
  await t.close();
});

describe("employee directory", () => {
  let employeeId: number;

  it("creates an employee record (SSN encrypted at rest)", async () => {
    const res = await adminReq("POST", "/api/admin/employees", {
      legalName: "Directory Person",
      employmentType: "w2",
      hireDate: "2025-02-03",
      address: { line1: "5 Oak Ave", city: "Madrid", state: "MD", zip: "28002", country: "ES" },
      taxId: "123456789",
    });
    expect(res.statusCode).toBe(201);
    const { employee } = res.json() as { employee: { id: number; user: unknown } };
    employeeId = employee.id;
    expect(employee.user).toBeNull();

    const [row] = await t.db.select().from(employees).where(eq(employees.id, employeeId));
    expect(row!.taxId!.startsWith("enc:v1:")).toBe(true);
    expect(decryptField(row!.taxId!, t.config.encryptionKey)).toBe("123456789");
    // The API response must not contain the SSN in any form.
    expect(res.body).not.toContain("123456789");
    expect(res.body).not.toContain("enc:v1:");
  });

  it("creates a contractor record for testing", async () => {
    const res = await adminReq("POST", "/api/admin/employees", {
      legalName: "Contractor Person",
      employmentType: "1099",
      hireDate: "2025-02-03",
      address: { line1: "5 Oak Ave", city: "Madrid", state: "MD", zip: "28002", country: "ES" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("lists and reads employees with linked-user info", async () => {
    const list = await adminReq("GET", "/api/admin/employees");
    expect(list.statusCode).toBe(200);
    const { employees: rows } = list.json() as { employees: { id: number; legalName: string }[] };
    expect(rows.some((r) => r.legalName === "Directory Person")).toBe(true);
    expect(rows.some((r) => r.legalName === "Contractor Person")).toBe(false); // Contractors are filtered out

    const detail = await adminReq("GET", `/api/admin/employees/${employeeId}`);
    expect(detail.statusCode).toBe(200);
    const { employee } = detail.json() as { employee: { legalName: string; user: null } };
    expect(employee.legalName).toBe("Directory Person");
    expect(employee.user).toBeNull();
  });

  it("invites and links a user, then resend works while pending enrollment", async () => {
    const invite = await adminReq("POST", `/api/admin/employees/${employeeId}/invite`, {
      email: "directory-person@example.com",
    });
    expect(invite.statusCode).toBe(201);
    const invited = invite.json() as { userId: string; resent: boolean; setupLink: string };
    expect(invited.resent).toBe(false);

    const [row] = await t.db.select().from(employees).where(eq(employees.id, employeeId));
    expect(row!.userId).toBe(invited.userId);

    // Resend while still pending enrollment → 200, new setup link.
    const resend = await adminReq("POST", `/api/admin/employees/${employeeId}/invite`, {});
    expect(resend.statusCode).toBe(200);
    expect((resend.json() as { resent: boolean }).resent).toBe(true);

    const mails = await t.db
      .select()
      .from(emailOutbox)
      .where(
        and(eq(emailOutbox.userId, invited.userId), eq(emailOutbox.eventType, "security_invite")),
      );
    expect(mails.length).toBe(2); // invite + resend
  });

  it("disable bans the linked user; enable restores", async () => {
    // Onboard the invited user so there is an active account to disable.
    // (Simulate by unbanning directly — the full onboarding flow is covered elsewhere.)
    const [row] = await t.db.select().from(employees).where(eq(employees.id, employeeId));
    const userId = row!.userId!;
    // PAY-217 round 2 (C7): termination keeps a pending_enrollment ban, so
    // the account must be active first (as the comment above intends).
    await t.db
      .update(authUser)
      .set({ banned: false, banReason: null })
      .where(eq(authUser.id, userId));

    const disable = await adminReq("POST", `/api/admin/employees/${employeeId}/status`, {
      status: "terminated",
      terminationDate: "2025-06-30",
    });
    expect(disable.statusCode).toBe(200);
    const [user] = await t.db.select().from(authUser).where(eq(authUser.id, userId));
    expect(user!.banned).toBe(true);
    expect(user!.banReason).toBe("employee_terminated");
    const [emp] = await t.db.select().from(employees).where(eq(employees.id, employeeId));
    expect(emp!.status).toBe("terminated");
    expect(emp!.terminationDate).toBe("2025-06-30");

    // Re-enable.
    const enable = await adminReq("POST", `/api/admin/employees/${employeeId}/status`, {
      status: "active",
    });
    expect(enable.statusCode).toBe(200);
    const [user2] = await t.db.select().from(authUser).where(eq(authUser.id, userId));
    expect(user2!.banned).toBe(false);

    // No-op is a conflict.
    const noop = await adminReq("POST", `/api/admin/employees/${employeeId}/status`, {
      status: "active",
    });
    expect(noop.statusCode).toBe(409);
  });

  it("requires admin role", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/api/admin/employees",
      headers: sessionHeader(employeeCookie),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("company profile", () => {
  it("reads with masked EIN and updates name/address with audit", async () => {
    const get1 = await adminReq("GET", "/api/admin/company");
    expect(get1.statusCode).toBe(200);
    const { company: before } = get1.json() as {
      company: { legalName: string; einMasked: string | null };
    };
    expect(before.legalName.length).toBeGreaterThan(0);
    expect(before.einMasked === null || before.einMasked.startsWith("••••")).toBe(true);

    const put = await adminReq("PUT", "/api/admin/company", {
      legalName: "Renamed Co",
      address: { line1: "1 HQ Way", city: "Barcelona", state: "CT", zip: "08001", country: "ES" },
    });
    expect(put.statusCode).toBe(200);
    const { company: after } = put.json() as { company: { legalName: string } };
    expect(after.legalName).toBe("Renamed Co");

    const { auditEvents } = await import("@payroll/db");
    const audits = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "company.update"));
    expect(audits.length).toBe(1);
  });
});

describe("audit viewers", () => {
  it("returns paginated auth_events and audit_events", async () => {
    const auth = await adminReq("GET", "/api/admin/audit/auth-events?limit=5");
    expect(auth.statusCode).toBe(200);
    const authBody = auth.json() as { events: { event: string }[]; total: number; limit: number };
    expect(authBody.events.length).toBeGreaterThan(0);
    expect(authBody.events.length).toBeLessThanOrEqual(5);
    expect(authBody.total).toBeGreaterThan(0);

    const audit = await adminReq("GET", "/api/admin/audit/audit-events?limit=5&offset=0");
    expect(audit.statusCode).toBe(200);
    const auditBody = audit.json() as { events: { action: string }[]; total: number };
    expect(auditBody.events.length).toBeGreaterThan(0);
    expect(auditBody.total).toBeGreaterThan(0);

    // Employees are rejected.
    const forbidden = await t.app.inject({
      method: "GET",
      url: "/api/admin/audit/audit-events",
      headers: sessionHeader(employeeCookie),
    });
    expect(forbidden.statusCode).toBe(403);
  });
});

describe("my security", () => {
  it("reports 2FA status and remaining backup codes", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/api/my/security",
      headers: sessionHeader(employeeCookie),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { twoFactorEnabled: boolean; backupCodesRemaining: number };
    expect(body.twoFactorEnabled).toBe(true);
    expect(body.backupCodesRemaining).toBe(10); // onboarded, none used
  });

  it("regenerates backup codes (old batch invalidated, new one hashed at rest)", async () => {
    const { authTwoFactor } = await import("@payroll/db");
    const before = await t.db
      .select()
      .from(authTwoFactor)
      .where(eq(authTwoFactor.userId, employeeUserId))
      .limit(1);
    const res = await t.app.inject({
      method: "POST",
      url: "/api/my/backup-codes",
      headers: sessionHeader(employeeCookie),
    });
    expect(res.statusCode).toBe(200);
    const { backupCodes } = res.json() as { backupCodes: string[] };
    expect(backupCodes).toHaveLength(10);
    expect(backupCodes[0]).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);

    const after = await t.db
      .select()
      .from(authTwoFactor)
      .where(eq(authTwoFactor.userId, employeeUserId))
      .limit(1);
    expect(after[0]!.backupCodes).not.toBe(before[0]!.backupCodes); // old batch gone
    expect(after[0]!.backupCodes).not.toContain(backupCodes[0]!); // hashed, not plain
  });
});

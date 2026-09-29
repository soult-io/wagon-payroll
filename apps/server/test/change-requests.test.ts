/**
 * Change-request integration tests (spec 4, step 4). Real SQL via the PGlite
 * harness: submit → thread → approve/deny/withdraw, application semantics
 * (employees update vs append-only W-4), effective-date rule + audited
 * override, duplicate-pending 409, cross-tenant 404, and bank-details
 * encryption-at-rest + masked API responses.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import {
  auditEvents,
  changeRequestComments,
  changeRequests,
  company,
  compensation,
  emailOutbox,
  employees,
  seedDatabase,
  stateWithholdingElections,
  w4Elections,
  type SeedDb,
} from "@payroll/db";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";
import { decryptField } from "../src/crypto/field-encryption.js";
import { decryptAddress } from "../src/crypto/address-encryption.js";

let t: TestContext;
let adminCookie: string;
let adminId: string;
let employeeCookie: string;
let employeeUserId: string;
let employeeId: number;
let intruderCookie: string;

const ADDRESS_PAYLOAD = {
  line1: "1 Main St",
  city: "Madrid",
  state: "MD",
  zip: "28001",
  country: "ES",
};

function nextMonthStart(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 2; // next month
  const y = month > 12 ? year + 1 : year;
  const m = ((month - 1) % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

async function createEmployeeFor(userId: string | null, legalName: string): Promise<number> {
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({
      userId,
      companyId: companyRows[0]!.id,
      legalName,
      hireDate: "2024-01-01",
      address: { line1: "Old Street 1", city: "Oldtown", state: "OT", zip: "00001", country: "ES" },
    })
    .returning();
  return rows[0]!.id;
}

async function submit(cookie: string, body: Record<string, unknown>) {
  return t.app.inject({
    method: "POST",
    url: "/api/change-requests",
    headers: sessionHeader(cookie),
    payload: body,
  });
}

async function submitAddress(cookie: string, effectiveFrom = nextMonthStart()) {
  const res = await submit(cookie, {
    requestType: "address",
    payload: ADDRESS_PAYLOAD,
    effectiveFrom,
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { request: { publicId: string } }).request.publicId;
}

async function outboxFor(userId: string, eventType: string) {
  return t.db
    .select()
    .from(emailOutbox)
    .where(and(eq(emailOutbox.userId, userId), eq(emailOutbox.eventType, eventType)));
}

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);

  const admin = await inviteAndOnboard(t, { email: "cr-admin@example.com", role: "admin" });
  adminId = admin.userId;
  adminCookie = (await login(t, admin.email, TEST_PASSWORD)).sessionCookie;

  const employee = await inviteAndOnboard(t, {
    email: "cr-employee@example.com",
    role: "employee",
  });
  employeeUserId = employee.userId;
  employeeId = await createEmployeeFor(employee.userId, "Cr Employee");
  employeeCookie = (await login(t, employee.email, TEST_PASSWORD)).sessionCookie;

  const intruder = await inviteAndOnboard(t, {
    email: "cr-intruder@example.com",
    role: "employee",
  });
  await createEmployeeFor(intruder.userId, "Cr Intruder");
  intruderCookie = (await login(t, intruder.email, TEST_PASSWORD)).sessionCookie;
});

afterAll(async () => {
  await t.close();
});

describe("submit → comment → approve (address)", () => {
  it("applies in one transaction with audit before/after and notifications", async () => {
    const publicId = await submitAddress(employeeCookie);

    // submitted → all active admins (spec catalog).
    const submitted = await outboxFor(adminId, "change_request_submitted");
    expect(submitted.length).toBeGreaterThanOrEqual(1);
    expect(submitted[0]!.bodyHtml).toContain("Cr Employee");
    expect(submitted[0]!.bodyHtml).not.toContain("$"); // never amounts

    // Admin joins the thread.
    const comment = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/comments`,
      headers: sessionHeader(adminCookie),
      payload: { body: "Looks fine, approving." },
    });
    expect(comment.statusCode).toBe(201);

    const approve = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/approve`,
      headers: sessionHeader(adminCookie),
      payload: { note: "Welcome to the new place." },
    });
    expect(approve.statusCode).toBe(200);
    const { request } = approve.json() as { request: { status: string; appliedAt: string | null } };
    expect(request.status).toBe("approved");
    expect(request.appliedAt).not.toBeNull();

    // Target write: employees.address now holds the proposed value (PAY-21:
    // ciphertext at rest; decrypts to the payload).
    const [row] = await t.db.select().from(employees).where(eq(employees.id, employeeId));
    expect(decryptAddress(row!.address, t.config.encryptionKey)).toMatchObject(ADDRESS_PAYLOAD);

    // Audit: previous value in before (ciphertext), effective date in after.
    const audits = await t.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, "change_request.approve"), eq(auditEvents.entityId, publicId)),
      );
    expect(audits).toHaveLength(1);
    const before = audits[0]!.before as { address?: unknown } | null;
    expect(decryptAddress(before?.address, t.config.encryptionKey)).toMatchObject({
      line1: "Old Street 1",
    });
    expect(audits[0]!.actorId).toBe(adminId);

    // approved → that employee.
    const approvedMail = await outboxFor(employeeUserId, "change_request_approved");
    expect(approvedMail).toHaveLength(1);

    // Thread holds both the admin comment and the approval note.
    const detail = await t.app.inject({
      method: "GET",
      url: `/api/change-requests/${publicId}`,
      headers: sessionHeader(employeeCookie),
    });
    expect(detail.statusCode).toBe(200);
    const { comments } = detail.json() as { comments: { body: string; authorName: string }[] };
    expect(comments.map((c) => c.body)).toEqual([
      "Looks fine, approving.",
      "Welcome to the new place.",
    ]);
  });
});

describe("deny / withdraw / duplicate", () => {
  it("deny requires a reason, records it in the thread, notifies the employee", async () => {
    const publicId = await submitAddress(employeeCookie);

    const noReason = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/deny`,
      headers: sessionHeader(adminCookie),
      payload: { reason: "  " },
    });
    expect(noReason.statusCode).toBe(400);

    const deny = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/deny`,
      headers: sessionHeader(adminCookie),
      payload: { reason: "Incomplete documentation." },
    });
    expect(deny.statusCode).toBe(200);
    expect((deny.json() as { request: { status: string } }).request.status).toBe("denied");

    const thread = await t.db
      .select()
      .from(changeRequestComments)
      .where(eq(changeRequestComments.requestId, (await requestId(publicId))!));
    expect(thread.map((c) => c.body)).toContain("Incomplete documentation.");

    const deniedMail = await outboxFor(employeeUserId, "change_request_denied");
    expect(deniedMail).toHaveLength(1);

    // Address unchanged by the denial (still the value test 1 approved).
    const [row] = await t.db.select().from(employees).where(eq(employees.id, employeeId));
    expect(decryptAddress(row!.address, t.config.encryptionKey)).toMatchObject({
      line1: "1 Main St",
    });
  });

  it("withdraw: owner-only, pre-decision only", async () => {
    const publicId = await submitAddress(employeeCookie);

    // Non-owner employee gets 404 (no enumeration).
    const foreign = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/withdraw`,
      headers: sessionHeader(intruderCookie),
    });
    expect(foreign.statusCode).toBe(404);

    const own = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/withdraw`,
      headers: sessionHeader(employeeCookie),
    });
    expect(own.statusCode).toBe(200);
    expect((own.json() as { request: { status: string } }).request.status).toBe("withdrawn");

    // Post-decision withdraw is a conflict.
    const again = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/withdraw`,
      headers: sessionHeader(employeeCookie),
    });
    expect(again.statusCode).toBe(409);
  });

  it("one pending per (employee, type): second submit 409s until decided", async () => {
    const publicId = await submitAddress(employeeCookie);
    const dupe = await submit(employeeCookie, {
      requestType: "address",
      payload: ADDRESS_PAYLOAD,
      effectiveFrom: nextMonthStart(),
    });
    expect(dupe.statusCode).toBe(409);
    expect((dupe.json() as { error: string }).error).toBe("duplicate_pending");

    // After a decision the slot frees up.
    const deny = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/deny`,
      headers: sessionHeader(adminCookie),
      payload: { reason: "Freeing the slot." },
    });
    expect(deny.statusCode).toBe(200);
    const reopened = await submitAddress(employeeCookie);

    // Clean up: leave no pending address request for later tests.
    const cleanup = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${reopened}/deny`,
      headers: sessionHeader(adminCookie),
      payload: { reason: "Cleanup." },
    });
    expect(cleanup.statusCode).toBe(200);
  });
});

async function requestId(publicId: string): Promise<number | null> {
  const rows = await t.db
    .select({ id: changeRequests.id })
    .from(changeRequests)
    .where(eq(changeRequests.publicId, publicId))
    .limit(1);
  return rows[0]?.id ?? null;
}

describe("W-4 append-only", () => {
  it("approval INSERTs a new election and never updates history", async () => {
    await t.db.insert(w4Elections).values({
      employeeId,
      taxYear: 2024,
      filingStatus: "single",
      effectiveFrom: "2024-01-01",
      filedDate: "2024-01-01",
    });

    const effectiveFrom = nextMonthStart();
    const res = await submit(employeeCookie, {
      requestType: "w4",
      payload: {
        taxYear: 2026,
        filingStatus: "married_joint",
        effectiveFrom, // payload copy; top-level is authoritative
        // Filed today: next month's start is inside the replacement window
        // (Spec 26 (PAY-173) D3 step 4).
        filedDate: new Date().toISOString().slice(0, 10),
      },
      effectiveFrom,
    });
    expect(res.statusCode).toBe(201);
    const publicId = (res.json() as { request: { publicId: string } }).request.publicId;

    const approve = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/approve`,
      headers: sessionHeader(adminCookie),
      payload: {},
    });
    expect(approve.statusCode).toBe(200);

    const elections = await t.db
      .select()
      .from(w4Elections)
      .where(eq(w4Elections.employeeId, employeeId))
      .orderBy(desc(w4Elections.effectiveFrom));
    expect(elections).toHaveLength(2);
    expect(elections[0]).toMatchObject({
      taxYear: 2026,
      filingStatus: "married_joint",
      effectiveFrom,
    });
    // History row untouched.
    expect(elections[1]).toMatchObject({
      taxYear: 2024,
      filingStatus: "single",
      effectiveFrom: "2024-01-01",
    });

    // Profile shows the latest election as the W-4 summary.
    const profile = await t.app.inject({
      method: "GET",
      url: "/api/my/profile",
      headers: sessionHeader(employeeCookie),
    });
    expect(profile.statusCode).toBe(200);
    const body = profile.json() as { profile: { w4: { filingStatus: string } | null } };
    expect(body.profile.w4?.filingStatus).toBe("married_joint");
  });

  it("approval refuses a replacement W-4 whose effective date is past the lawful window (Spec 26 (PAY-173) D3 step 4)", async () => {
    const before = await t.db
      .select({ id: w4Elections.id })
      .from(w4Elections)
      .where(eq(w4Elections.employeeId, employeeId));
    // Replacement filed 2026-01-05: effective no later than 2026-02-01 (start
    // of the first monthly period ending on/after filed + 30 days). Next
    // month's start is later than that whenever this suite runs.
    const effectiveFrom = nextMonthStart();
    const res = await submit(employeeCookie, {
      requestType: "w4",
      payload: { taxYear: 2026, filingStatus: "single", effectiveFrom, filedDate: "2026-01-05" },
      effectiveFrom,
    });
    expect(res.statusCode).toBe(201);
    const publicId = (res.json() as { request: { publicId: string } }).request.publicId;

    const approve = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/approve`,
      headers: sessionHeader(adminCookie),
      payload: {},
    });
    expect({
      status: approve.statusCode,
      error: (approve.json() as { error?: string }).error,
    }).toEqual({ status: 400, error: "invalid_w4_effective_date" });

    const after = await t.db
      .select({ id: w4Elections.id })
      .from(w4Elections)
      .where(eq(w4Elections.employeeId, employeeId));
    expect(after).toHaveLength(before.length);
    const status = await t.db
      .select({ status: changeRequests.status })
      .from(changeRequests)
      .where(eq(changeRequests.publicId, publicId));
    expect(status[0]?.status).toBe("pending");

    // Clean up: leave no pending W-4 request for later tests.
    const cleanup = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/deny`,
      headers: sessionHeader(adminCookie),
      payload: { reason: "Cleanup." },
    });
    expect(cleanup.statusCode).toBe(200);
  });
});

describe("state election append-only (PAY-13 phase 2)", () => {
  it("approval INSERTs a new state_withholding_elections row and notifies", async () => {
    const effectiveFrom = nextMonthStart();
    const res = await submit(employeeCookie, {
      requestType: "state_election",
      payload: {
        stateCode: "IL",
        filingStatus: "married_joint",
        allowances: 2,
        additionalAllowances: 1,
        extraWithholding: 25,
        effectiveFrom, // payload copy; top-level is authoritative
        filedDate: "2026-01-05",
        note: "New IL-W-4",
      },
      effectiveFrom,
    });
    expect(res.statusCode).toBe(201);
    const publicId = (res.json() as { request: { publicId: string } }).request.publicId;

    const approve = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/approve`,
      headers: sessionHeader(adminCookie),
      payload: {},
    });
    expect(approve.statusCode).toBe(200);

    const elections = await t.db
      .select()
      .from(stateWithholdingElections)
      .where(eq(stateWithholdingElections.employeeId, employeeId))
      .orderBy(desc(stateWithholdingElections.effectiveFrom));
    expect(elections).toHaveLength(1);
    expect(elections[0]).toMatchObject({
      stateCode: "IL",
      filingStatus: "married_joint",
      allowances: 2,
      additionalAllowances: 1,
      exempt: false,
      effectiveFrom, // top-level wins over any payload copy
      filedDate: "2026-01-05",
      note: "New IL-W-4",
    });
    expect(Number(elections[0]!.extraWithholding)).toBe(25);

    // Audit trail records the approval against this request.
    const audits = await t.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, "change_request.approve"), eq(auditEvents.entityId, publicId)),
      );
    expect(audits).toHaveLength(1);

    // approved → that employee (outbox).
    const approvedMail = await outboxFor(employeeUserId, "change_request_approved");
    expect(approvedMail.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects an exempt election that also claims allowances or extra", async () => {
    const res = await submit(employeeCookie, {
      requestType: "state_election",
      payload: {
        stateCode: "CA",
        filingStatus: "single",
        allowances: 1,
        exempt: true,
        effectiveFrom: nextMonthStart(),
        filedDate: "2026-01-05",
      },
      effectiveFrom: nextMonthStart(),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("invalid_payload");
  });

  it("one pending per (employee, type): a second state_election submit 409s", async () => {
    const payload = {
      stateCode: "GA",
      filingStatus: "single",
      effectiveFrom: nextMonthStart(),
      filedDate: "2026-01-05",
    };
    const first = await submit(employeeCookie, {
      requestType: "state_election",
      payload,
      effectiveFrom: nextMonthStart(),
    });
    expect(first.statusCode).toBe(201);
    const publicId = (first.json() as { request: { publicId: string } }).request.publicId;

    const dupe = await submit(employeeCookie, {
      requestType: "state_election",
      payload: { ...payload, stateCode: "NY" },
      effectiveFrom: nextMonthStart(),
    });
    expect(dupe.statusCode).toBe(409);
    expect((dupe.json() as { error: string }).error).toBe("duplicate_pending");

    // Clean up: leave no pending state_election request behind.
    const cleanup = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/deny`,
      headers: sessionHeader(adminCookie),
      payload: { reason: "Cleanup." },
    });
    expect(cleanup.statusCode).toBe(200);
  });
});

describe("effective-date rule", () => {
  it("rejects dates before the next un-run period unless overridden (audited)", async () => {
    // Employee with a completed-run history: latest run 2025-06 → earliest 2025-07-01.
    const runEmployeeId = await createEmployeeFor(null, "Cr Runner");
    await t.db.insert(compensation).values({
      employeeId: runEmployeeId,
      periodAmount: "3000",
      frequency: "monthly",
      effectiveFrom: "2025-01-01",
    });
    const gen = await t.app.inject({
      method: "POST",
      url: "/api/admin/payroll-runs/generate",
      headers: sessionHeader(adminCookie),
      payload: { year: 2025, month: 6, employeeId: runEmployeeId },
    });
    expect(gen.statusCode).toBe(201);

    // The request must come from the run employee's account — use a direct
    // service-path request row instead: link a user to this employee.
    const runner = await inviteAndOnboard(t, { email: "cr-runner@example.com", role: "employee" });
    await t.db
      .update(employees)
      .set({ userId: runner.userId })
      .where(eq(employees.id, runEmployeeId));
    const runnerCookie = (await login(t, runner.email, TEST_PASSWORD)).sessionCookie;

    const res = await submit(runnerCookie, {
      requestType: "address",
      payload: ADDRESS_PAYLOAD,
      effectiveFrom: "2025-06-15", // precedes 2025-07-01
    });
    expect(res.statusCode).toBe(201);
    const publicId = (res.json() as { request: { publicId: string } }).request.publicId;

    const reject = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/approve`,
      headers: sessionHeader(adminCookie),
      payload: {},
    });
    expect(reject.statusCode).toBe(409);
    expect((reject.json() as { error: string }).error).toBe("effective_date");

    const override = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/approve`,
      headers: sessionHeader(adminCookie),
      payload: { effectiveFromOverride: "2025-06-15" },
    });
    expect(override.statusCode).toBe(200);

    // The override is recorded in the audit trail.
    const audits = await t.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, "change_request.approve"), eq(auditEvents.entityId, publicId)),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ effectiveFromOverride: "2025-06-15" });
  });
});

describe("cross-tenant isolation", () => {
  it("non-participant employees get 404 on detail, comments, and decisions", async () => {
    const publicId = await submitAddress(employeeCookie);

    const read = await t.app.inject({
      method: "GET",
      url: `/api/change-requests/${publicId}`,
      headers: sessionHeader(intruderCookie),
    });
    expect(read.statusCode).toBe(404);

    const comment = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/comments`,
      headers: sessionHeader(intruderCookie),
      payload: { body: "not my business" },
    });
    expect(comment.statusCode).toBe(404);

    const approve = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/approve`,
      headers: sessionHeader(intruderCookie),
      payload: {},
    });
    expect(approve.statusCode).toBe(403); // role guard, not a tenant leak

    // Admin can read; owner can read.
    const asAdmin = await t.app.inject({
      method: "GET",
      url: `/api/change-requests/${publicId}`,
      headers: sessionHeader(adminCookie),
    });
    expect(asAdmin.statusCode).toBe(200);
  });

  it("employee list shows only own requests; admin list shows all with names", async () => {
    const own = await t.app.inject({
      method: "GET",
      url: "/api/change-requests",
      headers: sessionHeader(intruderCookie),
    });
    const ownBody = own.json() as { requests: { employeeId: number }[] };
    expect(ownBody.requests.every((r) => r.employeeId !== employeeId)).toBe(true);

    const all = await t.app.inject({
      method: "GET",
      url: "/api/change-requests?status=pending",
      headers: sessionHeader(adminCookie),
    });
    const allBody = all.json() as { requests: { employeeName?: string; status: string }[] };
    expect(allBody.requests.length).toBeGreaterThan(0);
    expect(allBody.requests.every((r) => r.status === "pending")).toBe(true);
    expect(allBody.requests.some((r) => r.employeeName === "Cr Employee")).toBe(true);
  });
});

describe("bank details", () => {
  it("encrypts payloads at rest, masks in responses, applies encrypted", async () => {
    const res = await submit(employeeCookie, {
      requestType: "bank_details",
      payload: { routing: "021000021", account: "123456789012", type: "checking" },
      effectiveFrom: nextMonthStart(),
    });
    expect(res.statusCode).toBe(201);
    const { request } = res.json() as {
      request: { publicId: string; payload: { routing: string; account: string } };
    };
    // Submit response is masked, never ciphertext, never clear.
    expect(request.payload.account).toBe("••••9012");
    expect(request.payload.routing).toBe("••••0021");

    // At rest: the payload column holds encrypted values.
    const [stored] = await t.db
      .select()
      .from(changeRequests)
      .where(eq(changeRequests.publicId, request.publicId));
    const storedPayload = stored!.payload as { routing: string; account: string; type: string };
    expect(storedPayload.account.startsWith("enc:v1:")).toBe(true);
    expect(storedPayload.routing.startsWith("enc:v1:")).toBe(true);
    expect(decryptField(storedPayload.account, t.config.encryptionKey)).toBe("123456789012");

    // Detail view is masked too.
    const detail = await t.app.inject({
      method: "GET",
      url: `/api/change-requests/${request.publicId}`,
      headers: sessionHeader(adminCookie),
    });
    const detailBody = detail.json() as { request: { payload: { account: string } } };
    expect(detailBody.request.payload.account).toBe("••••9012");

    const approve = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${request.publicId}/approve`,
      headers: sessionHeader(adminCookie),
      payload: {},
    });
    expect(approve.statusCode).toBe(200);

    // Applied to employees.bank_details in encrypted form; audit holds the
    // encrypted before/after (never clear values).
    const [row] = await t.db.select().from(employees).where(eq(employees.id, employeeId));
    const bank = row!.bankDetails as { routing: string; account: string; type: string };
    expect(bank.type).toBe("checking");
    expect(decryptField(bank.account, t.config.encryptionKey)).toBe("123456789012");
    expect(decryptField(bank.routing, t.config.encryptionKey)).toBe("021000021");

    const audits = await t.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "change_request.approve"),
          eq(auditEvents.entityId, request.publicId),
        ),
      );
    expect(JSON.stringify(audits[0]!.after)).not.toContain("123456789012");

    // Profile masks the account (••••9012) and never returns ciphertext.
    const profile = await t.app.inject({
      method: "GET",
      url: "/api/my/profile",
      headers: sessionHeader(employeeCookie),
    });
    const body = profile.json() as {
      profile: {
        bankDetails: { accountMasked: string; routingMasked: string; type: string } | null;
      };
    };
    expect(body.profile.bankDetails).toMatchObject({
      accountMasked: "••••9012",
      routingMasked: "••••0021",
      type: "checking",
    });
  });

  it("rejects a routing number that fails the ABA checksum", async () => {
    const res = await submit(employeeCookie, {
      requestType: "bank_details",
      payload: { routing: "021000022", account: "123456789012", type: "checking" },
      effectiveFrom: nextMonthStart(),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("invalid_payload");
  });
});

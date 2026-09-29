/**
 * PAY-20 integration tests — effective-dated employee mailing address on W-2
 * box f. Real SQL via the PGlite harness; routes go through app.inject with
 * real sessions.
 *
 * Fixture: two account-linked W-2 employees, each with an issued 2025 run;
 * employee A also has a January 2026 run. Employee A is the effective-dating
 * fixture (mid-year mailing changes via admin direct edit, a mid-year
 * residential change via the change-request flow with an audited
 * effective-date override). Employee B exercises the mailing_address
 * change-request submit/approve/deny flow. PDF placement is asserted on the
 * 2025 packet — the only bundled IRS template year; the 2026 boundary goes
 * through w2InputFor assembly (with a `today` override past the January gate).
 *
 * Covers: as-of resolution incl. pre-first-change `before` recovery (present-
 * but-null means "unset back then"), the mailing → residential fallback chain
 * at Dec 31 of the tax year, exact AcroForm box-f placement, the admin PATCH
 * (writes an already-approved change_request + approve-shaped audit row), the
 * employee CR flow (submit/duplicate-pending/approve/deny + notification
 * label), and the export channel staying PII-free.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import {
  auditEvents,
  changeRequests,
  company,
  compensation,
  emailOutbox,
  employees,
  type payrollRuns,
  seedDatabase,
  type SeedDb,
} from "@payroll/db";
import { EVENT_TYPE } from "@payroll/notifications";
import { prepareW2EmployeePacket, w2FieldMap } from "@payroll/documents";
import {
  resolveEmployeeAddressAt,
  w2EmployeeAddressAt,
} from "../src/change-requests/address-history.js";
import { decryptAddress, isAddressEncrypted } from "../src/crypto/address-encryption.js";
import { w2InputFor } from "../src/filings/annual.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

const EXPORT_TOKEN = "test-export-token-mailing-address";

const RES_OLD = {
  line1: "10 Old Mill Rd",
  city: "Oldtown",
  state: "OT",
  zip: "00001",
  country: "US",
};
const RES_NEW = {
  line1: "20 New Mill Rd",
  city: "Newtown",
  state: "NT",
  zip: "00002",
  country: "US",
};
const MAIL_A = { line1: "PO Box 100", city: "Mailtown", state: "MT", zip: "10001", country: "US" };
const MAIL_B = { line1: "PO Box 200", city: "Mailtown", state: "MT", zip: "10002", country: "US" };
const MAIL_C = {
  line1: "300 Harbor Way",
  city: "Portville",
  state: "PV",
  zip: "30003",
  country: "US",
};

let t: TestContext;
let ADMIN: Record<string, string>;
let empA: { userId: string; email: string; employeeId: number };
let empB: { userId: string; email: string; employeeId: number };

function nextMonthStart(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 2; // next month
  const y = month > 12 ? year + 1 : year;
  const m = ((month - 1) % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

async function createEmployee(
  legalName: string,
  opts: { userId?: string; address?: Record<string, string> } = {},
): Promise<number> {
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({
      companyId: companyRows[0]?.id ?? 1,
      legalName,
      hireDate: "2025-01-01",
      ...(opts.userId ? { userId: opts.userId } : {}),
      ...(opts.address ? { address: opts.address } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("employee insert failed");
  return row.id;
}

async function addCompensation(employeeId: number): Promise<void> {
  await t.db.insert(compensation).values({
    employeeId,
    periodAmount: "3000",
    frequency: "monthly",
    effectiveFrom: "2025-01-01",
    effectiveTo: null,
  });
}

/** Generate → approve → issue a monthly run (the annual-forms.test.ts pattern). */
async function issueRun(employeeId: number, year: number, month: number) {
  const gen = await t.app.inject({
    method: "POST",
    url: "/api/admin/payroll-runs/generate",
    headers: ADMIN,
    payload: { year, month, employeeId },
  });
  expect(gen.statusCode, gen.body).toBe(201);
  const run = (gen.json() as { generated: (typeof payrollRuns.$inferSelect)[] }).generated[0];
  if (!run) throw new Error(`no run generated: ${gen.body}`);
  for (const action of ["approve", "issue"] as const) {
    const res = await t.app.inject({
      method: "POST",
      url: `/api/admin/payroll-runs/${run.publicId}/${action}`,
      headers: ADMIN,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
  }
}

/** One login per user per file — the auth rate limiter 429s burst sign-ins. */
const sessionCache = new Map<string, Record<string, string>>();
async function sessionFor(email: string): Promise<Record<string, string>> {
  const cached = sessionCache.get(email);
  if (cached) return cached;
  const header = sessionHeader((await login(t, email, TEST_PASSWORD)).sessionCookie);
  sessionCache.set(email, header);
  return header;
}

async function patchEmployee(employeeId: number, payload: unknown) {
  return t.app.inject({
    method: "PATCH",
    url: `/api/admin/employees/${employeeId}`,
    headers: ADMIN,
    payload,
  });
}

// History runs paid in 2025 are issued "in" late 2025: issuing a past pay
// date in another calendar year is refused (Spec 26 (PAY-173) D9).
const ISSUE_CLOCK = () => new Date("2025-12-31T12:00:00Z");

beforeAll(async () => {
  t = await createTestApp({ exportToken: EXPORT_TOKEN }, { clock: ISSUE_CLOCK });
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "mail-admin@test.dev", role: "admin" });
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);

  const userA = await inviteAndOnboard(t, { email: "mail-emp-a@test.dev", name: "Mail Emp A" });
  const aId = await createEmployee("Mail Emp A", { userId: userA.userId, address: RES_OLD });
  empA = { userId: userA.userId, email: userA.email, employeeId: aId };
  await addCompensation(aId);
  await issueRun(aId, 2025, 6);
  await issueRun(aId, 2026, 1);

  const userB = await inviteAndOnboard(t, { email: "mail-emp-b@test.dev", name: "Mail Emp B" });
  const bId = await createEmployee("Mail Emp B", { userId: userB.userId, address: RES_OLD });
  empB = { userId: userB.userId, email: userB.email, employeeId: bId };
  await addCompensation(bId);
  await issueRun(bId, 2025, 6);
}, 120_000);

afterAll(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------
// Effective-dated resolution (change-request history + audit `before`)
// ---------------------------------------------------------------------------

describe("effective-dated address resolution", () => {
  it("falls back to the current residential address when no history exists", async () => {
    await expect(
      resolveEmployeeAddressAt(
        t.db,
        empA.employeeId,
        "mailing",
        "2025-12-31",
        t.config.encryptionKey,
      ),
    ).resolves.toBeNull();
    await expect(
      resolveEmployeeAddressAt(
        t.db,
        empA.employeeId,
        "residential",
        "2025-12-31",
        t.config.encryptionKey,
      ),
    ).resolves.toEqual(RES_OLD);
    await expect(
      w2EmployeeAddressAt(t.db, empA.employeeId, 2025, t.config.encryptionKey),
    ).resolves.toEqual(RES_OLD);
  });

  it("admin direct edit writes an approved request + approve-shaped audit row", async () => {
    const res = await patchEmployee(empA.employeeId, {
      mailingAddress: MAIL_A,
      effectiveFrom: "2025-06-01",
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { employee: { mailingAddress: unknown } };
    expect(body.employee.mailingAddress).toEqual(MAIL_A);

    const requests = await t.db
      .select()
      .from(changeRequests)
      .where(
        and(
          eq(changeRequests.employeeId, empA.employeeId),
          eq(changeRequests.requestType, "mailing_address"),
        ),
      );
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.status).toBe("approved");
    expect(request.effectiveFrom).toBe("2025-06-01");
    expect(request.appliedAt).not.toBeNull();
    expect(request.decidedBy).not.toBeNull();

    // Same audit shape as change_request.approve — the resolver reads it.
    const audit = await t.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "change_request.approve"),
          eq(auditEvents.entity, "change_request"),
          eq(auditEvents.entityId, request.publicId),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.before).toEqual({ mailingAddress: null });
    // PAY-21: audit after.applied carries the stored (ciphertext) form.
    const after = audit[0]?.after as { applied: unknown; effectiveFrom?: string } | null;
    expect(after?.effectiveFrom).toBe("2025-06-01");
    expect(isAddressEncrypted(after?.applied)).toBe(true);
    expect(decryptAddress(after?.applied, t.config.encryptionKey)).toEqual(MAIL_A);
  });

  it("resolves around the effective date; pre-first-change recovers null (was unset)", async () => {
    // Before the first mailing change the field was UNSET — a present-but-null
    // audit `before` is authoritative, not a fallback to the current value.
    await expect(
      resolveEmployeeAddressAt(
        t.db,
        empA.employeeId,
        "mailing",
        "2025-05-31",
        t.config.encryptionKey,
      ),
    ).resolves.toBeNull();
    await expect(
      resolveEmployeeAddressAt(
        t.db,
        empA.employeeId,
        "mailing",
        "2025-06-01",
        t.config.encryptionKey,
      ),
    ).resolves.toEqual(MAIL_A);
    // 2024 box f: mailing unset back then → residential fallback.
    await expect(
      w2EmployeeAddressAt(t.db, empA.employeeId, 2024, t.config.encryptionKey),
    ).resolves.toEqual(RES_OLD);
    await expect(
      w2EmployeeAddressAt(t.db, empA.employeeId, 2025, t.config.encryptionKey),
    ).resolves.toEqual(MAIL_A);
  });

  it("a second change effective-dates over the first", async () => {
    const res = await patchEmployee(empA.employeeId, {
      mailingAddress: MAIL_B,
      effectiveFrom: "2025-09-01",
    });
    expect(res.statusCode, res.body).toBe(200);
    await expect(
      resolveEmployeeAddressAt(
        t.db,
        empA.employeeId,
        "mailing",
        "2025-08-31",
        t.config.encryptionKey,
      ),
    ).resolves.toEqual(MAIL_A);
    await expect(
      resolveEmployeeAddressAt(
        t.db,
        empA.employeeId,
        "mailing",
        "2025-09-01",
        t.config.encryptionKey,
      ),
    ).resolves.toEqual(MAIL_B);
    await expect(
      w2EmployeeAddressAt(t.db, empA.employeeId, 2025, t.config.encryptionKey),
    ).resolves.toEqual(MAIL_B);
  });

  it("residential history resolves as-of too (CR approve with audited override)", async () => {
    const session = await sessionFor(empA.email);
    const submitted = await t.app.inject({
      method: "POST",
      url: "/api/change-requests",
      headers: session,
      payload: { requestType: "address", payload: RES_NEW, effectiveFrom: nextMonthStart() },
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const { publicId } = (submitted.json() as { request: { publicId: string } }).request;

    // Mid-year 2025 — precedes the next un-run period, so an explicit audited
    // override is required (spec 4 effective-date rule).
    const approved = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/approve`,
      headers: ADMIN,
      payload: { effectiveFromOverride: "2025-03-01" },
    });
    expect(approved.statusCode, approved.body).toBe(200);

    // The row carries the APPLIED (overridden) effective date — the history
    // source for as-of resolution.
    const rows = await t.db
      .select()
      .from(changeRequests)
      .where(eq(changeRequests.publicId, publicId));
    expect(rows[0]?.effectiveFrom).toBe("2025-03-01");

    await expect(
      resolveEmployeeAddressAt(
        t.db,
        empA.employeeId,
        "residential",
        "2025-02-28",
        t.config.encryptionKey,
      ),
    ).resolves.toEqual(RES_OLD);
    await expect(
      resolveEmployeeAddressAt(
        t.db,
        empA.employeeId,
        "residential",
        "2025-03-01",
        t.config.encryptionKey,
      ),
    ).resolves.toEqual(RES_NEW);
    // 2024 box f still resolves the OLD residential (pre-first-change `before`).
    await expect(
      w2EmployeeAddressAt(t.db, empA.employeeId, 2024, t.config.encryptionKey),
    ).resolves.toEqual(RES_OLD);
    // 2025: mailing wins over residential.
    await expect(
      w2EmployeeAddressAt(t.db, empA.employeeId, 2025, t.config.encryptionKey),
    ).resolves.toEqual(MAIL_B);
  });
});

// ---------------------------------------------------------------------------
// W-2 box f — year boundaries + exact AcroForm placement
// ---------------------------------------------------------------------------

describe("W-2 box f", () => {
  it("uses the address effective Dec 31 of each tax year", async () => {
    // A third mailing change lands mid-2026 (admin direct edit, backfilled).
    const res = await patchEmployee(empA.employeeId, {
      mailingAddress: MAIL_C,
      effectiveFrom: "2026-06-01",
    });
    expect(res.statusCode, res.body).toBe(200);

    const input2025 = await w2InputFor({ db: t.db, config: t.config }, empA.employeeId, 2025);
    expect(input2025.employee.address).toMatchObject({ line1: MAIL_B.line1 });

    const input2026 = await w2InputFor({ db: t.db, config: t.config }, empA.employeeId, 2026, {
      today: "2027-01-01",
    });
    expect(input2026.employee.address).toMatchObject({ line1: MAIL_C.line1 });
  });

  it("places the resolved mailing address in box f of every employee copy", async () => {
    const input = await w2InputFor({ db: t.db, config: t.config }, empA.employeeId, 2025);
    const doc = await prepareW2EmployeePacket(input);
    const form = doc.getForm();
    for (const copy of ["CopyB", "CopyC", "Copy2"] as const) {
      const text = form.getTextField(w2FieldMap(copy).employeeAddress).getText() ?? "";
      expect(text).toContain(MAIL_B.line1);
      expect(text).toContain("Mailtown, MT 10002");
      expect(text).not.toContain("Old Mill");
      expect(text).not.toContain("New Mill");
      expect(text).not.toContain("Harbor");
    }
  });

  it("places the residential fallback in box f when no mailing address applies", async () => {
    // Employee B has a mailing change PENDING-but-unapproved at this point in
    // the file (nothing approved) — box f falls back to the residential
    // address effective at 2025-12-31.
    const input = await w2InputFor({ db: t.db, config: t.config }, empB.employeeId, 2025);
    expect(input.employee.address).toMatchObject({ line1: RES_OLD.line1 });

    const doc = await prepareW2EmployeePacket(input);
    const text = doc.getForm().getTextField(w2FieldMap("CopyB").employeeAddress).getText() ?? "";
    expect(text).toContain(RES_OLD.line1);
    expect(text).not.toContain("PO Box");
  });
});

// ---------------------------------------------------------------------------
// Change-request flow — mailing_address (employee B)
// ---------------------------------------------------------------------------

describe("mailing_address change requests", () => {
  it("submits, blocks a duplicate pending, approves and applies", async () => {
    const session = await sessionFor(empB.email);
    const submitted = await t.app.inject({
      method: "POST",
      url: "/api/change-requests",
      headers: session,
      payload: { requestType: "mailing_address", payload: MAIL_A, effectiveFrom: nextMonthStart() },
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const request = (submitted.json() as { request: { publicId: string; requestType: string } })
      .request;
    expect(request.requestType).toBe("mailing_address");

    // One pending request per (employee, type) — independent of `address`.
    const duplicate = await t.app.inject({
      method: "POST",
      url: "/api/change-requests",
      headers: session,
      payload: { requestType: "mailing_address", payload: MAIL_B, effectiveFrom: nextMonthStart() },
    });
    expect(duplicate.statusCode).toBe(409);

    const approved = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${request.publicId}/approve`,
      headers: ADMIN,
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);

    const rows = await t.db.select().from(employees).where(eq(employees.id, empB.employeeId));
    // PAY-21: ciphertext at rest, decrypts to the applied address.
    expect(isAddressEncrypted(rows[0]?.mailingAddress)).toBe(true);
    expect(decryptAddress(rows[0]?.mailingAddress, t.config.encryptionKey)).toEqual(MAIL_A);

    const audit = await t.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "change_request.approve"),
          eq(auditEvents.entityId, request.publicId),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.before).toEqual({ mailingAddress: null });
    const applied = (audit[0]?.after as { applied: unknown } | null)?.applied;
    expect(isAddressEncrypted(applied)).toBe(true);
    expect(decryptAddress(applied, t.config.encryptionKey)).toEqual(MAIL_A);

    // The approval email uses the "mailing address" label.
    const mails = await t.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.eventType, EVENT_TYPE.changeRequestApproved))
      .orderBy(desc(emailOutbox.id));
    expect(mails[0]?.bodyHtml).toContain("mailing address");
  });

  it("denies with a reason and leaves the address untouched", async () => {
    const session = await sessionFor(empB.email);
    const submitted = await t.app.inject({
      method: "POST",
      url: "/api/change-requests",
      headers: session,
      payload: { requestType: "mailing_address", payload: MAIL_B, effectiveFrom: nextMonthStart() },
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const { publicId } = (submitted.json() as { request: { publicId: string } }).request;

    const denied = await t.app.inject({
      method: "POST",
      url: `/api/change-requests/${publicId}/deny`,
      headers: ADMIN,
      payload: { reason: "PO box not deliverable" },
    });
    expect(denied.statusCode, denied.body).toBe(200);

    const rows = await t.db.select().from(employees).where(eq(employees.id, empB.employeeId));
    // Unchanged from the approved request — still the same ciphertext value.
    expect(decryptAddress(rows[0]?.mailingAddress, t.config.encryptionKey)).toEqual(MAIL_A);
  });
});

// ---------------------------------------------------------------------------
// Admin PATCH validation + export stays PII-free
// ---------------------------------------------------------------------------

describe("admin PATCH + export", () => {
  it("rejects an empty PATCH and an invalid mailing address", async () => {
    const empty = await patchEmployee(empB.employeeId, {});
    expect(empty.statusCode).toBe(400);

    const invalid = await patchEmployee(empB.employeeId, {
      mailingAddress: { ...MAIL_B, country: "USA" },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("defaults effective_from to today when omitted", async () => {
    const res = await patchEmployee(empB.employeeId, { mailingAddress: MAIL_B });
    expect(res.statusCode, res.body).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    const requests = await t.db
      .select()
      .from(changeRequests)
      .where(
        and(
          eq(changeRequests.employeeId, empB.employeeId),
          eq(changeRequests.requestType, "mailing_address"),
          eq(changeRequests.status, "approved"),
        ),
      )
      .orderBy(desc(changeRequests.id));
    expect(requests[0]?.effectiveFrom).toBe(today);
  });

  it("the export channel never carries addresses", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/api/export/payroll-runs?from=2025-01-01&to=2026-12-31",
      headers: { authorization: `Bearer ${EXPORT_TOKEN}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const raw = JSON.stringify(res.json());
    for (const marker of ["Old Mill", "New Mill", "PO Box", "Mailtown", "mailingAddress"]) {
      expect(raw).not.toContain(marker);
    }
  });
});

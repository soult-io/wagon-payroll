/**
 * Change-request application semantics (spec 4 — the correctness core).
 *
 * One transaction per decision: change_requests.status → target write →
 * audit_events → email_outbox. w4 = append-only INSERT with effective_from;
 * address/bank_details/legal_name = employees update with before-values in
 * audit. effective_from must be ≥ the first day of the next un-run pay period
 * unless the admin explicitly overrides (override recorded in audit).
 */

import { and, desc, eq, ne } from "drizzle-orm";
import {
  auditEvents,
  authUser,
  changeRequestComments,
  changeRequests,
  emailOutbox,
  employees,
  payrollRuns,
  stateWithholdingElections,
  w4Elections,
} from "@payroll/db";
import {
  changeRequestApproved,
  changeRequestDenied,
  changeRequestSubmitted,
  EVENT_TYPE,
} from "@payroll/notifications";
import type { BankDetailsPayload, ChangeRequestType, TaxIdPayload } from "@payroll/shared";
import type { Db } from "../db.js";
import { isUniqueViolation } from "../db.js";
import type { AppConfig } from "../config.js";
import { encryptField, isEncrypted, maskLast4 } from "../crypto/field-encryption.js";
import { addressForStorage } from "../crypto/address-encryption.js";
import { templateContext } from "../notify/outbox.js";
import type { DbLike } from "../payroll/resolve.js";
import { clampToW4Window, validateW4Dates } from "../payroll/w4-dates.js";

export class ChangeRequestError extends Error {
  constructor(
    public code:
      | "not_found"
      | "not_pending"
      | "duplicate_pending"
      | "forbidden"
      | "effective_date"
      | "reason_required"
      // Spec 26 (PAY-173) D3 step 4
      | "invalid_w4_effective_date",
    message: string,
    /** Extra response fields (dates only — never amounts or PII). */
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type ChangeRequestRow = typeof changeRequests.$inferSelect;

interface Deps {
  db: Db;
  config: AppConfig;
}

/** All active admins (recipients of submitted/notifications per spec catalog). */
async function activeAdmins(db: DbLike): Promise<{ id: string }[]> {
  return db
    .select({ id: authUser.id })
    .from(authUser)
    .where(and(eq(authUser.role, "admin"), ne(authUser.banned, true)));
}

/**
 * First day of the next un-run pay period for an employee: the month after
 * their latest non-void run, or the current month when nothing has run.
 */
export async function nextUnrunPeriodStart(db: DbLike, employeeId: number): Promise<string> {
  const rows = await db
    .select({ periodStart: payrollRuns.periodStart })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.employeeId, employeeId), ne(payrollRuns.status, "void")))
    .orderBy(desc(payrollRuns.periodStart))
    .limit(1);
  const base = rows[0]?.periodStart;
  const date = base ? new Date(`${base}T00:00:00Z`) : new Date();
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + (base ? 2 : 1); // next month if a run exists
  const y = month > 12 ? year + 1 : year;
  const m = ((month - 1) % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/** Employee row for a user id (employee-self scoping). */
export async function employeeForUser(db: DbLike, userId: string) {
  const rows = await db.select().from(employees).where(eq(employees.userId, userId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Stored form of a payload: sensitive identifiers are encrypted at rest in
 * the payload column too, exactly like their target fields (spec 4
 * "Sensitive-data handling" + spec 11 for tax_id). encrypt() is idempotent
 * on already-encrypted values so legacy plaintext payloads still land
 * encrypted on the target field at approval time. PAY-21: address payloads
 * are whole-payload encrypted (the jsonb payload column holds the ciphertext
 * string), so the return type widens beyond a plain object.
 */
export function payloadForStorage(
  requestType: ChangeRequestType,
  payload: Record<string, unknown>,
  key: string,
): unknown {
  const enc = (v: string) => (isEncrypted(v) ? v : encryptField(v, key));
  if (requestType === "bank_details") {
    const bank = payload as unknown as BankDetailsPayload;
    return { ...bank, routing: enc(bank.routing), account: enc(bank.account) };
  }
  if (requestType === "tax_id") {
    const tin = payload as unknown as TaxIdPayload;
    return { taxId: enc(tin.taxId) };
  }
  if (requestType === "address" || requestType === "mailing_address") {
    return addressForStorage(payload, key);
  }
  return payload;
}

/**
 * Submit a request. The payload is already validated against the shared Zod
 * schema for its type. The partial unique index enforces one pending request
 * per (employee, type) — a violation maps to a clean conflict.
 */
export async function submitRequest(
  deps: Deps,
  input: {
    employeeId: number;
    employeeName: string;
    requestType: ChangeRequestType;
    payload: Record<string, unknown>;
    effectiveFrom: string;
  },
): Promise<ChangeRequestRow> {
  const { db, config } = deps;
  const payload = payloadForStorage(input.requestType, input.payload, config.encryptionKey);
  let row: ChangeRequestRow;
  try {
    const inserted = await db
      .insert(changeRequests)
      .values({
        employeeId: input.employeeId,
        requestType: input.requestType,
        payload,
        effectiveFrom: input.effectiveFrom,
      })
      .returning();
    row = inserted[0]!;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ChangeRequestError(
        "duplicate_pending",
        `a pending ${input.requestType} request already exists for this employee`,
      );
    }
    throw err;
  }

  // submitted → all admins (outbox; send failure can never roll this back).
  const ctx = await templateContext(db, config);
  const rendered = changeRequestSubmitted(ctx, {
    employeeName: input.employeeName,
    requestType: input.requestType,
  });
  for (const admin of await activeAdmins(db)) {
    await db.insert(emailOutbox).values({
      userId: admin.id,
      eventType: EVENT_TYPE.changeRequestSubmitted,
      subject: rendered.subject,
      bodyHtml: rendered.html,
    });
  }
  return row;
}

/** Comment thread append (participant or admin — authorization in the route). */
export async function addComment(
  deps: Deps,
  input: { requestId: number; authorId: string; body: string },
): Promise<void> {
  await deps.db.insert(changeRequestComments).values({
    requestId: input.requestId,
    authorId: input.authorId,
    body: input.body,
  });
}

/**
 * The effective date a W-4 approval applies (Spec 26 (PAY-173) D3 step 4).
 * - explicit override: must be inside the lawful window, else 400
 *   `invalid_w4_effective_date` with the window;
 * - no override: the requested date, clamped to the nearest allowed date. If
 *   that precedes the next un-run pay period, 409 `effective_date` proposing
 *   the nearest allowed date to that period start (never past the window).
 */
async function w4ApprovalDate(
  db: DbLike,
  request: ChangeRequestRow,
  override: string | undefined,
  nextUnrun: string,
): Promise<string> {
  const payload = request.payload as Record<string, unknown>;
  const check = await validateW4Dates(db, request.employeeId, {
    taxYear: Number(payload["taxYear"]),
    filedDate: String(payload["filedDate"]),
    effectiveFrom: override ?? request.effectiveFrom,
  });
  const window = check.window;
  if (!window || (override && check.violation)) {
    throw new ChangeRequestError(
      "invalid_w4_effective_date",
      check.violation ?? "invalid W-4 dates",
      { window },
    );
  }
  if (override) return override;
  const clamped = clampToW4Window(request.effectiveFrom, window);
  if (clamped < nextUnrun) {
    const proposed = clampToW4Window(nextUnrun, window);
    throw new ChangeRequestError(
      "effective_date",
      `effective_from ${clamped} precedes the next un-run pay period (${nextUnrun}); pass an explicit override to approve anyway — proposed ${proposed}, inside the W-4 window ${window.earliest ?? "(no lower bound)"} to ${window.latest}`,
      { window, proposedEffectiveFrom: proposed },
    );
  }
  return clamped;
}

/**
 * Approve + apply, one transaction: target write → status → audit → outbox.
 */
export async function approveRequest(
  deps: Deps,
  input: {
    publicId: string;
    adminId: string;
    note?: string | undefined;
    effectiveFromOverride?: string | undefined;
  },
): Promise<ChangeRequestRow> {
  const { db, config } = deps;
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: single atomic transaction body; extraction would fragment the flow
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(changeRequests)
      .where(eq(changeRequests.publicId, input.publicId))
      .limit(1);
    const request = rows[0];
    if (!request) throw new ChangeRequestError("not_found", "request not found");
    if (request.status !== "pending") {
      throw new ChangeRequestError("not_pending", `request is '${request.status}', not pending`);
    }

    const earliest = await nextUnrunPeriodStart(tx as DbLike, request.employeeId);
    const effectiveFrom =
      request.requestType === "w4"
        ? await w4ApprovalDate(tx as DbLike, request, input.effectiveFromOverride, earliest)
        : (input.effectiveFromOverride ?? request.effectiveFrom);
    if (effectiveFrom < earliest && !input.effectiveFromOverride && request.requestType !== "w4") {
      throw new ChangeRequestError(
        "effective_date",
        `effective_from ${effectiveFrom} precedes the next un-run pay period (${earliest}); pass an explicit override to approve anyway`,
      );
    }

    const employeeRows = await tx
      .select()
      .from(employees)
      .where(eq(employees.id, request.employeeId))
      .limit(1);
    const employee = employeeRows[0]!;
    const payload = request.payload as Record<string, unknown>;
    let before: unknown = null;
    let after: unknown = payload;

    switch (request.requestType) {
      case "address": {
        before = { address: employee.address }; // stored form (encrypted) — safe in audit
        const stored = addressForStorage(payload, config.encryptionKey);
        after = stored;
        await tx
          .update(employees)
          .set({ address: stored, updatedAt: new Date() })
          .where(eq(employees.id, employee.id));
        break;
      }
      case "mailing_address": {
        before = { mailingAddress: employee.mailingAddress }; // stored form (encrypted)
        const stored = addressForStorage(payload, config.encryptionKey);
        after = stored;
        await tx
          .update(employees)
          .set({ mailingAddress: stored, updatedAt: new Date() })
          .where(eq(employees.id, employee.id));
        break;
      }
      case "bank_details": {
        before = { bankDetails: employee.bankDetails }; // stored form (encrypted) — safe in audit
        const encrypted = payloadForStorage("bank_details", payload, config.encryptionKey);
        after = encrypted;
        await tx
          .update(employees)
          .set({ bankDetails: encrypted, updatedAt: new Date() })
          .where(eq(employees.id, employee.id));
        break;
      }
      case "tax_id": {
        // Spec 11 (D20b): audit holds MASKED before/after only; the applied
        // value is the ciphertext from the payload (re-encrypted idempotently
        // for legacy plaintext payloads).
        const storedTaxId = payloadForStorage("tax_id", payload, config.encryptionKey) as {
          taxId: string;
        };
        const encrypted = String(storedTaxId.taxId);
        before = { taxIdMasked: maskLast4(employee.taxId, config.encryptionKey) };
        after = { taxIdMasked: maskLast4(encrypted, config.encryptionKey) };
        await tx
          .update(employees)
          .set({ taxId: encrypted, updatedAt: new Date() })
          .where(eq(employees.id, employee.id));
        break;
      }
      case "legal_name": {
        before = { legalName: employee.legalName };
        await tx
          .update(employees)
          .set({ legalName: String(payload["legalName"]), updatedAt: new Date() })
          .where(eq(employees.id, employee.id));
        break;
      }
      case "w4": {
        // effectiveFrom is inside the lawful window (w4ApprovalDate).
        // Append-only: INSERT a new election, never UPDATE history.
        const inserted = await tx
          .insert(w4Elections)
          .values({
            employeeId: employee.id,
            taxYear: Number(payload["taxYear"]),
            filingStatus: String(payload["filingStatus"] ?? "single"),
            federalExempt: Boolean(payload["federalExempt"] ?? false),
            multipleJobs: Boolean(payload["multipleJobs"] ?? false),
            dependentsAmount: String(payload["dependentsAmount"] ?? "0"),
            otherIncome: String(payload["otherIncome"] ?? "0"),
            deductionsAmount: String(payload["deductionsAmount"] ?? "0"),
            extraWithholding: String(payload["extraWithholding"] ?? "0"),
            effectiveFrom,
            filedDate: String(payload["filedDate"]),
            note: String(payload["note"] ?? ""),
          })
          .returning();
        after = inserted[0];
        break;
      }
      case "state_election": {
        // Append-only like w4: INSERT a new state election, never UPDATE
        // history. Mirrors the admin state-elections route shape (PAY-13).
        const inserted = await tx
          .insert(stateWithholdingElections)
          .values({
            employeeId: employee.id,
            stateCode: String(payload["stateCode"]),
            filingStatus: String(payload["filingStatus"] ?? "single"),
            allowances: Number(payload["allowances"] ?? 0),
            additionalAllowances: Number(payload["additionalAllowances"] ?? 0),
            extraWithholding: String(payload["extraWithholding"] ?? "0"),
            exempt: Boolean(payload["exempt"] ?? false),
            effectiveFrom,
            filedDate: String(payload["filedDate"]),
            note: String(payload["note"] ?? ""),
          })
          .returning();
        after = inserted[0];
        break;
      }
      default:
        throw new ChangeRequestError("not_found", `unknown request type ${request.requestType}`);
    }

    const now = new Date();
    const updated = await tx
      .update(changeRequests)
      .set({
        status: "approved",
        decidedBy: input.adminId,
        decidedAt: now,
        appliedAt: now,
        // The row carries the APPLIED effective date (the override when one was
        // given) — it is the effective-dated history source for address
        // resolution (PAY-20). The originally requested date is preserved in
        // the audit event below.
        effectiveFrom,
        updatedAt: now,
      })
      .where(eq(changeRequests.id, request.id))
      .returning();

    await tx.insert(auditEvents).values({
      actorId: input.adminId,
      action: "change_request.approve",
      entity: "change_request",
      entityId: request.publicId,
      before,
      after: {
        applied: after,
        effectiveFrom,
        ...(input.effectiveFromOverride
          ? {
              effectiveFromOverride: input.effectiveFromOverride,
              requestedEffectiveFrom: request.effectiveFrom,
            }
          : effectiveFrom !== request.effectiveFrom
            ? { requestedEffectiveFrom: request.effectiveFrom } // clamped to the W-4 window
            : {}),
      },
    });

    if (employee.userId) {
      const ctx = await templateContext(tx as DbLike, config);
      const rendered = changeRequestApproved(ctx, {
        requestType: request.requestType,
        effectiveFrom,
      });
      await tx.insert(emailOutbox).values({
        userId: employee.userId,
        eventType: EVENT_TYPE.changeRequestApproved,
        subject: rendered.subject,
        bodyHtml: rendered.html,
      });
    }

    if (input.note?.trim()) {
      await tx.insert(changeRequestComments).values({
        requestId: request.id,
        authorId: input.adminId,
        body: input.note.trim(),
      });
    }
    return updated[0]!;
  });
}

/** Deny: reason REQUIRED and recorded in the thread (spec state machine). */
export async function denyRequest(
  deps: Deps,
  input: { publicId: string; adminId: string; reason: string },
): Promise<ChangeRequestRow> {
  const { db, config } = deps;
  if (!input.reason.trim()) {
    throw new ChangeRequestError("reason_required", "denying a request requires a reason");
  }
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(changeRequests)
      .where(eq(changeRequests.publicId, input.publicId))
      .limit(1);
    const request = rows[0];
    if (!request) throw new ChangeRequestError("not_found", "request not found");
    if (request.status !== "pending") {
      throw new ChangeRequestError("not_pending", `request is '${request.status}', not pending`);
    }

    await tx.insert(changeRequestComments).values({
      requestId: request.id,
      authorId: input.adminId,
      body: input.reason.trim(),
    });
    const now = new Date();
    const updated = await tx
      .update(changeRequests)
      .set({ status: "denied", decidedBy: input.adminId, decidedAt: now, updatedAt: now })
      .where(eq(changeRequests.id, request.id))
      .returning();

    await tx.insert(auditEvents).values({
      actorId: input.adminId,
      action: "change_request.deny",
      entity: "change_request",
      entityId: request.publicId,
      before: { status: "pending" },
      after: { status: "denied" },
    });

    const employeeRows = await tx
      .select()
      .from(employees)
      .where(eq(employees.id, request.employeeId))
      .limit(1);
    const employee = employeeRows[0];
    if (employee?.userId) {
      const ctx = await templateContext(tx as DbLike, config);
      const rendered = changeRequestDenied(ctx, { requestType: request.requestType });
      await tx.insert(emailOutbox).values({
        userId: employee.userId,
        eventType: EVENT_TYPE.changeRequestDenied,
        subject: rendered.subject,
        bodyHtml: rendered.html,
      });
    }
    return updated[0]!;
  });
}

/** Withdraw: employee owner, pre-decision only. */
export async function withdrawRequest(
  deps: Deps,
  input: { publicId: string; userId: string },
): Promise<ChangeRequestRow> {
  const { db } = deps;
  const rows = await db
    .select()
    .from(changeRequests)
    .where(eq(changeRequests.publicId, input.publicId))
    .limit(1);
  const request = rows[0];
  if (!request) throw new ChangeRequestError("not_found", "request not found");
  const employee = await employeeForUser(db, input.userId);
  if (!employee || employee.id !== request.employeeId) {
    throw new ChangeRequestError("forbidden", "not your request");
  }
  if (request.status !== "pending") {
    throw new ChangeRequestError("not_pending", `request is '${request.status}', not pending`);
  }
  const updated = await db
    .update(changeRequests)
    .set({ status: "withdrawn", updatedAt: new Date() })
    .where(eq(changeRequests.id, request.id))
    .returning();
  return updated[0]!;
}

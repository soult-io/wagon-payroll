/**
 * Effective-dated address resolution (PAY-20).
 *
 * employees.address / employees.mailing_address hold only the CURRENT value;
 * history lives in approved change_requests (one row per applied change, with
 * effective_from) plus the pre-change snapshot in the approve audit event's
 * `before`. Admin direct edits write the same already-approved change_request
 * row shape, so this single history source covers both flows.
 *
 * Resolution rule for an as-of date:
 *  - the payload of the latest approved change with effective_from <= asOf, or
 *  - when asOf precedes the first recorded change, that first change's audit
 *    `before` value (the address in effect before it), or
 *  - the current employees field when no history exists (or the audit row is
 *    missing — defensive fallback).
 */

import { and, asc, desc, eq } from "drizzle-orm";
import { auditEvents, changeRequests, employees } from "@payroll/db";
import type { AddressPayload } from "@payroll/shared";
import { decryptAddress } from "../crypto/address-encryption.js";
import type { DbLike } from "../payroll/resolve.js";

export type AddressKind = "residential" | "mailing";

/**
 * Spec 24 (PAY-116) PR-4: a stored address (current field, history payload
 * or audit snapshot) failed to decrypt. Fixed message; never carries the
 * value or a cause.
 */
export class AddressUnreadableError extends Error {
  constructor() {
    super("address could not be decrypted");
    this.name = "AddressUnreadableError";
  }
}

/** decryptAddress, with a decrypt failure as AddressUnreadableError. */
function readAddress(value: unknown, key: string): AddressPayload | null {
  try {
    return decryptAddress(value, key);
  } catch {
    throw new AddressUnreadableError();
  }
}

const KIND_TO_REQUEST_TYPE = {
  residential: "address",
  mailing: "mailing_address",
} as const;

const KIND_TO_BEFORE_KEY = {
  residential: "address",
  mailing: "mailingAddress",
} as const;

/**
 * The employee's address of `kind` in effect on `asOf` (YYYY-MM-DD), or null.
 * AddressUnreadableError when a value it reads does not decrypt.
 */
export async function resolveEmployeeAddressAt(
  db: DbLike,
  employeeId: number,
  kind: AddressKind,
  asOf: string,
  key: string,
): Promise<AddressPayload | null> {
  const employeeRows = await db
    .select({ address: employees.address, mailingAddress: employees.mailingAddress })
    .from(employees)
    .where(eq(employees.id, employeeId))
    .limit(1);
  const employee = employeeRows[0];
  if (!employee) return null;
  // PAY-21: every source (current field, history payload, audit before) is
  // ciphertext at rest; decryptAddress tolerates plaintext legacy rows.
  // Spec 24 (PAY-116) PR-4: the current field is decrypted only when it
  // decides the value, so an unreadable current value never holds a W-2
  // whose box f comes from the history.
  const current = () =>
    readAddress(kind === "mailing" ? employee.mailingAddress : employee.address, key);

  const requestType = KIND_TO_REQUEST_TYPE[kind];
  const history = await db
    .select({
      payload: changeRequests.payload,
      effectiveFrom: changeRequests.effectiveFrom,
      publicId: changeRequests.publicId,
    })
    .from(changeRequests)
    .where(
      and(
        eq(changeRequests.employeeId, employeeId),
        eq(changeRequests.requestType, requestType),
        eq(changeRequests.status, "approved"),
      ),
    )
    .orderBy(asc(changeRequests.effectiveFrom), asc(changeRequests.appliedAt));

  const inEffect = history.filter((r) => r.effectiveFrom <= asOf).at(-1);
  if (inEffect) return readAddress(inEffect.payload, key);

  const first = history[0];
  if (!first) return current();

  // asOf precedes the first recorded change — recover the pre-change value
  // from the approve audit event of that first change. A present-but-null
  // `before` value is authoritative (the field was unset back then); only a
  // missing audit row/key falls back to the current field.
  const auditRows = await db
    .select({ before: auditEvents.before })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, "change_request.approve"),
        eq(auditEvents.entity, "change_request"),
        eq(auditEvents.entityId, first.publicId),
      ),
    )
    .orderBy(desc(auditEvents.id))
    .limit(1);
  const before = auditRows[0]?.before;
  if (before && typeof before === "object") {
    const beforeKey = KIND_TO_BEFORE_KEY[kind];
    const record = before as Record<string, unknown>;
    if (beforeKey in record) return readAddress(record[beforeKey], key);
  }
  return current();
}

/** W-2 box f (spec: mailing address effective Dec 31 of the tax year, else residential). */
export async function w2EmployeeAddressAt(
  db: DbLike,
  employeeId: number,
  year: number,
  key: string,
): Promise<AddressPayload | null> {
  const asOf = `${year}-12-31`;
  const mailing = await resolveEmployeeAddressAt(db, employeeId, "mailing", asOf, key);
  if (mailing) return mailing;
  return resolveEmployeeAddressAt(db, employeeId, "residential", asOf, key);
}

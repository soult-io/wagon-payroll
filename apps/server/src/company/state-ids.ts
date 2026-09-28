/**
 * Spec 24 (PAY-116) S24-D2 — employer state withholding account numbers
 * (W-2 box 15), stored per (company, state, first tax year), encrypted and
 * write-only.
 *
 * - `maskStateId`: decrypt then mask; never throws (L1). An ID shorter than
 *   8 characters is shown as "••••" alone, so a short free-text ID is never
 *   printed in full (M4).
 * - `resolveStateId`: the ID a W-2 of `taxYear` uses — the row with the
 *   greatest from_tax_year ≤ the year; else, for IL and NY, the company EIN
 *   digits while the company has an EIN; else none. Decrypts: render time
 *   only (the EIN doctrine).
 * - `writeStateId` / `deleteStateId`: the filed-year check (L9) and the write
 *   share one transaction that first takes the w2_w3 filing advisory lock
 *   (also taken by markFiled) and locks the w2_w3 tax_filings rows
 *   FOR UPDATE (L4), so a filing marked filed at the same moment cannot slip
 *   between them. A 409 names the first year from the requested one that is
 *   not filed. Audit rows carry `{ idMasked }` only.
 */

import { and, asc, eq, gt, lte, desc } from "drizzle-orm";
import { auditEvents, company, companyStateIds, taxFilings } from "@payroll/db";
import { EIN_DEFAULT_STATES } from "@payroll/shared";
import { decryptField, encryptField } from "../crypto/field-encryption.js";
import type { Db } from "../db.js";
import { W2W3_FILING_LOCK } from "../filings/shared.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Reader = Db | Tx;

export type StateIdSource = "entered" | "ein_default";

const MASK = "••••";

/** Mask a plaintext ID: "••••" + last 4 from 8 characters up, "••••" below. */
export function maskPlainStateId(plain: string): string {
  return plain.length >= 8 ? `${MASK}${plain.slice(-4)}` : MASK;
}

/** Decrypt a stored ID and mask it. Any decryption failure reads as "••••". */
export function maskStateId(stored: string, key: string): string {
  try {
    return maskPlainStateId(decryptField(stored, key));
  } catch {
    return MASK;
  }
}

/** The IL/NY default: the 9 EIN digits (IL sequence omitted = "000"). */
function einDigits(einStored: string, key: string): string {
  return decryptField(einStored, key).replace(/\D/g, "");
}

/** Masked EIN default for the settings screen; never throws. */
export function maskEinDefault(einStored: string, key: string): string {
  try {
    return maskPlainStateId(einDigits(einStored, key));
  } catch {
    return MASK;
  }
}

function isEinDefaultState(stateCode: string): boolean {
  return (EIN_DEFAULT_STATES as readonly string[]).includes(stateCode);
}

/**
 * Which source a W-2 of `taxYear` takes its box 15 ID from, given the
 * state's row start years and whether the company has an EIN. Pure.
 */
export function stateIdSourceFor(
  stateCode: string,
  taxYear: number,
  rowYears: readonly number[],
  hasEin: boolean,
): StateIdSource | null {
  if (rowYears.some((y) => y <= taxYear)) return "entered";
  if (hasEin && isEinDefaultState(stateCode)) return "ein_default";
  return null;
}

/** The box 15 ID of `stateCode` for a W-2 of `taxYear` (decrypted). */
export async function resolveStateId(
  db: Reader,
  key: string,
  query: { companyId: number; stateCode: string; taxYear: number },
): Promise<{ source: StateIdSource | null; value: string | null }> {
  const rows = await db
    .select({ stateId: companyStateIds.stateId })
    .from(companyStateIds)
    .where(
      and(
        eq(companyStateIds.companyId, query.companyId),
        eq(companyStateIds.stateCode, query.stateCode),
        lte(companyStateIds.fromTaxYear, query.taxYear),
      ),
    )
    .orderBy(desc(companyStateIds.fromTaxYear))
    .limit(1);
  const row = rows[0];
  if (row) return { source: "entered", value: decryptField(row.stateId, key) };
  if (!isEinDefaultState(query.stateCode)) return { source: null, value: null };
  const [companyRow] = await db
    .select({ ein: company.ein })
    .from(company)
    .where(eq(company.id, query.companyId))
    .limit(1);
  if (!companyRow?.ein) return { source: null, value: null };
  return { source: "ein_default", value: einDigits(companyRow.ein, key) };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type StateIdWriteResult =
  | { status: 200; idMasked: string }
  | { status: 204 }
  | { status: 404 }
  | { status: 409; error: "state_id_year_filed"; firstOpenYear: number };

interface WriteTarget {
  companyId: number;
  stateCode: string;
  fromTaxYear: number;
}

/**
 * Serialize with the filings: take the w2_w3 advisory lock (markFiled takes
 * it too, so no filing is marked filed between the check and the write,
 * including a filing row created meanwhile), lock the existing w2_w3 rows,
 * and return the first tax year from `fromTaxYear` that is not filed when a
 * change at `target` would alter the ID of a filed year, else null. The
 * years from `fromTaxYear` up to (not incl.) the state's next row start use
 * the changed row.
 */
async function filedYearConflict(tx: Tx, target: WriteTarget): Promise<number | null> {
  await tx.execute(W2W3_FILING_LOCK);
  const filings = await tx
    .select({ year: taxFilings.year, status: taxFilings.status })
    .from(taxFilings)
    .where(eq(taxFilings.formType, "w2_w3"))
    .for("update");
  const [next] = await tx
    .select({ fromTaxYear: companyStateIds.fromTaxYear })
    .from(companyStateIds)
    .where(
      and(
        eq(companyStateIds.companyId, target.companyId),
        eq(companyStateIds.stateCode, target.stateCode),
        gt(companyStateIds.fromTaxYear, target.fromTaxYear),
      ),
    )
    .orderBy(asc(companyStateIds.fromTaxYear))
    .limit(1);
  const until = next?.fromTaxYear ?? Number.POSITIVE_INFINITY;
  const filed = new Set(filings.filter((f) => f.status === "filed").map((f) => f.year));
  const hit = [...filed].some((y) => y >= target.fromTaxYear && y < until);
  if (!hit) return null;
  let open = target.fromTaxYear;
  while (filed.has(open)) open += 1;
  return open;
}

async function lockedRow(tx: Tx, target: WriteTarget) {
  const rows = await tx
    .select()
    .from(companyStateIds)
    .where(
      and(
        eq(companyStateIds.companyId, target.companyId),
        eq(companyStateIds.stateCode, target.stateCode),
        eq(companyStateIds.fromTaxYear, target.fromTaxYear),
      ),
    )
    .for("update");
  return rows[0] ?? null;
}

const entityId = (t: WriteTarget) => `${t.stateCode}:${t.fromTaxYear}`;

/**
 * Insert the row, or replace the one already there. Race-safe on the unique
 * key: the INSERT does nothing on conflict (it waits for a concurrent
 * insert to commit), then the row actually there is read FOR UPDATE and
 * replaced. Returns the replaced row's stored value, or null for a new row.
 */
async function insertOrReplace(
  tx: Tx,
  target: WriteTarget,
  encrypted: string,
  actorId: string,
): Promise<string | null> {
  const inserted = await tx
    .insert(companyStateIds)
    .values({
      companyId: target.companyId,
      stateCode: target.stateCode,
      fromTaxYear: target.fromTaxYear,
      stateId: encrypted,
      createdBy: actorId,
    })
    .onConflictDoNothing({
      target: [companyStateIds.companyId, companyStateIds.stateCode, companyStateIds.fromTaxYear],
    })
    .returning({ id: companyStateIds.id });
  if (inserted.length > 0) return null;
  const previous = await lockedRow(tx, target);
  if (!previous) throw new Error("state ID row vanished inside its transaction");
  await tx
    .update(companyStateIds)
    .set({ stateId: encrypted, updatedAt: new Date() })
    .where(eq(companyStateIds.id, previous.id));
  return previous.stateId;
}

/** Upsert the (normalized) ID for `target`. */
export async function writeStateId(
  db: Db,
  key: string,
  target: WriteTarget,
  normalized: string,
  actorId: string,
): Promise<StateIdWriteResult> {
  return db.transaction(async (tx) => {
    const firstOpenYear = await filedYearConflict(tx, target);
    if (firstOpenYear !== null) {
      return { status: 409, error: "state_id_year_filed", firstOpenYear } as const;
    }
    const replaced = await insertOrReplace(tx, target, encryptField(normalized, key), actorId);
    const idMasked = maskPlainStateId(normalized);
    await tx.insert(auditEvents).values({
      actorId,
      action: "company.state_id.set",
      entity: "company_state_id",
      entityId: entityId(target),
      before: replaced === null ? null : { idMasked: maskStateId(replaced, key) },
      after: { idMasked },
    });
    return { status: 200, idMasked } as const;
  });
}

/** Delete the row for `target`; 404 (no audit) when there is none. */
export async function deleteStateId(
  db: Db,
  key: string,
  target: WriteTarget,
  actorId: string,
): Promise<StateIdWriteResult> {
  return db.transaction(async (tx) => {
    const firstOpenYear = await filedYearConflict(tx, target);
    const previous = await lockedRow(tx, target);
    if (!previous) return { status: 404 } as const;
    if (firstOpenYear !== null) {
      return { status: 409, error: "state_id_year_filed", firstOpenYear } as const;
    }
    await tx.delete(companyStateIds).where(eq(companyStateIds.id, previous.id));
    await tx.insert(auditEvents).values({
      actorId,
      action: "company.state_id.delete",
      entity: "company_state_id",
      entityId: entityId(target),
      before: { idMasked: maskStateId(previous.stateId, key) },
      after: null,
    });
    return { status: 204 } as const;
  });
}

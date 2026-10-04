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
 *   only (the EIN doctrine). A value that fails to decrypt (AES-GCM) throws
 *   StateIdUnreadableError, which carries no value (PR-3).
 * - `writeStateId` / `deleteStateId`: the filed-year check (L9) and the write
 *   share one transaction that first takes the w2_w3 filing advisory lock
 *   (also taken by markFiled) and locks the w2_w3 tax_filings rows
 *   FOR UPDATE (L4), so a filing marked filed at the same moment cannot slip
 *   between them. A 409 names firstOpenYear: the year after the last filed
 *   year the change would reach. Audit rows carry `{ idMasked }` only.
 */

import { createHash } from "node:crypto";
import { and, asc, eq, gt, lte, desc } from "drizzle-orm";
import { auditEvents, company, companyStateIds, taxFilings } from "@payroll/db";
import { EIN_DEFAULT_STATES } from "@payroll/shared";
import { decryptField, encryptField } from "../crypto/field-encryption.js";
import type { Db } from "../db.js";
import { FILING_CLOSE_LOCK } from "../filings/shared.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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

/**
 * Spec 24 (PAY-116) PR-3: an entered box 15 ID failed to decrypt (AES-GCM).
 * Fixed message; never carries the value.
 */
export class StateIdUnreadableError extends Error {
  constructor() {
    super("state ID could not be decrypted");
    this.name = "StateIdUnreadableError";
  }
}

/**
 * Spec 24 (PAY-116) PR-3 R4: the company EIN failed to decrypt. Fixed
 * message; never carries the value.
 */
export class EinUnreadableError extends Error {
  constructor() {
    super("EIN could not be decrypted");
    this.name = "EinUnreadableError";
  }
}

/** The IL/NY default: the 9 EIN digits (IL sequence omitted = "000"). */
function einDigits(einPlain: string): string {
  return einPlain.replace(/\D/g, "");
}

/** Masked EIN default for the settings screen; never throws. */
export function maskEinDefault(einStored: string, key: string): string {
  try {
    return maskPlainStateId(einDigits(decryptField(einStored, key)));
  } catch {
    return MASK;
  }
}

/**
 * The company's stored (encrypted) EIN, or null when there is none. An empty
 * string is no EIN: the IL/NY default must never print blank digits. The one
 * place every box 15 path decides "has an EIN".
 */
export function storedEin(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === "" ? null : value;
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

/**
 * Decrypt the value box 15 prints from: the entered ID, or the EIN digits
 * for the IL/NY default. A failure throws the source's fixed-message error
 * (StateIdUnreadableError / EinUnreadableError), without value or cause.
 */
function decryptBox15(stored: string, source: StateIdSource, key: string): string {
  try {
    const plain = decryptField(stored, key);
    return source === "ein_default" ? einDigits(plain) : plain;
  } catch {
    throw source === "entered" ? new StateIdUnreadableError() : new EinUnreadableError();
  }
}

/**
 * The box 15 ID of `stateCode` for a W-2 of `taxYear` (decrypted).
 * StateIdUnreadableError / EinUnreadableError when the stored value does not
 * decrypt.
 */
export async function resolveStateId(
  db: Pick<Db, "select">,
  key: string,
  query: { companyId: number; stateCode: string; taxYear: number },
): Promise<{ source: StateIdSource | null; value: string | null }> {
  const rows = await db
    .select({ stateId: companyStateIds.stateId, fromTaxYear: companyStateIds.fromTaxYear })
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
  const [companyRow] = await db
    .select({ ein: company.ein })
    .from(company)
    .where(eq(company.id, query.companyId))
    .limit(1);
  const ein = storedEin(companyRow?.ein);
  const source = stateIdSourceFor(
    query.stateCode,
    query.taxYear,
    row ? [row.fromTaxYear] : [],
    ein !== null,
  );
  if (source === "entered" && row) return { source, value: decryptBox15(row.stateId, source, key) };
  if (source === "ein_default" && ein !== null) {
    return { source, value: decryptBox15(ein, source, key) };
  }
  return { source: null, value: null };
}

/** Where one state's box 15 comes from for a tax year, and the stored (encrypted) value. */
interface StoredBox15 {
  source: StateIdSource | null;
  /** The entered row's ciphertext, the EIN ciphertext (ein_default), or null. */
  stored: string | null;
}

/**
 * One company read and one state-ID query: per state, the box 15 source for
 * a W-2 of `taxYear` (the row with the greatest from_tax_year ≤ the year;
 * else the IL/NY EIN default) and the stored value. Nothing is decrypted.
 */
async function storedBox15(
  db: Pick<Db, "select">,
  taxYear: number,
  states: readonly string[],
): Promise<Map<string, StoredBox15>> {
  const out = new Map<string, StoredBox15>();
  if (states.length === 0) return out;
  const [owner] = await db.select({ id: company.id, ein: company.ein }).from(company).limit(1);
  const rows = owner
    ? await db
        .select({
          stateCode: companyStateIds.stateCode,
          fromTaxYear: companyStateIds.fromTaxYear,
          stateId: companyStateIds.stateId,
        })
        .from(companyStateIds)
        .where(eq(companyStateIds.companyId, owner.id))
    : [];
  const ein = storedEin(owner?.ein);
  for (const state of new Set(states)) {
    const own = rows.filter((r) => r.stateCode === state);
    const source = stateIdSourceFor(
      state,
      taxYear,
      own.map((r) => r.fromTaxYear),
      ein !== null,
    );
    let stored: string | null = null;
    if (source === "entered") {
      const current = own
        .filter((r) => r.fromTaxYear <= taxYear)
        .reduce((a, b) => (b.fromTaxYear > a.fromTaxYear ? b : a));
      stored = current.stateId;
    } else if (source === "ein_default") {
      stored = ein;
    }
    out.set(state, { source, stored });
  }
  return out;
}

/**
 * Spec 24 (PAY-116) PR-3: the decrypted box 15 ID of each state for a W-2
 * (or W-3) of `taxYear`, null when the state has none — render time only,
 * never stored or logged. StateIdUnreadableError / EinUnreadableError on a
 * decrypt failure.
 */
export async function resolveStateIds(
  db: Pick<Db, "select">,
  key: string,
  taxYear: number,
  states: readonly string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const [state, { source, stored }] of await storedBox15(db, taxYear, states)) {
    out.set(state, source !== null && stored !== null ? decryptBox15(stored, source, key) : null);
  }
  return out;
}

/** What keeps a state's box 15 from printing (PR-3 R1, R4, R5). */
export type Box15Problem = "state_id_unreadable" | "ein_unreadable" | "state_id_too_long";

/**
 * Spec 24 (PAY-116) PR-3 R1/R5: readiness probe. Decrypts each state's box
 * 15 value, asks `fits` whether the form can print it, and DISCARDS it: the
 * value is never stored, returned, logged or hashed. This is the one agreed
 * exception to "decrypted at render time only" (security condition on
 * PAY-116, 2026-09-28): the W-2 must be held (block) before any furnishing
 * when the PDF could not print box 15. Returns the problem states only.
 */
export async function probeStateIds(
  db: Pick<Db, "select">,
  key: string,
  taxYear: number,
  states: readonly string[],
  fits: (plain: string) => boolean,
): Promise<Map<string, Box15Problem>> {
  const out = new Map<string, Box15Problem>();
  for (const [state, { source, stored }] of await storedBox15(db, taxYear, states)) {
    if (source === null || stored === null) continue;
    try {
      if (!fits(decryptBox15(stored, source, key))) out.set(state, "state_id_too_long");
    } catch (err) {
      if (err instanceof StateIdUnreadableError) out.set(state, "state_id_unreadable");
      else if (err instanceof EinUnreadableError) out.set(state, "ein_unreadable");
      else throw err;
    }
  }
  return out;
}

/** True when the stored EIN is absent or decrypts; the value is discarded (R4 probe). */
export function einReadable(einStored: string | null | undefined, key: string): boolean {
  const ein = storedEin(einStored);
  if (ein === null) return true;
  try {
    decryptField(ein, key);
    return true;
  } catch {
    return false;
  }
}

/** Box 15 identity of one state for the furnishing hash (R3). */
export interface StateIdFact {
  source: StateIdSource | null;
  /**
   * SHA-256 hex of the entered row's stored ciphertext ("enc:v1:…"), null
   * for the EIN default or no ID. The ciphertext, not the value: the hash
   * must change when box 15 changes without any decrypt (the value is
   * decrypted at render time only). Spec 24 (PAY-116) PR-4: re-saving the
   * same ID writes nothing (writeStateId), so it does not change the digest.
   */
  digest: string | null;
}

/**
 * Spec 24 (PAY-116): the box 15 source (and R3 digest) of each state for a
 * W-2 of `taxYear` — never decrypted.
 */
export async function stateIdFacts(
  db: Pick<Db, "select">,
  taxYear: number,
  states: readonly string[],
): Promise<Record<string, StateIdFact>> {
  const out: Record<string, StateIdFact> = {};
  for (const [state, { source, stored }] of await storedBox15(db, taxYear, states)) {
    const digest =
      source === "entered" && stored !== null
        ? createHash("sha256").update(stored, "utf8").digest("hex")
        : null;
    out[state] = { source, digest };
  }
  return out;
}

/**
 * Spec 24 (PAY-116) PR-2: the box 15 ID source of each state for a W-2 of
 * `taxYear` — availability only, never decrypted (no value leaves here).
 */
export async function stateIdAvailability(
  db: Pick<Db, "select">,
  taxYear: number,
  states: readonly string[],
): Promise<Record<string, StateIdSource | null>> {
  const out: Record<string, StateIdSource | null> = {};
  for (const [state, { source }] of await storedBox15(db, taxYear, states)) out[state] = source;
  return out;
}

/** The IL/NY states still using the EIN default for some year from `fromYear`. Pure. */
export function einDefaults(
  fromYear: number,
  yearsByState: ReadonlyMap<string, readonly number[]>,
  hasEin: boolean,
): string[] {
  if (!hasEin) return [];
  return EIN_DEFAULT_STATES.filter(
    (s) => stateIdSourceFor(s, fromYear, yearsByState.get(s) ?? [], true) === "ein_default",
  );
}

export interface NeededStateId {
  stateCode: string;
  taxYear: number;
  reason: "tax_withheld" | "wages_only";
}

/**
 * The states on any W-2 line without a box 15 ID, one entry per (state,
 * year): tax_withheld when any such line shows box 17 > 0. Sorted by state
 * code (code-point), then year. Pure.
 */
export function neededStates(
  yearLines: readonly {
    taxYear: number;
    lines: readonly {
      state: string;
      box17Cents: number | null;
      stateIdSource: StateIdSource | null;
    }[];
  }[],
): NeededStateId[] {
  const byKey = new Map<string, NeededStateId>();
  for (const { taxYear, lines } of yearLines) {
    for (const line of lines) {
      if (line.stateIdSource !== null) continue;
      const key = `${line.state}:${taxYear}`;
      const entry = byKey.get(key) ?? { stateCode: line.state, taxYear, reason: "wages_only" };
      if ((line.box17Cents ?? 0) > 0) entry.reason = "tax_withheld";
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      (a.stateCode < b.stateCode ? -1 : a.stateCode > b.stateCode ? 1 : 0) || a.taxYear - b.taxYear,
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

type YearFiled = { status: 409; error: "state_id_year_filed"; firstOpenYear: number };

export type StateIdSetResult = { status: 200; idMasked: string; unchanged: boolean } | YearFiled;
export type StateIdDeleteResult = { status: 204 } | { status: 404 } | YearFiled;

interface WriteTarget {
  companyId: number;
  stateCode: string;
  fromTaxYear: number;
}

/**
 * Serialize with the filings: take the w2_w3 advisory lock (markFiled takes
 * it too, so no filing is marked filed between the check and the write,
 * including a filing row created meanwhile), lock the existing w2_w3 rows,
 * and, when a change at `target` would alter the ID of a filed year, return
 * the year after the last such filed year (firstOpenYear), else null. The
 * years from `fromTaxYear` up to (not incl.) the state's next row start use
 * the changed row.
 */
async function filedYearConflict(tx: Tx, target: WriteTarget): Promise<number | null> {
  await tx.execute(FILING_CLOSE_LOCK);
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
  const hits = filings
    .filter((f) => f.status === "filed" && f.year >= target.fromTaxYear && f.year < until)
    .map((f) => f.year);
  if (hits.length === 0) return null;
  // The year after the last filed year the change would reach: a row from
  // there leaves every filed year in the window on the ID it was filed with.
  return Math.max(...hits) + 1;
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

/** True when the stored value decrypts to exactly `normalized`; a decrypt failure is false. */
function storesSameValue(stored: string, key: string, normalized: string): boolean {
  try {
    return decryptField(stored, key) === normalized;
  } catch {
    return false;
  }
}

/**
 * Upsert the (normalized) ID for `target`. Spec 24 (PAY-116) PR-4 (D-PL2):
 * when the row already holds exactly this value, nothing is written — no new
 * ciphertext (so no CORRECTED W-2 from the furnishing hash), no updated_at
 * change, no audit row — and `unchanged` is true. The stored value is
 * decrypted for the compare inside the locked transaction and discarded;
 * a stored value that does not decrypt is replaced as a normal write.
 */
export async function writeStateId(
  db: Db,
  key: string,
  target: WriteTarget,
  normalized: string,
  actorId: string,
): Promise<StateIdSetResult> {
  return db.transaction(async (tx) => {
    const firstOpenYear = await filedYearConflict(tx, target);
    if (firstOpenYear !== null) {
      return { status: 409, error: "state_id_year_filed", firstOpenYear } as const;
    }
    const idMasked = maskPlainStateId(normalized);
    const existing = await lockedRow(tx, target);
    if (existing && storesSameValue(existing.stateId, key, normalized)) {
      return { status: 200, idMasked, unchanged: true } as const;
    }
    const replaced = await insertOrReplace(tx, target, encryptField(normalized, key), actorId);
    await tx.insert(auditEvents).values({
      actorId,
      action: "company.state_id.set",
      entity: "company_state_id",
      entityId: entityId(target),
      before: replaced === null ? null : { idMasked: maskStateId(replaced, key) },
      after: { idMasked },
    });
    return { status: 200, idMasked, unchanged: false } as const;
  });
}

/** Delete the row for `target`; 404 (no audit) when there is none. */
export async function deleteStateId(
  db: Db,
  key: string,
  target: WriteTarget,
  actorId: string,
): Promise<StateIdDeleteResult> {
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

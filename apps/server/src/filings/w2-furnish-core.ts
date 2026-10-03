/**
 * PAY-206: W-2 furnishing record — the pure core (figures hash, furnishing
 * state) and the row helpers. Imports nothing from annual.ts, so annual.ts
 * can record the year notice; the flows live in w2-furnish.ts.
 *
 * Rulings (federal-payroll-tax-sme, 2026-10-03): 2026 General Instructions
 * for Forms W-2 and W-3, p.28 — an error found after the W-2 went to the
 * employee but before it went to SSA: a new W-2 with the correct figures,
 * "CORRECTED" on the employee's new Copies B, C and 2; Copy A to SSA
 * unmarked. 26 CFR 31.6051-1(j)(5): electronic furnishing = posted +
 * notified, with consent.
 *
 * A W-2 counts as furnished from the earliest moment the employee could hold
 * a copy with those figures (w2_furnishings, append-only). `boxes_hash`
 * covers boxes 1-6 in integer cents; it never leaves the database.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { w2Furnishings } from "@payroll/db";
import type { Db } from "../db.js";
import { worksheetHash } from "./shared.js";
import type { W2BoxesCents } from "./w2-boxes.js";

/** How a W-2 reached (or could reach) the employee. */
export type FurnishMethod =
  | "portal_notice"
  | "employee_download"
  | "admin_print"
  | "paper_handed"
  | "backfill";

/** Version of the figures hash (v1 = boxes 1-6). */
export const W2_HASH_VERSION = 1;

const BOX_KEYS = [
  "box1Cents",
  "box2Cents",
  "box3Cents",
  "box4Cents",
  "box5Cents",
  "box6Cents",
] as const;

/**
 * R3: canonical SHA-256 of one employee-year's boxes 1-6 in integer cents.
 * Throws (fixed message, no value) on anything that is not a safe integer.
 * Security review LOW-1 (deferred, PAY-206 review round): the hash is not
 * keyed, so anyone holding a row could test guessed figures against it. It
 * never leaves the database (no API body, no log); a keyed HMAC is a later
 * change with its own hash_version.
 */
export function w2BoxesHash(employeeId: number, taxYear: number, boxes: W2BoxesCents): string {
  for (const key of BOX_KEYS) {
    if (!Number.isSafeInteger(boxes[key])) {
      throw new TypeError("w2BoxesHash: boxes must be integer cents");
    }
  }
  return worksheetHash({
    v: W2_HASH_VERSION,
    employeeId,
    taxYear,
    box1: boxes.box1Cents,
    box2: boxes.box2Cents,
    box3: boxes.box3Cents,
    box4: boxes.box4Cents,
    box5: boxes.box5Cents,
    box6: boxes.box6Cents,
  });
}

export interface FurnishingRef {
  id: number;
  boxesHash: string;
  furnishedAt: Date;
  method: string;
}

export interface FurnishingState<R extends FurnishingRef = FurnishingRef> {
  /** At least one furnishing exists. */
  furnished: boolean;
  /** Some furnishing (any method) carried other figures: every render is CORRECTED. */
  corrected: boolean;
  /**
   * Corrected and the latest DELIVERY of the employee's channel is not the
   * current figures (review round D1): consented → portal_notice; otherwise
   * → paper_handed. employee_download, admin_print and backfill never clear it.
   */
  correctionToFurnish: boolean;
  /** Latest furnishing of any method: the highest id (D3; furnishedAt never orders). */
  latest: R | null;
}

/** The method that delivers a W-2 on the employee's channel (D1). */
export function deliveryMethod(consented: boolean): FurnishMethod {
  return consented ? "portal_notice" : "paper_handed";
}

/** The row with the highest id, optionally of one method only (D3). */
export function latestRow<R extends { id: number; method: string }>(
  rows: readonly R[],
  method?: string,
): R | null {
  let latest: R | null = null;
  for (const r of rows) {
    if (method !== undefined && r.method !== method) continue;
    if (latest === null || r.id > latest.id) latest = r;
  }
  return latest;
}

/**
 * R4 + review round D1/D3: the one owner of furnished / corrected /
 * correctionToFurnish. `consented` = active electronic consent AND a login.
 */
export function furnishingState<R extends FurnishingRef>(
  rows: readonly R[],
  currentHash: string,
  opts: { consented: boolean },
): FurnishingState<R> {
  const latest = latestRow(rows);
  const corrected = rows.some((r) => r.boxesHash !== currentHash);
  const delivered = latestRow(rows, deliveryMethod(opts.consented));
  return {
    furnished: latest !== null,
    corrected,
    correctionToFurnish: corrected && delivered?.boxesHash !== currentHash,
    latest,
  };
}

/** `corrected` alone: some furnishing (any method) carried other figures. */
export function isCorrected(rows: readonly { boxesHash: string }[], currentHash: string): boolean {
  return rows.some((r) => r.boxesHash !== currentHash);
}

/** Review round D9: the access window's last day lives in @payroll/shared. */
export { electronicW2AccessThrough } from "@payroll/shared";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type FurnishingRow = typeof w2Furnishings.$inferSelect;

/** The furnishing rows of one employee-year (any order). */
export async function furnishingRows(
  db: Pick<Db, "select">,
  employeeId: number,
  taxYear: number,
): Promise<FurnishingRow[]> {
  return db
    .select()
    .from(w2Furnishings)
    .where(and(eq(w2Furnishings.employeeId, employeeId), eq(w2Furnishings.taxYear, taxYear)));
}

/** The furnishing rows of many employees in one year, grouped by employee. */
export async function furnishingRowsByEmployee(
  db: Pick<Db, "select">,
  employeeIds: readonly number[],
  taxYear: number,
): Promise<Map<number, FurnishingRow[]>> {
  const out = new Map<number, FurnishingRow[]>();
  if (employeeIds.length === 0) return out;
  const rows = await db
    .select()
    .from(w2Furnishings)
    .where(
      and(inArray(w2Furnishings.employeeId, [...employeeIds]), eq(w2Furnishings.taxYear, taxYear)),
    );
  for (const r of rows) {
    const list = out.get(r.employeeId) ?? [];
    list.push(r);
    out.set(r.employeeId, list);
  }
  return out;
}

/**
 * Insert one furnishing event. Review round D2: skipped only when the LATEST
 * row (highest id) of the same method already carries this hash — figures
 * that come back to an earlier hash are furnished again. Returns true when a
 * row was written. The caller holds the employee lock and read the figures
 * in the same transaction (R10), so the read-then-insert cannot race.
 */
export async function recordFurnishing(
  tx: Pick<Db, "select" | "insert">,
  row: {
    employeeId: number;
    taxYear: number;
    boxesHash: string;
    corrected: boolean;
    method: FurnishMethod;
    actorId: string | null;
  },
): Promise<boolean> {
  const last = await tx
    .select({ boxesHash: w2Furnishings.boxesHash })
    .from(w2Furnishings)
    .where(
      and(
        eq(w2Furnishings.employeeId, row.employeeId),
        eq(w2Furnishings.taxYear, row.taxYear),
        eq(w2Furnishings.method, row.method),
      ),
    )
    .orderBy(desc(w2Furnishings.id))
    .limit(1);
  if (last[0]?.boxesHash === row.boxesHash) return false;
  await tx.insert(w2Furnishings).values({ ...row, hashVersion: W2_HASH_VERSION });
  return true;
}

/**
 * Record that the employee was furnished the CURRENT figures (`boxes`) by
 * `method`. The row's `corrected` flag is the state before the write (the
 * copy furnished now is CORRECTED when an earlier one carried other
 * figures). Caller: inside a transaction that took lockEmployee and read
 * `boxes` after the lock (R10).
 */
export async function furnishCurrent(
  tx: Pick<Db, "select" | "insert">,
  row: {
    employeeId: number;
    taxYear: number;
    boxes: W2BoxesCents;
    method: FurnishMethod;
    actorId: string | null;
  },
): Promise<{ corrected: boolean; inserted: boolean }> {
  const hash = w2BoxesHash(row.employeeId, row.taxYear, row.boxes);
  const corrected = isCorrected(await furnishingRows(tx, row.employeeId, row.taxYear), hash);
  const inserted = await recordFurnishing(tx, {
    employeeId: row.employeeId,
    taxYear: row.taxYear,
    boxesHash: hash,
    corrected,
    method: row.method,
    actorId: row.actorId,
  });
  return { corrected, inserted };
}

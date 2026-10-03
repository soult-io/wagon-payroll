/**
 * PAY-206: W-2 furnishing record and CORRECTED employee copies.
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

import { and, eq, inArray } from "drizzle-orm";
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
}

export interface FurnishingState<R extends FurnishingRef = FurnishingRef> {
  /** At least one furnishing exists. */
  furnished: boolean;
  /** Some furnishing carried other figures: every render is CORRECTED. */
  corrected: boolean;
  /** Corrected and the latest furnishing is not the current figures. */
  correctionToFurnish: boolean;
  /** Latest furnishing: max furnishedAt, then max id. */
  latest: R | null;
}

/** R4: the one owner of furnished / corrected / correctionToFurnish. */
export function furnishingState<R extends FurnishingRef>(
  rows: readonly R[],
  currentHash: string,
): FurnishingState<R> {
  let latest: R | null = null;
  for (const r of rows) {
    if (
      latest === null ||
      r.furnishedAt.getTime() > latest.furnishedAt.getTime() ||
      (r.furnishedAt.getTime() === latest.furnishedAt.getTime() && r.id > latest.id)
    ) {
      latest = r;
    }
  }
  const corrected = rows.some((r) => r.boxesHash !== currentHash);
  return {
    furnished: latest !== null,
    corrected,
    correctionToFurnish: corrected && latest !== null && latest.boxesHash !== currentHash,
    latest,
  };
}

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
 * Insert one furnishing event; idempotent per (employee, year, hash, method)
 * — the first furnished_at is kept. Returns true when a row was written.
 * The caller holds the employee lock and read the figures in the same
 * transaction (R10).
 */
export async function recordFurnishing(
  tx: Pick<Db, "insert">,
  row: {
    employeeId: number;
    taxYear: number;
    boxesHash: string;
    corrected: boolean;
    method: FurnishMethod;
    actorId: string | null;
  },
): Promise<boolean> {
  const inserted = await tx
    .insert(w2Furnishings)
    .values({ ...row, hashVersion: W2_HASH_VERSION })
    .onConflictDoNothing({
      target: [
        w2Furnishings.employeeId,
        w2Furnishings.taxYear,
        w2Furnishings.boxesHash,
        w2Furnishings.method,
      ],
    })
    .returning({ id: w2Furnishings.id });
  return inserted.length > 0;
}

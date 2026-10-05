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
 * covers boxes 1-6 in integer cents (v1, tax years before 2026) or boxes 1-6
 * plus formCount and the state lines (v2, Spec 24 PR-2 brief §4, from
 * 2026); it never leaves the database. No state ID VALUE enters any hash:
 * v2 covers what box 15 prints by its source and, for an entered ID, the
 * SHA-256 of the stored ciphertext (PR-3 R3).
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { w2Furnishings } from "@payroll/db";
import type { Db } from "../db.js";
import { worksheetHash } from "./shared.js";
import type { W2BoxesCents } from "./w2-boxes.js";
import { STATE_BOXES_FROM_YEAR } from "./w2-state.js";

/** How a W-2 reached (or could reach) the employee. */
export type FurnishMethod =
  | "portal_notice"
  | "employee_download"
  | "admin_print"
  | "paper_handed"
  | "backfill";

/** Version of the v1 figures hash (boxes 1-6); kept as the v1 alias. */
export const W2_HASH_VERSION = 1;

/** The figures hash version of a tax year: 2 from STATE_BOXES_FROM_YEAR (state lines), else 1. */
export function hashVersionFor(taxYear: number): 1 | 2 {
  return taxYear >= STATE_BOXES_FROM_YEAR ? 2 : 1;
}

/** The figures a furnishing hash covers (W2Figures with printable boxes). */
export interface W2HashFigures extends W2BoxesCents {
  formCount: number;
  stateLines: readonly {
    state: string;
    box16Cents: number | null;
    box17Cents: number | null;
    form: number;
    row: number;
    stateIdSource: string | null;
    stateIdDigest: string | null;
  }[];
}

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

/** Fixed-message TypeError: never echoes the offending value. */
function notCents(): TypeError {
  return new TypeError("w2FiguresHash: figures must be integer cents");
}

function intOrNull(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v === "number" && Number.isSafeInteger(v)) return v;
  throw notCents();
}

function int(v: unknown): number {
  if (typeof v === "number" && Number.isSafeInteger(v)) return v;
  throw notCents();
}

function strOrNull(v: unknown): string | null {
  if (v === null || typeof v === "string") return v;
  throw notCents();
}

/**
 * The furnishing hash of one employee-year, by tax year (hashVersionFor):
 * v1 = w2BoxesHash (byte-identical for years before 2026); v2 = boxes 1-6 +
 * formCount + every state line {state, form, row, box16, box17,
 * stateIdSource, stateIdDigest} in line order + localLines (always [] from
 * Spec 24). PR-3 R3: box 15 is covered by its source and the digest of the
 * entered ID's stored ciphertext — not the value, so the hash stays pure (no
 * key, no decrypt) and a changed ID makes the next furnishing CORRECTED.
 * Spec 24 (PAY-116) PR-4: re-entering the identical value writes nothing,
 * so its ciphertext and digest stay the same.
 * Changed in place: no v2 row existed in production. Other keys of
 * `figures` (names, issues) never enter it. Amounts are integers or null;
 * anything else throws a fixed TypeError.
 */
export function w2FiguresHash(employeeId: number, taxYear: number, figures: W2HashFigures): string {
  if (hashVersionFor(taxYear) === 1) return w2BoxesHash(employeeId, taxYear, figures);
  const stateLines = figures.stateLines.map((l) => {
    if (typeof l.state !== "string") throw notCents();
    return {
      state: l.state,
      form: int(l.form),
      row: int(l.row),
      box16: intOrNull(l.box16Cents),
      box17: intOrNull(l.box17Cents),
      stateIdSource: strOrNull(l.stateIdSource),
      stateIdDigest: strOrNull(l.stateIdDigest),
    };
  });
  return worksheetHash({
    v: 2,
    employeeId,
    taxYear,
    box1: int(figures.box1Cents),
    box2: int(figures.box2Cents),
    box3: int(figures.box3Cents),
    box4: int(figures.box4Cents),
    box5: int(figures.box5Cents),
    box6: int(figures.box6Cents),
    formCount: int(figures.formCount),
    stateLines,
    // Spec 24 emits no local lines; PAY-171 extends the canonical object.
    localLines: [],
  });
}

export interface FurnishingRef {
  id: number;
  boxesHash: string;
  furnishedAt: Date;
  method: string;
  /** The row's hash version; a row of another version never matches (CORRECTED). */
  hashVersion?: number;
}

/** The row carries `currentHash` under the expected hash version. */
function sameFigures(
  r: { boxesHash: string; hashVersion?: number },
  currentHash: string,
  version: number | undefined,
): boolean {
  if (version !== undefined && r.hashVersion !== undefined && r.hashVersion !== version) {
    return false;
  }
  return r.boxesHash === currentHash;
}

export interface FurnishingState<R extends FurnishingRef = FurnishingRef> {
  /** At least one furnishing exists. */
  furnished: boolean;
  /** Some furnishing (any method) carried other figures: every render is CORRECTED. */
  corrected: boolean;
  /**
   * Corrected and no DELIVERY of the employee's channel carries the current
   * figures (review round D1, round 3 R1): consented → the latest
   * portal_notice; otherwise → the latest paper_handed OR the latest
   * portal_notice (a notice delivered before consent was withdrawn stays
   * delivered, 26 CFR 31.6051-1(j)(3)(v)(C)). employee_download,
   * admin_print and backfill never clear it.
   */
  correctionToFurnish: boolean;
  /** Latest furnishing of any method: the highest id (D3; furnishedAt never orders). */
  latest: R | null;
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
 * correctionToFurnish. `consented` = the electronic channel of the year
 * (electronicW2Channel). PAY-208: `electronicUntil` (the withdrawal time,
 * on the paper branch) — a portal_notice posted at or after it does not
 * count as a delivery: a correction posted online after a withdrawal is
 * still owed on paper (federal SME ruling 2026-10-04).
 */
export function furnishingState<R extends FurnishingRef>(
  rows: readonly R[],
  currentHash: string,
  opts: { consented: boolean; version?: number; electronicUntil?: Date | null },
): FurnishingState<R> {
  const latest = latestRow(rows);
  const corrected = rows.some((r) => !sameFigures(r, currentHash, opts.version));
  const latestNotice = latestRow(rows, "portal_notice");
  const delivered = opts.consented
    ? latestNotice !== null && sameFigures(latestNotice, currentHash, opts.version)
    : offChannelDelivered(rows, currentHash, opts.version, opts.electronicUntil ?? null);
  return {
    furnished: latest !== null,
    corrected,
    correctionToFurnish: corrected && !delivered,
    latest,
  };
}

/**
 * PAY-217 round 2 (C1): off the electronic channel, a delivery is a
 * paper_handed row or a portal_notice posted before `until` (the withdrawal
 * or the termination). It counts as current only when it carries the
 * current figures AND no later row (by id) carries other figures — so
 * figures that go A → B → A owe the A copy again after B was delivered.
 */
function offChannelDelivered(
  rows: readonly FurnishingRef[],
  currentHash: string,
  version: number | undefined,
  until: Date | null,
): boolean {
  const isDelivery = (r: FurnishingRef) =>
    r.method === "paper_handed" ||
    (r.method === "portal_notice" && (until === null || r.furnishedAt.getTime() < until.getTime()));
  return rows.some(
    (r) =>
      isDelivery(r) &&
      sameFigures(r, currentHash, version) &&
      !rows.some((o) => o.id > r.id && !sameFigures(o, currentHash, version)),
  );
}

/**
 * `corrected` alone: some furnishing (any method) carried other figures. With
 * `version`, a row of another hash version counts as other figures.
 */
export function isCorrected(
  rows: readonly { boxesHash: string; hashVersion?: number }[],
  currentHash: string,
  version?: number,
): boolean {
  return rows.some((r) => !sameFigures(r, currentHash, version));
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
  await tx.insert(w2Furnishings).values({ ...row, hashVersion: hashVersionFor(row.taxYear) });
  return true;
}

/**
 * Record that the employee was furnished the CURRENT figures (`figures`) by
 * `method`. The row's `corrected` flag is the state before the write (the
 * copy furnished now is CORRECTED when an earlier one carried other
 * figures). Caller: inside a transaction that took lockEmployee and read
 * `figures` after the lock (R10).
 */
export async function furnishCurrent(
  tx: Pick<Db, "select" | "insert">,
  row: {
    employeeId: number;
    taxYear: number;
    figures: W2HashFigures;
    method: FurnishMethod;
    actorId: string | null;
  },
): Promise<{ corrected: boolean; inserted: boolean }> {
  const hash = w2FiguresHash(row.employeeId, row.taxYear, row.figures);
  const corrected = isCorrected(
    await furnishingRows(tx, row.employeeId, row.taxYear),
    hash,
    hashVersionFor(row.taxYear),
  );
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

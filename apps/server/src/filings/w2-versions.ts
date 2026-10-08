/**
 * PAY-223 PR-2: W-2 versions — the read model over w2_furnishings and
 * w2_furnished_figures, and the render of one frozen version.
 *
 * 26 CFR 31.6051-1(j)(6): every W-2 furnished on a Web site stays reachable
 * through the year's window, corrections or filings notwithstanding.
 *
 * - A version is a distinct (hash_version, boxes_hash) among an
 *   employee-year's furnishing rows, numbered 1..k by its first row (id
 *   order; rows are append-only, so the numbering is stable). The employee
 *   counts online rows only (portal_notice, employee_download; D-4); the
 *   admin counts every method (D-8). kind, postedOn (company-local date) and
 *   the CORRECTED mark come from that first row (D-F2).
 * - A version renders from its FROZEN figures (D-1: the hash input only);
 *   identity fields (SSN, name, address, EIN) come from current data at
 *   render time; box 15 from the frozen entered-ID ciphertext (OD-3 A,
 *   decrypted here only), the current EIN (IL/NY default, D-2), or blank.
 * - Read-time integrity check: the frozen figures must re-hash to their key
 *   and each entered line's ciphertext must match its digest; otherwise the
 *   version is refused and one fixed line is logged (error class only).
 * - A version download records nothing (D-6): no furnishing row, no mail,
 *   no audit row. The hash and the frozen figures never leave the server.
 */

import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { w2FurnishedFigures } from "@payroll/db";
import { hasTemplate, renderW2AdminCopyD, renderW2EmployeePacket } from "@payroll/documents";
import { currentEinDefaultId, decryptFrozenStateId } from "../company/state-ids.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import { lockEmployee } from "../payroll/locks.js";
import { localDate } from "../payroll/run-dates.js";
import {
  type Box15Resolver,
  FormNotAvailableError,
  isW2Available,
  isW2Blocked,
  type ReadableW2Figures,
  type W2Figures,
  w2AvailableOn,
  w2InputFromFigures,
} from "./annual.js";
import { errorClass, FilingServiceError } from "./shared.js";
import { onlineW2Windows } from "./w2-consent.js";
import {
  type FrozenFigures,
  type FurnishingRow,
  frozenFigures,
  furnishingRows,
  furnishingRowsByEmployee,
  hashVersionFor,
  type W2HashFigures,
  w2FiguresHash,
} from "./w2-furnish-core.js";
import { currentHash, type FurnishedVia } from "./w2-furnish.js";

interface Deps {
  db: Db;
  config: AppConfig;
}

type ReadDb = Pick<Db, "select">;

/** The online methods: a W-2 posted (portal_notice) or downloaded (employee_download). */
const ONLINE_METHODS: ReadonlySet<string> = new Set(["portal_notice", "employee_download"]);

/** How a version first reached the employee (admin view); backfill = "unknown". */
const VIA: Record<string, Exclude<FurnishedVia, "none">> = {
  portal_notice: "online",
  employee_download: "online",
  backfill: "unknown",
  admin_print: "printed",
  paper_handed: "paper",
};

/** One version of an employee-year (server-side: the hash never leaves it). */
export interface W2Version {
  version: number;
  kind: "original" | "corrected";
  /** Company-local date of the version's first row. */
  postedOn: string;
  /** The CORRECTED mark of the version's PDF: its first row's flag. */
  corrected: boolean;
  via: Exclude<FurnishedVia, "none">;
  hashVersion: number;
  boxesHash: string;
  frozen: boolean;
}

/** The employee list item's version (no amount, hash, id or reason). */
export interface MyW2VersionView {
  version: number;
  kind: "original" | "corrected";
  postedOn: string;
  current: boolean;
  downloadable: boolean;
}

/** The admin list row's version. */
export interface AdminW2VersionView {
  version: number;
  kind: "original" | "corrected";
  postedOn: string;
  via: Exclude<FurnishedVia, "none">;
  current: boolean;
  frozen: boolean;
}

function keyOf(hashVersion: number, boxesHash: string): string {
  return `${hashVersion}:${boxesHash}`;
}

/** Group rows into versions by their first row (id order). Pure. */
export function versionsOf(
  rows: readonly FurnishingRow[],
  frozenKeys: ReadonlySet<string>,
  appTz: string,
): W2Version[] {
  const seen = new Set<string>();
  const out: W2Version[] = [];
  for (const r of [...rows].sort((a, b) => a.id - b.id)) {
    const key = keyOf(r.hashVersion, r.boxesHash);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      version: out.length + 1,
      kind: r.corrected ? "corrected" : "original",
      postedOn: localDate(r.furnishedAt, appTz),
      corrected: r.corrected,
      via: VIA[r.method] ?? "unknown",
      hashVersion: r.hashVersion,
      boxesHash: r.boxesHash,
      frozen: frozenKeys.has(key),
    });
  }
  return out;
}

/** The frozen keys of many employees in one year, by employee. */
async function frozenKeysByEmployee(
  db: ReadDb,
  employeeIds: readonly number[],
  year: number,
): Promise<Map<number, Set<string>>> {
  const out = new Map<number, Set<string>>();
  if (employeeIds.length === 0) return out;
  const rows = await db
    .select({
      employeeId: w2FurnishedFigures.employeeId,
      hashVersion: w2FurnishedFigures.hashVersion,
      boxesHash: w2FurnishedFigures.boxesHash,
    })
    .from(w2FurnishedFigures)
    .where(
      and(
        inArray(w2FurnishedFigures.employeeId, [...employeeIds]),
        eq(w2FurnishedFigures.taxYear, year),
      ),
    );
  for (const r of rows) {
    const set = out.get(r.employeeId) ?? new Set<string>();
    set.add(keyOf(r.hashVersion, r.boxesHash));
    out.set(r.employeeId, set);
  }
  return out;
}

/** D-4: the versions posted online to the employee (online rows only). */
export async function onlineVersions(
  db: ReadDb,
  employeeId: number,
  year: number,
  appTz: string,
): Promise<W2Version[]> {
  const rows = (await furnishingRows(db, employeeId, year)).filter((r) =>
    ONLINE_METHODS.has(r.method),
  );
  if (rows.length === 0) return [];
  const frozen = (await frozenKeysByEmployee(db, [employeeId], year)).get(employeeId);
  return versionsOf(rows, frozen ?? new Set(), appTz);
}

/** D-8: every version of the employee-year, any method (admin records). */
export async function allVersions(
  db: ReadDb,
  employeeId: number,
  year: number,
  appTz: string,
): Promise<W2Version[]> {
  const rows = await furnishingRows(db, employeeId, year);
  if (rows.length === 0) return [];
  const frozen = (await frozenKeysByEmployee(db, [employeeId], year)).get(employeeId);
  return versionsOf(rows, frozen ?? new Set(), appTz);
}

/** The version carries the figures hashed `current` under the year's hash version. */
function isCurrent(v: W2Version, current: string | null, year: number): boolean {
  return current !== null && v.hashVersion === hashVersionFor(year) && v.boxesHash === current;
}

/**
 * The employee list's `versions` of one year: downloadable = frozen and the
 * year inside its (j)(6) window on `today` (onlineW2Windows; D-5 A, the
 * same gate for active and former employees, consent not re-checked).
 */
export async function myW2Versions(
  deps: Deps,
  employeeId: number,
  year: number,
  today: string,
): Promise<MyW2VersionView[]> {
  const { db, config } = deps;
  const versions = await onlineVersions(db, employeeId, year, config.appTz);
  if (versions.length === 0) return [];
  const current = await currentHash(db, employeeId, year);
  const windows = await onlineW2Windows(db, employeeId, today, config.appTz);
  const open = windows.some((w) => w.taxYear === year);
  return versions.map((v) => ({
    version: v.version,
    kind: v.kind,
    postedOn: v.postedOn,
    current: isCurrent(v, current, year),
    downloadable: v.frozen && open,
  }));
}

/** The admin list's `versions` of every listed W-2, by employee (all methods). */
export async function adminW2Versions(
  deps: Deps,
  year: number,
  figures: readonly W2Figures[],
): Promise<Map<number, AdminW2VersionView[]>> {
  const ids = figures.map((f) => f.employeeId);
  const rows = await furnishingRowsByEmployee(deps.db, ids, year);
  const frozen = await frozenKeysByEmployee(deps.db, ids, year);
  const out = new Map<number, AdminW2VersionView[]>();
  for (const f of figures) {
    const current =
      isW2Blocked(f) || f.box1Cents === null
        ? null
        : w2FiguresHash(f.employeeId, year, f as ReadableW2Figures);
    const versions = versionsOf(
      rows.get(f.employeeId) ?? [],
      frozen.get(f.employeeId) ?? new Set(),
      deps.config.appTz,
    );
    out.set(
      f.employeeId,
      versions.map((v) => ({
        version: v.version,
        kind: v.kind,
        postedOn: v.postedOn,
        via: v.via,
        current: isCurrent(v, current, year),
        frozen: v.frozen,
      })),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Render one version
// ---------------------------------------------------------------------------

/**
 * The version is not offered: unknown n, never posted (or furnished), not
 * frozen, or outside the window (employee). Fixed message; one body per
 * audience (employee 409 w2_not_available, admin 404 not_found).
 */
export class VersionNotAvailableError extends Error {
  constructor() {
    super("W-2 version not available");
    this.name = "VersionNotAvailableError";
  }
}

/**
 * The frozen figures failed the read-time integrity check (or a v1 row
 * carries a state line, S24-D5). Fixed message; employee 409
 * w2_not_available, admin 409 w2_version_unreadable.
 */
export class VersionUnreadableError extends Error {
  constructor() {
    super("W-2 version could not be read");
    this.name = "VersionUnreadableError";
  }
}

/** The internal cause of an integrity failure (its class is the only thing logged). */
class IntegrityCheckError extends Error {
  constructor() {
    super("integrity check failed");
    this.name = "IntegrityCheckError";
  }
}

/** A frozen version proven equal to its key: the figures and the entered-ID ciphertexts. */
interface VerifiedVersion {
  figures: FrozenFigures;
  box15: Readonly<Record<string, string>>;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Rebuild the canonical hash input from the stored figures: jsonb keeps no
 * key order, so frozenFigures copies the allowlist and type-checks every
 * amount. Throws on a malformed value, local lines (Spec 24 emits none), or
 * a v1 (2025) row with a state line or a second form (S24-D5).
 */
function storedFigures(stored: unknown, hashVersion: number): FrozenFigures {
  const f = stored as Partial<Record<keyof FrozenFigures, unknown>> | null;
  if (f === null || typeof f !== "object") throw new IntegrityCheckError();
  if (!Array.isArray(f.stateLines) || !Array.isArray(f.localLines) || f.localLines.length > 0) {
    throw new IntegrityCheckError();
  }
  const figures = frozenFigures(f as unknown as W2HashFigures);
  if (hashVersion === 1 && (figures.stateLines.length > 0 || figures.formCount !== 1)) {
    throw new IntegrityCheckError();
  }
  return figures;
}

/** The ciphertext of each entered line, each proven equal to its digest. */
function verifiedBox15(figures: FrozenFigures, stored: unknown): Record<string, string> {
  if (stored !== null && (typeof stored !== "object" || Array.isArray(stored))) {
    throw new IntegrityCheckError();
  }
  const cts = (stored ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const l of figures.stateLines) {
    if (l.stateIdSource !== "entered") continue;
    const ct = cts[l.state];
    if (typeof ct !== "string" || l.stateIdDigest === null || sha256Hex(ct) !== l.stateIdDigest) {
      throw new IntegrityCheckError();
    }
    out[l.state] = ct;
  }
  return out;
}

/**
 * The read-time integrity check: the stored figures re-hash to the row's key
 * under the year's hash version, and every entered ID's ciphertext matches
 * its digest. Throws on any mismatch or malformed value.
 */
function verifyFrozen(
  row: { hashVersion: number; boxesHash: string; figures: unknown; box15Ciphertexts: unknown },
  employeeId: number,
  year: number,
): VerifiedVersion {
  if (row.hashVersion !== hashVersionFor(year)) throw new IntegrityCheckError();
  const figures = storedFigures(row.figures, row.hashVersion);
  if (w2FiguresHash(employeeId, year, figures) !== row.boxesHash) throw new IntegrityCheckError();
  return { figures, box15: verifiedBox15(figures, row.box15Ciphertexts) };
}

/** Load and verify the frozen row of `v`; VersionUnreadableError (logged) on failure. */
async function loadVerified(
  db: ReadDb,
  employeeId: number,
  year: number,
  v: W2Version,
): Promise<VerifiedVersion> {
  const rows = await db
    .select({
      hashVersion: w2FurnishedFigures.hashVersion,
      boxesHash: w2FurnishedFigures.boxesHash,
      figures: w2FurnishedFigures.figures,
      box15Ciphertexts: w2FurnishedFigures.box15Ciphertexts,
    })
    .from(w2FurnishedFigures)
    .where(
      and(
        eq(w2FurnishedFigures.employeeId, employeeId),
        eq(w2FurnishedFigures.taxYear, year),
        eq(w2FurnishedFigures.hashVersion, v.hashVersion),
        eq(w2FurnishedFigures.boxesHash, v.boxesHash),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new VersionNotAvailableError();
  try {
    return verifyFrozen(row, employeeId, year);
  } catch (err) {
    // Fixed text + error class only: no figure, hash, ciphertext or id.
    console.error(
      `[filings] W-2 version: frozen figures failed the integrity check (${errorClass(err)})`,
    );
    throw new VersionUnreadableError();
  }
}

/**
 * Box 15 of a frozen version: the entered ID as posted (frozen ciphertext,
 * decrypted here), the current EIN digits for the IL/NY default, else blank.
 */
function frozenBox15(
  deps: { db: ReadDb; config: AppConfig },
  verified: VerifiedVersion,
): Box15Resolver {
  return async () => {
    const key = deps.config.encryptionKey;
    const out = new Map<string, string | null>();
    let ein: string | null | undefined;
    for (const l of verified.figures.stateLines) {
      if (l.stateIdSource === "entered") {
        out.set(l.state, decryptFrozenStateId(verified.box15[l.state] as string, key));
      } else if (l.stateIdSource === "ein_default") {
        if (ein === undefined) ein = await currentEinDefaultId(deps.db, key);
        out.set(l.state, ein);
      } else {
        out.set(l.state, null);
      }
    }
    return out;
  };
}

/** January gate and bundled form, before any version or PII is read. */
function assertRenderable(year: number, today: string): void {
  if (!isW2Available(year, today)) {
    throw new FilingServiceError(
      "invalid_transition",
      `W-2 for ${year} becomes available on ${w2AvailableOn(year)}`,
    );
  }
  if (!hasTemplate(year, "fw2")) throw new FormNotAvailableError(year);
}

/**
 * The employee packet of online version `n` (brief §6): under the employee
 * lock, in one transaction that writes nothing (D-6). Refused
 * (VersionNotAvailableError) outside the year's (j)(6) window on
 * `windowToday`, for an unknown n, or an unfrozen version;
 * VersionUnreadableError on an integrity failure. CORRECTED per the
 * version's first online row.
 */
export async function renderMyW2Version(
  deps: Deps,
  employeeId: number,
  year: number,
  n: number,
  windowToday: string,
): Promise<Buffer> {
  return deps.db.transaction(async (tx) => {
    await lockEmployee(tx, employeeId);
    assertRenderable(year, localDate(new Date(), deps.config.appTz));
    const windows = await onlineW2Windows(tx, employeeId, windowToday, deps.config.appTz);
    if (!windows.some((w) => w.taxYear === year)) throw new VersionNotAvailableError();
    const v = (await onlineVersions(tx, employeeId, year, deps.config.appTz))[n - 1];
    if (!v?.frozen) throw new VersionNotAvailableError();
    const verified = await loadVerified(tx, employeeId, year, v);
    const txDeps = { db: tx, config: deps.config };
    const input = await w2InputFromFigures(
      txDeps,
      employeeId,
      year,
      verified.figures,
      frozenBox15(txDeps, verified),
    );
    return renderW2EmployeePacket(input, { corrected: v.corrected });
  });
}

/**
 * Admin Copy D of version `n` (any method, D-8): no window gate, never
 * marked, writes nothing. VersionNotAvailableError for an unknown n, a
 * never-furnished employee-year or an unfrozen version;
 * VersionUnreadableError on an integrity failure.
 */
export async function renderW2VersionCopyD(
  deps: Deps,
  employeeId: number,
  year: number,
  n: number,
): Promise<Buffer> {
  assertRenderable(year, localDate(new Date(), deps.config.appTz));
  const v = (await allVersions(deps.db, employeeId, year, deps.config.appTz))[n - 1];
  if (!v?.frozen) throw new VersionNotAvailableError();
  const verified = await loadVerified(deps.db, employeeId, year, v);
  const input = await w2InputFromFigures(
    deps,
    employeeId,
    year,
    verified.figures,
    frozenBox15(deps, verified),
  );
  return renderW2AdminCopyD(input);
}

/**
 * `?version=` of a W-2 PDF route: absent → null (the current figures); an
 * integer 1-50 written in plain digits → n; anything else (repeated,
 * signed, decimal, empty, out of range) → "invalid".
 */
export function parseVersionParam(query: unknown): number | null | "invalid" {
  const raw = (query as { version?: unknown } | null)?.version;
  if (raw === undefined) return null;
  if (typeof raw !== "string" || !/^\d{1,2}$/.test(raw)) return "invalid";
  const n = Number(raw);
  return n >= 1 && n <= 50 ? n : "invalid";
}

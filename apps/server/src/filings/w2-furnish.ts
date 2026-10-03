/**
 * PAY-206: W-2 furnishing record and CORRECTED employee copies — the flows.
 *
 * Rulings (federal-payroll-tax-sme, 2026-10-03): 2026 General Instructions
 * for Forms W-2 and W-3, p.28 — an error found after the W-2 went to the
 * employee but before it went to SSA: a new W-2 with the correct figures,
 * "CORRECTED" on the employee's new Copies B, C and 2; Copy A to SSA
 * unmarked. 26 CFR 31.6051-1(j)(5): electronic furnishing = posted +
 * notified, with consent.
 *
 * A W-2 counts as furnished from the earliest moment the employee could hold
 * a copy with those figures (w2_furnishings, append-only). Every furnishing
 * write runs in one transaction: lockEmployee → read the figures → insert
 * (R10). The figures hash never leaves the database.
 */

import { and, eq, inArray, isNotNull, isNull, like } from "drizzle-orm";
import {
  appSettings,
  auditEvents,
  emailOutbox,
  employees,
  taxFilings,
  w2DeliveryConsents,
  w2Furnishings,
} from "@payroll/db";
import { hasTemplate, type W2Input } from "@payroll/documents";
import { EVENT_TYPE, w2Changed as tplW2Changed } from "@payroll/notifications";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { templateContext } from "../notify/outbox.js";
import { lockEmployee, type Tx } from "../payroll/locks.js";
import { localDate } from "../payroll/run-dates.js";
import { AnnualFiguresDefectError, type W2BoxesCents } from "./w2-boxes.js";
import {
  employeeW2Figures,
  FormNotAvailableError,
  hasActiveW2Consent,
  isW2Available,
  isW2Blocked,
  MissingTaxConfigError,
  notifiedYears,
  readableBoxes,
  type W2Figures,
  w2AvailableOn,
  w2FiguresForYear,
  w2InputWithBoxes,
} from "./annual.js";
import {
  electronicW2AccessThrough,
  type FurnishingRow,
  furnishingRows,
  furnishingRowsByEmployee,
  furnishingState,
  isCorrected,
  recordFurnishing,
  w2BoxesHash,
} from "./w2-furnish-core.js";
import { errorClass, FilingServiceError, todayIso } from "./shared.js";
import { furnishCurrent } from "./w2-furnish-core.js";

export {
  type FurnishingRef,
  type FurnishingRow,
  type FurnishingState,
  type FurnishMethod,
  deliveryMethod,
  electronicW2AccessThrough,
  furnishCurrent,
  furnishingRows,
  furnishingState,
  isCorrected,
  latestRow,
  recordFurnishing,
  W2_HASH_VERSION,
  w2BoxesHash,
} from "./w2-furnish-core.js";

interface Deps {
  db: Db;
  config: AppConfig;
}

// ---------------------------------------------------------------------------
// Furnishing on render (employee download, admin print packet)
// ---------------------------------------------------------------------------

/**
 * R2/R7: build the employee packet input for the CURRENT figures and record
 * the furnishing BEFORE any byte leaves: lock → figures → insert, one
 * transaction. A failed insert fails the request; no copy leaves without a
 * record. Returns the input and whether the packet must say CORRECTED.
 */
export async function furnishForRender(
  deps: Deps,
  employeeId: number,
  year: number,
  furnishing: { method: "employee_download" | "admin_print"; actorId: string },
): Promise<{ input: W2Input; corrected: boolean }> {
  return deps.db.transaction(async (tx) => {
    await lockEmployee(tx, employeeId);
    const { input, boxes } = await w2InputWithBoxes(
      { db: tx, config: deps.config },
      employeeId,
      year,
      { requireBundledForm: true },
    );
    const { corrected } = await furnishCurrent(tx, {
      employeeId,
      taxYear: year,
      boxes,
      method: furnishing.method,
      actorId: furnishing.actorId,
    });
    return { input, corrected };
  });
}

/**
 * R8: the admin handed the employee the current W-2 on paper. Idempotent
 * while the figures stand: no new row (and no audit row) when the latest
 * paper_handed already carries them (review round D2). Throws the W-2
 * service errors (not_found, W2BlockedError, …); FormNotAvailableError
 * (409 form_not_available) when the year has no bundled W-2 form — no
 * paper copy can have been printed (D8).
 */
export async function markFurnishedOnPaper(
  deps: Deps,
  employeeId: number,
  year: number,
  actorId: string,
): Promise<{ corrected: boolean }> {
  return deps.db.transaction(async (tx) => {
    await lockEmployee(tx, employeeId);
    if (!isW2Available(year)) {
      throw new FilingServiceError(
        "invalid_transition",
        `W-2 for ${year} becomes available on ${w2AvailableOn(year)}`,
      );
    }
    if (!hasTemplate(year, "fw2")) throw new FormNotAvailableError(year);
    const boxes = readableBoxes(await employeeW2Figures(tx, employeeId, year));
    const { corrected, inserted } = await furnishCurrent(tx, {
      employeeId,
      taxYear: year,
      boxes,
      method: "paper_handed",
      actorId,
    });
    if (inserted) {
      await tx.insert(auditEvents).values({
        actorId,
        action: "w2_furnishing.paper_handed",
        entity: "employee",
        entityId: String(employeeId),
        before: null,
        after: { taxYear: year, corrected },
      });
    }
    return { corrected };
  });
}

// ---------------------------------------------------------------------------
// Read side (admin list, employee list)
// ---------------------------------------------------------------------------

/** How the latest furnishing reached the employee; "unknown" = backfill (D7). */
export type FurnishedVia = "none" | "online" | "printed" | "paper" | "unknown";

const VIA: Record<string, FurnishedVia> = {
  portal_notice: "online",
  employee_download: "online",
  backfill: "unknown",
  admin_print: "printed",
  paper_handed: "paper",
};

export interface FurnishingView {
  corrected: boolean;
  correctionToFurnish: boolean;
  furnished: FurnishedVia;
  /** Company-local (APP_TZ) date of the latest furnishing. */
  furnishedOn: string | null;
}

/** R8 list fields for one W-2 (a blocked W-2 is never "corrected"). */
function viewOf(
  f: W2Figures,
  year: number,
  rows: readonly FurnishingRow[],
  consented: boolean,
  appTz: string,
): FurnishingView {
  const blocked = isW2Blocked(f) || f.box1Cents === null;
  const state = blocked
    ? furnishingState(rows, "", { consented })
    : furnishingState(rows, w2BoxesHash(f.employeeId, year, f as W2BoxesCents), { consented });
  const latest = state.latest;
  return {
    corrected: !blocked && state.corrected,
    correctionToFurnish: !blocked && state.correctionToFurnish,
    furnished: latest ? (VIA[latest.method] ?? "unknown") : "none",
    furnishedOn: latest ? localDate(latest.furnishedAt, appTz) : null,
  };
}

/**
 * The employees whose delivery channel is electronic (D1): an active
 * (not withdrawn) consent AND a login.
 */
async function electronicChannel(
  db: Pick<Db, "select">,
  employeeIds: readonly number[],
): Promise<Set<number>> {
  if (employeeIds.length === 0) return new Set();
  const rows = await db
    .select({ employeeId: w2DeliveryConsents.employeeId })
    .from(w2DeliveryConsents)
    .innerJoin(employees, eq(employees.id, w2DeliveryConsents.employeeId))
    .where(
      and(
        inArray(w2DeliveryConsents.employeeId, [...employeeIds]),
        isNull(w2DeliveryConsents.withdrawnAt),
        isNotNull(employees.userId),
      ),
    );
  return new Set(rows.map((r) => r.employeeId));
}

/** R8: furnishing fields for every W-2 of the year, by employee. */
export async function furnishingViews(
  deps: Deps,
  year: number,
  figures: readonly W2Figures[],
): Promise<Map<number, FurnishingView>> {
  const ids = figures.map((f) => f.employeeId);
  const rows = await furnishingRowsByEmployee(deps.db, ids, year);
  const electronic = await electronicChannel(deps.db, ids);
  return new Map(
    figures.map((f) => [
      f.employeeId,
      viewOf(
        f,
        year,
        rows.get(f.employeeId) ?? [],
        electronic.has(f.employeeId),
        deps.config.appTz,
      ),
    ]),
  );
}

/** R7: the bare corrected flag of the employee's W-2 (false when not ready). */
export async function isMyW2Corrected(db: Db, employeeId: number, year: number): Promise<boolean> {
  const current = await currentHash(db, employeeId, year);
  if (current === null) return false;
  return isCorrected(await furnishingRows(db, employeeId, year), current);
}

/**
 * Review round D9 (26 CFR 31.6051-1(j)(3)(v)(C), (j)(6)): after consent is
 * withdrawn, a year furnished ELECTRONICALLY (a portal_notice or
 * employee_download row) stays downloadable through
 * electronicW2AccessThrough(year). backfill and admin_print rows never count.
 */
export async function electronicAccessAfterWithdrawal(
  db: Pick<Db, "select">,
  employeeId: number,
  year: number,
  today: string,
): Promise<boolean> {
  if (today > electronicW2AccessThrough(year)) return false;
  const rows = await db
    .select({ id: w2Furnishings.id })
    .from(w2Furnishings)
    .where(
      and(
        eq(w2Furnishings.employeeId, employeeId),
        eq(w2Furnishings.taxYear, year),
        inArray(w2Furnishings.method, ["portal_notice", "employee_download"]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** The current figures hash, or null (no W-2, blocked, or unreadable). */
async function currentHash(
  db: Pick<Db, "select">,
  employeeId: number,
  year: number,
): Promise<string | null> {
  let figures: W2Figures | undefined;
  try {
    figures = (await w2FiguresForYear(db, year)).find((f) => f.employeeId === employeeId);
  } catch (err) {
    if (err instanceof MissingTaxConfigError || err instanceof AnnualFiguresDefectError) {
      return null;
    }
    throw err;
  }
  if (!figures || isW2Blocked(figures) || figures.box1Cents === null) return null;
  return w2BoxesHash(employeeId, year, figures);
}

// ---------------------------------------------------------------------------
// R6: furnish a correction
// ---------------------------------------------------------------------------

export type CorrectionFollowUp = "w2_changed_notice_sent" | "w2_paper_correction_needed";

/** True when the year's W-2/W-3 was marked filed with SSA. */
async function w2w3Filed(db: Pick<Db, "select">, year: number): Promise<boolean> {
  const rows = await db
    .select({ id: taxFilings.id })
    .from(taxFilings)
    .where(
      and(
        eq(taxFilings.formType, "w2_w3"),
        eq(taxFilings.year, year),
        eq(taxFilings.quarter, 0),
        eq(taxFilings.status, "filed"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The paper courtesy mail, once per correction: the marker carries n = the
 * number of runs of equal hashes in id order, after dropping the trailing
 * rows that already carry the current figures (a reprint of the corrected
 * copy is not a new correction). Never a hash. n equals the count of
 * distinct furnished hashes until figures come back to an earlier hash —
 * then n still grows, so the return mails again (D2).
 */
async function sendPaperCourtesy(
  tx: Tx,
  config: AppConfig,
  userId: string,
  employeeId: number,
  year: number,
  rows: readonly FurnishingRow[],
  currentHash: string,
): Promise<void> {
  const ordered = [...rows].sort((x, y) => x.id - y.id);
  while (ordered.length > 0 && ordered[ordered.length - 1]!.boxesHash === currentHash) {
    ordered.pop();
  }
  const n = ordered.filter((r, i) => i === 0 || r.boxesHash !== ordered[i - 1]!.boxesHash).length;
  const marker = `<!-- w2-changed:${year}:${employeeId}:${n} -->`;
  const sent = await tx
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.eventType, EVENT_TYPE.w2Changed),
        eq(emailOutbox.userId, userId),
        like(emailOutbox.bodyHtml, `%${marker}%`),
      ),
    )
    .limit(1);
  if (sent.length > 0) return;
  const rendered = tplW2Changed(await templateContext(tx, config), {
    taxYear: year,
    consented: false,
  });
  await tx.insert(emailOutbox).values({
    userId,
    eventType: EVENT_TYPE.w2Changed,
    subject: rendered.subject,
    bodyHtml: `${rendered.html}${marker}`,
  });
}

/**
 * R6 + review round D1: when the employee may hold a copy with other figures
 * and the latest DELIVERY of their channel is not the current figures,
 * furnish the correction. Consent +
 * login → the w2_changed (consented) mail and a portal_notice furnishing
 * (corrected) → "w2_changed_notice_sent". Otherwise → paper: a courtesy mail
 * when there is a login → "w2_paper_correction_needed". Not furnished,
 * filed with SSA, blocked or not yet available → null. The caller holds the
 * employee lock in `tx`.
 */
export async function furnishCorrectionIfNeeded(
  tx: Tx,
  config: AppConfig,
  employeeId: number,
  taxYear: number,
  today: string = todayIso(),
): Promise<CorrectionFollowUp | null> {
  if (!isW2Available(taxYear, today)) return null;
  const rows = await furnishingRows(tx, employeeId, taxYear);
  if (rows.length === 0 || (await w2w3Filed(tx, taxYear))) return null;
  const hash = await currentHash(tx, employeeId, taxYear);
  if (hash === null) return null;
  const found = await tx.select().from(employees).where(eq(employees.id, employeeId)).limit(1);
  const employee = found[0];
  if (employee?.employmentType !== "w2") return null;
  const consented = employee.userId !== null && (await hasActiveW2Consent(tx, employeeId));
  if (!furnishingState(rows, hash, { consented }).correctionToFurnish) return null;
  if (consented && employee.userId) {
    const posted = await recordFurnishing(tx, {
      employeeId,
      taxYear,
      boxesHash: hash,
      corrected: true,
      method: "portal_notice",
      actorId: null,
    });
    // The latest notice already carries these figures (D2): never mail twice.
    if (!posted) return null;
    const rendered = tplW2Changed(await templateContext(tx, config), {
      taxYear,
      consented: true,
    });
    await tx.insert(emailOutbox).values({
      userId: employee.userId,
      eventType: EVENT_TYPE.w2Changed,
      subject: rendered.subject,
      bodyHtml: rendered.html,
    });
    return "w2_changed_notice_sent";
  }
  if (employee.userId) {
    await sendPaperCourtesy(tx, config, employee.userId, employeeId, taxYear, rows, hash);
  }
  return "w2_paper_correction_needed";
}

// ---------------------------------------------------------------------------
// Daily tick: reconcile + one-shot backfill
// ---------------------------------------------------------------------------

/** Log one failed employee-year by error class only (D5). */
function logFailure(step: string, year: number, err: unknown): void {
  console.error(`[filings] ${step}: one ${year} employee-year failed (${errorClass(err)})`);
}

/**
 * R6 caller 2 (daily, after syncAnnualFilings): every employee-year with a
 * furnishing in an available, unfiled year gets furnishCorrectionIfNeeded
 * under its own lock. Catches figure changes that are not an issue (e.g. a
 * tax_config edit). Idempotent: once the correction is furnished the latest
 * delivery equals the current figures. D5: one failing employee-year is
 * rolled back, logged by class and skipped; the others continue.
 */
export async function reconcileW2Furnishings(
  deps: Deps,
  opts: { today?: string } = {},
): Promise<{ checked: number; followUps: number; failed: number }> {
  const today = opts.today ?? localDate(new Date(), deps.config.appTz);
  const pairs = await deps.db
    .selectDistinct({ employeeId: w2Furnishings.employeeId, taxYear: w2Furnishings.taxYear })
    .from(w2Furnishings)
    .orderBy(w2Furnishings.taxYear, w2Furnishings.employeeId);
  let checked = 0;
  let followUps = 0;
  let failed = 0;
  for (const { employeeId, taxYear } of pairs) {
    if (!isW2Available(taxYear, today)) continue;
    checked += 1;
    try {
      const code = await deps.db.transaction(async (tx) => {
        await lockEmployee(tx, employeeId);
        return furnishCorrectionIfNeeded(tx, deps.config, employeeId, taxYear, today);
      });
      if (code) followUps += 1;
    } catch (err) {
      failed += 1;
      logFailure("W-2 reconcile", taxYear, err);
    }
  }
  return { checked, followUps, failed };
}

const BACKFILLED_KEY = "w2_furnishings_backfilled";

/** The W-2 figures of a year, or [] when its config/figures cannot be read. */
async function figuresOrNone(db: Pick<Db, "select">, year: number): Promise<W2Figures[]> {
  try {
    return await w2FiguresForYear(db, year);
  } catch (err) {
    if (err instanceof MissingTaxConfigError || err instanceof AnnualFiguresDefectError) return [];
    throw err;
  }
}

/**
 * One backfill row for the employee-year when it has none. The caller holds
 * the employee lock in `tx`.
 */
async function backfillOneInTx(tx: Tx, employeeId: number, year: number): Promise<boolean> {
  const figures = (await figuresOrNone(tx, year)).find((f) => f.employeeId === employeeId);
  if (!figures || isW2Blocked(figures) || figures.box1Cents === null) return false;
  if ((await furnishingRows(tx, employeeId, year)).length > 0) return false;
  return recordFurnishing(tx, {
    employeeId,
    taxYear: year,
    boxesHash: w2BoxesHash(employeeId, year, figures),
    corrected: false,
    method: "backfill",
    actorId: null,
  });
}

/** True once the one-shot backfill ran. */
async function backfillDone(db: Pick<Db, "select">): Promise<boolean> {
  const flag = await db
    .select({ key: appSettings.key })
    .from(appSettings)
    .where(eq(appSettings.key, BACKFILLED_KEY))
    .limit(1);
  return flag.length > 0;
}

/** Years the backfill covers on `today`: notified by the previous release, available, unfiled. */
async function backfillYear(db: Pick<Db, "select">, year: number, today: string) {
  return (
    isW2Available(year, today) &&
    (await notifiedYears(db)).includes(year) &&
    !(await w2w3Filed(db, year))
  );
}

/**
 * Review round D4 (lazy): while the one-shot backfill has not run, a late
 * issue in a year the previous release notified first backfills its own
 * employee-year — with the figures BEFORE the run is issued, so the issue is
 * a detected correction. Call before the run's status changes, holding the
 * employee lock in `tx`. The flag is left to the one-shot backfill.
 */
export async function backfillEmployeeYearIfNeeded(
  tx: Tx,
  employeeId: number,
  year: number,
  today: string,
): Promise<boolean> {
  if (await backfillDone(tx)) return false;
  if (!(await backfillYear(tx, year, today))) return false;
  return backfillOneInTx(tx, employeeId, year);
}

/**
 * R9 (one-shot; at boot and on the daily tick, D4): years the previous
 * release notified (notifiedYears) and not filed with SSA get one backfill
 * row per non-blocked W-2 employee without a furnishing; then the flag is
 * set and later calls do nothing. Safe: before this release no path changed
 * a notified year's figures. D5: a failing employee-year is rolled back,
 * logged by class and skipped. The flag is set only when none failed, so a
 * later call retries the failures.
 */
export async function backfillW2Furnishings(
  deps: Deps,
  opts: { today?: string } = {},
): Promise<{ inserted: number; skipped: boolean; failed: number }> {
  const { db } = deps;
  if (await backfillDone(db)) return { inserted: 0, skipped: true, failed: 0 };
  const today = opts.today ?? localDate(new Date(), deps.config.appTz);
  let inserted = 0;
  let failed = 0;
  for (const year of await notifiedYears(db)) {
    if (!(await backfillYear(db, year, today))) continue;
    for (const f of await figuresOrNone(db, year)) {
      try {
        const wrote = await db.transaction(async (tx) => {
          await lockEmployee(tx, f.employeeId);
          return backfillOneInTx(tx, f.employeeId, year);
        });
        if (wrote) inserted += 1;
      } catch (err) {
        failed += 1;
        logFailure("W-2 furnishing backfill", year, err);
      }
    }
  }
  if (failed === 0) {
    await db
      .insert(appSettings)
      .values({ key: BACKFILLED_KEY, value: { at: today, inserted }, updatedAt: new Date() })
      .onConflictDoNothing({ target: [appSettings.key] });
  }
  return { inserted, skipped: false, failed };
}

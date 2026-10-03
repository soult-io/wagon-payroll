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

import { and, eq, like } from "drizzle-orm";
import {
  appSettings,
  auditEvents,
  emailOutbox,
  employees,
  taxFilings,
  w2Furnishings,
} from "@payroll/db";
import type { W2Input } from "@payroll/documents";
import { EVENT_TYPE, w2Changed as tplW2Changed } from "@payroll/notifications";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { templateContext } from "../notify/outbox.js";
import { lockEmployee, type Tx } from "../payroll/locks.js";
import { localDate } from "../payroll/run-dates.js";
import { AnnualFiguresDefectError, type W2BoxesCents } from "./w2-boxes.js";
import {
  employeeW2Figures,
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
  type FurnishingRow,
  furnishCurrent,
  furnishingRows,
  furnishingRowsByEmployee,
  furnishingState,
  recordFurnishing,
  w2BoxesHash,
} from "./w2-furnish-core.js";
import { FilingServiceError, todayIso } from "./shared.js";

export {
  type FurnishingRef,
  type FurnishingRow,
  type FurnishingState,
  type FurnishMethod,
  furnishCurrent,
  furnishingRows,
  furnishingState,
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
      {
        requireBundledForm: true,
      },
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
 * R8: the admin handed the employee the current W-2 on paper. Idempotent:
 * one row and one audit row (w2_furnishing.paper_handed) per figures.
 * Throws the W-2 service errors (not_found, W2BlockedError, …).
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

export type FurnishedVia = "none" | "online" | "printed" | "paper";

const VIA: Record<string, FurnishedVia> = {
  portal_notice: "online",
  employee_download: "online",
  backfill: "online",
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
  appTz: string,
): FurnishingView {
  const blocked = isW2Blocked(f) || f.box1Cents === null;
  const state = blocked
    ? furnishingState(rows, "")
    : furnishingState(rows, w2BoxesHash(f.employeeId, year, f as W2BoxesCents));
  const latest = state.latest;
  return {
    corrected: !blocked && state.corrected,
    correctionToFurnish: !blocked && state.correctionToFurnish,
    furnished: latest ? (VIA[latest.method] ?? "online") : "none",
    furnishedOn: latest ? localDate(latest.furnishedAt, appTz) : null,
  };
}

/** R8: furnishing fields for every W-2 of the year, by employee. */
export async function furnishingViews(
  deps: Deps,
  year: number,
  figures: readonly W2Figures[],
): Promise<Map<number, FurnishingView>> {
  const rows = await furnishingRowsByEmployee(
    deps.db,
    figures.map((f) => f.employeeId),
    year,
  );
  return new Map(
    figures.map((f) => [
      f.employeeId,
      viewOf(f, year, rows.get(f.employeeId) ?? [], deps.config.appTz),
    ]),
  );
}

/** R7: the bare corrected flag of the employee's W-2 (false when not ready). */
export async function isMyW2Corrected(db: Db, employeeId: number, year: number): Promise<boolean> {
  const current = await currentHash(db, employeeId, year);
  if (current === null) return false;
  return furnishingState(await furnishingRows(db, employeeId, year), current).corrected;
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
 * The paper courtesy mail, once per furnished state: the marker counts the
 * distinct furnished hashes (never the hash itself).
 */
async function sendPaperCourtesy(
  tx: Tx,
  config: AppConfig,
  userId: string,
  employeeId: number,
  year: number,
  rows: readonly FurnishingRow[],
): Promise<void> {
  const n = new Set(rows.map((r) => r.boxesHash)).size;
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
 * R6: when the employee may hold a copy with other figures and the latest
 * furnishing is not the current figures, furnish the correction. Consent +
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
  if (hash === null || !furnishingState(rows, hash).correctionToFurnish) return null;
  const found = await tx.select().from(employees).where(eq(employees.id, employeeId)).limit(1);
  const employee = found[0];
  if (employee?.employmentType !== "w2") return null;
  if (employee.userId && (await hasActiveW2Consent(tx, employeeId))) {
    const posted = await recordFurnishing(tx, {
      employeeId,
      taxYear,
      boxesHash: hash,
      corrected: true,
      method: "portal_notice",
      actorId: null,
    });
    // These figures were already posted and notified once (they came back):
    // the employee was told; never mail the same figures twice.
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
    await sendPaperCourtesy(tx, config, employee.userId, employeeId, taxYear, rows);
  }
  return "w2_paper_correction_needed";
}

// ---------------------------------------------------------------------------
// Daily tick: reconcile + one-shot backfill
// ---------------------------------------------------------------------------

/**
 * R6 caller 2 (daily, after syncAnnualFilings): every employee-year with a
 * furnishing in an available, unfiled year gets furnishCorrectionIfNeeded
 * under its own lock. Catches figure changes that are not an issue (e.g. a
 * tax_config edit). Idempotent: once the correction is furnished the latest
 * row equals the current figures.
 */
export async function reconcileW2Furnishings(
  deps: Deps,
  opts: { today?: string } = {},
): Promise<{ checked: number; followUps: number }> {
  const today = opts.today ?? todayIso();
  const pairs = await deps.db
    .selectDistinct({ employeeId: w2Furnishings.employeeId, taxYear: w2Furnishings.taxYear })
    .from(w2Furnishings)
    .orderBy(w2Furnishings.taxYear, w2Furnishings.employeeId);
  let checked = 0;
  let followUps = 0;
  for (const { employeeId, taxYear } of pairs) {
    if (!isW2Available(taxYear, today)) continue;
    checked += 1;
    const code = await deps.db.transaction(async (tx) => {
      await lockEmployee(tx, employeeId);
      return furnishCorrectionIfNeeded(tx, deps.config, employeeId, taxYear, today);
    });
    if (code) followUps += 1;
  }
  return { checked, followUps };
}

const BACKFILLED_KEY = "w2_furnishings_backfilled";

/** The W-2 figures of a year, or [] when its config/figures cannot be read. */
async function figuresOrNone(db: Db, year: number): Promise<W2Figures[]> {
  try {
    return await w2FiguresForYear(db, year);
  } catch (err) {
    if (err instanceof MissingTaxConfigError || err instanceof AnnualFiguresDefectError) return [];
    throw err;
  }
}

/** One backfill row, under the employee lock, only when the employee-year has none. */
async function backfillOne(deps: Deps, employeeId: number, year: number): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    await lockEmployee(tx, employeeId);
    const figures = (await w2FiguresForYear(tx, year)).find((f) => f.employeeId === employeeId);
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
  });
}

/**
 * R9 (one-shot): years the previous release notified (notifiedYears) and
 * not filed with SSA get one backfill row per non-blocked W-2 employee
 * without a furnishing; then the flag is set and later ticks do nothing.
 * Safe: before this release no path changed a notified year's figures.
 */
export async function backfillW2Furnishings(
  deps: Deps,
  opts: { today?: string } = {},
): Promise<{ inserted: number; skipped: boolean }> {
  const { db } = deps;
  const flag = await db
    .select({ key: appSettings.key })
    .from(appSettings)
    .where(eq(appSettings.key, BACKFILLED_KEY))
    .limit(1);
  if (flag.length > 0) return { inserted: 0, skipped: true };
  const today = opts.today ?? todayIso();
  let inserted = 0;
  for (const year of await notifiedYears(db)) {
    if (!isW2Available(year, today) || (await w2w3Filed(db, year))) continue;
    for (const f of await figuresOrNone(db, year)) {
      if (await backfillOne(deps, f.employeeId, year)) inserted += 1;
    }
  }
  await db
    .insert(appSettings)
    .values({ key: BACKFILLED_KEY, value: { at: today, inserted }, updatedAt: new Date() })
    .onConflictDoNothing({ target: [appSettings.key] });
  return { inserted, skipped: false };
}

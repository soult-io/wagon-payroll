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

import { and, desc, eq, gte, inArray, like, or } from "drizzle-orm";
import {
  appSettings,
  auditEvents,
  emailOutbox,
  employees,
  taxFilings,
  w2DeliveryConsents,
  w2Furnishings,
} from "@payroll/db";
import { hasTemplate, renderW2EmployeePacket } from "@payroll/documents";
import { EVENT_TYPE, w2Changed as tplW2Changed } from "@payroll/notifications";
import { STATE_ID_MIN_YEAR } from "@payroll/shared";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { templateContext } from "../notify/outbox.js";
import { lockEmployee, type Tx } from "../payroll/locks.js";
import { localDate } from "../payroll/run-dates.js";
import { AnnualFiguresDefectError } from "./w2-boxes.js";
import {
  employeeW2Figures,
  FormNotAvailableError,
  isW2Available,
  isW2Blocked,
  MissingTaxConfigError,
  notifiedYears,
  readableBoxes,
  type ReadableW2Figures,
  type W2Figures,
  w2AvailableOn,
  w2FiguresForYear,
  w2InputWithBoxes,
  w2StateLinesByEmployee,
} from "./annual.js";
import {
  electronicW2AccessThrough,
  type FurnishingRow,
  furnishingRows,
  furnishingRowsByEmployee,
  furnishingState,
  hashVersionFor,
  isCorrected,
  recordFurnishing,
  w2FiguresHash,
} from "./w2-furnish-core.js";
import { errorClass, FilingServiceError, todayIso } from "./shared.js";
import { consentCoversYear, consentRowOf, electronicW2Channel } from "./w2-consent.js";
import { furnishCurrent } from "./w2-furnish-core.js";

export {
  type FurnishingRef,
  type FurnishingRow,
  type FurnishingState,
  type FurnishMethod,
  electronicW2AccessThrough,
  furnishCurrent,
  furnishingRows,
  furnishingState,
  hashVersionFor,
  isCorrected,
  latestRow,
  recordFurnishing,
  W2_HASH_VERSION,
  w2BoxesHash,
  w2FiguresHash,
} from "./w2-furnish-core.js";

interface Deps {
  db: Db;
  config: AppConfig;
}

// ---------------------------------------------------------------------------
// Furnishing on render (employee download, admin print packet)
// ---------------------------------------------------------------------------

/**
 * R2/R7: build the employee packet for the CURRENT figures, record the
 * furnishing and render the PDF in ONE transaction: lock → figures → insert
 * → render. The row commits only when the PDF bytes exist (PR-3 R2): a
 * render failure rolls the row back, and no copy leaves without a record.
 * Rendering takes no lock, so the lock order (employee advisory lock →
 * FILING_CLOSE_LOCK → SYNC_LOCK) is unchanged; the employee lock is held for
 * the render (about a second). CORRECTED when the employee may hold a copy
 * with other figures.
 */
export async function furnishAndRender(
  deps: Deps,
  employeeId: number,
  year: number,
  furnishing: { method: "employee_download" | "admin_print"; actorId: string },
): Promise<Buffer> {
  return deps.db.transaction(async (tx) => {
    await lockEmployee(tx, employeeId);
    const { input, boxes } = await w2InputWithBoxes(
      { db: tx, config: deps.config },
      employeeId,
      year,
      // PAY-208: the January gate on the company-local date, like the list.
      { requireBundledForm: true, today: localDate(new Date(), deps.config.appTz) },
    );
    const { corrected } = await furnishCurrent(tx, {
      employeeId,
      taxYear: year,
      figures: boxes,
      method: furnishing.method,
      actorId: furnishing.actorId,
    });
    return renderW2EmployeePacket(input, { corrected });
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
    const figures = readableBoxes(await employeeW2Figures(tx, employeeId, year));
    const { corrected, inserted } = await furnishCurrent(tx, {
      employeeId,
      taxYear: year,
      figures,
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
  channel: { consented: boolean; electronicUntil: Date | null },
  appTz: string,
): FurnishingView {
  const blocked = isW2Blocked(f) || f.box1Cents === null;
  const version = hashVersionFor(year);
  const opts = { ...channel, version };
  const state = blocked
    ? furnishingState(rows, "", opts)
    : furnishingState(rows, w2FiguresHash(f.employeeId, year, f as ReadableW2Figures), opts);
  const latest = state.latest;
  return {
    corrected: !blocked && state.corrected,
    correctionToFurnish: !blocked && state.correctionToFurnish,
    furnished: latest ? (VIA[latest.method] ?? "unknown") : "none",
    furnishedOn: latest ? localDate(latest.furnishedAt, appTz) : null,
  };
}

/** R8: furnishing fields for every W-2 of the year, by employee. */
export async function furnishingViews(
  deps: Deps,
  year: number,
  figures: readonly W2Figures[],
): Promise<Map<number, FurnishingView>> {
  const ids = figures.map((f) => f.employeeId);
  const rows = await furnishingRowsByEmployee(deps.db, ids, year);
  const electronic = await electronicW2Channel(deps.db, ids, year);
  const withdrawn = await withdrawalTimes(deps.db, ids);
  return new Map(
    figures.map((f) => {
      const consented = electronic.has(f.employeeId);
      const electronicUntil = consented ? null : (withdrawn.get(f.employeeId) ?? null);
      return [
        f.employeeId,
        viewOf(
          f,
          year,
          rows.get(f.employeeId) ?? [],
          { consented, electronicUntil },
          deps.config.appTz,
        ),
      ];
    }),
  );
}

/** The withdrawal time of every withdrawn consent among `ids`. */
async function withdrawalTimes(
  db: Pick<Db, "select">,
  ids: readonly number[],
): Promise<Map<number, Date>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      employeeId: w2DeliveryConsents.employeeId,
      withdrawnAt: w2DeliveryConsents.withdrawnAt,
    })
    .from(w2DeliveryConsents)
    .where(inArray(w2DeliveryConsents.employeeId, [...ids]));
  return new Map(
    rows.flatMap((r) => (r.withdrawnAt === null ? [] : [[r.employeeId, r.withdrawnAt] as const])),
  );
}

/**
 * PAY-208 (26 CFR 31.6051-1(j)(5)(ii)): employees whose CONSENTED notice for
 * `year` (the w2_available legal notice or a corrected w2_changed notice —
 * both carry the IMPORTANT subject) ended 'failed' in the outbox, with the
 * company-local date of the failed attempt (N4). An employee drops off once
 * a paper_handed or admin_print furnishing of the year is recorded AFTER
 * that failure. Names only: no address, no amounts. Sorted by name.
 */
export async function undeliveredW2Notices(
  db: Pick<Db, "select">,
  year: number,
  appTz: string,
): Promise<{ employeeId: number; legalName: string; failedOn: string }[]> {
  const important = "IMPORTANT TAX RETURN DOCUMENT AVAILABLE: Your";
  const failures = await db
    .select({
      employeeId: employees.id,
      legalName: employees.legalName,
      lastAttemptAt: emailOutbox.lastAttemptAt,
      createdAt: emailOutbox.createdAt,
    })
    .from(emailOutbox)
    .innerJoin(employees, eq(employees.userId, emailOutbox.userId))
    .where(
      and(
        eq(emailOutbox.status, "failed"),
        inArray(emailOutbox.eventType, [EVENT_TYPE.w2Available, EVENT_TYPE.w2Changed]),
        or(
          like(emailOutbox.subject, `${important} ${year} W-2 from %`),
          like(emailOutbox.subject, `${important} corrected ${year} W-2 from %`),
        ),
      ),
    );
  if (failures.length === 0) return [];
  const latest = new Map<number, { legalName: string; at: Date }>();
  for (const f of failures) {
    const at = f.lastAttemptAt ?? f.createdAt;
    if (at === null) continue;
    const seen = latest.get(f.employeeId);
    if (!seen || at.getTime() > seen.at.getTime()) {
      latest.set(f.employeeId, { legalName: f.legalName, at });
    }
  }
  const paper = await db
    .select({ employeeId: w2Furnishings.employeeId, furnishedAt: w2Furnishings.furnishedAt })
    .from(w2Furnishings)
    .where(
      and(
        inArray(w2Furnishings.employeeId, [...latest.keys()]),
        eq(w2Furnishings.taxYear, year),
        inArray(w2Furnishings.method, ["paper_handed", "admin_print"]),
      ),
    );
  const out: { employeeId: number; legalName: string; failedOn: string }[] = [];
  for (const [employeeId, f] of latest) {
    const answered = paper.some(
      (p) => p.employeeId === employeeId && p.furnishedAt.getTime() > f.at.getTime(),
    );
    if (!answered) {
      out.push({ employeeId, legalName: f.legalName, failedOn: localDate(f.at, appTz) });
    }
  }
  return out.sort((a, b) =>
    a.legalName < b.legalName ? -1 : a.legalName > b.legalName ? 1 : a.employeeId - b.employeeId,
  );
}

/** R7: the bare corrected flag of the employee's W-2 (false when not ready). */
export async function isMyW2Corrected(db: Db, employeeId: number, year: number): Promise<boolean> {
  const current = await currentHash(db, employeeId, year);
  if (current === null) return false;
  return isCorrected(await furnishingRows(db, employeeId, year), current, hashVersionFor(year));
}

/**
 * Review round D9 (26 CFR 31.6051-1(j)(3)(v)(C), (j)(6)) + PAY-208: when the
 * consent does not cover the year (withdrawn, or on earlier terms), a year
 * furnished ELECTRONICALLY (a portal_notice or employee_download row) stays
 * downloadable through its access window: electronicW2AccessThrough(year),
 * or 90 days after the latest CORRECTED portal_notice when that is later
 * ((j)(6), 2nd sentence; company-local date of the posting). backfill and
 * admin_print rows never count.
 */
export async function electronicAccessAlreadyFurnished(
  db: Pick<Db, "select">,
  employeeId: number,
  year: number,
  today: string,
  appTz: string,
): Promise<boolean> {
  const rows = await onlineRows(db, employeeId, year);
  if (rows.length === 0) return false;
  return today <= electronicW2AccessThrough(year, latestCorrectedPostedOn(rows, appTz));
}

/** The year's portal_notice / employee_download rows of one employee. */
async function onlineRows(db: Pick<Db, "select">, employeeId: number, year: number) {
  return db
    .select({
      furnishedAt: w2Furnishings.furnishedAt,
      corrected: w2Furnishings.corrected,
      method: w2Furnishings.method,
    })
    .from(w2Furnishings)
    .where(
      and(
        eq(w2Furnishings.employeeId, employeeId),
        eq(w2Furnishings.taxYear, year),
        inArray(w2Furnishings.method, ["portal_notice", "employee_download"]),
      ),
    )
    .orderBy(desc(w2Furnishings.furnishedAt));
}

/** Company-local date of the latest CORRECTED portal_notice, or null. */
function latestCorrectedPostedOn(
  rows: readonly { furnishedAt: Date; corrected: boolean; method: string }[],
  appTz: string,
): string | null {
  let latest: Date | null = null;
  for (const r of rows) {
    if (r.method !== "portal_notice" || !r.corrected) continue;
    if (latest === null || r.furnishedAt.getTime() > latest.getTime()) latest = r.furnishedAt;
  }
  return latest === null ? null : localDate(latest, appTz);
}

/**
 * PAY-208 (N1, (j)(6)): the last day the employee's W-2 of `year` stays
 * online — October 15 of the next year, or 90 days after the latest
 * corrected posting when that is later.
 */
export async function w2AccessThrough(
  db: Pick<Db, "select">,
  employeeId: number,
  year: number,
  appTz: string,
): Promise<string> {
  return electronicW2AccessThrough(
    year,
    latestCorrectedPostedOn(await onlineRows(db, employeeId, year), appTz),
  );
}

/** The current figures hash, or null (no W-2, blocked, or unreadable). */
async function currentHash(
  db: Pick<Db, "select">,
  employeeId: number,
  year: number,
): Promise<string | null> {
  const figures = await printableFigures(db, employeeId, year);
  return figures === null ? null : w2FiguresHash(employeeId, year, figures);
}

/**
 * The employee-year's figures when its W-2 can be furnished, else null (no
 * W-2, unreadable figures or config, or any block issue). Read through
 * employeeW2Figures, so the PR-3 render checks (state_id_unreadable,
 * ein_unreadable, state_id_too_long) hold the correction and backfill paths
 * like every other furnishing path (round 3 H1).
 */
async function printableFigures(
  db: Pick<Db, "select">,
  employeeId: number,
  year: number,
): Promise<ReadableW2Figures | null> {
  let figures: W2Figures;
  try {
    figures = await employeeW2Figures(db, employeeId, year);
  } catch (err) {
    if (err instanceof MissingTaxConfigError || err instanceof AnnualFiguresDefectError) {
      return null;
    }
    if (err instanceof FilingServiceError && err.code === "not_found") return null;
    throw err;
  }
  if (isW2Blocked(figures) || figures.box1Cents === null) return null;
  return figures as ReadableW2Figures;
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
 * PAY-208 (federal SME ruling 2026-10-04): the employee withdrew AFTER the
 * year's W-2 was posted online under a consent that covered the year, is
 * still active with a login (N3: a portal_notice or an employee_download
 * before the withdrawal) — a correction is then posted online too (with
 * the IMPORTANT notice) and, because they withdrew, also owed on paper
 * (correctionToFurnish stays set until paper_handed).
 */
function withdrewAfterOnlineFurnishing(
  rows: readonly FurnishingRow[],
  withdrawnAt: Date,
  consent: { disclosureVersion: string; withdrawnAt: Date | null } | undefined,
  taxYear: number,
  employee: { userId: string | null; status: string },
): boolean {
  if (consent === undefined || employee.userId === null || employee.status !== "active") {
    return false;
  }
  if (!consentCoversYear({ ...consent, withdrawnAt: null }, taxYear)) return false;
  // N3: a download is online furnishing too.
  return rows.some(
    (r) =>
      (r.method === "portal_notice" || r.method === "employee_download") &&
      r.furnishedAt.getTime() < withdrawnAt.getTime(),
  );
}

/**
 * R6 + review round D1: when the employee may hold a copy with other figures
 * and the latest DELIVERY of their channel is not the current figures,
 * furnish the correction. The electronic channel of the year (PAY-208:
 * electronicW2Channel(…, taxYear)) → the w2_changed (consented) mail and a
 * portal_notice furnishing (corrected) → "w2_changed_notice_sent"; so does
 * an employee who withdrew after the online W-2 (withdrewAfterOnlineFurnishing),
 * whose correction is then also owed on paper. Otherwise → paper: a courtesy mail
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
  const consented = (await electronicW2Channel(tx, [employeeId], taxYear)).has(employeeId);
  const consent = await consentRowOf(tx, employeeId);
  const withdrawnAt = consented ? null : (consent?.withdrawnAt ?? null);
  const version = hashVersionFor(taxYear);
  const state = furnishingState(rows, hash, { consented, version, electronicUntil: withdrawnAt });
  if (!state.correctionToFurnish) return null;
  const postOnline =
    consented ||
    (withdrawnAt !== null &&
      withdrewAfterOnlineFurnishing(rows, withdrawnAt, consent, taxYear, employee) &&
      // C-L7: inside the window, extended by the latest corrected posting.
      today <= electronicW2AccessThrough(taxYear, latestCorrectedPostedOn(rows, config.appTz)));
  if (postOnline && employee.userId) {
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
    // N2: posted today — online through the later of Oct 15 and today + 90 days.
    const rendered = tplW2Changed(await templateContext(tx, config), {
      taxYear,
      consented: true,
      accessThrough: electronicW2AccessThrough(taxYear, today),
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

/**
 * One backfill row for the employee-year when it has none and its W-2 can be
 * furnished (printableFigures: render checks included). The caller holds
 * the employee lock in `tx`.
 */
async function backfillOneInTx(tx: Tx, employeeId: number, year: number): Promise<boolean> {
  const figures = await printableFigures(tx, employeeId, year);
  if (figures === null) return false;
  if ((await furnishingRows(tx, employeeId, year)).length > 0) return false;
  return recordFurnishing(tx, {
    employeeId,
    taxYear: year,
    boxesHash: w2FiguresHash(employeeId, year, figures),
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
 * The backfill of one year, each employee-year in its own transaction (D5).
 * Round 3 R3: a year whose figures cannot be read is one failure, not an
 * empty year — the caller then leaves the flag unset so a later call retries.
 */
async function backfillOneYear(
  db: Db,
  year: number,
): Promise<{ inserted: number; failed: number }> {
  let figures: W2Figures[];
  try {
    figures = await w2FiguresForYear(db, year);
  } catch (err) {
    if (!(err instanceof MissingTaxConfigError || err instanceof AnnualFiguresDefectError)) {
      throw err;
    }
    logFailure("W-2 furnishing backfill", year, err);
    return { inserted: 0, failed: 1 };
  }
  let inserted = 0;
  let failed = 0;
  for (const f of figures) {
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
  return { inserted, failed };
}

/**
 * R9 (one-shot; at boot and on the daily tick, D4): years the previous
 * release notified (notifiedYears) and not filed with SSA get one backfill
 * row per non-blocked W-2 employee without a furnishing; then the flag is
 * set and later calls do nothing. Safe: before this release no path changed
 * a notified year's figures. D5: a failing employee-year is rolled back,
 * logged by class and skipped; a year whose figures cannot be read counts as
 * failed (round 3 R3). The flag is set only when none failed, so a later
 * call retries the failures.
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
    const out = await backfillOneYear(db, year);
    inserted += out.inserted;
    failed += out.failed;
  }
  if (failed === 0) {
    await db
      .insert(appSettings)
      .values({ key: BACKFILLED_KEY, value: { at: today, inserted }, updatedAt: new Date() })
      .onConflictDoNothing({ target: [appSettings.key] });
  }
  return { inserted, skipped: false, failed };
}

// ---------------------------------------------------------------------------
// Spec 24 (PAY-116) PR-4: who already holds a W-2 with a state's number
// ---------------------------------------------------------------------------

/** Employees already given a W-2 of `taxYear` that has a `stateCode` line (a count only). */
export interface FurnishedStateCount {
  stateCode: string;
  taxYear: number;
  employees: number;
}

/**
 * Spec 24 (PAY-116) PR-4 (carry-over f): per unfiled w2_w3 tax year from
 * STATE_ID_MIN_YEAR with any furnishing row, and per state on those
 * employees' current W-2 lines, the number of distinct furnished employees
 * whose W-2 has a line for that state. Counts only — no names, no ids.
 * A filed year is left out (its state IDs can no longer change). A year
 * whose state lines cannot be planned is skipped with a fixed-message log
 * (the other years still count); a database error on the furnishing or
 * filing reads propagates. Sorted by state code (code-point), then year.
 */
export async function furnishedStateCounts(
  db: Pick<Db, "select" | "selectDistinct">,
): Promise<FurnishedStateCount[]> {
  const out: FurnishedStateCount[] = [];
  for (const [taxYear, ids] of await furnishedByOpenYear(db)) {
    out.push(...(await stateCountsForYear(db, taxYear, ids)));
  }
  return out.sort(
    (a, b) =>
      (a.stateCode < b.stateCode ? -1 : a.stateCode > b.stateCode ? 1 : 0) || a.taxYear - b.taxYear,
  );
}

/** Furnished employee ids per unfiled tax year from STATE_ID_MIN_YEAR. */
async function furnishedByOpenYear(
  db: Pick<Db, "select" | "selectDistinct">,
): Promise<Map<number, Set<number>>> {
  const byYear = new Map<number, Set<number>>();
  const furnished = await db
    .selectDistinct({ employeeId: w2Furnishings.employeeId, taxYear: w2Furnishings.taxYear })
    .from(w2Furnishings)
    .where(gte(w2Furnishings.taxYear, STATE_ID_MIN_YEAR));
  if (furnished.length === 0) return byYear;
  const filed = await db
    .select({ year: taxFilings.year })
    .from(taxFilings)
    .where(
      and(
        eq(taxFilings.formType, "w2_w3"),
        eq(taxFilings.quarter, 0),
        eq(taxFilings.status, "filed"),
      ),
    );
  const filedYears = new Set(filed.map((f) => f.year));
  for (const r of furnished) {
    if (filedYears.has(r.taxYear)) continue;
    byYear.set(r.taxYear, (byYear.get(r.taxYear) ?? new Set()).add(r.employeeId));
  }
  return byYear;
}

/** Per state, how many of `ids` have a W-2 line for it in `taxYear`; [] when the year cannot be planned. */
async function stateCountsForYear(
  db: Pick<Db, "select">,
  taxYear: number,
  ids: ReadonlySet<number>,
): Promise<FurnishedStateCount[]> {
  let lines: Awaited<ReturnType<typeof w2StateLinesByEmployee>>;
  try {
    lines = await w2StateLinesByEmployee(db, taxYear);
  } catch {
    console.warn("[state-ids] furnished: one year's W-2 state lines could not be planned");
    return [];
  }
  const perState = new Map<string, number>();
  for (const id of ids) {
    for (const state of new Set((lines.get(id) ?? []).map((l) => l.state))) {
      perState.set(state, (perState.get(state) ?? 0) + 1);
    }
  }
  return [...perState].map(([stateCode, employees]) => ({ stateCode, taxYear, employees }));
}

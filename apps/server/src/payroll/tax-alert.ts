/**
 * PAY-103 R18: the missing-tax-tables alert.
 *
 * When the installed tax tables do not cover a payroll year (the one
 * definition: taxTableCoverage), admins are told once per (year,
 * jurisdiction): an `audit_events` row is the dedupe key and the record, and
 * one `email_outbox` row per non-banned admin carries the email
 * (`tax_tables_missing`, a toggleable admin workflow event — the outbox drain
 * suppresses it for an admin who turned it off).
 *
 * Callers: the draft tick (for the pay-date year of the period it drafts) and
 * the daily deposit tick (today's year, plus next year from Dec 1, APP_TZ).
 * Logs carry years, USPS codes, counts and error class names only.
 */

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { auditEvents, authUser, emailOutbox } from "@payroll/db";
import { EVENT_TYPE, taxTablesMissing as tplTaxTablesMissing } from "@payroll/notifications";
import { stateName } from "@payroll/shared";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { templateContext } from "../notify/outbox.js";
import { errorClass } from "../filings/shared.js";
import { localDate } from "./run-dates.js";
import { isCovered, taxTableCoverage, type TaxTableCoverage } from "./tax-coverage.js";

/**
 * Serialises the dedupe read + insert: the draft tick and the daily tick can
 * overlap on pg-boss retries.
 */
export const TAX_TABLES_MISSING_LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('tax_tables_missing_alert'))`;

const ACTION = "tax_tables.missing";
const FEDERAL = "federal";

/**
 * The years whose coverage matters on `today` (YYYY-MM-DD, APP_TZ): the
 * current year, plus next year from Dec 1. Shared by the daily check and the
 * admin coverage endpoint.
 */
export function coverageYears(today: string): number[] {
  const year = Number(today.slice(0, 4));
  return today.slice(5) >= "12-01" ? [year, year + 1] : [year];
}

/** The jurisdiction codes a coverage result reports missing: federal first, then USPS codes. */
export function missingCodes(c: TaxTableCoverage): string[] {
  return [...(c.federal ? [] : [FEDERAL]), ...c.missingStates];
}

/** Federal first, then USPS codes sorted; duplicates dropped. */
function orderCodes(codes: readonly string[]): string[] {
  const states = [...new Set(codes.filter((c) => c !== FEDERAL))].sort();
  return [...(codes.includes(FEDERAL) ? [FEDERAL] : []), ...states];
}

async function adminUserIds(db: Pick<Db, "select">): Promise<string[]> {
  const rows = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(
      and(eq(authUser.role, "admin"), or(isNull(authUser.banned), eq(authUser.banned, false))),
    );
  return rows.map((r) => r.id);
}

/**
 * Records + mails each (year, jurisdiction) of `jurisdictions` not reported
 * before. `jurisdictions` is the full set missing right now ("federal" and/or
 * USPS codes): the email names only the newly reported states, and uses the
 * federal (all payroll on hold) wording whenever federal is in the set
 * (Product Lead round 3). One transaction: a failure keeps no audit row, so
 * the next call reports again. Returns the newly reported codes, federal
 * first then USPS codes sorted.
 */
export async function reportMissingTaxTables(
  db: Db,
  config: AppConfig,
  input: { year: number; jurisdictions: string[]; today: string },
): Promise<{ reported: string[] }> {
  const { year, today } = input;
  const codes = orderCodes(input.jurisdictions);
  if (codes.length === 0) return { reported: [] };

  return db.transaction(async (tx) => {
    await tx.execute(TAX_TABLES_MISSING_LOCK);
    const reported: string[] = [];
    for (const code of codes) {
      const entityId = `${year}:${code}`;
      const seen = await tx
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(and(eq(auditEvents.action, ACTION), eq(auditEvents.entityId, entityId)))
        .limit(1);
      if (seen.length > 0) continue;
      await tx.insert(auditEvents).values({
        actorId: "scheduler",
        action: ACTION,
        entity: "tax_tables",
        entityId,
        before: null,
        after: { year, jurisdiction: code, day: today },
      });
      reported.push(code);
    }
    if (reported.length === 0) return { reported };

    const admins = await adminUserIds(tx);
    if (admins.length > 0) {
      const stateLabels = reported
        .filter((c) => c !== FEDERAL)
        .map((c) => stateName(c))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const ctx = await templateContext(tx, config);
      const rendered = tplTaxTablesMissing(ctx, {
        year,
        federal: codes.includes(FEDERAL),
        stateLabels,
        when: year > Number(today.slice(0, 4)) ? "upcoming" : "current",
      });
      await tx.insert(emailOutbox).values(
        admins.map((userId) => ({
          userId,
          eventType: EVENT_TYPE.taxTablesMissing,
          subject: rendered.subject,
          bodyHtml: rendered.html, // dedupe is the audit event, not a marker
        })),
      );
    }
    return { reported };
  });
}

/**
 * Reports the coverage gap of one year; never throws. Logs years and codes
 * only, and only when something was newly reported. Returns the newly
 * reported codes, or null when the report failed (logged by error class).
 */
export async function reportCoverageGap(
  db: Db,
  config: AppConfig,
  coverage: TaxTableCoverage,
  today: string,
): Promise<string[] | null> {
  const codes = missingCodes(coverage);
  try {
    const { reported } = await reportMissingTaxTables(db, config, {
      year: coverage.year,
      jurisdictions: codes,
      today,
    });
    if (reported.length > 0) {
      console.log(
        `[tax-tables] ${coverage.year} missing: ${codes.join(", ")} (${reported.length} newly reported)`,
      );
    }
    return reported;
  } catch (err) {
    console.error(`[tax-tables] ${coverage.year} alert failed (${errorClass(err)})`);
    return null;
  }
}

/**
 * Daily step: checks today's year, plus next year from Dec 1 (APP_TZ), and
 * reports each uncovered year. A report failure is logged by class and the
 * other year is still checked; a coverage-query failure (DB down) throws.
 */
export async function checkTaxTableCoverage(
  deps: { db: Db; config: AppConfig },
  opts: { now: Date },
): Promise<{ checked: number[]; reported: { year: number; jurisdictions: string[] }[] }> {
  const { db, config } = deps;
  const today = localDate(opts.now, config.appTz);
  const checked = coverageYears(today);
  const reported: { year: number; jurisdictions: string[] }[] = [];
  for (const year of checked) {
    const coverage = await taxTableCoverage(db, year);
    if (isCovered(coverage)) continue;
    const codes = await reportCoverageGap(db, config, coverage, today);
    if (codes) reported.push({ year, jurisdictions: codes });
  }
  return { checked, reported };
}

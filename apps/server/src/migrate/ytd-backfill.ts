/**
 * One-off backfill for deployments that ran the legacy migration BEFORE
 * snapshot template 1.1.0 (2026-07-30): pre-1.1.0 run snapshots have no `ytd`
 * block, so the payslip's expanded Year-to-Date section (gross / withholdings
 * / net, owner request 2026-07-30) cannot render from them.
 *
 * For every legacy-imported run, walk in pay-date order (pay_date,
 * period_start, id; YTD resets each pay-date year) and accumulate the run's
 * OWN stored payroll_entries per category — the same stored-is-truth rule the
 * migration uses (deviation runs count at their ISSUED amounts). Where the
 * snapshot's `ytd` differs from the expected accumulation, patch
 * run_snapshot.ytd + templateVersion, recompute snapshot_hash, and record the
 * correction in audit_events.
 *
 * ⚠ The immutability trigger (migration 0001,
 * payroll_runs_immutable_once_issued) FORBIDS changing run_snapshot on issued
 * runs — correctly so. This is not an amendment of live payroll: it derives
 * display-only YTD totals from data already frozen in the same rows. The
 * trigger is therefore suspended inside THIS transaction only (Postgres DDL
 * is transactional — a failure rolls the suspension back with everything
 * else). App-created runs are never touched; `updatedAt` is left untouched to
 * preserve import provenance.
 * Idempotent: a second run finds every snapshot already current and writes
 * nothing.
 */

import { asc, eq, inArray, sql } from "drizzle-orm";
import { auditEvents, payrollEntries, payrollRuns } from "@payroll/db";
import { round2 } from "@payroll/engine/money";
import type { Db } from "../db.js";
import {
  LEGACY_SNAPSHOT_TEMPLATE_VERSION,
  type RunSnapshot,
  type RunSnapshotYtd,
  snapshotHash,
} from "../payroll/snapshot.js";
import { LEGACY_CREATED_BY } from "./migrate.js";

export const YTD_BACKFILL_ACTOR = "cli:backfill-legacy-ytd";
const IMMUTABILITY_TRIGGER = "payroll_runs_immutable_once_issued";

export interface YtdBackfillReport {
  scanned: number;
  backfilled: number;
  alreadyCurrent: number;
}

const YTD_CATEGORIES = [
  "gross_pay",
  "federal_withholding",
  "social_security",
  "medicare",
  "state_withholding",
  "net_pay",
] as const;

function toYtd(acc: Map<string, number>): RunSnapshotYtd {
  const gross = acc.get("gross_pay") ?? 0;
  const netPay = acc.get("net_pay") ?? 0;
  return {
    gross,
    federalWithholding: acc.get("federal_withholding") ?? 0,
    socialSecurity: acc.get("social_security") ?? 0,
    medicare: acc.get("medicare") ?? 0,
    stateWithholding: acc.get("state_withholding") ?? 0,
    totalDeductions: round2(gross - netPay),
    netPay,
  };
}

function ytdEquals(a: RunSnapshotYtd | undefined, b: RunSnapshotYtd): boolean {
  return (
    a !== undefined &&
    a.gross === b.gross &&
    a.federalWithholding === b.federalWithholding &&
    a.socialSecurity === b.socialSecurity &&
    a.medicare === b.medicare &&
    a.stateWithholding === b.stateWithholding &&
    a.totalDeductions === b.totalDeductions &&
    a.netPay === b.netPay
  );
}

export async function backfillLegacyYtd(
  db: Db,
  log: (line: string) => void = () => {},
): Promise<YtdBackfillReport> {
  const runs = await db
    .select()
    .from(payrollRuns)
    .where(eq(payrollRuns.createdBy, LEGACY_CREATED_BY))
    // Spec 26 (PAY-173) D2 order: wages are counted in the year they are PAID.
    .orderBy(asc(payrollRuns.payDate), asc(payrollRuns.periodStart), asc(payrollRuns.id));

  const entries =
    runs.length === 0
      ? []
      : await db
          .select({
            runId: payrollEntries.runId,
            category: payrollEntries.category,
            amount: payrollEntries.amount,
          })
          .from(payrollEntries)
          .where(
            inArray(
              payrollEntries.runId,
              runs.map((r) => r.id),
            ),
          );

  const byRun = new Map<number, Map<string, number>>();
  for (const e of entries) {
    let m = byRun.get(e.runId);
    if (!m) {
      m = new Map();
      byRun.set(e.runId, m);
    }
    m.set(e.category, round2((m.get(e.category) ?? 0) + Number(e.amount)));
  }

  // Walk in (pay_date, period_start, id) order: accumulate per-category,
  // resetting each pay-date calendar year (YTD = wages paid in the year,
  // Spec 26 (PAY-173)); expected YTD through each run.
  const acc = new Map<string, number>();
  let accYear: string | null = null;
  const expectedByRun = new Map<number, RunSnapshotYtd>();
  for (const run of runs) {
    const year = run.payDate.slice(0, 4);
    if (year !== accYear) {
      acc.clear();
      accYear = year;
    }
    const own = byRun.get(run.id) ?? new Map<string, number>();
    for (const cat of YTD_CATEGORIES) {
      acc.set(cat, round2((acc.get(cat) ?? 0) + (own.get(cat) ?? 0)));
    }
    expectedByRun.set(run.id, toYtd(acc));
  }

  const stale = runs.filter((run) => {
    const expected = expectedByRun.get(run.id);
    return expected !== undefined && !ytdEquals((run.runSnapshot as RunSnapshot).ytd, expected);
  });

  if (stale.length > 0) {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`ALTER TABLE payroll_runs DISABLE TRIGGER ${IMMUTABILITY_TRIGGER}`));
      try {
        for (const run of stale) {
          const ytd = expectedByRun.get(run.id);
          if (!ytd) continue;
          const snapshot = run.runSnapshot as RunSnapshot;
          const next: RunSnapshot = {
            ...snapshot,
            ytd,
            templateVersion: LEGACY_SNAPSHOT_TEMPLATE_VERSION,
          };
          await tx
            .update(payrollRuns)
            .set({ runSnapshot: next, snapshotHash: snapshotHash(next) })
            .where(eq(payrollRuns.id, run.id));
          await tx.insert(auditEvents).values({
            actorId: YTD_BACKFILL_ACTOR,
            action: "run.ytd_backfilled",
            entity: "payroll_run",
            entityId: String(run.id),
            before: { ytd: snapshot.ytd ?? null },
            after: {
              ytd,
              reason: "template 1.1.0: payslip YTD withholdings/net (owner request 2026-07-30)",
            },
          });
          log(
            `  backfilled ${run.periodStart.slice(0, 7)}: ytd gross ${ytd.gross.toFixed(2)} ` +
              `/ withholdings ${ytd.totalDeductions.toFixed(2)} / net ${ytd.netPay.toFixed(2)}`,
          );
        }
      } finally {
        await tx.execute(
          sql.raw(`ALTER TABLE payroll_runs ENABLE TRIGGER ${IMMUTABILITY_TRIGGER}`),
        );
      }
    });
  }

  log(
    `ytd backfill: ${stale.length} backfilled, ${runs.length - stale.length} already current ` +
      `(${runs.length} legacy run(s) scanned)`,
  );
  return {
    scanned: runs.length,
    backfilled: stale.length,
    alreadyCurrent: runs.length - stale.length,
  };
}

/**
 * YTD backfill tests (template 1.1.0, 2026-07-30): legacy runs imported
 * before 1.1.0 have no snapshot.ytd; the backfill derives it from each run's
 * own stored entries (chronological accumulation, stored-is-truth — the
 * 2026-03 deviation run counts at its ISSUED amounts), bumps templateVersion,
 * re-hashes, audits — idempotently, and never touches app-created runs.
 */

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@payroll/db";
import { auditEvents, company, employees, payrollEntries, payrollRuns } from "@payroll/db";
import type { Db } from "../src/db.js";
import { LEGACY_CREATED_BY } from "../src/migrate/migrate.js";
import { backfillLegacyYtd, YTD_BACKFILL_ACTOR } from "../src/migrate/ytd-backfill.js";
import {
  LEGACY_SNAPSHOT_TEMPLATE_VERSION,
  type RunSnapshot,
  SNAPSHOT_TEMPLATE_VERSION,
  snapshotHash,
} from "../src/payroll/snapshot.js";
import { runMigrations } from "./helpers.js";

let pglite: PGlite;
let db: Db;

/** Minimal pre-1.1.0 snapshot — deliberately NO ytd block. */
function legacySnapshot(periodStart: string, periodEnd: string, payDate: string): RunSnapshot {
  return {
    inputs: {
      periodAmount: 4000,
      frequency: "monthly",
      periodsPerYear: 12,
      w4: null,
      taxConfig: {
        jurisdiction: "federal",
        taxYear: 2026,
        standardDeduction: 16100,
        socialSecurityRate: 0.062,
        socialSecurityWageCap: 184500,
        medicareRate: 0.0145,
        medicareAdditionalRate: 0.009,
        medicareAdditionalThreshold: 200000,
        stateWithholdingRate: 0,
        employerSocialSecurityRate: 0.062,
        employerMedicareRate: 0.0145,
        futaRate: 0.006,
        futaWageCap: 7000,
      },
      brackets: [],
      priorYtdGross: 0,
      periodStart,
      periodEnd,
      payDate,
      company: { legalName: "Example Corp" },
      employee: { legalName: "Ada Lovelace", preferredName: null },
    },
    result: {
      grossPay: 4000,
      federalWithholding: 310.13,
      socialSecurity: 248,
      medicare: 58,
      stateWithholding: 0,
      totalDeductions: 616.13,
      netPay: 3383.87,
      employerSocialSecurity: 248,
      employerMedicare: 58,
      employerFUTA: 24,
      totalEmployerCost: 4330,
      ytdGross: 4000,
    },
    engineVersion: "legacy-import",
    templateVersion: "1.0.0",
  };
}

async function insertRun(opts: {
  month: string; // "2026-01"
  federal: number;
  net: number;
  createdBy: string;
}): Promise<number> {
  const snapshot = legacySnapshot(`${opts.month}-01`, `${opts.month}-28`, `${opts.month}-15`);
  const inserted = await db
    .insert(payrollRuns)
    .values({
      employeeId: 1,
      periodStart: `${opts.month}-01`,
      periodEnd: `${opts.month}-28`,
      payDate: `${opts.month}-15`,
      status: "issued",
      runSnapshot: snapshot,
      snapshotHash: snapshotHash(snapshot),
      createdBy: opts.createdBy,
    })
    .returning();
  const runId = inserted[0]!.id;
  await db.insert(payrollEntries).values([
    { runId, category: "gross_pay", amount: "4000.00" },
    { runId, category: "federal_withholding", amount: opts.federal.toFixed(2) },
    { runId, category: "social_security", amount: "248.00" },
    { runId, category: "medicare", amount: "58.00" },
    { runId, category: "state_withholding", amount: "0.00" },
    { runId, category: "net_pay", amount: opts.net.toFixed(2) },
    { runId, category: "employer_social_security", amount: "248.00" },
    { runId, category: "employer_medicare", amount: "58.00" },
    { runId, category: "employer_futa", amount: "24.00" },
  ]);
  return runId;
}

beforeEach(async () => {
  pglite = new PGlite("memory://");
  await runMigrations(pglite);
  db = drizzle(pglite, { schema }) as unknown as Db;
  await db.insert(company).values({ legalName: "Example Corp" });
  await db.insert(employees).values({
    companyId: 1,
    employmentType: "w2",
    legalName: "Ada Lovelace",
    hireDate: "2025-01-01",
    status: "active",
  });
});

afterEach(async () => {
  await pglite.close();
});

describe("backfillLegacyYtd", () => {
  it("accumulates YTD from stored entries — deviation run counts at issued amounts", async () => {
    // A 2025 run first: 2026 YTD must RESET at the calendar-year boundary
    // (regression: the first backfill version accumulated across years).
    const dec25Id = await insertRun({
      month: "2025-12",
      federal: 310.13,
      net: 3383.87,
      createdBy: LEGACY_CREATED_BY,
    });
    const janId = await insertRun({
      month: "2026-01",
      federal: 310.13,
      net: 3383.87,
      createdBy: LEGACY_CREATED_BY,
    });
    // 2026-03 is the legacy true-up month: stored federal 490.73 ≠ engine 298.33.
    await insertRun({
      month: "2026-02",
      federal: 310.13,
      net: 3383.87,
      createdBy: LEGACY_CREATED_BY,
    });
    const marchId = await insertRun({
      month: "2026-03",
      federal: 490.73,
      net: 3203.27,
      createdBy: LEGACY_CREATED_BY,
    });

    const report = await backfillLegacyYtd(db);
    expect(report).toEqual({ scanned: 4, backfilled: 4, alreadyCurrent: 0 });

    const [dec25] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, dec25Id));
    expect((dec25!.runSnapshot as RunSnapshot).ytd?.gross).toBe(4000);

    // Year boundary: January's YTD is January alone, NOT Dec + Jan.
    const [jan] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, janId));
    expect((jan!.runSnapshot as RunSnapshot).ytd).toEqual({
      gross: 4000,
      federalWithholding: 310.13,
      socialSecurity: 248,
      medicare: 58,
      stateWithholding: 0,
      totalDeductions: 616.13,
      netPay: 3383.87,
    });

    const [march] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, marchId));
    const snapshot = march!.runSnapshot as RunSnapshot;
    expect(snapshot.ytd).toEqual({
      gross: 12000,
      federalWithholding: 1110.99, // 310.13 + 310.13 + 490.73 (issued true-up)
      socialSecurity: 744,
      medicare: 174,
      stateWithholding: 0,
      totalDeductions: 2028.99, // 12000 − 9971.01
      netPay: 9971.01,
    });
    // Spec 26 (PAY-173): the backfill writes ytd, not inputs.resolution — it
    // stamps the 1.2.0 shape, never the current 1.3.0.
    expect(snapshot.templateVersion).toBe("1.2.0");
    expect(snapshot.templateVersion).toBe(LEGACY_SNAPSHOT_TEMPLATE_VERSION);
    expect(snapshot.templateVersion).not.toBe(SNAPSHOT_TEMPLATE_VERSION);
    expect(snapshot.inputs.resolution).toBeUndefined();
    expect(march!.snapshotHash).toBe(snapshotHash(snapshot));

    const audit = await db.select().from(auditEvents);
    expect(audit).toHaveLength(4);
    expect(audit[3]).toMatchObject({
      actorId: YTD_BACKFILL_ACTOR,
      action: "run.ytd_backfilled",
      entity: "payroll_run",
      entityId: String(marchId),
      before: { ytd: null },
    });
  });

  it("is idempotent and never touches app-created runs", async () => {
    const legacyId = await insertRun({
      month: "2026-01",
      federal: 310.13,
      net: 3383.87,
      createdBy: LEGACY_CREATED_BY,
    });
    const appRunId = await insertRun({
      month: "2026-02",
      federal: 310.13,
      net: 3383.87,
      createdBy: "scheduler",
    });

    const first = await backfillLegacyYtd(db);
    expect(first).toEqual({ scanned: 1, backfilled: 1, alreadyCurrent: 0 });
    const second = await backfillLegacyYtd(db);
    expect(second).toEqual({ scanned: 1, backfilled: 0, alreadyCurrent: 1 });

    const [appRun] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, appRunId));
    expect((appRun!.runSnapshot as RunSnapshot).ytd).toBeUndefined(); // untouched
    const [legacy] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, legacyId));
    expect((legacy!.runSnapshot as RunSnapshot).ytd?.gross).toBe(4000);
    // Exactly one audit row (the first pass); the idempotent second pass adds none.
    expect(await db.select().from(auditEvents)).toHaveLength(1);
  });
});

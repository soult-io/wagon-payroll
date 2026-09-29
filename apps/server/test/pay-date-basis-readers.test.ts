/**
 * Spec 26 (PAY-173) §8 — readers keyed by pay date: the admin run list
 * `?year=` filter/order (C11, L-1) and the legacy YTD backfill (C10, D-8,
 * D-9). The backfill accumulates across ALL legacy runs, so each backfill
 * case gets its own fresh PGlite database.
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@payroll/db";
import {
  company,
  employees,
  payrollEntries,
  payrollRuns,
  seedDatabase,
  type SeedDb,
} from "@payroll/db";
import { formatCents } from "@payroll/shared";
import type { Db } from "../src/db.js";
import { LEGACY_CREATED_BY } from "../src/migrate/migrate.js";
import { backfillLegacyYtd } from "../src/migrate/ytd-backfill.js";
import type { RunSnapshot, RunSnapshotYtd } from "../src/payroll/snapshot.js";
import { createTestApp, runMigrations, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";
import { cents, createEmployee, insertIssuedHistoryRun, monthPeriod } from "./pay-date-helpers.js";

describe("L-1: GET /api/admin/payroll-runs?year= is the pay-date year, newest pay date first", () => {
  let t: TestContext;
  let ADMIN: Record<string, string>;
  beforeAll(async () => {
    t = await createTestApp();
    await seedDatabase(t.db as unknown as SeedDb);
    const admin = await inviteAndOnboard(t, { email: "pay-date-l1-admin@test.dev", role: "admin" });
    ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);
  }, 120_000);
  afterAll(async () => {
    await t.close();
  });

  it("returns the Dec-2026 period paid 2027-01-05 and the Jan-2027 period paid 2027-01-04, not the 2026-12-15 payment; ordered by pay date desc", async () => {
    const emp = await createEmployee(t, 500_000);
    const paid0105 = await insertIssuedHistoryRun(t, emp, monthPeriod("2026-12", "2027-01-05"), {});
    await insertIssuedHistoryRun(t, emp, monthPeriod("2026-11", "2026-12-15"), {});
    const paid0104 = await insertIssuedHistoryRun(t, emp, monthPeriod("2027-01", "2027-01-04"), {});
    const res = await t.app.inject({
      method: "GET",
      url: `/api/admin/payroll-runs?year=2027&employeeId=${emp}`,
      headers: ADMIN,
    });
    const runs = (res.json() as { runs: { publicId: string; payDate: string }[] }).runs;
    expect({ status: res.statusCode, runs: runs.map((r) => [r.publicId, r.payDate]) }).toEqual({
      status: 200,
      runs: [
        [paid0105.publicId, "2027-01-05"],
        [paid0104.publicId, "2027-01-04"],
      ],
    });
  });
});

describe("ytd-backfill by pay-date year (C10)", () => {
  let pglite: PGlite;
  let db: Db;
  let employeeId = 0;

  async function freshDb() {
    pglite = new PGlite("memory://");
    await runMigrations(pglite);
    db = drizzle(pglite, { schema }) as unknown as Db;
    const c = await db.insert(company).values({ legalName: "Example Corp" }).returning();
    const e = await db
      .insert(employees)
      .values({ companyId: c[0]!.id, legalName: "Ada Test", hireDate: "2024-01-01" })
      .returning();
    employeeId = e[0]!.id;
  }

  // One legacy month (cents): gross 400,000; FIT 30,000; SS 24,800; Medicare 5,800; net 339,400.
  const MONTH = { gross: 400_000, fit: 30_000, ss: 24_800, med: 5_800, net: 339_400 };
  function ytdAfter(k: number): RunSnapshotYtd {
    return {
      gross: (MONTH.gross * k) / 100,
      federalWithholding: (MONTH.fit * k) / 100,
      socialSecurity: (MONTH.ss * k) / 100,
      medicare: (MONTH.med * k) / 100,
      stateWithholding: 0,
      totalDeductions: ((MONTH.gross - MONTH.net) * k) / 100,
      netPay: (MONTH.net * k) / 100,
    };
  }
  async function legacyRun(periodYm: string, payDate: string, ytd?: RunSnapshotYtd) {
    const p = monthPeriod(periodYm, payDate);
    const snapshot = {
      inputs: { periodStart: p.periodStart, periodEnd: p.periodEnd, payDate },
      result: {},
      engineVersion: "legacy-import",
      templateVersion: ytd ? "1.1.0" : "1.0.0",
      ...(ytd ? { ytd } : {}),
    } as unknown as RunSnapshot;
    const rows = await db
      .insert(payrollRuns)
      .values({
        employeeId,
        ...p,
        status: "issued",
        runSnapshot: snapshot,
        createdBy: LEGACY_CREATED_BY,
      })
      .returning();
    const id = rows[0]!.id;
    const entries: [string, number][] = [
      ["gross_pay", MONTH.gross],
      ["federal_withholding", MONTH.fit],
      ["social_security", MONTH.ss],
      ["medicare", MONTH.med],
      ["state_withholding", 0],
      ["net_pay", MONTH.net],
    ];
    await db
      .insert(payrollEntries)
      .values(entries.map(([category, c]) => ({ runId: id, category, amount: formatCents(c) })));
    return id;
  }
  async function ytdGrossOf(id: number): Promise<number | null> {
    const rows = await db.select().from(payrollRuns).where(eq(payrollRuns.id, id));
    const ytd = (rows[0]!.runSnapshot as RunSnapshot).ytd;
    return ytd ? cents(ytd.gross) : null;
  }

  it("D-8 (guard, classes b, e): legacy-shaped runs (paid the 15th of the period month) with current YTD → 0 backfilled, twice", async () => {
    await freshDb();
    await legacyRun("2026-01", "2026-01-15", ytdAfter(1));
    await legacyRun("2026-02", "2026-02-15", ytdAfter(2));
    await legacyRun("2026-03", "2026-03-15", ytdAfter(3));
    const first = await backfillLegacyYtd(db);
    const second = await backfillLegacyYtd(db);
    await pglite.close();
    expect({ first: first.backfilled, second: second.backfilled, scanned: first.scanned }).toEqual({
      first: 0,
      second: 0,
      scanned: 3,
    });
  });

  it("D-9 (class e): a Dec-2026 period paid 2027-01-15 accumulates into 2027 by pay date", async () => {
    await freshDb();
    const nov = await legacyRun("2026-11", "2026-11-15");
    const dec = await legacyRun("2026-12", "2027-01-15");
    const jan = await legacyRun("2027-01", "2027-02-15");
    const feb = await legacyRun("2027-02", "2027-03-15");
    await backfillLegacyYtd(db);
    const got = {
      nov: await ytdGrossOf(nov),
      dec: await ytdGrossOf(dec),
      jan: await ytdGrossOf(jan),
      feb: await ytdGrossOf(feb),
    };
    await pglite.close();
    expect(got).toEqual({ nov: 400_000, dec: 400_000, jan: 800_000, feb: 1_200_000 });
  });
});

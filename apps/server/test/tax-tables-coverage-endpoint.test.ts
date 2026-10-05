/**
 * PAY-225 / year-rollover guard brief §4.5 (PR-4): the read-only admin
 * coverage endpoint. payroll-calc-auditor, fail-first; the coder may not edit
 * this file.
 *
 * Contract assumed (brief §4.5, §4.1, risk R1):
 *   GET /api/admin/tax-tables/coverage   (admin preHandler, admin-payroll.ts)
 *   200 → {
 *     today: "YYYY-MM-DD",          // localDate(deps.clock(), config.appTz)
 *     latestCoveredYear: number | null,   // latestCoveredYear(db, year(today))
 *     years: [{ year, federal, missingStates }]
 *   }
 *   `years` = the current year, plus next year when today >= Dec 1 (APP_TZ
 *   local date), ascending. Each entry is exactly taxTableCoverage(db, year)
 *   — the ONE coverage definition (tax-coverage.ts), never re-derived.
 *   No session → 401; employee → 403 (existing guards). GET is not
 *   CSRF-checked in this app (csrf.ts checks mutating methods only), so no
 *   cross-site case applies. No PII: years and USPS codes only.
 *
 * Bundled tables: federal 2025 + 2026, IL 2025 + 2026. 2027 rows here are the
 * SYNTHETIC test-only fixtures (fixtures/synthetic-2027.ts), never product
 * seed data.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  company,
  compensation,
  employees,
  employeeWorkStates,
  seedDatabase,
  type SeedDb,
} from "@payroll/db";
import { latestCoveredYear, taxTableCoverage } from "../src/payroll/tax-coverage.js";
import { seedSyntheticFederal2027, seedSyntheticIl2027 } from "./fixtures/synthetic-2027.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

const PATH = "/api/admin/tax-tables/coverage";
const IL_WORKER = "Synthetic Coverage Illinois Worker";

interface CoverageBody {
  today: string;
  latestCoveredYear: number | null;
  years: { year: number; federal: boolean; missingStates: string[] }[];
}

/** A synthetic active W-2 employee paid and working in IL since 2024. */
async function addIllinoisWorker(t: TestContext): Promise<void> {
  const c = await t.db.select({ id: company.id }).from(company).limit(1);
  if (!c[0]) throw new Error("seedDatabase did not create a company");
  const [row] = await t.db
    .insert(employees)
    .values({
      companyId: c[0].id,
      employmentType: "w2",
      legalName: IL_WORKER,
      hireDate: "2024-01-01",
      status: "active",
    })
    .returning({ id: employees.id });
  if (!row) throw new Error("employee insert returned nothing");
  await t.db.insert(compensation).values({
    employeeId: row.id,
    periodAmount: "4000.00",
    frequency: "monthly",
    effectiveFrom: "2024-01-01",
    effectiveTo: null,
  });
  await t.db.insert(employeeWorkStates).values({
    employeeId: row.id,
    stateCode: "IL",
    effectiveFrom: "2024-01-01",
    effectiveTo: null,
  });
}

/** One app per describe; the clock is a mutable instant the test moves. */
async function boot(
  overrides: Parameters<typeof createTestApp>[0] = {},
): Promise<{ t: TestContext; setNow: (iso: string) => void; admin: string; employee: string }> {
  let now = new Date("2027-01-02T12:00:00Z");
  const t = await createTestApp(overrides, { clock: () => now });
  await seedDatabase(t.db as unknown as SeedDb);
  await addIllinoisWorker(t);
  const a = await inviteAndOnboard(t, { email: "cov-admin@example.com", role: "admin" });
  const e = await inviteAndOnboard(t, { email: "cov-employee@example.com", role: "employee" });
  return {
    t,
    setNow: (iso) => {
      now = new Date(iso);
    },
    admin: (await login(t, a.email, TEST_PASSWORD)).sessionCookie,
    employee: (await login(t, e.email, TEST_PASSWORD)).sessionCookie,
  };
}

async function getCoverage(t: TestContext, cookie: string): Promise<CoverageBody> {
  const res = await t.app.inject({ method: "GET", url: PATH, headers: sessionHeader(cookie) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as CoverageBody;
}

describe("C1 bundled tables only (federal + IL through 2026), IL worker", () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    ctx = await boot();
  }, 120_000);
  afterAll(async () => ctx.t.close());

  it("C1a 2027-01-02: 2027 uncovered (no federal, IL missing); latest covered 2026", async () => {
    ctx.setNow("2027-01-02T12:00:00Z");
    expect(await getCoverage(ctx.t, ctx.admin)).toEqual({
      today: "2027-01-02",
      latestCoveredYear: 2026,
      years: [{ year: 2027, federal: false, missingStates: ["IL"] }],
    });
  });

  it("C1b 2026-12-02: from Dec 1 next year is listed too, ascending", async () => {
    ctx.setNow("2026-12-02T12:00:00Z");
    expect(await getCoverage(ctx.t, ctx.admin)).toEqual({
      today: "2026-12-02",
      latestCoveredYear: 2026,
      years: [
        { year: 2026, federal: true, missingStates: [] },
        { year: 2027, federal: false, missingStates: ["IL"] },
      ],
    });
  });

  it("C1c 2026-11-30: before Dec 1 only the current year", async () => {
    ctx.setNow("2026-11-30T12:00:00Z");
    expect(await getCoverage(ctx.t, ctx.admin)).toEqual({
      today: "2026-11-30",
      latestCoveredYear: 2026,
      years: [{ year: 2026, federal: true, missingStates: [] }],
    });
  });

  it("C1d 2027-12-31 with tables a year stale: both 2027 and 2028 uncovered", async () => {
    ctx.setNow("2027-12-31T12:00:00Z");
    expect(await getCoverage(ctx.t, ctx.admin)).toEqual({
      today: "2027-12-31",
      latestCoveredYear: 2026,
      years: [
        { year: 2027, federal: false, missingStates: ["IL"] },
        { year: 2028, federal: false, missingStates: ["IL"] },
      ],
    });
  });

  it("C1e every entry is exactly taxTableCoverage (one definition, risk R1)", async () => {
    ctx.setNow("2026-12-02T12:00:00Z");
    const body = await getCoverage(ctx.t, ctx.admin);
    for (const entry of body.years) {
      expect(entry).toEqual(await taxTableCoverage(ctx.t.db, entry.year));
    }
    expect(body.latestCoveredYear).toBe(await latestCoveredYear(ctx.t.db, 2026));
  });

  it("C1f no session → 401", async () => {
    const res = await ctx.t.app.inject({ method: "GET", url: PATH });
    expect(res.statusCode).toBe(401);
  });

  it("C1g employee session → 403", async () => {
    const res = await ctx.t.app.inject({
      method: "GET",
      url: PATH,
      headers: sessionHeader(ctx.employee),
    });
    expect(res.statusCode).toBe(403);
  });

  it("C1h no PII: only the three keys, no legal name, no money amount", async () => {
    ctx.setNow("2027-01-02T12:00:00Z");
    const res = await ctx.t.app.inject({
      method: "GET",
      url: PATH,
      headers: sessionHeader(ctx.admin),
    });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json() as object).sort()).toEqual([
      "latestCoveredYear",
      "today",
      "years",
    ]);
    for (const y of (res.json() as CoverageBody).years) {
      expect(Object.keys(y).sort()).toEqual(["federal", "missingStates", "year"]);
    }
    expect(res.body).not.toContain(IL_WORKER);
    expect(res.body).not.toMatch(/\d+\.\d{2}/);
  });

  it("C1i read-only: two calls leave the tax tables unchanged", async () => {
    ctx.setNow("2027-01-02T12:00:00Z");
    const before = await taxTableCoverage(ctx.t.db, 2027);
    await getCoverage(ctx.t, ctx.admin);
    await getCoverage(ctx.t, ctx.admin);
    expect(await taxTableCoverage(ctx.t.db, 2027)).toEqual(before);
  });
});

describe("C2 'today' is the APP_TZ local date, not UTC (America/Chicago)", () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    ctx = await boot({ appTz: "America/Chicago" });
  }, 120_000);
  afterAll(async () => ctx.t.close());

  it("C2a 2026-12-01T03:00Z is Nov 30 in Chicago → one year", async () => {
    ctx.setNow("2026-12-01T03:00:00Z");
    const body = await getCoverage(ctx.t, ctx.admin);
    expect(body.today).toBe("2026-11-30");
    expect(body.years.map((y) => y.year)).toEqual([2026]);
  });

  it("C2b 2026-12-01T07:00Z is Dec 1 in Chicago → Dec 1 counts (>=)", async () => {
    ctx.setNow("2026-12-01T07:00:00Z");
    const body = await getCoverage(ctx.t, ctx.admin);
    expect(body.today).toBe("2026-12-01");
    expect(body.years.map((y) => y.year)).toEqual([2026, 2027]);
  });

  it("C2c 2027-01-01T03:00Z is still Dec 31 2026 in Chicago", async () => {
    ctx.setNow("2027-01-01T03:00:00Z");
    const body = await getCoverage(ctx.t, ctx.admin);
    expect(body.today).toBe("2026-12-31");
    expect(body.years.map((y) => y.year)).toEqual([2026, 2027]);
    expect(body.latestCoveredYear).toBe(2026);
  });
});

describe("C3 synthetic 2027 tables (TEST ONLY)", () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    ctx = await boot();
  }, 120_000);
  afterAll(async () => ctx.t.close());

  it("C3a federal-2027 only: federal true, IL still missing, latest covered 2026", async () => {
    await seedSyntheticFederal2027(ctx.t.db);
    ctx.setNow("2027-01-02T12:00:00Z");
    expect(await getCoverage(ctx.t, ctx.admin)).toEqual({
      today: "2027-01-02",
      latestCoveredYear: 2026,
      years: [{ year: 2027, federal: true, missingStates: ["IL"] }],
    });
  });

  it("C3b federal-2027 + IL-2027: 2027 covered and latest", async () => {
    await seedSyntheticIl2027(ctx.t.db);
    ctx.setNow("2027-01-02T12:00:00Z");
    expect(await getCoverage(ctx.t, ctx.admin)).toEqual({
      today: "2027-01-02",
      latestCoveredYear: 2027,
      years: [{ year: 2027, federal: true, missingStates: [] }],
    });
  });
});

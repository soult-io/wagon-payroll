/**
 * PAY-103 R18 PR-5a (brief §2 D3-a, §4.4): the coverage endpoint's own clock
 * seam. payroll-calc-auditor, fail-first; the coder may not edit this file.
 *
 * Contract assumed:
 *   buildApp / createTestApp extra `coverageClock?: () => Date` (constructor
 *   argument only; no env var, no request parameter). The endpoint
 *   GET /api/admin/tax-tables/coverage computes `today` from
 *   `coverageClock ?? clock ?? (() => new Date())`. Response shape unchanged
 *   (tax-tables-coverage-endpoint.test.ts stays the shape contract).
 *   apps/server/src/e2e/serve.ts passes `coverageClock: () => new Date()` so
 *   the ephemeral e2e boot answers for the (shifted) process year while its
 *   D9 issue clock stays pinned to 2025-12-31.
 *
 * Synthetic data only: one IL worker, bundled federal + IL tables through 2026.
 */

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  company,
  compensation,
  employees,
  employeeWorkStates,
  seedDatabase,
  type SeedDb,
} from "@payroll/db";
import { localDate } from "../src/payroll/run-dates.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

const PATH = "/api/admin/tax-tables/coverage";

interface CoverageBody {
  today: string;
  latestCoveredYear: number | null;
  years: { year: number; federal: boolean; missingStates: string[] }[];
}

async function addIllinoisWorker(t: TestContext): Promise<void> {
  const c = await t.db.select({ id: company.id }).from(company).limit(1);
  const [row] = await t.db
    .insert(employees)
    .values({
      companyId: c[0]!.id,
      employmentType: "w2",
      legalName: "Synthetic Clock Illinois Worker",
      hireDate: "2024-01-01",
      status: "active",
    })
    .returning({ id: employees.id });
  await t.db.insert(compensation).values({
    employeeId: row!.id,
    periodAmount: "4000.00",
    frequency: "monthly",
    effectiveFrom: "2024-01-01",
    effectiveTo: null,
  });
  await t.db.insert(employeeWorkStates).values({
    employeeId: row!.id,
    stateCode: "IL",
    effectiveFrom: "2024-01-01",
    effectiveTo: null,
  });
}

async function boot(extra: Parameters<typeof createTestApp>[1]) {
  const t = await createTestApp({ appTz: "Europe/Madrid" }, extra);
  await seedDatabase(t.db as unknown as SeedDb);
  await addIllinoisWorker(t);
  const a = await inviteAndOnboard(t, { email: "covclock-admin@example.com", role: "admin" });
  const cookie = (await login(t, a.email, TEST_PASSWORD)).sessionCookie;
  const get = async (): Promise<CoverageBody> => {
    const res = await t.app.inject({ method: "GET", url: PATH, headers: sessionHeader(cookie) });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as CoverageBody;
  };
  return { t, get };
}

describe("CC1 coverageClock overrides the D9 clock for the coverage endpoint", () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    ctx = await boot({
      clock: () => new Date("2025-12-31T12:00:00Z"),
      coverageClock: () => new Date("2027-01-02T12:00:00Z"),
    });
  }, 120_000);
  afterAll(async () => ctx.t.close());

  it("CC1a today and years follow coverageClock (2027-01-02), not clock (2025-12-31)", async () => {
    expect(await ctx.get()).toEqual({
      today: "2027-01-02",
      latestCoveredYear: 2026,
      years: [{ year: 2027, federal: false, missingStates: ["IL"] }],
    });
  });
});

describe("CC2 without coverageClock the endpoint keeps using clock (regression)", () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    ctx = await boot({ clock: () => new Date("2026-12-02T12:00:00Z") });
  }, 120_000);
  afterAll(async () => ctx.t.close());

  it("CC2a clock 2026-12-02 → today 2026-12-02, years [2026, 2027]", async () => {
    const body = await ctx.get();
    expect(body.today).toBe("2026-12-02");
    expect(body.years.map((y) => y.year)).toEqual([2026, 2027]);
  });
});

describe("CC3 neither clock: the process clock (production path, regression)", () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    ctx = await boot({});
  }, 120_000);
  afterAll(async () => ctx.t.close());

  it("CC3a today = localDate(new Date(), APP_TZ)", async () => {
    const before = localDate(new Date(), "Europe/Madrid");
    const body = await ctx.get();
    const after = localDate(new Date(), "Europe/Madrid");
    expect([before, after]).toContain(body.today);
  });
});

describe("CC4 wiring (structural; brief §4.4)", () => {
  it("CC4a the ephemeral e2e boot passes the process clock as coverageClock", () => {
    const src = readFileSync(new URL("../src/e2e/serve.ts", import.meta.url), "utf8");
    expect(src).toMatch(/coverageClock:\s*\(\)\s*=>\s*new Date\(\)/);
  });

  it("CC4b coverageClock is not read from the environment", () => {
    for (const file of ["../src/app.ts", "../src/config.ts", "../src/routes/admin-payroll.ts"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(src, file).not.toMatch(/COVERAGE_CLOCK|process\.env[^\n]*coverage/i);
    }
  });

  it("CC4c the endpoint uses the shared coverageYears() helper, no local Dec-1 literal", () => {
    const src = readFileSync(new URL("../src/routes/admin-payroll.ts", import.meta.url), "utf8");
    expect(src).toMatch(/\bcoverageYears\b/);
    expect(src).not.toContain('"12-01"');
  });
});

/**
 * PAY-81 / year-rollover guard brief §4.1, tests V1–V3 (payroll-calc-auditor,
 * fail-first; the coder may not edit this file).
 *
 * Contract assumed (apps/server/src/payroll/tax-coverage.ts):
 *   taxTableCoverage(db, year): Promise<{ year: number; federal: boolean; missingStates: string[] }>
 *     federal       = a tax_config row with jurisdiction 'federal' and tax_year = year exists.
 *     missingStates = sorted distinct work-state codes (employee_work_states rows
 *                     overlapping calendar year `year`, effective_to exclusive) of
 *                     ACTIVE W-2 employees whose compensation overlaps `year`
 *                     (effective_to exclusive), with no state_tax_configs row for
 *                     (code, year). No work state → nothing (federal only).
 *   latestCoveredYear(db, onOrBefore): Promise<number | null>
 *     the highest federal tax_config year <= onOrBefore whose coverage is complete
 *     (federal true AND missingStates empty); null when there is none.
 *
 * Bundled tables at 2b9793f: federal 2025 + 2026; IL 2025 + 2026; TX 2025 + 2026;
 * every other state 2026 only. 2027 rows used here are the SYNTHETIC test-only
 * fixtures (fixtures/synthetic-2027.ts), never product seed data.
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

async function companyId(t: TestContext): Promise<number> {
  const c = await t.db.select({ id: company.id }).from(company).limit(1);
  if (!c[0]) throw new Error("seedDatabase did not create a company");
  return c[0].id;
}

/** A synthetic W-2 employee with optional compensation and work-state rows. */
async function addEmployee(
  t: TestContext,
  opts: {
    name: string;
    status?: "active" | "terminated";
    comp?: { from: string; to: string | null }[];
    work?: { state: string; from: string; to: string | null }[];
  },
): Promise<number> {
  const [row] = await t.db
    .insert(employees)
    .values({
      companyId: await companyId(t),
      employmentType: "w2",
      legalName: opts.name,
      hireDate: "2024-01-01",
      status: opts.status ?? "active",
    })
    .returning({ id: employees.id });
  if (!row) throw new Error("employee insert returned nothing");
  for (const c of opts.comp ?? []) {
    await t.db.insert(compensation).values({
      employeeId: row.id,
      periodAmount: "4000.00",
      frequency: "monthly",
      effectiveFrom: c.from,
      effectiveTo: c.to,
    });
  }
  for (const w of opts.work ?? []) {
    await t.db.insert(employeeWorkStates).values({
      employeeId: row.id,
      stateCode: w.state,
      effectiveFrom: w.from,
      effectiveTo: w.to,
    });
  }
  return row.id;
}

describe("V1 taxTableCoverage: bundled seeds + an IL W-2 employee paid since 2024", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestApp();
    await seedDatabase(t.db as unknown as SeedDb);
    await addEmployee(t, {
      name: "Synthetic Illinois Worker",
      comp: [{ from: "2024-01-01", to: null }],
      work: [{ state: "IL", from: "2024-01-01", to: null }],
    });
  }, 120_000);
  afterAll(async () => t.close());

  it("2026 is covered: federal row present, IL-2026 present", async () => {
    expect(await taxTableCoverage(t.db, 2026)).toEqual({
      year: 2026,
      federal: true,
      missingStates: [],
    });
  });

  it("2025 is covered: federal row present, IL-2025 present", async () => {
    expect(await taxTableCoverage(t.db, 2025)).toEqual({
      year: 2025,
      federal: true,
      missingStates: [],
    });
  });

  it("2027 is not: no federal row, IL listed as missing", async () => {
    expect(await taxTableCoverage(t.db, 2027)).toEqual({
      year: 2027,
      federal: false,
      missingStates: ["IL"],
    });
  });
});

describe("V2 who counts: unpaid, terminated, and out-of-year work states add nothing", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestApp();
    await seedDatabase(t.db as unknown as SeedDb);
    // Like the QA NY/MD residence personas: a work state, no compensation.
    await addEmployee(t, {
      name: "Synthetic Unpaid NY",
      work: [{ state: "NY", from: "2024-01-01", to: null }],
    });
    // Terminated: compensation and a work state, but not active.
    await addEmployee(t, {
      name: "Synthetic Terminated CA",
      status: "terminated",
      comp: [{ from: "2024-01-01", to: null }],
      work: [{ state: "CA", from: "2024-01-01", to: null }],
    });
    // Paid throughout; worked in MD until 2026-01-01 (exclusive), TX after.
    await addEmployee(t, {
      name: "Synthetic Mover MD TX",
      comp: [{ from: "2024-01-01", to: null }],
      work: [
        { state: "MD", from: "2024-01-01", to: "2026-01-01" },
        { state: "TX", from: "2026-01-01", to: null },
      ],
    });
    // Works in NJ throughout, but pay ended 2026-01-01 (exclusive).
    await addEmployee(t, {
      name: "Synthetic Former NJ",
      comp: [{ from: "2024-01-01", to: "2026-01-01" }],
      work: [{ state: "NJ", from: "2024-01-01", to: null }],
    });
    // No work state at all: federal only, adds nothing.
    await addEmployee(t, {
      name: "Synthetic No Work State",
      comp: [{ from: "2024-01-01", to: null }],
    });
  }, 120_000);
  afterAll(async () => t.close());

  it("2026: MD row ended before the year, NJ pay ended before the year, NY unpaid, CA terminated → nothing missing", async () => {
    expect(await taxTableCoverage(t.db, 2026)).toEqual({
      year: 2026,
      federal: true,
      missingStates: [],
    });
  });

  it("2025: MD and NJ (paid, working there, no 2025 table) are missing, sorted; NY unpaid and CA terminated are not", async () => {
    expect(await taxTableCoverage(t.db, 2025)).toEqual({
      year: 2025,
      federal: true,
      missingStates: ["MD", "NJ"],
    });
  });

  it("2027: TX (current work state, no 2027 table) is the only missing state", async () => {
    expect(await taxTableCoverage(t.db, 2027)).toEqual({
      year: 2027,
      federal: false,
      missingStates: ["TX"],
    });
  });

  it("latestCoveredYear skips an incomplete earlier year: 2026 even though 2025 is incomplete", async () => {
    expect(await latestCoveredYear(t.db, 2027)).toBe(2026);
    expect(await latestCoveredYear(t.db, 2025)).toBeNull();
  });
});

describe("V3 latestCoveredYear follows federal AND state coverage", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestApp();
    await seedDatabase(t.db as unknown as SeedDb);
    await addEmployee(t, {
      name: "Synthetic Illinois Worker",
      comp: [{ from: "2024-01-01", to: null }],
      work: [{ state: "IL", from: "2024-01-01", to: null }],
    });
  }, 120_000);
  afterAll(async () => t.close());

  it("bundled tables only: 2026 on or before 2027, 2026 on or before 2026, 2025 on or before 2025, null before 2025", async () => {
    expect({
      y2027: await latestCoveredYear(t.db, 2027),
      y2026: await latestCoveredYear(t.db, 2026),
      y2025: await latestCoveredYear(t.db, 2025),
      y2024: await latestCoveredYear(t.db, 2024),
    }).toEqual({ y2027: 2026, y2026: 2026, y2025: 2025, y2024: null });
  });

  it("SYNTHETIC federal 2027 only: still 2026 (IL-2027 missing)", async () => {
    await seedSyntheticFederal2027(t.db);
    expect(await taxTableCoverage(t.db, 2027)).toEqual({
      year: 2027,
      federal: true,
      missingStates: ["IL"],
    });
    expect(await latestCoveredYear(t.db, 2027)).toBe(2026);
  });

  it("SYNTHETIC federal 2027 + IL-2027: 2027", async () => {
    await seedSyntheticIl2027(t.db);
    expect(await taxTableCoverage(t.db, 2027)).toEqual({
      year: 2027,
      federal: true,
      missingStates: [],
    });
    expect(await latestCoveredYear(t.db, 2027)).toBe(2027);
    // Never looks past `onOrBefore`.
    expect(await latestCoveredYear(t.db, 2026)).toBe(2026);
  });
});

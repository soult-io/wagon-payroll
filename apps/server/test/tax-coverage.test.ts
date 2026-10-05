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
 *                     (effective_to exclusive), for which the run resolver
 *                     (resolveStateTaxConfig: "<code>:<mapped status>", then
 *                     "<code>"; progressive needs brackets) finds no config for
 *                     that employee's filing status (V4–V5). No work state →
 *                     nothing (federal only).
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
  stateTaxBrackets,
  stateTaxConfigs,
  stateWithholdingElections,
  w4Elections,
  type SeedDb,
} from "@payroll/db";
import { mapStateFilingStatus, resolveStateTaxConfig } from "../src/payroll/resolve.js";
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

// Steps build on each other (one database, seeded in order): never shuffled.
describe("V3 latestCoveredYear follows federal AND state coverage", {
  shuffle: false,
}, () => {
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

// ---------------------------------------------------------------------------
// V4–V5 (code review HIGH, PAY-81): coverage must agree with the run resolver.
//
// resolveStateTaxConfig (src/payroll/resolve.ts) looks up the jurisdiction
// "<state>:<mapped status>" first, then "<state>", and treats a 'progressive'
// config with no brackets (same fallback order) as not found. The status is
// the employee's state election filing status if any, else the federal W-4's,
// mapped by mapStateFilingStatus (married_separate → single). Contract
// assumed: a work state is missing for year Y exactly when, for some active
// W-2 employee paid in Y and working there in Y, that lookup returns null for
// the employee's filing status in Y. (Every employee below has one status for
// the whole year, so "status as of which date" does not matter here.)
// ---------------------------------------------------------------------------

type FilingStatus = "single" | "married_joint" | "married_separate" | "head_of_household";

async function addPaidEmployee(
  t: TestContext,
  opts: { name: string; state: string; year: number; w4: FilingStatus; election?: FilingStatus },
): Promise<void> {
  const [row] = await t.db
    .insert(employees)
    .values({
      companyId: await companyId(t),
      employmentType: "w2",
      legalName: opts.name,
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
    stateCode: opts.state,
    effectiveFrom: "2024-01-01",
    effectiveTo: null,
  });
  await t.db.insert(w4Elections).values({
    employeeId: row.id,
    taxYear: opts.year,
    filingStatus: opts.w4,
    federalExempt: false,
    effectiveFrom: `${opts.year}-01-01`,
    filedDate: `${opts.year - 1}-12-15`,
    renewalDeadline: null,
  });
  if (opts.election) {
    await t.db.insert(stateWithholdingElections).values({
      employeeId: row.id,
      stateCode: opts.state,
      filingStatus: opts.election,
      effectiveFrom: `${opts.year}-01-01`,
      filedDate: `${opts.year - 1}-12-15`,
    });
  }
}

/** SYNTHETIC — TEST ONLY: a state config row (not a published table). */
async function synState(
  t: TestContext,
  jurisdiction: string,
  year: number,
  kind: "flat" | "progressive",
): Promise<void> {
  await t.db.insert(stateTaxConfigs).values({
    jurisdiction,
    taxYear: year,
    kind,
    flatRate: kind === "flat" ? "0.0300" : null,
    note: "SYNTHETIC — TEST ONLY (PAY-81 V5)",
  });
}

/** SYNTHETIC — TEST ONLY: one open bracket under `jurisdiction`. */
async function synBracket(t: TestContext, jurisdiction: string, year: number): Promise<void> {
  await t.db.insert(stateTaxBrackets).values({
    jurisdiction,
    taxYear: year,
    ordinal: 1,
    minAmount: "0.00",
    maxAmount: null,
    rate: "0.0300",
  });
}

/** States where the resolver finds no config for at least one employee working there. */
async function resolverMissing(
  t: TestContext,
  year: number,
  people: { state: string; w4: FilingStatus; election?: FilingStatus }[],
): Promise<string[]> {
  const out = new Set<string>();
  for (const p of people) {
    const found = await resolveStateTaxConfig(
      t.db,
      p.state,
      year,
      mapStateFilingStatus(p.election ?? p.w4),
    );
    if (!found) out.add(p.state);
  }
  return [...out].sort();
}

describe("V4 bundled 2026 seeds: CA (status-specific rows only, no bare 'CA' row) is covered", () => {
  let t: TestContext;
  const people: { name: string; state: string; w4: FilingStatus }[] = [
    { name: "Synthetic CA Single", state: "CA", w4: "single" },
    { name: "Synthetic CA Joint", state: "CA", w4: "married_joint" },
    { name: "Synthetic CA Head", state: "CA", w4: "head_of_household" },
    { name: "Synthetic CA Separate", state: "CA", w4: "married_separate" },
  ];
  beforeAll(async () => {
    t = await createTestApp();
    await seedDatabase(t.db as unknown as SeedDb);
    for (const p of people) await addPaidEmployee(t, { ...p, year: 2026 });
  }, 120_000);
  afterAll(async () => t.close());

  it("the resolver finds a CA 2026 config for every one of them (precondition)", async () => {
    expect(await resolverMissing(t, 2026, people)).toEqual([]);
  });

  it("taxTableCoverage(2026) = { federal: true, missingStates: [] }", async () => {
    expect(await taxTableCoverage(t.db, 2026)).toEqual({
      year: 2026,
      federal: true,
      missingStates: [],
    });
  });

  it("latestCoveredYear(2026) = 2026", async () => {
    expect(await latestCoveredYear(t.db, 2026)).toBe(2026);
  });
});

// One describe, one database, steps in order: never shuffled.
describe("V5 coverage agrees with resolveStateTaxConfig (synthetic 2025 state rows)", {
  shuffle: false,
}, () => {
  // 2025: only IL and TX are bundled, so every state below starts with no
  // 2025 row and gets SYNTHETIC test-only rows.
  const YEAR = 2025;
  const people: {
    name: string;
    state: string;
    w4: FilingStatus;
    election?: FilingStatus;
  }[] = [
    // Only CA:single exists; this employee is married_joint → resolver null.
    { name: "Synthetic CA Joint", state: "CA", w4: "married_joint" },
    // Same state, status that has a row → found (CA still missing: see above).
    { name: "Synthetic CA Single", state: "CA", w4: "single" },
    // Bare row only → fallback finds it.
    { name: "Synthetic GA Single", state: "GA", w4: "single" },
    // married_separate maps to single → NJ:single found.
    { name: "Synthetic NJ Separate", state: "NJ", w4: "married_separate" },
    // State election status (head_of_household) wins over the W-4 (single);
    // only OR:single exists → resolver null.
    { name: "Synthetic OR Election", state: "OR", w4: "single", election: "head_of_household" },
    // Bare progressive config without brackets → resolver null.
    { name: "Synthetic NY Single", state: "NY", w4: "single" },
    // Status config progressive, brackets only under the bare code → found.
    { name: "Synthetic MN Head", state: "MN", w4: "head_of_household" },
  ];
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestApp();
    await seedDatabase(t.db as unknown as SeedDb);
    for (const p of people) await addPaidEmployee(t, { ...p, year: YEAR });
    await synState(t, "CA:single", YEAR, "flat");
    await synState(t, "GA", YEAR, "flat");
    await synState(t, "NJ:single", YEAR, "flat");
    await synState(t, "OR:single", YEAR, "flat");
    await synState(t, "NY", YEAR, "progressive");
    await synState(t, "MN:head_of_household", YEAR, "progressive");
    await synBracket(t, "MN", YEAR);
  }, 120_000);
  afterAll(async () => t.close());

  it("step 1: missing = CA (married_joint has no row, no bare row), NY (progressive, no brackets), OR (election status has no row); equals the resolver", async () => {
    const coverage = await taxTableCoverage(t.db, YEAR);
    expect({
      coverage,
      resolver: await resolverMissing(t, YEAR, people),
    }).toEqual({
      coverage: { year: YEAR, federal: true, missingStates: ["CA", "NY", "OR"] },
      resolver: ["CA", "NY", "OR"],
    });
  });

  it("step 2: a bare CA row and NY brackets are added → only OR missing; equals the resolver", async () => {
    await synState(t, "CA", YEAR, "flat");
    await synBracket(t, "NY", YEAR);
    expect({
      coverage: await taxTableCoverage(t.db, YEAR),
      resolver: await resolverMissing(t, YEAR, people),
      latest: await latestCoveredYear(t.db, YEAR),
    }).toEqual({
      coverage: { year: YEAR, federal: true, missingStates: ["OR"] },
      resolver: ["OR"],
      latest: null,
    });
  });

  it("step 3: OR:head_of_household is added → covered; latestCoveredYear(2025) = 2025", async () => {
    await synState(t, "OR:head_of_household", YEAR, "flat");
    expect({
      coverage: await taxTableCoverage(t.db, YEAR),
      resolver: await resolverMissing(t, YEAR, people),
      latest: await latestCoveredYear(t.db, YEAR),
    }).toEqual({
      coverage: { year: YEAR, federal: true, missingStates: [] },
      resolver: [],
      latest: YEAR,
    });
  });
});

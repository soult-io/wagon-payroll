/**
 * PAY-81 + year-rollover guard brief §4.2 / §5 (R1, R2, R3, R6, R7, R8 and the
 * extra calendar points 2026-10-05 and 2027-12-20), fresh database per date.
 * payroll-calc-auditor, fail-first; the coder may not edit this file.
 *
 * Every date is injected through `seedQaDataset(deps, { today })`; no fake
 * timers. Each database boots with btree_gist so `compensation_no_overlap` is
 * live (qa-seed-rollover-harness.ts).
 *
 * Contract assumed (brief §4.2, owner decision D-C = C1, D-A = A1, D-B = B1):
 * - L = latestCoveredYear(db, year(today)), computed after the personas and
 *   their work states exist. Bundled tables: federal 2025 + 2026, IL 2025 +
 *   2026; Ada works in IL, Bob (TX) and Carol (WA) have no work-state row, the
 *   NY/MD personas are unpaid. So L = 2026 for every date from 2026 to 2028.
 * - historyMonths(today, L): L = Y → (Y−1)-01..(Y−1)-12 + Y-01..Y-(M−1);
 *   L < Y → (L−1)-01..(L−1)-12 + L-01..L-12. `L` defaults to year(today), so
 *   the existing one-argument call stays valid.
 * - Current-period draft (Ada) only when L = Y.
 * - QaSeedSummary.payroll gains latestCoveredYear, historyThrough
 *   ("YYYY-MM" | null) and draftPeriod ("YYYY-MM" | null).
 * - W-4 rows for every year L−1..Y.
 * - Bob's ladder (D-B1): at L = 2026 exactly today's live-QA rows.
 * - No synthetic tax tables are ever written by the seed.
 * - L null → reject "qa seed: no installed tax year on or before <year>", no PII.
 * - The APP_ENV=qa / NODE_ENV=test guard still runs first.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authUser, company, employees, payrollRuns, seedDatabase, type SeedDb } from "@payroll/db";
import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { historyMonths } from "../src/qa/seed-qa.js";
import { seedSyntheticFederal2027 } from "./fixtures/synthetic-2027.js";
import {
  BOB_ROWS_2026,
  bobRows,
  bobShape,
  bootWithOverlapConstraint,
  monthRange,
  mustSeed,
  overlapConstraintLive,
  rowCounts,
  runFacts,
  seedAt,
  tableYears,
  w4Years,
  type SeedOutcome,
} from "./qa-seed-rollover-harness.js";
import type { TestContext } from "./helpers.js";

const PERSONA_NAMES = [
  "Ada Testworth",
  "Bob Fakeley",
  "Carol Mockington",
  "Nia NYC",
  "Yuri Yonkers",
  "Mara Maryland",
  "Quinn Adminster",
];

interface Case {
  today: string;
  L: number;
  /** First and last issued month (inclusive) per paid persona. */
  from: string;
  through: string;
  draft: string | null;
  w4: number[];
  /** Run the seed a second time the same day (idempotency, R2). */
  rerun: boolean;
}

const CASES: Case[] = [
  // Today's behaviour, unchanged (covered year): 21 months + Ada's draft.
  {
    today: "2026-10-05",
    L: 2026,
    from: "2025-01",
    through: "2026-09",
    draft: "2026-10",
    w4: [2025, 2026],
    rerun: true,
  },
  // R1: first working day after the rollover, no 2027 tables.
  {
    today: "2027-01-02",
    L: 2026,
    from: "2025-01",
    through: "2026-12",
    draft: null,
    w4: [2025, 2026, 2027],
    rerun: false,
  },
  // R2: January 2027 is NOT issued while 2027 is uncovered; second call is a no-op.
  {
    today: "2027-02-02",
    L: 2026,
    from: "2025-01",
    through: "2026-12",
    draft: null,
    w4: [2025, 2026, 2027],
    rerun: true,
  },
  // Late in the uncovered year.
  {
    today: "2027-12-20",
    L: 2026,
    from: "2025-01",
    through: "2026-12",
    draft: null,
    w4: [2025, 2026, 2027],
    rerun: false,
  },
  // R3: tables stale by a year — still 2 years of history (guards against A2).
  {
    today: "2028-01-03",
    L: 2026,
    from: "2025-01",
    through: "2026-12",
    draft: null,
    w4: [2025, 2026, 2027, 2028],
    rerun: false,
  },
];

describe.each(CASES)("QA seed on a fresh database at $today", (c) => {
  let t: TestContext;
  let first: SeedOutcome;
  let second: SeedOutcome | undefined;
  let countsAfterFirst: Record<string, number>;
  let countsAfterSecond: Record<string, number> | undefined;
  const months = monthRange(c.from, c.through);

  beforeAll(async () => {
    t = await bootWithOverlapConstraint();
    first = await seedAt(t, c.today);
    countsAfterFirst = await rowCounts(t);
    if (c.rerun) {
      second = await seedAt(t, c.today);
      countsAfterSecond = await rowCounts(t);
    }
  }, 300_000);
  afterAll(async () => t.close());

  it("boots with migration 0001 applied in full (compensation_no_overlap live)", async () => {
    expect({ skipped: t.skippedStatements, live: await overlapConstraintLive(t) }).toEqual({
      skipped: [],
      live: true,
    });
  });

  it(`resolves; summary: latestCoveredYear ${c.L}, historyThrough ${c.through}, draftPeriod ${c.draft}`, () => {
    const { payroll } = mustSeed(first);
    expect({
      latestCoveredYear: payroll.latestCoveredYear,
      historyThrough: payroll.historyThrough,
      draftPeriod: payroll.draftPeriod,
      draftCreated: payroll.draftCreated,
      issued: payroll.issued,
      existing: payroll.existing,
    }).toEqual({
      latestCoveredYear: c.L,
      historyThrough: c.through,
      draftPeriod: c.draft,
      draftCreated: c.draft !== null,
      issued: 3 * months.length,
      existing: 0,
    });
  });

  it(`issues ${c.from}..${c.through} for Ada, Bob and Carol (${months.length} months each) and nothing later`, async () => {
    const { summary } = mustSeed(first);
    const facts = await runFacts(t, summary.w2);
    expect(facts.issuedMonths).toEqual({ ada: months, bob: months, carol: months });
    expect(facts.open).toEqual(c.draft ? [`ada:${c.draft}`] : []);
    // No run (any status) pays after the last covered month or the draft.
    expect(facts.maxPayDate).toBe(`${c.draft ?? c.through}-15`);
  });

  it("writes no tax tables of its own: federal years stay 2025 + 2026, no state table after 2026 (no fake tax numbers)", async () => {
    mustSeed(first);
    expect(await tableYears(t)).toEqual({ federal: [2025, 2026], maxStateYear: 2026 });
  });

  it("Bob's ladder at L = 2026 is exactly today's live-QA rows", async () => {
    const { summary } = mustSeed(first);
    expect(bobShape(await bobRows(t, summary.w2.bob))).toEqual(BOB_ROWS_2026);
  });

  it(`W-4 rows for every year L−1..Y: ${c.w4.join(", ")}`, async () => {
    const { summary } = mustSeed(first);
    expect({
      ada: await w4Years(t, summary.w2.ada),
      bob: await w4Years(t, summary.w2.bob),
      carol: await w4Years(t, summary.w2.carol),
    }).toEqual({ ada: c.w4, bob: c.w4, carol: c.w4 });
  });

  if (c.rerun) {
    it("R2: a second seed the same day is a no-op (issued 0, no draft, row counts unchanged)", () => {
      mustSeed(first);
      const { payroll } = mustSeed(second);
      expect({
        issued: payroll.issued,
        existing: payroll.existing,
        draftCreated: payroll.draftCreated,
        latestCoveredYear: payroll.latestCoveredYear,
        historyThrough: payroll.historyThrough,
        draftPeriod: payroll.draftPeriod,
        counts: countsAfterSecond,
      }).toEqual({
        issued: 0,
        existing: 3 * months.length,
        draftCreated: false,
        latestCoveredYear: c.L,
        historyThrough: c.through,
        draftPeriod: c.draft,
        counts: countsAfterFirst,
      });
    });
  }
});

describe("R6 federal 2027 present, IL-2027 missing (Ada works in IL), today 2027-03-02", () => {
  let t: TestContext;
  let outcome: SeedOutcome;
  beforeAll(async () => {
    t = await bootWithOverlapConstraint();
    await seedDatabase(t.db as unknown as SeedDb);
    // SYNTHETIC — NOT PUBLISHED 2027 VALUES — TEST ONLY (federal only).
    await seedSyntheticFederal2027(t.db);
    outcome = await seedAt(t, "2027-03-02");
  }, 300_000);
  afterAll(async () => t.close());

  it("resolves with latestCoveredYear 2026, history through 2026-12, no draft", () => {
    const { payroll } = mustSeed(outcome);
    expect({
      latestCoveredYear: payroll.latestCoveredYear,
      historyThrough: payroll.historyThrough,
      draftPeriod: payroll.draftPeriod,
      issued: payroll.issued,
    }).toEqual({
      latestCoveredYear: 2026,
      historyThrough: "2026-12",
      draftPeriod: null,
      issued: 72,
    });
  });

  it("no 2027 run for anyone (Bob and Carol have no work state, but the year is still uncovered)", async () => {
    const { summary } = mustSeed(outcome);
    const facts = await runFacts(t, summary.w2);
    expect({ open: facts.open, maxPayDate: facts.maxPayDate }).toEqual({
      open: [],
      maxPayDate: "2026-12-15",
    });
  });
});

describe("R7 no installed tax year on or before today (today 2024-06-01)", () => {
  let t: TestContext;
  let outcome: SeedOutcome;
  let runsAfter = -1;
  beforeAll(async () => {
    t = await bootWithOverlapConstraint();
    outcome = await seedAt(t, "2024-06-01");
    const [row] = await t.db.select({ n: sql<number>`count(*)::int` }).from(payrollRuns);
    runsAfter = row?.n ?? -1;
  }, 300_000);
  afterAll(async () => t.close());

  it("rejects with the fixed message naming the year, no PII, and no payroll run written", () => {
    expect(outcome.ok).toBe(false);
    const message = outcome.ok ? "" : outcome.error;
    expect(message).toMatch(/^qa seed: no installed tax year on or before 2024\b/);
    // Names the fix: the tax tables / the bundled seed.
    expect(message).toMatch(/tax tables|seed/i);
    for (const name of PERSONA_NAMES) expect(message).not.toContain(name);
    expect(message).not.toMatch(/\d{9}/); // no SSN/TIN/EIN-shaped digits
    expect(message).not.toMatch(/\d+\.\d{2}/); // no amounts
    expect(runsAfter).toBe(0);
  });
});

describe("R8 historyMonths(today, L) — pure", () => {
  const ym = (months: { year: number; month: number }[]) =>
    months.map((m) => `${m.year}-${String(m.month).padStart(2, "0")}`);

  it("(2026-08-20, 2026) → 2025-01..2026-07 (today's case, unchanged)", () => {
    expect(ym(historyMonths("2026-08-20", 2026))).toEqual(monthRange("2025-01", "2026-07"));
  });
  it("one-argument call is unchanged: (2026-08-20) = (2026-08-20, 2026)", () => {
    expect(historyMonths("2026-08-20")).toEqual(historyMonths("2026-08-20", 2026));
  });
  it("(2027-01-02, 2026) → 2025-01..2026-12", () => {
    expect(ym(historyMonths("2027-01-02", 2026))).toEqual(monthRange("2025-01", "2026-12"));
  });
  it("(2027-01-02, 2027) → 2026-01..2026-12", () => {
    expect(ym(historyMonths("2027-01-02", 2027))).toEqual(monthRange("2026-01", "2026-12"));
  });
  it("(2028-01-03, 2026) → 2025-01..2026-12", () => {
    expect(ym(historyMonths("2028-01-03", 2026))).toEqual(monthRange("2025-01", "2026-12"));
  });
  it("(2027-12-20, 2026) → 2025-01..2026-12 (no 2027 month leaks in)", () => {
    expect(ym(historyMonths("2027-12-20", 2026))).toEqual(monthRange("2025-01", "2026-12"));
  });
});

describe("seed env guard at an uncovered date (2027-01-02)", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await bootWithOverlapConstraint();
  }, 120_000);
  afterAll(async () => t.close());

  it('appEnv "production" / nodeEnv "production": still refused first, fixed message, nothing written', async () => {
    const count = async () => {
      const n = async (table: PgTable): Promise<number> => {
        const [row] = await t.db.select({ n: sql<number>`count(*)::int` }).from(table);
        return row?.n ?? 0;
      };
      return {
        company: await n(company),
        employees: await n(employees),
        users: await n(authUser),
        runs: await n(payrollRuns),
      };
    };
    const before = await count();
    const outcome = await seedAt(t, "2027-01-02", {
      ...t.config,
      appEnv: "production",
      nodeEnv: "production",
    });
    expect({
      ok: outcome.ok,
      error: outcome.ok ? "" : outcome.error,
      after: await count(),
    }).toEqual({
      ok: false,
      error: "QA seed refused: it runs only with APP_ENV=qa or in a test boot",
      after: before,
    });
  });

  it('appEnv "qa" / nodeEnv "production" (the QA stack app-seed one-shot): resolves with latestCoveredYear 2026', async () => {
    const outcome = await seedAt(t, "2027-01-02", {
      ...t.config,
      appEnv: "qa",
      nodeEnv: "production",
    });
    const { payroll } = mustSeed(outcome);
    expect({ L: payroll.latestCoveredYear, draft: payroll.draftPeriod }).toEqual({
      L: 2026,
      draft: null,
    });
  });
});

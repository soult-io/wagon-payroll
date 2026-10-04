/**
 * PAY-81: the QA seed on a PERSISTENT database across a year rollover, with
 * the `compensation_no_overlap` exclusion constraint LIVE (PGlite + btree_gist).
 * Brief §5 R4, R5, plus two cases the brief implies:
 *  - R5b convergence: a fresh database seeded once at the same date ends with
 *    the same Bob rows as the persistent one.
 *  - R4b the literal PAY-81 sequence (seed in year N, then N+1, same DB) with
 *    REAL bundled tables only: N = 2025 → N+1 = 2026.
 * payroll-calc-auditor, fail-first; the coder may not edit this file.
 *
 * Dates are injected via `seedQaDataset(deps, { today })`; no fake timers.
 * Synthetic 2027 rows come from fixtures/synthetic-2027.ts (TEST ONLY, never
 * product seed data). No tax amount is asserted here: only run statuses,
 * months and Bob's compensation rows (input data, not tax math).
 *
 * Contract assumed: as in qa-seed-rollover.test.ts, plus the D-B1 ladder:
 * base [2024-11-01, 2026-07-01) 3800.00; for each Y in 2026..L a row from
 * Y-07-01 at 3800.00 + 400.00 × (Y − 2025); only the newest is open-ended.
 * When L moves up the seed CLOSES the open row in place (same id,
 * effective_to = L-07-01) and inserts the new open row.
 * The shape of Bob's rows at L = 2025 is NOT asserted (the brief's base row
 * ends 2026-07-01 while "only the newest row is open-ended" would make it
 * open at L = 2025; both readings converge to BOB_ROWS_2026 at L = 2026, which
 * is what R4b asserts).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDatabase, type SeedDb } from "@payroll/db";
import {
  seedSyntheticFederal2027,
  seedSyntheticIl2027,
  seedSyntheticIlDepositSchedule2027,
} from "./fixtures/synthetic-2027.js";
import {
  BOB_ROWS_2026,
  BOB_ROWS_2027,
  bobRows,
  bobShape,
  bootWithOverlapConstraint,
  monthRange,
  mustSeed,
  overlapConstraintLive,
  rowCounts,
  runFacts,
  runStatus,
  seedAt,
  type BobRow,
  type SeedOutcome,
} from "./qa-seed-rollover-harness.js";
import type { TestContext } from "./helpers.js";

/** SYNTHETIC — NOT PUBLISHED 2027 VALUES — TEST ONLY: federal + IL + IL deposit schedule. */
async function installSynthetic2027(t: TestContext): Promise<void> {
  await seedSyntheticFederal2027(t.db);
  await seedSyntheticIl2027(t.db);
  await seedSyntheticIlDepositSchedule2027(t.db);
}

describe("R4 + R5 persistent DB: 2026-12-15 → 2027-01-02 → 2027-02-02 → (2027 tables land) → 2027-03-02 ×2", () => {
  let t: TestContext;
  let s1: SeedOutcome;
  let bob1: BobRow[] = [];
  let adaDecDraft: { publicId: string; status: string } | null = null;

  beforeAll(async () => {
    t = await bootWithOverlapConstraint();
    s1 = await seedAt(t, "2026-12-15");
    if (s1.ok) {
      bob1 = await bobRows(t, s1.summary.w2.bob);
      adaDecDraft = await runStatus(t, s1.summary.w2.ada, "2026-12");
    }
  }, 300_000);
  afterAll(async () => t.close());

  it("the overlap constraint is live (skippedStatements empty) — the gap that hid PAY-81 from CI", async () => {
    expect({ skipped: t.skippedStatements, live: await overlapConstraintLive(t) }).toEqual({
      skipped: [],
      live: true,
    });
  });

  it("run 1 (2026-12-15): covered year; history 2025-01..2026-11, Ada's 2026-12 draft awaiting approval, Bob = today's rows", () => {
    const { payroll } = mustSeed(s1);
    expect({
      L: payroll.latestCoveredYear,
      through: payroll.historyThrough,
      draft: payroll.draftPeriod,
      adaDec: adaDecDraft?.status,
      bob: bobShape(bob1),
    }).toEqual({
      L: 2026,
      through: "2026-11",
      draft: "2026-12",
      adaDec: "awaiting_approval",
      bob: BOB_ROWS_2026,
    });
  });

  it("run 2 (2027-01-02, no 2027 tables): resolves; Ada's 2026-12 draft from run 1 is now issued; Bob's rows identical", async () => {
    const { summary } = mustSeed(s1);
    const s2 = await seedAt(t, "2027-01-02");
    const { payroll } = mustSeed(s2);
    const adaDec = await runStatus(t, summary.w2.ada, "2026-12");
    const facts = await runFacts(t, summary.w2);
    expect({
      L: payroll.latestCoveredYear,
      through: payroll.historyThrough,
      draft: payroll.draftPeriod,
      draftCreated: payroll.draftCreated,
      // Bob + Carol 2026-12 are new; Ada's 2026-12 already existed (the draft).
      issued: payroll.issued,
      adaDec,
      open: facts.open,
      bob: await bobRows(t, summary.w2.bob),
    }).toEqual({
      L: 2026,
      through: "2026-12",
      draft: null,
      draftCreated: false,
      issued: 2,
      adaDec: { publicId: adaDecDraft?.publicId, status: "issued" },
      open: [],
      bob: bob1,
    });
  });

  it("run 3 (2027-02-02): resolves; nothing new issued; Bob's rows identical", async () => {
    const { summary } = mustSeed(s1);
    const before = await rowCounts(t);
    const s3 = await seedAt(t, "2027-02-02");
    const { payroll } = mustSeed(s3);
    expect({
      issued: payroll.issued,
      draftCreated: payroll.draftCreated,
      L: payroll.latestCoveredYear,
      bob: await bobRows(t, summary.w2.bob),
      runs: (await rowCounts(t)).runs,
    }).toEqual({
      issued: 0,
      draftCreated: false,
      L: 2026,
      bob: bob1,
      runs: before.runs,
    });
  });

  it("R5 run 4 (2027 tables installed, 2027-03-02): no constraint error; 2027-01/02 issued for all three; Ada's 2027-03 draft; Bob's open row closed in place and the 4600.00 row added", async () => {
    const { summary } = mustSeed(s1);
    await installSynthetic2027(t);
    const s4 = await seedAt(t, "2027-03-02");
    const { payroll } = mustSeed(s4);
    const facts = await runFacts(t, summary.w2);
    const bob = await bobRows(t, summary.w2.bob);
    const history = monthRange("2025-01", "2027-02");
    expect({
      L: payroll.latestCoveredYear,
      through: payroll.historyThrough,
      draft: payroll.draftPeriod,
      draftCreated: payroll.draftCreated,
      issued: payroll.issued,
      issuedMonths: facts.issuedMonths,
      open: facts.open,
      bob: bobShape(bob),
      // Closed in place: the first two rows keep their ids.
      keptIds: bob.slice(0, 2).map((r) => r.id),
    }).toEqual({
      L: 2027,
      through: "2027-02",
      draft: "2027-03",
      draftCreated: true,
      issued: 6,
      issuedMonths: { ada: history, bob: history, carol: history },
      open: ["ada:2027-03"],
      bob: BOB_ROWS_2027,
      keptIds: bob1.map((r) => r.id),
    });
  });

  it("R5 run 5 (2027-03-02 again): idempotent — issued 0, no draft, row counts and Bob's rows unchanged", async () => {
    const { summary } = mustSeed(s1);
    const bobBefore = await bobRows(t, summary.w2.bob);
    const before = await rowCounts(t);
    const s5 = await seedAt(t, "2027-03-02");
    const { payroll } = mustSeed(s5);
    expect({
      issued: payroll.issued,
      draftCreated: payroll.draftCreated,
      counts: await rowCounts(t),
      bob: await bobRows(t, summary.w2.bob),
    }).toEqual({ issued: 0, draftCreated: false, counts: before, bob: bobBefore });
    expect(bobShape(bobBefore)).toEqual(BOB_ROWS_2027);
  });
});

describe("R5b convergence: a fresh DB seeded once at 2027-03-02 with 2027 tables ends with the same Bob rows", () => {
  let t: TestContext;
  let outcome: SeedOutcome;
  beforeAll(async () => {
    t = await bootWithOverlapConstraint();
    await seedDatabase(t.db as unknown as SeedDb);
    await installSynthetic2027(t);
    outcome = await seedAt(t, "2027-03-02");
  }, 300_000);
  afterAll(async () => t.close());

  it("Bob = the 2027 ladder; history (L−1)-01..L-(M−1) = 2026-01..2027-02; Ada's 2027-03 draft", async () => {
    const { summary, payroll } = mustSeed(outcome);
    const facts = await runFacts(t, summary.w2);
    const history = monthRange("2026-01", "2027-02");
    expect({
      L: payroll.latestCoveredYear,
      through: payroll.historyThrough,
      draft: payroll.draftPeriod,
      issued: payroll.issued,
      issuedMonths: facts.issuedMonths,
      open: facts.open,
      bob: bobShape(await bobRows(t, summary.w2.bob)),
    }).toEqual({
      L: 2027,
      through: "2027-02",
      draft: "2027-03",
      issued: 3 * history.length,
      issuedMonths: { ada: history, bob: history, carol: history },
      open: ["ada:2027-03"],
      bob: BOB_ROWS_2027,
    });
  });
});

describe("R4b PAY-81 literal sequence with real bundled tables: seed 2025-10-05, then 2026-10-05, same DB", () => {
  let t: TestContext;
  let n: SeedOutcome;
  let n1: SeedOutcome;
  beforeAll(async () => {
    t = await bootWithOverlapConstraint();
    n = await seedAt(t, "2025-10-05");
    n1 = await seedAt(t, "2026-10-05");
  }, 300_000);
  afterAll(async () => t.close());

  it("year N (2025-10-05): L = 2025; 2024 is uncovered so the window is 2025 only (2025-01..2025-09); Ada's 2025-10 draft", () => {
    const { payroll } = mustSeed(n);
    expect({
      L: payroll.latestCoveredYear,
      through: payroll.historyThrough,
      draft: payroll.draftPeriod,
      issued: payroll.issued,
    }).toEqual({ L: 2025, through: "2025-09", draft: "2025-10", issued: 27 });
  });

  it("year N+1 (2026-10-05): resolves on the same DB (no compensation_no_overlap error); Bob converges to today's rows; Ada's 2025-10 draft is issued", async () => {
    const { summary } = mustSeed(n);
    const { payroll } = mustSeed(n1);
    const facts = await runFacts(t, summary.w2);
    const history = monthRange("2025-01", "2026-09");
    expect({
      L: payroll.latestCoveredYear,
      through: payroll.historyThrough,
      draft: payroll.draftPeriod,
      issuedMonths: facts.issuedMonths,
      open: facts.open,
      bob: bobShape(await bobRows(t, summary.w2.bob)),
    }).toEqual({
      L: 2026,
      through: "2026-09",
      draft: "2026-10",
      issuedMonths: { ada: history, bob: history, carol: history },
      open: ["ada:2026-10"],
      bob: BOB_ROWS_2026,
    });
  });
});

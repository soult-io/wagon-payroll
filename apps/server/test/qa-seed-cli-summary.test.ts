/**
 * PAY-81 V6 (code review): the QA seed CLI summary must take the year from
 * the seed's own summary, never from the process clock, and must name the
 * missing state tables when today's year is not covered.
 * payroll-calc-auditor, fail-first; the coder may not edit this file.
 *
 * Contract assumed:
 * - QaPayrollSummary gains
 *     year: number            — year(today) as used by the seed;
 *     missingStates: string[] — taxTableCoverage(year).missingStates when
 *                               latestCoveredYear < year, else [].
 * - `formatQaSeedSummary(summary: QaSeedSummary): string[]` is exported from
 *   src/qa/seed-qa.ts and is what src/cli/seed-qa.ts prints (the CLI script
 *   itself runs at import against postgres-js, so it is not run here).
 *   When latestCoveredYear < year one line says
 *   "no current-period draft: <year> tax tables not installed" and names every
 *   code in missingStates. When covered it says "current-period draft <YYYY-MM>".
 *
 * Dates are injected with `today`; 2028-01-03 is a year neither the real clock
 * nor the clock-shift job (2027-01-02) can produce, so a clock-derived year
 * cannot pass by accident.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDatabase, type SeedDb } from "@payroll/db";
import * as seedQa from "../src/qa/seed-qa.js";
import { seedSyntheticFederal2027 } from "./fixtures/synthetic-2027.js";
import { createTestApp, type TestContext } from "./helpers.js";

type Summary = Awaited<ReturnType<typeof seedQa.seedQaDataset>>;
type PayrollV6 = Summary["payroll"] & { year?: number; missingStates?: string[] };

/** The exported formatter, or a failing stand-in that names the missing export. */
function format(summary: Summary): string[] {
  const fn = (seedQa as Record<string, unknown>).formatQaSeedSummary;
  if (typeof fn !== "function") {
    throw new Error("src/qa/seed-qa.ts does not export formatQaSeedSummary(summary): string[]");
  }
  return (fn as (s: Summary) => string[])(summary);
}

async function seedFresh(
  today: string,
  before?: (t: TestContext) => Promise<void>,
): Promise<{ t: TestContext; summary: Summary }> {
  const t = await createTestApp();
  if (before) await before(t);
  const summary = await seedQa.seedQaDataset(
    { db: t.db, auth: t.auth, config: t.config },
    { today },
  );
  return { t, summary };
}

describe("V6a today 2028-01-03 (tables stale by a year): year 2028, IL missing", () => {
  let t: TestContext;
  let summary: Summary;
  beforeAll(async () => {
    ({ t, summary } = await seedFresh("2028-01-03"));
  }, 300_000);
  afterAll(async () => t.close());

  it("summary.payroll: year 2028, latestCoveredYear 2026, missingStates [IL]", () => {
    const p = summary.payroll as PayrollV6;
    expect({ year: p.year, L: p.latestCoveredYear, missing: p.missingStates }).toEqual({
      year: 2028,
      L: 2026,
      missing: ["IL"],
    });
  });

  it("CLI lines: '2028 tax tables not installed' naming IL; no clock-derived year", () => {
    const lines = format(summary);
    const draftLine = lines.find((l) => l.includes("no current-period draft"));
    expect(draftLine).toBeDefined();
    expect(draftLine).toContain("no current-period draft: 2028 tax tables not installed");
    expect(draftLine).toMatch(/\bIL\b/);
    expect(lines.join("\n")).not.toMatch(/\b(2026|2027) tax tables not installed/);
  });
});

describe("V6b today 2027-03-02, federal 2027 present (SYNTHETIC), IL-2027 missing", () => {
  let t: TestContext;
  let summary: Summary;
  beforeAll(async () => {
    ({ t, summary } = await seedFresh("2027-03-02", async (ctx) => {
      await seedDatabase(ctx.db as unknown as SeedDb);
      // SYNTHETIC — NOT PUBLISHED 2027 VALUES — TEST ONLY (federal only).
      await seedSyntheticFederal2027(ctx.db);
    }));
  }, 300_000);
  afterAll(async () => t.close());

  it("summary.payroll: year 2027, latestCoveredYear 2026, missingStates [IL]", () => {
    const p = summary.payroll as PayrollV6;
    expect({ year: p.year, L: p.latestCoveredYear, missing: p.missingStates }).toEqual({
      year: 2027,
      L: 2026,
      missing: ["IL"],
    });
  });

  it("CLI lines: '2027 tax tables not installed' naming IL", () => {
    const draftLine = format(summary).find((l) => l.includes("no current-period draft"));
    expect(draftLine).toContain("no current-period draft: 2027 tax tables not installed");
    expect(draftLine).toMatch(/\bIL\b/);
  });
});

describe("V6c today 2026-10-05 (covered): year 2026, nothing missing, draft line", () => {
  let t: TestContext;
  let summary: Summary;
  beforeAll(async () => {
    ({ t, summary } = await seedFresh("2026-10-05"));
  }, 300_000);
  afterAll(async () => t.close());

  it("summary.payroll: year 2026, latestCoveredYear 2026, missingStates []", () => {
    const p = summary.payroll as PayrollV6;
    expect({ year: p.year, L: p.latestCoveredYear, missing: p.missingStates }).toEqual({
      year: 2026,
      L: 2026,
      missing: [],
    });
  });

  it("CLI lines: 'current-period draft 2026-10', no 'not installed'", () => {
    const text = format(summary).join("\n");
    expect(text).toContain("current-period draft 2026-10");
    expect(text).not.toContain("not installed");
  });
});

describe("V6d the CLI prints the formatter's lines and reads no clock", () => {
  it("src/cli/seed-qa.ts uses formatQaSeedSummary and contains no new Date( / Date.now(", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../src/cli/seed-qa.ts"), "utf8");
    expect({
      usesFormatter: src.includes("formatQaSeedSummary"),
      readsClock: /new Date\(|Date\.now\(/.test(src),
    }).toEqual({ usesFormatter: true, readsClock: false });
  });
});

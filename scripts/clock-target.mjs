#!/usr/bin/env node
// PAY-220: the date the clock-shift CI job moves the clock to — Jan 2 of the
// first year with no bundled federal tax tables, i.e. (latest bundled year + 1).
// It always tests "the first days of a year without tables", which recurs every
// January. When the next year's tables are seeded (BUNDLED_FEDERAL_TAX_YEARS in
// packages/db/src/seed.ts grows) the target moves forward by itself.
//
// Needs the workspace built (`pnpm -r run build`): it reads the list from
// packages/db/dist so the seed and this script share one source.
//
// Usage: node scripts/clock-target.mjs
// Prints two lines for $GITHUB_ENV (or `export` in a shell):
//   PAYROLL_CLOCK_SHIFT_DAYS=<whole days from today (UTC) to the target>
//   PAYROLL_CLOCK_TARGET=<YYYY-MM-DD>

import { fileURLToPath } from "node:url";

const DAY_MS = 86_400_000;

/** Jan 2 of the year after the latest bundled federal tax year (YYYY-MM-DD). */
export function clockTarget(bundledYears) {
  if (!Array.isArray(bundledYears) || bundledYears.length === 0) {
    throw new Error("clock-target: no bundled federal tax years");
  }
  if (!bundledYears.every((y) => Number.isInteger(y))) {
    throw new Error("clock-target: bundled federal tax years must be integers");
  }
  return `${Math.max(...bundledYears) + 1}-01-02`;
}

/** Whole days from the UTC calendar date of `nowMs` to `target` (YYYY-MM-DD). */
export function shiftDays(nowMs, target) {
  const todayUtc = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return Math.round((Date.parse(`${target}T00:00:00Z`) - todayUtc) / DAY_MS);
}

/** Read BUNDLED_FEDERAL_TAX_YEARS from the built @payroll/db seed module. */
export async function loadBundledYears() {
  const seed = new URL("../packages/db/dist/seed.js", import.meta.url);
  const { BUNDLED_FEDERAL_TAX_YEARS } = await import(seed.href);
  return BUNDLED_FEDERAL_TAX_YEARS;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = clockTarget(await loadBundledYears());
  process.stdout.write(
    `PAYROLL_CLOCK_SHIFT_DAYS=${shiftDays(Date.now(), target)}\nPAYROLL_CLOCK_TARGET=${target}\n`,
  );
}

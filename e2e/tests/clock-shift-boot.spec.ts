/**
 * PAY-225 (payroll-calc-auditor; the coder may not edit this file).
 *
 * Proves the clock-shift CI job really ran the suite at the shifted date, so
 * a green clock-shift job cannot be a real-clock run in disguise. Active only
 * when CLOCK_SHIFT_REQUIRED=1 (the clock-shift job sets it next to
 * PAYROLL_CLOCK_SHIFT_DAYS / PAYROLL_CLOCK_TARGET from scripts/clock-target.mjs);
 * skipped otherwise. Ephemeral boot only.
 *
 * - The runner's own clock is shifted: scripts/clock-shift.mjs marks the
 *   installed Date, and the runner's UTC date equals PAYROLL_CLOCK_TARGET.
 * - The server seeded at the shifted date: the target is Jan 2 of the first
 *   year without bundled tables, so the seed must report no current-period
 *   draft (state.json qa.draftPeriod === null) and a latest covered year below
 *   the target year. A server that booted on the real clock would have a
 *   draft (Spec 14 §2 as amended, D-C = C1).
 */

import { expect, test } from "@playwright/test";
import { LIVE_QA, loadEphemeralState } from "./qa.js";

const REQUIRED = process.env.CLOCK_SHIFT_REQUIRED === "1";

test("clock-shift job: runner and server both run at PAYROLL_CLOCK_TARGET (PAY-225)", () => {
  test.skip(!REQUIRED, "only in the clock-shift job (CLOCK_SHIFT_REQUIRED=1)");
  test.skip(LIVE_QA, "ephemeral boot only");

  const target = process.env.PAYROLL_CLOCK_TARGET;
  expect(target, "PAYROLL_CLOCK_TARGET set by scripts/clock-target.mjs").toMatch(
    /^\d{4}-\d{2}-\d{2}$/,
  );
  expect(
    Object.hasOwn(globalThis.Date, Symbol.for("wagon-payroll.clock-shift")),
    "scripts/clock-shift.mjs preloaded into the Playwright runner (NODE_OPTIONS)",
  ).toBe(true);
  expect(new Date().toISOString().slice(0, 10), "runner UTC date").toBe(target);

  const state = loadEphemeralState();
  expect(state, "e2e/.state/state.json written by e2e:serve").not.toBeNull();
  const qa = state?.qa;
  expect(qa?.draftPeriod, "server seeded at the shifted date: no current-period draft").toBeNull();
  expect(qa?.latestCoveredYear).toBeLessThan(Number(target?.slice(0, 4)));
});

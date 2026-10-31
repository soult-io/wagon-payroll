import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// Mutation runs only (stryker.targets.mjs). The Stryker vitest runner forces
// vitest's `threads` pool, and under it the PAY-220 clock-shift preload
// (`execArgv: ["--import", ...]`) makes every worker fail at start: the
// initial test run dies with "Worker threads emitted error" and no score.
// The preload is a no-op without PAYROLL_CLOCK_SHIFT_DAYS, so it is dropped
// here, and a shifted mutation run is refused instead of running unshifted.
if (process.env.PAYROLL_CLOCK_SHIFT_DAYS) {
  throw new Error("mutation runs do not support PAYROLL_CLOCK_SHIFT_DAYS; unset it");
}

const { execArgv: _clockShiftPreload, ...test } = base.test ?? {};

export default defineConfig({ ...base, test });

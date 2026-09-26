// Mutation-testing targets for the server's money-path modules (PAY-93,
// PAY-108). One Stryker run per module so each fits its own CI timeout and
// keeps its own threshold and incremental file.
//
// `testFiles` are GLOBS, not a list: a new suite named after its module is
// picked up without editing this file. A suite that imports the module but
// does not match a glob is caught by scripts/check-mutation-test-globs.mjs
// (CI verify job), so a missing suite fails CI instead of lowering the score.
//
// `break` sits a little below the measured score
// (plan/mutation-baseline-2026-09.md): a drop fails the run.

export const TARGETS = {
  deposits: {
    mutate: ["src/deposits/**/*.ts"],
    testFiles: [
      "test/*deposit*.test.ts",
      "test/pay-91-*.test.ts",
      // Imports computeDepositAmount from src/deposits.
      "test/filings.test.ts",
    ],
    thresholds: { high: 85, low: 70, break: 72 },
  },
  filings: {
    mutate: ["src/filings/**/*.ts"],
    testFiles: [
      "test/*filing*.test.ts",
      "test/*940*.test.ts",
      "test/*941*.test.ts",
      "test/annual*.test.ts",
      "test/futa-*.test.ts",
      // Import from src/filings without the module in their names.
      "test/calendar.test.ts",
      "test/mailing-address.test.ts",
      "test/state-deposit-transitions.test.ts",
    ],
    thresholds: { high: 80, low: 60, break: 65 },
  },
};

/**
 * Stryker options for one target.
 * @param {keyof typeof TARGETS} name
 * @returns {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export function strykerConfig(name) {
  const target = TARGETS[name];
  return {
    packageManager: "pnpm",
    testRunner: "vitest",
    plugins: ["@stryker-mutator/vitest-runner"],
    vitest: { configFile: "vitest.config.ts" },
    mutate: target.mutate,
    // Only the suites that exercise this module. Each file boots its own
    // PGlite, so running every suite per mutant would add hours for no signal.
    testFiles: target.testFiles,
    coverageAnalysis: "perTest",
    // Static mutants (module-level constants) force a full reload per mutant.
    ignoreStatic: true,
    incremental: true,
    incrementalFile: `reports/stryker-incremental-${name}.json`,
    reporters: ["html", "json", "clear-text", "progress"],
    htmlReporter: { fileName: `reports/mutation-${name}/index.html` },
    jsonReporter: { fileName: `reports/mutation-${name}/mutation.json` },
    // ubuntu-latest runners have 4 vCPUs.
    concurrency: 4,
    timeoutMS: 30_000,
    dryRunTimeoutMinutes: 15,
    tempDirName: `.stryker-tmp-${name}`,
    cleanTempDir: "always",
    thresholds: target.thresholds,
  };
}

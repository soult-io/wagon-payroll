// Mutation testing for the pure withholding engine (PAY-93). Run with
// `pnpm mutation:engine` from the repo root; see CONTRIBUTING.md.
// The HTML report holds only source code and mutant diffs — no env, no data.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "pnpm",
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner", "@stryker-mutator/typescript-checker"],
  // Drop mutants that do not type-check (they prove nothing about the tests).
  // ~25 s here; not used for the server, where the run is already ~20 min+.
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  vitest: { configFile: "vitest.config.ts" },
  mutate: ["src/**/*.ts"],
  coverageAnalysis: "perTest",
  // Only re-test mutants whose source or covering tests changed since the
  // last run. CI restores the file from the actions cache.
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",
  reporters: ["html", "json", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  // ubuntu-latest runners have 4 vCPUs.
  concurrency: 4,
  timeoutMS: 10_000,
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
  // Baseline 2026-09: break sits a little
  // below the measured score so a drop fails the run.
  thresholds: { high: 90, low: 80, break: 86 },
};

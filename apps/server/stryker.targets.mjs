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
// (recorded 2026-09): a drop fails the run.
//
// PAY-255: a full run is split into `shards` parallel CI jobs (a whole module
// no longer fits one 6-hour job); the merge job scores the module from all
// shard reports against `break`. Two env vars select what one run mutates:
//   STRYKER_SHARD="2/5"   shard 2 of 5 of the module (whole files, and large
//                         files cut at top-level statements; see shardUnits;
//                         no break here, the merge job judges the module)
//   STRYKER_MUTATE="src/filings/service.ts:120-180,..."
//                         only these files/line ranges (a PR's changed lines);
//                         judged against the module's break, not incremental
// Neither set: the whole module in one run (local use).

import { readFileSync, globSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  parseMutateList,
  parseShard,
  planShards,
  splitFile,
} from "../../scripts/mutation-shards.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const TARGETS = {
  deposits: {
    mutate: ["src/deposits/**/*.ts"],
    testFiles: [
      "test/*deposit*.test.ts",
      "test/pay-91-*.test.ts",
      // PAY-226: federal quarter netting (planner + sync).
      "test/pay-226-*.test.ts",
      // Imports computeDepositAmount from src/deposits.
      "test/filings.test.ts",
      // PAY-103: mocks syncDeposits around the deposit tick.
      "test/tax-tables-alert-scheduler.test.ts",
    ],
    thresholds: { high: 85, low: 70, break: 72 },
    shards: 3,
  },
  filings: {
    mutate: ["src/filings/**/*.ts"],
    testFiles: [
      "test/*filing*.test.ts",
      "test/*940*.test.ts",
      "test/*941*.test.ts",
      "test/annual*.test.ts",
      "test/futa-*.test.ts",
      // PAY-162: the W-2 box module suites (pure + integration).
      "test/w2-boxes*.test.ts",
      // PAY-116 (Spec 24 PR-2): the W-2 state-line suites (planner, figures, hash).
      "test/w2-state*.test.ts",
      // PAY-193: filed-return guard (closing-filings, markFiled lock).
      "test/pay-193-*.test.ts",
      // PAY-208: W-2 consent v2 (terms, channel, notices, contact).
      "test/pay-208-*.test.ts",
      // PAY-217: former employees keep W-2-only access (corrections, daily job).
      "test/pay-217-*.test.ts",
      // Import from src/filings without the module in their names.
      "test/calendar.test.ts",
      "test/mailing-address.test.ts",
      "test/state-deposit-transitions.test.ts",
      // PAY-116 (Spec 24 PR-4): the QA seed EIN suite reads W-2 figures.
      "test/qa-seed-ein.test.ts",
    ],
    thresholds: { high: 80, low: 60, break: 65 },
    // ~23 h of mutant testing at 2026-10-30. At 10 shards one shard (an
    // annual.ts range with 59 hanging mutants) needed ~5 h 05 m.
    shards: 12,
  },
};

/**
 * Stryker options for one target.
 * @param {keyof typeof TARGETS} name
 * @returns {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export function strykerConfig(name) {
  const target = TARGETS[name];
  const { mutate, suffix, incremental, thresholds } = selection(name, process.env);
  return {
    packageManager: "pnpm",
    testRunner: "vitest",
    plugins: ["@stryker-mutator/vitest-runner"],
    // The server suite config minus the clock-shift preload; see the file.
    vitest: { configFile: "vitest.mutation.config.ts" },
    mutate,
    // Only the suites that exercise this module. Each file boots its own
    // PGlite, so running every suite per mutant would add hours for no signal.
    testFiles: target.testFiles,
    coverageAnalysis: "perTest",
    // Static mutants (module-level constants) force a full reload per mutant.
    ignoreStatic: true,
    incremental,
    incrementalFile: `reports/stryker-incremental-${name}${suffix}.json`,
    reporters: ["html", "json", "clear-text", "progress"],
    htmlReporter: { fileName: `reports/mutation-${name}${suffix}/index.html` },
    jsonReporter: { fileName: `reports/mutation-${name}${suffix}/mutation.json` },
    // ubuntu-latest runners have 4 vCPUs.
    concurrency: 4,
    timeoutMS: 30_000,
    dryRunTimeoutMinutes: 15,
    tempDirName: `.stryker-tmp-${name}${suffix}`,
    cleanTempDir: "always",
    thresholds,
  };
}

/**
 * The files, report suffix, incremental mode and thresholds for one run,
 * from STRYKER_MUTATE / STRYKER_SHARD (see the top of this file).
 * @param {keyof typeof TARGETS} name
 * @param {Record<string, string | undefined>} env
 */
export function selection(name, env) {
  const target = TARGETS[name];
  if (env.STRYKER_MUTATE && env.STRYKER_SHARD)
    throw new Error("set STRYKER_MUTATE or STRYKER_SHARD, not both");
  if (env.STRYKER_MUTATE) {
    return {
      mutate: parseMutateList(env.STRYKER_MUTATE),
      suffix: "-changed",
      incremental: false,
      thresholds: target.thresholds,
    };
  }
  if (env.STRYKER_SHARD) {
    const { index, count } = parseShard(env.STRYKER_SHARD);
    const mutate = planShards(shardUnits(name, count), count)[index - 1];
    if (mutate.length === 0)
      throw new Error(`${name}: shard ${index}/${count} has no files; lower shards`);
    return {
      mutate,
      suffix: `-${index}of${count}`,
      incremental: true,
      thresholds: { ...target.thresholds, break: null },
    };
  }
  return { mutate: target.mutate, suffix: "", incremental: true, thresholds: target.thresholds };
}

/**
 * The module's units for `count` shards: whole files, with each file larger
 * than a sixth of a shard's share cut at top-level statements (splitFile).
 * Bytes only roughly predict test time (one 13 KB annual.ts range with many
 * hanging mutants took ~4 h at 2026-10-30), so units are kept small: a slow
 * range is spread over several shards instead of filling one.
 * @param {keyof typeof TARGETS} name
 * @param {number} count
 */
function shardUnits(name, count) {
  const files = mutateFiles(name).map((path) => {
    const text = readFileSync(resolve(HERE, path), "utf8");
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const line = (pos) => source.getLineAndCharacterOfPosition(pos).line + 1;
    const statements = source.statements.map((s) => ({
      startLine: line(s.getStart(source)),
      endLine: line(s.getEnd()),
      bytes: Buffer.byteLength(text.slice(s.getStart(source), s.getEnd())),
    }));
    return { path, bytes: Buffer.byteLength(text), lines: line(text.length), statements };
  });
  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  const maxBytes = Math.ceil(total / (6 * count));
  return files.flatMap((f) => splitFile(f, maxBytes));
}

/**
 * The mutate entries shard `index` of `count` runs (what selection() gives
 * it). The merge job keeps only these from that shard's report: Stryker's
 * incremental mode carries mutants it saw last time into the report, even
 * after their file or range moved to another shard.
 * @param {keyof typeof TARGETS} name
 * @param {number} index
 * @param {number} count
 */
export function shardFiles(name, index, count) {
  return selection(name, { STRYKER_SHARD: `${index}/${count}` }).mutate;
}

/**
 * The module's mutate globs expanded to sorted file paths (relative to apps/server).
 * @param {keyof typeof TARGETS} name
 */
export function mutateFiles(name) {
  const files = new Set(TARGETS[name].mutate.flatMap((g) => globSync(g, { cwd: HERE })));
  return [...files].sort();
}

#!/usr/bin/env node
// PAY-108 guard: every server test suite that imports a mutation-tested
// module (src/deposits, src/filings) must match that target's `testFiles`
// globs in apps/server/stryker.targets.mjs. A suite left out is never run
// against the mutants, and the score drops with no error — this happened with
// the seven PAY-91 deposit suites. Runs in the CI verify job.
//
// Also fails when a target finds no importing suite (nothing checked) or when
// a configured glob matches no test file (dead glob).
//
// Usage: node scripts/check-mutation-test-globs.mjs   (exit 1 on any failure)

import { readdirSync, readFileSync } from "node:fs";
import { dirname, matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS } from "../apps/server/stryker.targets.mjs";

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/server");
const TEST_DIR = resolve(SERVER, "test");

const suites = readdirSync(TEST_DIR)
  .filter((f) => f.endsWith(".test.ts"))
  .sort();

let failures = 0;
function fail(message) {
  console.error(`✗ ${message}`);
  failures += 1;
}

for (const [name, target] of Object.entries(TARGETS)) {
  // Static or dynamic import of the module in any form: "../src/<m>",
  // "../src/<m>.js", "../src/<m>/index.js", "../src/<m>/service.js" — any
  // quote style.
  const importRe = new RegExp(`["'\`]\\.\\./src/${name}(?:\\.[cm]?[jt]s|/[^"'\`]*)?["'\`]`);
  const importers = suites.filter((f) => importRe.test(readFileSync(resolve(TEST_DIR, f), "utf8")));
  // Nothing found means the detection or the test dir is wrong, not that all
  // is well.
  if (importers.length === 0) {
    fail(`no test suite imports src/${name} — the guard would check nothing.`);
  }
  for (const f of importers) {
    if (!target.testFiles.some((glob) => matchesGlob(`test/${f}`, glob))) {
      fail(
        `apps/server/test/${f} imports src/${name} but matches no "${name}" testFiles glob ` +
          "in apps/server/stryker.targets.mjs — add a glob (or rename the suite).",
      );
    }
  }
  // A glob that matches no suite is dead: a rename left it behind.
  for (const glob of target.testFiles) {
    if (!suites.some((f) => matchesGlob(`test/${f}`, glob))) {
      fail(`"${name}" testFiles glob "${glob}" matches no test file — remove or fix it.`);
    }
  }
  console.log(`${name}: ${importers.length} importing suite(s)`);
}

if (failures > 0) process.exit(1);

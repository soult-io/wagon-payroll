#!/usr/bin/env node
// PAY-255: score one server module from all its shard reports.
//
// Usage: node scripts/merge-mutation-reports.mjs <target> <shards> <break> <dir>
//   <dir> holds one sub-directory per downloaded shard artifact, each with a
//   mutation.json. Fails when a shard report is missing (a shard crashed or
//   timed out: no partial score) or when the module score is below <break>.
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeScore } from "./mutation-shards.mjs";

const [target, shardsArg, breakArg, dir] = process.argv.slice(2);
const shards = Number(shardsArg);
const breakAt = Number(breakArg);
if (!target || !Number.isInteger(shards) || shards < 1 || !Number.isFinite(breakAt) || !dir) {
  console.error("usage: merge-mutation-reports.mjs <target> <shards> <break> <dir>");
  process.exit(2);
}

/** Every mutation.json under dir (any depth). */
function reportFiles(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name === "mutation.json")
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

let files = [];
try {
  files = reportFiles(dir);
} catch {
  files = [];
}

const problems = [];
if (files.length !== shards)
  problems.push(`expected ${shards} shard reports, found ${files.length}`);
let result = null;
try {
  result = mergeScore(files.map((f) => JSON.parse(readFileSync(f, "utf8"))));
} catch (err) {
  problems.push(String(err instanceof Error ? err.message : err));
}
if (result && result.score === null) problems.push("no valid mutants");
if (result && result.score !== null && result.score < breakAt) {
  problems.push(`score ${result.score.toFixed(2)} is below the break threshold ${breakAt}`);
}

const score = result?.score == null ? "—" : result.score.toFixed(2);
const summary = [
  `### Mutation score: ${target}`,
  "",
  "| Score | Break | Killed | Timeout | Survived | No coverage | Ignored | Errors | Shards |",
  "|---|---|---|---|---|---|---|---|---|",
  `| ${score} | ${breakAt} | ${result?.killed ?? "—"} | ${result?.timeout ?? "—"} | ${result?.survived ?? "—"} | ${result?.noCoverage ?? "—"} | ${result?.ignored ?? "—"} | ${result?.errors ?? "—"} | ${files.length}/${shards} |`,
  "",
  problems.length === 0 ? "PASS" : `FAIL: ${problems.join("; ")}`,
  "",
].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
process.exit(problems.length === 0 ? 0 : 1);

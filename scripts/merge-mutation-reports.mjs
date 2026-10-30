#!/usr/bin/env node
// PAY-255: score one server module from all its shard reports.
//
// Usage: node scripts/merge-mutation-reports.mjs <target> <shards> <break> <dir>
//   <dir> holds one sub-directory per downloaded shard artifact, named
//   mutation-report-<target>-<i>of<n>, each with a mutation.json. Each report
//   is cut down to the files its shard owns (stryker.targets.mjs shardFiles;
//   incremental mode re-emits files a shard owned on an earlier run). Fails
//   when a shard report is missing (a shard crashed or timed out: no partial
//   score) or when the module score is below <break>.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { shardFiles } from "../apps/server/stryker.targets.mjs";
import { mergeScore } from "./mutation-shards.mjs";

const [target, shardsArg, breakArg, dir] = process.argv.slice(2);
const shards = Number(shardsArg);
const breakAt = Number(breakArg);
if (!target || !Number.isInteger(shards) || shards < 1 || !Number.isFinite(breakAt) || !dir) {
  console.error("usage: merge-mutation-reports.mjs <target> <shards> <break> <dir>");
  process.exit(2);
}

const moduleName = target.replace(/^server-/, "");

/**
 * Shard i's report, limited to the files shard i owns; null when missing.
 * upload-artifact keeps the report folder's contents at the artifact root.
 * @param {number} i
 */
function shardReport(i) {
  const file = join(dir, `mutation-report-${target}-${i}of${shards}`, "mutation.json");
  if (!existsSync(file)) return null;
  const report = JSON.parse(readFileSync(file, "utf8"));
  const owned = new Set(shardFiles(/** @type {any} */ (moduleName), i, shards));
  const files = Object.fromEntries(
    Object.entries(report.files ?? {}).filter(([path]) => owned.has(path)),
  );
  return { ...report, files };
}

const problems = [];
const reports = [];
for (let i = 1; i <= shards; i++) {
  try {
    const report = shardReport(i);
    if (report === null) problems.push(`shard ${i}/${shards} report is missing`);
    else reports.push(report);
  } catch (err) {
    problems.push(`shard ${i}/${shards}: ${err instanceof Error ? err.message : err}`);
  }
}
let result = null;
try {
  result = mergeScore(reports);
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
  `| ${score} | ${breakAt} | ${result?.killed ?? "—"} | ${result?.timeout ?? "—"} | ${result?.survived ?? "—"} | ${result?.noCoverage ?? "—"} | ${result?.ignored ?? "—"} | ${result?.errors ?? "—"} | ${reports.length}/${shards} |`,
  "",
  problems.length === 0 ? "PASS" : `FAIL: ${problems.join("; ")}`,
  "",
].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
process.exit(problems.length === 0 ? 0 : 1);

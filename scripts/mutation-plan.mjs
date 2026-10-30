#!/usr/bin/env node
// PAY-255: the job list for .github/workflows/mutation.yml.
//
//   SINCE unset — full run: engine in one job, each server module split into
//                 its `shards` (apps/server/stryker.targets.mjs), plus one
//                 merge job per server module that scores all its shards.
//   SINCE=<ref> — changed lines only: `git diff <ref>...HEAD` limited to the
//                 mutated source files; one job per target with changes,
//                 judged by Stryker against that target's break threshold.
//
// Writes `run`, `merge` (JSON arrays) and `has-run`, `has-merge` to
// $GITHUB_OUTPUT, and a short table to $GITHUB_STEP_SUMMARY.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mutateFiles, TARGETS } from "../apps/server/stryker.targets.mjs";
import { changedRanges } from "./mutation-shards.mjs";

const ENGINE = {
  target: "engine",
  package: "@payroll/engine",
  dir: "packages/engine",
  config: "stryker.config.mjs",
  timeout: 20,
  incremental: "reports/stryker-incremental.json",
  report: "reports/mutation/",
};
// The first full run of the largest shard (deposits service.ts, ~70% of the
// module) takes about 2.5 h; later runs are incremental. GitHub's cap is 6 h.
const SHARD_TIMEOUT = 300;

function server(name) {
  return {
    target: `server-${name}`,
    package: "@payroll/server",
    dir: "apps/server",
    config: `stryker.${name}.config.mjs`,
  };
}

function fullPlan() {
  const run = [{ id: "engine", ...ENGINE, shard: "", mutate: "", save: true }];
  const merge = [];
  for (const [name, t] of Object.entries(TARGETS)) {
    for (let i = 1; i <= t.shards; i++) {
      const suffix = `-${i}of${t.shards}`;
      run.push({
        id: `server-${name}${suffix}`,
        ...server(name),
        timeout: SHARD_TIMEOUT,
        incremental: `reports/stryker-incremental-${name}${suffix}.json`,
        report: `reports/mutation-${name}${suffix}/`,
        shard: `${i}/${t.shards}`,
        mutate: "",
        save: true,
      });
    }
    merge.push({ target: `server-${name}`, shards: t.shards, break: t.thresholds.break });
  }
  return { run, merge };
}

function changedPlan(since) {
  if (!/^[A-Za-z0-9._/-]+$/.test(since) || since.startsWith("-"))
    throw new Error(`invalid SINCE ref "${since}"`);
  const diff = execFileSync(
    "git",
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "--unified=0",
      "--no-color",
      "--no-ext-diff",
      `${since}...HEAD`,
      "--",
      "packages/engine/src",
      "apps/server/src",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const ranges = changedRanges(diff);
  const entries = (prefix, files) =>
    [...ranges]
      .filter(([path]) => path.startsWith(prefix) && files.has(path.slice(prefix.length)))
      .flatMap(([path, rs]) => rs.map(([s, e]) => `${path.slice(prefix.length)}:${s}-${e}`));
  const run = [];
  const engineFiles = new Set(
    [...ranges.keys()]
      .filter(
        (p) => p.startsWith("packages/engine/src/") && p.endsWith(".ts") && !p.endsWith(".test.ts"),
      )
      .map((p) => p.slice("packages/engine/".length)),
  );
  const engine = entries("packages/engine/", engineFiles);
  if (engine.length > 0)
    run.push({ id: "engine-changed", ...ENGINE, shard: "", mutate: engine.join(","), save: false });
  for (const name of Object.keys(TARGETS)) {
    const mutate = entries("apps/server/", new Set(mutateFiles(name)));
    if (mutate.length === 0) continue;
    run.push({
      id: `server-${name}-changed`,
      ...server(name),
      timeout: SHARD_TIMEOUT,
      incremental: `reports/stryker-incremental-${name}-changed.json`,
      report: `reports/mutation-${name}-changed/`,
      shard: "",
      mutate: mutate.join(","),
      save: false,
    });
  }
  return { run, merge: [] };
}

const since = process.env.SINCE?.trim() ?? "";
const { run, merge } = since === "" ? fullPlan() : changedPlan(since);

const lines = [
  `run=${JSON.stringify(run)}`,
  `merge=${JSON.stringify(merge)}`,
  `has-run=${run.length > 0}`,
  `has-merge=${merge.length > 0}`,
];
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
else console.log(lines.join("\n"));

const summary = [
  since === ""
    ? "### Mutation plan: full run"
    : `### Mutation plan: lines changed since \`${since}\``,
  "",
  "| Job | Mutates |",
  "|---|---|",
  ...run.map(
    (j) => `| ${j.id} | ${j.shard ? `shard ${j.shard}` : j.mutate ? `\`${j.mutate}\`` : "all"} |`,
  ),
  ...(run.length === 0 ? ["| — | no mutated source file changed |"] : []),
  "",
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);

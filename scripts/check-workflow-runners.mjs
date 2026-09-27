#!/usr/bin/env node
// PAY-112 guard: self-hosted runners only for `schedule` / `workflow_dispatch`.
// The repo is public and the `qa-e2e` runner sits on the LAN; a pull_request
// (or pull_request_target, workflow_run, workflow_call, ...) trigger could let
// a fork PR run its own code there (CONTRIBUTING.md → "CI workflows and the
// self-hosted runner"). Runs in the CI verify job.
//
// Allowlist, not denylist: a workflow with ANY trigger other than schedule /
// workflow_dispatch must run every job on a literal GitHub-hosted label
// (ubuntu-*, windows-*, macos-*). Anything else fails — self-hosted labels,
// label lists, runner groups, `${{ }}` expressions, and job-level `uses:`
// (a reusable workflow picks its own runner). The file is parsed as YAML, so
// anchors, flow mappings and quoting cannot hide a trigger or a runner. `<<`
// merge keys are rejected outright: their override rules may differ between
// this parser and GitHub's.
//
// Usage: node scripts/check-workflow-runners.mjs   (exit 1 on any failure)

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const WORKFLOWS = resolve(dirname(fileURLToPath(import.meta.url)), "../.github/workflows");

const SELF_HOSTED_OK = new Set(["schedule", "workflow_dispatch"]);
const HOSTED_RE = /^(?:ubuntu|windows|macos)-[a-z0-9.-]+$/;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True if any mapping in the document has a `<<` key. */
function hasMergeKey(node) {
  if (Array.isArray(node)) return node.some(hasMergeKey);
  if (!isObject(node)) return false;
  return Object.hasOwn(node, "<<") || Object.values(node).some(hasMergeKey);
}

/** Event names from `on:` in any of its forms, or null if it is malformed. */
function triggerNames(on) {
  if (typeof on === "string") return [on];
  if (Array.isArray(on) && on.every((t) => typeof t === "string")) return on;
  if (isObject(on)) return Object.keys(on);
  return null;
}

/** Why one job of an exposed workflow is not allowed, or null if it is fine. */
function jobViolation(file, id, job, why) {
  if (!isObject(job)) return `${file}: job "${id}" is not a mapping — cannot check its runner.`;
  if (job.uses !== undefined) {
    return (
      `${file}: job "${id}" calls a reusable workflow (uses:) — ${why}; call it only ` +
      "from a schedule / workflow_dispatch workflow, or inline the job."
    );
  }
  if (typeof job["runs-on"] === "string" && HOSTED_RE.test(job["runs-on"])) return null;
  return (
    `${file}: job "${id}" runs-on ${JSON.stringify(job["runs-on"] ?? null)} — ${why} ` +
    "(a literal ubuntu-*, windows-* or macos-* label). Self-hosted jobs " +
    "(qa-e2e) belong in a schedule / workflow_dispatch-only workflow."
  );
}

/** Violations for one workflow file's text; empty when it is fine. */
export function findViolations(file, text) {
  let doc;
  try {
    doc = parse(text, { merge: false });
  } catch (err) {
    return [`${file}: not valid YAML (${err.message.split("\n")[0]}) — cannot check it.`];
  }
  if (hasMergeKey(doc)) {
    return [`${file}: uses a "<<" merge key — not allowed in workflows (cannot check it).`];
  }
  const triggers = isObject(doc) ? triggerNames(doc.on) : null;
  if (!triggers || triggers.length === 0) {
    return [`${file}: no readable top-level "on:" — cannot check its triggers.`];
  }
  const exposed = triggers.filter((t) => !SELF_HOSTED_OK.has(t));
  if (exposed.length === 0) return [];
  if (!isObject(doc.jobs)) return [`${file}: no "jobs:" mapping — cannot check its runners.`];

  const why = `it has a "${exposed[0]}" trigger, so every job must run on a GitHub-hosted runner`;
  return Object.entries(doc.jobs)
    .map(([id, job]) => jobViolation(file, id, job, why))
    .filter((v) => v !== null);
}

function main() {
  const files = readdirSync(WORKFLOWS)
    .filter((f) => /\.ya?ml$/i.test(f))
    .sort();
  if (files.length === 0) {
    console.error(`✗ no workflow files in ${WORKFLOWS} — the guard would check nothing.`);
    process.exit(1);
  }
  const violations = files.flatMap((f) =>
    findViolations(`.github/workflows/${f}`, readFileSync(resolve(WORKFLOWS, f), "utf8")),
  );
  for (const v of violations) console.error(`✗ ${v}`);
  console.log(`${files.length} workflow file(s) checked, ${violations.length} violation(s)`);
  if (violations.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

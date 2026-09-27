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
// anchors, flow mappings and quoting cannot hide a trigger or a runner.
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

/** Event names from `on:` in any of its forms, or null if it is malformed. */
function triggerNames(on) {
  if (typeof on === "string") return [on];
  if (Array.isArray(on) && on.every((t) => typeof t === "string")) return on;
  if (isObject(on)) return Object.keys(on);
  return null;
}

/** Violations for one workflow file's text; empty when it is fine. */
export function findViolations(file, text) {
  let doc;
  try {
    // merge: resolve `<<` keys so a merged-in runs-on is checked too.
    doc = parse(text, { merge: true });
  } catch (err) {
    return [`${file}: not valid YAML (${err.message.split("\n")[0]}) — cannot check it.`];
  }
  const triggers = isObject(doc) ? triggerNames(doc.on) : null;
  if (!triggers || triggers.length === 0) {
    return [`${file}: no readable top-level "on:" — cannot check its triggers.`];
  }
  const exposed = triggers.filter((t) => !SELF_HOSTED_OK.has(t));
  if (exposed.length === 0) return [];
  if (!isObject(doc.jobs)) return [`${file}: no "jobs:" mapping — cannot check its runners.`];

  const why = `it has a "${exposed[0]}" trigger, so every job must run on a GitHub-hosted runner`;
  const violations = [];
  for (const [id, job] of Object.entries(doc.jobs)) {
    if (!isObject(job)) {
      violations.push(`${file}: job "${id}" is not a mapping — cannot check its runner.`);
    } else if (job.uses !== undefined) {
      violations.push(
        `${file}: job "${id}" calls a reusable workflow (uses:) — ${why}; call it only ` +
          "from a schedule / workflow_dispatch workflow, or inline the job.",
      );
    } else if (typeof job["runs-on"] !== "string" || !HOSTED_RE.test(job["runs-on"])) {
      violations.push(
        `${file}: job "${id}" runs-on ${JSON.stringify(job["runs-on"] ?? null)} — ${why} ` +
          "(a literal ubuntu-*, windows-* or macos-* label). Self-hosted jobs " +
          "(qa-e2e) belong in a schedule / workflow_dispatch-only workflow.",
      );
    }
  }
  return violations;
}

function main() {
  const files = readdirSync(WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
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

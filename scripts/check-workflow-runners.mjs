#!/usr/bin/env node
// PAY-112 guard: no workflow may run a self-hosted job on a pull_request*
// trigger. The repo is public and the `qa-e2e` runner sits on the LAN; a
// pull_request or pull_request_target trigger would let a fork PR run its own
// code there. Self-hosted jobs are for `schedule` / `workflow_dispatch` only
// (CONTRIBUTING.md → "CI workflows and the self-hosted runner"). Runs in the
// CI verify job.
//
// Text-based on purpose (no YAML parser in the root package) and fails
// closed: a workflow that mentions `self-hosted` or `qa-e2e` anywhere outside
// a comment, or picks its runner from a `${{ }}` expression, counts as
// self-hosted; any `pull_request*` event under the top-level `on:` counts as a
// PR trigger; a file with no top-level `on:` fails.
//
// Usage: node scripts/check-workflow-runners.mjs   (exit 1 on any failure)

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKFLOWS = resolve(dirname(fileURLToPath(import.meta.url)), "../.github/workflows");

const SELF_HOSTED_RE = /\bself-hosted\b|\bqa-e2e\b/;
const DYNAMIC_RUNS_ON_RE = /^\s*runs-on:.*\$\{\{/m;
const ON_KEY_RE = /^(?:on|"on"|'on')\s*:(.*)$/;
// pull_request, pull_request_target, pull_request_review, ... — all run on
// PR events a fork can raise.
const PR_TRIGGER_RE = /\bpull_request\w*/;

/** Drop `#` comments (start of line, or after whitespace). */
function stripComments(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");
}

/** The top-level `on:` value: its inline part plus its indented block. */
function triggerText(lines) {
  const start = lines.findIndex((line) => ON_KEY_RE.test(line));
  if (start === -1) return null;
  const parts = [lines[start].match(ON_KEY_RE)[1]];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !/^\s/.test(line)) break;
    parts.push(line);
  }
  return parts.join("\n");
}

/** Violations for one workflow file's text; empty when it is fine. */
export function findViolations(file, text) {
  const stripped = stripComments(text);
  const triggers = triggerText(stripped.split("\n"));
  if (triggers === null) {
    return [`${file}: no top-level "on:" found — cannot check its triggers.`];
  }
  const prTrigger = triggers.match(PR_TRIGGER_RE);
  if (!prTrigger) return [];
  if (SELF_HOSTED_RE.test(stripped)) {
    return [
      `${file}: a self-hosted runner (self-hosted / qa-e2e) with a "${prTrigger[0]}" trigger — ` +
        "a fork PR would run its code on the LAN host. Self-hosted jobs are for schedule / " +
        "workflow_dispatch only; move the job to its own workflow.",
    ];
  }
  if (DYNAMIC_RUNS_ON_RE.test(stripped)) {
    return [
      `${file}: runs-on from a \${{ }} expression with a "${prTrigger[0]}" trigger — ` +
        "cannot prove the runner is GitHub-hosted. Use a literal GitHub-hosted label.",
    ];
  }
  return [];
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

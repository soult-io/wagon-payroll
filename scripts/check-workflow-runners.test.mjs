// Tests for the PAY-112 guard. Run: node --test scripts/check-workflow-runners.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { findViolations } from "./check-workflow-runners.mjs";

const job = (runsOn) => `jobs:\n  e2e:\n    runs-on: ${runsOn}\n    steps:\n      - run: echo hi\n`;
const LAN = "[self-hosted, qa-e2e]";
const fails = (wf) => assert.ok(findViolations("wf.yml", wf).length > 0, "expected a violation");
const passes = (wf) => assert.deepEqual(findViolations("wf.yml", wf), []);

test("self-hosted on schedule + workflow_dispatch passes", () => {
  passes(`on:\n  schedule:\n    - cron: "17 5 * * *"\n  workflow_dispatch:\n\n${job(LAN)}`);
});

test("GitHub-hosted on pull_request + push passes", () => {
  passes(`on:\n  pull_request:\n  push:\n    branches: [main]\n\n${job("ubuntu-latest")}`);
  passes(`on: [pull_request]\n${job("macos-15")}`);
});

// Every trigger form, with the LAN runner.
for (const [name, on] of [
  ["block pull_request", "on:\n  pull_request:\n  schedule:\n    - cron: '0 0 * * *'\n"],
  ["block pull_request_target", "on:\n  pull_request_target:\n    types: [opened]\n"],
  ["inline scalar", "on: pull_request\n"],
  ["inline list", "on: [push, pull_request_target]\n"],
  ["block list", "on:\n  - push\n  - pull_request\n"],
  ["quoted key", '"on":\n  pull_request:\n'],
  ["pull_request_review", "on:\n  pull_request_review:\n"],
  ["workflow_run", "on:\n  workflow_run:\n    workflows: [ci]\n"],
  ["workflow_call", "on: workflow_call\n"],
  ["push", "on: push\n"],
  [
    "flow mapping with a quoted #",
    'on: {workflow_dispatch: {inputs: {x: {description: "see #1"}}}, pull_request: {}}\n',
  ],
  ["anchor + alias", "name: &ev pull_request_target\non: [*ev]\n"],
  ["escaped event name", 'on: ["pull\\u005frequest"]\n'],
]) {
  test(`self-hosted + ${name} fails`, () => fails(`${on}${job(LAN)}`));
}

// Every runner form, on a PR trigger.
for (const [name, runsOn] of [
  ["qa-e2e alone", "qa-e2e"],
  ["mixed case", "[Self-Hosted, QA-E2E]"],
  ["default self-hosted labels", "[linux, x64]"],
  ["quoted escapes", '["self\\u002dhosted"]'],
  ["expression", `\${{ vars.RUNNER }}`],
  ["runner group", "{group: lan}"],
  ["hosted label in a list", "[ubuntu-latest]"],
]) {
  test(`pull_request + runs-on ${name} fails`, () => fails(`on: pull_request\n${job(runsOn)}`));
}

test("multi-line runs-on list fails", () => {
  fails("on: pull_request\njobs:\n  e2e:\n    runs-on:\n      - self-hosted\n      - qa-e2e\n");
});

test("expression on the next line fails", () => {
  fails(`on: pull_request\njobs:\n  e2e:\n    runs-on: >-\n      \${{ vars.R }}\n`);
});

test("<< merge keys fail, even under an explicit hosted runs-on", () => {
  fails(
    "on: pull_request\nx: &lan {runs-on: [self-hosted, qa-e2e]}\njobs:\n  e2e:\n    <<: *lan\n",
  );
  fails(
    "on: pull_request\nx: &lan {runs-on: [self-hosted, qa-e2e]}\njobs:\n  e2e:\n" +
      "    runs-on: ubuntu-latest\n    <<: *lan\n    steps: [{run: id}]\n",
  );
  fails(`on: workflow_dispatch\nx: &a {k: v}\ny:\n  <<: *a\n${job(LAN)}`);
});

test("missing runs-on fails", () => fails("on: pull_request\njobs:\n  e2e:\n    steps: []\n"));

test("reusable workflow call from a PR workflow fails", () => {
  fails("on: pull_request\njobs:\n  lan:\n    uses: ./.github/workflows/lan.yml\n");
});

test("words in comments and strings do not count", () => {
  passes(
    `# never use self-hosted / qa-e2e here\non: pull_request\n${job("ubuntu-latest  # not qa-e2e")}` +
      '      - name: "self-hosted is banned"\n        run: echo qa-e2e\n',
  );
});

test("pull_request outside on: does not count as a trigger", () => {
  passes(`on: workflow_dispatch\nenv:\n  E: pull_request\n${job(LAN)}`);
});

test("no on:, bad YAML and duplicate keys fail closed", () => {
  fails(job("ubuntu-latest"));
  fails("on: [pull_request\n");
  fails(`on: workflow_dispatch\non: pull_request\n${job(LAN)}`);
});

test("CRLF line endings parse", () => {
  fails(`on: pull_request\n${job(LAN)}`.replaceAll("\n", "\r\n"));
  passes(`on: pull_request\n${job("ubuntu-latest")}`.replaceAll("\n", "\r\n"));
});

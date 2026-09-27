// Tests for the PAY-112 guard. Run: node --test scripts/check-workflow-runners.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { findViolations } from "./check-workflow-runners.mjs";

const job = (runsOn) => `jobs:\n  e2e:\n    runs-on: ${runsOn}\n    steps:\n      - run: echo hi\n`;

test("self-hosted on schedule + workflow_dispatch passes", () => {
  const wf = `on:\n  schedule:\n    - cron: "17 5 * * *"\n  workflow_dispatch:\n\n${job("[self-hosted, qa-e2e]")}`;
  assert.deepEqual(findViolations("wf.yml", wf), []);
});

test("GitHub-hosted on pull_request passes", () => {
  const wf = `on:\n  pull_request:\n  push:\n    branches: [main]\n\n${job("ubuntu-latest")}`;
  assert.deepEqual(findViolations("wf.yml", wf), []);
});

for (const [name, on] of [
  ["block pull_request", "on:\n  pull_request:\n  schedule:\n    - cron: '0 0 * * *'\n"],
  ["block pull_request_target", "on:\n  pull_request_target:\n    types: [opened]\n"],
  ["inline scalar", "on: pull_request\n"],
  ["inline list", "on: [push, pull_request_target]\n"],
  ["list form", "on:\n  - push\n  - pull_request\n"],
  ["quoted key", '"on":\n  pull_request:\n'],
  ["pull_request_review", "on:\n  pull_request_review:\n"],
]) {
  test(`self-hosted + ${name} fails`, () => {
    assert.equal(findViolations("wf.yml", `${on}\n${job("[self-hosted, qa-e2e]")}`).length, 1);
  });
}

test("qa-e2e label alone counts as self-hosted", () => {
  assert.equal(findViolations("wf.yml", `on: pull_request\n${job("qa-e2e")}`).length, 1);
});

test("multi-line runs-on list counts", () => {
  const wf = "on: pull_request\njobs:\n  e2e:\n    runs-on:\n      - self-hosted\n      - qa-e2e\n";
  assert.equal(findViolations("wf.yml", wf).length, 1);
});

test("runs-on from an expression on a PR trigger fails", () => {
  assert.equal(findViolations("wf.yml", `on: pull_request\n${job(`\${{ matrix.os }}`)}`).length, 1);
});

test("self-hosted in a comment only does not count", () => {
  const wf = `# never use self-hosted here\non: pull_request\n${job("ubuntu-latest  # not qa-e2e")}`;
  assert.deepEqual(findViolations("wf.yml", wf), []);
});

test("pull_request outside the on: block does not count as a trigger", () => {
  const wf = `on:\n  schedule:\n    - cron: "0 0 * * *"\n\n${job("[self-hosted, qa-e2e]")}      - run: echo "\${{ github.event.pull_request.number }}"\n`;
  assert.deepEqual(findViolations("wf.yml", wf), []);
});

test("pull_request in a commented-out trigger does not count", () => {
  const wf = `on:\n  # pull_request:\n  workflow_dispatch:\n${job("[self-hosted, qa-e2e]")}`;
  assert.deepEqual(findViolations("wf.yml", wf), []);
});

test("no top-level on: fails closed", () => {
  assert.equal(findViolations("wf.yml", job("ubuntu-latest")).length, 1);
});

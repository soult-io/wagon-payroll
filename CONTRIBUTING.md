# Contributing

Thanks for your interest in contributing! This document covers the dev setup,
the checks every PR must pass, and what to expect in review.

## Dev setup

Prereqs: Node ≥ 22, pnpm 11 (`npm install -g pnpm`), Docker (for Postgres).

```sh
pnpm install

# Postgres for dev (the example compose db service works standalone)
mkdir -p secrets && echo payroll > secrets/db-password
docker compose -f compose.example.yml up -d db

# Migrations
DATABASE_URL=postgres://payroll:payroll@localhost:5432/payroll pnpm db:migrate

# Dev servers — API on :8927, web on :5173 (proxying /api → :8927)
pnpm dev
```

## Checks (all must be green before merge)

```sh
pnpm biome check        # lint/format — CI gates on 0 errors (complexity ≤ 15)
pnpm -r run typecheck   # tsc / vue-tsc across all packages
pnpm test               # unit tests across the workspace (vitest)
```

Run tests for a single package while iterating:

```sh
pnpm --filter @payroll/server test
pnpm --filter @payroll/engine test
```

End-to-end tests use an **ephemeral** stack (in-memory PGlite, no external
services) and must also pass:

```sh
pnpm --filter @payroll/e2e e2e
```

(The nightly e2e against a live QA deployment requires our self-hosted runner
and is not expected to run on forks — it skips cleanly there.)

### Mutation testing (test strength on the money path)

[StrykerJS](https://stryker-mutator.io/) makes small changes ("mutants") to the
code — flips `<` to `<=`, `+` to `-`, drops a branch — and re-runs the tests.
A mutant that no test catches ("survived") marks a behavior the tests do not
pin down. It covers the withholding engine and the server's `deposits/` and
`filings/` modules:

```sh
pnpm mutation:engine            # packages/engine/src — seconds
pnpm mutation:server-deposits   # apps/server/src/deposits — tens of minutes
pnpm mutation:server-filings    # apps/server/src/filings — tens of minutes
```

The server targets are defined in `apps/server/stryker.targets.mjs`: per module,
the `mutate` glob, the test suites to run (`testFiles`, as globs) and the
thresholds. Name a new suite after its module (`*deposit*`, `*filing*`,
`*940*`, …) and it is picked up. A suite that imports `src/deposits` or
`src/filings` but matches no glob fails CI (`pnpm check:mutation-globs`, verify
job) — add a glob for it rather than letting the score drop silently.

Extra flags pass through to `stryker run`, e.g. `pnpm mutation:engine --force`
(re-test every mutant) or `--mutate "src/filings/service.ts"` (one file).
Runs are incremental: `reports/stryker-incremental*.json` in each package
(one per server target) holds the last result, and only mutants whose code or
covering tests changed are re-tested.

Reading the report — open `reports/mutation/index.html` in `packages/engine/`,
or `reports/mutation-deposits/` / `reports/mutation-filings/` in `apps/server/`:

- **Killed** — a test failed with the mutant in place. Good.
- **Survived** — every covering test still passed. A test gap, unless the
  mutant is equivalent (behaves the same as the original).
- **No coverage** — no test runs that line at all.
- **Timeout** — the mutant caused a hang (e.g. an endless loop); counts as
  detected.
- **Mutation score** = (killed + timeout) / all valid mutants.

Each target sets `thresholds.break` a little below its recorded baseline
(`plan/mutation-baseline-2026-09.md`); a score below it fails the run. The
`mutation` workflow runs weekly and on demand (Actions → mutation → Run
workflow), not on PRs, and uploads the HTML report as an artifact.

Note: `patches/@stryker-mutator__vitest-runner@10.0.0.patch` makes the runner
run whole test files (every test in each file that covers a mutant) instead of
filtering by test name. Upstream's name filter never matches under Vitest 5
(every mutant looked "survived"), and the server's integration tests share
state between `it` blocks, so a filtered subset fails for reasons unrelated to
the mutant. Revisit when upgrading Stryker.

## PR expectations

- Green CI is required: Biome 0 errors, typecheck clean, unit tests and
  ephemeral e2e passing.
- Keep changes focused; one logical change per PR.
- **Big changes start as a spec.** The `plan/` directory holds the approved
  design history (`plan/decisions.md` + `plan/specs/`). If your change alters
  behavior, data model, or architecture, open an issue first to discuss, and
  be ready to write a short spec in that style.
- Don't commit secrets, real personal data, or environment-specific
  configuration — the repo is deliberately deployable by anyone.
- Money handling rules are strict (NUMERIC to the cent, rounding defined once
  in `packages/engine`) — follow the existing patterns.

## License

By contributing, you agree that your contributions are licensed under the
project's [AGPL-3.0 license](LICENSE).

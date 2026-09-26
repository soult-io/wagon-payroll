# Mutation-testing baseline — 2026-09 (PAY-93)

StrykerJS 10.0.0 + `@stryker-mutator/vitest-runner` (Vitest 5.0.1), measured
2026-09-26 on branch `pay-93-stryker` (base `c45c7b5`). Feeds the test-gap
audit (PAY-92). How to run and read the report: `CONTRIBUTING.md` →
"Mutation testing".

## Baseline scores

Mutation score = (killed + timeout) / (all mutants − compile errors).

| Module | Score | Killed | Timeout | Survived | No coverage | Compile error | Wall time (full / incremental) |
|---|---:|---:|---:|---:|---:|---:|---|
| `packages/engine/src` | **88.14%** | 104 | 0 | 14 | 0 | 58 | 27 s / 2 s |
| `apps/server/src/deposits` | **78.56%** | 478 | 2 | 102 | 29 | — | |
| `apps/server/src/filings` | **69.26%** | 763 | 3 | 262 | 78 | — | |
| server total (deposits + filings) | **72.57%** | 1241 | 5 | 364 | 107 | — | 21 m 55 s / 38 s |

Per file (server): `deposits/service.ts` 79.93, `deposits/attachments.ts`
62.50, `filings/annual.ts` 82.86, `filings/service.ts` 59.49,
`filings/attachments.ts` 62.30, `filings/shared.ts` 76.00,
`filings/w2-consent.ts` 79.03, `form-940-pdf.ts` / `form-941-pdf.ts` 73.33.

Break thresholds set from this baseline: engine **86**, server **70**.

Run notes:

- Wall times are local (14-core Mac, `concurrency: 4`, the CI setting). The
  server run used 8,690 CPU-seconds; expect roughly 40–70 min on a 4-vCPU
  GitHub runner for a full run, well under a minute plus build for an
  incremental one.
- Engine uses the TypeScript checker (58 mutants that do not compile are
  excluded, +20 s). The server does not: its run is already the long one.
- Server: 41 static mutants (module-level constants) are ignored
  (`ignoreStatic`) — each would force a full module reload per mutant.
- Server tests: only the 13 suites that exercise deposits/filings
  (`testFiles` in the then single `apps/server/stryker.config.mjs`). Superseded
  by the per-module targets below.

## 2026-09-26 re-baseline after PAY-91 (PAY-108)

The 13-suite list above was hard-coded, and the seven suites PAY-91 added
(`state-deposit-transitions`, `deposit-transition`,
`deposit-transition-coverage`, `deposit-sync-robustness`,
`deposit-period-boundaries`, `deposit-calendar-zero`, `pay-91-revert`) were
never added to it. Deposits read 53% on CI instead of the score those suites
earn, and the combined server job took 1 h 41 m against a 150-minute timeout;
adding the suites roughly doubles the deposits half.

Changes:

- The server run is split into two targets, `server-deposits` and
  `server-filings` (`apps/server/stryker.targets.mjs`, one config file each),
  each with its own CI timeout (90 / 120 min; engine 20), incremental file and
  cache key.
- Test suites are chosen by glob, not by list. `scripts/check-mutation-test-globs.mjs`
  (CI verify job) fails when a suite importing `src/deposits` or `src/filings`
  matches none of its target's globs.

Local results, full run:

| Target | Score | Suites | Break |
|---|---:|---|---:|
| `apps/server/src/deposits` | **77.24%** | every deposit suite, including the 7 PAY-91 suites | 72 |
| `apps/server/src/filings` | **69.26%** | every filing suite | 65 |
| `packages/engine/src` | 88.14% (unchanged) | — | 86 (unchanged) |

Spot check with the new deposits config, `--mutate src/deposits/transition.ts`:
**79.89%** (373 mutants: 295 killed, 3 timeout, 63 survived, 12 no coverage;
10 test files matched, 5 m 12 s local). The 10 are the deposit suites present
at the time of the run, before `state-deposit-transitions-gaps` was added.

## Runner patch, and a finding about the tests themselves

`patches/@stryker-mutator__vitest-runner@10.0.0.patch` changes how Stryker
picks tests for a mutant: it runs every test in each file that holds a
covering test, in order, instead of filtering by test name. Two reasons,
both measured:

1. **Vitest 5 incompatibility.** Stryker filters with a space-joined test
   name; Vitest 5 matches `testNamePattern` against `fullTestName`
   (`describe > test`). Nothing matched, every test was skipped, and every
   non-static mutant "survived" (engine read 48.86% instead of 90.91% in that early run, before the TypeScript checker was enabled; the recorded baseline with the checker is 88.14%).
2. **Order-dependent integration tests.** With name filtering fixed, a first
   server run scored 82.24%, but 715 of its 1,407 kills came from test
   subsets that fail with **no mutant at all** (65 of 157 distinct subsets).
   Cause: tests in `deposits.test.ts`, `filings.test.ts`,
   `annual-forms.test.ts` and `in-year-940.test.ts` rely on rows created by
   earlier `it` blocks in the same file. Examples that fail when run alone:
   `syncDeposits > upserts pending rows for completed months AND the current
   month, idempotently`, `admin deposit routes > marks a deposit as deposited
   — status change + audit event`, `syncFilings > is idempotent and refreshes
   the worksheet when more runs issue`, `in-year 940 row (PAY-22) >
   transitions not_started → ready on Jan 1; filed rows are untouched`.
   **For PAY-92:** each `it` should seed what it needs (or the file should
   say, in one place, that its tests are a sequence).

## Top surviving mutants — deposits/ and filings/

Ranked by what a missed bug would cost the customer (wrong figure on a
filing or a wrong due date first, validation last). "Survived" = every test
that runs the line still passes with the change in place.

| # | Location | Mutation | Why no test caught it |
|---|---|---|---|
| 1 | `filings/service.ts:215–221` (Form 941 lines 5a/5c/5e/6) | `ssTotal / SS_COMBINED_RATE` → `ssTotal * SS_COMBINED_RATE`; also `ssWages * rate` → `/`, `line5aTax + line5cTax` → `-`, `fed + line5e` → `-` (8 mutants) | Line 7 (fractions of cents) is computed as the residual `fed + ssTotal + medTotal − line6`, so any error in 5a/5c/5e/6 moves into line 7 and lines 10/12/14 stay correct. Tests assert the reconciled totals, not the per-line figures that print on the 941. A wrong line 5a would ship on the PDF. |
| 2 | `filings/service.ts:256–257` (941 lines 14/15) | `diff > 0 ? diff : 0` → `diff`; `diff < 0 ? -diff : 0` → `0` / `diff <= 0` | No test has an overpaid quarter (deposits + adjustments > liability). Line 15 (overpayment) is never asserted, and line 14 could go negative unnoticed. |
| 3 | `deposits/service.ts:202–203` (state monthly due date) | `month === 12 ? year + 1 : year` → `year`; `month === 12 ? 1 : month + 1` → `month + 1` | No test covers a December period on a state **monthly** schedule. The federal path has a year-rollover test; the state path does not. A December state deposit would get a due date in the wrong year. |
| 4 | `deposits/service.ts:308`, `:432`, `:932` (quarterly state periods) | `(q - 1) * 3 + 1` → `(q - 1) * 3 - 1` (and `/ 3`, `q + 1` at :432) | Quarterly-schedule tests have no issued runs in the months just before the quarter, so a range starting two months early sums the same, and the period key still groups the same rows. Amount and grouping of a quarterly state deposit are not pinned at the quarter's start. |
| 5 | `filings/service.ts:197` (941 line 1, employee count) | `r.periodStart <= periodKeyDay && r.periodEnd >= periodKeyDay` → `true` / `||` / `<` | Every test run's pay period includes the 12th of the quarter's first month, so filtering by it changes nothing. No test pays an employee only outside that period. |
| 6 | `filings/service.ts:268` (941 line 16 de minimis) | `line12 < DE_MINIMIS_THRESHOLD` → `false` / `<=` | The `deMinimis` flag is never asserted, neither under $2,500 nor at the boundary. |
| 7 | `filings/annual.ts:216` (940 FUTA deposit trigger) | `cumulative > 500` → `cumulative >= 500` | No test has cumulative FUTA of exactly $500.00. IRS: deposit when liability is *more than* $500 — the boundary is the rule. |
| 8 | `deposits/service.ts:288`, `:334` (state rows) | `row.workState && row.amount !== "0.00"` → `true` / `\|\|` | No test issues a run with zero state withholding or with no work state, so a $0.00 or state-less deposit row is never shown to be dropped. |
| 9 | `filings/service.ts:457` (when a quarter's 941 row appears) | `quarterEnd(year, quarter) >= today` → `>` | No test runs `syncFilings` on the last day of a quarter; the row may be created before the quarter has ended. |
| 10 | `filings/service.ts:396–425` (line 7 admin override on refresh) | `previous !== null && filing.fractionsOfCents !== …` → `true`; `fresh.fractionsOfCents !== undefined ? … : …` → either branch | Refresh after an admin edits line 7 is not tested for keeping vs. replacing the override. |
| 11 | `deposits/service.ts:666–673`, `filings/service.ts:592–606`, `:748–749`, `:816–839`, `:907–916`, `:967–976` | validation conditions → `false`; `.trim()` removed; `> 100` / `> 50` → `>=` | Error paths of markDeposited, markFiled, setFractionsOfCents and add/update/deleteAdjustment are mostly **no coverage**: invalid dates, over-long confirmation/method strings, negative money, adjusting a filed return, unknown ids. |
| 12 | `deposits/service.ts:345–375`, `filings/service.ts:304–336` (reminder offsets) | `value.every(…)` → `value.some(…)`; `n <= MAX` → `n < MAX`; sort comparator removed | Offset validation and sort order are tested only with valid, already-sorted input. |

Lower-value clusters not listed above: string-literal mutants in error
messages and audit-event text; `filings/annual.ts:293–294` (W-2 list sort by
name — tests have one employee); `filings/annual.ts:457` (address
completeness check); `attachments.ts` in both folders (62%: upload
error paths).

## Engine survivors (for completeness)

14 survivors in `packages/engine/src/payroll.ts`, mostly boundaries:
`priorYtdGross < socialSecurityWageCap` / `< futaWageCap` → `<=` (no test
with prior YTD exactly at a cap), `ytdGross > medicareAdditionalThreshold` →
`>=` (equivalent: the additional base is 0 at the threshold), `inBracket <= 0`
break removals (equivalent: a zero-width bracket adds 0), the state
low-income exemption `annualGross <= lowIncome` → `<`, and the
`periodsPerYear` error message text.

## Raw data

The full list (all survived and no-coverage mutants) is in the HTML report:
`pnpm mutation:server-deposits` / `pnpm mutation:server-filings` →
`apps/server/reports/mutation-deposits/index.html` /
`reports/mutation-filings/index.html`, or the `mutation-report-server-deposits`
/ `mutation-report-server-filings` artifacts of the `mutation` workflow.

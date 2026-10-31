import type { SuiteResult, TestResult, VerifySummary } from "@payroll/verify-summary";
import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  formatDurationMs,
  lastExecutedAtByTest,
  lastExecutionOf,
  passRate,
  renderPage,
  shortSha,
  sortByGeneratedAtDesc,
  sourceViews,
  worstOutcome,
} from "../src/lib.js";

function suite(
  key: SuiteResult["key"],
  name: string,
  passed: number,
  failed: number,
  skipped: number,
): SuiteResult {
  return {
    key,
    name,
    status: failed > 0 ? "failed" : passed === 0 ? "not_run" : "passed",
    durationMs: 1000,
    counts: {
      passed,
      failed,
      skipped,
      executed: passed + failed,
      total: passed + failed + skipped,
    },
    tests: [],
  };
}

function summary(over: Partial<VerifySummary> & { generatedAt: string }): VerifySummary {
  const suites = over.suites ?? [suite("engine", "Engine unit tests", 10, 0, 0)];
  const counts = over.counts ?? { passed: 10, failed: 0, skipped: 0, executed: 10, total: 10 };
  return {
    schemaVersion: 2,
    runId: "r",
    source: "ci",
    gitSha: "8d80bba1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7",
    gitRef: "refs/heads/main",
    overallStatus: counts.failed > 0 ? "failed" : "passed",
    counts,
    suites,
    ...over,
  };
}

describe("helpers", () => {
  it("escapeHtml escapes all metacharacters", () => {
    expect(escapeHtml(`<b>&"'`)).toBe("&lt;b&gt;&amp;&quot;&#39;");
  });

  it("formatDurationMs", () => {
    expect(formatDurationMs(820)).toBe("820ms");
    expect(formatDurationMs(3200)).toBe("3.2s");
    expect(formatDurationMs(65_000)).toBe("1m 05s");
  });

  it("shortSha shortens a hex sha but leaves non-sha alone", () => {
    expect(shortSha("8d80bba1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7")).toBe("8d80bba");
    expect(shortSha("unknown")).toBe("unknown");
  });

  it("passRate ignores skipped and handles all-skipped", () => {
    expect(
      passRate(
        summary({
          generatedAt: "2026-09-21T00:00:00Z",
          counts: { passed: 3, failed: 1, skipped: 5, executed: 4, total: 9 },
        }),
      ),
    ).toBe(75);
    expect(
      passRate(
        summary({
          generatedAt: "2026-09-21T00:00:00Z",
          counts: { passed: 0, failed: 0, skipped: 4, executed: 0, total: 4 },
        }),
      ),
      // Spec 18: a run that executed nothing has no pass rate. It is not 100%.
    ).toBeUndefined();
  });

  it("sortByGeneratedAtDesc orders newest first without mutating input", () => {
    const a = summary({ generatedAt: "2026-09-20T00:00:00Z" });
    const b = summary({ generatedAt: "2026-09-21T00:00:00Z" });
    const input = [a, b];
    const sorted = sortByGeneratedAtDesc(input);
    expect(sorted.map((s) => s.generatedAt)).toEqual([
      "2026-09-21T00:00:00Z",
      "2026-09-20T00:00:00Z",
    ]);
    expect(input).toEqual([a, b]);
  });
});

describe("renderPage", () => {
  it("renders the empty state with no history", () => {
    const html = renderPage([]);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("No verification runs ingested yet");
    expect(html).not.toContain("badge fail");
  });

  it("carries the product name in the title and heading (spec 22 D8)", () => {
    const empty = renderPage([]);
    expect(empty).toContain("<title>Wagon Payroll QA verification</title>");
    expect(empty).toContain("<h1>Wagon Payroll — QA verification</h1>");
    expect(empty).not.toContain("<h1>payroll-app");
    const populated = renderPage([summary({ generatedAt: "2026-09-21T05:20:00Z" })]);
    expect(populated).toContain("<title>Wagon Payroll QA verification</title>");
    expect(populated).toContain("<h1>Wagon Payroll — QA verification</h1>");
    // The meta description names the repo, soult-io/wagon-payroll (renamed in PAY-68).
    expect(populated).toContain("status for wagon-payroll");
  });

  it("renders the latest run's status, counts, suites and report link", () => {
    const html = renderPage(
      [
        summary({
          generatedAt: "2026-09-21T05:20:00Z",
          gitSha: "aaaaaaa0000000000000000000000000000000ff",
          counts: { passed: 185, failed: 0, skipped: 6, executed: 185, total: 191 },
          suites: [
            suite("engine", "Engine unit tests", 171, 0, 0),
            suite("e2e", "Playwright journeys", 14, 0, 6),
          ],
        }),
      ],
      { reportHref: "report/" },
    );
    expect(html).toContain(">PASSED<");
    expect(html).toContain("aaaaaaa"); // shortened sha
    expect(html).toContain("185</strong> passed");
    expect(html).toContain("Playwright journeys");
    expect(html).toContain('href="report/"');
  });

  it("shows the newest run in the header when history is unsorted", () => {
    const older = summary({
      generatedAt: "2026-09-19T00:00:00Z",
      gitSha: "0000000older00000000000000000000000000ff",
    });
    const newer = summary({
      generatedAt: "2026-09-21T00:00:00Z",
      gitSha: "1111111newer0000000000000000000000000fff",
    });
    const html = renderPage([older, newer], { now: new Date("2026-09-21T01:00:00Z") });
    // The commit moved to the per-source card with spec 19 — that card must
    // show the NEWEST ci run's sha, not the older one.
    const sources = html.slice(html.indexOf("<h2>Sources</h2>"), html.indexOf("<h2>Suites</h2>"));
    // The ci card shows the NEWER run. Asserted on the distinguishing part of
    // each fixture sha ("newer"/"older") rather than the leading digits, which
    // both fixtures share — a negative on those would pass by accident.
    expect(sources).toContain("1111111newer");
    expect(sources).not.toContain("0000000older");
  });

  it("escapes suite names (no raw HTML injection)", () => {
    const html = renderPage([
      summary({
        generatedAt: "2026-09-21T00:00:00Z",
        suites: [suite("server", "<script>evil</script>", 1, 0, 0)],
      }),
    ]);
    expect(html).not.toContain("<script>evil");
    expect(html).toContain("&lt;script&gt;evil");
  });

  it("marks a failing run FAILED", () => {
    const html = renderPage([
      summary({
        generatedAt: "2026-09-21T00:00:00Z",
        counts: { passed: 5, failed: 2, skipped: 0, executed: 7, total: 7 },
        suites: [suite("server", "Server integration tests", 5, 2, 0)],
      }),
    ]);
    expect(html).toContain(">FAILED<");
    expect(html).toContain("badge fail");
  });

  it("caps the history table at historyLimit rows", () => {
    const history = Array.from({ length: 5 }, (_, i) =>
      summary({ generatedAt: `2026-09-2${i}T00:00:00Z` }),
    );
    const html = renderPage(history, { historyLimit: 2 });
    // one pass-rate bar per history row → exactly historyLimit rows.
    expect(html.match(/class="bar"/g)?.length).toBe(2);
  });

  it("omits the report link when no reportHref is given", () => {
    const html = renderPage([summary({ generatedAt: "2026-09-21T00:00:00Z" })]);
    expect(html).not.toContain("View full test report");
  });

  it("renders the empty-suites fallback", () => {
    const html = renderPage([summary({ generatedAt: "2026-09-21T00:00:00Z", suites: [] })]);
    expect(html).toContain("no suites reported");
  });

  it("falls back to the raw (escaped) value for an unparseable generatedAt", () => {
    const html = renderPage([summary({ generatedAt: "not-a-date" })]);
    expect(html).toContain("not-a-date");
  });
});

describe("rich cards (chunk C)", () => {
  const e2eSuite: SuiteResult = {
    key: "e2e",
    name: "Playwright journeys",
    status: "passed",
    durationMs: 100,
    counts: { passed: 2, failed: 0, skipped: 0, executed: 2, total: 2 },
    tests: [
      {
        name: "journey 1: onboarding",
        fullName: "j1",
        status: "passed",
        durationMs: 50,
        file: "tests/journeys.spec.ts",
      },
      {
        name: "journey 2: payroll run",
        fullName: "j2",
        status: "passed",
        durationMs: 50,
        file: "tests/journeys.spec.ts",
      },
    ],
  };
  const serverSuite: SuiteResult = {
    key: "server",
    name: "Server integration tests",
    status: "failed",
    durationMs: 30,
    counts: { passed: 2, failed: 1, skipped: 0, executed: 3, total: 3 },
    tests: [
      {
        name: "zero credit -> 6.0% net, $420 per employee",
        fullName: "a",
        status: "passed",
        durationMs: 5,
        file: "/repo/apps/server/test/futa-credit.test.ts",
      },
      {
        name: "fills every computed line",
        fullName: "b",
        status: "failed",
        durationMs: 5,
        file: "/repo/apps/server/test/f941-pdf.test.ts",
      },
      {
        name: "some non-tax test",
        fullName: "c",
        status: "passed",
        durationMs: 5,
        file: "/repo/apps/server/test/auth-flows.test.ts",
      },
    ],
  };

  it("renders per-journey cards from the e2e suite", () => {
    const html = renderPage([summary({ generatedAt: "2026-09-21T00:00:00Z", suites: [e2eSuite] })]);
    expect(html).toContain("End-to-end journeys");
    expect(html).toContain("journey 1: onboarding");
    expect(html).toContain("journey 2: payroll run");
  });

  it("omits the journeys section when there is no e2e suite", () => {
    const html = renderPage([
      summary({ generatedAt: "2026-09-21T00:00:00Z", suites: [serverSuite] }),
    ]);
    expect(html).not.toContain("End-to-end journeys");
  });

  it("groups tax checks into worksheet cards and marks a failing check FAIL", () => {
    const html = renderPage([
      summary({ generatedAt: "2026-09-21T00:00:00Z", suites: [serverSuite] }),
    ]);
    expect(html).toContain("Tax-worksheet correctness");
    expect(html).toContain("Form 940 / FUTA");
    expect(html).toContain("Form 941");
    expect(html).toContain("zero credit -&gt; 6.0% net, $420 per employee");
    expect(html).not.toContain("some non-tax test"); // non-tax test excluded from cards
    expect(html).toContain(">FAIL<"); // the f941 check badge, distinct from the suite's ">FAILED<"
  });

  it("omits the tax section when no tax-classified tests are present", () => {
    const nonTax: SuiteResult = {
      ...serverSuite,
      tests: [
        {
          name: "auth works",
          fullName: "a",
          status: "passed",
          durationMs: 1,
          file: "/repo/apps/server/test/auth-flows.test.ts",
        },
      ],
    };
    const html = renderPage([summary({ generatedAt: "2026-09-21T00:00:00Z", suites: [nonTax] })]);
    expect(html).not.toContain("Tax-worksheet correctness");
  });

  // Spec 18: a skip the retained history has never seen execute is NEVER RUN,
  // not SKIP. The SKIP-with-a-last-ran-date case is covered in "never-run
  // journeys (spec 18)" below, which supplies the earlier run that executed it.
  it("renders a never-executed skipped journey as NEVER RUN", () => {
    const withSkip: SuiteResult = {
      ...e2eSuite,
      tests: [
        {
          name: "journey 4: live-QA only",
          fullName: "j4",
          status: "skipped",
          durationMs: 0,
          file: "tests/journeys.spec.ts",
        },
      ],
    };
    const html = renderPage([summary({ generatedAt: "2026-09-21T00:00:00Z", suites: [withSkip] })]);
    expect(html).toContain("NEVER RUN");
    expect(html).toContain("never-edge");
  });

  it("does not classify an e2e spec as a tax check (e2e excluded from tax cards)", () => {
    const trickyE2e: SuiteResult = {
      ...e2eSuite,
      tests: [
        {
          name: "e2e filings view",
          fullName: "f",
          status: "passed",
          durationMs: 1,
          file: "tests/filings.spec.ts",
        },
      ],
    };
    const html = renderPage([
      summary({ generatedAt: "2026-09-21T00:00:00Z", suites: [trickyE2e] }),
    ]);
    expect(html).toContain("End-to-end journeys");
    expect(html).not.toContain("Tax-worksheet correctness"); // e2e spec never becomes a tax card
  });
});

// --- spec 18 (PAY-55): honest status ---------------------------------------

function testResult(
  name: string,
  status: TestResult["status"],
  over: Partial<TestResult> = {},
): TestResult {
  return { name, fullName: name, status, durationMs: 100, file: "qa.spec.ts", ...over };
}

function makeE2eSuite(tests: TestResult[]): SuiteResult {
  const passed = tests.filter((t) => t.status === "passed").length;
  const failed = tests.filter((t) => t.status === "failed").length;
  const flaky = tests.filter((t) => t.status === "flaky").length;
  const skipped = tests.filter((t) => t.status === "skipped").length;
  return {
    key: "e2e",
    name: "Playwright journeys",
    status: failed > 0 ? "failed" : flaky > 0 ? "passed_with_flakes" : "passed",
    durationMs: 1000,
    counts: {
      passed,
      failed,
      flaky,
      skipped,
      executed: passed + failed + flaky,
      total: tests.length,
    },
    tests,
  };
}

describe("flaky headline (spec 18)", () => {
  const flakyRun = summary({
    generatedAt: "2026-09-22T21:44:42.000Z",
    overallStatus: "passed_with_flakes",
    counts: { passed: 13, failed: 0, flaky: 1, skipped: 0, executed: 14, total: 14 },
    suites: [
      makeE2eSuite([testResult("config page: State taxes tab renders", "flaky", { attempts: 2 })]),
    ],
  });

  it("never shows a plain PASSED badge for a run with flakes", () => {
    const html = renderPage([flakyRun]);
    expect(html).toContain("PASSED (FLAKY)");
    expect(html).not.toMatch(/badge pass">PASSED</);
  });

  it("shows the flake count in the headline", () => {
    expect(renderPage([flakyRun])).toMatch(/1<\/strong> flaky/);
  });

  it("omits the flake figure entirely when the count is unknown (upgraded v1)", () => {
    const v1ish = summary({
      generatedAt: "2026-09-21T21:44:42.000Z",
      counts: { passed: 10, failed: 0, skipped: 0, executed: 10, total: 10 },
    });
    expect(renderPage([v1ish])).not.toContain("flaky");
  });
});

describe("never-run journeys (spec 18)", () => {
  const older = summary({
    generatedAt: "2026-09-21T10:00:00.000Z",
    suites: [
      makeE2eSuite([
        testResult("ran once, skipped now", "passed"),
        testResult("never ran at all", "skipped", {
          skipReason: "live-QA only — needs seed-qa Dave",
        }),
      ]),
    ],
  });
  const latest = summary({
    generatedAt: "2026-09-22T10:00:00.000Z",
    suites: [
      makeE2eSuite([
        testResult("ran once, skipped now", "skipped", { skipReason: "ephemeral state missing" }),
        testResult("never ran at all", "skipped", {
          skipReason: "live-QA only — needs seed-qa Dave",
        }),
      ]),
    ],
  });
  const history = [older, latest];

  it("maps each test to the newest run that actually executed it", () => {
    const map = lastExecutedAtByTest(history);
    const at = (name: string) => lastExecutionOf("e2e", testResult(name, "skipped"), map);
    expect(at("ran once, skipped now")).toBe("2026-09-21T10:00:00.000Z");
    expect(at("never ran at all")).toBeUndefined();
  });

  it("scopes by suite, so a same-named test in another suite cannot vouch for it", () => {
    const map = lastExecutedAtByTest(history);
    // "ran once, skipped now" executed in the e2e suite only.
    expect(
      lastExecutionOf("engine", testResult("ran once, skipped now", "skipped"), map),
    ).toBeUndefined();
  });

  it("labels a test no retained run ever executed as NEVER RUN", () => {
    expect(renderPage(history)).toContain("NEVER RUN");
  });

  it("states the skip reason on the never-run card", () => {
    expect(renderPage(history)).toContain("live-QA only — needs seed-qa Dave");
  });

  it("keeps a plain SKIP, with its last-executed instant, for one that has run before", () => {
    const html = renderPage(history);
    expect(html).toMatch(/last ran 2026-09-21 10:00:00 UTC/);
  });

  it("states the never-run count as its own figure, not folded into the totals", () => {
    // Deliberately on its own line: the totals are summed per source while this
    // is a count of DISTINCT tests, so the two do not share a universe and must
    // not read as one sentence.
    expect(renderPage(history)).toMatch(
      /<strong>1<\/strong> distinct test no retained run has ever executed/,
    );
  });
});

describe("not_run suites (spec 18)", () => {
  it("renders NOT RUN, never PASSED, for a suite in which nothing executed", () => {
    const run = summary({
      generatedAt: "2026-09-22T10:00:00.000Z",
      overallStatus: "not_run",
      counts: { passed: 0, failed: 0, flaky: 0, skipped: 3, executed: 0, total: 3 },
      suites: [suite("e2e", "Playwright journeys", 0, 0, 3)],
    });
    const html = renderPage([run]);
    expect(html).toContain("NOT RUN");
    expect(html).not.toContain(">PASSED<");
  });
});

describe("footer (spec 18)", () => {
  it("declares schema v2", () => {
    expect(renderPage([summary({ generatedAt: "2026-09-22T10:00:00.000Z" })])).toContain(
      "summary schema v2",
    );
  });

  it("flags a stale deploy when the newest run predates the page build", () => {
    expect(renderPage([summary({ generatedAt: "2020-01-01T00:00:00.000Z" })])).toContain(
      "newest run is",
    );
  });
});

describe("never-run demotes the headline (spec 18)", () => {
  const withGap = [
    summary({
      generatedAt: "2026-09-22T10:00:00.000Z",
      counts: { passed: 10, failed: 0, flaky: 0, skipped: 1, executed: 10, total: 11 },
      suites: [
        makeE2eSuite([
          testResult("ran", "passed"),
          testResult("never ran", "skipped", { skipReason: "live-QA only" }),
        ]),
      ],
    }),
  ];

  it("never shows a bare PASSED in the headline or the suite rows", () => {
    const html = renderPage(withGap);
    // The headline and the suite rows both describe what is true NOW, and must
    // agree. Two sections are deliberately excluded: the per-source cards,
    // which carry each SOURCE's own verdict (a healthy ci is legitimately
    // green), and "Recent runs", which records what each run itself reported
    // and must never be rewritten.
    const headline = html.slice(0, html.indexOf("<h2>Sources</h2>"));
    const suites = html.slice(html.indexOf("<h2>Suites</h2>"), html.indexOf("<h2>End-to-end"));
    expect(headline).toContain("1 NEVER RUN");
    expect(headline).not.toMatch(/badge pass">PASSED</);
    expect(suites).toContain("PASSED · 1 NEVER RUN");
    expect(suites).not.toMatch(/badge pass">PASSED</);
  });

  it("leaves a genuinely clean system's headline alone", () => {
    // Clean now means: every source reporting, recently, all green, nothing
    // never-run. A ci-only history is NOT clean — the nightly is quiet.
    const at = new Date("2026-09-22T11:00:00Z");
    const clean = [
      summary({
        generatedAt: "2026-09-22T10:00:00.000Z",
        suites: [makeE2eSuite([testResult("ran", "passed")])],
      }),
      nightly({
        generatedAt: "2026-09-22T10:30:00.000Z",
        suites: [makeE2eSuite([testResult("ran", "passed")])],
      }),
    ];
    const html = renderPage(clean, { now: at });
    const headline = html.slice(0, html.indexOf("<h2>Sources</h2>"));
    expect(headline).toMatch(/badge pass">PASSED</);
  });

  it("refuses a green headline for a ci-only history — the nightly is quiet", () => {
    const html = renderPage(
      [
        summary({
          generatedAt: "2026-09-22T10:00:00.000Z",
          suites: [makeE2eSuite([testResult("ran", "passed")])],
        }),
      ],
      { now: new Date("2026-09-22T11:00:00Z") },
    );
    const headline = html.slice(0, html.indexOf("<h2>Sources</h2>"));
    expect(headline).not.toMatch(/badge pass">PASSED</);
    expect(headline).toContain("SOURCE QUIET");
  });

  it("does not soften a FAILED headline into the never-run wording", () => {
    const failed = summary({
      generatedAt: "2026-09-22T10:00:00.000Z",
      overallStatus: "failed",
      counts: { passed: 9, failed: 1, flaky: 0, skipped: 1, executed: 10, total: 11 },
      suites: [
        makeE2eSuite([
          testResult("boom", "failed"),
          testResult("never ran", "skipped", { skipReason: "live-QA only" }),
        ]),
      ],
    });
    const html = renderPage([failed]);
    const headline = html.slice(0, html.indexOf("<h2>Sources</h2>"));
    expect(headline).toContain('badge fail">FAILED');
    // A FAILED verdict is never softened into the amber never-run wording.
    expect(headline).not.toContain("NEVER RUN");
  });
});

// --- spec 19 (PAY-58): the per-source view --------------------------------

function nightly(over: Partial<VerifySummary> & { generatedAt: string }): VerifySummary {
  return summary({ source: "nightly", ...over });
}

const CI_RUN = summary({
  generatedAt: "2026-09-24T12:00:00.000Z",
  counts: { passed: 560, failed: 0, flaky: 0, skipped: 6, executed: 560, total: 566 },
  suites: [
    suite("engine", "Engine unit tests", 171, 0, 0),
    suite("server", "Server integration tests", 375, 0, 0),
    makeE2eSuite([testResult("journey 1: onboarding", "passed")]),
  ],
});

const NIGHTLY_RUN = nightly({
  generatedAt: "2026-09-24T13:00:00.000Z",
  overallStatus: "failed",
  counts: { passed: 11, failed: 1, flaky: 0, skipped: 9, executed: 12, total: 21 },
  suites: [
    {
      ...makeE2eSuite([
        testResult("tax deposits (PAY-9)", "passed"),
        testResult("W-2/W-3 detail (PAY-23)", "failed"),
      ]),
      status: "failed",
    },
  ],
});

/** Two hours after CI_RUN: ci is fresh, so only the nightly can be quiet. */
const SPEC19_NOW = new Date("2026-09-24T14:00:00Z");

describe("sourceViews (spec 19)", () => {
  it("represents every expected source, even one that has never reported", () => {
    const views = sourceViews([CI_RUN], SPEC19_NOW);
    expect(views.map((v) => v.source)).toEqual(["ci", "nightly"]);
    expect(views.find((v) => v.source === "nightly")?.latest).toBeUndefined();
  });

  it("picks the newest summary per source, not the newest overall", () => {
    const older = summary({ generatedAt: "2026-09-20T12:00:00.000Z" });
    const views = sourceViews([older, CI_RUN, NIGHTLY_RUN], SPEC19_NOW);
    expect(views.find((v) => v.source === "ci")?.latest?.generatedAt).toBe(CI_RUN.generatedAt);
    expect(views.find((v) => v.source === "nightly")?.latest?.generatedAt).toBe(
      NIGHTLY_RUN.generatedAt,
    );
  });

  it("applies a per-source staleness threshold — a cron is not a push", () => {
    const at = new Date("2026-09-26T12:00:00Z"); // 48h after both runs
    const views = sourceViews([CI_RUN, NIGHTLY_RUN], at);
    expect(views.find((v) => v.source === "nightly")?.stale).toBe(true);
    expect(views.find((v) => v.source === "ci")?.stale).toBe(false);
  });
});

describe("worstOutcome (spec 19)", () => {
  it("ranks failed above not_run above flaky above passed", () => {
    expect(worstOutcome(["passed", "failed", "passed_with_flakes"])).toBe("failed");
    expect(worstOutcome(["passed", "not_run"])).toBe("not_run");
    expect(worstOutcome(["passed", "passed_with_flakes"])).toBe("passed_with_flakes");
    expect(worstOutcome(["passed", "passed"])).toBe("passed");
  });
});

describe("renderPage per-source (spec 19)", () => {
  it("keeps the ci suites and counts when the NEWEST summary is a nightly", () => {
    const html = renderPage([CI_RUN, NIGHTLY_RUN], { now: SPEC19_NOW });
    expect(html).toContain("Engine unit tests");
    expect(html).toContain("Server integration tests");
    expect(html).toMatch(/560/); // the ci pass count survives
  });

  it("takes the worst outcome across sources for the headline", () => {
    expect(renderPage([CI_RUN, NIGHTLY_RUN], { now: SPEC19_NOW })).toContain("FAILED");
  });

  it("says so, loudly, when an expected source has never reported", () => {
    const html = renderPage([CI_RUN], { now: SPEC19_NOW });
    expect(html).toContain("NEVER REPORTED");
    // Headline only: the ci source card SHOULD still show its own green badge.
    const headline = html.slice(0, html.indexOf("<h2>Sources</h2>"));
    expect(headline).not.toMatch(/badge pass">PASSED</);
    // Only the never-reported nightly; ci reported two hours earlier.
    expect(headline).toContain("1 SOURCE QUIET");
  });

  it("reports a quiet nightly with its age and refuses a plain green badge", () => {
    const passingNightly = nightly({
      generatedAt: "2026-09-24T13:00:00.000Z",
      suites: [makeE2eSuite([testResult("tax deposits (PAY-9)", "passed")])],
    });
    const html = renderPage([CI_RUN, passingNightly], {
      now: new Date("2026-09-30T12:00:00Z"),
    });
    const headline = html.slice(0, html.indexOf("<h2>Sources</h2>"));
    expect(headline).toContain("SOURCE QUIET");
    expect(headline).not.toMatch(/badge pass">PASSED</);
    // The age is stated, not just the fact.
    expect(html).toMatch(/has not reported for \d+ days/);
  });

  it("shows a nightly-only journey's real result rather than NEVER RUN", () => {
    const html = renderPage([CI_RUN, NIGHTLY_RUN], { now: SPEC19_NOW });
    expect(html).toContain("tax deposits (PAY-9)");
    // It never ran in ci, but the nightly executed it — so it is not never-run.
    const card = html.slice(html.indexOf("tax deposits (PAY-9)") - 400);
    expect(card.slice(0, 600)).not.toContain("NEVER RUN");
  });

  it("still shows NEVER RUN for a journey no retained run has executed", () => {
    const withGhost = summary({
      generatedAt: "2026-09-24T12:00:00.000Z",
      suites: [
        makeE2eSuite([
          testResult("ran", "passed"),
          testResult("ghost", "skipped", { skipReason: "live-QA only" }),
        ]),
      ],
    });
    expect(renderPage([withGhost], { now: SPEC19_NOW })).toContain("NEVER RUN");
  });
});

// --- spec 19 review findings ----------------------------------------------

describe("headline never-run spans every suite, not just journeys", () => {
  it("demotes on a never-run UNIT test, not only a never-run journey", () => {
    const engineWithGhost: SuiteResult = {
      key: "engine",
      name: "Engine unit tests",
      status: "passed",
      durationMs: 10,
      counts: { passed: 1, failed: 0, flaky: 0, skipped: 1, executed: 1, total: 2 },
      tests: [
        testResult("engine ran", "passed", { file: "futa.test.ts" }),
        testResult("engine ghost", "skipped", { file: "futa.test.ts" }),
      ],
    };
    const ci = summary({
      generatedAt: "2026-09-24T12:00:00.000Z",
      suites: [engineWithGhost, makeE2eSuite([testResult("journey 1", "passed")])],
    });
    const night = nightly({
      generatedAt: "2026-09-24T12:30:00.000Z",
      suites: [makeE2eSuite([testResult("journey 1", "passed")])],
    });
    const html = renderPage([ci, night], { now: new Date("2026-09-24T13:00:00Z") });
    const headline = html.slice(0, html.indexOf("<h2>Sources</h2>"));
    // Both sources are fresh and green, so the ONLY reason to demote is the
    // never-run engine test. Before the fix the headline read a plain PASSED
    // while the engine suite row beneath it said "1 NEVER RUN".
    expect(headline).toContain("1 NEVER RUN");
    expect(headline).not.toMatch(/badge pass">PASSED</);
  });
});

describe("staleness fails closed", () => {
  const ci = summary({ generatedAt: "2026-09-24T12:00:00.000Z" });

  it("treats an unreadable generatedAt as stale, never as fresh", () => {
    const broken = nightly({ generatedAt: "not-a-date" });
    const views = sourceViews([ci, broken], new Date("2026-09-24T13:00:00Z"));
    expect(views.find((v) => v.source === "nightly")?.stale).toBe(true);
  });

  it("treats a future timestamp as stale — a skewed clock is not freshness", () => {
    const future = nightly({ generatedAt: "2027-01-01T00:00:00.000Z" });
    const views = sourceViews([ci, future], new Date("2026-09-24T13:00:00Z"));
    expect(views.find((v) => v.source === "nightly")?.stale).toBe(true);
  });

  it("does not let an unreadable timestamp produce a green headline", () => {
    const html = renderPage([ci, nightly({ generatedAt: "not-a-date" })], {
      now: new Date("2026-09-24T13:00:00Z"),
    });
    const headline = html.slice(0, html.indexOf("<h2>Sources</h2>"));
    expect(headline).not.toMatch(/badge pass">PASSED</);
  });
});

describe("executedInLatest is scoped to the e2e suite", () => {
  it("a same-named unit test cannot vouch for a journey that is being skipped", () => {
    const COLLIDING = "FUTA credit caps at 5.4%";
    const older = summary({
      generatedAt: "2026-09-20T12:00:00.000Z",
      suites: [makeE2eSuite([testResult(COLLIDING, "passed")])],
    });
    const latest = summary({
      generatedAt: "2026-09-24T12:00:00.000Z",
      suites: [
        // Same fullName, different suite, executed in the latest run.
        {
          key: "server",
          name: "Server integration tests",
          status: "passed",
          durationMs: 10,
          counts: { passed: 1, failed: 0, flaky: 0, skipped: 0, executed: 1, total: 1 },
          tests: [testResult(COLLIDING, "passed", { file: "futa.test.ts" })],
        },
        makeE2eSuite([testResult(COLLIDING, "skipped", { skipReason: "live-QA only" })]),
      ],
    });
    const html = renderPage([older, latest], { now: new Date("2026-09-24T13:00:00Z") });
    const journeys = html.slice(html.indexOf("<h2>End-to-end journeys</h2>"));
    // The journey is skipped NOW; only a unit test of the same name ran. The
    // card must say SKIP with its last real result, not wear a live PASS.
    expect(journeys.slice(0, 900)).toContain("last ran");
  });
});

describe("ordering does not assume a lexical ISO shape", () => {
  it("orders by instant, so a +02:00 offset does not outrank an earlier Z", () => {
    // 11:00Z, written with an offset — lexically AFTER "…12:00:00.000Z",
    // chronologically BEFORE it.
    const offset = summary({ generatedAt: "2026-09-24T13:00:00+02:00" });
    const utc = summary({ generatedAt: "2026-09-24T12:00:00.000Z" });
    expect(sortByGeneratedAtDesc([offset, utc])[0]?.generatedAt).toBe("2026-09-24T12:00:00.000Z");
  });

  it("never lets an unreadable instant become a source's latest", () => {
    const good = nightly({ generatedAt: "2026-09-24T12:00:00.000Z" });
    const bad = nightly({ generatedAt: "not-a-date" });
    const views = sourceViews([good, bad], new Date("2026-09-24T13:00:00Z"));
    expect(views.find((v) => v.source === "nightly")?.latest?.generatedAt).toBe(
      "2026-09-24T12:00:00.000Z",
    );
  });
});

describe("round-2 review findings", () => {
  it("a not_run SUITE demotes the headline even when the summary says passed", () => {
    // A real shape: enough executed elsewhere that the summary-level outcome is
    // `passed`, while one suite executed nothing. Reading only overallStatus let
    // the headline go green above a Suites table reading NOT RUN.
    const ci = summary({
      generatedAt: "2026-09-24T12:00:00.000Z",
      overallStatus: "passed",
      counts: { passed: 171, failed: 0, flaky: 0, skipped: 2, executed: 171, total: 173 },
      suites: [
        suite("engine", "Engine unit tests", 171, 0, 0),
        { ...makeE2eSuite([testResult("j", "passed")]), status: "not_run" as const },
      ],
    });
    const night = nightly({
      generatedAt: "2026-09-24T12:30:00.000Z",
      suites: [makeE2eSuite([testResult("j", "passed")])],
    });
    const html = renderPage([ci, night], { now: new Date("2026-09-24T13:00:00Z") });
    const headline = html.slice(0, html.indexOf("<h2>Sources</h2>"));
    expect(headline).not.toMatch(/badge pass">PASSED</);
    expect(headline).toContain("NOT RUN");
  });

  it("two same-named tests in different FILES of one suite are distinct", () => {
    const NAME = "FUTA caps at 5.4%";
    const engineTwoFiles: SuiteResult = {
      key: "engine",
      name: "Engine unit tests",
      status: "passed",
      durationMs: 10,
      counts: { passed: 1, failed: 0, flaky: 0, skipped: 1, executed: 1, total: 2 },
      tests: [
        testResult(NAME, "passed", { file: "/home/runner/work/a/futa-credit.test.ts" }),
        // Same fullName, different file, never executed. Before the fix the
        // first one's execution vouched for this one.
        testResult(NAME, "skipped", { file: "/home/runner/work/a/futa-cap.test.ts" }),
      ],
    };
    const html = renderPage(
      [
        summary({ generatedAt: "2026-09-24T12:00:00.000Z", suites: [engineTwoFiles] }),
        nightly({
          generatedAt: "2026-09-24T12:30:00.000Z",
          suites: [makeE2eSuite([testResult("j", "passed")])],
        }),
      ],
      { now: new Date("2026-09-24T13:00:00Z") },
    );
    const headline = html.slice(0, html.indexOf("<h2>Sources</h2>"));
    expect(headline).toMatch(/<strong>1<\/strong> distinct test no retained run has ever executed/);
  });

  it("matches a test across sources despite runner-specific absolute paths", () => {
    // vitest reports an absolute path that differs per runner; the basename is
    // the stable part, so the same test must resolve to one identity.
    const a = summary({
      generatedAt: "2026-09-24T12:00:00.000Z",
      suites: [
        {
          key: "engine",
          name: "Engine unit tests",
          status: "passed",
          durationMs: 1,
          counts: { passed: 1, failed: 0, flaky: 0, skipped: 0, executed: 1, total: 1 },
          tests: [testResult("shared", "passed", { file: "/home/runner/work/x/futa.test.ts" })],
        },
      ],
    });
    const b = nightly({
      generatedAt: "2026-09-24T12:30:00.000Z",
      suites: [
        {
          key: "engine",
          name: "Engine unit tests",
          status: "not_run",
          durationMs: 0,
          counts: { passed: 0, failed: 0, flaky: 0, skipped: 1, executed: 0, total: 1 },
          tests: [testResult("shared", "skipped", { file: "/__w/x/futa.test.ts" })],
        },
      ],
    });
    const html = renderPage([a, b], { now: new Date("2026-09-24T13:00:00Z") });
    const headline = html.slice(0, html.indexOf("<h2>Sources</h2>"));
    // ci executed it, so it is NOT never-run despite the nightly's differing path.
    expect(headline).not.toContain("distinct test no retained run has ever executed");
  });
});

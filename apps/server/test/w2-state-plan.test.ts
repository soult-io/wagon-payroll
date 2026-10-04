/**
 * Spec 24 (PAY-116) PR-2 — payroll-calc-auditor tests for the pure planner
 * `planW2StateLines` (apps/server/src/filings/w2-state.ts). Literal inputs,
 * no DB. Fail first on origin/main a58dfc5: the module does not exist.
 *
 * Expected values come from the auditor's oracle (w2-state-oracle.ts, no
 * src/ import) AND from the hand values of Spec 24 §11, which are asserted
 * against the oracle first so a wrong oracle cannot pass silently.
 *
 * Hand values (gross 5,000.00/month unless stated; Spec 24 §6/§11):
 *  W01 Ana CA x12, SWH 12.34      -> CA 60000.00 / 148.08 (12 x 1234 = 14808)
 *  W02 Ben CA Jan-Jun 12.34, NY Jul-Dec 20.00
 *                                 -> CA 30000.00 / 74.04; NY = box 1 60000.00 / 120.00
 *  W03 Cara 4,000.00/month, CA Jan-Jun 10.00, NY Jul-Dec 15.00
 *                                 -> CA 24000.00 / 60.00; NY 48000.00 / 90.00
 *  W04 Ivy IL 247.50 Jan-Jun, exempt Jul-Dec -> IL 60000.00 / 1485.00
 *  W05 Dee IL Jan-Apr 247.50, MD May-Aug 25.00, NC Sep-Dec 20.00
 *                                 -> IL 20000.00/990.00 f1r1, MD 20000.00/100.00 f1r2,
 *                                    NC 20000.00/80.00 f2r1; 2 forms
 *  W07 Fay TX(none) Jan-Jun, CA Jul-Dec 12.34 -> CA 30000.00 / 74.04 only
 *  W11 Jon legacy Jan-Mar 30.00, CA Apr-Dec 12.34 -> CA 45000.00 / 111.06 (9 x 1234)
 *  W14 legacy Jan-Jun 0.00, CA Jul-Dec 12.34 -> CA 30000.00 / 74.04
 *
 * Issue order (PR-2 brief §5): year-level internal_mismatch,
 * local_boxes_pending, legacy_state_runs, legacy_runs_without_state; then
 * per line in line order: missing_state_id, missing_state_id_zero_tax,
 * local_tax_md, local_tax_ny, ny_all_wages, exempt_reciprocity,
 * period_spans_move.
 */

import { describe, expect, it } from "vitest";
import { planW2StateLines, STATE_BOXES_FROM_YEAR } from "../src/filings/w2-state.js";
import {
  expBoxes,
  expFormCount,
  expLines,
  type FxRun,
  months,
  monthly,
  st,
} from "./w2-state-oracle.js";

type Source = "entered" | "ein_default" | null;

interface PlanRun {
  runPublicId: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  workState: string | null;
  stateKind: "none" | "flat" | "progressive" | null;
  exempt: boolean;
  grossCents: number;
  stateTaxCents: number;
  locals: {
    code: string;
    category: "local_resident_withholding" | "local_work_withholding";
    cents: number;
  }[];
  localsUnreadable: boolean;
}

/** Fixture runs -> planner runs, public ids "<tag>-01".. in input order. */
function planRuns(tag: string, runs: readonly FxRun[]): PlanRun[] {
  return runs.map((r, i) => ({
    runPublicId: `${tag}-${String(i + 1).padStart(2, "0")}`,
    payDate: r.payDate,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    workState: r.state?.workState ?? null,
    stateKind: r.state?.kind ?? null,
    exempt: r.state?.exempt ?? false,
    grossCents: r.grossCents,
    stateTaxCents: r.swhCents ?? 0,
    locals: [],
    localsUnreadable: false,
  }));
}

function input(
  tag: string,
  runs: readonly FxRun[],
  stateIds: Record<string, Source>,
  extra: {
    box1Cents?: number;
    moves?: string[];
    attributions?: Record<string, string>;
    year?: number;
  } = {},
) {
  const year = extra.year ?? 2026;
  return {
    taxYear: year,
    runs: planRuns(tag, runs),
    box1Cents: extra.box1Cents ?? expBoxes(runs, year).box1,
    stateIds,
    attributions: extra.attributions ?? {},
    moves: (extra.moves ?? []).map((effectiveFrom) => ({ effectiveFrom })),
  };
}

/** The oracle's lines in the planner's cent shape. */
function oracleLines(runs: readonly FxRun[], year = 2026) {
  return expLines(runs, year).map((l) => ({
    state: l.state,
    box16Cents: l.box16,
    box17Cents: l.box17,
    form: l.form,
    row: l.row,
  }));
}

/** Only the documented line keys (extra keys on a line are allowed). */
function linesOf(plan: { lines: readonly object[] }) {
  return plan.lines.map((line) => {
    const l = line as Record<string, unknown>;
    return {
      state: l.state,
      box16Cents: l.box16Cents,
      box17Cents: l.box17Cents,
      form: l.form,
      row: l.row,
    };
  });
}

const CA = st("CA");
const NY = st("NY");
const IL = st("IL");
const MD = st("MD");
const NC = st("NC");
const TX_NONE = st("TX", "none");

const ana = (): FxRun[] => months(2026, 1, 12).map((m) => monthly(m, CA, 1234));
const ben = (): FxRun[] => [
  ...months(2026, 1, 6).map((m) => monthly(m, CA, 1234)),
  ...months(2026, 7, 12).map((m) => monthly(m, NY, 2000)),
];
const dee = (): FxRun[] => [
  ...months(2026, 1, 4).map((m) => monthly(m, IL, 24750)),
  ...months(2026, 5, 8).map((m) => monthly(m, MD, 2500)),
  ...months(2026, 9, 12).map((m) => monthly(m, NC, 2000)),
];

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object") {
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

describe("oracle self-check against Spec 24 §11 hand values", () => {
  it("W01, W02, W05 oracle lines equal the hand values", () => {
    expect(oracleLines(ana())).toEqual([
      { state: "CA", box16Cents: 6_000_000, box17Cents: 14_808, form: 1, row: 1 },
    ]);
    expect(oracleLines(ben())).toEqual([
      { state: "CA", box16Cents: 3_000_000, box17Cents: 7_404, form: 1, row: 1 },
      { state: "NY", box16Cents: 6_000_000, box17Cents: 12_000, form: 1, row: 2 },
    ]);
    expect(oracleLines(dee())).toEqual([
      { state: "IL", box16Cents: 2_000_000, box17Cents: 99_000, form: 1, row: 1 },
      { state: "MD", box16Cents: 2_000_000, box17Cents: 10_000, form: 1, row: 2 },
      { state: "NC", box16Cents: 2_000_000, box17Cents: 8_000, form: 2, row: 1 },
    ]);
    expect(expFormCount(expLines(dee(), 2026))).toBe(2);
  });
});

describe("STATE_BOXES_FROM_YEAR", () => {
  it("is 2026 (S24-D5)", () => {
    expect(STATE_BOXES_FROM_YEAR).toBe(2026);
  });
});

describe("W01 CA single state", () => {
  it("one CA line 6000000 / 14808 on form 1 row 1, formCount 1, no locals, no issues", () => {
    const plan = planW2StateLines(input("ana", ana(), { CA: "entered" }));
    expect({
      lines: linesOf(plan),
      locals: plan.locals,
      formCount: plan.formCount,
      issues: plan.issues,
    }).toEqual({
      lines: oracleLines(ana()),
      locals: [],
      formCount: 1,
      issues: [],
    });
  });
});

describe("W02 CA -> NY, NY box 16 = box 1 (R3), issue order (O1)", () => {
  it("CA 3000000/7404 row 1; NY 6000000/12000 row 2; issues local_tax_ny then ny_all_wages", () => {
    const plan = planW2StateLines(input("ben", ben(), { CA: "entered", NY: "ein_default" }));
    expect({ lines: linesOf(plan), formCount: plan.formCount, issues: plan.issues }).toEqual({
      lines: oracleLines(ben()),
      formCount: 1,
      issues: [
        { code: "local_tax_ny", severity: "warn", state: "NY" },
        { code: "ny_all_wages", severity: "info", state: "NY" },
      ],
    });
  });
});

describe("W03 move mid-period (K3, I2)", () => {
  const cara = (): FxRun[] => [
    ...months(2026, 1, 6).map((m) => monthly(m, CA, 1000, { grossCents: 400_000 })),
    ...months(2026, 7, 12).map((m) => monthly(m, NY, 1500, { grossCents: 400_000 })),
  ];
  it("June run stays CA; CA 2400000/6000; NY 4800000/9000; period_spans_move on the CA line", () => {
    expect(oracleLines(cara())).toEqual([
      { state: "CA", box16Cents: 2_400_000, box17Cents: 6_000, form: 1, row: 1 },
      { state: "NY", box16Cents: 4_800_000, box17Cents: 9_000, form: 1, row: 2 },
    ]);
    const plan = planW2StateLines(
      input(
        "cara",
        cara(),
        { CA: "entered", NY: "ein_default" },
        { moves: ["2026-01-01", "2026-06-10"] },
      ),
    );
    expect({ lines: linesOf(plan), issues: plan.issues }).toEqual({
      lines: oracleLines(cara()),
      issues: [
        { code: "period_spans_move", severity: "info", state: "CA", date: "2026-06-10" },
        { code: "local_tax_ny", severity: "warn", state: "NY" },
        { code: "ny_all_wages", severity: "info", state: "NY" },
      ],
    });
  });

  it("boundary: a move on periodStart is not inside the period; a move on periodEnd is", () => {
    const runs = [monthly("2026-03", CA, 1234)];
    const at = (d: string) =>
      planW2StateLines(
        input("b", runs, { CA: "entered" }, { box1Cents: 500_000, moves: ["2024-01-01", d] }),
      ).issues;
    expect({
      onStart: at("2026-03-01"),
      onEnd: at("2026-03-31"),
      dayAfter: at("2026-04-01"),
      dayBefore: at("2026-02-28"),
    }).toEqual({
      onStart: [],
      onEnd: [{ code: "period_spans_move", severity: "info", state: "CA", date: "2026-03-31" }],
      dayAfter: [],
      dayBefore: [],
    });
  });
});

describe("W04 IL exempt from July (K2, W8)", () => {
  it("IL 6000000 / 148500; one exempt_reciprocity warn on IL", () => {
    const ivy = [
      ...months(2026, 1, 6).map((m) => monthly(m, IL, 24750)),
      ...months(2026, 7, 12).map((m) => monthly(m, st("IL", "flat", true), 0)),
    ];
    const plan = planW2StateLines(input("ivy", ivy, { IL: "ein_default" }));
    expect({ lines: linesOf(plan), issues: plan.issues }).toEqual({
      lines: [{ state: "IL", box16Cents: 6_000_000, box17Cents: 148_500, form: 1, row: 1 }],
      issues: [{ code: "exempt_reciprocity", severity: "warn", state: "IL" }],
    });
  });

  it("MD exempt: local_tax_md before exempt_reciprocity; CA/NY exempt raise no reciprocity warn", () => {
    const runs = [
      monthly("2026-01", st("MD", "progressive", true), 0),
      monthly("2026-02", st("CA", "progressive", true), 0),
      monthly("2026-03", st("NY", "progressive", true), 0),
    ];
    const plan = planW2StateLines(
      input("mdx", runs, { MD: "entered", CA: "entered", NY: "entered" }),
    );
    expect(plan.issues).toEqual([
      { code: "local_tax_md", severity: "warn", state: "MD" },
      { code: "exempt_reciprocity", severity: "warn", state: "MD" },
      { code: "local_tax_ny", severity: "warn", state: "NY" },
      { code: "ny_all_wages", severity: "info", state: "NY" },
    ]);
  });
});

describe("W05 three states -> two forms (R5), O1", () => {
  it("IL f1r1, MD f1r2, NC f2r1; formCount 2; one local_tax_md", () => {
    const plan = planW2StateLines(
      input("dee", dee(), { IL: "ein_default", MD: "entered", NC: "entered" }),
    );
    expect({ lines: linesOf(plan), formCount: plan.formCount, issues: plan.issues }).toEqual({
      lines: oracleLines(dee()),
      formCount: 2,
      issues: [{ code: "local_tax_md", severity: "warn", state: "MD" }],
    });
  });

  it("form/row placement and formCount for 0, 1, 2, 3, 4, 5 states; code-point order", () => {
    const codes = ["NY", "CA", "IL", "MD", "NC"];
    const placements: Record<number, unknown> = {};
    for (let n = 0; n <= 5; n++) {
      const runs = codes
        .slice(0, n)
        .map((c, i) => monthly(`2026-${String(i + 1).padStart(2, "0")}`, st(c), 100));
      const ids = Object.fromEntries(codes.map((c) => [c, "entered" as const]));
      const plan = planW2StateLines(input(`n${n}`, runs, ids));
      placements[n] = {
        formCount: plan.formCount,
        lines: plan.lines.map((l) => `${String(l.state)}:${String(l.form)}/${String(l.row)}`),
      };
    }
    expect(placements).toEqual({
      0: { formCount: 1, lines: [] },
      1: { formCount: 1, lines: ["NY:1/1"] },
      2: { formCount: 1, lines: ["CA:1/1", "NY:1/2"] },
      3: { formCount: 2, lines: ["CA:1/1", "IL:1/2", "NY:2/1"] },
      4: { formCount: 2, lines: ["CA:1/1", "IL:1/2", "MD:2/1", "NY:2/2"] },
      5: { formCount: 3, lines: ["CA:1/1", "IL:1/2", "MD:2/1", "NC:2/2", "NY:3/1"] },
    });
  });
});

describe("W06 / W07 kind none (R4)", () => {
  it("W06 TX all year: no lines, formCount 1, no issues", () => {
    const eve = months(2026, 1, 12).map((m) => monthly(m, TX_NONE, 0));
    const plan = planW2StateLines(input("eve", eve, {}));
    expect({
      lines: plan.lines,
      formCount: plan.formCount,
      issues: plan.issues,
      locals: plan.locals,
    }).toEqual({
      lines: [],
      formCount: 1,
      issues: [],
      locals: [],
    });
  });

  it("W07 TX Jan-Jun then CA: only CA 3000000 / 7404", () => {
    const fay = [
      ...months(2026, 1, 6).map((m) => monthly(m, TX_NONE, 0)),
      ...months(2026, 7, 12).map((m) => monthly(m, CA, 1234)),
    ];
    const plan = planW2StateLines(input("fay", fay, { CA: "entered" }));
    expect({ lines: linesOf(plan), issues: plan.issues }).toEqual({
      lines: [{ state: "CA", box16Cents: 3_000_000, box17Cents: 7_404, form: 1, row: 1 }],
      issues: [],
    });
  });

  it("a state is dropped only when EVERY run is kind none (one flat run keeps the line, summing all its runs)", () => {
    const runs = [
      monthly("2026-01", st("WA", "none"), 0),
      monthly("2026-02", st("WA", "flat"), 700),
    ];
    const plan = planW2StateLines(input("mix", runs, { WA: "entered" }));
    expect(linesOf(plan)).toEqual([
      { state: "WA", box16Cents: 1_000_000, box17Cents: 700, form: 1, row: 1 },
    ]);
  });
});

describe("W08 / W09 / W10 state ID availability (S24-D3)", () => {
  const hal = (swh: number) =>
    months(2026, 1, 12).map((m) => monthly(m, st("NY", "progressive", swh === 0), swh));

  it("W08 NY exempt, EIN default: NY 6000000 / 0, not blocked", () => {
    const plan = planW2StateLines(input("hal", hal(0), { NY: "ein_default" }));
    expect({ lines: linesOf(plan), issues: plan.issues }).toEqual({
      lines: [{ state: "NY", box16Cents: 6_000_000, box17Cents: 0, form: 1, row: 1 }],
      issues: [
        { code: "local_tax_ny", severity: "warn", state: "NY" },
        { code: "ny_all_wages", severity: "info", state: "NY" },
      ],
    });
  });

  it("W08b no source, tax withheld 15.00/run: missing_state_id block first", () => {
    const plan = planW2StateLines(input("halb", hal(1500), { NY: null }));
    expect({ lines: linesOf(plan), issues: plan.issues }).toEqual({
      lines: [{ state: "NY", box16Cents: 6_000_000, box17Cents: 18_000, form: 1, row: 1 }],
      issues: [
        { code: "missing_state_id", severity: "block", state: "NY" },
        { code: "local_tax_ny", severity: "warn", state: "NY" },
        { code: "ny_all_wages", severity: "info", state: "NY" },
      ],
    });
  });

  it("W08c no source, no tax: missing_state_id_zero_tax warn only", () => {
    const plan = planW2StateLines(input("halc", hal(0), {}));
    expect(plan.issues).toEqual([
      { code: "missing_state_id_zero_tax", severity: "warn", state: "NY" },
      { code: "local_tax_ny", severity: "warn", state: "NY" },
      { code: "ny_all_wages", severity: "info", state: "NY" },
    ]);
  });

  it("W09 NC exempt, no NC ID: NC 6000000 / 0 with W4 only", () => {
    const ivy = months(2026, 1, 12).map((m) => monthly(m, st("NC", "flat", true), 0));
    const plan = planW2StateLines(input("ivy9", ivy, { NC: null }));
    expect({ lines: linesOf(plan), issues: plan.issues }).toEqual({
      lines: [{ state: "NC", box16Cents: 6_000_000, box17Cents: 0, form: 1, row: 1 }],
      issues: [{ code: "missing_state_id_zero_tax", severity: "warn", state: "NC" }],
    });
  });

  it("W10 CA without ID: missing_state_id block; 1 cent of tax already blocks", () => {
    const noId = planW2StateLines(input("w10", ana(), { CA: null }));
    const oneCent = planW2StateLines(
      input("w10c", [monthly("2026-01", CA, 1)], {}, { box1Cents: 500_000 }),
    );
    expect({ noId: noId.issues, oneCent: oneCent.issues }).toEqual({
      noId: [{ code: "missing_state_id", severity: "block", state: "CA" }],
      oneCent: [{ code: "missing_state_id", severity: "block", state: "CA" }],
    });
  });
});

describe("W11 / W13 / W14 legacy runs (R7)", () => {
  it("W11: one legacy_state_runs block listing the 3 runs (pay-date order, 30.00 each); CA 4500000 / 11106 still computed", () => {
    const jon = [
      ...months(2026, 1, 3).map((m) => monthly(m, null, 3000)),
      ...months(2026, 4, 12).map((m) => monthly(m, CA, 1234)),
    ];
    const plan = planW2StateLines(input("jon", jon, { CA: "entered" }));
    expect({ lines: linesOf(plan), issues: plan.issues }).toEqual({
      lines: [{ state: "CA", box16Cents: 4_500_000, box17Cents: 11_106, form: 1, row: 1 }],
      issues: [
        {
          code: "legacy_state_runs",
          severity: "block",
          runs: [
            { runPublicId: "jon-01", payDate: "2026-01-25", stateTax: "30.00" },
            { runPublicId: "jon-02", payDate: "2026-02-25", stateTax: "30.00" },
            { runPublicId: "jon-03", payDate: "2026-03-25", stateTax: "30.00" },
          ],
        },
      ],
    });
  });

  it("W13 all runs legacy with no state tax: no lines, no issues", () => {
    const neo = months(2026, 1, 12).map((m) => monthly(m, null, 0));
    const plan = planW2StateLines(input("neo", neo, {}));
    expect({ lines: plan.lines, formCount: plan.formCount, issues: plan.issues }).toEqual({
      lines: [],
      formCount: 1,
      issues: [],
    });
  });

  it("W14 legacy SWH 0 Jan-Jun + CA Jul-Dec: legacy_runs_without_state warn; CA 3000000 / 7404", () => {
    const neo = [
      ...months(2026, 1, 6).map((m) => monthly(m, null, 0)),
      ...months(2026, 7, 12).map((m) => monthly(m, CA, 1234)),
    ];
    const plan = planW2StateLines(input("neo14", neo, { CA: "entered" }));
    expect({ lines: linesOf(plan), issues: plan.issues }).toEqual({
      lines: [{ state: "CA", box16Cents: 3_000_000, box17Cents: 7_404, form: 1, row: 1 }],
      issues: [{ code: "legacy_runs_without_state", severity: "warn" }],
    });
  });

  it("a legacy run with no state_withholding entry (absent = 0) is skipped, not blocked", () => {
    const runs = [monthly("2026-01", null, undefined), monthly("2026-02", CA, 1234)];
    const plan = planW2StateLines(input("abs", runs, { CA: "entered" }));
    expect(plan.issues).toEqual([{ code: "legacy_runs_without_state", severity: "warn" }]);
  });

  it("S24-D1 attributions (planner only; PR-5 feeds them): an attributed legacy run counts in its state, no block", () => {
    const jon = [
      ...months(2026, 1, 3).map((m) => monthly(m, null, 3000)),
      ...months(2026, 4, 12).map((m) => monthly(m, CA, 1234)),
    ];
    const plan = planW2StateLines(
      input(
        "jat",
        jon,
        { CA: "entered" },
        { attributions: { "jat-01": "CA", "jat-02": "CA", "jat-03": "CA" } },
      ),
    );
    expect({ lines: linesOf(plan), issues: plan.issues }).toEqual({
      lines: [{ state: "CA", box16Cents: 6_000_000, box17Cents: 20_106, form: 1, row: 1 }],
      issues: [],
    });
  });

  it("an attributed run counts as having income tax (kind null): a TX attribution keeps a TX line", () => {
    const runs = [monthly("2026-01", null, 500)];
    const plan = planW2StateLines(
      input("atx", runs, { TX: "entered" }, { attributions: { "atx-01": "TX" } }),
    );
    expect(linesOf(plan)).toEqual([
      { state: "TX", box16Cents: 500_000, box17Cents: 500, form: 1, row: 1 },
    ]);
  });
});

describe("year-level issue order (O1)", () => {
  it("local_boxes_pending, legacy_state_runs, legacy_runs_without_state, then line issues", () => {
    const runs = [
      monthly("2026-01", null, 3000),
      monthly("2026-02", null, 0),
      monthly("2026-03", CA, 1234),
    ];
    const inp = input("ord", runs, { CA: null });
    inp.runs[2]!.locals = [
      { code: "NY-NYC", category: "local_resident_withholding", cents: 16556 },
    ];
    const plan = planW2StateLines(inp);
    expect(plan.issues).toEqual([
      { code: "local_boxes_pending", severity: "block" },
      {
        code: "legacy_state_runs",
        severity: "block",
        runs: [{ runPublicId: "ord-01", payDate: "2026-01-25", stateTax: "30.00" }],
      },
      { code: "legacy_runs_without_state", severity: "warn" },
      { code: "missing_state_id", severity: "block", state: "CA" },
    ]);
  });
});

describe("W34 locals fail closed (S24-D8)", () => {
  it("a run with locals -> exactly one local_boxes_pending {code, severity}; plan locals []", () => {
    const inp = input("w34", ana(), { CA: "entered" });
    inp.runs[4]!.locals = [
      { code: "NY-NYC", category: "local_resident_withholding", cents: 16556 },
    ];
    inp.runs[7]!.locals = [{ code: "MD-510", category: "local_work_withholding", cents: 100 }];
    const plan = planW2StateLines(inp);
    expect({ issues: plan.issues, locals: plan.locals }).toEqual({
      issues: [{ code: "local_boxes_pending", severity: "block" }],
      locals: [],
    });
  });

  it("a run the loader marked localsUnreadable -> the same single issue", () => {
    const inp = input("w34u", ana(), { CA: "entered" });
    inp.runs[0]!.localsUnreadable = true;
    const plan = planW2StateLines(inp);
    expect({ issues: plan.issues, locals: plan.locals }).toEqual({
      issues: [{ code: "local_boxes_pending", severity: "block" }],
      locals: [],
    });
  });
});

describe("W35 internal_mismatch (M3): never throws, {code, severity} only", () => {
  it("box1Cents one cent above the run sum -> one internal_mismatch issue", () => {
    const sum = expBoxes(ana(), 2026).box1;
    const plan = planW2StateLines(input("w35", ana(), { CA: "entered" }, { box1Cents: sum + 1 }));
    expect(plan.issues.filter((i) => i.code === "internal_mismatch")).toEqual([
      { code: "internal_mismatch", severity: "block" },
    ]);
  });

  it("box1Cents one cent below the run sum -> one internal_mismatch issue", () => {
    const sum = expBoxes(ana(), 2026).box1;
    const plan = planW2StateLines(input("w35b", ana(), { CA: "entered" }, { box1Cents: sum - 1 }));
    expect(plan.issues.filter((i) => i.code === "internal_mismatch")).toEqual([
      { code: "internal_mismatch", severity: "block" },
    ]);
  });

  it("an unreadable run amount (NaN) does not throw and yields internal_mismatch", () => {
    const inp = input("w35n", ana(), { CA: "entered" });
    inp.runs[3]!.grossCents = Number.NaN;
    let plan: ReturnType<typeof planW2StateLines> | undefined;
    expect(() => {
      plan = planW2StateLines(inp);
    }).not.toThrow();
    expect(plan?.issues.filter((i) => i.code === "internal_mismatch")).toEqual([
      { code: "internal_mismatch", severity: "block" },
    ]);
  });

  it("no issue anywhere carries an amount except legacy_state_runs (P1)", () => {
    const runs = [
      ...months(2026, 1, 2).map((m) => monthly(m, null, 3000)),
      ...months(2026, 3, 12).map((m) => monthly(m, st("MD", "progressive", true), 0)),
    ];
    const inp = input("p1", runs, { MD: null }, { moves: ["2024-01-01", "2026-05-10"] });
    inp.runs[5]!.localsUnreadable = true;
    const plan = planW2StateLines(inp);
    const allowed = new Set(["code", "severity", "state", "date", "runs"]);
    for (const i of plan.issues) {
      for (const k of Object.keys(i)) expect(allowed.has(k), `${i.code} carries ${k}`).toBe(true);
      if (i.code !== "legacy_state_runs") expect("runs" in i, i.code).toBe(false);
    }
    expect(plan.issues.map((i) => i.code)).toEqual([
      "local_boxes_pending",
      "legacy_state_runs",
      "missing_state_id_zero_tax",
      "local_tax_md",
      "exempt_reciprocity",
      "period_spans_move",
    ]);
  });
});

describe("purity", () => {
  it("does not mutate its input and returns the same plan for the same input", () => {
    const a = planW2StateLines(
      deepFreeze(input("pure", ben(), { CA: "entered", NY: "ein_default" })),
    );
    const b = planW2StateLines(
      deepFreeze(input("pure", ben(), { CA: "entered", NY: "ein_default" })),
    );
    expect(a).toEqual(b);
  });

  it("run order does not change the plan (lines sorted by state; legacy runs listed by pay date)", () => {
    const jon = [
      ...months(2026, 1, 3).map((m) => monthly(m, null, 3000)),
      ...months(2026, 4, 12).map((m) => monthly(m, CA, 1234)),
      monthly("2026-12", NY, 0, { payDate: "2026-12-30", grossCents: 100 }),
    ];
    const fwd = input("ro", jon, { CA: "entered", NY: "ein_default" });
    const rev = { ...fwd, runs: [...fwd.runs].reverse() };
    expect(planW2StateLines(rev)).toEqual(planW2StateLines(fwd));
  });
});

// ---------------------------------------------------------------------------
// Review round (2026-10-04)
// ---------------------------------------------------------------------------

describe("review R-hire: the employee's first work-state row is a hire, not a move (K3)", () => {
  // `moves` carries every work-state row of the employee (all years); the
  // earliest effectiveFrom is where the employee started, so it never
  // raises period_spans_move, even when it falls inside a run's period.
  const runs = () => [
    monthly("2026-03", CA, 1234, { grossCents: 250_000 }),
    ...months(2026, 4, 12).map((m) => monthly(m, CA, 1234)),
  ];
  const box1Cents = 250_000 + 9 * 500_000;

  it("hired 2026-03-15 inside the Mar 1-31 period: no period_spans_move", () => {
    const plan = planW2StateLines(
      input("hire", runs(), { CA: "entered" }, { box1Cents, moves: ["2026-03-15"] }),
    );
    expect(plan.issues).toEqual([]);
  });

  it("hired 2026-03-15, then a real move on 2026-06-10: one period_spans_move for 2026-06-10 only", () => {
    const plan = planW2StateLines(
      input("hire2", runs(), { CA: "entered" }, { box1Cents, moves: ["2026-06-10", "2026-03-15"] }),
    );
    expect(plan.issues).toEqual([
      { code: "period_spans_move", severity: "info", state: "CA", date: "2026-06-10" },
    ]);
  });

  it("a first row from an earlier year plus a move inside a 2026 period still raises it", () => {
    const plan = planW2StateLines(
      input("hire3", runs(), { CA: "entered" }, { box1Cents, moves: ["2024-07-01", "2026-03-15"] }),
    );
    expect(plan.issues).toEqual([
      { code: "period_spans_move", severity: "info", state: "CA", date: "2026-03-15" },
    ]);
  });
});

describe("review R-negative: net negative box 17 for the year is a block (PAY-162 code)", () => {
  // Refunds exceed withholding: 12.34 withheld in January, a February
  // adjustment run with 0.00 gross refunds 50.00 -> box 17 = 1234 - 5000
  // = -3766 cents. A W-2 money box is unsigned (iw2w3 2026; PAY-162 D2).
  const runs = () => [
    monthly("2026-01", CA, 1234),
    monthly("2026-02", CA, -5000, { grossCents: 0 }),
  ];

  it("one negative_amount block carrying the state; nothing else on a CA line with an ID", () => {
    const plan = planW2StateLines(input("neg", runs(), { CA: "entered" }, { box1Cents: 500_000 }));
    expect(plan.issues).toEqual([{ code: "negative_amount", severity: "block", state: "CA" }]);
  });

  it("zero box 17 is not negative; -1 cent is", () => {
    const zero = planW2StateLines(
      input(
        "z",
        [monthly("2026-01", CA, 100), monthly("2026-02", CA, -100, { grossCents: 0 })],
        { CA: "entered" },
        { box1Cents: 500_000 },
      ),
    );
    const minusOne = planW2StateLines(
      input(
        "m",
        [monthly("2026-01", CA, 100), monthly("2026-02", CA, -101, { grossCents: 0 })],
        { CA: "entered" },
        { box1Cents: 500_000 },
      ),
    );
    expect({ zero: zero.issues, minusOne: minusOne.issues }).toEqual({
      zero: [],
      minusOne: [{ code: "negative_amount", severity: "block", state: "CA" }],
    });
  });

  it("only the negative state is flagged on a two-state W-2", () => {
    const two = [...runs(), monthly("2026-03", st("IL"), 2000)];
    const plan = planW2StateLines(
      input("neg2", two, { CA: "entered", IL: "entered" }, { box1Cents: 1_000_000 }),
    );
    expect(plan.issues.filter((i) => i.code === "negative_amount")).toEqual([
      { code: "negative_amount", severity: "block", state: "CA" },
    ]);
  });
});

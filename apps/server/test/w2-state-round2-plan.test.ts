/**
 * Spec 24 (PAY-116) PR-3 fix round 2, R2 planner (payroll-calc-auditor,
 * fail-first): a state line whose box 16 nets below zero is a
 * negative_amount block on that line, the same as box 17 < 0. A W-2 money
 * box is unsigned (iw2w3 2026; PAY-162 D2). Literal planner input, integer
 * cents; nothing from @payroll/engine.
 *
 * Fixture: CA Jan gross 5,000.00 (SWH 12.34), CA Feb adjustment gross
 * -6,000.00 (SWH 0); IL Mar gross 7,000.00 (SWH 20.00). Box 1 = 500000 -
 * 600000 + 700000 = 600000 cents. CA box 16 = -100000 (< 0), box 17 = 1234
 * (>= 0). IL box 16 = 700000, box 17 = 2000.
 */

import { describe, expect, it } from "vitest";
import { planW2StateLines } from "../src/filings/w2-state.js";

function run(
  id: string,
  month: string,
  workState: string,
  grossCents: number,
  stateTaxCents: number,
) {
  const last = month === "2026-02" ? "28" : "31";
  return {
    runPublicId: id,
    payDate: `${month}-25`,
    periodStart: `${month}-01`,
    periodEnd: `${month}-${last}`,
    workState,
    stateKind: "progressive" as const,
    exempt: false,
    grossCents,
    stateTaxCents,
    locals: [],
    localsUnreadable: false,
  };
}

const INPUT = {
  taxYear: 2026,
  runs: [
    run("neg16-01", "2026-01", "CA", 500_000, 1234),
    run("neg16-02", "2026-02", "CA", -600_000, 0),
    run("neg16-03", "2026-03", "IL", 700_000, 2000),
  ],
  box1Cents: 600_000,
  stateIds: { CA: "entered" as const, IL: "entered" as const },
  attributions: {},
  moves: [],
};

describe("R2 planner: box 16 < 0 -> negative_amount (block) on that state's line", () => {
  it("CA line box16 -100000 / box17 1234 is flagged; IL is not", () => {
    const plan = planW2StateLines(INPUT as never);
    expect({
      lines: plan.lines.map((l) => [l.state, l.box16Cents, l.box17Cents]),
      negative: plan.issues.filter((i) => i.code === "negative_amount"),
    }).toEqual({
      lines: [
        ["CA", -100_000, 1234],
        ["IL", 700_000, 2000],
      ],
      negative: [{ code: "negative_amount", severity: "block", state: "CA" }],
    });
  });
});

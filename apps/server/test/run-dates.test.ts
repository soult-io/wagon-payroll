/**
 * Spec 26 (PAY-173) D1/D2 — pure unit tests for run-dates.ts (T3 and the
 * runDates rule). Must fail first: the module does not exist on main 1fbd87e.
 * (The spec names src/payroll/run-dates.test.ts; vitest only collects
 * test/**, so the suite lives here and imports the module path the spec
 * defines.)
 */

import { describe, expect, it } from "vitest";
import * as runDatesModule from "../src/payroll/run-dates.js";
import { PayrollServiceError } from "../src/payroll/runs.js";

const { runDates, compareYtdKey } = runDatesModule;

describe("runDates (D1)", () => {
  it("arrears across the year boundary: tables + YTD by pay date, certificate by period end, earned by period start", () => {
    expect(
      runDates({ periodStart: "2026-12-01", periodEnd: "2026-12-31", payDate: "2027-01-05" }),
    ).toEqual({
      payDate: "2027-01-05",
      certificateAsOf: "2026-12-31",
      taxYear: 2027,
      earnedAsOf: "2026-12-01",
    });
  });

  it("advance pay inside the period: certificateAsOf = pay date", () => {
    expect(
      runDates({ periodStart: "2026-12-01", periodEnd: "2026-12-31", payDate: "2026-12-20" }),
    ).toEqual({
      payDate: "2026-12-20",
      certificateAsOf: "2026-12-20",
      taxYear: 2026,
      earnedAsOf: "2026-12-01",
    });
  });

  it("advance pay into the prior year: period 2027-01 paid 2026-12-31 → taxYear 2026", () => {
    expect(
      runDates({ periodStart: "2027-01-01", periodEnd: "2027-01-31", payDate: "2026-12-31" }),
    ).toEqual({
      payDate: "2026-12-31",
      certificateAsOf: "2026-12-31",
      taxYear: 2026,
      earnedAsOf: "2027-01-01",
    });
  });

  it("pay date equal to period end", () => {
    const d = runDates({
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      payDate: "2026-11-30",
    });
    expect(d.certificateAsOf).toBe("2026-11-30");
    expect(d.taxYear).toBe(2026);
  });

  it("accepts a leap day", () => {
    const d = runDates({
      periodStart: "2028-02-01",
      periodEnd: "2028-02-29",
      payDate: "2028-02-29",
    });
    expect(d.taxYear).toBe(2028);
  });

  it.each([
    ["non-ISO date", { periodStart: "2026/12/01", periodEnd: "2026-12-31", payDate: "2027-01-05" }],
    [
      "impossible date",
      { periodStart: "2026-02-01", periodEnd: "2026-02-30", payDate: "2026-02-15" },
    ],
    [
      "impossible month",
      { periodStart: "2026-12-01", periodEnd: "2026-12-31", payDate: "2027-13-05" },
    ],
    [
      "period end before start",
      { periodStart: "2026-12-31", periodEnd: "2026-12-01", payDate: "2026-12-15" },
    ],
  ])("throws invalid_period on %s", (_label, period) => {
    let err: unknown = null;
    try {
      runDates(period);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PayrollServiceError);
    expect((err as PayrollServiceError).code).toBe("invalid_period");
  });
});

describe("compareYtdKey (T3, D2 order (pay_date, period_start, id); null id = +∞)", () => {
  const k = (payDate: string, periodStart: string, selfRunId: number | null) => ({
    payDate,
    periodStart,
    selfRunId,
  });
  const sign = (n: number) => Math.sign(n);

  it("pay date dominates period start and id", () => {
    expect(
      sign(compareYtdKey(k("2026-12-04", "2026-12-01", 99), k("2026-12-15", "2026-01-01", 1))),
    ).toBe(-1);
  });
  it("same pay date: earlier period start first", () => {
    expect(
      sign(compareYtdKey(k("2026-12-04", "2026-10-01", 9), k("2026-12-04", "2026-11-01", 5))),
    ).toBe(-1);
  });
  it("same pay date and period start: id 5 before id 9", () => {
    expect(
      sign(compareYtdKey(k("2026-12-04", "2026-11-01", 5), k("2026-12-04", "2026-11-01", 9))),
    ).toBe(-1);
    expect(
      sign(compareYtdKey(k("2026-12-04", "2026-11-01", 9), k("2026-12-04", "2026-11-01", 5))),
    ).toBe(1);
  });
  it("a new draft (null id = +∞) sorts after every existing id on the same pay date and start", () => {
    expect(
      sign(
        compareYtdKey(
          k("2026-12-04", "2026-11-01", 2147483646),
          k("2026-12-04", "2026-11-01", null),
        ),
      ),
    ).toBe(-1);
    expect(
      sign(compareYtdKey(k("2026-12-04", "2026-11-01", null), k("2026-12-04", "2026-11-01", 5))),
    ).toBe(1);
  });
  it("equal keys compare 0", () => {
    expect(compareYtdKey(k("2026-12-04", "2026-11-01", 5), k("2026-12-04", "2026-11-01", 5))).toBe(
      0,
    );
  });
  it("is a total order: sorting a shuffled list gives the D2 order, antisymmetric", () => {
    const ordered = [
      k("2026-01-05", "2025-12-01", 1),
      k("2026-12-04", "2026-10-01", 7),
      k("2026-12-04", "2026-11-01", 5),
      k("2026-12-04", "2026-11-01", 9),
      k("2026-12-04", "2026-11-01", null),
      k("2027-01-05", "2026-12-01", 2),
    ];
    const shuffled = [
      ordered[3],
      ordered[5],
      ordered[0],
      ordered[4],
      ordered[2],
      ordered[1],
    ] as typeof ordered;
    expect([...shuffled].sort(compareYtdKey)).toEqual(ordered);
    for (const a of ordered)
      for (const b of ordered)
        expect(sign(compareYtdKey(a, b)) + sign(compareYtdKey(b, a))).toBe(0);
  });
});

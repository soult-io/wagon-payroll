/**
 * PAY-193 L4 — the late predicate (addendum L4.2, tests LP-1…LP-10).
 * Auditor-owned (payroll-calc-auditor), fail-first. Pure: no DB, no clock.
 *
 * Rule (Q-N2 = B, brain #3940; Q-S2 state SME 2026-10-03):
 *   quarterEnd(payDate) < today                                 -> "quarter_ended" (wins)
 *   else monthEnd(payDate) < today and MONTHLY_RETURN_STATES[workState]
 *        covers month(payDate)                                  -> "month_ended"
 *   else                                                        -> null
 * String (ISO) date compares only.
 *
 * Interface the coder must meet: apps/server/src/payroll/late-issue.ts exports
 *   MONTHLY_RETURN_STATES: Readonly<Record<string, "all" | readonly number[]>>
 *   lateTrigger(payDate: string, today: string, workState: string | null): "quarter_ended" | "month_ended" | null
 *   monthEnd(payDate: string): string
 * The module is loaded per test (dynamic import) so each case fails on its
 * own until it exists.
 */

import { describe, expect, it } from "vitest";

type Trigger = "quarter_ended" | "month_ended" | null;
interface LateIssueModule {
  MONTHLY_RETURN_STATES: Readonly<Record<string, "all" | readonly number[]>>;
  lateTrigger: (payDate: string, today: string, workState: string | null) => Trigger;
  monthEnd: (payDate: string) => string;
}

async function load(): Promise<LateIssueModule> {
  // Loaded per test: the module does not exist until L4 is built.
  return (await import("../src/payroll/late-issue.js")) as unknown as LateIssueModule;
}

/** The table exactly as researched (L4.2). */
const EXPECTED_TABLE = {
  CO: "all",
  DE: "all",
  IN: "all",
  MD: "all",
  MI: "all",
  MS: "all",
  NM: "all",
  VA: "all",
  AL: [1, 2, 4, 5, 7, 8, 10, 11],
  MA: [1, 2, 4, 5, 7, 8, 10, 11],
  MO: [1, 2, 4, 5, 7, 8, 10, 11],
  KY: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  NC: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  NY: "all",
  AR: "all",
  KS: "all",
  WI: "all",
  PA: "all",
};

describe("lateTrigger — L4.2 cases", () => {
  it("LP-1: IL paid 2026-03-20, today 2026-03-31 (quarter's last day) -> null", async () => {
    const { lateTrigger } = await load();
    expect(lateTrigger("2026-03-20", "2026-03-31", "IL")).toBeNull();
  });

  it("LP-2: IL paid 2026-03-20, today 2026-04-01 -> quarter_ended", async () => {
    const { lateTrigger } = await load();
    expect(lateTrigger("2026-03-20", "2026-04-01", "IL")).toBe("quarter_ended");
  });

  it("LP-3: MD paid 2026-01-20, today 2026-02-01 -> month_ended", async () => {
    const { lateTrigger } = await load();
    expect(lateTrigger("2026-01-20", "2026-02-01", "MD")).toBe("month_ended");
  });

  it("LP-4: MD paid 2026-01-20, today 2026-01-31 (month's last day) -> null", async () => {
    const { lateTrigger } = await load();
    expect(lateTrigger("2026-01-20", "2026-01-31", "MD")).toBeNull();
  });

  it("LP-5: TX (not listed) and IL (quarterly), paid 2026-01-20, today 2026-02-10 -> null", async () => {
    const { lateTrigger } = await load();
    expect([
      lateTrigger("2026-01-20", "2026-02-10", "TX"),
      lateTrigger("2026-01-20", "2026-02-10", "IL"),
    ]).toEqual([null, null]);
  });

  it("LP-6: AL, MA, MO: Feb pay date after Feb -> month_ended; Mar 15 seen on Mar 31 -> null", async () => {
    const { lateTrigger } = await load();
    const got = ["AL", "MA", "MO"].map((s) => [
      lateTrigger("2026-02-15", "2026-03-01", s),
      lateTrigger("2026-03-15", "2026-03-31", s),
    ]);
    expect(got).toEqual([
      ["month_ended", null],
      ["month_ended", null],
      ["month_ended", null],
    ]);
  });

  it("LP-6b (auditor): AL, MA, MO have no March return: paid 2026-03-15, today 2026-04-01 is late by the quarter rule only", async () => {
    const { lateTrigger } = await load();
    expect(["AL", "MA", "MO"].map((s) => lateTrigger("2026-03-15", "2026-04-01", s))).toEqual([
      "quarter_ended",
      "quarter_ended",
      "quarter_ended",
    ]);
  });

  it("LP-7: KY, NC: Nov -> Dec 1 month_ended; Dec 15 -> 2027-01-01 quarter_ended", async () => {
    const { lateTrigger } = await load();
    const got = ["KY", "NC"].map((s) => [
      lateTrigger("2026-11-15", "2026-12-01", s),
      lateTrigger("2026-12-15", "2027-01-01", s),
    ]);
    expect(got).toEqual([
      ["month_ended", "quarter_ended"],
      ["month_ended", "quarter_ended"],
    ]);
  });

  it("LP-8: every table key, paid 2026-05-10, today 2026-06-01 -> month_ended", async () => {
    const { lateTrigger } = await load();
    const keys = Object.keys(EXPECTED_TABLE);
    const got = Object.fromEntries(
      keys.map((s) => [s, lateTrigger("2026-05-10", "2026-06-01", s)]),
    );
    expect(got).toEqual(Object.fromEntries(keys.map((s) => [s, "month_ended"])));
  });

  it("LP-9: null workState, paid 2026-01-20, today 2026-02-10 -> null", async () => {
    const { lateTrigger } = await load();
    expect(lateTrigger("2026-01-20", "2026-02-10", null)).toBeNull();
  });

  it("LP-10: MONTHLY_RETURN_STATES is exactly the 18 researched states with their months", async () => {
    const { MONTHLY_RETURN_STATES } = await load();
    expect(Object.keys(MONTHLY_RETURN_STATES).sort()).toEqual(Object.keys(EXPECTED_TABLE).sort());
    expect(Object.keys(MONTHLY_RETURN_STATES)).toHaveLength(18);
    expect(MONTHLY_RETURN_STATES).toEqual(EXPECTED_TABLE);
  });
});

describe("lateTrigger — auditor boundary cases", () => {
  it("quarter rule wins: MD paid 2026-03-20, today 2026-04-01 -> quarter_ended (not month_ended)", async () => {
    const { lateTrigger } = await load();
    expect(lateTrigger("2026-03-20", "2026-04-01", "MD")).toBe("quarter_ended");
  });

  it("year boundary: paid 2026-12-31, today 2027-01-01 -> quarter_ended for IL, TX and no state", async () => {
    const { lateTrigger } = await load();
    expect([
      lateTrigger("2026-12-31", "2027-01-01", "IL"),
      lateTrigger("2026-12-31", "2027-01-01", "TX"),
      lateTrigger("2026-12-31", "2027-01-01", null),
    ]).toEqual(["quarter_ended", "quarter_ended", "quarter_ended"]);
  });

  it("pay date today or later is never late (MD, quarter end day, future)", async () => {
    const { lateTrigger } = await load();
    expect([
      lateTrigger("2026-01-31", "2026-01-31", "MD"),
      lateTrigger("2026-03-31", "2026-03-31", "IL"),
      lateTrigger("2026-06-15", "2026-05-02", "MD"),
    ]).toEqual([null, null, null]);
  });

  it("Q2 pay date seen in Q2 is not late for a quarterly state: IL paid 2026-04-20, today 2026-05-02 -> null", async () => {
    const { lateTrigger } = await load();
    expect(lateTrigger("2026-04-20", "2026-05-02", "IL")).toBeNull();
  });

  it("KY December (no December monthly return): paid 2026-12-05, today 2026-12-31 -> null", async () => {
    const { lateTrigger } = await load();
    expect(lateTrigger("2026-12-05", "2026-12-31", "KY")).toBeNull();
  });

  it("each quarter's last day is in its quarter: paid 03-31/06-30/09-30, today the next day -> quarter_ended", async () => {
    const { lateTrigger } = await load();
    expect([
      lateTrigger("2026-03-31", "2026-04-01", null),
      lateTrigger("2026-06-30", "2026-07-01", null),
      lateTrigger("2026-09-30", "2026-10-01", null),
    ]).toEqual(["quarter_ended", "quarter_ended", "quarter_ended"]);
  });
});

describe("monthEnd", () => {
  it("last day of the pay-date month, leap years included", async () => {
    const { monthEnd } = await load();
    expect(
      ["2026-01-20", "2026-02-10", "2028-02-10", "2026-04-30", "2026-12-05", "2026-11-01"].map(
        monthEnd,
      ),
    ).toEqual(["2026-01-31", "2026-02-28", "2028-02-29", "2026-04-30", "2026-12-31", "2026-11-30"]);
  });
});

/**
 * PAY-91 fix round 1 (F): planner branches the scenario matrix does not
 * reach — defensive supersede of duplicate open rows, and a paid quarter row
 * next to open month rows under a quarterly schedule. Pure, cents, literals.
 */
import { describe, expect, it } from "vitest";
import {
  overpaidAnchor,
  planStateQuarter,
  type LiveDepositRow,
  type QuarterInput,
} from "../src/deposits/transition.js";

const Q = { frequency: "quarterly", dueDay: null } as const;
const M15 = { frequency: "monthly", dueDay: 15 } as const;

function r(
  id: number,
  kind: "month" | "quarter",
  periodStart: string,
  cents: number,
  dueDate: string,
  status: LiveDepositRow["status"],
): LiveDepositRow {
  return {
    id,
    kind,
    periodStart,
    cents,
    dueDate,
    status,
    depositedOn: status === "deposited" ? "2026-09-05" : null,
    seq: 0,
  };
}
const q3 = (over: Partial<QuarterInput>): QuarterInput => ({
  year: 2026,
  quarter: 3,
  schedule: Q,
  liability: [12345, 12345, 13000],
  live: [],
  today: "2026-10-01",
  ...over,
});

describe("planQuarterly — extra open quarter row", () => {
  it("keeps the earliest open quarter row, supersedes the extra one, updates the kept one", () => {
    const p = planStateQuarter(
      q3({
        live: [
          r(20, "quarter", "2026-07-01", 100, "2026-11-02", "pending"),
          r(10, "quarter", "2026-07-01", 37690, "2026-11-02", "pending"),
        ],
      }),
    );
    expect(p.supersede).toEqual([20]);
    expect(p.updates).toEqual([]); // row 10 already holds 37,690 · 11-02 · pending
    expect(p.inserts).toEqual([]);
  });
});

describe("planMonthly — duplicate open month row", () => {
  it("keeps the earliest open July row, supersedes the duplicate", () => {
    const p = planStateQuarter(
      q3({
        schedule: M15,
        liability: [12345, 0, 0],
        live: [
          r(31, "month", "2026-07-01", 12345, "2026-08-17", "overdue"),
          r(30, "month", "2026-07-01", 12345, "2026-08-17", "overdue"),
        ],
      }),
    );
    expect(p.supersede).toEqual([31]);
    expect(p.updates).toEqual([]);
    expect(p.inserts).toEqual([]);
  });
});

describe("planQuarterly — quarter already paid, open month rows present", () => {
  it("supersedes every open month row; inserts a seq 1 quarter row for ΣL − ΣD (PAY-193 D9.6)", () => {
    const p = planStateQuarter(
      q3({
        live: [
          r(1, "quarter", "2026-07-01", 24690, "2026-11-02", "deposited"),
          r(2, "month", "2026-08-01", 2655, "2026-09-15", "overdue"),
          r(3, "month", "2026-09-01", 13000, "2026-10-15", "pending"),
        ],
      }),
    );
    expect(p.supersede.sort((a, b) => a - b)).toEqual([2, 3]);
    expect(p.updates).toEqual([]);
    // 37,690 − 24,690 = 13,000, due 2026-11-02, today 2026-10-01 -> pending.
    expect(p.inserts).toEqual([
      {
        kind: "quarter",
        periodStart: "2026-07-01",
        seq: 1,
        cents: 13000,
        dueDate: "2026-11-02",
        status: "pending",
      },
    ]);
    expect(p.liabilityCents).toBe(37690);
    expect(p.overpaidCents).toBe(0);
    expect(p.overpaidAnchorId).toBeNull();
  });
});

describe("overpaidAnchor", () => {
  it("prefers the row covering the latest month, open before deposited", () => {
    const jul = r(1, "month", "2026-07-01", 12345, "2026-08-17", "deposited");
    const aug = r(2, "month", "2026-08-01", 12345, "2026-09-15", "deposited");
    const q = r(3, "quarter", "2026-07-01", 0, "2026-11-02", "pending");
    expect(overpaidAnchor([jul, aug, q])).toBe(3);
    const paidQ = r(4, "quarter", "2026-07-01", 24690, "2026-11-02", "deposited");
    const sep = r(5, "month", "2026-09-01", 0, "2026-10-15", "pending");
    expect(overpaidAnchor([paidQ, sep])).toBe(5);
    expect(overpaidAnchor([paidQ])).toBe(4);
    expect(overpaidAnchor([])).toBeNull();
  });
});

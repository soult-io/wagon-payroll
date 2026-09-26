/**
 * PAY-108 — surviving mutants in deposits/transition.ts (credits, overpaid,
 * input guards, anchor). Auditor-owned (payroll-calc-auditor).
 *
 * Every expected value was computed by hand in integer cents from spec 23
 * (plan/specs/state-deposit-period-transitions.md) §3 D6, §6 and §7, not by
 * running the planner. Where the spec is silent (which deposit row a month's
 * excess is attributed to), the file header comment of the function is the
 * rule under test and says so. Synthetic data only.
 *
 * Weekday checked: 2026-09-15 Tue (Aug due date, monthly dueDay 15).
 */
import { describe, expect, it } from "vitest";
import {
  overpaidAnchor,
  planStateQuarter,
  PlanInputError,
  type LiveDepositRow,
  type QuarterInput,
} from "../src/deposits/transition.js";

const MONTHLY = { frequency: "monthly", dueDay: 15 } as const;
const QUARTERLY = { frequency: "quarterly", dueDay: 31 } as const;

function row(
  id: number,
  kind: "month" | "quarter",
  periodStart: string,
  cents: number,
  status: LiveDepositRow["status"] = "deposited",
  dueDate = "2026-11-02",
): LiveDepositRow {
  return {
    id,
    kind,
    periodStart,
    cents,
    status,
    dueDate,
    depositedOn:
      status === "deposited" ? `2026-10-${String((id % 28) + 1).padStart(2, "0")}` : null,
  };
}

function input(over: Partial<QuarterInput>): QuarterInput {
  return {
    year: 2026,
    quarter: 3,
    schedule: MONTHLY,
    liability: [0, 0, 0],
    live: [],
    today: "2026-10-05",
    ...over,
  };
}

function thrown(fn: () => unknown): PlanInputError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PlanInputError);
    return e as PlanInputError;
  }
  throw new Error("expected PlanInputError, nothing thrown");
}

function cr(r: LiveDepositRow, appliedCents: number) {
  return {
    depositId: r.id,
    periodStart: r.periodStart,
    periodKind: r.kind,
    depositedOn: r.depositedOn,
    amountCents: r.cents,
    appliedCents,
  };
}

// ---------------------------------------------------------------------------
// Guards (§6: PlanInputError, code safe to log; data error, never clamped)
// ---------------------------------------------------------------------------

describe("quarter-range guard", () => {
  it.each([
    [0, "0"],
    [5, "5"],
    [1.5, "1.5"],
    [-1, "-1"],
  ])("quarter %s is rejected as invalid_quarter", (q, shown) => {
    const e = thrown(() => planStateQuarter(input({ quarter: q })));
    expect(e.name).toBe("PlanInputError");
    expect(e.code).toBe("invalid_quarter");
    expect(e.message).toBe(`planStateQuarter: quarter must be 1-4, got ${shown}`);
  });

  it.each([1, 4])("quarter %s (edge) is accepted", (q) => {
    const first = (q - 1) * 3 + 1;
    const start = `2026-${String(first).padStart(2, "0")}-01`;
    const p = planStateQuarter(input({ quarter: q, live: [row(1, "month", start, 100)] }));
    expect(p.depositedCents).toBe(100);
  });
});

describe("invalid_amount: exact code and message", () => {
  it("negative month liability names the month index", () => {
    const e = thrown(() => planStateQuarter(input({ liability: [0, -1, 0] })));
    expect(e.code).toBe("invalid_amount");
    expect(e.message).toBe(
      "planStateQuarter: liability[1] must be non-negative integer cents, got -1",
    );
  });

  it("fractional liability (not whole cents) is rejected", () => {
    const e = thrown(() => planStateQuarter(input({ liability: [0, 0, 12.5] })));
    expect(e.code).toBe("invalid_amount");
    expect(e.message).toBe(
      "planStateQuarter: liability[2] must be non-negative integer cents, got 12.5",
    );
  });

  it("unsafe integer liability is rejected", () => {
    const big = 2 ** 53;
    const e = thrown(() => planStateQuarter(input({ liability: [big, 0, 0] })));
    expect(e.code).toBe("invalid_amount");
    expect(e.message).toBe(
      `planStateQuarter: liability[0] must be non-negative integer cents, got ${big}`,
    );
  });

  it("negative row amount names the row id", () => {
    const e = thrown(() => planStateQuarter(input({ live: [row(7, "month", "2026-08-01", -5)] })));
    expect(e.code).toBe("invalid_amount");
    expect(e.message).toBe(
      "planStateQuarter: row 7 amount must be non-negative integer cents, got -5",
    );
  });

  it("zero is a valid amount (edge)", () => {
    const p = planStateQuarter(
      input({ liability: [0, 0, 0], live: [row(7, "month", "2026-08-01", 0)] }),
    );
    expect(p.depositedCents).toBe(0);
    expect(p.overpaidCents).toBe(0);
  });
});

describe("row_outside_unit", () => {
  it.each([
    [9, "2025-07-01"], // right month, wrong (earlier) year
    [10, "2027-08-01"], // right month, wrong (later) year
    [11, "2026-06-01"], // month before Q3
    [12, "2026-10-01"], // month after Q3
  ])("row %s (%s) is rejected with the exact message", (id, start) => {
    const e = thrown(() => planStateQuarter(input({ live: [row(id, "month", start, 100)] })));
    expect(e.code).toBe("row_outside_unit");
    expect(e.message).toBe(`planStateQuarter: row ${id} (${start}) is outside the unit`);
  });

  it("first and last month of the quarter are inside (edges)", () => {
    const p = planStateQuarter(
      input({ live: [row(1, "month", "2026-07-01", 100), row(2, "month", "2026-09-01", 200)] }),
    );
    expect(p.depositedCents).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Ordering (byPeriod) as seen through quarterCredits (earliest-first, capped at ΣL)
// ---------------------------------------------------------------------------

describe("byPeriod tie-break", () => {
  it("same start: the month row is counted before the quarter row (lower id notwithstanding)", () => {
    // Q3, L = 5,000 x3 = 15,000. Deposited: quarter #1 07-01 10,000; month #2 07-01 10,000.
    // quarterCredits: #2 min(15,000, 10,000) = 10,000 (cap 5,000); #1 min(5,000, 10,000) = 5,000.
    // D6: own = [10,000, 0, 0]; excess[0] = 5,000; need = [0, 5,000, 5,000].
    //   pool = [#1 10,000, #2 5,000]; Aug takes 5,000 of #1; Sep takes 5,000 of #1.
    //   overpaid = 0 + 5,000 = 5,000 (= ΣD 20,000 − ΣL 15,000).
    const q1 = row(1, "quarter", "2026-07-01", 10_000);
    const m2 = row(2, "month", "2026-07-01", 10_000);
    const p = planStateQuarter(input({ liability: [5_000, 5_000, 5_000], live: [q1, m2] }));
    expect(p.quarterCredits).toEqual([cr(m2, 10_000), cr(q1, 5_000)]);
    expect(p.monthCredits).toEqual([[], [cr(q1, 5_000)], [cr(q1, 5_000)]]);
    expect(p.liabilityCents).toBe(15_000);
    expect(p.depositedCents).toBe(20_000);
    expect(p.overpaidCents).toBe(5_000);
    expect(p.overpaidAnchorId).toBe(1); // the quarter row covers Sep
    expect(p).toMatchObject({ supersede: [], updates: [], inserts: [] });
  });

  it("same start and kind: lower id first; different starts: earlier first", () => {
    // L = [0, 4,000, 0]. Deposited Aug #5 3,000, Aug #3 3,000, Jul #8 0 (given out of order).
    // Sorted: #8 (Jul), #3, #5. Cap 4,000: #8 0, #3 3,000, #5 1,000.
    const m5 = row(5, "month", "2026-08-01", 3_000);
    const m3 = row(3, "month", "2026-08-01", 3_000);
    const m8 = row(8, "month", "2026-07-01", 0);
    const p = planStateQuarter(input({ liability: [0, 4_000, 0], live: [m5, m3, m8] }));
    expect(p.quarterCredits.map((c) => [c.depositId, c.appliedCents])).toEqual([
      [8, 0],
      [3, 3_000],
      [5, 1_000],
    ]);
    // D6: own[Aug] = 6,000 ≥ L 4,000 → excess 2,000, nothing needed elsewhere.
    expect(p.depositedCents).toBe(6_000);
    expect(p.overpaidCents).toBe(2_000);
  });
});

// ---------------------------------------------------------------------------
// excessSources: one month's excess attributed to its rows latest-first
// ---------------------------------------------------------------------------

describe("excessSources", () => {
  it("July excess 7,500 is split latest-first across three July rows, then fills August", () => {
    // L = [1,500, 6,000, 0]. Deposited July rows #10 3,000, #11 4,000, #12 2,000 (own 9,000).
    // excess[Jul] = 9,000 − 1,500 = 7,500, taken latest-first (#12, #11, #10):
    //   #12 2,000 → 5,500 left; #11 4,000 → 1,500 left; #10 1,500 → 0.
    // Pool (earliest-first again): #10 1,500, #11 4,000, #12 2,000.
    // need = [0, 6,000, 0]: Aug takes #10 1,500, #11 4,000, #12 500. overpaid = 1,500 (#12).
    // Check: ΣD 9,000 − ΣL 7,500 = 1,500.
    // Open Aug row #20 (6,000 pending) → rem 0: update to 0.00, due 2026-09-15 (Tue), pending.
    const m10 = row(10, "month", "2026-07-01", 3_000);
    const m11 = row(11, "month", "2026-07-01", 4_000);
    const m12 = row(12, "month", "2026-07-01", 2_000);
    const open20 = row(20, "month", "2026-08-01", 6_000, "pending", "2026-09-15");
    const p = planStateQuarter(
      input({ liability: [1_500, 6_000, 0], live: [m11, open20, m12, m10] }),
    );
    expect(p.monthCredits).toEqual([[], [cr(m10, 1_500), cr(m11, 4_000), cr(m12, 500)], []]);
    expect(p.overpaidCents).toBe(1_500);
    expect(p.depositedCents).toBe(9_000);
    expect(p.liabilityCents).toBe(7_500);
    expect(p.updates).toEqual([{ id: 20, cents: 0, dueDate: "2026-09-15", status: "pending" }]);
    expect(p.inserts).toEqual([]);
    expect(p.supersede).toEqual([]);
    // Anchor: #20 covers Aug, later than every July row.
    expect(p.overpaidAnchorId).toBe(20);
  });

  it("a month paid exactly (no excess) contributes nothing to the pool", () => {
    // L = [2,000, 1,000, 0]; Jul #1 2,000 (own = L, excess 0). Aug need 1,000, pool empty → rem 1,000.
    // Open Aug row #2 already 1,000 due 09-15 pending → no update (no field differs).
    const p = planStateQuarter(
      input({
        liability: [2_000, 1_000, 0],
        live: [
          row(1, "month", "2026-07-01", 2_000),
          row(2, "month", "2026-08-01", 1_000, "pending", "2026-09-15"),
        ],
        today: "2026-09-01",
      }),
    );
    expect(p.monthCredits).toEqual([[], [], []]);
    expect(p.overpaidCents).toBe(0);
    expect(p.overpaidAnchorId).toBeNull();
    expect(p.updates).toEqual([]);
    expect(p.depositedCents).toBe(2_000);
  });
});

// ---------------------------------------------------------------------------
// quarterCreditsFor: sort order and cap
// ---------------------------------------------------------------------------

describe("quarterCreditsFor", () => {
  it("earliest-first, capped at ΣL; the quarter payment is only partly counted", () => {
    // Quarterly CA-style unit, L = [2,000, 1,000, 1,000] = 4,000.
    // Deposited (given out of order): Aug #30 2,500; quarter #31 07-01 5,000; Jul #32 1,000.
    // Sorted: #32 (07-01 month), #31 (07-01 quarter), #30 (08-01).
    // Cap 4,000: #32 1,000 (3,000 left); #31 min(3,000, 5,000) = 3,000 (0 left); #30 0.
    // D6: own = [1,000, 2,500, 0]; excess = [0, 1,500, 0]; need = [1,000, 0, 1,000].
    //   pool = [#31 5,000, #30 1,500]: Jul 1,000 of #31, Sep 1,000 of #31.
    //   overpaid = 3,000 + 1,500 = 4,500 (= ΣD 8,500 − ΣL 4,000).
    const m30 = row(30, "month", "2026-08-01", 2_500);
    const q31 = row(31, "quarter", "2026-07-01", 5_000);
    const m32 = row(32, "month", "2026-07-01", 1_000);
    const p = planStateQuarter(
      input({ schedule: QUARTERLY, liability: [2_000, 1_000, 1_000], live: [m30, q31, m32] }),
    );
    expect(p.quarterCredits.map((c) => c.depositId)).toEqual([32, 31, 30]);
    expect(p.quarterCredits[0]).toEqual(cr(m32, 1_000));
    expect(p.quarterCredits[1]).toEqual(cr(q31, 3_000));
    // Σ applied never exceeds ΣL.
    expect(p.quarterCredits.reduce((a, c) => a + c.appliedCents, 0)).toBe(4_000);
    // #30 is past the cap: applied 0. Whether a 0-applied row belongs in the
    // credits list at all is a spec question (§7 "deposited rows counted
    // against this row"); only its applied figure is asserted here.
    expect(p.quarterCredits[2]?.appliedCents).toBe(0);
    expect(p.monthCredits).toEqual([[cr(q31, 1_000)], [], [cr(q31, 1_000)]]);
    expect(p.depositedCents).toBe(8_500);
    expect(p.overpaidCents).toBe(4_500);
    expect(p.overpaidAnchorId).toBe(31);
    // Quarter already paid (§6): no open rows, nothing to write.
    expect(p).toMatchObject({ supersede: [], updates: [], inserts: [] });
  });

  it("a single quarter payment above ΣL is capped at ΣL", () => {
    // L = [1,000, 1,000, 1,000] = 3,000; quarter #4 5,000 → applied 3,000; overpaid 2,000.
    const q4 = row(4, "quarter", "2026-07-01", 5_000);
    const p = planStateQuarter(
      input({ schedule: QUARTERLY, liability: [1_000, 1_000, 1_000], live: [q4] }),
    );
    expect(p.quarterCredits).toEqual([cr(q4, 3_000)]);
    expect(p.monthCredits).toEqual([[cr(q4, 1_000)], [cr(q4, 1_000)], [cr(q4, 1_000)]]);
    expect(p.overpaidCents).toBe(2_000);
    expect(p.depositedCents).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// overpaidAnchor (§7): latest month covered; tie → open, then quarter, then newest id
// ---------------------------------------------------------------------------

describe("overpaidAnchor ordering", () => {
  const both = (a: LiveDepositRow, b: LiveDepositRow) => [
    overpaidAnchor([a, b]),
    overpaidAnchor([b, a]),
  ];

  it("no rows → null", () => {
    expect(overpaidAnchor([])).toBeNull();
  });

  it("latest month covered beats a newer id", () => {
    expect(both(row(1, "month", "2026-09-01", 0), row(9, "month", "2026-08-01", 0))).toEqual([
      1, 1,
    ]);
  });

  it("a quarter row covers its third month (Sep), beating an Aug row", () => {
    expect(both(row(1, "quarter", "2026-07-01", 0), row(9, "month", "2026-08-01", 0))).toEqual([
      1, 1,
    ]);
  });

  it("tie on month: an open row beats a deposited one", () => {
    const open = row(1, "month", "2026-09-01", 0, "pending");
    const dep = row(9, "month", "2026-09-01", 0);
    expect(both(open, dep)).toEqual([1, 1]);
    const overdue = row(2, "month", "2026-09-01", 50, "overdue");
    expect(both(overdue, dep)).toEqual([2, 2]);
  });

  it("tie on month: open beats a quarter row that is deposited", () => {
    const open = row(1, "month", "2026-09-01", 0, "pending");
    const q = row(9, "quarter", "2026-07-01", 0);
    expect(both(open, q)).toEqual([1, 1]);
  });

  it("tie on month and status: the quarter row beats the month row", () => {
    expect(both(row(1, "quarter", "2026-07-01", 0), row(9, "month", "2026-09-01", 0))).toEqual([
      1, 1,
    ]);
    const oq = row(2, "quarter", "2026-07-01", 0, "pending");
    const om = row(8, "month", "2026-09-01", 0, "pending");
    expect(both(oq, om)).toEqual([2, 2]);
  });

  it("full tie: the newest id wins, compared as numbers (12 > 3)", () => {
    expect(both(row(3, "month", "2026-09-01", 0), row(12, "month", "2026-09-01", 0))).toEqual([
      12, 12,
    ]);
  });

  it("in a plan: the open 0.00 quarter row carries Overpaid, not the deposited month rows", () => {
    // Quarterly, L = [1,000, 1,000, 1,000] = 3,000. Deposited Jul #1 2,000, Aug #2 2,000.
    // Open quarter #3 (3,000, due 2026-11-02, pending) → max(0, 3,000 − 4,000) = 0.
    // D6: own = [2,000, 2,000, 0]; excess = [1,000, 1,000, 0]; need = [0, 0, 1,000].
    //   pool = [#1 1,000, #2 1,000]: Sep takes #1 1,000. overpaid = 1,000.
    // Anchor: #3 covers Sep (latest) → #3.
    const q3 = row(3, "quarter", "2026-07-01", 3_000, "pending", "2026-11-02");
    const m1 = row(1, "month", "2026-07-01", 2_000);
    const m2 = row(2, "month", "2026-08-01", 2_000);
    const p = planStateQuarter(
      input({
        schedule: QUARTERLY,
        liability: [1_000, 1_000, 1_000],
        live: [m1, m2, q3],
        today: "2026-10-05",
      }),
    );
    expect(p.monthCredits).toEqual([[], [], [cr(m1, 1_000)]]);
    expect(p.overpaidCents).toBe(1_000);
    expect(p.depositedCents).toBe(4_000);
    expect(p.overpaidAnchorId).toBe(3);
    expect(p.updates).toEqual([{ id: 3, cents: 0, dueDate: "2026-11-02", status: "pending" }]);
  });
});

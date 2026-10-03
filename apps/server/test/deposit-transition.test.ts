/**
 * PAY-91 — pure planner unit matrix (spec 23 §8: T01–T09, T12–T15, T19, T21,
 * T23, T24 as literals, `today` injected). Expected values are the spec's
 * hand-computed figures; the integration versions live in
 * state-deposit-transitions.test.ts (auditor-owned).
 */
import { describe, expect, it } from "vitest";
import {
  allocate,
  periodKindFor,
  planStateQuarter,
  type LiveDepositRow,
  type QuarterInput,
} from "../src/deposits/transition.js";
import type { StateSchedule } from "../src/deposits/periods.js";

const CA_Q: StateSchedule = { frequency: "quarterly", dueDay: null };
const MON15: StateSchedule = { frequency: "monthly", dueDay: 15 };
const JUL = 12345;
const AUG = 12345;
const SEP = 13000;

let nextId = 1;
function row(
  kind: "month" | "quarter",
  periodStart: string,
  cents: number,
  dueDate: string,
  status: LiveDepositRow["status"],
  depositedOn: string | null = null,
): LiveDepositRow {
  nextId += 1;
  return { id: nextId, kind, periodStart, cents, dueDate, status, depositedOn };
}

function q3(over: Partial<QuarterInput>): QuarterInput {
  return {
    year: 2026,
    quarter: 3,
    schedule: CA_Q,
    liability: [0, 0, 0],
    live: [],
    today: "2026-09-10",
    ...over,
  };
}

describe("planStateQuarter — Case A (merge)", () => {
  it("T01: overdue Jul + pending Aug -> supersede both, insert Q3 24,690 due 11-02 pending", () => {
    const jul = row("month", "2026-07-01", JUL, "2026-08-17", "overdue");
    const aug = row("month", "2026-08-01", AUG, "2026-09-15", "pending");
    const p = planStateQuarter(q3({ liability: [JUL, AUG, 0], live: [jul, aug] }));
    expect(p.supersede.sort()).toEqual([jul.id, aug.id].sort());
    expect(p.updates).toEqual([]);
    expect(p.inserts).toEqual([
      {
        kind: "quarter",
        periodStart: "2026-07-01",
        seq: 0,
        cents: 24690,
        dueDate: "2026-11-02",
        status: "pending",
      },
    ]);
    expect(p.overpaidCents).toBe(0);
  });

  it("T02: Q3 row exists, Sep run lands -> update to 37,690, no Sep row", () => {
    const q = row("quarter", "2026-07-01", 24690, "2026-11-02", "pending");
    const p = planStateQuarter(q3({ liability: [JUL, AUG, SEP], live: [q], today: "2026-10-05" }));
    expect(p.supersede).toEqual([]);
    expect(p.inserts).toEqual([]);
    expect(p.updates).toEqual([
      { id: q.id, cents: 37690, dueDate: "2026-11-02", status: "pending" },
    ]);
  });

  it("T12/T15: empty unit with liability -> one quarter row on the schedule's date", () => {
    const md = planStateQuarter({
      year: 2026,
      quarter: 4,
      schedule: { frequency: "quarterly", dueDay: 15 },
      liability: [10000, 10000, 10000],
      live: [],
      today: "2026-12-20",
    });
    expect(md.inserts.map((i) => [i.periodStart, i.cents, i.dueDate, i.status])).toEqual([
      ["2026-10-01", 30000, "2027-01-15", "pending"],
    ]);
    const q2 = planStateQuarter({
      year: 2026,
      quarter: 2,
      schedule: CA_Q,
      liability: [0, 0, 5000],
      live: [],
      today: "2026-07-10",
    });
    expect(q2.inserts.map((i) => [i.periodStart, i.cents, i.dueDate])).toEqual([
      ["2026-04-01", 5000, "2026-07-31"],
    ]);
  });

  it("T12 on 2027-01-16: MD quarter row goes overdue", () => {
    const q = row("quarter", "2026-10-01", 30000, "2027-01-15", "pending");
    const p = planStateQuarter({
      year: 2026,
      quarter: 4,
      schedule: { frequency: "quarterly", dueDay: 15 },
      liability: [10000, 10000, 10000],
      live: [q],
      today: "2027-01-16",
    });
    expect(p.updates).toEqual([
      { id: q.id, cents: 30000, dueDate: "2027-01-15", status: "overdue" },
    ]);
  });

  it("T14: fallback Jan 2027 month row -> superseded by Q1 2027 due 04-30", () => {
    const jan = row("month", "2027-01-01", 10000, "2027-02-15", "pending");
    const p = planStateQuarter({
      year: 2027,
      quarter: 1,
      schedule: CA_Q,
      liability: [10000, 0, 0],
      live: [jan],
      today: "2027-02-01",
    });
    expect(p.supersede).toEqual([jan.id]);
    expect(p.inserts.map((i) => [i.kind, i.periodStart, i.cents, i.dueDate])).toEqual([
      ["quarter", "2027-01-01", 10000, "2027-04-30"],
    ]);
  });

  it("no runs, no rows -> empty plan", () => {
    const p = planStateQuarter(q3({}));
    expect([p.supersede, p.updates, p.inserts]).toEqual([[], [], []]);
  });
});

describe("planStateQuarter — Case B (some months deposited)", () => {
  it("T03: Jul deposited -> Q3 25,345; quarter credit Jul applied 12,345", () => {
    const jul = row("month", "2026-07-01", JUL, "2026-08-17", "deposited", "2026-08-14");
    const aug = row("month", "2026-08-01", AUG, "2026-09-15", "overdue");
    const sep = row("month", "2026-09-01", SEP, "2026-10-15", "pending");
    const p = planStateQuarter(
      q3({ liability: [JUL, AUG, SEP], live: [jul, aug, sep], today: "2026-10-01" }),
    );
    expect(p.supersede.sort()).toEqual([aug.id, sep.id].sort());
    expect(p.inserts.map((i) => [i.kind, i.cents, i.dueDate, i.status])).toEqual([
      ["quarter", 25345, "2026-11-02", "pending"],
    ]);
    expect(p.quarterCredits.map((c) => [c.depositId, c.amountCents, c.appliedCents])).toEqual([
      [jul.id, JUL, JUL],
    ]);
    expect(p.overpaidCents).toBe(0);
  });

  it("T04: Jul+Aug deposited, liability 14,345 -> Q3 0 pending, overpaid 10,345", () => {
    const jul = row("month", "2026-07-01", JUL, "2026-08-17", "deposited", "2026-08-14");
    const aug = row("month", "2026-08-01", AUG, "2026-09-15", "deposited", "2026-09-14");
    const p = planStateQuarter(
      q3({ liability: [JUL, 2000, 0], live: [jul, aug], today: "2026-09-20" }),
    );
    expect(p.inserts.map((i) => [i.cents, i.status])).toEqual([[0, "pending"]]);
    expect(p.overpaidCents).toBe(10345);
    expect(p.liabilityCents).toBe(14345);
  });

  it("T05: then Sep 13,000 -> Q3 2,655, overpaid 0", () => {
    const jul = row("month", "2026-07-01", JUL, "2026-08-17", "deposited", "2026-08-14");
    const aug = row("month", "2026-08-01", AUG, "2026-09-15", "deposited", "2026-09-14");
    const q = row("quarter", "2026-07-01", 0, "2026-11-02", "pending");
    const p = planStateQuarter(
      q3({ liability: [JUL, 2000, SEP], live: [jul, aug, q], today: "2026-10-01" }),
    );
    expect(p.updates).toEqual([
      { id: q.id, cents: 2655, dueDate: "2026-11-02", status: "pending" },
    ]);
    expect(p.overpaidCents).toBe(0);
  });

  it("T06: Jul+Aug deposited exactly -> Q3 0, overpaid 0", () => {
    const jul = row("month", "2026-07-01", JUL, "2026-08-17", "deposited", "2026-08-14");
    const aug = row("month", "2026-08-01", AUG, "2026-09-15", "deposited", "2026-09-14");
    const p = planStateQuarter(q3({ liability: [JUL, AUG, 0], live: [jul, aug] }));
    expect(p.inserts.map((i) => i.cents)).toEqual([0]);
    expect(p.overpaidCents).toBe(0);
  });

  it("T19 sync 1: v1.25 quarter-sized Jul row (24,000 deposited) -> Q3 0", () => {
    const jul = row("month", "2026-07-01", 24000, "2026-11-02", "deposited", "2026-10-20");
    const p = planStateQuarter(
      q3({ liability: [8000, 8000, 8000], live: [jul], today: "2026-10-25" }),
    );
    expect(p.inserts.map((i) => [i.kind, i.cents, i.dueDate])).toEqual([
      ["quarter", 0, "2026-11-02"],
    ]);
    expect(p.overpaidCents).toBe(0);
  });

  it("T23: every run voided -> Q3 0, pending although the due date passed", () => {
    const q = row("quarter", "2026-07-01", 37690, "2026-11-02", "pending");
    const p = planStateQuarter(q3({ live: [q], today: "2026-11-03" }));
    expect(p.updates).toEqual([{ id: q.id, cents: 0, dueDate: "2026-11-02", status: "pending" }]);
  });

  it("quarter already deposited: no new quarter row; overpaid when a run is voided (T34)", () => {
    const q = row("quarter", "2026-07-01", 24690, "2026-11-02", "deposited", "2026-09-05");
    const p = planStateQuarter(q3({ liability: [JUL, 0, 0], live: [q], today: "2026-09-20" }));
    expect([p.supersede, p.updates, p.inserts]).toEqual([[], [], []]);
    expect(p.overpaidCents).toBe(12345);
  });
});

describe("planStateQuarter — Case C (quarter row, schedule monthly)", () => {
  it("T07: pending Q3 -> superseded; month rows on their own dates", () => {
    const q = row("quarter", "2026-07-01", 37690, "2026-11-02", "pending");
    const p = planStateQuarter(
      q3({ schedule: MON15, liability: [JUL, AUG, SEP], live: [q], today: "2026-10-05" }),
    );
    expect(p.supersede).toEqual([q.id]);
    expect(p.inserts.map((i) => [i.kind, i.periodStart, i.cents, i.dueDate, i.status])).toEqual([
      ["month", "2026-07-01", JUL, "2026-08-17", "overdue"],
      ["month", "2026-08-01", AUG, "2026-09-15", "overdue"],
      ["month", "2026-09-01", SEP, "2026-10-15", "pending"],
    ]);
  });

  it("T08: deposited Q3 24,690 applied earliest-first -> Aug 2,655, Sep 13,000", () => {
    const q = row("quarter", "2026-07-01", 24690, "2026-11-02", "deposited", "2026-09-05");
    const p = planStateQuarter(
      q3({ schedule: MON15, liability: [JUL, 15000, SEP], live: [q], today: "2026-10-05" }),
    );
    expect(p.supersede).toEqual([]);
    expect(p.inserts.map((i) => [i.periodStart, i.cents, i.dueDate, i.status])).toEqual([
      ["2026-08-01", 2655, "2026-09-15", "overdue"],
      ["2026-09-01", SEP, "2026-10-15", "pending"],
    ]);
    expect(p.monthCredits[1].map((c) => [c.depositId, c.appliedCents])).toEqual([[q.id, 12345]]);
    expect(p.monthCredits[0].map((c) => [c.depositId, c.appliedCents])).toEqual([[q.id, 12345]]);
  });

  it("T09: deposited Q3, Aug voided -> no month rows; overpaid 12,345", () => {
    const q = row("quarter", "2026-07-01", 24690, "2026-11-02", "deposited", "2026-09-05");
    const p = planStateQuarter(
      q3({ schedule: MON15, liability: [JUL, 0, 0], live: [q], today: "2026-10-05" }),
    );
    expect([p.supersede, p.updates, p.inserts]).toEqual([[], [], []]);
    expect(p.overpaidCents).toBe(12345);
  });

  it("T19 sync 2: Jul excess 16,000 covers Aug and Sep (D6 step 1)", () => {
    const jul = row("month", "2026-07-01", 24000, "2026-11-02", "deposited", "2026-10-20");
    const q = row("quarter", "2026-07-01", 0, "2026-11-02", "pending");
    const p = planStateQuarter(
      q3({
        schedule: { frequency: "monthly", dueDay: null },
        liability: [8000, 8000, 8000],
        live: [jul, q],
        today: "2026-10-25",
      }),
    );
    expect(p.supersede).toEqual([q.id]);
    expect(p.inserts).toEqual([]);
    expect(p.overpaidCents).toBe(0);
  });

  it("T21: no schedule (fallback) -> quarter superseded, month rows on the federal convention", () => {
    const q = row("quarter", "2026-07-01", 24000, "2026-11-02", "pending");
    const p = planStateQuarter(
      q3({ schedule: null, liability: [8000, 8000, 8000], live: [q], today: "2026-10-01" }),
    );
    expect(p.supersede).toEqual([q.id]);
    expect(p.inserts.map((i) => [i.periodStart, i.dueDate, i.status])).toEqual([
      ["2026-07-01", "2026-08-17", "overdue"],
      ["2026-08-01", "2026-09-15", "overdue"],
      ["2026-09-01", "2026-10-15", "pending"],
    ]);
  });

  it("T24: monthly dueDay change moves the open row's due date only", () => {
    const jul = row("month", "2026-07-01", 5000, "2026-08-17", "deposited", "2026-08-10");
    const aug = row("month", "2026-08-01", 5000, "2026-09-15", "pending");
    const p = planStateQuarter(
      q3({
        schedule: { frequency: "monthly", dueDay: 20 },
        liability: [5000, 5000, 0],
        live: [jul, aug],
        today: "2026-09-10",
      }),
    );
    expect(p.updates).toEqual([
      { id: aug.id, cents: 5000, dueDate: "2026-09-21", status: "pending" },
    ]);
    expect(p.inserts).toEqual([]);
  });

  it("monthly units are unchanged when nothing moved (idempotent)", () => {
    const jul = row("month", "2026-07-01", 5000, "2026-08-17", "overdue");
    const p = planStateQuarter(
      q3({ schedule: MON15, liability: [5000, 0, 0], live: [jul], today: "2026-09-10" }),
    );
    expect([p.supersede, p.updates, p.inserts]).toEqual([[], [], []]);
  });
});

describe("allocate (D6)", () => {
  it("pays own month first, then pools quarter + excess earliest-first", () => {
    const jul = row("month", "2026-07-01", 20000, "x", "deposited");
    const q = row("quarter", "2026-07-01", 5000, "x", "deposited");
    const a = allocate([10000, 10000, 10000], [jul, q], 7);
    // own Jul 20,000 pays Jul 10,000; pool = 5,000 (Q) + 10,000 (Jul excess)
    expect(a.rem).toEqual([0, 0, 5000]);
    expect(a.overpaidCents).toBe(0);
  });
  it("overpaid = ΣD − ΣL when deposits exceed liability", () => {
    const q = row("quarter", "2026-07-01", 30000, "x", "deposited");
    expect(allocate([1000, 2000, 3000], [q], 7).overpaidCents).toBe(24000);
  });
  it("rejects negative or fractional cents", () => {
    expect(() => planStateQuarter(q3({ liability: [-1, 0, 0] }))).toThrow();
    expect(() => planStateQuarter(q3({ liability: [0.5, 0, 0] }))).toThrow();
  });
});

describe("periodKindFor (moved from periodKindForDeposit)", () => {
  it("returns 'month' for federal, 'quarter' only for quarterly schedules", () => {
    expect(periodKindFor("federal", CA_Q)).toBe("month");
    expect(periodKindFor("CA", CA_Q)).toBe("quarter");
    expect(periodKindFor("IL", MON15)).toBe("month");
    expect(periodKindFor("TX", null)).toBe("month");
  });
});

/**
 * PAY-226 — federal 941 deposits net within the quarter: the pure planner.
 *
 * Auditor-owned (payroll-calc-auditor). Fail-first: written before the code.
 *
 * Rule (federal SME ruling 2026-10-05; IRC 6656(e)(1); Pub 15 (2026) §11
 * "Order in which deposits are applied"; Form 941 (2026) instructions lines
 * 13–15). For each month m of ONE quarter that has an issued run or a live row:
 *   L[m] = the month's 941 line-16 liability, D[m] = Σ live `deposited` rows of m,
 *   unpaid[m] = max(0, L[m] − D[m]);  pool = Σ max(0, D[m] − L[m]);
 *   for m most recent first: take = min(pool, unpaid[m]); unpaid[m] −= take; pool −= take;
 *   target[m] = unpaid[m]; status = target 0 → "none", due(m) < today → "overdue", else "pending";
 *   quarterExcess = the pool left over (information only, never carried forward).
 *
 * Assumed API contract (the implementer creates it):
 *   module  apps/server/src/deposits/federal-quarter.ts
 *   export  planFederalQuarter(input: {
 *             months: { periodStart: string; liabilityCents: number; depositedCents: number }[];
 *             today: string;
 *           }): {
 *             months: { periodStart: string; targetCents: number;
 *                       status: "none" | "pending" | "overdue"; dueDate: string }[];
 *             quarterExcessCents: number;
 *           }
 *   Pure: no DB, no clock, integer cents. Invalid input (negative / non-integer
 *   cents, months of more than one quarter, a month twice) throws.
 *
 * Oracle: computed by hand and with an independent Python script (integer
 * cents), never from the app. All figures are SYNTHETIC: E1–E6 keep the shape
 * of the brief's worked examples (E1 = the production case) with made-up
 * amounts, because the repo is public (GUARDRAILS: no real figures in fixtures).
 *   Synthetic quarter: L = 71234 / 71234 / 92345 (ΣL 234813 = 3 × 78271).
 * Due dates used for status (15th of the next month, weekend roll — the app's
 * V1 convention): Feb 2026 → 2026-03-16 (Mar 15 is a Sunday), Mar 2026 →
 * 2026-04-15, Dec 2026 → 2027-01-15. No test depends on the Jan 2026 due date
 * (Feb 16 2026 is Washington's Birthday; see the report).
 */

import { describe, expect, it } from "vitest";

interface MonthIn {
  periodStart: string;
  liabilityCents: number;
  depositedCents: number;
}
interface MonthOut {
  periodStart: string;
  targetCents: number;
  status: "none" | "pending" | "overdue";
  dueDate: string;
}
interface Plan {
  months: MonthOut[];
  quarterExcessCents: number;
}
type Planner = (input: { months: MonthIn[]; today: string }) => Plan;

/** Loaded per test so a missing module fails each test, not the file. */
async function planner(): Promise<Planner> {
  const path = "../src/deposits/federal-quarter.js";
  const mod = (await import(/* @vite-ignore */ path)) as { planFederalQuarter?: Planner };
  if (typeof mod.planFederalQuarter !== "function") {
    throw new Error("planFederalQuarter is not exported from src/deposits/federal-quarter.ts");
  }
  return mod.planFederalQuarter;
}

const JAN = "2026-01-01";
const FEB = "2026-02-01";
const MAR = "2026-03-01";
const LJ = 71234;
const LF = 71234;
const LM = 92345;

function m(periodStart: string, liabilityCents: number, depositedCents: number): MonthIn {
  return { periodStart, liabilityCents, depositedCents };
}

/** "periodStart targetCents status" per month, ascending. */
function summary(p: Plan): string[] {
  return [...p.months]
    .sort((a, b) => (a.periodStart < b.periodStart ? -1 : 1))
    .map((x) => `${x.periodStart} ${x.targetCents} ${x.status}`);
}

describe("PAY-226 oracle self-check", () => {
  it("the synthetic E1 quarter nets to zero: ΣL = ΣD = 234813", () => {
    expect(LJ + LF + LM).toBe(234813);
    expect(3 * 78271).toBe(234813);
    // Per-month split: Jan/Feb over by 7037 each, March short by 14074.
    expect([78271 - LJ, 78271 - LF, LM - 78271]).toEqual([7037, 7037, 14074]);
  });
});

describe("PAY-226 planFederalQuarter — worked examples", () => {
  it("P-E1 (production shape): L 71234/71234/92345, D 78271 ×3, today 2026-10-05 → all 0, no excess", async () => {
    const p = (await planner())({
      months: [m(JAN, LJ, 78271), m(FEB, LF, 78271), m(MAR, LM, 78271)],
      today: "2026-10-05",
    });
    // pool = 7037 + 7037 = 14074; March unpaid 14074 − 14074 = 0.
    expect(summary(p)).toEqual([`${JAN} 0 none`, `${FEB} 0 none`, `${MAR} 0 none`]);
    expect(p.quarterExcessCents).toBe(0);
  });

  it("P-E2: D 80000/71234/78271, today 2026-04-10 → March pending 5308", async () => {
    const p = (await planner())({
      months: [m(JAN, LJ, 80000), m(FEB, LF, 71234), m(MAR, LM, 78271)],
      today: "2026-04-10",
    });
    // pool = 80000 − 71234 = 8766; March unpaid 92345 − 78271 = 14074 → 14074 − 8766 = 5308.
    expect(summary(p)).toEqual([`${JAN} 0 none`, `${FEB} 0 none`, `${MAR} 5308 pending`]);
    expect(p.months.find((x) => x.periodStart === MAR)!.dueDate).toBe("2026-04-15");
    expect(p.quarterExcessCents).toBe(0);
  });

  it("P-E2 boundary: on the due date 2026-04-15 still pending; 2026-04-16 overdue", async () => {
    const plan = await planner();
    const months = [m(JAN, LJ, 80000), m(FEB, LF, 71234), m(MAR, LM, 78271)];
    expect(summary(plan({ months, today: "2026-04-15" }))[2]).toBe(`${MAR} 5308 pending`);
    expect(summary(plan({ months, today: "2026-04-16" }))[2]).toBe(`${MAR} 5308 overdue`);
  });

  it("P-E3: D 0/71234/163579 (March over by January's liability), today 2026-05-01 → all 0", async () => {
    const p = (await planner())({
      months: [m(JAN, LJ, 0), m(FEB, LF, 71234), m(MAR, LM, LM + LJ)],
      today: "2026-05-01",
    });
    // pool = 71234 (March); taken Mar 0, Feb 0, Jan 71234 → 0.
    expect(summary(p)).toEqual([`${JAN} 0 none`, `${FEB} 0 none`, `${MAR} 0 none`]);
    expect(p.quarterExcessCents).toBe(0);
  });

  it("P-E4: L 71234 ×3, D 71234/0/71234, today 2026-04-20 → February overdue 71234", async () => {
    const p = (await planner())({
      months: [m(JAN, 71234, 71234), m(FEB, 71234, 0), m(MAR, 71234, 71234)],
      today: "2026-04-20",
    });
    expect(summary(p)).toEqual([`${JAN} 0 none`, `${FEB} 71234 overdue`, `${MAR} 0 none`]);
    expect(p.months.find((x) => x.periodStart === FEB)!.dueDate).toBe("2026-03-16");
    expect(p.quarterExcessCents).toBe(0);
  });

  it("P-E5: L 71234 ×3, D 71234/71234/72671, today 2026-04-20 → all 0, quarterExcess 1437", async () => {
    const p = (await planner())({
      months: [m(JAN, 71234, 71234), m(FEB, 71234, 71234), m(MAR, 71234, 72671)],
      today: "2026-04-20",
    });
    expect(summary(p)).toEqual([`${JAN} 0 none`, `${FEB} 0 none`, `${MAR} 0 none`]);
    expect(p.quarterExcessCents).toBe(1437);
  });

  it("P-E6: only Jan/Feb so far, D 71234/0, today 2026-03-20 → February overdue 71234 (no March in the plan)", async () => {
    const p = (await planner())({
      months: [m(JAN, 71234, 71234), m(FEB, 71234, 0)],
      today: "2026-03-20",
    });
    expect(summary(p)).toEqual([`${JAN} 0 none`, `${FEB} 71234 overdue`]);
    expect(p.months.map((x) => x.periodStart)).not.toContain(MAR);
    expect(p.quarterExcessCents).toBe(0);
  });
});

describe("PAY-226 planFederalQuarter — order and edges", () => {
  it("P-ORD: the pool is applied most recent month first — L 10000 ×3, D 0/0/25000 → Jan 5000, Feb 0", async () => {
    const p = (await planner())({
      months: [m(JAN, 10000, 0), m(FEB, 10000, 0), m(MAR, 10000, 25000)],
      today: "2026-04-20",
    });
    // pool 15000: Mar 0; Feb 10000 → 0 (pool 5000); Jan 10000 − 5000 = 5000.
    // (Earliest-first would leave Feb 5000 instead — that reading is wrong here.)
    expect(summary(p)).toEqual([`${JAN} 5000 overdue`, `${FEB} 0 none`, `${MAR} 0 none`]);
    expect(p.quarterExcessCents).toBe(0);
  });

  it("P-ORD2: input order does not matter (months given descending)", async () => {
    const p = (await planner())({
      months: [m(MAR, 10000, 25000), m(FEB, 10000, 0), m(JAN, 10000, 0)],
      today: "2026-04-20",
    });
    expect(summary(p)).toEqual([`${JAN} 5000 overdue`, `${FEB} 0 none`, `${MAR} 0 none`]);
  });

  it("P-EMPTY: an empty quarter plans nothing", async () => {
    const p = (await planner())({ months: [], today: "2026-04-20" });
    expect(p.months).toEqual([]);
    expect(p.quarterExcessCents).toBe(0);
  });

  it("P-L0: a month with a deposit but no liability (runs voided) feeds the pool; its target is 0", async () => {
    const p = (await planner())({
      months: [m(JAN, 71234, 71234), m(FEB, 0, 5000), m(MAR, 71234, 0)],
      today: "2026-04-20",
    });
    // pool 5000 → March 71234 − 5000 = 66234 overdue (due 2026-04-15).
    expect(summary(p)).toEqual([`${JAN} 0 none`, `${FEB} 0 none`, `${MAR} 66234 overdue`]);
  });

  it("P-ZERO: a month with liability 0 and nothing deposited is 'none' even when past due", async () => {
    const p = (await planner())({
      months: [m(JAN, 0, 0), m(FEB, 71234, 71234)],
      today: "2026-10-05",
    });
    expect(summary(p)).toEqual([`${JAN} 0 none`, `${FEB} 0 none`]);
  });

  it("P-DEC: December liability is due 2027-01-15 — pending on that day, overdue the day after", async () => {
    const plan = await planner();
    const months = [
      m("2026-10-01", 10000, 10000),
      m("2026-11-01", 10000, 10000),
      m("2026-12-01", 10000, 0),
    ];
    const onDue = plan({ months, today: "2027-01-15" });
    expect(summary(onDue)).toEqual([
      "2026-10-01 0 none",
      "2026-11-01 0 none",
      "2026-12-01 10000 pending",
    ]);
    expect(onDue.months.find((x) => x.periodStart === "2026-12-01")!.dueDate).toBe("2027-01-15");
    expect(summary(plan({ months, today: "2027-01-16" }))[2]).toBe("2026-12-01 10000 overdue");
  });

  it("P-FULL: exactly paid months are 'none' with no excess (no cent drift)", async () => {
    const p = (await planner())({
      months: [m(JAN, LJ, LJ), m(FEB, LF, LF), m(MAR, LM, LM)],
      today: "2026-10-05",
    });
    expect(summary(p)).toEqual([`${JAN} 0 none`, `${FEB} 0 none`, `${MAR} 0 none`]);
    expect(p.quarterExcessCents).toBe(0);
  });

  it("P-YEAR: months of two quarters (Dec 2026 + Jan 2027) are rejected — the pool never crosses a quarter or year", async () => {
    const plan = await planner();
    expect(() =>
      plan({
        months: [m("2026-12-01", 10000, 15000), m("2027-01-01", 10000, 0)],
        today: "2027-03-01",
      }),
    ).toThrow();
  });

  it("P-BAD: negative or fractional cents and a duplicated month are rejected, never clamped", async () => {
    const plan = await planner();
    expect(() => plan({ months: [m(JAN, -1, 0)], today: "2026-04-20" })).toThrow();
    expect(() => plan({ months: [m(JAN, 100, -5)], today: "2026-04-20" })).toThrow();
    expect(() => plan({ months: [m(JAN, 100.5, 0)], today: "2026-04-20" })).toThrow();
    expect(() => plan({ months: [m(JAN, 100, 0), m(JAN, 100, 0)], today: "2026-04-20" })).toThrow();
  });

  it("P-PURE: the planner does not mutate its input", async () => {
    const months = [m(JAN, LJ, 78271), m(FEB, LF, 78271), m(MAR, LM, 78271)];
    const copy = JSON.parse(JSON.stringify(months)) as MonthIn[];
    (await planner())({ months, today: "2026-10-05" });
    expect(months).toEqual(copy);
  });
});

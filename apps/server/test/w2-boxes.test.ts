/**
 * PAY-162 auditor-owned scenario tests (payroll-calc-auditor) — the pure
 * W-2 box module `src/filings/w2-boxes.ts` (integer cents, box 4 / box 6
 * reasonableness checks, W-3 totals). Written before the module exists:
 * every test here fails on origin/main 1fbd87e40a701e026709726a8a2716df924310d1
 * (module not found). Only the auditor edits the expected values.
 *
 * Oracle: every expected value below was recomputed by hand from the
 * published rules, never from the engine or the code under test:
 * - Pub 15 (2026) What's New: Social Security 6.2%, wage base $184,500;
 *   Medicare 1.45%, no wage base. Pub 15 (2026) section 9: Additional
 *   Medicare Tax 0.9% withheld on wages paid in excess of $200,000 in the
 *   calendar year.
 * - General Instructions for Forms W-2 and W-3 (2026), box 3-6: box 4
 *   "should not exceed $11,439 ($184,500 x 6.2%)"; box 5 has no limit;
 *   box 6 is total Medicare withheld "including any Additional Medicare Tax".
 * - Form 8959 Part V lines 19-22: box 6 is reconciled as (box 5 x 1.45%)
 *   plus Additional Medicare withheld, the two terms computed separately.
 *   Auditor ruling for PAY-162 D7: the box 6 expectation rounds EACH term
 *   half-up to the cent (applyRate(box5, medicare) + applyRate(excess,
 *   additional)), not once over the sum. The "box 6 rounding form" test
 *   below pins that reading.
 * - Rounding is half-up (packages/shared ROUNDING_MODE).
 *
 * Money literals are integer cents. Synthetic data only.
 */

import { describe, expect, it } from "vitest";
import { formatCents } from "@payroll/shared";
import { round2 } from "@payroll/engine/money";
import {
  AnnualFiguresDefectError,
  applyRate,
  checkW2Boxes,
  type FicaParams,
  parseRate5,
  sumCents,
  type W2BoxesCents,
  type W2Sums,
  w2Boxes,
  w3Totals,
} from "../src/filings/w2-boxes.js";

/** 2026 federal parameters (Pub 15 2026; SSA wage base $184,500). */
const P2026: FicaParams = {
  ssWageCapCents: 18_450_000,
  ssRate5: 6200,
  medicareRate5: 1450,
  addlMedicareRate5: 900,
  addlMedicareThresholdCents: 20_000_000,
};
/** 2025 federal parameters (SSA wage base $176,100). */
const P2025: FicaParams = { ...P2026, ssWageCapCents: 17_610_000 };

const BOX_NAMES = [
  "box1Cents",
  "box2Cents",
  "box3Cents",
  "box4Cents",
  "box5Cents",
  "box6Cents",
] as const;

function boxes(
  b1: number,
  b2: number,
  b3: number,
  b4: number,
  b5: number,
  b6: number,
): W2BoxesCents {
  return {
    box1Cents: b1,
    box2Cents: b2,
    box3Cents: b3,
    box4Cents: b4,
    box5Cents: b5,
    box6Cents: b6,
  };
}

function codes(issues: readonly { code: string; severity: string }[]): string[] {
  return issues.map((i) => `${i.code}:${i.severity}`).sort();
}

// ---------------------------------------------------------------------------
// T01-T03: the box rules (P162-D2)
// ---------------------------------------------------------------------------

describe("T01-T03 w2Boxes (P162-D2)", () => {
  it("T01 $240,000 in 2026: box 3 capped at 184,500.00, box 4 at the max, box 6 includes Additional Medicare", () => {
    // Hand: box3 = min(240,000.00, 184,500.00) = 184,500.00; box4 withheld =
    // 184,500 x 6.2% = 11,439.00; box6 withheld = 240,000 x 1.45% + 40,000 x 0.9%
    // = 3,480.00 + 360.00 = 3,840.00; box5 = box1 (no cap).
    const b = w2Boxes(
      {
        gross_pay: "240000.00",
        social_security: "11439.00",
        medicare: "3840.00",
        federal_withholding: "0.00",
      },
      P2026,
    );
    expect(b).toEqual(boxes(24_000_000, 0, 18_450_000, 1_143_900, 24_000_000, 384_000));
    for (const k of BOX_NAMES) expect(Number.isSafeInteger(b[k]), k).toBe(true);
  });

  it("T02 box 3 at cap - 1c / cap / cap + 1c", () => {
    const at = (gross: string) => w2Boxes({ gross_pay: gross }, P2026).box3Cents;
    expect(at("184499.99")).toBe(18_449_999);
    expect(at("184500.00")).toBe(18_450_000);
    expect(at("184500.01")).toBe(18_450_000);
    // box 5 is never capped.
    expect(w2Boxes({ gross_pay: "184500.01" }, P2026).box5Cents).toBe(18_450_001);
    // The cap is the year's parameter, not a constant: 2025 base 176,100.00.
    expect(w2Boxes({ gross_pay: "184500.00" }, P2025).box3Cents).toBe(17_610_000);
  });

  it("T03 missing categories read as 0 for boxes 2, 4, 6 (and all six when nothing is present)", () => {
    const b = w2Boxes({ gross_pay: "1000.00" }, P2026);
    expect(b).toEqual(boxes(100_000, 0, 100_000, 0, 100_000, 0));
    expect(w2Boxes({}, P2026)).toEqual(boxes(0, 0, 0, 0, 0, 0));
  });

  it("box 2 and box 4 are the amounts withheld, never recomputed", () => {
    // 12 x 76.54 withheld = 918.48 although 6.2% x 14,814.72 = 918.51 (G04).
    const b = w2Boxes(
      {
        gross_pay: "14814.72",
        federal_withholding: "123.45",
        social_security: "918.48",
        medicare: "214.80",
      },
      P2026,
    );
    expect(b).toEqual(boxes(1_481_472, 12_345, 1_481_472, 91_848, 1_481_472, 21_480));
  });

  it("a negative sum is carried as negative cents (so D5 can block it), not thrown", () => {
    const b = w2Boxes({ gross_pay: "1000.00", social_security: "-0.01" }, P2026);
    expect(b.box4Cents).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// T04: parse errors carry no value (P162-D5)
// ---------------------------------------------------------------------------

describe("T04 sumCents / parseRate5 (P162-D5)", () => {
  it("reads SQL numeric text exactly", () => {
    expect(sumCents(undefined)).toBe(0);
    expect(sumCents("0.00")).toBe(0);
    expect(sumCents("11439.00")).toBe(1_143_900);
    expect(sumCents("109333.32")).toBe(10_933_332);
    expect(sumCents("-0.01")).toBe(-1);
    // numeric(14,2) top of range stays a safe integer.
    expect(sumCents("999999999999.99")).toBe(99_999_999_999_999);
    expect(parseRate5("0.06200")).toBe(6200);
    expect(parseRate5("0.01450")).toBe(1450);
    expect(parseRate5("0.00900")).toBe(900);
  });

  const BAD_MONEY = ["1e3", "NaN", "", "1.234"];
  for (const bad of BAD_MONEY) {
    it(`sumCents(${JSON.stringify(bad)}) throws the fixed-message defect error`, () => {
      let caught: unknown;
      try {
        sumCents(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AnnualFiguresDefectError);
      const message = (caught as Error).message;
      expect(message).toBe("annual figures: unreadable amount");
      if (bad !== "") expect(message).not.toContain(bad);
    });
  }

  it('parseRate5("0.0620001") throws the fixed-message defect error', () => {
    let caught: unknown;
    try {
      parseRate5("0.0620001");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AnnualFiguresDefectError);
    expect((caught as Error).message).toBe("annual figures: unreadable amount");
    expect((caught as Error).message).not.toContain("0.0620001");
  });
});

// ---------------------------------------------------------------------------
// applyRate: half-up, exact (BigInt)
// ---------------------------------------------------------------------------

describe("applyRate half-up in integer arithmetic (P162-D1)", () => {
  it("rounds an exact half cent UP (not to even)", () => {
    expect(applyRate(1, 50_000)).toBe(1); // 0.5c -> 1
    expect(applyRate(3, 50_000)).toBe(2); // 1.5c -> 2
    expect(applyRate(5, 50_000)).toBe(3); // 2.5c -> 3 (banker's would give 2)
    expect(applyRate(1, 49_999)).toBe(0); // 0.49999c -> 0
  });

  it("G07 per-run Medicare: 15,375.00 x 1.45% = 222.9375 -> 222.94", () => {
    expect(applyRate(1_537_500, 1450)).toBe(22_294);
  });

  it("2026 box 4 maximum: 184,500.00 x 6.2% = 11,439.00", () => {
    expect(applyRate(18_450_000, 6200)).toBe(1_143_900);
  });

  it("is exact where Number arithmetic is not (top of numeric(14,2) range)", () => {
    // 99,999,999,997,000c x 0.01450 = 1,449,999,999,956.5c exactly -> half-up
    // 1,449,999,999,957. Math.round(c * r / 100000) returns ...956.
    expect(applyRate(99_999_999_997_000, 1450)).toBe(1_449_999_999_957);
    expect(applyRate(99_999_999_999_999, 6200)).toBe(6_200_000_000_000);
  });
});

// ---------------------------------------------------------------------------
// T05 / G05: W-3 totals are exact integer sums
// ---------------------------------------------------------------------------

describe("T05 / G05 w3Totals (P162-D2)", () => {
  it("T05 two W-2s with 10c and 20c in every box -> 30c each, count 2, '0.30'", () => {
    const t = w3Totals([boxes(10, 10, 10, 10, 10, 10), boxes(20, 20, 20, 20, 20, 20)]);
    for (const k of BOX_NAMES) {
      expect(t[k], k).toBe(30);
      expect(formatCents(t[k])).toBe("0.30");
    }
    expect(t.employeeCount).toBe(2);
  });

  it("G05 box 2 sums 0.10 + 0.20 + 0.07 -> '0.37' (float would carry 0.37000000000000005)", () => {
    const t = w3Totals([
      boxes(100, 10, 100, 6, 100, 1),
      boxes(200, 20, 200, 12, 200, 3),
      boxes(70, 7, 70, 4, 70, 1),
    ]);
    expect(t.box2Cents).toBe(37);
    expect(formatCents(t.box2Cents)).toBe("0.37");
    expect(t.employeeCount).toBe(3);
  });

  it("no W-2s -> all zero, count 0", () => {
    expect(w3Totals([])).toEqual({ ...boxes(0, 0, 0, 0, 0, 0), employeeCount: 0 });
  });
});

// ---------------------------------------------------------------------------
// T11-T15: checkW2Boxes (P162-D7, P162-D5)
// ---------------------------------------------------------------------------

describe("T11-T13 block checks (P162-D7)", () => {
  // Consistent 2026 cap employee: box4 = 11,439.00, box6 = 184,500 x 1.45% = 2,675.25.
  const atCap = boxes(18_450_000, 0, 18_450_000, 1_143_900, 18_450_000, 267_525);

  it("a consistent at-cap W-2 has no issue", () => {
    expect(checkW2Boxes(atCap, 12, P2026)).toEqual([]);
  });

  it("T11 box 4 = max + 1c (1,143,901) -> box4_over_max block", () => {
    const issues = checkW2Boxes({ ...atCap, box4Cents: 1_143_901 }, 12, P2026);
    // 1c off 6.2% x box 3 is within tol (6c), so the block is the only issue.
    expect(codes(issues)).toEqual(["box4_over_max:block"]);
  });

  it("T11 boundary: box 4 exactly at the max is not over", () => {
    expect(checkW2Boxes({ ...atCap, box4Cents: 1_143_900 }, 1, P2026)).toEqual([]);
  });

  it("T12 box 3 = 0, box 4 = 1c -> box4_without_box3 block (box4_off_rate warn allowed)", () => {
    const issues = codes(checkW2Boxes(boxes(0, 0, 0, 1, 0, 0), 1, P2026));
    expect(issues).toContain("box4_without_box3:block");
    for (const c of issues) expect(["box4_without_box3:block", "box4_off_rate:warn"]).toContain(c);
  });

  it("T13 box 5 = 0, box 6 = 1c -> box6_without_box5 block (box6_off_rate warn allowed)", () => {
    const issues = codes(checkW2Boxes(boxes(0, 0, 0, 0, 0, 1), 1, P2026));
    expect(issues).toContain("box6_without_box5:block");
    for (const c of issues) expect(["box6_without_box5:block", "box6_off_rate:warn"]).toContain(c);
  });

  it("issues carry { code, severity } only — no amounts, no expected values", () => {
    const issues = checkW2Boxes({ ...atCap, box4Cents: 1_143_901 }, 12, P2026);
    for (const issue of issues) expect(Object.keys(issue).sort()).toEqual(["code", "severity"]);
  });
});

describe("T14 off-rate warnings, tol = ceil(runCount / 2) cents (P162-D7)", () => {
  // G04 figures: 14,814.72 wages. Expected box 4 = 6.2% x 1,481,472c =
  // 91,851.264c -> 91,851; expected box 6 = 1.45% x 1,481,472c = 21,481.344c
  // -> 21,481 (no Additional Medicare: box 5 < $200,000).
  const W = 1_481_472;
  const E4 = 91_851;
  const E6 = 21_481;
  const w2 = (b4: number, b6: number) => boxes(W, 0, W, b4, W, b6);

  it("n = 12 (tol 6c): box 4 off by 6c -> no issue; by 7c -> box4_off_rate warn (both directions)", () => {
    expect(checkW2Boxes(w2(E4 + 6, E6), 12, P2026)).toEqual([]);
    expect(checkW2Boxes(w2(E4 - 6, E6), 12, P2026)).toEqual([]);
    expect(codes(checkW2Boxes(w2(E4 + 7, E6), 12, P2026))).toEqual(["box4_off_rate:warn"]);
    expect(codes(checkW2Boxes(w2(E4 - 7, E6), 12, P2026))).toEqual(["box4_off_rate:warn"]);
  });

  it("n = 12 (tol 6c): box 6 off by 6c -> no issue; by 7c -> box6_off_rate warn (both directions)", () => {
    expect(checkW2Boxes(w2(E4, E6 + 6), 12, P2026)).toEqual([]);
    expect(checkW2Boxes(w2(E4, E6 - 6), 12, P2026)).toEqual([]);
    expect(codes(checkW2Boxes(w2(E4, E6 + 7), 12, P2026))).toEqual(["box6_off_rate:warn"]);
    expect(codes(checkW2Boxes(w2(E4, E6 - 7), 12, P2026))).toEqual(["box6_off_rate:warn"]);
  });

  it("G04 as withheld (918.48 / 214.80 vs 918.51 / 214.81, n = 12) -> no warning", () => {
    expect(checkW2Boxes(w2(91_848, 21_480), 12, P2026)).toEqual([]);
  });

  it("n = 1 -> tol 1c; n = 2 -> tol 1c; n = 3 -> tol 2c", () => {
    expect(checkW2Boxes(w2(E4 + 1, E6), 1, P2026)).toEqual([]);
    expect(codes(checkW2Boxes(w2(E4 + 2, E6), 1, P2026))).toEqual(["box4_off_rate:warn"]);
    expect(checkW2Boxes(w2(E4 + 1, E6), 2, P2026)).toEqual([]);
    expect(codes(checkW2Boxes(w2(E4 + 2, E6), 2, P2026))).toEqual(["box4_off_rate:warn"]);
    expect(checkW2Boxes(w2(E4 + 2, E6), 3, P2026)).toEqual([]);
    expect(codes(checkW2Boxes(w2(E4 + 3, E6), 3, P2026))).toEqual(["box4_off_rate:warn"]);
    expect(checkW2Boxes(w2(E4, E6 - 2), 3, P2026)).toEqual([]);
    expect(codes(checkW2Boxes(w2(E4, E6 - 3), 3, P2026))).toEqual(["box6_off_rate:warn"]);
  });

  it("G06 cap crossing (240,000 wages; 11,439.00 / 3,840.00 withheld, n = 12) -> no issue", () => {
    // Expected box 6 = 1.45% x 240,000 + 0.9% x 40,000 = 3,480.00 + 360.00.
    expect(
      checkW2Boxes(boxes(24_000_000, 0, 18_450_000, 1_143_900, 24_000_000, 384_000), 12, P2026),
    ).toEqual([]);
  });

  it("G07 at cap (box 6 withheld 2,675.28 = 12 x 222.94 vs expected 2,675.25; 3c <= 6c) -> no issue", () => {
    expect(
      checkW2Boxes(boxes(18_450_000, 0, 18_450_000, 1_143_900, 18_450_000, 267_528), 12, P2026),
    ).toEqual([]);
  });
});

describe("box 6 rounding form — auditor ruling: round each term (P162-D7)", () => {
  // box 5 = 200,000.30. Term 1: 20,000,030c x 1.45% = 290,000.435c -> 290,000.
  // Term 2: 30c excess x 0.9% = 0.27c -> 0. Per-term expectation = 290,000c.
  // (Round-once over the sum: 290,000.705c -> 290,001 — the reading NOT chosen.)
  const B5 = 20_000_030;
  const w2 = (b6: number) => boxes(B5, 0, 18_450_000, 1_143_900, B5, b6);

  it("terms are rounded separately", () => {
    expect(applyRate(B5, 1450)).toBe(290_000);
    expect(applyRate(30, 900)).toBe(0);
  });

  it("n = 1 (tol 1c): 289,999 is within tol of the per-term 290,000 (2c off the round-once 290,001)", () => {
    expect(checkW2Boxes(w2(289_999), 1, P2026)).toEqual([]);
  });

  it("n = 1 (tol 1c): 290,002 is 2c off the per-term 290,000 -> box6_off_rate warn", () => {
    expect(codes(checkW2Boxes(w2(290_002), 1, P2026))).toEqual(["box6_off_rate:warn"]);
  });
});

describe("T15 negative amounts block and suppress the other checks (P162-D2, D5)", () => {
  const ok = boxes(100_000, 5_000, 100_000, 6_200, 100_000, 1_450);
  BOX_NAMES.forEach((k, i) => {
    it(`box ${i + 1} = -1c -> exactly one negative_amount block`, () => {
      expect(checkW2Boxes({ ...ok, [k]: -1 }, 1, P2026)).toEqual([
        { code: "negative_amount", severity: "block" },
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// G09: differential — the frozen legacy arithmetic vs the cents module
// ---------------------------------------------------------------------------

/** Frozen copy of the pre-PAY-162 arithmetic (annual.ts at 1fbd87e). Test-only. */
function legacyBoxes(sums: W2Sums, capDollars: number): number[] {
  const n = (s: string | undefined) => (s === undefined ? 0 : Number(s));
  const box1 = round2(n(sums.gross_pay));
  return [
    box1,
    round2(n(sums.federal_withholding)),
    round2(Math.min(box1, capDollars)),
    round2(n(sums.social_security)),
    box1,
    round2(n(sums.medicare)),
  ];
}
const legacyToMoney = (x: number): string => round2(x).toFixed(2);

/** Independent exact oracle: BigInt cents from the string, no floats. */
function oracleCents(s: string | undefined): bigint {
  if (s === undefined) return 0n;
  const m = /^(\d+)\.(\d\d)$/.exec(s);
  if (!m) throw new Error("oracle: bad literal");
  return BigInt(m[1] ?? "") * 100n + BigInt(m[2] ?? "");
}
function oracleString(c: bigint): string {
  const whole = c / 100n;
  const frac = c % 100n;
  return `${whole}.${frac.toString().padStart(2, "0")}`;
}

/** mulberry32 — deterministic, dependency-free. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface DiffCase {
  capCents: number;
  employees: W2Sums[];
}

function amountFor(rnd: () => number, capCents: number): string {
  const money = (c: number) => oracleString(BigInt(c));
  const r = rnd();
  if (r < 0.05) return money(capCents - 1);
  if (r < 0.1) return money(capCents);
  if (r < 0.15) return money(capCents + 1);
  return money(Math.floor(rnd() * 1_000_000_001)); // [0.00, 10,000,000.00]
}

function sumsFor(rnd: () => number, capCents: number): W2Sums {
  const sums: W2Sums = {};
  if (rnd() > 0.02) sums.gross_pay = amountFor(rnd, capCents);
  if (rnd() > 0.1) sums.federal_withholding = amountFor(rnd, capCents);
  if (rnd() > 0.1) sums.social_security = amountFor(rnd, capCents);
  if (rnd() > 0.1) sums.medicare = amountFor(rnd, capCents);
  return sums;
}

function differentialCases(count: number): DiffCase[] {
  const rnd = prng(0x5eed_0162);
  const out: DiffCase[] = [];
  for (let i = 0; i < count; i += 1) {
    const capCents = rnd() < 0.5 ? 17_610_000 : 18_450_000;
    const n = 1 + Math.floor(rnd() * 20);
    const employees: W2Sums[] = [];
    for (let e = 0; e < n; e += 1) employees.push(sumsFor(rnd, capCents));
    out.push({ capCents, employees });
  }
  return out;
}

const CASES = differentialCases(10_000);

function legacyStrings(c: DiffCase): { w2: string[][]; w3: string[] } {
  const w2 = c.employees.map((s) => legacyBoxes(s, c.capCents / 100));
  const w3 = [0, 1, 2, 3, 4, 5].map((i) =>
    legacyToMoney(round2(w2.reduce((acc, b) => acc + (b[i] ?? 0), 0))),
  );
  return { w2: w2.map((b) => b.map(legacyToMoney)), w3 };
}

describe("G09 differential: legacy Number + round2 vs exact cents (10,000 seeded cases)", () => {
  it("the legacy arithmetic equals an independent BigInt oracle (no printed figure changes)", () => {
    for (const c of CASES) {
      const legacy = legacyStrings(c);
      const cap = BigInt(c.capCents);
      const exact = c.employees.map((s) => {
        const b1 = oracleCents(s.gross_pay);
        return [
          b1,
          oracleCents(s.federal_withholding),
          b1 < cap ? b1 : cap,
          oracleCents(s.social_security),
          b1,
          oracleCents(s.medicare),
        ];
      });
      const w3 = [0, 1, 2, 3, 4, 5].map((i) => exact.reduce((acc, b) => acc + (b[i] ?? 0n), 0n));
      expect(legacy.w2).toEqual(exact.map((b) => b.map(oracleString)));
      expect(legacy.w3).toEqual(w3.map(oracleString));
    }
  });

  it("w2Boxes / w3Totals print the same strings as the legacy arithmetic", () => {
    for (const c of CASES) {
      const legacy = legacyStrings(c);
      const p: FicaParams = { ...P2026, ssWageCapCents: c.capCents };
      const cents = c.employees.map((s) => w2Boxes(s, p));
      expect(cents.map((b) => BOX_NAMES.map((k) => formatCents(b[k])))).toEqual(legacy.w2);
      const t = w3Totals(cents);
      expect(BOX_NAMES.map((k) => formatCents(t[k]))).toEqual(legacy.w3);
      expect(t.employeeCount).toBe(c.employees.length);
    }
  });
});

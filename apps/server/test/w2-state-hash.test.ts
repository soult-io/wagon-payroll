/**
 * Spec 24 (PAY-116) PR-2 brief §4 — payroll-calc-auditor tests for the
 * furnishing hash v2 (tax years >= 2026 cover the state lines). Fail first
 * on origin/main a58dfc5: `w2FiguresHash` / `hashVersionFor` do not exist,
 * recordFurnishing writes hash_version 1 for every year, and the W-2 list
 * compares a boxes-1-6 hash, so a box 17 change is not a correction.
 *
 * Expected hashes are the auditor's own canonical SHA-256 (w2-state-oracle
 * hashV1 / hashV2), never the code's. H1's literal was computed on
 * a58dfc5 with w2BoxesHash and independently with Python
 * (json.dumps(sort_keys=True, separators=(",", ":")) + sha256):
 *   {v:1, employeeId:7, taxYear:2025, box1:6000000, box2:600000,
 *    box3:6000000, box4:372000, box5:6000000, box6:87000}
 *   -> d91171fab835f667d0a27f4ff0abd0593a8310200c10a52c471954761c441db1
 *
 * Rules: 2026 General Instructions for Forms W-2 and W-3, p.28
 * "Correcting Forms W-2 and W-3" (a W-2 furnished with other figures is
 * reissued marked CORRECTED); PAY-206 R3-R6; PR-2 brief §4 option (b): v2 =
 * boxes 1-6 + formCount + state lines {state, form, row, box16, box17} +
 * localLines []; no state ID value; integers or null only.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { w2Furnishings } from "@payroll/db";
import { hashVersionFor, recordFurnishing, w2FiguresHash } from "../src/filings/w2-furnish-core.js";
import {
  createEmployee,
  enterStateId,
  type Env,
  bootEnv,
  insertRun,
  insertRuns,
  rowOf,
  voidRun,
} from "./w2-state-harness.js";
import {
  type ExpBoxes,
  type ExpLine,
  expBoxes,
  expLines,
  hashV1,
  hashV2,
  months,
  monthly,
  st,
} from "./w2-state-oracle.js";

const H1_LITERAL = "d91171fab835f667d0a27f4ff0abd0593a8310200c10a52c471954761c441db1";

const B: ExpBoxes = {
  box1: 6_000_000,
  box2: 600_000,
  box3: 6_000_000,
  box4: 372_000,
  box5: 6_000_000,
  box6: 87_000,
};

/** A readable W2Figures-like object (extra keys must not enter the hash). */
function figures(
  b: ExpBoxes,
  lines: ExpLine[],
  formCount: number,
  extra: Record<string, unknown> = {},
) {
  return {
    employeeId: 7,
    legalName: "Synthetic Seven",
    runCount: 12,
    issues: [],
    box1Cents: b.box1,
    box2Cents: b.box2,
    box3Cents: b.box3,
    box4Cents: b.box4,
    box5Cents: b.box5,
    box6Cents: b.box6,
    formCount,
    stateLines: lines.map((l) => ({
      state: l.state,
      box16Cents: l.box16,
      box17Cents: l.box17,
      form: l.form,
      row: l.row,
      stateIdSource: "entered",
    })),
    localLines: [],
    ...extra,
  };
}

const TWO: ExpLine[] = [
  { state: "CA", box16: 3_000_000, box17: 7_404, form: 1, row: 1 },
  { state: "NY", box16: 6_000_000, box17: 12_000, form: 1, row: 2 },
];

const hash = (y: number, f: unknown) => w2FiguresHash(7, y, f as never);

describe("hashVersionFor", () => {
  it("1 through 2025, 2 from 2026 (STATE_BOXES_FROM_YEAR)", () => {
    expect([2020, 2024, 2025, 2026, 2027, 2100].map((y) => hashVersionFor(y))).toEqual([
      1, 1, 1, 2, 2, 2,
    ]);
  });
});

describe("H1 hash v1 frozen for tax years <= 2025", () => {
  it("equals the a58dfc5 literal; state fields on the figures never enter a v1 hash", () => {
    expect(hashV1(7, 2025, B)).toBe(H1_LITERAL);
    expect({
      plain: hash(2025, figures(B, [], 1)),
      withLines: hash(2025, figures(B, TWO, 1)),
      formCount2: hash(2025, figures(B, TWO, 2)),
    }).toEqual({ plain: H1_LITERAL, withLines: H1_LITERAL, formCount2: H1_LITERAL });
  });
});

describe("H2 hash v2 for tax years >= 2026 (pure)", () => {
  it("equals the auditor's canonical v2 object; extra keys (names, issues, stateIdSource) excluded", () => {
    expect(hash(2026, figures(B, TWO, 1))).toBe(hashV2(7, 2026, B, 1, TWO));
    expect(
      hash(2026, figures(B, TWO, 1, { legalName: "Other Name", issues: [{ code: "x" }] })),
    ).toBe(hashV2(7, 2026, B, 1, TWO));
    const otherSource = figures(B, TWO, 1);
    otherSource.stateLines = otherSource.stateLines.map((l) => ({
      ...l,
      stateIdSource: "ein_default",
    }));
    expect(hash(2026, otherSource)).toBe(hashV2(7, 2026, B, 1, TWO));
    expect(hash(2027, figures(B, [], 1))).toBe(hashV2(7, 2027, B, 1, []));
  });

  it("differs from the v1 hash of the same boxes", () => {
    expect(hash(2026, figures(B, [], 1))).not.toBe(hashV1(7, 2026, B));
  });

  it("one cent of box 17, a state code, a form or a row, formCount, box 16 -> a different hash; identical figures -> the same", () => {
    const base = hash(2026, figures(B, TWO, 1));
    const vary = (lines: ExpLine[], formCount = 1) => hash(2026, figures(B, lines, formCount));
    const variants = {
      box17PlusCent: vary([TWO[0]!, { ...TWO[1]!, box17: 12_001 }]),
      box17MinusCent: vary([{ ...TWO[0]!, box17: 7_403 }, TWO[1]!]),
      box16PlusCent: vary([{ ...TWO[0]!, box16: 3_000_001 }, TWO[1]!]),
      stateCode: vary([{ ...TWO[0]!, state: "IL" }, TWO[1]!]),
      formOfLine2: vary([TWO[0]!, { ...TWO[1]!, form: 2, row: 1 }], 2),
      rowSwap: vary([
        { ...TWO[0]!, row: 2 },
        { ...TWO[1]!, row: 1 },
      ]),
      formCountOnly: vary(TWO, 2),
      lineDropped: vary([TWO[0]!]),
    };
    for (const [name, h] of Object.entries(variants)) expect(h, name).not.toBe(base);
    expect(
      hash(
        2026,
        figures(
          { ...B },
          TWO.map((l) => ({ ...l })),
          1,
        ),
      ),
    ).toBe(base);
  });

  it("a null second row of one state (S1) hashes without error", () => {
    const nullRow: ExpLine[] = [
      { state: "NY", box16: 6_000_000, box17: 12_000, form: 1, row: 1 },
      { state: "NY", box16: null, box17: null, form: 1, row: 2 },
    ];
    expect(hash(2026, figures(B, nullRow, 1))).toBe(hashV2(7, 2026, B, 1, nullRow));
  });

  it("anything but integers or null -> a fixed TypeError that does not echo the value", () => {
    expect(typeof w2FiguresHash).toBe("function");
    expect(() => hash(2026, figures(B, TWO, 1))).not.toThrow();
    const bad = (patch: Record<string, unknown>) => {
      const f = figures(B, TWO, 1);
      f.stateLines = [{ ...f.stateLines[0]!, ...patch }, f.stateLines[1]!];
      return () => hash(2026, f);
    };
    for (const patch of [
      { box17Cents: 1.5 },
      { box16Cents: "3000000" },
      { box17Cents: Number.NaN },
    ]) {
      let err: unknown;
      try {
        bad(patch)();
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(patch)).toBeInstanceOf(TypeError);
      expect(String((err as Error).message)).not.toMatch(/1\.5|3000000|NaN/);
    }
    expect(() => hash(2026, figures({ ...B, box4: 0.5 }, TWO, 1))).toThrow(TypeError);
    expect(() => hash(2026, figures(B, TWO, 1.5))).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Integration: recorded version, CORRECTED on a state change (H2-H4)
// ---------------------------------------------------------------------------

const CA = st("CA");
const ana = () => months(2026, 1, 12).map((m) => monthly(m, CA, 1234));

describe("H2 recordFurnishing writes hashVersionFor(taxYear)", () => {
  let env: Env;
  let employeeId: number;
  beforeAll(async () => {
    env = await bootEnv();
    employeeId = await createEmployee(env, "Hash Version Emp");
  });
  afterAll(async () => env.close());

  it("2025 row -> hash_version 1; 2026 row -> hash_version 2", async () => {
    for (const taxYear of [2025, 2026]) {
      await recordFurnishing(env.t.db, {
        employeeId,
        taxYear,
        boxesHash: "a".repeat(64),
        corrected: false,
        method: "backfill",
        actorId: null,
      });
    }
    const rows = await env.t.db
      .select({ taxYear: w2Furnishings.taxYear, v: w2Furnishings.hashVersion })
      .from(w2Furnishings)
      .where(eq(w2Furnishings.employeeId, employeeId));
    expect(rows.map((r) => [r.taxYear, r.v]).sort()).toEqual([
      [2025, 1],
      [2026, 2],
    ]);
  });
});

describe("H3 a 2026 W-2 furnished, then only box 17 changes -> CORRECTED", () => {
  let env: Env;
  let employeeId: number;
  let marchId: number;
  beforeAll(async () => {
    env = await bootEnv();
    await enterStateId(env, "CA");
    employeeId = await createEmployee(env, "Hash Corrected Ana");
    const runs = await insertRuns(env, employeeId, ana());
    marchId = runs[2]!.id;
    // Furnished (portal notice) with the current v2 figures, hash by the oracle.
    const lines = expLines(ana(), 2026);
    await env.t.db.insert(w2Furnishings).values({
      employeeId,
      taxYear: 2026,
      boxesHash: hashV2(employeeId, 2026, expBoxes(ana(), 2026), 1, lines),
      hashVersion: 2,
      corrected: false,
      method: "portal_notice",
      actorId: null,
    });
  });
  afterAll(async () => env.close());

  it("same figures -> not corrected; March re-issued with the same amounts -> still not corrected; SWH 13.00 -> corrected + correctionToFurnish", async () => {
    const before = await rowOf(env, 2026, employeeId);
    // Void + re-issue with identical amounts: same figures, same hash.
    await voidRun(env, marchId);
    const same = await insertRun(env, employeeId, monthly("2026-03", CA, 1234));
    const afterSame = await rowOf(env, 2026, employeeId);
    // Void + re-issue with 13.00 state tax: boxes 1-6 unchanged, box 17 148.74.
    await voidRun(env, same.id);
    await insertRun(env, employeeId, monthly("2026-03", CA, 1300));
    const afterChange = await rowOf(env, 2026, employeeId);
    const pick = (r: typeof before) => ({
      box1Wages: r.box1Wages,
      corrected: r.corrected,
      correctionToFurnish: r.correctionToFurnish,
    });
    expect({
      before: pick(before),
      afterSame: pick(afterSame),
      afterChange: pick(afterChange),
    }).toEqual({
      before: { box1Wages: "60000.00", corrected: false, correctionToFurnish: false },
      afterSame: { box1Wages: "60000.00", corrected: false, correctionToFurnish: false },
      afterChange: { box1Wages: "60000.00", corrected: true, correctionToFurnish: true },
    });
  });
});

describe("H4 a 2026 furnishing row of hash version 1 counts as other figures", () => {
  let env: Env;
  let employeeId: number;
  beforeAll(async () => {
    env = await bootEnv();
    await enterStateId(env, "CA");
    employeeId = await createEmployee(env, "Hash Mixed Version");
    await insertRuns(env, employeeId, ana());
    await env.t.db.insert(w2Furnishings).values({
      employeeId,
      taxYear: 2026,
      // The v1 hash of the CURRENT boxes: equal under v1, but 2026 is v2.
      boxesHash: hashV1(employeeId, 2026, expBoxes(ana(), 2026)),
      hashVersion: 1,
      corrected: false,
      method: "portal_notice",
      actorId: null,
    });
  });
  afterAll(async () => env.close());

  it("list row corrected: true, correctionToFurnish: true", async () => {
    const row = await rowOf(env, 2026, employeeId);
    expect({ corrected: row.corrected, correctionToFurnish: row.correctionToFurnish }).toEqual({
      corrected: true,
      correctionToFurnish: true,
    });
  });

  it("guard: the stored row is untouched (append-only)", async () => {
    const rows = await env.t.db
      .select({ v: w2Furnishings.hashVersion })
      .from(w2Furnishings)
      .where(and(eq(w2Furnishings.employeeId, employeeId), eq(w2Furnishings.taxYear, 2026)));
    expect(rows).toEqual([{ v: 1 }]);
  });
});

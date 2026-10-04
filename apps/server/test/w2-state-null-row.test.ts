/**
 * Spec 24 (PAY-116) PR-2 — W36 (S1): every consumer accepts a null-amount
 * second row of one state. payroll-calc-auditor; synthetic data only.
 *
 * PR-2's planner emits one line per state, so the S1 shape (Spec 25's NY
 * layout: row 1 NY with amounts, row 2 NY with box 16/17 empty) can only be
 * reached with a test double: `planW2StateLines` is wrapped to add
 * {state: NY, box16Cents: null, box17Cents: null, form 1, row 2} after the
 * NY line. The consumers under test are the real ones: the admin list, the
 * W-3 worksheet, the stored filing and the furnishing hash.
 * REQUIREMENT this places on the code: annual.ts (the figures path) calls
 * planW2StateLines through its module export (import from
 * "./w2-state.js"), not through a call inside w2-state.ts.
 *
 * Expected (S24-D1 S1 rules, §7, R6): a null amount prints as null and
 * counts as 0; the second row of a state is not a second state, so W-3 box
 * 15 = NY (not X); box 16 60000.00, box 17 120.00; states NY w2Lines 2,
 * 60000.00 / 120.00, reconciled against the issued NY runs 120.00; box c 1.
 *
 * Fail first on origin/main a58dfc5: src/filings/w2-state.ts does not exist.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { computeW3Worksheet, syncAnnualFilings } from "../src/filings/annual.js";
import type { Db } from "../src/db.js";
import {
  bootEnv,
  createEmployee,
  type Env,
  insertRuns,
  list,
  setEin,
  SYNTHETIC_EIN,
  w2w3Row,
} from "./w2-state-harness.js";
import {
  canonicalSha,
  expW3,
  type ExpLine,
  type FxRun,
  months,
  monthly,
  st,
} from "./w2-state-oracle.js";

vi.mock("../src/filings/w2-state.js", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  type Line = {
    state: string;
    box16Cents: number | null;
    box17Cents: number | null;
    form: number;
    row: number;
  };
  const plan = orig.planW2StateLines as (
    input: unknown,
  ) => { lines: Line[] } & Record<string, unknown>;
  return {
    ...orig,
    planW2StateLines: (input: unknown) => {
      const p = plan(input);
      const i = p.lines.findIndex((l) => l.state === "NY");
      if (i < 0 || p.lines.length !== 1) return p;
      const first = p.lines[0]!;
      return {
        ...p,
        lines: [first, { ...first, box16Cents: null, box17Cents: null, form: 1, row: 2 }],
      };
    },
  };
});

const ny = (): FxRun[] => months(2026, 1, 12).map((m) => monthly(m, st("NY"), 1000));
const LINES: ExpLine[] = [
  { state: "NY", box16: 6_000_000, box17: 12_000, form: 1, row: 1 },
  { state: "NY", box16: null, box17: null, form: 1, row: 2 },
];

describe("W36 NY row 1 with amounts + NY row 2 null", () => {
  let env: Env;
  let id = 0;
  beforeAll(async () => {
    env = await bootEnv();
    await setEin(env, SYNTHETIC_EIN);
    id = await createEmployee(env, "Nina NullRow");
    await insertRuns(env, id, ny());
  });
  afterAll(async () => env.close());

  it("list 200: two NY rows, the second with null box 16/17; formCount 1", async () => {
    const l = await list(env, 2026);
    expect(l.status).toBe(200);
    const row = l.json.w2s.find((r) => r.employeeId === id)!;
    expect({ stateLines: row.stateLines, formCount: row.formCount, blocked: row.blocked }).toEqual({
      stateLines: [
        {
          state: "NY",
          box16: "60000.00",
          box17: "120.00",
          form: 1,
          row: 1,
          stateIdSource: "ein_default",
        },
        { state: "NY", box16: null, box17: null, form: 1, row: 2, stateIdSource: "ein_default" },
      ],
      formCount: 1,
      blocked: false,
    });
  });

  it("W-3: box 15 NY (not X), 16 60000.00, 17 120.00; NY w2Lines 2, reconciled; box c 1", async () => {
    const ws = await computeW3Worksheet(env.t.db as unknown as Db, 2026);
    const exp = expW3(2026, [{ runs: ny(), lines: LINES }]);
    expect(ws).toEqual(exp);
    expect([ws.box15State, ws.box16StateWages, ws.box17StateTax, ws.w2FormCount]).toEqual([
      "NY",
      "60000.00",
      "120.00",
      1,
    ]);
  });

  it("stored filing worksheet + hash", async () => {
    await syncAnnualFilings({ db: env.t.db, config: env.t.config } as never, {
      today: "2027-01-05",
    });
    const row = await w2w3Row(env, 2026);
    const exp = expW3(2026, [{ runs: ny(), lines: LINES }]);
    expect({ worksheet: row?.worksheet, hash: row?.worksheetHash }).toEqual({
      worksheet: exp,
      hash: canonicalSha(exp),
    });
  });
});

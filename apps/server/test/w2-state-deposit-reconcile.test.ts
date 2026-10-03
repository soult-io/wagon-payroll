/**
 * Spec 24 (PAY-116) PR-2 — W25 (R9 guard): a forced reconciliation
 * mismatch. payroll-calc-auditor; synthetic data only.
 *
 * Test double: the deposits module's `stateWithholdingByYear(db, year)`
 * (PR-2 brief §2: the thin export over loadStateLiability, category
 * state_withholding only, pay-date year, Map<state, cents>) is wrapped so
 * California reads ONE CENT more than the issued runs carry. Every other
 * state passes through. A real mismatch can only come from a code defect
 * (S24-D10), so a double is the only way to reach it.
 *
 * Expected (PR-2 brief §5, Product Lead approved): the W-3 worksheet shows
 * CA reconciled: false (runWithholding 222.13 vs W-2 box 17 222.12); NY
 * stays reconciled; the W-2 list returns 200 with yearIssues
 * [{code: reconciliation_mismatch, severity: block, state: CA}] and no
 * per-employee block; yearW2BlockCodes includes reconciliation_mismatch;
 * the W-3 PDF answers 409 {error: w2_not_ready, issues:
 * [reconciliation_mismatch]} (before the template check); a single W-2 PDF
 * is not blocked by it (2026 still answers form_not_available until PR-3).
 *
 * Fail first on origin/main a58dfc5: no states[] / yearIssues, and the W-3
 * PDF answers form_not_available.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { computeW3Worksheet, syncAnnualFilings, yearW2BlockCodes } from "../src/filings/annual.js";
import type { Db } from "../src/db.js";
import {
  bootEnv,
  createEmployee,
  enterStateId,
  type Env,
  get,
  insertRuns,
  list,
  setEin,
  SYNTHETIC_EIN,
  w2w3Row,
} from "./w2-state-harness.js";
import { expW3, type FxRun, months, monthly, st } from "./w2-state-oracle.js";

vi.mock("../src/deposits/service.js", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  const real = orig.stateWithholdingByYear as (
    db: unknown,
    year: number,
  ) => Promise<Map<string, number>>;
  return {
    ...orig,
    stateWithholdingByYear: async (db: unknown, year: number) => {
      const m = new Map(await real(db, year));
      m.set("CA", (m.get("CA") ?? 0) + 1);
      return m;
    },
  };
});

const CA = st("CA");
const NY = st("NY");
const ana = (): FxRun[] => months(2026, 1, 12).map((m) => monthly(m, CA, 1234));
const ben = (): FxRun[] => [
  ...months(2026, 1, 6).map((m) => monthly(m, CA, 1234)),
  ...months(2026, 7, 12).map((m) => monthly(m, NY, 2000)),
];

/** The oracle's W-3 with California's run withholding one cent up (the double). */
function expected() {
  const exp = expW3(2026, [{ runs: ana() }, { runs: ben() }]);
  return {
    ...exp,
    states: exp.states.map((s) =>
      s.state === "CA" ? { ...s, runWithholding: "222.13", reconciled: false } : s,
    ),
  };
}

describe("W25 forced CA reconciliation mismatch (clock 2027-01-05)", () => {
  let env: Env;
  let anaId = 0;
  beforeAll(async () => {
    env = await bootEnv({ now: "2027-01-05T12:00:00Z" });
    await enterStateId(env, "CA");
    await setEin(env, SYNTHETIC_EIN);
    anaId = await createEmployee(env, "Ana Reconcile");
    await insertRuns(env, anaId, ana());
    await insertRuns(env, await createEmployee(env, "Ben Reconcile"), ben());
  });
  afterAll(async () => env.close());

  it("W-3 worksheet: CA box17 222.12 vs runs 222.13 -> reconciled false; NY reconciled", async () => {
    const ws = await computeW3Worksheet(env.t.db as unknown as Db, 2026);
    expect(ws).toEqual(expected());
  });

  it("the stored worksheet shows the mismatch (the worksheet is never blocked)", async () => {
    await syncAnnualFilings({ db: env.t.db, config: env.t.config } as never, {
      today: "2027-01-05",
    });
    expect((await w2w3Row(env, 2026))?.worksheet).toEqual(expected());
  });

  it("list 200: yearIssues [reconciliation_mismatch CA]; no employee row blocked by it", async () => {
    const l = await list(env, 2026);
    expect(l.status).toBe(200);
    expect({
      yearIssues: l.json.yearIssues,
      blocked: l.json.w2s.map((r) => r.blocked),
      rowCodes: l.json.w2s.flatMap((r) => (r.issues as { code: string }[]).map((i) => i.code)),
    }).toEqual({
      yearIssues: [{ code: "reconciliation_mismatch", severity: "block", state: "CA" }],
      blocked: [false, false],
      rowCodes: ["local_tax_ny", "ny_all_wages"],
    });
  });

  it("yearW2BlockCodes includes reconciliation_mismatch (holds the W-3 and the notice, S24-D11)", async () => {
    expect(await yearW2BlockCodes(env.t.db as unknown as Db, 2026)).toEqual([
      "reconciliation_mismatch",
    ]);
  });

  it("W-3 PDF -> 409 w2_not_ready [reconciliation_mismatch]", async () => {
    const res = await get(env, "/api/admin/annual-forms/w3/pdf?year=2026");
    expect({ status: res.statusCode, body: res.json() }).toEqual({
      status: 409,
      body: { error: "w2_not_ready", issues: ["reconciliation_mismatch"] },
    });
  });

  it("guard: a single W-2 PDF is not blocked by the year-level mismatch (2026 form not bundled yet)", async () => {
    const res = await get(env, `/api/admin/annual-forms/w2/${anaId}/pdf?year=2026`);
    expect({ status: res.statusCode, body: res.json() }).toEqual({
      status: 409,
      body: { error: "form_not_available", year: 2026 },
    });
  });
});

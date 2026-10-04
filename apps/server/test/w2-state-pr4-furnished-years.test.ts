/**
 * Spec 24 (PAY-116) PR-4 round 2, F8 (code-reviewer LOW-2) — GET
 * /api/admin/company/state-ids `furnished` (payroll-calc-auditor,
 * fail-first; the coder may not edit this file). Synthetic data only.
 *
 * Test double: `w2StateLinesByEmployee` (src/filings/annual.ts) as seen by
 * the other server modules; for a year in `failYears` it throws (one
 * year's W-2 state lines cannot be planned). Every other year runs the
 * real planner.
 *
 * F8a: furnishings in 2026 (two CA employees) and 2027 (one CA employee);
 *      the 2027 plan fails -> furnished still lists [{CA, 2026, 2}] (the
 *      failure is caught per year, never empties the other years); 200.
 * F8b: the furnishing query itself fails (w2_furnishings unreadable — the
 *      table is renamed for the duration of the request) -> the route
 *      answers an error status (>= 500), never 200 with furnished: [].
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { w2Furnishings } from "@payroll/db";
import {
  bootEnv,
  createEmployee,
  enterStateId,
  type Env,
  federalConfig,
  get,
  insertRuns,
  setEin,
  SYNTHETIC_EIN,
} from "./w2-state-harness.js";
import { type FxRun, monthly, months, st } from "./w2-state-oracle.js";

const plan = vi.hoisted(() => ({ failYears: new Set<number>() }));

vi.mock("../src/filings/annual.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/filings/annual.js")>();
  return {
    ...orig,
    w2StateLinesByEmployee: async (...args: Parameters<typeof orig.w2StateLinesByEmployee>) => {
      if (plan.failYears.has(args[1]))
        throw new Error("state lines could not be planned (test double)");
      return orig.w2StateLinesByEmployee(...args);
    },
  };
});

const CA = st("CA");
const ana = (year: number): FxRun[] => months(year, 1, 12).map((m) => monthly(m, CA, 1234));
const URL = "/api/admin/company/state-ids";

describe("F8 furnished counts: per-year failure is contained; a DB error is not hidden", () => {
  let env: Env;
  beforeAll(async () => {
    env = await bootEnv({ now: "2028-01-10T12:00:00Z" });
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "CA", "00000001");
    await federalConfig(env, 2027);
    const ids: number[] = [];
    for (const name of ["Ana F1 Synthetic", "Ana F2 Synthetic"]) {
      const id = await createEmployee(env, name);
      ids.push(id);
      await insertRuns(env, id, ana(2026));
    }
    await insertRuns(env, ids[0] as number, ana(2027));
    const row = (employeeId: number, taxYear: number) => ({
      employeeId,
      taxYear,
      boxesHash: "a".repeat(64),
      hashVersion: 2,
      corrected: false,
      method: "portal_notice",
      actorId: null,
    });
    await env.t.db
      .insert(w2Furnishings)
      .values([
        row(ids[0] as number, 2026),
        row(ids[1] as number, 2026),
        row(ids[0] as number, 2027),
      ]);
  }, 180_000);
  afterAll(async () => {
    plan.failYears.clear();
    await env.close();
  });

  it("guard: both years plan -> [{CA,2026,2},{CA,2027,1}]", async () => {
    plan.failYears.clear();
    const res = await get(env, URL);
    expect({
      status: res.statusCode,
      furnished: (res.json() as { furnished?: unknown }).furnished,
    }).toEqual({
      status: 200,
      furnished: [
        { stateCode: "CA", taxYear: 2026, employees: 2 },
        { stateCode: "CA", taxYear: 2027, employees: 1 },
      ],
    });
  });

  it("F8a the 2027 plan fails: 200 and furnished still [{CA, 2026, 2}]", async () => {
    plan.failYears.clear();
    plan.failYears.add(2027);
    const res = await get(env, URL);
    plan.failYears.clear();
    expect({
      status: res.statusCode,
      furnished: (res.json() as { furnished?: unknown }).furnished,
    }).toEqual({
      status: 200,
      furnished: [{ stateCode: "CA", taxYear: 2026, employees: 2 }],
    });
  });

  it("F8b the furnishing query fails (table unreadable): an error status, never 200 with furnished []", async () => {
    plan.failYears.clear();
    await env.t.pglite.exec("ALTER TABLE w2_furnishings RENAME TO w2_furnishings_hidden");
    let status = 0;
    let furnished: unknown;
    try {
      const res = await get(env, URL);
      status = res.statusCode;
      furnished = status === 200 ? (res.json() as { furnished?: unknown }).furnished : undefined;
    } finally {
      await env.t.pglite.exec("ALTER TABLE w2_furnishings_hidden RENAME TO w2_furnishings");
    }
    expect({ errorStatus: status >= 500, furnished }).toEqual({
      errorStatus: true,
      furnished: undefined,
    });
  });
});

/**
 * Spec 24 (PAY-116) PR-2 — W35 (security M3): a box-1 mismatch or an
 * unreadable per-run amount on the state-line path becomes ONE
 * internal_mismatch block {code, severity}; nothing throws, no route 500s,
 * no body carries an amount or a run id. payroll-calc-auditor; synthetic.
 *
 * Test double: `parseCents` (@payroll/shared) as seen by the server
 * modules —
 *  - "60000.00" (the per-employee gross SUM, i.e. box 1) reads one cent
 *    high: box1Cents = 6000001 while the 12 runs sum to 6000000 (W35a);
 *  - "5000.01" (ONE run's gross text) is rejected, as parseCents rejects a
 *    malformed amount (W35b). The year sum "60000.01" still parses, so the
 *    PAY-162 box path is clean and only the state-line loader sees it.
 * The fixture amounts cannot produce either defect through SQL; only a
 * double reaches the path (S24-D1: "can only come from a code or data
 * defect").
 *
 * Expected (S24-D1, §7, PR-2 brief §2/§5): list 200, the row's issues
 * deep-equal [{code: internal_mismatch, severity: block}], boxes null,
 * stateLines []; admin Copy D, print packet, W-3 -> 409 {error:
 * w2_not_ready, issues: [internal_mismatch]}; employee route -> exactly
 * {error: w2_not_ready}; GET state-ids stays 200 (S1).
 *
 * Fail first on origin/main a58dfc5: no per-run loader, so neither defect
 * raises an issue and the PDF routes answer form_not_available.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  bootEnv,
  consentedEmployee,
  createEmployee,
  enterStateId,
  type Env,
  get,
  insertRuns,
  type InsertedRun,
  list,
  scrubTimestamps,
} from "./w2-state-harness.js";
import { type FxRun, months, monthly, st } from "./w2-state-oracle.js";

vi.mock("@payroll/shared", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@payroll/shared")>();
  return {
    ...orig,
    parseCents: (value: string) => {
      if (value === "60000.00") return orig.parseCents(value) + 1;
      if (value === "5000.01") throw new Error("parseCents: not a money string");
      return orig.parseCents(value);
    },
  };
});

const CA = st("CA");
const NOW = "2027-01-05T12:00:00Z";
const AMOUNT_STRINGS = ["60000", "148", "1234", "5000", "12.34", "6000001"];

const W2_NOT_READY = { error: "w2_not_ready", issues: ["internal_mismatch"] };

function noLeak(body: string, runs: readonly InsertedRun[]) {
  const text = scrubTimestamps(body);
  for (const a of AMOUNT_STRINGS) expect(text, `body leaks ${a}`).not.toContain(a);
  for (const r of runs) expect(text, "body leaks a run public id").not.toContain(r.publicId);
}

describe("W35a box 1 one cent off the run sum", () => {
  let env: Env;
  let id = 0;
  let session: Record<string, string> = {};
  let runs: InsertedRun[] = [];
  const ana = (): FxRun[] => months(2026, 1, 12).map((m) => monthly(m, CA, 1234));
  beforeAll(async () => {
    env = await bootEnv({ now: NOW });
    await enterStateId(env, "CA");
    const emp = await consentedEmployee(env, "Ana Defect");
    id = emp.employeeId;
    session = emp.session;
    runs = await insertRuns(env, id, ana());
  });
  afterAll(async () => env.close());

  it("list 200: one internal_mismatch {code, severity}; boxes null; stateLines []", async () => {
    const l = await list(env, 2026);
    expect(l.status).toBe(200);
    const row = l.json.w2s.find((r) => r.employeeId === id)!;
    expect({
      issues: row.issues,
      blocked: row.blocked,
      box1Wages: row.box1Wages,
      stateLines: row.stateLines,
      localLines: row.localLines,
    }).toEqual({
      issues: [{ code: "internal_mismatch", severity: "block" }],
      blocked: true,
      box1Wages: null,
      stateLines: [],
      localLines: [],
    });
    noLeak(l.body, runs);
  });

  it("Copy D, print packet, W-3 -> 409 w2_not_ready [internal_mismatch]; employee -> bare body; no leak", async () => {
    const urls = [
      `/api/admin/annual-forms/w2/${id}/pdf?year=2026`,
      `/api/admin/annual-forms/w2/${id}/print-packet?year=2026`,
      "/api/admin/annual-forms/w3/pdf?year=2026",
    ];
    const out: unknown[] = [];
    for (const url of urls) {
      const res = await get(env, url);
      noLeak(res.body, runs);
      out.push({ url, status: res.statusCode, body: res.json() });
    }
    const mine = await get(env, "/api/my/w2/2026/pdf", session);
    noLeak(mine.body, runs);
    out.push({ url: "my", status: mine.statusCode, body: mine.json() });
    expect(out).toEqual([
      ...urls.map((url) => ({ url, status: 409, body: W2_NOT_READY })),
      { url: "my", status: 409, body: { error: "w2_not_ready" } },
    ]);
  });

  it("guard: GET /api/admin/company/state-ids does not 500 (S1)", async () => {
    const res = await get(env, "/api/admin/company/state-ids");
    expect(res.statusCode).toBe(200);
  });
});

describe("W35b one run's gross text is unreadable", () => {
  let env: Env;
  let id = 0;
  let runs: InsertedRun[] = [];
  const bad = (): FxRun[] =>
    months(2026, 1, 12).map((m) =>
      monthly(m, CA, 1234, m === "2026-03" ? { grossCents: 500_001 } : {}),
    );
  beforeAll(async () => {
    env = await bootEnv({ now: NOW });
    await enterStateId(env, "CA");
    id = await createEmployee(env, "Ana Unreadable");
    runs = await insertRuns(env, id, bad());
  });
  afterAll(async () => env.close());

  it("list 200 with one internal_mismatch {code, severity}; no throw", async () => {
    const l = await list(env, 2026);
    expect(l.status).toBe(200);
    const row = l.json.w2s.find((r) => r.employeeId === id)!;
    expect({ issues: row.issues, blocked: row.blocked, stateLines: row.stateLines }).toEqual({
      issues: [{ code: "internal_mismatch", severity: "block" }],
      blocked: true,
      stateLines: [],
    });
    noLeak(l.body, runs);
  });

  it("Copy D and W-3 -> 409 w2_not_ready [internal_mismatch]", async () => {
    const d = await get(env, `/api/admin/annual-forms/w2/${id}/pdf?year=2026`);
    const w = await get(env, "/api/admin/annual-forms/w3/pdf?year=2026");
    expect([d.statusCode, d.json(), w.statusCode, w.json()]).toEqual([
      409,
      W2_NOT_READY,
      409,
      W2_NOT_READY,
    ]);
  });
});

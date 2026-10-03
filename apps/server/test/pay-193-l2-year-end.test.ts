/**
 * PAY-193 L2 — year-end warning (spec D9.8; tests Y-1, Y-2 of D9.11, as
 * amended by the Product Lead on 2026-10-03). Written fail-first by the
 * payroll-calc-auditor; the coder may not edit it. Y-3 (web) is out of scope.
 *
 * Contract encoded here:
 * - Pure module `src/filings/state-q4-due.ts` exports
 *   `stateQ4CloseDate(state: string, taxYear: number): string | null`
 *   (ISO date). Entries exist for taxYear 2026 only; the date is the state
 *   SME's "safe closesOn" (earliest filer status). No entry -> null.
 * - closesOn(Y) = earliest of filingDueDate(Y, 4), annualDueDate(Y) and, for
 *   every state in which an employee works in Y, stateQ4CloseDate(state, Y)
 *   ?? `${Y + 1}-01-31` (fallback, no weekend roll).
 *   "Works in Y" = a run with pay_date in Y whose snapshot names the state
 *   (inputs.state.workState — the field the state deposit planner reads), or
 *   an employee_work_states row active on some day of Y
 *   (effective_from <= Y-12-31 and (effective_to IS NULL or
 *   effective_to > Y-01-01); effective_to is exclusive, as in resolve.ts).
 *   No state at all -> federal only.
 * - GET /api/admin/payroll-runs/year-end (admin; employee -> 403). Body keys
 *   exactly { today, year, phase, closesOn, openRuns }; openRuns items exactly
 *   { publicId, payDate, status }. today = company-local date (APP_TZ
 *   Europe/Madrid) from the injected clock.
 *   - today in Dec of Y -> phase "december", year Y.
 *   - Jan 1 of Y+1 <= today <= closesOn(Y) -> phase "after_year_end", year Y.
 *   - otherwise phase null, year null, closesOn null, openRuns [].
 *   openRuns = runs in draft|awaiting_approval|approved with year(pay_date) = Y.
 *
 * Oracle (independent of the app): 941 Q4 for 2026 is due Jan 31, 2027
 * (Sunday) -> Mon Feb 1, 2027 (IRS Form 941 instructions, "When must you
 * file"; weekend rule IRC 7503). W-2/W-3 for 2026: Jan 31, 2027 -> Feb 1,
 * 2027 (General Instructions for Forms W-2 and W-3). State dates: state SME
 * table for TY2026 (2026-10-03): AR 01-15 (AR941M monthly), NJ 01-30
 * (NJ-927/WR-30, no roll), DC 01-31 (UC-30, no roll), CA 02-01 (DE 9),
 * HI 01-15 (HW-14), NY 02-01 (NYS-45, rolls), IL 02-01 (IL-941).
 * Madrid is UTC+1 from Nov to Mar, so local midnight is 23:00Z the day before.
 *
 * Every test deletes runs and work-state rows first, so the file passes in
 * any order. All data is synthetic; no amount is asserted (L2 changes none).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedDatabase, type SeedDb } from "@payroll/db";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";
import {
  createEmployee,
  insertIssuedHistoryRun,
  insertWorkState,
  monthPeriod,
} from "./pay-date-helpers.js";

// ---------------------------------------------------------------- pure table

describe("stateQ4CloseDate(state, taxYear) — D9.8 state table", () => {
  async function load() {
    return import("../src/filings/state-q4-due.js");
  }

  it.each([
    ["AR", 2026, "2027-01-15"],
    ["NJ", 2026, "2027-01-30"],
    ["DC", 2026, "2027-01-31"],
    ["CA", 2026, "2027-02-01"],
    ["HI", 2026, "2027-01-15"],
    ["NY", 2026, "2027-02-01"],
    ["IL", 2026, "2027-02-01"],
    ["ZZ", 2026, null],
    ["NJ", 2027, null],
    ["AR", 2027, null],
    ["NJ", 2025, null],
  ] as const)("%s for tax year %i -> %s", async (state, year, expected) => {
    const { stateQ4CloseDate } = await load();
    expect(stateQ4CloseDate(state, year)).toBe(expected);
  });
});

// ---------------------------------------------------------------- route harness

let t: TestContext;
let ADMIN: Record<string, string>;
let EMPLOYEE: Record<string, string>;
/** The app's wall clock; every test sets it before calling the route. */
let now = new Date("2026-10-03T10:00:00Z");

beforeAll(async () => {
  t = await createTestApp({ appTz: "Europe/Madrid" }, { clock: () => now });
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "pay-193-l2-admin@test.dev", role: "admin" });
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);
  const emp = await inviteAndOnboard(t, { email: "pay-193-l2-emp@test.dev", role: "employee" });
  EMPLOYEE = sessionHeader((await login(t, emp.email, TEST_PASSWORD)).sessionCookie);
}, 120_000);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  // The route reads every run and work state of the company: each test owns them.
  await t.pglite.query("DELETE FROM payroll_entries");
  await t.pglite.query("DELETE FROM payroll_runs");
  await t.pglite.query("DELETE FROM employee_work_states");
});

type Status = "draft" | "awaiting_approval" | "approved" | "issued" | "void";

/** A run row inserted directly; its snapshot names the work state (or none). */
async function run(
  employeeId: number,
  payDate: string,
  status: Status,
  workState: string | null,
): Promise<{ publicId: string; payDate: string; status: Status }> {
  const ym = payDate.slice(0, 7);
  const r = await insertIssuedHistoryRun(
    t,
    employeeId,
    monthPeriod(ym, payDate),
    {},
    {
      status,
      createdBy: "pay-193-l2-test",
      runSnapshot: workState
        ? { inputs: { payDate, state: { workState } } }
        : { inputs: { payDate } },
    },
  );
  return { publicId: r.publicId, payDate, status };
}

/** Employee working in `state` since 2024 (work-state row), or with none. */
async function employeeIn(state: string | null, label: string): Promise<number> {
  const id = await createEmployee(t, 400_000, label);
  if (state) await insertWorkState(t, id, state, "2024-01-01");
  return id;
}

interface YearEndBody {
  today: string;
  year: number | null;
  phase: "december" | "after_year_end" | null;
  closesOn: string | null;
  openRuns: Array<{ publicId: string; payDate: string; status: string }>;
}

async function yearEnd(instant: string, headers = ADMIN) {
  now = new Date(instant);
  return t.app.inject({ method: "GET", url: "/api/admin/payroll-runs/year-end", headers });
}

async function body(instant: string): Promise<YearEndBody> {
  const res = await yearEnd(instant);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as YearEndBody;
}

const byId = (a: { publicId: string }, b: { publicId: string }) =>
  a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : 0;

/** phase / year / closesOn only, for compact per-clock tables. */
async function window(instant: string) {
  const b = await body(instant);
  return { today: b.today, phase: b.phase, year: b.year, closesOn: b.closesOn };
}

const NULL_WINDOW = (today: string) => ({ today, phase: null, year: null, closesOn: null });

// ---------------------------------------------------------------- access

describe("GET /api/admin/payroll-runs/year-end — access", () => {
  it("an employee session is refused with 403", async () => {
    const res = await yearEnd("2026-12-10T12:00:00Z", EMPLOYEE);
    expect(res.statusCode, res.body).toBe(403);
  });

  it("no session is refused with 401", async () => {
    const res = await yearEnd("2026-12-10T12:00:00Z", {});
    expect(res.statusCode, res.body).toBe(401);
  });
});

// ---------------------------------------------------------------- Y-1

describe("Y-1 — IL employee: window Dec 1, 2026 to Feb 1, 2027 (Madrid)", () => {
  async function fixture() {
    const emp = await employeeIn("IL", "Year End IL");
    const open = await run(emp, "2026-12-15", "approved", "IL");
    await run(emp, "2027-01-15", "draft", "IL");
    await run(emp, "2026-11-15", "issued", "IL");
    // void runs release the period slot; a distinct period keeps them apart.
    await run(emp, "2026-10-01", "void", "IL");
    return { open };
  }

  it("phase by clock, in order: null, december, after_year_end, after_year_end, null", async () => {
    await fixture();
    const got = [];
    for (const i of [
      "2026-11-30T22:30:00Z", // Madrid 2026-11-30 23:30
      "2026-11-30T23:30:00Z", // Madrid 2026-12-01 00:30
      "2027-01-31T12:00:00Z",
      "2027-02-01T12:00:00Z",
      "2027-02-02T12:00:00Z",
    ]) {
      got.push(await window(i));
    }
    expect(got).toEqual([
      NULL_WINDOW("2026-11-30"),
      { today: "2026-12-01", phase: "december", year: 2026, closesOn: "2027-02-01" },
      { today: "2027-01-31", phase: "after_year_end", year: 2026, closesOn: "2027-02-01" },
      { today: "2027-02-01", phase: "after_year_end", year: 2026, closesOn: "2027-02-01" },
      NULL_WINDOW("2027-02-02"),
    ]);
  });

  it("year rollover and closesOn edge at Madrid midnight", async () => {
    await fixture();
    const got = [];
    for (const i of [
      "2026-12-31T22:59:00Z", // Madrid 2026-12-31 23:59
      "2026-12-31T23:00:00Z", // Madrid 2027-01-01 00:00
      "2027-02-01T22:59:00Z", // Madrid 2027-02-01 23:59
      "2027-02-01T23:00:00Z", // Madrid 2027-02-02 00:00
    ]) {
      got.push(await window(i));
    }
    expect(got).toEqual([
      { today: "2026-12-31", phase: "december", year: 2026, closesOn: "2027-02-01" },
      { today: "2027-01-01", phase: "after_year_end", year: 2026, closesOn: "2027-02-01" },
      { today: "2027-02-01", phase: "after_year_end", year: 2026, closesOn: "2027-02-01" },
      NULL_WINDOW("2027-02-02"),
    ]);
  });

  it("openRuns is only the 2026-12-15 approved run, in both phases", async () => {
    const { open } = await fixture();
    for (const i of ["2026-11-30T23:30:00Z", "2027-01-31T12:00:00Z"]) {
      expect((await body(i)).openRuns).toEqual([open]);
    }
  });

  it("body keys are exactly the D9.8 ones, with or without a phase", async () => {
    await fixture();
    for (const i of ["2026-12-10T12:00:00Z", "2027-01-10T12:00:00Z", "2027-03-01T12:00:00Z"]) {
      const b = await body(i);
      expect(Object.keys(b).sort()).toEqual(["closesOn", "openRuns", "phase", "today", "year"]);
      for (const r of b.openRuns) {
        expect(Object.keys(r).sort()).toEqual(["payDate", "publicId", "status"]);
      }
    }
  });

  it("outside the window openRuns is empty although open 2026 runs exist", async () => {
    await fixture();
    for (const i of ["2026-11-30T22:30:00Z", "2027-02-02T12:00:00Z", "2026-06-15T12:00:00Z"]) {
      expect((await body(i)).openRuns).toEqual([]);
    }
  });
});

describe("openRuns membership — statuses and pay-date year edges", () => {
  it("draft, awaiting_approval and approved with a Y pay date; nothing else", async () => {
    const a = await employeeIn("IL", "Open A");
    const b = await employeeIn("IL", "Open B");
    const expected = [
      await run(a, "2026-01-01", "draft", "IL"),
      await run(a, "2026-06-30", "awaiting_approval", "IL"),
      await run(a, "2026-12-31", "approved", "IL"),
    ];
    await run(b, "2025-12-31", "draft", "IL"); // year Y-1
    await run(b, "2027-01-01", "approved", "IL"); // year Y+1
    await run(b, "2026-03-31", "issued", "IL");
    await run(b, "2026-04-30", "void", "IL");
    for (const i of ["2026-12-10T12:00:00Z", "2027-01-20T12:00:00Z"]) {
      const got = (await body(i)).openRuns;
      expect([...got].sort(byId)).toEqual([...expected].sort(byId));
    }
  });

  it("the body carries no employee name and no amount", async () => {
    const a = await employeeIn("IL", "Zebulon Nameprobe");
    await run(a, "2026-12-15", "approved", "IL");
    const res = await yearEnd("2026-12-10T12:00:00Z");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain("Nameprobe");
    expect(res.body).not.toMatch(/\d+\.\d{2}/);
    expect(res.body).not.toContain("$");
  });
});

// ---------------------------------------------------------------- Y-2 family

describe("Y-2 — state Q4 due dates shorten the window", () => {
  it("Y-2 NJ (Jan 30, no roll): after_year_end through Jan 30, null from Jan 31 (Madrid)", async () => {
    const emp = await employeeIn("NJ", "Year End NJ");
    const open = await run(emp, "2026-12-15", "approved", "NJ");
    const got = [];
    for (const i of [
      "2027-01-30T12:00:00Z",
      "2027-01-30T22:59:00Z", // Madrid 2027-01-30 23:59
      "2027-01-30T23:00:00Z", // Madrid 2027-01-31 00:00
      "2027-01-31T12:00:00Z",
    ]) {
      got.push(await window(i));
    }
    expect(got).toEqual([
      { today: "2027-01-30", phase: "after_year_end", year: 2026, closesOn: "2027-01-30" },
      { today: "2027-01-30", phase: "after_year_end", year: 2026, closesOn: "2027-01-30" },
      NULL_WINDOW("2027-01-31"),
      NULL_WINDOW("2027-01-31"),
    ]);
    expect((await body("2027-01-30T12:00:00Z")).openRuns).toEqual([open]);
  });

  it("Y-2b HI (Jan 15): closesOn 2027-01-15, null on Jan 16", async () => {
    const emp = await employeeIn("HI", "Year End HI");
    await run(emp, "2026-12-15", "approved", "HI");
    expect([
      await window("2026-12-10T12:00:00Z"),
      await window("2027-01-15T12:00:00Z"),
      await window("2027-01-16T12:00:00Z"),
    ]).toEqual([
      { today: "2026-12-10", phase: "december", year: 2026, closesOn: "2027-01-15" },
      { today: "2027-01-15", phase: "after_year_end", year: 2026, closesOn: "2027-01-15" },
      NULL_WINDOW("2027-01-16"),
    ]);
  });

  it("Y-2c NY (NYS-45 rolls to Feb 1): closesOn 2027-02-01, same as federal", async () => {
    const emp = await employeeIn("NY", "Year End NY");
    await run(emp, "2026-12-15", "approved", "NY");
    expect([await window("2027-02-01T12:00:00Z"), await window("2027-02-02T12:00:00Z")]).toEqual([
      { today: "2027-02-01", phase: "after_year_end", year: 2026, closesOn: "2027-02-01" },
      NULL_WINDOW("2027-02-02"),
    ]);
  });

  it("AR (monthly AR941M, Jan 15) and DC (UC-30 Jan 31, no roll)", async () => {
    const ar = await employeeIn("AR", "Year End AR");
    await run(ar, "2026-12-15", "approved", "AR");
    expect(await window("2027-01-15T12:00:00Z")).toEqual({
      today: "2027-01-15",
      phase: "after_year_end",
      year: 2026,
      closesOn: "2027-01-15",
    });
    await t.pglite.query("DELETE FROM payroll_runs");
    await t.pglite.query("DELETE FROM employee_work_states");
    const dc = await employeeIn("DC", "Year End DC");
    await run(dc, "2026-12-15", "approved", "DC");
    expect([await window("2027-01-31T12:00:00Z"), await window("2027-02-01T12:00:00Z")]).toEqual([
      { today: "2027-01-31", phase: "after_year_end", year: 2026, closesOn: "2027-01-31" },
      NULL_WINDOW("2027-02-01"),
    ]);
  });

  it("several states: the earliest wins (CA Feb 1, NJ Jan 30, HI Jan 15 -> Jan 15)", async () => {
    for (const s of ["CA", "NJ", "HI"]) {
      const e = await employeeIn(s, `Multi ${s}`);
      await run(e, "2026-12-15", "approved", s);
    }
    expect(await window("2026-12-01T12:00:00Z")).toEqual({
      today: "2026-12-01",
      phase: "december",
      year: 2026,
      closesOn: "2027-01-15",
    });
  });

  it("a state with no table entry falls back to Jan 31 of Y+1, no roll", async () => {
    const emp = await employeeIn("ZZ", "Year End ZZ");
    await run(emp, "2026-12-15", "approved", "ZZ");
    expect([await window("2027-01-31T12:00:00Z"), await window("2027-02-01T12:00:00Z")]).toEqual([
      { today: "2027-01-31", phase: "after_year_end", year: 2026, closesOn: "2027-01-31" },
      NULL_WINDOW("2027-02-01"),
    ]);
  });

  it("no work state anywhere (customer zero shape): federal only, Feb 1, 2027", async () => {
    const emp = await employeeIn(null, "Year End No State");
    const open = await run(emp, "2026-12-15", "draft", null);
    const b = await body("2027-02-01T12:00:00Z");
    expect(b).toEqual({
      today: "2027-02-01",
      year: 2026,
      phase: "after_year_end",
      closesOn: "2027-02-01",
      openRuns: [open],
    });
  });
});

describe("which states count for year Y", () => {
  it("a 2026 run naming NJ counts even with no NJ work-state row", async () => {
    const emp = await employeeIn(null, "Snapshot NJ");
    await run(emp, "2026-03-31", "issued", "NJ");
    expect((await window("2026-12-10T12:00:00Z")).closesOn).toBe("2027-01-30");
  });

  it("an active 2026 work-state row counts with no runs at all", async () => {
    await employeeIn("HI", "Row Only HI");
    expect((await window("2026-12-10T12:00:00Z")).closesOn).toBe("2027-01-15");
  });

  it("a work-state row active on Jan 1, 2026 only counts (effective_to exclusive)", async () => {
    const emp = await createEmployee(t, 400_000, "Ends Jan 2");
    await insertWorkState(t, emp, "HI", "2024-01-01", "2026-01-02");
    expect((await window("2026-12-10T12:00:00Z")).closesOn).toBe("2027-01-15");
  });

  it("rows not active in 2026 do not count: ended by Jan 1, 2026 or starting 2027", async () => {
    const ended = await createEmployee(t, 400_000, "Ended 2025");
    await insertWorkState(t, ended, "HI", "2024-01-01", "2026-01-01");
    const later = await createEmployee(t, 400_000, "Starts 2027");
    await insertWorkState(t, later, "NJ", "2027-01-01");
    expect((await window("2026-12-10T12:00:00Z")).closesOn).toBe("2027-02-01");
  });

  it("a run paid in 2025 or 2027 does not make its state count for 2026", async () => {
    const emp = await employeeIn(null, "Other Years");
    await run(emp, "2025-12-31", "issued", "HI");
    await run(emp, "2027-01-05", "draft", "NJ");
    expect((await window("2027-01-10T12:00:00Z")).closesOn).toBe("2027-02-01");
  });
});

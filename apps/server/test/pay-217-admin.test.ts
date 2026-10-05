/**
 * PAY-217 T-24, T-25 — the admin side: the "former employees who can still
 * get this W-2 online" list (step b mitigation) and formerW2Access on the
 * employee page. payroll-calc-auditor, fail-first against faad1d9; the coder
 * may not edit this file. Synthetic data only.
 *
 * Contract assumed (brief §6.3):
 *  - GET /api/admin/annual-forms/w2?year=Y + formerEmployeeAccess: Array<{
 *      employeeId, legalName, terminationDate, accessThrough,
 *      signIn: "can_sign_in" | "locked" | "setting_up" | "no_sign_in",
 *      paperHandedOn: string | null }> — terminated employees with Y
 *    furnished online and open today; signIn from the user row (not banned
 *    -> can_sign_in; lockout -> locked; pending_enrollment -> setting_up;
 *    any other ban or no user -> no_sign_in); paperHandedOn = company-local
 *    date of the latest paper_handed row of Y carrying the CURRENT figures,
 *    else null; sorted by name; exactly these keys (no SSN, address, email,
 *    amount).
 *  - GET /api/admin/employees/:id -> employee.formerW2Access:
 *    { accessThrough, years } | null (null unless terminated with an open window).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { employees } from "@payroll/db";
import {
  adminCall,
  boot217,
  consenter,
  type Emp,
  type Env,
  hasAmount,
  insertFurnishing,
  makeEmp,
  scrub,
  setBan,
  SSN_FORMS,
  terminate,
  yearNotice,
  moveTo,
} from "./pay-217-harness.js";

const JAN_4_2027 = "2027-01-04T16:00:00Z";
const FEB_1_2027 = "2027-02-01T16:00:00Z";
const KEYS = [
  "accessThrough",
  "employeeId",
  "legalName",
  "paperHandedOn",
  "signIn",
  "terminationDate",
];

interface FormerRow {
  employeeId: number;
  legalName: string;
  terminationDate: string;
  accessThrough: string;
  signIn: string;
  paperHandedOn: string | null;
}

async function formerList(env: Env, year: number): Promise<FormerRow[] | null> {
  const r = await adminCall(env, "GET", `/api/admin/annual-forms/w2?year=${year}`);
  if (r.statusCode !== 200) throw new Error(`admin list ${r.statusCode}`);
  return ((r.json() as { formerEmployeeAccess?: FormerRow[] }).formerEmployeeAccess ?? null) as
    | FormerRow[]
    | null;
}

async function detail(env: Env, id: number) {
  const r = await adminCall(env, "GET", `/api/admin/employees/${id}`);
  const emp = (r.json() as { employee: Record<string, unknown> }).employee;
  return { present: "formerW2Access" in emp, value: emp.formerW2Access ?? null };
}

describe("PAY-217 admin: former-employee W-2 access list and employee detail", () => {
  let env: Env;
  const e: Record<string, Emp> = {};
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    for (const k of ["AdAlpha", "AdBravo", "AdCharlie", "AdDelta", "AdEcho"])
      e[k] = await consenter(env, k);
    e.AdFoxtrot = await makeEmp(env, { label: "AdFoxtrot", login: true, years: [2026] }); // paper only
    e.AdGolf = await makeEmp(env, { label: "AdGolf", years: [2026] }); // no login
    await yearNotice(env);
    await insertFurnishing(env, e.AdGolf.id, 2026, { at: "2027-01-05T16:00:00Z" });
    await moveTo(env, FEB_1_2027);
    for (const k of ["AdAlpha", "AdBravo", "AdCharlie", "AdDelta", "AdFoxtrot", "AdGolf"]) {
      await terminate(env, e[k]!, "2027-01-29");
    }
    await setBan(env, e.AdBravo!.userId!, "lockout");
    await setBan(env, e.AdCharlie!.userId!, "pending_enrollment");
    await setBan(env, e.AdDelta!.userId!, "employee_terminated"); // terminated before this release
    // Bravo: a paper copy handed with OTHER figures (not the current ones).
    await insertFurnishing(env, e.AdBravo!.id, 2026, {
      method: "paper_handed",
      at: "2027-02-15T16:00:00Z",
      hash: "d".repeat(64),
    });
    await moveTo(env, "2027-03-01T17:00:00Z"); // 11:00 CST
    const paper = await adminCall(
      env,
      "POST",
      `/api/admin/annual-forms/w2/${e.AdAlpha!.id}/furnished-on-paper?year=2026`,
      {},
    );
    if (paper.statusCode !== 200) throw new Error(`paper ${paper.statusCode}`);
  }, 300_000);
  afterAll(async () => env.close());

  it("T-24 2026 list on 2027-03-01: exactly the terminated people with 2026 online and open, sorted by name, each sign-in state, paperHandedOn only for the current figures; key allowlist; no email, SSN or amount", async () => {
    const rows = await formerList(env, 2026);
    const json = JSON.stringify(rows);
    const view = (k: string, signIn: string, paperHandedOn: string | null) => ({
      employeeId: e[k]!.id,
      legalName: `${k} Synthetic`,
      terminationDate: "2027-01-29",
      accessThrough: "2027-10-15",
      signIn,
      paperHandedOn,
    });
    expect({
      rows,
      keys: [...new Set((rows ?? []).map((r) => Object.keys(r).sort().join(",")))],
      noEmail: !json.includes("@"),
      noSsn: SSN_FORMS.every((s) => !json.includes(s)),
      noAmount: !hasAmount(scrub(json)),
      y2025: await formerList(env, 2025),
    }).toEqual({
      rows: [
        view("AdAlpha", "can_sign_in", "2027-03-01"),
        view("AdBravo", "locked", null),
        view("AdCharlie", "setting_up", null),
        view("AdDelta", "no_sign_in", null),
        view("AdGolf", "no_sign_in", null),
      ],
      keys: [KEYS.join(",")],
      noEmail: true,
      noSsn: true,
      noAmount: true,
      y2025: [],
    });
  });

  it("T-25 employee detail formerW2Access: { accessThrough, years } for a former with an open window; null for active, for paper-only, and once the window closed; the 2026 list is then empty", async () => {
    const open = {
      alpha: await detail(env, e.AdAlpha!.id),
      echo: await detail(env, e.AdEcho!.id),
      foxtrot: await detail(env, e.AdFoxtrot!.id),
    };
    await moveTo(env, "2027-10-16T15:00:00Z");
    const closed = await detail(env, e.AdAlpha!.id);
    const listAfter = await formerList(env, 2026);
    const status = (
      await env.t.db.select().from(employees).where(eq(employees.id, e.AdEcho!.id))
    )[0]!.status;
    expect({ open, closed, listAfter, echoStatus: status }).toEqual({
      open: {
        alpha: { present: true, value: { accessThrough: "2027-10-15", years: [2026] } },
        echo: { present: true, value: null },
        foxtrot: { present: true, value: null },
      },
      closed: { present: true, value: null },
      listAfter: [],
      echoStatus: "active",
    });
  });
});

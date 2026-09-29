/**
 * Spec 26 (PAY-173) §8 — federal W-4 cases (D3): certificate selection as of
 * certificateAsOf = min(period end, pay date); the next-calendar-year gate
 * and the exempt lapse judged by the pay date; the D3 step 4 write rule
 * (400 invalid_w4_effective_date).
 *
 * Sources: Treas. Reg. 31.3402(f)(3)-1; IRC 3402(f)(2)(C), 3402(f)(3)(A)/(B);
 * Treas. Reg. 31.3402(f)(4)-1(b)(1); Pub 15 (2026) §9 "Effective date of
 * Form W-4" (replacement: no later than the start of the first payroll
 * period ending on or after the 30th day; "A Form W-4 that makes a change for
 * the next calendar year won't take effect in the current calendar year") and
 * "Exemption from federal income tax withholding" (new W-4 due by February 15:
 * a Feb 15 payment is still exempt, Feb 16 is not).
 *
 * FIT, gross 5,000.00/mo, single, auditor-computed (cents):
 *   2026: 41,833 (+10,000 extra = 51,833); SYN-2027: 40,833 (+10,000 = 50,833).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDatabase, type SeedDb } from "@payroll/db";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";
import { seedSyntheticFederal2027 } from "./fixtures/synthetic-2027.js";
import {
  createEmployee,
  entriesOf,
  gen,
  insertW4,
  monthPeriod,
  runRow,
  snap,
} from "./pay-date-helpers.js";

let t: TestContext;
let ADMIN: Record<string, string>;

/**
 * Fixed wall clock (company-local today = 2026-12-10, Europe/Madrid). The
 * W-4 write path refuses a filedDate after today (400 filed_date_in_future),
 * so V-1..V-6 (filed 2026-11-20 .. 2026-12-10) need a today on/after the
 * latest filed date to reach the D3 step 4 window rule on any run date.
 * V-2/V-3/V-3b/V-6 file exactly on today (the boundary that must pass).
 */
const TODAY = "2026-12-10";
const CLOCK = () => new Date(`${TODAY}T12:00:00Z`);

beforeAll(async () => {
  t = await createTestApp({ appTz: "Europe/Madrid" }, { clock: CLOCK });
  await seedDatabase(t.db as unknown as SeedDb);
  await seedSyntheticFederal2027(t.db);
  const admin = await inviteAndOnboard(t, { email: "pay-date-w4-admin@test.dev", role: "admin" });
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);
}, 120_000);

afterAll(async () => {
  await t.close();
});

async function fitOf(emp: number, periodYm: string, payDate: string) {
  const { run } = await gen(t, emp, monthPeriod(periodYm, payDate));
  const s = snap(await runRow(t, run.id));
  const e = await entriesOf(t, run.id);
  return { fit: e.federal_withholding, w4From: s.inputs.w4?.effectiveFrom ?? null };
}

const W4_A = { taxYear: 2026, effectiveFrom: "2026-01-01", filedDate: "2025-12-15" };
const W4_B_NEXT_YEAR = {
  taxYear: 2027,
  effectiveFrom: "2026-11-20",
  filedDate: "2026-11-20",
  extraWithholdingCents: 10_000,
};
const EXEMPT_2026 = {
  taxYear: 2026,
  effectiveFrom: "2026-04-01",
  filedDate: "2026-03-17",
  federalExempt: true,
};

describe("exempt lapse by pay date (D3 step 3)", () => {
  it("W-1: exempt W-4 (deadline 2027-02-16), Feb 2027 period paid 2027-02-26 → withheld", async () => {
    const emp = await createEmployee(t, 500_000);
    await insertW4(t, emp, { ...EXEMPT_2026, renewalDeadline: "2027-02-16" });
    expect((await fitOf(emp, "2027-02", "2027-02-26")).fit).toBe(40_833);
  });

  it.each([
    ["2027-02-15", 0],
    ["2027-02-16", 40_833],
  ])("W-1b: deadline 2027-02-16, payment on %s → FIT %i", async (payDate, fit) => {
    const emp = await createEmployee(t, 500_000);
    await insertW4(t, emp, { ...EXEMPT_2026, renewalDeadline: "2027-02-16" });
    expect((await fitOf(emp, "2027-02", payDate)).fit).toBe(fit);
  });

  it("W-4c (guard, customer-zero shape): pay day 15 — Feb 2027 exempt, Mar 2027 withheld", async () => {
    const emp = await createEmployee(t, 500_000);
    await insertW4(t, emp, { ...EXEMPT_2026, renewalDeadline: "2027-02-16" });
    expect({
      feb: (await fitOf(emp, "2027-02", "2027-02-15")).fit,
      mar: (await fitOf(emp, "2027-03", "2027-03-15")).fit,
    }).toEqual({ feb: 0, mar: 40_833 });
  });

  it.each([
    ["2027-02-15", 0],
    ["2027-02-16", 40_833],
  ])(
    "W-5: NULL renewal deadline lapses on Feb 16 of tax_year + 1 — payment on %s → FIT %i",
    async (payDate, fit) => {
      const emp = await createEmployee(t, 500_000);
      await insertW4(t, emp, { ...EXEMPT_2026, renewalDeadline: null });
      expect((await fitOf(emp, "2027-02", payDate)).fit).toBe(fit);
    },
  );
});

describe("certificate selection (D3 steps 1–2)", () => {
  it("W-2 (i): a tax_year-2027 W-4 does not apply to a 2026-12-15 payment", async () => {
    const emp = await createEmployee(t, 500_000);
    await insertW4(t, emp, W4_A);
    await insertW4(t, emp, W4_B_NEXT_YEAR);
    expect(await fitOf(emp, "2026-12", "2026-12-15")).toEqual({
      fit: 41_833,
      w4From: "2026-01-01",
    });
  });

  it("W-2 (ii): the tax_year-2027 W-4 applies to the 2027-01-05 payment (+10,000 extra, SYN-2027)", async () => {
    const emp = await createEmployee(t, 500_000);
    await insertW4(t, emp, W4_A);
    await insertW4(t, emp, W4_B_NEXT_YEAR);
    expect(await fitOf(emp, "2026-12", "2027-01-05")).toEqual({
      fit: 50_833,
      w4From: "2026-11-20",
    });
  });

  it("W-3: effective start GREATEST(effective_from, tax_year-01-01) orders — 2027 form beats a 2026-12-01 mid-year W-4", async () => {
    const emp = await createEmployee(t, 500_000);
    await insertW4(t, emp, W4_A);
    await insertW4(t, emp, W4_B_NEXT_YEAR);
    await insertW4(t, emp, { taxYear: 2026, effectiveFrom: "2026-12-01", filedDate: "2026-12-01" });
    expect(await fitOf(emp, "2026-12", "2027-01-05")).toEqual({
      fit: 50_833,
      w4From: "2026-11-20",
    });
  });

  it("W-6: first W-4 filed and effective 2026-12-03 — (i) not for the Nov period paid 12-04; (ii) whole Dec run", async () => {
    const emp = await createEmployee(t, 500_000);
    await insertW4(t, emp, {
      taxYear: 2026,
      effectiveFrom: "2026-12-03",
      filedDate: "2026-12-03",
      extraWithholdingCents: 10_000,
    });
    expect({
      i: await fitOf(emp, "2026-11", "2026-12-04"),
      ii: await fitOf(emp, "2026-12", "2026-12-15"),
    }).toEqual({
      i: { fit: 41_833, w4From: null },
      ii: { fit: 51_833, w4From: "2026-12-03" },
    });
  });

  it("W-7: replacement filed and effective 2026-12-02 — (i) A for Nov paid 12-04; (ii) B for Dec paid 2027-01-05", async () => {
    const emp = await createEmployee(t, 500_000);
    await insertW4(t, emp, W4_A);
    await insertW4(t, emp, {
      taxYear: 2026,
      effectiveFrom: "2026-12-02",
      filedDate: "2026-12-02",
      extraWithholdingCents: 10_000,
    });
    expect({
      i: await fitOf(emp, "2026-11", "2026-12-04"),
      ii: await fitOf(emp, "2026-12", "2027-01-05"),
    }).toEqual({
      i: { fit: 41_833, w4From: "2026-01-01" },
      ii: { fit: 50_833, w4From: "2026-12-02" },
    });
  });

  it("W-8 (guard): advance pay 2026-12-20, replacement effective 2026-12-22 → A", async () => {
    const emp = await createEmployee(t, 500_000);
    await insertW4(t, emp, W4_A);
    await insertW4(t, emp, {
      taxYear: 2026,
      effectiveFrom: "2026-12-22",
      filedDate: "2026-12-22",
      extraWithholdingCents: 10_000,
    });
    expect(await fitOf(emp, "2026-12", "2026-12-20")).toEqual({
      fit: 41_833,
      w4From: "2026-01-01",
    });
  });
});

describe("W-4 write rule (D3 step 4) — POST /api/admin/employees/:id/w4", () => {
  async function postRaw(
    emp: number,
    body: { taxYear: number; filedDate: string; effectiveFrom: string },
  ) {
    return t.app.inject({
      method: "POST",
      url: `/api/admin/employees/${emp}/w4`,
      headers: ADMIN,
      payload: { filingStatus: "single", ...body },
    });
  }
  async function post(
    emp: number,
    body: { taxYear: number; filedDate: string; effectiveFrom: string },
  ) {
    const res = await postRaw(emp, body);
    const json = res.json() as { error?: string };
    return { status: res.statusCode, error: json.error ?? null };
  }
  const REJECT = { status: 400, error: "invalid_w4_effective_date" };
  const ACCEPT = { status: 201, error: null };

  async function empWith(hasA: boolean) {
    const emp = await createEmployee(t, 500_000);
    if (hasA) await insertW4(t, emp, W4_A);
    return emp;
  }

  it("V-1: first W-4 effective after its filed date → 400", async () => {
    expect(
      await post(await empWith(false), {
        taxYear: 2026,
        filedDate: "2026-12-01",
        effectiveFrom: "2026-12-10",
      }),
    ).toEqual(REJECT);
  });

  it("V-2: replacement effective before its filed date → 400", async () => {
    expect(
      await post(await empWith(true), {
        taxYear: 2026,
        filedDate: "2026-12-10",
        effectiveFrom: "2026-12-01",
      }),
    ).toEqual(REJECT);
  });

  it("V-3: replacement effective after W (2027-01-01: first period ending on/after 2027-01-09) → 400", async () => {
    expect(
      await post(await empWith(true), {
        taxYear: 2026,
        filedDate: "2026-12-10",
        effectiveFrom: "2027-02-15",
      }),
    ).toEqual(REJECT);
  });

  it("V-3b (auditor-added boundary): replacement effective exactly W = 2027-01-01 → 201", async () => {
    expect(
      await post(await empWith(true), {
        taxYear: 2026,
        filedDate: "2026-12-10",
        effectiveFrom: "2027-01-01",
      }),
    ).toEqual(ACCEPT);
  });

  it("V-4 (guard): next-year W-4 filed 2026-11-20, effective 2026-11-20 → 201", async () => {
    expect(
      await post(await empWith(true), {
        taxYear: 2027,
        filedDate: "2026-11-20",
        effectiveFrom: "2026-11-20",
      }),
    ).toEqual(ACCEPT);
  });

  it("V-5: next-year W-4 with effective start 2027-06-01 > 2027-01-01 → 400", async () => {
    expect(
      await post(await empWith(true), {
        taxYear: 2027,
        filedDate: "2026-11-20",
        effectiveFrom: "2027-06-01",
      }),
    ).toEqual(REJECT);
  });

  it("V-6: first W-4 effective before P(filed) = 2026-12-01 → 400; control 2026-12-01 → 201", async () => {
    expect({
      early: await post(await empWith(false), {
        taxYear: 2026,
        filedDate: "2026-12-10",
        effectiveFrom: "2026-11-15",
      }),
      control: await post(await empWith(false), {
        taxYear: 2026,
        filedDate: "2026-12-10",
        effectiveFrom: "2026-12-01",
      }),
    }).toEqual({ early: REJECT, control: ACCEPT });
  });

  it("V-7 (auditor-added): filedDate one day after today (2026-12-11) → 400 filed_date_in_future, no value echoed", async () => {
    // Otherwise lawful (first W-4, effective = filed), so only the future
    // filed date can refuse it.
    const res = await postRaw(await empWith(false), {
      taxYear: 2026,
      filedDate: "2026-12-11",
      effectiveFrom: "2026-12-11",
    });
    expect({
      status: res.statusCode,
      body: res.json(),
      echoesDate: res.body.includes("2026-12-11"),
    }).toEqual({
      status: 400,
      body: {
        error: "filed_date_in_future",
        field: "filedDate",
        message:
          'The "Date filed" can\'t be after today. Enter the date the employee signed the W-4.',
      },
      echoesDate: false,
    });
  });
});

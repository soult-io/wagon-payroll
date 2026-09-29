/**
 * Spec 26 (PAY-173) §8 — federal and state scenarios: tax tables, YTD and
 * the FUTA trigger follow the PAY date; work state and compensation stay on
 * the period start; state elections resolve on min(period end, pay date).
 *
 * Expected values: payroll-calc-auditor, recomputed independently of the
 * engine (Python decimal, half-up to cents) from Pub 15-T (2026) Worksheet 1A
 * + Annual Percentage Method (single, standard: $8,600 line 1g, 0 % to
 * $7,500 …), Pub 15 (2026) (SS 6.2 % to $184,500; Medicare 1.45 %;
 * Additional Medicare 0.9 % over $200,000 paid in the calendar year, employee
 * only; FUTA first $7,000 paid in the year, 0.6 % net), IRC 3121(a)(1),
 * 3102(f), 3306(b)(1), IL-700-T (2026) formula (4.95 %, $2,925 line-1
 * allowance). 2027 values use the SYNTHETIC fixtures (fixtures/synthetic-2027.ts):
 * SS cap 190,000, standard deduction 17,100, IL 5.00 %.
 *
 * Worksheet (gross 5,000.00/mo, single, no adjustments):
 *   2026: 60,000 − 16,100 = 43,900 → 1,240 + 31,500 × 12 % = 5,020 → /12 = 418.33
 *   SYN-2027: 60,000 − 17,100 = 42,900 → 1,240 + 30,500 × 12 % = 4,900 → /12 = 408.33
 * All amounts below are integer cents.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import { emailOutbox, payrollEntries, payrollRuns, seedDatabase, type SeedDb } from "@payroll/db";
import { formatCents } from "@payroll/shared";
import * as resolveModule from "../src/payroll/resolve.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard } from "./flow-helpers.js";
import { seedSyntheticFederal2027, seedSyntheticIl2027 } from "./fixtures/synthetic-2027.js";
import {
  approveAndIssue,
  cents,
  createEmployee,
  entriesOf,
  gen,
  insertIssuedHistoryRun,
  insertStateElection,
  insertWorkState,
  monthPeriod,
  runRow,
  settle,
  snap,
} from "./pay-date-helpers.js";

let t: TestContext;

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  await seedSyntheticFederal2027(t.db);
  await seedSyntheticIl2027(t.db);
  // An admin exists so a successful draft would write a draft-ready outbox row (S-1).
  await inviteAndOnboard(t, { email: "pay-date-admin@test.dev", role: "admin" });
}, 120_000);

afterAll(async () => {
  await t.close();
});

/** "YYYY-MM" plus n months. */
function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/**
 * `n` issued monthly history runs starting at period `firstYm`, each paid on
 * day `payDay` of the FOLLOWING month (arrears), gross `grossCents`; FUTA
 * entries follow the $7,000 base in pay-date order (0.6 %).
 */
async function arrearsHistory(
  employeeId: number,
  firstYm: string,
  n: number,
  grossCents: number,
  ssCents: number,
) {
  let futaBaseLeft = 700_000;
  for (let i = 0; i < n; i++) {
    const ym = addMonths(firstYm, i);
    const futaBase = Math.min(grossCents, futaBaseLeft);
    futaBaseLeft -= futaBase;
    await insertIssuedHistoryRun(t, employeeId, monthPeriod(ym, `${addMonths(ym, 1)}-05`), {
      gross_pay: grossCents,
      social_security: ssCents,
      employer_social_security: ssCents,
      employer_futa: (futaBase * 6) / 1000,
    });
  }
}

/** The figures every federal case compares, in cents. */
async function federalView(runId: number) {
  const run = await runRow(t, runId);
  const s = snap(run);
  const e = await entriesOf(t, runId);
  return {
    taxYear: s.inputs.taxConfig.taxYear,
    resolutionTaxYear: s.inputs.resolution?.taxYear,
    priorYtdGross: cents(s.inputs.priorYtdGross),
    federal_withholding: e.federal_withholding,
    social_security: e.social_security,
    employer_social_security: e.employer_social_security,
    medicare: e.medicare,
    employer_medicare: e.employer_medicare,
    employer_futa: e.employer_futa,
  };
}

describe("federal worked examples (R1–R4)", () => {
  async function scenarioA(priorCents: number) {
    const emp = await createEmployee(t, 500_000);
    await insertIssuedHistoryRun(t, emp, monthPeriod("2026-11", "2026-11-15"), {
      gross_pay: priorCents,
      employer_futa: 4_200,
    });
    const { run } = await gen(t, emp, monthPeriod("2026-12", "2027-01-05"));
    return { emp, run };
  }

  it("A: Dec 2026 period paid 2027-01-05, 2026 YTD 18,200,000 → 2027 tables, YTD 0, full SS + FUTA", async () => {
    const { run } = await scenarioA(18_200_000);
    expect(await federalView(run.id)).toEqual({
      taxYear: 2027,
      resolutionTaxYear: 2027,
      priorYtdGross: 0,
      federal_withholding: 40_833,
      social_security: 31_000,
      employer_social_security: 31_000,
      medicare: 7_250,
      employer_medicare: 7_250,
      employer_futa: 3_000, // DB trigger accepted it in the 2027 bucket
    });
  });

  it("A2: as A with 2026 YTD 19,800,000 → no 2026 Additional Medicare carried into 2027", async () => {
    const { run } = await scenarioA(19_800_000);
    expect(await federalView(run.id)).toEqual({
      taxYear: 2027,
      resolutionTaxYear: 2027,
      priorYtdGross: 0,
      federal_withholding: 40_833,
      social_security: 31_000,
      employer_social_security: 31_000,
      medicare: 7_250,
      employer_medicare: 7_250,
      employer_futa: 3_000,
    });
  });

  it("A-rev (auditor-added): Jan 2027 period paid in advance 2026-12-31 → 2026 tables and the 2026 YTD", async () => {
    const emp = await createEmployee(t, 500_000);
    await insertIssuedHistoryRun(t, emp, monthPeriod("2026-11", "2026-11-15"), {
      gross_pay: 18_200_000,
      employer_futa: 4_200,
    });
    const { run } = await gen(t, emp, monthPeriod("2027-01", "2026-12-31"));
    // SS: (18,450,000 − 18,200,000) × 6.2 % = 15,500; FUTA: 2026 base used up → 0.
    expect(await federalView(run.id)).toEqual({
      taxYear: 2026,
      resolutionTaxYear: 2026,
      priorYtdGross: 18_200_000,
      federal_withholding: 41_833,
      social_security: 15_500,
      employer_social_security: 15_500,
      medicare: 7_250,
      employer_medicare: 7_250,
      employer_futa: 0,
    });
  });

  it("B: SS cap crossing with pay in arrears — YTD counts the Dec-2025 period paid 2026-01-05", async () => {
    const emp = await createEmployee(t, 1_600_000);
    await arrearsHistory(emp, "2025-12", 11, 1_600_000, 99_200);
    const { run } = await gen(t, emp, monthPeriod("2026-11", "2026-12-04"));
    await approveAndIssue(t, run.publicId, "2026-12-01T12:00:00Z");
    const view = await federalView(run.id);
    // Σ 2026-paid SS (employee and employer) after issuing B.
    const ssRows = await t.db
      .select({ category: payrollEntries.category, amount: payrollEntries.amount })
      .from(payrollEntries)
      .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
      .where(and(eq(payrollRuns.employeeId, emp), eq(payrollRuns.status, "issued")));
    const sum = (cat: string) =>
      ssRows.filter((r) => r.category === cat).reduce((a, r) => a + cents(r.amount), 0);
    expect({
      ...view,
      ssEmployee2026: sum("social_security"),
      ssEmployer2026: sum("employer_social_security"),
    }).toEqual({
      taxYear: 2026,
      resolutionTaxYear: 2026,
      priorYtdGross: 17_600_000,
      federal_withholding: 290_117, // (192,000 − 16,100) → 34,814 / 12
      social_security: 52_700, // 850,000 × 6.2 %
      employer_social_security: 52_700,
      medicare: 23_200,
      employer_medicare: 23_200,
      employer_futa: 0,
      ssEmployee2026: 1_143_900, // = 18,450,000 × 6.2 %: never above the wage base
      ssEmployer2026: 1_143_900,
    });
  });

  describe("B2: exactly at the SS wage base", () => {
    // Each case builds its own employee (order-safe under --sequence.shuffle):
    // 9 arrears months + the Sep period paid 2026-10-05, issued.
    async function atWageBase() {
      const emp = await createEmployee(t, 2_050_000);
      await arrearsHistory(emp, "2025-12", 9, 2_050_000, 127_100);
      const { run } = await gen(t, emp, monthPeriod("2026-09", "2026-10-05"));
      await approveAndIssue(t, run.publicId, "2026-10-01T12:00:00Z");
      return { emp, sep: run };
    }
    it("(i) period 2026-09 paid 2026-10-05, prior = 18,450,000 → SS 0, Additional Medicare on 500,000", async () => {
      const { sep: run } = await atWageBase();
      expect(await federalView(run.id)).toEqual({
        taxYear: 2026,
        resolutionTaxYear: 2026,
        priorYtdGross: 18_450_000,
        federal_withholding: 416_867, // (246,000 − 16,100) → 50,024 / 12
        social_security: 0,
        employer_social_security: 0,
        medicare: 34_225, // 29,725 + 0.9 % × 500,000
        employer_medicare: 29_725,
        employer_futa: 0,
      });
    });
    it("(ii) period 2026-12 paid 2027-01-05 (SYN-2027) → fresh year: SS 127,100, FUTA 4,200, trigger accepts", async () => {
      const { emp } = await atWageBase();
      const { run } = await gen(t, emp, monthPeriod("2026-12", "2027-01-05"));
      expect(await federalView(run.id)).toEqual({
        taxYear: 2027,
        resolutionTaxYear: 2027,
        priorYtdGross: 0,
        federal_withholding: 414_200, // (246,000 − 17,100) → 49,704 / 12
        social_security: 127_100,
        employer_social_security: 127_100,
        medicare: 29_725,
        employer_medicare: 29_725,
        employer_futa: 4_200,
      });
    });
  });

  it("C: Additional Medicare crossing with pay in arrears (employee only)", async () => {
    const emp = await createEmployee(t, 1_800_000);
    await arrearsHistory(emp, "2025-12", 11, 1_800_000, 0);
    const { run } = await gen(t, emp, monthPeriod("2026-11", "2026-12-04"));
    expect(await federalView(run.id)).toEqual({
      taxYear: 2026,
      resolutionTaxYear: 2026,
      priorYtdGross: 19_800_000,
      federal_withholding: 338_117,
      social_security: 0,
      employer_social_security: 0,
      medicare: 40_500, // 26,100 + 0.9 % × 1,600,000
      employer_medicare: 26_100,
      employer_futa: 0,
    });
  });

  async function issuedA() {
    const emp = await createEmployee(t, 500_000);
    await insertIssuedHistoryRun(t, emp, monthPeriod("2026-11", "2026-11-15"), {
      gross_pay: 18_200_000,
      employer_futa: 4_200,
    });
    const { run } = await gen(t, emp, monthPeriod("2026-12", "2027-01-05"));
    await approveAndIssue(t, run.publicId, "2026-12-20T12:00:00Z");
    return { emp, a: run };
  }

  it("Y1: the Feb-5 payment sees the Jan-5 payment (A) in its 2027 YTD", async () => {
    const { emp, a } = await issuedA();
    const { run } = await gen(t, emp, monthPeriod("2027-01", "2027-02-05"));
    const s = snap(await runRow(t, run.id));
    expect({
      prior: cents(s.inputs.priorYtdGross),
      ytdGross: s.ytd ? cents(s.ytd.gross) : null,
      ytdYear: s.inputs.resolution?.ytd.year,
      ytdRuns: s.inputs.resolution?.ytd.runs,
    }).toEqual({ prior: 500_000, ytdGross: 1_000_000, ytdYear: 2027, ytdRuns: [a.publicId] });
  });

  it("Y2: a Jan-15 payment for the Jan period counts the Jan-5 payment (key 01-05 < 01-15)", async () => {
    const { emp } = await issuedA();
    const { run } = await gen(t, emp, monthPeriod("2027-01", "2027-01-15"));
    expect(cents(snap(await runRow(t, run.id)).inputs.priorYtdGross)).toBe(500_000);
  });

  it("T1 (guard): same pay date, earlier period start is counted", async () => {
    const emp = await createEmployee(t, 500_000);
    await insertIssuedHistoryRun(t, emp, monthPeriod("2026-10", "2026-12-04"), {
      gross_pay: 500_000,
      employer_futa: 3_000,
    });
    const { run } = await gen(t, emp, monthPeriod("2026-11", "2026-12-04"));
    expect(cents(snap(await runRow(t, run.id)).inputs.priorYtdGross)).toBe(500_000);
  });

  it("T4: resolvePriorYtd excludes the run itself, later keys, void runs and other years", async () => {
    const emp = await createEmployee(t, 500_000);
    await insertIssuedHistoryRun(t, emp, monthPeriod("2025-12", "2025-12-15"), {
      gross_pay: 300_000,
    });
    await insertIssuedHistoryRun(
      t,
      emp,
      monthPeriod("2026-09", "2026-09-15"),
      { gross_pay: 900_000 },
      {
        status: "void",
      },
    );
    const e = await insertIssuedHistoryRun(t, emp, monthPeriod("2026-10", "2026-10-15"), {
      gross_pay: 100_000,
    });
    const r = await insertIssuedHistoryRun(t, emp, monthPeriod("2026-11", "2026-11-15"), {
      gross_pay: 500_000,
    });
    await insertIssuedHistoryRun(t, emp, monthPeriod("2026-12", "2026-12-15"), {
      gross_pay: 700_000,
    });
    const resolvePriorYtd = (resolveModule as Record<string, unknown>).resolvePriorYtd as
      | ((
          db: unknown,
          employeeId: number,
          key: { payDate: string; periodStart: string; selfRunId: number | null },
        ) => Promise<{ year: number; byCategory: Map<string, number>; runPublicIds: string[] }>)
      | undefined;
    expect(typeof resolvePriorYtd).toBe("function");
    const self = await resolvePriorYtd!(t.db, emp, {
      payDate: "2026-11-15",
      periodStart: "2026-11-01",
      selfRunId: r.id,
    });
    expect({
      year: self.year,
      gross: cents(self.byCategory.get("gross_pay") ?? 0),
      runs: self.runPublicIds,
    }).toEqual({ year: 2026, gross: 100_000, runs: [e.publicId] });
    // A NEW draft with the same pay date and period start (id = +∞) does count R.
    const fresh = await resolvePriorYtd!(t.db, emp, {
      payDate: "2026-11-15",
      periodStart: "2026-11-01",
      selfRunId: null,
    });
    expect({
      gross: cents(fresh.byCategory.get("gross_pay") ?? 0),
      runs: fresh.runPublicIds,
    }).toEqual({ gross: 600_000, runs: [e.publicId, r.publicId] });
  });
});

describe("FUTA DB trigger by pay-date year (C12)", () => {
  async function with2026FutaAtCap() {
    const emp = await createEmployee(t, 500_000);
    await insertIssuedHistoryRun(t, emp, monthPeriod("2026-11", "2026-11-15"), {
      gross_pay: 18_200_000,
      employer_futa: 4_200,
    });
    return emp;
  }
  async function insertRunWithFuta(emp: number, periodYm: string, payDate: string, futa: number) {
    const run = await insertIssuedHistoryRun(
      t,
      emp,
      monthPeriod(periodYm, payDate),
      {},
      {
        status: "awaiting_approval",
      },
    );
    const res = await settle(
      t.db
        .insert(payrollEntries)
        .values({ runId: run.id, category: "employer_futa", amount: formatCents(futa) }),
    );
    const stored = await entriesOf(t, run.id);
    return { res, stored };
  }

  it("F1: 2026 FUTA 4,200 issued; A's 3,000 (period 2026-12, paid 2027-01-05) is accepted in the 2027 bucket", async () => {
    const emp = await with2026FutaAtCap();
    const { res, stored } = await insertRunWithFuta(emp, "2026-12", "2027-01-05", 3_000);
    expect({ ok: res.ok, message: res.ok ? "" : res.message, futa: stored.employer_futa }).toEqual({
      ok: true,
      message: "",
      futa: 3_000,
    });
  });

  it("F1b (auditor-added): advance pay 2026-12-31 for the Jan-2027 period is judged in 2026 → rejected", async () => {
    const emp = await with2026FutaAtCap();
    const { res, stored } = await insertRunWithFuta(emp, "2027-01", "2026-12-31", 100);
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.message).toContain("employer_futa annual cap exceeded");
    expect(res.ok ? "" : res.message).toContain("in 2026");
    expect(stored.employer_futa).toBeUndefined();
  });

  it("F2 (guard): a 2026-paid entry of 100 over the 2026 cap is still rejected", async () => {
    const emp = await with2026FutaAtCap();
    const { res, stored } = await insertRunWithFuta(emp, "2026-12", "2026-12-15", 100);
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.message).toContain("employer_futa annual cap exceeded");
    expect(stored.employer_futa).toBeUndefined();
  });
});

describe("state examples (S1–S6)", () => {
  async function outboxCount(): Promise<number> {
    const rows = await t.db.select({ n: count() }).from(emailOutbox);
    return Number(rows[0]?.n ?? 0);
  }
  async function runsOf(emp: number): Promise<number> {
    const rows = await t.db
      .select({ n: count() })
      .from(payrollRuns)
      .where(eq(payrollRuns.employeeId, emp));
    return Number(rows[0]?.n ?? 0);
  }

  it.each([
    ["S-1", "CA"],
    ["S-1b", "TX"],
  ])(
    "%s: work state %s with no 2027 row → no_state_tax_config naming the state and 2027; nothing written",
    async (_id, state) => {
      const emp = await createEmployee(t, 500_000);
      await insertWorkState(t, emp, state, "2024-01-01");
      const before = await outboxCount();
      const res = await settle(gen(t, emp, monthPeriod("2026-12", "2027-01-05")));
      expect({
        ok: res.ok,
        code: res.ok ? null : res.code,
        namesState: res.ok ? false : res.message.includes(state),
        namesYear: res.ok ? false : res.message.includes("2027"),
        runs: await runsOf(emp),
        outboxAdded: (await outboxCount()) - before,
      }).toEqual({
        ok: false,
        code: "no_state_tax_config",
        namesState: true,
        namesYear: true,
        runs: 0,
        outboxAdded: 0,
      });
    },
  );

  async function ilRun(opts: { history?: boolean } = {}) {
    const emp = await createEmployee(t, 500_000);
    await insertWorkState(t, emp, "IL", "2024-01-01");
    if (opts.history) {
      // 11 IL runs paid in 2026 (periods and pay dates 2026-01..11), 24,750 each = 272,250.
      let futaBaseLeft = 700_000;
      for (let m = 1; m <= 11; m++) {
        const ym = `2026-${String(m).padStart(2, "0")}`;
        const futaBase = Math.min(500_000, futaBaseLeft);
        futaBaseLeft -= futaBase;
        await insertIssuedHistoryRun(t, emp, monthPeriod(ym, `${ym}-15`), {
          gross_pay: 500_000,
          state_withholding: 24_750,
          employer_futa: (futaBase * 6) / 1000,
        });
      }
    }
    const { run } = await gen(t, emp, monthPeriod("2026-12", "2027-01-05"));
    const s = snap(await runRow(t, run.id));
    const e = await entriesOf(t, run.id);
    return { s, e };
  }

  it("S-2: IL, Dec period paid 2027-01-05 → SYN-IL-2027 5.00 %: 60,000 × 5 % / 12 = 25,000", async () => {
    const { s, e } = await ilRun();
    expect({
      state_withholding: e.state_withholding,
      stateTaxYear: s.inputs.state?.taxYear,
      resolutionTaxYear: s.inputs.resolution?.taxYear,
    }).toEqual({ state_withholding: 25_000, stateTaxYear: 2027, resolutionTaxYear: 2027 });
  });

  it("S-3: IL state YTD resets in the pay-date year (25,000, not 272,250 + …)", async () => {
    const { s } = await ilRun({ history: true });
    expect(s.ytd ? cents(s.ytd.stateWithholding) : null).toBe(25_000);
  });

  async function ilElectionRun(effectiveFrom: string | null, payDate: string) {
    const emp = await createEmployee(t, 500_000);
    await insertWorkState(t, emp, "IL", "2024-01-01");
    if (effectiveFrom)
      await insertStateElection(t, emp, {
        stateCode: "IL",
        allowances: 1,
        effectiveFrom,
        filedDate: effectiveFrom,
      });
    const { run } = await gen(t, emp, monthPeriod("2026-11", payDate));
    const s = snap(await runRow(t, run.id));
    const e = await entriesOf(t, run.id);
    return {
      state_withholding: e.state_withholding,
      electionFrom: s.inputs.state?.election?.effectiveFrom ?? null,
    };
  }

  it("S-5a (guard): IL-W-4 effective 2026-12-01, after the Nov period end → not applied (24,750)", async () => {
    expect(await ilElectionRun("2026-12-01", "2026-12-04")).toEqual({
      state_withholding: 24_750,
      electionFrom: null,
    });
  });

  it("S-5b: IL-W-4 effective 2026-11-20, inside the period and before the pay date → applied (23,543)", async () => {
    // IL-700-T: (5,000 − 2,925 / 12) × 4.95 % = 4,756.25 × 4.95 % = 235.434375 → 235.43
    expect(await ilElectionRun("2026-11-20", "2026-12-04")).toEqual({
      state_withholding: 23_543,
      electionFrom: "2026-11-20",
    });
  });

  it("S-5c (guard): advance pay 2026-11-15, IL-W-4 effective 2026-11-20 → not applied (24,750)", async () => {
    expect(await ilElectionRun("2026-11-20", "2026-11-15")).toEqual({
      state_withholding: 24_750,
      electionFrom: null,
    });
  });

  it("S-6: work state stays on the period start (IL), table year follows the pay date (2027)", async () => {
    const emp = await createEmployee(t, 500_000);
    await insertWorkState(t, emp, "IL", "2024-01-01", "2027-01-01");
    await insertWorkState(t, emp, "CA", "2027-01-01");
    const res = await settle(gen(t, emp, monthPeriod("2026-12", "2027-01-05")));
    expect(res.ok ? null : res.code).toBeNull();
    const run = res.ok ? res.value.run : null;
    const s = snap(await runRow(t, run!.id));
    const e = await entriesOf(t, run!.id);
    expect({
      workState: s.inputs.state?.workState,
      taxYear: s.inputs.state?.taxYear,
      state_withholding: e.state_withholding,
    }).toEqual({ workState: "IL", taxYear: 2027, state_withholding: 25_000 });
  });
});

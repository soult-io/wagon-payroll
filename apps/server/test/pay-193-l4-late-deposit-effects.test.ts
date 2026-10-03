/**
 * PAY-193 L4 — what a late issue writes in its own transaction: worksheet
 * refresh (EF-4), deposit shortfall / overdue rows and their follow-up codes
 * (EF-5, EF-8), a state unit that cannot be planned (EF-9), and the lock
 * order (EF-10). Addendum L4.5, L4.11. Auditor-owned (payroll-calc-auditor),
 * fail-first; the coder may not edit it.
 *
 * Every filing and deposit figure below is recomputed by the auditor from the
 * published method (test/pay-193-oracle.ts; Pub 15-T 2026 Worksheet 1A,
 * Pub 15 2026 §§9, 14, IL-700-T 2026), never read from the engine:
 *
 * EF-4 scenario (2026, all IL, single, IL-W-4 1 allowance, monthly):
 *  E3 16,000.00/mo, runs Jan–Nov issued (seeded with oracle entries), the
 *     December run (paid 2026-12-31) issued LATE on 2027-01-20.
 *     Per month: FIT 2,901.17; Medicare 232.00; IL 779.93; SS 992.00 until
 *     the $184,500 wage base. December: prior YTD 176,000.00 -> 8,500.00
 *     SS wages -> SS 527.00 (wage-base crossing in the late run); net
 *     11,559.90; FUTA 0 (the $7,000 went in January: 42.00).
 *  E2 4,000.00/mo, hired 2026-11-01: November issued (seeded), December
 *     (paid 2026-12-31) issued LATE after E3's. Per month FIT 298.33, SS
 *     248.00, Medicare 58.00, IL 185.93, net 3,209.74. FUTA: Nov 24.00
 *     (4,000), Dec 18.00 (3,000 — the $7,000 crossing in the late run).
 *  After both late issues:
 *   W-3 2026: box 1 200,000.00 (192,000 + 8,000); box 2 35,410.70
 *     (12 x 2,901.17 + 2 x 298.33); box 3 192,500.00 (184,500 + 8,000);
 *     box 4 11,935.00 (11,439.00 + 496.00); box 5 200,000.00; box 6
 *     2,900.00 (2,784.00 + 116.00). Boxes 16/17 (IL wages / IL tax):
 *     200,000.00 / 9,731.02 (12 x 779.93 + 2 x 185.93).
 *   940 2026: line 3 200,000.00; line 7 FUTA wages 14,000.00 (7,000 + 7,000);
 *     line 8 84.00; frozen employer_futa 84.00 (42 + 24 + 18).
 *   941 2026-Q4 (Oct, Nov, Dec runs: E3 x3, E2 x2): line 2 56,000.00;
 *     line 3 9,300.17 (3 x 2,901.17 + 2 x 298.33); line 5a col 1
 *     48,500.00 (16,000 + 16,000 + 8,500 + 4,000 + 4,000), col 2 6,014.00;
 *     line 5c col 1 56,000.00, col 2 1,624.00; line 6 16,938.17; line 16
 *     Oct 5,349.17, Nov 6,259.50, Dec 5,329.50 (sum = line 12 16,938.17).
 *  After E3's late issue only: W-3 box 1 196,000.00, box 3 188,500.00;
 *   940 line 7 11,000.00; 941 Q4 line 2 52,000.00, line 5a 44,500.00.
 *
 * EF-5 / EF-8 amounts: one more IL 4,000.00 run adds 910.33 federal
 * (298.33 + 2 x 248.00 + 2 x 58.00) and 185.93 IL to December 2026.
 * Federal December is due 2027-01-15 (Fri); IL monthly (IL-2026 seed, due day
 * 15) also 2027-01-15.
 *
 * Reading named for the tax SME (EF-8b): `deposit_overdue:<jurisdiction>:…`
 * is emitted for a state seq-0 row inserted past its due date as well as for
 * federal (L4.3 defines the code for "federal or the two-letter code").
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { payrollEntries, payrollRuns, taxFilings } from "@payroll/db";
import { parseCents } from "@payroll/shared";
import { markDeposited, syncDeposits } from "../src/deposits/service.js";
import { computeWorksheet, syncFilings } from "../src/filings/service.js";
import {
  compute940Worksheet,
  computeW3Worksheet,
  syncAnnualFilings,
} from "../src/filings/annual.js";
import { fedDepositCents, money, oracleRun2026, oracleYear, sum } from "./pay-193-oracle.js";
import {
  approve,
  audits,
  bootL4,
  draft,
  history,
  installRecorder,
  issue,
  type L4Env,
  labelsIn,
  allLabels,
  latePayment,
  makeEmployee,
  notFiled,
  record,
  resetL4,
  runByPublicId,
  txOf,
} from "./pay-193-l4-harness.js";

let env: L4Env;

beforeAll(async () => {
  env = await bootL4({ adminEmail: "pay-193-l4-effects-admin@test.dev" });
  installRecorder(env.t);
}, 180_000);

afterAll(async () => {
  await env.t.close();
});

beforeEach(async () => {
  await resetL4(env.t);
});

const deps = () => ({ db: env.t.db, config: env.t.config });

const A = oracleRun2026(400_000, 0, "IL1");
const B = oracleRun2026(250_000, 0, "IL1");
const NONE = oracleRun2026(400_000, 0, "none");

interface DepRow {
  seq: number;
  c: number;
  due: string;
  status: string;
}

async function live(j: string, start = "2026-12-01"): Promise<DepRow[]> {
  const r = await env.t.pglite.query<{ seq: number; amount: string; due: string; status: string }>(
    `SELECT seq, amount::text AS amount, due_date::text AS due, status FROM tax_deposits
      WHERE jurisdiction = $1 AND period_start = $2 AND status <> 'superseded' ORDER BY seq`,
    [j, start],
  );
  return r.rows.map((x) => ({ seq: x.seq, c: parseCents(x.amount), due: x.due, status: x.status }));
}

async function depositId(j: string, seq: number): Promise<number> {
  const r = await env.t.pglite.query<{ id: number }>(
    `SELECT id FROM tax_deposits WHERE jurisdiction = $1 AND period_start = '2026-12-01' AND seq = $2 AND status <> 'superseded'`,
    [j, seq],
  );
  return r.rows[0]!.id;
}

function followUps(res: { body: Record<string, unknown> }): string[] {
  return [
    ...((res.body.lateIssue as { followUps?: string[] } | undefined)?.followUps ?? []),
  ].sort();
}

async function ilDecDraft(gross = 400_000) {
  const emp = await makeEmployee(env.t, { grossCents: gross, state: "IL" });
  const d = await draft(env.t, emp, "2026-12", "2026-12-31");
  await approve(env, d.publicId);
  return { emp, ...d };
}

async function entryCents(publicId: string): Promise<Record<string, number>> {
  const run = await runByPublicId(env.t, publicId);
  const rows = await env.t.db.select().from(payrollEntries).where(eq(payrollEntries.runId, run.id));
  return Object.fromEntries(rows.map((r) => [r.category, parseCents(r.amount)]));
}

// ---------------------------------------------------------------- EF-4

async function storedWorksheet(formType: "941" | "940" | "w2_w3", quarter: number) {
  const rows = await env.t.db
    .select()
    .from(taxFilings)
    .where(
      and(
        eq(taxFilings.formType, formType),
        eq(taxFilings.year, 2026),
        eq(taxFilings.quarter, quarter),
      ),
    );
  return rows[0]!;
}

async function stateSums2026(state: string): Promise<{ wages: number; tax: number }> {
  const r = await env.t.db
    .select({
      category: payrollEntries.category,
      total: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)::numeric(14,2)::text`,
    })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .where(
      and(
        eq(payrollRuns.status, "issued"),
        sql`${payrollRuns.payDate} BETWEEN '2026-01-01' AND '2026-12-31'`,
        sql`${payrollRuns.runSnapshot}#>>'{inputs,state,workState}' = ${state}`,
      ),
    )
    .groupBy(payrollEntries.category);
  const by = Object.fromEntries(r.map((x) => [x.category, parseCents(x.total)]));
  return { wages: by.gross_pay ?? 0, tax: by.state_withholding ?? 0 };
}

describe("EF-4 a late issue refreshes the unfiled 941, 940 and W-3 in its transaction", () => {
  it("two late December runs (SS wage-base and FUTA $7,000 crossings): worksheets = fresh compute = auditor oracle", async () => {
    // --- history (oracle entries) ---
    const e3 = await makeEmployee(env.t, { grossCents: 1_600_000, state: "IL", label: "EF4 High" });
    const e2 = await makeEmployee(env.t, {
      grossCents: 400_000,
      state: "IL",
      hireDate: "2026-11-01",
      label: "EF4 Hire",
    });
    const e3Year = oracleYear(1_600_000, 1, 12, "IL1");
    for (let m = 1; m <= 11; m += 1) {
      const ym = `2026-${String(m).padStart(2, "0")}`;
      await history(env.t, e3, ym, `${ym}-15`, e3Year[m - 1]!, "IL");
    }
    const e2Nov = oracleRun2026(400_000, 0, "IL1");
    const e2Dec = oracleRun2026(400_000, 400_000, "IL1");
    await history(env.t, e2, "2026-11", "2026-11-15", e2Nov, "IL");
    const e3Dec = e3Year[11]!;

    const d3 = await draft(env.t, e3, "2026-12", "2026-12-31");
    const d2 = await draft(env.t, e2, "2026-12", "2026-12-31");
    await approve(env, d3.publicId);
    await approve(env, d2.publicId);

    // --- ready filings with worksheets computed before the late runs ---
    env.setNow("2027-01-20T10:00:00Z");
    await syncFilings(deps(), { today: "2027-01-20" });
    await syncAnnualFilings(deps(), { today: "2027-01-20" });
    const q4Before = (await storedWorksheet("941", 4)).worksheet as Record<string, unknown>;
    const w3Before = (await storedWorksheet("w2_w3", 0)).worksheet as Record<string, unknown>;
    expect({
      line2: q4Before.line2Wages,
      line5a: q4Before.line5aTaxableSsWages,
      box1: w3Before.box1Wages,
      box3: w3Before.box3SsWages,
    }).toEqual({ line2: "36000.00", line5a: "36000.00", box1: "180000.00", box3: "180000.00" });

    // --- late issue 1: E3 December (SS wage base crossed in this run) ---
    expect(e3Dec.netCents).toBe(1_155_990);
    const { value: r3, stmts } = await record(() =>
      issue(env, d3.publicId, latePayment(e3Dec.netCents, [notFiled("IL")])),
    );
    expect(r3.status, r3.raw).toBe(200);
    expect(await entryCents(d3.publicId)).toEqual({
      gross_pay: 1_600_000,
      federal_withholding: 290_117,
      social_security: 52_700,
      medicare: 23_200,
      state_withholding: 77_993,
      net_pay: 1_155_990,
      employer_social_security: 52_700,
      employer_medicare: 23_200,
      employer_futa: 0,
    });
    const issueTx = txOf(stmts, "run_update");
    const filingUpdates = stmts.filter(
      (s) => s.tx === issueTx && labelsIn([s], s.tx ?? -1).includes("filings_update"),
    ).length;
    expect({ issueTx: issueTx !== null, refreshedInIssueTx: filingUpdates }).toEqual({
      issueTx: true,
      refreshedInIssueTx: 3,
    });
    const mid941 = (await storedWorksheet("941", 4)).worksheet as Record<string, string>;
    const mid940 = (await storedWorksheet("940", 0)).worksheet as Record<string, string>;
    const midW3 = (await storedWorksheet("w2_w3", 0)).worksheet as Record<string, string>;
    expect({
      q4line2: mid941.line2Wages,
      q4line3: mid941.line3FederalWithheld,
      q4line5a: mid941.line5aTaxableSsWages,
      f940line3: mid940.line3TotalPayments,
      f940line7: mid940.line7FutaTaxableWages,
      w3box1: midW3.box1Wages,
      w3box3: midW3.box3SsWages,
      w3box5: midW3.box5MedicareWages,
    }).toEqual({
      q4line2: "52000.00",
      q4line3: "9001.84",
      q4line5a: "44500.00",
      f940line3: "196000.00",
      f940line7: "11000.00",
      w3box1: "196000.00",
      w3box3: "188500.00",
      w3box5: "196000.00",
    });

    // --- late issue 2: E2 December (FUTA $7,000 crossed in this run) ---
    expect(e2Dec.netCents).toBe(320_974);
    const r2 = await issue(env, d2.publicId, latePayment(e2Dec.netCents, [notFiled("IL")]));
    expect(r2.status, r2.raw).toBe(200);
    expect(await entryCents(d2.publicId)).toEqual({
      gross_pay: 400_000,
      federal_withholding: 29_833,
      social_security: 24_800,
      medicare: 5_800,
      state_withholding: 18_593,
      net_pay: 320_974,
      employer_social_security: 24_800,
      employer_medicare: 5_800,
      employer_futa: 1_800,
    });

    const row941 = await storedWorksheet("941", 4);
    const row940 = await storedWorksheet("940", 0);
    const rowW3 = await storedWorksheet("w2_w3", 0);
    // Stored = a fresh compute that includes both runs.
    expect(row941.worksheet).toEqual(
      await computeWorksheet(env.t.db, 2026, 4, { filingId: row941.id }),
    );
    expect(row940.worksheet).toEqual(await compute940Worksheet(env.t.db, 2026));
    expect(rowW3.worksheet).toEqual(await computeW3Worksheet(env.t.db, 2026));

    // Stored = the auditor's oracle.
    const all = [...e3Year, e2Nov, e2Dec];
    const q4 = [...e3Year.slice(9, 12), e2Nov, e2Dec];
    const ssWagesQ4 = sum(q4, "ssWagesCents");
    const grossQ4 = sum(q4, "grossCents");
    const w941 = row941.worksheet as Record<string, unknown>;
    const w940 = row940.worksheet as Record<string, unknown>;
    const w3 = rowW3.worksheet as Record<string, unknown>;
    expect({
      line2: w941.line2Wages,
      line3: w941.line3FederalWithheld,
      line5aWages: w941.line5aTaxableSsWages,
      line5aTax: w941.line5aTax,
      line5cWages: w941.line5cTaxableMedicareWages,
      line5cTax: w941.line5cTax,
      line6: w941.line6TotalTaxes,
      line16: w941.line16,
    }).toEqual({
      line2: money(grossQ4), // 56000.00
      line3: money(sum(q4, "fitCents")), // 9300.17
      line5aWages: money(ssWagesQ4), // 48500.00
      line5aTax: money(Math.round((ssWagesQ4 * 124) / 1000)), // 6014.00
      line5cWages: money(grossQ4), // 56000.00
      line5cTax: money(Math.round((grossQ4 * 29) / 1000)), // 1624.00
      line6: "16938.17",
      line16: {
        month1: money(fedDepositCents(e3Year[9]!)), // 5349.17
        month2: money(fedDepositCents(e3Year[10]!) + fedDepositCents(e2Nov)), // 6259.50
        month3: money(fedDepositCents(e3Dec) + fedDepositCents(e2Dec)), // 5329.50
        deMinimis: false,
      },
    });
    expect([money(grossQ4), money(ssWagesQ4), money(sum(q4, "fitCents"))]).toEqual([
      "56000.00",
      "48500.00",
      "9300.17",
    ]);
    const box3 = Math.min(sum(e3Year, "grossCents"), 18_450_000) + 800_000;
    expect({
      count: w3.employeeCount,
      box1: w3.box1Wages,
      box2: w3.box2FederalWithheld,
      box3: w3.box3SsWages,
      box4: w3.box4SsTax,
      box5: w3.box5MedicareWages,
      box6: w3.box6MedicareTax,
    }).toEqual({
      count: 2,
      box1: money(sum(all, "grossCents")), // 200000.00
      box2: money(sum(all, "fitCents")), // 35410.70
      box3: money(box3), // 192500.00
      box4: money(sum(all, "ssCents")), // 11935.00
      box5: money(sum(all, "grossCents")), // 200000.00
      box6: money(sum(all, "medCents")), // 2900.00
    });
    expect([
      w3.box1Wages,
      w3.box2FederalWithheld,
      w3.box3SsWages,
      w3.box4SsTax,
      w3.box6MedicareTax,
    ]).toEqual(["200000.00", "35410.70", "192500.00", "11935.00", "2900.00"]);
    // W-3 boxes 16/17: the app's W-3 worksheet has no state boxes; the
    // figures they would carry are the IL sums of the year's issued entries.
    expect(await stateSums2026("IL")).toEqual({
      wages: sum(all, "grossCents"), // 200000.00
      tax: sum(all, "stateCents"), // 9731.02
    });
    expect(sum(all, "stateCents")).toBe(973_102);
    expect({
      line3: w940.line3TotalPayments,
      line7: w940.line7FutaTaxableWages,
      line8: w940.line8FutaTax,
      frozen: w940.futaTaxPerFrozenEntries,
      delta: w940.roundingDelta,
    }).toEqual({
      line3: "200000.00",
      line7: money(700_000 + 700_000), // 14000.00
      line8: "84.00",
      frozen: money(sum(all, "futaCents")), // 84.00
      delta: "0.00",
    });
  });
});

// ---------------------------------------------------------------- EF-5

describe("EF-5 deposited federal and IL December rows -> seq 1 rows inside the issue transaction", () => {
  it("federal seq 1 pending 910.33 and IL seq 1 pending 185.93, due 2027-01-15; followUps both deposit_shortfall codes; shortfall audits by the admin", async () => {
    const b = await makeEmployee(env.t, { grossCents: 250_000, state: "IL" });
    await history(env.t, b, "2026-12", "2026-12-15", B, "IL");
    await syncDeposits(deps(), { today: "2027-01-05" });
    for (const j of ["federal", "IL"]) {
      await markDeposited(
        deps(),
        await depositId(j, 0),
        { depositedOn: "2027-01-08", eftpsConfirmation: `SYN-EF5-${j}` },
        "auditor",
      );
    }
    const a = await ilDecDraft();
    env.setNow("2027-01-10T10:00:00Z");
    const { value: res, stmts } = await record(() =>
      issue(env, a.publicId, latePayment(A.netCents, [notFiled("IL")])),
    );
    expect(res.status, res.raw).toBe(200);
    expect(followUps(res)).toEqual([
      "deposit_shortfall:IL:2026-12-01",
      "deposit_shortfall:federal:2026-12-01",
    ]);
    expect({ federal: await live("federal"), il: await live("IL") }).toEqual({
      federal: [
        { seq: 0, c: fedDepositCents(B), due: "2027-01-15", status: "deposited" }, // 500.83
        { seq: 1, c: fedDepositCents(A), due: "2027-01-15", status: "pending" }, // 910.33
      ],
      il: [
        { seq: 0, c: B.stateCents, due: "2027-01-15", status: "deposited" }, // 111.68
        { seq: 1, c: A.stateCents, due: "2027-01-15", status: "pending" }, // 185.93
      ],
    });
    expect([fedDepositCents(A), A.stateCents, fedDepositCents(B), B.stateCents]).toEqual([
      91_033, 18_593, 50_083, 11_168,
    ]);
    const issueTx = txOf(stmts, "run_update");
    expect({
      issueTx: issueTx !== null,
      insertsInIssueTx: stmts.filter(
        (s) => s.tx === issueTx && labelsIn([s], s.tx ?? -1).includes("deposits_insert"),
      ).length,
    }).toEqual({ issueTx: true, insertsInIssueTx: 2 });
    const sf = await audits(env.t, "tax_deposit.shortfall_created");
    expect(
      sf
        .map((x) => ({ actorId: x.actorId, after: x.after }))
        .sort((p, q) =>
          String((p.after as { jurisdiction: string }).jurisdiction) <
          String((q.after as { jurisdiction: string }).jurisdiction)
            ? -1
            : 1,
        ),
    ).toEqual([
      {
        actorId: env.adminId,
        after: {
          jurisdiction: "IL",
          periodStart: "2026-12-01",
          periodKind: "month",
          seq: 1,
          cents: 18_593,
        },
      },
      {
        actorId: env.adminId,
        after: {
          jurisdiction: "federal",
          periodStart: "2026-12-01",
          periodKind: "month",
          seq: 1,
          cents: 91_033,
        },
      },
    ]);
    const late = await audits(env.t, "run.issued_late", a.publicId);
    const auditFollowUps =
      (late[0]?.after as { followUps?: string[] } | null | undefined)?.followUps ?? [];
    expect([...auditFollowUps].sort()).toEqual(followUps(res));
  });
});

// ---------------------------------------------------------------- EF-8

describe("EF-8 no December federal row yet, issued after its due date", () => {
  it("no state: seq 0 federal row inserted 'overdue' (910.33, due 2027-01-15) in the issue tx; followUps [deposit_overdue:federal:2026-12-01]", async () => {
    const emp = await makeEmployee(env.t, { grossCents: 400_000, state: null });
    const d = await draft(env.t, emp, "2026-12", "2026-12-31");
    await approve(env, d.publicId);
    env.setNow("2027-01-20T10:00:00Z");
    const { value: res, stmts } = await record(() =>
      issue(env, d.publicId, latePayment(NONE.netCents, [])),
    );
    expect(res.status, res.raw).toBe(200);
    expect(followUps(res)).toEqual(["deposit_overdue:federal:2026-12-01"]);
    expect(await live("federal")).toEqual([
      { seq: 0, c: fedDepositCents(NONE), due: "2027-01-15", status: "overdue" },
    ]);
    const issueTx = txOf(stmts, "run_update");
    expect(txOf(stmts, "deposits_insert")).toBe(issueTx);
  });

  it("EF-8b (auditor reading): IL employee -> IL seq 0 row 185.93 inserted overdue too; followUps carry both deposit_overdue codes", async () => {
    const a = await ilDecDraft();
    env.setNow("2027-01-20T10:00:00Z");
    const res = await issue(env, a.publicId, latePayment(A.netCents, [notFiled("IL")]));
    expect(res.status, res.raw).toBe(200);
    expect(followUps(res)).toEqual([
      "deposit_overdue:IL:2026-12-01",
      "deposit_overdue:federal:2026-12-01",
    ]);
    expect({ federal: await live("federal"), il: await live("IL") }).toEqual({
      federal: [{ seq: 0, c: 91_033, due: "2027-01-15", status: "overdue" }],
      il: [{ seq: 0, c: 18_593, due: "2027-01-15", status: "overdue" }],
    });
  });

  it("EF-8c (auditor): federal seq 0 already overdue (frozen) -> seq 1 overdue for the late run only; code is deposit_shortfall, not deposit_overdue", async () => {
    const b = await makeEmployee(env.t, { grossCents: 250_000, state: null });
    await history(env.t, b, "2026-12", "2026-12-15", oracleRun2026(250_000, 0, "none"), null);
    await syncDeposits(deps(), { today: "2027-01-16" }); // seq 0 500.83 -> overdue
    const emp = await makeEmployee(env.t, { grossCents: 400_000, state: null });
    const d = await draft(env.t, emp, "2026-12", "2026-12-31");
    await approve(env, d.publicId);
    env.setNow("2027-01-20T10:00:00Z");
    const res = await issue(env, d.publicId, latePayment(NONE.netCents, []));
    expect(res.status, res.raw).toBe(200);
    expect(followUps(res)).toEqual(["deposit_shortfall:federal:2026-12-01"]);
    expect(await live("federal")).toEqual([
      { seq: 0, c: 50_083, due: "2027-01-15", status: "overdue" },
      { seq: 1, c: 91_033, due: "2027-01-15", status: "overdue" },
    ]);
  });
});

describe("EF-8d (PL review round) federal seq 0 still PENDING after its due date", () => {
  it("pending 500.83 due 2027-01-15, issued late 2027-01-16 before the nightly flip: seq 0 raised to 1,411.16 AND flipped 'overdue' in the issue tx; followUps [deposit_overdue:federal:2026-12-01]", async () => {
    // Auditor oracle: B = 2,500.00 run -> 500.83 federal (EF-8c); the late
    // 4,000.00 run adds 910.33 (298.33 + 2 x 248.00 + 2 x 58.00) = 1,411.16.
    const b = await makeEmployee(env.t, { grossCents: 250_000, state: null });
    await history(env.t, b, "2026-12", "2026-12-15", oracleRun2026(250_000, 0, "none"), null);
    await syncDeposits(deps(), { today: "2027-01-10" });
    expect(await live("federal")).toEqual([
      { seq: 0, c: 50_083, due: "2027-01-15", status: "pending" },
    ]);
    const emp = await makeEmployee(env.t, { grossCents: 400_000, state: null });
    const d = await draft(env.t, emp, "2026-12", "2026-12-31");
    await approve(env, d.publicId);
    env.setNow("2027-01-16T10:00:00Z");
    const { value: res, stmts } = await record(() =>
      issue(env, d.publicId, latePayment(NONE.netCents, [])),
    );
    expect(res.status, res.raw).toBe(200);
    expect(fedDepositCents(NONE)).toBe(91_033);
    expect({
      followUps: followUps(res),
      federal: await live("federal"),
    }).toEqual({
      followUps: ["deposit_overdue:federal:2026-12-01"],
      federal: [{ seq: 0, c: 50_083 + 91_033, due: "2027-01-15", status: "overdue" }],
    });
    const issueTx = txOf(stmts, "run_update");
    const depositWrites = stmts.filter(
      (x) => x.tx !== null && /^\s*(update|insert\s+into)\s+"?tax_deposits"?/i.test(x.text),
    );
    expect({
      wrote: depositWrites.length > 0,
      allInIssueTx: depositWrites.every((x) => x.tx === issueTx),
    }).toEqual({ wrote: true, allInIssueTx: true });
    const late = await audits(env.t, "run.issued_late", d.publicId);
    expect((late[0]?.after as { followUps?: string[] } | undefined)?.followUps).toEqual([
      "deposit_overdue:federal:2026-12-01",
    ]);
  });
});

// ---------------------------------------------------------------- EF-9

describe("EF-9 the IL unit cannot be planned", () => {
  it("run issued; no IL row written; followUps has deposit_sync_deferred:IL; the next syncDeposits reports IL:2026-Q4", async () => {
    // Another IL run in October with a NEGATIVE state withholding entry makes
    // IL 2026-Q4 a data error (planStateQuarter throws invalid_amount).
    const bad = await makeEmployee(env.t, { grossCents: 100_000, state: "IL" });
    await env.t.db.insert(payrollRuns).values({
      employeeId: bad.id,
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      payDate: "2026-10-15",
      status: "issued",
      runSnapshot: { inputs: { state: { workState: "IL" } } },
      createdBy: "pay-193-l4-ef9",
    });
    const badRun = (
      await env.t.db
        .select({ id: payrollRuns.id })
        .from(payrollRuns)
        .where(eq(payrollRuns.employeeId, bad.id))
    )[0]!;
    await env.t.db.insert(payrollEntries).values([
      { runId: badRun.id, category: "federal_withholding", amount: "50.00" },
      { runId: badRun.id, category: "state_withholding", amount: "-90.00" },
    ]);

    const a = await ilDecDraft();
    env.setNow("2027-01-10T10:00:00Z");
    const res = await issue(env, a.publicId, latePayment(A.netCents, [notFiled("IL")]));
    expect(res.status, res.raw).toBe(200);
    expect({
      runStatus: (await runByPublicId(env.t, a.publicId)).status,
      followUps: followUps(res),
      ilRows: (await env.t.pglite.query(`SELECT id FROM tax_deposits WHERE jurisdiction = 'IL'`))
        .rows.length,
      federalDec: await live("federal"),
    }).toEqual({
      runStatus: "issued",
      followUps: ["deposit_sync_deferred:IL"],
      ilRows: 0,
      federalDec: [{ seq: 0, c: 91_033, due: "2027-01-15", status: "pending" }],
    });
    const tick = await syncDeposits(deps(), { today: "2027-01-10" });
    expect({
      failedUnits: tick.failedUnits,
      reported: (await audits(env.t, "tax_deposit.sync_failed", "IL:2026-Q4")).length,
    }).toEqual({ failedUnits: 1, reported: 1 });
  });
});

// ---------------------------------------------------------------- EF-10

describe("EF-10 lock order (recording spy)", () => {
  it("late issue: employee -> FILING_CLOSE_LOCK -> SYNC_LOCK in the issue transaction; no earlier lock after a later one", async () => {
    const a = await ilDecDraft();
    env.setNow("2027-01-10T10:00:00Z");
    const { value: res, stmts } = await record(() =>
      issue(env, a.publicId, latePayment(A.netCents, [notFiled("IL")])),
    );
    expect(res.status, res.raw).toBe(200);
    const tx = txOf(stmts, "run_update");
    expect(tx).not.toBeNull();
    const labels = labelsIn(stmts, tx!);
    const first = (l: string) => labels.indexOf(l as never);
    const lastIndexOf = (l: string) => labels.lastIndexOf(l as never);
    expect({
      employee: first("employee_lock") >= 0,
      filingAfterEmployee: first("filing_close_lock") > first("employee_lock"),
      syncAfterFiling: first("sync_lock") > first("filing_close_lock"),
      noEmployeeLockAfterFiling: lastIndexOf("employee_lock") < first("filing_close_lock"),
      noEarlierLockAfterSync:
        lastIndexOf("employee_lock") < first("sync_lock") &&
        lastIndexOf("filing_close_lock") < first("sync_lock"),
    }).toEqual({
      employee: true,
      filingAfterEmployee: true,
      syncAfterFiling: true,
      noEmployeeLockAfterFiling: true,
      noEarlierLockAfterSync: true,
    });
  });

  it("past pay date, not late (paid 2026-04-20, today 2026-05-02, no state): FILING_CLOSE_LOCK but no SYNC_LOCK", async () => {
    const emp = await makeEmployee(env.t, { grossCents: 400_000, state: null });
    const d = await draft(env.t, emp, "2026-04", "2026-04-20");
    await approve(env, d.publicId);
    env.setNow("2026-05-02T10:00:00Z");
    const { value: res, stmts } = await record(() => issue(env, d.publicId));
    expect(res.status, res.raw).toBe(200);
    const seen = allLabels(stmts);
    expect({ filing: seen.has("filing_close_lock"), sync: seen.has("sync_lock") }).toEqual({
      filing: true,
      sync: false,
    });
  });

  it("future pay date (paid 2026-05-15, today 2026-05-02): neither FILING_CLOSE_LOCK nor SYNC_LOCK", async () => {
    const emp = await makeEmployee(env.t, { grossCents: 400_000, state: "IL" });
    const d = await draft(env.t, emp, "2026-05", "2026-05-15");
    await approve(env, d.publicId);
    env.setNow("2026-05-02T10:00:00Z");
    const { value: res, stmts } = await record(() => issue(env, d.publicId));
    expect(res.status, res.raw).toBe(200);
    const seen = allLabels(stmts);
    expect({
      employee: seen.has("employee_lock"),
      filing: seen.has("filing_close_lock"),
      sync: seen.has("sync_lock"),
    }).toEqual({ employee: true, filing: false, sync: false });
  });
});

/**
 * Spec 26 (PAY-173) §8 — stale drafts (D4), out-of-order issue (D6,
 * ytd_order_conflict) and not-late issue guards (PAY-193 L4).
 * GUARDRAILS scenario classes: (a) a setting changing after generation, (b)
 * data written by the previous release, (c) re-running / parallel issue,
 * (d) void and regenerate, (e) year boundaries. The D9 block is now the
 * PAY-193 L4 "LI guard" set (past_pay_date_other_year was removed).
 *
 * Every test that issues injects "now" (withClock); D9 converts it to the
 * company's local date via config.appTz (APP_TZ, Europe/Madrid here).
 * Money in integer cents; figures from the auditor's worksheet (gross
 * 5,000.00/mo single: FIT 2026 41,833; SS 31,000; Medicare 7,250).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditEvents, payrollEntries, payrollRuns, seedDatabase, type SeedDb } from "@payroll/db";
import { formatCents } from "@payroll/shared";
import { transitionRun } from "../src/payroll/runs.js";
import { snapshotHash, type RunSnapshot } from "../src/payroll/snapshot.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";
import { seedSyntheticFederal2027 } from "./fixtures/synthetic-2027.js";
import {
  approveAndIssue,
  cents,
  createEmployee,
  gen,
  insertIssuedHistoryRun,
  insertW4,
  monthPeriod,
  runRow,
  settle,
  snap,
  transition,
  withClock,
} from "./pay-date-helpers.js";

let t: TestContext;
let ADMIN: Record<string, string>;

beforeAll(async () => {
  t = await createTestApp({ appTz: "Europe/Madrid" });
  await seedDatabase(t.db as unknown as SeedDb);
  await seedSyntheticFederal2027(t.db);
  const admin = await inviteAndOnboard(t, {
    email: "pay-date-drafts-admin@test.dev",
    role: "admin",
  });
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);
}, 120_000);

afterAll(async () => {
  await t.close();
});

async function httpAction(publicId: string, action: "approve" | "issue") {
  const res = await t.app.inject({
    method: "POST",
    url: `/api/admin/payroll-runs/${publicId}/${action}`,
    headers: ADMIN,
    payload: {},
  });
  const body = res.json() as { error?: string; message?: string };
  return { status: res.statusCode, error: body.error ?? null, message: body.message ?? "" };
}

describe("D6 — out-of-order issue in a pay-date year", () => {
  it("T2: Oct period paid 12-04 after the Nov period (paid 12-04) was issued → draft excludes Nov; approve 409 ytd_order_conflict", async () => {
    const emp = await createEmployee(t, 500_000);
    // Jan run uses the whole 2026 FUTA base, so the out-of-order Oct draft
    // accrues no FUTA and generation reaches approve (see the auditor note on
    // the FUTA trigger at generation in the PAY-173 report).
    await insertIssuedHistoryRun(t, emp, monthPeriod("2026-01", "2026-01-15"), {
      gross_pay: 700_000,
      employer_futa: 4_200,
    });
    await insertIssuedHistoryRun(t, emp, monthPeriod("2026-11", "2026-12-04"), {
      gross_pay: 500_000,
      employer_futa: 0,
    });
    const { run } = await gen(t, emp, monthPeriod("2026-10", "2026-12-04"));
    const prior = cents(snap(await runRow(t, run.id)).inputs.priorYtdGross);
    const res = await httpAction(run.publicId, "approve");
    expect({
      prior,
      status: res.status,
      error: res.error,
      namesPayDate: res.message.includes("2026-12-04"),
      saysNothingChanged: res.message.includes("Nothing was approved or issued."),
      tellsFix: res.message.includes(
        "Void this draft and generate it again with the date you actually pay it.",
      ),
      messageHasNoAmounts: !/\d+\.\d{2}/.test(res.message) && !/\$/.test(res.message),
      runStatus: (await runRow(t, run.id)).status,
    }).toEqual({
      prior: 700_000, // Jan only: the Nov run paid 12-04 sorts after (12-04, 10-01)
      status: 409,
      error: "ytd_order_conflict",
      namesPayDate: true,
      saysNothingChanged: true,
      tellsFix: true,
      messageHasNoAmounts: true,
      runStatus: "awaiting_approval", // the refusal's "nothing was approved" holds
    });
  });
});

describe("D4 — stale drafts (fingerprint recompute at approve/issue)", () => {
  it("D-1 (guard, class b): a draft as main writes it (template 1.2.0, no resolution), nothing changed → approve + issue, snapshot byte-for-byte", async () => {
    const emp = await createEmployee(t, 500_000);
    const { run } = await gen(t, emp, monthPeriod("2026-10", "2026-10-15"));
    const legacy = structuredClone(run.runSnapshot) as RunSnapshot & {
      inputs: Record<string, unknown>;
    };
    delete legacy.inputs.resolution;
    legacy.templateVersion = "1.2.0";
    const legacyHash = snapshotHash(legacy);
    await t.db
      .update(payrollRuns)
      .set({ runSnapshot: legacy, snapshotHash: legacyHash })
      .where(eq(payrollRuns.id, run.id));
    const res = await settle(approveAndIssue(t, run.publicId, "2026-10-10T12:00:00Z"));
    const after = await runRow(t, run.id);
    expect({
      ok: res.ok,
      status: after.status,
      hash: after.snapshotHash,
      recomputedHash: snapshotHash(after.runSnapshot as RunSnapshot),
    }).toEqual({ ok: true, status: "issued", hash: legacyHash, recomputedHash: legacyHash });
    expect(after.runSnapshot).toEqual(legacy);
  });

  it("D-2 (class b): main-shaped draft for A's period/pay (2026 tables inside) → approve 409 stale_draft, run unchanged, audited", async () => {
    const emp = await createEmployee(t, 500_000, "Stale Test");
    await insertIssuedHistoryRun(t, emp, monthPeriod("2026-11", "2026-11-15"), {
      gross_pay: 18_200_000,
      net_pay: 18_200_000,
      employer_futa: 4_200,
    });
    // What main 1fbd87e writes for scenario A (auditor worksheet, 2026 tables,
    // period-start YTD 182,000.00): FIT 418.33, SS 155.00, Medicare 72.50, FUTA 0.
    const mainSnapshot = {
      inputs: {
        periodAmount: 5000,
        frequency: "monthly",
        periodsPerYear: 12,
        w4: null,
        taxConfig: {
          jurisdiction: "federal",
          taxYear: 2026,
          standardDeduction: 16100,
          socialSecurityRate: 0.062,
          socialSecurityWageCap: 184500,
          medicareRate: 0.0145,
          medicareAdditionalRate: 0.009,
          medicareAdditionalThreshold: 200000,
          stateWithholdingRate: 0,
          employerSocialSecurityRate: 0.062,
          employerMedicareRate: 0.0145,
          futaRate: 0.006,
          futaWageCap: 7000,
          sutaCreditRate: 0.054,
        },
        brackets: [
          { min: 0, max: 12400, rate: 0.1 },
          { min: 12400, max: 50400, rate: 0.12 },
          { min: 50400, max: 105700, rate: 0.22 },
          { min: 105700, max: 201775, rate: 0.24 },
          { min: 201775, max: 256225, rate: 0.32 },
          { min: 256225, max: 640600, rate: 0.35 },
          { min: 640600, max: null, rate: 0.37 },
        ],
        priorYtdGross: 182000,
        periodStart: "2026-12-01",
        periodEnd: "2026-12-31",
        payDate: "2027-01-05",
        company: { legalName: "Example Corp" },
        employee: { legalName: "Stale Test", preferredName: null },
      },
      result: {
        grossPay: 5000,
        federalWithholding: 418.33,
        socialSecurity: 155,
        medicare: 72.5,
        stateWithholding: 0,
        totalDeductions: 645.83,
        netPay: 4354.17,
        employerSocialSecurity: 155,
        employerMedicare: 72.5,
        employerFUTA: 0,
        totalEmployerCost: 5227.5,
        ytdGross: 187000,
      },
      engineVersion: "0.3.0",
      templateVersion: "1.2.0",
      ytd: {
        gross: 187000,
        federalWithholding: 418.33,
        socialSecurity: 155,
        medicare: 72.5,
        stateWithholding: 0,
        totalDeductions: 645.83,
        netPay: 186354.17,
      },
    } as unknown as RunSnapshot;
    const hash = snapshotHash(mainSnapshot);
    const inserted = await t.db
      .insert(payrollRuns)
      .values({
        employeeId: emp,
        ...monthPeriod("2026-12", "2027-01-05"),
        status: "awaiting_approval",
        runSnapshot: mainSnapshot,
        snapshotHash: hash,
        createdBy: "test-main-shaped",
      })
      .returning();
    const draft = inserted[0]!;
    const entries: [string, number][] = [
      ["gross_pay", 500_000],
      ["federal_withholding", 41_833],
      ["social_security", 15_500],
      ["medicare", 7_250],
      ["state_withholding", 0],
      ["net_pay", 435_417],
      ["employer_social_security", 15_500],
      ["employer_medicare", 7_250],
      ["employer_futa", 0],
    ];
    await t.db
      .insert(payrollEntries)
      .values(
        entries.map(([category, c]) => ({ runId: draft.id, category, amount: formatCents(c) })),
      );

    const res = await httpAction(draft.publicId, "approve");
    const after = await runRow(t, draft.id);
    const audits = await t.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, "run.stale_detected"), eq(auditEvents.entityId, draft.publicId)),
      );
    const fields = ((audits[0]?.after as { fields?: string[] } | null)?.fields ?? []).join(",");
    expect({
      status: res.status,
      error: res.error,
      fieldsTaxConfig: fields.includes("taxConfig"),
      fieldsResult: fields.includes("result"),
      messageHasNoAmounts: !/\d+\.\d{2}/.test(res.message) && !res.message.includes("Stale Test"),
      runStatus: after.status,
      runHash: after.snapshotHash,
    }).toEqual({
      status: 409,
      error: "stale_draft",
      fieldsTaxConfig: true,
      fieldsResult: true,
      messageHasNoAmounts: true,
      runStatus: "awaiting_approval",
      runHash: hash,
    });
  });

  it("D-3 (classes a, d): Oct issued after the Nov draft → issue Nov 409 stale_draft; void + regenerate → issued with Oct in YTD", async () => {
    const emp = await createEmployee(t, 500_000);
    const oct = (await gen(t, emp, monthPeriod("2026-10", "2026-10-15"))).run;
    const nov = (await gen(t, emp, monthPeriod("2026-11", "2026-11-15"))).run;
    await withClock("2026-10-10T12:00:00Z", () => transition(t, nov.publicId, "approve"));
    await approveAndIssue(t, oct.publicId, "2026-10-10T12:00:00Z");
    const stale = await settle(
      withClock("2026-11-10T12:00:00Z", () => transition(t, nov.publicId, "issue")),
    );
    expect({
      ok: stale.ok,
      code: stale.ok ? null : stale.code,
      namesYtd: stale.ok ? false : stale.message.includes("ytd"),
      namesPrior: stale.ok ? false : stale.message.includes("priorYtdGross"),
    }).toEqual({ ok: false, code: "stale_draft", namesYtd: true, namesPrior: true });

    await transition(t, nov.publicId, "void", "stale draft — regenerate");
    const nov2 = (await gen(t, emp, monthPeriod("2026-11", "2026-11-15"))).run;
    const issued = await approveAndIssue(t, nov2.publicId, "2026-11-10T12:00:00Z");
    const s = snap(await runRow(t, nov2.id));
    expect({
      status: issued.status,
      prior: cents(s.inputs.priorYtdGross),
      ytdGross: s.ytd ? cents(s.ytd.gross) : null,
    }).toEqual({ status: "issued", prior: 500_000, ytdGross: 1_000_000 });
  });

  it("D-4 (class a): pay_date edited in the DB after generation → approve 409 stale_draft (payDate)", async () => {
    const emp = await createEmployee(t, 500_000);
    const { run } = await gen(t, emp, monthPeriod("2026-11", "2026-11-15"));
    await t.db.update(payrollRuns).set({ payDate: "2027-01-05" }).where(eq(payrollRuns.id, run.id));
    const res = await settle(
      withClock("2026-11-10T12:00:00Z", () => transition(t, run.publicId, "approve")),
    );
    expect({
      ok: res.ok,
      code: res.ok ? null : res.code,
      namesPayDate: res.ok ? false : res.message.includes("payDate"),
    }).toEqual({ ok: false, code: "stale_draft", namesPayDate: true });
  });

  it("D-5 (class a): replacement W-4 effective on/before min(period end, pay date) added after generation → 409 stale_draft (w4, result)", async () => {
    const emp = await createEmployee(t, 500_000);
    await insertW4(t, emp, { taxYear: 2026, effectiveFrom: "2026-01-01", filedDate: "2025-12-15" });
    const { run } = await gen(t, emp, monthPeriod("2026-11", "2026-11-15"));
    await insertW4(t, emp, {
      taxYear: 2026,
      effectiveFrom: "2026-11-10",
      filedDate: "2026-11-10",
      extraWithholdingCents: 10_000,
    });
    const res = await settle(
      withClock("2026-11-10T12:00:00Z", () => transition(t, run.publicId, "approve")),
    );
    expect({
      ok: res.ok,
      code: res.ok ? null : res.code,
      namesW4: res.ok ? false : res.message.includes("w4"),
      namesResult: res.ok ? false : res.message.includes("result"),
    }).toEqual({ ok: false, code: "stale_draft", namesW4: true, namesResult: true });
  });

  it("D-6a (guard, class c): generating twice is idempotent", async () => {
    const emp = await createEmployee(t, 500_000);
    const first = await gen(t, emp, monthPeriod("2026-10", "2026-10-15"));
    const second = await gen(t, emp, monthPeriod("2026-10", "2026-10-15"));
    expect({ created: second.created, same: second.run.id === first.run.id }).toEqual({
      created: false,
      same: true,
    });
  });

  it("D-6b (class c): two drafts issued in parallel are never both issued with each other's YTD missing", async () => {
    const emp = await createEmployee(t, 500_000);
    const oct = (await gen(t, emp, monthPeriod("2026-10", "2026-10-15"))).run;
    const nov = (await gen(t, emp, monthPeriod("2026-11", "2026-11-15"))).run;
    const outcome = await withClock("2026-10-10T12:00:00Z", async () => {
      await transition(t, oct.publicId, "approve");
      await transition(t, nov.publicId, "approve");
      return Promise.all([
        settle(transition(t, oct.publicId, "issue")),
        settle(transition(t, nov.publicId, "issue")),
      ]);
    });
    const octRow = await runRow(t, oct.id);
    const novRow = await runRow(t, nov.id);
    const bothIssued = octRow.status === "issued" && novRow.status === "issued";
    const novPrior = cents(snap(novRow).inputs.priorYtdGross);
    const codes = outcome.flatMap((r) => (r.ok ? [] : [r.code]));
    expect({
      bothIssuedWithNovMissingOct: bothIssued && novPrior !== 500_000,
      atLeastOneIssued: octRow.status === "issued" || novRow.status === "issued",
      refusalsAreD4orD6: codes.every((c) => c === "stale_draft" || c === "ytd_order_conflict"),
    }).toEqual({
      bothIssuedWithNovMissingOct: false,
      atLeastOneIssued: true,
      refusalsAreD4orD6: true,
    });
  });

  it("D-7 (guard, class d): a voided issued run is not in YTD", async () => {
    const emp = await createEmployee(t, 500_000);
    const oct = await insertIssuedHistoryRun(t, emp, monthPeriod("2026-10", "2026-10-15"), {
      gross_pay: 500_000,
      employer_futa: 3_000,
    });
    await t.db
      .update(payrollRuns)
      .set({ status: "void", voidedAt: new Date(), voidReason: "test: voided after issue" })
      .where(eq(payrollRuns.id, oct.id));
    const { run } = await gen(t, emp, monthPeriod("2026-11", "2026-11-15"));
    expect(cents(snap(await runRow(t, run.id)).inputs.priorYtdGross)).toBe(0);
  });
});

/**
 * PAY-193 L4 removed past_pay_date_other_year (the late-issue path replaces
 * it). P-1 and P-4 (i) are deleted: their cases are now LI-1 and LI-11 in
 * pay-193-l4-late-issue.test.ts. The rest stay as guards: these issues are
 * not late (pay-date quarter open, no monthly-return state), so they issue
 * with no attestation.
 */
describe("LI guard — past or future pay dates that are not late issue without latePayment", () => {
  async function approvedDraft(payDate: string) {
    const emp = await createEmployee(t, 500_000);
    const { run } = await gen(t, emp, monthPeriod("2026-12", payDate));
    return run;
  }
  async function issueAt(publicId: string, instant: string, appTz?: string) {
    return settle(
      withClock(instant, async () => {
        const deps = { db: t.db, config: appTz ? { ...t.config, appTz } : t.config };
        await transitionRun(deps, { publicId, action: "approve", actorId: "test-admin" });
        return transitionRun(deps, { publicId, action: "issue", actorId: "test-admin" });
      }),
    );
  }
  const view = (r: Awaited<ReturnType<typeof issueAt>>) =>
    r.ok
      ? { ok: true, code: null, status: r.value.status }
      : { ok: false, code: r.code, status: null };

  it("LI guard (P-2): paid 2027-01-05, today 2027-01-10 (past, Q1 2027 open) -> issued", async () => {
    const run = await approvedDraft("2027-01-05");
    expect(view(await issueAt(run.publicId, "2027-01-10T12:00:00Z"))).toEqual({
      ok: true,
      code: null,
      status: "issued",
    });
  });

  it("LI guard (P-3): paid 2027-01-05, today 2026-12-20 (future pay date) -> issued", async () => {
    const run = await approvedDraft("2027-01-05");
    expect(view(await issueAt(run.publicId, "2026-12-20T12:00:00Z"))).toEqual({
      ok: true,
      code: null,
      status: "issued",
    });
  });

  it("LI guard (P-4 (ii)): clock 2026-12-31T22:30Z (Madrid 2026-12-31 23:30), paid 2026-12-31 -> issued", async () => {
    const run = await approvedDraft("2026-12-31");
    expect(view(await issueAt(run.publicId, "2026-12-31T22:30:00Z"))).toEqual({
      ok: true,
      code: null,
      status: "issued",
    });
  });

  it("LI guard (P-4b): APP_TZ America/Los_Angeles, clock 2027-01-01T05:00Z (LA 2026-12-31 21:00) -> issued; a UTC/host date would make it late", async () => {
    const run = await approvedDraft("2026-12-31");
    expect(
      view(await issueAt(run.publicId, "2027-01-01T05:00:00Z", "America/Los_Angeles")),
    ).toEqual({
      ok: true,
      code: null,
      status: "issued",
    });
  });
});

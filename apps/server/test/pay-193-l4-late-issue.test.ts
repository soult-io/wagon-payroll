/**
 * PAY-193 L4 — the late-issue path over HTTP (spec D9.2, D9.3, D9.6, D9.7;
 * addendum L4.3–L4.8, L4.11 LI-1…LI-15, EF-1, EF-2, EF-3, EF-6, EF-7, EF-11).
 * Auditor-owned (payroll-calc-auditor), fail-first. The coder may not edit it.
 *
 * Decisions encoded (owner + Product Lead):
 *  - A run is LATE when its pay-date quarter has ended (Q-N2 = B, brain
 *    #3940) or its pay-date month has ended and the work state files monthly
 *    returns that month (Q-S2). `today` = localDate(clock(), APP_TZ).
 *  - A late issue needs `latePayment` { attestationVersion: 1, netPayCents,
 *    stateReturns }. Check order: pay_period_filed -> ytd_order_conflict ->
 *    stale_draft -> late_payment_confirmation_required ->
 *    late_payment_incomplete -> state_return_filed ->
 *    late_payment_amount_mismatch. All 409; malformed body -> 400
 *    { error: "invalid_body" } with nothing else.
 *  - Copy: /private/tmp/wagon-pay193-l4-copy.md final strings with the
 *    Product Lead amendments of 2026-10-03 (attestation monthly-depositor
 *    sentence, amount-mismatch sentence, no-income-tax variant chosen by the
 *    state config kind 'none' with `Choose "No, not filed".`). {payDate} is
 *    the long US date ("December 31, 2026"); {netPay} is left literal in the
 *    409 and filled ("$3,209.74") in the audit row.
 *  - w2_changed employee mail only when the year's W-2 is available, the
 *    employee was FURNISHED a W-2 for the year with different figures
 *    (PAY-206: a w2_furnishings row whose hash differs from the current
 *    figures; the w2_available notified-years proxy no longer gates it),
 *    and the employee has a login.
 *
 * Review round (Product Lead decisions 2026-10-03, copy file "Product Lead
 * amendments" + "round 2", round 2 overriding amendment 7):
 *  - lateIssueAllowed() false FAILS CLOSED: 409 late_issue_not_supported
 *    {error,message,payDate}; nothing written (LI-16). Seam: the test mocks
 *    `lateIssueAllowed` exported by src/filings/closing-filings.ts; runs.ts
 *    must call it through that module export (any arguments are ignored by
 *    the mock; a sync boolean or a Promise<boolean> both work if awaited).
 *  - The no-income-tax variant comes from the run SNAPSHOT's
 *    inputs.state.kind, not the live state config (LI-17).
 *  - stateAttestationText lines are `${question} Answer: ${answer}` (LI-2).
 *  - late_payment_incomplete with no state questions: the "out of date"
 *    message (LI-18).
 *  - LI-7: a wrong amount first (409 mismatch), then the right one; no
 *    netPayCents key or value in the log.
 *  - w2_changed is split by W-2 electronic-delivery consent
 *    (w2_delivery_consents row, withdrawn_at null): consented -> IMPORTANT
 *    subject first + follow-up w2_changed_notice_sent; not consented ->
 *    paper courtesy notice + follow-up w2_paper_correction_needed. Not
 *    opt-out-able. Template seam: w2Changed(ctx, { taxYear, consented }).
 *
 * Amounts: the auditor's oracle (test/pay-193-oracle.ts, Pub 15-T 2026
 * Worksheet 1A, Pub 15 2026, IL-700-T 2026), never the engine. Main case:
 * IL single, 1 IL-W-4 allowance, 4,000.00/month: FIT 298.33, SS 248.00,
 * Medicare 58.00, IL 185.93 -> net 3,209.74 (320974 cents). No-state / TX /
 * exempt-state 4,000.00: net 3,395.67 (339567).
 *
 * Every test resets the run, filing, deposit, outbox and audit tables and
 * creates its own employees, so the file passes in any order.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import {
  appSettings,
  company,
  companyStateIds,
  emailOutbox,
  notificationSettings,
  stateTaxConfigs,
  taxFilings,
  w2DeliveryConsents,
} from "@payroll/db";
import * as notifications from "@payroll/notifications";
import { renderPayslipPdf, type PayslipSnapshot } from "@payroll/documents";
import { drainOutbox } from "../src/notify/outbox.js";
import { encryptField } from "../src/crypto/field-encryption.js";
import { cents, monthPeriod, gen, runRow, snap } from "./pay-date-helpers.js";
import { oracleRun2026, oracleYear } from "./pay-193-oracle.js";
import {
  approve,
  audits,
  bootL4,
  draft,
  hasAmount,
  history,
  issue,
  type L4Env,
  latePayment,
  longDate,
  makeEmployee,
  monthYear,
  notFiled,
  resetL4,
  runByPublicId,
  runStatus,
} from "./pay-193-l4-harness.js";

/**
 * LI-16 seam: the PAY-119 depositor-schedule hook. Default true (as shipped);
 * LI-16 flips it to false. Every other export of the module is the original.
 */
const lateGate = vi.hoisted(() => ({ allowed: true }));
vi.mock("../src/filings/closing-filings.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/filings/closing-filings.js")>();
  return { ...mod, lateIssueAllowed: (..._args: unknown[]) => lateGate.allowed };
});

let env: L4Env;

beforeAll(async () => {
  env = await bootL4({ adminEmail: "pay-193-l4-api-admin@test.dev", logLevel: "trace" });
  // Spec 24 (PAY-116) S24-D3: a 2026 W-2 with IL tax withheld and no box 15
  // ID source is blocked (missing_state_id). The IL fixtures here exercise
  // the late-issue and W-2 follow-up paths, so the company has a synthetic
  // IL withholding account number (FEIN + 000 sequence, IL-941 format).
  const [co] = await env.t.db.select({ id: company.id }).from(company).limit(1);
  await env.t.db.insert(companyStateIds).values({
    companyId: co!.id,
    stateCode: "IL",
    fromTaxYear: 2026,
    stateId: encryptField("000000001000", env.t.config.encryptionKey),
    createdBy: "test",
  });
}, 180_000);

afterAll(async () => {
  await env.t.close();
});

beforeEach(async () => {
  lateGate.allowed = true;
  await resetL4(env.t);
});

// ---------------------------------------------------------------- oracle

const A = oracleRun2026(400_000, 0, "IL1"); // net 320974
const N = oracleRun2026(400_000, 0, "none"); // net 339567
const NET_IL = 320_974;
const NET_NONE = 339_567;

// ---------------------------------------------------------------- copy (final, with PL amendments)

const P1 =
  "The pay date is the day the money was in your employee's account and they could spend it, not the day you sent it and not the date on the pay stub.";

function attestationText(payDate: string, netPay = "{netPay}"): string {
  return (
    `${P1}\n\n` +
    `I paid ${netPay} to this employee on ${longDate(payDate)}, and that is the day the money was in their account. ` +
    "My business is a monthly schedule depositor for federal payroll taxes: each month's taxes are due by the 15th of the following month. " +
    "Wagon Payroll supports monthly depositors only."
  );
}

function confirmMessage(payDate: string): string {
  return `This payroll's pay date, ${longDate(payDate)}, is in a tax period that has ended. To add it to ${payDate.slice(0, 4)}, confirm the date and amount you paid, and that the related state returns aren't filed yet.`;
}

const INCOMPLETE = (stateList: string) =>
  `Answer every question for each state on this payroll (${stateList}). Nothing was issued.`;

const STATE_FILED = (stateList: string) =>
  `Nothing was issued. You said a return or report for ${stateList} that covers this pay date is already filed. Adding this payroll means correcting that filing with a state correction form, which Wagon Payroll doesn't prepare. Keep the pay date as it is. Keep your own record of this payment, and make the correction outside Wagon Payroll or with your tax preparer.`;

const MISMATCH =
  "Nothing was issued. The amount you typed doesn't match this payroll's net pay. Check it against your bank record, including cents. If you paid a different amount, the wages and taxes for that payment may be different from this payroll, and Wagon Payroll can't record it as it is. Talk to your tax preparer before you issue it.";

const STATE_NAME: Record<string, string> = {
  IL: "Illinois",
  MD: "Maryland",
  TX: "Texas",
  AL: "Alabama",
};

function quarterLabel(payDate: string): string {
  return `Q${Math.ceil(Number(payDate.slice(5, 7)) / 3)} ${payDate.slice(0, 4)}`;
}

/** Server question strings (copy 1.7 + PL amendment 3). `monthly` = state listed for that month. */
function questions(state: string, payDate: string, o: { monthly?: boolean; none?: boolean } = {}) {
  const name = STATE_NAME[state]!;
  const quarter = quarterLabel(payDate);
  const period = o.monthly ? `${monthYear(payDate)} or ${quarter}` : quarter;
  const year = payDate.slice(0, 4);
  return {
    jurisdiction: state,
    withholdingReturn: o.none
      ? `${name} has no state income tax withholding return. Choose "No, not filed".`
      : `Have you filed your ${name} income tax withholding return for ${period}?`,
    suiWageReport: `Have you filed your ${name} unemployment insurance (SUI) wage report for ${quarter}?`,
    annualReconciliation: o.none
      ? `${name} has no state income tax W-2 filing. Choose "No, not filed".`
      : `Have you filed your ${name} year-end withholding reconciliation or W-2s with the state for ${year}?`,
  };
}

// ---------------------------------------------------------------- fixtures

const JAN_10_2027 = "2027-01-10T10:00:00Z";

/** IL employee (with login) and an APPROVED engine draft. */
async function ilDraft(payDate = "2026-12-31", withUser = true) {
  const emp = await makeEmployee(env.t, { grossCents: 400_000, state: "IL", withUser });
  const d = await draft(env.t, emp, payDate.slice(0, 7), payDate);
  await approve(env, d.publicId);
  return { emp, ...d };
}

async function outboxCount(): Promise<number> {
  return (await env.t.db.select({ id: emailOutbox.id }).from(emailOutbox)).length;
}

async function outboxOf(eventType: string) {
  return env.t.db.select().from(emailOutbox).where(eq(emailOutbox.eventType, eventType));
}

/**
 * PAY-206: the employee was furnished a W-2 for `year` whose figures differ
 * from today's (a raw w2_furnishings row with a hash that can never match).
 */
async function furnishedEarlier(employeeId: number, year = 2026): Promise<void> {
  await env.t.pglite.query(
    `INSERT INTO w2_furnishings (employee_id, tax_year, boxes_hash, corrected, method)
     VALUES ($1, $2, $3, false, 'backfill')`,
    [employeeId, year, "0".repeat(64)],
  );
}

async function setNotifiedYears(years: number[]): Promise<void> {
  await env.t.db
    .insert(appSettings)
    .values({ key: "w2_available_notified_years", value: years, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [appSettings.key], set: { value: years } });
}

async function putFiling(formType: "941" | "940" | "w2_w3", year: number, quarter: number) {
  await env.t.db.insert(taxFilings).values({
    formType,
    year,
    quarter,
    dueDate: `${year + 1}-01-31`,
    status: "filed",
    worksheet: { synthetic: true },
    worksheetHash: "synthetic",
    filedOn: `${year + 1}-01-02`,
    filingMethod: "synthetic",
    createdBy: "pay-193-l4-test",
  });
}

function keys(o: unknown): string[] {
  return Object.keys(o as object).sort();
}

const REFUSED = "run.late_issue_refused";

// ---------------------------------------------------------------- LI-1 … LI-7 (IL, paid 2026-12-31, today 2027-01-10)

describe("LI-1 late run without latePayment -> 409 late_payment_confirmation_required", () => {
  it("body keys exactly error,message,payDate,attestation,stateJurisdictions; attestation {version,text,stateQuestions}; no amount; nothing written", async () => {
    const d = await ilDraft();
    env.setNow(JAN_10_2027);
    const before = await outboxCount();
    const res = await issue(env, d.publicId);
    expect(res.status, res.raw).toBe(409);
    expect({
      keys: keys(res.body),
      error: res.body.error,
      message: res.body.message,
      payDate: res.body.payDate,
      stateJurisdictions: res.body.stateJurisdictions,
      attestationKeys: keys(res.body.attestation ?? {}),
      attestation: res.body.attestation,
      noAmount: !hasAmount(res.raw),
    }).toEqual({
      keys: ["attestation", "error", "message", "payDate", "stateJurisdictions"],
      error: "late_payment_confirmation_required",
      message: confirmMessage("2026-12-31"),
      payDate: "2026-12-31",
      stateJurisdictions: ["IL"],
      attestationKeys: ["stateQuestions", "text", "version"],
      attestation: {
        version: 1,
        text: attestationText("2026-12-31"),
        stateQuestions: [questions("IL", "2026-12-31")],
      },
      noAmount: true,
    });
    const text = String((res.body.attestation as { text?: string } | undefined)?.text ?? "");
    expect(text.includes(P1) && text.includes("{netPay}")).toBe(true);
    expect({
      status: await runStatus(env.t, d.publicId),
      issueAudits: (await audits(env.t, "run.issue", d.publicId)).length,
      lateAudits: (await audits(env.t, "run.issued_late", d.publicId)).length,
      refused: (await audits(env.t, REFUSED, d.publicId)).length,
      outboxAdded: (await outboxCount()) - before,
    }).toEqual({ status: "approved", issueAudits: 0, lateAudits: 0, refused: 0, outboxAdded: 0 });
  });

  it("LI-1b (auditor): a filed W-2/W-3 for 2026 refuses with pay_period_filed even with a complete latePayment (check 1 first)", async () => {
    const d = await ilDraft();
    await putFiling("w2_w3", 2026, 0);
    env.setNow(JAN_10_2027);
    const res = await issue(env, d.publicId, latePayment(NET_IL, [notFiled("IL")]));
    expect({ status: res.status, error: res.body.error, forms: res.body.forms }).toEqual({
      status: 409,
      error: "pay_period_filed",
      forms: ["w2_w3:2026"],
    });
    expect((await audits(env.t, REFUSED, d.publicId)).length).toBe(0);
  });
});

describe("LI-2 late issue with a complete, correct latePayment", () => {
  it("200 { run, lateIssue: { taxYear: 2026, followUps: [] } }; run.issue late:true; run.issued_late row; payslip mail; snapshot unchanged", async () => {
    const d = await ilDraft();
    env.setNow(JAN_10_2027);
    expect(A.netCents).toBe(NET_IL);
    const res = await issue(env, d.publicId, latePayment(NET_IL, [notFiled("IL")]));
    expect(res.status, res.raw).toBe(200);
    expect(keys(res.body)).toEqual(["lateIssue", "run"]);
    expect(res.body.lateIssue).toEqual({ taxYear: 2026, followUps: [] });
    expect((res.body.run as { status: string }).status).toBe("issued");

    const row = await runByPublicId(env.t, d.publicId);
    expect({ hash: row.snapshotHash, snapshot: row.runSnapshot }).toEqual({
      hash: d.hash,
      snapshot: d.snapshot,
    });

    const issueAudit = await audits(env.t, "run.issue", d.publicId);
    expect(issueAudit.map((a) => a.after)).toEqual([{ status: "issued", late: true }]);

    const late = await audits(env.t, "run.issued_late", d.publicId);
    expect(late).toHaveLength(1);
    const after = late[0]!.after as Record<string, unknown>;
    expect({
      actorId: late[0]!.actorId,
      entity: late[0]!.entity,
      keys: keys(after),
      payDate: after.payDate,
      taxYear: after.taxYear,
      localToday: after.localToday,
      trigger: after.trigger,
      attestationVersion: after.attestationVersion,
      attestationText: after.attestationText,
      netPayCents: after.netPayCents,
      stateReturns: after.stateReturns,
      followUps: after.followUps,
    }).toEqual({
      actorId: env.adminId,
      entity: "payroll_run",
      keys: [
        "attestationText",
        "attestationVersion",
        "followUps",
        "localToday",
        "netPayCents",
        "payDate",
        "stateAttestationText",
        "stateReturns",
        "taxYear",
        "trigger",
      ],
      payDate: "2026-12-31",
      taxYear: 2026,
      localToday: "2027-01-10",
      trigger: "quarter_ended",
      attestationVersion: 1,
      attestationText: attestationText("2026-12-31", "$3,209.74"),
      netPayCents: NET_IL,
      stateReturns: [notFiled("IL")],
      followUps: [],
    });
    // PL review round: each answered question is one line `${question} Answer: ${answer}`.
    const stateLines = String(after.stateAttestationText ?? "").split("\n");
    const q = questions("IL", "2026-12-31");
    expect({
      withholding: stateLines.includes(`${q.withholdingReturn} Answer: No, not filed`),
      sui: stateLines.includes(`${q.suiWageReport} Answer: No, not filed`),
      annual: stateLines.includes(`${q.annualReconciliation} Answer: No, not filed`),
    }).toEqual({ withholding: true, sui: true, annual: true });

    const payslipMails = (await outboxOf("payslip_issued")).filter(
      (m) => m.userId === d.emp.userId,
    );
    expect(payslipMails).toHaveLength(1);
    expect((await audits(env.t, REFUSED, d.publicId)).length).toBe(0);
  });
});

describe("LI-3 amount off by one cent", () => {
  it("409 late_payment_amount_mismatch {error,message,payDate}; no amount in body or refusal audit; run unchanged", async () => {
    const d = await ilDraft();
    env.setNow(JAN_10_2027);
    const res = await issue(env, d.publicId, latePayment(NET_IL + 1, [notFiled("IL")]));
    expect({
      status: res.status,
      keys: keys(res.body),
      error: res.body.error,
      message: res.body.message,
      payDate: res.body.payDate,
      noAmount:
        !hasAmount(res.raw) &&
        !res.raw.includes(String(NET_IL + 1)) &&
        !res.raw.includes(String(NET_IL)),
      runStatus: await runStatus(env.t, d.publicId),
    }).toEqual({
      status: 409,
      keys: ["error", "message", "payDate"],
      error: "late_payment_amount_mismatch",
      message: MISMATCH,
      payDate: "2026-12-31",
      noAmount: true,
      runStatus: "approved",
    });
    const refused = await audits(env.t, REFUSED, d.publicId);
    expect(refused).toHaveLength(1);
    const after = refused[0]!.after as Record<string, unknown>;
    expect({
      actorId: refused[0]!.actorId,
      reason: after.reason,
      payDate: after.payDate,
      onlyAllowedKeys: keys(after).every((k) => ["jurisdictions", "payDate", "reason"].includes(k)),
      noTypedAmount: !JSON.stringify(after).includes(String(NET_IL + 1)),
      noNetPayKey: !("netPayCents" in after),
    }).toEqual({
      actorId: env.adminId,
      reason: "late_payment_amount_mismatch",
      payDate: "2026-12-31",
      onlyAllowedKeys: true,
      noTypedAmount: true,
      noNetPayKey: true,
    });
    expect((await audits(env.t, "run.issue", d.publicId)).length).toBe(0);
  });
});

describe("LI-4 stateReturns do not list exactly the run's jurisdictions", () => {
  it("empty, CA instead of IL, IL twice -> 409 late_payment_incomplete {error,message,payDate,stateJurisdictions:[IL]}; one refusal row each", async () => {
    const d = await ilDraft();
    env.setNow(JAN_10_2027);
    const variants = [[], [notFiled("CA")], [notFiled("IL"), notFiled("IL")]];
    for (const stateReturns of variants) {
      const res = await issue(env, d.publicId, latePayment(NET_IL, stateReturns));
      expect({
        status: res.status,
        keys: keys(res.body),
        error: res.body.error,
        message: res.body.message,
        payDate: res.body.payDate,
        stateJurisdictions: res.body.stateJurisdictions,
      }).toEqual({
        status: 409,
        keys: ["error", "message", "payDate", "stateJurisdictions"],
        error: "late_payment_incomplete",
        message: INCOMPLETE("Illinois"),
        payDate: "2026-12-31",
        stateJurisdictions: ["IL"],
      });
    }
    const refused = await audits(env.t, REFUSED, d.publicId);
    expect(refused.map((r) => (r.after as { reason?: string }).reason)).toEqual([
      "late_payment_incomplete",
      "late_payment_incomplete",
      "late_payment_incomplete",
    ]);
    expect(refused.every((r) => !("netPayCents" in (r.after as object)))).toBe(true);
    expect(await runStatus(env.t, d.publicId)).toBe("approved");
  });

  it("LI-4b (auditor, check order): incomplete beats a wrong amount; state_return_filed beats a wrong amount", async () => {
    const d = await ilDraft();
    env.setNow(JAN_10_2027);
    const incomplete = await issue(env, d.publicId, latePayment(NET_IL + 7, []));
    const filed = await issue(
      env,
      d.publicId,
      latePayment(NET_IL + 7, [{ ...notFiled("IL"), withholdingReturnFiled: true }]),
    );
    expect([incomplete.body.error, filed.body.error]).toEqual([
      "late_payment_incomplete",
      "state_return_filed",
    ]);
  });
});

describe("LI-5 a state return is filed", () => {
  for (const flag of [
    "withholdingReturnFiled",
    "suiWageReportFiled",
    "annualReconciliationFiled",
  ] as const) {
    it(`IL ${flag}: true -> 409 state_return_filed {error,message,payDate,jurisdictions:[IL]}; run unchanged; refusal row`, async () => {
      const d = await ilDraft();
      env.setNow(JAN_10_2027);
      const res = await issue(
        env,
        d.publicId,
        latePayment(NET_IL, [{ ...notFiled("IL"), [flag]: true }]),
      );
      expect({
        status: res.status,
        keys: keys(res.body),
        error: res.body.error,
        message: res.body.message,
        payDate: res.body.payDate,
        jurisdictions: res.body.jurisdictions,
        noAmount: !hasAmount(res.raw),
        runStatus: await runStatus(env.t, d.publicId),
      }).toEqual({
        status: 409,
        keys: ["error", "jurisdictions", "message", "payDate"],
        error: "state_return_filed",
        message: STATE_FILED("Illinois"),
        payDate: "2026-12-31",
        jurisdictions: ["IL"],
        noAmount: true,
        runStatus: "approved",
      });
      const refused = await audits(env.t, REFUSED, d.publicId);
      expect(refused.map((r) => r.after)).toEqual([
        { payDate: "2026-12-31", reason: "state_return_filed", jurisdictions: ["IL"] },
      ]);
    });
  }
});

describe("LI-6 malformed bodies -> 400 { error: 'invalid_body' } only", () => {
  const good = latePayment(NET_IL, [notFiled("IL")]).latePayment;
  const cases: [string, unknown][] = [
    ["netPayCents float", { latePayment: { ...good, netPayCents: 3209.74 } }],
    ["netPayCents negative", { latePayment: { ...good, netPayCents: -1 } }],
    ["netPayCents string", { latePayment: { ...good, netPayCents: "320974" } }],
    ["netPayCents over 1e10", { latePayment: { ...good, netPayCents: 10_000_000_001 } }],
    ["attestationVersion 2", { latePayment: { ...good, attestationVersion: 2 } }],
    ["extra key in latePayment", { latePayment: { ...good, note: "x" } }],
    [
      "lowercase jurisdiction",
      { latePayment: { ...good, stateReturns: [{ ...notFiled("IL"), jurisdiction: "il" }] } },
    ],
    [
      "extra key in a state answer",
      { latePayment: { ...good, stateReturns: [{ ...notFiled("IL"), localFiled: false }] } },
    ],
    [
      "flag not a boolean",
      {
        latePayment: {
          ...good,
          stateReturns: [{ ...notFiled("IL"), suiWageReportFiled: "false" }],
        },
      },
    ],
    [
      "11 state answers",
      { latePayment: { ...good, stateReturns: Array.from({ length: 11 }, () => notFiled("IL")) } },
    ],
    ["unknown top-level key", { ...latePayment(NET_IL, [notFiled("IL")]), confirm: true }],
  ];
  for (const [name, payload] of cases) {
    it(`${name} -> 400, body exactly { error: "invalid_body" }; nothing written`, async () => {
      const d = await ilDraft();
      env.setNow(JAN_10_2027);
      const res = await issue(env, d.publicId, payload);
      expect({ status: res.status, body: res.body }).toEqual({
        status: 400,
        body: { error: "invalid_body" },
      });
      expect({
        runStatus: await runStatus(env.t, d.publicId),
        refused: (await audits(env.t, REFUSED, d.publicId)).length,
      }).toEqual({ runStatus: "approved", refused: 0 });
    });
  }
});

describe("LI-7 the typed amount never reaches the log", () => {
  it("approved late run at trace level: a wrong amount first (409 late_payment_amount_mismatch), then the correct one (200); no 'netPayCents' key and no typed value in the log stream", async () => {
    const d = await ilDraft();
    env.setNow(JAN_10_2027);
    const from = env.logs.length;
    const wrong = await issue(env, d.publicId, latePayment(NET_IL + 3, [notFiled("IL")]));
    const statusAfterWrong = await runStatus(env.t, d.publicId);
    const res = await issue(env, d.publicId, latePayment(NET_IL, [notFiled("IL")]));
    const log = env.logs.slice(from).join("\n");
    expect({
      wrong: wrong.status,
      wrongError: wrong.body.error,
      statusAfterWrong,
      issued: res.status,
      logged: log.includes(`/api/admin/payroll-runs/${d.publicId}/issue`),
      key: log.includes("netPayCents"),
      value: /\b320974\b/.test(log) || /\b320977\b/.test(log),
      dollars:
        log.includes("3209.74") ||
        log.includes("3,209.74") ||
        log.includes("3209.77") ||
        log.includes("3,209.77"),
    }).toEqual({
      wrong: 409,
      wrongError: "late_payment_amount_mismatch",
      statusAfterWrong: "approved",
      issued: 200,
      logged: true,
      key: false,
      value: false,
      dollars: false,
    });
  });
});

// ---------------------------------------------------------------- LI-8 … LI-15 (trigger, states, guards)

describe("LI-8 trigger (ii): the pay-date quarter has ended", () => {
  it("IL paid 2026-03-20: today 2026-03-25 issued without latePayment; today 2026-04-02 -> 409 confirmation required", async () => {
    const early = await ilDraft("2026-03-20");
    const late = await ilDraft("2026-03-20");
    env.setNow("2026-03-25T10:00:00Z");
    const a = await issue(env, early.publicId);
    env.setNow("2026-04-02T10:00:00Z");
    const b = await issue(env, late.publicId);
    expect({
      a: a.status,
      aLateKey: "lateIssue" in a.body,
      b: b.status,
      bError: b.body.error,
      bStates: b.body.stateJurisdictions,
    }).toEqual({
      a: 200,
      aLateKey: false,
      b: 409,
      bError: "late_payment_confirmation_required",
      bStates: ["IL"],
    });
  });
});

describe("LI-9 a no-income-tax state (TX, kind 'none') still gets the state step", () => {
  it("stateJurisdictions [TX]; withholding and annual questions use the kind 'none' variant; issue completes with TX answered", async () => {
    const emp = await makeEmployee(env.t, { grossCents: 400_000, state: "TX" });
    const d = await draft(env.t, emp, "2026-12", "2026-12-31");
    await approve(env, d.publicId);
    env.setNow(JAN_10_2027);
    const res = await issue(env, d.publicId);
    expect({
      status: res.status,
      error: res.body.error,
      states: res.body.stateJurisdictions,
      questions: (res.body.attestation as { stateQuestions?: unknown } | undefined)?.stateQuestions,
    }).toEqual({
      status: 409,
      error: "late_payment_confirmation_required",
      states: ["TX"],
      questions: [questions("TX", "2026-12-31", { none: true })],
    });
    expect(N.netCents).toBe(NET_NONE);
    const done = await issue(env, d.publicId, latePayment(NET_NONE, [notFiled("TX")]));
    expect({ status: done.status, lateIssue: done.body.lateIssue }).toEqual({
      status: 200,
      lateIssue: { taxYear: 2026, followUps: [] },
    });
  });
});

describe("LI-10 monthly-return state (MD): late once the pay-date month has ended", () => {
  it("paid 2026-01-20: Jan 31 issued; Feb 1 -> 409 [MD]; with latePayment issued, trigger month_ended, no federal follow-up while January's federal row is pending", async () => {
    const md1 = await makeEmployee(env.t, { grossCents: 400_000, state: "MD" });
    const md2 = await makeEmployee(env.t, { grossCents: 400_000, state: "MD" });
    const r1 = await draft(env.t, md1, "2026-01", "2026-01-20");
    const r2 = await draft(env.t, md2, "2026-01", "2026-01-20");
    await approve(env, r1.publicId);
    await approve(env, r2.publicId);

    env.setNow("2026-01-31T10:00:00Z");
    const first = await issue(env, r1.publicId);
    expect({ status: first.status, lateKey: "lateIssue" in first.body }).toEqual({
      status: 200,
      lateKey: false,
    });
    // January's federal row as the daily tick leaves it: pending, due 2026-02-16 (Feb 15 is a Sunday).
    await env.t.pglite.query(
      `INSERT INTO tax_deposits (jurisdiction, period_start, amount, due_date, status, created_by)
       VALUES ('federal', '2026-01-01', '910.33', '2026-02-16', 'pending', 'scheduler')`,
    );

    env.setNow("2026-02-01T10:00:00Z");
    const refused = await issue(env, r2.publicId);
    expect({
      status: refused.status,
      error: refused.body.error,
      states: refused.body.stateJurisdictions,
    }).toEqual({ status: 409, error: "late_payment_confirmation_required", states: ["MD"] });

    const done = await issue(env, r2.publicId, latePayment(NET_NONE, [notFiled("MD")]));
    expect({ status: done.status, lateIssue: done.body.lateIssue }).toEqual({
      status: 200,
      lateIssue: { taxYear: 2026, followUps: [] },
    });
    const late = await audits(env.t, "run.issued_late", r2.publicId);
    expect((late[0]?.after as { trigger?: string } | undefined)?.trigger).toBe("month_ended");
    // The pending federal row took the late run's liability (2 x 910.33); no shortfall row.
    const fed = await env.t.pglite.query<{ seq: number; amount: string; status: string }>(
      `SELECT seq, amount::text AS amount, status FROM tax_deposits WHERE jurisdiction = 'federal' AND status <> 'superseded' ORDER BY seq`,
    );
    expect(fed.rows).toEqual([{ seq: 0, amount: "1820.66", status: "pending" }]);
  });
});

describe("LI-11 the month boundary is the company-local date (APP_TZ Europe/Madrid)", () => {
  it("MD paid 2026-01-20: 2026-01-31T23:30Z (Madrid Feb 1) -> 409; 2026-01-31T22:30Z (Madrid Jan 31) -> issued", async () => {
    const a = await makeEmployee(env.t, { grossCents: 400_000, state: "MD" });
    const b = await makeEmployee(env.t, { grossCents: 400_000, state: "MD" });
    const ra = await draft(env.t, a, "2026-01", "2026-01-20");
    const rb = await draft(env.t, b, "2026-01", "2026-01-20");
    await approve(env, ra.publicId);
    await approve(env, rb.publicId);
    env.setNow("2026-01-31T23:30:00Z");
    const x = await issue(env, ra.publicId);
    env.setNow("2026-01-31T22:30:00Z");
    const y = await issue(env, rb.publicId);
    expect([x.status, x.body.error, y.status]).toEqual([
      409,
      "late_payment_confirmation_required",
      200,
    ]);
  });
});

describe("LI-12 a quarterly state inside its open quarter", () => {
  it("TX paid 2026-01-20, today 2026-02-10 -> issued without attestation; no run.issued_late", async () => {
    const emp = await makeEmployee(env.t, { grossCents: 400_000, state: "TX" });
    const d = await draft(env.t, emp, "2026-01", "2026-01-20");
    await approve(env, d.publicId);
    env.setNow("2026-02-10T10:00:00Z");
    const res = await issue(env, d.publicId);
    expect({
      status: res.status,
      lateKey: "lateIssue" in res.body,
      late: (await audits(env.t, "run.issued_late", d.publicId)).length,
      issueAfter: (await audits(env.t, "run.issue", d.publicId)).map((a) => a.after),
    }).toEqual({ status: 200, lateKey: false, late: 0, issueAfter: [{ status: "issued" }] });
  });
});

describe("LI-13 the state question period", () => {
  async function stateQuestionsFor(state: "IL" | "MD" | "AL", payDate: string, today: string) {
    const emp = await makeEmployee(env.t, { grossCents: 400_000, state });
    const d = await draft(env.t, emp, payDate.slice(0, 7), payDate);
    await approve(env, d.publicId);
    env.setNow(today);
    const res = await issue(env, d.publicId);
    expect(res.body.error, res.raw).toBe("late_payment_confirmation_required");
    return (res.body.attestation as { stateQuestions: unknown }).stateQuestions;
  }

  it("MD paid 2026-01-20 seen 2026-02-01: 'January 2026 or Q1 2026'", async () => {
    expect(await stateQuestionsFor("MD", "2026-01-20", "2026-02-01T10:00:00Z")).toEqual([
      questions("MD", "2026-01-20", { monthly: true }),
    ]);
  });

  it("MD paid 2026-03-20 seen 2026-04-02 (quarter rule): still 'March 2026 or Q1 2026' (MD files monthly)", async () => {
    expect(await stateQuestionsFor("MD", "2026-03-20", "2026-04-02T10:00:00Z")).toEqual([
      questions("MD", "2026-03-20", { monthly: true }),
    ]);
  });

  it("IL paid 2026-03-20 seen 2026-04-02: 'Q1 2026'", async () => {
    expect(await stateQuestionsFor("IL", "2026-03-20", "2026-04-02T10:00:00Z")).toEqual([
      questions("IL", "2026-03-20"),
    ]);
  });

  it("AL: February is a monthly-return month ('February 2026 or Q1 2026'); March is not ('Q1 2026')", async () => {
    expect(await stateQuestionsFor("AL", "2026-02-15", "2026-03-01T10:00:00Z")).toEqual([
      questions("AL", "2026-02-15", { monthly: true }),
    ]);
    expect(await stateQuestionsFor("AL", "2026-03-20", "2026-04-02T10:00:00Z")).toEqual([
      questions("AL", "2026-03-20"),
    ]);
  });
});

describe("LI-14 latePayment on a run that is not late is ignored", () => {
  it("future pay date and past pay date in an open quarter: issued with a mismatched, 'filed' latePayment; no late audit, no lateIssue", async () => {
    const future = await ilDraft("2026-05-15");
    const past = await ilDraft("2026-04-20");
    env.setNow("2026-05-02T10:00:00Z");
    const body = latePayment(1, [{ ...notFiled("IL"), withholdingReturnFiled: true }]);
    const a = await issue(env, future.publicId, body);
    const b = await issue(env, past.publicId, body);
    expect({
      a: a.status,
      b: b.status,
      lateKeys: ["lateIssue" in a.body, "lateIssue" in b.body],
      late: [
        (await audits(env.t, "run.issued_late", future.publicId)).length,
        (await audits(env.t, "run.issued_late", past.publicId)).length,
      ],
      refused: (await audits(env.t, REFUSED)).length,
      issueAfter: [
        ...(await audits(env.t, "run.issue", future.publicId)),
        ...(await audits(env.t, "run.issue", past.publicId)),
      ].map((x) => x.after),
    }).toEqual({
      a: 200,
      b: 200,
      lateKeys: [false, false],
      late: [0, 0],
      refused: 0,
      issueAfter: [{ status: "issued" }, { status: "issued" }],
    });
  });
});

describe("LI-15 past_pay_date_other_year is gone", () => {
  it("no match in apps/server/src or apps/web/src", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const roots = [resolve(here, "../src"), resolve(here, "../../web/src")];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (readFileSync(p, "utf8").includes("past_pay_date_other_year")) hits.push(p);
      }
    };
    for (const r of roots) walk(r);
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------- LI-16 … LI-18 (PL review round)

const NOT_SUPPORTED =
  "Wagon Payroll can't record a late payroll for your business's deposit schedule yet. Nothing was issued.";

describe("LI-16 lateIssueAllowed() false fails closed", () => {
  it("late run, hook false: without and with a complete latePayment -> 409 late_issue_not_supported {error,message,payDate}; run approved; no deposit, worksheet, outbox or issue rows", async () => {
    const d = await ilDraft();
    await setNotifiedYears([2026]);
    // PAY-206: a furnished 2026 W-2 would trigger the w2_changed mail on success.
    await furnishedEarlier(d.emp.id);
    env.setNow(JAN_10_2027);
    lateGate.allowed = false;
    const counts = async () => ({
      deposits: Number(
        (await env.t.pglite.query<{ n: number }>("SELECT count(*)::int AS n FROM tax_deposits"))
          .rows[0]!.n,
      ),
      filings: Number(
        (await env.t.pglite.query<{ n: number }>("SELECT count(*)::int AS n FROM tax_filings"))
          .rows[0]!.n,
      ),
      outbox: await outboxCount(),
    });
    const before = await counts();
    const bare = await issue(env, d.publicId);
    const full = await issue(env, d.publicId, latePayment(NET_IL, [notFiled("IL")]));
    for (const res of [bare, full]) {
      expect({
        status: res.status,
        keys: keys(res.body),
        error: res.body.error,
        message: res.body.message,
        payDate: res.body.payDate,
        noAmount: !hasAmount(res.raw),
      }).toEqual({
        status: 409,
        keys: ["error", "message", "payDate"],
        error: "late_issue_not_supported",
        message: NOT_SUPPORTED,
        payDate: "2026-12-31",
        noAmount: true,
      });
    }
    expect({
      status: await runStatus(env.t, d.publicId),
      counts: await counts(),
      issueAudits: (await audits(env.t, "run.issue", d.publicId)).length,
      lateAudits: (await audits(env.t, "run.issued_late", d.publicId)).length,
    }).toEqual({ status: "approved", counts: before, issueAudits: 0, lateAudits: 0 });
  });

  it("hook false does not touch a run that is not late (paid 2026-12-31, today 2026-12-31) -> issued", async () => {
    const d = await ilDraft();
    env.setNow("2026-12-31T10:00:00Z");
    lateGate.allowed = false;
    const res = await issue(env, d.publicId);
    expect({ status: res.status, lateKey: "lateIssue" in res.body }).toEqual({
      status: 200,
      lateKey: false,
    });
  });
});

describe("LI-17 the no-income-tax variant follows the run snapshot, not the live state config", () => {
  it("TX run whose snapshot kind is 'none' (TX:single row) while a live TX row of kind 'flat' sorts first -> 'none' variant", async () => {
    // Live config made ambiguous without changing what the D4 recompute
    // resolves: TX:married_joint (flat, never used for a single employee) is
    // inserted before TX:single (none); the plain TX 2026 row is parked on
    // 2099. The resolver ('TX:single' then 'TX') still finds kind 'none', so
    // the draft stays current; any live read of "TX or TX:*" for 2026 can
    // land on the flat row.
    const tx2026 = and(eq(stateTaxConfigs.jurisdiction, "TX"), eq(stateTaxConfigs.taxYear, 2026));
    await env.t.db.insert(stateTaxConfigs).values({
      jurisdiction: "TX:married_joint",
      taxYear: 2026,
      kind: "flat",
      flatRate: "0.05",
      note: "pay-193-l4 LI-17 synthetic",
    });
    await env.t.db.insert(stateTaxConfigs).values({
      jurisdiction: "TX:single",
      taxYear: 2026,
      kind: "none",
      note: "pay-193-l4 LI-17 synthetic",
    });
    await env.t.db.update(stateTaxConfigs).set({ taxYear: 2099 }).where(tx2026);
    try {
      const emp = await makeEmployee(env.t, { grossCents: 400_000, state: "TX" });
      const d = await draft(env.t, emp, "2026-12", "2026-12-31");
      await approve(env, d.publicId);
      const s = d.snapshot as { inputs: { state?: { kind?: string; jurisdiction?: string } } };
      expect({ kind: s.inputs.state?.kind, jurisdiction: s.inputs.state?.jurisdiction }).toEqual({
        kind: "none",
        jurisdiction: "TX:single",
      });
      env.setNow(JAN_10_2027);
      const res = await issue(env, d.publicId);
      expect({
        status: res.status,
        error: res.body.error,
        questions: (res.body.attestation as { stateQuestions?: unknown } | undefined)
          ?.stateQuestions,
      }).toEqual({
        status: 409,
        error: "late_payment_confirmation_required",
        questions: [questions("TX", "2026-12-31", { none: true })],
      });
    } finally {
      await env.t.db
        .delete(stateTaxConfigs)
        .where(
          and(
            eq(stateTaxConfigs.taxYear, 2026),
            eq(stateTaxConfigs.note, "pay-193-l4 LI-17 synthetic"),
          ),
        );
      await env.t.db
        .update(stateTaxConfigs)
        .set({ taxYear: 2026 })
        .where(and(eq(stateTaxConfigs.jurisdiction, "TX"), eq(stateTaxConfigs.taxYear, 2099)));
    }
  });
});

describe("LI-18 late_payment_incomplete when the run has no state questions (state list changed)", () => {
  it("no-state run answered with [IL] -> 409 late_payment_incomplete, the 'out of date' message, stateJurisdictions []", async () => {
    const emp = await makeEmployee(env.t, { grossCents: 400_000, state: null });
    const d = await draft(env.t, emp, "2026-12", "2026-12-31");
    await approve(env, d.publicId);
    env.setNow(JAN_10_2027);
    const res = await issue(env, d.publicId, latePayment(NET_NONE, [notFiled("IL")]));
    expect({
      status: res.status,
      keys: keys(res.body),
      error: res.body.error,
      message: res.body.message,
      payDate: res.body.payDate,
      stateJurisdictions: res.body.stateJurisdictions,
    }).toEqual({
      status: 409,
      keys: ["error", "message", "payDate", "stateJurisdictions"],
      error: "late_payment_incomplete",
      message:
        "The state questions on this screen are out of date. Nothing was issued. Close this window and select Issue payslip again.",
      payDate: "2026-12-31",
      stateJurisdictions: [],
    });
    expect(await runStatus(env.t, d.publicId)).toBe("approved");
  });
});

// ---------------------------------------------------------------- EF-1, EF-2, EF-3 (YTD and draft checks still run)

describe("EF-1 late December issued after January of the next year", () => {
  it("no ytd_order_conflict; December YTD = the 11 runs of 2026 (44,000.00); 2027-01 snapshot unchanged; a 2027-02 draft's prior YTD = 4,000.00", async () => {
    const emp = await makeEmployee(env.t, { grossCents: 400_000, state: null });
    const year = oracleYear(400_000, 1, 11, "none");
    const ids: string[] = [];
    for (let m = 1; m <= 11; m += 1) {
      const ym = `2026-${String(m).padStart(2, "0")}`;
      ids.push(await history(env.t, emp, ym, `${ym}-15`, year[m - 1]!, null));
    }
    const dec = await draft(env.t, emp, "2026-12", "2026-12-31");
    await approve(env, dec.publicId);
    const jan = await draft(env.t, emp, "2027-01", "2027-01-15");
    await approve(env, jan.publicId);
    env.setNow(JAN_10_2027);
    expect((await issue(env, jan.publicId)).status).toBe(200);
    const janBefore = (await runByPublicId(env.t, jan.publicId)).runSnapshot;

    // December with 44,000.00 prior: FUTA base used up in February; FIT/FICA as a plain month.
    const decOracle = oracleRun2026(400_000, 4_400_000, "none");
    env.setNow("2027-01-20T10:00:00Z");
    const res = await issue(env, dec.publicId, latePayment(decOracle.netCents, []));
    expect(res.status, res.raw).toBe(200);

    const decRow = await runByPublicId(env.t, dec.publicId);
    const s = snap(decRow);
    expect({
      prior: cents(s.inputs.priorYtdGross),
      ytdRuns: [...(s.inputs.resolution?.ytd.runs ?? [])].sort(),
      ytdYear: s.inputs.resolution?.ytd.year,
      taxYear: s.inputs.resolution?.taxYear,
    }).toEqual({ prior: 4_400_000, ytdRuns: [...ids].sort(), ytdYear: 2026, taxYear: 2026 });
    expect((await runByPublicId(env.t, jan.publicId)).runSnapshot).toEqual(janBefore);

    const feb = (await gen(env.t, emp.id, monthPeriod("2027-02", "2027-02-15"))).run;
    expect(cents(snap(await runRow(env.t, feb.id)).inputs.priorYtdGross)).toBe(400_000);
  });
});

describe("EF-2 an issued later 2026 run blocks the late issue (D6)", () => {
  it("draft paid 2026-12-15 after a 2026-12-31 run was issued: 409 ytd_order_conflict without and with latePayment", async () => {
    const emp = await makeEmployee(env.t, { grossCents: 400_000, state: null });
    const nov = await draft(env.t, emp, "2026-11", "2026-12-15");
    await approve(env, nov.publicId);
    await history(
      env.t,
      emp,
      "2026-12",
      "2026-12-31",
      oracleRun2026(400_000, 400_000, "none"),
      null,
    );
    env.setNow(JAN_10_2027);
    const a = await issue(env, nov.publicId);
    const b = await issue(env, nov.publicId, latePayment(NET_NONE, []));
    expect([a.status, a.body.error, b.status, b.body.error]).toEqual([
      409,
      "ytd_order_conflict",
      409,
      "ytd_order_conflict",
    ]);
    expect((await audits(env.t, REFUSED, nov.publicId)).length).toBe(0);
  });
});

describe("EF-3 a late draft made stale by an earlier issued run (D4)", () => {
  it("409 stale_draft without and with latePayment; run.stale_detected written; no late refusal row", async () => {
    const emp = await makeEmployee(env.t, { grossCents: 400_000, state: null });
    const dec = await draft(env.t, emp, "2026-12", "2026-12-31");
    await approve(env, dec.publicId);
    await history(env.t, emp, "2026-11", "2026-12-15", oracleRun2026(400_000, 0, "none"), null);
    env.setNow(JAN_10_2027);
    const a = await issue(env, dec.publicId);
    const b = await issue(env, dec.publicId, latePayment(NET_NONE, []));
    expect([a.status, a.body.error, b.status, b.body.error]).toEqual([
      409,
      "stale_draft",
      409,
      "stale_draft",
    ]);
    expect({
      stale: (await audits(env.t, "run.stale_detected", dec.publicId)).length,
      refused: (await audits(env.t, REFUSED, dec.publicId)).length,
    }).toEqual({ stale: 2, refused: 0 });
  });
});

// ---------------------------------------------------------------- EF-6 W-2 changed notice

// PL amendments round 2 (federal SME: 26 CFR 31.6051-1(j)(1),(j)(5); iw2w3 2026
// "Correcting Forms W-2 and W-3"). {company} = the company legal name;
// {appUrl} = config.baseUrl. PAY-206 review round (UX item 2, PL D11
// 2026-10-03): the bodies state no cause — the daily reconcile also sends
// them when the figures moved for a reason that is not a payroll.
const W2_PHRASE = "IMPORTANT TAX RETURN DOCUMENT AVAILABLE";
const W2_SUBJECT_E = (year: number, co: string) =>
  `${W2_PHRASE}: Your corrected ${year} W-2 from ${co}`;
// PAY-217 round 2 (F1): + the print step, as in the w2Available notice.
const W2_BODY_E = (year: number, co: string, appUrl: string) =>
  `${co} has corrected your ${year} Form W-2. The corrected W-2 is marked CORRECTED and replaces the earlier one. Use the corrected W-2 for your tax return. To view and print it, sign in at ${appUrl}, open Payslips, and find "W-2 wage and tax statements". Select Download PDF, then print or save it from your PDF reader. If you already filed your return using the earlier W-2, you may need to amend it.`;
const W2_SUBJECT_P = (year: number, co: string) => `${co} — Your ${year} W-2 is being corrected`;
const W2_BODY_P = (year: number, co: string) =>
  `${co} has corrected your ${year} Form W-2. ${co} will give you a corrected paper W-2, marked CORRECTED. Use the corrected paper copy for your tax return, not the earlier one. This email is a notice only and is not your W-2.`;

/** HTML -> the text a reader sees: tags dropped, entities decoded, whitespace collapsed. */
function plain(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&#34;", '"')
    .replaceAll("&#x22;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .replace(/ ([.,])/g, "$1")
    .trim();
}

async function companyLegalName(): Promise<string> {
  return (await env.t.db.select({ n: company.legalName }).from(company).limit(1))[0]!.n;
}

async function consentElectronicW2(employeeId: number): Promise<void> {
  await env.t.db
    .insert(w2DeliveryConsents)
    // PAY-208: a consent that covers tax year 2026 is version "2026-10".
    .values({ employeeId, disclosureVersion: "2026-10", withdrawnAt: null });
}

/** Paper notice content rules: no IMPORTANT phrase, no link, never "available". */
function paperViolations(subject: string, html: string, text = ""): string[] {
  const v: string[] = [];
  const all = `${subject}\n${html}\n${text}`;
  if (all.includes(W2_PHRASE)) v.push("important_phrase");
  if (/<a\b/i.test(html) || /href=/i.test(html) || /https?:\/\//i.test(all)) v.push("link");
  if (all.includes(env.t.config.baseUrl)) v.push("app_url");
  if (/available/i.test(all)) v.push("available");
  return v;
}

describe("EF-6 w2_changed notice", () => {
  it("(a) consented to electronic W-2; today 2027-01-10, a 2026 W-2 furnished with other figures -> one w2_changed row, IMPORTANT subject first (no company prefix), round-2 body, no amount; followUps has w2_changed_notice_sent", async () => {
    const d = await ilDraft();
    await consentElectronicW2(d.emp.id);
    await furnishedEarlier(d.emp.id);
    env.setNow(JAN_10_2027);
    const res = await issue(env, d.publicId, latePayment(NET_IL, [notFiled("IL")]));
    expect(res.status, res.raw).toBe(200);
    expect((res.body.lateIssue as { followUps: string[] }).followUps).toEqual([
      "w2_changed_notice_sent",
    ]);
    const rows = await outboxOf("w2_changed");
    expect(rows.map((r) => r.userId)).toEqual([d.emp.userId]);
    const m = rows[0]!;
    const co = await companyLegalName();
    const body = plain(m.bodyHtml);
    expect({
      subject: m.subject,
      startsWithPhrase: m.subject.startsWith(`${W2_PHRASE}: `),
      body: body.includes(W2_BODY_E(2026, co, env.t.config.baseUrl)),
      noAmountSubject: !hasAmount(m.subject),
      noAmountBody: !hasAmount(body),
      noNet: !body.includes("3,209.74") && !body.includes("3209.74"),
      noSsnShape: !/\b\d{3}-\d{2}-\d{4}\b/.test(body),
    }).toEqual({
      subject: W2_SUBJECT_E(2026, co),
      startsWithPhrase: true,
      body: true,
      noAmountSubject: true,
      noAmountBody: true,
      noNet: true,
      noSsnShape: true,
    });
    const late = await audits(env.t, "run.issued_late", d.publicId);
    expect((late[0]?.after as { followUps?: string[] } | undefined)?.followUps).toEqual([
      "w2_changed_notice_sent",
    ]);
  });

  it("(a2) NOT consented (paper), furnished earlier -> one w2_changed row: '{company} — Your 2026 W-2 is being corrected', round-2 paper body; no IMPORTANT phrase, no link, no 'available', no amount; followUps [w2_paper_correction_needed]", async () => {
    const d = await ilDraft();
    await furnishedEarlier(d.emp.id);
    env.setNow(JAN_10_2027);
    const res = await issue(env, d.publicId, latePayment(NET_IL, [notFiled("IL")]));
    expect(res.status, res.raw).toBe(200);
    const fu = (res.body.lateIssue as { followUps: string[] }).followUps;
    const rows = await outboxOf("w2_changed");
    expect(rows.map((r) => r.userId)).toEqual([d.emp.userId]);
    const m = rows[0]!;
    const co = await companyLegalName();
    expect({
      followUps: fu,
      subject: m.subject,
      body: plain(m.bodyHtml).includes(W2_BODY_P(2026, co)),
      violations: paperViolations(m.subject, m.bodyHtml),
      noAmount: !hasAmount(m.subject) && !hasAmount(plain(m.bodyHtml)),
    }).toEqual({
      followUps: ["w2_paper_correction_needed"],
      subject: W2_SUBJECT_P(2026, co),
      body: true,
      violations: [],
      noAmount: true,
    });
    const late = await audits(env.t, "run.issued_late", d.publicId);
    expect((late[0]?.after as { followUps?: string[] } | undefined)?.followUps).toEqual([
      "w2_paper_correction_needed",
    ]);
  });

  it("(a3) consent withdrawn (withdrawn_at set) counts as NOT consented -> paper notice, w2_paper_correction_needed", async () => {
    const d = await ilDraft();
    await env.t.db.insert(w2DeliveryConsents).values({
      employeeId: d.emp.id,
      disclosureVersion: "2025-01",
      withdrawnAt: new Date("2026-11-01T00:00:00Z"),
    });
    await furnishedEarlier(d.emp.id);
    env.setNow(JAN_10_2027);
    const res = await issue(env, d.publicId, latePayment(NET_IL, [notFiled("IL")]));
    expect(res.status, res.raw).toBe(200);
    const co = await companyLegalName();
    const rows = await outboxOf("w2_changed");
    expect({
      followUps: (res.body.lateIssue as { followUps: string[] }).followUps,
      subjects: rows.map((r) => r.subject),
    }).toEqual({
      followUps: ["w2_paper_correction_needed"],
      subjects: [W2_SUBJECT_P(2026, co)],
    });
  });

  it("(a4) not opt-out-able: every workflow email disabled for the employee -> the w2_changed row is still sent by the drain (never 'suppressed'); no w2_changed toggle on the employee settings surface", async () => {
    const d = await ilDraft();
    await consentElectronicW2(d.emp.id);
    const toggles = new Set<string>([...notifications.WORKFLOW_EVENTS, "w2_changed"]);
    for (const eventType of toggles) {
      await env.t.db
        .insert(notificationSettings)
        .values({ userId: d.emp.userId!, eventType, enabled: false })
        .onConflictDoUpdate({
          target: [notificationSettings.userId, notificationSettings.eventType],
          set: { enabled: false },
        });
    }
    await furnishedEarlier(d.emp.id);
    env.setNow(JAN_10_2027);
    const res = await issue(env, d.publicId, latePayment(NET_IL, [notFiled("IL")]));
    expect(res.status, res.raw).toBe(200);
    await drainOutbox({
      db: env.t.db,
      config: { ...env.t.config, emailMode: "log" },
      resolveRecipientEmail: async () => "worker@test.dev",
    } as unknown as Parameters<typeof drainOutbox>[0]);
    const rows = await outboxOf("w2_changed");
    expect({
      statuses: rows.map((r) => r.status),
      employeeSurface: notifications
        .workflowEventsFor({ isAdmin: false, employmentType: "w2" })
        .includes("w2_changed" as never),
    }).toEqual({ statuses: ["sent"], employeeSurface: false });
  });

  it("(b) PAY-206: nothing furnished for 2026 -> no w2_changed row, no follow-up, even with 2026 in the notified years (old gate)", async () => {
    const d = await ilDraft();
    await setNotifiedYears([2026]);
    env.setNow(JAN_10_2027);
    const res = await issue(env, d.publicId, latePayment(NET_IL, [notFiled("IL")]));
    expect(res.status, res.raw).toBe(200);
    expect({
      rows: (await outboxOf("w2_changed")).length,
      followUps: (res.body.lateIssue as { followUps: string[] }).followUps,
    }).toEqual({ rows: 0, followUps: [] });
  });

  it("(c) employee without a login (user_id null; can never have consented), furnished earlier -> no email row; followUps [w2_paper_correction_needed] (PL reading B)", async () => {
    const d = await ilDraft("2026-12-31", false);
    await furnishedEarlier(d.emp.id);
    env.setNow(JAN_10_2027);
    const res = await issue(env, d.publicId, latePayment(NET_IL, [notFiled("IL")]));
    expect(res.status, res.raw).toBe(200);
    const late = await audits(env.t, "run.issued_late", d.publicId);
    expect({
      rows: (await outboxOf("w2_changed")).length,
      followUps: (res.body.lateIssue as { followUps: string[] }).followUps,
      auditFollowUps: (late[0]?.after as { followUps?: string[] } | undefined)?.followUps,
    }).toEqual({
      rows: 0,
      followUps: ["w2_paper_correction_needed"],
      auditFollowUps: ["w2_paper_correction_needed"],
    });
  });

  it("(d) same-year issue on 2026-12-31 (not late) -> no row", async () => {
    const d = await ilDraft();
    await furnishedEarlier(d.emp.id);
    env.setNow("2026-12-31T10:00:00Z");
    const res = await issue(env, d.publicId);
    expect(res.status, res.raw).toBe(200);
    expect((await outboxOf("w2_changed")).length).toBe(0);
  });

  it("(e, auditor) late in-year (paid 2026-09-30, today 2026-10-05): the 2026 W-2 is not available yet -> no row even with a 2026 furnishing row", async () => {
    const d = await ilDraft("2026-09-30");
    await consentElectronicW2(d.emp.id);
    await furnishedEarlier(d.emp.id);
    env.setNow("2026-10-05T10:00:00Z");
    const res = await issue(env, d.publicId, latePayment(NET_IL, [notFiled("IL")]));
    expect(res.status, res.raw).toBe(200);
    const fu = (res.body.lateIssue as { followUps: string[] }).followUps;
    expect({
      rows: (await outboxOf("w2_changed")).length,
      w2Codes: fu.filter((c) => c.startsWith("w2_")),
    }).toEqual({ rows: 0, w2Codes: [] });
  });

  it("(f, auditor) @payroll/notifications: EVENT_TYPE.w2Changed = 'w2_changed', NOT a toggleable workflow event; w2Changed(ctx, { taxYear, consented }) renders both round-2 variants with no amount", () => {
    const n = notifications as unknown as {
      EVENT_TYPE: Record<string, string>;
      WORKFLOW_EVENTS: readonly string[];
      w2Changed?: (
        ctx: { companyName: string; brandName: string; appUrl: string },
        data: { taxYear: number; consented: boolean },
      ) => { subject: string; html: string; text: string };
    };
    expect({
      type: n.EVENT_TYPE.w2Changed,
      workflow: n.WORKFLOW_EVENTS.includes("w2_changed"),
      template: typeof n.w2Changed,
    }).toEqual({ type: "w2_changed", workflow: false, template: "function" });
    const ctx = {
      companyName: "Example Corp",
      brandName: "Wagon Payroll",
      appUrl: "http://localhost",
    };
    const e = n.w2Changed!(ctx, { taxYear: 2026, consented: true });
    const p = n.w2Changed!(ctx, { taxYear: 2026, consented: false });
    expect({
      eSubject: e.subject,
      eHtml: plain(e.html).includes(W2_BODY_E(2026, "Example Corp", "http://localhost")),
      eText: e.text
        .replace(/\s+/g, " ")
        .includes(W2_BODY_E(2026, "Example Corp", "http://localhost")),
      pSubject: p.subject,
      pHtml: plain(p.html).includes(W2_BODY_P(2026, "Example Corp")),
      pText: p.text.replace(/\s+/g, " ").includes(W2_BODY_P(2026, "Example Corp")),
      pViolations: paperViolations(p.subject, p.html, p.text),
      noAmount: [e.subject, e.text, plain(e.html), p.subject, p.text, plain(p.html)].every(
        (x) => !hasAmount(x),
      ),
    }).toEqual({
      eSubject: W2_SUBJECT_E(2026, "Example Corp"),
      eHtml: true,
      eText: true,
      pSubject: W2_SUBJECT_P(2026, "Example Corp"),
      pHtml: true,
      pText: true,
      pViolations: [],
      noAmount: true,
    });
  });
});

// ---------------------------------------------------------------- EF-7 payslip, EF-11 run detail

describe("EF-7 payslip of a late-issued run", () => {
  it("snapshot pay date 2026-12-31, tax year 2026; PDF bytes equal a render of the generation snapshot", async () => {
    const d = await ilDraft();
    env.setNow(JAN_10_2027);
    const res = await issue(env, d.publicId, latePayment(NET_IL, [notFiled("IL")]));
    expect(res.status, res.raw).toBe(200);
    const issued = await runByPublicId(env.t, d.publicId);
    const s = snap(issued);
    expect({ payDate: s.inputs.payDate, taxYear: s.inputs.resolution?.taxYear }).toEqual({
      payDate: "2026-12-31",
      taxYear: 2026,
    });
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2027-01-10T10:00:00Z") });
    try {
      const a = await renderPayslipPdf(issued.runSnapshot as PayslipSnapshot);
      const b = await renderPayslipPdf(d.snapshot as PayslipSnapshot);
      expect(Buffer.compare(a, b)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("EF-11 run detail shows who confirmed a late issue", () => {
  it("late run -> lateIssue { confirmedBy: admin, confirmedAt: the run.issued_late time }; normal and unissued runs -> lateIssue null", async () => {
    const late = await ilDraft();
    const normal = await ilDraft("2026-12-15");
    const open = await ilDraft("2026-11-30");
    env.setNow("2026-12-15T10:00:00Z");
    expect((await issue(env, normal.publicId)).status).toBe(200);
    env.setNow(JAN_10_2027);
    expect((await issue(env, late.publicId, latePayment(NET_IL, [notFiled("IL")]))).status).toBe(
      200,
    );
    const get = async (publicId: string) => {
      const r = await env.t.app.inject({
        method: "GET",
        url: `/api/admin/payroll-runs/${publicId}`,
        headers: env.admin,
      });
      return r.json() as { run: unknown; lateIssue?: unknown };
    };
    const lateBody = await get(late.publicId);
    const auditRow = (await audits(env.t, "run.issued_late", late.publicId))[0]!;
    const li = lateBody.lateIssue as { confirmedBy?: string; confirmedAt?: string } | null;
    expect({
      keys: li ? keys(li) : null,
      confirmedBy: li?.confirmedBy,
      confirmedAtMs: li?.confirmedAt ? new Date(li.confirmedAt).getTime() : null,
    }).toEqual({
      keys: ["confirmedAt", "confirmedBy"],
      confirmedBy: env.adminId,
      confirmedAtMs: auditRow.createdAt.getTime(),
    });
    const n = await get(normal.publicId);
    const o = await get(open.publicId);
    expect({
      normalHasKey: "lateIssue" in n,
      normal: n.lateIssue,
      openHasKey: "lateIssue" in o,
      open: o.lateIssue,
    }).toEqual({ normalHasKey: true, normal: null, openHasKey: true, open: null });
  });
});

// Keep the oracle import honest: the IL constants above are the oracle's.
describe("oracle self-check (no engine)", () => {
  it("IL 4,000.00 single, 1 allowance: 298.33 / 248.00 / 58.00 / 185.93 -> net 3,209.74; no state -> 3,395.67", () => {
    expect([A.fitCents, A.ssCents, A.medCents, A.stateCents, A.netCents]).toEqual([
      29_833, 24_800, 5_800, 18_593, 320_974,
    ]);
    expect(N.netCents).toBe(339_567);
  });
});

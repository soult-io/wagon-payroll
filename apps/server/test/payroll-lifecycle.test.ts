/**
 * Payroll run lifecycle + payslip PDF integration tests (step 3).
 * Real SQL via the PGlite harness; config resolution, YTD chaining,
 * idempotency, state machine, snapshot immutability, outbox rows, PDF bytes,
 * and the golden $310.13 differential against the seeded 2025 tables.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  company,
  compensation,
  emailOutbox,
  employees,
  payrollEntries,
  payrollRuns,
  seedDatabase,
  w4Elections,
  type SeedDb,
} from "@payroll/db";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";
import { snapshotHash, type RunSnapshot } from "../src/payroll/snapshot.js";
import { round2 } from "@payroll/engine/money";

let t: TestContext;
let adminCookie: string;

// Runs are issued on their pay date (issueOn): a run whose pay-date quarter
// has ended is late and needs the PAY-193 L4 confirmation. Outside an issue
// the clock stays at late 2025.
let issueOn: string | null = null;
const ISSUE_CLOCK = () => new Date(`${issueOn ?? "2025-12-31"}T12:00:00Z`);

beforeAll(async () => {
  t = await createTestApp({}, { clock: ISSUE_CLOCK });
  await seedDatabase(t.db as unknown as SeedDb);
  await inviteAndOnboard(t, { email: "payroll-admin@example.com", role: "admin" });
  const adminLogin = await login(t, "payroll-admin@example.com", TEST_PASSWORD);
  adminCookie = adminLogin.sessionCookie;
});

afterAll(async () => {
  await t.close();
});

let employeeSeq = 0;
async function createEmployee(userId: string | null = null): Promise<number> {
  employeeSeq += 1;
  // Seeds guarantee exactly one company row.
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({
      userId,
      companyId: companyRows[0]!.id,
      legalName: `Test Employee ${employeeSeq}`,
      hireDate: "2024-01-01",
    })
    .returning();
  return rows[0]!.id;
}

async function addCompensation(
  employeeId: number,
  periodAmount: number,
  effectiveFrom: string,
  effectiveTo: string | null = null,
): Promise<void> {
  await t.db.insert(compensation).values({
    employeeId,
    periodAmount: String(periodAmount),
    frequency: "monthly",
    effectiveFrom,
    effectiveTo,
  });
}

async function generate(employeeId: number, year: number, month: number) {
  const res = await t.app.inject({
    method: "POST",
    url: "/api/admin/payroll-runs/generate",
    headers: sessionHeader(adminCookie),
    payload: { year, month, employeeId },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as {
    generated: (typeof payrollRuns.$inferSelect)[];
    skipped: { employeeId: number; reason: string }[];
  };
}

async function act(publicId: string, action: "approve" | "issue" | "void", reason?: string) {
  const rows = await t.db
    .select({ payDate: payrollRuns.payDate })
    .from(payrollRuns)
    .where(eq(payrollRuns.publicId, publicId));
  issueOn = action === "issue" ? (rows[0]?.payDate ?? null) : null;
  try {
    return await t.app.inject({
      method: "POST",
      url: `/api/admin/payroll-runs/${publicId}/${action}`,
      headers: sessionHeader(adminCookie),
      payload: reason ? { reason } : {},
    });
  } finally {
    issueOn = null;
  }
}

async function runEntries(runId: number) {
  return t.db.select().from(payrollEntries).where(eq(payrollEntries.runId, runId));
}

describe("config resolution + generation", () => {
  it("resolves compensation as-of the period date (effective-dated)", async () => {
    const employeeId = await createEmployee();
    await addCompensation(employeeId, 3000, "2025-01-01", "2025-07-01");
    await addCompensation(employeeId, 4000, "2025-07-01");

    const may = await generate(employeeId, 2025, 5);
    const july = await generate(employeeId, 2025, 7);

    const maySnapshot = may.generated[0]!.runSnapshot as RunSnapshot;
    const julySnapshot = july.generated[0]!.runSnapshot as RunSnapshot;
    expect(maySnapshot.inputs.periodAmount).toBe(3000);
    expect(julySnapshot.inputs.periodAmount).toBe(4000);
    expect(may.generated[0]!.status).toBe("awaiting_approval");
  });

  it("applies effective-dated W-4: exempt from its effective date, not retroactively", async () => {
    const employeeId = await createEmployee();
    await addCompensation(employeeId, 4000, "2025-01-01");
    await t.db.insert(w4Elections).values({
      employeeId,
      taxYear: 2025,
      filingStatus: "single",
      federalExempt: true,
      effectiveFrom: "2025-03-01",
      filedDate: "2025-02-15",
      renewalDeadline: "2026-02-16",
    });

    const feb = await generate(employeeId, 2025, 2);
    const mar = await generate(employeeId, 2025, 3);

    const febFederal = (feb.generated[0]!.runSnapshot as RunSnapshot).result.federalWithholding;
    const marFederal = (mar.generated[0]!.runSnapshot as RunSnapshot).result.federalWithholding;
    expect(febFederal).toBeGreaterThan(0); // no W-4 effective yet → default withhold
    expect(marFederal).toBe(0); // exempt effective 2025-03-01
  });

  it("chains prior YTD across ISSUED runs only", async () => {
    const employeeId = await createEmployee();
    await addCompensation(employeeId, 4000, "2025-01-01");

    const jan = (await generate(employeeId, 2025, 1)).generated[0]!;
    // Feb generated while Jan is still awaiting approval → prior YTD must be 0.
    const febDraft = (await generate(employeeId, 2025, 2)).generated[0]!;
    expect((febDraft.runSnapshot as RunSnapshot).inputs.priorYtdGross).toBe(0);

    await act(jan.publicId, "approve");
    await act(jan.publicId, "issue");

    // Regenerate Feb after voiding the stale draft: prior YTD now includes Jan.
    await act(febDraft.publicId, "void", "stale draft before Jan issued");
    const feb = (await generate(employeeId, 2025, 2)).generated[0]!;
    const febSnapshot = feb.runSnapshot as RunSnapshot;
    expect(febSnapshot.inputs.priorYtdGross).toBe(4000);
    expect(febSnapshot.result.ytdGross).toBe(8000);

    // Template ≥1.1.0: the frozen YTD block accumulates through this run —
    // Jan's issued amounts + Feb's own.
    const janResult = (jan.runSnapshot as RunSnapshot).result;
    const febYtd = febSnapshot.ytd;
    expect(febYtd).toBeDefined();
    expect(febYtd!.gross).toBe(8000);
    expect(febYtd!.netPay).toBe(round2(janResult.netPay + febSnapshot.result.netPay));
    expect(febYtd!.totalDeductions).toBe(round2(8000 - febYtd!.netPay));
    expect(febYtd!.federalWithholding).toBe(
      round2(janResult.federalWithholding + febSnapshot.result.federalWithholding),
    );
    // The Feb DRAFT generated before Jan was issued chains nothing.
    expect((febDraft.runSnapshot as RunSnapshot).ytd!.gross).toBe(febSnapshot.result.grossPay);
  });

  it("is idempotent: double-generate yields exactly one run", async () => {
    const employeeId = await createEmployee();
    await addCompensation(employeeId, 5000, "2025-01-01");
    await generate(employeeId, 2025, 4);
    const second = await generate(employeeId, 2025, 4);
    expect(second.generated.length).toBe(1); // existing run returned
    const runs = await t.db
      .select()
      .from(payrollRuns)
      .where(
        and(eq(payrollRuns.employeeId, employeeId), eq(payrollRuns.periodStart, "2025-04-01")),
      );
    expect(runs.length).toBe(1);
  });

  it("notifies admins on draft generation (email_outbox, payroll_draft_ready)", async () => {
    const employeeId = await createEmployee();
    await addCompensation(employeeId, 5000, "2025-01-01");
    const before = await t.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.eventType, "payroll_draft_ready"));
    await generate(employeeId, 2025, 6);
    const after = await t.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.eventType, "payroll_draft_ready"));
    expect(after.length).toBeGreaterThan(before.length);
  });
});

describe("state machine", () => {
  it("walks awaiting_approval → approved → issued and rejects illegal transitions", async () => {
    const employeeId = await createEmployee();
    await addCompensation(employeeId, 5000, "2025-01-01");
    const run = (await generate(employeeId, 2025, 8)).generated[0]!;

    // Issue before approve → 409.
    expect((await act(run.publicId, "issue")).statusCode).toBe(409);

    expect((await act(run.publicId, "approve")).statusCode).toBe(200);
    // Approve again → 409.
    expect((await act(run.publicId, "approve")).statusCode).toBe(409);

    expect((await act(run.publicId, "issue")).statusCode).toBe(200);
    // Void an issued run → 409 (spec: pre-issued only).
    expect((await act(run.publicId, "void", "too late")).statusCode).toBe(409);

    // Audit trail covers the successful transitions.
    const audits = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, run.publicId));
    const actions = audits.map((a) => a.action).sort();
    expect(actions).toContain("run.approve");
    expect(actions).toContain("run.issue");
  });

  it("voids a pre-issued run only with a reason, and regeneration creates a new run", async () => {
    const employeeId = await createEmployee();
    await addCompensation(employeeId, 5000, "2025-01-01");
    const run = (await generate(employeeId, 2025, 9)).generated[0]!;

    expect((await act(run.publicId, "void")).statusCode).toBe(409); // no reason
    expect((await act(run.publicId, "void", "wrong period")).statusCode).toBe(200);

    const voided = await t.db
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.publicId, run.publicId));
    expect(voided[0]!.status).toBe("void");
    expect(voided[0]!.voidReason).toBe("wrong period");
    expect(voided[0]!.voidedAt).toBeTruthy();

    // Regeneration after void creates a NEW run row (spec), same (employee, period).
    const regen = await generate(employeeId, 2025, 9);
    expect(regen.generated[0]!.publicId).not.toBe(run.publicId);
    expect(regen.generated[0]!.status).toBe("awaiting_approval");
  });
});

describe("snapshot immutability (D5)", () => {
  it("issued runs keep their snapshot despite later config edits", async () => {
    const employeeId = await createEmployee();
    await addCompensation(employeeId, 4000, "2025-01-01");
    const run = (await generate(employeeId, 2025, 10)).generated[0]!;
    await act(run.publicId, "approve");
    await act(run.publicId, "issue");

    const snapshotBefore = run.runSnapshot as RunSnapshot;
    const hashBefore = run.snapshotHash;

    // Change the compensation going forward AND overwrite 2025 tax tables.
    await addCompensation(employeeId, 9999, "2025-10-15");
    const cfgRes = await t.app.inject({
      method: "GET",
      url: "/api/admin/tax-config?year=2025&jurisdiction=federal",
      headers: sessionHeader(adminCookie),
    });
    const { taxConfig: configs, taxBrackets: brackets } = cfgRes.json() as {
      taxConfig: Record<string, string | number>[];
      taxBrackets: Record<string, string | number | null>[];
    };
    const originalConfig = {
      jurisdiction: "federal",
      taxYear: 2025,
      config: {
        standardDeduction: Number(configs[0]!.standardDeduction),
        socialSecurityRate: Number(configs[0]!.socialSecurityRate),
        socialSecurityWageCap: Number(configs[0]!.socialSecurityWageCap),
        medicareRate: Number(configs[0]!.medicareRate),
        medicareAdditionalRate: Number(configs[0]!.medicareAdditionalRate),
        medicareAdditionalThreshold: Number(configs[0]!.medicareAdditionalThreshold),
        stateWithholdingRate: Number(configs[0]!.stateWithholdingRate),
        employerSocialSecurityRate: Number(configs[0]!.employerSocialSecurityRate),
        employerMedicareRate: Number(configs[0]!.employerMedicareRate),
        futaRate: Number(configs[0]!.futaRate),
        futaWageCap: Number(configs[0]!.futaWageCap),
      },
      brackets: brackets.map((b) => ({
        ordinal: Number(b.ordinal),
        minAmount: Number(b.minAmount),
        maxAmount: b.maxAmount === null ? null : Number(b.maxAmount),
        rate: Number(b.rate),
      })),
    };
    try {
      await t.app.inject({
        method: "PUT",
        url: "/api/admin/tax-config",
        headers: sessionHeader(adminCookie),
        payload: {
          ...originalConfig,
          config: { ...originalConfig.config, standardDeduction: 1 }, // drastically different
        },
      });

      // The issued run is untouched.
      const detail = await t.app.inject({
        method: "GET",
        url: `/api/admin/payroll-runs/${run.publicId}`,
        headers: sessionHeader(adminCookie),
      });
      const after = detail.json().run;
      expect(after.runSnapshot).toEqual(snapshotBefore);
      expect(after.snapshotHash).toBe(hashBefore);
      expect(snapshotHash(after.runSnapshot as RunSnapshot)).toBe(hashBefore);
    } finally {
      // Restore the seeded 2025 tables — later tests (golden differential)
      // depend on them.
      await t.app.inject({
        method: "PUT",
        url: "/api/admin/tax-config",
        headers: sessionHeader(adminCookie),
        payload: originalConfig,
      });
    }

    // And the DB trigger rejects direct snapshot mutation on issued runs.
    await expect(
      t.db
        .update(payrollRuns)
        .set({ runSnapshot: { tampered: true } })
        .where(eq(payrollRuns.id, run.id)),
    ).rejects.toThrow();
  });
});

describe("golden differential (2025 seeded tables)", () => {
  it("reproduces the known $310.13 federal case end-to-end through the API", async () => {
    const employeeId = await createEmployee();
    await addCompensation(employeeId, 4000, "2025-01-01");
    const run = (await generate(employeeId, 2025, 11)).generated[0]!;
    await act(run.publicId, "approve");
    await act(run.publicId, "issue");

    // Hand-computed (documented in packages/engine/src/payroll.ts TAX_CONFIG_2025):
    // 48,000 − 15,000 = 33,000 taxable → 1,192.50 + 21,075×.12 = 3,721.50/yr
    // → 310.125 → 310.13/mo. SS 248.00, Medicare 58.00 → net 3,383.87.
    const entries = await runEntries(run.id);
    const byCategory = Object.fromEntries(entries.map((e) => [e.category, Number(e.amount)]));
    expect(byCategory["gross_pay"]).toBe(4000);
    expect(byCategory["federal_withholding"]).toBe(310.13);
    expect(byCategory["social_security"]).toBe(248.0);
    expect(byCategory["medicare"]).toBe(58.0);
    expect(byCategory["net_pay"]).toBe(3383.87);
  });
});

describe("employee payslip endpoints + PDF", () => {
  it("serves own issued payslips, 404s foreign, streams a valid PDF", async () => {
    const empUser = await inviteAndOnboard(t, { email: "payslip-emp@example.com" });
    const otherUser = await inviteAndOnboard(t, { email: "payslip-other@example.com" });
    const employeeId = await createEmployee(empUser.userId);
    const otherEmployeeId = await createEmployee(otherUser.userId);
    await addCompensation(employeeId, 4000, "2025-01-01");
    await addCompensation(otherEmployeeId, 4000, "2025-01-01");

    const run = (await generate(employeeId, 2025, 12)).generated[0]!;
    await act(run.publicId, "approve");
    await act(run.publicId, "issue");
    const otherRun = (await generate(otherEmployeeId, 2025, 12)).generated[0]!;
    await act(otherRun.publicId, "approve");
    await act(otherRun.publicId, "issue");

    const empLogin = await login(t, "payslip-emp@example.com", TEST_PASSWORD);
    const emp = sessionHeader(empLogin.sessionCookie);

    const list = await t.app.inject({ method: "GET", url: "/api/payslips", headers: emp });
    expect(list.statusCode).toBe(200);
    const slips = list.json().payslips as { publicId: string; netPay: number }[];
    expect(slips.length).toBe(1);
    expect(slips[0]!.publicId).toBe(run.publicId);

    const detail = await t.app.inject({
      method: "GET",
      url: `/api/payslips/${run.publicId}`,
      headers: emp,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().payslip.snapshot.engineVersion).toBe("0.3.0");

    // Foreign payslip → 404 (no enumeration).
    const foreign = await t.app.inject({
      method: "GET",
      url: `/api/payslips/${otherRun.publicId}`,
      headers: emp,
    });
    expect(foreign.statusCode).toBe(404);
    const foreignPdf = await t.app.inject({
      method: "GET",
      url: `/api/payslips/${otherRun.publicId}/pdf`,
      headers: emp,
    });
    expect(foreignPdf.statusCode).toBe(404);

    // Unauthenticated → 401.
    expect(
      (await t.app.inject({ method: "GET", url: `/api/payslips/${run.publicId}` })).statusCode,
    ).toBe(401);

    // PDF: valid bytes, deterministic filename.
    const pdf = await t.app.inject({
      method: "GET",
      url: `/api/payslips/${run.publicId}/pdf`,
      headers: emp,
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.headers["content-disposition"]).toContain("payslip-2025-12.pdf");
    expect(pdf.rawPayload.length).toBeGreaterThan(2000);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");

    // Issuing wrote the payslip_issued outbox row to the employee.
    const outbox = await t.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.eventType, "payslip_issued"));
    expect(outbox.some((r) => r.userId === empUser.userId)).toBe(true);
  });
});

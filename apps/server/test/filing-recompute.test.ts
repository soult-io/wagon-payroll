/**
 * PAY-25 integration tests — the audited "Recompute worksheet" correction
 * path for FILED filings. Real SQL via the PGlite harness; routes through
 * app.inject with real sessions.
 *
 * Fixture mirrors the incident that motivated the ticket: a 940 row for 2025
 * (one $4,000/mo employee, January run issued under the seeded 5.4% SUTA
 * credit → 0.6% net FUTA → $24.00 for the year) is marked filed, then its
 * frozen worksheet is tampered out-of-band ($24.00 → $2.40, the wrong-rate
 * shape) exactly like the direct-DB correction of 2026-09-03 that this
 * ticket productizes.
 *
 * Covers: the read-only preview (before/after worksheets + hashes), the
 * commit (worksheet + canonical hash restored, reason mandatory), the
 * tax_filing.correct_worksheet audit row (old hash → new hash + reason +
 * actor), filing metadata provably untouched (status/filedOn/method/
 * reference), corrections surfaced on the detail response, filed-only
 * enforcement (unfiled rows 409), and RBAC (admin-only).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  company,
  compensation,
  employees,
  type payrollRuns,
  seedDatabase,
  taxFilings,
  type SeedDb,
} from "@payroll/db";
import type { Worksheet940 } from "../src/filings/annual.js";
import { worksheetHash } from "../src/filings/service.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

const REASON = "corrected to match the filed return, IRS e-file ack ACK-123";

let t: TestContext;
let ADMIN: Record<string, string>;
let EMPLOYEE: Record<string, string>;
let adminUserId: string;
let filingId: number;
let unfiledId: number;
let originalWorksheet: Worksheet940;
let originalHash: string;
let tamperedHash: string;

interface CorrectionJson {
  id: string;
  actorId: string;
  before: { worksheetHash: string | null };
  after: { worksheetHash: string; reason: string };
  createdAt: string;
}

async function filingRow(id: number) {
  const rows = await t.db.select().from(taxFilings).where(eq(taxFilings.id, id)).limit(1);
  return rows[0];
}

// Runs are issued on their pay date (issueOn): a run whose pay-date quarter
// has ended is late and needs the PAY-193 L4 confirmation. Outside an issue
// the clock stays at late 2025.
let issueOn: string | null = null;
const ISSUE_CLOCK = () => new Date(`${issueOn ?? "2025-12-31"}T12:00:00Z`);

beforeAll(async () => {
  t = await createTestApp({}, { clock: ISSUE_CLOCK });
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "recompute-admin@test.dev", role: "admin" });
  adminUserId = admin.userId;
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);
  const employee = await inviteAndOnboard(t, { email: "recompute-emp@test.dev", role: "employee" });
  EMPLOYEE = sessionHeader((await login(t, employee.email, TEST_PASSWORD)).sessionCookie);

  // One W-2 employee at $4,000/mo; January 2025 run issued under the seeded
  // 2025 config (5.4% credit → 0.6% net FUTA) → futa = 4000 × 0.006 = 24.00.
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const inserted = await t.db
    .insert(employees)
    .values({
      companyId: companyRows[0]?.id ?? 1,
      legalName: "Recompute One",
      hireDate: "2025-01-01",
    })
    .returning();
  const employeeId = inserted[0]?.id;
  if (!employeeId) throw new Error("employee insert failed");
  await t.db.insert(compensation).values({
    employeeId,
    periodAmount: "4000",
    frequency: "monthly",
    effectiveFrom: "2025-01-01",
    effectiveTo: null,
  });

  const gen = await t.app.inject({
    method: "POST",
    url: "/api/admin/payroll-runs/generate",
    headers: ADMIN,
    payload: { year: 2025, month: 1, employeeId },
  });
  expect(gen.statusCode, gen.body).toBe(201);
  const run = (gen.json() as { generated: (typeof payrollRuns.$inferSelect)[] }).generated[0];
  if (!run) throw new Error(`no run generated: ${gen.body}`);
  issueOn = run.payDate;
  for (const action of ["approve", "issue"] as const) {
    const res = await t.app.inject({
      method: "POST",
      url: `/api/admin/payroll-runs/${run.publicId}/${action}`,
      headers: ADMIN,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  issueOn = null;

  // The 940 row, computed once (detail read refreshes unfiled worksheets),
  // then marked filed.
  const filing = await t.db
    .insert(taxFilings)
    .values({ formType: "940", year: 2025, quarter: 0, dueDate: "2026-02-02", status: "ready" })
    .returning({ id: taxFilings.id });
  filingId = filing[0]?.id ?? -1;
  const detail = await t.app.inject({
    method: "GET",
    url: `/api/admin/tax-filings/${filingId}`,
    headers: ADMIN,
  });
  expect(detail.statusCode, detail.body).toBe(200);
  const computed = await filingRow(filingId);
  originalWorksheet = computed?.worksheet as Worksheet940;
  originalHash = computed?.worksheetHash ?? "";
  expect(originalWorksheet.line8FutaTax).toBe("24.00");
  expect(originalHash).toBe(worksheetHash(originalWorksheet));

  const filed = await t.app.inject({
    method: "POST",
    url: `/api/admin/tax-filings/${filingId}/file`,
    headers: ADMIN,
    payload: { filedOn: "2026-01-15", filingMethod: "e-file", filingReference: "ACK-123" },
  });
  expect(filed.statusCode, filed.body).toBe(200);

  // Tamper out-of-band: the worksheet froze with figures that never matched
  // the actual filing (wrong-rate shape). Hash is updated with it, exactly
  // like a direct-DB fix would leave the row.
  const tampered: Worksheet940 = {
    ...originalWorksheet,
    line8FutaTax: "2.40",
    line12TotalFutaTax: "2.40",
  };
  tamperedHash = worksheetHash(tampered);
  await t.db
    .update(taxFilings)
    .set({ worksheet: tampered, worksheetHash: tamperedHash })
    .where(eq(taxFilings.id, filingId));

  // A second, unfiled row for the filed-only guard.
  const unfiled = await t.db
    .insert(taxFilings)
    .values({ formType: "941", year: 2025, quarter: 1, dueDate: "2025-04-30", status: "ready" })
    .returning({ id: taxFilings.id });
  unfiledId = unfiled[0]?.id ?? -1;
}, 120_000);

afterAll(async () => {
  await t.close();
});

describe("GET /api/admin/tax-filings/:id/recompute — read-only preview", () => {
  it("shows the frozen (tampered) worksheet vs the recomputed truth", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-filings/${filingId}/recompute`,
      headers: ADMIN,
    });
    expect(res.statusCode, res.body).toBe(200);
    const preview = res.json() as {
      beforeWorksheet: Worksheet940;
      afterWorksheet: Worksheet940;
      beforeHash: string;
      afterHash: string;
    };
    expect(preview.beforeHash).toBe(tamperedHash);
    expect(preview.afterHash).toBe(originalHash);
    expect(preview.beforeWorksheet.line8FutaTax).toBe("2.40");
    expect(preview.afterWorksheet.line8FutaTax).toBe("24.00");
    expect(preview.afterWorksheet.futaTaxPerFrozenEntries).toBe("24.00");

    // Read-only: the row is untouched.
    expect((await filingRow(filingId))?.worksheetHash).toBe(tamperedHash);
  });

  it("rejects unfiled filings — their worksheets already track the data", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-filings/${unfiledId}/recompute`,
      headers: ADMIN,
    });
    expect(res.statusCode, res.body).toBe(409);
  });
});

describe("POST /api/admin/tax-filings/:id/recompute — guards", () => {
  it("requires a reason", async () => {
    for (const payload of [{}, { reason: "" }, { reason: "   " }]) {
      const res = await t.app.inject({
        method: "POST",
        url: `/api/admin/tax-filings/${filingId}/recompute`,
        headers: ADMIN,
        payload,
      });
      expect(res.statusCode, res.body).toBe(400);
    }
  });

  it("is admin-only", async () => {
    const asEmployee = await t.app.inject({
      method: "POST",
      url: `/api/admin/tax-filings/${filingId}/recompute`,
      headers: EMPLOYEE,
      payload: { reason: REASON },
    });
    expect(asEmployee.statusCode).toBe(403);
    const anon = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-filings/${filingId}/recompute`,
    });
    expect(anon.statusCode).toBe(401);
  });

  it("rejects unfiled filings", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: `/api/admin/tax-filings/${unfiledId}/recompute`,
      headers: ADMIN,
      payload: { reason: REASON },
    });
    expect(res.statusCode, res.body).toBe(409);
  });
});

describe("POST /api/admin/tax-filings/:id/recompute — the correction", () => {
  it("restores the recomputed worksheet + hash and audits old → new + reason", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: `/api/admin/tax-filings/${filingId}/recompute`,
      headers: ADMIN,
      payload: { reason: REASON },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { filing } = res.json() as { filing: typeof taxFilings.$inferSelect };
    expect((filing.worksheet as Worksheet940).line8FutaTax).toBe("24.00");
    expect(filing.worksheetHash).toBe(originalHash);

    // Filing metadata is never touched by a worksheet correction.
    const row = await filingRow(filingId);
    expect(row?.status).toBe("filed");
    expect(row?.filedOn).toBe("2026-01-15");
    expect(row?.filingMethod).toBe("e-file");
    expect(row?.filingReference).toBe("ACK-123");

    const audits = await t.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "tax_filing.correct_worksheet"),
          eq(auditEvents.entityId, String(filingId)),
        ),
      );
    expect(audits).toHaveLength(1);
    const audit = audits[0];
    expect(audit?.actorId).toBe(adminUserId);
    expect(audit?.entity).toBe("tax_filing");
    const before = audit?.before as { worksheetHash: string } | undefined;
    expect(before?.worksheetHash).toBe(tamperedHash);
    const after = audit?.after as { worksheetHash: string; reason: string } | undefined;
    expect(after?.worksheetHash).toBe(originalHash);
    expect(after?.reason).toBe(REASON);
  });

  it("surfaces the correction on the filing detail response", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-filings/${filingId}`,
      headers: ADMIN,
    });
    expect(res.statusCode, res.body).toBe(200);
    const detail = res.json() as { corrections: CorrectionJson[] };
    expect(detail.corrections).toHaveLength(1);
    const correction = detail.corrections[0];
    expect(correction?.actorId).toBe(adminUserId);
    expect(correction?.before.worksheetHash).toBe(tamperedHash);
    expect(correction?.after.worksheetHash).toBe(originalHash);
    expect(correction?.after.reason).toBe(REASON);
  });

  it("is a no-op-safe second run — recompute again yields the same figures", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: `/api/admin/tax-filings/${filingId}/recompute`,
      headers: ADMIN,
      payload: { reason: "re-verified against the e-file acknowledgement" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = await filingRow(filingId);
    expect(row?.worksheetHash).toBe(originalHash);
    const ws = row?.worksheet as Worksheet940 | undefined;
    expect(ws?.line8FutaTax).toBe("24.00");
  });
});

/**
 * PAY-13 phase 1 integration tests — per-state income-tax withholding.
 * Real SQL via the PGlite harness: admin route validation/auth, config upsert
 * + bracket replace, effective-dated work-state assignment, state elections,
 * and run generation against the seeded IL/CA/TX tables (snapshot state block
 * frozen; legacy path bit-identical without a work state).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  compensation,
  company,
  employees,
  payrollEntries,
  seedDatabase,
  stateTaxBrackets,
  stateTaxConfigs,
  type SeedDb,
} from "@payroll/db";
import { createTestApp, ORIGIN, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";
import type { RunSnapshot } from "../src/payroll/snapshot.js";

let t: TestContext;
let adminCookie: string;

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  await inviteAndOnboard(t, { email: "state-admin@example.com", role: "admin" });
  const adminLogin = await login(t, "state-admin@example.com", TEST_PASSWORD);
  adminCookie = adminLogin.sessionCookie;
});

afterAll(async () => {
  await t.close();
});

let employeeSeq = 0;
async function createEmployee(): Promise<number> {
  employeeSeq += 1;
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({
      companyId: companyRows[0]!.id,
      legalName: `State Test ${employeeSeq}`,
      hireDate: "2024-01-01",
    })
    .returning();
  return rows[0]!.id;
}

async function addMonthlyComp(employeeId: number, periodAmount: number, from = "2025-01-01") {
  await t.db.insert(compensation).values({
    employeeId,
    periodAmount: String(periodAmount),
    frequency: "monthly",
    effectiveFrom: from,
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
    generated: { id: number; runSnapshot: unknown }[];
    skipped: { employeeId: number; reason: string }[];
  };
}

async function stateWithholdingOf(runId: number): Promise<number> {
  const rows = await t.db.select().from(payrollEntries).where(eq(payrollEntries.runId, runId));
  const row = rows.find((r) => r.category === "state_withholding");
  return Number(row!.amount);
}

function putStateConfig(payload: unknown, cookie: string | null = adminCookie) {
  return t.app.inject({
    method: "PUT",
    url: "/api/admin/state-tax-config",
    headers: cookie ? sessionHeader(cookie) : ORIGIN,
    payload,
  });
}

describe("seed data", () => {
  it("seeds IL/CA/TX state tax configs", async () => {
    const rows = await t.db.select().from(stateTaxConfigs);
    const keys = rows.map((r) => `${r.jurisdiction}:${r.taxYear}`).sort();
    expect(keys).toContain("IL:2025");
    expect(keys).toContain("IL:2026");
    expect(keys).toContain("TX:2025");
    expect(keys).toContain("TX:2026");
    expect(keys).toContain("CA:single:2026");
    const brackets = await t.db.select().from(stateTaxBrackets);
    expect(brackets.filter((b) => b.jurisdiction === "CA:single").length).toBeGreaterThan(3);
  });
});

describe("admin state-tax-config route", () => {
  it("rejects invalid bodies", async () => {
    const bad = await putStateConfig({ jurisdiction: "IL" });
    expect(bad.statusCode).toBe(400);

    const progressiveNoBrackets = await putStateConfig({
      jurisdiction: "WA",
      taxYear: 2026,
      config: { kind: "progressive" },
      brackets: [],
    });
    expect(progressiveNoBrackets.statusCode).toBe(400);

    const flatNoRate = await putStateConfig({
      jurisdiction: "WA",
      taxYear: 2026,
      config: { kind: "flat" },
    });
    expect(flatNoRate.statusCode).toBe(400);
  });

  it("requires an admin session", async () => {
    const unauth = await putStateConfig(
      { jurisdiction: "WA", taxYear: 2026, config: { kind: "none" } },
      null,
    );
    expect(unauth.statusCode).toBe(401);

    await inviteAndOnboard(t, { email: "state-employee@example.com", role: "employee" });
    const empLogin = await login(t, "state-employee@example.com", TEST_PASSWORD);
    const forbidden = await putStateConfig(
      { jurisdiction: "WA", taxYear: 2026, config: { kind: "none" } },
      empLogin.sessionCookie,
    );
    expect(forbidden.statusCode).toBe(403);
  });

  it("upserts a config and replaces the bracket set atomically", async () => {
    const create = await putStateConfig({
      jurisdiction: "WA",
      taxYear: 2026,
      config: { kind: "flat", flatRate: 0.02, note: "test" },
    });
    expect(create.statusCode).toBe(200);

    const update = await putStateConfig({
      jurisdiction: "WA",
      taxYear: 2026,
      config: { kind: "progressive", note: "now with brackets" },
      brackets: [
        { ordinal: 1, minAmount: 0, maxAmount: 10_000, rate: 0.01 },
        { ordinal: 2, minAmount: 10_000, maxAmount: null, rate: 0.03 },
      ],
    });
    expect(update.statusCode).toBe(200);
    const updated = update.json() as { config: { kind: string } };
    expect(updated.config.kind).toBe("progressive");

    const rows = await t.db
      .select()
      .from(stateTaxBrackets)
      .where(eq(stateTaxBrackets.jurisdiction, "WA"));
    expect(rows).toHaveLength(2);
    expect(Number(rows[0]!.rate)).toBe(0.01);
  });
});

describe("work state assignment", () => {
  it("assigns, closes the previous window, and rejects overlapping dates", async () => {
    const employeeId = await createEmployee();

    const first = await t.app.inject({
      method: "PUT",
      url: `/api/admin/employees/${employeeId}/work-state`,
      headers: sessionHeader(adminCookie),
      payload: { stateCode: "IL", effectiveFrom: "2025-01-01" },
    });
    expect(first.statusCode).toBe(201);

    const second = await t.app.inject({
      method: "PUT",
      url: `/api/admin/employees/${employeeId}/work-state`,
      headers: sessionHeader(adminCookie),
      payload: { stateCode: "TX", effectiveFrom: "2025-06-01" },
    });
    expect(second.statusCode).toBe(201);

    const history = await t.app.inject({
      method: "GET",
      url: `/api/admin/employees/${employeeId}/work-state`,
      headers: sessionHeader(adminCookie),
    });
    const { workStates } = history.json() as {
      workStates: { stateCode: string; effectiveFrom: string; effectiveTo: string | null }[];
    };
    expect(workStates).toHaveLength(2);
    const il = workStates.find((w) => w.stateCode === "IL")!;
    const tx = workStates.find((w) => w.stateCode === "TX")!;
    expect(il.effectiveTo).toBe("2025-06-01");
    expect(tx.effectiveTo).toBeNull();

    const overlap = await t.app.inject({
      method: "PUT",
      url: `/api/admin/employees/${employeeId}/work-state`,
      headers: sessionHeader(adminCookie),
      payload: { stateCode: "CA", effectiveFrom: "2025-03-01" },
    });
    expect(overlap.statusCode).toBe(409);
  });

  it("validates the state code and employee", async () => {
    const employeeId = await createEmployee();
    const bad = await t.app.inject({
      method: "PUT",
      url: `/api/admin/employees/${employeeId}/work-state`,
      headers: sessionHeader(adminCookie),
      payload: { stateCode: "illinois", effectiveFrom: "2025-01-01" },
    });
    expect(bad.statusCode).toBe(400);

    const missing = await t.app.inject({
      method: "PUT",
      url: "/api/admin/employees/999999/work-state",
      headers: sessionHeader(adminCookie),
      payload: { stateCode: "IL", effectiveFrom: "2025-01-01" },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("state elections", () => {
  it("creates and lists elections; rejects exempt-with-allowances", async () => {
    const employeeId = await createEmployee();
    const create = await t.app.inject({
      method: "POST",
      url: `/api/admin/employees/${employeeId}/state-elections`,
      headers: sessionHeader(adminCookie),
      payload: {
        stateCode: "IL",
        filingStatus: "single",
        allowances: 2,
        effectiveFrom: "2025-01-01",
        filedDate: "2025-01-15",
      },
    });
    expect(create.statusCode).toBe(201);

    const list = await t.app.inject({
      method: "GET",
      url: `/api/admin/employees/${employeeId}/state-elections?state=IL`,
      headers: sessionHeader(adminCookie),
    });
    const { elections } = list.json() as { elections: { allowances: number }[] };
    expect(elections).toHaveLength(1);
    expect(elections[0]!.allowances).toBe(2);

    const exemptWithAllowances = await t.app.inject({
      method: "POST",
      url: `/api/admin/employees/${employeeId}/state-elections`,
      headers: sessionHeader(adminCookie),
      payload: {
        stateCode: "IL",
        exempt: true,
        allowances: 1,
        effectiveFrom: "2025-06-01",
        filedDate: "2025-06-01",
      },
    });
    expect(exemptWithAllowances.statusCode).toBe(400);
  });
});

describe("run generation with state withholding", () => {
  it("IL flat: no election → 4.95% of gross ($6,000/mo → $297.00)", async () => {
    const employeeId = await createEmployee();
    await addMonthlyComp(employeeId, 6000);
    await t.app.inject({
      method: "PUT",
      url: `/api/admin/employees/${employeeId}/work-state`,
      headers: sessionHeader(adminCookie),
      payload: { stateCode: "IL", effectiveFrom: "2025-01-01" },
    });
    const { generated, skipped } = await generate(employeeId, 2025, 3);
    expect(skipped).toHaveLength(0);
    expect(await stateWithholdingOf(generated[0]!.id)).toBe(297);

    const snapshot = generated[0]!.runSnapshot as RunSnapshot;
    expect(snapshot.inputs.state?.workState).toBe("IL");
    expect(snapshot.inputs.state?.jurisdiction).toBe("IL");
    expect(snapshot.inputs.state?.kind).toBe("flat");
    expect(snapshot.inputs.state?.flatRate).toBe(0.0495);
    expect(snapshot.inputs.state?.election).toBeNull();
    expect(snapshot.templateVersion).toBe("1.3.0");
  });

  it("IL election effective-dating: 2 allowances from June → $273.49", async () => {
    const employeeId = await createEmployee();
    await addMonthlyComp(employeeId, 6000);
    await t.app.inject({
      method: "PUT",
      url: `/api/admin/employees/${employeeId}/work-state`,
      headers: sessionHeader(adminCookie),
      payload: { stateCode: "IL", effectiveFrom: "2025-01-01" },
    });
    await t.app.inject({
      method: "POST",
      url: `/api/admin/employees/${employeeId}/state-elections`,
      headers: sessionHeader(adminCookie),
      payload: {
        stateCode: "IL",
        filingStatus: "single",
        allowances: 2,
        effectiveFrom: "2025-06-01",
        filedDate: "2025-05-20",
      },
    });

    // May: no election effective yet → 297.00. July: (72,000 − 2×2,850) × .0495
    // = 3,281.85/yr → 273.4875 → 273.49.
    const may = await generate(employeeId, 2025, 5);
    expect(await stateWithholdingOf(may.generated[0]!.id)).toBe(297);
    const july = await generate(employeeId, 2025, 7);
    expect(await stateWithholdingOf(july.generated[0]!.id)).toBe(273.49);
    const julySnapshot = july.generated[0]!.runSnapshot as RunSnapshot;
    expect(julySnapshot.inputs.state?.election?.allowances).toBe(2);
  });

  it("TX explicit zero-tax: $0.00 (kind='none', not a missing config)", async () => {
    const employeeId = await createEmployee();
    await addMonthlyComp(employeeId, 5000);
    await t.app.inject({
      method: "PUT",
      url: `/api/admin/employees/${employeeId}/work-state`,
      headers: sessionHeader(adminCookie),
      payload: { stateCode: "TX", effectiveFrom: "2025-01-01" },
    });
    const { generated, skipped } = await generate(employeeId, 2025, 3);
    expect(skipped).toHaveLength(0);
    expect(await stateWithholdingOf(generated[0]!.id)).toBe(0);
    const snapshot = generated[0]!.runSnapshot as RunSnapshot;
    expect(snapshot.inputs.state?.kind).toBe("none");
  });

  it("CA progressive (EDD Example F): $4,750/mo married 4 allowances → $7.17", async () => {
    const employeeId = await createEmployee();
    await addMonthlyComp(employeeId, 4750, "2026-01-01");
    await t.app.inject({
      method: "PUT",
      url: `/api/admin/employees/${employeeId}/work-state`,
      headers: sessionHeader(adminCookie),
      payload: { stateCode: "CA", effectiveFrom: "2026-01-01" },
    });
    await t.app.inject({
      method: "POST",
      url: `/api/admin/employees/${employeeId}/state-elections`,
      headers: sessionHeader(adminCookie),
      payload: {
        stateCode: "CA",
        filingStatus: "married_joint",
        allowances: 4,
        effectiveFrom: "2026-01-01",
        filedDate: "2026-01-02",
      },
    });
    const { generated, skipped } = await generate(employeeId, 2026, 1);
    expect(skipped).toHaveLength(0);
    expect(await stateWithholdingOf(generated[0]!.id)).toBe(7.17);
    const snapshot = generated[0]!.runSnapshot as RunSnapshot;
    expect(snapshot.inputs.state?.jurisdiction).toBe("CA:married_joint");
    expect(snapshot.inputs.state?.brackets.length).toBeGreaterThan(3);
  });

  it("work state without a config fails generation loudly (no_state_tax_config)", async () => {
    const employeeId = await createEmployee();
    await addMonthlyComp(employeeId, 4000);
    await t.app.inject({
      method: "PUT",
      url: `/api/admin/employees/${employeeId}/work-state`,
      headers: sessionHeader(adminCookie),
      payload: { stateCode: "NY", effectiveFrom: "2025-01-01", localityCode: null },
    });
    const { generated, skipped } = await generate(employeeId, 2025, 3);
    expect(generated).toHaveLength(0);
    expect(skipped).toEqual([{ employeeId, reason: "no_state_tax_config" }]);
  });

  it("no work state → legacy flat-rate path (seeded rate 0 → $0.00), no snapshot state block", async () => {
    const employeeId = await createEmployee();
    await addMonthlyComp(employeeId, 4000);
    const { generated, skipped } = await generate(employeeId, 2025, 3);
    expect(skipped).toHaveLength(0);
    expect(await stateWithholdingOf(generated[0]!.id)).toBe(0);
    const snapshot = generated[0]!.runSnapshot as RunSnapshot;
    expect(snapshot.inputs.state).toBeUndefined();
  });
});

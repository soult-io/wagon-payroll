/**
 * PAY-162 auditor-owned scenario test T10 (payroll-calc-auditor): a data
 * defect in one employee's summed amount is contained (P162-D5). Must FAIL
 * on origin/main 1fbd87e40a701e026709726a8a2716df924310d1.
 *
 * Test double: P162-D1 says `sumCents` wraps `parseCents` from
 * `@payroll/shared`. This file mocks that export so that, once armed, reading
 * the rounding employee's 2025 gross_pay sum ("13333.32", unique in the
 * fixture) behaves exactly as if the loader had returned "x" (the real
 * parseCents is called with "x" and throws). Every other value passes
 * through to the real parseCents.
 *
 * Fixture: the 2025 annual-forms fixture (twelve $8,000.00 January runs +
 * $1,111.11 x 12). Synthetic data only.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  company,
  compensation,
  employees,
  seedDatabase,
  type SeedDb,
  taxFilings,
} from "@payroll/db";
import { syncAnnualFilings } from "../src/filings/annual.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

const defect = vi.hoisted(() => ({ armed: false, target: "13333.32" }));

vi.mock("@payroll/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@payroll/shared")>();
  return {
    ...actual,
    parseCents: (value: string) =>
      defect.armed && value === defect.target ? actual.parseCents("x") : actual.parseCents(value),
  };
});

const TODAY = "2026-09-29";

/**
 * Issue-time wall clock (Spec 26 (PAY-173) D9 refuses issuing a past pay date
 * in an ended year). Each fixture run is issued on Dec 31 of its own pay year,
 * as a real company would have issued it; the W-2 figures do not depend on it.
 */
let issueAt = new Date("2025-12-31T12:00:00Z");
/** Fixture amount fragments that must never appear in a body or a log line. */
const AMOUNTS = ["8000", "1111", "109333", "13333", "1061.17", "826.68", "193.32"];

let t: TestContext;
let ADMIN: Record<string, string>;
let roundingId: number;
const logLines: string[] = [];

beforeAll(async () => {
  t = await createTestApp(
    { logLevel: "info" },
    { logStream: { write: (m) => logLines.push(m) }, clock: () => issueAt },
  );
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "defect-admin@test.dev", role: "admin" });
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);
  for (let i = 1; i <= 12; i += 1) {
    const id = await createEmployee(`Defect Cap ${String(i).padStart(2, "0")}`);
    await addCompensation(id, 8000);
    await issueRun(id, 2025, 1);
  }
  roundingId = await createEmployee("Defect Rounding");
  await addCompensation(roundingId, 1111.11);
  for (let month = 1; month <= 12; month += 1) await issueRun(roundingId, 2025, month);
  await syncAnnualFilings({ db: t.db, config: t.config }, { today: TODAY });
}, 300_000);

afterAll(async () => {
  defect.armed = false;
  await t.close();
});

async function createEmployee(legalName: string): Promise<number> {
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({ companyId: companyRows[0]?.id ?? 1, legalName, hireDate: "2025-01-01" })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("employee insert failed");
  return row.id;
}

async function addCompensation(employeeId: number, amount: number): Promise<void> {
  await t.db.insert(compensation).values({
    employeeId,
    periodAmount: String(amount),
    frequency: "monthly",
    effectiveFrom: "2025-01-01",
    effectiveTo: null,
  });
}

async function issueRun(employeeId: number, year: number, month: number): Promise<void> {
  issueAt = new Date(`${year}-12-31T12:00:00Z`);
  const gen = await t.app.inject({
    method: "POST",
    url: "/api/admin/payroll-runs/generate",
    headers: ADMIN,
    payload: { year, month, employeeId },
  });
  expect(gen.statusCode, gen.body).toBe(201);
  const run = (gen.json() as { generated: { publicId: string }[] }).generated[0];
  if (!run) throw new Error("no run generated");
  for (const action of ["approve", "issue"] as const) {
    const res = await t.app.inject({
      method: "POST",
      url: `/api/admin/payroll-runs/${run.publicId}/${action}`,
      headers: ADMIN,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
  }
}

/** The W-2 list body plus the three 409 PDF bodies for the defect employee. */
async function requestDefectSurfaces(): Promise<{ listBody: string; pdfBodies: string[] }> {
  const get = (url: string) => t.app.inject({ method: "GET", url, headers: ADMIN });
  const list = await get("/api/admin/annual-forms/w2?year=2025");
  expect(list.statusCode, list.body).toBe(200);
  const pdfBodies: string[] = [];
  for (const url of [
    `/api/admin/annual-forms/w2/${roundingId}/pdf?year=2025`,
    `/api/admin/annual-forms/w2/${roundingId}/print-packet?year=2025`,
    "/api/admin/annual-forms/w3/pdf?year=2025",
  ]) {
    const res = await get(url);
    expect(res.statusCode, url).toBe(409);
    pdfBodies.push(res.body);
  }
  return { listBody: list.body, pdfBodies };
}

function expectNoAmount(text: string, what: string): void {
  for (const a of AMOUNTS) expect(text, `${what} leaks ${a}`).not.toContain(a);
  expect(text, what).not.toMatch(/\d+\.\d\d/);
}

/**
 * The list legitimately carries the twelve unaffected W-2s ("8000.00",
 * "1061.17", ...). The defect employee's own figures (13333.32 wages,
 * 1111.11 per run, 826.68 / 193.32 withheld) and the W-3 total (109333.32)
 * must appear nowhere in the list body; the defect row itself carries no
 * amount at all.
 */
function expectListLeakFree(listBody: string): void {
  for (const a of ["1111", "13333", "826.68", "193.32", "109333"]) {
    expect(listBody, `list leaks ${a}`).not.toContain(a);
  }
  const rows = (JSON.parse(listBody) as { w2s: Record<string, unknown>[] }).w2s;
  const defectRow = rows.find((w) => w.employeeId === roundingId);
  expect(defectRow).toBeDefined();
  const { employeeId: _id, ...defectFields } = defectRow ?? {};
  expectNoAmount(JSON.stringify(defectFields), "defect row");
}

/**
 * pino adds clock/host fields ("time" epoch ms, "responseTime" float, "pid",
 * "hostname") whose digits can contain "8000" by chance; drop only those.
 */
function scrubLogLine(line: string): string {
  const NOISE = new Set(["time", "responseTime", "pid", "hostname"]);
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    return JSON.stringify(Object.fromEntries(Object.entries(obj).filter(([k]) => !NOISE.has(k))));
  } catch {
    return line;
  }
}

async function w2w3Row() {
  const rows = await t.db
    .select()
    .from(taxFilings)
    .where(
      and(eq(taxFilings.formType, "w2_w3"), eq(taxFilings.year, 2025), eq(taxFilings.quarter, 0)),
    );
  return rows[0];
}

describe("T10 a forced defect for one employee is contained (fail first)", () => {
  const consoleLines: string[] = [];
  let storedHash: string | null;
  let storedWorksheet: unknown;

  beforeAll(async () => {
    const row = await w2w3Row();
    storedHash = row?.worksheetHash ?? null;
    storedWorksheet = row?.worksheet;
    expect(storedHash).toMatch(/^[0-9a-f]{64}$/);
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
      });
    }
    logLines.length = 0;
    defect.armed = true;
  });

  it("list 200: the defect row has six null boxes and exactly one internal_mismatch block", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/api/admin/annual-forms/w2?year=2025",
      headers: ADMIN,
    });
    expect(res.statusCode, res.body).toBe(200);
    const rows = (res.json() as { w2s: Record<string, unknown>[] }).w2s;
    const row = rows.find((w) => w.employeeId === roundingId);
    for (const k of [
      "box1Wages",
      "box2FederalWithheld",
      "box3SsWages",
      "box4SsTax",
      "box5MedicareWages",
      "box6MedicareTax",
    ]) {
      expect(row?.[k], k).toBeNull();
    }
    expect(row?.issues).toEqual([{ code: "internal_mismatch", severity: "block" }]);
    // The other twelve W-2s are unaffected.
    for (const other of rows.filter((w) => w.employeeId !== roundingId)) {
      expect(other.issues).toEqual([]);
    }
  });

  it("the defect employee's W-2 PDFs and the W-3 PDF -> 409 (no 500)", async () => {
    for (const url of [
      `/api/admin/annual-forms/w2/${roundingId}/pdf?year=2025`,
      `/api/admin/annual-forms/w2/${roundingId}/print-packet?year=2025`,
      "/api/admin/annual-forms/w3/pdf?year=2025",
    ]) {
      const res = await t.app.inject({ method: "GET", url, headers: ADMIN });
      expect(res.statusCode, url).toBe(409);
    }
  });

  it("sync leaves the stored W-3 worksheet and hash unchanged, even when other W-2s change", async () => {
    // A new February run for an unaffected employee: without the skip, the
    // refresh would rewrite the 2025 worksheet with the other twelve W-2s.
    const other = (
      await t.db
        .select({ id: employees.id })
        .from(employees)
        .where(eq(employees.legalName, "Defect Cap 01"))
    )[0];
    if (!other) throw new Error("fixture employee missing");
    await issueRun(other.id, 2025, 2);
    await syncAnnualFilings({ db: t.db, config: t.config }, { today: TODAY });
    const row = await w2w3Row();
    expect(row?.worksheetHash).toBe(storedHash);
    expect(row?.worksheet).toEqual(storedWorksheet);
  });

  it("no defect-row field, PDF body or log line contains a fixture amount", async () => {
    // Order-safe: this test makes its own requests (list, three PDFs, a sync)
    // and checks only the bodies and log lines they produce.
    logLines.length = 0;
    consoleLines.length = 0;
    const { listBody, pdfBodies } = await requestDefectSurfaces();
    await syncAnnualFilings({ db: t.db, config: t.config }, { today: TODAY });
    expectListLeakFree(listBody);
    // PDF 409 bodies carry codes only.
    for (const body of pdfBodies) expectNoAmount(body, "pdf body");
    // The log check must not be vacuous.
    expect(logLines.length).toBeGreaterThan(0);
    for (const text of [...logLines.map(scrubLogLine), ...consoleLines]) {
      for (const a of AMOUNTS) expect(text, `log leaks ${a}`).not.toContain(a);
      expect(text).not.toContain('"x"');
      expect(text).not.toContain("not a money string");
    }
  });
});

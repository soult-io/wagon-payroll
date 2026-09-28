/**
 * Spec 24 (PAY-116) PR-1 — employer state tax account numbers, routes and
 * storage. Real SQL via the PGlite harness; HTTP through app.inject.
 *
 * Covers W26 (format checks per state, params/body validation before any
 * query, 400 bodies that never echo input), W27 (filed years are frozen:
 * 409 state_id_year_filed) and W28 (write-only storage: masked reads and
 * audit, encrypted column enforced by the database, GCM failure masked as
 * "••••", DELETE of a missing row 404 without audit, auth matrix, no state
 * ID in /api/export or the W-2 figures). The year-effective lookup and the
 * IL/NY EIN default are covered in state-id-lookup.test.ts.
 *
 * All identifiers are synthetic.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  auditEvents,
  company,
  employees,
  payrollEntries,
  payrollRuns,
  seedDatabase,
  taxFilings,
  type SeedDb,
} from "@payroll/db";
import { decryptField, encryptField } from "../src/crypto/field-encryption.js";
import { createTestApp, ORIGIN, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

const EXPORT_TOKEN = "export-token-for-state-id-tests-0123456789";
/** Synthetic company EIN; its digits never collide with a state ID below. */
const EIN = "98-7654321";

let t: TestContext;
let adminCookie: string;
let employeeCookie: string;

beforeAll(async () => {
  t = await createTestApp({ exportToken: EXPORT_TOKEN });
  await seedDatabase(t.db as unknown as SeedDb);
  await t.db.update(company).set({ ein: encryptField(EIN, t.config.encryptionKey) });
  await inviteAndOnboard(t, { email: "sid-admin@example.com", role: "admin" });
  adminCookie = (await login(t, "sid-admin@example.com", TEST_PASSWORD)).sessionCookie;
  await inviteAndOnboard(t, { email: "sid-employee@example.com", role: "employee" });
  employeeCookie = (await login(t, "sid-employee@example.com", TEST_PASSWORD)).sessionCookie;
});

afterAll(async () => {
  await t.close();
});

type Method = "GET" | "PUT" | "DELETE";

function api(method: Method, url: string, payload?: unknown, cookie: string | null = adminCookie) {
  return t.app.inject({
    method,
    url,
    headers: cookie ? sessionHeader(cookie) : ORIGIN,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

const BASE = "/api/admin/company/state-ids";

function put(stateCode: string, body: unknown, cookie: string | null = adminCookie) {
  return api("PUT", `${BASE}/${stateCode}`, body, cookie);
}

function del(stateCode: string, year: string | number, cookie: string | null = adminCookie) {
  return api("DELETE", `${BASE}/${stateCode}/${year}`, undefined, cookie);
}

/** Stored row for (state, year), decrypted with the test key; null when absent. */
async function storedPlain(stateCode: string, fromTaxYear: number): Promise<string | null> {
  const res = await t.pglite.query<{ state_id: string }>(
    "SELECT state_id FROM company_state_ids WHERE state_code = $1 AND from_tax_year = $2",
    [stateCode, fromTaxYear],
  );
  const row = res.rows[0];
  return row ? decryptField(row.state_id, t.config.encryptionKey) : null;
}

async function auditFor(action: string, entityId: string) {
  return t.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.entityId, entityId)))
    .orderBy(desc(auditEvents.id));
}

/** The audit row's payload as JSON (the bigint id is left out). */
function auditJson(
  row:
    | { action: string; entity: string; entityId: string; before: unknown; after: unknown }
    | undefined,
) {
  return JSON.stringify(
    row
      ? {
          action: row.action,
          entity: row.entity,
          entityId: row.entityId,
          before: row.before,
          after: row.after,
        }
      : null,
  );
}

async function auditCount(): Promise<number> {
  const [row] = await t.db.select({ n: sql<number>`count(*)::int` }).from(auditEvents);
  return row?.n ?? 0;
}

async function clearStateIds() {
  await t.pglite.exec("DELETE FROM company_state_ids");
}

async function setFiling(year: number, status: "not_started" | "ready" | "filed") {
  await t.db
    .insert(taxFilings)
    .values({ formType: "w2_w3", year, quarter: 0, dueDate: `${year + 1}-02-01`, status })
    .onConflictDoUpdate({
      target: [taxFilings.formType, taxFilings.year, taxFilings.quarter],
      set: { status },
    });
}

async function clearFilings() {
  await t.pglite.exec("DELETE FROM tax_filings WHERE form_type = 'w2_w3'");
}

// ---------------------------------------------------------------------------
// W26 — format checks per state (S24-D2)
// ---------------------------------------------------------------------------

describe("W26 state ID format checks", () => {
  const cases: { state: string; input: string; status: 200 | 400; stored?: string }[] = [
    { state: "CA", input: "123-4567-8", status: 200, stored: "12345678" },
    { state: "CA", input: "1234567", status: 400 },
    { state: "NC", input: "123456789", status: 200, stored: "123456789" },
    { state: "NC", input: "APPLIEDFOR", status: 400 },
    { state: "MD", input: "12-345678", status: 200, stored: "12345678" },
    { state: "MD", input: "1234567890", status: 400 }, // 10-digit UI number
    { state: "MD", input: "123456789", status: 400 }, // 9-digit FEIN
    { state: "IL", input: "123456789", status: 200, stored: "123456789" },
    { state: "IL", input: "123456789000", status: 200, stored: "123456789000" },
    { state: "IL", input: "ABC 12", status: 400 },
    { state: "NY", input: "123456789", status: 200, stored: "123456789" },
    { state: "NY", input: "12345678901", status: 200, stored: "12345678901" },
    { state: "NY", input: "123456789012", status: 200, stored: "123456789012" },
    { state: "NY", input: "1234567", status: 400 }, // 7-digit UI employer registration number
    { state: "TX", input: "AB\u000712", status: 400 }, // control character in free text
  ];

  for (const c of cases) {
    it(`${c.state} ${JSON.stringify(c.input)} → ${c.status}`, async () => {
      await clearStateIds();
      const res = await put(c.state, { stateId: c.input });
      expect(res.statusCode).toBe(c.status);
      if (c.status === 200) {
        expect(await storedPlain(c.state, 2026)).toBe(c.stored);
        const body = res.json();
        expect(body.stateId).toMatchObject({
          stateCode: c.state,
          fromTaxYear: 2026,
          source: "entered",
        });
        expect(body.stateId.idMasked).toBe(`••••${(c.stored ?? "").slice(-4)}`);
        expect(res.body).not.toContain(c.stored);
      } else {
        expect(res.json().error).toBe("invalid_body");
        expect(await storedPlain(c.state, 2026)).toBeNull();
      }
      expect(res.body).not.toContain(c.input);
      expect(res.body).not.toContain(c.input.replace(/[\s-]/g, ""));
    });
  }

  it("free text is trimmed and stored as typed; over 20 characters is refused", async () => {
    await clearStateIds();
    const ok = await put("TX", { stateId: "  Acct 12-AB9  " });
    expect(ok.statusCode).toBe(200);
    expect(await storedPlain("TX", 2026)).toBe("Acct 12-AB9");
    const long = await put("OH", { stateId: "A".repeat(21) });
    expect(long.statusCode).toBe(400);
    expect(long.body).not.toContain("A".repeat(21));
    const blank = await put("OH", { stateId: "   " });
    expect(blank.statusCode).toBe(400);
  });

  it("a PUT to the same (state, year) replaces the stored value", async () => {
    await clearStateIds();
    expect((await put("CA", { stateId: "11111111" })).statusCode).toBe(200);
    expect((await put("CA", { stateId: "22222222" })).statusCode).toBe(200);
    expect(await storedPlain("CA", 2026)).toBe("22222222");
    const rows = await t.pglite.query("SELECT 1 FROM company_state_ids WHERE state_code = 'CA'");
    expect(rows.rows).toHaveLength(1);
  });

  it("unknown body keys and a missing stateId are 400", async () => {
    const extra = await put("CA", { stateId: "12345678", note: "x" });
    expect(extra.statusCode).toBe(400);
    const missing = await put("CA", {});
    expect(missing.statusCode).toBe(400);
  });
});

describe("W26 / M1 params and body range are validated before any query", () => {
  const badStateCodes = ["ca", "C1", "CAL"];
  for (const code of badStateCodes) {
    it(`PUT :stateCode ${code} → 400`, async () => {
      const res = await put(code, { stateId: "12345678" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_params");
      expect(res.body).not.toContain(code);
      expect(res.body).not.toContain("12345678");
    });
    it(`DELETE :stateCode ${code} → 400`, async () => {
      const res = await del(code, 2026);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_params");
    });
  }

  for (const year of ["2025", "2101", "abc", "2026.5"]) {
    it(`DELETE :fromTaxYear ${year} → 400`, async () => {
      const res = await del("CA", year);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_params");
      expect(res.body).not.toContain(year);
    });
  }

  for (const year of [2025, 2101, "2026x"] as const) {
    it(`PUT body fromTaxYear ${JSON.stringify(year)} → 400`, async () => {
      const res = await put("CA", { stateId: "12345678", fromTaxYear: year });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_body");
      expect(res.body).not.toContain(String(year));
      expect(res.body).not.toContain("12345678");
    });
  }

  it("400 bodies carry only path and code (safeIssues)", async () => {
    const res = await put("CA", { stateId: "1234567" });
    const body = res.json() as { details: Record<string, unknown>[] };
    for (const issue of body.details) {
      for (const key of Object.keys(issue)) expect(["path", "code", "message"]).toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// W27 — filed years are frozen (S24-D2, L9, L4)
// ---------------------------------------------------------------------------

describe("W27 filed-year freeze", () => {
  it("PUT or DELETE that would change a filed year's ID → 409; later years stay editable", async () => {
    await clearStateIds();
    await clearFilings();
    expect((await put("CA", { stateId: "00000001" })).statusCode).toBe(200);
    expect((await put("CA", { stateId: "00000002", fromTaxYear: 2028 })).statusCode).toBe(200);

    await setFiling(2026, "filed");
    const before = await auditCount();

    const putFiled = await put("CA", { stateId: "00000009", fromTaxYear: 2026 });
    expect(putFiled.statusCode).toBe(409);
    expect(putFiled.json()).toEqual({ error: "state_id_year_filed" });
    expect(putFiled.body).not.toContain("00000009");

    const delFiled = await del("CA", 2026);
    expect(delFiled.statusCode).toBe(409);
    expect(delFiled.json()).toEqual({ error: "state_id_year_filed" });

    expect(await storedPlain("CA", 2026)).toBe("00000001");
    expect(await auditCount()).toBe(before);

    const put2027 = await put("CA", { stateId: "00000003", fromTaxYear: 2027 });
    expect(put2027.statusCode).toBe(200);
    expect(await storedPlain("CA", 2027)).toBe("00000003");
  });

  it("a filed year before the row's start is not affected; a ready (unfiled) year is", async () => {
    await clearStateIds();
    await clearFilings();
    await setFiling(2026, "filed");
    await setFiling(2027, "ready");
    // No CA row yet: a new row from 2027 changes 2027+ only.
    expect((await put("CA", { stateId: "00000004", fromTaxYear: 2027 })).statusCode).toBe(200);
    // A new row from 2026 would change the filed 2026 (no ID → an ID).
    expect((await put("CA", { stateId: "00000005", fromTaxYear: 2026 })).statusCode).toBe(409);
    // Deleting the 2027 row changes 2027 only, which is not filed.
    expect((await del("CA", 2027)).statusCode).toBe(204);
  });

  it("an IL row from a filed year is refused (it would replace the EIN default)", async () => {
    await clearStateIds();
    await clearFilings();
    await setFiling(2026, "filed");
    expect((await put("IL", { stateId: "123456789000", fromTaxYear: 2026 })).statusCode).toBe(409);
    expect((await put("IL", { stateId: "123456789000", fromTaxYear: 2027 })).statusCode).toBe(200);
    await clearFilings();
  });
});

// ---------------------------------------------------------------------------
// W28 — security
// ---------------------------------------------------------------------------

describe("W28 write-only storage and masking", () => {
  it("GET shows the mask only; the column is enc:v1; audit holds idMasked only", async () => {
    await clearStateIds();
    await clearFilings();
    const res = await put("CA", { stateId: "00000001" });
    expect(res.statusCode).toBe(200);

    const get = await api("GET", BASE);
    expect(get.statusCode).toBe(200);
    expect(get.json().stateIds).toEqual([
      { stateCode: "CA", fromTaxYear: 2026, idMasked: "••••0001", source: "entered" },
    ]);
    expect(get.body).not.toContain("00000001");

    const col = await t.pglite.query<{ state_id: string }>(
      "SELECT state_id FROM company_state_ids WHERE state_code = 'CA'",
    );
    expect(col.rows[0]?.state_id).toMatch(/^enc:v1:[A-Za-z0-9_-]{39,}$/);

    const [audit] = await auditFor("company.state_id.set", "CA:2026");
    expect(audit).toBeDefined();
    expect(audit?.entity).toBe("company_state_id");
    expect(audit?.after).toEqual({ idMasked: "••••0001" });
    expect(audit?.before).toBeNull(); // a new row has no before-state
    expect(auditJson(audit)).not.toContain("00000001");

    // Replacing the value audits before and after, both masked.
    expect((await put("CA", { stateId: "00000002" })).statusCode).toBe(200);
    const [second] = await auditFor("company.state_id.set", "CA:2026");
    expect(second?.before).toEqual({ idMasked: "••••0001" });
    expect(second?.after).toEqual({ idMasked: "••••0002" });
  });

  it("the database refuses a plaintext value and a too-short enc:v1 value", async () => {
    await expect(
      t.pglite.query(
        "INSERT INTO company_state_ids (company_id, state_code, from_tax_year, state_id) VALUES (1, 'NC', 2026, '123456789')",
      ),
    ).rejects.toThrow(/company_state_ids_encrypted_check/);
    await expect(
      t.pglite.query(
        "INSERT INTO company_state_ids (company_id, state_code, from_tax_year, state_id) VALUES (1, 'NC', 2026, 'enc:v1:x')",
      ),
    ).rejects.toThrow(/company_state_ids_encrypted_check/);
  });

  it("the database refuses a bad state code and an out-of-range year", async () => {
    const enc = encryptField("123456789", t.config.encryptionKey);
    await expect(
      t.pglite.query(
        "INSERT INTO company_state_ids (company_id, state_code, from_tax_year, state_id) VALUES (1, 'nc', 2026, $1)",
        [enc],
      ),
    ).rejects.toThrow(/company_state_ids_state_code_check/);
    await expect(
      t.pglite.query(
        "INSERT INTO company_state_ids (company_id, state_code, from_tax_year, state_id) VALUES (1, 'NC', 1999, $1)",
        [enc],
      ),
    ).rejects.toThrow(/company_state_ids_year_check/);
  });

  it("a short free-text ID (AB12) is shown and audited as •••• only", async () => {
    await clearStateIds();
    const res = await put("TX", { stateId: "AB12" });
    expect(res.statusCode).toBe(200);
    expect(res.json().stateId.idMasked).toBe("••••");
    expect(res.body).not.toContain("AB12");
    const get = await api("GET", BASE);
    expect(get.json().stateIds).toEqual([
      { stateCode: "TX", fromTaxYear: 2026, idMasked: "••••", source: "entered" },
    ]);
    expect(get.body).not.toContain("AB12");
    const rows = await auditFor("company.state_id.set", "TX:2026");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(auditJson(row)).not.toContain("AB12");
    expect(rows[0]?.after).toEqual({ idMasked: "••••" });
  });

  it("L1: a ciphertext that fails GCM authentication reads as •••• (200, never 500)", async () => {
    await clearStateIds();
    expect((await put("CA", { stateId: "00000001" })).statusCode).toBe(200);
    const col = await t.pglite.query<{ state_id: string }>(
      "SELECT state_id FROM company_state_ids WHERE state_code = 'CA'",
    );
    const value = col.rows[0]?.state_id ?? "";
    // Flip one character inside the IV|tag|ciphertext body; still passes the CHECK.
    const i = "enc:v1:".length + 10;
    const flipped = value.slice(0, i) + (value[i] === "A" ? "B" : "A") + value.slice(i + 1);
    await t.pglite.query("UPDATE company_state_ids SET state_id = $1 WHERE state_code = 'CA'", [
      flipped,
    ]);
    const get = await api("GET", BASE);
    expect(get.statusCode).toBe(200);
    expect(get.json().stateIds).toEqual([
      { stateCode: "CA", fromTaxYear: 2026, idMasked: "••••", source: "entered" },
    ]);
    // A replacing PUT still works and its audit "before" is the failed mask.
    expect((await put("CA", { stateId: "00000002" })).statusCode).toBe(200);
    const [audit] = await auditFor("company.state_id.set", "CA:2026");
    expect(audit?.before).toEqual({ idMasked: "••••" });
  });

  it("DELETE removes the row (204) with a masked audit row", async () => {
    await clearStateIds();
    expect((await put("NC", { stateId: "123456789" })).statusCode).toBe(200);
    const res = await del("NC", 2026);
    expect(res.statusCode).toBe(204);
    expect(await storedPlain("NC", 2026)).toBeNull();
    const [audit] = await auditFor("company.state_id.delete", "NC:2026");
    expect(audit?.entity).toBe("company_state_id");
    expect(audit?.before).toEqual({ idMasked: "••••6789" });
    expect(audit?.after).toBeNull();
    expect(auditJson(audit)).not.toContain("123456789");
  });

  it("L5: DELETE of a (state, year) with no row → 404 not_found, no audit row", async () => {
    await clearStateIds();
    const before = await auditCount();
    const res = await del("TX", 2027);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
    expect(await auditCount()).toBe(before);
  });
});

describe("W28 auth matrix", () => {
  it("employee 403 and no session 401 on GET, PUT and DELETE", async () => {
    await clearStateIds();
    expect((await api("GET", BASE, undefined, employeeCookie)).statusCode).toBe(403);
    expect((await api("GET", BASE, undefined, null)).statusCode).toBe(401);
    expect((await put("CA", { stateId: "12345678" }, employeeCookie)).statusCode).toBe(403);
    expect((await put("CA", { stateId: "12345678" }, null)).statusCode).toBe(401);
    expect((await del("CA", 2026, employeeCookie)).statusCode).toBe(403);
    expect((await del("CA", 2026, null)).statusCode).toBe(401);
    expect(await storedPlain("CA", 2026)).toBeNull();
  });

  it("the guard runs before validation: bad params from an employee are 403, not 400", async () => {
    expect((await put("ca", { stateId: "x" }, employeeCookie)).statusCode).toBe(403);
    expect((await del("CA", "abc", null)).statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET: IL/NY EIN defaults and the "needed" list
// ---------------------------------------------------------------------------

let empSeq = 0;
async function employeeWithRun(opts: {
  workState: string | null;
  kind: "none" | "flat" | "progressive";
  payDate: string;
  stateTax: string;
}) {
  empSeq += 1;
  const [companyRow] = await t.db.select({ id: company.id }).from(company).limit(1);
  const [emp] = await t.db
    .insert(employees)
    .values({
      companyId: companyRow?.id ?? 1,
      legalName: `State Id Person ${empSeq}`,
      hireDate: "2025-01-01",
      employmentType: "w2",
      status: "active",
    })
    .returning();
  const snapshot = {
    inputs: opts.workState ? { state: { workState: opts.workState, kind: opts.kind } } : {},
  };
  const [run] = await t.db
    .insert(payrollRuns)
    .values({
      employeeId: emp?.id ?? 0,
      periodStart: `${opts.payDate.slice(0, 7)}-01`,
      periodEnd: `${opts.payDate.slice(0, 7)}-28`,
      payDate: opts.payDate,
      status: "issued",
      runSnapshot: snapshot,
      createdBy: "test",
    })
    .returning();
  await t.db.insert(payrollEntries).values([
    { runId: run?.id ?? 0, category: "gross_pay", amount: "5000.00" },
    { runId: run?.id ?? 0, category: "state_withholding", amount: opts.stateTax },
  ]);
}

describe("GET defaults and needed", () => {
  it("IL and NY default to the EIN only while the company has an EIN", async () => {
    await clearStateIds();
    const get = await api("GET", BASE);
    expect(get.json().defaults).toEqual([
      { stateCode: "IL", idMasked: "••••4321", source: "ein_default" },
      { stateCode: "NY", idMasked: "••••4321", source: "ein_default" },
    ]);
    expect(get.body).not.toContain("7654321");

    // An entered IL row from 2026 replaces the IL default.
    expect((await put("IL", { stateId: "111111111" })).statusCode).toBe(200);
    const withIl = await api("GET", BASE);
    expect(withIl.json().defaults).toEqual([
      { stateCode: "NY", idMasked: "••••4321", source: "ein_default" },
    ]);

    const saved = await t.db.select({ ein: company.ein }).from(company).limit(1);
    await t.db.update(company).set({ ein: null });
    try {
      const noEin = await api("GET", BASE);
      expect(noEin.json().defaults).toEqual([]);
    } finally {
      await t.db.update(company).set({ ein: saved[0]?.ein ?? null });
    }
  });

  it("needed lists 2026+ states with issued wages and no ID, with the reason", async () => {
    await clearStateIds();
    await employeeWithRun({
      workState: "NC",
      kind: "flat",
      payDate: "2026-03-25",
      stateTax: "12.00",
    });
    await employeeWithRun({
      workState: "CA",
      kind: "progressive",
      payDate: "2026-03-25",
      stateTax: "0.00",
    });
    await employeeWithRun({
      workState: "TX",
      kind: "none",
      payDate: "2026-03-25",
      stateTax: "0.00",
    });
    await employeeWithRun({
      workState: "IL",
      kind: "flat",
      payDate: "2026-03-25",
      stateTax: "20.00",
    }); // EIN default
    await employeeWithRun({
      workState: "MD",
      kind: "progressive",
      payDate: "2025-03-25",
      stateTax: "9.00",
    }); // pre-2026
    await employeeWithRun({
      workState: null,
      kind: "flat",
      payDate: "2026-04-25",
      stateTax: "7.00",
    }); // legacy

    const get = await api("GET", BASE);
    expect(get.json().needed).toEqual([
      { stateCode: "CA", taxYear: 2026, reason: "wages_only" },
      { stateCode: "NC", taxYear: 2026, reason: "tax_withheld" },
    ]);

    expect((await put("NC", { stateId: "123456789" })).statusCode).toBe(200);
    const after = await api("GET", BASE);
    expect(after.json().needed).toEqual([{ stateCode: "CA", taxYear: 2026, reason: "wages_only" }]);
  });
});

// ---------------------------------------------------------------------------
// W28 / K8 — no state ID leaves through exports or the W-2 figures
// ---------------------------------------------------------------------------

describe("W28 no state ID in exports or figures", () => {
  it("/api/export responses and the W-2 list never carry a state ID", async () => {
    await clearStateIds();
    expect((await put("CA", { stateId: "00000001" })).statusCode).toBe(200);
    expect((await put("NY", { stateId: "123456789012" })).statusCode).toBe(200);
    const auth = { authorization: `Bearer ${EXPORT_TOKEN}` };
    const bodies: string[] = [];
    for (const url of [
      "/api/export/payroll-runs",
      "/api/export/payroll-runs?format=csv",
      "/api/export/contractor-payments?year=2026",
    ]) {
      const res = await t.app.inject({ method: "GET", url, headers: auth });
      expect(res.statusCode).toBeLessThan(500);
      bodies.push(res.body);
    }
    const w2 = await api("GET", "/api/admin/annual-forms/w2?year=2026");
    bodies.push(w2.body);
    for (const body of bodies) {
      expect(body).not.toContain("00000001");
      expect(body).not.toContain("123456789012");
      expect(body).not.toContain("state_id");
    }
  });
});

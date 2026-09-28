/**
 * PAY-163 (Spec 25 (PAY-120), step G1) — residence and work-locality capture,
 * the local-tax coverage seed, and the read-only "would block" check.
 * Real SQL via the PGlite harness. Nothing here blocks a pay run: G1 only
 * captures data and reports what the guard would say.
 *
 * Covers: M-G1 constraints; LT42 (coverage seeder idempotent); LT35 G1 half
 * (a work-state row written before M-G1 is listed as
 * work_locality_unconfirmed, and draft generation still succeeds); residence
 * and work-locality routes (admin 200/201, employee 403, no session 401,
 * unknown or invalid id 404 with one body, 400 bodies that never echo input,
 * audit rows with codes and dates only); the address hint (state only).
 * All people and addresses are synthetic.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  auditEvents,
  company,
  compensation,
  employeeResidences,
  employeeWorkStates,
  employees,
  LOCAL_TAX_COVERAGE_FILE,
  localTaxCoverage,
  seedDatabase,
  seedLocalTaxCoverage,
  type LocalTaxCoverageFile,
  type SeedDb,
} from "@payroll/db";
import { LOCALITY_CODES, WORK_LOCALITY_CODES } from "@payroll/shared";
import { encryptAddress } from "../src/crypto/address-encryption.js";
import { createTestApp, ORIGIN, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

/** Non-null or throw — keeps test code free of `!` assertions. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

let t: TestContext;
let adminCookie: string;
let adminId: string;
let employeeCookie: string;

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "local-admin@example.com", role: "admin" });
  adminId = admin.userId;
  adminCookie = (await login(t, "local-admin@example.com", TEST_PASSWORD)).sessionCookie;
  await inviteAndOnboard(t, { email: "local-employee@example.com", role: "employee" });
  employeeCookie = (await login(t, "local-employee@example.com", TEST_PASSWORD)).sessionCookie;
});

afterAll(async () => {
  await t.close();
});

let seq = 0;
async function createEmployee(
  opts: {
    address?: { line1: string; city: string; state: string; zip: string; country: string } | null;
    employmentType?: "w2" | "1099";
    status?: "active" | "terminated";
  } = {},
): Promise<number> {
  seq += 1;
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({
      companyId: must(companyRows[0], "company").id,
      legalName: `Local Test ${seq}`,
      hireDate: "2024-01-01",
      employmentType: opts.employmentType ?? "w2",
      status: opts.status ?? "active",
      address: opts.address ? encryptAddress(opts.address, t.config.encryptionKey) : null,
    })
    .returning();
  return must(rows[0], "employee").id;
}

function api(
  method: "GET" | "PUT",
  url: string,
  payload?: unknown,
  cookie: string | null = adminCookie,
) {
  return t.app.inject({
    method,
    url,
    headers: cookie ? sessionHeader(cookie) : ORIGIN,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

const residenceUrl = (id: number | string) => `/api/admin/employees/${id}/residence`;
const workStateUrl = (id: number | string) => `/api/admin/employees/${id}/work-state`;
const workLocalityUrl = (id: number | string) => `/api/admin/employees/${id}/work-state/locality`;

async function auditRows(employeeId: number, action: string) {
  return t.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.entityId, String(employeeId)), eq(auditEvents.action, action)))
    .orderBy(desc(auditEvents.id));
}

/** Insert a work-state row exactly as pre-G1 code wrote it (no locality, unconfirmed). */
async function legacyWorkState(
  employeeId: number,
  stateCode: string,
  effectiveFrom = "2025-01-01",
) {
  await t.db.insert(employeeWorkStates).values({ employeeId, stateCode, effectiveFrom });
}

// ---------------------------------------------------------------------------
// M-G1 schema
// ---------------------------------------------------------------------------

describe("M-G1 constraints", () => {
  async function insertResidence(values: Partial<typeof employeeResidences.$inferInsert>) {
    const employeeId = values.employeeId ?? (await createEmployee());
    return t.db.insert(employeeResidences).values({
      employeeId,
      country: "US",
      stateCode: "TX",
      localityCode: null,
      effectiveFrom: "2026-01-01",
      createdBy: "test",
      ...values,
    });
  }

  it("accepts every residence locality on the closed list and rejects anything else", async () => {
    for (const code of LOCALITY_CODES) {
      await insertResidence({ stateCode: code.slice(0, 2), localityCode: code });
    }
    await expect(insertResidence({ stateCode: "NY", localityCode: "NY-BRONX" })).rejects.toThrow();
  });

  it("a locality must belong to the residence state; Maryland needs a county", async () => {
    await expect(insertResidence({ stateCode: "TX", localityCode: "NY-NYC" })).rejects.toThrow();
    await expect(insertResidence({ stateCode: "MD", localityCode: null })).rejects.toThrow();
  });

  it("US residences carry a state; foreign residences carry neither state nor locality", async () => {
    await expect(insertResidence({ stateCode: null })).rejects.toThrow();
    await expect(insertResidence({ country: "ES", stateCode: "TX" })).rejects.toThrow();
    await expect(
      insertResidence({ country: "ES", stateCode: null, localityCode: "NY-NYC" }),
    ).rejects.toThrow();
    await insertResidence({ country: "ES", stateCode: null });
  });

  it("rejects bad country codes, unknown sources and inverted windows", async () => {
    await expect(insertResidence({ country: "usa" })).rejects.toThrow();
    await expect(insertResidence({ source: "address" })).rejects.toThrow();
    await expect(
      insertResidence({ effectiveFrom: "2026-02-01", effectiveTo: "2026-02-01" }),
    ).rejects.toThrow();
  });

  it("overlapping residence windows for one employee are impossible", async () => {
    const employeeId = await createEmployee();
    await insertResidence({ employeeId, effectiveFrom: "2026-01-01", effectiveTo: null });
    await expect(insertResidence({ employeeId, effectiveFrom: "2026-03-01" })).rejects.toThrow();
    // A different employee may share the window.
    await insertResidence({ effectiveFrom: "2026-03-01" });
  });

  it("work-state locality: closed work list, same state, confirmed when set; NYC never a work locality", async () => {
    const employeeId = await createEmployee();
    const at = new Date();
    let from = 1;
    const insert = (values: Partial<typeof employeeWorkStates.$inferInsert>) => {
      from += 1;
      return t.db.insert(employeeWorkStates).values({
        employeeId,
        stateCode: "NY",
        effectiveFrom: `2020-01-${String(from).padStart(2, "0")}`,
        effectiveTo: `2020-01-${String(from).padStart(2, "0")}`.replace("2020", "2021"),
        ...values,
      });
    };
    for (const code of WORK_LOCALITY_CODES) {
      await insert({ stateCode: code.slice(0, 2), localityCode: code, localityConfirmedAt: at });
    }
    await expect(insert({ localityCode: "NY-NYC", localityConfirmedAt: at })).rejects.toThrow();
    await expect(
      insert({ stateCode: "NY", localityCode: "MD-510", localityConfirmedAt: at }),
    ).rejects.toThrow();
    await expect(
      insert({ localityCode: "NY-YONKERS", localityConfirmedAt: null }),
    ).rejects.toThrow();
    // Legacy shape (no locality, unconfirmed) stays valid.
    await insert({});
  });
});

// ---------------------------------------------------------------------------
// Coverage seed (LT42)
// ---------------------------------------------------------------------------

describe("local tax coverage seed", () => {
  it("seedDatabase loads the coverage list; every row carries a source", async () => {
    const rows = await t.db.select().from(localTaxCoverage);
    expect(rows.length).toBe(LOCAL_TAX_COVERAGE_FILE.rows.length);
    for (const row of rows) expect(row.source.length).toBeGreaterThan(0);
    const engine = rows
      .filter((r) => r.handling === "engine")
      .map((r) => `${r.code}:${r.basis}`)
      .sort();
    expect(engine).toEqual([
      "MD:residence",
      "MD:work",
      "NY-NYC:residence",
      "NY-YONKERS:residence",
      "NY-YONKERS:work",
    ]);
    const unsupported = rows.filter((r) => r.handling === "unsupported");
    const byState = (code: string) =>
      unsupported
        .filter((r) => r.code === code)
        .map((r) => r.basis)
        .sort();
    for (const s of ["DE", "IN", "MI", "MO", "OH", "OR"]) {
      expect(byState(s), s).toEqual(["residence", "work"]);
    }
    for (const s of ["AL", "CO", "KY", "PA", "WV"]) expect(byState(s), s).toEqual(["work"]);
    expect(byState("IA")).toEqual([]);
  });

  it("marks every row whose source was not fetched live as sourceVerified: false", () => {
    for (const row of LOCAL_TAX_COVERAGE_FILE.rows) {
      expect(typeof row.sourceVerified).toBe("boolean");
      expect(row.source.length).toBeGreaterThan(0);
    }
    expect(LOCAL_TAX_COVERAGE_FILE.rows.some((r) => r.sourceVerified === false)).toBe(true);
  });

  it("LT42: running the seeder twice leaves no duplicate rows", async () => {
    const db = t.db as unknown as SeedDb;
    await seedLocalTaxCoverage(db);
    await seedLocalTaxCoverage(db);
    const rows = await t.db.select().from(localTaxCoverage);
    expect(rows.length).toBe(LOCAL_TAX_COVERAGE_FILE.rows.length);
    const keys = new Set(rows.map((r) => `${r.code}:${r.basis}`));
    expect(keys.size).toBe(rows.length);
  });

  it("re-converges: a row dropped from the file is removed, a changed row is updated", async () => {
    const db = t.db as unknown as SeedDb;
    await t.db
      .insert(localTaxCoverage)
      .values({ code: "ZZ", basis: "work", handling: "unsupported", source: "stale" });
    const edited: LocalTaxCoverageFile = {
      ...LOCAL_TAX_COVERAGE_FILE,
      rows: LOCAL_TAX_COVERAGE_FILE.rows.map((r) =>
        r.code === "AL" ? { ...r, note: "edited note" } : r,
      ),
    };
    await seedLocalTaxCoverage(db, edited);
    const rows = await t.db.select().from(localTaxCoverage);
    expect(rows.find((r) => r.code === "ZZ")).toBeUndefined();
    expect(rows.find((r) => r.code === "AL")?.note).toBe("edited note");
    await seedLocalTaxCoverage(db);
  });

  it("rejects a malformed coverage file without touching the table", async () => {
    const db = t.db as unknown as SeedDb;
    const before = await t.db.select().from(localTaxCoverage);
    const first = must(LOCAL_TAX_COVERAGE_FILE.rows[0], "coverage row");
    const bad: LocalTaxCoverageFile[] = [
      { ...LOCAL_TAX_COVERAGE_FILE, rows: [] },
      { ...LOCAL_TAX_COVERAGE_FILE, rows: [{ ...first, basis: "home" as "work" }] },
      { ...LOCAL_TAX_COVERAGE_FILE, rows: [{ ...first, handling: "maybe" as "engine" }] },
      { ...LOCAL_TAX_COVERAGE_FILE, rows: [{ ...first, source: "" }] },
      { ...LOCAL_TAX_COVERAGE_FILE, rows: [{ ...first, code: "ny" }] },
      { ...LOCAL_TAX_COVERAGE_FILE, rows: [first, first] },
      {
        ...LOCAL_TAX_COVERAGE_FILE,
        rows: [{ ...first, sourceVerified: "yes" as unknown as boolean }],
      },
    ];
    for (const file of bad) await expect(seedLocalTaxCoverage(db, file)).rejects.toThrow();
    const after = await t.db.select().from(localTaxCoverage);
    expect(after.length).toBe(before.length);
  });
});

// ---------------------------------------------------------------------------
// Residence routes
// ---------------------------------------------------------------------------

describe("GET /api/admin/employees/:employeeId/residence", () => {
  it("401 without a session, 403 for an employee", async () => {
    const id = await createEmployee();
    expect((await api("GET", residenceUrl(id), undefined, null)).statusCode).toBe(401);
    expect((await api("GET", residenceUrl(id), undefined, employeeCookie)).statusCode).toBe(403);
  });

  it("unknown and invalid ids get the same 404 body", async () => {
    const bodies = new Set<string>();
    for (const id of ["999999", "abc", "0", "-1", "1.5", "99999999999", "%20"]) {
      const res = await api("GET", residenceUrl(id));
      expect(res.statusCode, id).toBe(404);
      bodies.add(res.body);
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: "not_found" })]);
  });

  it("empty history, no address → current null, addressHint null", async () => {
    const id = await createEmployee({ address: null });
    const res = await api("GET", residenceUrl(id));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ current: null, history: [], addressHint: null });
  });

  it("address hint: state only, normalized from a full name; never street, city or ZIP", async () => {
    const address = {
      line1: "742 Synthetic Terrace",
      city: "Exampleville",
      state: "New York",
      zip: "10999",
      country: "US",
    };
    const id = await createEmployee({ address });
    const res = await api("GET", residenceUrl(id));
    expect(res.json().addressHint).toEqual({ country: "US", state: "NY" });
    for (const secret of [address.line1, address.city, address.zip, "New York"]) {
      expect(res.body).not.toContain(secret);
    }
  });

  it("address hint: lowercase code normalized; unknown text → null; foreign state never read as a US state", async () => {
    const md = await createEmployee({
      address: { line1: "1 A St", city: "Sampletown", state: "md", zip: "21999", country: "US" },
    });
    expect((await api("GET", residenceUrl(md))).json().addressHint).toEqual({
      country: "US",
      state: "MD",
    });
    const odd = await createEmployee({
      address: { line1: "1 A St", city: "Sampletown", state: "Nowhere", zip: "0", country: "US" },
    });
    expect((await api("GET", residenceUrl(odd))).json().addressHint).toEqual({
      country: "US",
      state: null,
    });
    const foreign = await createEmployee({
      address: { line1: "1 Calle", city: "Ciudad", state: "MD", zip: "28000", country: "es" },
    });
    expect((await api("GET", residenceUrl(foreign))).json().addressHint).toEqual({
      country: "ES",
      state: null,
    });
  });
});

describe("PUT /api/admin/employees/:employeeId/residence", () => {
  it("401 without a session, 403 for an employee, 404 for unknown/invalid ids", async () => {
    const id = await createEmployee();
    const body = {
      country: "US",
      stateCode: "TX",
      localityCode: null,
      effectiveFrom: "2026-01-01",
    };
    expect((await api("PUT", residenceUrl(id), body, null)).statusCode).toBe(401);
    expect((await api("PUT", residenceUrl(id), body, employeeCookie)).statusCode).toBe(403);
    for (const bad of ["999999", "abc", "0"]) {
      const res = await api("PUT", residenceUrl(bad), body);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
    }
    const rows = await t.db
      .select()
      .from(employeeResidences)
      .where(eq(employeeResidences.employeeId, id));
    expect(rows).toHaveLength(0);
  });

  it("creates the first residence (201, source admin) and audits codes and dates only", async () => {
    const id = await createEmployee({
      address: { line1: "9 Mock Rd", city: "Faketown", state: "NY", zip: "10998", country: "US" },
    });
    const res = await api("PUT", residenceUrl(id), {
      country: "US",
      stateCode: "NY",
      localityCode: "NY-NYC",
      effectiveFrom: "2026-01-01",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().residence).toMatchObject({
      employeeId: id,
      country: "US",
      stateCode: "NY",
      localityCode: "NY-NYC",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      source: "admin",
    });
    const [row] = await t.db
      .select()
      .from(employeeResidences)
      .where(eq(employeeResidences.employeeId, id));
    expect(must(row, "residence row").createdBy).toBe(adminId);

    const audits = await auditRows(id, "employee_residence.assign");
    expect(audits).toHaveLength(1);
    expect(must(audits[0], "audit row").actorId).toBe(adminId);
    expect(must(audits[0], "audit row").entity).toBe("employee");
    expect(must(audits[0], "audit row").before).toBeNull();
    expect(must(audits[0], "audit row").after).toEqual({
      country: "US",
      stateCode: "NY",
      localityCode: "NY-NYC",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      source: "admin",
    });
    const auditJson = JSON.stringify([
      must(audits[0], "audit row").before,
      must(audits[0], "audit row").after,
    ]);
    for (const secret of ["9 Mock Rd", "Faketown", "10998", "Local Test"]) {
      expect(auditJson).not.toContain(secret);
    }

    const get = (await api("GET", residenceUrl(id))).json();
    expect(get.current).toMatchObject({ localityCode: "NY-NYC" });
    expect(get.history).toHaveLength(1);
    expect(get.history[0]).not.toHaveProperty("createdBy");
  });

  it("a new residence closes the open row at its start date; before/after audited", async () => {
    const id = await createEmployee();
    const first = await api("PUT", residenceUrl(id), {
      country: "US",
      stateCode: "NY",
      localityCode: "NY-NYC",
      effectiveFrom: "2026-01-01",
    });
    expect(first.statusCode).toBe(201);
    const second = await api("PUT", residenceUrl(id), {
      country: "US",
      stateCode: "MD",
      localityCode: "MD-510",
      effectiveFrom: "2026-06-15",
    });
    expect(second.statusCode).toBe(201);
    const rows = await t.db
      .select()
      .from(employeeResidences)
      .where(eq(employeeResidences.employeeId, id))
      .orderBy(employeeResidences.effectiveFrom);
    expect(rows.map((r) => [r.localityCode, r.effectiveFrom, r.effectiveTo])).toEqual([
      ["NY-NYC", "2026-01-01", "2026-06-15"],
      ["MD-510", "2026-06-15", null],
    ]);
    const audits = await auditRows(id, "employee_residence.assign");
    expect(must(audits[0], "audit row").before).toMatchObject({
      localityCode: "NY-NYC",
      effectiveFrom: "2026-01-01",
    });
    expect(must(audits[0], "audit row").after).toMatchObject({
      localityCode: "MD-510",
      effectiveFrom: "2026-06-15",
    });

    const history = (await api("GET", residenceUrl(id))).json().history;
    expect(history.map((h: { localityCode: string }) => h.localityCode)).toEqual([
      "MD-510",
      "NY-NYC",
    ]);
  });

  it("409 invalid_effective_from when the start is not after the open row's start", async () => {
    const id = await createEmployee();
    const body = {
      country: "US",
      stateCode: "TX",
      localityCode: null,
      effectiveFrom: "2026-03-01",
    };
    expect((await api("PUT", residenceUrl(id), body)).statusCode).toBe(201);
    for (const effectiveFrom of ["2026-03-01", "2026-02-01"]) {
      const res = await api("PUT", residenceUrl(id), { ...body, stateCode: "NJ", effectiveFrom });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("invalid_effective_from");
    }
  });

  it("400 invalid_body for bad input — the body never echoes what was sent", async () => {
    const id = await createEmployee();
    const marker = "Zq9<script>";
    const bad: Record<string, unknown>[] = [
      { country: "US", stateCode: "MD", localityCode: null, effectiveFrom: "2026-01-01" },
      { country: "US", stateCode: "TX", localityCode: "NY-NYC", effectiveFrom: "2026-01-01" },
      { country: "US", stateCode: "NY", localityCode: `NY-${marker}`, effectiveFrom: "2026-01-01" },
      { country: marker, stateCode: null, localityCode: null, effectiveFrom: "2026-01-01" },
      { country: "US", stateCode: marker, localityCode: null, effectiveFrom: "2026-01-01" },
      { country: "US", stateCode: "TX", localityCode: null, effectiveFrom: marker },
      {
        country: "US",
        stateCode: "TX",
        localityCode: null,
        effectiveFrom: "2026-01-01",
        [marker]: 1,
      },
      {
        country: "US",
        stateCode: "TX",
        localityCode: null,
        effectiveFrom: "2026-01-01",
        note: marker,
      },
    ];
    for (const body of bad) {
      const res = await api("PUT", residenceUrl(id), body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error).toBe("invalid_body");
      expect(res.body).not.toContain("Zq9");
    }
    const rows = await t.db
      .select()
      .from(employeeResidences)
      .where(eq(employeeResidences.employeeId, id));
    expect(rows).toHaveLength(0);
  });

  it("a foreign residence is stored with no state and no locality", async () => {
    const id = await createEmployee();
    const res = await api("PUT", residenceUrl(id), {
      country: "ES",
      stateCode: null,
      localityCode: null,
      effectiveFrom: "2026-01-01",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().residence).toMatchObject({
      country: "ES",
      stateCode: null,
      localityCode: null,
    });
  });

  it("sameAsBefore: inserts a same-values row and audits employee_residence.confirm", async () => {
    const id = await createEmployee();
    const body = {
      country: "US",
      stateCode: "NY",
      localityCode: "NY-YONKERS",
      effectiveFrom: "2026-01-01",
    };
    expect((await api("PUT", residenceUrl(id), body)).statusCode).toBe(201);
    const res = await api("PUT", residenceUrl(id), {
      ...body,
      effectiveFrom: "2026-09-01",
      sameAsBefore: true,
    });
    expect(res.statusCode).toBe(201);
    const confirms = await auditRows(id, "employee_residence.confirm");
    expect(confirms).toHaveLength(1);
    expect(must(confirms[0], "audit row").after).toMatchObject({
      localityCode: "NY-YONKERS",
      effectiveFrom: "2026-09-01",
    });
    expect(await auditRows(id, "employee_residence.assign")).toHaveLength(1);
    const rows = await t.db
      .select()
      .from(employeeResidences)
      .where(eq(employeeResidences.employeeId, id));
    expect(rows).toHaveLength(2);
  });

  it("sameAsBefore with different values, or with nothing on file, is refused (409)", async () => {
    const id = await createEmployee();
    const body = {
      country: "US",
      stateCode: "TX",
      localityCode: null,
      effectiveFrom: "2026-01-01",
    };
    const none = await api("PUT", residenceUrl(id), { ...body, sameAsBefore: true });
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toBe("not_same_as_before");
    expect((await api("PUT", residenceUrl(id), body)).statusCode).toBe(201);
    const differs = await api("PUT", residenceUrl(id), {
      ...body,
      stateCode: "NJ",
      effectiveFrom: "2026-05-01",
      sameAsBefore: true,
    });
    expect(differs.statusCode).toBe(409);
    expect(differs.json().error).toBe("not_same_as_before");
  });
});

// ---------------------------------------------------------------------------
// Work state + locality
// ---------------------------------------------------------------------------

describe("PUT /api/admin/employees/:employeeId/work-state (locality question)", () => {
  it("New York must answer the Yonkers question; the answer confirms the row", async () => {
    const id = await createEmployee();
    const missing = await api("PUT", workStateUrl(id), {
      stateCode: "NY",
      effectiveFrom: "2026-01-01",
    });
    expect(missing.statusCode).toBe(400);
    const no = await api("PUT", workStateUrl(id), {
      stateCode: "NY",
      effectiveFrom: "2026-01-01",
      localityCode: null,
    });
    expect(no.statusCode).toBe(201);
    expect(no.json().workState).toMatchObject({
      stateCode: "NY",
      localityCode: null,
      localityConfirmedBy: adminId,
    });
    expect(no.json().workState.localityConfirmedAt).not.toBeNull();
    const yes = await api("PUT", workStateUrl(id), {
      stateCode: "NY",
      effectiveFrom: "2026-04-01",
      localityCode: "NY-YONKERS",
    });
    expect(yes.statusCode).toBe(201);
    expect(yes.json().workState.localityCode).toBe("NY-YONKERS");
  });

  it("Maryland needs a county; NYC is never a work locality; locality must match the state", async () => {
    const id = await createEmployee();
    for (const payload of [
      { stateCode: "MD", effectiveFrom: "2026-01-01", localityCode: null },
      { stateCode: "MD", effectiveFrom: "2026-01-01" },
      { stateCode: "NY", effectiveFrom: "2026-01-01", localityCode: "NY-NYC" },
      { stateCode: "IL", effectiveFrom: "2026-01-01", localityCode: "MD-510" },
    ]) {
      const res = await api("PUT", workStateUrl(id), payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const ok = await api("PUT", workStateUrl(id), {
      stateCode: "MD",
      effectiveFrom: "2026-01-01",
      localityCode: "MD-510",
    });
    expect(ok.statusCode).toBe(201);
  });

  it("other states need no answer and stay unconfirmed (nothing to confirm)", async () => {
    const id = await createEmployee();
    const res = await api("PUT", workStateUrl(id), {
      stateCode: "IL",
      effectiveFrom: "2026-01-01",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().workState).toMatchObject({ localityCode: null, localityConfirmedAt: null });
  });

  it("unknown and invalid ids get the same 404 body", async () => {
    for (const bad of ["999999", "abc", "-3"]) {
      const res = await api("PUT", workStateUrl(bad), {
        stateCode: "IL",
        effectiveFrom: "2026-01-01",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
      const get = await api("GET", workStateUrl(bad));
      expect(get.statusCode).toBe(404);
      expect(get.json()).toEqual({ error: "not_found" });
    }
  });
});

describe("PUT /api/admin/employees/:employeeId/work-state/locality (backfill)", () => {
  it("confirms the locality on the open pre-G1 row and audits it", async () => {
    const id = await createEmployee();
    await legacyWorkState(id, "NY");
    const res = await api("PUT", workLocalityUrl(id), { localityCode: "NY-YONKERS" });
    expect(res.statusCode).toBe(200);
    expect(res.json().workState).toMatchObject({
      stateCode: "NY",
      localityCode: "NY-YONKERS",
      localityConfirmedBy: adminId,
    });
    const audits = await auditRows(id, "employee_work_state.locality");
    expect(audits).toHaveLength(1);
    expect(must(audits[0], "audit row").before).toEqual({
      stateCode: "NY",
      localityCode: null,
      localityConfirmed: false,
      effectiveFrom: "2025-01-01",
    });
    expect(must(audits[0], "audit row").after).toEqual({
      stateCode: "NY",
      localityCode: "NY-YONKERS",
      localityConfirmed: true,
      effectiveFrom: "2025-01-01",
    });
  });

  it("confirms 'no taxing locality' for New York with null", async () => {
    const id = await createEmployee();
    await legacyWorkState(id, "NY");
    const res = await api("PUT", workLocalityUrl(id), { localityCode: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().workState.localityConfirmedAt).not.toBeNull();
  });

  it("Maryland needs a county; the locality must match the open row's state", async () => {
    const id = await createEmployee();
    await legacyWorkState(id, "MD");
    expect((await api("PUT", workLocalityUrl(id), { localityCode: null })).statusCode).toBe(400);
    expect((await api("PUT", workLocalityUrl(id), { localityCode: "NY-YONKERS" })).statusCode).toBe(
      400,
    );
    expect((await api("PUT", workLocalityUrl(id), { localityCode: "MD-021" })).statusCode).toBe(
      200,
    );
  });

  it("409 when there is no open work-state row", async () => {
    const id = await createEmployee();
    const res = await api("PUT", workLocalityUrl(id), { localityCode: null });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_open_work_state");
  });

  it("401 / 403 / 404, and 400 bodies never echo input", async () => {
    const id = await createEmployee();
    await legacyWorkState(id, "NY");
    expect((await api("PUT", workLocalityUrl(id), { localityCode: null }, null)).statusCode).toBe(
      401,
    );
    expect(
      (await api("PUT", workLocalityUrl(id), { localityCode: null }, employeeCookie)).statusCode,
    ).toBe(403);
    const missing = await api("PUT", workLocalityUrl("abc"), { localityCode: null });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not_found" });
    const bad = await api("PUT", workLocalityUrl(id), { localityCode: "NY-Zq9<b>" });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain("Zq9");
  });
});

// ---------------------------------------------------------------------------
// Read-only check (G1: nothing is enforced)
// ---------------------------------------------------------------------------

interface CheckBody {
  enforced: boolean;
  employees: { employeeId: number; name: string; status: "ok" | "blocked"; reasons: string[] }[];
}

async function check(payDate?: string, cookie: string | null = adminCookie) {
  return api(
    "GET",
    `/api/admin/local-tax/check${payDate ? `?payDate=${payDate}` : ""}`,
    undefined,
    cookie,
  );
}

function entryFor(body: CheckBody, employeeId: number) {
  return body.employees.find((e) => e.employeeId === employeeId);
}

describe("GET /api/admin/local-tax/check", () => {
  it("401 without a session, 403 for an employee", async () => {
    expect((await check("2026-10-25", null)).statusCode).toBe(401);
    expect((await check("2026-10-25", employeeCookie)).statusCode).toBe(403);
  });

  it("400 for a bad payDate, without echoing it", async () => {
    for (const bad of ["2026-13-01", "Zq9", "2026-1-1"]) {
      const res = await check(bad);
      expect(res.statusCode, bad).toBe(400);
      expect(res.body).not.toContain("Zq9");
    }
  });

  it("defaults the pay date to today and reports enforced: false", async () => {
    const res = await check();
    expect(res.statusCode).toBe(200);
    expect((res.json() as CheckBody).enforced).toBe(false);
  });

  it("lists active W-2 employees only, with reasons; no address data", async () => {
    const noResidence = await createEmployee({
      address: { line1: "3 Sham Ln", city: "Mocksville", state: "TX", zip: "73999", country: "US" },
    });
    const texan = await createEmployee();
    await api("PUT", residenceUrl(texan), {
      country: "US",
      stateCode: "TX",
      localityCode: null,
      effectiveFrom: "2026-01-01",
    });
    const nyc = await createEmployee();
    await api("PUT", residenceUrl(nyc), {
      country: "US",
      stateCode: "NY",
      localityCode: "NY-NYC",
      effectiveFrom: "2026-01-01",
    });
    await api("PUT", workStateUrl(nyc), {
      stateCode: "NY",
      effectiveFrom: "2026-01-01",
      localityCode: null,
    });
    const contractor = await createEmployee({ employmentType: "1099" });
    const gone = await createEmployee({ status: "terminated" });

    const res = await check("2026-10-25");
    expect(res.statusCode).toBe(200);
    const body = res.json() as CheckBody;
    expect(entryFor(body, noResidence)).toMatchObject({
      status: "blocked",
      reasons: ["residence_missing"],
    });
    expect(must(entryFor(body, noResidence), "check entry").name).toMatch(/^Local Test/);
    expect(entryFor(body, texan)).toMatchObject({ status: "ok", reasons: [] });
    // G1 loads no local tax tables: an NYC resident would be held until they exist.
    expect(entryFor(body, nyc)).toMatchObject({
      status: "blocked",
      reasons: ["local_not_yet_supported"],
    });
    expect(entryFor(body, contractor)).toBeUndefined();
    expect(entryFor(body, gone)).toBeUndefined();
    for (const secret of ["3 Sham Ln", "Mocksville", "73999"])
      expect(res.body).not.toContain(secret);
  });

  it("resolves the residence on the pay date", async () => {
    const id = await createEmployee();
    await api("PUT", residenceUrl(id), {
      country: "US",
      stateCode: "TX",
      localityCode: null,
      effectiveFrom: "2026-11-01",
    });
    const before = (await check("2026-10-25")).json() as CheckBody;
    expect(must(entryFor(before, id), "check entry").reasons).toEqual(["residence_missing"]);
    const after = (await check("2026-11-25")).json() as CheckBody;
    expect(must(entryFor(after, id), "check entry").reasons).toEqual([]);
  });

  it("LT35 (G1 half): a NY work-state row written before M-G1 is listed as work_locality_unconfirmed, and draft generation still succeeds", async () => {
    const id = await createEmployee();
    await legacyWorkState(id, "NY", "2025-01-01");
    await api("PUT", residenceUrl(id), {
      country: "US",
      stateCode: "NJ",
      localityCode: null,
      effectiveFrom: "2025-01-01",
    });
    await t.db.insert(compensation).values({
      employeeId: id,
      periodAmount: "5000.00",
      frequency: "monthly",
      effectiveFrom: "2025-01-01",
    });

    const body = (await check("2026-03-15")).json() as CheckBody;
    expect(entryFor(body, id)).toMatchObject({
      status: "blocked",
      reasons: ["work_locality_unconfirmed"],
    });

    const gen = await t.app.inject({
      method: "POST",
      url: "/api/admin/payroll-runs/generate",
      headers: sessionHeader(adminCookie),
      payload: { year: 2026, month: 3, employeeId: id },
    });
    expect(gen.statusCode).toBe(201);
    const result = gen.json() as { generated: unknown[]; skipped: unknown[] };
    expect(result.skipped).toEqual([]);
    expect(result.generated).toHaveLength(1);
  });

  it("an empty coverage table is reported as local_coverage_missing for every W-2 employee", async () => {
    const id = await createEmployee();
    await t.db.execute(sql`DELETE FROM local_tax_coverage`);
    try {
      const body = (await check("2026-10-25")).json() as CheckBody;
      expect(must(entryFor(body, id), "check entry").reasons).toContain("local_coverage_missing");
      expect(body.employees.every((e) => e.reasons.includes("local_coverage_missing"))).toBe(true);
    } finally {
      await seedLocalTaxCoverage(t.db as unknown as SeedDb);
    }
  });
});

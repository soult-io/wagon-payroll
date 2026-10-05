/**
 * Spec 24 (PAY-116) PR-4 "blocks, UI, notices" — server suite
 * (payroll-calc-auditor, fail-first; the coder may not edit this file).
 * Synthetic data only; runs are direct inserts with literal snapshots
 * (w2-state-harness.ts). Expected values are computed by hand below.
 *
 * Tests: W22-ext, W31-ext, C-d1, C-f1, C-f2.
 *
 * Hand values:
 *  - Ana (W01): CA 12 runs x 12.34 state tax = 148.08 (box 17 and the issued
 *    runs' state withholding). W22 deposit rows: 4 quarters x (3 x 12.34) =
 *    4 x 37.02 = 148.08.
 *  - Dee (W05): IL / MD / NC = three state lines, two per form -> formCount 2.
 *
 * API contract assumed (PR-4 brief S2-S4):
 *  - GET /api/admin/annual-forms/w2?year= adds
 *      notified: boolean  (the year is in notifiedYears())
 *      stateChecks: { state, box17, runWithholding, attributedLegacy,
 *        deposited, reconciled }[]  (exactly these keys; money as "0.00"
 *        strings; [] before 2026 and [] while any W-2 of the year has
 *        withheld boxes)
 *  - GET /api/my/w2 rows: exactly { year, availableOn, ready, corrected,
 *    downloadable, formCount }; formCount = number of forms when ready,
 *    null otherwise.
 *  - GET /api/admin/company/state-ids adds
 *      furnished: { stateCode, taxYear, employees }[]  (counts only; unfiled
 *      w2_w3 years >= 2026 with a furnishing row)
 *  - PUT /api/admin/company/state-ids/:stateCode answers 200
 *    { stateId: {...masked row}, unchanged: boolean } — `unchanged` at the
 *    top level of the body. An identical value writes nothing (no new
 *    ciphertext, no updated_at change, no audit row).
 */

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appSettings,
  auditEvents,
  companyStateIds,
  taxDeposits,
  taxFilings,
  w2Furnishings,
} from "@payroll/db";
import { computeW3Worksheet, sendW2AvailableNotices } from "../src/filings/annual.js";
import { reconcileW2Furnishings } from "../src/filings/w2-furnish.js";
import type { Db } from "../src/db.js";
import {
  bootEnv,
  consentedEmployee,
  createEmployee,
  enterStateId,
  type Env,
  get,
  insertRuns,
  list,
  rowOf,
  setEin,
  stateView,
  SYNTHETIC_EIN,
} from "./w2-state-harness.js";
import { canonicalSha, type FxRun, money, monthly, months, st } from "./w2-state-oracle.js";

const CA = st("CA");
const IL = st("IL");
const MD = st("MD");
const NC = st("NC");
const AFTER_YEAR_END = "2027-01-05T12:00:00Z";
const TODAY_2027 = "2027-01-05";

const ana = (): FxRun[] => months(2026, 1, 12).map((m) => monthly(m, CA, 1234));
const dee = (): FxRun[] => [
  ...months(2026, 1, 4).map((m) => monthly(m, IL, 24750)),
  ...months(2026, 5, 8).map((m) => monthly(m, MD, 2500)),
  ...months(2026, 9, 12).map((m) => monthly(m, NC, 2000)),
];

const deps = (env: Env) => ({ db: env.t.db, config: env.t.config }) as never;
const w3 = (env: Env, year: number) => computeW3Worksheet(env.t.db as unknown as Db, year);

interface ListBody {
  notified?: unknown;
  stateChecks?: unknown;
  w2s: { employeeId: number }[];
}

async function listBody(env: Env, year: number): Promise<ListBody> {
  const l = await list(env, year);
  if (l.status !== 200) throw new Error(`list ${year} -> ${l.status}`);
  return l.json as unknown as ListBody;
}

// ---------------------------------------------------------------------------
// W22-ext — the deposited figure is UI-only: it moves with the deposit
// status, the W-2 figures, worksheet and hash do not (S24-D10).
// ---------------------------------------------------------------------------

describe("W22-ext CA deposits pending -> deposited -> overdue: stateChecks.deposited moves, figures do not", () => {
  let env: Env;
  let id = 0;
  beforeAll(async () => {
    env = await bootEnv();
    await enterStateId(env, "CA");
    id = await createEmployee(env, "Ana TwentyTwo Synthetic");
    await insertRuns(env, id, ana());
    for (const q of [1, 2, 3, 4]) {
      await env.t.db.insert(taxDeposits).values({
        jurisdiction: "CA",
        periodStart: `2026-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`,
        periodKind: "quarter",
        amount: money(3 * 1234),
        dueDate: q === 4 ? "2027-01-31" : `2026-${String(q * 3 + 1).padStart(2, "0")}-30`,
        status: "pending",
        createdBy: "test",
      });
    }
  });
  afterAll(async () => env.close());

  it("stateChecks CA: box17 148.08, runWithholding 148.08, deposited 0.00 -> 148.08 -> 0.00; row, worksheet and SHA identical", async () => {
    const snap = async () => {
      const ws = await w3(env, 2026);
      const body = await listBody(env, 2026);
      return {
        fig: { row: stateView(await rowOf(env, 2026, id)), ws, hash: canonicalSha(ws) },
        checks: body.stateChecks,
      };
    };
    const pending = await snap();
    await env.t.db
      .update(taxDeposits)
      .set({ status: "deposited", depositedOn: "2026-12-15" })
      .where(eq(taxDeposits.jurisdiction, "CA"));
    const deposited = await snap();
    await env.t.db
      .update(taxDeposits)
      .set({ status: "overdue", depositedOn: null })
      .where(eq(taxDeposits.jurisdiction, "CA"));
    const overdue = await snap();
    const check = (dep: string) => [
      {
        state: "CA",
        box17: "148.08",
        runWithholding: "148.08",
        attributedLegacy: "0.00",
        deposited: dep,
        reconciled: true,
      },
    ];
    expect({
      pending: pending.checks,
      deposited: deposited.checks,
      overdue: overdue.checks,
      figuresSame: [deposited.fig, overdue.fig].map(
        (f) => JSON.stringify(f) === JSON.stringify(pending.fig),
      ),
    }).toEqual({
      pending: check("0.00"),
      deposited: check("148.08"),
      overdue: check("0.00"),
      figuresSame: [true, true],
    });
  });

  it("the deposited figure never enters the worksheet: no 'deposited' key in the W-3 worksheet", async () => {
    const ws = await w3(env, 2026);
    expect(JSON.stringify(ws)).not.toMatch(/deposited/i);
  });

  it("stateChecks is [] for a year before 2026; notified is a boolean (false: no notice sent)", async () => {
    const y2025 = await listBody(env, 2025);
    const y2026 = await listBody(env, 2026);
    expect({ c2025: y2025.stateChecks, n2025: y2025.notified, n2026: y2026.notified }).toEqual({
      c2025: [],
      n2025: false,
      n2026: false,
    });
  });
});

// ---------------------------------------------------------------------------
// W31-ext — the list says whether the year notice went out (I4).
// ---------------------------------------------------------------------------

describe("W31-ext blocked 2026 W-2 (no CA ID): notified false while held; after the ID and one tick: true", () => {
  let env: Env;
  let anaId = 0;
  beforeAll(async () => {
    env = await bootEnv({ now: "2027-01-01T09:00:00Z" });
    await setEin(env, SYNTHETIC_EIN);
    anaId = (await consentedEmployee(env, "Ana Formtest Synthetic")).employeeId;
    await insertRuns(env, anaId, ana());
  }, 180_000);
  afterAll(async () => env.close());

  it("notified false + sent 0 while blocked; CA ID entered + tick: sent 1, notified true; still true after a second tick (sent 0)", async () => {
    const blocked = {
      notice: await sendW2AvailableNotices(deps(env), { today: "2027-01-01" }),
      notified: (await listBody(env, 2026)).notified,
    };
    await enterStateId(env, "CA", "00000001");
    const fixed = {
      notice: await sendW2AvailableNotices(deps(env), { today: "2027-01-01" }),
      notified: (await listBody(env, 2026)).notified,
    };
    const again = {
      notice: await sendW2AvailableNotices(deps(env), { today: "2027-01-01" }),
      notified: (await listBody(env, 2026)).notified,
    };
    expect({ blocked, fixed, again }).toEqual({
      blocked: { notice: { sent: 0 }, notified: false },
      fixed: { notice: { sent: 1 }, notified: true },
      again: { notice: { sent: 0 }, notified: true },
    });
  });

  it("I4: a year already notified that becomes blocked again keeps notified true (the email clause must not apply)", async () => {
    await env.t.db.delete(companyStateIds).where(eq(companyStateIds.stateCode, "CA"));
    const l = await list(env, 2026);
    const row = (l.json as unknown as { w2s: { employeeId: number; blocked: boolean }[] }).w2s.find(
      (r) => r.employeeId === anaId,
    );
    expect({ blocked: row?.blocked, notified: (l.json as unknown as ListBody).notified }).toEqual({
      blocked: true,
      notified: true,
    });
  });
});

// ---------------------------------------------------------------------------
// C-d1 — employee W-2 list: formCount only when ready (security gate 3).
// ---------------------------------------------------------------------------

describe("C-d1 /api/my/w2 formCount (Dee W05: IL, MD, NC; consented; IDs set)", () => {
  let env: Env;
  let session: Record<string, string> = {};
  beforeAll(async () => {
    env = await bootEnv({ now: AFTER_YEAR_END });
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "MD", "00000002");
    await enterStateId(env, "NC", "000000003");
    const emp = await consentedEmployee(env, "Dee Synthetic");
    session = emp.session;
    await insertRuns(env, emp.employeeId, dee());
  }, 180_000);
  afterAll(async () => env.close());

  const my2026 = async () => {
    const res = await get(env, "/api/my/w2", session);
    expect(res.statusCode).toBe(200);
    const rows = (res.json() as { w2s: Record<string, unknown>[] }).w2s;
    const row = rows.find((r) => r.year === 2026);
    if (!row) throw new Error("no 2026 row on /api/my/w2");
    return row;
  };

  it("ready: formCount 2; key set exactly {year, availableOn, ready, corrected, downloadable, formCount, accessThrough (PAY-208 N1)}", async () => {
    const row = await my2026();
    expect({
      keys: Object.keys(row).sort(),
      ready: row.ready,
      formCount: row.formCount,
      accessThrough: row.accessThrough,
    }).toEqual({
      keys: [
        "accessThrough",
        "availableOn",
        "corrected",
        "downloadable",
        "formCount",
        "ready",
        "year",
      ],
      ready: true,
      formCount: 2,
      // PAY-208 N1 ((j)(6)): Oct 15, 2027 is a Friday; no corrected posting.
      accessThrough: "2027-10-15",
    });
  });

  it("NC ID removed (NC tax > 0 -> missing_state_id): ready false, formCount null (no count leaks from a held W-2)", async () => {
    await env.t.db.delete(companyStateIds).where(eq(companyStateIds.stateCode, "NC"));
    const row = await my2026();
    expect({
      keys: Object.keys(row).sort(),
      ready: row.ready,
      formCount: row.formCount,
      accessThrough: row.accessThrough,
    }).toEqual({
      keys: [
        "accessThrough",
        "availableOn",
        "corrected",
        "downloadable",
        "formCount",
        "ready",
        "year",
      ],
      ready: false,
      formCount: null,
      // PAY-208 N1: the window is a date, not a figure; shown for a held W-2 too.
      accessThrough: "2027-10-15",
    });
  });
});

// ---------------------------------------------------------------------------
// C-f1 / C-f2 — state IDs after W-2s were given out (carry-over f, D-PL2).
// ---------------------------------------------------------------------------

const STATE_IDS = "/api/admin/company/state-ids";

async function putId(env: Env, stateCode: string, stateId: string, fromTaxYear = 2026) {
  return env.t.app.inject({
    method: "PUT",
    url: `${STATE_IDS}/${stateCode}`,
    headers: env.admin,
    payload: { stateId, fromTaxYear },
  });
}

async function storedCa(env: Env) {
  const res = await env.t.pglite.query<{ state_id: string; updated_at: unknown }>(
    "SELECT state_id, updated_at FROM company_state_ids WHERE state_code = 'CA' AND from_tax_year = 2026",
  );
  const row = res.rows[0];
  return { stateId: row?.state_id ?? null, updatedAt: String(row?.updated_at ?? "") };
}

async function auditCount(env: Env): Promise<number> {
  const [row] = await env.t.db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditEvents)
    .where(eq(auditEvents.action, "company.state_id.set"));
  return row?.n ?? 0;
}

async function correctedRows(env: Env): Promise<{ employeeId: number; method: string }[]> {
  return env.t.db
    .select({ employeeId: w2Furnishings.employeeId, method: w2Furnishings.method })
    .from(w2Furnishings)
    .where(and(eq(w2Furnishings.taxYear, 2026), eq(w2Furnishings.corrected, true)))
    .orderBy(w2Furnishings.employeeId);
}

describe("C-f1 furnished counts: two consented CA employees furnished (portal_notice), one not", () => {
  let env: Env;
  beforeAll(async () => {
    env = await bootEnv({ now: AFTER_YEAR_END });
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "CA", "00000001");
    for (const name of ["Ana One Synthetic", "Ana Two Synthetic"]) {
      const e = await consentedEmployee(env, name);
      await insertRuns(env, e.employeeId, ana());
    }
    const paper = await createEmployee(env, "Ana Paper Synthetic");
    await insertRuns(env, paper, ana());
    const sent = await sendW2AvailableNotices(deps(env), { today: TODAY_2027 });
    if (sent.sent !== 2) throw new Error(`fixture: expected 2 notices, got ${sent.sent}`);
  }, 240_000);
  afterAll(async () => env.close());

  it("GET state-ids furnished = [{CA, 2026, employees 2}] (counts only, no names or ids)", async () => {
    const res = await get(env, STATE_IDS);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { furnished?: unknown };
    expect(body.furnished).toEqual([{ stateCode: "CA", taxYear: 2026, employees: 2 }]);
    expect(res.body).not.toContain("Ana One");
    expect(res.body).not.toContain("Ana Two");
  });

  it("after the 2026 w2_w3 filing is marked filed: furnished = []", async () => {
    const existing = await env.t.db
      .select({ id: taxFilings.id })
      .from(taxFilings)
      .where(and(eq(taxFilings.formType, "w2_w3"), eq(taxFilings.year, 2026)));
    if (existing.length > 0) {
      await env.t.db
        .update(taxFilings)
        .set({ status: "filed", filedOn: "2027-01-28", filingMethod: "synthetic" })
        .where(and(eq(taxFilings.formType, "w2_w3"), eq(taxFilings.year, 2026)));
    } else {
      await env.t.db.insert(taxFilings).values({
        formType: "w2_w3",
        year: 2026,
        quarter: 0,
        dueDate: "2027-02-01",
        status: "filed",
        worksheet: { synthetic: true },
        worksheetHash: "synthetic",
        filedOn: "2027-01-28",
        filingMethod: "synthetic",
        createdBy: "pay-116-pr4-test",
      });
    }
    const res = await get(env, STATE_IDS);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { furnished?: unknown }).furnished).toEqual([]);
  });
});

describe("C-f2 re-saving a state ID: identical value writes nothing; a new value writes and corrects", () => {
  let env: Env;
  const ids: number[] = [];
  beforeAll(async () => {
    env = await bootEnv({ now: AFTER_YEAR_END });
    await setEin(env, SYNTHETIC_EIN);
    for (const name of ["Ana Resave One Synthetic", "Ana Resave Two Synthetic"]) {
      const e = await consentedEmployee(env, name);
      ids.push(e.employeeId);
      await insertRuns(env, e.employeeId, ana());
    }
    const first = await putId(env, "CA", "00000001");
    if (first.statusCode !== 200) throw new Error(`fixture PUT -> ${first.statusCode}`);
    const sent = await sendW2AvailableNotices(deps(env), { today: TODAY_2027 });
    if (sent.sent !== 2) throw new Error(`fixture: expected 2 notices, got ${sent.sent}`);
  }, 240_000);
  afterAll(async () => env.close());

  it("identical value: 200 unchanged true; column byte-identical; updated_at unchanged; no audit row; reconcile adds no CORRECTED row", async () => {
    const before = { stored: await storedCa(env), audits: await auditCount(env) };
    const res = await putId(env, "CA", "00000001");
    const after = { stored: await storedCa(env), audits: await auditCount(env) };
    const rec = await reconcileW2Furnishings(deps(env), { today: TODAY_2027 });
    expect({
      status: res.statusCode,
      unchanged: (res.json() as { unchanged?: unknown }).unchanged,
      sameCiphertext: after.stored.stateId === before.stored.stateId,
      sameUpdatedAt: after.stored.updatedAt === before.stored.updatedAt,
      newAudits: after.audits - before.audits,
      followUps: rec.followUps,
      corrected: await correctedRows(env),
    }).toEqual({
      status: 200,
      unchanged: true,
      sameCiphertext: true,
      sameUpdatedAt: true,
      newAudits: 0,
      followUps: 0,
      corrected: [],
    });
    expect(res.body).not.toContain("00000001");
  });

  it("different value: 200 unchanged false; new ciphertext; one audit row; next reconcile furnishes CORRECTED (portal_notice) for both employees", async () => {
    const before = { stored: await storedCa(env), audits: await auditCount(env) };
    const res = await putId(env, "CA", "00000002");
    const after = { stored: await storedCa(env), audits: await auditCount(env) };
    await reconcileW2Furnishings(deps(env), { today: TODAY_2027 });
    expect({
      status: res.statusCode,
      unchanged: (res.json() as { unchanged?: unknown }).unchanged,
      newCiphertext: after.stored.stateId !== before.stored.stateId,
      newAudits: after.audits - before.audits,
      corrected: await correctedRows(env),
    }).toEqual({
      status: 200,
      unchanged: false,
      newCiphertext: true,
      newAudits: 1,
      corrected: [...ids]
        .sort((a, b) => a - b)
        .map((employeeId) => ({
          employeeId,
          method: "portal_notice",
        })),
    });
  });

  it("stored value fails GCM: the PUT is a normal write (200, unchanged false), never a 500", async () => {
    const { stateId } = await storedCa(env);
    const value = stateId ?? "";
    const i = "enc:v1:".length + 10;
    const flipped = value.slice(0, i) + (value[i] === "A" ? "B" : "A") + value.slice(i + 1);
    await env.t.pglite.query(
      "UPDATE company_state_ids SET state_id = $1 WHERE state_code = 'CA' AND from_tax_year = 2026",
      [flipped],
    );
    const res = await putId(env, "CA", "00000003");
    const after = await storedCa(env);
    expect({
      status: res.statusCode,
      unchanged: (res.json() as { unchanged?: unknown }).unchanged,
      rewritten: after.stateId !== flipped,
    }).toEqual({ status: 200, unchanged: false, rewritten: true });
  });

  it("guard: app_settings and furnishing rows exist as the fixture expects (2 portal_notice originals)", async () => {
    const originals = await env.t.db
      .select({ id: w2Furnishings.id })
      .from(w2Furnishings)
      .where(and(eq(w2Furnishings.taxYear, 2026), eq(w2Furnishings.corrected, false)));
    const notified = await env.t.db.select().from(appSettings);
    expect(originals.length).toBe(2);
    expect(notified.length).toBeGreaterThan(0);
  });
});

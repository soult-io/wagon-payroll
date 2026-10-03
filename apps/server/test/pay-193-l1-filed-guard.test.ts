/**
 * PAY-193 L1 — filed-return guard (spec D9.4, D9.5; tests G-1…G-8 of D9.11).
 * Written fail-first by the payroll-calc-auditor; the coder may not edit it.
 *
 * Product decisions encoded here:
 * - Issue (only issue) of a run whose pay date is before the company-local
 *   today (APP_TZ Europe/Madrid, injected clock) is refused with 409
 *   `pay_period_filed` when any of its federal closing filings
 *   (941 of the pay date's quarter, 940 and w2_w3 of its year) is `filed`.
 *   A missing tax_filings row counts as not filed. Body keys exactly
 *   `error, message, payDate, forms`; forms like "941:2026-Q1", "940:2026",
 *   "w2_w3:2026", in closingFilings order. The check runs before
 *   `past_pay_date_other_year`.
 * - markFiled takes FILING_CLOSE_LOCK (hashtext('w2_w3_filing_state_ids'))
 *   for every form type, re-reads the row under it (already filed ->
 *   409 invalid_transition), and accepts an optional body field
 *   `expectedWorksheetHash`: a mismatch with the worksheet as it stands
 *   under the lock -> 409 `worksheet_changed`.
 * - Lock order: payroll_run_employee:{id} -> FILING_CLOSE_LOCK -> SYNC_LOCK.
 *
 * PGlite is one connection, so lock tests assert order and outcome, not
 * timing: a recorder wraps PGlite's query/transaction and captures every
 * statement with its transaction id. All data is synthetic; no amount is
 * asserted (L1 changes no figure).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditEvents, payrollRuns, seedDatabase, taxFilings, type SeedDb } from "@payroll/db";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";
import { createEmployee, gen, monthPeriod, runRow } from "./pay-date-helpers.js";

// ---------------------------------------------------------------- harness

let t: TestContext;
let ADMIN: Record<string, string>;
/** The app's wall clock; every test sets it before acting. */
let now = new Date("2026-05-02T10:00:00Z");

interface Stmt {
  tx: number | null;
  text: string;
  params: unknown[];
}
type RawClient = { query: (text: string, params?: unknown[], opts?: unknown) => Promise<unknown> };

let recording: Stmt[] | null = null;
/** One-shot hook run inside the transaction BEFORE a matching statement executes. */
let hook: { match: (s: Stmt) => boolean; run: (client: RawClient) => Promise<void> } | null = null;
let hookFired = false;
let txSeq = 0;

function note(tx: number | null, text: string, params: unknown[] | undefined): Stmt {
  const s: Stmt = { tx, text, params: params ?? [] };
  if (recording) recording.push(s);
  return s;
}

function installRecorder(): void {
  const pg = t.pglite as unknown as {
    query: (text: string, params?: unknown[], opts?: unknown) => Promise<unknown>;
    transaction: (fn: (client: RawClient) => Promise<unknown>) => Promise<unknown>;
  };
  const origQuery = pg.query.bind(pg);
  const origTx = pg.transaction.bind(pg);
  pg.query = async (text, params, opts) => {
    note(null, text, params);
    return origQuery(text, params, opts);
  };
  pg.transaction = async (fn) =>
    origTx(async (client) => {
      txSeq += 1;
      const id = txSeq;
      const wrapped = new Proxy(client as object, {
        get(target, prop) {
          if (prop === "query") {
            return async (text: string, params?: unknown[], opts?: unknown) => {
              const s = note(id, text, params);
              if (hook?.match(s)) {
                const h = hook;
                hook = null;
                hookFired = true;
                await h.run(target as RawClient);
              }
              return (target as RawClient).query(text, params, opts);
            };
          }
          const v = Reflect.get(target, prop) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      return fn(wrapped as RawClient);
    });
}

type Label =
  | "employee_lock"
  | "filing_close_lock"
  | "sync_lock"
  | "tax_filings_read"
  | "tax_filings_update";

function labelOf(s: Stmt): Label | null {
  const blob = `${s.text} ${JSON.stringify(s.params)}`;
  if (/pg_advisory_xact_lock/i.test(s.text)) {
    if (blob.includes("payroll_run_employee:")) return "employee_lock";
    if (blob.includes("w2_w3_filing_state_ids")) return "filing_close_lock";
    if (blob.includes("tax_deposits_state_sync")) return "sync_lock";
    return null;
  }
  if (/^\s*select\b/i.test(s.text) && /\bfrom\s+"?tax_filings"?/i.test(s.text)) {
    return "tax_filings_read";
  }
  if (/^\s*update\s+"?tax_filings"?/i.test(s.text)) return "tax_filings_update";
  return null;
}

async function record<T>(fn: () => Promise<T>): Promise<{ value: T; stmts: Stmt[] }> {
  recording = [];
  try {
    const value = await fn();
    return { value, stmts: recording };
  } finally {
    recording = null;
  }
}

/** Labels of the statements of transaction `tx`, in execution order. */
function labelsIn(stmts: Stmt[], tx: number): Label[] {
  return stmts
    .filter((s) => s.tx === tx)
    .map(labelOf)
    .filter((l): l is Label => l !== null);
}

/** Every label seen anywhere in the recording (any transaction or none). */
function allLabels(stmts: Stmt[]): Set<Label> {
  return new Set(stmts.map(labelOf).filter((l): l is Label => l !== null));
}

beforeAll(async () => {
  t = await createTestApp({ appTz: "Europe/Madrid" }, { clock: () => now });
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "pay-193-l1-admin@test.dev", role: "admin" });
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);
  installRecorder();
}, 120_000);

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  recording = null;
  hook = null;
  hookFired = false;
});

// ---------------------------------------------------------------- fixtures

/** tax_filings is global (unique per form/year/quarter): each test sets its own. */
async function resetFilings(): Promise<void> {
  await t.pglite.query("DELETE FROM tax_filings");
}

type Form = "941" | "940" | "w2_w3";
async function putFiling(
  formType: Form,
  year: number,
  quarter: number,
  status: "ready" | "filed",
  worksheet: unknown = null,
): Promise<number> {
  const rows = await t.db
    .insert(taxFilings)
    .values({
      formType,
      year,
      quarter,
      dueDate: `${year + 1}-01-31`,
      status,
      worksheet,
      worksheetHash: worksheet === null ? null : "synthetic",
      createdBy: "pay-193-l1-test",
      ...(status === "filed"
        ? { filedOn: `${year}-12-31`, filingMethod: "synthetic", filingReference: null }
        : {}),
    })
    .returning({ id: taxFilings.id });
  return rows[0]!.id;
}

/** A fresh employee with an approved-able draft for `ym` paid `payDate`. */
async function draft(ym: string, payDate: string, gross = 400_000): Promise<string> {
  const emp = await createEmployee(t, gross, "Filed Guard");
  const { run } = await gen(t, emp, monthPeriod(ym, payDate));
  return run.publicId;
}

function act(publicId: string, action: "approve" | "issue") {
  return t.app.inject({
    method: "POST",
    url: `/api/admin/payroll-runs/${publicId}/${action}`,
    headers: ADMIN,
    payload: {},
  });
}

async function approve(publicId: string): Promise<void> {
  const res = await act(publicId, "approve");
  expect(res.statusCode, res.body).toBe(200);
}

function markFiledReq(filingId: number, extra: Record<string, unknown> = {}) {
  return t.app.inject({
    method: "POST",
    url: `/api/admin/tax-filings/${filingId}/file`,
    headers: ADMIN,
    payload: { filedOn: "2026-05-02", filingMethod: "paper", ...extra },
  });
}

async function filingRow(id: number) {
  return (await t.db.select().from(taxFilings).where(eq(taxFilings.id, id)).limit(1))[0]!;
}

async function auditCount(action: string, entityId: string): Promise<number> {
  return (
    await t.db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(and(eq(auditEvents.action, action), eq(auditEvents.entityId, entityId)))
  ).length;
}

async function runState(publicId: string) {
  const r = (
    await t.db.select().from(payrollRuns).where(eq(payrollRuns.publicId, publicId)).limit(1)
  )[0]!;
  const full = await runRow(t, r.id);
  return {
    status: full.status,
    issuedAt: full.issuedAt,
    issueAudits: await auditCount("run.issue", publicId),
  };
}

const MONEY_SHAPED = /\d+\.\d{2}/;

/** The pay_period_filed body contract (D9.3, D9.4). */
function filedRefusal(res: { statusCode: number; json: () => unknown }, payDate: string) {
  const body = res.json() as Record<string, unknown>;
  const message = typeof body.message === "string" ? body.message : "";
  return {
    status: res.statusCode,
    error: body.error,
    keys: Object.keys(body).sort(),
    payDate: body.payDate,
    forms: body.forms,
    messageNamesPayDate: message.includes(payDate),
    messageSaysNothingIssued: message.includes("Nothing was issued"),
    messageHasNoAmount: !message.includes("$") && !MONEY_SHAPED.test(message),
  };
}

function expectedRefusal(payDate: string, forms: string[]) {
  return {
    status: 409,
    error: "pay_period_filed",
    keys: ["error", "forms", "message", "payDate"],
    payDate,
    forms,
    messageNamesPayDate: true,
    messageSaysNothingIssued: true,
    messageHasNoAmount: true,
  };
}

const MAY_2 = "2026-05-02T10:00:00Z";
const JAN_10_2027 = "2027-01-10T10:00:00Z";

// ---------------------------------------------------------------- closingFilings (pure)

describe("closingFilings(payDate) — D9.4 pure set", () => {
  async function load() {
    return import("../src/filings/closing-filings.js");
  }
  const cases: [string, number, number][] = [
    ["2026-03-20", 2026, 1],
    ["2026-01-01", 2026, 1],
    ["2026-03-31", 2026, 1],
    ["2026-04-01", 2026, 2],
    ["2026-06-30", 2026, 2],
    ["2026-07-01", 2026, 3],
    ["2026-09-30", 2026, 3],
    ["2026-10-01", 2026, 4],
    ["2026-12-31", 2026, 4],
    ["2027-01-01", 2027, 1],
  ];
  for (const [payDate, year, quarter] of cases) {
    it(`${payDate} -> 941 ${year} Q${quarter}, 940 ${year}, w2_w3 ${year} (in that order)`, async () => {
      const { closingFilings } = await load();
      expect(closingFilings(payDate)).toEqual([
        { formType: "941", year, quarter },
        { formType: "940", year, quarter: 0 },
        { formType: "w2_w3", year, quarter: 0 },
      ]);
    });
  }

  it("filedClosingFilings returns only the filed members, in closingFilings order; missing row = not filed", async () => {
    const { filedClosingFilings } = await load();
    await resetFilings();
    await putFiling("w2_w3", 2026, 0, "filed");
    await putFiling("941", 2026, 4, "filed");
    await putFiling("941", 2026, 3, "filed"); // other quarter: not a member
    await putFiling("940", 2026, 0, "ready");
    const got = await t.db.transaction((tx) => filedClosingFilings(tx, "2026-12-31"));
    expect(got).toEqual([
      { formType: "941", year: 2026, quarter: 4 },
      { formType: "w2_w3", year: 2026, quarter: 0 },
    ]);
  });
});

// ---------------------------------------------------------------- G-1 … G-4

describe("G-1 past pay date, 941 of its quarter filed", () => {
  it("issue -> 409 pay_period_filed {error,message,payDate,forms:[941:2026-Q1]}; approve allowed; run unchanged", async () => {
    await resetFilings();
    now = new Date(MAY_2);
    const id = await draft("2026-03", "2026-03-20");
    await putFiling("941", 2026, 1, "filed");
    await approve(id); // the guard runs on issue only
    const res = await act(id, "issue");
    expect(filedRefusal(res, "2026-03-20")).toEqual(expectedRefusal("2026-03-20", ["941:2026-Q1"]));
    expect(await runState(id)).toEqual({ status: "approved", issuedAt: null, issueAudits: 0 });
  });

  it("company-local today (Europe/Madrid): 2026-03-20T23:30Z is 03-21 locally -> refused", async () => {
    await resetFilings();
    now = new Date("2026-03-20T23:30:00Z");
    const id = await draft("2026-03", "2026-03-20");
    await putFiling("941", 2026, 1, "filed");
    await approve(id);
    const res = await act(id, "issue");
    expect(filedRefusal(res, "2026-03-20")).toEqual(expectedRefusal("2026-03-20", ["941:2026-Q1"]));
  });

  it("company-local today: 2026-03-20T22:30Z is still 03-20 locally (pay date = today) -> no guard, issued", async () => {
    await resetFilings();
    now = new Date("2026-03-20T22:30:00Z");
    const id = await draft("2026-03", "2026-03-20");
    await putFiling("941", 2026, 1, "filed");
    await approve(id);
    const res = await act(id, "issue");
    expect(res.statusCode, res.body).toBe(200);
    expect((await runState(id)).status).toBe("issued");
  });
});

describe("G-2 past pay date, closing filings not filed", () => {
  it("941 2026-Q1 'ready' -> issued", async () => {
    await resetFilings();
    now = new Date(MAY_2);
    const id = await draft("2026-03", "2026-03-20");
    await putFiling("941", 2026, 1, "ready");
    await approve(id);
    const res = await act(id, "issue");
    expect(res.statusCode, res.body).toBe(200);
    expect((await runState(id)).status).toBe("issued");
  });

  it("no tax_filings row at all -> issued (missing row = not filed)", async () => {
    await resetFilings();
    now = new Date(MAY_2);
    const id = await draft("2026-03", "2026-03-20");
    await approve(id);
    const res = await act(id, "issue");
    expect(res.statusCode, res.body).toBe(200);
    expect((await runState(id)).status).toBe("issued");
  });

  it("a filed 941 of ANOTHER quarter (2026-Q2) does not close a Q1 pay date -> issued", async () => {
    await resetFilings();
    now = new Date("2026-08-02T10:00:00Z");
    const id = await draft("2026-03", "2026-03-31");
    await putFiling("941", 2026, 2, "filed");
    await approve(id);
    const res = await act(id, "issue");
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe("G-3 pay_period_filed comes before past_pay_date_other_year", () => {
  it("paid 2026-12-31, today 2027-01-10, 940 2026 filed -> 409 pay_period_filed [940:2026]", async () => {
    await resetFilings();
    now = new Date(JAN_10_2027);
    const id = await draft("2026-12", "2026-12-31");
    await putFiling("940", 2026, 0, "filed");
    await approve(id);
    const res = await act(id, "issue");
    expect(filedRefusal(res, "2026-12-31")).toEqual(expectedRefusal("2026-12-31", ["940:2026"]));
    expect((await runState(id)).status).toBe("approved");
  });

  it("paid 2026-12-31, today 2027-01-10, w2_w3 2026 filed -> 409 pay_period_filed [w2_w3:2026]", async () => {
    await resetFilings();
    now = new Date(JAN_10_2027);
    const id = await draft("2026-12", "2026-12-31");
    await putFiling("w2_w3", 2026, 0, "filed");
    await approve(id);
    const res = await act(id, "issue");
    expect(filedRefusal(res, "2026-12-31")).toEqual(expectedRefusal("2026-12-31", ["w2_w3:2026"]));
    expect((await runState(id)).status).toBe("approved");
  });

  it("all three filed -> forms in closingFilings order [941:2026-Q4, 940:2026, w2_w3:2026]", async () => {
    await resetFilings();
    now = new Date(JAN_10_2027);
    const id = await draft("2026-12", "2026-12-31");
    await putFiling("w2_w3", 2026, 0, "filed");
    await putFiling("940", 2026, 0, "filed");
    await putFiling("941", 2026, 4, "filed");
    await approve(id);
    const res = await act(id, "issue");
    expect(filedRefusal(res, "2026-12-31")).toEqual(
      expectedRefusal("2026-12-31", ["941:2026-Q4", "940:2026", "w2_w3:2026"]),
    );
  });
});

describe("G-4 future pay date", () => {
  it("every 2026 form filed, pay date after today -> issued (no guard)", async () => {
    await resetFilings();
    now = new Date(MAY_2);
    const id = await draft("2026-06", "2026-06-15");
    for (const q of [1, 2, 3, 4]) await putFiling("941", 2026, q, "filed");
    await putFiling("940", 2026, 0, "filed");
    await putFiling("w2_w3", 2026, 0, "filed");
    await approve(id);
    const res = await act(id, "issue");
    expect(res.statusCode, res.body).toBe(200);
    expect((await runState(id)).status).toBe("issued");
  });
});

// ---------------------------------------------------------------- G-5 lock order

describe("G-5 lock order (recording spy)", () => {
  it("issue, past pay date: employee lock -> FILING_CLOSE_LOCK -> tax_filings read, one transaction", async () => {
    await resetFilings();
    now = new Date(MAY_2);
    const id = await draft("2026-03", "2026-03-20");
    await approve(id);
    const { value: res, stmts } = await record(() => act(id, "issue"));
    expect(res.statusCode, res.body).toBe(200);
    const issueTx = stmts.find((s) => s.tx !== null && labelOf(s) === "employee_lock")?.tx;
    expect(issueTx, "issue took no employee lock").toBeDefined();
    const labels = labelsIn(stmts, issueTx!);
    const firstOf = (l: Label) => labels.indexOf(l);
    expect({
      employeeLock: firstOf("employee_lock") >= 0,
      filingLockAfterEmployee: firstOf("filing_close_lock") > firstOf("employee_lock"),
      readAfterFilingLock:
        firstOf("filing_close_lock") >= 0 &&
        firstOf("tax_filings_read") > firstOf("filing_close_lock"),
      syncNotBeforeFilingLock:
        firstOf("sync_lock") === -1 || firstOf("sync_lock") > firstOf("filing_close_lock"),
    }).toEqual({
      employeeLock: true,
      filingLockAfterEmployee: true,
      readAfterFilingLock: true,
      syncNotBeforeFilingLock: true,
    });
  });

  it("issue, pay date today or later: takes neither FILING_CLOSE_LOCK nor SYNC_LOCK", async () => {
    await resetFilings();
    now = new Date(MAY_2);
    const id = await draft("2026-05", "2026-05-02"); // pay date = company-local today
    await approve(id);
    const { value: res, stmts } = await record(() => act(id, "issue"));
    expect(res.statusCode, res.body).toBe(200);
    const seen = allLabels(stmts);
    expect({
      employee: seen.has("employee_lock"),
      filing: seen.has("filing_close_lock"),
      sync: seen.has("sync_lock"),
    }).toEqual({ employee: true, filing: false, sync: false });
  });

  for (const [form, quarter] of [
    ["941", 2],
    ["940", 0],
    ["w2_w3", 0],
  ] as const) {
    it(`markFiled ${form}: FILING_CLOSE_LOCK before the update, in its transaction; no employee lock, no SYNC_LOCK`, async () => {
      await resetFilings();
      // 2025: no run of this file falls in it, so the W-2 year is clean.
      const fid = await putFiling(form, 2025, quarter, "ready", { synthetic: true });
      const { value: res, stmts } = await record(() => markFiledReq(fid));
      expect(res.statusCode, res.body).toBe(200);
      const updTx = stmts.find((s) => s.tx !== null && labelOf(s) === "tax_filings_update")?.tx;
      expect(updTx, "markFiled wrote no tax_filings update in a transaction").toBeDefined();
      const labels = labelsIn(stmts, updTx!);
      const seen = allLabels(stmts);
      expect({
        filingLockBeforeUpdate:
          labels.includes("filing_close_lock") &&
          labels.indexOf("filing_close_lock") < labels.indexOf("tax_filings_update"),
        employee: seen.has("employee_lock"),
        sync: seen.has("sync_lock"),
      }).toEqual({ filingLockBeforeUpdate: true, employee: false, sync: false });
    });
  }

  it("state-ids write: FILING_CLOSE_LOCK only (no employee lock, no SYNC_LOCK)", async () => {
    await resetFilings();
    const { value: res, stmts } = await record(() =>
      t.app.inject({
        method: "PUT",
        url: "/api/admin/company/state-ids/CA",
        headers: ADMIN,
        payload: { stateId: "11111111" },
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const seen = allLabels(stmts);
    expect({
      filing: seen.has("filing_close_lock"),
      employee: seen.has("employee_lock"),
      sync: seen.has("sync_lock"),
    }).toEqual({ filing: true, employee: false, sync: false });
  });
});

// ---------------------------------------------------------------- G-6 … G-8 races

describe("G-6 order A: the issue commits, then markFiled with the old hash", () => {
  it("markFiled(expectedWorksheetHash = displayed hash) -> 409 worksheet_changed; with the new hash it files", async () => {
    await resetFilings();
    now = new Date(MAY_2);
    const fid = await putFiling("941", 2026, 1, "ready");
    // The admin opens the filing: the detail read computes and shows the hash.
    const opened = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-filings/${fid}`,
      headers: ADMIN,
    });
    expect(opened.statusCode, opened.body).toBe(200);
    const oldHash = (opened.json() as { filing: { worksheetHash: string } }).filing.worksheetHash;
    expect(oldHash).toMatch(/^[0-9a-f]{64}$/);

    // A March run is issued meanwhile (Q1 not yet filed -> allowed).
    const id = await draft("2026-03", "2026-03-20");
    await approve(id);
    const issued = await act(id, "issue");
    expect(issued.statusCode, issued.body).toBe(200);

    // markFiled with the hash the admin saw: no detail read in between, so
    // the check must use the worksheet as it stands under the lock.
    const stale = await markFiledReq(fid, { expectedWorksheetHash: oldHash });
    const staleBody = stale.json() as Record<string, unknown>;
    expect({
      status: stale.statusCode,
      error: staleBody.error,
      noAmount:
        !String(staleBody.message ?? "").includes("$") &&
        !MONEY_SHAPED.test(String(staleBody.message ?? "")),
      rowStatus: (await filingRow(fid)).status,
      fileAudits: await auditCount("tax_filing.file", String(fid)),
    }).toEqual({
      status: 409,
      error: "worksheet_changed",
      noAmount: true,
      rowStatus: "ready",
      fileAudits: 0,
    });

    // Re-open: the new hash differs, and filing with it succeeds.
    const reopened = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-filings/${fid}`,
      headers: ADMIN,
    });
    const newHash = (reopened.json() as { filing: { worksheetHash: string } }).filing.worksheetHash;
    expect(newHash).not.toBe(oldHash);
    const ok = await markFiledReq(fid, { expectedWorksheetHash: newHash });
    expect(ok.statusCode, ok.body).toBe(200);
    const row = await filingRow(fid);
    expect({ status: row.status, worksheetHash: row.worksheetHash }).toEqual({
      status: "filed",
      worksheetHash: newHash,
    });
  });

  it("markFiled without expectedWorksheetHash keeps today's behaviour (files)", async () => {
    await resetFilings();
    const fid = await putFiling("940", 2025, 0, "ready", { synthetic: true });
    const res = await markFiledReq(fid);
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe("G-7 order B: markFiled commits, then the issue", () => {
  it("issue -> 409 pay_period_filed [941:2026-Q1]", async () => {
    await resetFilings();
    now = new Date(MAY_2);
    const id = await draft("2026-03", "2026-03-20");
    await approve(id);
    const fid = await putFiling("941", 2026, 1, "ready");
    const filed = await markFiledReq(fid);
    expect(filed.statusCode, filed.body).toBe(200);
    const res = await act(id, "issue");
    expect(filedRefusal(res, "2026-03-20")).toEqual(expectedRefusal("2026-03-20", ["941:2026-Q1"]));
    expect((await runState(id)).status).toBe("approved");
  });
});

describe("G-8 the row is filed between markFiled's first read and its lock", () => {
  it("941: markFiled -> 409 invalid_transition; exactly one tax_filing.file audit row (the winner's)", async () => {
    await resetFilings();
    const fid = await putFiling("941", 2026, 1, "ready");
    // Stand-in for a concurrent markFiled that commits first: right before
    // FILING_CLOSE_LOCK executes, file the row and write its audit row.
    hook = {
      match: (s) => labelOf(s) === "filing_close_lock",
      run: async (client) => {
        await client.query(
          "UPDATE tax_filings SET status = 'filed', filed_on = '2026-05-01', filing_method = 'concurrent' WHERE id = $1",
          [fid],
        );
        await client.query(
          "INSERT INTO audit_events (actor_id, action, entity, entity_id, before, after) VALUES ('concurrent-admin', 'tax_filing.file', 'tax_filing', $1, NULL, '{\"status\":\"filed\"}'::jsonb)",
          [String(fid)],
        );
        // The winner commits: up to here this transaction has only read, so
        // COMMIT + BEGIN publishes the winner's writes and the refused
        // markFiled rolls back only its own work.
        await client.query("COMMIT");
        await client.query("BEGIN");
      },
    };
    const res = await markFiledReq(fid);
    const body = res.json() as Record<string, unknown>;
    const row = await filingRow(fid);
    expect({
      hookFired,
      status: res.statusCode,
      error: body.error,
      filingMethod: row.filingMethod,
      fileAudits: await auditCount("tax_filing.file", String(fid)),
    }).toEqual({
      hookFired: true,
      status: 409,
      error: "invalid_transition",
      filingMethod: "concurrent",
      fileAudits: 1,
    });
  });
});

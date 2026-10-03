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
 *   "w2_w3:2026", in closingFilings order. The check runs first: before
 *   D6/D4 and before the PAY-193 L4 attestation
 *   (`late_payment_confirmation_required`).
 * - PAY-193 L4: a run whose pay-date quarter has ended is LATE and needs a
 *   `latePayment` body. Fixtures that only need "a past pay date" use a Q2
 *   pay date seen in Q2 (paid 2026-04-20, today 2026-05-02, no work state),
 *   which is not late; G-2b covers a late one.
 * - markFiled takes FILING_CLOSE_LOCK (hashtext('w2_w3_filing_state_ids'))
 *   for every form type, re-reads the row under it (already filed ->
 *   409 invalid_transition), and accepts an optional body field
 *   `expectedWorksheetHash`: a mismatch with the worksheet as it stands
 *   under the lock -> 409 `worksheet_changed`.
 * - Lock order: payroll_run_employee:{id} -> FILING_CLOSE_LOCK -> SYNC_LOCK.
 *
 * Review-round decisions (Product Lead, 2026-10-03; G-9 … G-12):
 * - G-9: markFiled WITHOUT expectedWorksheetHash behaves as if the client
 *   sent the stored hash: refresh under the lock; a changed hash -> 409
 *   worksheet_changed with the refreshed worksheet committed; unchanged ->
 *   files. A row is therefore filed only after its worksheet was read
 *   (fixtures below open the filing first).
 * - G-10: an unlocked refresh never rewrites a row that is filed by the time
 *   it writes (refresh decided on a stale unfiled object).
 * - G-11: the pay_period_filed message names only the corrections for the
 *   blocking forms ("Form 941-X", "an amended Form 940", "Forms W-2c and
 *   W-3c"), says "Nothing was issued" and "Don't move it", and drops "A return
 *   covering".
 * - worksheet_changed message: WORKSHEET_CHANGED_MESSAGE, exactly.
 * - G-12: the tax_filing.file audit row's before.status is the status read
 *   under the lock.
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
import { oracleRun2026 } from "./pay-193-oracle.js";

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
  status: "not_started" | "ready" | "filed",
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

/** The admin opens the filing: the detail read refreshes an unfiled worksheet. Returns its hash. */
async function openFiling(filingId: number): Promise<string> {
  const res = await t.app.inject({
    method: "GET",
    url: `/api/admin/tax-filings/${filingId}`,
    headers: ADMIN,
  });
  expect(res.statusCode, res.body).toBe(200);
  const hash = (res.json() as { filing: { worksheetHash: string } }).filing.worksheetHash;
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  return hash;
}

const WORKSHEET_CHANGED_MESSAGE =
  "Not recorded yet. The figures on this page changed since you opened it, usually because a payroll was issued or changed. Check the updated figures. If they match what you filed, mark it as filed again. If you already filed different figures, the filed return may need a correction.";

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
  it("941 2026-Q2 'ready' -> issued (paid 2026-04-20, today 2026-05-02: not late)", async () => {
    await resetFilings();
    now = new Date(MAY_2);
    const id = await draft("2026-04", "2026-04-20");
    await putFiling("941", 2026, 2, "ready");
    await approve(id);
    const res = await act(id, "issue");
    expect(res.statusCode, res.body).toBe(200);
    expect((await runState(id)).status).toBe("issued");
  });

  it("no tax_filings row at all -> issued (missing row = not filed)", async () => {
    await resetFilings();
    now = new Date(MAY_2);
    const id = await draft("2026-04", "2026-04-20");
    await approve(id);
    const res = await act(id, "issue");
    expect(res.statusCode, res.body).toBe(200);
    expect((await runState(id)).status).toBe("issued");
  });

  it("a filed 941 of ANOTHER quarter (2026-Q1) does not close a Q2 pay date -> issued", async () => {
    await resetFilings();
    now = new Date(MAY_2);
    const id = await draft("2026-04", "2026-04-20");
    await putFiling("941", 2026, 1, "filed");
    await approve(id);
    const res = await act(id, "issue");
    expect(res.statusCode, res.body).toBe(200);
  });

  it("G-2b (L4): late run (paid 2026-03-20, today 2026-05-02), 941 2026-Q1 'ready' -> issued with a complete latePayment", async () => {
    await resetFilings();
    now = new Date(MAY_2);
    const id = await draft("2026-03", "2026-03-20");
    await putFiling("941", 2026, 1, "ready");
    await approve(id);
    // No work state: no state step. Net pay from the auditor oracle (Pub 15-T
    // 2026 Worksheet 1A, Pub 15 2026): 4,000.00 - 298.33 - 248.00 - 58.00.
    const res = await t.app.inject({
      method: "POST",
      url: `/api/admin/payroll-runs/${id}/issue`,
      headers: ADMIN,
      payload: {
        latePayment: {
          attestationVersion: 1,
          netPayCents: oracleRun2026(400_000, 0, "none").netCents,
          stateReturns: [],
        },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await runState(id)).status).toBe("issued");
  });
});

describe("G-3 pay_period_filed comes before the attestation (late_payment_confirmation_required)", () => {
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
    const id = await draft("2026-04", "2026-04-20");
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
      await openFiling(fid); // G-9: a row is filed only after its worksheet was read
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
    const fid = await putFiling("941", 2026, 2, "ready");
    // The admin opens the filing: the detail read computes and shows the hash.
    const opened = await t.app.inject({
      method: "GET",
      url: `/api/admin/tax-filings/${fid}`,
      headers: ADMIN,
    });
    expect(opened.statusCode, opened.body).toBe(200);
    const oldHash = (opened.json() as { filing: { worksheetHash: string } }).filing.worksheetHash;
    expect(oldHash).toMatch(/^[0-9a-f]{64}$/);

    // An April run is issued meanwhile (Q2 not filed -> allowed; not late,
    // so the issue itself does not refresh the worksheet).
    const id = await draft("2026-04", "2026-04-20");
    await approve(id);
    const issued = await act(id, "issue");
    expect(issued.statusCode, issued.body).toBe(200);

    // markFiled with the hash the admin saw: no detail read in between, so
    // the check must use the worksheet as it stands under the lock.
    const stale = await markFiledReq(fid, { expectedWorksheetHash: oldHash });
    const staleBody = stale.json() as Record<string, unknown>;
    // Read the row straight from the DB (a GET would refresh it): the
    // refreshed worksheet must already be committed by the refused markFiled.
    const afterRefusal = await filingRow(fid);
    expect({
      status: stale.statusCode,
      error: staleBody.error,
      message: staleBody.message,
      noAmount:
        !String(staleBody.message ?? "").includes("$") &&
        !MONEY_SHAPED.test(String(staleBody.message ?? "")),
      rowStatus: afterRefusal.status,
      storedHashRefreshed:
        afterRefusal.worksheetHash !== oldHash && afterRefusal.worksheetHash !== null,
      fileAudits: await auditCount("tax_filing.file", String(fid)),
    }).toEqual({
      status: 409,
      error: "worksheet_changed",
      message: WORKSHEET_CHANGED_MESSAGE,
      noAmount: true,
      rowStatus: "ready",
      storedHashRefreshed: true,
      fileAudits: 0,
    });
    expect(afterRefusal.status).not.toBe("filed");

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
});

describe("G-7 order B: markFiled commits, then the issue", () => {
  it("issue -> 409 pay_period_filed [941:2026-Q1]", async () => {
    await resetFilings();
    now = new Date(MAY_2);
    const id = await draft("2026-03", "2026-03-20");
    await approve(id);
    const fid = await putFiling("941", 2026, 1, "ready");
    await openFiling(fid); // G-9: a row is filed only after its worksheet was read
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

// ---------------------------------------------------------------- G-9 markFiled without a hash

describe("G-9 markFiled without expectedWorksheetHash = expected the stored hash", () => {
  it("941: a past-dated run issued after the last read -> 409 worksheet_changed, refreshed worksheet committed; the retry files", async () => {
    await resetFilings();
    now = new Date(MAY_2);
    const fid = await putFiling("941", 2026, 2, "ready");
    const readHash = await openFiling(fid);

    // An April run is issued after the read (Q2 not filed -> allowed). A
    // not-late issue does not refresh the worksheet (L4 refreshes only on a
    // late issue), so the stored hash is now stale.
    const id = await draft("2026-04", "2026-04-20");
    await approve(id);
    const issued = await act(id, "issue");
    expect(issued.statusCode, issued.body).toBe(200);
    expect((await filingRow(fid)).worksheetHash).toBe(readHash);

    const res = await markFiledReq(fid); // no expectedWorksheetHash
    const body = res.json() as Record<string, unknown>;
    const row = await filingRow(fid); // DB read, not GET
    expect({
      status: res.statusCode,
      error: body.error,
      message: body.message,
      rowStatus: row.status,
      storedHashRefreshed: row.worksheetHash !== readHash && row.worksheetHash !== null,
      fileAudits: await auditCount("tax_filing.file", String(fid)),
    }).toEqual({
      status: 409,
      error: "worksheet_changed",
      message: WORKSHEET_CHANGED_MESSAGE,
      rowStatus: "ready",
      storedHashRefreshed: true,
      fileAudits: 0,
    });

    // The committed worksheet is the current one: a read changes nothing,
    // and filing again (still without a hash) succeeds with it.
    const refreshed = row.worksheetHash;
    expect(await openFiling(fid)).toBe(refreshed);
    const ok = await markFiledReq(fid);
    expect(ok.statusCode, ok.body).toBe(200);
    const filed = await filingRow(fid);
    expect({ status: filed.status, worksheetHash: filed.worksheetHash }).toEqual({
      status: "filed",
      worksheetHash: refreshed,
    });
  });

  it("941: nothing changed since the last read -> files (200), stored hash unchanged", async () => {
    await resetFilings();
    now = new Date(MAY_2);
    const fid = await putFiling("941", 2025, 3, "ready");
    const readHash = await openFiling(fid);
    const res = await markFiledReq(fid);
    expect(res.statusCode, res.body).toBe(200);
    const row = await filingRow(fid);
    expect({
      status: row.status,
      worksheetHash: row.worksheetHash,
      fileAudits: await auditCount("tax_filing.file", String(fid)),
    }).toEqual({ status: "filed", worksheetHash: readHash, fileAudits: 1 });
  });
});

// ---------------------------------------------------------------- G-10 unlocked refresh vs filed row

describe("G-10 a filed 941 worksheet is never rewritten by an unlocked refresh", () => {
  it("adjustment: refresh decided on the stale unfiled row, row filed before the write -> worksheet and hash stay as filed", async () => {
    await resetFilings();
    now = new Date(MAY_2);
    const fid = await putFiling("941", 2025, 2, "ready");
    const filedHash = await openFiling(fid);
    const filedWorksheet = (await filingRow(fid)).worksheet;

    // addAdjustment reads the row (unfiled) first, then inserts the
    // adjustment, then refreshes with the row object it read. Stand-in for a
    // concurrent markFiled (hash = filedHash) that commits in between: right
    // before the adjustment insert, mark the row filed.
    hook = {
      match: (s) => s.tx !== null && /^\s*insert\s+into\s+"?tax_adjustments"?/i.test(s.text),
      run: async (client) => {
        await client.query(
          "UPDATE tax_filings SET status = 'filed', filed_on = '2026-05-01', filing_method = 'concurrent' WHERE id = $1",
          [fid],
        );
      },
    };
    // amountPaid feeds 941 line 13: a refresh would compute a different hash.
    const res = await t.app.inject({
      method: "POST",
      url: `/api/admin/tax-filings/${fid}/adjustments`,
      headers: ADMIN,
      payload: { kind: "notice", amountDue: "10.00", amountPaid: "10.00" },
    });
    const row = await filingRow(fid);
    expect({
      hookFired,
      noServerError: res.statusCode < 500,
      status: row.status,
      worksheetHash: row.worksheetHash,
      worksheet: row.worksheet,
    }).toEqual({
      hookFired: true,
      noServerError: true,
      status: "filed",
      worksheetHash: filedHash,
      worksheet: filedWorksheet,
    });
  });
});

// ---------------------------------------------------------------- G-11 pay_period_filed copy

describe("G-11 pay_period_filed message names only the blocking forms' corrections", () => {
  const CORRECTION = {
    "941": "Form 941-X",
    "940": "an amended Form 940",
    w2_w3: "Forms W-2c and W-3c",
  } as const;

  async function refusalMessage(
    filed: [Form, number][],
    payDate: string,
    ym: string,
    clock: string,
  ): Promise<string> {
    await resetFilings();
    now = new Date(clock);
    const id = await draft(ym, payDate);
    for (const [form, quarter] of filed) await putFiling(form, 2026, quarter, "filed");
    await approve(id);
    const res = await act(id, "issue");
    expect(res.statusCode, res.body).toBe(409);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe("pay_period_filed");
    return body.message;
  }

  function copy(message: string) {
    return {
      f941x: message.includes(CORRECTION["941"]),
      amended940: message.includes(CORRECTION["940"]),
      w2c: message.includes(CORRECTION.w2_w3),
      anyW2c: message.includes("W-2c"),
      any940: message.includes("940"),
      any941x: message.includes("941-X"),
      nothingIssued: message.includes("Nothing was issued"),
      dontMoveIt: message.includes("Don't move it"),
      oldWording: message.includes("A return covering"),
    };
  }
  const common = { nothingIssued: true, dontMoveIt: true, oldWording: false };

  it("only the 941 filed -> 'Form 941-X'; no W-2c, no 940", async () => {
    const m = await refusalMessage([["941", 1]], "2026-03-20", "2026-03", MAY_2);
    expect(copy(m)).toEqual({
      f941x: true,
      amended940: false,
      w2c: false,
      anyW2c: false,
      any940: false,
      any941x: true,
      ...common,
    });
  });

  it("only the 940 filed -> 'an amended Form 940'; no 941-X, no W-2c", async () => {
    const m = await refusalMessage([["940", 0]], "2026-12-31", "2026-12", JAN_10_2027);
    expect(copy(m)).toEqual({
      f941x: false,
      amended940: true,
      w2c: false,
      anyW2c: false,
      any940: true,
      any941x: false,
      ...common,
    });
  });

  it("only the W-2/W-3 filed -> 'Forms W-2c and W-3c'; no 941-X, no amended 940", async () => {
    const m = await refusalMessage([["w2_w3", 0]], "2026-12-31", "2026-12", JAN_10_2027);
    expect(copy(m)).toEqual({
      f941x: false,
      amended940: false,
      w2c: true,
      anyW2c: true,
      any940: false,
      any941x: false,
      ...common,
    });
  });

  it("all three filed -> all three corrections named", async () => {
    const m = await refusalMessage(
      [
        ["941", 4],
        ["940", 0],
        ["w2_w3", 0],
      ],
      "2026-12-31",
      "2026-12",
      JAN_10_2027,
    );
    expect(copy(m)).toEqual({
      f941x: true,
      amended940: true,
      w2c: true,
      anyW2c: true,
      any940: true,
      any941x: true,
      ...common,
    });
  });
});

// ---------------------------------------------------------------- G-12 audit before.status

describe("G-12 markFiled audit before.status comes from the locked re-read", () => {
  it("row promoted not_started -> ready between the pre-read and the lock -> before.status 'ready'", async () => {
    await resetFilings();
    now = new Date(MAY_2);
    const fid = await putFiling("941", 2025, 1, "not_started");
    await openFiling(fid);
    expect((await filingRow(fid)).status).toBe("not_started");
    hook = {
      match: (s) => labelOf(s) === "filing_close_lock",
      run: async (client) => {
        await client.query("UPDATE tax_filings SET status = 'ready' WHERE id = $1", [fid]);
      },
    };
    const res = await markFiledReq(fid);
    expect(res.statusCode, res.body).toBe(200);
    const audits = await t.db
      .select({ before: auditEvents.before })
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "tax_filing.file"), eq(auditEvents.entityId, String(fid))));
    expect({
      hookFired,
      count: audits.length,
      beforeStatus: (audits[0]?.before as { status?: string } | null)?.status,
    }).toEqual({ hookFired: true, count: 1, beforeStatus: "ready" });
  });
});

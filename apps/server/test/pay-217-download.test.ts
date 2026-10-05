/**
 * PAY-217 T-14 .. T-20 + R1/R2/R3/R5/R6 — what a former employee can get.
 * payroll-calc-auditor, fail-first against faad1d9; the coder may not edit
 * this file. Synthetic data only. Legal source + oracle dates:
 * pay-217-harness.ts.
 *
 * The federal SME ruling on OD-2 (2026-10-05) supersedes the brief's
 * hash-match gate: T-16 is INVERTED (a correction after termination is
 * posted online + IMPORTANT notice, and paper too; no w2_on_paper, no
 * onPaper) and T-17 is re-specified per R3.
 *
 * Contract assumed:
 *  - GET /api/my/w2 for a former employee: `w2s` = only years with a
 *    portal_notice / employee_download row whose window is open today
 *    (company-local); per year ready, formCount, corrected, downloadable,
 *    accessThrough; NO `onPaper` key; `upcomingYear` null; + `former:
 *    { companyName, contact: { name, phone, email, ... } }`.
 *  - GET /api/my/w2/:year/pdf for a former employee: a year not in that
 *    list -> 409 { error: "w2_not_available" } (one body for never online /
 *    window closed / foreign year), no furnishing row written.
 *  - R1: furnishCorrectionIfNeeded / reconcileW2Furnishings post a
 *    correction of a year furnished online as a CORRECTED portal_notice
 *    with the IMPORTANT w2_changed mail, whatever the employment status and
 *    a later withdrawal. R2: paper is still owed (admin row
 *    correctionToFurnish until paper_handed); the former-employee notice
 *    says a paper copy is coming (regex /paper copy/i — UX owns wording).
 *  - R3: a former download renders current figures only when a
 *    portal_notice row carries those figures; the window check and the
 *    figures read happen under the employee lock in the furnishing
 *    transaction.
 *  - R5: an undeliverable IMPORTANT w2_changed mail to a former employee is
 *    listed in the PAY-208 undeliveredNotices of the year.
 *  - R6: a year never furnished online -> corrections on paper only.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { emailOutbox } from "@payroll/db";
import { reconcileW2Furnishings } from "../src/filings/w2-furnish.js";
import {
  adminCall,
  adminList,
  boot217,
  CONTACT,
  consenter,
  correct,
  deleteConsent,
  deps,
  type Emp,
  type Env,
  errorOf,
  furnishings,
  IMPORTANT,
  insertFurnishing,
  makeEmp,
  me,
  mustSignIn,
  myPdf,
  myW2,
  NEW_VERSION,
  outbox,
  plain,
  reloginAdmin,
  terminate,
  yearNotice,
  moveTo,
} from "./pay-217-harness.js";
import { insertRun } from "./w2-state-harness.js";
import { installRecorder, labelOf, record, type Stmt } from "./pay-193-l4-harness.js";

const JAN_4_2027 = "2027-01-04T16:00:00Z";
const FEB_1_2027 = "2027-02-01T16:00:00Z"; // 10:00 CST

interface W2Row {
  year: number;
  ready: boolean;
  corrected: boolean;
  downloadable: boolean;
  accessThrough: string;
  [k: string]: unknown;
}
interface MyW2 {
  w2s: W2Row[];
  upcomingYear: number | null;
  former?: { companyName?: string; contact?: { name?: string; phone?: string; email?: string } };
}

async function list(env: Env, emp: Emp) {
  const r = await myW2(env, emp);
  if (r.statusCode !== 200) throw new Error(`GET /api/my/w2 ${r.statusCode} ${r.body}`);
  return r.json() as MyW2;
}

/** A late December run: the 2026 figures change after the W-2 was furnished. */
async function changeFigures(env: Env, employeeId: number) {
  await insertRun(env as never, employeeId, {
    payDate: "2026-12-31",
    periodStart: "2026-12-31",
    periodEnd: "2026-12-31",
    grossCents: 100_000,
    fitCents: 10_000,
    state: null,
  } as never);
}

async function adminRow(env: Env, employeeId: number, year = 2026) {
  await reloginAdmin(env);
  return (await adminList(env, year)).w2s.find((r) => r.employeeId === employeeId) as
    | { correctionToFurnish?: boolean }
    | undefined;
}

// ---------------------------------------------------------------- T-14, T-15, T-18

describe("PAY-217 former employee download: T-14, T-15, T-18 (2027-02-01)", () => {
  let env: Env;
  const e: Record<string, Emp> = {};
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    e.d15 = await consenter(env, "Dl15");
    e.d18 = await consenter(env, "Dl18");
    // T-14: terminated mid-December 2026, before the January notice: the
    // 2026 W-2 goes on paper. TY2025 was furnished online (a corrected
    // posting on 2027-01-03 keeps it online through 2027-04-03).
    e.d14 = await consenter(env, "Dl14", [2025, 2026]);
    await insertFurnishing(env, e.d14.id, 2025, { at: "2026-01-05T16:00:00Z" });
    await insertFurnishing(env, e.d14.id, 2025, { at: "2027-01-03T18:00:00Z", corrected: true });
    await terminate(env, e.d14, "2026-12-15");
    await yearNotice(env);
    await moveTo(env, FEB_1_2027);
    await terminate(env, e.d15, "2027-01-29");
    await terminate(env, e.d18, "2027-01-29");
  }, 300_000);
  afterAll(async () => env.close());

  it("T-15 year furnished online, window open, figures unchanged: listed (downloadable, through 2027-10-15, no onPaper, former contact block); PDF 200 twice, one employee_download row at most", async () => {
    await mustSignIn(env, e.d15!);
    const l = await list(env, e.d15!);
    const before = (await furnishings(env, e.d15!.id, 2026)).length;
    const p1 = await myPdf(env, e.d15!, 2026);
    const p2 = await myPdf(env, e.d15!, 2026);
    const added = (await furnishings(env, e.d15!.id, 2026)).slice(before);
    const y = l.w2s.find((r) => r.year === 2026);
    expect({
      years: l.w2s.map((r) => r.year),
      row: y && {
        ready: y.ready,
        downloadable: y.downloadable,
        corrected: y.corrected,
        accessThrough: y.accessThrough,
        onPaper: "onPaper" in y,
      },
      upcomingYear: l.upcomingYear,
      contact: l.former?.contact && {
        name: l.former.contact.name,
        phone: l.former.contact.phone,
        email: l.former.contact.email,
      },
      companyName: typeof l.former?.companyName === "string" && l.former.companyName.length > 0,
      pdf: [p1.statusCode, String(p1.headers["content-type"]), p2.statusCode],
      added: added.map((r) => r.method),
    }).toEqual({
      years: [2026],
      row: {
        ready: true,
        downloadable: true,
        corrected: false,
        accessThrough: "2027-10-15",
        onPaper: false,
      },
      upcomingYear: null,
      contact: { name: CONTACT.name, phone: CONTACT.phone, email: CONTACT.email },
      companyName: true,
      pdf: [200, "application/pdf", 200],
      added: ["employee_download"],
    });
  });

  it("T-14 a year never furnished online (termination-year W-2, paper notice) is absent from the list; its PDF -> 409 w2_not_available; no online row written", async () => {
    await mustSignIn(env, e.d14!);
    const l = await list(env, e.d14!);
    const pdf = await myPdf(env, e.d14!, 2026);
    const foreign = await myPdf(env, e.d14!, 2024);
    const online2026 = (await furnishings(env, e.d14!.id, 2026)).filter(
      (r) => r.method === "portal_notice" || r.method === "employee_download",
    );
    expect({
      years: l.w2s.map((r) => r.year),
      through2025: l.w2s.find((r) => r.year === 2025)?.accessThrough,
      pdf: [pdf.statusCode, errorOf(pdf)],
      foreign: [foreign.statusCode, errorOf(foreign)],
      online2026: online2026.length,
      me: (await me(env, e.d14!.session!)).json(),
    }).toMatchObject({
      years: [2025],
      through2025: "2027-04-03",
      pdf: [409, "w2_not_available"],
      foreign: [409, "w2_not_available"],
      online2026: 0,
      me: { access: "w2_only", w2AccessThrough: "2027-04-03" },
    });
  });

  it("T-18 consent routes (GET/POST/DELETE, test-pdf) -> 403 w2_access_only; consent row and furnishing rows unchanged", async () => {
    await mustSignIn(env, e.d18!);
    const consentBefore = await env.t.pglite.query(
      "SELECT disclosure_version, withdrawn_at FROM w2_delivery_consents WHERE employee_id = $1",
      [e.d18!.id],
    );
    const rowsBefore = (await furnishings(env, e.d18!.id)).length;
    const h = e.d18!.session!;
    const res = {
      get: await env.t.app.inject({ method: "GET", url: "/api/my/w2/consent", headers: h }),
      testPdf: await env.t.app.inject({
        method: "GET",
        url: "/api/my/w2/consent/test-pdf",
        headers: h,
      }),
      post: await env.t.app.inject({
        method: "POST",
        url: "/api/my/w2/consent",
        headers: h,
        payload: { disclosureVersion: NEW_VERSION, accessCode: "000000" },
      }),
      del: await deleteConsent(env, e.d18!),
    };
    const consentAfter = await env.t.pglite.query(
      "SELECT disclosure_version, withdrawn_at FROM w2_delivery_consents WHERE employee_id = $1",
      [e.d18!.id],
    );
    const r403 = [403, "w2_access_only"];
    expect({
      get: [res.get.statusCode, errorOf(res.get)],
      testPdf: [res.testPdf.statusCode, errorOf(res.testPdf)],
      post: [res.post.statusCode, errorOf(res.post)],
      del: [res.del.statusCode, errorOf(res.del)],
      consentUnchanged: JSON.stringify(consentAfter.rows) === JSON.stringify(consentBefore.rows),
      rowsAdded: (await furnishings(env, e.d18!.id)).length - rowsBefore,
    }).toEqual({
      get: r403,
      testPdf: r403,
      post: r403,
      del: r403,
      consentUnchanged: true,
      rowsAdded: 0,
    });
  });
});

// ---------------------------------------------------------------- T-16 (inverted), R1, R2, R5, R6

describe("PAY-217 T-16 (inverted per SME R1-R3): a correction after termination is posted online + IMPORTANT notice, and owed on paper", () => {
  let env: Env;
  const e: Record<string, Emp> = {};
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    e.c1 = await consenter(env, "Cr1");
    e.c2 = await consenter(env, "Cr2withdrew");
    e.c4 = await consenter(env, "Cr4bounce");
    e.c6 = await makeEmp(env, { label: "Cr6paper", login: true, years: [2026] }); // no consent: paper only
    await yearNotice(env);
    // R6: c6's 2026 W-2 was handed on paper (never online).
    await insertFurnishing(env, e.c6.id, 2026, {
      method: "paper_handed",
      at: "2027-01-10T16:00:00Z",
    });
    await moveTo(env, FEB_1_2027);
    // R1: c2 withdrew AFTER the online W-2, while still employed.
    await mustSignIn(env, e.c2);
    const del = await deleteConsent(env, e.c2);
    if (del.statusCode !== 200) throw new Error(`withdraw ${del.statusCode}`);
    for (const k of ["c1", "c2", "c4", "c6"]) {
      await terminate(env, e[k]!, "2027-01-29");
      await changeFigures(env, e[k]!.id);
    }
    await moveTo(env, "2027-03-01T17:00:00Z"); // 11:00 CST
  }, 300_000);
  afterAll(async () => env.close());

  it("T-16/R1/R2 the daily reconcile posts a CORRECTED portal_notice with the new figures and queues the IMPORTANT w2_changed mail (paper line); the admin row still owes paper; the former employee sees the year corrected + downloadable (no onPaper) and the PDF carries the posted figures", async () => {
    const original = (await furnishings(env, e.c1!.id, 2026)).filter(
      (r) => r.method === "portal_notice",
    );
    await reconcileW2Furnishings(deps(env), { today: "2027-03-01" });
    const rows = await furnishings(env, e.c1!.id, 2026);
    const posted = rows.filter((r) => r.method === "portal_notice").slice(original.length);
    const mails = await outbox(env, e.c1!.userId, "w2_changed");
    const important = mails.filter((m) => m.subject.startsWith(IMPORTANT));
    const owedBefore = (await adminRow(env, e.c1!.id))?.correctionToFurnish;
    await mustSignIn(env, e.c1!);
    const l = await list(env, e.c1!);
    const y = l.w2s.find((r) => r.year === 2026);
    const pdf = await myPdf(env, e.c1!, 2026);
    const dl = (await furnishings(env, e.c1!.id, 2026))
      .filter((r) => r.method === "employee_download")
      .at(-1);
    const paper = await adminCall(
      env,
      "POST",
      `/api/admin/annual-forms/w2/${e.c1!.id}/furnished-on-paper?year=2026`,
      {},
    );
    const owedAfter = (await adminRow(env, e.c1!.id))?.correctionToFurnish;
    expect({
      posted: posted.map((r) => ({
        corrected: r.corrected,
        newFigures: r.boxes_hash !== original[0]?.boxes_hash,
      })),
      important: important.map((m) => m.subject.includes("corrected 2026")),
      paperLine: important.map((m) => /paper copy/i.test(plain(m.bodyHtml))),
      owedBefore,
      row: y && {
        corrected: y.corrected,
        downloadable: y.downloadable,
        accessThrough: y.accessThrough,
        onPaper: "onPaper" in y,
      },
      me: (await me(env, e.c1!.session!)).json(),
      pdf: pdf.statusCode,
      pdfFiguresPosted: dl?.boxes_hash === posted[0]?.boxes_hash,
      paper: paper.statusCode,
      owedAfter,
    }).toMatchObject({
      posted: [{ corrected: true, newFigures: true }],
      important: [true],
      paperLine: [true],
      owedBefore: true,
      // 2027-03-01 + 90 days = 2027-05-30, before Oct 15: the Oct 15 date holds.
      row: { corrected: true, downloadable: true, accessThrough: "2027-10-15", onPaper: false },
      me: { access: "w2_only", w2AccessThrough: "2027-10-15" },
      pdf: 200,
      pdfFiguresPosted: true,
      paper: 200,
      owedAfter: false,
    });
  });

  it("R1 a later withdrawal does not stop the online correction of a year already furnished online (former employee who withdrew while employed): the daily reconcile posts it once, with one IMPORTANT mail", async () => {
    // Idempotent: the T-16 test may already have run this reconcile on the
    // same day; R1 must hold whether or not it did.
    await reconcileW2Furnishings(deps(env), { today: "2027-03-01" });
    const portal = (await furnishings(env, e.c2!.id, 2026)).filter(
      (r) => r.method === "portal_notice",
    );
    const mails = await outbox(env, e.c2!.userId, "w2_changed");
    const before = (await furnishings(env, e.c2!.id, 2026)).length;
    const again = await correct(env, e.c2!.id, 2026, "2027-03-01");
    const after = (await furnishings(env, e.c2!.id, 2026)).length;
    expect({
      portal: portal.map((r) => r.corrected),
      newFigures: portal.length === 2 && portal[1]!.boxes_hash !== portal[0]!.boxes_hash,
      important: mails.filter((m) => m.subject.startsWith(IMPORTANT)).length,
      paperLine: mails
        .filter((m) => m.subject.startsWith(IMPORTANT))
        .every((m) => /paper copy/i.test(plain(m.bodyHtml))),
      paperOwed: (await adminRow(env, e.c2!.id))?.correctionToFurnish,
      againNothing: [again, after - before],
    }).toEqual({
      portal: [false, true],
      newFigures: true,
      important: 1,
      paperLine: true,
      paperOwed: true,
      againNothing: [null, 0],
    });
  });

  it("R5 an undeliverable IMPORTANT w2_changed mail to a former employee is listed in undeliveredNotices for 2026", async () => {
    await correct(env, e.c4!.id, 2026, "2027-03-01");
    const ids = (await outbox(env, e.c4!.userId, "w2_changed")).map((m) => m.id);
    if (ids.length > 0) {
      await env.t.db
        .update(emailOutbox)
        .set({ status: "failed", attempts: 5, lastError: "550 mailbox unavailable" })
        .where(inArray(emailOutbox.id, ids));
    }
    await reloginAdmin(env);
    const l = await adminList(env, 2026);
    const listed = ((l.undeliveredNotices ?? []) as { employeeId: number }[]).map(
      (x) => x.employeeId,
    );
    expect({ mails: ids.length > 0, listed: listed.includes(e.c4!.id) }).toEqual({
      mails: true,
      listed: true,
    });
  });

  it("R6 (regression guard; passes today) a year furnished on paper only: the correction stays on paper — no portal_notice, no IMPORTANT mail", async () => {
    const out = await correct(env, e.c6!.id, 2026, "2027-03-01");
    const rows = await furnishings(env, e.c6!.id, 2026);
    const mails = await outbox(env, e.c6!.userId, "w2_changed");
    expect({
      out,
      portal: rows.filter((r) => r.method === "portal_notice").length,
      important: mails.filter((m) => m.subject.startsWith(IMPORTANT)).length,
    }).toEqual({ out: "w2_paper_correction_needed", portal: 0, important: 0 });
  });
});

// ---------------------------------------------------------------- T-17 (R3)

const INSERT_FURNISHING = /^\s*insert\s+into\s+"?w2_furnishings"?/i;

describe("PAY-217 T-17 (re-specified per R3): figures that changed after the last online posting are never rendered without a portal_notice row for them", () => {
  let env: Env;
  let x: Emp;
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    x = await consenter(env, "Rc17");
    await yearNotice(env);
    await moveTo(env, FEB_1_2027);
    await terminate(env, x, "2027-01-29");
    await changeFigures(env, x.id); // the daily reconcile has NOT run yet
    installRecorder(env.t);
  }, 240_000);
  afterAll(async () => env.close());

  it("former download before the reconcile: either 200 with a CORRECTED portal_notice for the rendered figures (+ IMPORTANT mail) written in the same transaction, after the employee lock — or a refusal with no row; never a PDF of figures with no portal_notice", async () => {
    await mustSignIn(env, x);
    const before = await furnishings(env, x.id, 2026);
    const { value: res, stmts } = await record(() => myPdf(env, x, 2026));
    const after = await furnishings(env, x.id, 2026);
    const added = after.slice(before.length);
    const download = added.filter((r) => r.method === "employee_download").at(-1);
    const portalForRendered = after.find(
      (r) =>
        r.method === "portal_notice" &&
        download !== undefined &&
        r.boxes_hash === download.boxes_hash &&
        r.id < download.id,
    );
    const important = (await outbox(env, x.userId, "w2_changed")).filter((m) =>
      m.subject.startsWith(IMPORTANT),
    );
    // Lock order in the transaction that wrote the furnishing rows.
    const insertAt = stmts.findIndex((s: Stmt) => s.tx !== null && INSERT_FURNISHING.test(s.text));
    const tx = insertAt >= 0 ? stmts[insertAt]!.tx : null;
    const inTx = stmts.map((s, i) => ({ s, i })).filter(({ s }) => tx !== null && s.tx === tx);
    const lockAt = inTx.find(({ s }) => labelOf(s) === "employee_lock")?.i ?? -1;
    const firstRead =
      inTx.find(({ s }) => /payroll_entries|w2_furnishings/i.test(s.text) && labelOf(s) === null)
        ?.i ?? -1;
    const outcome =
      res.statusCode === 200
        ? {
            status: 200,
            portalForRenderedFigures: portalForRendered !== undefined,
            portalCorrected: portalForRendered?.corrected ?? null,
            importantMail: important.length >= 1,
            lockBeforeReads: lockAt >= 0 && lockAt < firstRead,
          }
        : { status: res.statusCode, rowsAdded: added.length };
    expect([
      {
        status: 200,
        portalForRenderedFigures: true,
        portalCorrected: true,
        importantMail: true,
        lockBeforeReads: true,
      },
      { status: 409, rowsAdded: 0 },
    ]).toContainEqual(outcome);
  });
});

// ---------------------------------------------------------------- T-19, T-20 window edges

describe("PAY-217 T-19 window edges (company-local, America/Chicago)", () => {
  let env: Env;
  const e: Record<string, Emp> = {};
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    e.oct15 = await consenter(env, "Wn15");
    e.corr = await consenter(env, "Wncorr");
    e.sun = await makeEmp(env, { label: "Wnsun", login: true, consent: NEW_VERSION });
    e.sat = await makeEmp(env, { label: "Wnsat", login: true, consent: NEW_VERSION });
    await yearNotice(env);
    // Corrected posting 2027-09-01 12:00 CDT -> through 2027-11-30.
    await insertFurnishing(env, e.corr.id, 2026, { at: "2027-09-01T17:00:00Z", corrected: true });
    // TY2027 (Oct 15 2028 = Sunday) and TY2032 (Oct 15 2033 = Saturday).
    await insertFurnishing(env, e.sun.id, 2027, { at: "2028-01-05T16:00:00Z" });
    await insertFurnishing(env, e.sat.id, 2032, { at: "2033-01-05T16:00:00Z" });
    await moveTo(env, FEB_1_2027);
    await terminate(env, e.oct15, "2027-01-29");
    await terminate(env, e.corr, "2027-01-29");
  }, 300_000);
  afterAll(async () => env.close());

  async function edge(x: Emp, lastLocal2330Z: string, nextLocal0030Z: string, url: string) {
    await moveTo(env, new Date(new Date(lastLocal2330Z).getTime() - 30 * 60_000).toISOString());
    await mustSignIn(env, x);
    await moveTo(env, lastLocal2330Z);
    const last = await env.t.app.inject({
      method: "GET",
      url,
      headers: { ...x.session!, "x-forwarded-for": "10.217.250.1" },
    });
    const meLast = (await me(env, x.session!)).json() as { w2AccessThrough?: string };
    await moveTo(env, nextLocal0030Z);
    const next = await env.t.app.inject({
      method: "GET",
      url,
      headers: { ...x.session!, "x-forwarded-for": "10.217.250.2" },
    });
    return {
      last: last.statusCode,
      through: meLast.w2AccessThrough,
      next: [next.statusCode, errorOf(next)],
    };
  }

  it("Oct 15 2027 (Fri): PDF 200 at 23:30 local on the last day, 403 account_disabled at 00:30 local the next day", async () => {
    expect(
      await edge(e.oct15!, "2027-10-16T04:30:00Z", "2027-10-16T05:30:00Z", "/api/my/w2/2026/pdf"),
    ).toEqual({
      last: 200,
      through: "2027-10-15",
      next: [403, "account_disabled"],
    });
  });

  it("corrected posting 2027-09-01 -> through Tue 2027-11-30 (CST): 200 on Nov 30 23:30, refused Dec 1 00:30", async () => {
    expect(
      await edge(e.corr!, "2027-12-01T05:30:00Z", "2027-12-01T06:30:00Z", "/api/my/w2"),
    ).toEqual({
      last: 200,
      through: "2027-11-30",
      next: [403, "account_disabled"],
    });
  });

  it("TY2027: Oct 15 2028 is a Sunday -> through Mon 2028-10-16", async () => {
    await moveTo(env, "2028-10-01T15:00:00Z");
    await terminate(env, e.sun!, "2028-10-01");
    expect(await edge(e.sun!, "2028-10-17T04:30:00Z", "2028-10-17T05:30:00Z", "/api/me")).toEqual({
      last: 200,
      through: "2028-10-16",
      next: [403, "account_disabled"],
    });
  });

  it("TY2032: Oct 15 2033 is a Saturday -> through Mon 2033-10-17", async () => {
    await moveTo(env, "2033-10-01T15:00:00Z");
    await terminate(env, e.sat!, "2033-10-01");
    expect(await edge(e.sat!, "2033-10-18T04:30:00Z", "2033-10-18T05:30:00Z", "/api/me")).toEqual({
      last: 200,
      through: "2033-10-17",
      next: [403, "account_disabled"],
    });
  });
});

describe("PAY-217 T-20 two open years with different windows", () => {
  let env: Env;
  let x: Emp;
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    x = await consenter(env, "Tw20", [2025, 2026]);
    // TY2025: online in Jan 2026, corrected posting 2027-01-10 -> through 2027-04-10.
    await insertFurnishing(env, x.id, 2025, { at: "2026-01-05T16:00:00Z" });
    await insertFurnishing(env, x.id, 2025, { at: "2027-01-10T18:00:00Z", corrected: true });
    await yearNotice(env); // TY2026 online -> through 2027-10-15
    await moveTo(env, FEB_1_2027);
    await terminate(env, x, "2027-01-29");
  }, 240_000);
  afterAll(async () => env.close());

  it("both listed with their own dates; w2AccessThrough = the later; after 2027-04-10 only 2026 stays and the 2025 PDF -> 409 w2_not_available", async () => {
    await mustSignIn(env, x);
    const feb = await list(env, x);
    const febMe = (await me(env, x.session!)).json() as { w2AccessThrough?: string };
    await moveTo(env, "2027-04-11T15:00:00Z"); // 10:00 CDT Apr 11
    await mustSignIn(env, x);
    const apr = await list(env, x);
    const pdf2025 = await myPdf(env, x, 2025);
    const aprMe = (await me(env, x.session!)).json() as { w2AccessThrough?: string };
    expect({
      feb: feb.w2s.map((r) => [r.year, r.accessThrough]),
      febThrough: febMe.w2AccessThrough,
      apr: apr.w2s.map((r) => r.year),
      pdf2025: [pdf2025.statusCode, errorOf(pdf2025)],
      aprThrough: aprMe.w2AccessThrough,
    }).toEqual({
      feb: [
        [2025, "2027-04-10"],
        [2026, "2027-10-15"],
      ],
      febThrough: "2027-10-15",
      apr: [2026],
      pdf2025: [409, "w2_not_available"],
      aprThrough: "2027-10-15",
    });
  });
});

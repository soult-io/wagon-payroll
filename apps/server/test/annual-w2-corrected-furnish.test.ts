/**
 * PAY-206 furnishing writes (payroll-calc-auditor, fail-first; the coder may
 * not edit this file): T7, T8, T9, T14, T17, T20, R7/R8 list fields, R10
 * lock order. Tax year 2025 (the only year with a bundled fw2 template).
 *
 * Rulings: 26 CFR 31.6051-1(j)(5) (electronic furnishing = posted +
 * notified, with consent), (j)(6) (available through October 15 of the
 * following year); 2026 iw2w3 p.28.
 *
 * Interfaces required:
 *  - table w2_furnishings (spec §3); methods portal_notice,
 *    employee_download, admin_print, paper_handed, backfill; actor_id = the
 *    auth user id for employee/admin actions, null for the scheduler.
 *  - sendW2AvailableNotices: one portal_notice row per CONSENTED recipient
 *    (current hash, corrected false); none for a recipient without consent.
 *  - GET /api/my/w2/:year/pdf: employee_download row (first time per hash)
 *    written BEFORE the bytes; an insert failure -> 500 and no PDF.
 *  - GET …/w2/:id/print-packet: admin_print row. GET …/w2/:id/pdf (Copy D)
 *    and GET …/w3/pdf: no row.
 *  - POST /api/admin/annual-forms/w2/:employeeId/furnished-on-paper?year=:
 *    200 or 204; paper_handed row; audit w2_furnishing.paper_handed (entity
 *    employee, entityId = employee id, after { taxYear, corrected }); 409
 *    { error: "w2_not_ready", issues } when blocked; 404 without a W-2.
 *  - GET /api/my/w2 rows + corrected:boolean. GET /api/admin/annual-forms/w2
 *    rows + corrected, correctionToFurnish, furnished
 *    ("none"|"online"|"printed"|"paper"), furnishedOn (ISO date | null).
 *  - Every furnishing insert runs in a transaction that first takes
 *    pg_advisory_xact_lock(hashtext('payroll_run_employee:{id}')), then reads
 *    the figures (payroll_entries), then inserts.
 *  - No boxes_hash value in any API body, audit row, outbox row or log line.
 *
 * Expected hashes come from w2BoxesHash over the auditor's oracle boxes
 * (harness), never from the server's own figures.
 * Every test resets runs/filings/outbox/audit/furnishings and makes its own
 * employees, so the file passes in any order. Synthetic data only.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditEvents, emailOutbox } from "@payroll/db";
import { listMyW2Years, sendW2AvailableNotices, w2InputFor } from "../src/filings/annual.js";
import {
  bootL4,
  history,
  installRecorder,
  labelOf,
  type L4Env,
  record,
  type Stmt,
} from "./pay-193-l4-harness.js";
import {
  adminRow,
  boxStrings,
  brief,
  copyD,
  furnishings,
  hasAmount,
  hashOf,
  makeW2Emp,
  markedPages,
  markPaper,
  myList,
  myPdf,
  oracleBoxes,
  oracleMonths2025,
  pageShowsAll,
  printPacket,
  resetW2,
  seedHistory2025,
  type W2Emp,
  Y,
} from "./annual-w2-corrected-harness.js";
import { expMyVersions } from "./pay-223-versions-oracle.js";

let env: L4Env;

beforeAll(async () => {
  env = await bootL4({ adminEmail: "pay-206-furnish-admin@test.dev", logLevel: "trace" });
  installRecorder(env.t);
}, 180_000);

afterAll(async () => {
  await env.t.close();
});

beforeEach(async () => {
  await resetW2(env.t);
  env.logs.length = 0;
});

// 6,000.00/month Jan-Dec 2025: 72,000.00 / 7,454.04 / 72,000.00 / 4,464.00 / 72,000.00 / 1,044.00
const FULL = oracleMonths2025(600_000, 12);
const FULL_BOXES = oracleBoxes(FULL);

async function w2Employee(o: { login?: boolean; consent?: boolean }): Promise<W2Emp> {
  const e = await makeW2Emp(env, { grossCents: 600_000, ...o });
  await seedHistory2025(env, e, FULL);
  return e;
}

const deps = () => ({ db: env.t.db, config: env.t.config });

describe("oracle self-check (no engine)", () => {
  it("6,000.00/month 2025: FIT 621.17, SS 372.00, Medicare 87.00; Jan-Dec boxes 72000.00/7454.04/72000.00/4464.00/72000.00/1044.00", () => {
    expect([FULL[0]!.fitCents, FULL[0]!.ssCents, FULL[0]!.medCents, FULL[0]!.netCents]).toEqual([
      62_117, 37_200, 8_700, 491_983,
    ]);
    expect(boxStrings(FULL_BOXES)).toEqual([
      "72000.00",
      "7454.04",
      "72000.00",
      "4464.00",
      "72000.00",
      "1044.00",
    ]);
  });
});

describe("T7 year notice records portal_notice for consented recipients only", () => {
  it("consented -> one portal_notice row (current hash, corrected false, hash_version 1, actor null); not consented -> none; a second tick adds nothing", async () => {
    const a = await w2Employee({ login: true, consent: true });
    const b = await w2Employee({ login: true, consent: false });
    const first = await sendW2AvailableNotices(deps(), { today: "2026-01-05" });
    const h = await hashOf(a.id, Y, FULL_BOXES);
    const rowsA = await furnishings(env.t, a.id);
    expect({
      sent: first.sent,
      a: rowsA.map((r) => ({
        method: r.method,
        hash: r.boxes_hash,
        corrected: r.corrected,
        v: r.hash_version,
        actor: r.actor_id,
      })),
      b: await furnishings(env.t, b.id),
    }).toEqual({
      sent: 2,
      a: [{ method: "portal_notice", hash: h, corrected: false, v: 1, actor: null }],
      b: [],
    });
    const second = await sendW2AvailableNotices(deps(), { today: "2026-01-06" });
    expect({
      sent: second.sent,
      a: (await furnishings(env.t, a.id)).map((r) => r.id),
      b: (await furnishings(env.t, b.id)).length,
    }).toEqual({ sent: 0, a: rowsA.map((r) => r.id), b: 0 });
  });
});

describe("T8 employee download records employee_download before the bytes", () => {
  it("first download -> one employee_download row (current hash, corrected false, actor = the employee's user); the PDF is unmarked and shows boxes 1-6", async () => {
    const a = await w2Employee({ login: true, consent: true });
    const res = await myPdf(env, a);
    expect(res.statusCode, res.body).toBe(200);
    const h = await hashOf(a.id, Y, FULL_BOXES);
    const rows = await furnishings(env.t, a.id);
    const bytes = res.rawPayload;
    expect({
      rows: brief(rows),
      actor: rows[0]?.actor_id,
      marked: await markedPages(bytes),
      figures: await pageShowsAll(bytes, 0, boxStrings(FULL_BOXES)),
    }).toEqual({
      rows: [{ method: "employee_download", hash: h, corrected: false }],
      actor: a.userId,
      marked: [],
      figures: true,
    });
  });

  it("a second download of the same figures adds no row and keeps the first furnished_at", async () => {
    const a = await w2Employee({ login: true, consent: true });
    expect((await myPdf(env, a)).statusCode).toBe(200);
    const first = await furnishings(env.t, a.id);
    expect((await myPdf(env, a)).statusCode).toBe(200);
    const second = await furnishings(env.t, a.id);
    expect({
      ids: second.map((r) => r.id),
      at: second.map((r) => r.furnished_at.getTime()),
    }).toEqual({
      ids: first.map((r) => r.id),
      at: first.map((r) => r.furnished_at.getTime()),
    });
  });

  it("furnishing insert fails -> 500, no PDF bytes, no row (a copy never leaves without a record)", async () => {
    const a = await w2Employee({ login: true, consent: true });
    await env.t.pglite.exec(`
      CREATE OR REPLACE FUNCTION pay206_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'pay206 injected insert failure'; END $$;
      CREATE TRIGGER pay206_fail_insert BEFORE INSERT ON w2_furnishings
        FOR EACH ROW WHEN (NEW.employee_id = ${a.id}) EXECUTE FUNCTION pay206_fail_insert();`);
    try {
      const res = await myPdf(env, a);
      expect({
        status: res.statusCode,
        pdfType: String(res.headers["content-type"] ?? "").includes("application/pdf"),
        pdfBytes: res.rawPayload.subarray(0, 5).toString("latin1") === "%PDF-",
        rows: (await furnishings(env.t, a.id)).length,
      }).toEqual({ status: 500, pdfType: false, pdfBytes: false, rows: 0 });
    } finally {
      await env.t.pglite.exec("DROP TRIGGER IF EXISTS pay206_fail_insert ON w2_furnishings;");
    }
  });

  it("no consent -> 409 consent_required and no row (nothing was furnished)", async () => {
    const b = await w2Employee({ login: true, consent: false });
    const res = await myPdf(env, b);
    expect({ status: res.statusCode, rows: (await furnishings(env.t, b.id)).length }).toEqual({
      status: 409,
      rows: 0,
    });
  });
});

describe("T9 admin print-packet records admin_print; Copy D and the W-3 do not", () => {
  it("print-packet -> one admin_print row (actor = admin); repeat adds none; Copy D and W-3 downloads add none", async () => {
    const b = await w2Employee({ login: false });
    const p1 = await printPacket(env, b.id);
    expect(p1.statusCode, p1.body).toBe(200);
    const h = await hashOf(b.id, Y, FULL_BOXES);
    const afterPrint = await furnishings(env.t, b.id);
    expect((await printPacket(env, b.id)).statusCode).toBe(200);
    const d = await copyD(env, b.id);
    const w3 = await env.t.app.inject({
      method: "GET",
      url: `/api/admin/annual-forms/w3/pdf?year=${Y}`,
      headers: env.admin,
    });
    expect({
      printRows: brief(afterPrint),
      actor: afterPrint[0]?.actor_id,
      printMarked: await markedPages(p1.rawPayload),
      copyD: d.statusCode,
      copyDMarked: await markedPages(d.rawPayload),
      w3: w3.statusCode,
      finalIds: (await furnishings(env.t, b.id)).map((r) => r.id),
    }).toEqual({
      printRows: [{ method: "admin_print", hash: h, corrected: false }],
      actor: env.adminId,
      printMarked: [],
      copyD: 200,
      copyDMarked: [],
      w3: 200,
      finalIds: afterPrint.map((r) => r.id),
    });
  });
});

/** The furnishedOn readings the auditor accepts: company-local (APP_TZ) or UTC date. */
function dateReadings(at: Date): string[] {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: env.t.config.appTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  return [...new Set([local, at.toISOString().slice(0, 10)])];
}

describe("R7/R8 list fields", () => {
  it("admin list: none / online (download) / printed / paper; furnishedOn = date of the latest furnishing; corrected and correctionToFurnish false while figures are unchanged", async () => {
    const none = await w2Employee({ login: false });
    const online = await w2Employee({ login: true, consent: true });
    const printed = await w2Employee({ login: false });
    const paper = await w2Employee({ login: false });
    expect((await myPdf(env, online)).statusCode).toBe(200);
    expect((await printPacket(env, printed.id)).statusCode).toBe(200);
    const mark = await markPaper(env, paper.id);
    expect([200, 204], mark.body).toContain(mark.statusCode);
    const view = async (e: W2Emp) => {
      const r = await adminRow(env, e.id);
      return {
        corrected: r.corrected,
        correctionToFurnish: r.correctionToFurnish,
        furnished: r.furnished,
        furnishedOn: r.furnishedOn,
      };
    };
    const latestAt = async (e: W2Emp) => (await furnishings(env.t, e.id)).at(-1)!.furnished_at;
    const rows = {
      none: await view(none),
      online: await view(online),
      printed: await view(printed),
      paper: await view(paper),
    };
    const base = { corrected: false, correctionToFurnish: false };
    expect({
      none: rows.none,
      online: { ...rows.online, furnishedOn: undefined },
      printed: { ...rows.printed, furnishedOn: undefined },
      paper: { ...rows.paper, furnishedOn: undefined },
    }).toEqual({
      none: { ...base, furnished: "none", furnishedOn: null },
      online: { ...base, furnished: "online", furnishedOn: undefined },
      printed: { ...base, furnished: "printed", furnishedOn: undefined },
      paper: { ...base, furnished: "paper", furnishedOn: undefined },
    });
    expect({
      online: dateReadings(await latestAt(online)).includes(String(rows.online.furnishedOn)),
      printed: dateReadings(await latestAt(printed)).includes(String(rows.printed.furnishedOn)),
      paper: dateReadings(await latestAt(paper)).includes(String(rows.paper.furnishedOn)),
    }).toEqual({ online: true, printed: true, paper: true });
  });

  it("employee list row carries corrected:false for an unchanged W-2 (bare flag, no reasons)", async () => {
    const a = await w2Employee({ login: true, consent: true });
    expect((await myPdf(env, a)).statusCode).toBe(200);
    const res = await myList(env, a);
    expect(res.json()).toEqual({
      w2s: [
        {
          year: Y,
          availableOn: "2026-01-01",
          ready: true,
          corrected: false,
          downloadable: true,
          formCount: 1,
          // PAY-208 N1 ((j)(6)): Oct 15, 2026 (Thursday); unchanged W-2, no correction.
          accessThrough: "2026-10-15",
          // PAY-223 PR-2 (D-4): the one downloaded version, current.
          versions: await expMyVersions(env.t, a.id, Y, { current: "last", downloadable: true }),
        },
      ],
      // PAY-208 (2.2b): no issued year waiting for January.
      upcomingYear: null,
    });
  });

  it("furnished-on-paper: paper_handed row (actor admin, corrected false), audit w2_furnishing.paper_handed { taxYear, corrected }; idempotent (no second row, no second audit row)", async () => {
    const p = await w2Employee({ login: false });
    const h = await hashOf(p.id, Y, FULL_BOXES);
    const r1 = await markPaper(env, p.id);
    const r2 = await markPaper(env, p.id);
    const rows = await furnishings(env.t, p.id);
    const audit = await env.t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "w2_furnishing.paper_handed"));
    expect({
      s1: [200, 204].includes(r1.statusCode),
      s2: [200, 204].includes(r2.statusCode),
      rows: brief(rows),
      actor: rows[0]?.actor_id,
      audit: audit.map((x) => ({
        actor: x.actorId,
        entity: x.entity,
        entityId: x.entityId,
        after: x.after,
      })),
    }).toEqual({
      s1: true,
      s2: true,
      rows: [{ method: "paper_handed", hash: h, corrected: false }],
      actor: env.adminId,
      audit: [
        {
          actor: env.adminId,
          entity: "employee",
          entityId: String(p.id),
          after: { taxYear: Y, corrected: false },
        },
      ],
    });
  });

  it("furnished-on-paper needs the admin role; an employee session gets 401/403 and nothing is written", async () => {
    const a = await w2Employee({ login: true, consent: true });
    const res = await env.t.app.inject({
      method: "POST",
      url: `/api/admin/annual-forms/w2/${a.id}/furnished-on-paper?year=${Y}`,
      headers: a.session!,
      payload: {},
    });
    expect({
      denied: [401, 403].includes(res.statusCode),
      rows: (await furnishings(env.t, a.id)).length,
    }).toEqual({ denied: true, rows: 0 });
  });
});

describe("T14 retention: (j)(6) posting window", () => {
  it("2025 is still listed and still serves on 2026-10-15 and on 2027-01-10 (consented)", async () => {
    const a = await w2Employee({ login: true, consent: true });
    const view = async (today: string) => ({
      listed: (await listMyW2Years(env.t.db, a.userId!, today)).includes(Y),
      box1: (await w2InputFor(deps(), a.id, Y, { today, requireBundledForm: true })).box1Wages,
    });
    expect({
      oct15: await view("2026-10-15"),
      jan10: await view("2027-01-10"),
      pdf: (await myPdf(env, a)).statusCode,
    }).toEqual({
      oct15: { listed: true, box1: "72000.00" },
      jan10: { listed: true, box1: "72000.00" },
      pdf: 200,
    });
  });
});

describe("T17 a blocked W-2 is never furnished", () => {
  it("box4_over_max and negative_amount: download/print/Copy D 409, furnished-on-paper 409 w2_not_ready with the issue codes; year notice held; no row on any path", async () => {
    const over = await makeW2Emp(env, { grossCents: 1_800_000, login: true, consent: true });
    // 10,918.21 SS withheld: 1 cent over 176,100 x 6.2% (2025 maximum) -> box4_over_max (block).
    await history(
      env.t,
      over,
      "2025-06",
      "2025-06-25",
      {
        grossCents: 18_000_000,
        fitCents: 0,
        ssCents: 1_091_821,
        ssWagesCents: 17_610_000,
        medCents: 261_000,
        medWagesCents: 18_000_000,
        stateCents: 0,
        netCents: 18_000_000 - 1_091_821 - 261_000,
        futaCents: 4_200,
        futaWagesCents: 700_000,
      },
      null,
    );
    const neg = await makeW2Emp(env, { grossCents: 100_000, login: false });
    await history(
      env.t,
      neg,
      "2025-03",
      "2025-03-25",
      {
        grossCents: -100_000,
        fitCents: 0,
        ssCents: -6_200,
        ssWagesCents: -100_000,
        medCents: -1_450,
        medWagesCents: -100_000,
        stateCents: 0,
        netCents: -92_350,
        futaCents: 0,
        futaWagesCents: 0,
      },
      null,
    );
    const notice = await sendW2AvailableNotices(deps(), { today: "2026-01-05" });
    const paperOver = await markPaper(env, over.id);
    const paperNeg = await markPaper(env, neg.id);
    expect({
      notice: notice.sent,
      download: (await myPdf(env, over)).statusCode,
      printOver: (await printPacket(env, over.id)).statusCode,
      printNeg: (await printPacket(env, neg.id)).statusCode,
      copyD: (await copyD(env, over.id)).statusCode,
      paperOver: { status: paperOver.statusCode, body: paperOver.json() },
      paperNeg: {
        status: paperNeg.statusCode,
        error: (paperNeg.json() as { error?: string }).error,
        issues: (paperNeg.json() as { issues?: string[] }).issues,
      },
      rows: [...(await furnishings(env.t, over.id)), ...(await furnishings(env.t, neg.id))].length,
    }).toEqual({
      notice: 0,
      download: 409,
      printOver: 409,
      printNeg: 409,
      copyD: 409,
      paperOver: { status: 409, body: { error: "w2_not_ready", issues: ["box4_over_max"] } },
      paperNeg: { status: 409, error: "w2_not_ready", issues: ["negative_amount"] },
      rows: 0,
    });
  });

  it("furnished-on-paper for an employee with no W-2 in the year -> 404, nothing written", async () => {
    const z = await makeW2Emp(env, { grossCents: 600_000, login: false });
    const res = await markPaper(env, z.id);
    expect({ status: res.statusCode, rows: (await furnishings(env.t, z.id)).length }).toEqual({
      status: 404,
      rows: 0,
    });
  });
});

// ---------------------------------------------------------------- R10 lock order

const INSERT_FURNISHING = /^\s*insert\s+into\s+"?w2_furnishings"?/i;

/** Per furnishing insert: lock index < figures read index < insert index, all in one transaction. */
function lockOrder(stmts: Stmt[], employeeId: number) {
  const out: { lockFirst: boolean; figuresInTx: boolean }[] = [];
  stmts.forEach((s, i) => {
    if (s.tx === null || !INSERT_FURNISHING.test(s.text)) return;
    if (
      !JSON.stringify(s.params).includes(String(employeeId)) &&
      !s.text.includes(String(employeeId))
    ) {
      return;
    }
    const inTx = stmts.map((x, j) => ({ x, j })).filter(({ x, j }) => x.tx === s.tx && j < i);
    const lock = inTx.find(
      ({ x }) =>
        labelOf(x) === "employee_lock" &&
        `${x.text} ${JSON.stringify(x.params)}`.includes(`payroll_run_employee:${employeeId}`),
    );
    const figures = inTx.find(({ x }) => /payroll_entries/i.test(x.text));
    out.push({
      lockFirst: lock !== undefined && (figures === undefined || lock.j < figures.j),
      figuresInTx: figures !== undefined,
    });
  });
  return out;
}

describe("R10 every furnishing write: employee lock -> figures -> insert, one transaction", () => {
  it("year notice, then a download (a new method: its own row), print-packet and furnished-on-paper", async () => {
    const a = await w2Employee({ login: true, consent: true });
    const p = await w2Employee({ login: false });
    const q = await w2Employee({ login: false });
    const ok = [{ lockFirst: true, figuresInTx: true }];
    const notice = await record(() => sendW2AvailableNotices(deps(), { today: "2026-01-05" }));
    const dl = await record(() => myPdf(env, a));
    const pr = await record(() => printPacket(env, p.id));
    const pp = await record(() => markPaper(env, q.id));
    expect({
      notice: lockOrder(notice.stmts, a.id),
      download: lockOrder(dl.stmts, a.id),
      print: lockOrder(pr.stmts, p.id),
      paper: lockOrder(pp.stmts, q.id),
    }).toEqual({ notice: ok, download: ok, print: ok, paper: ok });
  });

  it("a fresh download (no prior notice row) inserts under the lock too", async () => {
    const a = await w2Employee({ login: true, consent: true });
    const dl = await record(() => myPdf(env, a));
    expect(lockOrder(dl.stmts, a.id)).toEqual([{ lockFirst: true, figuresInTx: true }]);
  });
});

// ---------------------------------------------------------------- T20 no leak

/** JSON with bigint columns as strings. */
const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

describe("T20 the figures hash never leaves the database", () => {
  it("API bodies, audit rows, outbox rows and the trace log carry no boxes_hash; the new audit rows and the paper response carry no amount", async () => {
    const a = await w2Employee({ login: true, consent: true });
    const p = await w2Employee({ login: false });
    await sendW2AvailableNotices(deps(), { today: "2026-01-05" });
    const bodies: string[] = [];
    const dl = await myPdf(env, a);
    bodies.push(String(dl.headers["content-disposition"] ?? ""));
    bodies.push((await myList(env, a)).body);
    bodies.push((await printPacket(env, p.id)).headers["content-disposition"] as string);
    const paper = await markPaper(env, p.id);
    bodies.push(paper.body);
    const list = await env.t.app.inject({
      method: "GET",
      url: `/api/admin/annual-forms/w2?year=${Y}`,
      headers: env.admin,
    });
    bodies.push(list.body);
    const hashes = (
      await env.t.pglite.query<{ boxes_hash: string }>("SELECT boxes_hash FROM w2_furnishings")
    ).rows.map((r) => r.boxes_hash);
    const audits = json(await env.t.db.select().from(auditEvents));
    const furnishingAudits = json(
      await env.t.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.entity, "employee"),
            eq(auditEvents.action, "w2_furnishing.paper_handed"),
          ),
        ),
    );
    const outbox = json(
      (await env.t.db.select().from(emailOutbox)).map((m) => [m.subject, m.bodyHtml]),
    );
    const logs = env.logs.join("\n");
    const leaks = (text: string) => hashes.filter((h) => text.includes(h)).length;
    expect({
      hashesFound: hashes.length >= 3,
      inBodies: leaks(bodies.join("\n")),
      inAudits: leaks(audits),
      inOutbox: leaks(outbox),
      inLogs: leaks(logs),
      anyHexBlobInAudits: /[0-9a-f]{64}/.test(audits),
      paperAuditAmount: hasAmount(furnishingAudits),
      paperBodyAmount: hasAmount(paper.body),
    }).toEqual({
      hashesFound: true,
      inBodies: 0,
      inAudits: 0,
      inOutbox: 0,
      inLogs: 0,
      anyHexBlobInAudits: false,
      paperAuditAmount: false,
      paperBodyAmount: false,
    });
  });
});

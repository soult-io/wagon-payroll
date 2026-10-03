/**
 * PAY-206 review round (payroll-calc-auditor, fail-first; the coder may not
 * edit this file). Product Lead decisions 2026-10-03 (override the spec):
 *
 *  D1  correctionToFurnish comes from DELIVERY rows only — consented
 *      (active consent + login): the latest portal_notice; otherwise the
 *      latest paper_handed. employee_download / admin_print / backfill never
 *      clear it; `corrected` still counts every method.
 *  D2  figures that come back to an earlier hash re-notify / re-require
 *      paper: dedupe by the LATEST row of the same method (no unique key).
 *  D3  "latest" = highest id.
 *  D4  backfill runs at boot and lazily inside furnishCorrectionIfNeeded
 *      when the flag is missing: a late issue before the first tick, in a
 *      year the previous release notified, is a detected correction.
 *  D5  reconcile and backfill: one failing employee-year never stops the
 *      others nor the year notice (sendW2AvailableNotices); the error is
 *      logged by class only — a drizzle query error message carries the
 *      SQL params (boxes_hash, the mail body), so no message, params or
 *      hash may reach the console.
 *  D6  year notice: skip a recipient who already has a portal_notice row
 *      with the current figures (a rerun after a partial failure).
 *  D7  backfill rows -> furnished "unknown".
 *  D8  furnished-on-paper for a year with no bundled fw2 -> 409
 *      form_not_available.
 *  D9  consent withdrawn: a year furnished ELECTRONICALLY (portal_notice or
 *      employee_download) stays downloadable through
 *      electronicW2AccessThrough(year) (Oct 15 of year+1, next business
 *      day); backfill / admin_print rows do not count. A correction after
 *      withdrawal takes the paper path and the CORRECTED copy stays
 *      downloadable. 26 CFR 31.6051-1(j)(3)(v)(C), (j)(6).
 *  D10 GET /api/my/w2/:year/pdf and GET …/w2/:id/print-packet: 403
 *      { error: "cross_site" } when Sec-Fetch-Site is "cross-site" or
 *      "same-site"; "same-origin", "none" (user opened the link: typed,
 *      bookmark, new tab) or no header -> allowed (coordinator 2026-10-03);
 *      rate limit 20 per minute (21st -> 429).
 *  D11 (UX item 2) w2_changed bodies state no payroll cause (outbox check).
 *
 * Interfaces required beyond the earlier suites:
 *  - The /api/my/w2 routes read "today" from the app clock (buildApp
 *    deps.clock, company-local APP_TZ date) — the D9 window is tested by
 *    moving that clock.
 *  - scheduler.ts exports annualTick({ db, config }): the daily annual step
 *    (syncAnnualFilings, backfill, reconcile, sendW2AvailableNotices).
 *  - The boot path (src/index.ts or src/app.ts) calls backfillW2Furnishings.
 *
 * Tax year 2025 (only year with a bundled fw2). Expected hashes come from
 * w2BoxesHash over the auditor's oracle boxes (harness), never from the
 * server's figures; every engine-generated late run is diffed to the cent
 * against the oracle first. Every test resets and makes its own employees.
 * Synthetic data only.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspect } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { appSettings, auditEvents, company, emailOutbox, taxConfig } from "@payroll/db";
import { sendW2AvailableNotices } from "../src/filings/annual.js";
import { entriesOf } from "./pay-date-helpers.js";
import {
  approve,
  bootL4,
  draft,
  history,
  issue,
  type L4Env,
  latePayment,
  runByPublicId,
} from "./pay-193-l4-harness.js";
import {
  adminRow,
  boxStrings,
  brief,
  freshAdmin,
  furnishModule,
  furnishings,
  hashOf,
  makeW2Emp,
  markedPages,
  markPaper,
  myList,
  myPdf,
  oracleBoxes,
  oracleMonths2025,
  oracleRun2025,
  pageShowsAll,
  printPacket,
  rawFurnishing,
  resetW2,
  ROOT,
  seedHistory2025,
  setNotifiedYears,
  type W2Emp,
  withdrawConsent,
  Y,
} from "./annual-w2-corrected-harness.js";

let env: L4Env;

beforeAll(async () => {
  env = await bootL4({ adminEmail: "pay-206-review-admin@test.dev" });
}, 180_000);

afterAll(async () => {
  await env.t.close();
});

beforeEach(async () => {
  await resetW2(env.t);
  env.setNow("2026-06-01T10:00:00Z");
});

const deps = () => ({ db: env.t.db, config: env.t.config });

// ---------------------------------------------------------------- oracle

const G = 600_000;
const JAN_NOV = oracleMonths2025(G, 11);
const JAN_DEC = oracleMonths2025(G, 12);
const B_NOV = oracleBoxes(JAN_NOV);
const B_DEC = oracleBoxes(JAN_DEC);
/** December run at 6,000.00: FIT 621.17, SS 372.00, Medicare 87.00, net 4,919.83. */
const LATE = JAN_DEC[11]!;
/** 16,000.00/month: box1 192,000.00, box3 176,100.00 (2025 wage base), box4 10,918.20. */
const HIGH = oracleMonths2025(1_600_000, 12);
const B_HIGH = oracleBoxes(HIGH);
/** The same runs with the SS wage base raised to 180,000.00 in tax_config: box 3 180,000.00. */
const B_HIGH_180 = oracleBoxes(HIGH, 18_000_000);

const W2_PHRASE = "IMPORTANT TAX RETURN DOCUMENT AVAILABLE";
const JAN_10 = "2026-01-10T10:00:00Z";
const NO_DIFF = { gross: 0, fit: 0, ss: 0, med: 0, net: 0 };

async function co(): Promise<string> {
  return (await env.t.db.select({ n: company.legalName }).from(company).limit(1))[0]!.n;
}

async function mails(userId: string | null, eventType: "w2_changed" | "w2_available") {
  const rows = await env.t.db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.eventType, eventType));
  return rows.filter((r) => r.userId === userId);
}

async function lateRun(emp: W2Emp, ym: string, payDate: string, issueAt: string) {
  env.setNow(`${payDate}T08:00:00Z`);
  const d = await draft(env.t, emp, ym, payDate);
  await approve(env, d.publicId);
  env.setNow(issueAt);
  return d;
}

async function issueLate(publicId: string): Promise<string[]> {
  const res = await issue(env, publicId, latePayment(LATE.netCents, []));
  expect(res.status, res.raw).toBe(200);
  return (res.body.lateIssue as { followUps: string[] }).followUps;
}

async function entriesDiff(publicId: string) {
  const run = await runByPublicId(env.t, publicId);
  const e = await entriesOf(env.t, run.id);
  return {
    gross: e.gross_pay! - LATE.grossCents,
    fit: e.federal_withholding! - LATE.fitCents,
    ss: e.social_security! - LATE.ssCents,
    med: e.medicare! - LATE.medCents,
    net: e.net_pay! - LATE.netCents,
  };
}

const federal2025 = and(eq(taxConfig.jurisdiction, "federal"), eq(taxConfig.taxYear, Y));

async function ssCap(): Promise<string> {
  return (
    await env.t.db
      .select({ cap: taxConfig.socialSecurityWageCap })
      .from(taxConfig)
      .where(federal2025)
      .limit(1)
  )[0]!.cap;
}

async function setSsCap(value: string): Promise<void> {
  await env.t.db.update(taxConfig).set({ socialSecurityWageCap: value }).where(federal2025);
}

/** Run `body` with the 2025 SS wage base restored afterwards. */
async function withCapRestored(body: () => Promise<void>): Promise<void> {
  const original = await ssCap();
  expect(original).toBe("176100.00");
  try {
    await body();
  } finally {
    await setSsCap(original);
  }
}

async function listView(e: W2Emp) {
  const r = await adminRow(env, e.id);
  return {
    corrected: r.corrected,
    correctionToFurnish: r.correctionToFurnish,
    furnished: r.furnished,
  };
}

/** The JSON body, or a marker when the body is not JSON (e.g. a PDF on a route that should refuse). */
function safeJson(res: { body: string; headers: Record<string, unknown> }): unknown {
  try {
    return JSON.parse(res.body);
  } catch {
    return `<non-JSON ${String(res.headers["content-type"] ?? "")}>`;
  }
}

async function dropTrigger(name: string, table: string) {
  await env.t.pglite.exec(`DROP TRIGGER IF EXISTS ${name} ON ${table};`);
}

describe("oracle self-check (no engine)", () => {
  it("6,000.00/month Jan-Nov / Jan-Dec and 16,000.00/month at both wage bases", () => {
    expect({
      nov: boxStrings(B_NOV),
      dec: boxStrings(B_DEC),
      high: boxStrings(B_HIGH),
      high180: boxStrings(B_HIGH_180),
      late: [LATE.fitCents, LATE.ssCents, LATE.medCents, LATE.netCents],
    }).toEqual({
      nov: ["66000.00", "6832.87", "66000.00", "4092.00", "66000.00", "957.00"],
      dec: ["72000.00", "7454.04", "72000.00", "4464.00", "72000.00", "1044.00"],
      high: ["192000.00", "35327.04", "176100.00", "10918.20", "192000.00", "2784.00"],
      high180: ["192000.00", "35327.04", "180000.00", "10918.20", "192000.00", "2784.00"],
      late: [62_117, 37_200, 8_700, 491_983],
    });
  });
});

// ---------------------------------------------------------------- D1

describe("D1 only a delivery clears the correction to furnish", () => {
  it("paper (T12 path): printing the CURRENT figures keeps correctionToFurnish true; only furnished-on-paper clears it", async () => {
    const g = await makeW2Emp(env, { grossCents: G, login: true, consent: false });
    await seedHistory2025(env, g, JAN_NOV);
    expect((await printPacket(env, g.id)).statusCode).toBe(200);
    const d = await lateRun(g, "2025-12", "2025-12-31", JAN_10);
    const followUps = await issueLate(d.publicId);
    const reprint = await printPacket(env, g.id);
    expect(reprint.statusCode, reprint.body).toBe(200);
    const afterPrint = await listView(g);
    const mark = await markPaper(env, g.id);
    const afterMark = await listView(g);
    const [h1, h2] = await Promise.all([hashOf(g.id, Y, B_NOV), hashOf(g.id, Y, B_DEC)]);
    expect({
      engineVsOracle: await entriesDiff(d.publicId),
      followUps,
      reprintMarked: await markedPages(reprint.rawPayload),
      reprintFigures: await pageShowsAll(reprint.rawPayload, 0, boxStrings(B_DEC)),
      afterPrint,
      mark: [200, 204].includes(mark.statusCode),
      afterMark,
      rows: brief(await furnishings(env.t, g.id)),
    }).toEqual({
      engineVsOracle: NO_DIFF,
      followUps: ["w2_paper_correction_needed"],
      reprintMarked: [0, 2, 4],
      reprintFigures: true,
      afterPrint: { corrected: true, correctionToFurnish: true, furnished: "printed" },
      mark: true,
      afterMark: { corrected: true, correctionToFurnish: false, furnished: "paper" },
      rows: [
        { method: "admin_print", hash: h1, corrected: false },
        { method: "admin_print", hash: h2, corrected: true },
        { method: "paper_handed", hash: h2, corrected: true },
      ],
    });
    // UX item 2: the courtesy mail states no payroll cause.
    const courtesy = await mails(g.userId, "w2_changed");
    expect({
      n: courtesy.length,
      cause: courtesy.some((m) => /processed a payroll|because of a payroll/.test(m.bodyHtml)),
      lead: courtesy.every((m) => m.bodyHtml.includes(`has corrected your ${Y} Form W-2.`)),
    }).toEqual({ n: 1, cause: false, lead: true });
  });

  it("consented: an employee_download of the NEW figures does not suppress the notice — reconcile still sends w2_changed and records portal_notice", async () => {
    await withCapRestored(async () => {
      const { reconcileW2Furnishings } = await furnishModule();
      const k = await makeW2Emp(env, { grossCents: 1_600_000, login: true, consent: true });
      await seedHistory2025(env, k, HIGH);
      expect((await myPdf(env, k)).statusCode).toBe(200);
      await setSsCap("180000.00");
      const second = await myPdf(env, k);
      expect(second.statusCode, second.body).toBe(200);
      const beforeReconcile = await listView(k);
      await reconcileW2Furnishings(deps(), { today: "2026-01-20" });
      const changed = await mails(k.userId, "w2_changed");
      const [h1, h2] = await Promise.all([hashOf(k.id, Y, B_HIGH), hashOf(k.id, Y, B_HIGH_180)]);
      expect({
        secondMarked: await markedPages(second.rawPayload),
        secondFigures: await pageShowsAll(second.rawPayload, 0, boxStrings(B_HIGH_180)),
        beforeReconcile,
        mails: changed.map((m) => m.subject),
        rows: brief(await furnishings(env.t, k.id)),
        afterReconcile: await listView(k),
      }).toEqual({
        secondMarked: [0, 2, 4],
        secondFigures: true,
        beforeReconcile: { corrected: true, correctionToFurnish: true, furnished: "online" },
        mails: [`${W2_PHRASE}: Your corrected ${Y} W-2 from ${await co()}`],
        rows: [
          { method: "employee_download", hash: h1, corrected: false },
          { method: "employee_download", hash: h2, corrected: true },
          { method: "portal_notice", hash: h2, corrected: true },
        ],
        afterReconcile: { corrected: true, correctionToFurnish: false, furnished: "online" },
      });
      // UX item 2: the consented lead states no payroll cause.
      expect({
        cause: changed.some((m) => /payroll processed|because of a payroll/.test(m.bodyHtml)),
        lead: changed.every((m) => m.bodyHtml.includes(`has corrected your ${Y} Form W-2.`)),
      }).toEqual({ cause: false, lead: true });
    });
  });
});

// ---------------------------------------------------------------- D2 / D3

describe("D2 figures that come back to an earlier hash are furnished again", () => {
  it("consented: notice H1 -> H2 (notice) -> back to H1: a second portal_notice for H1 and a second w2_changed mail; a further reconcile adds nothing", async () => {
    await withCapRestored(async () => {
      const { reconcileW2Furnishings } = await furnishModule();
      const k = await makeW2Emp(env, { grossCents: 1_600_000, login: true, consent: true });
      await seedHistory2025(env, k, HIGH);
      const notice = await sendW2AvailableNotices(deps(), { today: "2026-01-05" });
      await setSsCap("180000.00");
      await reconcileW2Furnishings(deps(), { today: "2026-01-20" });
      const afterH2 = (await mails(k.userId, "w2_changed")).length;
      await setSsCap("176100.00");
      await reconcileW2Furnishings(deps(), { today: "2026-01-21" });
      const afterBack = (await mails(k.userId, "w2_changed")).length;
      await reconcileW2Furnishings(deps(), { today: "2026-01-22" });
      const [h1, h2] = await Promise.all([hashOf(k.id, Y, B_HIGH), hashOf(k.id, Y, B_HIGH_180)]);
      const rows = await furnishings(env.t, k.id);
      expect({
        notice: notice.sent,
        afterH2,
        afterBack,
        final: (await mails(k.userId, "w2_changed")).length,
        rows: brief(rows),
        idsAscending: rows.every((r, i) => i === 0 || r.id > rows[i - 1]!.id),
        list: await listView(k),
        myList: (await myList(env, k)).json(),
      }).toEqual({
        notice: 1,
        afterH2: 1,
        afterBack: 2,
        final: 2,
        rows: [
          { method: "portal_notice", hash: h1, corrected: false },
          { method: "portal_notice", hash: h2, corrected: true },
          { method: "portal_notice", hash: h1, corrected: true },
        ],
        idsAscending: true,
        list: { corrected: true, correctionToFurnish: false, furnished: "online" },
        myList: { w2s: [{ year: Y, availableOn: "2026-01-01", ready: true, corrected: true }] },
      });
    });
  });

  it("paper (no login): handed H1 -> H2 handed -> back to H1: the to-do returns; reprint + mark writes new rows and clears it", async () => {
    await withCapRestored(async () => {
      const { reconcileW2Furnishings } = await furnishModule();
      const p = await makeW2Emp(env, { grossCents: 1_600_000, login: false });
      await seedHistory2025(env, p, HIGH);
      expect((await printPacket(env, p.id)).statusCode).toBe(200);
      expect([200, 204]).toContain((await markPaper(env, p.id)).statusCode);
      await setSsCap("180000.00");
      await reconcileW2Furnishings(deps(), { today: "2026-01-20" });
      const atH2 = await listView(p);
      expect((await printPacket(env, p.id)).statusCode).toBe(200);
      expect([200, 204]).toContain((await markPaper(env, p.id)).statusCode);
      const handedH2 = await listView(p);
      await setSsCap("176100.00");
      await reconcileW2Furnishings(deps(), { today: "2026-01-21" });
      const back = await listView(p);
      const reprint = await printPacket(env, p.id);
      expect(reprint.statusCode).toBe(200);
      const m3 = await markPaper(env, p.id);
      const [h1, h2] = await Promise.all([hashOf(p.id, Y, B_HIGH), hashOf(p.id, Y, B_HIGH_180)]);
      const audit = await env.t.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "w2_furnishing.paper_handed"),
            eq(auditEvents.entityId, String(p.id)),
          ),
        );
      expect({
        atH2,
        handedH2,
        back,
        reprintMarked: await markedPages(reprint.rawPayload),
        reprintFigures: await pageShowsAll(reprint.rawPayload, 0, boxStrings(B_HIGH)),
        m3: [200, 204].includes(m3.statusCode),
        final: await listView(p),
        rows: brief(await furnishings(env.t, p.id)),
        audit: audit.map((a) => a.after),
      }).toEqual({
        atH2: { corrected: true, correctionToFurnish: true, furnished: "paper" },
        handedH2: { corrected: true, correctionToFurnish: false, furnished: "paper" },
        back: { corrected: true, correctionToFurnish: true, furnished: "paper" },
        reprintMarked: [0, 2, 4],
        reprintFigures: true,
        m3: true,
        final: { corrected: true, correctionToFurnish: false, furnished: "paper" },
        rows: [
          { method: "admin_print", hash: h1, corrected: false },
          { method: "paper_handed", hash: h1, corrected: false },
          { method: "admin_print", hash: h2, corrected: true },
          { method: "paper_handed", hash: h2, corrected: true },
          { method: "admin_print", hash: h1, corrected: true },
          { method: "paper_handed", hash: h1, corrected: true },
        ],
        audit: [
          { taxYear: Y, corrected: false },
          { taxYear: Y, corrected: true },
          { taxYear: Y, corrected: true },
        ],
      });
    });
  });
});

describe("D3 latest = highest id (furnished_at never orders)", () => {
  it("paper rows: id 1 old figures furnished later, id 2 current figures furnished earlier -> nothing to furnish; furnishedOn is row 2's date", async () => {
    const p = await makeW2Emp(env, { grossCents: G, login: false });
    await seedHistory2025(env, p, JAN_DEC);
    const [h1, h2] = await Promise.all([hashOf(p.id, Y, B_NOV), hashOf(p.id, Y, B_DEC)]);
    await rawFurnishing(env.t, {
      employeeId: p.id,
      hash: h1,
      method: "paper_handed",
      corrected: false,
      furnishedAt: "2026-02-10T12:00:00Z",
    });
    await rawFurnishing(env.t, {
      employeeId: p.id,
      hash: h2,
      method: "paper_handed",
      corrected: true,
      furnishedAt: "2026-01-10T12:00:00Z",
    });
    const r = await adminRow(env, p.id);
    expect({
      corrected: r.corrected,
      correctionToFurnish: r.correctionToFurnish,
      furnished: r.furnished,
      furnishedOn: r.furnishedOn,
    }).toEqual({
      corrected: true,
      correctionToFurnish: false,
      furnished: "paper",
      furnishedOn: "2026-01-10",
    });
  });
});

// ---------------------------------------------------------------- D4

describe("D4 late issue after deploy, before the first tick, in a year the previous release notified", () => {
  it("consented: no rows and no backfill flag; the late December issue backfills the pre-issue figures and sends the correction", async () => {
    const e = await makeW2Emp(env, { grossCents: G, login: true, consent: true });
    await seedHistory2025(env, e, JAN_NOV);
    await setNotifiedYears(env.t, [Y]);
    const flagBefore = await env.t.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, "w2_furnishings_backfilled"));
    const d = await lateRun(e, "2025-12", "2025-12-31", JAN_10);
    const followUps = await issueLate(d.publicId);
    const [h1, h2] = await Promise.all([hashOf(e.id, Y, B_NOV), hashOf(e.id, Y, B_DEC)]);
    expect({
      flagBefore: flagBefore.length,
      engineVsOracle: await entriesDiff(d.publicId),
      followUps: followUps.filter((c) => c.startsWith("w2_")),
      rows: brief(await furnishings(env.t, e.id)),
      mails: (await mails(e.userId, "w2_changed")).map((m) => m.subject),
    }).toEqual({
      flagBefore: 0,
      engineVsOracle: NO_DIFF,
      followUps: ["w2_changed_notice_sent"],
      rows: [
        { method: "backfill", hash: h1, corrected: false },
        { method: "portal_notice", hash: h2, corrected: true },
      ],
      mails: [`${W2_PHRASE}: Your corrected ${Y} W-2 from ${await co()}`],
    });
  });

  it("the boot path (src/index.ts or src/app.ts) calls backfillW2Furnishings", () => {
    const read = (f: string) => readFileSync(resolve(ROOT, "apps/server/src", f), "utf8");
    expect(["index.ts", "app.ts"].some((f) => read(f).includes("backfillW2Furnishings("))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------- D5

describe("D5 one failing employee-year never stops the others", () => {
  it("reconcile: A's w2_changed insert fails; reconcile resolves and B (later id) still gets its correction; the daily annualTick still sends the year notice", async () => {
    await withCapRestored(async () => {
      const { reconcileW2Furnishings } = await furnishModule();
      const a = await makeW2Emp(env, { grossCents: 1_600_000, login: true, consent: true });
      await seedHistory2025(env, a, HIGH);
      const b = await makeW2Emp(env, { grossCents: 1_600_000, login: true, consent: true });
      await seedHistory2025(env, b, HIGH);
      const c = await makeW2Emp(env, { grossCents: G, login: true, consent: true });
      await seedHistory2025(env, c, JAN_DEC);
      expect((await myPdf(env, a)).statusCode).toBe(200);
      expect((await myPdf(env, b)).statusCode).toBe(200);
      await setSsCap("180000.00");
      await env.t.pglite.exec(`
        CREATE OR REPLACE FUNCTION pay206_fail_mail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'pay206 injected mail failure'; END $$;
        CREATE TRIGGER pay206_fail_mail BEFORE INSERT ON email_outbox FOR EACH ROW
          WHEN (NEW.user_id = '${a.userId}' AND NEW.event_type = 'w2_changed')
          EXECUTE FUNCTION pay206_fail_mail();`);
      const logged: string[] = [];
      const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
          logged.push(
            args.map((x) => (typeof x === "string" ? x : inspect(x, { depth: 6 }))).join(" "),
          );
        }),
      );
      try {
        const rec = await reconcileW2Furnishings(deps(), { today: "2026-01-20" }).then(
          () => "resolved",
          (err: unknown) => `rejected: ${err instanceof Error ? err.message : String(err)}`,
        );
        const hB = await hashOf(b.id, Y, B_HIGH_180);
        const reconcileView = {
          rec,
          a: {
            mails: (await mails(a.userId, "w2_changed")).length,
            notices: (await furnishings(env.t, a.id)).filter((r) => r.method === "portal_notice")
              .length,
          },
          b: {
            mails: (await mails(b.userId, "w2_changed")).length,
            notice: brief(await furnishings(env.t, b.id)).some(
              (r) => r.method === "portal_notice" && r.hash === hB,
            ),
          },
        };
        expect(reconcileView).toEqual({
          rec: "resolved",
          a: { mails: 0, notices: 0 },
          b: { mails: 1, notice: true },
        });

        const sched = (await import("../src/payroll/scheduler.js")) as unknown as {
          annualTick?: (d: ReturnType<typeof deps>) => Promise<unknown>;
        };
        expect(typeof sched.annualTick).toBe("function");
        const tick = await sched.annualTick!(deps()).then(
          () => "resolved",
          (err: unknown) => `rejected: ${err instanceof Error ? err.message : String(err)}`,
        );
        const notified = await env.t.db
          .select({ value: appSettings.value })
          .from(appSettings)
          .where(eq(appSettings.key, "w2_available_notified_years"));
        expect({
          tick,
          cAvailable: (await mails(c.userId, "w2_available")).length,
          aAvailable: (await mails(a.userId, "w2_available")).length,
          notified: (notified[0]?.value as number[] | undefined)?.includes(Y) ?? false,
        }).toEqual({ tick: "resolved", cAvailable: 1, aAvailable: 1, notified: true });
        const hashes = (
          await env.t.pglite.query<{ boxes_hash: string }>("SELECT boxes_hash FROM w2_furnishings")
        ).rows.map((r) => r.boxes_hash);
        const text = logged.join("\n");
        expect({
          hashes: hashes.length > 0,
          hashInLog: hashes.some((h) => text.includes(h)),
          anyHex64: /[0-9a-f]{64}/.test(text),
          queryText: /Failed query|params:|insert into/i.test(text),
          message: text.includes("pay206 injected"),
        }).toEqual({
          hashes: true,
          hashInLog: false,
          anyHex64: false,
          queryText: false,
          message: false,
        });
      } finally {
        for (const s of spies) s.mockRestore();
        await dropTrigger("pay206_fail_mail", "email_outbox");
      }
    });
  });

  it("backfill: A's backfill insert fails; backfill resolves and B still gets its backfill row", async () => {
    const { backfillW2Furnishings } = await furnishModule();
    const a = await makeW2Emp(env, { grossCents: G, login: false });
    await seedHistory2025(env, a, JAN_DEC);
    const b = await makeW2Emp(env, { grossCents: G, login: false });
    await seedHistory2025(env, b, JAN_DEC);
    await setNotifiedYears(env.t, [Y]);
    await env.t.pglite.exec(`
      CREATE OR REPLACE FUNCTION pay206_fail_backfill() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'pay206 injected backfill failure'; END $$;
      CREATE TRIGGER pay206_fail_backfill BEFORE INSERT ON w2_furnishings FOR EACH ROW
        WHEN (NEW.employee_id = ${a.id}) EXECUTE FUNCTION pay206_fail_backfill();`);
    try {
      const out = await backfillW2Furnishings(deps(), { today: "2026-03-01" }).then(
        () => "resolved",
        (err: unknown) => `rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
      expect({
        out,
        a: (await furnishings(env.t, a.id)).length,
        b: brief(await furnishings(env.t, b.id)),
      }).toEqual({
        out: "resolved",
        a: 0,
        b: [{ method: "backfill", hash: await hashOf(b.id, Y, B_DEC), corrected: false }],
      });
    } finally {
      await dropTrigger("pay206_fail_backfill", "w2_furnishings");
    }
  });
});

// ---------------------------------------------------------------- D6

describe("D6 year notice rerun after a partial failure", () => {
  it("A notified, B fails; the rerun mails B once and does not mail A again (A already holds a portal_notice for the current figures)", async () => {
    const a = await makeW2Emp(env, { grossCents: G, login: true, consent: true });
    await seedHistory2025(env, a, JAN_DEC);
    const b = await makeW2Emp(env, { grossCents: G, login: true, consent: true });
    await seedHistory2025(env, b, JAN_DEC);
    await env.t.pglite.exec(`
      CREATE OR REPLACE FUNCTION pay206_fail_notice() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'pay206 injected notice failure'; END $$;
      CREATE TRIGGER pay206_fail_notice BEFORE INSERT ON w2_furnishings FOR EACH ROW
        WHEN (NEW.employee_id = ${b.id}) EXECUTE FUNCTION pay206_fail_notice();`);
    try {
      await sendW2AvailableNotices(deps(), { today: "2026-01-05" }).catch(() => undefined);
    } finally {
      await dropTrigger("pay206_fail_notice", "w2_furnishings");
    }
    const firstA = (await mails(a.userId, "w2_available")).length;
    await sendW2AvailableNotices(deps(), { today: "2026-01-06" });
    const pn = async (e: W2Emp) =>
      (await furnishings(env.t, e.id)).filter((r) => r.method === "portal_notice").length;
    expect({
      firstA,
      a: { mails: (await mails(a.userId, "w2_available")).length, notices: await pn(a) },
      b: { mails: (await mails(b.userId, "w2_available")).length, notices: await pn(b) },
    }).toEqual({ firstA: 1, a: { mails: 1, notices: 1 }, b: { mails: 1, notices: 1 } });
  });
});

// ---------------------------------------------------------------- D7

describe("D7 backfill rows display as unknown, count for corrected, never for delivery", () => {
  it("backfilled -> furnished 'unknown', nothing to furnish; figures change -> corrected and a paper correction is due", async () => {
    await withCapRestored(async () => {
      const { backfillW2Furnishings } = await furnishModule();
      const l = await makeW2Emp(env, { grossCents: 1_600_000, login: false });
      await seedHistory2025(env, l, HIGH);
      await setNotifiedYears(env.t, [Y]);
      await backfillW2Furnishings(deps(), { today: "2026-03-01" });
      const before = await listView(l);
      await setSsCap("180000.00");
      const after = await listView(l);
      expect({ before, after }).toEqual({
        before: { corrected: false, correctionToFurnish: false, furnished: "unknown" },
        after: { corrected: true, correctionToFurnish: true, furnished: "unknown" },
      });
    });
  });
});

// ---------------------------------------------------------------- D8

describe("D8 furnished-on-paper needs the year's bundled W-2 form", () => {
  it("2024 (figures readable, no bundled fw2) -> 409 form_not_available, nothing written", async () => {
    // Synthetic 2024 federal config (SSA 2024 wage base 168,600; 2024 std deduction 14,600).
    await env.t.db
      .insert(taxConfig)
      .values({
        jurisdiction: "federal",
        taxYear: 2024,
        standardDeduction: "14600.00",
        socialSecurityRate: "0.06200",
        socialSecurityWageCap: "168600.00",
        medicareRate: "0.01450",
        medicareAdditionalRate: "0.00900",
        medicareAdditionalThreshold: "200000.00",
        stateWithholdingRate: "0",
        employerSocialSecurityRate: "0.06200",
        employerMedicareRate: "0.01450",
        futaRate: "0.00600",
        futaWageCap: "7000.00",
        sutaCreditRate: "0.05400",
      })
      .onConflictDoNothing();
    const z = await makeW2Emp(env, { grossCents: G, login: false });
    // One 6,000.00 run: SS 372.00 (6.2%), Medicare 87.00 (1.45%) — a clean W-2.
    await history(env.t, z, "2024-06", "2024-06-25", oracleRun2025(G), null);
    const listed = await env.t.app.inject({
      method: "GET",
      url: "/api/admin/annual-forms/w2?year=2024",
      headers: env.admin,
    });
    const res = await markPaper(env, z.id, 2024);
    expect({
      listed: listed.statusCode,
      status: res.statusCode,
      error: (safeJson(res) as { error?: string }).error,
      rows: (await furnishings(env.t, z.id, 2024)).length,
      audit: (
        await env.t.db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, "w2_furnishing.paper_handed"))
      ).length,
    }).toEqual({ listed: 200, status: 409, error: "form_not_available", rows: 0, audit: 0 });
  });
});

// ---------------------------------------------------------------- D9

describe("D9 after consent is withdrawn", () => {
  it("downloaded, then withdrew: the PDF still serves on 2026-10-15 (Thursday) and is refused on 2026-10-16", async () => {
    const a = await makeW2Emp(env, { grossCents: G, login: true, consent: true });
    await seedHistory2025(env, a, JAN_DEC);
    expect((await myPdf(env, a)).statusCode).toBe(200);
    await withdrawConsent(env, a);
    env.setNow("2026-10-15T12:00:00Z");
    const oct15 = await myPdf(env, a);
    env.setNow("2026-10-16T12:00:00Z");
    const oct16 = await myPdf(env, a);
    expect({
      oct15: oct15.statusCode,
      oct15Pdf: oct15.rawPayload.subarray(0, 5).toString("latin1"),
      oct15Figures:
        oct15.statusCode === 200 && (await pageShowsAll(oct15.rawPayload, 0, boxStrings(B_DEC))),
      oct16: oct16.statusCode,
      oct16Error: (safeJson(oct16) as { error?: string }).error,
    }).toEqual({
      oct15: 200,
      oct15Pdf: "%PDF-",
      oct15Figures: true,
      oct16: 409,
      oct16Error: "consent_required",
    });
  });

  it("notified (portal_notice only), then withdrew: the PDF still serves on 2026-10-15", async () => {
    const a = await makeW2Emp(env, { grossCents: G, login: true, consent: true });
    await seedHistory2025(env, a, JAN_DEC);
    await sendW2AvailableNotices(deps(), { today: "2026-01-05" });
    expect((await furnishings(env.t, a.id)).map((r) => r.method)).toEqual(["portal_notice"]);
    await withdrawConsent(env, a);
    env.setNow("2026-10-15T12:00:00Z");
    expect((await myPdf(env, a)).statusCode).toBe(200);
  });

  it("only backfilled or only admin-printed, then withdrew: refused (409 consent_required) inside the window", async () => {
    const { backfillW2Furnishings } = await furnishModule();
    const bf = await makeW2Emp(env, { grossCents: G, login: true, consent: true });
    await seedHistory2025(env, bf, JAN_DEC);
    const ap = await makeW2Emp(env, { grossCents: G, login: true, consent: true });
    await seedHistory2025(env, ap, JAN_DEC);
    await setNotifiedYears(env.t, [Y]);
    await backfillW2Furnishings(deps(), { today: "2026-03-01" });
    // ap already holds a backfill row too; the print adds admin_print.
    expect((await printPacket(env, ap.id)).statusCode).toBe(200);
    await withdrawConsent(env, bf);
    await withdrawConsent(env, ap);
    env.setNow("2026-03-02T12:00:00Z");
    const rBf = await myPdf(env, bf);
    const rAp = await myPdf(env, ap);
    expect({
      bfRows: (await furnishings(env.t, bf.id)).map((r) => r.method),
      apRows: (await furnishings(env.t, ap.id)).map((r) => r.method),
      bf: [rBf.statusCode, (safeJson(rBf) as { error?: string }).error],
      ap: [rAp.statusCode, (safeJson(rAp) as { error?: string }).error],
    }).toEqual({
      bfRows: ["backfill"],
      apRows: ["backfill", "admin_print"],
      bf: [409, "consent_required"],
      ap: [409, "consent_required"],
    });
  });

  it("correction after withdrawal: paper path (to-do + courtesy mail) and the CORRECTED copy stays downloadable; the download does not clear the to-do", async () => {
    const e = await makeW2Emp(env, { grossCents: G, login: true, consent: true });
    await seedHistory2025(env, e, JAN_NOV);
    expect((await myPdf(env, e)).statusCode).toBe(200);
    await withdrawConsent(env, e);
    const d = await lateRun(e, "2025-12", "2025-12-31", JAN_10);
    const followUps = await issueLate(d.publicId);
    const before = await listView(e);
    const pdf = await myPdf(env, e);
    const [h1, h2] = await Promise.all([hashOf(e.id, Y, B_NOV), hashOf(e.id, Y, B_DEC)]);
    const courtesy = await mails(e.userId, "w2_changed");
    expect({
      engineVsOracle: await entriesDiff(d.publicId),
      followUps: followUps.filter((c) => c.startsWith("w2_")),
      courtesy: courtesy.map((m) => m.subject),
      before,
      pdf: pdf.statusCode,
      marked: pdf.statusCode === 200 ? await markedPages(pdf.rawPayload) : null,
      figures: pdf.statusCode === 200 && (await pageShowsAll(pdf.rawPayload, 4, boxStrings(B_DEC))),
      after: await listView(e),
      rows: brief(await furnishings(env.t, e.id)),
    }).toEqual({
      engineVsOracle: NO_DIFF,
      followUps: ["w2_paper_correction_needed"],
      courtesy: [`${await co()} — Your ${Y} W-2 is being corrected`],
      before: { corrected: true, correctionToFurnish: true, furnished: "online" },
      pdf: 200,
      marked: [0, 2, 4],
      figures: true,
      after: { corrected: true, correctionToFurnish: true, furnished: "online" },
      rows: [
        { method: "employee_download", hash: h1, corrected: false },
        { method: "employee_download", hash: h2, corrected: true },
      ],
    });
  });
});

// ---------------------------------------------------------------- D10

describe("D10 PDF routes: Sec-Fetch-Site and rate limit", () => {
  for (const site of ["cross-site", "same-site"]) {
    it(`Sec-Fetch-Site: ${site} -> 403 { error: "cross_site" } on both PDF routes, no PDF, nothing recorded`, async () => {
      const a = await makeW2Emp(env, { grossCents: G, login: true, consent: true });
      await seedHistory2025(env, a, JAN_DEC);
      const h = { "sec-fetch-site": site };
      const mine = await myPdf(env, a, Y, { headers: h });
      const packet = await printPacket(env, a.id, Y, { headers: h });
      expect({
        mine: [mine.statusCode, safeJson(mine)],
        packet: [packet.statusCode, safeJson(packet)],
        rows: (await furnishings(env.t, a.id)).length,
      }).toEqual({
        mine: [403, { error: "cross_site" }],
        packet: [403, { error: "cross_site" }],
        rows: 0,
      });
    });
  }

  it("Sec-Fetch-Site: same-origin, none (user opened the link: typed, bookmark, new tab) and no header -> 200 PDF on both routes", async () => {
    const a = await makeW2Emp(env, { grossCents: G, login: true, consent: true });
    await seedHistory2025(env, a, JAN_DEC);
    const so = { "sec-fetch-site": "same-origin" };
    const none = { "sec-fetch-site": "none" };
    const statuses = [
      (await myPdf(env, a, Y, { headers: so })).statusCode,
      (await myPdf(env, a, Y, { headers: none })).statusCode,
      (await myPdf(env, a)).statusCode,
      (await printPacket(env, a.id, Y, { headers: so })).statusCode,
      (await printPacket(env, a.id, Y, { headers: none })).statusCode,
      (await printPacket(env, a.id)).statusCode,
    ];
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
  });

  it("20 requests per minute pass the limiter; the 21st -> 429 (employee PDF and admin print-packet)", async () => {
    // Fresh users and fixed addresses: the limit trips the same way keyed by IP or by user.
    const e = await makeW2Emp(env, { grossCents: G, login: true, consent: false });
    const admin = await freshAdmin(env);
    const mine: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      // No consent: each request is refused cheaply (409) after the limiter.
      mine.push((await myPdf(env, e, Y, { ip: "10.209.0.1" })).statusCode);
    }
    const packet: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      // Unknown employee: 404 after the limiter.
      packet.push((await printPacket(env, 987_654, Y, { ip: "10.209.0.2", admin })).statusCode);
    }
    expect({
      mineFirst20: mine.slice(0, 20).filter((s) => s === 429).length,
      mine21: mine[20],
      packetFirst20: packet.slice(0, 20).filter((s) => s === 429).length,
      packet21: packet[20],
    }).toEqual({ mineFirst20: 0, mine21: 429, packetFirst20: 0, packet21: 429 });
  });
});

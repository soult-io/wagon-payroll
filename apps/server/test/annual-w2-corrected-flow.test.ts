/**
 * PAY-206 corrections flow (payroll-calc-auditor, fail-first; the coder may
 * not edit this file): T10, T11, T12, T13, T15, T16, T19. Tax year 2025:
 * a 2025-12-31 (or 2025-11-28) run issued late on 2026-01-10 through the
 * PAY-193 L4 path changes a W-2 the employee may already hold.
 *
 * Rulings: 2026 iw2w3 p.28 (CORRECTED on the new Copies B, C, 2; Copy D and
 * the SSA copy unmarked); 26 CFR 31.6051-1(j)(5)(iii) (consented employee:
 * post the corrected W-2 and notify).
 *
 * Interfaces required (spec R6, R9):
 *  - furnishCorrectionIfNeeded replaces the notifiedYears gate in the L4
 *    follow-up: not furnished -> no follow-up; furnished + consent + login
 *    -> w2_changed (consented) mail + portal_notice row (current hash,
 *    corrected true) + "w2_changed_notice_sent"; otherwise
 *    "w2_paper_correction_needed" and, with a login, one courtesy mail per
 *    hash whose body ends with the marker
 *    `<!-- w2-changed:{year}:{employeeId}:{n} -->`, n = count of distinct
 *    furnished hashes.
 *  - src/filings/w2-furnish.ts exports
 *      reconcileW2Furnishings({ db, config }, { today? }) and
 *      backfillW2Furnishings({ db, config }, { today? });
 *    the scheduler's daily tick calls both after syncAnnualFilings.
 *    Reconcile: every unfiled, available year; idempotent. Backfill: once
 *    (app_settings key w2_furnishings_backfilled), notified and unfiled
 *    years only, one backfill row per non-blocked W-2 employee without any
 *    row for the year.
 *
 * Expected figures: the auditor's 2025 oracle (harness), never the engine.
 * The late runs are engine-generated; their entries are diffed to the cent
 * against the oracle before anything else is asserted.
 * Every test resets and creates its own employees; any order passes.
 * Synthetic data only.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { appSettings, auditEvents, company, emailOutbox, taxConfig } from "@payroll/db";
import { sendW2AvailableNotices } from "../src/filings/annual.js";
import { entriesOf } from "./pay-date-helpers.js";
import {
  approve,
  audits,
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
  copyD,
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
  pageShowsAll,
  printPacket,
  putFiledW2W3,
  resetW2,
  seedHistory2025,
  setNotifiedYears,
  type W2Emp,
  Y,
} from "./annual-w2-corrected-harness.js";

let env: L4Env;

beforeAll(async () => {
  env = await bootL4({ adminEmail: "pay-206-flow-admin@test.dev" });
}, 180_000);

afterAll(async () => {
  await env.t.close();
});

beforeEach(async () => {
  await resetW2(env.t);
});

const deps = () => ({ db: env.t.db, config: env.t.config });

// ---------------------------------------------------------------- oracle

const G = 600_000;
const JAN_OCT = oracleMonths2025(G, 10);
const JAN_NOV = oracleMonths2025(G, 11);
const JAN_DEC = oracleMonths2025(G, 12);
const B_OCT = oracleBoxes(JAN_OCT);
const B_NOV = oracleBoxes(JAN_NOV);
const B_DEC = oracleBoxes(JAN_DEC);
/** December (and November) run at 6,000.00: FIT 621.17, SS 372.00, Medicare 87.00, net 4,919.83. */
const LATE = JAN_DEC[11]!;

const W2_PHRASE = "IMPORTANT TAX RETURN DOCUMENT AVAILABLE";

async function co(): Promise<string> {
  return (await env.t.db.select({ n: company.legalName }).from(company).limit(1))[0]!.n;
}

async function w2Mails(userId: string | null) {
  const rows = await env.t.db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.eventType, "w2_changed"));
  return rows.filter((r) => r.userId === userId);
}

/** Engine draft for `ym` paid `payDate`, approved before its pay date; clock left at `issueAt`. */
async function lateRun(emp: W2Emp, ym: string, payDate: string, issueAt: string) {
  env.setNow(`${payDate}T08:00:00Z`);
  const d = await draft(env.t, emp, ym, payDate);
  await approve(env, d.publicId);
  env.setNow(issueAt);
  return d;
}

/** Issue the late run with the oracle's net pay; returns the follow-up codes. */
async function issueLate(publicId: string): Promise<string[]> {
  const res = await issue(env, publicId, latePayment(LATE.netCents, []));
  expect(res.status, res.raw).toBe(200);
  return (res.body.lateIssue as { followUps: string[] }).followUps;
}

/** The engine's entries for the late run, diffed to the cent against the oracle. */
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
const NO_DIFF = { gross: 0, fit: 0, ss: 0, med: 0, net: 0 };

/** A 2025 W-2 blocked by box4_over_max (10,918.21 SS: 1 cent over the 2025 maximum). */
async function blockedEmployee(): Promise<W2Emp> {
  const f = await makeW2Emp(env, { grossCents: 1_800_000, login: false, label: "Blocked" });
  await history(
    env.t,
    f,
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
  return f;
}

const JAN_10 = "2026-01-10T10:00:00Z";

describe("oracle self-check (no engine)", () => {
  it("Jan-Oct / Jan-Nov / Jan-Dec 2025 boxes at 6,000.00 per month", () => {
    expect({
      oct: boxStrings(B_OCT),
      nov: boxStrings(B_NOV),
      dec: boxStrings(B_DEC),
      late: [LATE.fitCents, LATE.ssCents, LATE.medCents, LATE.netCents],
    }).toEqual({
      oct: ["60000.00", "6211.70", "60000.00", "3720.00", "60000.00", "870.00"],
      nov: ["66000.00", "6832.87", "66000.00", "4092.00", "66000.00", "957.00"],
      dec: ["72000.00", "7454.04", "72000.00", "4464.00", "72000.00", "1044.00"],
      late: [62_117, 37_200, 8_700, 491_983],
    });
  });
});

describe("T10 the L4 miss: downloaded before the year notice", () => {
  it("consented employee downloads while another W-2 holds the notice; late December issue -> w2_changed_notice_sent, consented mail, portal_notice (corrected); the next download is CORRECTED with the Jan-Dec figures", async () => {
    const e = await makeW2Emp(env, { grossCents: G, login: true, consent: true });
    await seedHistory2025(env, e, JAN_NOV);
    await blockedEmployee();
    const first = await myPdf(env, e);
    expect(first.statusCode, first.body).toBe(200);
    expect(await markedPages(first.rawPayload)).toEqual([]);
    const held = await sendW2AvailableNotices(deps(), { today: "2026-01-05" });
    const d = await lateRun(e, "2025-12", "2025-12-31", JAN_10);
    const followUps = await issueLate(d.publicId);
    const h1 = await hashOf(e.id, Y, B_NOV);
    const h2 = await hashOf(e.id, Y, B_DEC);
    const mails = await w2Mails(e.userId);
    const afterIssue = await furnishings(env.t, e.id);
    const late = await audits(env.t, "run.issued_late", d.publicId);
    expect({
      held: held.sent,
      engineVsOracle: await entriesDiff(d.publicId),
      followUps,
      auditFollowUps: (late[0]?.after as { followUps?: string[] } | undefined)?.followUps,
      mailSubjects: mails.map((m) => m.subject),
      rows: brief(afterIssue),
    }).toEqual({
      held: 0,
      engineVsOracle: NO_DIFF,
      followUps: ["w2_changed_notice_sent"],
      auditFollowUps: ["w2_changed_notice_sent"],
      mailSubjects: [`${W2_PHRASE}: Your corrected ${Y} W-2 from ${await co()}`],
      rows: [
        { method: "employee_download", hash: h1, corrected: false },
        { method: "portal_notice", hash: h2, corrected: true },
      ],
    });

    const second = await myPdf(env, e);
    expect(second.statusCode, second.body).toBe(200);
    const bytes = second.rawPayload;
    const dec = boxStrings(B_DEC);
    const row = await adminRow(env, e.id);
    expect({
      marked: await markedPages(bytes),
      figures: await Promise.all([0, 2, 4].map((i) => pageShowsAll(bytes, i, dec))),
      rows: brief(await furnishings(env.t, e.id)).slice(2),
      myList: (await myList(env, e)).json(),
      admin: {
        corrected: row.corrected,
        correctionToFurnish: row.correctionToFurnish,
        furnished: row.furnished,
        boxes: [
          row.box1Wages,
          row.box2FederalWithheld,
          row.box3SsWages,
          row.box4SsTax,
          row.box5MedicareWages,
          row.box6MedicareTax,
        ],
      },
      copyD: await markedPages((await copyD(env, e.id)).rawPayload),
    }).toEqual({
      marked: [0, 2, 4],
      figures: [true, true, true],
      rows: [{ method: "employee_download", hash: h2, corrected: true }],
      myList: { w2s: [{ year: Y, availableOn: "2026-01-01", ready: true, corrected: true }] },
      admin: { corrected: true, correctionToFurnish: false, furnished: "online", boxes: dec },
      copyD: [],
    });
  });
});

describe("T11 never furnished -> no follow-up, no mark", () => {
  it("2025 in the notified years (old gate) but nothing furnished: late issue has no w2_ follow-up, no mail, no row; the next print is unmarked", async () => {
    const n = await makeW2Emp(env, { grossCents: G, login: true, consent: false });
    await seedHistory2025(env, n, JAN_NOV);
    await setNotifiedYears(env.t, [Y]);
    // Review round D4: the one-shot backfill already ran (flag set) and this
    // employee has no row — so nothing was furnished. Without the flag a late
    // issue backfills first (annual-w2-corrected-review D4).
    await env.t.db
      .insert(appSettings)
      .values({
        key: "w2_furnishings_backfilled",
        value: { at: "2026-01-02", inserted: 0 },
        updatedAt: new Date(),
      })
      .onConflictDoNothing({ target: [appSettings.key] });
    const d = await lateRun(n, "2025-12", "2025-12-31", JAN_10);
    const followUps = await issueLate(d.publicId);
    const rowsBefore = await furnishings(env.t, n.id);
    const print = await printPacket(env, n.id);
    expect({
      engineVsOracle: await entriesDiff(d.publicId),
      w2Codes: followUps.filter((c) => c.startsWith("w2_")),
      mails: (await w2Mails(n.userId)).length,
      rowsBefore: rowsBefore.length,
      printMarked: await markedPages(print.rawPayload),
      rowsAfterPrint: brief(await furnishings(env.t, n.id)),
    }).toEqual({
      engineVsOracle: NO_DIFF,
      w2Codes: [],
      mails: 0,
      rowsBefore: 0,
      printMarked: [],
      rowsAfterPrint: [
        { method: "admin_print", hash: await hashOf(n.id, Y, B_DEC), corrected: false },
      ],
    });
  });
});

describe("T12 paper correction: printed, changed, marked given on paper", () => {
  it("not consented, printed, late issue -> w2_paper_correction_needed + one courtesy mail with the w2-changed marker; list toFurnish; furnished-on-paper clears it (corrected stays); idempotent; reprint is CORRECTED, Copy D is not", async () => {
    const g = await makeW2Emp(env, { grossCents: G, login: true, consent: false });
    await seedHistory2025(env, g, JAN_NOV);
    expect((await printPacket(env, g.id)).statusCode).toBe(200);
    const d = await lateRun(g, "2025-12", "2025-12-31", JAN_10);
    const followUps = await issueLate(d.publicId);
    const h1 = await hashOf(g.id, Y, B_NOV);
    const h2 = await hashOf(g.id, Y, B_DEC);
    const mails = await w2Mails(g.userId);
    const before = await adminRow(env, g.id);
    expect({
      engineVsOracle: await entriesDiff(d.publicId),
      followUps,
      mails: mails.map((m) => ({
        subject: m.subject,
        marker: m.bodyHtml.includes(`<!-- w2-changed:${Y}:${g.id}:1 -->`),
        phrase: m.subject.includes(W2_PHRASE),
      })),
      list: {
        corrected: before.corrected,
        correctionToFurnish: before.correctionToFurnish,
        furnished: before.furnished,
      },
    }).toEqual({
      engineVsOracle: NO_DIFF,
      followUps: ["w2_paper_correction_needed"],
      mails: [
        {
          subject: `${await co()} — Your ${Y} W-2 is being corrected`,
          marker: true,
          phrase: false,
        },
      ],
      list: { corrected: true, correctionToFurnish: true, furnished: "printed" },
    });

    const m1 = await markPaper(env, g.id);
    const m2 = await markPaper(env, g.id);
    const after = await adminRow(env, g.id);
    const audit = await env.t.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "w2_furnishing.paper_handed"),
          eq(auditEvents.entityId, String(g.id)),
        ),
      );
    expect({
      statuses: [m1.statusCode, m2.statusCode].every((s) => s === 200 || s === 204),
      list: {
        corrected: after.corrected,
        correctionToFurnish: after.correctionToFurnish,
        furnished: after.furnished,
      },
      rows: brief(await furnishings(env.t, g.id)),
      audit: audit.map((a) => ({ entity: a.entity, actor: a.actorId, after: a.after })),
    }).toEqual({
      statuses: true,
      list: { corrected: true, correctionToFurnish: false, furnished: "paper" },
      rows: [
        { method: "admin_print", hash: h1, corrected: false },
        { method: "paper_handed", hash: h2, corrected: true },
      ],
      audit: [{ entity: "employee", actor: env.adminId, after: { taxYear: Y, corrected: true } }],
    });

    const reprint = await printPacket(env, g.id);
    const d2 = await copyD(env, g.id);
    expect({
      reprint: await markedPages(reprint.rawPayload),
      reprintFigures: await pageShowsAll(reprint.rawPayload, 0, boxStrings(B_DEC)),
      copyD: await markedPages(d2.rawPayload),
      copyDFigures: await pageShowsAll(d2.rawPayload, 0, boxStrings(B_DEC)),
      lastRow: brief(await furnishings(env.t, g.id)).at(-1),
      myList: (await myList(env, g)).json(),
      mailsAfter: (await w2Mails(g.userId)).length,
    }).toEqual({
      reprint: [0, 2, 4],
      reprintFigures: true,
      copyD: [],
      copyDFigures: true,
      lastRow: { method: "admin_print", hash: h2, corrected: true },
      myList: { w2s: [{ year: Y, availableOn: "2026-01-01", ready: true, corrected: true }] },
      mailsAfter: 1,
    });
  });

  it("no login (can never consent), printed, late issue -> w2_paper_correction_needed, no mail, list toFurnish", async () => {
    const p = await makeW2Emp(env, { grossCents: G, login: false });
    await seedHistory2025(env, p, JAN_NOV);
    expect((await printPacket(env, p.id)).statusCode).toBe(200);
    const d = await lateRun(p, "2025-12", "2025-12-31", JAN_10);
    const followUps = await issueLate(d.publicId);
    const row = await adminRow(env, p.id);
    expect({
      followUps,
      mails: (
        await env.t.db.select().from(emailOutbox).where(eq(emailOutbox.eventType, "w2_changed"))
      ).length,
      toFurnish: row.correctionToFurnish,
    }).toEqual({ followUps: ["w2_paper_correction_needed"], mails: 0, toFurnish: true });
  });
});

describe("T13 two late issues in one year", () => {
  it("H1 (Jan-Oct, downloaded) -> November late -> notice (H2) -> December late -> second notice (H3); reconcile after each sends nothing; the download is CORRECTED with Jan-Dec figures", async () => {
    const { reconcileW2Furnishings } = await furnishModule();
    const h = await makeW2Emp(env, { grossCents: G, login: true, consent: true });
    await seedHistory2025(env, h, JAN_OCT);
    expect((await myPdf(env, h)).statusCode).toBe(200);

    const nov = await lateRun(h, "2025-11", "2025-11-28", JAN_10);
    const f1 = await issueLate(nov.publicId);
    const rows1 = await furnishings(env.t, h.id);
    await reconcileW2Furnishings(deps(), { today: "2026-01-10" });
    const afterRec1 = {
      mails: (await w2Mails(h.userId)).length,
      rows: (await furnishings(env.t, h.id)).length,
    };

    const dec = await lateRun(h, "2025-12", "2025-12-31", "2026-01-12T10:00:00Z");
    const f2 = await issueLate(dec.publicId);
    await reconcileW2Furnishings(deps(), { today: "2026-01-12" });
    const rows2 = await furnishings(env.t, h.id);
    const mails = await w2Mails(h.userId);

    const [h1, h2, h3] = await Promise.all([
      hashOf(h.id, Y, B_OCT),
      hashOf(h.id, Y, B_NOV),
      hashOf(h.id, Y, B_DEC),
    ]);
    const pdf = await myPdf(env, h);
    expect({
      novVsOracle: await entriesDiff(nov.publicId),
      decVsOracle: await entriesDiff(dec.publicId),
      // November's federal deposit (due 2025-12-15) is overdue on 2026-01-10:
      // that L4 follow-up is not the subject here.
      f1: f1.filter((c) => c.startsWith("w2_")),
      f2: f2.filter((c) => c.startsWith("w2_")),
      rows1: brief(rows1),
      afterRec1,
      rows2: brief(rows2),
      mails: mails.length,
      marked: await markedPages(pdf.rawPayload),
      figures: await pageShowsAll(pdf.rawPayload, 4, boxStrings(B_DEC)),
    }).toEqual({
      novVsOracle: NO_DIFF,
      decVsOracle: NO_DIFF,
      f1: ["w2_changed_notice_sent"],
      f2: ["w2_changed_notice_sent"],
      rows1: [
        { method: "employee_download", hash: h1, corrected: false },
        { method: "portal_notice", hash: h2, corrected: true },
      ],
      afterRec1: { mails: 1, rows: 2 },
      rows2: [
        { method: "employee_download", hash: h1, corrected: false },
        { method: "portal_notice", hash: h2, corrected: true },
        { method: "portal_notice", hash: h3, corrected: true },
      ],
      mails: 2,
      marked: [0, 2, 4],
      figures: true,
    });
  });
});

// ---------------------------------------------------------------- T15 reconcile

/** 16,000.00/month Jan-Dec 2025: box1 192,000.00, box3 176,100.00 (wage base), box4 10,918.20. */
const HIGH = oracleMonths2025(1_600_000, 12);

async function setSsCap(value: string): Promise<void> {
  await env.t.db
    .update(taxConfig)
    .set({ socialSecurityWageCap: value })
    .where(and(eq(taxConfig.jurisdiction, "federal"), eq(taxConfig.taxYear, Y)));
}

describe("T15 daily reconcile catches a figure change that is not an issue", () => {
  it("furnish H1, raise the 2025 SS wage base in tax_config (box 3 176,100.00 -> 180,000.00) -> one notice + portal_notice H2; second run nothing; a filed w2_w3 year is skipped", async () => {
    const { reconcileW2Furnishings } = await furnishModule();
    const k = await makeW2Emp(env, { grossCents: 1_600_000, login: true, consent: true });
    await seedHistory2025(env, k, HIGH);
    const original = (
      await env.t.db
        .select({ cap: taxConfig.socialSecurityWageCap })
        .from(taxConfig)
        .where(and(eq(taxConfig.jurisdiction, "federal"), eq(taxConfig.taxYear, Y)))
        .limit(1)
    )[0]!.cap;
    try {
      expect(boxStrings(oracleBoxes(HIGH))).toEqual([
        "192000.00",
        "35327.04",
        "176100.00",
        "10918.20",
        "192000.00",
        "2784.00",
      ]);
      expect((await myPdf(env, k)).statusCode).toBe(200);
      await setSsCap("180000.00");
      await reconcileW2Furnishings(deps(), { today: "2026-01-20" });
      const once = {
        mails: (await w2Mails(k.userId)).length,
        rows: brief(await furnishings(env.t, k.id)),
      };
      await reconcileW2Furnishings(deps(), { today: "2026-01-21" });
      const twice = {
        mails: (await w2Mails(k.userId)).length,
        rows: (await furnishings(env.t, k.id)).length,
      };
      await putFiledW2W3(env.t, Y);
      await setSsCap("181000.00");
      await reconcileW2Furnishings(deps(), { today: "2026-02-02" });
      const filed = {
        mails: (await w2Mails(k.userId)).length,
        rows: (await furnishings(env.t, k.id)).length,
      };
      const h1 = await hashOf(k.id, Y, oracleBoxes(HIGH));
      const h2 = await hashOf(k.id, Y, oracleBoxes(HIGH, 18_000_000));
      expect({ original, once, twice, filed }).toEqual({
        original: "176100.00",
        once: {
          mails: 1,
          rows: [
            { method: "employee_download", hash: h1, corrected: false },
            { method: "portal_notice", hash: h2, corrected: true },
          ],
        },
        twice: { mails: 1, rows: 2 },
        filed: { mails: 1, rows: 2 },
      });
    } finally {
      await setSsCap(original);
    }
  });

  it("scheduler wiring: the daily tick calls backfillW2Furnishings and reconcileW2Furnishings after syncAnnualFilings", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../src/payroll/scheduler.ts"), "utf8");
    const sync = src.indexOf("syncAnnualFilings({");
    expect({
      sync: sync >= 0,
      backfillAfter: src.indexOf("backfillW2Furnishings(", sync) > sync,
      reconcileAfter: src.indexOf("reconcileW2Furnishings(", sync) > sync,
    }).toEqual({ sync: true, backfillAfter: true, reconcileAfter: true });
  });
});

// ---------------------------------------------------------------- T16 backfill

async function backfillFlag(): Promise<boolean> {
  const rows = await env.t.db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, "w2_furnishings_backfilled"));
  return rows.length === 1;
}

describe("T16 one-shot backfill of years notified by the previous release", () => {
  it("notified, unfiled 2025: one backfill row per non-blocked employee; blocked skipped; an employee with a row untouched; flag set; second run no-op; reconcile afterwards sends nothing", async () => {
    const { backfillW2Furnishings, reconcileW2Furnishings } = await furnishModule();
    const l = await makeW2Emp(env, { grossCents: G, login: false });
    await seedHistory2025(env, l, JAN_DEC);
    const m = await blockedEmployee();
    const n = await makeW2Emp(env, { grossCents: G, login: true, consent: true });
    await seedHistory2025(env, n, JAN_DEC);
    // Data written by the previous release: 2025 is a notified year (scenario b).
    await setNotifiedYears(env.t, [Y]);
    expect((await myPdf(env, n)).statusCode).toBe(200);
    const nBefore = await furnishings(env.t, n.id);
    await backfillW2Furnishings(deps(), { today: "2026-03-01" });
    const lRows = await furnishings(env.t, l.id);
    const o = await makeW2Emp(env, { grossCents: G, login: false });
    await seedHistory2025(env, o, JAN_DEC);
    await backfillW2Furnishings(deps(), { today: "2026-03-02" });
    await reconcileW2Furnishings(deps(), { today: "2026-03-02" });
    expect({
      l: lRows.map((r) => ({
        method: r.method,
        hash: r.boxes_hash,
        corrected: r.corrected,
        actor: r.actor_id,
      })),
      m: (await furnishings(env.t, m.id)).length,
      nUntouched: (await furnishings(env.t, n.id)).map((r) => r.id),
      flag: await backfillFlag(),
      oAfterSecondRun: (await furnishings(env.t, o.id)).length,
      lAfterSecondRun: (await furnishings(env.t, l.id)).length,
      mails: (
        await env.t.db.select().from(emailOutbox).where(eq(emailOutbox.eventType, "w2_changed"))
      ).length,
    }).toEqual({
      l: [
        { method: "backfill", hash: await hashOf(l.id, Y, B_DEC), corrected: false, actor: null },
      ],
      m: 0,
      nUntouched: nBefore.map((r) => r.id),
      flag: true,
      oAfterSecondRun: 0,
      lAfterSecondRun: 1,
      mails: 0,
    });
  });

  it("a notified year whose w2_w3 is filed, and a year never notified, get no backfill row; the flag is still set", async () => {
    const { backfillW2Furnishings } = await furnishModule();
    const l = await makeW2Emp(env, { grossCents: G, login: false });
    await seedHistory2025(env, l, JAN_DEC);
    await setNotifiedYears(env.t, [Y]);
    await putFiledW2W3(env.t, Y);
    await backfillW2Furnishings(deps(), { today: "2026-03-01" });
    const filedYear = (await furnishings(env.t, l.id)).length;
    await env.t.pglite.exec(
      "DELETE FROM app_settings WHERE key = 'w2_furnishings_backfilled'; TRUNCATE tax_filings RESTART IDENTITY CASCADE;",
    );
    await setNotifiedYears(env.t, []);
    await backfillW2Furnishings(deps(), { today: "2026-03-01" });
    expect({
      filedYear,
      notNotified: (await furnishings(env.t, l.id)).length,
      flag: await backfillFlag(),
    }).toEqual({ filedYear: 0, notNotified: 0, flag: true });
  });
});

// ---------------------------------------------------------------- T19 race

describe("T19 a late issue and a download at the same time", () => {
  for (const order of ["issue first", "download first"] as const) {
    it(`${order}: both succeed and the consented employee is left with nothing to furnish`, async () => {
      const r = await makeW2Emp(env, { grossCents: G, login: true, consent: true });
      await seedHistory2025(env, r, JAN_NOV);
      expect((await myPdf(env, r)).statusCode).toBe(200);
      const d = await lateRun(r, "2025-12", "2025-12-31", JAN_10);
      const go = [
        () => issue(env, d.publicId, latePayment(LATE.netCents, [])),
        () => myPdf(env, r),
      ];
      if (order === "download first") go.reverse();
      const results = await Promise.all(go.map((f) => f()));
      const statuses = results.map((x) => ("status" in x ? x.status : x.statusCode));
      const h2 = await hashOf(r.id, Y, B_DEC);
      const rows = await furnishings(env.t, r.id);
      const row = await adminRow(env, r.id);
      expect({
        statuses,
        toFurnish: row.correctionToFurnish,
        corrected: row.corrected,
        h2Furnished: rows.some((x) => x.boxes_hash === h2),
      }).toEqual({ statuses: [200, 200], toFurnish: false, corrected: true, h2Furnished: true });
    });
  }
});

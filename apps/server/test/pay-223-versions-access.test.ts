/**
 * PAY-223 PR-2 — T4 (SME N2: a posted version stays reachable after the
 * W-2/W-3 is filed, for a former employee and for a withdrawn one), T5 (the
 * (j)(6) window of every version), T6 (D-6: a version download records
 * nothing and changes no furnishing state, mail or counter) and the
 * security carry-forward (?version=n is a per-employee ordinal resolved
 * from the session — no IDOR; malformed n -> 400; one 409 body; cross-site
 * refused; rate limited). payroll-calc-auditor, fail-first against 9cb9534;
 * the coder may not edit this file. Synthetic data only. Contract:
 * pay-223-harness.ts (PR-2 section).
 *
 * Window oracle (26 CFR 31.6051-1(j)(6), the auditor's own dates, company
 * time zone America/Chicago):
 *  - TY2026, no correction: October 15, 2027 is a Friday -> 2027-10-15.
 *  - TY2026, corrected posting 2027-09-01: 2027-09-01 + 90 days =
 *    2027-11-30 (Sep 29 + Oct 31 + Nov 30 = 90) > 2027-10-15 -> 2027-11-30.
 *  - Edges probed at 23:30 local on the last day (2027-10-16T04:30Z CDT;
 *    2027-12-01T05:30Z CST) and 00:30 local the day after (2027-10-16T05:30Z;
 *    2027-12-01T06:30Z): a UTC-date slip fails one side.
 *
 * T4 fixture (wage-base crossing, hand values, integer cents): 12 monthly
 * runs of 1,600,000 gross, FIT 300,000; Social Security 6.2% to the 2026
 * SSA wage base $184,500: Jan-Nov 99,200 each (YTD wages 17,600,000), Dec
 * 6.2% x (18,450,000 - 17,600,000) = 6.2% x 850,000 = 52,700; Medicare
 * 1.45% x 1,600,000 = 23,200 (YTD 19,200,000 < the 20,000,000 Additional
 * Medicare threshold). Box 1/5 19,200,000 "192000.00"; box 2 3,600,000
 * "36000.00"; box 3 min(19,200,000, 18,450,000) = 18,450,000 "184500.00";
 * box 4 11 x 99,200 + 52,700 = 1,143,900 "11439.00" (= 6.2% of the base,
 * the maximum); box 6 278,400 "2784.00". The post-filing tax_config edit
 * sets the 2026 wage base to $185,000.00 -> box 3 = 18,500,000 "185000.00"
 * (box 4 1,143,900 <= 6.2% x 18,500,000 = 1,147,000: no box4_over_max
 * block; box4_off_rate is a warn) — a figure change no reconcile posts.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { taxConfig } from "@payroll/db";
import { oracleAccessThrough, putFiledW2W3 } from "./annual-w2-corrected-harness.js";
import {
  adminRow223,
  bodyError,
  boot223,
  CA_ID,
  caRuns,
  deleteConsent,
  deps,
  type Emp,
  emp,
  type Env,
  expFrozen,
  expPacket,
  type Frozen,
  furnRows,
  furnishModule,
  HEX64,
  type Ids,
  type IdText,
  identityOf,
  insertRawFurnishing,
  insertRunWithEntries,
  lateRun,
  markedOf,
  markedPages,
  moveTo,
  mustSignIn,
  myPdf,
  myVersions,
  myYear,
  outbox,
  pageStrings,
  relogin,
  setCaId,
  sha256,
  terminate,
  TZ,
  versionPdf,
  yearNotice,
} from "./pay-223-harness.js";
import { insertRun } from "./w2-state-harness.js";
import { type FxRun, monthly, months } from "./w2-state-oracle.js";

type E = Emp & { runs: FxRun[] };

const JAN_4 = "2027-01-04T16:00:00Z";
const NOT_AVAILABLE = { error: "w2_not_available" };

/** One view of a PDF response: the pages and marks, or the status and body. */
async function view(res: { statusCode: number; rawPayload: Buffer; body: string }) {
  return res.statusCode === 200
    ? { pages: await pageStrings(res.rawPayload), marked: await markedPages(res.rawPayload) }
    : { status: res.statusCode, body: bodyError(res) };
}

// ---------------------------------------------------------------- T4

/** The T4 high earner's runs (FxRun snapshots) and its explicit entries. */
const HIGH: { run: FxRun; entries: Record<string, number> }[] = months(2026, 1, 12).map((m, i) => ({
  run: monthly(m, null, undefined, { grossCents: 1_600_000, fitCents: 300_000 }),
  entries: {
    gross_pay: 1_600_000,
    federal_withholding: 300_000,
    social_security: i < 11 ? 99_200 : 52_700,
    medicare: 23_200,
  },
}));
const HA: Frozen = {
  box1Cents: 19_200_000,
  box2Cents: 3_600_000,
  box3Cents: 18_450_000,
  box4Cents: 1_143_900,
  box5Cents: 19_200_000,
  box6Cents: 278_400,
  formCount: 1,
  stateLines: [],
  localLines: [],
};
const HC: Frozen = { ...HA, box3Cents: 18_500_000 };

describe("T4 (SME N2): after the W-2/W-3 is filed, a tax_config edit changes box 3 and nothing is posted — the posted Original stays reachable", () => {
  let env: Env;
  const e: Record<string, E> = {};
  beforeAll(async () => {
    env = await boot223(JAN_4);
    for (const label of ["Hana", "Wren"]) {
      const x = await emp(env, label, [], { login: true, consent: true });
      for (const h of HIGH) await insertRunWithEntries(env, x.id, h.run, h.entries);
      e[label] = x;
    }
    await yearNotice(env, "2027-01-04");
    await putFiledW2W3(env.t as never, 2026);
    await moveTo(env, "2027-02-01T16:00:00Z");
    // Hana leaves (W-2-only sign-in); Wren withdraws consent and stays.
    await terminate(env, e.Hana!, "2027-01-29");
    await mustSignIn(env, e.Hana!);
    await relogin(env, e.Wren!);
    const w = await deleteConsent(env, e.Wren!);
    if (w.statusCode !== 200) throw new Error(`withdraw ${w.statusCode}`);
    await env.t.db
      .update(taxConfig)
      .set({ socialSecurityWageCap: "185000.00" })
      .where(and(eq(taxConfig.jurisdiction, "federal"), eq(taxConfig.taxYear, 2026)));
    const { reconcileW2Furnishings } = await furnishModule();
    await reconcileW2Furnishings(deps(env), { today: "2027-02-01" });
  }, 300_000);
  afterAll(async () => env.close());

  it("oracle self-check: one portal_notice each (nothing posted after filing); the admin list shows the edited box 3 (185000.00) next to the oracle boxes", async () => {
    const row = await adminRow223(env, e.Hana!.id);
    expect({
      hana: (await furnRows(env, e.Hana!.id, 2026)).map((r) => [r.method, r.corrected]),
      wren: (await furnRows(env, e.Wren!.id, 2026)).map((r) => [r.method, r.corrected]),
      boxes: [
        row.box1Wages,
        row.box2FederalWithheld,
        row.box3SsWages,
        row.box4SsTax,
        row.box5MedicareWages,
        row.box6MedicareTax,
      ],
    }).toEqual({
      hana: [["portal_notice", false]],
      wren: [["portal_notice", false]],
      boxes: ["192000.00", "36000.00", "185000.00", "11439.00", "192000.00", "2784.00"],
    });
  });

  it("former employee: the list keeps the main row downloadable: false and lists version 1 (Original, not current) downloadable", async () => {
    const item = await myYear(env, e.Hana!, 2026, { former: true });
    expect({ downloadable: item?.downloadable, versions: item?.versions }).toEqual({
      downloadable: false,
      versions: [
        {
          version: 1,
          kind: "original",
          postedOn: "2027-01-04",
          current: false,
          downloadable: true,
        },
      ],
    });
  });

  it("former employee: version 1 = the posted Original (box 3 184500.00), unmarked; the main download stays 409 w2_not_available; nothing recorded", async () => {
    const before = (await furnRows(env, e.Hana!.id)).length;
    const v1 = await versionPdf(env, e.Hana!, 2026, 1);
    const main = await myPdf(env, e.Hana!, 2026);
    expect({
      v1: await view(v1),
      main: [main.statusCode, bodyError(main)],
      rows: (await furnRows(env, e.Hana!.id)).length - before,
    }).toEqual({
      v1: { pages: expPacket(identityOf(e.Hana!.id, "Hana"), HA, {}), marked: [] },
      main: [409, NOT_AVAILABLE],
      rows: 0,
    });
  });

  it("active employee who withdrew: version 1 listed and = the Original; the main download is unchanged (D-7: the current figures, CORRECTED)", async () => {
    const versions = await myVersions(env, e.Wren!);
    const v1 = await versionPdf(env, e.Wren!, 2026, 1);
    await relogin(env, e.Wren!);
    const main = await myPdf(env, e.Wren!, 2026);
    const who = identityOf(e.Wren!.id, "Wren");
    expect({ versions, v1: await view(v1), main: await view(main) }).toEqual({
      versions: [
        {
          version: 1,
          kind: "original",
          postedOn: "2027-01-04",
          current: false,
          downloadable: true,
        },
      ],
      v1: { pages: expPacket(who, HA, {}), marked: [] },
      main: { pages: expPacket(who, HC, {}), marked: markedOf(1) },
    });
  });
});

// ---------------------------------------------------------------- T5

describe("T5 window: every version stays downloadable through the year's (j)(6) date (company-local), and is refused the day after", () => {
  let env: Env;
  const e: Record<string, E> = {};
  beforeAll(async () => {
    env = await boot223(JAN_4);
    await setCaId(env, CA_ID);
    e.q = await emp(env, "Quinn", caRuns(), { login: true, consent: true });
    e.r = await emp(env, "Rhea", caRuns(), { login: true, consent: true });
    await yearNotice(env, "2027-01-04");
    await insertRun(env as never, e.r!.id, lateRun());
    await moveTo(env, "2027-09-01T15:00:00Z");
    const { reconcileW2Furnishings } = await furnishModule();
    await reconcileW2Furnishings(deps(env), { today: "2027-09-01" });
  }, 300_000);
  afterAll(async () => env.close());

  async function at(iso: string) {
    await moveTo(env, iso);
    const out: Record<string, unknown> = {};
    for (const [k, ns] of [
      ["q", [1]],
      ["r", [1, 2]],
    ] as const) {
      const x = e[k]!;
      const versions = (await myVersions(env, x)) as { downloadable: boolean }[] | undefined;
      const status: number[] = [];
      for (const n of ns) {
        await relogin(env, x);
        status.push((await versionPdf(env, x, 2026, n)).statusCode);
      }
      out[k] = { downloadable: versions?.map((v) => v.downloadable), status };
    }
    return out;
  }

  it("oracle self-check: Quinn's window ends 2027-10-15, Rhea's 2027-11-30 (corrected posting 2027-09-01 + 90 days); the list's accessThrough agrees", async () => {
    expect({
      q: await oracleAccessThrough(env.t as never, e.q!.id, 2026, TZ),
      r: await oracleAccessThrough(env.t as never, e.r!.id, 2026, TZ),
      qList: (await myYear(env, e.q!))?.accessThrough,
      rList: (await myYear(env, e.r!))?.accessThrough,
    }).toEqual({ q: "2027-10-15", r: "2027-11-30", qList: "2027-10-15", rList: "2027-11-30" });
  });

  it("2027-10-15 23:30 CDT: Quinn's version 1 and Rhea's versions 1-2 are downloadable", async () => {
    expect(await at("2027-10-16T04:30:00Z")).toEqual({
      q: { downloadable: [true], status: [200] },
      r: { downloadable: [true, true], status: [200, 200] },
    });
  });

  it("2027-10-16 00:30 CDT: Quinn's year closed (409, listed not downloadable); Rhea's Original stays open with her correction (D-5 A: one window per year)", async () => {
    expect(await at("2027-10-16T05:30:00Z")).toEqual({
      q: { downloadable: [false], status: [409] },
      r: { downloadable: [true, true], status: [200, 200] },
    });
  });

  it("2027-11-30 23:30 CST: Rhea's versions 1-2 still downloadable", async () => {
    expect(await at("2027-12-01T05:30:00Z")).toEqual({
      q: { downloadable: [false], status: [409] },
      r: { downloadable: [true, true], status: [200, 200] },
    });
  });

  it("2027-12-01 00:30 CST: Rhea's versions refused with the one body; the version list still shows them, not downloadable", async () => {
    await moveTo(env, "2027-12-01T06:30:00Z");
    const versions = await myVersions(env, e.r!);
    await relogin(env, e.r!);
    const v1 = await versionPdf(env, e.r!, 2026, 1);
    expect({ versions, v1: [v1.statusCode, bodyError(v1)] }).toEqual({
      versions: [
        {
          version: 1,
          kind: "original",
          postedOn: "2027-01-04",
          current: false,
          downloadable: false,
        },
        {
          version: 2,
          kind: "corrected",
          postedOn: "2027-09-01",
          current: true,
          downloadable: false,
        },
      ],
      v1: [409, NOT_AVAILABLE],
    });
  });
});

describe("T5 one body: never-online year, unknown n and an unfrozen version all answer 409 { error: w2_not_available }", () => {
  let env: Env;
  const e: Record<string, E> = {};
  let bogus = "";
  beforeAll(async () => {
    env = await boot223(JAN_4);
    await setCaId(env, CA_ID);
    e.s = await emp(env, "Sage", caRuns(), { login: true, consent: true });
    await yearNotice(env, "2027-01-04");
    // A corrected posting written without a freeze (v1.29.0 / rollback window):
    // its figures are gone, so the version is listed but never offered.
    bogus = sha256("pay-223 unfrozen synthetic version");
    await insertRawFurnishing(env, {
      employeeId: e.s.id,
      taxYear: 2026,
      hash: bogus,
      method: "portal_notice",
      corrected: true,
      at: "2027-01-05T16:00:00Z",
    });
    await relogin(env, e.s);
  }, 300_000);
  afterAll(async () => env.close());

  it("the list shows the unfrozen version 2 as not downloadable", async () => {
    expect(await myVersions(env, e.s!)).toEqual([
      { version: 1, kind: "original", postedOn: "2027-01-04", current: true, downloadable: true },
      {
        version: 2,
        kind: "corrected",
        postedOn: "2027-01-05",
        current: false,
        downloadable: false,
      },
    ]);
  });

  it("version 2 (unfrozen), version 3 (unknown), version 50 (max, unknown), and 2025 version 1 (never online) -> the same 409 body; version 1 -> 200; nothing recorded", async () => {
    const before = (await furnRows(env, e.s!.id)).length;
    const out: unknown[] = [];
    for (const [year, n] of [
      [2026, 2],
      [2026, 3],
      [2026, 50],
      [2025, 1],
    ] as const) {
      const r = await versionPdf(env, e.s!, year, n);
      out.push([r.statusCode, r.body]);
    }
    const ok = await versionPdf(env, e.s!, 2026, 1);
    const one = [409, JSON.stringify(NOT_AVAILABLE)];
    expect({
      out,
      ok: ok.statusCode,
      rows: (await furnRows(env, e.s!.id)).length - before,
    }).toEqual({ out: [one, one, one, one], ok: 200, rows: 0 });
  });
});

// ---------------------------------------------------------------- T6

describe("T6 (D-6): a version download writes no w2_furnishings row and changes no furnishing state, courtesy counter or mail", () => {
  let env: Env;
  const e: Record<string, E> = {};
  beforeAll(async () => {
    env = await boot223(JAN_4);
    await setCaId(env, CA_ID);
    e.c = await emp(env, "Cora", caRuns(), { login: true, consent: true });
    e.w = await emp(env, "Wynn", caRuns(), { login: true, consent: true });
    await yearNotice(env, "2027-01-04");
    await moveTo(env, "2027-01-10T16:00:00Z");
    await relogin(env, e.w);
    const w = await deleteConsent(env, e.w);
    if (w.statusCode !== 200) throw new Error(`withdraw ${w.statusCode}`);
    for (const k of ["c", "w"]) await insertRun(env as never, e[k]!.id, lateRun());
    await moveTo(env, "2027-01-11T16:00:00Z");
    const { reconcileW2Furnishings } = await furnishModule();
    await reconcileW2Furnishings(deps(env), { today: "2027-01-11" });
  }, 300_000);
  afterAll(async () => env.close());

  async function state() {
    const out: Record<string, unknown> = {};
    for (const k of ["c", "w"]) {
      const x = e[k]!;
      const row = await adminRow223(env, x.id);
      out[k] = {
        rows: (await furnRows(env, x.id)).map((r) => [r.id, r.method, r.corrected, r.boxes_hash]),
        admin: {
          corrected: row.corrected,
          correctionToFurnish: row.correctionToFurnish,
          furnished: row.furnished,
          furnishedOn: row.furnishedOn,
        },
        mails: (await outbox(env, x.userId, "w2_changed")).length,
      };
    }
    return out;
  }

  it("oracle self-check: both got the corrected posting; the withdrawn employee is also owed paper (correctionToFurnish)", async () => {
    const s = (await state()) as Record<
      string,
      { admin: { correctionToFurnish: boolean }; mails: number }
    >;
    expect({
      c: [s.c!.admin.correctionToFurnish, s.c!.mails],
      w: [s.w!.admin.correctionToFurnish, s.w!.mails],
    }).toEqual({ c: [false, 1], w: [true, 1] });
  });

  it("downloading version 1 (the Original) and version 2 (current) twice each: 200, then rows, admin state and mails are unchanged, and the next reconcile queues nothing", async () => {
    const before = await state();
    const status: number[] = [];
    for (const k of ["c", "w"]) {
      for (const n of [1, 2, 1, 2]) {
        await relogin(env, e[k]!);
        status.push((await versionPdf(env, e[k]!, 2026, n)).statusCode);
      }
    }
    const afterDownloads = await state();
    await moveTo(env, "2027-01-12T16:00:00Z");
    const { reconcileW2Furnishings } = await furnishModule();
    await reconcileW2Furnishings(deps(env), { today: "2027-01-12" });
    const afterReconcile = await state();
    expect({ status, afterDownloads, afterReconcile }).toEqual({
      status: [200, 200, 200, 200, 200, 200, 200, 200],
      afterDownloads: before,
      afterReconcile: before,
    });
  });
});

// ---------------------------------------------------------------- security

describe("security: ?version=n is a per-employee ordinal resolved from the session (no IDOR), validated, refused cross-site, rate limited", () => {
  let env: Env;
  let ids: Ids = {};
  const e: Record<string, E> = {};
  beforeAll(async () => {
    env = await boot223(JAN_4);
    const ct = await setCaId(env, CA_ID);
    ids = { CA: { source: "entered", ct } };
    e.x1 = await emp(env, "Xena", caRuns(), { login: true, consent: true });
    // Another employee with other figures ($4,000.00 a month) and one version.
    e.x2 = await emp(
      env,
      "Yuri",
      caRuns().map((r) => ({ ...r, grossCents: 400_000 })),
      { login: true, consent: true },
    );
    await yearNotice(env, "2027-01-04");
    await insertRun(env as never, e.x1.id, lateRun());
    await moveTo(env, "2027-01-11T16:00:00Z");
    const { reconcileW2Furnishings } = await furnishModule();
    await reconcileW2Furnishings(deps(env), { today: "2027-01-11" });
    for (const v of Object.values(e)) await relogin(env, v);
  }, 300_000);
  afterAll(async () => env.close());

  it("no IDOR: Yuri's version 2 does not exist (409, the one body) although Xena has one; Yuri's version 1 is his own figures", async () => {
    const v2 = await versionPdf(env, e.x2!, 2026, 2);
    const v1 = await versionPdf(env, e.x2!, 2026, 1);
    const yuriA = expFrozen(e.x2!.runs, 2026, ids);
    expect({
      v2: [v2.statusCode, bodyError(v2)],
      v1: await view(v1),
      xena: (await myVersions(env, e.x1!)) as unknown[] | undefined,
    }).toEqual({
      v2: [409, NOT_AVAILABLE],
      v1: { pages: expPacket(identityOf(e.x2!.id, "Yuri"), yuriA, { CA: CA_ID }), marked: [] },
      xena: [
        {
          version: 1,
          kind: "original",
          postedOn: "2027-01-04",
          current: false,
          downloadable: true,
        },
        {
          version: 2,
          kind: "corrected",
          postedOn: "2027-01-11",
          current: true,
          downloadable: true,
        },
      ],
    });
    expect(money4(yuriA)).toEqual(["48000.00", "6000.00", "2976.00", "696.00"]);
  });

  it("malformed version -> 400 { error: invalid_version } (0, 51, abc, 1.5, -1, 2x, repeated); nothing recorded", async () => {
    const before = (await furnRows(env, e.x1!.id)).length;
    const out: unknown[] = [];
    for (const n of ["0", "51", "abc", "1.5", "-1", "2x"]) {
      const r = await versionPdf(env, e.x1!, 2026, n);
      out.push([n, r.statusCode, bodyError(r)]);
    }
    const rep = await versionPdf(env, e.x1!, 2026, null, { query: "?version=1&version=2" });
    out.push(["repeated", rep.statusCode, bodyError(rep)]);
    const bad = { error: "invalid_version" };
    expect({ out, rows: (await furnRows(env, e.x1!.id)).length - before }).toEqual({
      out: [
        ["0", 400, bad],
        ["51", 400, bad],
        ["abc", 400, bad],
        ["1.5", 400, bad],
        ["-1", 400, bad],
        ["2x", 400, bad],
        ["repeated", 400, bad],
      ],
      rows: 0,
    });
  });

  it("refused cross-site and same-site (403 cross_site) and without a session (401); a version route body never carries a hash", async () => {
    const cross = await versionPdf(env, e.x1!, 2026, 1, {
      headers: { "sec-fetch-site": "cross-site" },
    });
    const same = await versionPdf(env, e.x1!, 2026, 1, {
      headers: { "sec-fetch-site": "same-site" },
    });
    const anon = await env.t.app.inject({ method: "GET", url: "/api/my/w2/2026/pdf?version=1" });
    const no = await versionPdf(env, e.x1!, 2026, 9);
    expect({
      cross: [cross.statusCode, bodyError(cross)],
      same: same.statusCode,
      anon: anon.statusCode,
      no: [no.statusCode, HEX64.test(no.body)],
    }).toEqual({ cross: [403, { error: "cross_site" }], same: 403, anon: 401, no: [409, false] });
  });

  it("rate limited with the other PDF routes: 20 per minute per client, the 21st -> 429 (refusals count)", async () => {
    const addr = "10.223.250.250";
    const codes: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      codes.push((await versionPdf(env, e.x1!, 2026, 9, { ip: addr })).statusCode);
    }
    expect(codes).toEqual([...Array(20).fill(409), 429]);
  });
});

function money4(f: Frozen): string[] {
  const m = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
  return [m(f.box1Cents), m(f.box2Cents), m(f.box4Cents), m(f.box6Cents)];
}

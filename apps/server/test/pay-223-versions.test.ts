/**
 * PAY-223 PR-2 — T2 (consented, pre-filing: Original + Corrected versions,
 * each rendered from its frozen figures), its multi-state variant (scenario
 * g: three states, formCount 2) and void variant (scenario d), T10 (A -> B
 * -> A), the employee list contract and T11 (API part: no PII, amount or
 * hash in a list body). payroll-calc-auditor, fail-first against 9cb9534;
 * the coder may not edit this file. Synthetic data only. Legal source,
 * oracle and the assumed API contract: pay-223-harness.ts (PR-2 section).
 *
 * Hand values (oracle, integer cents; Pub 15 (2026) 6.2% / 1.45% per run;
 * no fixture reaches the 2026 SSA wage base $184,500):
 *  - A = caRuns: 12 x 500,000 -> box 1/3/5 6,000,000 "60000.00"; box 2
 *    600,000 "6000.00"; box 4 372,000 "3720.00"; box 6 87,000 "870.00"; CA
 *    box 16 6,000,000, box 17 12 x 1,234 = 14,808 "148.08"; formCount 1.
 *  - B = A + lateRun (gross 100,000, FIT 10,000, SS 6,200, Medicare 1,450,
 *    CA 500): "61000.00" / "6100.00" / "61000.00" / "3782.00" / "61000.00" /
 *    "884.50"; CA "61000.00" / "153.08".
 *  - Void of the 2026-12-25 run: 11 runs -> "55000.00" / "5500.00" /
 *    "55000.00" / "3410.00" / "55000.00" / "797.50"; CA "55000.00" / 11 x
 *    1,234 = 13,574 "135.74".
 *  - multiRuns A: box 1 "60000.00"; CA 2,000,000 / 4,000 (form 1 row 1, ID
 *    77665544), IL 2,000,000 / 8,000 (form 1 row 2, EIN default 000000001),
 *    NC 2,000,000 / 0 (form 2 row 1, no ID). B (+ lateRun in CA): box 1
 *    "61000.00", CA "21000.00" / "45.00"; IL and NC unchanged.
 *  - Posting dates (company time zone America/Chicago): the notice at
 *    2027-01-04 16:00Z = 2027-01-04; the reconcile at 2027-02-10 03:00Z =
 *    2027-02-09 21:00 CST -> "2027-02-09" (a UTC slip gives 02-10); the
 *    T10 re-posting at 2027-03-02 15:00Z = 2027-03-02.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bodyError,
  CA_ID,
  caRuns,
  deps,
  type Emp,
  type EmpVersion,
  emp,
  type Env,
  expFrozen,
  expHash,
  expPacket,
  furnRows,
  furnishModule,
  HEX64,
  type Ids,
  type IdText,
  identityOf,
  lateRun,
  markedOf,
  markedPages,
  moveTo,
  multiRuns,
  myW2Body,
  myVersions,
  myPdf,
  pageStrings,
  relogin,
  runIdOf,
  scrub,
  setCaId,
  SSN_FORMS,
  versionPdf,
  yearNotice,
} from "./pay-223-harness.js";
import { insertRun, voidRun } from "./w2-state-harness.js";
import type { FxRun } from "./w2-state-oracle.js";

type E = Emp & { runs: FxRun[] };

const JAN_4 = "2027-01-04T16:00:00Z";
const FEB_9_LATE = "2027-02-10T03:00:00Z"; // 2027-02-09 21:00 CST
const MAR_2 = "2027-03-02T15:00:00Z";

const IDS_TEXT: IdText = { CA: CA_ID, IL: "000000001", NC: null };

describe("T2 / T2-g / T2-d / T10: every version posted online is listed and renders its frozen figures", () => {
  let env: Env;
  let ids: Ids = {};
  const e: Record<string, E> = {};
  const late: Record<string, number> = {};
  beforeAll(async () => {
    env = await boot223Fresh();
    const ct = await setCaId(env, CA_ID);
    ids = { CA: { source: "entered", ct }, IL: { source: "ein_default" }, NC: { source: null } };
    e.a = await emp(env, "Alma", caRuns(), { login: true, consent: true });
    e.m = await emp(env, "Mona", multiRuns(), { login: true, consent: true });
    e.v = await emp(env, "Vera", caRuns(), { login: true, consent: true });
    e.t = await emp(env, "Tess", caRuns(), { login: true, consent: true });
    e.n = await emp(env, "Nell", caRuns(), { login: true, consent: true });
    await yearNotice(env, "2027-01-04");
    // Consents after the notice and never downloads: no online row.
    e.z = await emp(env, "Zora", caRuns(), { login: true, consent: true });
    // A -> B: a late run (a, m, t); a void of the December run (v).
    for (const k of ["a", "m", "t"]) {
      late[k] = (await insertRun(env as never, e[k]!.id, lateRun())).id;
    }
    await voidRun(env as never, await runIdOf(env, e.v!.id, "2026-12-25"));
    await moveTo(env, FEB_9_LATE);
    const { reconcileW2Furnishings } = await furnishModule();
    await reconcileW2Furnishings(deps(env), { today: "2027-02-09" });
    // T10: B -> A (the late run voided), posted again on 2027-03-02.
    await voidRun(env as never, late.t!);
    await moveTo(env, MAR_2);
    await reconcileW2Furnishings(deps(env), { today: "2027-03-02" });
    // Sessions expire after 7 faked days: sign every employee in again.
    for (const v of Object.values(e)) await relogin(env, v);
  }, 300_000);
  afterAll(async () => env.close());

  const A = () => expFrozen(caRuns(), 2026, ids);
  const B = () => expFrozen([...caRuns(), lateRun()], 2026, ids);
  const V = () =>
    expFrozen(
      caRuns().filter((r) => r.payDate !== "2026-12-25"),
      2026,
      ids,
    );
  const MA = () => expFrozen(multiRuns(), 2026, ids);
  const MB = () => expFrozen([...multiRuns(), lateRun()], 2026, ids);

  it("oracle self-check: the furnishing rows are the PR-1 ones (A original, B corrected; T10 A again, corrected) with the oracle hashes", async () => {
    const rows = async (k: string) =>
      (await furnRows(env, e[k]!.id, 2026)).map((r) => [r.method, r.corrected, r.boxes_hash]);
    const h = (k: string, runs: FxRun[]) => expHash(e[k]!.id, runs, 2026, ids);
    expect({
      a: await rows("a"),
      v: await rows("v"),
      t: await rows("t"),
      m: await rows("m"),
      bBoxes: [B().box1Cents, B().box2Cents, B().box4Cents, B().box6Cents],
      vBoxes: [
        V().box1Cents,
        V().box2Cents,
        V().box4Cents,
        V().box6Cents,
        V().stateLines[0]?.box17Cents,
      ],
    }).toEqual({
      a: [
        ["portal_notice", false, h("a", caRuns())],
        ["portal_notice", true, h("a", [...caRuns(), lateRun()])],
      ],
      v: [
        ["portal_notice", false, h("v", caRuns())],
        [
          "portal_notice",
          true,
          h(
            "v",
            caRuns().filter((r) => r.payDate !== "2026-12-25"),
          ),
        ],
      ],
      t: [
        ["portal_notice", false, h("t", caRuns())],
        ["portal_notice", true, h("t", [...caRuns(), lateRun()])],
        ["portal_notice", true, h("t", caRuns())],
      ],
      m: [
        ["portal_notice", false, h("m", multiRuns())],
        ["portal_notice", true, h("m", [...multiRuns(), lateRun()])],
      ],
      bBoxes: [6_100_000, 610_000, 378_200, 88_450],
      vBoxes: [5_500_000, 550_000, 341_000, 79_750, 13_574],
    });
  });

  it("T2 list: versions [1 Original posted 2027-01-04, 2 Corrected posted 2027-02-09 (company-local), current], both downloadable", async () => {
    expect(await myVersions(env, e.a!)).toEqual([
      { version: 1, kind: "original", postedOn: "2027-01-04", current: false, downloadable: true },
      { version: 2, kind: "corrected", postedOn: "2027-02-09", current: true, downloadable: true },
    ] satisfies EmpVersion[]);
  });

  it("T2 version=1: the Original as posted — boxes 1-6 and 15-17 = A to the cent, no CORRECTED mark, w2-2026-v1.pdf, no-store", async () => {
    const res = await versionPdf(env, e.a!, 2026, 1);
    expect({
      status: res.statusCode,
      type: res.headers["content-type"],
      file: /filename="w2-2026-v1\.pdf"/.test(String(res.headers["content-disposition"])),
      cache: res.headers["cache-control"],
      pages: res.statusCode === 200 ? await pageStrings(res.rawPayload) : res.body,
      marked: res.statusCode === 200 ? await markedPages(res.rawPayload) : null,
    }).toEqual({
      status: 200,
      type: "application/pdf",
      file: true,
      cache: "no-store",
      pages: expPacket(identityOf(e.a!.id, "Alma"), A(), IDS_TEXT),
      marked: [],
    });
  });

  it("T2 version=2: the Corrected copy = B to the cent, CORRECTED on Copies B, C and 2", async () => {
    const res = await versionPdf(env, e.a!, 2026, 2);
    expect({
      status: res.statusCode,
      file: /filename="w2-2026-v2\.pdf"/.test(String(res.headers["content-disposition"])),
      pages: res.statusCode === 200 ? await pageStrings(res.rawPayload) : res.body,
      marked: res.statusCode === 200 ? await markedPages(res.rawPayload) : null,
    }).toEqual({
      status: 200,
      file: true,
      pages: expPacket(identityOf(e.a!.id, "Alma"), B(), IDS_TEXT),
      marked: markedOf(1),
    });
  });

  it("T2 main download (no version) unchanged: B, marked CORRECTED", async () => {
    await relogin(env, e.a!);
    const res = await myPdf(env, e.a!, 2026);
    expect({
      status: res.statusCode,
      pages: await pageStrings(res.rawPayload),
      marked: await markedPages(res.rawPayload),
    }).toEqual({
      status: 200,
      pages: expPacket(identityOf(e.a!.id, "Alma"), B(), IDS_TEXT),
      marked: markedOf(1),
    });
  });

  it("T2-g multi-state (formCount 2): version 1 = A on both forms (CA entered ID, IL EIN default, NC no ID), unmarked; version 2 = B, marked on all six copy pages", async () => {
    const who = identityOf(e.m!.id, "Mona");
    const v1 = await versionPdf(env, e.m!, 2026, 1);
    const v2 = await versionPdf(env, e.m!, 2026, 2);
    const view = async (r: typeof v1) =>
      r.statusCode === 200
        ? { pages: await pageStrings(r.rawPayload), marked: await markedPages(r.rawPayload) }
        : { status: r.statusCode, body: r.body };
    expect({
      list: await myVersions(env, e.m!),
      v1: await view(v1),
      v2: await view(v2),
    }).toEqual({
      list: [
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
          postedOn: "2027-02-09",
          current: true,
          downloadable: true,
        },
      ],
      v1: { pages: expPacket(who, MA(), IDS_TEXT), marked: [] },
      v2: { pages: expPacket(who, MB(), IDS_TEXT), marked: markedOf(2) },
    });
    // Hand check of the oracle (not the code): B's CA line and IL line.
    expect([
      MB().stateLines.map((l) => [l.state, l.form, l.row, l.box16Cents, l.box17Cents]),
    ]).toEqual([
      [
        ["CA", 1, 1, 2_100_000, 4_500],
        ["IL", 1, 2, 2_000_000, 8_000],
        ["NC", 2, 1, 2_000_000, 0],
      ],
    ]);
  });

  it("T2-d void variant: the December run voided after posting -> version 1 = A (12 runs), version 2 = the 11-run figures, marked", async () => {
    const who = identityOf(e.v!.id, "Vera");
    const v1 = await versionPdf(env, e.v!, 2026, 1);
    const v2 = await versionPdf(env, e.v!, 2026, 2);
    expect({
      list: await myVersions(env, e.v!),
      v1: v1.statusCode === 200 ? await pageStrings(v1.rawPayload) : v1.statusCode,
      v1marked: v1.statusCode === 200 ? await markedPages(v1.rawPayload) : null,
      v2: v2.statusCode === 200 ? await pageStrings(v2.rawPayload) : v2.statusCode,
      v2marked: v2.statusCode === 200 ? await markedPages(v2.rawPayload) : null,
    }).toEqual({
      list: [
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
          postedOn: "2027-02-09",
          current: true,
          downloadable: true,
        },
      ],
      v1: expPacket(who, A(), IDS_TEXT),
      v1marked: [],
      v2: expPacket(who, V(), IDS_TEXT),
      v2marked: markedOf(1),
    });
  });

  it("T10 A -> B -> A: two versions (not three); version 1 is current and renders A unmarked (as first posted); the main download renders A marked CORRECTED; version 2 = B marked", async () => {
    const who = identityOf(e.t!.id, "Tess");
    const v1 = await versionPdf(env, e.t!, 2026, 1);
    const v2 = await versionPdf(env, e.t!, 2026, 2);
    const v3 = await versionPdf(env, e.t!, 2026, 3);
    await relogin(env, e.t!);
    const main = await myPdf(env, e.t!, 2026);
    expect({
      list: await myVersions(env, e.t!),
      v1: v1.statusCode === 200 ? await pageStrings(v1.rawPayload) : v1.statusCode,
      v1marked: v1.statusCode === 200 ? await markedPages(v1.rawPayload) : null,
      v2: v2.statusCode === 200 ? await pageStrings(v2.rawPayload) : v2.statusCode,
      v2marked: v2.statusCode === 200 ? await markedPages(v2.rawPayload) : null,
      v3: [v3.statusCode, v3.body],
      main: await pageStrings(main.rawPayload),
      mainMarked: await markedPages(main.rawPayload),
    }).toEqual({
      list: [
        { version: 1, kind: "original", postedOn: "2027-01-04", current: true, downloadable: true },
        {
          version: 2,
          kind: "corrected",
          postedOn: "2027-02-09",
          current: false,
          downloadable: true,
        },
      ],
      v1: expPacket(who, A(), IDS_TEXT),
      v1marked: [],
      v2: expPacket(who, B(), IDS_TEXT),
      v2marked: markedOf(1),
      v3: [409, JSON.stringify({ error: "w2_not_available" })],
      main: expPacket(who, A(), IDS_TEXT),
      mainMarked: markedOf(1),
    });
  });

  it("one version only: [1 Original, current, downloadable]; a year with no online row: versions []", async () => {
    expect({
      n: await myVersions(env, e.n!),
      z: await myVersions(env, e.z!),
    }).toEqual({
      n: [
        { version: 1, kind: "original", postedOn: "2027-01-04", current: true, downloadable: true },
      ],
      z: [],
    });
  });

  it("list contract: each version item has exactly the keys version, kind, postedOn, current, downloadable (no amount, hash, id, reason, or exactness claim)", async () => {
    const list = (await myVersions(env, e.a!)) as Record<string, unknown>[] | undefined;
    expect((list ?? [null]).map((v) => Object.keys(v ?? {}).sort())).toEqual([
      ["current", "downloadable", "kind", "postedOn", "version"],
      ["current", "downloadable", "kind", "postedOn", "version"],
    ]);
  });

  it("T11 (API part): no list body carries a hash, an amount, the SSN, the legal name, the address, the EIN, a ciphertext or the state ID", async () => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e)) {
      const b = await myW2Body(env, v);
      const text = scrub(b.body);
      out[k] = {
        status: b.status,
        hasVersions: Array.isArray(
          (b.json.w2s as { versions?: unknown }[] | undefined)?.[0]?.versions,
        ),
        hex64: HEX64.test(b.body),
        amount: /\d+\.\d{2}\b/.test(text) || text.includes("$"),
        ssn: SSN_FORMS.filter((s) => text.includes(s)),
        name: text.includes("Synthetic"),
        address: text.includes("Fixture"),
        ein: text.includes("0000001"),
        ciphertext: text.includes("enc:v1:"),
        stateId: text.includes(CA_ID),
      };
    }
    const clean = {
      status: 200,
      hasVersions: true,
      hex64: false,
      amount: false,
      ssn: [],
      name: false,
      address: false,
      ein: false,
      ciphertext: false,
      stateId: false,
    };
    expect(out).toEqual(Object.fromEntries(Object.keys(e).map((k) => [k, clean])));
  });

  it("T11 (API part): a version PDF response carries no hash or figure in its headers; a refusal body is exactly { error } with no detail", async () => {
    const ok = await versionPdf(env, e.a!, 2026, 1);
    const no = await versionPdf(env, e.a!, 2026, 7);
    expect({
      status: [ok.statusCode, no.statusCode],
      headers:
        HEX64.test(JSON.stringify(ok.headers)) || /\d+\.\d{2}/.test(JSON.stringify(ok.headers)),
      refusal: bodyError(no),
    }).toEqual({ status: [200, 409], headers: false, refusal: { error: "w2_not_available" } });
  });

  async function boot223Fresh(): Promise<Env> {
    const { boot223 } = await import("./pay-223-harness.js");
    return boot223(JAN_4);
  }
});

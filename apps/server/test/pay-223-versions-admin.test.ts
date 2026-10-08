/**
 * PAY-223 PR-2 — T13 (admin list `versions` over every method: a paper-only
 * original appears with via "paper"; Copy D ?version=n = the frozen figures,
 * records nothing, no window gate; unknown or unfrozen -> 404), the employee
 * numbering that counts online rows only (brief §6: the two numberings can
 * differ), T11 (API part, admin), and the security carry-forward: /api/export
 * never carries the new table (no frozen hash, figures key or box 15
 * ciphertext). payroll-calc-auditor, fail-first against 9cb9534; the coder
 * may not edit this file. Synthetic data only. Contract: pay-223-harness.ts.
 *
 * Hand values: A = caRuns ("60000.00" / "6000.00" / "60000.00" / "3720.00" /
 * "60000.00" / "870.00"; CA "60000.00" / "148.08"); B = A + lateRun
 * ("61000.00" / "6100.00" / "61000.00" / "3782.00" / "61000.00" / "884.50";
 * CA "61000.00" / "153.08"). Dates (America/Chicago): paper marked
 * 2027-01-05 16:00Z = 2027-01-05; print packet / consent at 2027-02-10
 * 03:00Z = 2027-02-09 21:00 CST -> "2027-02-09".
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AdminVersion,
  adminCall,
  adminListBody,
  adminRow223,
  bodyError,
  boot223,
  CA_ID,
  caRuns,
  copyDOf,
  deps,
  type Emp,
  type EmpVersion,
  emp,
  type Env,
  expCopyD,
  expFrozen,
  expPacket,
  frozenRows,
  furnRows,
  furnishModule,
  HEX64,
  type Ids,
  identityOf,
  insertRawFurnishing,
  lateRun,
  markedOf,
  markedPages,
  moveTo,
  myVersions,
  pageStrings,
  postConsent,
  relogin,
  setCaId,
  sha256,
  versionPdf,
  yearNotice,
} from "./pay-223-harness.js";
import { insertRun } from "./w2-state-harness.js";
import type { FxRun } from "./w2-state-oracle.js";

type E = Emp & { runs: FxRun[] };

const JAN_4 = "2027-01-04T16:00:00Z";
const FEB_9_LATE = "2027-02-10T03:00:00Z";
const TOKEN = "pay-223-export-token-0123456789abcdef";

async function view(res: { statusCode: number; rawPayload: Buffer; body: string }) {
  return res.statusCode === 200
    ? { pages: await pageStrings(res.rawPayload), marked: await markedPages(res.rawPayload) }
    : { status: res.statusCode, body: bodyError(res) };
}

describe("T13 admin: versions over every method, Copy D of a version, and the employee's online-only numbering", () => {
  let env: Env;
  let ids: Ids = {};
  const e: Record<string, E> = {};
  let pazBeforeConsent: unknown;
  beforeAll(async () => {
    env = await boot223(JAN_4, { config: { exportToken: TOKEN } });
    const ct = await setCaId(env, CA_ID);
    ids = { CA: { source: "entered", ct } };
    // Bo: no login — the one-shot backfill gives him a 'backfill' row.
    e.bo = await emp(env, "Bo", caRuns());
    await yearNotice(env, "2027-01-04");
    const { backfillW2Furnishings, reconcileW2Furnishings } = await furnishModule();
    await backfillW2Furnishings(deps(env), { today: "2027-01-04" });
    // Pax (no login) and Paz (login, no consent yet): paper first.
    e.pax = await emp(env, "Pax", caRuns());
    e.paz = await emp(env, "Paz", caRuns(), { login: true });
    e.uma = await emp(env, "Uma", caRuns());
    e.nia = await emp(env, "Nia", caRuns());
    await moveTo(env, "2027-01-05T16:00:00Z");
    for (const k of ["pax", "paz"]) {
      const r = await adminCall(
        env,
        "POST",
        `/api/admin/annual-forms/w2/${e[k]!.id}/furnished-on-paper?year=2026`,
        {},
      );
      if (r.statusCode !== 200) throw new Error(`paper ${r.statusCode}`);
    }
    // Uma: a printed copy recorded without a freeze (rollback window).
    await insertRawFurnishing(env, {
      employeeId: e.uma.id,
      taxYear: 2026,
      hash: sha256("pay-223 unfrozen admin print"),
      method: "admin_print",
      at: "2027-01-06T16:00:00Z",
    });
    for (const k of ["pax", "paz"]) await insertRun(env as never, e[k]!.id, lateRun());
    await moveTo(env, FEB_9_LATE);
    await reconcileW2Furnishings(deps(env), { today: "2027-02-09" });
    const p = await adminCall(
      env,
      "GET",
      `/api/admin/annual-forms/w2/${e.pax.id}/print-packet?year=2026`,
    );
    if (p.statusCode !== 200) throw new Error(`print ${p.statusCode}`);
    pazBeforeConsent = await myVersions(env, e.paz);
    await relogin(env, e.paz);
    const c = await postConsent(env, e.paz);
    if (c.statusCode !== 200) throw new Error(`consent ${c.statusCode}`);
    await relogin(env, e.paz);
  }, 300_000);
  afterAll(async () => env.close());

  const A = () => expFrozen(caRuns(), 2026, ids);
  const B = () => expFrozen([...caRuns(), lateRun()], 2026, ids);

  it("oracle self-check: the rows each method wrote (backfill; paper then print; paper then the late-consent corrected posting)", async () => {
    const rows = async (k: string) =>
      (await furnRows(env, e[k]!.id, 2026)).map((r) => [r.method, r.corrected]);
    expect({
      bo: await rows("bo"),
      pax: await rows("pax"),
      paz: await rows("paz"),
      uma: await rows("uma"),
      nia: await rows("nia"),
    }).toEqual({
      bo: [["backfill", false]],
      pax: [
        ["paper_handed", false],
        ["admin_print", true],
      ],
      paz: [
        ["paper_handed", false],
        ["portal_notice", true],
      ],
      uma: [["admin_print", false]],
      nia: [],
    });
  });

  it("admin list: versions numbered by the first row of any method, with via, current and frozen", async () => {
    const out: Record<string, unknown> = {};
    for (const k of ["bo", "pax", "paz", "uma", "nia"])
      out[k] = (await adminRow223(env, e[k]!.id)).versions;
    expect(out).toEqual({
      bo: [
        {
          version: 1,
          kind: "original",
          postedOn: "2027-01-04",
          via: "unknown",
          current: true,
          frozen: true,
        },
      ],
      pax: [
        {
          version: 1,
          kind: "original",
          postedOn: "2027-01-05",
          via: "paper",
          current: false,
          frozen: true,
        },
        {
          version: 2,
          kind: "corrected",
          postedOn: "2027-02-09",
          via: "printed",
          current: true,
          frozen: true,
        },
      ],
      paz: [
        {
          version: 1,
          kind: "original",
          postedOn: "2027-01-05",
          via: "paper",
          current: false,
          frozen: true,
        },
        {
          version: 2,
          kind: "corrected",
          postedOn: "2027-02-09",
          via: "online",
          current: true,
          frozen: true,
        },
      ],
      uma: [
        {
          version: 1,
          kind: "original",
          postedOn: "2027-01-06",
          via: "printed",
          current: false,
          frozen: false,
        },
      ],
      nia: [],
    } satisfies Record<string, AdminVersion[]>);
  });

  it("employee numbering counts online rows only: Paz had no version before consenting; now version 1 = B (Corrected, as posted), marked", async () => {
    const v1 = await versionPdf(env, e.paz!, 2026, 1);
    const v2 = await versionPdf(env, e.paz!, 2026, 2);
    expect({
      before: pazBeforeConsent,
      now: await myVersions(env, e.paz!),
      v1: await view(v1),
      v2: [v2.statusCode, bodyError(v2)],
    }).toEqual({
      before: [],
      now: [
        {
          version: 1,
          kind: "corrected",
          postedOn: "2027-02-09",
          current: true,
          downloadable: true,
        },
      ] satisfies EmpVersion[],
      v1: {
        pages: expPacket(identityOf(e.paz!.id, "Paz"), B(), { CA: CA_ID }),
        marked: markedOf(1),
      },
      v2: [409, { error: "w2_not_available" }],
    });
  });

  it("Copy D ?version=1 = the paper Original (A), ?version=2 = B; never marked; nothing recorded", async () => {
    const who = identityOf(e.pax!.id, "Pax");
    const before = await furnRows(env, e.pax!.id);
    const frozenBefore = (await frozenRows(env)).length;
    const d1 = await copyDOf(env, e.pax!.id, 2026, 1);
    const d2 = await copyDOf(env, e.pax!.id, 2026, 2);
    expect({
      d1: await view(d1),
      d2: await view(d2),
      rows: await furnRows(env, e.pax!.id),
      frozen: (await frozenRows(env)).length - frozenBefore,
    }).toEqual({
      d1: { pages: expCopyD(who, A(), { CA: CA_ID }), marked: [] },
      d2: { pages: expCopyD(who, B(), { CA: CA_ID }), marked: [] },
      rows: before,
      frozen: 0,
    });
  });

  it("Copy D: unknown version (3), an unfrozen version (Uma 1) and a never-furnished employee (Nia 1) -> 404 not_found; malformed -> 400 invalid_version", async () => {
    const out: unknown[] = [];
    for (const [k, n] of [
      ["pax", "3"],
      ["uma", "1"],
      ["nia", "1"],
      ["pax", "0"],
      ["pax", "abc"],
      ["pax", "51"],
    ] as const) {
      const r = await copyDOf(env, e[k]!.id, 2026, n);
      out.push([k, n, r.statusCode, bodyError(r)]);
    }
    const nf = { error: "not_found" };
    const bad = { error: "invalid_version" };
    expect(out).toEqual([
      ["pax", "3", 404, nf],
      ["uma", "1", 404, nf],
      ["nia", "1", 404, nf],
      ["pax", "0", 400, bad],
      ["pax", "abc", 400, bad],
      ["pax", "51", 400, bad],
    ]);
  });

  it("Copy D of a version is admin-only (an employee session -> 403) and refused cross-site (403)", async () => {
    const asEmployee = await copyDOf(env, e.pax!.id, 2026, 1, e.paz!.session!);
    const cross = await copyDOf(env, e.pax!.id, 2026, 1, {
      ...env.admin,
      "sec-fetch-site": "cross-site",
    });
    expect([asEmployee.statusCode, cross.statusCode, bodyError(cross)]).toEqual([
      403,
      403,
      { error: "cross_site" },
    ]);
  });

  it("T11 (admin API part): the versions arrays carry no hash, amount, name, SSN, ciphertext or state ID", async () => {
    const body = await adminListBody(env);
    const rows = (JSON.parse(body) as { w2s: { versions?: unknown }[] }).w2s;
    const text = JSON.stringify(rows.map((r) => r.versions));
    expect({
      present: rows.every((r) => Array.isArray(r.versions)),
      hex64: HEX64.test(body),
      amount: /\d+\.\d{2}\b/.test(text),
      name: text.includes("Synthetic"),
      ssn: text.includes("0017"),
      ciphertext: body.includes("enc:v1:"),
      stateId: body.includes(CA_ID),
    }).toEqual({
      present: true,
      hex64: false,
      amount: false,
      name: false,
      ssn: false,
      ciphertext: false,
      stateId: false,
    });
  });

  it("security: /api/export carries nothing of w2_furnished_figures (no frozen hash, figures keys or box 15 ciphertext)", async () => {
    const frozen = await frozenRows(env);
    const auth = { authorization: `Bearer ${TOKEN}` };
    const bodies: [string, number, string][] = [];
    for (const url of [
      "/api/export/payroll-runs",
      "/api/export/payroll-runs?format=csv",
      "/api/export/tax-deposits",
      "/api/export/tax-filings?year=2026",
      "/api/export/contractor-payments?year=2026",
    ]) {
      const r = await env.t.app.inject({ method: "GET", url, headers: auth });
      bodies.push([url, r.statusCode, r.body]);
    }
    const all = bodies.map((b) => b[2]).join("\n");
    expect({
      frozenRows: frozen.length > 0,
      status: bodies.map((b) => b[1]),
      hashes: frozen.filter((f) => all.includes(f.boxes_hash)).length,
      ciphertexts: frozen.some((f) =>
        Object.values(f.box15_ciphertexts ?? {}).some((c) => all.includes(c)),
      ),
      keys: [
        "stateIdDigest",
        "box15",
        "furnished_figures",
        "frozen",
        "hash_version",
        "boxesHash",
      ].filter((k) => all.includes(k)),
    }).toEqual({
      frozenRows: true,
      status: [200, 200, 200, 200, 200],
      hashes: 0,
      ciphertexts: false,
      keys: [],
    });
  });

  it("D-8: Copy D of a version has no window gate — after the (j)(6) window closed (2028-01-03) the paper Original still renders", async () => {
    await moveTo(env, "2028-01-03T16:00:00Z");
    const d1 = await copyDOf(env, e.pax!.id, 2026, 1);
    expect(await view(d1)).toEqual({
      pages: expCopyD(identityOf(e.pax!.id, "Pax"), A(), { CA: CA_ID }),
      marked: [],
    });
  });
});

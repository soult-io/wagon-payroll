/**
 * PAY-223 PR-1 — T1 (freeze on every furnishing write path), T11 (row part:
 * no PII at rest), the same-hash race, the dedupe heal, and the
 * recordFurnishing / frozenFigures contract. payroll-calc-auditor,
 * fail-first against f74b51b; the coder may not edit this file. Synthetic
 * data only. Legal source, oracle and contract: pay-223-harness.ts.
 *
 * Hand values (oracle, integer cents; Pub 15 (2026) 6.2% / 1.45% per run):
 *  - caRuns: 12 x $5,000.00 -> box 1/3/5 = 6,000,000; box 2 = 12 x 50,000 =
 *    600,000; box 4 = 12 x 31,000 = 372,000; box 6 = 12 x 7,250 = 87,000;
 *    CA line box 16 = 6,000,000, box 17 = 12 x 1,234 = 14,808; formCount 1.
 *  - lateRun adds $1,000.00 (FIT 10,000; SS 6,200; Medicare 1,450; CA 500):
 *    box 1 = 6,100,000, box 2 = 610,000, box 4 = 378,200, box 6 = 88,450,
 *    CA box 16 = 6,100,000, box 17 = 15,308.
 *  - multiRuns: CA 4 x 500,000 = 2,000,000 / 4,000 (form 1 row 1, entered),
 *    IL 2,000,000 / 8,000 (form 1 row 2, ein_default), NC 2,000,000 / 0
 *    (form 2 row 1, no ID); formCount 2; box 1 = 6,000,000.
 *  - 2025 (v1): 12 x $5,000.00 -> same boxes 1-6; formCount 1, no lines.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { company, employees } from "@payroll/db";
import {
  ADDRESS,
  adminCall,
  boot217,
  CA_ID,
  CA_ID_MID,
  caCiphertext,
  caRuns,
  coreModule,
  deps,
  type Emp,
  emp,
  type Env,
  expBox15,
  expFrozen,
  expHash,
  FIGURE_KEYS,
  type FrozenRow,
  frozenRows,
  frozenRowsText,
  furnKeys,
  furnRows,
  furnishModule,
  type Ids,
  insertRawFurnishing,
  keyOf,
  keysOf,
  LINE_KEYS,
  lateRun,
  multiRuns,
  myPdf,
  need,
  postConsent,
  rehash,
  setCaId,
  sha256,
  scrub,
  SSN_FORMS,
  stateIdsModule,
  yearNotice,
} from "./pay-223-harness.js";
import { insertRun } from "./w2-state-harness.js";
import type { FxRun } from "./w2-state-oracle.js";

const JAN_4_2027 = "2027-01-04T16:00:00Z";
const TODAY = "2027-01-04";

type E = Emp & { runs: FxRun[] };

/** One frozen row checked against the oracle: figures, keys, re-hash, box 15, source. */
function checkFrozen(row: FrozenRow | undefined, employeeId: number, runs: FxRun[], ids: Ids) {
  if (!row) return { present: false };
  const exp = expFrozen(runs, row.tax_year, ids);
  return {
    present: true,
    figures: row.figures,
    figureKeys: keysOf(row.figures),
    lineKeys: (row.figures.stateLines ?? []).map(keysOf),
    rehashMatchesKey:
      rehash(employeeId, row.tax_year, row.hash_version, row.figures) === row.boxes_hash,
    box15: row.box15_ciphertexts,
    box15DigestsMatch: Object.entries(row.box15_ciphertexts ?? {}).every(
      ([s, ct]) => row.figures.stateLines.find((l) => l.state === s)?.stateIdDigest === sha256(ct),
    ),
    source: row.source,
    expected: { figures: exp, box15: expBox15(exp, ids) },
  };
}

function expectedCheck(runs: FxRun[], year: number, ids: Ids) {
  const exp = expFrozen(runs, year, ids);
  return {
    present: true,
    figures: exp,
    figureKeys: [...FIGURE_KEYS],
    lineKeys: exp.stateLines.map(() => [...LINE_KEYS]),
    rehashMatchesKey: true,
    box15: expBox15(exp, ids),
    box15DigestsMatch: true,
    source: "furnishing",
    expected: { figures: exp, box15: expBox15(exp, ids) },
  };
}

// ---------------------------------------------------------------- T1 every write path (2026, v2)

describe("T1 every furnishing write path freezes exactly one row per distinct (employee, year, hash_version, hash) — 2026 (v2)", () => {
  let env: Env;
  let ct = "";
  const e: Record<string, E> = {};
  let ids: Ids = {};
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    ct = await setCaId(env, CA_ID);
    ids = { CA: { source: "entered", ct }, IL: { source: "ein_default" }, NC: { source: null } };
    // Year notice (portal_notice): a consenter, three states, formCount 2 (scenario g).
    e.notice = await emp(env, "Notice", multiRuns(), { login: true, consent: true });
    // Corrected portal_notice (postCorrectionOnline via the daily reconcile).
    e.corr = await emp(env, "Corr", caRuns(), { login: true, consent: true });
    // Late consent (furnishAfterConsent): a login, no consent at notice time.
    e.late = await emp(env, "Late", caRuns(), { login: true });
    // Admin print packet / paper handed / backfill: no login, no consent.
    e.print = await emp(env, "Print", caRuns());
    e.paper = await emp(env, "Paper", caRuns());
    e.back = await emp(env, "Back", caRuns());
    await yearNotice(env, TODAY);
    // Employee download as the FIRST furnishing: consent on file, created after the notice.
    e.dl = await emp(env, "Download", caRuns(), { login: true, consent: true });
  }, 300_000);
  afterAll(async () => env.close());

  it("oracle self-check: the year notice's portal_notice row carries the oracle v2 hash (3 lines, formCount 2)", async () => {
    const rows = await furnRows(env, e.notice!.id, 2026);
    expect(rows.map((r) => ({ m: r.method, v: r.hash_version, h: r.boxes_hash }))).toEqual([
      { m: "portal_notice", v: 2, h: expHash(e.notice!.id, e.notice!.runs, 2026, ids) },
    ]);
  });

  it("year notice (portal_notice): one frozen row = the oracle figures (CA entered ciphertext only; IL EIN default and NC no ID store nothing)", async () => {
    const rows = await frozenRows(env, e.notice!.id);
    expect({
      count: rows.length,
      keysMatchFurnishings: rows.map(keyOf).sort(),
      check: checkFrozen(rows[0], e.notice!.id, e.notice!.runs, ids),
    }).toEqual({
      count: 1,
      keysMatchFurnishings: await furnKeys(env, e.notice!.id),
      check: expectedCheck(e.notice!.runs, 2026, ids),
    });
  });

  it("late consent (furnishAfterConsent -> portal_notice): one frozen row = the oracle figures", async () => {
    const res = await postConsent(env, e.late!);
    const rows = await frozenRows(env, e.late!.id);
    expect({
      consent: res.statusCode,
      methods: (await furnRows(env, e.late!.id)).map((r) => r.method),
      count: rows.length,
      keys: rows.map(keyOf),
      check: checkFrozen(rows[0], e.late!.id, e.late!.runs, ids),
    }).toEqual({
      consent: 200,
      methods: ["portal_notice"],
      count: 1,
      keys: await furnKeys(env, e.late!.id),
      check: expectedCheck(e.late!.runs, 2026, ids),
    });
  });

  it("employee download (employee_download, first furnishing): one frozen row = the oracle figures", async () => {
    const pdf = await myPdf(env, e.dl!, 2026);
    const rows = await frozenRows(env, e.dl!.id);
    expect({
      pdf: pdf.statusCode,
      methods: (await furnRows(env, e.dl!.id)).map((r) => r.method),
      count: rows.length,
      keys: rows.map(keyOf),
      check: checkFrozen(rows[0], e.dl!.id, e.dl!.runs, ids),
    }).toEqual({
      pdf: 200,
      methods: ["employee_download"],
      count: 1,
      keys: await furnKeys(env, e.dl!.id),
      check: expectedCheck(e.dl!.runs, 2026, ids),
    });
  });

  it("admin print packet (admin_print): one frozen row = the oracle figures", async () => {
    const res = await adminCall(
      env,
      "GET",
      `/api/admin/annual-forms/w2/${e.print!.id}/print-packet?year=2026`,
    );
    const rows = await frozenRows(env, e.print!.id);
    expect({
      status: res.statusCode,
      methods: (await furnRows(env, e.print!.id)).map((r) => r.method),
      count: rows.length,
      keys: rows.map(keyOf),
      check: checkFrozen(rows[0], e.print!.id, e.print!.runs, ids),
    }).toEqual({
      status: 200,
      methods: ["admin_print"],
      count: 1,
      keys: await furnKeys(env, e.print!.id),
      check: expectedCheck(e.print!.runs, 2026, ids),
    });
  });

  it("paper handed (paper_handed): one frozen row = the oracle figures (OD-4: every method)", async () => {
    const res = await adminCall(
      env,
      "POST",
      `/api/admin/annual-forms/w2/${e.paper!.id}/furnished-on-paper?year=2026`,
      {},
    );
    const rows = await frozenRows(env, e.paper!.id);
    expect({
      status: res.statusCode,
      methods: (await furnRows(env, e.paper!.id)).map((r) => r.method),
      count: rows.length,
      keys: rows.map(keyOf),
      check: checkFrozen(rows[0], e.paper!.id, e.paper!.runs, ids),
    }).toEqual({
      status: 200,
      methods: ["paper_handed"],
      count: 1,
      keys: await furnKeys(env, e.paper!.id),
      check: expectedCheck(e.paper!.runs, 2026, ids),
    });
  });

  it("backfill (backfillOneInTx via backfillW2Furnishings): one frozen row = the oracle figures", async () => {
    const { backfillW2Furnishings } = await furnishModule();
    // Every other employee already holds a row, so only `back` is backfilled.
    const out = await backfillW2Furnishings(deps(env), { today: TODAY });
    const rows = await frozenRows(env, e.back!.id);
    expect({
      inserted: out.inserted,
      methods: (await furnRows(env, e.back!.id)).map((r) => r.method),
      count: rows.length,
      keys: rows.map(keyOf),
      check: checkFrozen(rows[0], e.back!.id, e.back!.runs, ids),
    }).toEqual({
      inserted: 1,
      methods: ["backfill"],
      count: 1,
      keys: await furnKeys(env, e.back!.id),
      check: expectedCheck(e.back!.runs, 2026, ids),
    });
  });

  it("corrected portal_notice (reconcile -> postCorrectionOnline): figures A and B each frozen once; B = A + the late run to the cent", async () => {
    const { reconcileW2Furnishings } = await furnishModule();
    await insertRun(env as never, e.corr!.id, lateRun());
    const runsB = [...e.corr!.runs, lateRun()];
    await reconcileW2Furnishings(deps(env), { today: TODAY });
    const rows = await frozenRows(env, e.corr!.id);
    const hashA = expHash(e.corr!.id, e.corr!.runs, 2026, ids);
    const hashB = expHash(e.corr!.id, runsB, 2026, ids);
    const byHash = (h: string) => rows.find((r) => r.boxes_hash === h);
    expect({
      furnishings: (await furnRows(env, e.corr!.id)).map((r) => [
        r.method,
        r.corrected,
        r.boxes_hash,
      ]),
      count: rows.length,
      a: checkFrozen(byHash(hashA), e.corr!.id, e.corr!.runs, ids),
      b: checkFrozen(byHash(hashB), e.corr!.id, runsB, ids),
      bBoxes: byHash(hashB) && [
        byHash(hashB)!.figures.box1Cents,
        byHash(hashB)!.figures.box2Cents,
        byHash(hashB)!.figures.box4Cents,
        byHash(hashB)!.figures.box6Cents,
        byHash(hashB)!.figures.stateLines[0]?.box16Cents,
        byHash(hashB)!.figures.stateLines[0]?.box17Cents,
      ],
    }).toEqual({
      furnishings: [
        ["portal_notice", false, hashA],
        ["portal_notice", true, hashB],
      ],
      count: 2,
      a: expectedCheck(e.corr!.runs, 2026, ids),
      b: expectedCheck(runsB, 2026, ids),
      bBoxes: [6_100_000, 610_000, 378_200, 88_450, 6_100_000, 15_308],
    });
  });

  it("re-run: repeating every furnishing (second download, second print, paper again, notice again, reconcile again, backfill again) and a second method with the same figures add no frozen row", async () => {
    const before = (await frozenRows(env)).length;
    const furnBefore = (
      await env.t.pglite.query<{ n: number }>("SELECT count(*)::int AS n FROM w2_furnishings")
    ).rows[0]!.n;
    const { reconcileW2Furnishings, backfillW2Furnishings } = await furnishModule();
    await myPdf(env, e.dl!, 2026);
    await adminCall(env, "GET", `/api/admin/annual-forms/w2/${e.print!.id}/print-packet?year=2026`);
    await adminCall(
      env,
      "POST",
      `/api/admin/annual-forms/w2/${e.paper!.id}/furnished-on-paper?year=2026`,
      {},
    );
    await yearNotice(env, TODAY);
    await reconcileW2Furnishings(deps(env), { today: TODAY });
    await backfillW2Furnishings(deps(env), { today: TODAY });
    // A different method with the same figures: a new w2_furnishings row, no new frozen row.
    const printDl = await adminCall(
      env,
      "GET",
      `/api/admin/annual-forms/w2/${e.dl!.id}/print-packet?year=2026`,
    );
    const furnAfter = (
      await env.t.pglite.query<{ n: number }>("SELECT count(*)::int AS n FROM w2_furnishings")
    ).rows[0]!.n;
    const all = await frozenRows(env);
    const keys = all.map((r) => `${r.employee_id}:${keyOf(r)}`);
    expect({
      printDl: printDl.statusCode,
      newFurnishingRows: furnAfter - furnBefore,
      newFrozenRows: all.length - before,
      duplicates: keys.length - new Set(keys).size,
    }).toEqual({ printDl: 200, newFurnishingRows: 1, newFrozenRows: 0, duplicates: 0 });
  });

  it("invariant: every employee's distinct furnishing keys equal its frozen keys (one frozen row each, none extra)", async () => {
    const out: Record<string, { furn: string[]; frozen: string[] }> = {};
    for (const [k, v] of Object.entries(e)) {
      out[k] = {
        furn: await furnKeys(env, v.id),
        frozen: (await frozenRows(env, v.id)).map(keyOf).sort(),
      };
    }
    for (const v of Object.values(out)) expect(v.frozen).toEqual(v.furn);
    expect(Object.values(out).every((v) => v.furn.length > 0)).toBe(true);
  });

  it("T11 (row part): no SSN, legal name, address, EIN, or plaintext state ID at rest; the only ciphertext is the CA box 15 copy, byte-equal to company_state_ids", async () => {
    const text = await frozenRowsText(env);
    const empRows = await env.t.db
      .select({
        taxId: employees.taxId,
        address: employees.address,
        legalName: employees.legalName,
      })
      .from(employees);
    const [co] = await env.t.db
      .select({ ein: company.ein, legalName: company.legalName })
      .from(company);
    const ciphertexts = text.match(/enc:v1:[A-Za-z0-9_-]+/g) ?? [];
    // Scans run on the text without hashes, ciphertexts and timestamps, so a
    // 4-digit SSN tail can never match inside random hex/base64 (no flake).
    const plain = scrub(text)
      .replace(/enc:v1:[A-Za-z0-9_-]+/g, "<ct>")
      .replace(/[0-9a-f]{64}/g, "<h>");
    expect({
      nonEmpty: text.length > 2,
      ssn: SSN_FORMS.filter((s) => plain.includes(s)),
      names: empRows.map((r) => r.legalName).filter((n) => plain.includes(n)),
      synthetic: plain.includes("Synthetic"),
      address: [ADDRESS.line1, ADDRESS.city, ADDRESS.zip].filter((s) => plain.includes(s)),
      ein: ["00-0000001", "000000001"].filter((s) => plain.includes(s)),
      einCiphertext: co?.ein ? text.includes(co.ein) : false,
      companyName: co?.legalName ? text.includes(`"${co.legalName}"`) : false,
      ssnCiphertext: empRows.some((r) => r.taxId !== null && text.includes(r.taxId)),
      addressCiphertext: empRows.some(
        (r) => typeof r.address === "string" && text.includes(r.address),
      ),
      plainStateId: [CA_ID, CA_ID_MID].filter((s) => plain.includes(s)),
      ciphertexts: [...new Set(ciphertexts)],
    }).toEqual({
      nonEmpty: true,
      ssn: [],
      names: [],
      synthetic: false,
      address: [],
      ein: [],
      einCiphertext: false,
      companyName: false,
      ssnCiphertext: false,
      addressCiphertext: false,
      plainStateId: [],
      ciphertexts: [ct],
    });
  });
});

// ---------------------------------------------------------------- the same hash twice, dedupe heal

describe("race safety and heal: two furnishings of the same figures, a pre-existing frozen key, a deduped furnishing row", () => {
  let env: Env;
  let ids: Ids = {};
  const e: Record<string, E> = {};
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    const ct = await setCaId(env, CA_ID);
    ids = { CA: { source: "entered", ct } };
    e.anchor = await emp(env, "Anchor", caRuns(), { login: true, consent: true });
    await yearNotice(env, TODAY);
    e.twice = await emp(env, "Twice", caRuns(), { login: true, consent: true });
    e.pre = await emp(env, "Pre", caRuns(), { login: true, consent: true });
    e.heal = await emp(env, "Heal", caRuns(), { login: true, consent: true });
  }, 300_000);
  afterAll(async () => env.close());

  it("an employee download and an admin print of the same figures at once: both 200, two furnishing rows, one frozen row, no error", async () => {
    const [a, b] = await Promise.all([
      myPdf(env, e.twice!, 2026),
      adminCall(env, "GET", `/api/admin/annual-forms/w2/${e.twice!.id}/print-packet?year=2026`),
    ]);
    const rows = await frozenRows(env, e.twice!.id);
    expect({
      status: [a.statusCode, b.statusCode],
      methods: (await furnRows(env, e.twice!.id)).map((r) => r.method).sort(),
      frozen: rows.map(keyOf),
      check: checkFrozen(rows[0], e.twice!.id, e.twice!.runs, ids),
    }).toEqual({
      status: [200, 200],
      methods: ["admin_print", "employee_download"],
      frozen: [`2026:2:${expHash(e.twice!.id, e.twice!.runs, 2026, ids)}`],
      check: expectedCheck(e.twice!.runs, 2026, ids),
    });
  });

  it("a frozen row already holding the key (source 'reconstructed') -> the furnishing succeeds and the first row stands (ON CONFLICT DO NOTHING)", async () => {
    const f = expFrozen(e.pre!.runs, 2026, ids);
    const hash = rehash(e.pre!.id, 2026, 2, f);
    await env.t.pglite.query(
      `INSERT INTO w2_furnished_figures (employee_id, tax_year, hash_version, boxes_hash, figures, box15_ciphertexts, source)
       VALUES ($1, 2026, 2, $2, $3::jsonb, $4::jsonb, 'reconstructed')`,
      [e.pre!.id, hash, JSON.stringify(f), JSON.stringify(expBox15(f, ids))],
    );
    const pdf = await myPdf(env, e.pre!, 2026);
    const rows = await frozenRows(env, e.pre!.id);
    expect({
      pdf: pdf.statusCode,
      methods: (await furnRows(env, e.pre!.id)).map((r) => r.method),
      frozen: rows.map((r) => [keyOf(r), r.source]),
    }).toEqual({
      pdf: 200,
      methods: ["employee_download"],
      frozen: [[`2026:2:${hash}`, "reconstructed"]],
    });
  });

  it("heal: a furnishing row written without a freeze (v1.29.0 / rollback window) + the same download again -> the furnishing row is deduped and the frozen row is still written", async () => {
    const hash = expHash(e.heal!.id, e.heal!.runs, 2026, ids);
    await insertRawFurnishing(env, {
      employeeId: e.heal!.id,
      taxYear: 2026,
      hash,
      method: "employee_download",
    });
    const pdf = await myPdf(env, e.heal!, 2026);
    const rows = await frozenRows(env, e.heal!.id);
    expect({
      pdf: pdf.statusCode,
      furnishings: (await furnRows(env, e.heal!.id)).length,
      check: checkFrozen(rows[0], e.heal!.id, e.heal!.runs, ids),
      count: rows.length,
    }).toEqual({
      pdf: 200,
      furnishings: 1,
      check: expectedCheck(e.heal!.runs, 2026, ids),
      count: 1,
    });
  });
});

// ---------------------------------------------------------------- 2025 (v1)

describe("T1 v1 (tax year 2025): the year notice and a download freeze boxes 1-6 with formCount 1, no lines, no box 15", () => {
  let env: Env;
  let a: E;
  beforeAll(async () => {
    env = await boot217("2026-01-05T16:00:00Z");
    a = await emp(
      env,
      "V1",
      caRuns(2025).map((r) => ({ ...r, state: null, swhCents: undefined })),
      {
        login: true,
        consent: true,
      },
    );
    await yearNotice(env, "2026-01-05");
    await myPdf(env, a, 2025);
  }, 300_000);
  afterAll(async () => env.close());

  it("one frozen row (v1), figures = { boxes 1-6, formCount 1, stateLines [], localLines [] }, re-hashes to the v1 key, box15_ciphertexts null", async () => {
    const rows = await frozenRows(env, a.id);
    const exp = expFrozen(a.runs, 2025);
    expect({
      furn: (await furnRows(env, a.id)).map((r) => [r.method, r.hash_version, r.boxes_hash]),
      frozen: rows.map((r) => ({
        version: r.hash_version,
        figures: r.figures,
        keys: keysOf(r.figures),
        rehash: rehash(a.id, 2025, 1, r.figures) === r.boxes_hash,
        box15: r.box15_ciphertexts,
        source: r.source,
      })),
    }).toEqual({
      furn: [
        ["portal_notice", 1, expHash(a.id, a.runs, 2025)],
        ["employee_download", 1, expHash(a.id, a.runs, 2025)],
      ],
      frozen: [
        {
          version: 1,
          figures: exp,
          keys: [...FIGURE_KEYS],
          rehash: true,
          box15: null,
          source: "furnishing",
        },
      ],
    });
    expect(exp).toEqual({
      box1Cents: 6_000_000,
      box2Cents: 600_000,
      box3Cents: 6_000_000,
      box4Cents: 372_000,
      box5Cents: 6_000_000,
      box6Cents: 87_000,
      formCount: 1,
      stateLines: [],
      localLines: [],
    });
  });
});

// ---------------------------------------------------------------- recordFurnishing / frozenFigures contract

describe("recordFurnishing takes figures (not a hash) and freezes in the same transaction; frozenFigures is an allowlist copy", () => {
  let env: Env;
  let a: E;
  let ids: Ids = {};
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    const ct = await setCaId(env, CA_ID);
    ids = { CA: { source: "entered", ct } };
    a = await emp(env, "Direct", caRuns());
  }, 300_000);
  afterAll(async () => env.close());

  /** A W2Figures-shaped input: the hash figures plus identity and display keys that must never be frozen. */
  function inputOf(f: ReturnType<typeof expFrozen>): Record<string, unknown> {
    return {
      ...f,
      employeeId: a.id,
      legalName: "Direct Synthetic",
      ssn: "900-00-0017",
      box1Wages: "60000.00",
      issues: [{ code: "box4_off_rate", severity: "warn" }],
      stateLines: f.stateLines.map((l) => ({ ...l, box16: "60000.00", stateId: CA_ID })),
    };
  }

  it("frozenFigures: exactly the allowlisted keys, integer cents copied, identity/display keys dropped", async () => {
    const frozenFigures = need(await coreModule(), "frozenFigures");
    const f = expFrozen(a.runs, 2026, ids);
    const out = frozenFigures(inputOf(f));
    expect({ out, keys: keysOf(out), lineKeys: out.stateLines.map(keysOf) }).toEqual({
      out: f,
      keys: [...FIGURE_KEYS],
      lineKeys: [[...LINE_KEYS]],
    });
  });

  it("frozenFigures: a non-integer amount throws a TypeError whose message carries no value", async () => {
    const frozenFigures = need(await coreModule(), "frozenFigures");
    const f = expFrozen(a.runs, 2026, ids);
    const bad = [
      { ...f, box1Cents: 6_000_000.5 },
      { ...f, box2Cents: "600000" },
      { ...f, stateLines: [{ ...f.stateLines[0]!, box17Cents: 14_808.25 }] },
    ];
    const results = bad.map((b) => {
      try {
        frozenFigures(b);
        return "no throw";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return err instanceof TypeError && !/\d{3}/.test(msg)
          ? "TypeError(fixed)"
          : `other: ${msg}`;
      }
    });
    expect(results).toEqual(["TypeError(fixed)", "TypeError(fixed)", "TypeError(fixed)"]);
  });

  it("recordFurnishing(tx, { figures, … }) writes the furnishing row with the oracle hash and the frozen row in one transaction; identity keys are not stored", async () => {
    const recordFurnishing = need(await coreModule(), "recordFurnishing");
    const f = expFrozen(a.runs, 2026, ids);
    const wrote = await env.t.db.transaction((tx) =>
      recordFurnishing(tx, {
        employeeId: a.id,
        taxYear: 2026,
        figures: inputOf(f),
        corrected: false,
        method: "admin_print",
        actorId: null,
      }),
    );
    const rows = await frozenRows(env, a.id);
    const hash = rehash(a.id, 2026, 2, f);
    expect({
      wrote,
      furn: (await furnRows(env, a.id)).map((r) => [r.method, r.hash_version, r.boxes_hash]),
      frozen: rows.map((r) => ({
        key: keyOf(r),
        figures: r.figures,
        box15: r.box15_ciphertexts,
        source: r.source,
      })),
    }).toEqual({
      wrote: true,
      furn: [["admin_print", 2, hash]],
      frozen: [
        { key: `2026:2:${hash}`, figures: f, box15: expBox15(f, ids), source: "furnishing" },
      ],
    });
  });

  it("a stale entered-ID digest (the ID was re-entered after the figures were read) -> FrozenFiguresRaceError with a fixed message, nothing written", async () => {
    const core = await coreModule();
    const recordFurnishing = need(core, "recordFurnishing");
    const stale = expFrozen(a.runs, 2026, ids); // digest of the CA_ID ciphertext
    await setCaId(env, CA_ID_MID); // the stored ciphertext is now another one
    const furnBefore = (await furnRows(env, a.id)).length;
    const frozenBefore = (await frozenRows(env, a.id)).length;
    let caught: unknown = null;
    try {
      await env.t.db.transaction((tx) =>
        recordFurnishing(tx, {
          employeeId: a.id,
          taxYear: 2026,
          figures: { ...stale, box1Cents: stale.box1Cents + 100 },
          corrected: true,
          method: "paper_handed",
          actorId: null,
        }),
      );
    } catch (err) {
      caught = err;
    }
    const msg = caught instanceof Error ? caught.message : "";
    expect({
      name: caught instanceof Error ? caught.constructor.name : String(caught),
      exported:
        typeof core.FrozenFiguresRaceError === "function" &&
        caught instanceof core.FrozenFiguresRaceError,
      fixedMessage:
        msg.length > 0 &&
        !msg.includes(CA_ID) &&
        !msg.includes(CA_ID_MID) &&
        !/[0-9a-f]{16}/.test(msg) &&
        !msg.includes(String(a.id)),
      furn: (await furnRows(env, a.id)).length - furnBefore,
      frozen: (await frozenRows(env, a.id)).length - frozenBefore,
      stored: (await caCiphertext(env)).startsWith("enc:v1:"),
    }).toEqual({
      name: "FrozenFiguresRaceError",
      exported: true,
      fixedMessage: true,
      furn: 0,
      frozen: 0,
      stored: true,
    });
  });

  it("storedEnteredStateIds(db, taxYear, states): the entered ciphertext only (enc:v1, byte-equal), nothing for the EIN default or a state without an ID", async () => {
    const fn = need(await stateIdsModule(), "storedEnteredStateIds");
    const raw = await fn(env.t.db, 2026, ["CA", "IL", "NC"]);
    const out = raw instanceof Map ? Object.fromEntries(raw) : raw;
    const entered = Object.fromEntries(
      Object.entries(out).filter(([, v]) => v !== null && v !== undefined),
    );
    expect(entered).toEqual({ CA: await caCiphertext(env) });
  });
});

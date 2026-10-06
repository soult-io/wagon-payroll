/**
 * PAY-223 PR-1 — T9: the gap sweep for furnishing rows without a frozen
 * record (brief §5.4), and its wiring (boot + daily tick after the
 * reconcile). payroll-calc-auditor, fail-first against f74b51b; the coder
 * may not edit this file. Synthetic data only. Legal source, oracle and
 * contract: pay-223-harness.ts.
 *
 * Rule under test: a row's figures can be frozen after the fact only when it
 * is PROVEN — hashVersionFor(year) === row.hash_version AND the current
 * figures re-hash to row.boxes_hash (SHA-256 over the canonical object, which
 * for v2 includes the entered ID's ciphertext digest). Otherwise the posted
 * figures are gone (the hash is one-way) and nothing is frozen, ever.
 *
 * Scenarios (GUARDRAILS): (b) data from the previous release (rows written
 * by v1.29.0, 2025 v1 rows of a filed year); (c) re-run (idempotent);
 * (d) an adjustment after posting (hash differs); (g) three states.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { taxFilings } from "@payroll/db";
import { annualTick } from "../src/payroll/scheduler.js";
import {
  boot217,
  CA_ID,
  caRuns,
  deps,
  emp,
  type Emp,
  type Env,
  expBox15,
  expFrozen,
  expHash,
  FIGURE_KEYS,
  frozenRows,
  furnishModule,
  type Ids,
  insertRawFurnishing,
  keyOf,
  keysOf,
  lateRun,
  multiRuns,
  need,
  rehash,
  setCaId,
} from "./pay-223-harness.js";
import { ROOT } from "./annual-w2-corrected-harness.js";
import { insertRun } from "./w2-state-harness.js";
import { hashV1, type FxRun } from "./w2-state-oracle.js";
import { installRecorder, labelOf, record } from "./pay-193-l4-harness.js";

const FEB_1_2027 = "2027-02-01T16:00:00Z";
const TODAY = "2027-02-01";

type E = Emp & { runs: FxRun[] };

const v1Runs = (): FxRun[] => caRuns(2025).map((r) => ({ ...r, state: null, swhCents: undefined }));

async function sweep(env: Env) {
  const fn = need(await furnishModule(), "sweepW2FurnishedFigures");
  return fn(deps(env), { today: TODAY }) as Promise<{
    frozen: number;
    unreconstructable: number;
    failed: number;
  }>;
}

/** Capture every console line written while `fn` runs. */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    }),
  );
  try {
    return { value: await fn(), lines };
  } finally {
    for (const s of spies) s.mockRestore();
  }
}

describe("T9 gap sweep: freeze a row only when the current figures re-hash to it", () => {
  let env: Env;
  let ids: Ids = {};
  const e: Record<string, E> = {};
  const h: Record<string, string> = {};
  let first: { frozen: number; unreconstructable: number; failed: number } | undefined;
  let firstLog: string[] = [];

  beforeAll(async () => {
    env = await boot217(FEB_1_2027);
    const ct = await setCaId(env, CA_ID);
    ids = { CA: { source: "entered", ct }, IL: { source: "ein_default" }, NC: { source: null } };
    // match: a v1.29.0 portal_notice whose hash equals the current figures.
    e.match = await emp(env, "Match", caRuns());
    h.match = expHash(e.match.id, e.match.runs, 2026, ids);
    await insertRawFurnishing(env, { employeeId: e.match.id, taxYear: 2026, hash: h.match });
    // changed: posted A, then an adjustment run -> current B; A cannot be rebuilt.
    e.changed = await emp(env, "Changed", caRuns());
    h.changedA = expHash(e.changed.id, e.changed.runs, 2026, ids);
    await insertRawFurnishing(env, { employeeId: e.changed.id, taxYear: 2026, hash: h.changedA });
    await insertRun(env as never, e.changed.id, lateRun());
    // version: hash equal to the current v2 hash but stored as hash_version 1,
    // and a v1-hash row for a 2026 W-2 — neither may be frozen.
    e.version = await emp(env, "Version", caRuns());
    h.versionV2 = expHash(e.version.id, e.version.runs, 2026, ids);
    await insertRawFurnishing(env, {
      employeeId: e.version.id,
      taxYear: 2026,
      hash: h.versionV2,
      version: 1,
    });
    const b = expFrozen(e.version.runs, 2026, ids);
    h.versionV1 = hashV1(e.version.id, 2026, {
      box1: b.box1Cents,
      box2: b.box2Cents,
      box3: b.box3Cents,
      box4: b.box4Cents,
      box5: b.box5Cents,
      box6: b.box6Cents,
    });
    await insertRawFurnishing(env, {
      employeeId: e.version.id,
      taxYear: 2026,
      hash: h.versionV1,
      version: 1,
    });
    // y2025: a v1 row of a FILED year (prod: 2025 w2_w3 filed, rows since 2026-10-04).
    e.y2025 = await emp(env, "Prior", v1Runs(), { login: true, consent: true });
    h.y2025 = expHash(e.y2025.id, e.y2025.runs, 2025);
    await insertRawFurnishing(env, {
      employeeId: e.y2025.id,
      taxYear: 2025,
      hash: h.y2025,
      method: "employee_download",
      at: "2026-10-05T16:00:00Z",
    });
    await env.t.db.insert(taxFilings).values({
      formType: "w2_w3",
      year: 2025,
      quarter: 0,
      dueDate: "2026-02-02",
      status: "filed",
    } as never);
    // paper: any method is swept (OD-4).
    e.paper = await emp(env, "PaperRow", caRuns());
    h.paper = expHash(e.paper.id, e.paper.runs, 2026, ids);
    await insertRawFurnishing(env, {
      employeeId: e.paper.id,
      taxYear: 2026,
      hash: h.paper,
      method: "paper_handed",
    });
    // twice: two rows (backfill + admin_print) with one key -> one frozen row.
    e.twice = await emp(env, "TwiceRow", caRuns());
    h.twice = expHash(e.twice.id, e.twice.runs, 2026, ids);
    await insertRawFurnishing(env, {
      employeeId: e.twice.id,
      taxYear: 2026,
      hash: h.twice,
      method: "backfill",
    });
    await insertRawFurnishing(env, {
      employeeId: e.twice.id,
      taxYear: 2026,
      hash: h.twice,
      method: "admin_print",
    });
    // already: the key already has a frozen row (written at furnishing time).
    e.already = await emp(env, "Already", caRuns());
    const fa = expFrozen(e.already.runs, 2026, ids);
    h.already = rehash(e.already.id, 2026, 2, fa);
    await insertRawFurnishing(env, { employeeId: e.already.id, taxYear: 2026, hash: h.already });
    await env.t.pglite
      .query(
        `INSERT INTO w2_furnished_figures (employee_id, tax_year, hash_version, boxes_hash, figures, box15_ciphertexts, source)
       VALUES ($1, 2026, 2, $2, $3::jsonb, $4::jsonb, 'furnishing')`,
        [e.already.id, h.already, JSON.stringify(fa), JSON.stringify(expBox15(fa, ids))],
      )
      .catch(() => undefined); // no table before 0029: the tests below fail on their own
    // multi (rollback simulation): A frozen at furnishing time; B posted by
    // v1.29.0 during a rollback window, without a freeze -> healed.
    e.multi = await emp(env, "Multi", multiRuns());
    const fm = expFrozen(e.multi.runs, 2026, ids);
    h.multiA = rehash(e.multi.id, 2026, 2, fm);
    await insertRawFurnishing(env, { employeeId: e.multi.id, taxYear: 2026, hash: h.multiA });
    await env.t.pglite
      .query(
        `INSERT INTO w2_furnished_figures (employee_id, tax_year, hash_version, boxes_hash, figures, box15_ciphertexts, source)
       VALUES ($1, 2026, 2, $2, $3::jsonb, $4::jsonb, 'furnishing')`,
        [e.multi.id, h.multiA, JSON.stringify(fm), JSON.stringify(expBox15(fm, ids))],
      )
      .catch(() => undefined);
    await insertRun(env as never, e.multi.id, lateRun());
    e.multi.runs.push(lateRun());
    h.multiB = expHash(e.multi.id, e.multi.runs, 2026, ids);
    await insertRawFurnishing(env, {
      employeeId: e.multi.id,
      taxYear: 2026,
      hash: h.multiB,
      corrected: true,
    });
    try {
      const c = await captureConsole(() => sweep(env));
      first = c.value;
      firstLog = c.lines;
    } catch {
      first = undefined;
    }
  }, 300_000);
  afterAll(async () => env.close());

  it("oracle self-check (no sweep needed): the hashes the fixture rows carry are the oracle's own (v2 three-line and v1)", () => {
    expect({
      v2: /^[0-9a-f]{64}$/.test(h.match!) && h.match !== h.versionV1,
      changed: h.changedA !== expHash(e.changed!.id, [...e.changed!.runs, lateRun()], 2026, ids),
      multi: h.multiA !== h.multiB,
    }).toEqual({ v2: true, changed: true, multi: true });
  });

  it("counts: frozen 5 (match, 2025, paper, twice, multi B), failed 0, at least one unreconstructable (changed)", () => {
    expect(
      first && { frozen: first.frozen, failed: first.failed, unrec: first.unreconstructable >= 1 },
    ).toEqual({
      frozen: 5,
      failed: 0,
      unrec: true,
    });
  });

  it("match: one 'reconstructed' row = the oracle figures, re-hashes to the key, CA ciphertext copied (digest proven by the hash)", async () => {
    const rows = await frozenRows(env, e.match!.id);
    const exp = expFrozen(e.match!.runs, 2026, ids);
    expect(
      rows.map((r) => ({
        key: keyOf(r),
        figures: r.figures,
        keys: keysOf(r.figures),
        rehash: rehash(e.match!.id, 2026, 2, r.figures) === r.boxes_hash,
        box15: r.box15_ciphertexts,
        source: r.source,
      })),
    ).toEqual([
      {
        key: `2026:2:${h.match}`,
        figures: exp,
        keys: [...FIGURE_KEYS],
        rehash: true,
        box15: expBox15(exp, ids),
        source: "reconstructed",
      },
    ]);
  });

  it("changed (posted A, figures now B): no frozen row for A and none for the never-posted B", async () => {
    expect((await frozenRows(env, e.changed!.id)).map(keyOf)).toEqual([]);
  });

  it("hash_version mismatch: a v1-version row carrying the v2 hash, and a v1 hash for a 2026 W-2 -> not frozen", async () => {
    expect((await frozenRows(env, e.version!.id)).map(keyOf)).toEqual([]);
  });

  it("2025 (v1, w2_w3 filed): one 'reconstructed' v1 row { boxes 1-6, formCount 1, stateLines [], localLines [] }, box15 null", async () => {
    const rows = await frozenRows(env, e.y2025!.id);
    expect(
      rows.map((r) => ({
        key: keyOf(r),
        figures: r.figures,
        rehash: rehash(e.y2025!.id, 2025, 1, r.figures) === r.boxes_hash,
        box15: r.box15_ciphertexts,
        source: r.source,
      })),
    ).toEqual([
      {
        key: `2025:1:${h.y2025}`,
        figures: expFrozen(e.y2025!.runs, 2025),
        rehash: true,
        box15: null,
        source: "reconstructed",
      },
    ]);
  });

  it("any method: a paper_handed row and a backfill + admin_print pair are frozen once each", async () => {
    const paper = await frozenRows(env, e.paper!.id);
    const twice = await frozenRows(env, e.twice!.id);
    expect({
      paper: paper.map((r) => [keyOf(r), r.source, r.figures]),
      twice: twice.map((r) => [keyOf(r), r.source, r.figures]),
    }).toEqual({
      paper: [[`2026:2:${h.paper}`, "reconstructed", expFrozen(e.paper!.runs, 2026, ids)]],
      twice: [[`2026:2:${h.twice}`, "reconstructed", expFrozen(e.twice!.runs, 2026, ids)]],
    });
  });

  it("already frozen: the furnishing-time row stands alone (no second row, source unchanged)", async () => {
    expect((await frozenRows(env, e.already!.id)).map((r) => [keyOf(r), r.source])).toEqual([
      [`2026:2:${h.already}`, "furnishing"],
    ]);
  });

  it("rollback simulation (three states, formCount 2): A kept as written, B healed as 'reconstructed' with the CA ciphertext only", async () => {
    const rows = await frozenRows(env, e.multi!.id);
    const expB = expFrozen(e.multi!.runs, 2026, ids);
    expect(rows.map((r) => [keyOf(r), r.source, r.figures, r.box15_ciphertexts])).toEqual([
      [
        `2026:2:${h.multiA}`,
        "furnishing",
        expFrozen(multiRuns(), 2026, ids),
        expBox15(expFrozen(multiRuns(), 2026, ids), ids),
      ],
      [`2026:2:${h.multiB}`, "reconstructed", expB, expBox15(expB, ids)],
    ]);
    expect(expB.formCount).toBe(2);
  });

  it("re-run: a second sweep freezes nothing and changes no row", async () => {
    const before = await frozenRows(env);
    const again = await sweep(env);
    const after = await frozenRows(env);
    expect({ frozen: again.frozen, failed: again.failed, same: after }).toEqual({
      frozen: 0,
      failed: 0,
      same: before,
    });
  });

  it("logs: counts only — no name, hash, year, amount or state ID in any line the sweep writes", () => {
    const text = firstLog.join("\n");
    expect({
      ran: first !== undefined,
      names: /Synthetic/.test(text),
      hash: /[0-9a-f]{64}/.test(text),
      year: /\b20(2[0-9])\b/.test(text),
      amount: /\d[\d,]*\.\d{2}\b/.test(text) || /\b(6000000|14808|600000)\b/.test(text),
      stateId: text.includes(CA_ID) || text.includes("enc:v1"),
    }).toEqual({
      ran: true,
      names: false,
      hash: false,
      year: false,
      amount: false,
      stateId: false,
    });
  });

  it("each frozen insert runs in a transaction that first took the employee lock (per employee-year, like the reconcile)", async () => {
    const late = await emp(env, "Locked", caRuns());
    await insertRawFurnishing(env, {
      employeeId: late.id,
      taxYear: 2026,
      hash: expHash(late.id, late.runs, 2026, ids),
    });
    installRecorder(env.t);
    const { stmts } = await record(() => sweep(env));
    const inserts = stmts.filter((s) => /insert\s+into\s+"?w2_furnished_figures"?/i.test(s.text));
    expect({
      inserts: inserts.length,
      locked: inserts.every(
        (ins) =>
          ins.tx !== null &&
          stmts.some(
            (s) =>
              s.tx === ins.tx &&
              labelOf(s) === "employee_lock" &&
              stmts.indexOf(s) < stmts.indexOf(ins),
          ),
      ),
      frozen: (await frozenRows(env, late.id)).map((r) => r.source),
    }).toEqual({ inserts: 1, locked: true, frozen: ["reconstructed"] });
  });

  it("daily tick: annualTick freezes a gap row written since the last sweep", async () => {
    const tick = await emp(env, "Tick", caRuns());
    await insertRawFurnishing(env, {
      employeeId: tick.id,
      taxYear: 2026,
      hash: expHash(tick.id, tick.runs, 2026, ids),
      method: "admin_print",
    });
    await annualTick(deps(env));
    expect((await frozenRows(env, tick.id)).map((r) => [keyOf(r), r.source])).toEqual([
      [`2026:2:${expHash(tick.id, tick.runs, 2026, ids)}`, "reconstructed"],
    ]);
  });
});

describe("T9 wiring: the sweep runs at boot and on the daily tick after the reconcile", () => {
  const read = (rel: string) => readFileSync(resolve(ROOT, "apps/server/src", rel), "utf8");

  it("src/index.ts (boot) calls sweepW2FurnishedFigures(", () => {
    expect(read("index.ts").includes("sweepW2FurnishedFigures(")).toBe(true);
  });

  it("src/payroll/scheduler.ts annualTick calls sweepW2FurnishedFigures( after reconcileW2Furnishings(", () => {
    const src = read("payroll/scheduler.ts");
    const rec = src.indexOf("reconcileW2Furnishings({");
    expect({ rec: rec >= 0, after: src.indexOf("sweepW2FurnishedFigures(", rec) > rec }).toEqual({
      rec: true,
      after: true,
    });
  });
});

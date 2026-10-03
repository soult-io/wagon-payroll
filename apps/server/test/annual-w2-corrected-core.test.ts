/**
 * PAY-206 T1, T2, T18 (payroll-calc-auditor, fail-first; the coder may not
 * edit this file). Pure core of apps/server/src/filings/w2-furnish.ts and
 * the append-only w2_furnishings table (migration 0027).
 *
 * Interfaces required (spec R3, R4):
 *  - w2BoxesHash(employeeId, taxYear, boxes: W2BoxesCents): string — 64
 *    lowercase hex, canonical (box key order irrelevant), from integer cents
 *    only. The spec's "a string input fails typecheck" cannot be enforced
 *    here (CI does not typecheck test files), so the auditor pins the
 *    runtime form: a non-safe-integer box throws.
 *  - furnishingState(rows: { id, boxesHash, furnishedAt: Date, method }[],
 *    H, { consented }) -> { furnished, corrected, correctionToFurnish,
 *    latest }. Product Lead review round 2026-10-03 (overrides the spec):
 *    D1 corrected = any row of ANY method with hash != H;
 *    correctionToFurnish = corrected AND the latest DELIVERY row is not H —
 *    consented (active consent + login): the latest portal_notice;
 *    otherwise the latest paper_handed; no delivery row = not delivered.
 *    employee_download, admin_print and backfill never clear it.
 *    D3 "latest" = highest id only (furnishedAt never orders).
 *    Rows may arrive in any order.
 *  - D2: no unique key on w2_furnishings (w2_furnishings_event_uniq dropped
 *    by editing the unreleased migration 0027 in place; no new migration).
 *  - D9: electronicW2AccessThrough(taxYear) — ISO date, October 15 of
 *    taxYear+1 rolled to the next business day (weekend / federal holiday).
 *    26 CFR 31.6051-1(j)(6). Oracle: calendar weekday arithmetic below.
 *    October 15 is never a federal holiday and the roll never reaches
 *    Columbus Day (2nd Monday, Oct 8-14), so no holiday case exists.
 * Synthetic data only.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDatabase, type SeedDb } from "@payroll/db";
import { createTestApp, type TestContext } from "./helpers.js";
import { createEmployee } from "./pay-date-helpers.js";
import { type Boxes, furnishModule, ROOT } from "./annual-w2-corrected-harness.js";

// Jan-Dec 2025 at 6,000.00/month (harness oracle): 72,000.00 / 7,454.04 /
// 72,000.00 / 4,464.00 / 72,000.00 / 1,044.00.
const B: Boxes = {
  box1Cents: 7_200_000,
  box2Cents: 745_404,
  box3Cents: 7_200_000,
  box4Cents: 446_400,
  box5Cents: 7_200_000,
  box6Cents: 104_400,
};
const KEYS = Object.keys(B) as (keyof Boxes)[];

describe("T1 w2BoxesHash", () => {
  it("64 lowercase hex; stable for the same cents; independent of box key order", async () => {
    const { w2BoxesHash } = await furnishModule();
    const h = w2BoxesHash(7, 2025, B);
    const reordered = Object.fromEntries([...KEYS].reverse().map((k) => [k, B[k]])) as Boxes;
    expect({
      shape: /^[0-9a-f]{64}$/.test(h),
      again: w2BoxesHash(7, 2025, { ...B }) === h,
      reordered: w2BoxesHash(7, 2025, reordered) === h,
    }).toEqual({ shape: true, again: true, reordered: true });
  });

  it("each single box +1 cent and -1 cent changes the hash; all twelve differ from each other", async () => {
    const { w2BoxesHash } = await furnishModule();
    const base = w2BoxesHash(7, 2025, B);
    const variants = KEYS.flatMap((k) => [
      w2BoxesHash(7, 2025, { ...B, [k]: B[k] + 1 }),
      w2BoxesHash(7, 2025, { ...B, [k]: B[k] - 1 }),
    ]);
    expect({
      allDifferFromBase: variants.every((v) => v !== base),
      distinct: new Set(variants).size,
    }).toEqual({ allDifferFromBase: true, distinct: 12 });
  });

  it("differs across employeeId and taxYear for the same cents", async () => {
    const { w2BoxesHash } = await furnishModule();
    const h = w2BoxesHash(7, 2025, B);
    expect({
      otherEmployee: w2BoxesHash(8, 2025, B) !== h,
      otherYear: w2BoxesHash(7, 2026, B) !== h,
      swapped: w2BoxesHash(2025, 7, B) !== h,
    }).toEqual({ otherEmployee: true, otherYear: true, swapped: true });
  });

  it("integer cents only: a formatted string, a fraction or NaN in any box throws (never hashed)", async () => {
    const { w2BoxesHash } = await furnishModule();
    const bad: unknown[] = ["8000.00", 800_000.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2];
    const outcomes = bad.map((v) => {
      try {
        w2BoxesHash(7, 2025, { ...B, box1Cents: v as number });
        return "hashed";
      } catch {
        return "threw";
      }
    });
    expect(outcomes).toEqual(["threw", "threw", "threw", "threw"]);
  });
});

describe("T2 furnishingState truth table (review round D1, D3)", () => {
  const H1 = "1".repeat(64);
  const H2 = "2".repeat(64);
  const H3 = "3".repeat(64);
  type M = "portal_notice" | "employee_download" | "admin_print" | "paper_handed" | "backfill";
  const PN: M = "portal_notice";
  const DL: M = "employee_download";
  const AP: M = "admin_print";
  const PH: M = "paper_handed";
  const BF: M = "backfill";
  // Default: furnished_at rises with id; the D3 rows break that on purpose.
  const r = (id: number, h: string, method: M, iso?: string) => ({
    id,
    boxesHash: h,
    method,
    furnishedAt: new Date(iso ?? `2026-01-${String(id + 4).padStart(2, "0")}T10:00:00Z`),
  });
  const C = true; // consented (active consent + login)
  const P = false; // paper (no consent or no login)

  const cases: [
    string,
    boolean,
    ReturnType<typeof r>[],
    string,
    [boolean, boolean, boolean, number | null],
  ][] = [
    ["none", C, [], H1, [false, false, false, null]],
    ["none (paper)", P, [], H1, [false, false, false, null]],
    // Consented: only portal_notice delivers.
    ["C [pn H1] cur H1", C, [r(1, H1, PN)], H1, [true, false, false, 1]],
    ["C [pn H1] cur H2", C, [r(1, H1, PN)], H2, [true, true, true, 1]],
    ["C [pn H1, pn H2] cur H2", C, [r(1, H1, PN), r(2, H2, PN)], H2, [true, true, false, 2]],
    ["C [pn H1, pn H2] cur H3", C, [r(1, H1, PN), r(2, H2, PN)], H3, [true, true, true, 2]],
    [
      "C [pn H1, dl H2] cur H2 (download never clears)",
      C,
      [r(1, H1, PN), r(2, H2, DL)],
      H2,
      [true, true, true, 2],
    ],
    [
      "C [pn H1, ap H2] cur H2 (print never clears)",
      C,
      [r(1, H1, PN), r(2, H2, AP)],
      H2,
      [true, true, true, 2],
    ],
    [
      "C [pn H1, ph H2] cur H2 (paper is not the consented channel)",
      C,
      [r(1, H1, PN), r(2, H2, PH)],
      H2,
      [true, true, true, 2],
    ],
    ["C [dl H1] cur H1", C, [r(1, H1, DL)], H1, [true, false, false, 1]],
    ["C [dl H1] cur H2 (no portal_notice at all)", C, [r(1, H1, DL)], H2, [true, true, true, 1]],
    ["C [dl H1, dl H2] cur H2", C, [r(1, H1, DL), r(2, H2, DL)], H2, [true, true, true, 2]],
    ["C [bf H1] cur H2", C, [r(1, H1, BF)], H2, [true, true, true, 1]],
    ["C [bf H1, pn H2] cur H2", C, [r(1, H1, BF), r(2, H2, PN)], H2, [true, true, false, 2]],
    // D2: figures that come back to an earlier hash need a new delivery.
    [
      "C [pn H1, pn H2] cur H1 (came back)",
      C,
      [r(1, H1, PN), r(2, H2, PN)],
      H1,
      [true, true, true, 2],
    ],
    [
      "C [pn H1, pn H2, pn H1] cur H1 (re-notified)",
      C,
      [r(1, H1, PN), r(2, H2, PN), r(3, H1, PN)],
      H1,
      [true, true, false, 3],
    ],
    // Paper: only paper_handed delivers.
    ["P [ap H1] cur H1", P, [r(1, H1, AP)], H1, [true, false, false, 1]],
    ["P [ap H1] cur H2", P, [r(1, H1, AP)], H2, [true, true, true, 1]],
    [
      "P [ap H1, ap H2] cur H2 (print never clears)",
      P,
      [r(1, H1, AP), r(2, H2, AP)],
      H2,
      [true, true, true, 2],
    ],
    ["P [ap H1, ph H2] cur H2", P, [r(1, H1, AP), r(2, H2, PH)], H2, [true, true, false, 2]],
    [
      "P [ap H1, ph H2, ap H2] cur H2",
      P,
      [r(1, H1, AP), r(2, H2, PH), r(3, H2, AP)],
      H2,
      [true, true, false, 3],
    ],
    [
      "P [ph H1, ph H2] cur H1 (came back)",
      P,
      [r(1, H1, PH), r(2, H2, PH)],
      H1,
      [true, true, true, 2],
    ],
    [
      "P [ph H1, ph H2, ph H1] cur H1 (handed again)",
      P,
      [r(1, H1, PH), r(2, H2, PH), r(3, H1, PH)],
      H1,
      [true, true, false, 3],
    ],
    [
      "P [pn H1, pn H2] cur H2 (consent withdrawn, R1: the latest portal_notice carries the current figures -> delivered)",
      P,
      [r(1, H1, PN), r(2, H2, PN)],
      H2,
      [true, true, false, 2],
    ],
    ["P [dl H1, dl H2] cur H2", P, [r(1, H1, DL), r(2, H2, DL)], H2, [true, true, true, 2]],
    ["P [bf H1] cur H1", P, [r(1, H1, BF)], H1, [true, false, false, 1]],
    ["P [bf H1] cur H2", P, [r(1, H1, BF)], H2, [true, true, true, 1]],
    // D3: latest = highest id, even when its furnished_at is older.
    [
      "D3 P id beats furnished_at",
      P,
      [r(1, H1, PH, "2026-02-10T10:00:00Z"), r(2, H2, PH, "2026-01-10T10:00:00Z")],
      H2,
      [true, true, false, 2],
    ],
    [
      "D3 P id beats furnished_at (other figures)",
      P,
      [r(1, H2, PH, "2026-02-10T10:00:00Z"), r(2, H1, PH, "2026-01-10T10:00:00Z")],
      H2,
      [true, true, true, 2],
    ],
    [
      "D3 C id beats furnished_at",
      C,
      [r(4, H1, PN, "2026-02-10T10:00:00Z"), r(5, H2, PN, "2026-01-10T10:00:00Z")],
      H2,
      [true, true, false, 5],
    ],
    [
      "D3 same furnished_at -> max id",
      P,
      [r(4, H1, PH, "2026-01-12T10:00:00Z"), r(5, H2, PH, "2026-01-12T10:00:00Z")],
      H2,
      [true, true, false, 5],
    ],
  ];

  for (const [name, consented, rows, cur, [furnished, corrected, toFurnish, latestId]] of cases) {
    it(`${name} -> furnished ${furnished}, corrected ${corrected}, toFurnish ${toFurnish}, latest ${latestId}`, async () => {
      const { furnishingState } = await furnishModule();
      const forward = furnishingState(rows, cur, { consented });
      const backward = furnishingState([...rows].reverse(), cur, { consented });
      const view = (s: typeof forward) => ({
        furnished: s.furnished,
        corrected: s.corrected,
        correctionToFurnish: s.correctionToFurnish,
        latestId: s.latest?.id ?? null,
      });
      const expected = { furnished, corrected, correctionToFurnish: toFurnish, latestId };
      expect({ forward: view(forward), backward: view(backward) }).toEqual({
        forward: expected,
        backward: expected,
      });
    });
  }
});

// ---------------------------------------------------------------- D9 date (pure)

/** Auditor oracle: Oct 15 of taxYear+1; Saturday -> +2, Sunday -> +1 (UTC calendar). */
function oracleAccessThrough(taxYear: number): string {
  const d = new Date(Date.UTC(taxYear + 1, 9, 15));
  const dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(d.getUTCDate() + 2);
  if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe("D9 electronicW2AccessThrough: October 15 of the following year, next business day", () => {
  it("oracle self-check: 2025 Thu, 2026 Fri, 2021 Sat -> Mon, 2022 Sun -> Mon, 2027 Sun -> Mon", () => {
    expect([2025, 2026, 2021, 2022, 2027].map(oracleAccessThrough)).toEqual([
      "2026-10-15",
      "2027-10-15",
      "2022-10-17",
      "2023-10-16",
      "2028-10-16",
    ]);
  });

  it("matches the oracle for tax years 2020-2040 (weekday, Saturday and Sunday cases)", async () => {
    const { electronicW2AccessThrough } = await furnishModule();
    const years = Array.from({ length: 21 }, (_, i) => 2020 + i);
    expect(years.map((y) => [y, electronicW2AccessThrough(y)])).toEqual(
      years.map((y) => [y, oracleAccessThrough(y)]),
    );
  });
});

describe("T18 w2_furnishings is append-only and constrained (migration 0027)", () => {
  let t: TestContext;
  let employeeId: number;
  const HASH = "a".repeat(64);

  beforeAll(async () => {
    t = await createTestApp();
    await seedDatabase(t.db as unknown as SeedDb);
    employeeId = await createEmployee(t, 600_000, "T18 Synthetic");
  }, 180_000);

  afterAll(async () => {
    await t.close();
  });

  async function insert(hash: string, method: string, corrected = false) {
    return t.pglite.query<{ id: number }>(
      `INSERT INTO w2_furnishings (employee_id, tax_year, boxes_hash, corrected, method)
       VALUES ($1, 2025, $2, $3, $4) RETURNING id`,
      [employeeId, hash, corrected, method],
    );
  }

  async function outcome(sql: string, params: unknown[] = []): Promise<string> {
    try {
      await t.pglite.query(sql, params);
      return "ok";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  it("UPDATE and DELETE raise 'w2_furnishings is append-only'; the row is unchanged", async () => {
    await t.pglite.exec("TRUNCATE w2_furnishings RESTART IDENTITY");
    const id = (await insert(HASH, "backfill")).rows[0]!.id;
    const upd = await outcome("UPDATE w2_furnishings SET corrected = true WHERE id = $1", [id]);
    const del = await outcome("DELETE FROM w2_furnishings WHERE id = $1", [id]);
    const row = await t.pglite.query<{ corrected: boolean; hash_version: number }>(
      "SELECT corrected, hash_version FROM w2_furnishings WHERE id = $1",
      [id],
    );
    expect({
      upd: upd.includes("w2_furnishings is append-only"),
      del: del.includes("w2_furnishings is append-only"),
      row: row.rows,
    }).toEqual({ upd: true, del: true, row: [{ corrected: false, hash_version: 1 }] });
  });

  it("CHECKs: unknown method, non-hex or short hash, tax_year out of range are rejected; the five methods are accepted", async () => {
    await t.pglite.exec("TRUNCATE w2_furnishings RESTART IDENTITY");
    const methods = [
      "portal_notice",
      "employee_download",
      "admin_print",
      "paper_handed",
      "backfill",
    ];
    const accepted: string[] = [];
    for (const m of methods) {
      if (
        (await insert(HASH, m)
          .then(() => "ok")
          .catch(() => "no")) === "ok"
      )
        accepted.push(m);
    }
    const ins = (hash: string, method: string, year = 2025) =>
      outcome(
        `INSERT INTO w2_furnishings (employee_id, tax_year, boxes_hash, corrected, method)
         VALUES ($1, $2, $3, false, $4)`,
        [employeeId, year, hash, method],
      );
    expect({
      accepted,
      badMethod: await ins("b".repeat(64), "emailed"),
      upperHex: await ins("B".repeat(64), "backfill"),
      shortHash: await ins("b".repeat(63), "backfill"),
      year2019: await ins("c".repeat(64), "backfill", 2019),
    }).toEqual({
      accepted: methods,
      badMethod: expect.not.stringMatching(/^ok$/),
      upperHex: expect.not.stringMatching(/^ok$/),
      shortHash: expect.not.stringMatching(/^ok$/),
      year2019: expect.not.stringMatching(/^ok$/),
    });
  });

  it("D2: no unique key — w2_furnishings_event_uniq is gone, no unique index besides the primary key, and the same event inserts twice", async () => {
    await t.pglite.exec("TRUNCATE w2_furnishings RESTART IDENTITY");
    const cons = await t.pglite.query<{ conname: string; contype: string }>(
      `SELECT conname, contype FROM pg_constraint
        WHERE conrelid = 'w2_furnishings'::regclass AND contype IN ('u', 'x')`,
    );
    const uniqueIdx = await t.pglite.query<{ relname: string }>(
      `SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid = 'w2_furnishings'::regclass AND i.indisunique AND NOT i.indisprimary`,
    );
    await insert(HASH, "portal_notice");
    const dup = await outcome(
      `INSERT INTO w2_furnishings (employee_id, tax_year, boxes_hash, corrected, method)
       VALUES ($1, 2025, $2, true, 'portal_notice')`,
      [employeeId, HASH],
    );
    const rows = await t.pglite.query<{ id: number }>("SELECT id FROM w2_furnishings ORDER BY id");
    expect({
      constraints: cons.rows,
      uniqueIndexes: uniqueIdx.rows,
      dup,
      ids: rows.rows.map((x) => x.id),
    }).toEqual({ constraints: [], uniqueIndexes: [], dup: "ok", ids: [1, 2] });
  });

  it("D2: dropped by editing the unreleased 0027 in place — no migration names the event key; 0027, its snapshot and schema.ts carry none", () => {
    const dir = resolve(ROOT, "packages/db/drizzle");
    const naming = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => readFileSync(resolve(dir, f), "utf8").includes("w2_furnishings_event_uniq"));
    const m0027 = readFileSync(resolve(dir, "0027_w2_furnishings.sql"), "utf8");
    const snap = readFileSync(resolve(dir, "meta/0027_snapshot.json"), "utf8");
    const schema = readFileSync(resolve(ROOT, "packages/db/src/schema.ts"), "utf8");
    expect({
      naming,
      m0027: m0027.includes("w2_furnishings_event_uniq") || /\bUNIQUE\s*\(/i.test(m0027),
      snapshot: snap.includes("w2_furnishings_event_uniq"),
      schema: schema.includes("w2_furnishings_event_uniq"),
    }).toEqual({ naming: [], m0027: false, snapshot: false, schema: false });
  });

  it("FK: employee_id must reference employees", async () => {
    const res = await outcome(
      `INSERT INTO w2_furnishings (employee_id, tax_year, boxes_hash, corrected, method)
       VALUES (987654, 2025, $1, false, 'backfill')`,
      [HASH],
    );
    expect(res).not.toBe("ok");
    expect(res).not.toMatch(/does not exist/);
  });
});

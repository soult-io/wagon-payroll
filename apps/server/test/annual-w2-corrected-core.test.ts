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
 *  - furnishingState(rows: { id, boxesHash, furnishedAt: Date }[], H) ->
 *    { furnished, corrected, correctionToFurnish, latest }. corrected = any
 *    row hash != H; correctionToFurnish = corrected AND the latest row (max
 *    furnishedAt, then max id) has hash != H. Rows may arrive in any order.
 * Synthetic data only.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDatabase, type SeedDb } from "@payroll/db";
import { createTestApp, type TestContext } from "./helpers.js";
import { createEmployee } from "./pay-date-helpers.js";
import { type Boxes, furnishModule } from "./annual-w2-corrected-harness.js";

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

describe("T2 furnishingState truth table", () => {
  const H1 = "1".repeat(64);
  const H2 = "2".repeat(64);
  const H3 = "3".repeat(64);
  const at = (iso: string) => new Date(iso);
  const r = (id: number, h: string, iso: string) => ({ id, boxesHash: h, furnishedAt: at(iso) });

  const cases: [
    string,
    ReturnType<typeof r>[],
    string,
    [boolean, boolean, boolean, number | null],
  ][] = [
    ["none", [], H1, [false, false, false, null]],
    ["[H1] cur H1", [r(1, H1, "2026-01-05T10:00:00Z")], H1, [true, false, false, 1]],
    ["[H1] cur H2", [r(1, H1, "2026-01-05T10:00:00Z")], H2, [true, true, true, 1]],
    [
      "[H1,H2] cur H2",
      [r(1, H1, "2026-01-05T10:00:00Z"), r(2, H2, "2026-01-12T10:00:00Z")],
      H2,
      [true, true, false, 2],
    ],
    [
      "[H1,H2] cur H3",
      [r(1, H1, "2026-01-05T10:00:00Z"), r(2, H2, "2026-01-12T10:00:00Z")],
      H3,
      [true, true, true, 2],
    ],
    [
      "[H1,H2] cur H1",
      [r(1, H1, "2026-01-05T10:00:00Z"), r(2, H2, "2026-01-12T10:00:00Z")],
      H1,
      [true, true, true, 2],
    ],
    // Latest by furnished_at, not by id: row 2 is older than row 1.
    [
      "furnished_at beats id",
      [r(2, H2, "2026-01-05T10:00:00Z"), r(1, H1, "2026-01-12T10:00:00Z")],
      H1,
      [true, true, false, 1],
    ],
    // Same furnished_at: the higher id is the latest.
    [
      "tie -> max id",
      [r(5, H2, "2026-01-12T10:00:00Z"), r(4, H1, "2026-01-12T10:00:00Z")],
      H2,
      [true, true, false, 5],
    ],
    [
      "tie -> max id (other way)",
      [r(4, H2, "2026-01-12T10:00:00Z"), r(5, H1, "2026-01-12T10:00:00Z")],
      H2,
      [true, true, true, 5],
    ],
  ];

  for (const [name, rows, cur, [furnished, corrected, toFurnish, latestId]] of cases) {
    it(`${name} -> furnished ${furnished}, corrected ${corrected}, toFurnish ${toFurnish}`, async () => {
      const { furnishingState } = await furnishModule();
      const forward = furnishingState(rows, cur);
      const backward = furnishingState([...rows].reverse(), cur);
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

  it("UNIQUE (employee_id, tax_year, boxes_hash, method): a duplicate event is refused; ON CONFLICT DO NOTHING keeps the first furnished_at", async () => {
    await t.pglite.exec("TRUNCATE w2_furnishings RESTART IDENTITY");
    await insert(HASH, "employee_download");
    const first = await t.pglite.query<{ furnished_at: Date }>(
      "SELECT furnished_at FROM w2_furnishings",
    );
    const dup = await outcome(
      `INSERT INTO w2_furnishings (employee_id, tax_year, boxes_hash, corrected, method)
       VALUES ($1, 2025, $2, false, 'employee_download')`,
      [employeeId, HASH],
    );
    await t.pglite.query(
      `INSERT INTO w2_furnishings (employee_id, tax_year, boxes_hash, corrected, method, furnished_at)
       VALUES ($1, 2025, $2, false, 'employee_download', now() + interval '1 day')
       ON CONFLICT ON CONSTRAINT w2_furnishings_event_uniq DO NOTHING`,
      [employeeId, HASH],
    );
    const after = await t.pglite.query<{ furnished_at: Date }>(
      "SELECT furnished_at FROM w2_furnishings",
    );
    expect({
      dupRefused: dup !== "ok",
      rows: after.rows.length,
      keptFirst: after.rows[0]!.furnished_at.getTime() === first.rows[0]!.furnished_at.getTime(),
    }).toEqual({ dupRefused: true, rows: 1, keptFirst: true });
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

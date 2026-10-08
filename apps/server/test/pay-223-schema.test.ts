/**
 * PAY-223 PR-1 — T12 (w2_furnished_figures is append-only and constrained),
 * T15 (migration 0029 is additive and applies on a v1.29.0 database holding
 * w2_furnishings rows; Drizzle snapshot consistent), and the export guard
 * (the new table never reaches /api/export). payroll-calc-auditor,
 * fail-first against f74b51b; the coder may not edit this file. Synthetic
 * data only. Contract: pay-223-harness.ts (brief §4).
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDatabase, type SeedDb } from "@payroll/db";
import { createTestApp, type TestContext } from "./helpers.js";
import { ROOT } from "./annual-w2-corrected-harness.js";

const DRIZZLE = resolve(ROOT, "packages/db/drizzle");
const HASH = "a".repeat(64);
const FIG = JSON.stringify({
  box1Cents: 1,
  box2Cents: 0,
  box3Cents: 1,
  box4Cents: 0,
  box5Cents: 1,
  box6Cents: 0,
  formCount: 1,
  stateLines: [],
  localLines: [],
});

async function outcome(
  pg: { query: PGlite["query"] },
  sql: string,
  params: unknown[] = [],
): Promise<string> {
  try {
    await pg.query(sql, params);
    return "ok";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ---------------------------------------------------------------- T12

describe("T12 w2_furnished_figures: append-only, keyed, constrained (migration 0029)", () => {
  let t: TestContext;
  let employeeId = 0;
  beforeAll(async () => {
    t = await createTestApp();
    await seedDatabase(t.db as unknown as SeedDb);
    const r = await t.pglite.query<{ id: number }>(
      `INSERT INTO employees (company_id, legal_name, hire_date) VALUES ((SELECT id FROM company LIMIT 1), 'T12 Synthetic', '2024-01-01') RETURNING id`,
    );
    employeeId = r.rows[0]!.id;
  }, 180_000);
  afterAll(async () => t.close());

  const ins = (o: {
    year?: number;
    version?: number;
    hash?: string;
    figures?: string;
    box15?: string | null;
    source?: string;
    employee?: number;
  }) =>
    outcome(
      t.pglite,
      `INSERT INTO w2_furnished_figures (employee_id, tax_year, hash_version, boxes_hash, figures, box15_ciphertexts, source)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
      [
        o.employee ?? employeeId,
        o.year ?? 2026,
        o.version ?? 2,
        o.hash ?? HASH,
        o.figures ?? FIG,
        o.box15 === undefined ? null : o.box15,
        o.source ?? "furnishing",
      ],
    );

  it("columns: exactly the brief §4 set, types and nullability", async () => {
    const cols = await t.pglite.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'w2_furnished_figures' ORDER BY column_name`,
    );
    expect(cols.rows).toEqual([
      { column_name: "box15_ciphertexts", data_type: "jsonb", is_nullable: "YES" },
      { column_name: "boxes_hash", data_type: "text", is_nullable: "NO" },
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
      { column_name: "employee_id", data_type: "integer", is_nullable: "NO" },
      { column_name: "figures", data_type: "jsonb", is_nullable: "NO" },
      { column_name: "hash_version", data_type: "smallint", is_nullable: "NO" },
      { column_name: "id", data_type: "integer", is_nullable: "NO" },
      { column_name: "source", data_type: "text", is_nullable: "NO" },
      { column_name: "tax_year", data_type: "integer", is_nullable: "NO" },
    ]);
  });

  it("UPDATE and DELETE raise 'w2_furnished_figures is append-only'; the row is unchanged", async () => {
    await t.pglite.exec("TRUNCATE w2_furnished_figures RESTART IDENTITY").catch(() => undefined);
    const first = await ins({});
    const upd = await outcome(t.pglite, "UPDATE w2_furnished_figures SET source = 'reconstructed'");
    const upd2 = await outcome(t.pglite, `UPDATE w2_furnished_figures SET figures = '{}'::jsonb`);
    const del = await outcome(t.pglite, "DELETE FROM w2_furnished_figures");
    const rows = await t.pglite
      .query<{ source: string; figures: unknown }>(
        "SELECT source, figures FROM w2_furnished_figures",
      )
      .then((r) => r.rows)
      .catch(() => null);
    expect({
      first,
      upd: upd.includes("w2_furnished_figures is append-only"),
      upd2: upd2.includes("w2_furnished_figures is append-only"),
      del: del.includes("w2_furnished_figures is append-only"),
      rows,
    }).toEqual({
      first: "ok",
      upd: true,
      upd2: true,
      del: true,
      rows: [{ source: "furnishing", figures: JSON.parse(FIG) }],
    });
  });

  it("unique key (employee_id, tax_year, hash_version, boxes_hash): a second row with the same key is refused; another version or hash is accepted", async () => {
    await t.pglite.exec("TRUNCATE w2_furnished_figures RESTART IDENTITY").catch(() => undefined);
    const idx = await t.pglite
      .query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'w2_furnished_figures' AND indexname = 'w2_furnished_figures_key_uniq'`,
      )
      .then((r) => r.rows.map((x) => x.indexdef.replace(/\s+/g, " ")));
    expect({
      idx:
        idx.length === 1 &&
        /UNIQUE INDEX .*\(employee_id, tax_year, hash_version, boxes_hash\)/.test(idx[0]!),
      a: await ins({}),
      dup: (await ins({ source: "reconstructed" })) === "ok",
      otherHash: await ins({ hash: "b".repeat(64) }),
      otherYear: await ins({ year: 2027 }),
      otherVersion: await ins({ version: 1, year: 2025 }),
    }).toEqual({
      idx: true,
      a: "ok",
      dup: false,
      otherHash: "ok",
      otherYear: "ok",
      otherVersion: "ok",
    });
  });

  it("CHECKs and FK: bad hash, hash_version 3, unknown source, non-object figures, box 15 on v1 or as an array, tax_year 2019, unknown employee -> refused; v2 box 15 object accepted", async () => {
    await t.pglite.exec("TRUNCATE w2_furnished_figures RESTART IDENTITY").catch(() => undefined);
    const refused = (s: string) => s !== "ok";
    expect({
      upperHex: refused(await ins({ hash: "A".repeat(64) })),
      shortHash: refused(await ins({ hash: "c".repeat(63) })),
      version3: refused(await ins({ hash: "d".repeat(64), version: 3 })),
      source: refused(await ins({ hash: "e".repeat(64), source: "imported" })),
      arrayFigures: refused(await ins({ hash: "f".repeat(64), figures: "[]" })),
      box15OnV1: refused(
        await ins({ hash: "1".repeat(64), version: 1, year: 2025, box15: '{"CA":"enc:v1:x"}' }),
      ),
      box15Array: refused(await ins({ hash: "2".repeat(64), box15: '["enc:v1:x"]' })),
      year2019: refused(await ins({ hash: "3".repeat(64), year: 2019 })),
      noEmployee: refused(await ins({ hash: "4".repeat(64), employee: 987_654 })),
      v2Box15: await ins({ hash: "5".repeat(64), box15: '{"CA":"enc:v1:x"}' }),
      v1Plain: await ins({ hash: "6".repeat(64), version: 1, year: 2025 }),
    }).toEqual({
      upperHex: true,
      shortHash: true,
      version3: true,
      source: true,
      arrayFigures: true,
      box15OnV1: true,
      box15Array: true,
      year2019: true,
      noEmployee: true,
      v2Box15: "ok",
      v1Plain: "ok",
    });
  });

  it("Drizzle schema exports w2FurnishedFigures from @payroll/db", async () => {
    const db = (await import("@payroll/db")) as Record<string, unknown>;
    expect(typeof db.w2FurnishedFigures).toBe("object");
  });
});

// ---------------------------------------------------------------- T15

interface Journal {
  entries: { idx: number; tag: string }[];
}
function journal(): Journal {
  return JSON.parse(readFileSync(resolve(DRIZZLE, "meta/_journal.json"), "utf8")) as Journal;
}
async function migrate(pg: PGlite, filter: (tag: string) => boolean): Promise<void> {
  for (const e of journal().entries.filter((x) => filter(x.tag))) {
    const text = readFileSync(resolve(DRIZZLE, `${e.tag}.sql`), "utf8");
    for (const part of text.split("--> statement-breakpoint")) {
      const stmt = part.trim();
      if (!stmt) continue;
      try {
        await pg.exec(stmt);
      } catch (err) {
        if (e.tag.startsWith("0001")) continue; // btree_gist, as helpers.ts
        throw err;
      }
    }
  }
}

function migration0029(): { tag: string | undefined; files: string[]; sql: string } {
  const tag = journal().entries.find((e) => e.tag.startsWith("0029"))?.tag;
  const files = readdirSync(DRIZZLE).filter((f) => f.startsWith("0029") && f.endsWith(".sql"));
  const sql = files.length === 1 ? readFileSync(resolve(DRIZZLE, files[0]!), "utf8") : "";
  return { tag, files, sql };
}

describe("T15 migration 0029 on a v1.29.0 database (0028) holding w2_furnishings rows", () => {
  it("T15a 0029_w2_furnished_figures exists, is journaled once (the last entry), and is additive only", () => {
    const { tag, files, sql } = migration0029();
    const tags = journal().entries.map((e) => e.tag);
    const stmts = sql
      .split("--> statement-breakpoint")
      .map((s) => s.replace(/--[^\n]*\n?/g, "").trim())
      .filter(Boolean);
    const isFnOrTrigger = (s: string) =>
      /^CREATE OR REPLACE FUNCTION w2_furnished_figures_append_only\(\)/i.test(s) ||
      /^CREATE TRIGGER "?w2_furnished_figures_no_update_delete"?\s+BEFORE UPDATE OR DELETE ON "?w2_furnished_figures"?/i.test(
        s,
      );
    const notAdditive = stmts.filter(
      (s) =>
        !(
          /^CREATE TABLE "w2_furnished_figures"/i.test(s) ||
          /^CREATE UNIQUE INDEX "w2_furnished_figures_key_uniq" ON "w2_furnished_figures"/i.test(
            s,
          ) ||
          /^CREATE INDEX "\w+" ON "w2_furnished_figures"/i.test(s) ||
          /^ALTER TABLE "w2_furnished_figures" ADD CONSTRAINT "\w+" FOREIGN KEY/i.test(s) ||
          isFnOrTrigger(s)
        ),
    );
    // FK referential actions ("ON DELETE no action") are not row rewrites.
    const plain = stmts
      .filter((s) => !isFnOrTrigger(s))
      .join("\n")
      .replace(/ON (DELETE|UPDATE) (no action|restrict|cascade|set null|set default)/gi, "");
    expect({
      tag,
      last: tags[tags.length - 1],
      journaled: tags.filter((t) => t.startsWith("0029")).length,
      files: files.length,
      notAdditive,
      noRewrite: !/\b(UPDATE|DELETE|DROP|RENAME|ALTER COLUMN|SET NOT NULL|TRUNCATE)\b/i.test(plain),
      touchesOnlyNewTable: !/\b(ALTER TABLE|INSERT INTO)\s+"?(?!w2_furnished_figures\b)\w+"?/i.test(
        plain,
      ),
      appendOnlyMessage: sql.includes("w2_furnished_figures is append-only"),
    }).toEqual({
      tag: "0029_w2_furnished_figures",
      last: "0029_w2_furnished_figures",
      journaled: 1,
      files: 1,
      notAdditive: [],
      noRewrite: true,
      touchesOnlyNewTable: true,
      appendOnlyMessage: true,
    });
  });

  it("T15b 0028 database with an employee and w2_furnishings rows -> 0029 applies; existing rows byte-identical; the new table is empty and append-only", async () => {
    const pg = new PGlite("memory://");
    try {
      await migrate(pg, (tag) => tag.slice(0, 4) <= "0028");
      await pg.query(
        `INSERT INTO company (legal_name, ein) VALUES ('Example Corp', 'enc:v1:synthetic')`,
      );
      await pg.query(
        `INSERT INTO employees (company_id, legal_name, hire_date) VALUES (1, 'Upgrade Synthetic', '2024-01-01')`,
      );
      await pg.query(
        `INSERT INTO w2_furnishings (employee_id, tax_year, boxes_hash, hash_version, corrected, method, furnished_at)
         VALUES (1, 2025, $1, 1, false, 'employee_download', '2026-10-05T16:00:00Z'),
                (1, 2025, $1, 1, false, 'portal_notice', '2026-10-05T17:00:00Z')`,
        ["9".repeat(64)],
      );
      const before = await pg.query("SELECT * FROM w2_furnishings ORDER BY id");
      await migrate(pg, (tag) => tag.slice(0, 4) > "0028");
      const after = await pg.query("SELECT * FROM w2_furnishings ORDER BY id");
      const count = await pg
        .query<{ n: number }>("SELECT count(*)::int AS n FROM w2_furnished_figures")
        .then((r) => r.rows[0]?.n)
        .catch(() => null);
      await pg
        .query(
          `INSERT INTO w2_furnished_figures (employee_id, tax_year, hash_version, boxes_hash, figures, source)
         VALUES (1, 2025, 1, $1, $2::jsonb, 'reconstructed')`,
          ["9".repeat(64), FIG],
        )
        .catch(() => undefined);
      const del = await outcome(pg, "DELETE FROM w2_furnished_figures");
      const furnDel = await outcome(pg, "DELETE FROM w2_furnishings");
      expect({
        same: JSON.stringify(after.rows) === JSON.stringify(before.rows),
        rows: after.rows.length,
        empty: count,
        appendOnly: del.includes("w2_furnished_figures is append-only"),
        oldTrigger: furnDel.includes("w2_furnishings is append-only"),
      }).toEqual({ same: true, rows: 2, empty: 0, appendOnly: true, oldTrigger: true });
    } finally {
      await pg.close();
    }
  });

  it("T15c Drizzle snapshot: meta/0029_snapshot.json chains to 0028 and its w2_furnished_figures table matches the migrated columns and the unique key", async () => {
    const path = resolve(DRIZZLE, "meta/0029_snapshot.json");
    let snap: Record<string, Any> | null = null;
    try {
      snap = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      snap = null;
    }
    const prev = JSON.parse(readFileSync(resolve(DRIZZLE, "meta/0028_snapshot.json"), "utf8"));
    const table = snap?.tables?.["public.w2_furnished_figures"];
    const pg = new PGlite("memory://");
    let dbCols: string[] = [];
    try {
      await migrate(pg, () => true);
      dbCols = (
        await pg.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_name = 'w2_furnished_figures' ORDER BY column_name`,
        )
      ).rows.map((r) => r.column_name);
    } finally {
      await pg.close();
    }
    const uniq = table?.indexes?.w2_furnished_figures_key_uniq;
    expect({
      chained: snap?.prevId === prev.id,
      cols: table ? Object.keys(table.columns).sort() : null,
      dbCols,
      unique: uniq
        ? {
            isUnique: uniq.isUnique,
            cols: uniq.columns.map((c: { expression: string }) => c.expression),
          }
        : null,
      fk: table
        ? Object.values(table.foreignKeys).map((f: Any) => [f.tableTo, f.columnsFrom])
        : null,
      // every table of 0028 is still in 0029 (nothing dropped)
      kept: snap ? Object.keys(prev.tables).every((k) => k in snap!.tables) : false,
    }).toEqual({
      chained: true,
      cols: [...dbCols].sort(),
      dbCols: [
        "box15_ciphertexts",
        "boxes_hash",
        "created_at",
        "employee_id",
        "figures",
        "hash_version",
        "id",
        "source",
        "tax_year",
      ],
      unique: { isUnique: true, cols: ["employee_id", "tax_year", "hash_version", "boxes_hash"] },
      fk: [["employees", ["employee_id"]]],
      kept: true,
    });
  });
});

// ---------------------------------------------------------------- export guard (brief §8)

describe("export guard: w2_furnished_figures never reaches /api/export", () => {
  it("routes/export.ts and docs/export-api.md never name the table or its Drizzle export", () => {
    const src = readFileSync(resolve(ROOT, "apps/server/src/routes/export.ts"), "utf8");
    const doc = readFileSync(resolve(ROOT, "docs/export-api.md"), "utf8");
    expect({
      src: /w2FurnishedFigures|w2_furnished_figures|box15_ciphertexts/.test(src),
      doc: /w2_furnished_figures|box15_ciphertexts/.test(doc),
    }).toEqual({ src: false, doc: false });
  });
});

// biome-ignore lint/suspicious/noExplicitAny: snapshot JSON
type Any = any;

/**
 * Integration test harness — REAL SQL, no mocks (step-2 requirement).
 *
 * Each test file boots an in-memory PGlite (embedded Postgres, genuinely
 * executing SQL), runs every drizzle migration from packages/db/drizzle, and
 * wires the app to it through PGlite's native drivers (drizzle-orm/pglite +
 * kysely's PGliteDialect). Production uses postgres-js over TCP instead; both
 * speak to real Postgres, and the SQL under test is identical.
 *
 * (An earlier revision exposed PGlite over the wire protocol via
 * @electric-sql/pglite-socket so the app could use postgres-js, but
 * pglite-socket's Bind path mangles Date parameters, breaking better-auth's
 * session writes. PGlite's native drivers handle Dates correctly.)
 */

import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { PGliteDialect } from "kysely";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@payroll/db";
import { loadConfig, type AppConfig } from "../src/config.js";
import { buildApp, type BuiltApp } from "../src/app.js";
import type { Db } from "../src/db.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Walk up to the workspace root (the dir holding pnpm-workspace.yaml) rather
 * than a fixed "../../.." — Stryker (PAY-93) runs these tests from a sandbox
 * copy nested under apps/server/.stryker-tmp/, where a fixed hop count misses.
 */
function workspaceRoot(from: string): string {
  let dir = from;
  while (!existsSync(resolve(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`pnpm-workspace.yaml not found above ${from}`);
    dir = parent;
  }
  return dir;
}

const DRIZZLE_DIR = resolve(workspaceRoot(HERE), "packages/db/drizzle");

interface Journal {
  entries: { idx: number; tag: string }[];
}

/** Run all migrations in journal order against PGlite. */
export async function runMigrations(pglite: PGlite): Promise<string[]> {
  const journal = JSON.parse(
    readFileSync(resolve(DRIZZLE_DIR, "meta/_journal.json"), "utf8"),
  ) as Journal;
  const skipped: string[] = [];
  for (const entry of journal.entries) {
    const file = resolve(DRIZZLE_DIR, `${entry.tag}.sql`);
    const sql = readFileSync(file, "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const stmt = statement.trim();
      if (!stmt) continue;
      try {
        await pglite.exec(stmt);
      } catch (err) {
        // PGlite may lack a contrib extension (e.g. btree_gist); skip only the
        // 0001 raw-SQL statements that depend on it, fail loudly otherwise.
        if (entry.tag.startsWith("0001")) {
          skipped.push(stmt.slice(0, 60));
          continue;
        }
        throw err;
      }
    }
  }
  return skipped;
}

export interface TestContext extends BuiltApp {
  pglite: PGlite;
  skippedStatements: string[];
  close: () => Promise<void>;
}

export async function createTestApp(
  overrides: Partial<AppConfig> = {},
  extra: {
    logStream?: { write(msg: string): void };
    /** Fixed wall clock for the issue-time pay-date check (Spec 26 (PAY-173) D9). */
    clock?: () => Date;
    /**
     * PAY-103 R18 (brief D3-a): constructor-only clock for the tax-table
     * coverage endpoint; falls back to `clock`, then the process clock.
     */
    coverageClock?: () => Date;
    /**
     * PAY-81: opt-in PGlite contrib extensions. Pass `{ btree_gist }` (from
     * `@electric-sql/pglite/contrib/btree_gist`) so migration 0001 applies in
     * full and the `compensation_no_overlap` exclusion constraint is live.
     * Without it runMigrations skips that constraint (skippedStatements), which
     * is how the year-rollover overlap stayed invisible to CI.
     */
    extensions?: PGliteOptions["extensions"];
  } = {},
): Promise<TestContext> {
  const pglite = new PGlite("memory://", extra.extensions ? { extensions: extra.extensions } : {});
  const skippedStatements = await runMigrations(pglite);

  const config = loadConfig({
    nodeEnv: "test",
    logLevel: "silent",
    baseUrl: "http://localhost",
    sessionSecret: "test-secret-0123456789abcdef0123456789abcdef",
    ...overrides,
  });

  const db = drizzle(pglite, { schema }) as unknown as Db;
  const built = await buildApp({
    ...(extra.logStream ? { logStream: extra.logStream } : {}),
    ...(extra.clock ? { clock: extra.clock } : {}),
    ...(extra.coverageClock ? { coverageClock: extra.coverageClock } : {}),
    config,
    database: {
      db,
      dialect: new PGliteDialect({ pglite }),
      close: () => pglite.close(),
    },
  });

  return {
    ...built,
    pglite,
    skippedStatements,
    close: async () => {
      await built.app.close();
      await built.database.close();
    },
  };
}

/** Default Origin header satisfying the CSRF middleware. */
export const ORIGIN = { origin: "http://localhost" };

/** Extract a named cookie value from a set-cookie array. */
export function cookieValue(
  setCookies: string | string[] | undefined,
  name: string,
): string | null {
  if (!setCookies) return null;
  const list = Array.isArray(setCookies) ? setCookies : [setCookies];
  for (const c of list) {
    const [pair] = c.split(";");
    const [k, ...v] = pair!.split("=");
    if (k?.trim() === name) return decodeURIComponent(v.join("=").trim());
  }
  return null;
}

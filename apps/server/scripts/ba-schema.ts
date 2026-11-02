/**
 * Better Auth schema drift check (PAY-259).
 *
 * BA_MIGRATIONS lists every packages/db/drizzle file that holds Better Auth
 * DDL. `pendingBetterAuthSql` applies them to an empty PGlite database and
 * returns what Better Auth's own migration compiler still wants for the
 * runtime options: "" when the migrations match the configuration. A plugin,
 * option or better-auth upgrade that needs DDL then shows up here (and in
 * test/better-auth-schema-drift) instead of at runtime.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGliteDialect } from "kysely";
import { getMigrations } from "better-auth/db/migration";
import { loadConfig } from "../src/config.js";
import { buildAuthOptions } from "../src/auth/auth.js";

export const BA_MIGRATIONS = ["0002_better_auth_tables.sql", "0030_passkey.sql"] as const;

const DRIZZLE_DIR = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../packages/db/drizzle",
);

/**
 * Statements of a Better Auth migration file that build the auth schema:
 * no app-table constraints (0002's employees FK) and no data backfills.
 */
export function betterAuthStatements(file: string): string[] {
  return readFileSync(resolve(DRIZZLE_DIR, file), "utf8")
    .split("--> statement-breakpoint")
    .map((stmt) =>
      stmt
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(
      (stmt) =>
        stmt.length > 0 && !/^alter table "employees"/i.test(stmt) && !/^update /i.test(stmt),
    );
}

/** Better Auth DDL still missing after `files` are applied ("" = none). */
export async function pendingBetterAuthSql(
  files: readonly string[] = BA_MIGRATIONS,
): Promise<string> {
  const pglite = new PGlite("memory://");
  try {
    for (const file of files) {
      for (const stmt of betterAuthStatements(file)) await pglite.exec(stmt);
    }
    const options = buildAuthOptions({
      // The schema does not depend on the address. Fixed, because vitest sets
      // BASE_URL="/" (Vite's public base path), which is not a URL.
      config: loadConfig({ baseUrl: "http://localhost:8927" }),
      // The audit hook / backup-codes plugin only touch db at request time;
      // schema generation never invokes them.
      db: null as never,
      dialect: new PGliteDialect({ pglite } as never),
    });
    const { compileMigrations } = await getMigrations(options);
    const sql = (await compileMigrations()).trim();
    // compileMigrations joins statements with ";" and always appends one.
    return sql === ";" ? "" : sql;
  } finally {
    await pglite.close();
  }
}

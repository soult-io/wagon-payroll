/**
 * Database wiring — postgres-js driver + drizzle (spec 1/8).
 *
 * TWO clients, one database — deliberately:
 * `drizzle(sql)` MUTATES its client's type serializers to identity for the
 * date/timestamp/JSON OIDs (see drizzle-orm/postgres-js/driver.js — drizzle
 * maps those types itself). Better Auth's kysely adapter sends raw `Date`
 * parameters and therefore MUST NOT share that client: on a shared client
 * the identity "serializer" hands the Date straight to the wire encoder,
 * which crashes (`Buffer.byteLength(Date)`, prod create-admin 2026-07-29).
 * Tests never saw this because they run Better Auth over PGlite.
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { PostgresJSDialect } from "kysely-postgres-js";
import type { Dialect } from "kysely";
import * as schema from "@payroll/db";
import { databaseUrl, type AppConfig } from "./config.js";

export type Db = PostgresJsDatabase<typeof schema>;

/** Everything the app needs from its database connection. */
export interface Database {
  db: Db;
  dialect: Dialect;
  /** Exposed for diagnostics/regression tests — prefer db/dialect/close. */
  clients?: { drizzle: postgres.Sql; auth: postgres.Sql };
  close: () => Promise<void>;
}

export function createDb(config: AppConfig, url?: string): Database {
  const dbUrl = url ?? databaseUrl(config);
  // Small pools: single admin + single employee workload.
  const sql = postgres(dbUrl, { max: 10 });
  const authSql = postgres(dbUrl, { max: 5 });
  return {
    db: drizzle(sql, { schema }),
    dialect: new PostgresJSDialect({ postgres: authSql }),
    clients: { drizzle: sql, auth: authSql },
    close: async () => {
      await Promise.all([sql.end(), authSql.end()]);
    },
  };
}

/**
 * True when an error is (or wraps) a Postgres error with one of `codes`.
 * Drizzle wraps driver errors in DrizzleQueryError with the original on
 * `cause` — walk the chain so both postgres-js and PGlite shapes match.
 */
export function hasPgErrorCode(err: unknown, codes: readonly string[]): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if ("code" in current && codes.includes((current as { code: unknown }).code as string)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** True when an error is (or wraps) a Postgres unique-violation (23505). */
export function isUniqueViolation(err: unknown): boolean {
  return hasPgErrorCode(err, ["23505"]);
}

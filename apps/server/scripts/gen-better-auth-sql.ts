/**
 * Generate the Better Auth table SQL (user, session, account, verification,
 * twoFactor, passkey) using Better Auth's own migration compiler — the same
 * engine the @better-auth/cli `migrate` command uses — against an empty
 * PGlite database. Output is reviewed and merged into packages/db/drizzle
 * migrations (spec 3: auth-owned tables managed by Better Auth migrations).
 *
 * Run: pnpm tsx scripts/gen-better-auth-sql.ts           (full schema)
 *      pnpm tsx scripts/gen-better-auth-sql.ts --delta   (only what the
 *        files in BA_MIGRATIONS do not create yet)
 */

import { BA_MIGRATIONS, pendingBetterAuthSql } from "./ba-schema.js";

const delta = process.argv.includes("--delta");
console.log(await pendingBetterAuthSql(delta ? BA_MIGRATIONS : []));

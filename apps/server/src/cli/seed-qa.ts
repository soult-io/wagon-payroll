/**
 * QA seed CLI (spec 14 §2): deterministic synthetic dataset for the QA
 * environment. Idempotent — safe to re-run; never touches prod data.
 *
 * Refuses to run unless APP_ENV=qa (or NODE_ENV=test) — Spec 24 (PAY-116).
 *
 * Usage:
 *   APP_ENV=qa pnpm seed:qa                             (local, dev DB)
 *   docker exec payroll-qa node dist/cli/seed-qa.js     (QA container)
 *
 * The fixed QA credentials + TOTP secrets it creates are documented in
 * docs/qa.md (fake, QA-only — safe to publish).
 */

import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { createAuth } from "../auth/auth.js";
import { formatQaSeedSummary, seedQaDataset } from "../qa/seed-qa.js";

const config = loadConfig();
const { db, dialect, close } = createDb(config);
const auth = createAuth({ config, db, dialect });

try {
  const summary = await seedQaDataset({ db, auth, config });
  for (const line of formatQaSeedSummary(summary)) console.log(line);
} finally {
  await close();
}

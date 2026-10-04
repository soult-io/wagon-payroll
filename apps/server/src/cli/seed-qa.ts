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
import { QA_ADMIN, QA_EMPLOYEE_LOGIN, seedQaDataset } from "../qa/seed-qa.js";

const config = loadConfig();
const { db, dialect, close } = createDb(config);
const auth = createAuth({ config, db, dialect });

try {
  const summary = await seedQaDataset({ db, auth, config });
  console.log("QA seed complete (idempotent):");
  console.log(
    `  users: ${summary.users.admin.email} (${summary.users.admin.created ? "created" : "already present"}), ` +
      `${summary.users.employee.email} (${summary.users.employee.created ? "created" : "already present"})`,
  );
  console.log(
    `  payroll: ${summary.payroll.issued} run(s) issued, ${summary.payroll.existing} already present, ` +
      `current-period draft ${summary.payroll.draftCreated ? "created" : "already present"}`,
  );
  console.log(
    `  change request thread: ${summary.changeRequestCreated ? "created" : "already present"}`,
  );
  console.log(
    `  credentials: see docs/qa.md (admin ${QA_ADMIN.email}, employee ${QA_EMPLOYEE_LOGIN.email})`,
  );
} finally {
  await close();
}

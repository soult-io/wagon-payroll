/**
 * Fastify app factory — everything except listen(), so tests can inject.
 */

import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, type AppConfig } from "./config.js";
import { createDb, type Database } from "./db.js";
import { createAuth } from "./auth/auth.js";
import { mountBetterAuth } from "./auth/fastify-mount.js";
import { createGuards } from "./plugins/guards.js";
import { csrfOriginCheck } from "./plugins/csrf.js";
import { securityHeaders } from "./plugins/security-headers.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerAdminRoutes } from "./routes/admin-users.js";
import { registerAdminPayrollRoutes } from "./routes/admin-payroll.js";
import { registerPayslipRoutes } from "./routes/payslips.js";
import { registerMyW2Routes } from "./routes/my-w2.js";
import { registerChangeRequestRoutes } from "./routes/change-requests.js";
import { registerMyRoutes } from "./routes/my.js";
import { registerMyInvoiceRoutes } from "./routes/my-invoices.js";
import { registerAdminNotificationRoutes } from "./routes/admin-notifications.js";
import { registerAdminEmployeeRoutes } from "./routes/admin-employees.js";
import { registerAdminSettingsRoutes } from "./routes/admin-settings.js";
import { registerAdminContractorRoutes } from "./routes/admin-contractors.js";
import { registerAdminDepositRoutes } from "./routes/admin-deposits.js";
import { registerAdminCalendarRoutes } from "./routes/admin-calendar.js";
import { registerAdminFilingRoutes } from "./routes/admin-filings.js";
import { registerAdminStateTaxRoutes } from "./routes/admin-state-taxes.js";
import { registerAdminLocalTaxRoutes } from "./routes/admin-local-tax.js";
import { registerAdminAnnualFormRoutes } from "./routes/admin-annual-forms.js";
import { registerExportRoutes } from "./routes/export.js";
import { registerQaRoutes } from "./routes/qa.js";
import { registerStubRoutes } from "./routes/stubs.js";

export interface BuildAppDeps {
  config?: AppConfig;
  /**
   * Test override: inject a database (e.g. PGlite-backed). Production uses
   * createDb() (postgres-js over TCP).
   */
  database?: Database;
  /** Re-register scheduler cron after pay-schedule edits (wired in index.ts). */
  onScheduleChange?: () => Promise<void>;
}

export async function buildApp(deps: BuildAppDeps = {}) {
  const config = deps.config ?? loadConfig();
  const database = deps.database ?? createDb(config);
  const { db, dialect } = database;
  const auth = createAuth({ config, db, dialect });
  const guards = createGuards({ auth, db });

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
  });

  await app.register(rateLimit, { global: false });
  app.addHook("onRequest", csrfOriginCheck(config));
  app.addHook("onSend", securityHeaders);

  app.get("/health", async () => ({ ok: true }));

  // Public runtime config (spec 14 + spec 22 D2): the deployment environment
  // label (QA banner) and the operator-set product name (non-secret display
  // text). Unauthenticated by design (it must be visible on the login page);
  // it exposes nothing else.
  app.get("/api/runtime-config", async () => ({
    appEnv: config.appEnv,
    brandName: config.brandName,
  }));

  mountBetterAuth(app, { auth, config });
  registerOnboardingRoutes(app, { auth, db, config, guards });
  registerAdminRoutes(app, { auth, db, config, guards });
  registerAdminPayrollRoutes(app, {
    db,
    config,
    guards,
    ...(deps.onScheduleChange ? { onScheduleChange: deps.onScheduleChange } : {}),
  });
  registerPayslipRoutes(app, { db, guards });
  registerMyW2Routes(app, { db, config, guards });
  registerChangeRequestRoutes(app, { db, config, guards });
  registerMyRoutes(app, { db, config, guards });
  registerMyInvoiceRoutes(app, { db, guards });
  registerAdminNotificationRoutes(app, { db, config, guards });
  registerAdminEmployeeRoutes(app, { auth, db, config, guards });
  registerAdminSettingsRoutes(app, { db, config, guards });
  registerAdminContractorRoutes(app, { db, config, guards });
  registerAdminDepositRoutes(app, { db, config, guards });
  registerAdminCalendarRoutes(app, { db, guards });
  registerAdminFilingRoutes(app, { db, config, guards });
  registerAdminStateTaxRoutes(app, { db, guards });
  registerAdminLocalTaxRoutes(app, { db, config, guards });
  registerAdminAnnualFormRoutes(app, { db, config, guards });
  registerExportRoutes(app, { db, config });
  registerQaRoutes(app, { config }); // no-op unless APP_ENV=qa (spec 14 §3)
  registerStubRoutes(app, guards);

  // Serve the built SPA when present (spec 8: server serves the SPA).
  const publicDir = process.env.PUBLIC_DIR
    ? resolve(process.env.PUBLIC_DIR)
    : [resolve(process.cwd(), "public"), resolve(process.cwd(), "../web/dist")].find((p) =>
        existsSync(p),
      );
  if (publicDir) {
    await app.register(fastifyStatic, {
      root: publicDir,
      wildcard: true,
      setHeaders(res, path) {
        // Files under /assets/ (Vite emits content-hashed filenames there):
        // Cache-Control: public, max-age=31536000, immutable
        // index.html (and anything else): keep the current behavior (public, max-age=0)
        // index.html MUST stay revalidating, it is the deploy-detection mechanism for fallback #1
        if (path.includes("/assets/")) {
          res.header("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    });
  }
  app.setNotFoundHandler(async (req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/") && publicDir) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({ error: "not_found" });
  });

  return { app, auth, db, database, config };
}

export type BuiltApp = Awaited<ReturnType<typeof buildApp>>;
export type { FastifyInstance };

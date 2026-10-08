/**
 * Payroll API server entrypoint.
 *
 * Note (2026-08-19): the ghcr package `soult-io/payroll-app` is PUBLIC, matching
 * the repo — the published image is part of the open-source artifact surface and
 * is pullable by anyone. The package was recreated this day after deleting the
 * private pre-open-source one; CI-created packages inherit repo visibility.
 *
 * PAY-68 (2026-09-26): the repo is now soult-io/wagon-payroll and the image is
 * published as `soult-io/wagon-payroll`. `soult-io/payroll-app` received tags up
 * to v1.25.0 and receives nothing after it; its old tags stay pullable. Neither
 * package is ever deleted.
 */

import { buildApp } from "./app.js";
import { databaseUrl } from "./config.js";
import { startScheduler } from "./payroll/scheduler.js";
import { startRecurringInvoiceScheduler } from "./contractors/scheduler.js";
import { backfillW2Furnishings, sweepW2FurnishedFigures } from "./filings/w2-furnish.js";
import { errorClass } from "./filings/shared.js";

// Scheduler is wired here (not in buildApp) so integration tests boot the app
// without pg-boss, which needs a real Postgres.
const schedulerEnabled =
  process.env.SCHEDULER_ENABLED !== "false" && process.env.NODE_ENV !== "test";
// Spec 12 separate-scheduler amendment: the contractor recurring-invoice
// scheduler is registered and can be disabled INDEPENDENTLY of payroll.
const recurringSchedulerEnabled =
  process.env.RECURRING_SCHEDULER_ENABLED !== "false" && process.env.NODE_ENV !== "test";

let onScheduleChange: (() => Promise<void>) | undefined;
const { app, config, db } = await buildApp({
  ...(schedulerEnabled
    ? {
        onScheduleChange: async () => {
          await onScheduleChange?.();
        },
      }
    : {}),
});

const start = async () => {
  try {
    if (config.nodeEnv !== "production" && config.sessionSecret.startsWith("dev-only")) {
      app.log.warn(
        "using dev fallback session secret — set SECRETS_DIR/session-secret in production",
      );
    }
    // PAY-206 review round D4: the one-shot W-2 furnishing backfill runs at
    // boot (idempotent via its app_settings flag), before any request can
    // issue a late run. A failure never stops the boot; the daily tick retries.
    try {
      const backfill = await backfillW2Furnishings({ db, config });
      if (!backfill.skipped) app.log.info(`W-2 furnishing backfill: ${JSON.stringify(backfill)}`);
    } catch (err) {
      app.log.error(`W-2 furnishing backfill failed (${errorClass(err)})`);
    }
    // PAY-223: freeze the figures of furnishing rows written without a
    // freeze (previous release, rollback window). Counts only; a failure
    // never stops the boot and the daily tick retries.
    try {
      const sweep = await sweepW2FurnishedFigures({ db, config });
      if (sweep.frozen + sweep.unreconstructable + sweep.failed > 0) {
        app.log.info(`W-2 frozen figures sweep: ${JSON.stringify(sweep)}`);
      }
    } catch (err) {
      app.log.error(`W-2 frozen figures sweep failed (${errorClass(err)})`);
    }
    if (schedulerEnabled) {
      const scheduler = await startScheduler({ db, config, databaseUrl: databaseUrl(config) });
      onScheduleChange = scheduler.syncSchedules;
      app.addHook("onClose", async () => {
        await scheduler.stop();
      });
      app.log.info("pg-boss scheduler started");
    }
    if (recurringSchedulerEnabled) {
      const recurring = await startRecurringInvoiceScheduler({
        db,
        config,
        databaseUrl: databaseUrl(config),
      });
      app.addHook("onClose", async () => {
        await recurring.stop();
      });
      app.log.info("pg-boss contractor recurring-invoice scheduler started");
    }
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();

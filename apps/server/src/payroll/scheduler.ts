/**
 * Scheduler (spec payroll-engine D6): pg-boss against the app DB.
 *
 * - A monthly cron (from the company-wide pay_schedules row, draft day,
 *   default 15th) enqueues one job per auto-draft employee per period with
 *   singletonKey = "<employeeId>:<periodStart>" so retries can never
 *   double-generate (the DB UNIQUE(employee_id, period_start) is the second
 *   belt).
 * - Cron re-registers on boot and on pay-schedule change (syncSchedules).
 * - The email outbox drain worker (spec 6) sends pending rows via nodemailer
 *   (SMTP) or the dev log transport, with exponential backoff handled in
 *   notify/outbox.ts.
 *
 * This module only wires pg-boss; all business logic lives in runs.ts and is
 * integration-tested without pg-boss (which needs a real Postgres).
 */

import { PgBoss } from "pg-boss";
import nodemailer from "nodemailer";
import { eq, isNull } from "drizzle-orm";
import { authUser, employees, paySchedules } from "@payroll/db";
import { syncFormerEmployeeLogins } from "../auth/former-employee.js";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { generateDraftsForPeriod, monthlyPeriod } from "./runs.js";
import { drainOutbox, type MailTransport } from "../notify/outbox.js";
import { checkContractorFormExpiry } from "../contractors/service.js";
import { sendDepositReminders, syncDeposits } from "../deposits/service.js";
import { sendFilingReminders, syncFilings } from "../filings/service.js";
import { sendW2AvailableNotices, syncAnnualFilings } from "../filings/annual.js";
import {
  backfillW2Furnishings,
  reconcileW2Furnishings,
  sweepW2FurnishedFigures,
} from "../filings/w2-furnish.js";
import { sendW2TermsUpdateNotices } from "../filings/w2-consent.js";
import { errorClass } from "../filings/shared.js";

const TICK_QUEUE = "payroll-draft-tick";
const GENERATE_QUEUE = "payroll-generate-draft";
const OUTBOX_QUEUE = "email-outbox-drain";
const FORM_EXPIRY_QUEUE = "contractor-form-expiry";
const DEPOSIT_TICK_QUEUE = "tax-deposit-tick";

export interface Scheduler {
  boss: PgBoss;
  /** Re-read pay_schedules and re-register the cron (call after edits). */
  syncSchedules: () => Promise<void>;
  stop: () => Promise<void>;
}

function currentPeriod(): { year: number; month: number } {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

/** Run one annual step; a failure is logged by class only and never stops the next step. */
async function annualStep<T>(name: string, step: () => Promise<T>): Promise<T | null> {
  try {
    return await step();
  } catch (err) {
    console.error(`[filings] ${name} failed (${errorClass(err)})`);
    return null;
  }
}

/**
 * PAY-11: annual forms (940 + W-2/W-3) fold into the daily deposit tick —
 * year-end row sync, the PAY-206 W-2 furnishing backfill and corrections,
 * then the once-per-year W-2 availability notices. All idempotent. PAY-206
 * review round D5: no step's failure blocks the year notice.
 */
export async function annualTick(deps: { db: Db; config: AppConfig }): Promise<void> {
  const { db, config } = deps;
  const annualSync = await annualStep("annual sync", () => syncAnnualFilings({ db, config }));
  if (annualSync && annualSync.created + annualSync.refreshed > 0) {
    console.log(`[filings] annual sync: ${JSON.stringify(annualSync)}`);
  }
  // PAY-206: one-shot backfill of years the previous release notified,
  // then furnish any W-2 correction (R6) — both idempotent. Before the
  // year notice, so a correction is never delayed by it.
  const backfill = await annualStep("W-2 furnishing backfill", () =>
    backfillW2Furnishings({ db, config }),
  );
  if (backfill && backfill.inserted + backfill.failed > 0) {
    console.log(`[filings] W-2 furnishing backfill: ${JSON.stringify(backfill)}`);
  }
  const reconcile = await annualStep("W-2 reconcile", () => reconcileW2Furnishings({ db, config }));
  if (reconcile && reconcile.followUps + reconcile.failed > 0) {
    console.log(`[filings] W-2 corrections: ${JSON.stringify(reconcile)}`);
  }
  // PAY-223: after the reconcile (its corrections freeze on write), freeze
  // any furnishing row still without frozen figures. Counts only.
  const sweep = await annualStep("W-2 frozen figures sweep", () =>
    sweepW2FurnishedFigures({ db, config }),
  );
  if (sweep && sweep.frozen + sweep.unreconstructable + sweep.failed > 0) {
    console.log(`[filings] W-2 frozen figures sweep: ${JSON.stringify(sweep)}`);
  }
  // PAY-217: after the reconcile, so a correction posted online today
  // re-opens a former employee's sign-in the same day (SME R4); a closed
  // (j)(6) window bans the login. Counts only in the log.
  const formers = await annualStep("former-employee sign-in", () =>
    syncFormerEmployeeLogins({ db, config }),
  );
  if (formers && formers.ended + formers.restored + formers.failed > 0) {
    console.log(`[auth] former-employee sign-in: ${JSON.stringify(formers)}`);
  }
  // PAY-208 (D-D): once per employee per terms version — "please review the
  // updated online-W-2 terms" to consenters on earlier terms.
  const terms = await annualStep("W-2 terms notices", () =>
    sendW2TermsUpdateNotices({ db, config }),
  );
  if (terms && terms.sent > 0) {
    console.log(`[filings] W-2 terms notices: ${JSON.stringify(terms)}`);
  }
  const w2Notices = await annualStep("W-2 notices", () => sendW2AvailableNotices({ db, config }));
  if (w2Notices && w2Notices.sent > 0) {
    console.log(`[filings] W-2 notices: ${JSON.stringify(w2Notices)}`);
  }
}

export async function startScheduler(deps: {
  db: Db;
  config: AppConfig;
  databaseUrl: string;
}): Promise<Scheduler> {
  const { db, config } = deps;
  const boss = new PgBoss({
    connectionString: deps.databaseUrl,
    // Keep pg-boss's own schema out of the app's migration-managed schema.
    schema: "pgboss",
  });
  await boss.start();
  await boss.createQueue(TICK_QUEUE);
  await boss.createQueue(GENERATE_QUEUE);
  await boss.createQueue(OUTBOX_QUEUE);
  await boss.createQueue(FORM_EXPIRY_QUEUE);
  await boss.createQueue(DEPOSIT_TICK_QUEUE);

  // Cron tick → enqueue per-employee generation jobs (singleton per period).
  await boss.work(TICK_QUEUE, async () => {
    const schedules = await db.select().from(paySchedules).where(isNull(paySchedules.employeeId));
    const schedule = schedules[0];
    if (!schedule?.active || !schedule.autoDraft) return;
    const { year, month } = currentPeriod();
    const period = monthlyPeriod(year, month, schedule.payDayOfMonth);

    // Spec 10 §4: contractors never enter payroll_runs — W-2 employees only.
    const activeEmployees = await db
      .select({ id: employees.id })
      .from(employees)
      .where(eq(employees.employmentType, "w2"));
    for (const employee of activeEmployees) {
      await boss.send(
        GENERATE_QUEUE,
        { employeeId: employee.id, year, month },
        { singletonKey: `${employee.id}:${period.periodStart}` },
      );
    }
  });

  // Per-employee generation — idempotent at the DB level as well.
  await boss.work<{ employeeId: number; year: number; month: number }>(
    GENERATE_QUEUE,
    async (jobs) => {
      for (const job of jobs) {
        await generateDraftsForPeriod(
          { db, config },
          {
            year: job.data.year,
            month: job.data.month,
            employeeId: job.data.employeeId,
            autoDraftOnly: true,
            createdBy: "scheduler",
          },
        );
      }
    },
  );

  // Outbox drain (spec 6): nodemailer over SMTP, or the dev log transport.
  // Backoff / suppression / max-attempts all live in drainOutbox.
  const transport: MailTransport | undefined =
    config.emailMode === "smtp"
      ? nodemailer.createTransport({
          host: config.smtp.host,
          port: config.smtp.port,
          secure: config.smtp.secure,
          ...(config.smtp.user
            ? { auth: { user: config.smtp.user, pass: config.smtp.password ?? "" } }
            : {}),
        })
      : undefined;

  const resolveRecipientEmail = async (userId: string): Promise<string | null> => {
    const rows = await db
      .select({ email: authUser.email })
      .from(authUser)
      .where(eq(authUser.id, userId))
      .limit(1);
    return rows[0]?.email ?? null;
  };

  await boss.work(OUTBOX_QUEUE, async () => {
    const result = await drainOutbox({
      db,
      config,
      ...(transport ? { transport } : {}),
      resolveRecipientEmail,
      log: (msg) => console.log(msg),
    });
    if (result.sent + result.failed + result.suppressed + result.logged > 0) {
      console.log(`[outbox] drain: ${JSON.stringify(result)}`);
    }
  });

  // W-8 expiry sweep (spec 10 §4): admins are notified 30 days before a
  // contractor's form expires and again at expiry (payment gate re-arms).
  await boss.work(FORM_EXPIRY_QUEUE, async () => {
    const result = await checkContractorFormExpiry({ db, config });
    if (result.expiring + result.expired > 0) {
      console.log(`[contractors] form expiry sweep: ${JSON.stringify(result)}`);
    }
  });

  // PAY-9 daily deposit tick: sync the computed schedule (upsert pending rows,
  // recompute pending amounts, flip overdue), then mail due-date reminders.
  // PAY-10 folds the quarterly-filing sync + filing reminders into the same
  // daily tick. All four halves are idempotent — re-ticks never duplicate
  // rows or emails.
  await boss.work(DEPOSIT_TICK_QUEUE, async () => {
    const sync = await syncDeposits({ db, config });
    if (sync.created + sync.recomputed + sync.flippedOverdue + sync.superseded > 0) {
      console.log(`[deposits] sync: ${JSON.stringify(sync)}`);
    }
    const reminders = await sendDepositReminders({ db, config });
    if (reminders.sent > 0) {
      console.log(`[deposits] reminders: ${JSON.stringify(reminders)}`);
    }
    const filingSync = await syncFilings({ db, config });
    if (filingSync.created + filingSync.refreshed > 0) {
      console.log(`[filings] sync: ${JSON.stringify(filingSync)}`);
    }
    const filingReminders = await sendFilingReminders({ db, config });
    if (filingReminders.sent > 0) {
      console.log(`[filings] reminders: ${JSON.stringify(filingReminders)}`);
    }
    await annualTick({ db, config });
  });

  async function syncSchedules(): Promise<void> {
    const schedules = await db.select().from(paySchedules).where(isNull(paySchedules.employeeId));
    const schedule = schedules[0];
    await boss.unschedule(TICK_QUEUE);
    await boss.unschedule(OUTBOX_QUEUE);
    await boss.unschedule(FORM_EXPIRY_QUEUE);
    await boss.unschedule(DEPOSIT_TICK_QUEUE);
    if (schedule?.active) {
      // Draft day at 09:12 local (off-peak minute), display timezone per spec 1.
      await boss.schedule(TICK_QUEUE, `12 9 ${schedule.draftDayOfMonth} * *`, null, {
        tz: config.appTz,
      });
    }
    // Outbox drain every minute (spec 6 outbox worker).
    await boss.schedule(OUTBOX_QUEUE, "* * * * *", null, { tz: config.appTz });
    // W-8 expiry sweep daily at 08:23 local (off-peak minute).
    await boss.schedule(FORM_EXPIRY_QUEUE, "23 8 * * *", null, { tz: config.appTz });
    // PAY-9 deposit sync + reminders daily at 07:41 local (off-peak minute).
    await boss.schedule(DEPOSIT_TICK_QUEUE, "41 7 * * *", null, { tz: config.appTz });
  }

  await syncSchedules();

  return {
    boss,
    syncSchedules,
    stop: async () => {
      await boss.stop({ graceful: true, timeout: 5000 });
    },
  };
}

/**
 * Notification plumbing (spec 6): queueing helpers that render templates, and
 * the outbox drain worker (pg-boss calls it; tests drive it directly with a
 * stub TRANSPORT — the DB is never stubbed).
 *
 * Drain semantics: pending rows eligible by exponential backoff
 * (2^attempts minutes since last_attempt_at); workflow events the user opted
 * out of are marked 'suppressed'; security events bypass settings; 5 attempts
 * → 'failed' + last_error. Dev mode ('log') logs instead of sending.
 *
 * PAY-208 (D-A): a row with recipient_email goes to that address instead of
 * the user-id lookup (the sign-in-email-change notice to the OLD address).
 * The address is never logged and is cleared once the row is sent or fails
 * for good.
 */

import { and, asc, eq } from "drizzle-orm";
import { company, emailOutbox, notificationSettings } from "@payroll/db";
import { type TemplateContext, WORKFLOW_EVENTS } from "@payroll/notifications";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";

/** Minimal nodemailer-compatible transport (structural — stubbed in tests). */
export interface MailTransport {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<unknown>;
}

export const MAX_ATTEMPTS = 5;

/** Backoff: 2^attempts minutes after the last attempt (1, 2, 4, 8, 16…). */
function backoffMs(attempts: number): number {
  return 2 ** attempts * 60 * 1000;
}

export interface DrainResult {
  sent: number;
  suppressed: number;
  failed: number;
  retriedLater: number;
  logged: number;
}

export interface DrainDeps {
  db: Db;
  config: AppConfig;
  /** Required when config.emailMode === 'smtp'; ignored in 'log' mode. */
  transport?: MailTransport;
  /** Resolve recipient email address from user id. */
  resolveRecipientEmail: (userId: string) => Promise<string | null>;
  log?: (msg: string) => void;
}

/**
 * Drain eligible outbox rows. Idempotent and safe to run on any cadence —
 * ineligible rows are left pending for a later tick.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: outbox drain loop; per-row branches are the domain logic
export async function drainOutbox(deps: DrainDeps): Promise<DrainResult> {
  const { db, config } = deps;
  const result: DrainResult = { sent: 0, suppressed: 0, failed: 0, retriedLater: 0, logged: 0 };
  const log = deps.log ?? (() => {});

  const pending = await db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.status, "pending"))
    .orderBy(asc(emailOutbox.id));

  for (const row of pending) {
    // Exponential backoff: not yet eligible.
    if (row.attempts > 0 && row.lastAttemptAt) {
      const eligibleAt = row.lastAttemptAt.getTime() + backoffMs(row.attempts);
      if (Date.now() < eligibleAt) {
        result.retriedLater += 1;
        continue;
      }
    }

    // Workflow events respect notification_settings; security events bypass.
    if ((WORKFLOW_EVENTS as readonly string[]).includes(row.eventType)) {
      const settings = await db
        .select()
        .from(notificationSettings)
        .where(
          and(
            eq(notificationSettings.userId, row.userId),
            eq(notificationSettings.eventType, row.eventType),
          ),
        )
        .limit(1);
      if (settings[0] && !settings[0].enabled) {
        await db
          .update(emailOutbox)
          .set({ status: "suppressed" })
          .where(eq(emailOutbox.id, row.id));
        result.suppressed += 1;
        continue;
      }
    }

    if (config.emailMode === "log") {
      log(`[email:dev-log] to user ${row.userId} — ${row.subject}`);
      await db
        .update(emailOutbox)
        .set({
          status: "sent",
          sentAt: new Date(),
          attempts: row.attempts + 1,
          recipientEmail: null,
        })
        .where(eq(emailOutbox.id, row.id));
      result.logged += 1;
      continue;
    }

    try {
      if (!deps.transport) throw new Error("no mail transport configured");
      const to = row.recipientEmail ?? (await deps.resolveRecipientEmail(row.userId));
      if (!to) throw new Error(`no email address for user ${row.userId}`);
      await deps.transport.sendMail({
        from: config.smtp.from,
        to,
        subject: row.subject,
        html: row.bodyHtml,
        text: htmlToText(row.bodyHtml),
      });
      await db
        .update(emailOutbox)
        .set({
          status: "sent",
          sentAt: new Date(),
          attempts: row.attempts + 1,
          lastAttemptAt: new Date(),
          recipientEmail: null,
        })
        .where(eq(emailOutbox.id, row.id));
      result.sent += 1;
    } catch (err) {
      const attempts = row.attempts + 1;
      // S-M1: a row sent to an override address never stores the error
      // text (a mail server's reply names the address) — the class only.
      const message =
        row.recipientEmail !== null
          ? `send failed (${err instanceof Error ? err.constructor.name || "Error" : typeof err})`
          : err instanceof Error
            ? err.message
            : String(err);
      await db
        .update(emailOutbox)
        .set({
          attempts,
          lastError: message,
          lastAttemptAt: new Date(),
          ...(attempts >= MAX_ATTEMPTS ? { status: "failed", recipientEmail: null } : {}),
        })
        .where(eq(emailOutbox.id, row.id));
      result.failed += 1;
    }
  }
  return result;
}

/** text/plain fallback for rows queued before the template refactor stored html only. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Stand-in employer name when no company row exists yet (spec 22 D5). A
 * deployment that has completed company setup never reaches it.
 */
export const COMPANY_NAME_PLACEHOLDER = "Your company";

/** Company-name helper for template contexts (single company row per spec 1). */
export async function companyName(db: Pick<Db, "select">): Promise<string> {
  const rows = await db.select({ legalName: company.legalName }).from(company).limit(1);
  return rows[0]?.legalName ?? COMPANY_NAME_PLACEHOLDER;
}

/**
 * The one builder for email template contexts: employer name (from the
 * company row unless the caller already holds it), product name, app URL.
 */
export async function templateContext(
  db: Pick<Db, "select">,
  config: Pick<AppConfig, "baseUrl" | "brandName">,
  knownCompanyName?: string,
): Promise<TemplateContext> {
  return {
    companyName: knownCompanyName || (await companyName(db)),
    brandName: config.brandName,
    appUrl: config.baseUrl,
  };
}

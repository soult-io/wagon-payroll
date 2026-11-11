/**
 * PAY-259: the always-on security email when a passkey is added to or removed
 * from an account. It carries the device, IP and time, like the new-device
 * email, and never the passkey's name or anything from the key itself.
 */

import { emailOutbox } from "@payroll/db";
import { EVENT_TYPE, securityPasskeyAdded, securityPasskeyRemoved } from "@payroll/notifications";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { usableIp } from "../auth/audit.js";
import { templateContext } from "./outbox.js";

const KINDS = {
  added: { eventType: EVENT_TYPE.securityPasskeyAdded, render: securityPasskeyAdded },
  removed: { eventType: EVENT_TYPE.securityPasskeyRemoved, render: securityPasskeyRemoved },
} as const;

/**
 * The request's user agent and first X-Forwarded-For value are chosen by the
 * client, who may be the intruder this email warns about: bound the text and
 * show only a real IP address.
 */
const MAX_USER_AGENT_CHARS = 200;

/** "Nov 11, 2026, 2:32 PM UTC": people read this, unlike an ISO timestamp. */
function readableTime(at: Date): string {
  const when = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(at);
  return `${when} UTC`;
}

export async function queuePasskeyEmail(
  deps: { db: Db; config: AppConfig },
  input: {
    userId: string;
    kind: keyof typeof KINDS;
    userAgent: string | null;
    ip: string | null;
  },
): Promise<void> {
  const { eventType, render } = KINDS[input.kind];
  const rendered = render(await templateContext(deps.db, deps.config), {
    userAgent: input.userAgent?.slice(0, MAX_USER_AGENT_CHARS) ?? null,
    ip: usableIp(input.ip),
    at: readableTime(new Date()),
  });
  await deps.db.insert(emailOutbox).values({
    userId: input.userId,
    eventType,
    subject: rendered.subject,
    bodyHtml: rendered.html,
  });
}

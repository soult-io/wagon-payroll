/**
 * PAY-267: whether the dashboard should offer "add a passkey" to this user,
 * and the user's answer. "Not now" hides the offer for 30 days; "Don't ask
 * again" hides it for good, and a later "Not now" does not undo that.
 */

import { eq, sql } from "drizzle-orm";
import { authPasskey, passkeyPromptState } from "@payroll/db";
import type { Db } from "../db.js";
import { passkeyCount } from "./passkey-policy.js";

export const PASSKEY_PROMPT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

export type PasskeyPromptChoice = "not_now" | "never";

/** True when the user has no passkey and has not put the offer off. */
export async function passkeyPromptDue(db: Db, userId: string, now: Date): Promise<boolean> {
  if ((await passkeyCount(db, userId)) > 0) return false;
  const rows = await db
    .select()
    .from(passkeyPromptState)
    .where(eq(passkeyPromptState.userId, userId))
    .limit(1);
  const state = rows[0];
  if (!state) return true;
  if (state.dismissedAt) return false;
  return !state.snoozedUntil || state.snoozedUntil.getTime() <= now.getTime();
}

export async function recordPasskeyPromptChoice(
  db: Db,
  userId: string,
  choice: PasskeyPromptChoice,
  now: Date,
): Promise<void> {
  const change =
    choice === "never"
      ? { dismissedAt: now, updatedAt: now }
      : { snoozedUntil: new Date(now.getTime() + PASSKEY_PROMPT_SNOOZE_MS), updatedAt: now };
  await db
    .insert(passkeyPromptState)
    .values({ userId, ...change })
    .onConflictDoUpdate({ target: passkeyPromptState.userId, set: change });
}

/** Passkeys per user, for users with at least one (the admin Users table). */
export async function passkeyCountsByUser(db: Db): Promise<Record<string, number>> {
  const rows = await db
    .select({ userId: authPasskey.userId, n: sql<number>`count(*)::int` })
    .from(authPasskey)
    .groupBy(authPasskey.userId);
  return Object.fromEntries(rows.map((r) => [r.userId, r.n]));
}

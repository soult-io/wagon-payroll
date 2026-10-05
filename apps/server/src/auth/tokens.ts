/**
 * Setup tokens (spec 3 — invite-only registration).
 *
 * Single-use, random 32-byte tokens for invites and admin-initiated password
 * resets. Only the SHA-256 hash is stored (setup_tokens table); expiry ≤ 24h.
 * The same machinery serves both purposes (`purpose` column).
 */

import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, gt } from "drizzle-orm";
import { setupTokens } from "@payroll/db";
import type { Db } from "../db.js";

export const SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // ≤ 24h (spec 3)

export type SetupTokenPurpose = "invite" | "reset";

export function hashSetupToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Create a setup token; returns the PLAINTEXT token (shown/emailed once). */
export async function createSetupToken(
  db: Db,
  userId: string,
  purpose: SetupTokenPurpose,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SETUP_TOKEN_TTL_MS);
  await db.insert(setupTokens).values({
    userId,
    tokenHash: hashSetupToken(token),
    purpose,
    expiresAt,
  });
  return { token, expiresAt };
}

export type ValidSetupToken = typeof setupTokens.$inferSelect;

/** Look up a VALID (unused, unexpired) setup token by plaintext value. */
export async function findValidSetupToken(db: Db, token: string): Promise<ValidSetupToken | null> {
  const rows = await db
    .select()
    .from(setupTokens)
    .where(
      and(
        eq(setupTokens.tokenHash, hashSetupToken(token)),
        isNull(setupTokens.usedAt),
        gt(setupTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function consumeSetupToken(db: Db, id: number): Promise<void> {
  await db.update(setupTokens).set({ usedAt: new Date() }).where(eq(setupTokens.id, id));
}

/** Invalidate any outstanding tokens for a user (e.g. when a new one is issued). */
export async function revokeOutstandingSetupTokens(
  db: Pick<Db, "update">,
  userId: string,
): Promise<void> {
  await db
    .update(setupTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(setupTokens.userId, userId), isNull(setupTokens.usedAt)));
}

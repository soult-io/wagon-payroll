/**
 * Shared low-level helpers for the filings modules (service.ts = quarterly
 * 941, annual.ts = PAY-11 annual 940 + W-2/W-3). Extracted so both modules
 * stay small and import-cycle-free.
 */

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { payrollEntries } from "@payroll/db";
import type { taxAdjustments, taxFilings } from "@payroll/db";
import { round2 } from "@payroll/engine/money";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";

/**
 * Spec 24 (PAY-116): one advisory lock serializes marking a w2_w3 filing
 * filed with employer state ID writes, whose filed-year check must see
 * every filing marked filed before it writes.
 */
export const W2W3_FILING_LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('w2_w3_filing_state_ids'))`;

export type TaxFilingRow = typeof taxFilings.$inferSelect;
export type TaxAdjustmentRow = typeof taxAdjustments.$inferSelect;

export class FilingServiceError extends Error {
  constructor(
    public code: "not_found" | "invalid_input" | "invalid_transition",
    message: string,
  ) {
    super(message);
  }
}

export interface Deps {
  db: Db;
  config: AppConfig;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MONEY_RE = /^-?\d{1,10}(\.\d{1,2})?$/;

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** UTC-safe day arithmetic on ISO dates (no server-local timezone leakage). */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const toMoney = (n: number): string => round2(n).toFixed(2);

/** Sum one entry category across the given issued runs (exact, to the cent). */
export async function sumCategory(db: Db, runIds: number[], category: string): Promise<number> {
  if (runIds.length === 0) return 0;
  const rows = await db
    .select({
      total: sql<string>`coalesce(sum(${payrollEntries.amount}), 0)::numeric(14,2)::text`,
    })
    .from(payrollEntries)
    .where(
      and(
        sql`${payrollEntries.runId} IN (${sql.join(
          runIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
        eq(payrollEntries.category, category),
      ),
    );
  return Number(rows[0]?.total ?? "0");
}

/**
 * Canonical SHA-256 of a worksheet: object keys are sorted recursively
 * before stringifying, because Postgres JSONB does NOT preserve key order —
 * the hash of a row read back from the DB must equal the hash computed
 * before insert (snapshot-hash stability rule). Shape-agnostic: quarterly
 * 941 and annual 940/W-3 worksheets hash the same way.
 */
export function worksheetHash(worksheet: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, canonical(val)]),
      );
    }
    return v;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(worksheet)))
    .digest("hex");
}

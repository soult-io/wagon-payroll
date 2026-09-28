/**
 * PAY-163 (Spec 25 (PAY-120)) — local income-tax coverage seed loader.
 *
 * Loads seeds/local-taxes/coverage.json into local_tax_coverage. The table
 * converges to the file: rows are upserted on (code, basis) and rows no
 * longer in the file are deleted, in one transaction — so a run twice adds
 * nothing and a row the SME drops stops holding pay runs. A malformed file
 * throws before anything is written. `sourceVerified` stays in the file (a
 * review flag for the SME: false = the source was not fetched live yet).
 */

import { and, eq, or, sql } from "drizzle-orm";
import { localTaxCoverage } from "./schema.js";
import type { SeedDb } from "./seed.js";

import coverage from "./seeds/local-taxes/coverage.json" with { type: "json" };

export interface LocalTaxCoverageRow {
  /** USPS state ('OH') or locality code ('NY-NYC'). */
  code: string;
  basis: "residence" | "work";
  handling: "unsupported" | "engine";
  note: string;
  source: string;
  sourceVerified: boolean;
}

export interface LocalTaxCoverageFile {
  description: string;
  reviewed: string;
  rows: LocalTaxCoverageRow[];
}

export const LOCAL_TAX_COVERAGE_FILE = coverage as LocalTaxCoverageFile;

const CODE_RE = /^[A-Z]{2}(-[A-Z0-9]{2,10})?$/;

/** What is wrong with one coverage row, or null. */
function rowProblem(row: LocalTaxCoverageRow): string | null {
  if (!CODE_RE.test(row.code)) return "bad code";
  if (row.basis !== "residence" && row.basis !== "work") return "bad basis";
  if (row.handling !== "unsupported" && row.handling !== "engine") return "bad handling";
  if (typeof row.source !== "string" || row.source.trim().length === 0) return "source is required";
  if (typeof row.note !== "string") return "bad note";
  if (typeof row.sourceVerified !== "boolean") return "sourceVerified must be true or false";
  return null;
}

/** Fail fast on a malformed coverage file — an empty or broken list must never load. */
export function validateCoverageFile(file: LocalTaxCoverageFile): void {
  if (!Array.isArray(file.rows) || file.rows.length === 0) {
    throw new Error("local tax coverage: the file has no rows");
  }
  const seen = new Set<string>();
  file.rows.forEach((row, index) => {
    const problem = rowProblem(row);
    if (problem) throw new Error(`local tax coverage row ${index + 1}: ${problem}`);
    const key = `${row.code}:${row.basis}`;
    if (seen.has(key)) throw new Error(`local tax coverage ${key}: duplicate row`);
    seen.add(key);
  });
}

/** Load the coverage list (idempotent; converges the table to the file). */
export async function seedLocalTaxCoverage(
  db: SeedDb,
  file: LocalTaxCoverageFile = LOCAL_TAX_COVERAGE_FILE,
): Promise<void> {
  validateCoverageFile(file);
  await db.transaction(async (tx) => {
    const keep = file.rows.map((r) =>
      and(eq(localTaxCoverage.code, r.code), eq(localTaxCoverage.basis, r.basis)),
    );
    // Delete every row not in the file: NOT (row1 OR row2 OR …).
    await tx.delete(localTaxCoverage).where(sql`NOT (${or(...keep)})`);
    for (const row of file.rows) {
      const values = {
        code: row.code,
        basis: row.basis,
        handling: row.handling,
        note: row.note,
        source: row.source,
        updatedAt: new Date(),
      };
      await tx
        .insert(localTaxCoverage)
        .values(values)
        .onConflictDoUpdate({
          target: [localTaxCoverage.code, localTaxCoverage.basis],
          set: {
            handling: values.handling,
            note: values.note,
            source: values.source,
            updatedAt: values.updatedAt,
          },
        });
    }
  });
}

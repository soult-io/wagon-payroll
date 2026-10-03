/**
 * Per-employee advisory lock (Spec 26 D4, PAY-206 R10). Serialises run
 * generation / approve / issue / void and every W-2 furnishing write of one
 * employee: two runs of one employee can never be issued in parallel with
 * each other's YTD missing, and a furnishing record always sees the figures
 * of the runs issued before it. Transaction-scoped; released at
 * commit/rollback. Global lock order: payroll_run_employee:{id} →
 * FILING_CLOSE_LOCK → SYNC_LOCK.
 */

import { sql } from "drizzle-orm";
import type { Db } from "../db.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function lockEmployee(tx: Pick<Tx, "execute">, employeeId: number): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`payroll_run_employee:${employeeId}`}))`,
  );
}

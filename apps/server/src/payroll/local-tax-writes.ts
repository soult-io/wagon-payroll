/**
 * PAY-163 (Spec 25 (PAY-120)) — residence and work-locality writes.
 *
 * Every write reads the row it changes INSIDE its transaction, locked with
 * SELECT … FOR UPDATE, and takes the audit before-state from that read, so
 * two admins saving at once cannot both act on the same stale row. Audit
 * events carry codes and dates only.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import { auditEvents, employeeResidences, employeeWorkStates } from "@payroll/db";
import { type ResidenceInput, workLocalityProblem } from "@payroll/shared";
import { type Db, hasPgErrorCode } from "../db.js";
import { type ResidenceRow, resolveWorkState } from "./resolve.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** A root db or a transaction: both can read and write. */
type Writer = Db | Tx;
type WorkStateRow = typeof employeeWorkStates.$inferSelect;

/** Audit payload for a residence: codes and dates only. */
function residenceAudit(row: ResidenceRow) {
  return {
    country: row.country,
    stateCode: row.stateCode,
    localityCode: row.localityCode,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    source: row.source,
  };
}

/** Audit payload for a work-state locality: codes and dates only. */
function workLocalityAudit(row: WorkStateRow) {
  return {
    stateCode: row.stateCode,
    localityCode: row.localityCode,
    localityConfirmed: row.localityConfirmedAt !== null,
    effectiveFrom: row.effectiveFrom,
  };
}

async function audit(
  tx: Writer,
  actorId: string,
  action: string,
  employeeId: number,
  before: unknown,
  after: unknown,
) {
  await tx.insert(auditEvents).values({
    actorId,
    action,
    entity: "employee",
    entityId: String(employeeId),
    before,
    after,
  });
}

/**
 * Why a residence cannot be written against the open row, or null. "Still
 * the same" must repeat the open row's place; a new row must not start before
 * the open row (the same start date corrects the open row instead).
 */
function residenceConflict(
  previous: ResidenceRow | undefined,
  input: ResidenceInput,
): "not_same_as_before" | "invalid_effective_from" | null {
  if (input.sameAsBefore) {
    const same =
      previous !== undefined &&
      previous.country === input.country &&
      previous.stateCode === input.stateCode &&
      previous.localityCode === input.localityCode;
    if (!same) return "not_same_as_before";
  }
  if (!previous) return null;
  if (input.effectiveFrom < previous.effectiveFrom) return "invalid_effective_from";
  // Confirming "still the same" on the day the open row starts has nothing to confirm.
  if (input.sameAsBefore && input.effectiveFrom === previous.effectiveFrom) {
    return "invalid_effective_from";
  }
  return null;
}

/** Postgres unique / exclusion violations → the caller's 409. */
function isWindowConflict(err: unknown): boolean {
  return hasPgErrorCode(err, ["23505", "23P01"]);
}

/** The first row RETURNING produced (an INSERT always produces one). */
function first<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error("expected one row");
  return row;
}

/**
 * Same start date as the open row: fix that row's place (a data-entry
 * correction). Only changes a row that is STILL open and still starts on
 * that date; returns null (and writes nothing) when it no longer is. The row
 * keeps its source.
 */
export async function correctOpenResidence(
  tx: Writer,
  previous: ResidenceRow,
  request: ResidenceInput,
  actorId: string,
): Promise<ResidenceRow | null> {
  const rows = await tx
    .update(employeeResidences)
    .set({
      country: request.country,
      stateCode: request.stateCode,
      localityCode: request.localityCode,
    })
    .where(
      and(
        eq(employeeResidences.id, previous.id),
        isNull(employeeResidences.effectiveTo),
        eq(employeeResidences.effectiveFrom, previous.effectiveFrom),
      ),
    )
    .returning();
  const row = rows[0];
  if (!row) return null;
  await audit(
    tx,
    actorId,
    "employee_residence.correct",
    previous.employeeId,
    residenceAudit(previous),
    residenceAudit(row),
  );
  return row;
}

/** New residence from `request.effectiveFrom`; closes the open row there. */
async function addResidence(
  tx: Tx,
  employeeId: number,
  previous: ResidenceRow | undefined,
  request: ResidenceInput,
  actorId: string,
): Promise<ResidenceRow> {
  if (previous) {
    await tx
      .update(employeeResidences)
      .set({ effectiveTo: request.effectiveFrom })
      .where(eq(employeeResidences.id, previous.id));
  }
  const row = first(
    await tx
      .insert(employeeResidences)
      .values({
        employeeId,
        country: request.country,
        stateCode: request.stateCode,
        localityCode: request.localityCode,
        effectiveFrom: request.effectiveFrom,
        source: "admin",
        createdBy: actorId,
      })
      .returning(),
  );
  await audit(
    tx,
    actorId,
    request.sameAsBefore ? "employee_residence.confirm" : "employee_residence.assign",
    employeeId,
    previous ? residenceAudit(previous) : null,
    residenceAudit(row),
  );
  return row;
}

export type ResidenceWrite =
  | { status: 200 | 201; row: ResidenceRow }
  | { status: 409; error: "not_same_as_before" | "invalid_effective_from" };

/**
 * Correct, confirm ("still the same", dated `today`) or add a residence, in
 * one transaction against the open row read with FOR UPDATE.
 */
export async function writeResidence(
  db: Db,
  employeeId: number,
  input: ResidenceInput,
  actorId: string,
  today: string,
): Promise<ResidenceWrite> {
  try {
    return await db.transaction(async (tx): Promise<ResidenceWrite> => {
      const open = await tx
        .select()
        .from(employeeResidences)
        .where(
          and(
            eq(employeeResidences.employeeId, employeeId),
            isNull(employeeResidences.effectiveTo),
          ),
        )
        .orderBy(desc(employeeResidences.effectiveFrom))
        .limit(1)
        .for("update");
      const previous = open[0];
      const request = input.sameAsBefore ? { ...input, effectiveFrom: today } : input;
      const conflict = residenceConflict(previous, request);
      if (conflict) return { status: 409, error: conflict };
      if (previous && previous.effectiveFrom === request.effectiveFrom) {
        const corrected = await correctOpenResidence(tx, previous, request, actorId);
        if (!corrected) return { status: 409, error: "invalid_effective_from" };
        return { status: 200, row: corrected };
      }
      const row = await addResidence(tx, employeeId, previous, request, actorId);
      return { status: 201, row };
    });
  } catch (err) {
    if (isWindowConflict(err)) return { status: 409, error: "invalid_effective_from" };
    throw err;
  }
}

export type WorkLocalityWrite =
  | { status: 200; row: WorkStateRow }
  | { status: 409; error: "no_open_work_state" | "work_state_ended" }
  | { status: 400; problem: string };

/**
 * Answer the work-locality question for the work-state row in force on
 * `effectiveOn`. A row that ended before `today` is history and is refused.
 */
export async function answerWorkLocality(
  db: Db,
  employeeId: number,
  answer: { localityCode: string | null; effectiveOn: string },
  actorId: string,
  today: string,
): Promise<WorkLocalityWrite> {
  return db.transaction(async (tx): Promise<WorkLocalityWrite> => {
    const target = await resolveWorkState(tx, employeeId, answer.effectiveOn);
    if (!target) return { status: 409, error: "no_open_work_state" };
    const locked = await tx
      .select()
      .from(employeeWorkStates)
      .where(eq(employeeWorkStates.id, target.id))
      .for("update");
    const row = locked[0];
    if (!row) return { status: 409, error: "no_open_work_state" };
    if (row.effectiveTo !== null && row.effectiveTo <= today) {
      return { status: 409, error: "work_state_ended" };
    }
    const problem = workLocalityProblem(row.stateCode, answer.localityCode);
    if (problem) return { status: 400, problem };

    const after = first(
      await tx
        .update(employeeWorkStates)
        .set({
          localityCode: answer.localityCode,
          localityConfirmedAt: new Date(),
          localityConfirmedBy: actorId,
        })
        .where(eq(employeeWorkStates.id, row.id))
        .returning(),
    );
    await audit(
      tx,
      actorId,
      "employee_work_state.locality",
      employeeId,
      workLocalityAudit(row),
      workLocalityAudit(after),
    );
    return { status: 200, row: after };
  });
}

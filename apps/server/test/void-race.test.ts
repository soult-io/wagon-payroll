/**
 * Void race (PAY-173 review, MEDIUM 3). Void reads the run, then updates it.
 * If an issue commits between the read and the UPDATE, an unconditional
 * `WHERE id = …` UPDATE would turn the issued run void (the DB immutability
 * trigger allows issued→void). Void must take the per-employee run lock and
 * update only when the status is still the one it read; otherwise 409.
 *
 * PGlite has one connection, so the race is emulated: the run is issued in
 * the DB while every read inside void's transaction still sees it as
 * 'approved' — the view void had before the parallel issue committed.
 * Synthetic people.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { seedDatabase, type SeedDb } from "@payroll/db";
import type { Db } from "../src/db.js";
import { transitionRun } from "../src/payroll/runs.js";
import { PayrollServiceError } from "../src/payroll/errors.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { createEmployee, insertIssuedHistoryRun, monthPeriod, runRow } from "./pay-date-helpers.js";

let t: TestContext;

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
}, 120_000);

afterAll(async () => {
  await t.close();
});

type AnyObj = Record<string | symbol, unknown>;

/** Wrap a drizzle builder so its awaited rows pass through `map`. */
function mapRows(builder: unknown, map: (row: AnyObj) => AnyObj): unknown {
  if (!builder || typeof builder !== "object") return builder;
  return new Proxy(builder as AnyObj, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop === "then") {
        return (ok?: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
          (value as (...a: unknown[]) => Promise<unknown>).call(
            target,
            (rows: unknown) => ok?.(Array.isArray(rows) ? rows.map((r) => map(r as AnyObj)) : rows),
            fail,
          );
      }
      return (...args: unknown[]) =>
        mapRows((value as (...a: unknown[]) => unknown).apply(target, args), map);
    },
  });
}

/**
 * A Db whose transactions see run `publicId` as 'approved' (stale read) and
 * record every raw SQL statement executed.
 */
function staleDb(db: Db, publicId: string, executed: string[]): Db {
  const dialect = new PgDialect();
  const stale = (row: AnyObj) =>
    row["publicId"] === publicId && row["status"] === "issued"
      ? { ...row, status: "approved" }
      : row;
  const wrapTx = (tx: AnyObj) =>
    new Proxy(tx, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === "select") {
          return (...args: unknown[]) =>
            mapRows((value as (...a: unknown[]) => unknown).apply(target, args), stale);
        }
        if (prop === "execute") {
          return (query: SQL) => {
            executed.push(dialect.sqlToQuery(query).sql);
            return (value as (q: SQL) => unknown).call(target, query);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db as unknown as AnyObj, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "transaction") {
        return (fn: (tx: unknown) => Promise<unknown>, cfg?: unknown) =>
          (value as (f: unknown, c?: unknown) => Promise<unknown>).call(
            target,
            (tx: AnyObj) => fn(wrapTx(tx)),
            cfg,
          );
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as Db;
}

describe("void vs a parallel issue", () => {
  it("takes the employee run lock, updates only from the status it read, and answers 409 when it changed", async () => {
    const emp = await createEmployee(t, 500_000);
    const run = await insertIssuedHistoryRun(t, emp, monthPeriod("2026-05", "2026-05-15"), {
      gross_pay: 500_000,
    });

    const executed: string[] = [];
    const outcome = await transitionRun(
      { db: staleDb(t.db, run.publicId, executed), config: t.config },
      { publicId: run.publicId, action: "void", actorId: "void-race-admin", reason: "race" },
    ).then(
      () => "voided",
      (err: unknown) => (err instanceof PayrollServiceError ? err.code : String(err)),
    );

    const after = await runRow(t, run.id);
    expect({
      outcome,
      locked: executed.some((q) => q.includes("pg_advisory_xact_lock")),
      status: after.status,
      voidedAt: after.voidedAt,
    }).toEqual({
      outcome: "invalid_transition",
      locked: true,
      status: "issued",
      voidedAt: null,
    });
  });
});

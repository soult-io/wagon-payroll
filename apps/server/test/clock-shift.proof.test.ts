/**
 * PAY-220: prove the clock shift is live — or, in a normal run, absent.
 *
 * The clock-shift CI job runs this file on its own before the full suite, with
 * PAYROLL_CLOCK_SHIFT_DAYS and PAYROLL_CLOCK_TARGET from scripts/clock-target.mjs.
 * It fails closed: a shift variable without the other, a missing preload, or a
 * PGlite clock that does not follow the JS clock is a failure, never a skip.
 */
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const SHIFT_MARK = Symbol.for("wagon-payroll.clock-shift");
const DAY_MS = 86_400_000;
const shiftDays = process.env.PAYROLL_CLOCK_SHIFT_DAYS ?? "";
const target = process.env.PAYROLL_CLOCK_TARGET ?? "";

type ShiftInfo = { days: number; realNow: () => number };
const shiftInfo = (Date as unknown as Record<symbol, ShiftInfo | undefined>)[SHIFT_MARK];

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe("clock shift (PAY-220)", () => {
  it("shift variables are set together or not at all", () => {
    expect(shiftDays === "", "PAYROLL_CLOCK_SHIFT_DAYS and PAYROLL_CLOCK_TARGET").toBe(
      target === "",
    );
  });

  // The CI job sets CLOCK_SHIFT_REQUIRED=1: empty shift variables there are a
  // broken job, not an unshifted run.
  it.runIf(process.env.CLOCK_SHIFT_REQUIRED === "1")("shift is required: variables are set", () => {
    expect(shiftDays, "CLOCK_SHIFT_REQUIRED=1 but PAYROLL_CLOCK_SHIFT_DAYS is empty").not.toBe("");
    expect(target, "CLOCK_SHIFT_REQUIRED=1 but PAYROLL_CLOCK_TARGET is empty").not.toBe("");
  });

  it.runIf(shiftDays === "")("no shift: Date is the real clock", () => {
    expect(shiftInfo).toBeUndefined();
  });

  it.runIf(shiftDays !== "")("JS clock and PGlite current_date are at the target", async () => {
    expect(shiftInfo, "scripts/clock-shift.mjs was not preloaded").toBeDefined();
    const info = shiftInfo as ShiftInfo;
    expect(info.days).toBe(Number(shiftDays));

    const jsToday = utcDate(Date.now());
    // The job may cross UTC midnight between computing the offset and this
    // check; then the shifted date is the day after the target, never earlier.
    const dayAfter = utcDate(Date.parse(`${target}T00:00:00Z`) + DAY_MS);
    expect([target, dayAfter]).toContain(jsToday);
    expect(jsToday).toBe(utcDate(info.realNow() + info.days * DAY_MS));

    const pg = new PGlite();
    try {
      await pg.exec("SET TimeZone = 'UTC'");
      const { rows } = await pg.query<{ today: string }>("select current_date::text as today");
      console.log(`clock-shift proof: target=${target} js=${jsToday} pglite=${rows[0]?.today}`);
      expect(rows[0]?.today).toBe(jsToday);
    } finally {
      await pg.close();
    }
  });
});

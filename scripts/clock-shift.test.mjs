// PAY-220: self-test for scripts/clock-target.mjs and scripts/clock-shift.mjs.
// Run: pnpm test:clock-shift   (needs `pnpm -r run build` for the seed export)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseShiftDays } from "./clock-shift.mjs";
import { clockTarget, loadBundledYears, shiftDays } from "./clock-target.mjs";

const SHIFT = fileURLToPath(new URL("./clock-shift.mjs", import.meta.url));
const at = (iso) => Date.parse(iso);

/** Run `node -e <code>` with the shift env and the given --import list. */
function runNode(imports, code, days = "90") {
  const args = imports.flatMap((spec) => ["--import", spec]);
  return spawnSync(process.execPath, [...args, "-e", code], {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "", PAYROLL_CLOCK_SHIFT_DAYS: days },
  });
}

test("target is Jan 2 of the year after the latest bundled year", () => {
  assert.equal(clockTarget([2025, 2026]), "2027-01-02");
  assert.equal(clockTarget([2026, 2025]), "2027-01-02");
  assert.equal(clockTarget([2025, 2026, 2027]), "2028-01-02");
  assert.throws(() => clockTarget([]), /no bundled federal tax years/);
  assert.throws(() => clockTarget(["2026"]), /integers/);
});

test("target comes from the BUNDLED_FEDERAL_TAX_YEARS export of the seed", async () => {
  const years = await loadBundledYears();
  assert.ok(Array.isArray(years) && years.length > 0, "export is a non-empty array");
  assert.equal(clockTarget(years), `${Math.max(...years) + 1}-01-02`);
});

test("shift days: whole UTC days to the target, across a year rollover", () => {
  assert.equal(shiftDays(at("2026-10-04T12:00:00Z"), "2027-01-02"), 90);
  // Time of day does not matter: the offset is from the UTC calendar date.
  assert.equal(shiftDays(at("2026-10-04T00:00:00Z"), "2027-01-02"), 90);
  assert.equal(shiftDays(at("2026-10-04T23:59:59Z"), "2027-01-02"), 90);
  assert.equal(shiftDays(at("2026-12-31T23:00:00Z"), "2027-01-02"), 2);
  assert.equal(shiftDays(at("2027-01-02T08:00:00Z"), "2027-01-02"), 0);
  // Tables not yet seeded and the target already passed: shift backwards.
  assert.equal(shiftDays(at("2027-03-01T08:00:00Z"), "2027-01-02"), -58);
  // Leap year 2028.
  assert.equal(shiftDays(at("2027-12-30T10:00:00Z"), "2028-03-01"), 62);
});

test("PAYROLL_CLOCK_SHIFT_DAYS must be whole days; unset/empty is a no-op", () => {
  assert.equal(parseShiftDays(undefined), null);
  assert.equal(parseShiftDays(""), null);
  assert.equal(parseShiftDays("90"), 90);
  assert.equal(parseShiftDays("-3"), -3);
  assert.throws(() => parseShiftDays("1.5"), /whole number of days/);
  assert.throws(() => parseShiftDays("7776000000ms"), /whole number of days/);
});

test("preload shifts Date, Date.now and Date() and keeps explicit dates", () => {
  const probe = `
    const info = Date[Symbol.for("wagon-payroll.clock-shift")];
    process.stdout.write(JSON.stringify({
      newDate: new Date().getTime() - info.realNow(),
      now: Date.now() - info.realNow(),
      call: typeof Date(),
      fixed: new Date("2026-01-01T00:00:00Z").toISOString(),
      inst: new Date() instanceof Date,
    }));`;
  const r = runNode([SHIFT], probe);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const ninetyDays = 90 * 86_400_000;
  assert.ok(Math.abs(out.newDate - ninetyDays) < 1000, r.stdout);
  assert.ok(Math.abs(out.now - ninetyDays) < 1000, r.stdout);
  assert.equal(out.call, "string");
  assert.equal(out.fixed, "2026-01-01T00:00:00.000Z");
  assert.equal(out.inst, true);
});

test("double-shift guard: a second load in the same process throws", () => {
  // A different URL for the same file defeats the ESM cache, as a second
  // mechanism (another path, a setup file) would.
  const r = runNode([SHIFT, `${new URL("./clock-shift.mjs?second", import.meta.url).href}`], "");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Date is already shifted/);
});

test("no shift without PAYROLL_CLOCK_SHIFT_DAYS", () => {
  const r = runNode(
    [SHIFT],
    'process.stdout.write(String(Symbol.for("wagon-payroll.clock-shift") in Date))',
    "",
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "false");
});

test("refused in production", () => {
  const r = spawnSync(process.execPath, ["--import", SHIFT, "-e", ""], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      NODE_ENV: "production",
      PAYROLL_CLOCK_SHIFT_DAYS: "1",
    },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refused in production/);
});

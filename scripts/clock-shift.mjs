// PAY-220: shift the process clock forward by PAYROLL_CLOCK_SHIFT_DAYS whole
// days. Test/CI only. Loaded with `node --import` (the server vitest config
// passes it to every worker via `execArgv`; the e2e job passes it through
// NODE_OPTIONS). A no-op when the variable is unset or empty.
//
// The offset is computed ONCE per job (scripts/clock-target.mjs) and passed in,
// never per process: every process (vitest workers, the Playwright runner, the
// e2e webServer) then agrees on "now". Whole days keep TOTP 30-second windows
// aligned across processes. The clock still runs: shifted now = real now +
// offset, so tight sequential DB writes keep distinct timestamps.
//
// Loading it twice in one process (for example NODE_OPTIONS=--import plus the
// vitest execArgv under a different path) would shift twice. The second load
// throws instead.

const SHIFT_MARK = Symbol.for("wagon-payroll.clock-shift");
const DAY_MS = 86_400_000;

/** Parse PAYROLL_CLOCK_SHIFT_DAYS. Returns null when unset/empty. */
export function parseShiftDays(raw) {
  if (raw === undefined || raw === "") return null;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`PAYROLL_CLOCK_SHIFT_DAYS must be a whole number of days, got "${raw}"`);
  }
  return Number(raw);
}

/** Replace globalThis.Date with a copy whose "now" is `days` days later. */
export function installClockShift(days) {
  const RealDate = globalThis.Date;
  if (Object.hasOwn(RealDate, SHIFT_MARK)) {
    throw new Error(
      "clock-shift: Date is already shifted in this process — load scripts/clock-shift.mjs once only",
    );
  }
  const offset = days * DAY_MS;
  // A function, not a class: `Date()` called without `new` must still work.
  function ShiftedDate(...args) {
    if (!new.target) return new RealDate(RealDate.now() + offset).toString();
    return Reflect.construct(
      RealDate,
      args.length === 0 ? [RealDate.now() + offset] : args,
      new.target,
    );
  }
  Object.setPrototypeOf(ShiftedDate, RealDate);
  ShiftedDate.prototype = RealDate.prototype;
  // Look like the built-in to code that inspects it (Date.name, Date.length).
  Object.defineProperty(ShiftedDate, "name", { value: "Date" });
  Object.defineProperty(ShiftedDate, "length", { value: 7 });
  ShiftedDate.now = () => RealDate.now() + offset;
  Object.defineProperty(ShiftedDate, SHIFT_MARK, {
    value: { days, realNow: () => RealDate.now() },
  });
  globalThis.Date = ShiftedDate;
}

const days = parseShiftDays(process.env.PAYROLL_CLOCK_SHIFT_DAYS);
if (days !== null) {
  if (process.env.NODE_ENV === "production") throw new Error("clock-shift refused in production");
  installClockShift(days);
}

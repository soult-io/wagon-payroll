/**
 * PAY-193 (D9.8): year-end warning shared by the admin dashboard and the run
 * view. Phase and year come only from the server (company-local date), never
 * from the browser clock.
 *
 * PAY-193 L4 (late issue) will let a past-year payroll be issued: the
 * after-year-end copy below says it can't be, so it MUST change when L4 ships.
 */

import { computed, ref } from "vue";
import { adminPayrollApi, isOpenRun, type PayrollRunRow, type YearEndStatus } from "../lib/api";
import { useDates } from "./useDates";

export function useYearEndWarning() {
  const { date } = useDates();
  const yearEnd = ref<YearEndStatus | null>(null);

  /** A reminder; the page works without it, so a failed read shows nothing. */
  async function load(): Promise<void> {
    try {
      yearEnd.value = await adminPayrollApi.yearEnd();
    } catch {
      yearEnd.value = null;
    }
  }

  const dueSentence = computed(() => {
    const ye = yearEnd.value;
    return ye?.closesOn && ye.year !== null
      ? ` Your first ${ye.year} year-end tax return is due by ${date(ye.closesOn)}.`
      : "";
  });

  /** Dashboard banner text, or null outside the window. */
  const dashboardText = computed(() => {
    const ye = yearEnd.value;
    if (!ye?.phase || ye.year === null) return null;
    const n = ye.openRuns.length;
    const y = ye.year;
    const due = dueSentence.value;
    if (ye.phase === "december") {
      const base = `Payrolls you pay in ${y} must be issued here by ${date(`${y}-12-31`)} to count in ${y}.`;
      if (n === 0) return base;
      return n === 1
        ? `${base} 1 payroll is still waiting to be issued.`
        : `${base} ${n} payrolls are still waiting to be issued.`;
    }
    if (n === 0) return `All your ${y} payrolls are issued.${due}`;
    return n === 1
      ? `1 payroll with a ${y} pay date wasn't issued before the year ended, and Wagon Payroll can't add it to ${y} yet. Don't change its pay date. Keep your own record of the payment and make sure it's in your ${y} tax filings.${due}`
      : `${n} payrolls with ${y} pay dates weren't issued before the year ended, and Wagon Payroll can't add them to ${y} yet. Don't change their pay dates. Keep your own record of these payments and make sure they're in your ${y} tax filings.${due}`;
  });

  /** Run-view notice for a run still to issue with a pay date in the warning's year, else null. */
  function runNotice(r: PayrollRunRow | null): string | null {
    const ye = yearEnd.value;
    if (!ye?.phase || ye.year === null || !r) return null;
    if (!isOpenRun(r.status)) return null;
    if (Number(r.payDate.slice(0, 4)) !== ye.year) return null;
    const y = ye.year;
    if (ye.phase === "december") {
      return `This payroll's pay date is in ${y}. Issue it by ${date(`${y}-12-31`)} so it counts in ${y}.`;
    }
    return `This payroll's pay date, ${date(r.payDate)}, is in ${y}, which has ended. Wagon Payroll can't add a payroll to ${y} yet, so this one can't be issued. If you paid it on that date, don't change the date. Keep your own record of the payment and make sure it's in your ${y} tax filings.${dueSentence.value}`;
  }

  return { yearEnd, load, dueSentence, dashboardText, runNotice };
}

/**
 * PAY-193 (D9.8): year-end warning shared by the admin dashboard and the run
 * view. Phase and year come only from the server (company-local date), never
 * from the browser clock.
 *
 * After PAY-193 L4 a past-year payroll can be issued through the late dialog,
 * so the after-year-end copy tells the owner to issue it before filing.
 */

import { computed, ref } from "vue";
import { adminPayrollApi, isOpenRun, type PayrollRunRow, type YearEndStatus } from "../lib/api";
import { useDates } from "./useDates";

export function useYearEndWarning() {
  const { date, longDate } = useDates();
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

  /** ", and by {closesOn} at the latest" (copy 4.4: empty when closesOn is unknown). */
  const byClosesOn = computed(() => {
    const closesOn = yearEnd.value?.closesOn;
    return closesOn ? `, and by ${longDate(closesOn)} at the latest` : "";
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
    const by = byClosesOn.value;
    return n === 1
      ? `1 payroll with a ${y} pay date isn't issued yet. If you paid it on that date, issue it before you file any ${y} fourth-quarter or year-end tax return${by}. Keep the pay date as it is. If you didn't pay it in ${y}, void it and generate it again with the date you actually pay.`
      : `${n} payrolls with ${y} pay dates aren't issued yet. If you paid them on those dates, issue them before you file any ${y} fourth-quarter or year-end tax return${by}. Keep their pay dates as they are. If you didn't pay one in ${y}, void it and generate it again with the date you actually pay.`;
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
    return `This payroll's pay date, ${longDate(r.payDate)}, is in ${y}, which has ended. If you paid it on that date, issue it before you file any ${y} fourth-quarter or year-end tax return${byClosesOn.value}. You'll be asked to confirm the amount you paid. Keep the pay date as it is. If you didn't pay it on that date, void it and generate it again with the date you actually pay.`;
  }

  return { yearEnd, load, dueSentence, dashboardText, runNotice };
}

/**
 * PAY-193 L2 (spec D9.8): the date by which each state's Q4 withholding,
 * SUI or annual return for a tax year is due — the last day the year-end
 * warning stays up for an employer with staff in that state.
 *
 * Data from the state SME table for tax year 2026 (read 2026-10-03). Each
 * date is the "safe closesOn": the EARLIEST due date across filer statuses
 * (monthly vs quarterly), and Jan 31 with no weekend roll where the agency
 * text does not state a roll. An earlier date only ends the warning sooner;
 * a later one would tell the owner there is time after a return is due.
 *
 * Confidence: H = date stated by the agency; M-H / M = rule read at the
 * agency, roll or filer status inferred. Re-check every entry in Dec 2026
 * when states publish 2027 calendars; add a new tax year as its own map.
 *
 * Pure: no I/O, no clock.
 */

interface StateQ4Due {
  /** ISO date (YYYY-MM-DD) in the following calendar year. */
  closesOn: string;
  /** Agency page or form the date comes from. */
  source: string;
  /** SME confidence: "H", "M-H" or "M". */
  confidence: "H" | "M-H" | "M";
}

const TY2026: Readonly<Record<string, StateQ4Due>> = {
  // UC-CR4 SUI Jan 31, roll not confirmed.
  AL: {
    closesOn: "2027-01-31",
    source: "revenue.alabama.gov whbooklet_0126.pdf (rev. Jan 2026)",
    confidence: "M",
  },
  // TQ01C SUI, last day of month, rolls.
  AK: {
    closesOn: "2027-02-01",
    source: "labor.alaska.gov/estax/documents/taxbook.pdf",
    confidence: "M-H",
  },
  // A1-QRT Q4 and A1-R Jan 31, ADOR roll not confirmed.
  AZ: { closesOn: "2027-01-31", source: "azdor.gov A1-QRT and A1-R instructions", confidence: "M" },
  // AR941M monthly report for December, 15th (new accounts start monthly).
  AR: {
    closesOn: "2027-01-15",
    source: "dfa.arkansas.gov withholdInstructions.pdf (upd. 07/2024)",
    confidence: "M-H",
  },
  // DE 9/DE 9C Q4 delinquent after Feb 1, 2027 (stated).
  CA: {
    closesOn: "2027-02-01",
    source: "edd.ca.gov/en/payroll_taxes/Due_Dates_Calendar (2026)",
    confidence: "H",
  },
  // DR 1094 monthly return, 15th.
  CO: {
    closesOn: "2027-01-15",
    source: "tax.colorado.gov/withholding-filing-frequency-due-dates",
    confidence: "M",
  },
  // CT-941 Q4 and CT-W3 Jan 31; DOL UC-2 roll not confirmed.
  CT: {
    closesOn: "2027-01-31",
    source: "portal.ct.gov/drs W-2 filing requirements, IP 2026(1)",
    confidence: "M",
  },
  // W1 monthly return, 15th.
  DE: {
    closesOn: "2027-01-15",
    source: "revenue.delaware.gov Employer's Guide and Withholding FAQ",
    confidence: "M",
  },
  // UC-30 Q4 Jan 31, no roll (stated).
  DC: {
    closesOn: "2027-01-31",
    source: "does.dc.gov UI Employer Handbook (Jan 2022)",
    confidence: "H",
  },
  // RT-6, last day, rolls.
  FL: { closesOn: "2027-02-01", source: "floridarevenue.com rt_return_pay.aspx", confidence: "H" },
  // G-7 Q4 and G-1003 Jan 31, DOR roll not confirmed.
  GA: {
    closesOn: "2027-01-31",
    source: "dor.georgia.gov 2025 Employer's Tax Guide; dol.georgia.gov",
    confidence: "M",
  },
  // HW-14 Q4, 15th of the month after the quarter, all filers.
  HI: {
    closesOn: "2027-01-15",
    source: "files.hawaii.gov/tax/forms/current/hw14_i.pdf (Rev. 2025)",
    confidence: "H",
  },
  // Form 967 and W-2 Jan 31, roll not confirmed.
  ID: { closesOn: "2027-01-31", source: "tax.idaho.gov Form 967 instructions", confidence: "M" },
  // IL-941 Q4 stated as Feb 1.
  IL: {
    closesOn: "2027-02-01",
    source: "tax.illinois.gov 2026 IL-941 instructions",
    confidence: "H",
  },
  // WH-1 early filer (over $1,000 a month), 20 days after month end.
  IN: {
    closesOn: "2027-01-20",
    source: "in.gov/dor Withholding WH-1 page; DN #5 (Sep 2023)",
    confidence: "M",
  },
  // IWD SUI Jan 31, roll not confirmed.
  IA: {
    closesOn: "2027-01-31",
    source: "revenue.iowa.gov filing-frequency-return-due-dates",
    confidence: "M-H",
  },
  // KW-5 monthly, 15th (required at zero).
  KS: {
    closesOn: "2027-01-15",
    source: "ksrevenue.gov KW-100 (rev. 7-24) and kw5.pdf",
    confidence: "M",
  },
  // K-3 Q4/annual Jan 31, DOR roll not confirmed.
  KY: {
    closesOn: "2027-01-31",
    source: "revenue.ky.gov 103 KAR 18:150 and employer instructions",
    confidence: "M",
  },
  // LWC SUI roll not confirmed.
  LA: {
    closesOn: "2027-01-31",
    source: "revenue.louisiana.gov When must I file Form L-1",
    confidence: "M",
  },
  // PFML quarterly report roll not confirmed.
  ME: {
    closesOn: "2027-01-31",
    source: "maine.gov/revenue/tax-return-forms/due-dates",
    confidence: "M",
  },
  // MW506 quarterly and monthly, 15th.
  MD: {
    closesOn: "2027-01-15",
    source: "2026 Maryland Employer Withholding Guide",
    confidence: "H",
  },
  // M-941 Q4 and W-2 Jan 31, DOR roll not confirmed.
  MA: { closesOn: "2027-01-31", source: "mass.gov M-941 instructions", confidence: "M" },
  // 5080 monthly and quarterly, 20th.
  MI: {
    closesOn: "2027-01-20",
    source: "michigan.gov 5080 TY2026; MiWAM toolkit",
    confidence: "M-H",
  },
  // Q4 withholding, W-2, UI and Paid Leave; all roll.
  MN: {
    closesOn: "2027-02-01",
    source: "revenue.state.mn.us/tax-due-dates; uimn.org due dates",
    confidence: "M-H",
  },
  // Withholding returns due the 15th after the period (third parties say Jan 31).
  MS: { closesOn: "2027-01-15", source: "dor.ms.gov/business/withholding-tax", confidence: "M" },
  // MO-941 Q4 and W-2 Jan 31, DOR roll not confirmed.
  MO: { closesOn: "2027-01-31", source: "dor.mo.gov Form 4282 (2026)", confidence: "M" },
  // MW-3, W-2 and UI Jan 31, roll not confirmed.
  MT: {
    closesOn: "2027-01-31",
    source: "revenue.mt.gov wage withholding returns",
    confidence: "M",
  },
  // 941N Q4, W-3N and UI Jan 31, roll not confirmed.
  NE: { closesOn: "2027-01-31", source: "revenue.nebraska.gov 941N", confidence: "M" },
  // NUCS-4072 Jan 31, roll not confirmed.
  NV: { closesOn: "2027-01-31", source: "DETR NUCS-4072", confidence: "M" },
  // NHES report Jan 31.
  NH: { closesOn: "2027-01-31", source: "nhes.nh.gov empbro01", confidence: "M" },
  // NJ-927/WR-30 on the 30th, no weekend extension (stated).
  NJ: {
    closesOn: "2027-01-30",
    source: "nj.gov/labor/ea/employer-services/rate-info/",
    confidence: "H",
  },
  // TRD-41414 every period, 25th.
  NM: { closesOn: "2027-01-25", source: "NM TRD FYI-104 (rev. 11/2023)", confidence: "H" },
  // NYS-45 Q4 Jan 31, rolls to the next business day (stated).
  NY: { closesOn: "2027-02-01", source: "tax.ny.gov/bus/wt/duedates.htm", confidence: "H" },
  // NC-5 Dec, NC-5Q and NC-3 Jan 31, DOR roll not confirmed.
  NC: { closesOn: "2027-01-31", source: "des.nc.gov; NC seed note", confidence: "M" },
  // Form 306 Q4, 307 and W-2 Jan 31, roll not confirmed.
  ND: {
    closesOn: "2027-01-31",
    source: "tax.nd.gov income-tax-withholding-deadlines",
    confidence: "M",
  },
  // IT 941 / IT 942 Q4 Jan 31, ODT roll not confirmed.
  OH: { closesOn: "2027-01-31", source: "tax.ohio.gov employer withholding", confidence: "M" },
  // WTH-10001 quarterly, 20th, every filer.
  OK: { closesOn: "2027-01-20", source: "oklahoma.gov WTH-10001 (rev. 11-2021)", confidence: "H" },
  // OQ Q4 stated as Feb 1, 2027.
  OR: {
    closesOn: "2027-02-01",
    source: "oregon.gov 2026 Combined Payroll Tax Report instructions",
    confidence: "H",
  },
  // PA-W3 Q4 and REV-1667 Jan 31, DOR roll not confirmed.
  PA: { closesOn: "2027-01-31", source: "pa.gov employer withholding", confidence: "M" },
  // RI-941 Q4, RI-W3 and TX-17 Jan 31, roll not confirmed.
  RI: { closesOn: "2027-01-31", source: "tax.ri.gov withholding", confidence: "M" },
  // WH-1606 Q4/annual and UCE-120 Jan 31, roll not confirmed.
  SC: { closesOn: "2027-01-31", source: "dor.sc.gov WH-1606", confidence: "M" },
  // Reemployment Assistance report, rolls.
  SD: { closesOn: "2027-02-01", source: "dlr.sd.gov RA employer handbook", confidence: "M-H" },
  // LB-0456 Jan 31, roll not confirmed.
  TN: { closesOn: "2027-01-31", source: "lwdsupport.tn.gov", confidence: "M" },
  // C-3, rolls.
  TX: {
    closesOn: "2027-02-01",
    source: "twc.texas.gov tax-report-payment-due-dates",
    confidence: "H",
  },
  // TC-941 Q4/annual and W-2 Jan 31, roll not confirmed.
  UT: { closesOn: "2027-01-31", source: "tax.utah.gov Pub 14", confidence: "M" },
  // WHT-436 Q4: 12/31/2026 -> 1/25/2027 (stated).
  VT: { closesOn: "2027-01-25", source: "tax.vermont.gov/business/withholding", confidence: "H" },
  // VA-5 monthly, 25th, December included.
  VA: { closesOn: "2027-01-25", source: "tax.virginia.gov/withholding-tax", confidence: "M-H" },
  // ESD UI, PFML and WA Cares, roll.
  WA: { closesOn: "2027-02-01", source: "esd.wa.gov quarterly reports", confidence: "M-H" },
  // IT-101Q Q4, IT-103 and UI Jan 31, roll not confirmed.
  WV: { closesOn: "2027-01-31", source: "tax.wv.gov withholding forms", confidence: "M" },
  // WT-7 and UCT-101, both roll.
  WI: {
    closesOn: "2027-02-01",
    source: "revenue.wi.gov WT-7 instructions; dwd.wi.gov ui201",
    confidence: "M-H",
  },
  // UI, rolls.
  WY: { closesOn: "2027-02-01", source: "dws.wyo.gov reporting due dates", confidence: "M-H" },
};

const BY_TAX_YEAR: Readonly<Record<number, Readonly<Record<string, StateQ4Due>>>> = {
  2026: TY2026,
};

/**
 * The safe Q4 close date for `state` (two-letter code) in `taxYear`, or null
 * when the table has no entry (the caller falls back to Jan 31 of Y+1).
 */
export function stateQ4CloseDate(state: string, taxYear: number): string | null {
  const table = BY_TAX_YEAR[taxYear];
  if (!table || !Object.hasOwn(table, state)) return null;
  return table[state]?.closesOn ?? null;
}

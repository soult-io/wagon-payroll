/**
 * Payslip PDF renderer (spec documents D5) — ported from
 * an internal accounting project's pdfmake renderer (paystub portion).
 *
 * Renders EXCLUSIVELY from the frozen run_snapshot: frozen inputs, computed
 * results, and display fields copied in at issuance. Live config is never
 * consulted. Output is an in-memory Buffer; nothing is stored.
 *
 * Employee-facing by design: employer-side costs (employer FICA/FUTA) are
 * intentionally NOT shown — they are not relevant to the employee (owner
 * decision 2026-07-30). They remain in the snapshot/DB for admin views.
 * The YTD block (template ≥1.1.0) shows gross, total withholdings, and net.
 *
 * No company logo: the original renderer fetched logo-black.png from
 * the file store at runtime; no logo asset exists in the internal source repo, so
 * the payslip renders the company name as text (spec allows proceeding
 * without, noted in the step report).
 */

import type { Buffer } from "node:buffer";
import type { PayrollResult } from "@payroll/engine";
import { round2 } from "@payroll/engine/money";

// pdfmake 0.3.x — no TypeScript declarations, use the untyped import idiom
// from the original renderer.
// @ts-expect-error — pdfmake has no .d.ts
import pdfMake from "pdfmake";
// @ts-expect-error — pdfmake font module
import RobotoFonts from "pdfmake/fonts/Roboto.js";

pdfMake.fonts = RobotoFonts;

/** Snapshot subset the payslip renders from (structurally matches the server's RunSnapshot). */
export interface PayslipSnapshot {
  inputs: {
    periodAmount: number;
    frequency: string;
    periodStart: string;
    periodEnd: string;
    payDate: string;
    company: { legalName: string };
    employee: { legalName: string; preferredName: string | null };
  };
  result: PayrollResult;
  engineVersion: string;
  templateVersion: string;
  /** YTD accumulations through this run (template ≥1.1.0); pre-1.1.0 snapshots render gross-only. */
  ytd?: {
    gross: number;
    federalWithholding: number;
    socialSecurity: number;
    medicare: number;
    stateWithholding: number;
    totalDeductions: number;
    netPay: number;
  };
  /**
   * Legacy-import only: categories where the ISSUED amount deliberately
   * differs from the recomputed engine result (e.g. the 2026-03 Form 941
   * true-up). The payslip must render the ISSUED (stored) amounts — the
   * employee was actually paid those — via effectivePayslipAmounts().
   */
  legacyDeviations?: {
    category: string;
    stored: string;
    recomputed: string;
    reason: string;
  }[];
}

/** Display labels for deviation categories (payslip "as issued" note). */
const CATEGORY_LABELS: Record<string, string> = {
  gross_pay: "Gross Pay",
  federal_withholding: "Federal Income Tax",
  social_security: "Social Security",
  medicare: "Medicare",
  state_withholding: "State Income Tax",
  net_pay: "Net Pay",
};

type AdjustableField =
  | "grossPay"
  | "federalWithholding"
  | "socialSecurity"
  | "medicare"
  | "stateWithholding"
  | "netPay";

const CATEGORY_TO_FIELD: Record<string, AdjustableField> = {
  gross_pay: "grossPay",
  federal_withholding: "federalWithholding",
  social_security: "socialSecurity",
  medicare: "medicare",
  state_withholding: "stateWithholding",
  net_pay: "netPay",
};

export interface PayslipDeviationDisplay {
  label: string;
  stored: number;
  recomputed: number;
}

/**
 * The amounts a payslip must SHOW: the engine result, with any documented
 * legacy deviation overridden to the ISSUED (stored) amount. Without
 * deviations this is the result verbatim, totalDeductions untouched; with
 * deviations totalDeductions is derived as gross − net so the stub stays
 * internally consistent. Pure: same snapshot → same amounts.
 */
export interface EffectivePayslipAmounts {
  grossPay: number;
  federalWithholding: number;
  socialSecurity: number;
  medicare: number;
  stateWithholding: number;
  totalDeductions: number;
  netPay: number;
  deviations: PayslipDeviationDisplay[];
}

export function effectivePayslipAmounts(snapshot: PayslipSnapshot): EffectivePayslipAmounts {
  const r = snapshot.result;
  const amounts = {
    grossPay: r.grossPay,
    federalWithholding: r.federalWithholding,
    socialSecurity: r.socialSecurity,
    medicare: r.medicare,
    stateWithholding: r.stateWithholding,
    totalDeductions: r.totalDeductions,
    netPay: r.netPay,
  };
  const deviations = snapshot.legacyDeviations ?? [];
  const display: PayslipDeviationDisplay[] = [];
  for (const d of deviations) {
    const field = CATEGORY_TO_FIELD[d.category];
    if (field) {
      amounts[field] = Number(d.stored);
    }
    display.push({
      label: CATEGORY_LABELS[d.category] ?? d.category,
      stored: Number(d.stored),
      recomputed: Number(d.recomputed),
    });
  }
  if (deviations.length > 0) {
    // Internal consistency: what was withheld is gross minus what was paid.
    amounts.totalDeductions = round2(amounts.grossPay - amounts.netPay);
  }
  return { ...amounts, deviations: display };
}

// biome-ignore lint/suspicious/noExplicitAny: pdfmake content types are not installed; runtime accepts these shapes
type Content = any;
// biome-ignore lint/suspicious/noExplicitAny: pdfmake cell types are not installed; runtime accepts these shapes
type TableCell = any;
// biome-ignore lint/suspicious/noExplicitAny: pdfmake doc-definition types are not installed; runtime accepts these shapes
type DocDefinition = any;

type LayoutNode = { table: { body: unknown[] } };

const ACCENT_BLUE = "#1A3B6E";
const DARK_TEXT = "#000000";
const GRAY_LINE = "#D1D5DB";
const LIGHT_BG = "#F5F5F5";

function usd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "April 2026" for monthly periods; "2026-04-01 → 2026-04-30" otherwise. */
function periodLabel(snapshot: PayslipSnapshot): string {
  const { periodStart, periodEnd } = snapshot.inputs;
  if (periodStart.slice(0, 7) === periodEnd.slice(0, 7)) {
    const [year, month] = periodStart.split("-");
    return `${MONTHS[Number(month) - 1]} ${year}`;
  }
  return `${periodStart} → ${periodEnd}`;
}

/** "2026-04-15" → "04/15/2026" (matches the legacy stub convention). */
function payDateLabel(payDate: string): string {
  const [year, month, day] = payDate.split("-");
  return `${month}/${day}/${year}`;
}

function buildPayslipDoc(snapshot: PayslipSnapshot): DocDefinition {
  const { inputs, result } = snapshot;
  const employeeName = inputs.employee.preferredName ?? inputs.employee.legalName;
  // Amounts SHOWN are the issued ones: engine result with any documented
  // legacy deviation overridden to the stored (actually-paid) figure.
  const eff = effectivePayslipAmounts(snapshot);

  const deductions = [
    { label: "Federal Income Tax", amount: eff.federalWithholding },
    { label: "Social Security", amount: eff.socialSecurity },
    { label: "Medicare", amount: eff.medicare },
    ...(eff.stateWithholding > 0
      ? [{ label: "State Income Tax", amount: eff.stateWithholding }]
      : []),
  ];
  const deductionRows: TableCell[][] = deductions.map((d) => [
    { text: d.label, fontSize: 9 },
    { text: `-${usd(d.amount)}`, fontSize: 9, alignment: "right" },
  ]);

  const content: Content[] = [
    // Header
    {
      columns: [
        {
          width: "*",
          stack: [
            { text: "PAY STUB", style: "title", color: DARK_TEXT },
            { text: inputs.company.legalName, bold: true, fontSize: 11, margin: [0, 4, 0, 0] },
          ],
        },
        {
          width: "auto",
          stack: [
            { text: `Pay Period: ${periodLabel(snapshot)}`, fontSize: 10, alignment: "right" },
            { text: `Pay Date: ${payDateLabel(inputs.payDate)}`, fontSize: 10, alignment: "right" },
          ],
        },
      ],
      margin: [0, 0, 0, 20],
    },

    // Employee
    {
      table: {
        widths: ["*", "*"],
        body: [
          [
            { text: "Employee", bold: true, fillColor: LIGHT_BG, margin: [4, 4, 4, 4] },
            { text: employeeName, fillColor: LIGHT_BG, margin: [4, 4, 4, 4], alignment: "right" },
          ],
        ],
      },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0 },
      margin: [0, 0, 0, 15],
    },

    // Earnings
    { text: "Earnings", bold: true, fontSize: 11, margin: [0, 0, 0, 5] },
    {
      table: {
        widths: ["*", "auto"],
        body: [
          [
            { text: "Gross Pay", fontSize: 9, bold: true },
            { text: usd(eff.grossPay), fontSize: 9, alignment: "right", bold: true },
          ],
        ],
      },
      layout: {
        hLineWidth: (i: number) => (i === 0 || i === 1 ? 1 : 0),
        vLineWidth: () => 0,
        hLineColor: () => GRAY_LINE,
        paddingTop: () => 4,
        paddingBottom: () => 4,
      },
      margin: [0, 0, 0, 15],
    },

    // Deductions
    { text: "Employee Deductions", bold: true, fontSize: 11, margin: [0, 0, 0, 5] },
    {
      table: {
        widths: ["*", "auto"],
        body: [
          ...deductionRows,
          [
            { text: "Total Deductions", fontSize: 9, bold: true },
            {
              text: `-${usd(eff.totalDeductions)}`,
              fontSize: 9,
              alignment: "right",
              bold: true,
            },
          ],
        ],
      },
      layout: {
        hLineWidth: (i: number, node: LayoutNode) =>
          i === 0 || i === node.table.body.length ? 1 : 0,
        vLineWidth: () => 0,
        hLineColor: () => GRAY_LINE,
        paddingTop: () => 4,
        paddingBottom: () => 4,
      },
      margin: [0, 0, 0, 15],
    },

    // "As issued" note — only when the snapshot documents legacy deviations
    // (e.g. the 2026-03 Form 941 true-up): the stub shows what was actually
    // withheld/paid, with the standard-tables figure for transparency.
    ...(eff.deviations.length > 0
      ? [
          {
            text: [
              { text: "Amounts shown as issued — documented adjustment: ", bold: true },
              ...eff.deviations.flatMap((d, i) => [
                { text: i > 0 ? "; " : "" },
                { text: `${d.label} ${usd(d.stored)} (standard tables ${usd(d.recomputed)})` },
              ]),
              { text: "." },
            ],
            fontSize: 8,
            color: "#6B7280",
            margin: [0, 0, 0, 15],
          },
        ]
      : []),

    // Net pay banner
    {
      table: {
        widths: ["*", "auto"],
        body: [
          [
            {
              text: "NET PAY",
              fontSize: 14,
              bold: true,
              color: "#FFFFFF",
              fillColor: ACCENT_BLUE,
              margin: [8, 8, 8, 8],
            },
            {
              text: usd(eff.netPay),
              fontSize: 14,
              bold: true,
              alignment: "right",
              color: "#FFFFFF",
              fillColor: ACCENT_BLUE,
              margin: [8, 8, 8, 8],
            },
          ],
        ],
      },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0 },
      margin: [0, 0, 0, 20],
    },

    // YTD — employee-side totals through this run (template ≥1.1.0).
    // Withholdings itemized per tax (owner request 2026-08-01), not bundled.
    // Pre-1.1.0 snapshots (never shipped) fall back to gross-only.
    {
      table: {
        widths: ["*", "auto"],
        body: (
          (snapshot.ytd
            ? [
                ["Year-to-Date Gross", usd(snapshot.ytd.gross)],
                ["Year-to-Date Federal Tax", `-${usd(snapshot.ytd.federalWithholding)}`],
                ["Year-to-Date Social Security", `-${usd(snapshot.ytd.socialSecurity)}`],
                ["Year-to-Date Medicare", `-${usd(snapshot.ytd.medicare)}`],
                ...(snapshot.ytd.stateWithholding > 0
                  ? [["Year-to-Date State Tax", `-${usd(snapshot.ytd.stateWithholding)}`]]
                  : []),
                ["Year-to-Date Net Pay", usd(snapshot.ytd.netPay)],
              ]
            : [["Year-to-Date Gross", usd(result.ytdGross)]]) as [string, string][]
        ).map(([label, value]) => [
          {
            text: label,
            fontSize: 10,
            bold: true,
            fillColor: LIGHT_BG,
            margin: [4, 4, 4, 4],
          },
          {
            text: value,
            fontSize: 10,
            alignment: "right",
            fillColor: LIGHT_BG,
            margin: [4, 4, 4, 4],
          },
        ]),
      },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0 },
    },
  ];

  return {
    content,
    defaultStyle: { font: "Roboto", fontSize: 10, color: DARK_TEXT },
    styles: {
      title: { fontSize: 18, bold: true, color: DARK_TEXT },
    },
    pageMargins: [40, 40, 40, 40],
    // Determinism breadcrumb: engine + template that produced this render.
    footer: (currentPage: number, pageCount: number) => ({
      text: `Generated from immutable run snapshot · engine ${snapshot.engineVersion} · template ${snapshot.templateVersion} · page ${currentPage}/${pageCount}`,
      fontSize: 7,
      color: "#9CA3AF",
      alignment: "center",
    }),
  };
}

/** Render a payslip PDF from a frozen run snapshot. Pure: same snapshot → same document. */
export async function renderPayslipPdf(snapshot: PayslipSnapshot): Promise<Buffer> {
  const doc = pdfMake.createPdf(buildPayslipDoc(snapshot));
  return doc.getBuffer();
}

export {
  renderNec1099Pdf,
  type Nec1099Address,
  type Nec1099Input,
} from "./nec-1099.js";

export {
  CORRECTED_MARK,
  formatEin,
  pagesWithCorrectedMark,
  prepareW2AdminCopyD,
  prepareW2EmployeePacket,
  prepareW3,
  renderW2AdminCopyD,
  renderW2EmployeePacket,
  renderW3Pdf,
  pdfStructure,
  splitLegalName,
  prepareW2Forms,
  W2FormAmountError,
  W2FormLinesError,
  type FormAddress,
  type W2EmployeePacketOptions,
  type W2Input,
  type W2LocalLineInput,
  type W2StateLineInput,
  type W3Input,
} from "./w2.js";

export {
  W2_COPY_PAGES_2026,
  W2_LAYOUT_2026,
  W3_FIELD_MAP_2026,
  w2FieldMap2026,
  type W2FieldMap2026,
  type W2LocalRowFields,
  type W2StateRowFields,
} from "./forms/field-map-2026.js";

export {
  w2FieldMapFor,
  w2LayoutFor,
  w3FieldMapFor,
  type W2Layout,
  type W3FieldMap,
} from "./forms/w2-years.js";

export {
  W2_ADMIN_COPIES,
  W2_ADMIN_COPY_D_PAGES,
  W2_CORRECTED_MARK_PAGES,
  W2_EMPLOYEE_COPIES,
  W2_EMPLOYEE_PAGES,
  W2_LAYOUT_2025,
  W3_CHECKBOXES,
  W3_FIELD_MAP,
  W3_FORM_PAGE,
  w2FieldMap,
  type W2Copy,
  type W2FieldMap,
} from "./forms/field-map-2025.js";

export {
  hasTemplate,
  templateBytes,
  templateYears,
  type FormKind,
} from "./forms/templates.js";

export {
  prepareF941,
  renderF941Pdf,
  splitEin,
  splitMoneyPair,
  type F941Input,
} from "./f941.js";

export { prepareF940, renderF940Pdf, type F940Input } from "./f940.js";

export {
  F940_FIELD_MAP,
  F940_REVISION_DATE,
  type F940FieldMap,
} from "./forms/f940-field-map.js";

export {
  F941_REVISION_DATE,
  f941FieldMap,
  type F941FieldMap,
  type MoneyField,
} from "./forms/f941-field-map.js";

export { renderInvoicePdf, type InvoicePdfInput } from "./invoice.js";

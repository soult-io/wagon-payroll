<script setup lang="ts">
/**
 * Admin filing detail (PAY-10): the frozen Form 941 worksheet (line-by-line,
 * with the per-month liability breakdown and snapshot hash), the
 * adjustment/notice records for the quarter (D3 — add/edit/delete), the
 * admin-editable line-7 fractions-of-cents (D4), the mark-as-filed action
 * (D2 track-only — date + method + reference), and the "How to file" help
 * dialog with self-filing instructions.
 *
 * PAY-206: the W-2 list shows which W-2s were corrected after the employee
 * got them, how each latest copy was given, and — for paper employees still
 * owed a corrected copy — a banner, "Print corrected W-2" and "Mark given
 * on paper". Recording the SSA filing is never held by them (warning only).
 *
 * Spec 24 (PAY-116) PR-4: W-2 state lines (boxes 15–17), W-3 box c and
 * boxes 15–17, the State tax check card, the notice-hold line, the W-3 as a
 * records copy, the two-up and more-than-one-W-2 help, the Business Services
 * Online copy (E1/E2) and the state filing checklist. Display logic and copy
 * live in lib/w2-filing.ts.
 */
import { computed, onMounted, ref } from "vue";
import { STATE_ID_MIN_YEAR } from "@payroll/shared";
import { useRoute } from "vue-router";
import Button from "primevue/button";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import DatePicker from "primevue/datepicker";
import Select from "primevue/select";
import Textarea from "primevue/textarea";
import Skeleton from "primevue/skeleton";
import Tag from "primevue/tag";
import Message from "primevue/message";
import PageHeader from "../../components/PageHeader.vue";
import BackButton from "../../components/BackButton.vue";
import StatusChip from "../../components/StatusChip.vue";
import MissingTaxConfigBanner from "../../components/MissingTaxConfigBanner.vue";
import {
  adminFilingsApi,
  ApiError,
  type AdjustmentInput,
  type FilingAttachment,
  type FilingCorrection,
  type TaxAdjustmentRow,
  type TaxFilingRow,
  type W2FiguresRow,
  type W2Issue,
  type W2StateCheck,
  type Worksheet940,
  type Worksheet941,
  type WorksheetRecomputePreview,
  type WorksheetW3,
} from "../../lib/api";
import { useDates } from "../../composables/useDates";
import { useMoney } from "../../composables/useMoney";
import { useConfirm } from "primevue/useconfirm";
import { useNotify } from "../../composables/useNotify";
import {
  formNotAvailableText,
  hasUnreadableTotals,
  RECONCILIATION_POINTER_TEXT,
  STALE_TOTALS_TEXT,
  w2BlockedText,
  w2IssueKey,
  w2IssueLabel,
  w2IssueText,
  w2LoadErrorText,
  w2WarningsOnlyText,
} from "../../lib/w2-issues";
import {
  box15MissingIdState,
  box15MissingIdText,
  bsoMultiFormText,
  markFiledLeadText,
  multiW2Text,
  STATE_CHECK_INTRO,
  STATE_CHECK_WITHHELD,
  stateCheckText,
  stateFilingChecklist,
  stateIdSourceTag,
  stateLineText,
  twoUpHelpText,
  W2_DOWNLOAD_STEP,
  W3_ON_HOLD_TEXT,
  W3_RECORDS_NOTE,
  w3WorksheetLines,
} from "../../lib/w2-filing";

const route = useRoute();
const { date, toIso } = useDates();
const { money } = useMoney();
const notify = useNotify();
const confirm = useConfirm();

const filingId = Number(route.params.id);

const loading = ref(true);
const filing = ref<TaxFilingRow | null>(null);
const adjustments = ref<TaxAdjustmentRow[]>([]);
/** PAY-11: per-employee W-2 figures for the W-2/W-3 detail (no PII). */
const w2Rows = ref<W2FiguresRow[]>([]);
/** Spec 24 (PAY-116): year-level issues (a state's W-2 tax vs its pay runs). */
const w2YearIssues = ref<W2Issue[]>([]);
/** Spec 24 (PAY-116) PR-4: the year's "your W-2 is ready" email already went out. */
const w2Notified = ref(false);
/** Spec 24 (PAY-116) PR-4 (I3): per-state tax check. */
const stateChecks = ref<W2StateCheck[]>([]);
/** PAY-24: uploaded confirmation/evidence documents (metadata only). */
const attachments = ref<FilingAttachment[]>([]);
/** PAY-25: past worksheet corrections (audit trail on the detail page). */
const corrections = ref<FilingCorrection[]>([]);

const filed = computed(() => filing.value?.status === "filed");
/** PAY-162: the year whose federal tax settings are missing (409 on load). */
const missingConfigYear = ref<number | null>(null);
/** PAY-162: any W-2 of the year blocked → the W-3 is held too. */
const anyW2Blocked = computed(
  () =>
    w2Rows.value.some((r) => r.blocked) || w2YearIssues.value.some((i) => i.severity === "block"),
);
/** PAY-162: the W-2 list failed to load — hold everything that depends on it. */
const w2LoadError = ref(false);
/** PAY-162 (D3): the official W-2/W-3 form is bundled for the year. */
const w2FormAvailable = ref(true);
/**
 * PAY-162: W-2s with a block or warn issue, for the "need attention" list.
 * Info issues (e.g. period_spans_move) are notes, not something to fix.
 */
const attentionRows = computed(() =>
  w2Rows.value.filter((r) => r.issues.some((i) => i.severity === "block" || i.severity === "warn")),
);
/** Spec 24 (PAY-116) PR-4: year-level holds and warnings, listed under "W-2s that need attention". */
const yearAttention = computed(() =>
  w2YearIssues.value.filter((i) => i.severity === "block" || i.severity === "warn"),
);
const anyUnreadableTotals = computed(() => w2Rows.value.some(hasUnreadableTotals));
/** Spec 24 (PAY-116): the year has W-2 state lines (boxes 15–17). */
const hasStateBoxes = computed(() => (filing.value?.year ?? 0) >= STATE_ID_MIN_YEAR);
/** PR-4 (carry-over e): the one box 15 state printed without an account number. */
const box15MissingState = computed(() => box15MissingIdState(w2Rows.value));
/** PR-4 (U7): Business Services Online copy when some employee has more than one W-2. */
const bsoText = computed(() => bsoMultiFormText(w2Rows.value));
/** PR-4 (U8): the "How to file" state lines. */
const stateChecklist = computed(() => stateFilingChecklist(w2Rows.value));
/** PR-4 (U6): employees with more than one W-2. */
const multiFormRows = computed(() => w2Rows.value.filter((r) => r.formCount > 1));

/** Apply one admin W-2 list response. */
function applyW2List(list: Awaited<ReturnType<typeof adminFilingsApi.w2List>>): void {
  w2Rows.value = list.w2s;
  w2YearIssues.value = list.yearIssues;
  w2FormAvailable.value = list.formAvailable;
  w2Notified.value = list.notified;
  stateChecks.value = list.stateChecks;
}

/** PR-4 (B3): a reconciliation_mismatch line points to the State tax check when it shows that state. */
function yearIssueText(issue: W2Issue, year: number): string {
  const text = w2IssueText(issue, { legalName: "", year });
  const shown =
    issue.code === "reconciliation_mismatch" &&
    stateChecks.value.some((c) => c.state === issue.state);
  return shown ? `${text} ${RECONCILIATION_POINTER_TEXT}` : text;
}
/** PAY-206: any W-2 corrected after the employee got it (SSA note). */
const anyW2Corrected = computed(() => w2Rows.value.some((r) => r.corrected));
/** PAY-206: paper employees still owed the corrected copy. */
const paperCorrectionRows = computed(() =>
  w2Rows.value.filter((r) => r.correctionToFurnish && !r.consented),
);
const markPaperBusy = ref<number | null>(null);
/** PAY-206: the paper-correction banner, singular or plural. */
const paperCorrectionBanner = computed(() => {
  const n = paperCorrectionRows.value.length;
  const y = filing.value?.year;
  return n === 1
    ? `1 employee needs a corrected paper W-2 for ${y}. Print it, give or mail it to them, then choose "Mark given on paper".`
    : `${n} employees need a corrected paper W-2 for ${y}. Print each one, give or mail it to them, then choose "Mark given on paper".`;
});
/** PAY-206: the mark-filed warning, singular or plural. */
const paperCorrectionWarning = computed(() => {
  const n = paperCorrectionRows.value.length;
  return n === 1
    ? "1 corrected W-2 hasn't been given to the employee yet. You can still record the filing."
    : `${n} corrected W-2s haven't been given to employees yet. You can still record the filing.`;
});

/**
 * PAY-206: the furnished column — how and when the latest copy was given.
 * A backfilled row (furnished before this record existed) is "Not recorded".
 */
function furnishedText(row: W2FiguresRow): string {
  const on = row.furnishedOn ? ` ${date(row.furnishedOn)}` : "";
  if (row.furnished === "online") return `Online since${on}`;
  if (row.furnished === "printed") return `Printed${on}`;
  if (row.furnished === "paper") return `Given on paper${on}`;
  if (row.furnished === "unknown") return "Not recorded";
  return "Not yet given";
}

/** PAY-206: record that the corrected W-2 was handed over on paper. */
function markGivenOnPaper(row: W2FiguresRow): void {
  const year = filing.value?.year;
  if (year === undefined) return;
  confirm.require({
    message: `Only do this after you have handed or mailed ${row.legalName} their corrected ${year} W-2. This removes it from your to-do list and can't be undone.`,
    header: `Mark ${row.legalName}'s W-2 as given?`,
    icon: "pi pi-check",
    rejectProps: { label: "Cancel", severity: "secondary", text: true },
    acceptProps: { label: "Yes, it's been given" },
    accept: async () => {
      markPaperBusy.value = row.employeeId;
      try {
        await adminFilingsApi.w2MarkGivenOnPaper(row.employeeId, year);
        applyW2List(await adminFilingsApi.w2List(year));
        notify.success(`${row.legalName}'s corrected W-2 is marked as given.`);
      } catch (err) {
        notify.error(err, "Could not mark the W-2 as given");
      } finally {
        markPaperBusy.value = null;
      }
    },
  });
}
/** PAY-162: warnings stand but nothing is on hold. */
const warnOnlyCount = computed(() => (anyW2Blocked.value ? 0 : attentionRows.value.length));
/** PAY-162 (D1): a W-2/W-3 filing cannot be recorded while held. */
/**
 * PAY-162 (D1): why a W-2/W-3 filing cannot be recorded yet, or null. The
 * list load failing comes first (holds are unknown), then held W-2s, then a
 * W-3 worksheet that has not been calculated.
 */
const markFiledHeldReason = computed<string | null>(() => {
  if (filing.value?.formType !== "w2_w3") return null;
  if (w2LoadError.value) {
    return "Reload the page to check whether any W-2 is on hold before recording this filing.";
  }
  if (anyW2Blocked.value) return "You can record this filing once no W-2s are on hold.";
  if (!filing.value.worksheet) {
    return "You can record this filing once the W-3 has been calculated. Open this page again after the next daily update.";
  }
  return null;
});
const markFiledHeld = computed(() => markFiledHeldReason.value !== null);

const FORM_LABELS: Record<string, string> = {
  "941": "Form 941",
  "940": "Form 940",
  w2_w3: "Forms W-2/W-3",
};

function formLabel(formType: string): string {
  return FORM_LABELS[formType] ?? formType;
}

// PAY-11: the worksheet shape depends on the form type.
const worksheet941 = computed<Worksheet941 | null>(() =>
  filing.value?.worksheet?.form === "941" ? filing.value.worksheet : null,
);
const worksheet940 = computed<Worksheet940 | null>(() =>
  filing.value?.worksheet?.form === "940" ? filing.value.worksheet : null,
);
const worksheetW3 = computed<WorksheetW3 | null>(() =>
  filing.value?.worksheet?.form === "w2_w3" ? filing.value.worksheet : null,
);

function periodLabel(): string {
  const f = filing.value;
  if (!f) return "";
  return f.quarter === 0 ? String(f.year) : `Q${f.quarter} ${f.year}`;
}

async function load() {
  loading.value = true;
  missingConfigYear.value = null;
  w2Rows.value = [];
  w2YearIssues.value = [];
  w2Notified.value = false;
  stateChecks.value = [];
  w2LoadError.value = false;
  w2FormAvailable.value = true;
  try {
    const res = await adminFilingsApi.detail(filingId);
    filing.value = res.filing;
    adjustments.value = res.adjustments;
    corrections.value = res.corrections;
    attachments.value = (await adminFilingsApi.listAttachments(filingId)).attachments;
    if (res.filing.formType === "w2_w3") {
      try {
        applyW2List(await adminFilingsApi.w2List(res.filing.year));
      } catch {
        w2LoadError.value = true;
      }
    }
  } catch (err) {
    // PAY-162: a fixed 409 code → the block banner, built from the code + year.
    const year = err instanceof ApiError ? err.body?.year : undefined;
    if (err instanceof ApiError && err.code === "missing_tax_config" && typeof year === "number") {
      missingConfigYear.value = year;
    } else {
      notify.error(err, "Could not load the filing");
    }
  } finally {
    loading.value = false;
  }
}

// ------------------------------------------------------------- attachments (PAY-24)
const attachFile = ref<File | null>(null);
const attachBusy = ref(false);
/** Bump to reset the native file inputs after a successful upload. */
const attachInputKey = ref(0);

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function onAttachPick(event: Event) {
  attachFile.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

async function submitAttachment() {
  const file = attachFile.value;
  if (!file) return;
  attachBusy.value = true;
  try {
    await adminFilingsApi.uploadAttachment(filingId, file);
    notify.success("Attachment uploaded", file.name);
    attachFile.value = null;
    attachInputKey.value += 1;
    await load();
  } catch (err) {
    notify.error(err, "Could not upload the attachment");
  } finally {
    attachBusy.value = false;
  }
}

// ------------------------------------------------- recompute worksheet (PAY-25)
const recomputeDialog = ref(false);
const recomputePreviewData = ref<WorksheetRecomputePreview | null>(null);
const recomputeReason = ref("");
const recomputeBusy = ref(false);
const recomputeLoading = ref(false);

/** Flatten a worksheet (nested objects → dotted keys) for the diff table. */
function flattenWs(ws: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (ws === null || typeof ws !== "object") return out;
  for (const [k, v] of Object.entries(ws as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") Object.assign(out, flattenWs(v, key));
    else out[key] = String(v);
  }
  return out;
}

/** Lines whose value changes under recomputation (old → new). */
const recomputeDiff = computed(() => {
  const p = recomputePreviewData.value;
  if (!p) return [];
  const before = flattenWs(p.beforeWorksheet);
  const after = flattenWs(p.afterWorksheet);
  return Object.keys(after)
    .filter((k) => before[k] !== after[k])
    .map((k) => ({ key: k, before: before[k] ?? "—", after: after[k] }));
});

function shortHash(hash: string | null | undefined): string {
  return hash ? hash.slice(0, 8) : "—";
}

async function openRecompute() {
  recomputeReason.value = "";
  recomputePreviewData.value = null;
  recomputeDialog.value = true;
  recomputeLoading.value = true;
  try {
    recomputePreviewData.value = await adminFilingsApi.recomputePreview(filingId);
  } catch (err) {
    notify.error(err, "Could not compute the preview");
    recomputeDialog.value = false;
  } finally {
    recomputeLoading.value = false;
  }
}

async function submitRecompute() {
  const reason = recomputeReason.value.trim();
  if (!reason) return;
  recomputeBusy.value = true;
  try {
    await adminFilingsApi.recompute(filingId, reason);
    notify.success("Worksheet recomputed", "The correction is recorded in the audit log.");
    recomputeDialog.value = false;
    await load();
  } catch (err) {
    notify.error(err, "Could not recompute the worksheet");
  } finally {
    recomputeBusy.value = false;
  }
}

// ------------------------------------------------------------- worksheet rows
interface WorksheetLine {
  line: string;
  label: string;
  value: string;
}

const worksheetLines = computed<WorksheetLine[]>(() => {
  const w = worksheet941.value;
  if (!w) return [];
  return [
    {
      line: "1",
      label: "Employees paid (pay period incl. the 12th of month 1)",
      value: String(w.line1Employees),
    },
    { line: "2", label: "Wages, tips, and other compensation", value: money(w.line2Wages) },
    { line: "3", label: "Federal income tax withheld", value: money(w.line3FederalWithheld) },
    {
      line: "5a",
      label: `Taxable Social Security wages (${money(w.line5aTaxableSsWages)} × 12.4%)`,
      value: money(w.line5aTax),
    },
    {
      line: "5c",
      label: `Taxable Medicare wages (${money(w.line5cTaxableMedicareWages)} × 2.9%)`,
      value: money(w.line5cTax),
    },
    {
      line: "5d",
      label: "Additional Medicare withholding",
      value: money(w.line5dAdditionalMedicare),
    },
    { line: "5e", label: "Total Social Security and Medicare taxes", value: money(w.line5eTotal) },
    { line: "6", label: "Total taxes (line 3 + line 5e)", value: money(w.line6TotalTaxes) },
    {
      line: "7",
      label: "Fractions of cents (admin-editable below)",
      value: money(w.line7FractionsOfCents),
    },
    {
      line: "10",
      label: "Total taxes after adjustments",
      value: money(w.line10TotalAfterAdjustments),
    },
    {
      line: "11",
      label: "Qualified small business R&D credit",
      value: money(w.line11ResearchCredit),
    },
    { line: "12", label: "Total taxes after credits", value: money(w.line12TotalAfterCredits) },
    { line: "13", label: "Total deposits + adjustment payments", value: money(w.line13Deposits) },
    { line: "14", label: "Balance due", value: money(w.line14BalanceDue) },
    { line: "15", label: "Overpayment", value: money(w.line15Overpayment) },
  ];
});

// PAY-11: Form 940 (FUTA) worksheet lines.
const worksheet940Lines = computed<WorksheetLine[]>(() => {
  const w = worksheet940.value;
  if (!w) return [];
  const depositRule =
    w.depositThresholdCrossedQuarter === null
      ? "Cumulative FUTA liability never exceeded $500 — pay with the return"
      : `Liability crossed $500 in Q${w.depositThresholdCrossedQuarter} — deposit was due by ${date(
          w.depositDueBy,
        )} (EFTPS)`;
  // PAY-18: the rate assumption is never silent. Worksheets frozen before
  // v1.11 lack the rate fields — they were computed at the full 5.4% credit.
  const netRate = Number(w.futaRate ?? "0.006") * 100;
  const rateAssumption =
    w.sutaCreditRate !== undefined
      ? `6.0% statutory − ${Number(w.sutaCreditRate) * 100}% SUTA credit = ${netRate}% net (tax_config, ${w.year})`
      : "6.0% statutory − 5.4% SUTA credit = 0.6% net (assumed — worksheet predates the rate fields)";
  return [
    { line: "—", label: "FUTA rate assumption", value: rateAssumption },
    { line: "3", label: "Total payments to all employees", value: money(w.line3TotalPayments) },
    {
      line: "7",
      label: "Total taxable FUTA wages (first $7,000 per employee)",
      value: money(w.line7FutaTaxableWages),
    },
    {
      line: "8",
      label: `FUTA tax before adjustments (line 7 × ${netRate}%)`,
      value: money(w.line8FutaTax),
    },
    { line: "12", label: "Total FUTA tax after adjustments", value: money(w.line12TotalFutaTax) },
    {
      line: "—",
      label: "FUTA withheld in frozen payroll entries (accrued-liability truth)",
      value: money(w.futaTaxPerFrozenEntries),
    },
    {
      line: "—",
      label: "Rounding delta (frozen entries − line 12)",
      value: money(w.roundingDelta),
    },
    { line: "—", label: "Deposit rule", value: depositRule },
    { line: "14", label: "Balance due", value: money(w.balanceDue) },
  ];
});

// PAY-11: W-3 aggregate lines. Spec 24 (PAY-116) PR-4: box c and 15–17 from 2026.
const worksheetW3Lines = computed<WorksheetLine[]>(() =>
  worksheetW3.value ? w3WorksheetLines(worksheetW3.value) : [],
);

// ------------------------------------------------------ fractions of cents (D4)
const fractionsText = ref("");
const fractionsBusy = ref(false);
const fractionsValid = computed(() => /^-?\d{1,10}(\.\d{1,2})?$/.test(fractionsText.value.trim()));

async function saveFractions() {
  if (!fractionsValid.value) return;
  fractionsBusy.value = true;
  try {
    await adminFilingsApi.setFractionsOfCents(filingId, fractionsText.value.trim());
    notify.success("Line 7 saved", "The worksheet totals were re-rendered with the new value.");
    await load();
  } catch (err) {
    notify.error(err, "Could not save line 7");
  } finally {
    fractionsBusy.value = false;
  }
}

// ------------------------------------------------------------ mark as filed (D2)
const fileDialog = ref(false);
const fileBusy = ref(false);
const filedOn = ref<Date | null>(new Date());
const filingMethod = ref<string>("letterstream");
const filingReference = ref("");
/** PAY-24: optional confirmation PDF uploaded alongside the filing record. */
const filedAttachment = ref<File | null>(null);
const methodOptions = [
  { label: "Mail (Letterstream)", value: "letterstream" },
  { label: "E-file (IRS authorized provider)", value: "efile" },
  { label: "Other", value: "other" },
];

function onFiledAttachmentPick(event: Event) {
  filedAttachment.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

async function submitFiled() {
  const iso = toIso(filedOn.value);
  if (!iso) return;
  fileBusy.value = true;
  try {
    const shownHash = filing.value?.worksheetHash;
    await adminFilingsApi.markFiled(filingId, {
      filedOn: iso,
      filingMethod: filingMethod.value,
      filingReference: filingReference.value.trim(),
      // PAY-193: refuse when the figures changed since this page loaded them.
      ...(shownHash ? { expectedWorksheetHash: shownHash } : {}),
    });
    // PAY-24: upload the confirmation document right after recording.
    const file = filedAttachment.value;
    if (file) {
      try {
        await adminFilingsApi.uploadAttachment(filingId, file);
      } catch (err) {
        notify.error(err, "Filing recorded — but the confirmation PDF upload failed");
      }
    }
    notify.success("Filing recorded", `${periodLabel()} marked as filed.`);
    filedAttachment.value = null;
    attachInputKey.value += 1;
    fileDialog.value = false;
    await load();
  } catch (err) {
    const changed = err instanceof ApiError && err.code === "worksheet_changed";
    notify.error(
      err,
      changed ? "Figures changed. Not marked as filed" : "Could not record the filing",
    );
    // PAY-193: show the refreshed figures so the admin can review them.
    if (changed) {
      fileDialog.value = false;
      await load();
    }
  } finally {
    fileBusy.value = false;
  }
}

// ---------------------------------------------------------- "How to file" (D2)
const helpDialog = ref(false);

// ------------------------------------------------------------------ adjustments
const adjDialog = ref(false);
const adjBusy = ref(false);
const adjTarget = ref<TaxAdjustmentRow | null>(null);
const adjKind = ref("");
const adjNoticeDate = ref<Date | null>(null);
const adjAmountDue = ref("");
const adjAbated = ref("");
const adjAmountPaid = ref("");
const adjPaidOn = ref<Date | null>(null);
const adjEftps = ref("");
const adjNote = ref("");

const KIND_SUGGESTIONS = ["CP220", "CP161", "penalty", "interest", "other"];

function openAdjDialog(row: TaxAdjustmentRow | null) {
  adjTarget.value = row;
  adjKind.value = row?.kind ?? "";
  adjNoticeDate.value = row?.noticeDate ? new Date(`${row.noticeDate}T00:00:00`) : null;
  adjAmountDue.value = row?.amountDue ?? "";
  adjAbated.value = row?.abatedAmount ?? "";
  adjAmountPaid.value = row?.amountPaid ?? "";
  adjPaidOn.value = row?.paidOn ? new Date(`${row.paidOn}T00:00:00`) : null;
  adjEftps.value = row?.eftpsConfirmation ?? "";
  adjNote.value = row?.note ?? "";
  adjDialog.value = true;
}

const adjValid = computed(
  () => adjKind.value.trim() !== "" && /^\d{1,10}(\.\d{1,2})?$/.test(adjAmountDue.value.trim()),
);

async function submitAdjustment() {
  if (!adjValid.value) return;
  adjBusy.value = true;
  const input: AdjustmentInput = {
    kind: adjKind.value.trim(),
    amountDue: adjAmountDue.value.trim(),
  };
  const noticeIso = toIso(adjNoticeDate.value);
  if (noticeIso) input.noticeDate = noticeIso;
  if (adjAbated.value.trim()) input.abatedAmount = adjAbated.value.trim();
  if (adjAmountPaid.value.trim()) input.amountPaid = adjAmountPaid.value.trim();
  const paidIso = toIso(adjPaidOn.value);
  if (paidIso) input.paidOn = paidIso;
  if (adjEftps.value.trim()) input.eftpsConfirmation = adjEftps.value.trim();
  if (adjNote.value.trim()) input.note = adjNote.value.trim();
  try {
    if (adjTarget.value) {
      await adminFilingsApi.updateAdjustment(filingId, adjTarget.value.id, input);
      notify.success("Adjustment updated");
    } else {
      await adminFilingsApi.addAdjustment(filingId, input);
      notify.success("Adjustment added", "The worksheet's line 13 now includes the payment.");
    }
    adjDialog.value = false;
    await load();
  } catch (err) {
    notify.error(err, "Could not save the adjustment");
  } finally {
    adjBusy.value = false;
  }
}

async function removeAdjustment(row: TaxAdjustmentRow) {
  try {
    await adminFilingsApi.deleteAdjustment(filingId, row.id);
    notify.success("Adjustment removed");
    await load();
  } catch (err) {
    notify.error(err, "Could not remove the adjustment");
  }
}

onMounted(async () => {
  await load();
  fractionsText.value = filing.value?.fractionsOfCents ?? "";
});
</script>

<template>
  <div class="page stack">
    <Skeleton v-if="loading" height="16rem" />
    <template v-else-if="missingConfigYear !== null">
      <PageHeader :title="`Forms W-2/W-3 — ${missingConfigYear}`">
        <BackButton to="admin-filings" label="Back to filings" />
      </PageHeader>
      <MissingTaxConfigBanner :year="missingConfigYear" />
    </template>
    <template v-else-if="filing">
      <PageHeader
        :title="`${formLabel(filing.formType)} — ${periodLabel()}`"
        :subtitle="`Due ${date(filing.dueDate)} · worksheet hash ${filing.worksheetHash?.slice(0, 12) ?? '—'}`"
      >
        <BackButton to="admin-filings" label="Back to filings" />
        <Button label="How to file" icon="pi pi-question-circle" text size="small" @click="helpDialog = true" />
        <!-- PAY-16: filled official 941 PDF — unsigned, wet/e-sign after download -->
        <a
          v-if="filing.formType === '941' && filing.worksheet"
          :href="adminFilingsApi.f941PdfUrl(filing.id)"
          target="_blank"
          rel="noopener"
        >
          <Button label="Filled 941 PDF" icon="pi pi-download" text size="small" />
        </a>
        <!-- PAY-33: filled official 940 PDF — unsigned, wet/e-sign after download -->
        <a
          v-if="filing.formType === '940' && filing.worksheet"
          :href="adminFilingsApi.f940PdfUrl(filing.id)"
          target="_blank"
          rel="noopener"
        >
          <Button label="Filled 940 PDF" icon="pi pi-download" text size="small" />
        </a>
        <Button
          v-if="filed"
          label="Recompute worksheet"
          icon="pi pi-refresh"
          text
          size="small"
          @click="openRecompute"
        />
        <Button
          v-if="!filed"
          label="Mark as filed"
          icon="pi pi-check"
          size="small"
          :disabled="markFiledHeld"
          @click="fileDialog = true"
        />
      </PageHeader>

      <p v-if="!filed && markFiledHeld" class="muted small" style="margin: 0" data-testid="mark-filed-held">
        {{ markFiledHeldReason }}
      </p>

      <Message v-if="filed" severity="success" :closable="false">
        Filed {{ date(filing.filedOn) }}<template v-if="filing.filingMethod"> via {{ filing.filingMethod }}</template><template v-if="filing.filingReference"> · ref {{ filing.filingReference }}</template>.
        The worksheet is frozen.
      </Message>

      <section v-if="corrections.length" class="card table-scroll stack">
        <h3 style="margin: 0">Worksheet corrections</h3>
        <p class="muted small" style="margin: 0">
          Audited recomputes of the frozen worksheet (PAY-25) — filing status, date, method, and
          reference were not changed.
        </p>
        <DataTable :value="corrections" data-key="id" striped-rows>
          <Column header="When" style="width: 9rem">
            <template #body="{ data }">{{ date(data.createdAt) }}</template>
          </Column>
          <Column header="Reason">
            <template #body="{ data }">{{ data.after?.reason ?? "—" }}</template>
          </Column>
          <Column header="Hash" style="width: 14rem">
            <template #body="{ data }">
              <span class="mono small">
                {{ shortHash(data.before?.worksheetHash) }} → {{ shortHash(data.after?.worksheetHash) }}
              </span>
            </template>
          </Column>
        </DataTable>
      </section>

      <section v-if="worksheet941" class="card table-scroll">
        <h3>Worksheet <StatusChip :status="filing.status" style="margin-left: 0.5rem" /></h3>
        <DataTable :value="worksheetLines" data-key="line" striped-rows>
          <Column field="line" header="Line" style="width: 4rem" />
          <Column field="label" header="Description" />
          <Column field="value" header="Amount" style="width: 10rem; text-align: right" />
        </DataTable>

        <h4 style="margin-top: 1rem">Line 16 — monthly liability</h4>
        <p class="muted small">
          Liability by pay month (not deposits made).
          <template v-if="worksheet941.line16.deMinimis">
            Line 12 is under $2,500 — the de minimis rule applies (no monthly breakdown owed on the form).
          </template>
        </p>
        <DataTable
          :value="[
            { month: 'Month 1', amount: worksheet941.line16.month1 },
            { month: 'Month 2', amount: worksheet941.line16.month2 },
            { month: 'Month 3', amount: worksheet941.line16.month3 },
          ]"
          data-key="month"
        >
          <Column field="month" header="Month" style="width: 8rem" />
          <Column header="Liability">
            <template #body="{ data }">{{ money(data.amount) }}</template>
          </Column>
        </DataTable>

        <form v-if="!filed" class="row" style="margin-top: 1rem" @submit.prevent="saveFractions">
          <label for="fractions" class="muted small" style="align-self: center">
            Line 7 — fractions of cents (default is the computed rounding delta):
          </label>
          <InputText
            id="fractions"
            v-model="fractionsText"
            size="small"
            style="width: 7rem"
            :invalid="!fractionsValid"
          />
          <Button
            type="submit"
            label="Save"
            icon="pi pi-check"
            size="small"
            :loading="fractionsBusy"
            :disabled="!fractionsValid"
          />
        </form>
      </section>

      <section v-if="worksheet940" class="card table-scroll">
        <h3>Worksheet <StatusChip :status="filing.status" style="margin-left: 0.5rem" /></h3>
        <p class="muted small">
          Annual FUTA return. Lines 9–11 (credit reductions / adjustments) are $0 in a fully
          SUTA-paid state, so line 12 equals line 8.
        </p>
        <DataTable :value="worksheet940Lines" data-key="line" striped-rows>
          <Column field="line" header="Line" style="width: 4rem" />
          <Column field="label" header="Description" />
          <Column field="value" header="Amount" style="width: 16rem; text-align: right" />
        </DataTable>
      </section>

      <!-- PAY-162: the W-2/W-3 section renders even when the W-3 worksheet is
           null (W-2s blocked from the start), so the holds stay visible. -->
      <section v-if="filing.formType === 'w2_w3'" class="card table-scroll stack">
        <div class="row" style="justify-content: space-between; align-items: center">
          <h3 style="margin: 0">
            W-3 totals (for your records) <StatusChip :status="filing.status" style="margin-left: 0.5rem" />
          </h3>
          <!-- PAY-23: the W-3 action belongs with the W-3 card, not the W-2 list. -->
          <template v-if="!w2LoadError">
            <span v-if="anyW2Blocked" class="muted small">{{ W3_ON_HOLD_TEXT }}</span>
            <a
              v-else-if="w2FormAvailable && worksheetW3"
              :href="adminFilingsApi.w3PdfUrl(filing.year)"
              target="_blank"
              rel="noopener"
            >
              <Button label="Download W-3 (records copy)" icon="pi pi-download" size="small" text />
            </a>
          </template>
        </div>

        <Message v-if="w2LoadError" severity="error" :closable="false" data-testid="w2-load-error">
          {{ w2LoadErrorText(filing.year) }}
        </Message>
        <Message v-else-if="anyW2Blocked" severity="error" :closable="false" data-testid="w2-blocked-banner">
          <div class="stack">
            <span>{{ w2BlockedText(filing.year, w2Notified) }}</span>
            <span v-if="anyUnreadableTotals">{{ STALE_TOTALS_TEXT }}</span>
          </div>
        </Message>
        <Message v-else-if="warnOnlyCount > 0" severity="info" :closable="false" data-testid="w2-warn-banner">
          {{ w2WarningsOnlyText(warnOnlyCount, filing.year) }}
        </Message>
        <Message
          v-if="!w2LoadError && !w2FormAvailable"
          severity="warn"
          :closable="false"
          data-testid="w2-form-unavailable"
        >
          {{ formNotAvailableText(filing.year) }}
        </Message>
        <!-- PAY-206: paper employees still owed a corrected W-2. -->
        <Message
          v-if="!w2LoadError && paperCorrectionRows.length > 0"
          severity="warn"
          :closable="false"
          data-testid="w2-paper-correction-banner"
        >
          {{ paperCorrectionBanner }}
        </Message>
        <Message
          v-if="!w2LoadError && anyW2Corrected && !filed"
          severity="info"
          :closable="false"
          data-testid="w2-corrected-ssa-note"
        >
          Some W-2s were corrected after employees got them. File the corrected figures with the
          SSA as normal W-2s. Don't mark them CORRECTED. If you already printed a paper Copy A (the
          SSA's copy) with the old figures, write VOID on it and don't send it.
        </Message>

        <!-- Spec 24 (PAY-116) PR-4 (carry-over e): warning only, never a hold. -->
        <Message
          v-if="!w2LoadError && box15MissingState"
          severity="warn"
          :closable="false"
          data-testid="w3-box15-missing-id"
        >
          {{ box15MissingIdText(box15MissingState) }}
        </Message>

        <DataTable v-if="worksheetW3" :value="worksheetW3Lines" data-key="line" striped-rows>
          <Column field="line" header="Box" style="width: 3rem" />
          <Column field="label" header="Description" />
          <Column field="value" header="Amount" style="text-align: right; white-space: nowrap" />
        </DataTable>
        <p v-else class="muted" style="margin: 0">
          {{ anyW2Blocked ? "W-3 not calculated: W-2s on hold" : "W-3 not calculated yet." }}
        </p>
        <!-- Spec 24 (PAY-116) PR-4 (D-PL1): the W-3 is a records copy. -->
        <p class="muted small" style="margin: 0" data-testid="w3-records-note">{{ W3_RECORDS_NOTE }}</p>

        <template v-if="!w2LoadError">
          <!-- Spec 24 (PAY-116) PR-4 (I3): the state tax check. -->
          <div
            v-if="hasStateBoxes && (stateChecks.length > 0 || anyUnreadableTotals)"
            class="stack state-check"
            data-testid="w2-state-check"
          >
            <h4 style="margin: 0">State tax check</h4>
            <p v-if="stateChecks.length === 0" class="muted small" style="margin: 0">
              {{ STATE_CHECK_WITHHELD }}
            </p>
            <template v-else>
              <p class="muted small" style="margin: 0">{{ STATE_CHECK_INTRO }}</p>
              <ul class="stack" style="margin: 0; padding-left: 1.25rem">
                <li v-for="check in stateChecks" :key="check.state">
                  <span>{{ stateCheckText(check) }}</span>
                  <span v-if="check.reconciled" class="small" style="margin-left: 0.5rem; white-space: nowrap">
                    <i class="pi pi-check" aria-hidden="true" /> Matches
                  </span>
                  <Tag v-else value="Doesn't match" severity="danger" style="margin-left: 0.5rem" />
                </li>
              </ul>
            </template>
          </div>
          <template v-if="attentionRows.length || yearAttention.length">
            <h4 id="w2-attention" style="margin: 0">W-2s that need attention</h4>
            <ul class="stack" style="margin: 0; padding-left: 1.25rem" aria-labelledby="w2-attention">
              <!-- Spec 24 (PAY-116) PR-4: year-level holds and warnings (all W-2s). -->
              <li v-if="yearAttention.length">
                <div class="row" style="gap: 0.5rem; align-items: center">
                  <strong>All {{ filing.year }} W-2s</strong>
                  <Tag
                    v-if="yearAttention.some((i) => i.severity === 'block')"
                    value="On hold"
                    icon="pi pi-lock"
                    severity="danger"
                  />
                  <Tag v-else value="Please check" icon="pi pi-exclamation-triangle" severity="warn" />
                </div>
                <p
                  v-for="issue in yearAttention"
                  :key="w2IssueKey(issue)"
                  class="small"
                  style="margin: 0.25rem 0 0"
                  data-testid="w2-year-issue"
                >
                  {{ yearIssueText(issue, filing.year) }}
                </p>
              </li>
              <li v-for="row in attentionRows" :key="row.employeeId">
                <div class="row" style="gap: 0.5rem; align-items: center">
                  <strong>{{ row.legalName }}</strong>
                  <Tag
                    v-if="row.blocked"
                    value="On hold"
                    icon="pi pi-lock"
                    severity="danger"
                  />
                  <Tag v-else value="Please check" icon="pi pi-exclamation-triangle" severity="warn" />
                </div>
                <template v-for="issue in row.issues" :key="w2IssueKey(issue)">
                  <p class="small" style="margin: 0.25rem 0 0">
                    {{ w2IssueText(issue, { legalName: row.legalName, year: filing.year }) }}
                  </p>
                  <!-- Spec 24 (PAY-116) PR-4 (B2): the runs, outside the issue sentence. -->
                  <ul v-if="issue.runs?.length" class="small" style="margin: 0.25rem 0 0; padding-left: 1.25rem">
                    <li v-for="run in issue.runs" :key="run.runPublicId">
                      Paid {{ date(run.payDate) }} · {{ money(run.stateTax) }} state tax
                    </li>
                  </ul>
                </template>
              </li>
            </ul>
          </template>

          <h4 style="margin: 0">Employee W-2s</h4>
          <!-- PAY-23: full column titles; the card scrolls horizontally instead
               of abbreviating or double-wrapping headers. Spec 24 (PAY-116)
               PR-4: what the owner acts on first (Checks, Delivery, Documents),
               then the boxes. -->
          <DataTable :value="w2Rows" data-key="employeeId" striped-rows class="w2-table">
            <template #empty><p class="muted">No W-2 employees were paid in {{ filing.year }}.</p></template>
            <Column header="Employee">
              <template #body="{ data }">
                {{ data.legalName }}
                <Tag v-if="data.corrected" value="Corrected" severity="info" style="margin-left: 0.25rem" />
              </template>
            </Column>
            <!-- PAY-162: check results — codes rendered as fixed copy, never amounts. -->
            <Column header="Checks" style="min-width: 10rem">
              <template #body="{ data }">
                <div v-if="data.issues.length" class="row" style="gap: 0.25rem; flex-wrap: wrap">
                  <Tag
                    v-for="issue in data.issues"
                    :key="w2IssueKey(issue)"
                    :value="w2IssueLabel(issue)"
                    :severity="
                      issue.severity === 'block' ? 'danger' : issue.severity === 'info' ? 'info' : 'warn'
                    "
                  />
                </div>
                <span v-else class="muted">No problems found</span>
              </template>
            </Column>
            <!-- PAY-23: status (Delivery) and actions (Documents) stay separate
                 columns. PAY-206: the delivery channel, then how and when the
                 latest copy reached the employee. -->
            <Column header="Delivery" style="min-width: 10rem">
              <template #body="{ data }">
                <Tag
                  :value="data.consented ? 'electronic' : 'paper'"
                  :severity="data.consented ? 'success' : 'warn'"
                />
                <span :class="{ muted: data.furnished === 'none' }" style="display: block; margin-top: 0.25rem">
                  {{ furnishedText(data) }}
                </span>
                <Tag
                  v-if="data.correctionToFurnish && !data.consented"
                  value="Corrected copy needed"
                  severity="warn"
                  style="display: block; margin-top: 0.25rem; width: fit-content"
                />
              </template>
            </Column>
            <!-- PAY-23: actions live in their own Documents column — "Download
                 Copy D" reads as an action, not a label. Buttons stack. -->
            <Column header="Documents" style="min-width: 11rem">
              <template #body="{ data }">
                <span v-if="data.blocked" class="muted small">On hold – see above</span>
                <span v-else-if="!w2FormAvailable" class="muted">—</span>
                <div v-else class="stack" style="gap: 0.25rem">
                  <a
                    :href="adminFilingsApi.w2PdfUrl(data.employeeId, filing.year)"
                    target="_blank"
                    rel="noopener"
                  >
                    <Button label="Download Copy D" icon="pi pi-download" size="small" text />
                  </a>
                  <a
                    :href="adminFilingsApi.w2PrintPacketUrl(data.employeeId, filing.year)"
                    target="_blank"
                    rel="noopener"
                  >
                    <Button
                      :label="data.corrected ? 'Print corrected W-2' : 'Print packet'"
                      icon="pi pi-print"
                      size="small"
                      text
                    />
                  </a>
                  <!-- PAY-206: only paper employees still owed the corrected copy. -->
                  <Button
                    v-if="data.correctionToFurnish && !data.consented"
                    label="Mark given on paper"
                    :aria-label="`Mark ${data.legalName}'s corrected W-2 as given on paper`"
                    icon="pi pi-check"
                    size="small"
                    text
                    :loading="markPaperBusy === data.employeeId"
                    @click="markGivenOnPaper(data)"
                  />
                </div>
              </template>
            </Column>
            <Column header="Wages, tips, other compensation" style="text-align: right">
              <template #body="{ data }">{{ money(data.box1Wages) }}</template>
            </Column>
            <Column header="Federal income tax withheld" style="text-align: right">
              <template #body="{ data }">{{ money(data.box2FederalWithheld) }}</template>
            </Column>
            <Column header="Social Security tax" style="text-align: right">
              <template #body="{ data }">{{ money(data.box4SsTax) }}</template>
            </Column>
            <Column header="Medicare tax" style="text-align: right">
              <template #body="{ data }">{{ money(data.box6MedicareTax) }}</template>
            </Column>
            <!-- Spec 24 (PAY-116) PR-4: boxes 15–17, never the state number or its mask. -->
            <Column v-if="hasStateBoxes" header="State (boxes 15–17)" style="min-width: 14rem">
              <template #body="{ data }">
                <span v-if="!data.stateLines.length" class="muted">No state lines</span>
                <div v-else class="stack" style="gap: 0.25rem">
                  <div v-for="line in data.stateLines" :key="`${line.form}:${line.row}`">
                    <template v-if="data.formCount > 1">W-2 #{{ line.form }} · </template>{{ stateLineText(line) }}
                    <Tag
                      v-if="stateIdSourceTag(line.stateIdSource)"
                      :value="stateIdSourceTag(line.stateIdSource) ?? ''"
                      :severity="line.stateIdSource === null ? 'warn' : 'secondary'"
                      style="margin-left: 0.25rem"
                    />
                  </div>
                </div>
              </template>
            </Column>
          </DataTable>
          <p class="muted small" style="margin: 0">
            PDFs render on demand — SSNs and addresses are decrypted at render time and never stored.
            Print the packet (Copies B/C/2 + instructions) for employees on paper delivery; employees
            who consented download their own.
          </p>
          <!-- Spec 24 (PAY-116) PR-4 (U6): two-up pages. -->
          <p v-if="twoUpHelpText(filing.year, 'admin')" class="muted small" style="margin: 0">
            {{ twoUpHelpText(filing.year, "admin") }}
          </p>
          <!-- Spec 24 (PAY-116) PR-4 (U6, U7): more than one W-2 per employee. -->
          <div v-if="bsoText" class="stack" data-testid="w2-multi-form">
            <h4 style="margin: 0">Employees with more than one W-2</h4>
            <ul class="stack small" style="margin: 0; padding-left: 1.25rem">
              <li v-for="row in multiFormRows" :key="row.employeeId">
                {{ multiW2Text(row.formCount, row.legalName) }}
              </li>
            </ul>
            <p class="small" style="margin: 0">{{ bsoText.e1 }}</p>
            <ul class="small" style="margin: 0; padding-left: 1.25rem">
              <li v-for="line in bsoText.e2" :key="line">{{ line }}</li>
            </ul>
          </div>
        </template>
      </section>

      <section class="card table-scroll stack">
        <div class="row" style="justify-content: space-between; align-items: center">
          <h3 style="margin: 0">Attachments</h3>
          <div class="row" style="gap: 0.5rem; align-items: center">
            <input
              :key="attachInputKey"
              type="file"
              accept="application/pdf,.pdf"
              aria-label="Confirmation PDF"
              @change="onAttachPick"
            />
            <Button
              label="Upload"
              icon="pi pi-upload"
              size="small"
              :loading="attachBusy"
              :disabled="!attachFile"
              @click="submitAttachment"
            />
          </div>
        </div>
        <p class="muted small" style="margin: 0">
          Confirmation documents from the filing authority — e.g. the SSA BSO receipt for the
          W-2/W-3 submission or an IRS e-file acknowledgment. Stored encrypted; every download is
          audit-logged.
        </p>
        <DataTable :value="attachments" data-key="id" striped-rows>
          <template #empty>
            <p class="muted">No attachments yet — upload the confirmation PDF after filing.</p>
          </template>
          <Column field="filename" header="File" />
          <Column header="Size" style="width: 6rem; text-align: right">
            <template #body="{ data }">{{ fileSize(data.sizeBytes) }}</template>
          </Column>
          <Column header="Uploaded" style="width: 9rem">
            <template #body="{ data }">{{ date(data.createdAt) }}</template>
          </Column>
          <Column header="" style="width: 7rem">
            <template #body="{ data }">
              <a
                :href="adminFilingsApi.attachmentDownloadUrl(filing.id, data.id)"
                target="_blank"
                rel="noopener"
              >
                <Button label="View" icon="pi pi-download" size="small" text />
              </a>
            </template>
          </Column>
        </DataTable>
      </section>

      <section v-if="worksheet941" class="card stack">
        <div class="row" style="justify-content: space-between">
          <h3 style="margin: 0">Adjustments &amp; notices</h3>
          <Button
            v-if="!filed"
            label="Add adjustment"
            icon="pi pi-plus"
            size="small"
            text
            @click="openAdjDialog(null)"
          />
        </div>
        <p class="muted small">
          IRS notices, penalties, and interest for this quarter (e.g. a CP220). Payments recorded
          here count toward line 13 so the quarter reconciles to your IRS account.
        </p>
        <DataTable :value="adjustments" data-key="id" striped-rows>
          <template #empty><p class="muted">No adjustments recorded for this quarter.</p></template>
          <Column field="kind" header="Kind" style="width: 7rem" />
          <Column header="Notice date" style="width: 8rem">
            <template #body="{ data }">{{ data.noticeDate ? date(data.noticeDate) : "—" }}</template>
          </Column>
          <Column header="Amount due" style="width: 8rem">
            <template #body="{ data }">{{ money(data.amountDue) }}</template>
          </Column>
          <Column header="Abated" style="width: 8rem">
            <template #body="{ data }">{{ money(data.abatedAmount) }}</template>
          </Column>
          <Column header="Paid" style="width: 12rem">
            <template #body="{ data }">
              <template v-if="Number(data.amountPaid) > 0">
                {{ money(data.amountPaid) }}<template v-if="data.paidOn"> · {{ date(data.paidOn) }}</template>
              </template>
              <span v-else class="muted">—</span>
            </template>
          </Column>
          <Column field="note" header="Note" />
          <Column v-if="!filed" header="" style="width: 8rem">
            <template #body="{ data }">
              <Button icon="pi pi-pencil" text size="small" aria-label="Edit" @click="openAdjDialog(data)" />
              <Button icon="pi pi-trash" text size="small" severity="danger" aria-label="Delete" @click="removeAdjustment(data)" />
            </template>
          </Column>
        </DataTable>
      </section>

      <Dialog v-model:visible="recomputeDialog" modal header="Recompute worksheet" :style="{ width: '36rem' }">
        <div class="stack">
          <p class="muted small" style="margin: 0">
            Recomputes the worksheet from frozen issued-run entries and current config, and records
            the correction in the audit log. Filing status, date, method, and reference are not
            changed.
          </p>
          <Skeleton v-if="recomputeLoading" height="6rem" />
          <template v-else>
            <p v-if="!recomputeDiff.length" class="muted small" style="margin: 0">
              Recomputation produces the current worksheet — no line changes. You can still record
              a correction (e.g. to log a review).
            </p>
            <DataTable v-else :value="recomputeDiff" striped-rows>
              <Column field="key" header="Line" />
              <Column field="before" header="Current" style="width: 8rem; text-align: right" />
              <Column field="after" header="Recomputed" style="width: 8rem; text-align: right" />
            </DataTable>
            <div class="field">
              <label for="recomputeReason">Reason (required — written to the audit log)</label>
              <Textarea
                id="recomputeReason"
                v-model="recomputeReason"
                rows="3"
                maxlength="500"
                auto-resize
                placeholder="e.g. corrected to match filed return, Letterstream 13601563"
              />
            </div>
          </template>
          <div class="row dialog-actions">
            <Button label="Cancel" text severity="secondary" @click="recomputeDialog = false" />
            <Button
              label="Recompute worksheet"
              icon="pi pi-check"
              severity="warn"
              :loading="recomputeBusy"
              :disabled="!recomputeReason.trim() || recomputeLoading"
              @click="submitRecompute"
            />
          </div>
        </div>
      </Dialog>

      <Dialog v-model:visible="fileDialog" modal header="Mark as filed" :style="{ width: '26rem' }">
        <div class="stack">
          <p class="muted small">
            {{ markFiledLeadText(filing.formType, formLabel(filing.formType), periodLabel()) }}
          </p>
          <!-- Spec 24 (PAY-116) PR-4 (carry-over e): a warning only. -->
          <Message
            v-if="filing.formType === 'w2_w3' && box15MissingState"
            severity="warn"
            :closable="false"
          >
            {{ box15MissingIdText(box15MissingState) }}
          </Message>
          <!-- PAY-206: a warning only; the SSA filing uses the current figures. -->
          <Message
            v-if="filing.formType === 'w2_w3' && paperCorrectionRows.length > 0"
            severity="warn"
            :closable="false"
            data-testid="mark-filed-paper-warning"
          >
            {{ paperCorrectionWarning }}
          </Message>
          <div class="field">
            <label for="filedOn">Filing date</label>
            <DatePicker id="filedOn" v-model="filedOn" date-format="yy-mm-dd" show-icon />
          </div>
          <div class="field">
            <label for="filingMethod">Method</label>
            <Select id="filingMethod" v-model="filingMethod" :options="methodOptions" option-label="label" option-value="value" />
          </div>
          <div class="field">
            <label for="filingReference">Reference (e.g. Letterstream Job ID)</label>
            <InputText id="filingReference" v-model="filingReference" maxlength="100" />
          </div>
          <div class="field">
            <label for="filedAttachment">Confirmation PDF (optional)</label>
            <input
              id="filedAttachment"
              :key="`filed-${attachInputKey}`"
              type="file"
              accept="application/pdf,.pdf"
              @change="onFiledAttachmentPick"
            />
            <small class="muted">e.g. the SSA BSO receipt or the e-file acknowledgment.</small>
          </div>
          <div class="row dialog-actions">
            <Button label="Cancel" text severity="secondary" @click="fileDialog = false" />
            <Button
              label="Record filing"
              icon="pi pi-check"
              :loading="fileBusy"
              :disabled="!filedOn"
              @click="submitFiled"
            />
          </div>
        </div>
      </Dialog>

      <Dialog
        v-model:visible="helpDialog"
        modal
        :header="`How to file — ${formLabel(filing.formType)}`"
        :style="{ width: '30rem' }"
      >
        <div v-if="filing.formType === '941'" class="stack">
          <ol style="margin: 0; padding-left: 1.25rem" class="stack">
            <li>Copy the worksheet figures above onto the official <strong>Form 941</strong> (Rev. March 2026) — the IRS fillable PDF at irs.gov/forms-pubs works well.</li>
            <li><strong>Sign</strong> the form in Part 5 — a paper return needs a handwritten signature.</li>
            <li>
              File it:
              <ul style="padding-left: 1.25rem">
                <li><strong>By mail</strong> — upload the signed PDF to Letterstream; note the Job ID.</li>
                <li><strong>E-file</strong> — through an IRS-authorized e-file provider (irs.gov/e-file-providers).</li>
              </ul>
            </li>
            <li>Come back and choose <strong>Mark as filed</strong> with the date and reference.</li>
          </ol>
          <p class="muted small">
            Deposits are separate from the filing — pay those monthly on eftps.gov (see Tax deposits).
          </p>
        </div>
        <div v-else-if="filing.formType === '940'" class="stack">
          <ol style="margin: 0; padding-left: 1.25rem" class="stack">
            <li>Copy the worksheet figures above onto the official <strong>Form 940</strong> — the IRS fillable PDF at irs.gov/forms-pubs works well.</li>
            <li><strong>Sign</strong> the form in Part 7 — a paper return needs a handwritten signature.</li>
            <li>
              File it:
              <ul style="padding-left: 1.25rem">
                <li><strong>By mail</strong> — upload the signed PDF to Letterstream; note the Job ID.</li>
                <li><strong>E-file</strong> — through an IRS-authorized e-file provider (irs.gov/e-file-providers).</li>
              </ul>
            </li>
            <li>Come back and choose <strong>Mark as filed</strong> with the date and reference.</li>
          </ol>
          <p class="muted small">
            FUTA deposits are separate from the filing — when cumulative liability crosses $500 in a
            quarter, deposit by the end of the following month on eftps.gov (see the deposit rule
            line in the worksheet).
          </p>
        </div>
        <div v-else class="stack">
          <ol style="margin: 0; padding-left: 1.25rem" class="stack">
            <li>{{ W2_DOWNLOAD_STEP }}</li>
            <li>
              File electronically via the SSA's <strong>Business Services Online</strong> portal at
              <strong>ssa.gov/bso</strong> — register for a BSO account, then upload the W-2 data
              (BSO also accepts manual entry for small counts). W-2s with more than 10 information
              returns in total <em>must</em> be e-filed.
            </li>
            <!-- Spec 24 (PAY-116) PR-4 (S24-D9): one line per state on the W-2s. -->
            <li v-for="line in stateChecklist" :key="line">{{ line }}</li>
            <li>
              Employees can also download their own W-2 from their payslips page starting in
              January — the amounts above are what they will see.
            </li>
            <li>Come back and choose <strong>Mark as filed</strong> with the date and BSO confirmation.</li>
          </ol>
          <p class="muted small">
            W-2s are due to employees and the SSA by January 31. PDFs render on demand — nothing
            with SSNs is stored in this app.
          </p>
        </div>
      </Dialog>

      <Dialog
        v-model:visible="adjDialog"
        modal
        :header="adjTarget ? 'Edit adjustment' : 'Add adjustment'"
        :style="{ width: '30rem' }"
      >
        <div class="stack">
          <div class="field">
            <label for="adjKind">Kind (notice type)</label>
            <InputText id="adjKind" v-model="adjKind" list="adj-kinds" maxlength="50" required />
            <datalist id="adj-kinds">
              <option v-for="k in KIND_SUGGESTIONS" :key="k" :value="k" />
            </datalist>
          </div>
          <div class="field">
            <label for="adjNoticeDate">Notice date</label>
            <DatePicker id="adjNoticeDate" v-model="adjNoticeDate" date-format="yy-mm-dd" show-icon />
          </div>
          <div class="field">
            <label for="adjAmountDue">Amount due</label>
            <InputText id="adjAmountDue" v-model="adjAmountDue" required :invalid="!adjValid" />
          </div>
          <div class="field">
            <label for="adjAbated">Abated amount</label>
            <InputText id="adjAbated" v-model="adjAbated" />
          </div>
          <div class="field">
            <label for="adjAmountPaid">Amount paid</label>
            <InputText id="adjAmountPaid" v-model="adjAmountPaid" />
          </div>
          <div class="field">
            <label for="adjPaidOn">Paid on</label>
            <DatePicker id="adjPaidOn" v-model="adjPaidOn" date-format="yy-mm-dd" show-icon />
          </div>
          <div class="field">
            <label for="adjEftps">EFTPS confirmation</label>
            <InputText id="adjEftps" v-model="adjEftps" maxlength="100" />
          </div>
          <div class="field">
            <label for="adjNote">Note</label>
            <Textarea id="adjNote" v-model="adjNote" rows="2" auto-resize maxlength="2000" />
          </div>
          <div class="row dialog-actions">
            <Button label="Cancel" text severity="secondary" @click="adjDialog = false" />
            <Button
              label="Save"
              icon="pi pi-check"
              :loading="adjBusy"
              :disabled="!adjValid"
              @click="submitAdjustment"
            />
          </div>
        </div>
      </Dialog>
    </template>
  </div>
</template>

<style scoped>
.dialog-actions {
  justify-content: flex-end;
}
/* Spec 24 (PAY-116) PR-4: amounts wrap as a unit at phone width. */
.state-check li {
  overflow-wrap: anywhere;
}
/* Spec 24 (PAY-116) PR-4: stacked document buttons keep each label on one line. */
.w2-table :deep(.p-button-label) {
  white-space: nowrap;
}
/* PAY-23: full headers never wrap — the card scrolls horizontally instead. */
.w2-table :deep(th) {
  white-space: nowrap;
}
</style>

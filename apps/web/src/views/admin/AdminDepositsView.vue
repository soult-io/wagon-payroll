<script setup lang="ts">
/**
 * Admin tax deposits (PAY-9): the computed monthly federal deposit schedule —
 * amount from issued payroll runs, due date (15th of the following month,
 * weekend-rolled), status chip (overdue highlighted) — plus the record-only
 * "mark as deposited" dialog (EFTPS date + confirmation number) and the
 * admin-editable reminder schedule (D1). The app never pays; deposits happen
 * on eftps.gov and are recorded here.
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import Button from "primevue/button";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import DatePicker from "primevue/datepicker";
import Select from "primevue/select";
import Skeleton from "primevue/skeleton";
import Message from "primevue/message";
import PageHeader from "../../components/PageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import StatusChip from "../../components/StatusChip.vue";
import { jurisdictionLabel as sharedJurisdictionLabel } from "@payroll/shared";
import { adminDepositsApi, type DepositAttachment, type TaxDepositRow } from "../../lib/api";
import { isAdditionalDeposit, withAdditionalPrefix } from "../../lib/deposit-labels";
import { useDates } from "../../composables/useDates";
import { useMoney } from "../../composables/useMoney";
import { useNotify } from "../../composables/useNotify";
import {
  SELECT_ALL,
  useQueryEnum,
  useQueryNumber,
  useQueryParam,
  useSelectAll,
} from "../../composables/useQueryFilters";

const { date, toIso } = useDates();
const { money } = useMoney();
const notify = useNotify();

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? `Month ${month}`;
}

function periodLabel(periodStart: string, periodKind?: "month" | "quarter"): string {
  if (periodKind === "quarter") {
    const year = Number(periodStart.slice(0, 4));
    const quarter = Math.ceil(Number(periodStart.slice(5, 7)) / 3);
    return `Q${quarter} ${year}`;
  }
  const month = Number(periodStart.slice(5, 7));
  return `${monthName(month)} ${periodStart.slice(0, 4)}`;
}

/** PAY-193 D9.6: a shortfall row (seq > 0) reads "Additional deposit for {period}". */
function rowPeriodLabel(row: Pick<TaxDepositRow, "periodStart" | "periodKind" | "seq">): string {
  return withAdditionalPrefix(row, periodLabel(row.periodStart, row.periodKind));
}

/**
 * PAY-193: newest period first; within a period, by jurisdiction, then seq,
 * so an additional deposit sits right after the deposit it follows.
 */
function byPeriodJurisdictionSeq(a: TaxDepositRow, b: TaxDepositRow): number {
  if (a.periodStart !== b.periodStart) return a.periodStart < b.periodStart ? 1 : -1;
  // Federal first, then states by code.
  const ja = a.jurisdiction === "federal" ? "" : a.jurisdiction;
  const jb = b.jurisdiction === "federal" ? "" : b.jurisdiction;
  if (ja !== jb) return ja < jb ? -1 : 1;
  return a.seq - b.seq || b.id - a.id;
}

/** "California (CA)" / "Federal" — shared map (PAY-91 UX). */
function jurisdictionLabel(jurisdiction: string): string {
  return sharedJurisdictionLabel(jurisdiction);
}

/** Numeric Amount sort: API sends amount as a string; a fixed-width zero-padded
 *  decimal keeps PrimeVue's string sort numerically correct. */
function amountSortField(row: TaxDepositRow): string {
  return Number(row.amount).toFixed(2).padStart(14, "0");
}

// -------------------------------------------------------------------- deposits
const loading = ref(true);
const rows = ref<TaxDepositRow[]>([]);

// PAY-15: year paging + status filter, same pattern as the payroll-runs list.
// PAY-17: filters live in the route query (?year=&status=) so list state is
// bookmarkable and survives browser-back.
const statusFilter = useQueryEnum("status", null, ["pending", "deposited", "overdue"] as const);
const statusSelect = useSelectAll(statusFilter);
const statusOptions = [
  { label: "All statuses", value: SELECT_ALL },
  { label: "Pending", value: "pending" },
  { label: "Deposited", value: "deposited" },
  { label: "Overdue", value: "overdue" },
];

const jurisdictionFilter = useQueryParam<string>("jurisdiction", null, (raw) =>
  raw === "federal" || /^[A-Z]{2}$/.test(raw) ? raw : null,
);
const jurisdictionSelect = useSelectAll(jurisdictionFilter);

const yearFilter = useQueryNumber("year", new Date().getFullYear());
/** Year options derived from the DATA (never hardcoded), plus the current year. */
const yearOptions = ref<{ label: string; value: number | null }[]>([
  { label: "All years", value: null },
]);

const jurisdictionOptions = ref<{ label: string; value: string }[]>([
  { label: "All jurisdictions", value: SELECT_ALL },
]);

async function load() {
  loading.value = true;
  try {
    const filter: {
      status?: "pending" | "deposited" | "overdue";
      year?: number;
      jurisdiction?: string;
    } = {};
    if (statusFilter.value) filter.status = statusFilter.value;
    if (yearFilter.value) filter.year = yearFilter.value;
    if (jurisdictionFilter.value) filter.jurisdiction = jurisdictionFilter.value;
    const { deposits } = await adminDepositsApi.list(filter);
    rows.value = [...deposits].sort(byPeriodJurisdictionSeq);
  } catch (err) {
    notify.error(err, "Could not load tax deposits");
  } finally {
    loading.value = false;
  }
}

watch([statusFilter, yearFilter, jurisdictionFilter], load);

const today = new Date().toISOString().slice(0, 10);

/** PAY-91: a 0.00 row (monthly payments already cover it, or runs voided). */
function nothingToPay(row: TaxDepositRow): boolean {
  return row.status !== "deposited" && /^0+(\.0+)?$/.test(row.amount);
}

function isOverdue(row: TaxDepositRow): boolean {
  if (nothingToPay(row)) return false;
  return row.status === "overdue" || (row.status === "pending" && row.dueDate < today);
}

/** UX: on the state-quarter's 0.00 anchor row, "Overpaid" replaces "Nothing left to pay". */
function statusChip(row: TaxDepositRow): string {
  if (nothingToPay(row)) return isOverpaid(row) ? "overpaid" : "nothing_to_pay";
  return isOverdue(row) ? "overdue" : row.status;
}

/** A second chip only when the anchor row is not a 0.00 row (a lone deposited quarter). */
function extraOverpaidChip(row: TaxDepositRow): boolean {
  return isOverpaid(row) && !nothingToPay(row);
}

function isOverpaid(row: TaxDepositRow): boolean {
  return !!row.overpaid && !/^0+(\.0+)?$/.test(row.overpaid);
}

function rowClass(row: TaxDepositRow): string {
  return isOverdue(row) ? "row-overdue" : "";
}

// -------------------------------------------------------- mark as deposited
const depositDialog = ref(false);
const depositBusy = ref(false);
const depositTarget = ref<TaxDepositRow | null>(null);
const depositedOn = ref<Date | null>(new Date());
const eftpsConfirmation = ref("");

function openDepositDialog(row: TaxDepositRow) {
  depositTarget.value = row;
  depositedOn.value = new Date();
  eftpsConfirmation.value = "";
  depositDialog.value = true;
}

async function submitDeposit() {
  const target = depositTarget.value;
  const iso = toIso(depositedOn.value);
  if (!target || !iso) return;
  depositBusy.value = true;
  try {
    await adminDepositsApi.markDeposited(target.id, {
      depositedOn: iso,
      eftpsConfirmation: eftpsConfirmation.value.trim(),
    });
    notify.success("Deposit recorded", `${rowPeriodLabel(target)} marked as deposited.`);
    depositDialog.value = false;
    await load();
  } catch (err) {
    notify.error(err, "Could not record the deposit");
  } finally {
    depositBusy.value = false;
  }
}

// ------------------------------------------------------------- confirmation (PAY-38)
const confirmationDialog = ref(false);
const confirmationTarget = ref<TaxDepositRow | null>(null);

function openConfirmationDialog(row: TaxDepositRow) {
  confirmationTarget.value = row;
  confirmationDialog.value = true;
}

// ------------------------------------------------------------- attachments (PAY-27)
const attachDialog = ref(false);
const attachTarget = ref<TaxDepositRow | null>(null);
const attachments = ref<DepositAttachment[]>([]);
const attachLoading = ref(false);
const attachFile = ref<File | null>(null);
const attachBusy = ref(false);
/** Bump to reset the native file input after a successful upload. */
const attachInputKey = ref(0);

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function openAttachments(row: TaxDepositRow) {
  attachTarget.value = row;
  attachFile.value = null;
  attachInputKey.value += 1;
  attachDialog.value = true;
  attachLoading.value = true;
  try {
    attachments.value = (await adminDepositsApi.listAttachments(row.id)).attachments;
  } catch (err) {
    notify.error(err, "Could not load attachments");
  } finally {
    attachLoading.value = false;
  }
}

function onAttachPick(event: Event) {
  attachFile.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

async function submitAttachment() {
  const target = attachTarget.value;
  const file = attachFile.value;
  if (!target || !file) return;
  attachBusy.value = true;
  try {
    await adminDepositsApi.uploadAttachment(target.id, file);
    notify.success("Attachment uploaded", file.name);
    attachFile.value = null;
    attachInputKey.value += 1;
    attachments.value = (await adminDepositsApi.listAttachments(target.id)).attachments;
  } catch (err) {
    notify.error(err, "Could not upload the attachment");
  } finally {
    attachBusy.value = false;
  }
}

const router = useRouter();
const scheduleLoading = ref(true);
const scheduleBusy = ref(false);
const offsetsText = ref("");
const defaultOffsets = ref<number[]>([]);

async function loadSchedule() {
  scheduleLoading.value = true;
  try {
    const res = await adminDepositsApi.reminderSchedule();
    offsetsText.value = res.offsets.join(", ");
    defaultOffsets.value = res.defaultOffsets;
  } catch (err) {
    notify.error(err, "Could not load the reminder schedule");
  } finally {
    scheduleLoading.value = false;
  }
}

/** "5, 0" → [5, 0]; null when the input is not a valid offset list. */
function parseOffsets(text: string): number[] | null {
  const parts = text
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length === 0 || parts.length > 10) return null;
  const offsets = parts.map(Number);
  if (offsets.some((n) => !Number.isInteger(n) || n < 0 || n > 30)) return null;
  return offsets;
}

const parsedOffsets = computed(() => parseOffsets(offsetsText.value));

async function saveSchedule() {
  const offsets = parsedOffsets.value;
  if (!offsets) return;
  scheduleBusy.value = true;
  try {
    const res = await adminDepositsApi.putReminderSchedule(offsets);
    offsetsText.value = res.offsets.join(", ");
    notify.success(
      "Reminder schedule saved",
      `Reminders fire ${res.offsets.join(", ")} days before the due date.`,
    );
  } catch (err) {
    notify.error(err, "Could not save the reminder schedule");
  } finally {
    scheduleBusy.value = false;
  }
}

function handleRowClick(event: { data: TaxDepositRow }) {
  router.push({ name: "admin-deposit-detail", params: { id: event.data.id } });
}

onMounted(async () => {
  try {
    // Unfiltered list: the source of the dynamic year options.
    const { deposits: all } = await adminDepositsApi.list();
    const years = [...new Set(all.map((d) => Number(d.periodStart.slice(0, 4))))].sort(
      (a, b) => b - a,
    );
    const current = new Date().getFullYear();
    if (!years.includes(current)) years.unshift(current);
    // A year from the URL query may have no deposits at all — keep it selectable.
    const fromQuery = yearFilter.value;
    if (fromQuery !== null && !years.includes(fromQuery)) {
      years.push(fromQuery);
      years.sort((a, b) => b - a);
    }
    yearOptions.value = [
      { label: "All years", value: null },
      ...years.map((y) => ({ label: String(y), value: y })),
    ];

    // Build jurisdiction options from unique values in 'all'
    const jurisdictions = [...new Set(all.map((d) => d.jurisdiction))].sort((a, b) => {
      if (a === "federal") return -1;
      if (b === "federal") return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    jurisdictionOptions.value = [
      { label: "All jurisdictions", value: SELECT_ALL },
      ...jurisdictions.map((j) => ({
        label: jurisdictionLabel(j),
        value: j,
      })),
    ];

    // If jurisdictionFilter.value is set and not already in the list, append it
    if (
      jurisdictionFilter.value &&
      !jurisdictionOptions.value.some((o) => o.value === jurisdictionFilter.value)
    ) {
      jurisdictionOptions.value.push({
        label: jurisdictionLabel(jurisdictionFilter.value),
        value: jurisdictionFilter.value,
      });
    }
  } catch (err) {
    notify.error(err, "Could not load tax deposits");
  }
  await Promise.all([load(), loadSchedule()]);
});
</script>

<template>
  <div class="page stack">
    <PageHeader
      title="Tax deposits"
      subtitle="Federal and state payroll tax deposits — computed from issued payroll runs. Record-only: pay on eftps.gov (or the state portal), then record the confirmation here."
    >
      <Select v-model="yearFilter" :options="yearOptions" option-label="label" option-value="value" size="small" />
      <Select v-model="statusSelect" :options="statusOptions" option-label="label" option-value="value" size="small" />
      <Select v-model="jurisdictionSelect" :options="jurisdictionOptions" option-label="label" option-value="value" size="small" />
    </PageHeader>

    <section class="card table-scroll">
      <Skeleton v-if="loading" height="10rem" />
      <DataTable v-else :value="rows" data-key="id" striped-rows :row-class="rowClass" row-hover @row-click="handleRowClick">
        <template #empty>
          <EmptyState
            icon="pi pi-calendar"
            title="No deposits yet"
            body="Deposit rows appear as soon as a month has issued payroll runs — the daily scheduler syncs the schedule."
          />
        </template>
        <Column field="periodStart" header="Period" style="width: 10rem" sortable>
          <template #body="{ data }">
            {{ rowPeriodLabel(data) }}
            <div v-if="isAdditionalDeposit(data)" class="muted small" data-testid="additional-line">
              Extra payment — a payroll was added after this period was paid.
            </div>
          </template>
        </Column>
        <Column field="jurisdiction" header="Jurisdiction" style="width: 8rem" sortable sortField="jurisdiction">
  <template #body="{ data }">
    {{ jurisdictionLabel(data.jurisdiction) }}
  </template>
</Column>
        <Column header="Amount" style="width: 9rem" sortable :sort-field="amountSortField">
          <template #body="{ data }">{{ money(data.amount) }}</template>
        </Column>
        <Column field="dueDate" header="Due date" style="width: 10rem" sortable>
          <template #body="{ data }">
            <span :class="{ 'overdue-text': isOverdue(data) }" style="white-space: nowrap">{{ date(data.dueDate) }}</span>
          </template>
        </Column>
        <Column field="status" header="Status" style="width: 11rem" sortable>
          <template #body="{ data }">
            <div class="chips">
              <StatusChip :status="statusChip(data)" />
              <StatusChip v-if="extraOverpaidChip(data)" status="overpaid" />
            </div>
            <p v-if="data.paymentsUnavailable" class="muted small unavailable">
              Amount not checked. Open this deposit before you pay.
            </p>
          </template>
        </Column>
        <Column header="Deposited" style="width: 12rem" sortable sort-field="depositedOn">
          <template #body="{ data }">
            <template v-if="data.status === 'deposited'">
              {{ date(data.depositedOn) }}
            </template>
            <span v-else class="muted">—</span>
          </template>
        </Column>
        <Column header="Actions" style="width: 16rem">
          <template #body="{ data }">
            <Button
              v-if="data.status !== 'deposited' && !nothingToPay(data)"
              label="Mark as deposited"
              size="small"
              text
              @click.stop="openDepositDialog(data)"
            />
            <Button
              label="Attachments"
              icon="pi pi-paperclip"
              size="small"
              text
              @click.stop="openAttachments(data)"
            />
            <Button
              v-if="data.status === 'deposited' && data.eftpsConfirmation"
              label="View confirmation"
              icon="pi pi-eye"
              size="small"
              text
              @click.stop="openConfirmationDialog(data)"
            />
          </template>
        </Column>
      </DataTable>
    </section>

    <section class="card stack">
      <h3>Reminder schedule</h3>
      <Skeleton v-if="scheduleLoading" height="4rem" />
      <template v-else>
        <p class="muted small">
          Days before the due date when admins get an email reminder — comma-separated, each
          between 0 and 30. Default: {{ defaultOffsets.join(", ") }}.
        </p>
        <form class="row" @submit.prevent="saveSchedule">
          <InputText
            v-model="offsetsText"
            aria-label="Reminder offsets in days"
            placeholder="e.g. 5, 0"
            :invalid="parsedOffsets === null"
          />
          <Button
            type="submit"
            label="Save"
            icon="pi pi-check"
            :loading="scheduleBusy"
            :disabled="parsedOffsets === null"
          />
        </form>
        <Message v-if="parsedOffsets === null" severity="error" :closable="false">
          Enter 1–10 whole numbers between 0 and 30, comma-separated.
        </Message>
      </template>
    </section>

    <Dialog
      v-model:visible="attachDialog"
      modal
      header="EFTPS confirmation attachments"
      :style="{ width: '34rem' }"
    >
      <div v-if="attachTarget" class="stack">
        <p class="muted small" style="margin: 0">
          {{ rowPeriodLabel(attachTarget) }} — {{ money(attachTarget.amount) }}.
          Payment confirmations from eftps.gov (acknowledgment PDFs / receipts). Stored encrypted;
          every download is audit-logged.
        </p>
        <div class="row" style="gap: 0.5rem; align-items: center">
          <input
            :key="attachInputKey"
            type="file"
            accept="application/pdf,.pdf"
            aria-label="EFTPS confirmation PDF"
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
        <Skeleton v-if="attachLoading" height="4rem" />
        <DataTable v-else :value="attachments" data-key="id" striped-rows>
          <template #empty>
            <p class="muted">No attachments yet — upload the EFTPS confirmation PDF.</p>
          </template>
          <Column field="filename" header="File" />
          <Column header="Size" style="width: 6rem; text-align: right">
            <template #body="{ data }">{{ fileSize(data.sizeBytes) }}</template>
          </Column>
          <Column header="Uploaded" style="width: 8rem">
            <template #body="{ data }">{{ date(data.createdAt) }}</template>
          </Column>
          <Column header="" style="width: 6rem">
            <template #body="{ data }">
              <a
                :href="adminDepositsApi.attachmentDownloadUrl(attachTarget.id, data.id)"
                target="_blank"
                rel="noopener"
              >
                <Button label="View" icon="pi pi-download" size="small" text />
              </a>
            </template>
          </Column>
        </DataTable>
      </div>
    </Dialog>

    <Dialog
      v-model:visible="depositDialog"
      modal
      header="Mark as deposited"
      :style="{ width: '26rem' }"
    >
      <div v-if="depositTarget" class="stack">
        <p class="muted small">
          {{ rowPeriodLabel(depositTarget) }} — {{ money(depositTarget.amount) }},
          due {{ date(depositTarget.dueDate) }}. Pay on eftps.gov first; this records the deposit.
        </p>
        <div class="field">
          <label for="depositedOn">Deposit date</label>
          <DatePicker id="depositedOn" v-model="depositedOn" date-format="yy-mm-dd" show-icon />
        </div>
        <div class="field">
          <label for="eftpsConfirmation">EFTPS confirmation number</label>
          <InputText id="eftpsConfirmation" v-model="eftpsConfirmation" required maxlength="100" />
        </div>
        <div class="row dialog-actions">
          <Button label="Cancel" text severity="secondary" @click="depositDialog = false" />
          <Button
            label="Record deposit"
            icon="pi pi-check"
            :loading="depositBusy"
            :disabled="!depositedOn || !eftpsConfirmation.trim()"
            @click="submitDeposit"
          />
        </div>
      </div>
    </Dialog>

    <Dialog
      v-model:visible="confirmationDialog"
      modal
      header="EFTPS confirmation"
      :style="{ width: '22rem' }"
    >
      <div v-if="confirmationTarget" class="stack">
        <p class="muted small">
          {{ rowPeriodLabel(confirmationTarget) }}
        </p>
        <div class="field">
          <label>Deposited on</label>
          <InputText :model-value="date(confirmationTarget.depositedOn)" readonly />
        </div>
        <div class="field">
          <label>Confirmation number</label>
          <InputText :model-value="confirmationTarget.eftpsConfirmation" readonly />
        </div>
        <div class="row dialog-actions">
          <Button label="Close" text @click="confirmationDialog = false" />
        </div>
      </div>
    </Dialog>
  </div>
</template>

<style scoped>
.unavailable {
  margin: 0.25rem 0 0;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.row-overdue {
  background: var(--p-red-50, #fef2f2);
}
.overdue-text {
  color: var(--p-red-700, #b91c1c);
  font-weight: 600;
}
.dialog-actions {
  justify-content: flex-end;
}
</style>

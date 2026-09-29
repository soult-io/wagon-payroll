<script setup lang="ts">
/**
 * Admin tax filings (PAY-10): quarterly Form 941 tracking — status chip,
 * due date (weekend-rolled), filed reference (e.g. the Letterstream Job
 * ID) — with year paging + status/form filters (same pattern as the
 * deposits list). Row → filing detail (worksheet, adjustments, mark-filed).
 * Record-only: the app never files; the admin files and records it here.
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import Button from "primevue/button";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import InputText from "primevue/inputtext";
import Message from "primevue/message";
import Select from "primevue/select";
import Skeleton from "primevue/skeleton";
import Tag from "primevue/tag";
import PageHeader from "../../components/PageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import StatusChip from "../../components/StatusChip.vue";
import MissingTaxConfigBanner from "../../components/MissingTaxConfigBanner.vue";
import {
  adminFilingsApi,
  type TaxFilingRow,
  type TaxFilingStatus,
  type TaxFormType,
} from "../../lib/api";
import { useDates } from "../../composables/useDates";
import { useNotify } from "../../composables/useNotify";
import {
  useQueryEnum,
  useQueryNumber,
  SELECT_ALL,
  useSelectAll,
} from "../../composables/useQueryFilters";

const route = useRoute();
const router = useRouter();
const { date } = useDates();
const notify = useNotify();

const FORM_LABELS: Record<string, string> = {
  "941": "Form 941",
  "940": "Form 940",
  w2_w3: "W-2/W-3",
};

function formLabel(formType: string): string {
  return FORM_LABELS[formType] ?? formType;
}

function periodLabel(row: TaxFilingRow): string {
  return row.quarter === 0 ? String(row.year) : `Q${row.quarter} ${row.year}`;
}

const loading = ref(true);
const rows = ref<TaxFilingRow[]>([]);
/** PAY-162: years whose W-2/W-3 is blocked by missing federal tax settings. */
const missingConfigYears = computed(() => [
  ...new Set(
    rows.value.flatMap((r) =>
      (r.issues ?? []).filter((i) => i.code === "missing_tax_config").map((i) => i.year),
    ),
  ),
]);

// PAY-17: filters live in the route query (?year=&form=&status=) so list state
// is bookmarkable and survives detail → back navigation.
const statusFilter = useQueryEnum<TaxFilingStatus>("status", null, [
  "not_started",
  "ready",
  "filed",
]);
const statusSelect = useSelectAll(statusFilter);
const statusOptions = [
  { label: "All statuses", value: SELECT_ALL },
  { label: "Not started", value: "not_started" },
  { label: "Ready", value: "ready" },
  { label: "Filed", value: "filed" },
];

const formFilter = useQueryEnum<TaxFormType>("form", null, ["941", "940", "w2_w3"]);
const formSelect = useSelectAll(formFilter);
const formOptions = [
  { label: "All forms", value: SELECT_ALL },
  { label: "Form 941", value: "941" },
  { label: "Form 940", value: "940" },
  { label: "W-2/W-3", value: "w2_w3" },
];

const yearFilter = useQueryNumber("year", new Date().getFullYear());
/** Year options derived from the DATA (never hardcoded), plus the current year. */
const yearOptions = ref<{ label: string; value: number | null }[]>([
  { label: "All years", value: null },
]);

async function load() {
  loading.value = true;
  try {
    const filter: { status?: TaxFilingStatus; formType?: TaxFormType; year?: number } = {};
    if (statusFilter.value) filter.status = statusFilter.value;
    if (formFilter.value) filter.formType = formFilter.value;
    if (yearFilter.value) filter.year = yearFilter.value;
    const { filings } = await adminFilingsApi.list(filter);
    rows.value = filings;
  } catch (err) {
    notify.error(err, "Could not load tax filings");
  } finally {
    loading.value = false;
  }
}

function open(event: { data: TaxFilingRow }) {
  // Carry the filter query onto the detail URL so its back button can restore it.
  void router.push({ name: "admin-filing", params: { id: event.data.id }, query: route.query });
}

watch([statusFilter, formFilter, yearFilter], load);

// ---------------------------------------------------------- reminder schedule
const scheduleLoading = ref(true);
const scheduleBusy = ref(false);
const offsetsText = ref("");
const defaultOffsets = ref<number[]>([]);

async function loadSchedule() {
  scheduleLoading.value = true;
  try {
    const res = await adminFilingsApi.reminderSchedule();
    offsetsText.value = res.offsets.join(", ");
    defaultOffsets.value = res.defaultOffsets;
  } catch (err) {
    notify.error(err, "Could not load the reminder schedule");
  } finally {
    scheduleLoading.value = false;
  }
}

/** "14, 7, 0" → [14, 7, 0]; null when the input is not a valid offset list. */
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
    const res = await adminFilingsApi.putReminderSchedule(offsets);
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

onMounted(async () => {
  try {
    // Unfiltered list: the source of the dynamic year options.
    const { filings: all } = await adminFilingsApi.list();
    const years = [...new Set(all.map((f) => f.year))].sort((a, b) => b - a);
    const current = new Date().getFullYear();
    if (!years.includes(current)) years.unshift(current);
    // A year from the URL query may have no filings at all — keep it selectable.
    const fromQuery = yearFilter.value;
    if (fromQuery !== null && !years.includes(fromQuery)) {
      years.push(fromQuery);
      years.sort((a, b) => b - a);
    }
    yearOptions.value = [
      { label: "All years", value: null },
      ...years.map((y) => ({ label: String(y), value: y })),
    ];
  } catch (err) {
    notify.error(err, "Could not load tax filings");
  }
  await Promise.all([load(), loadSchedule()]);
});
</script>

<template>
  <div class="page stack">
    <PageHeader
      title="Tax filings"
      subtitle="Quarterly Form 941 plus the annual Form 940 and W-2/W-3 — worksheets compute themselves from issued payroll runs when the period ends. File by mail or e-file, then record the filing here."
    >
      <Select v-model="yearFilter" :options="yearOptions" option-label="label" option-value="value" size="small" />
      <Select v-model="formSelect" :options="formOptions" option-label="label" option-value="value" size="small" />
      <Select v-model="statusSelect" :options="statusOptions" option-label="label" option-value="value" size="small" />
    </PageHeader>

    <MissingTaxConfigBanner v-for="year in missingConfigYears" :key="year" :year="year" />

    <section class="card table-scroll">
      <Skeleton v-if="loading" height="10rem" />
      <DataTable
        v-else
        :value="rows"
        data-key="id"
        striped-rows
        row-hover
        style="cursor: pointer"
        @row-click="open"
      >
        <template #empty>
          <EmptyState
            icon="pi pi-file"
            title="No filings yet"
            body="Filing rows appear when a quarter with issued payroll runs ends — the daily scheduler computes the worksheet."
          />
        </template>
        <Column header="Period" style="width: 8rem">
          <template #body="{ data }">{{ periodLabel(data) }}</template>
        </Column>
        <Column header="Form" style="width: 8rem">
          <template #body="{ data }">{{ formLabel(data.formType) }}</template>
        </Column>
        <Column header="Due date" style="width: 9rem">
          <template #body="{ data }">{{ date(data.dueDate) }}</template>
        </Column>
        <Column header="Status" style="width: 8rem">
          <template #body="{ data }">
            <StatusChip :status="data.status" />
            <!-- PAY-162: missing_tax_config or w2_blocked (codes only). -->
            <Tag
              v-if="data.issues?.length"
              value="On hold – open for details"
              icon="pi pi-lock"
              severity="danger"
              style="margin-left: 0.25rem"
            />
          </template>
        </Column>
        <Column header="Filed">
          <template #body="{ data }">
            <template v-if="data.status === 'filed'">
              {{ date(data.filedOn) }}<template v-if="data.filingReference"> · {{ data.filingReference }}</template>
            </template>
            <span v-else class="muted">—</span>
          </template>
        </Column>
      </DataTable>
    </section>

    <section class="card stack">
      <h3>Reminder schedule</h3>
      <Skeleton v-if="scheduleLoading" height="4rem" />
      <template v-else>
        <p class="muted small">
          Days before a filing due date when admins get an email reminder — comma-separated, each
          between 0 and 30. Default: {{ defaultOffsets.join(", ") }}.
        </p>
        <form class="row" @submit.prevent="saveSchedule">
          <InputText
            v-model="offsetsText"
            aria-label="Reminder offsets in days"
            placeholder="e.g. 14, 7, 0"
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
  </div>
</template>

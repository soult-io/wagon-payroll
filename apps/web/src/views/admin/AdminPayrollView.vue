<script setup lang="ts">
/**
 * Admin payroll runs (frontend spec): runs DataTable (all statuses,
 * filterable) with row-expansion entries breakdown; row → review page.
 */
import { onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Select from "primevue/select";
import PageHeader from "../../components/PageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import StatusChip from "../../components/StatusChip.vue";
import MissingTaxTablesBanner from "../../components/MissingTaxTablesBanner.vue";
import {
  adminEmployeesApi,
  adminPayrollApi,
  type PayrollRunRow,
  type RunStatus,
} from "../../lib/api";
import { useMoney } from "../../composables/useMoney";
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
const { money } = useMoney();
const { date } = useDates();
const notify = useNotify();

const loading = ref(true);
const runs = ref<PayrollRunRow[]>([]);
const expandedRows = ref<Record<string, boolean>>({});
const employeeNames = ref<Map<number, string>>(new Map());

// PAY-17: filters live in the route query (?year=&status=) so list state is
// bookmarkable and survives detail → back navigation.
const statusFilter = useQueryEnum<RunStatus>("status", null, [
  "draft",
  "awaiting_approval",
  "approved",
  "issued",
  "void",
]);
const statusSelect = useSelectAll(statusFilter);
const statusOptions = [
  { label: "All statuses", value: SELECT_ALL },
  { label: "Draft", value: "draft" },
  { label: "Awaiting approval", value: "awaiting_approval" },
  { label: "Approved", value: "approved" },
  { label: "Issued", value: "issued" },
  { label: "Void", value: "void" },
];

const yearFilter = useQueryNumber("year", new Date().getFullYear());
/**
 * Year options derived from the DATA (never hardcoded — the original
 * [2026, 2025, 2024] list would silently rot every January), plus the
 * current year even when it has no runs yet, so drafts can be reviewed.
 */
const yearOptions = ref<{ label: string; value: number | null }[]>([
  { label: "All years", value: null },
]);

const ENTRY_LABELS: [string, string][] = [
  ["grossPay", "Gross pay"],
  ["federalWithholding", "Federal withholding"],
  ["socialSecurity", "Social Security (EE)"],
  ["medicare", "Medicare (EE)"],
  ["stateWithholding", "State withholding"],
  ["netPay", "Net pay"],
  ["employerSocialSecurity", "Social Security (ER)"],
  ["employerMedicare", "Medicare (ER)"],
  ["employerFUTA", "FUTA"],
];

function name(id: number): string {
  return employeeNames.value.get(id) ?? `#${id}`;
}

async function load() {
  loading.value = true;
  try {
    const filter: { status?: RunStatus; year?: number } = {};
    if (statusFilter.value) filter.status = statusFilter.value;
    if (yearFilter.value) filter.year = yearFilter.value;
    const { runs: rows } = await adminPayrollApi.runs(filter);
    runs.value = rows;
  } catch (err) {
    notify.error(err, "Could not load runs");
  } finally {
    loading.value = false;
  }
}

function open(event: { data: PayrollRunRow }) {
  // Carry the filter query onto the detail URL so its back button can restore it.
  void router.push({
    name: "admin-payroll-run",
    params: { publicId: event.data.publicId },
    query: route.query,
  });
}

watch([statusFilter, yearFilter], load);

onMounted(async () => {
  try {
    const [{ employees }, { runs: allRuns }] = await Promise.all([
      adminEmployeesApi.list(),
      adminPayrollApi.runs(), // unfiltered: the source of the dynamic year options
    ]);
    employeeNames.value = new Map(employees.map((e) => [e.id, e.legalName]));
    const years = [...new Set(allRuns.map((r) => Number(r.periodStart.slice(0, 4))))].sort(
      (a, b) => b - a,
    );
    const current = new Date().getFullYear();
    if (!years.includes(current)) years.unshift(current);
    // A year from the URL query may have no runs at all — keep it selectable.
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
    notify.error(err, "Could not load employees");
  }
  await load();
});
</script>

<template>
  <div class="page stack">
    <PageHeader title="Payroll runs" subtitle="Expand a row for the entries breakdown; click it for the full review.">
      <Select v-model="yearFilter" :options="yearOptions" option-label="label" option-value="value" size="small" />
      <Select v-model="statusSelect" :options="statusOptions" option-label="label" option-value="value" size="small" />
    </PageHeader>

    <MissingTaxTablesBanner />

    <div class="card table-scroll">
      <DataTable
        v-model:expanded-rows="expandedRows"
        :value="runs"
        :loading="loading"
        data-key="publicId"
        striped-rows
        row-hover
        @row-click="open"
      >
        <template #empty>
          <EmptyState
            icon="pi pi-calculator"
            title="No runs"
            body="Generate drafts from Config → Pay schedule, or wait for the monthly scheduler."
          />
        </template>
        <Column expander style="width: 3rem" />
        <Column header="Employee">
          <template #body="{ data }">{{ name(data.employeeId) }}</template>
        </Column>
        <Column header="Period">
          <template #body="{ data }">{{ date(data.periodStart) }} – {{ date(data.periodEnd) }}</template>
        </Column>
        <Column header="Pay date">
          <template #body="{ data }">{{ date(data.payDate) }}</template>
        </Column>
        <Column header="Status">
          <template #body="{ data }"><StatusChip :status="data.status" /></template>
        </Column>
        <template #expansion="{ data }">
          <div v-if="data.runSnapshot" class="entries">
            <div v-for="[key, label] in ENTRY_LABELS" :key="key" class="entry">
              <span class="muted small">{{ label }}</span>
              <span>{{ money(data.runSnapshot.result[key] ?? 0) }}</span>
            </div>
          </div>
          <p v-else class="muted small">Entries available on the review page.</p>
        </template>
      </DataTable>
    </div>
  </div>
</template>

<style scoped>
.entries {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 0.5rem 1.5rem;
  padding: 0.5rem 0.75rem;
}
.entry {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
}
</style>

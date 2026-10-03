<script setup lang="ts">
/**
 * Admin dashboard (frontend spec): pending approvals inbox (payroll drafts +
 * change requests) + outbox health card.
 */
import { computed, onMounted, ref } from "vue";
import Button from "primevue/button";
import Skeleton from "primevue/skeleton";
import Message from "primevue/message";
import PageHeader from "../../components/PageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import StatusChip from "../../components/StatusChip.vue";
import {
  adminEmployeesApi,
  adminPayrollApi,
  adminNotificationsApi,
  changeRequestsApi,
  type PayrollRunRow,
  type ChangeRequest,
  type LocalTaxCheck,
  type OutboxHealth,
} from "../../lib/api";
import { localityName, stateName } from "@payroll/shared";
import { requestTypeLabel } from "../../composables/useRequestTypes";
import { useDates } from "../../composables/useDates";
import { useNotify } from "../../composables/useNotify";
import { useYearEndWarning } from "../../composables/useYearEndWarning";

const { date, dateTime } = useDates();
const notify = useNotify();

const loading = ref(true);
const draftRuns = ref<PayrollRunRow[]>([]);
const pendingRequests = ref<ChangeRequest[]>([]);
const outbox = ref<OutboxHealth | null>(null);
const employeeNames = ref<Map<number, string>>(new Map());
// PAY-163 (Spec 25 (PAY-120), step G1): who still needs "where they live /
// work" filled in, and who the coming check would hold for a place the app
// cannot handle yet.
type CheckEntry = LocalTaxCheck["employees"][number];
const localTax = ref<LocalTaxCheck | null>(null);
const TODO_LIMIT = 5;

/** Fixable by filling in data: no residence, unanswered work locality, or no work state for a NY/MD resident. */
function needsData(e: CheckEntry): boolean {
  return (
    e.reasons.includes("residence_missing") ||
    e.reasons.includes("work_locality_unconfirmed") ||
    (e.reasons.includes("local_outside_work_state") && e.workState === null)
  );
}

/** Held for a place: unsupported, no tax tables yet, or living and working in different states. */
function heldForPlace(e: CheckEntry): boolean {
  return (
    e.reasons.includes("local_unsupported_state") ||
    e.reasons.includes("local_not_yet_supported") ||
    (e.reasons.includes("local_outside_work_state") && e.workState !== null)
  );
}

const localTaxTodo = computed(() => localTax.value?.employees.filter(needsData) ?? []);
const localTaxTodoShown = computed(() => localTaxTodo.value.slice(0, TODO_LIMIT));
const localTaxHeld = computed(() => localTax.value?.employees.filter(heldForPlace) ?? []);
const localTaxHeldShown = computed(() => localTaxHeld.value.slice(0, TODO_LIMIT));

/** "PA" → "Pennsylvania"; "NY-NYC" → "New York City"; "MD-510" → "Baltimore City". */
function placeName(code: string | null): string {
  if (!code) return "a state";
  return code.includes("-") ? localityName(code) : stateName(code);
}

const { yearEnd, load: loadYearEnd, dashboardText: yearEndText } = useYearEndWarning();

async function loadLocalTax() {
  try {
    localTax.value = await adminPayrollApi.localTaxCheck();
  } catch {
    localTax.value = null; // the banner is a nudge; the dashboard works without it
  }
}

onMounted(async () => {
  void loadLocalTax();
  void loadYearEnd();
  try {
    const [runs, requests, health, employees] = await Promise.all([
      adminPayrollApi.runs({ status: "awaiting_approval" }),
      changeRequestsApi.list({ status: "pending" }),
      adminNotificationsApi.outbox(),
      adminEmployeesApi.list(),
    ]);
    draftRuns.value = runs.runs;
    pendingRequests.value = requests.requests;
    outbox.value = health;
    employeeNames.value = new Map(employees.employees.map((e) => [e.id, e.legalName]));
  } catch (err) {
    notify.error(err, "Could not load dashboard");
  } finally {
    loading.value = false;
  }
});

function employeeName(id: number): string {
  return employeeNames.value.get(id) ?? `Employee #${id}`;
}
</script>

<template>
  <div class="page stack">
    <PageHeader title="Admin dashboard" subtitle="Everything waiting on your decision." />

    <Message
      v-if="yearEnd && yearEndText"
      :severity="yearEnd.openRuns.length > 0 ? 'warn' : 'info'"
      :closable="false"
    >
      {{ yearEndText }}
      <RouterLink :to="{ name: 'admin-payroll', query: { year: yearEnd.year } }">See {{ yearEnd.year }} payrolls</RouterLink>
    </Message>

    <Message v-if="localTax && localTaxTodo.length > 0" severity="info" :closable="false">
      <strong>New: tell us where each employee lives and works.</strong>
      Some cities and counties charge their own income tax, and this is how we check for it.
      <template v-if="!localTax.enforced">
        Soon we'll hold a pay run until this is filled in, so nobody is paid without the right
        local tax.
      </template>
      Still to do:
      <template v-for="(e, i) in localTaxTodoShown" :key="e.employeeId">
        <RouterLink
          :to="{ name: 'admin-employee-detail', params: { employeeId: e.employeeId }, query: { tab: 'state' } }"
        >{{ e.name }}</RouterLink><template v-if="i < localTaxTodoShown.length - 1">, </template>
      </template>
      <template v-if="localTaxTodo.length > TODO_LIMIT">
        and
        <RouterLink :to="{ name: 'admin-employees' }">{{ localTaxTodo.length - TODO_LIMIT }} more</RouterLink>
      </template>
      ({{ localTaxTodo.length }} {{ localTaxTodo.length === 1 ? "employee" : "employees" }})
    </Message>

    <Message v-if="localTax && localTaxHeld.length > 0" severity="warn" :closable="false">
      Some employees live or work where cities or counties charge their own income tax. Wagon
      Payroll can't work that out yet, so once the new check starts we'll hold their pay runs.
      You'll need to run payroll for them another way for now:
      <ul class="held-list">
        <li v-for="e in localTaxHeldShown" :key="e.employeeId">
          <RouterLink
            :to="{ name: 'admin-employee-detail', params: { employeeId: e.employeeId }, query: { tab: 'state' } }"
          >{{ e.name }}</RouterLink>
          — {{ placeName(e.place) }}
        </li>
        <li v-if="localTaxHeld.length > TODO_LIMIT">
          and
          <RouterLink :to="{ name: 'admin-employees' }">{{ localTaxHeld.length - TODO_LIMIT }} more</RouterLink>
        </li>
      </ul>
    </Message>

    <div v-if="loading" class="grid-2">
      <Skeleton height="12rem" />
      <Skeleton height="12rem" />
    </div>

    <div v-else class="grid-2">
      <section class="card">
        <h3>Payroll drafts awaiting approval</h3>
        <ul v-if="draftRuns.length > 0" class="inbox-list">
          <li v-for="run in draftRuns" :key="run.publicId">
            <div>
              <RouterLink :to="{ name: 'admin-payroll-run', params: { publicId: run.publicId } }">
                {{ employeeName(run.employeeId) }}
              </RouterLink>
              <p class="muted small">{{ date(run.periodStart) }} – {{ date(run.periodEnd) }} · pay {{ date(run.payDate) }}</p>
            </div>
            <StatusChip :status="run.status" />
          </li>
        </ul>
        <EmptyState v-else icon="pi pi-check-circle" title="No drafts waiting" body="Generated drafts will queue here for approval." />
      </section>

      <section class="card">
        <h3>Pending change requests</h3>
        <ul v-if="pendingRequests.length > 0" class="inbox-list">
          <li v-for="r in pendingRequests" :key="r.publicId">
            <div>
              <RouterLink :to="{ name: 'admin-request-detail', params: { publicId: r.publicId } }">
                {{ r.employeeName ?? `Employee #${r.employeeId}` }} — {{ requestTypeLabel(r.requestType) }}
              </RouterLink>
              <p class="muted small">submitted {{ dateTime(r.submittedAt) }} · effective {{ date(r.effectiveFrom) }}</p>
            </div>
            <StatusChip :status="r.status" />
          </li>
        </ul>
        <EmptyState v-else icon="pi pi-check-circle" title="Inbox zero" body="Employee change requests will queue here." />
      </section>
    </div>

    <section v-if="outbox" class="card">
      <div class="row" style="justify-content: space-between">
        <h3 style="margin: 0">Email outbox</h3>
        <RouterLink :to="{ name: 'admin-settings' }">
          <Button label="Open settings" size="small" text icon="pi pi-arrow-right" icon-pos="right" />
        </RouterLink>
      </div>
      <div class="row" style="margin-top: 0.75rem">
        <span class="stat"><strong>{{ outbox.counts["pending"] ?? 0 }}</strong> pending</span>
        <span class="stat"><strong>{{ outbox.counts["sent"] ?? 0 }}</strong> sent</span>
        <span class="stat" :class="{ 'stat-bad': (outbox.counts['failed'] ?? 0) > 0 }">
          <strong>{{ outbox.counts["failed"] ?? 0 }}</strong> failed
        </span>
        <span class="stat"><strong>{{ outbox.counts["suppressed"] ?? 0 }}</strong> suppressed</span>
      </div>
      <p v-if="!outbox.smtp.configured" class="muted small" style="margin-top: 0.5rem">
        SMTP is not configured — emails are {{ outbox.emailMode === "log" ? "logged to the server console" : "queued" }}.
      </p>
      <ul v-if="outbox.recentFailures.length > 0" class="failure-list">
        <li v-for="f in outbox.recentFailures.slice(0, 3)" :key="f.id" class="small">
          <span class="mono">{{ f.eventType }}</span> — {{ f.lastError }}
          <span class="muted">({{ dateTime(f.lastAttemptAt) }})</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.held-list {
  margin: 0.5rem 0 0;
  padding-left: 1.25rem;
}
.inbox-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.inbox-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}
.inbox-list p {
  margin: 0.15rem 0 0;
}
.stat {
  padding: 0.5rem 1rem;
  border: 1px solid var(--p-surface-border, #e4e4e7);
  border-radius: 8px;
}
.stat-bad {
  border-color: var(--p-red-300, #ef9a9a);
  color: var(--p-red-600, #c62828);
}
.failure-list {
  margin: 0.75rem 0 0;
  padding-left: 1.25rem;
  color: var(--p-red-600, #c62828);
}
</style>

<script setup lang="ts">
/**
 * Employee dashboard (frontend spec): latest payslip summary card, pending
 * request statuses, quick links.
 */
import { onMounted, ref } from "vue";
import Button from "primevue/button";
import Skeleton from "primevue/skeleton";
import PageHeader from "../../components/PageHeader.vue";
import PasskeyPromptCard from "../../components/PasskeyPromptCard.vue";
import EmptyState from "../../components/EmptyState.vue";
import StatusChip from "../../components/StatusChip.vue";
import {
  payslipsApi,
  changeRequestsApi,
  type PayslipSummary,
  type ChangeRequest,
} from "../../lib/api";
import { requestTypeLabel } from "../../composables/useRequestTypes";
import { useMoney } from "../../composables/useMoney";
import { useDates } from "../../composables/useDates";
import { useNotify } from "../../composables/useNotify";

const { money } = useMoney();
const { date } = useDates();
const notify = useNotify();

const loading = ref(true);
const latest = ref<PayslipSummary | null>(null);
const pendingRequests = ref<ChangeRequest[]>([]);

onMounted(async () => {
  try {
    const [payslips, requests] = await Promise.all([
      payslipsApi.list(),
      changeRequestsApi.list({ status: "pending" }),
    ]);
    latest.value = payslips.payslips[0] ?? null;
    pendingRequests.value = requests.requests;
  } catch (err) {
    notify.error(err, "Could not load your dashboard");
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="page stack">
    <PageHeader title="Dashboard" />

    <PasskeyPromptCard />

    <div v-if="loading" class="grid-2">
      <Skeleton height="10rem" />
      <Skeleton height="10rem" />
    </div>

    <div v-else class="grid-2">
      <section class="card">
        <h3>Latest payslip</h3>
        <template v-if="latest">
          <dl class="kv">
            <dt>Period</dt>
            <dd>{{ date(latest.periodStart) }} – {{ date(latest.periodEnd) }}</dd>
            <dt>Pay date</dt>
            <dd>{{ date(latest.payDate) }}</dd>
            <dt>Gross</dt>
            <dd>{{ money(latest.grossPay) }}</dd>
            <dt>Net pay</dt>
            <dd><strong>{{ money(latest.netPay) }}</strong></dd>
          </dl>
          <div class="row" style="margin-top: 0.75rem">
            <RouterLink :to="{ name: 'my-payslip-detail', params: { publicId: latest.publicId } }">
              <Button label="View details" size="small" />
            </RouterLink>
            <a :href="payslipsApi.pdfUrl(latest.publicId)" target="_blank" rel="noopener">
              <Button label="Download PDF" size="small" severity="secondary" icon="pi pi-download" />
            </a>
          </div>
        </template>
        <EmptyState
          v-else
          icon="pi pi-file"
          title="No payslips yet"
          body="Once payroll issues your first payslip it will show up here."
        />
      </section>

      <section class="card">
        <h3>Pending change requests</h3>
        <template v-if="pendingRequests.length > 0">
          <ul class="pending-list">
            <li v-for="r in pendingRequests" :key="r.publicId">
              <RouterLink :to="{ name: 'my-request-detail', params: { publicId: r.publicId } }">
                {{ requestTypeLabel(r.requestType) }}
              </RouterLink>
              <span class="muted small">effective {{ date(r.effectiveFrom) }}</span>
              <StatusChip :status="r.status" />
            </li>
          </ul>
        </template>
        <EmptyState
          v-else
          icon="pi pi-check-circle"
          title="Nothing pending"
          body="Need to change your address, W-4, bank details, or legal name?"
        >
          <RouterLink :to="{ name: 'my-request-new' }">
            <Button label="Request a change" size="small" />
          </RouterLink>
        </EmptyState>
      </section>
    </div>

    <section class="card">
      <h3>Quick links</h3>
      <div class="row">
        <RouterLink :to="{ name: 'my-payslips' }"><Button label="All payslips" text /></RouterLink>
        <RouterLink :to="{ name: 'my-profile' }"><Button label="My profile" text /></RouterLink>
        <RouterLink :to="{ name: 'my-request-new' }"><Button label="Request a change" text /></RouterLink>
        <RouterLink :to="{ name: 'my-settings' }"><Button label="Notification settings" text /></RouterLink>
      </div>
    </section>
  </div>
</template>

<style scoped>
.pending-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.pending-list li {
  display: flex;
  gap: 0.6rem;
  align-items: center;
}
</style>

<script setup lang="ts">
/**
 * Run review (frontend spec): computed figures from the frozen snapshot,
 * inputs used, approve / issue / void with ConfirmDialog + audit note;
 * issue and void are irreversible → type-to-confirm second step.
 */
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import Button from "primevue/button";
import Skeleton from "primevue/skeleton";
import Dialog from "primevue/dialog";
import Textarea from "primevue/textarea";
import InputText from "primevue/inputtext";
import Message from "primevue/message";
import { useConfirm } from "primevue/useconfirm";
import PageHeader from "../../components/PageHeader.vue";
import BackButton from "../../components/BackButton.vue";
import EmptyState from "../../components/EmptyState.vue";
import StatusChip from "../../components/StatusChip.vue";
import { adminEmployeesApi, adminPayrollApi, isOpenRun, type PayrollRunRow } from "../../lib/api";
import { useMoney } from "../../composables/useMoney";
import { useDates } from "../../composables/useDates";
import { useNotify } from "../../composables/useNotify";
import { useYearEndWarning } from "../../composables/useYearEndWarning";

const route = useRoute();
const confirm = useConfirm();
const { money, percent } = useMoney();
const { date, dateTime } = useDates();
const notify = useNotify();

const publicId = route.params.publicId as string;
const loading = ref(true);
const notFound = ref(false);
const busy = ref(false);
const run = ref<PayrollRunRow | null>(null);
const employeeName = ref("");

const voidDialog = ref(false);
const voidReason = ref("");
const issueDialog = ref(false);
const issueConfirmText = ref("");

const snapshot = computed(() => run.value?.runSnapshot ?? null);
const canApprove = computed(
  () => run.value && ["draft", "awaiting_approval"].includes(run.value.status),
);
const canIssue = computed(() => run.value?.status === "approved");
const canVoid = computed(() => run.value && isOpenRun(run.value.status));

// PAY-193 (D9.8): year-end notice for a run still to issue with a pay date in
// the warning's year.
const { load: loadYearEnd, runNotice } = useYearEndWarning();
const yearEndNotice = computed(() => runNotice(run.value));

async function load() {
  try {
    const [{ run: r }, { employees }] = await Promise.all([
      adminPayrollApi.run(publicId),
      adminEmployeesApi.list(),
    ]);
    run.value = r;
    employeeName.value =
      employees.find((e) => e.id === r.employeeId)?.legalName ??
      r.runSnapshot?.inputs.employee.legalName ??
      `#${r.employeeId}`;
  } catch (err) {
    notFound.value = true;
    notify.error(err, "Could not load run");
  } finally {
    loading.value = false;
  }
}

async function act(action: "approve" | "issue" | "void", reason?: string) {
  busy.value = true;
  try {
    const { run: updated } = await adminPayrollApi.act(publicId, action, reason);
    run.value = updated;
    notify.success(
      action === "approve" ? "Run approved" : action === "issue" ? "Payslip issued" : "Run voided",
      action === "issue" ? "The employee was notified by email." : undefined,
    );
  } catch (err) {
    notify.error(err, `Could not ${action} run`);
  } finally {
    busy.value = false;
  }
}

function approve() {
  confirm.require({
    message: `Approve this run for ${employeeName.value}? It can then be issued.`,
    header: "Approve run",
    icon: "pi pi-check",
    rejectProps: { label: "Cancel", severity: "secondary", text: true },
    acceptProps: { label: "Approve" },
    accept: () => act("approve"),
  });
}

function issuePayslip() {
  issueConfirmText.value = "";
  issueDialog.value = true;
}

async function confirmIssue() {
  if (issueConfirmText.value.trim().toUpperCase() !== "ISSUE") return;
  issueDialog.value = false;
  await act("issue");
}

function voidRun() {
  voidReason.value = "";
  voidDialog.value = true;
}

async function confirmVoid() {
  if (!voidReason.value.trim()) return;
  voidDialog.value = false;
  await act("void", voidReason.value.trim());
}

onMounted(() => {
  void loadYearEnd();
  void load();
});
</script>

<template>
  <div class="page stack">
    <PageHeader title="Run review" :subtitle="run ? `${employeeName} · ${date(run.periodStart)} – ${date(run.periodEnd)}` : undefined">
      <BackButton to="admin-payroll" label="Back to runs" />
      <template v-if="run">
        <Button v-if="canApprove" label="Approve" icon="pi pi-check" :loading="busy" @click="approve" />
        <Button v-if="canIssue" label="Issue payslip" icon="pi pi-send" severity="success" :loading="busy" @click="issuePayslip" />
        <Button v-if="canVoid" label="Void" icon="pi pi-ban" severity="danger" outlined :loading="busy" @click="voidRun" />
      </template>
    </PageHeader>

    <Message v-if="yearEndNotice" severity="warn" :closable="false">{{ yearEndNotice }}</Message>

    <Skeleton v-if="loading" height="20rem" />

    <EmptyState v-else-if="notFound || !run" icon="pi pi-exclamation-circle" title="Run not found" />

    <template v-else>
      <section class="card">
        <div class="row" style="justify-content: space-between">
          <h3 style="margin: 0">Status</h3>
          <StatusChip :status="run.status" />
        </div>
        <dl class="kv" style="margin-top: 0.75rem">
          <dt>Pay date</dt>
          <dd>{{ date(run.payDate) }}</dd>
          <dt>Created by</dt>
          <dd class="mono">{{ run.createdBy }}</dd>
          <dt v-if="run.approvedAt">Approved</dt>
          <dd v-if="run.approvedAt">{{ dateTime(run.approvedAt) }}</dd>
          <dt v-if="run.issuedAt">Issued</dt>
          <dd v-if="run.issuedAt">{{ dateTime(run.issuedAt) }}</dd>
          <dt v-if="run.voidedAt">Voided</dt>
          <dd v-if="run.voidedAt">{{ dateTime(run.voidedAt) }} — {{ run.voidReason }}</dd>
          <dt>Snapshot hash</dt>
          <dd class="mono">{{ run.snapshotHash }}</dd>
        </dl>
      </section>

      <div v-if="snapshot" class="grid-2">
        <section class="card">
          <h3>Computed figures (frozen)</h3>
          <dl class="kv">
            <dt>Gross pay</dt>
            <dd>{{ money(snapshot.result.grossPay) }}</dd>
            <dt>Federal withholding</dt>
            <dd>{{ money(snapshot.result.federalWithholding) }}</dd>
            <dt>Social Security (EE)</dt>
            <dd>{{ money(snapshot.result.socialSecurity) }}</dd>
            <dt>Medicare (EE)</dt>
            <dd>{{ money(snapshot.result.medicare) }}</dd>
            <dt>State withholding</dt>
            <dd>{{ money(snapshot.result.stateWithholding) }}</dd>
            <dt><strong>Net pay</strong></dt>
            <dd><strong>{{ money(snapshot.result.netPay) }}</strong></dd>
            <dt>Social Security (ER)</dt>
            <dd>{{ money(snapshot.result.employerSocialSecurity) }}</dd>
            <dt>Medicare (ER)</dt>
            <dd>{{ money(snapshot.result.employerMedicare) }}</dd>
            <dt>FUTA</dt>
            <dd>{{ money(snapshot.result.employerFUTA) }}</dd>
          </dl>
        </section>

        <section class="card">
          <h3>Inputs used (as of period)</h3>
          <dl class="kv">
            <dt>Period amount</dt>
            <dd>{{ money(snapshot.inputs.periodAmount) }} / {{ snapshot.inputs.frequency }}</dd>
            <dt>Periods per year</dt>
            <dd>{{ snapshot.inputs.periodsPerYear }}</dd>
            <dt>W-4 filing status</dt>
            <dd>{{ (snapshot.inputs.w4?.["filingStatus"] as string | undefined) ?? "single (default)" }}</dd>
            <dt>Federal exempt</dt>
            <dd>{{ snapshot.inputs.w4?.["federalExempt"] ? "Yes" : "No" }}</dd>
            <dt>Prior YTD gross</dt>
            <dd>{{ money(snapshot.inputs.priorYtdGross) }}</dd>
            <dt>Tax year</dt>
            <dd>{{ snapshot.inputs.taxConfig["taxYear"] }}</dd>
            <dt>Standard deduction</dt>
            <dd>{{ money(snapshot.inputs.taxConfig["standardDeduction"] as number) }}</dd>
            <dt>Social Security rate</dt>
            <dd>{{ percent(snapshot.inputs.taxConfig["socialSecurityRate"] as number) }}</dd>
            <dt>Medicare rate</dt>
            <dd>{{ percent(snapshot.inputs.taxConfig["medicareRate"] as number) }}</dd>
          </dl>
          <h3 style="margin-top: 1rem">Federal brackets</h3>
          <table class="brackets">
            <thead>
              <tr><th>#</th><th>From</th><th>To</th><th>Rate</th></tr>
            </thead>
            <tbody>
              <tr v-for="b in snapshot.inputs.brackets" :key="b.ordinal">
                <td>{{ b.ordinal }}</td>
                <td>{{ money(b.minAmount) }}</td>
                <td>{{ b.maxAmount === null ? "∞" : money(b.maxAmount) }}</td>
                <td>{{ percent(b.rate) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </template>

    <Dialog v-model:visible="issueDialog" modal header="Issue payslip" :style="{ width: '28rem' }">
      <p>
        Issuing is <strong>final</strong>: the payslip becomes visible to the employee and the run can no
        longer be voided. Type <code>ISSUE</code> to confirm.
      </p>
      <InputText v-model="issueConfirmText" placeholder="ISSUE" class="confirm-input" />
      <div class="row" style="justify-content: flex-end; margin-top: 1rem">
        <Button label="Cancel" text severity="secondary" @click="issueDialog = false" />
        <Button label="Issue payslip" severity="success" :disabled="issueConfirmText.trim().toUpperCase() !== 'ISSUE'" :loading="busy" @click="confirmIssue" />
      </div>
    </Dialog>

    <Dialog v-model:visible="voidDialog" modal header="Void run" :style="{ width: '28rem' }">
      <p>Voiding marks the run as dead. A reason is required and recorded in the audit log.</p>
      <Textarea v-model="voidReason" rows="3" placeholder="Reason for voiding…" class="confirm-input" />
      <div class="row" style="justify-content: flex-end; margin-top: 1rem">
        <Button label="Cancel" text severity="secondary" @click="voidDialog = false" />
        <Button label="Void run" severity="danger" :disabled="!voidReason.trim()" :loading="busy" @click="confirmVoid" />
      </div>
    </Dialog>
  </div>
</template>

<style scoped>
.brackets {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
.brackets th,
.brackets td {
  text-align: left;
  padding: 0.25rem 0.5rem;
  border-bottom: 1px solid var(--p-surface-border, #eee);
}
.confirm-input {
  width: 100%;
  margin-top: 0.5rem;
}
</style>

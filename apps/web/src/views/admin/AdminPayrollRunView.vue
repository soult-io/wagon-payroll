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
import LateIssueDialog from "../../components/LateIssueDialog.vue";
import { stateName } from "@payroll/shared";
import {
  adminEmployeesApi,
  adminPayrollApi,
  ApiError,
  isOpenRun,
  type IssueResponse,
  type LateAttestationBody,
  type LatePayment,
  type PayrollRunRow,
  type RunDetailResponse,
} from "../../lib/api";
import { useMoney } from "../../composables/useMoney";
import { useDates } from "../../composables/useDates";
import { useNotify } from "../../composables/useNotify";
import { useYearEndWarning } from "../../composables/useYearEndWarning";

const route = useRoute();
const confirm = useConfirm();
const { money, percent } = useMoney();
const { date, dateTime, longDate } = useDates();
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

// PAY-193 L4: late dialog, opened only by a 409 late_payment_confirmation_required.
const lateDialog = ref(false);
const lateAttestation = ref<LateAttestationBody | null>(null);
const lateStates = ref<string[]>([]);
const lateMessage = ref("");
const lateRefusal = ref<string | null>(null);
const lateNetPayHint = ref<number | null>(null);
const lateIssue = ref<RunDetailResponse["lateIssue"]>(null);

/** Refusals shown inside the open late dialog (copy 1.11). */
const IN_DIALOG_REFUSALS = new Set([
  "late_payment_incomplete",
  "state_return_filed",
  "late_payment_amount_mismatch",
]);
const CLOSE_DIALOG_REFUSALS = new Set(["stale_draft", "ytd_order_conflict", "pay_period_filed"]);

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
    const [{ run: r, lateIssue: li }, { employees }] = await Promise.all([
      adminPayrollApi.run(publicId),
      adminEmployeesApi.list(),
    ]);
    run.value = r;
    lateIssue.value = li ?? null;
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
    const { run: updated } = await adminPayrollApi.act(publicId, action, reason ? { reason } : {});
    run.value = updated;
    notify.success(
      action === "approve" ? "Run approved" : action === "issue" ? "Payslip issued" : "Run voided",
      action === "issue" ? "The employee was notified by email." : undefined,
    );
  } catch (err) {
    if (action === "issue" && openLateDialog(err)) return;
    notify.error(err, `Could not ${action} run`);
  } finally {
    busy.value = false;
  }
}

/** W-L1: a 409 late_payment_confirmation_required opens the late dialog (no toast). */
function openLateDialog(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.code !== "late_payment_confirmation_required") return false;
  const body = err.body ?? {};
  lateAttestation.value = (body["attestation"] as LateAttestationBody | undefined) ?? null;
  lateStates.value = Array.isArray(body["stateJurisdictions"])
    ? (body["stateJurisdictions"] as string[])
    : [];
  lateMessage.value = typeof body["message"] === "string" ? body["message"] : "";
  lateRefusal.value = null;
  lateNetPayHint.value = null;
  lateDialog.value = lateAttestation.value !== null;
  return true;
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

/** Copy 3.2: "federal" / state name, and the period from the code's periodStart. */
function depositWords(jurisdiction: string, periodStart: string): { who: string; period: string } {
  if (jurisdiction === "federal") {
    const month = MONTHS[Number(periodStart.slice(5, 7)) - 1] ?? periodStart;
    return { who: "federal", period: `${month} ${periodStart.slice(0, 4)}` };
  }
  return {
    who: stateName(jurisdiction),
    period: `the period that starts ${longDate(periodStart)}`,
  };
}

/** One sticky toast per known follow-up code (copy 3.2); unknown codes show nothing. */
function followUpToast(code: string, taxYear: number): { summary: string; detail: string } | null {
  const [kind, jurisdiction = "", periodStart = ""] = code.split(":");
  if (kind === "w2_changed_notice_sent") {
    return {
      summary: "W-2 updated",
      detail: `${employeeName.value}'s ${taxYear} W-2 changed. We emailed them that a corrected copy is ready.`,
    };
  }
  if (kind === "deposit_sync_deferred") {
    const who = jurisdiction === "federal" ? "federal" : stateName(jurisdiction);
    return {
      summary: "Deposit not updated yet",
      detail: `The payslip is issued, but we couldn't update your ${who} tax deposit for it. We'll try again tonight and email you if it still doesn't work.`,
    };
  }
  if (kind === "deposit_overdue") {
    const { who, period } = depositWords(jurisdiction, periodStart);
    return {
      summary: "Tax deposit past due",
      detail: `Your ${who} tax deposit for ${period} is past its due date. Make it as soon as you can; the longer it waits, the more penalties and interest can add up. See Tax deposits for the amount.`,
    };
  }
  if (kind === "deposit_shortfall") {
    const { who, period } = depositWords(jurisdiction, periodStart);
    return {
      summary: "Additional tax deposit",
      detail: `This payroll adds to your ${who} taxes for ${period}, so you owe an additional deposit. See Tax deposits for the amount and due date. If the due date has passed, make it as soon as you can.`,
    };
  }
  return null;
}

/** Display order (copy 3.2): most urgent first. */
const FOLLOW_UP_ORDER = [
  "deposit_overdue",
  "deposit_shortfall",
  "deposit_sync_deferred",
  "w2_changed_notice_sent",
];

function showFollowUps(followUps: string[], taxYear: number): void {
  const rank = (c: string) => {
    const i = FOLLOW_UP_ORDER.indexOf(c.split(":")[0] ?? "");
    return i === -1 ? FOLLOW_UP_ORDER.length : i;
  };
  for (const code of [...followUps].sort((a, b) => rank(a) - rank(b))) {
    const toast = followUpToast(code, taxYear);
    if (toast) notify.stickyInfo(toast.summary, toast.detail);
  }
}

/** Success of a late issue: toasts (copy 3.1, 3.2) and the run-detail confirmation line. */
async function onLateIssued(res: IssueResponse): Promise<void> {
  run.value = res.run;
  lateDialog.value = false;
  const taxYear = res.lateIssue?.taxYear ?? Number(res.run.payDate.slice(0, 4));
  notify.success(
    `Payslip issued for ${taxYear}`,
    `It's now in your ${taxYear} pay and tax totals.`,
  );
  if (res.lateIssue) showFollowUps(res.lateIssue.followUps, res.lateIssue.taxYear);
  try {
    lateIssue.value = (await adminPayrollApi.run(publicId)).lateIssue ?? null;
  } catch {
    // The run is issued; the confirmation line appears on the next load.
  }
}

/** Copy 1.11: refusals stay in the open dialog; stale/ordering/filed close it. */
function onLateRefused(err: unknown): void {
  if (err instanceof ApiError && IN_DIALOG_REFUSALS.has(err.code)) {
    // Dialog stays open with every value kept; no duplicate toast.
    lateRefusal.value = notify.errorMessage(err);
    if (err.code === "late_payment_amount_mismatch") {
      lateNetPayHint.value = snapshot.value?.result.netPay ?? null;
    }
    return;
  }
  if (err instanceof ApiError && CLOSE_DIALOG_REFUSALS.has(err.code)) lateDialog.value = false;
  notify.error(err, "Could not issue run");
}

async function issueLate(latePayment: LatePayment) {
  busy.value = true;
  lateRefusal.value = null;
  lateNetPayHint.value = null;
  try {
    await onLateIssued(await adminPayrollApi.act(publicId, "issue", { latePayment }));
  } catch (err) {
    onLateRefused(err);
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
          <dt v-if="lateIssue">Late issue</dt>
          <dd v-if="lateIssue">
            Issued after its tax period ended. Payment confirmed on {{ longDate(lateIssue.confirmedAt) }}.
          </dd>
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

    <LateIssueDialog
      v-if="run"
      v-model:visible="lateDialog"
      :attestation="lateAttestation"
      :state-jurisdictions="lateStates"
      :message="lateMessage"
      :pay-date="run.payDate"
      :employee-name="employeeName"
      :busy="busy"
      :refusal="lateRefusal"
      :net-pay-hint="lateNetPayHint"
      @submit="issueLate"
    />

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

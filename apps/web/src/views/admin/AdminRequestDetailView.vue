<script setup lang="ts">
/**
 * Admin request review (frontend spec): current-vs-proposed diff, decision
 * controls (effective-date override, note, approve / deny-with-reason) and
 * the shared thread.
 *
 * Employee detail strips taxId/bankDetails server-side, so the bank diff
 * shows "on file (masked)" vs the masked proposed payload — clear account
 * data never reaches the browser.
 */
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import Button from "primevue/button";
import Skeleton from "primevue/skeleton";
import DatePicker from "primevue/datepicker";
import Textarea from "primevue/textarea";
import Dialog from "primevue/dialog";
import PageHeader from "../../components/PageHeader.vue";
import BackButton from "../../components/BackButton.vue";
import EmptyState from "../../components/EmptyState.vue";
import StatusChip from "../../components/StatusChip.vue";
import RequestThread from "../../components/RequestThread.vue";
import RequestPayloadView from "../../components/RequestPayloadView.vue";
import {
  ApiError,
  adminEmployeesApi,
  adminPayrollApi,
  changeRequestsApi,
  type AdminEmployeeDetail,
  type ChangeRequest,
  type ChangeRequestComment,
  type StateElectionRow,
  type W4ElectionRow,
} from "../../lib/api";
import { requestTypeLabel, filingStatusLabel } from "../../composables/useRequestTypes";
import { useMoney } from "../../composables/useMoney";
import { useDates } from "../../composables/useDates";
import { useNotify } from "../../composables/useNotify";

const route = useRoute();
const { money } = useMoney();
const { date, dateTime, toIso, fromIso } = useDates();
const notify = useNotify();

const publicId = route.params.publicId as string;
const loading = ref(true);
const notFound = ref(false);
const busy = ref(false);
const request = ref<ChangeRequest | null>(null);
const comments = ref<ChangeRequestComment[]>([]);
const employee = ref<AdminEmployeeDetail | null>(null);
const currentW4 = ref<W4ElectionRow | null>(null);
const currentStateElection = ref<StateElectionRow | null>(null);

// Decision controls
const effectiveFrom = ref<Date | null>(null);
const note = ref("");
const denyVisible = ref(false);
const denyReason = ref("");
/**
 * Set after a 409 effective_date (payroll already ran for earlier periods, or
 * a W-4 date outside the IRS window): the picker now holds the proposed date,
 * and the next approve sends it as an explicit override even when it equals
 * the requested date.
 */
const effectiveDateConfirmed = ref(false);

// Spec 11 (D21): tax_id reveal-on-demand — deliberate, audit-logged server-side.
const revealedTaxId = ref<string | null>(null);
const revealBusy = ref(false);

const isPending = computed(() => request.value?.status === "pending");

async function revealTaxId() {
  revealBusy.value = true;
  try {
    const { taxId } = await changeRequestsApi.revealTaxId(publicId);
    revealedTaxId.value = taxId;
  } catch (err) {
    notify.error(err, "Could not reveal the tax ID");
  } finally {
    revealBusy.value = false;
  }
}

type Row = { label: string; value: string };

function w4CurrentRows(w: W4ElectionRow | null): Row[] {
  if (!w) return [{ label: "W-4 election", value: "None on file" }];
  return [
    { label: "Tax year", value: String(w.taxYear) },
    { label: "Filing status", value: filingStatusLabel(w.filingStatus) },
    { label: "Federal exempt", value: w.federalExempt ? "Yes" : "No" },
    { label: "Multiple jobs", value: w.multipleJobs ? "Yes" : "No" },
    { label: "Dependents amount", value: money(Number(w.dependentsAmount)) },
    { label: "Other income", value: money(Number(w.otherIncome)) },
    { label: "Deductions", value: money(Number(w.deductionsAmount)) },
    { label: "Extra withholding", value: money(Number(w.extraWithholding)) },
    { label: "Effective from", value: date(w.effectiveFrom) },
  ];
}

function stateElectionCurrentRows(s: StateElectionRow | null): Row[] {
  if (!s) return [{ label: "State election", value: "None on file for this state" }];
  return [
    { label: "State", value: s.stateCode },
    { label: "Filing status", value: filingStatusLabel(s.filingStatus) },
    { label: "Allowances", value: String(s.allowances) },
    { label: "Additional allowances", value: String(s.additionalAllowances) },
    { label: "Extra withholding", value: money(Number(s.extraWithholding)) },
    { label: "Exempt", value: s.exempt ? "Yes" : "No" },
    { label: "Effective from", value: date(s.effectiveFrom) },
  ];
}

const currentRows = computed<Row[]>(() => {
  const req = request.value;
  const emp = employee.value;
  if (!req) return [];
  switch (req.requestType) {
    case "address": {
      const a = emp?.address;
      if (!a) return [{ label: "Address", value: "Not on file" }];
      return [
        { label: "Street", value: [a.line1, a.line2].filter(Boolean).join(", ") },
        { label: "City", value: a.city },
        { label: "State/Province", value: a.state },
        { label: "ZIP/Postal code", value: a.zip },
        { label: "Country", value: a.country },
      ];
    }
    case "legal_name":
      return [{ label: "Legal name", value: emp?.legalName ?? "—" }];
    case "bank_details":
      return [{ label: "Bank details", value: "On file (masked — not shown)" }];
    case "tax_id":
      return [
        { label: "Tax ID", value: emp?.hasTaxId ? "On file (masked — not shown)" : "Not on file" },
      ];
    case "w4":
      return w4CurrentRows(currentW4.value);
    case "state_election":
      return stateElectionCurrentRows(currentStateElection.value);
    default:
      return [];
  }
});

async function load() {
  try {
    const detail = await changeRequestsApi.detail(publicId);
    request.value = detail.request;
    comments.value = detail.comments;
    if (!effectiveFrom.value) effectiveFrom.value = fromIso(detail.request.effectiveFrom);
    // Side-by-side "current" data — best effort; the diff degrades gracefully.
    try {
      const { employee: emp } = await adminEmployeesApi.detail(detail.request.employeeId);
      employee.value = emp;
    } catch {
      employee.value = null;
    }
    if (detail.request.requestType === "w4") {
      try {
        const { w4Elections } = await adminPayrollApi.w4(detail.request.employeeId);
        currentW4.value = w4Elections[0] ?? null;
      } catch {
        currentW4.value = null;
      }
    }
    if (detail.request.requestType === "state_election") {
      try {
        const stateCode = (detail.request.payload as { stateCode?: string }).stateCode;
        const { elections } = await adminPayrollApi.stateElections(
          detail.request.employeeId,
          stateCode,
        );
        currentStateElection.value = elections[0] ?? null;
      } catch {
        currentStateElection.value = null;
      }
    }
  } catch (err) {
    notFound.value = true;
    notify.error(err, "Could not load request");
  } finally {
    loading.value = false;
  }
}

async function sendComment(body: string) {
  busy.value = true;
  try {
    await changeRequestsApi.comment(publicId, body);
    await load();
    notify.success("Comment added");
  } catch (err) {
    notify.error(err, "Could not add comment");
  } finally {
    busy.value = false;
  }
}

async function approve() {
  busy.value = true;
  try {
    const input: { note?: string; effectiveFromOverride?: string } = {};
    const trimmed = note.value.trim();
    if (trimmed) input.note = trimmed;
    const iso = toIso(effectiveFrom.value);
    if (iso && (effectiveDateConfirmed.value || iso !== request.value?.effectiveFrom)) {
      input.effectiveFromOverride = iso;
    }
    const { request: updated } = await changeRequestsApi.approve(publicId, input);
    request.value = updated;
    notify.success(
      "Request approved",
      updated.effectiveFrom
        ? `The change has been applied, effective ${date(updated.effectiveFrom)}.`
        : "The change has been applied.",
    );
    await load();
  } catch (err) {
    if (err instanceof ApiError && err.code === "effective_date") {
      effectiveDateConfirmed.value = true;
      const proposed = err.body?.["proposedEffectiveFrom"];
      if (typeof proposed === "string") effectiveFrom.value = fromIso(proposed);
    }
    notify.error(err, "Could not approve");
  } finally {
    busy.value = false;
  }
}

async function deny() {
  const reason = denyReason.value.trim();
  if (!reason) {
    notify.info("Reason required", "Tell the employee why the request was denied.");
    return;
  }
  busy.value = true;
  try {
    const { request: updated } = await changeRequestsApi.deny(publicId, reason);
    request.value = updated;
    denyVisible.value = false;
    denyReason.value = "";
    notify.success("Request denied");
    await load();
  } catch (err) {
    notify.error(err, "Could not deny");
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page stack">
    <PageHeader :title="request ? `Review: ${requestTypeLabel(request.requestType)}` : 'Review request'">
      <BackButton to="admin-requests" label="Back to inbox" />
    </PageHeader>

    <Skeleton v-if="loading" height="22rem" />

    <EmptyState
      v-else-if="notFound || !request"
      icon="pi pi-exclamation-circle"
      title="Request not found"
      body="It may have been withdrawn, or the link is wrong."
    />

    <template v-else>
      <section class="card">
        <div class="head-row">
          <h3>{{ request.employeeName ?? `Employee #${request.employeeId}` }}</h3>
          <StatusChip :status="request.status" />
        </div>
        <dl class="kv">
          <dt>Submitted</dt>
          <dd>{{ dateTime(request.submittedAt) }}</dd>
          <dt v-if="request.decidedAt">Decided</dt>
          <dd v-if="request.decidedAt">{{ dateTime(request.decidedAt) }}</dd>
          <dt v-if="request.appliedAt">Applied</dt>
          <dd v-if="request.appliedAt">{{ dateTime(request.appliedAt) }}</dd>
        </dl>
      </section>

      <div class="grid-2">
        <section class="card">
          <h3>Current</h3>
          <dl class="kv">
            <template v-for="row in currentRows" :key="row.label">
              <dt>{{ row.label }}</dt>
              <dd>{{ row.value }}</dd>
            </template>
          </dl>
        </section>
        <section class="card">
          <h3>Proposed</h3>
          <RequestPayloadView :request-type="request.requestType" :payload="request.payload" />
          <template v-if="request.requestType === 'tax_id'">
            <div v-if="revealedTaxId" class="reveal-row">
              <code class="mono">{{ revealedTaxId }}</code>
              <Button label="Hide" text size="small" icon="pi pi-eye-slash" @click="revealedTaxId = null" />
            </div>
            <div v-else class="reveal-row">
              <Button
                label="Reveal full tax ID"
                text
                size="small"
                icon="pi pi-eye"
                :loading="revealBusy"
                @click="revealTaxId"
              />
              <small class="muted">Logged in the audit trail.</small>
            </div>
          </template>
        </section>
      </div>

      <section v-if="isPending" class="card stack">
        <h3>Decision</h3>
        <div class="form-grid">
          <div class="field">
            <label for="eff">Effective from</label>
            <DatePicker v-model="effectiveFrom" input-id="eff" date-format="yy-mm-dd" show-icon />
          </div>
          <div class="field">
            <label for="note">Note to employee (optional)</label>
            <Textarea id="note" v-model="note" rows="2" auto-resize />
          </div>
        </div>
        <div class="row">
          <Button
            label="Approve & apply"
            icon="pi pi-check"
            :loading="busy"
            :disabled="Boolean(request.effectiveFrom) && !effectiveFrom"
            @click="approve"
          />
          <Button label="Deny" severity="danger" outlined icon="pi pi-times" :disabled="busy" @click="denyVisible = true" />
        </div>
      </section>

      <section class="card">
        <h3>Thread</h3>
        <RequestThread :comments="comments" :can-comment="true" :busy="busy" @submit="sendComment" />
      </section>
    </template>

    <Dialog v-model:visible="denyVisible" modal header="Deny request" :style="{ width: '26rem' }">
      <div class="stack">
        <p class="muted small">The employee sees this reason. It is required.</p>
        <Textarea v-model="denyReason" rows="3" auto-resize placeholder="Why is this request denied?" />
        <div class="row">
          <Button label="Deny request" severity="danger" icon="pi pi-times" :loading="busy" @click="deny" />
          <Button label="Cancel" text :disabled="busy" @click="denyVisible = false" />
        </div>
      </div>
    </Dialog>
  </div>
</template>

<style scoped>
.head-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}
.head-row h3 {
  margin: 0;
}
.reveal-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.75rem;
}
</style>

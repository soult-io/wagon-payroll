<script setup lang="ts">
/**
 * Admin employee detail (frontend spec): profile, compensation history
 * editor (effective-dated), W-4 history + add, invite/resend, disable.
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import Button from "primevue/button";
import Skeleton from "primevue/skeleton";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import InputMask from "primevue/inputmask";
import InputNumber from "primevue/inputnumber";
import Select from "primevue/select";
import Checkbox from "primevue/checkbox";
import DatePicker from "primevue/datepicker";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Tabs from "primevue/tabs";
import TabList from "primevue/tablist";
import Tab from "primevue/tab";
import TabPanels from "primevue/tabpanels";
import TabPanel from "primevue/tabpanel";
import { useConfirm } from "primevue/useconfirm";
import PageHeader from "../../components/PageHeader.vue";
import BackButton from "../../components/BackButton.vue";
import EmptyState from "../../components/EmptyState.vue";
import StatusChip from "../../components/StatusChip.vue";
import EmployeeResidenceCard from "../../components/EmployeeResidenceCard.vue";
import Message from "primevue/message";
import { localityName, W2_CONSENT_GATE_FROM_TAX_YEAR, WORK_LOCALITY_STATES } from "@payroll/shared";
import WorkLocalityQuestion from "../../components/WorkLocalityQuestion.vue";
import { localityFromAnswer } from "../../composables/useWorkLocality";
import {
  adminEmployeesApi,
  adminPayrollApi,
  ApiError,
  type AdminEmployeeDetail,
  type CompensationRow,
  type StateElectionRow,
  type W4ElectionRow,
  type WorkStateRow,
} from "../../lib/api";
import { filingStatusLabel } from "../../composables/useRequestTypes";
import { useMoney } from "../../composables/useMoney";
import { useDates } from "../../composables/useDates";
import { useNotify } from "../../composables/useNotify";

const route = useRoute();
const confirm = useConfirm();
const { money } = useMoney();
const { date, longDate, toIso } = useDates();
const notify = useNotify();

const employeeId = Number(route.params.employeeId);
// Deep link: ?tab=state opens the State tax tab (dashboard "Still to do" links).
const TABS = ["profile", "compensation", "w4", "state"];
const activeTab = ref(
  typeof route.query.tab === "string" && TABS.includes(route.query.tab)
    ? route.query.tab
    : "profile",
);
const loading = ref(true);
const notFound = ref(false);
const employee = ref<AdminEmployeeDetail | null>(null);
const compensation = ref<CompensationRow[]>([]);
const w4History = ref<W4ElectionRow[]>([]);
// PAY-13: work-state history + state withholding elections (IL-W-4 / DE 4).
const workStates = ref<WorkStateRow[]>([]);
const stateElections = ref<StateElectionRow[]>([]);

const inviteDialog = ref(false);
const inviteEmail = ref("");
const inviteBusy = ref(false);
const setupLink = ref("");

// Spec 11 (D20a): admin direct-set of the employee TIN (backfill/corrections).
const tinDialog = ref(false);
const tinBusy = ref(false);
const tinValue = ref("");

// PAY-20: admin direct-set of the mailing address (effective-dated; recorded
// as an already-approved change request so W-2 as-of resolution stays correct).
const mailDialog = ref(false);
const mailBusy = ref(false);
const mailForm = ref({
  line1: "",
  line2: "",
  city: "",
  state: "",
  zip: "",
  country: "US",
  effectiveFrom: new Date(),
});

function openMailingDialog() {
  const current = employee.value?.mailingAddress;
  mailForm.value = {
    line1: current?.line1 ?? "",
    line2: current?.line2 ?? "",
    city: current?.city ?? "",
    state: current?.state ?? "",
    zip: current?.zip ?? "",
    country: current?.country ?? "US",
    effectiveFrom: new Date(),
  };
  mailDialog.value = true;
}

async function saveMailingAddress() {
  const effectiveFrom = toIso(mailForm.value.effectiveFrom);
  if (!effectiveFrom) return;
  mailBusy.value = true;
  try {
    await adminEmployeesApi.setMailingAddress(employeeId, {
      mailingAddress: {
        line1: mailForm.value.line1.trim(),
        ...(mailForm.value.line2.trim() ? { line2: mailForm.value.line2.trim() } : {}),
        city: mailForm.value.city.trim(),
        state: mailForm.value.state.trim(),
        zip: mailForm.value.zip.trim(),
        country: mailForm.value.country.trim(),
      },
      effectiveFrom,
    });
    notify.success(
      "Mailing address saved",
      "Recorded effective-dated; W-2s use it from that date.",
    );
    mailDialog.value = false;
    await load();
  } catch (err) {
    notify.error(err, "Could not save the mailing address");
  } finally {
    mailBusy.value = false;
  }
}

const compDialog = ref(false);
const compBusy = ref(false);
const compForm = ref({
  periodAmount: 0,
  frequency: "monthly",
  effectiveFrom: new Date(),
  effectiveTo: null as Date | null,
});

const w4Dialog = ref(false);
const w4Busy = ref(false);
const w4Form = ref({
  taxYear: new Date().getFullYear(),
  filingStatus: "single",
  federalExempt: false,
  multipleJobs: false,
  dependentsAmount: 0,
  otherIncome: 0,
  deductionsAmount: 0,
  extraWithholding: 0,
  effectiveFrom: new Date(),
  filedDate: new Date(),
  note: "",
});

// PAY-13 dialogs
const wsDialog = ref(false);
const wsBusy = ref(false);
const wsForm = ref({
  stateCode: "",
  effectiveFrom: new Date(),
  // PAY-163: New York → "yes"/"no" (work in Yonkers); Maryland → county code.
  locality: "",
});

// PAY-163: answer the work-locality question on a row made before it was asked
// (the row in force today, or a future row), targeted by its start date.
const wlDialog = ref(false);
const wlBusy = ref(false);
const wlError = ref("");
const wlForm = ref({ stateCode: "", locality: "", effectiveOn: "" });

const displayName = computed(
  () => employee.value?.preferredName ?? employee.value?.legalName ?? "this employee",
);
// A new state means a new question: drop the previous answer.
watch(
  () => wsForm.value.stateCode.trim().toUpperCase(),
  () => {
    wsForm.value.locality = "";
  },
);

function stateLabel(stateCode: string): string {
  return stateCode === "MD" ? "Maryland" : "New York";
}

/** The Assign dialog's NY / MD question is still unanswered. */
const wsNeedsAnswer = computed(() => {
  const stateCode = wsForm.value.stateCode.trim().toUpperCase();
  return localityFromAnswer(stateCode, wsForm.value.locality) === undefined;
});

function workLocalityLabel(row: WorkStateRow): string {
  if (row.localityCode) return localityName(row.localityCode);
  if (!WORK_LOCALITY_STATES.includes(row.stateCode)) return "—";
  return row.localityConfirmedAt ? "Not in Yonkers" : "Not answered yet";
}

/** NY/MD row in force today or starting later, never answered. */
function needsLocalityAnswer(row: WorkStateRow): boolean {
  const today = toIso(new Date()) ?? "";
  return (
    WORK_LOCALITY_STATES.includes(row.stateCode) &&
    (row.effectiveTo === null || row.effectiveTo > today) &&
    row.localityConfirmedAt === null
  );
}

function openLocalityDialog(row: WorkStateRow) {
  wlForm.value = { stateCode: row.stateCode, locality: "", effectiveOn: row.effectiveFrom };
  wlError.value = "";
  wlDialog.value = true;
}

function workLocalityError(err: unknown): string {
  const name = displayName.value;
  if (err instanceof ApiError) {
    if (err.status === 404) return "We couldn't find this employee. Refresh the page.";
    if (err.code === "work_state_ended") {
      return "That work state has already ended, so it can't be changed here.";
    }
    if (err.code === "no_open_work_state") {
      return `${name} doesn't have a current work state. Assign one first, then answer this question.`;
    }
    if (err.code === "invalid_body") {
      return `That answer doesn't fit ${name}'s current work state. Refresh the page and try again.`;
    }
  }
  return notify.errorMessage(err);
}

async function saveWorkLocality() {
  const localityCode = localityFromAnswer(wlForm.value.stateCode, wlForm.value.locality);
  if (localityCode === undefined) return;
  wlBusy.value = true;
  wlError.value = "";
  try {
    await adminPayrollApi.setWorkLocality(employeeId, {
      localityCode,
      effectiveOn: wlForm.value.effectiveOn,
    });
    notify.success("Work location saved");
    wlDialog.value = false;
    const { workStates: rows } = await adminPayrollApi.workStates(employeeId);
    workStates.value = rows;
  } catch (err) {
    wlError.value = workLocalityError(err);
  } finally {
    wlBusy.value = false;
  }
}

const seDialog = ref(false);
const seBusy = ref(false);
const seForm = ref({
  stateCode: "",
  filingStatus: "single",
  allowances: 0,
  additionalAllowances: 0,
  extraWithholding: 0,
  exempt: false,
  effectiveFrom: new Date(),
  filedDate: new Date(),
  note: "",
});

const isTerminated = computed(() => employee.value?.status === "terminated");
const accountState = computed(() => {
  const u = employee.value?.user;
  if (!u) return { label: "Not invited", canInvite: true, canResend: false };
  // PAY-217: a former employee who can still sign in for their W-2s.
  const former = employee.value?.formerW2Access;
  if (isTerminated.value && former && !u.banned)
    return {
      label: `Former employee · can get W-2s online through ${longDate(former.accessThrough)}`,
      canInvite: false,
      canResend: false,
    };
  if (isTerminated.value && former && u.banReason !== "lockout")
    return {
      label: "Former employee · can't sign in · give W-2s on paper",
      canInvite: false,
      canResend: false,
    };
  if (u.banned && u.banReason === "pending_enrollment")
    return { label: "Invite pending", canInvite: false, canResend: true };
  if (u.banned)
    return { label: `Disabled (${u.banReason ?? "banned"})`, canInvite: false, canResend: false };
  return { label: "Active", canInvite: false, canResend: false };
});

async function load() {
  loading.value = true;
  try {
    const [detail, comp, w4, ws, se] = await Promise.all([
      adminEmployeesApi.detail(employeeId),
      adminPayrollApi.compensation(employeeId),
      adminPayrollApi.w4(employeeId),
      adminPayrollApi.workStates(employeeId),
      adminPayrollApi.stateElections(employeeId),
    ]);
    employee.value = detail.employee;
    compensation.value = comp.compensation;
    w4History.value = w4.w4Elections;
    workStates.value = ws.workStates;
    stateElections.value = se.elections;
  } catch (err) {
    notFound.value = true;
    notify.error(err, "Could not load employee");
  } finally {
    loading.value = false;
  }
}

async function sendInvite(resend: boolean) {
  inviteBusy.value = true;
  setupLink.value = "";
  try {
    const result = await adminEmployeesApi.invite(
      employeeId,
      resend ? {} : { email: inviteEmail.value.trim() },
    );
    setupLink.value = result.setupLink;
    inviteDialog.value = false;
    inviteEmail.value = "";
    notify.success(
      resend ? "Invite resent" : "Invite sent",
      result.smtpMissing
        ? "SMTP is not configured — copy the setup link below."
        : "Setup email queued.",
    );
    if (result.smtpMissing) {
      // surfaced via setupLink under the header
    }
    await load();
  } catch (err) {
    if (err instanceof ApiError && err.code === "email_exists") {
      notify.error(new Error("A user with that email already exists."), "Could not invite");
    } else {
      notify.error(err, "Could not invite");
    }
  } finally {
    inviteBusy.value = false;
  }
}

function toggleStatus() {
  const disabling = !isTerminated.value;
  confirm.require({
    message: disabling
      ? `Disable ${employee.value?.legalName}? Their account loses access immediately and their sessions are revoked.`
      : `Re-enable ${employee.value?.legalName}?`,
    header: disabling ? "Disable employee" : "Re-enable employee",
    icon: "pi pi-exclamation-triangle",
    rejectProps: { label: "Cancel", severity: "secondary", text: true },
    acceptProps: {
      label: disabling ? "Disable" : "Re-enable",
      severity: disabling ? "danger" : "success",
    },
    accept: async () => {
      try {
        await adminEmployeesApi.setStatus(employeeId, {
          status: disabling ? "terminated" : "active",
        });
        notify.success(disabling ? "Employee disabled" : "Employee re-enabled");
        await load();
      } catch (err) {
        notify.error(err, "Could not update status");
      }
    },
  });
}

async function saveTaxId() {
  const taxId = tinValue.value.trim();
  if (!/^\d{9}$/.test(taxId)) {
    notify.info("Invalid tax ID", "Enter the 9-digit TIN/SSN.");
    return;
  }
  tinBusy.value = true;
  try {
    await adminEmployeesApi.setTaxId(employeeId, { taxId });
    notify.success("Tax ID saved", "Stored encrypted; only the masked form is ever shown.");
    tinDialog.value = false;
    tinValue.value = "";
    await load();
  } catch (err) {
    notify.error(err, "Could not save the tax ID");
  } finally {
    tinBusy.value = false;
  }
}

async function addCompensation() {
  compBusy.value = true;
  try {
    const effectiveFrom = toIso(compForm.value.effectiveFrom);
    if (!effectiveFrom) return;
    await adminPayrollApi.addCompensation(employeeId, {
      periodAmount: compForm.value.periodAmount,
      frequency: compForm.value.frequency,
      effectiveFrom,
      effectiveTo: compForm.value.effectiveTo ? (toIso(compForm.value.effectiveTo) ?? null) : null,
    });
    notify.success("Compensation added");
    compDialog.value = false;
    const { compensation: rows } = await adminPayrollApi.compensation(employeeId);
    compensation.value = rows;
  } catch (err) {
    notify.error(err, "Could not add compensation");
  } finally {
    compBusy.value = false;
  }
}

async function addW4() {
  w4Busy.value = true;
  try {
    const effectiveFrom = toIso(w4Form.value.effectiveFrom);
    const filedDate = toIso(w4Form.value.filedDate);
    if (!effectiveFrom || !filedDate) return;
    await adminPayrollApi.addW4(employeeId, { ...w4Form.value, effectiveFrom, filedDate });
    notify.success("W-4 election recorded");
    w4Dialog.value = false;
    const { w4Elections } = await adminPayrollApi.w4(employeeId);
    w4History.value = w4Elections;
  } catch (err) {
    notify.error(err, "Could not add W-4");
  } finally {
    w4Busy.value = false;
  }
}

async function addWorkState() {
  const stateCode = wsForm.value.stateCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(stateCode)) {
    notify.info("Invalid state", "Use the 2-letter USPS code, e.g. IL.");
    return;
  }
  const localityCode = localityFromAnswer(stateCode, wsForm.value.locality);
  if (localityCode === undefined) {
    notify.info("One more answer", "Tell us where in the state they work.");
    return;
  }
  wsBusy.value = true;
  try {
    const effectiveFrom = toIso(wsForm.value.effectiveFrom);
    if (!effectiveFrom) return;
    await adminPayrollApi.assignWorkState(employeeId, {
      stateCode,
      effectiveFrom,
      ...(WORK_LOCALITY_STATES.includes(stateCode) ? { localityCode } : {}),
    });
    notify.success("Work state assigned", `${stateCode} from ${date(effectiveFrom)}.`);
    wsDialog.value = false;
    const { workStates: rows } = await adminPayrollApi.workStates(employeeId);
    workStates.value = rows;
  } catch (err) {
    notify.error(err, "Could not assign work state");
  } finally {
    wsBusy.value = false;
  }
}

async function addStateElection() {
  const stateCode = seForm.value.stateCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(stateCode)) {
    notify.info("Invalid state", "Use the 2-letter USPS code, e.g. IL.");
    return;
  }
  seBusy.value = true;
  try {
    const effectiveFrom = toIso(seForm.value.effectiveFrom);
    const filedDate = toIso(seForm.value.filedDate);
    if (!effectiveFrom || !filedDate) return;
    await adminPayrollApi.addStateElection(employeeId, {
      ...seForm.value,
      stateCode,
      effectiveFrom,
      filedDate,
    });
    notify.success("State election recorded");
    seDialog.value = false;
    const { elections } = await adminPayrollApi.stateElections(employeeId);
    stateElections.value = elections;
  } catch (err) {
    notify.error(err, "Could not add state election");
  } finally {
    seBusy.value = false;
  }
}

// ----------------------------------------------- PAY-208: W-2 delivery (S16)
const w2Busy = ref(false);
/** S15: a withdrawal recorded for an employee we can't email — confirm on paper. */
const w2PaperNotice = ref<string | null>(null);
const w2DeliveryText = computed(() => {
  const c = employee.value?.w2Consent;
  if (!c || c.state === "none") return "Paper — hasn't agreed to online W-2s";
  if (c.state === "current") return `Online — agreed on ${longDate(c.consentedAt)}`;
  if (c.state === "outdated") {
    return `Paper for ${W2_CONSENT_GATE_FROM_TAX_YEAR} and later — agreed to earlier terms on ${longDate(c.consentedAt)} and needs to agree to the updated terms`;
  }
  return `Paper — withdrew on ${longDate(c.withdrawnAt)}`;
});
const canRecordWithdrawal = computed(() => {
  const state = employee.value?.w2Consent?.state;
  return state === "current" || state === "outdated";
});
const todayLong = computed(() =>
  new Intl.DateTimeFormat("en-US", { day: "numeric", month: "long", year: "numeric" }).format(
    new Date(),
  ),
);

function recordWithdrawal() {
  const name = employee.value?.legalName ?? "this employee";
  confirm.require({
    header: "Record a written withdrawal?",
    message: `Use this when ${name} has asked you in writing (email or letter) to stop getting W-2s online. It takes effect today, ${todayLong.value}, and can't be back-dated. They'll get a confirmation email. W-2s already given to them online don't change.`,
    icon: "pi pi-exclamation-triangle",
    rejectProps: { label: "Cancel", severity: "secondary", text: true },
    acceptProps: { label: "Record withdrawal", severity: "danger" },
    accept: async () => {
      w2Busy.value = true;
      try {
        const out = await adminEmployeesApi.w2ConsentWithdraw(employeeId);
        const on = longDate(out.effectiveOn);
        if (out.confirmation === "paper_needed") {
          w2PaperNotice.value = `Withdrawal recorded for ${name}, effective today, ${on}. We can't email them, so confirm it on paper: tell them their withdrawal took effect on ${on} and that their W-2s will now be on paper.`;
        } else {
          notify.success(
            `Withdrawal recorded for ${name}, effective today, ${on}. They've been emailed a confirmation.`,
          );
        }
        await load();
      } catch (err) {
        notify.error(err, "Could not record the withdrawal");
      } finally {
        w2Busy.value = false;
      }
    },
  });
}

// ------------------------------------------- PAY-208 (D-A): sign-in email
const emailDialog = ref(false);
const newSignInEmail = ref("");
const emailBusy = ref(false);
const emailError = ref<string | null>(null);

function openEmailDialog() {
  newSignInEmail.value = "";
  emailError.value = null;
  emailDialog.value = true;
}

/** The inline message for a refused change, or null to toast the error. */
function signInEmailErrorText(err: unknown): string | null {
  const code = err instanceof ApiError ? err.code : "";
  if (code === "session_not_fresh") {
    return "For your security, sign out and sign in again, then change the email within an hour.";
  }
  if (code === "email_exists") return "Another account already signs in with that email.";
  if (code === "invalid_body") return "Enter an email address, like name@example.com.";
  return null;
}

function signInEmailChangedNotice(out: {
  changed: boolean;
  pendingEnrollment: boolean;
  sessionsRevoked: boolean;
}) {
  if (!out.changed) {
    notify.success("Sign-in email unchanged");
    return;
  }
  if (out.pendingEnrollment) {
    // S-H1: their old setup link no longer works — nothing is re-sent automatically.
    notify.stickyInfo(
      "Sign-in email changed",
      'This employee hasn\'t finished setting up their account, and the old setup link no longer works. Use "Resend invite" at the top of this page to send a new link to the new address.',
    );
  }
  if (!out.sessionsRevoked) {
    // R3-1: the email changed, but the employee may still be signed in somewhere.
    notify.stickyInfo(
      out.pendingEnrollment ? "Not signed out everywhere" : "Sign-in email changed",
      "We couldn't sign this employee out of devices where they're already signed in. To do that, open Settings, go to the Users tab and select Reset next to their email. They'll then set a new password and two-factor sign-in.",
    );
  }
  if (out.sessionsRevoked && !out.pendingEnrollment) {
    notify.success(
      "Sign-in email changed",
      "A notice went to the old and the new address. They're signed out and sign in with the new address.",
    );
  }
}

async function changeSignInEmail() {
  const email = newSignInEmail.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    emailError.value = "Enter an email address, like name@example.com.";
    return;
  }
  emailBusy.value = true;
  emailError.value = null;
  try {
    const out = await adminEmployeesApi.changeSignInEmail(employeeId, email);
    emailDialog.value = false;
    signInEmailChangedNotice(out);
    await load();
  } catch (err) {
    emailError.value = signInEmailErrorText(err);
    if (emailError.value === null) notify.error(err, "Could not change the sign-in email");
  } finally {
    emailBusy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page stack">
    <PageHeader :title="employee?.legalName ?? 'Employee'">
      <BackButton to="admin-employees" label="Back to employees" />
      <template v-if="employee">
        <Button v-if="accountState.canInvite" label="Invite" icon="pi pi-envelope" @click="inviteDialog = true" />
        <Button v-if="accountState.canResend" label="Resend invite" icon="pi pi-refresh" severity="secondary" :loading="inviteBusy" @click="sendInvite(true)" />
        <Button
          :label="isTerminated ? 'Re-enable' : 'Disable'"
          :severity="isTerminated ? 'success' : 'danger'"
          outlined
          :icon="isTerminated ? 'pi pi-check' : 'pi pi-ban'"
          @click="toggleStatus"
        />
      </template>
    </PageHeader>

    <div v-if="setupLink" class="card">
      <h3>Setup link (copy manually)</h3>
      <code class="mono" style="word-break: break-all">{{ setupLink }}</code>
    </div>

    <Skeleton v-if="loading" height="22rem" />
    <EmptyState v-else-if="notFound || !employee" icon="pi pi-exclamation-circle" title="Employee not found" />

    <Tabs v-else v-model:value="activeTab">
      <TabList>
        <Tab value="profile">Profile</Tab>
        <Tab value="compensation">Compensation</Tab>
        <Tab value="w4">W-4 history</Tab>
        <Tab value="state">State tax</Tab>
      </TabList>
      <TabPanels>
        <TabPanel value="profile">
          <section class="card" style="margin-top: 1rem">
            <div class="row" style="justify-content: space-between; margin-bottom: 0.75rem">
              <h3 style="margin: 0">Details</h3>
              <StatusChip :status="employee.status" />
            </div>
            <dl class="kv">
              <dt>Legal name</dt>
              <dd>{{ employee.legalName }}</dd>
              <dt>Preferred name</dt>
              <dd>{{ employee.preferredName ?? "—" }}</dd>
              <dt>Employment type</dt>
              <dd>{{ employee.employmentType }}</dd>
              <dt>Hire date</dt>
              <dd>{{ date(employee.hireDate) }}</dd>
              <dt v-if="employee.terminationDate">Termination</dt>
              <dd v-if="employee.terminationDate">{{ date(employee.terminationDate) }}</dd>
              <dt>Address</dt>
              <dd>
                <template v-if="employee.address">
                  {{ employee.address.line1 }}<template v-if="employee.address.line2">, {{ employee.address.line2 }}</template>,
                  {{ employee.address.city }}, {{ employee.address.state }} {{ employee.address.zip }},
                  {{ employee.address.country }}
                </template>
                <span v-else>—</span>
              </dd>
              <dt>Mailing address</dt>
              <dd>
                <template v-if="employee.mailingAddress">
                  {{ employee.mailingAddress.line1 }}<template v-if="employee.mailingAddress.line2">, {{ employee.mailingAddress.line2 }}</template>,
                  {{ employee.mailingAddress.city }}, {{ employee.mailingAddress.state }} {{ employee.mailingAddress.zip }},
                  {{ employee.mailingAddress.country }}
                </template>
                <span v-else>— (W-2 uses the home address)</span>
                <Button
                  :label="employee.mailingAddress ? 'Edit' : 'Set'"
                  text
                  size="small"
                  icon="pi pi-envelope"
                  @click="openMailingDialog"
                />
              </dd>
              <dt>Account</dt>
              <dd>
                <template v-if="employee.user">
                  {{ employee.user.email }} · {{ accountState.label }}
                  <Button
                    label="Change sign-in email"
                    text
                    size="small"
                    icon="pi pi-pencil"
                    @click="openEmailDialog"
                  />
                </template>
                <span v-else>Not invited</span>
              </dd>
              <dt>Tax ID</dt>
              <dd>
                {{ employee.hasTaxId ? "On file (masked — not shown)" : "Not on file" }}
                <Button
                  :label="employee.hasTaxId ? 'Correct' : 'Set'"
                  text
                  size="small"
                  icon="pi pi-lock"
                  @click="tinDialog = true"
                />
              </dd>
            </dl>
          </section>
          <!-- PAY-208 (S16): W-2 delivery — the employee's online-W-2 agreement. -->
          <section v-if="employee.employmentType === 'w2'" class="card stack" style="margin-top: 1rem">
            <h3 style="margin: 0">W-2 delivery</h3>
            <p style="margin: 0">{{ w2DeliveryText }}</p>
            <Message v-if="w2PaperNotice" severity="warn" :closable="true" @close="w2PaperNotice = null">
              {{ w2PaperNotice }}
            </Message>
            <div v-if="canRecordWithdrawal">
              <Button
                label="Record written withdrawal"
                icon="pi pi-file-edit"
                size="small"
                outlined
                :loading="w2Busy"
                @click="recordWithdrawal"
              />
            </div>
          </section>
        </TabPanel>

        <TabPanel value="compensation">
          <section class="card" style="margin-top: 1rem">
            <div class="row" style="justify-content: space-between">
              <h3 style="margin: 0">Compensation history</h3>
              <Button label="Add" size="small" icon="pi pi-plus" @click="compDialog = true" />
            </div>
            <div class="table-scroll">
              <DataTable :value="compensation" striped-rows>
                <template #empty><EmptyState title="No compensation rows" body="Add the first salary before generating drafts." /></template>
                <Column header="Period amount">
                  <template #body="{ data }">{{ money(data.periodAmount) }} / {{ data.frequency }}</template>
                </Column>
                <Column header="Effective from">
                  <template #body="{ data }">{{ date(data.effectiveFrom) }}</template>
                </Column>
                <Column header="Effective to">
                  <template #body="{ data }">{{ data.effectiveTo ? date(data.effectiveTo) : "current" }}</template>
                </Column>
              </DataTable>
            </div>
          </section>
        </TabPanel>

        <TabPanel value="w4">
          <section class="card" style="margin-top: 1rem">
            <div class="row" style="justify-content: space-between">
              <h3 style="margin: 0">W-4 elections (append-only)</h3>
              <Button label="Add" size="small" icon="pi pi-plus" @click="w4Dialog = true" />
            </div>
            <div class="table-scroll">
              <DataTable :value="w4History" striped-rows>
                <template #empty><EmptyState title="No W-4 elections" body="The default (single) withholding applies until one is filed." /></template>
                <Column field="taxYear" header="Year" />
                <Column header="Filing status">
                  <template #body="{ data }">{{ filingStatusLabel(data.filingStatus) }}</template>
                </Column>
                <Column header="Exempt">
                  <template #body="{ data }">{{ data.federalExempt ? "Yes" : "No" }}</template>
                </Column>
                <Column header="Extra withholding">
                  <template #body="{ data }">{{ money(data.extraWithholding) }}</template>
                </Column>
                <Column header="Effective from">
                  <template #body="{ data }">{{ date(data.effectiveFrom) }}</template>
                </Column>
                <Column header="Filed">
                  <template #body="{ data }">{{ date(data.filedDate) }}</template>
                </Column>
              </DataTable>
            </div>
          </section>
        </TabPanel>

        <TabPanel value="state">
          <EmployeeResidenceCard :employee-id="employeeId" :employee-name="displayName" />

          <section class="card" style="margin-top: 1rem">
            <div class="row" style="justify-content: space-between">
              <h3 style="margin: 0">Where {{ displayName }} works</h3>
              <Button label="Assign" size="small" icon="pi pi-plus" @click="wsDialog = true" />
            </div>
            <p class="muted small">
              State income tax follows where they work. Adding a new state ends the current one on
              the new date.
            </p>
            <div class="table-scroll">
              <DataTable :value="workStates" striped-rows>
                <template #empty><EmptyState title="No work state" body="Assign the state the employee works in to enable per-state withholding." /></template>
                <Column field="stateCode" header="State" />
                <Column header="City or county">
                  <template #body="{ data }">
                    {{ workLocalityLabel(data) }}
                    <Button
                      v-if="needsLocalityAnswer(data)"
                      label="Answer"
                      text
                      size="small"
                      icon="pi pi-map-marker"
                      :aria-label="`Answer where ${displayName} works in ${stateLabel(data.stateCode)}`"
                      @click="openLocalityDialog(data)"
                    />
                  </template>
                </Column>
                <Column header="Effective from">
                  <template #body="{ data }">{{ date(data.effectiveFrom) }}</template>
                </Column>
                <Column header="Effective to">
                  <template #body="{ data }">{{ data.effectiveTo ? date(data.effectiveTo) : "current" }}</template>
                </Column>
              </DataTable>
            </div>
          </section>

          <section class="card" style="margin-top: 1rem">
            <div class="row" style="justify-content: space-between">
              <h3 style="margin: 0">State withholding elections (append-only)</h3>
              <Button label="Add" size="small" icon="pi pi-plus" @click="seDialog = true" />
            </div>
            <p class="muted small">
              The IL-W-4 / DE 4 mirror of the W-4: regular + estimated-deduction allowances, per-period
              extra withholding, and state-only exempt. The latest row effective on the period start applies.
            </p>
            <div class="table-scroll">
              <DataTable :value="stateElections" striped-rows>
                <template #empty><EmptyState title="No state elections" body="Zero allowances apply until one is filed." /></template>
                <Column field="stateCode" header="State" />
                <Column header="Filing status">
                  <template #body="{ data }">{{ filingStatusLabel(data.filingStatus) }}</template>
                </Column>
                <Column field="allowances" header="Allow." />
                <Column field="additionalAllowances" header="Add'l" />
                <Column header="Extra">
                  <template #body="{ data }">{{ money(data.extraWithholding) }}</template>
                </Column>
                <Column header="Exempt">
                  <template #body="{ data }">{{ data.exempt ? "Yes" : "No" }}</template>
                </Column>
                <Column header="Effective from">
                  <template #body="{ data }">{{ date(data.effectiveFrom) }}</template>
                </Column>
                <Column header="Filed">
                  <template #body="{ data }">{{ date(data.filedDate) }}</template>
                </Column>
              </DataTable>
            </div>
          </section>
        </TabPanel>
      </TabPanels>
    </Tabs>

    <Dialog v-model:visible="inviteDialog" modal header="Invite employee" :style="{ width: '28rem' }">
      <p class="muted small">
        They receive a single-use setup link (24h) to choose a password and enroll an authenticator app.
      </p>
      <div class="field">
        <label for="inviteEmail">Email</label>
        <InputText id="inviteEmail" v-model="inviteEmail" type="email" required />
      </div>
      <div class="row" style="justify-content: flex-end">
        <Button label="Cancel" text severity="secondary" @click="inviteDialog = false" />
        <Button label="Send invite" :loading="inviteBusy" :disabled="!inviteEmail.includes('@')" @click="sendInvite(false)" />
      </div>
    </Dialog>

    <Dialog v-model:visible="tinDialog" modal header="Set employee tax ID" :style="{ width: '26rem' }">
      <form class="stack" @submit.prevent="saveTaxId">
        <p class="muted small">
          The TIN/SSN is encrypted at rest, write-only in every API response, and the change is
          audit-logged with masked values only. Employees can also submit their own via a
          change request.
        </p>
        <div class="field">
          <label for="tinInput">Tax ID / SSN (9 digits)</label>
          <InputMask id="tinInput" v-model="tinValue" mask="999999999" autocomplete="off" required />
        </div>
        <div class="row" style="justify-content: flex-end">
          <Button label="Cancel" text severity="secondary" type="button" @click="tinDialog = false" />
          <Button type="submit" label="Save" icon="pi pi-save" :loading="tinBusy" />
        </div>
      </form>
    </Dialog>

    <Dialog v-model:visible="mailDialog" modal header="Set mailing address" :style="{ width: '30rem' }">
      <form class="stack" @submit.prevent="saveMailingAddress">
        <p class="muted small">
          The mailing address is used on W-2s (box f) effective from the date below; before that,
          the previous address history applies. The employee can also request this change themselves.
        </p>
        <div class="form-grid">
          <div class="field" style="grid-column: 1 / -1">
            <label for="mailLine1">Street address</label>
            <InputText id="mailLine1" v-model="mailForm.line1" autocomplete="off" required />
          </div>
          <div class="field" style="grid-column: 1 / -1">
            <label for="mailLine2">Apartment, suite, etc. (optional)</label>
            <InputText id="mailLine2" v-model="mailForm.line2" autocomplete="off" />
          </div>
          <div class="field">
            <label for="mailCity">City</label>
            <InputText id="mailCity" v-model="mailForm.city" autocomplete="off" required />
          </div>
          <div class="field">
            <label for="mailState">State / Province</label>
            <InputText id="mailState" v-model="mailForm.state" autocomplete="off" required />
          </div>
          <div class="field">
            <label for="mailZip">ZIP / Postal code</label>
            <InputText id="mailZip" v-model="mailForm.zip" autocomplete="off" required />
          </div>
          <div class="field">
            <label for="mailCountry">Country (2-letter code)</label>
            <InputText id="mailCountry" v-model="mailForm.country" maxlength="2" required />
          </div>
          <div class="field">
            <label for="mailFrom">Effective from</label>
            <DatePicker id="mailFrom" v-model="mailForm.effectiveFrom" date-format="yy-mm-dd" required />
          </div>
        </div>
        <div class="row" style="justify-content: flex-end">
          <Button label="Cancel" text severity="secondary" type="button" @click="mailDialog = false" />
          <Button
            type="submit"
            label="Save"
            icon="pi pi-save"
            :loading="mailBusy"
            :disabled="!mailForm.line1.trim() || !mailForm.city.trim() || !mailForm.state.trim() || !mailForm.zip.trim() || mailForm.country.trim().length !== 2"
          />
        </div>
      </form>
    </Dialog>

    <Dialog v-model:visible="compDialog" modal header="Add compensation" :style="{ width: '30rem' }">
      <form class="stack" @submit.prevent="addCompensation">
        <div class="form-grid">
          <div class="field">
            <label for="periodAmount">Period amount</label>
            <InputNumber id="periodAmount" v-model="compForm.periodAmount" mode="currency" currency="USD" required />
          </div>
          <div class="field">
            <label for="frequency">Frequency</label>
            <Select id="frequency" v-model="compForm.frequency" :options="['monthly', 'semimonthly', 'biweekly', 'weekly']" />
          </div>
          <div class="field">
            <label for="compFrom">Effective from</label>
            <DatePicker id="compFrom" v-model="compForm.effectiveFrom" date-format="yy-mm-dd" required />
          </div>
          <div class="field">
            <label for="compTo">Effective to (optional)</label>
            <DatePicker id="compTo" v-model="compForm.effectiveTo" date-format="yy-mm-dd" />
          </div>
        </div>
        <div class="row" style="justify-content: flex-end">
          <Button label="Cancel" text severity="secondary" type="button" @click="compDialog = false" />
          <Button type="submit" label="Add" :loading="compBusy" :disabled="compForm.periodAmount <= 0" />
        </div>
      </form>
    </Dialog>

    <Dialog v-model:visible="w4Dialog" modal header="Add W-4 election" :style="{ width: '34rem' }">
      <form class="stack" @submit.prevent="addW4">
        <div class="form-grid">
          <div class="field">
            <label for="w4Year">Tax year</label>
            <InputNumber id="w4Year" v-model="w4Form.taxYear" :min="2020" :max="2100" :use-grouping="false" />
          </div>
          <div class="field">
            <label for="w4Status">Filing status</label>
            <Select id="w4Status" v-model="w4Form.filingStatus" :options="[
              { label: 'Single', value: 'single' },
              { label: 'Married filing jointly', value: 'married_joint' },
              { label: 'Married filing separately', value: 'married_separate' },
              { label: 'Head of household', value: 'head_of_household' },
            ]" option-label="label" option-value="value" />
          </div>
          <div class="field">
            <label for="w4Dep">Dependents (annual)</label>
            <InputNumber id="w4Dep" v-model="w4Form.dependentsAmount" mode="currency" currency="USD" />
          </div>
          <div class="field">
            <label for="w4Other">Other income (annual)</label>
            <InputNumber id="w4Other" v-model="w4Form.otherIncome" mode="currency" currency="USD" />
          </div>
          <div class="field">
            <label for="w4Ded">Deductions (annual)</label>
            <InputNumber id="w4Ded" v-model="w4Form.deductionsAmount" mode="currency" currency="USD" />
          </div>
          <div class="field">
            <label for="w4Extra">Extra withholding (per period)</label>
            <InputNumber id="w4Extra" v-model="w4Form.extraWithholding" mode="currency" currency="USD" />
          </div>
          <div class="field">
            <label for="w4From">Effective from</label>
            <DatePicker id="w4From" v-model="w4Form.effectiveFrom" date-format="yy-mm-dd" />
          </div>
          <div class="field">
            <label for="w4Filed">Date filed</label>
            <DatePicker id="w4Filed" v-model="w4Form.filedDate" date-format="yy-mm-dd" />
          </div>
        </div>
        <div class="row">
          <span class="row"><Checkbox v-model="w4Form.federalExempt" binary input-id="w4Exempt" /><label for="w4Exempt">Federal exempt</label></span>
          <span class="row"><Checkbox v-model="w4Form.multipleJobs" binary input-id="w4Multi" /><label for="w4Multi">Multiple jobs</label></span>
        </div>
        <div class="row" style="justify-content: flex-end">
          <Button label="Cancel" text severity="secondary" type="button" @click="w4Dialog = false" />
          <Button type="submit" label="Add" :loading="w4Busy" />
        </div>
      </form>
    </Dialog>

    <Dialog v-model:visible="wsDialog" modal header="Assign work state" :style="{ width: '26rem' }">
      <form class="stack" @submit.prevent="addWorkState">
        <p class="muted small">
          If we don't have that state's tax tables for the year, you'll need to add them under
          Configuration → State taxes before running payroll.
        </p>
        <div class="form-grid">
          <div class="field">
            <label for="wsState">State (USPS code)</label>
            <InputText id="wsState" v-model="wsForm.stateCode" maxlength="2" placeholder="IL" required />
          </div>
          <div class="field">
            <label for="wsFrom">Effective from</label>
            <DatePicker id="wsFrom" v-model="wsForm.effectiveFrom" date-format="yy-mm-dd" required />
          </div>
        </div>
        <WorkLocalityQuestion
          v-model="wsForm.locality"
          :state-code="wsForm.stateCode.trim().toUpperCase()"
          :employee-name="displayName"
          id-prefix="ws"
          show-required
        />
        <div class="row" style="justify-content: flex-end">
          <Button label="Cancel" text severity="secondary" type="button" @click="wsDialog = false" />
          <Button
            type="submit"
            label="Assign"
            :loading="wsBusy"
            :disabled="wsForm.stateCode.trim().length !== 2 || wsNeedsAnswer"
          />
        </div>
      </form>
    </Dialog>

    <Dialog
      v-model:visible="wlDialog"
      modal
      :header="`Where ${displayName} works in ${stateLabel(wlForm.stateCode)}`"
      :style="{ width: '28rem' }"
      :breakpoints="{ '575px': '95vw' }"
    >
      <form class="stack" @submit.prevent="saveWorkLocality">
        <WorkLocalityQuestion
          v-model="wlForm.locality"
          :state-code="wlForm.stateCode"
          :employee-name="displayName"
          id-prefix="wl"
        />
        <Message v-if="wlError" severity="error" :closable="false" role="alert">{{ wlError }}</Message>
        <div class="row" style="justify-content: flex-end">
          <Button label="Cancel" text severity="secondary" type="button" @click="wlDialog = false" />
          <Button
            type="submit"
            label="Save"
            icon="pi pi-save"
            :loading="wlBusy"
            :disabled="localityFromAnswer(wlForm.stateCode, wlForm.locality) === undefined"
          />
        </div>
      </form>
    </Dialog>

    <Dialog v-model:visible="seDialog" modal header="Add state withholding election" :style="{ width: '34rem' }">
      <form class="stack" @submit.prevent="addStateElection">
        <div class="form-grid">
          <div class="field">
            <label for="seState">State (USPS code)</label>
            <InputText id="seState" v-model="seForm.stateCode" maxlength="2" placeholder="IL" required />
          </div>
          <div class="field">
            <label for="seStatus">Filing status</label>
            <Select id="seStatus" v-model="seForm.filingStatus" :options="[
              { label: 'Single', value: 'single' },
              { label: 'Married filing jointly', value: 'married_joint' },
              { label: 'Married filing separately', value: 'married_separate' },
              { label: 'Head of household', value: 'head_of_household' },
            ]" option-label="label" option-value="value" />
          </div>
          <div class="field">
            <label for="seAllow">Regular allowances</label>
            <InputNumber id="seAllow" v-model="seForm.allowances" :min="0" :max="99" :use-grouping="false" />
          </div>
          <div class="field">
            <label for="seAddAllow">Additional (estimated-deduction) allowances</label>
            <InputNumber id="seAddAllow" v-model="seForm.additionalAllowances" :min="0" :max="99" :use-grouping="false" />
          </div>
          <div class="field">
            <label for="seExtra">Extra withholding (per period)</label>
            <InputNumber id="seExtra" v-model="seForm.extraWithholding" mode="currency" currency="USD" />
          </div>
          <div class="field">
            <label for="seFrom">Effective from</label>
            <DatePicker id="seFrom" v-model="seForm.effectiveFrom" date-format="yy-mm-dd" />
          </div>
          <div class="field">
            <label for="seFiled">Date filed</label>
            <DatePicker id="seFiled" v-model="seForm.filedDate" date-format="yy-mm-dd" />
          </div>
          <div class="field">
            <label for="seNote">Note (optional)</label>
            <InputText id="seNote" v-model="seForm.note" />
          </div>
        </div>
        <div class="row">
          <span class="row"><Checkbox v-model="seForm.exempt" binary input-id="seExempt" /><label for="seExempt">Exempt from state withholding</label></span>
        </div>
        <div class="row" style="justify-content: flex-end">
          <Button label="Cancel" text severity="secondary" type="button" @click="seDialog = false" />
          <Button type="submit" label="Add" :loading="seBusy" :disabled="seForm.stateCode.trim().length !== 2" />
        </div>
      </form>
    </Dialog>
    <!-- PAY-208 (D-A): change the email the employee signs in with. -->
    <Dialog
      v-model:visible="emailDialog"
      header="Change sign-in email"
      modal
      :style="{ width: '28rem' }"
      :breakpoints="{ '575px': '92vw' }"
    >
      <div class="stack">
        <p style="margin: 0">
          The employee signs in with the new address from now on, and W-2 emails go there. We email a
          notice to the old and the new address.
        </p>
        <div class="field">
          <label for="newSignInEmail">New sign-in email</label>
          <InputText
            id="newSignInEmail"
            v-model="newSignInEmail"
            type="email"
            autocomplete="off"
            :invalid="emailError !== null"
          />
        </div>
        <Message v-if="emailError" severity="error" :closable="false" role="alert">{{ emailError }}</Message>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" text @click="emailDialog = false" />
        <Button label="Change email" icon="pi pi-check" :loading="emailBusy" @click="changeSignInEmail" />
      </template>
    </Dialog>
  </div>
</template>

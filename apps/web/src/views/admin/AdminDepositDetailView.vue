<script setup lang="ts">
/**
 * Admin deposit detail (PAY-36): the reference details for a single tax deposit,
 * including the EFTPS values needed to enter the deposit on eftps.gov, breakdown
 * by category, contributing runs, and attachments.
 *
 * PAY-91 (spec 23 §7): when a state changes between monthly and quarterly
 * payments, the page shows the payments already made for the period, what is
 * left to pay, any overpayment, and — on a replaced row — which deposit
 * replaced it. Copy is plain and gives no tax advice.
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import Button from "primevue/button";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Dialog from "primevue/dialog";
import DatePicker from "primevue/datepicker";
import InputText from "primevue/inputtext";
import Skeleton from "primevue/skeleton";
import Message from "primevue/message";
import {
  formatCents,
  jurisdictionLabel as sharedJurisdictionLabel,
  parseCents,
  stateName,
} from "@payroll/shared";
import PageHeader from "../../components/PageHeader.vue";
import BackButton from "../../components/BackButton.vue";
import StatusChip from "../../components/StatusChip.vue";
import {
  adminDepositsApi,
  type DepositBreakdownRow,
  type DepositDetail,
  type DepositRunRow,
  type TaxDepositRow,
} from "../../lib/api";
import { isAdditionalDeposit, withAdditionalPrefix } from "../../lib/deposit-labels";
import { useDates } from "../../composables/useDates";
import { useMoney } from "../../composables/useMoney";
import { useNotify } from "../../composables/useNotify";

const route = useRoute();
const router = useRouter();
const { date, toIso } = useDates();
const { money } = useMoney();
const notify = useNotify();

// Computed: the "View Q3 2026 deposit" link reuses this component with a new id.
const depositId = computed(() => Number(route.params.id));

const loading = ref(true);
const deposit = ref<TaxDepositRow | null>(null);
const breakdown = ref<DepositBreakdownRow[]>([]);
const runs = ref<DepositRunRow[]>([]);
const credits = ref<DepositDetail["credits"]>([]);
const overpaid = ref("0.00");
const replacedBy = ref<DepositDetail["replacedBy"]>([]);
const liability = ref("0.00");
const alreadyDeposited = ref("0.00");
const stillOwedEarlier = ref("0.00");
const siblings = ref<DepositDetail["siblings"]>([]);
const additionalDeposit = ref<DepositDetail["additionalDeposit"]>(null);
const form941DueDate = ref<string | null>(null);
const attachments = ref<{ id: number; filename: string; sizeBytes: number; uploadedAt: string }[]>(
  [],
);

// Deposit dialog state
const depositDialog = ref(false);
const depositBusy = ref(false);
const depositedOn = ref<Date | null>(new Date());
const eftpsConfirmation = ref("");

const MONTH_NAMES = [
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

const QUARTER_ORDINALS = ["1st", "2nd", "3rd", "4th"] as const;

/** "4th quarter 2026" — the EFTPS tax period wording (PAY-193). */
function eftpsQuarterLabel(periodStart: string): string {
  const quarter = Math.ceil(Number(periodStart.slice(5, 7)) / 3);
  return `${QUARTER_ORDINALS[quarter - 1] ?? `Q${quarter}`} quarter ${periodStart.slice(0, 4)}`;
}

/** "California (CA)" / "Federal" — shared map (PAY-91 UX). */
function jurisdictionLabel(jurisdiction: string): string {
  return sharedJurisdictionLabel(jurisdiction);
}

/** "Q3 2026" — the quarter this deposit belongs to. */
function quarterLabel(periodStart: string): string {
  return periodLabel(periodStart, "quarter");
}

function centsOf(amount: string): number {
  try {
    return parseCents(amount);
  } catch {
    return 0;
  }
}

const isSuperseded = computed(() => deposit.value?.status === "superseded");
/** D5: a live 0.00 row has nothing left to pay. */
const nothingToPay = computed(
  () =>
    !!deposit.value &&
    deposit.value.status !== "deposited" &&
    !isSuperseded.value &&
    centsOf(deposit.value.amount) === 0,
);
const canRecord = computed(
  () =>
    !!deposit.value &&
    deposit.value.status !== "deposited" &&
    !isSuperseded.value &&
    !nothingToPay.value,
);
const overpaidAnchor = ref(false);
const paymentsUnavailable = ref(false);
/** The explanatory note may show on every row of an overpaid quarter. */
const isOverpaid = computed(() => centsOf(overpaid.value) > 0);
/** The chip shows only on the quarter's anchor (latest-period) row. */
const overpaidChip = computed(() => isOverpaid.value && overpaidAnchor.value);
const state = computed(() => (deposit.value ? stateName(deposit.value.jurisdiction) : ""));
/** PAY-193: this row is an additional deposit (seq > 0). */
const isAdditional = computed(() => !!deposit.value && isAdditionalDeposit(deposit.value));
/** "December 2026" / "Q4 2026" — the row's period, without the additional prefix. */
const period = computed(() =>
  deposit.value ? periodLabel(deposit.value.periodStart, deposit.value.periodKind) : "",
);
const pageTitle = computed(() => {
  const d = deposit.value;
  if (!d) return "";
  return isAdditional.value
    ? `${rowPeriodLabel(d)} (${state.value})`
    : `${period.value} ${state.value} deposit`;
});
/** PAY-193: the shortfall notice shows while the additional deposit is still open. */
const showAdditionalNotice = computed(
  () => isAdditional.value && !isSuperseded.value && deposit.value?.status !== "deposited",
);
/** PAY-193 round 3: some earlier row of the period is deposited ("was made" wording). */
const earlierDeposited = computed(() => centsOf(alreadyDeposited.value) > 0);
/** PAY-193 round 3: the period's newest live row (no live sibling with a higher seq). */
const isNewestRow = computed(
  () => !!deposit.value && !siblings.value.some((r) => r.seq > (deposit.value?.seq ?? 0)),
);
/** PAY-193 round 3: the seq 0 notice shows only once this row is paid. */
const showAdditionalLink = computed(
  () => !isAdditional.value && deposit.value?.status === "deposited" && !!additionalDeposit.value,
);
const isState = computed(() => !!deposit.value && deposit.value.jurisdiction !== "federal");
const subtitle = computed(() => {
  const d = deposit.value;
  if (!d) return "";
  if (isSuperseded.value) return "Replaced · nothing to pay here";
  return `Due ${date(d.dueDate)} · Amount ${money(d.amount)}`;
});
/** To-monthly banner link: the state's deposits for that year. */
const stateYearLink = computed(() => ({
  name: "admin-deposits",
  query: {
    jurisdiction: deposit.value?.jurisdiction ?? "",
    year: deposit.value?.periodStart.slice(0, 4) ?? "",
  },
}));
const appliedTotal = computed(() =>
  formatCents(credits.value.reduce((sum, c) => sum + centsOf(c.applied), 0)),
);
const replacement = computed(() => replacedBy.value[0] ?? null);
/** Case C: this month is paid (partly) by an earlier quarter payment. */
const creditedByQuarter = computed(
  () =>
    deposit.value?.periodKind === "month" && credits.value.some((c) => c.periodKind === "quarter"),
);

const statusChip = computed(() => {
  if (!deposit.value) return "pending";
  if (nothingToPay.value) return overpaidChip.value ? "overpaid" : "nothing_to_pay";
  return isOverdue.value ? "overdue" : deposit.value.status;
});
/** A second chip only when the anchor is not a 0.00 row (a lone deposited quarter). */
const extraOverpaidChip = computed(() => overpaidChip.value && !nothingToPay.value);

const isOverdue = computed(() => {
  if (!deposit.value) return false;
  const today = new Date().toISOString().slice(0, 10);
  return (
    deposit.value.status === "overdue" ||
    (deposit.value.status === "pending" && deposit.value.dueDate < today)
  );
});

const totalAmount = computed(() => {
  if (!breakdown.value) return "0.00";
  return breakdown.value.reduce((sum, row) => sum + Number(row.amount), 0).toFixed(2);
});

const COMBINED_LABELS: Record<string, string> = {
  federal_withholding: "Federal income tax withheld",
  social_security_combined: "Social security (employee + employer)",
  medicare_combined: "Medicare (employee + employer)",
};

function combinedCategory(category: string): string {
  if (category === "social_security" || category === "employer_social_security") {
    return "social_security";
  } else if (category === "medicare" || category === "employer_medicare") {
    return "medicare";
  }
  return category;
}

const combinedBreakdown = computed(() => {
  if (!breakdown.value) return [];

  // Group by category and sum amounts
  const grouped: Record<string, DepositBreakdownRow> = {};
  for (const row of breakdown.value) {
    const category = combinedCategory(row.category);
    if (!grouped[category]) {
      grouped[category] = { ...row, category };
    } else {
      grouped[category].amount = (Number(grouped[category].amount) + Number(row.amount)).toFixed(2);
    }
  }

  // Convert back to array, renaming the combined categories so their labels resolve
  const combined = Object.values(grouped).map((row) => {
    if (row.category === "social_security") {
      return { ...row, category: "social_security_combined" };
    }
    if (row.category === "medicare") {
      return { ...row, category: "medicare_combined" };
    }
    return row;
  });

  return combined.map((row) => ({
    ...row,
    category: COMBINED_LABELS[row.category] || row.category,
  }));
});

async function load() {
  loading.value = true;
  try {
    const detail = await adminDepositsApi.detail(depositId.value);
    deposit.value = detail.deposit;
    breakdown.value = detail.breakdown;
    runs.value = detail.runs;
    credits.value = detail.credits;
    overpaid.value = detail.overpaid;
    replacedBy.value = detail.replacedBy;
    liability.value = detail.liability;
    alreadyDeposited.value = detail.alreadyDeposited;
    stillOwedEarlier.value = detail.stillOwedEarlier;
    siblings.value = detail.siblings;
    additionalDeposit.value = detail.additionalDeposit;
    form941DueDate.value = detail.form941DueDate;
    overpaidAnchor.value = detail.overpaidAnchor;
    paymentsUnavailable.value = detail.paymentsUnavailable;
    attachments.value = (await adminDepositsApi.listAttachments(depositId.value)).attachments.map(
      (a) => ({
        id: a.id,
        filename: a.filename,
        sizeBytes: a.sizeBytes,
        uploadedAt: a.createdAt,
      }),
    );
  } catch (err) {
    notify.error(err, "Could not load the deposit detail");
    router.push({ name: "admin-deposits" });
  } finally {
    loading.value = false;
  }
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function handleClickRun(event: { data: DepositRunRow }) {
  router.push({ name: "admin-payroll-run", params: { id: event.data.publicId } });
}

function openDepositDialog() {
  depositedOn.value = new Date();
  eftpsConfirmation.value = "";
  depositDialog.value = true;
}

async function submitDeposit() {
  const target = deposit.value;
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

onMounted(async () => {
  await load();
});

watch(depositId, load);
</script>

<template>
  <div class="page stack">
    <Skeleton v-if="loading" height="16rem" />
    <template v-else-if="deposit">
<PageHeader :title="pageTitle" :subtitle="subtitle">
        <BackButton to="admin-deposits" label="Back to deposits" />
        <StatusChip :status="statusChip" style="margin-left: 0.5rem" />
        <StatusChip v-if="extraOverpaidChip" status="overpaid" style="margin-left: 0.25rem" />
      </PageHeader>

      <Message
        v-if="showAdditionalNotice"
        :severity="isOverdue ? 'warn' : 'info'"
        :closable="false"
        data-testid="additional-notice"
      >
        <template v-if="earlierDeposited">
          A payroll for {{ period }} was issued after your deposit for that period was made, so its
          taxes weren't included.
          <template v-if="!nothingToPay">
            Pay {{ money(deposit.amount) }} as an additional deposit for {{ period }}.
          </template>
        </template>
        <template v-else>
          A payroll for {{ period }} was issued after your earlier deposit for that period was
          already due, so its taxes weren't included in it.
          <template v-if="!nothingToPay">
            Pay {{ money(deposit.amount) }} as an additional deposit for {{ period }}, and pay the
            earlier deposit too.
          </template>
        </template>
        <template v-if="!nothingToPay">
          The amount shown is only what's left to pay, not the full period.
        </template>
        <template v-if="!isState">
          <template v-if="isOverdue">
            This deposit was due {{ date(deposit.dueDate) }}. The IRS can charge a late-deposit
            penalty of 2% (1–5 days late), 5% (6–15 days), 10% (16 or more days), or 15% (still
            unpaid more than 10 days after an IRS notice), plus interest. Wagon Payroll doesn't
            calculate penalties. If you're a monthly depositor, made the original deposit on time,
            and this extra amount is no more than $100 or 2% of what was due (whichever is
            greater), there's no penalty as long as you deposit it or pay it with your Form 941 by
            {{ date(form941DueDate) }}.
          </template>
          In EFTPS, pay this as a Form 941 federal tax deposit for the same tax period as the
          original deposit: {{ eftpsQuarterLabel(deposit.periodStart) }}. That's the quarter your
          employees were paid in, not the quarter you're paying in.
        </template>
        <template v-else>
          Additional payments were due on the same date as the original deposit. If that date has
          passed, pay as soon as you can. If you already filed the return for that period, your
          state may also need an amended return.
          <template v-if="isOverdue">
            Wagon Payroll doesn't calculate state penalties or interest. States charge their own
            penalties and interest on tax paid after the due date, usually counted from the
            original due date. Your state's instructions have the details.
          </template>
        </template>
      </Message>

      <Message
        v-if="showAdditionalLink && additionalDeposit"
        severity="info"
        :closable="false"
        data-testid="additional-link"
      >
        A payroll was added to {{ period }} after you paid this. The extra
        {{ money(additionalDeposit.amount) }} is on a separate additional deposit.
        <RouterLink :to="{ name: 'admin-deposit-detail', params: { id: additionalDeposit.id } }">
          View additional deposit
        </RouterLink>
      </Message>

      <Message v-if="isSuperseded" severity="secondary" :closable="false" data-testid="replaced-banner">
        <template v-if="deposit.periodKind === 'month'">
          Replaced — nothing to pay on this page. {{ state }} changed to quarterly payments, so this
          month is now part of the {{ quarterLabel(deposit.periodStart) }} deposit.
          <RouterLink
            v-if="replacement"
            :to="{ name: 'admin-deposit-detail', params: { id: replacement.id } }"
          >
            View {{ quarterLabel(deposit.periodStart) }} deposit
          </RouterLink>
        </template>
        <template v-else>
          Replaced — nothing to pay on this page. {{ state }} changed to monthly payments, so this
          quarter is now split into monthly deposits.
          <RouterLink :to="stateYearLink">
            View {{ state }} deposits for {{ deposit.periodStart.slice(0, 4) }}
          </RouterLink>
        </template>
      </Message>

      <p v-if="isState && !isSuperseded" class="muted small" data-testid="state-due-note">
        This due date is our best estimate. Check {{ state }}'s deposit schedule for the exact date.
      </p>

      <Message v-if="paymentsUnavailable" severity="warn" :closable="false">
        We couldn't check the payments already made for this period, so the amount above may not
        be right. Check it against your payroll runs before you pay, and contact support.
      </Message>

      <section v-if="credits.length && !isAdditional" class="card stack" data-testid="deposit-credits">
        <h3>Payments already made for {{ quarterLabel(deposit.periodStart) }}</h3>
        <ul class="credit-list">
          <li v-for="c in credits" :key="c.depositId">
            {{ periodLabel(c.periodStart, c.periodKind) }} payment on {{ date(c.depositedOn) }}:
            {{ money(c.amount) }}<template v-if="c.applied !== c.amount"> — {{ money(c.applied) }} counted here</template>
          </li>
        </ul>
        <p v-if="creditedByQuarter" style="margin: 0">
          Counted toward this month: {{ money(appliedTotal) }}.
        </p>
        <p v-if="creditedByQuarter" class="muted small" style="margin: 0">
          {{ state }} now takes monthly payments. Check with {{ state }} how your
          {{ quarterLabel(deposit.periodStart) }} payment was applied to each month.
        </p>
        <p v-else-if="deposit.periodKind === 'quarter'" class="muted small" style="margin: 0">
          {{ state }} now takes one payment per quarter. Check with {{ state }} that your monthly
          payments were applied to {{ quarterLabel(deposit.periodStart) }}.
        </p>
        <p v-else class="muted small" style="margin: 0">
          Check with {{ state }} how your payments for
          {{ periodLabel(deposit.periodStart, deposit.periodKind) }} were applied to each month.
        </p>
      </section>

      <Message v-if="isOverpaid" severity="info" :closable="false">
        Your recorded payments for {{ quarterLabel(deposit.periodStart) }} are
        {{ money(overpaid) }} more than that quarter's withholding. Ask {{ state }} how they want
        to handle the extra amount.
      </Message>

      <section v-if="!isSuperseded" class="card stack">
        <h3>EFTPS reference</h3>
        <p class="muted small">
          When depositing to eftps.gov, use these exact values:
        </p>
        <div class="stack">
          <div class="row">
            <div class="col">
              <p class="muted small" style="margin: 0">Tax period</p>
              <p class="bold">{{ periodLabel(deposit.periodStart, deposit.periodKind) }}</p>
            </div>
            <div class="col">
              <p class="muted small" style="margin: 0">Amount</p>
              <p class="bold">{{ money(deposit.amount) }}</p>
            </div>
            <div class="col">
              <p class="muted small" style="margin: 0">Due date</p>
              <p class="bold">{{ date(deposit.dueDate) }}</p>
            </div>
            <div class="col">
              <p class="muted small" style="margin: 0">Jurisdiction</p>
              <p class="bold">{{ jurisdictionLabel(deposit.jurisdiction) }}</p>
            </div>
            <div class="col">
              <p class="muted small" style="margin: 0">Tax year</p>
              <p class="bold">{{ deposit.periodStart.slice(0, 4) }}</p>
            </div>
            <div class="col">
              <p class="muted small" style="margin: 0">Quarter</p>
              <p class="bold">Q{{ Math.ceil(Number(deposit.periodStart.slice(5, 7)) / 3) }}</p>
            </div>
          </div>
          <div class="row" v-if="nothingToPay">
            <p class="muted small" v-if="credits.length">
              Payments already recorded for {{ periodLabel(deposit.periodStart, deposit.periodKind) }}
              cover this amount.
            </p>
            <p class="muted small" v-else>
              The issued payroll runs for this period add up to {{ money(totalAmount) }}.
            </p>
          </div>
          <div class="row" v-else-if="canRecord">
            <p class="muted small">
              <strong>Hint:</strong> Pay on eftps.gov first, then return here to record the deposit confirmation.
            </p>
            <Button
              label="Mark as deposited"
              size="small"
              @click="openDepositDialog"
              style="margin-left: 0.5rem"
            />
          </div>
          <div class="row" v-else-if="deposit.status === 'deposited'">
            <p class="muted small">
              <strong>Deposited:</strong> {{ date(deposit.depositedOn) }} · EFTPS {{ deposit.eftpsConfirmation }}
            </p>
          </div>
        </div>
      </section>

      <section class="card stack">
        <h3>Breakdown</h3>
        <p v-if="isAdditional" class="bold" style="margin: 0" data-testid="additional-breakdown">
          <template v-if="isNewestRow">
            Total tax for {{ period }}: {{ money(liability) }} ·
          </template>
          Already deposited: {{ money(alreadyDeposited) }} ·
          <template v-if="centsOf(stillOwedEarlier) > 0">
            Still owed on an earlier deposit: {{ money(stillOwedEarlier) }} ·
          </template>
          Left to pay: {{ money(deposit.amount) }}
        </p>
        <template v-else>
        <DataTable :value="combinedBreakdown" data-key="category" striped-rows>
          <Column field="category" header="Category">
            <template #body="{ data }">
              {{ data.category }}
            </template>
          </Column>
          <Column header="Amount" style="width: 12rem; text-align: right">
            <template #body="{ data }">
              {{ money(data.amount) }}
            </template>
          </Column>
        </DataTable>
        <div class="row" style="justify-content: flex-end; padding-top: 0.5rem">
          <div class="col" style="text-align: right">
            <p v-if="isState" class="bold" style="margin: 0">
              Total withholding for {{ periodLabel(deposit.periodStart, deposit.periodKind) }}:
              {{ money(totalAmount) }}
            </p>
            <p v-else class="bold" style="margin: 0">Total: {{ money(totalAmount) }}</p>
            <p
              v-if="credits.length && !isSuperseded && deposit.status !== 'deposited'"
              style="margin: 0"
              data-testid="left-to-pay"
            >
              Already paid: {{ money(appliedTotal) }} · Left to pay: {{ money(deposit.amount) }}
            </p>
          </div>
        </div>
        </template>
      </section>

      <section class="card stack">
        <template v-if="isAdditional">
          <h3>Payroll runs for {{ period }}</h3>
          <p class="muted small" style="margin: 0">
            All payroll runs for {{ period }} ({{ runs.length }}). This additional deposit covers
            the part not included in your earlier payment.
          </p>
        </template>
        <template v-else>
          <h3>Contributing runs</h3>
          <p class="muted small" style="margin: 0">
            Runs that contributed to this deposit ({{ runs.length }} total).
          </p>
        </template>
        <DataTable v-if="runs.length" :value="runs" data-key="publicId" striped-rows @row-click="handleClickRun">
          <Column header="Pay date" style="width: 10rem">
            <template #body="{ data }">
              {{ date(data.payDate) }}
            </template>
          </Column>
          <Column header="Employee" style="width: 12rem">
            <template #body="{ data }">
              {{ data.employeeName }}
            </template>
          </Column>
          <Column header="Amount" style="width: 10rem; text-align: right">
            <template #body="{ data }">
              {{ money(data.amount) }}
            </template>
          </Column>
        </DataTable>
        <p v-else class="muted" style="margin: 0.5rem 0">
          No issued runs in this period.
        </p>
      </section>

      <section class="card stack">
        <h3>Attachments</h3>
        <p class="muted small" style="margin: 0">
          EFTPS confirmation attachments uploaded for this deposit.
        </p>
        <DataTable v-if="attachments.length" :value="attachments" data-key="id" striped-rows>
          <Column field="filename" header="File" />
          <Column header="Size" style="width: 8rem; text-align: right">
            <template #body="{ data }">{{ fileSize(data.sizeBytes) }}</template>
          </Column>
          <Column header="Uploaded" style="width: 10rem">
            <template #body="{ data }">{{ date(data.uploadedAt) }}</template>
          </Column>
          <Column header="" style="width: 8rem">
            <template #body="{ data }">
              <a
                :href="adminDepositsApi.attachmentDownloadUrl(depositId, data.id)"
                target="_blank"
                rel="noopener"
              >
                <Button label="View" icon="pi pi-download" size="small" text />
              </a>
            </template>
          </Column>
        </DataTable>
        <p v-else class="muted" style="margin: 0.5rem 0">
          No attachments uploaded yet.
        </p>
      </section>
    </template>

    <Dialog
      v-model:visible="depositDialog"
      modal
      header="Mark as deposited"
      :style="{ width: '26rem' }"
    >
      <div class="stack" v-if="deposit">
        <p class="muted small">
          {{ rowPeriodLabel(deposit) }} — {{ money(deposit.amount) }},
          due {{ date(deposit.dueDate) }}. Pay on eftps.gov first; this records the deposit.<template
            v-if="isAdditional"
          > This is a second payment for the same period — don't repeat the earlier one.</template>
        </p>
        <div class="field">
          <label for="depositedOn">Deposit date</label>
          <DatePicker
            id="depositedOn"
            v-model="depositedOn"
            date-format="yy-mm-dd"
            show-icon
          />
        </div>
        <div class="field">
          <label for="eftpsConfirmation">EFTPS confirmation number</label>
          <InputText
            id="eftpsConfirmation"
            v-model="eftpsConfirmation"
            required
            maxlength="100"
          />
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
  </div>
</template>

<style scoped>
.col {
  flex: 1;
  min-width: 12rem;
}

.dialog-actions {
  justify-content: flex-end;
}

.credit-list {
  margin: 0;
  padding-left: 1.25rem;
}
</style>
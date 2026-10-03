<script setup lang="ts">
/**
 * PAY-193 L4 late dialog (copy section 1, addendum L4.9). Opened only by a
 * 409 late_payment_confirmation_required: the attestation text and the state
 * questions are the server's strings, shown verbatim. The amount the owner
 * types fills the attestation live; the run's computed net pay is never
 * shown before a mismatch (Product Lead amendment 1).
 */
import { computed, nextTick, ref, watch } from "vue";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import Dialog from "primevue/dialog";
import InputNumber from "primevue/inputnumber";
import Message from "primevue/message";
import SelectButton from "primevue/selectbutton";
import { parseCents, stateName } from "@payroll/shared";
import type { LateAttestationBody, LatePayment, LateStateReturn } from "../lib/api";
import { useDates } from "../composables/useDates";
import { useMoney } from "../composables/useMoney";

const props = defineProps<{
  attestation: LateAttestationBody | null;
  stateJurisdictions: string[];
  /** The 409 message (server-rendered intro). */
  message: string;
  payDate: string;
  employeeName: string;
  busy: boolean;
  /** A refusal from the last attempt, shown inline at the top (copy 1.11). */
  refusal: string | null;
  /** Shown only after late_payment_amount_mismatch (copy 2.4). */
  netPayHint: number | null;
}>();

const visible = defineModel<boolean>("visible", { required: true });
const emit = defineEmits<{ submit: [latePayment: LatePayment] }>();

const { longDate } = useDates();
const { money } = useMoney();

type Flag = "withholdingReturnFiled" | "suiWageReportFiled" | "annualReconciliationFiled";
type Answers = Record<Flag, boolean | null>;

const amount = ref<number | null>(null);
const confirmed = ref(false);
const answers = ref<Record<string, Answers>>({});
const heading = ref<HTMLElement | null>(null);
const refusalBox = ref<HTMLElement | null>(null);

const ANSWER_OPTIONS = [
  { label: "No, not filed", value: false },
  { label: "Yes, filed", value: true },
];

const year = computed(() => props.payDate.slice(0, 4));

const QUESTION_KEYS: {
  flag: Flag;
  key: "withholdingReturn" | "suiWageReport" | "annualReconciliation";
}[] = [
  { flag: "withholdingReturnFiled", key: "withholdingReturn" },
  { flag: "suiWageReportFiled", key: "suiWageReport" },
  { flag: "annualReconciliationFiled", key: "annualReconciliation" },
];

function resetAnswers(): void {
  const next: Record<string, Answers> = {};
  for (const j of props.stateJurisdictions) {
    next[j] = {
      withholdingReturnFiled: null,
      suiWageReportFiled: null,
      annualReconciliationFiled: null,
    };
  }
  answers.value = next;
}

// A new confirmation request (another run, or reopened) starts empty.
watch(
  () => props.attestation,
  () => {
    amount.value = null;
    confirmed.value = false;
    resetAnswers();
  },
  { immediate: true },
);

watch(
  () => props.refusal,
  async (r) => {
    if (!r) return;
    await nextTick();
    refusalBox.value?.focus();
  },
);

/** Attestation with the typed amount, or "the amount below" until typed. */
const attestationText = computed(() => {
  const text = props.attestation?.text ?? "";
  const filled = amount.value === null ? "the amount below" : money(amount.value);
  return text.replace("{netPay}", filled);
});

const questions = computed(() => props.attestation?.stateQuestions ?? []);

function hasYes(j: string): boolean {
  const a = answers.value[j];
  return !!a && Object.values(a).some((v) => v === true);
}

const anyYes = computed(() => props.stateJurisdictions.some(hasYes));

const unanswered = computed(() =>
  props.stateJurisdictions.reduce((n, j) => {
    const a = answers.value[j];
    return n + (a ? Object.values(a).filter((v) => v === null).length : 3);
  }, 0),
);

/** Copy 1.9: what is still missing, in order. */
const progress = computed(() => {
  if (anyYes.value) return "A filed state return stops this payroll from being issued here.";
  const missing: string[] = [];
  if (amount.value === null) missing.push("type the amount you paid");
  if (!confirmed.value) missing.push("tick the confirmation box");
  const k = unanswered.value;
  if (k === 1) missing.push("answer 1 more question");
  else if (k > 1) missing.push(`answer ${k} more questions`);
  return missing.length > 0 ? `To continue: ${missing.join(", ")}` : "";
});

const canSubmit = computed(
  () => amount.value !== null && confirmed.value && unanswered.value === 0 && !anyYes.value,
);

function submit(): void {
  if (!canSubmit.value || amount.value === null) return;
  const stateReturns: LateStateReturn[] = props.stateJurisdictions.map((j) => {
    const a = answers.value[j];
    return {
      jurisdiction: j,
      withholdingReturnFiled: a?.withholdingReturnFiled === true,
      suiWageReportFiled: a?.suiWageReportFiled === true,
      annualReconciliationFiled: a?.annualReconciliationFiled === true,
    };
  });
  emit("submit", {
    attestationVersion: 1,
    // W-L6: exact cents from the 2-decimal string; no float multiply.
    netPayCents: parseCents(amount.value.toFixed(2)),
    stateReturns,
  });
}

function onShow(): void {
  heading.value?.focus();
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :style="{ width: 'min(36rem, 95vw)' }"
    @show="onShow"
  >
    <template #header>
      <h2 ref="heading" tabindex="-1" class="late-heading">Confirm this payment before you issue it</h2>
    </template>

    <div class="stack late-body">
      <div v-if="refusal" ref="refusalBox" tabindex="-1">
        <Message severity="error" :closable="false">
          {{ refusal }}
          <template v-if="netPayHint !== null"><br />This payroll's net pay is {{ money(netPayHint) }}.</template>
        </Message>
      </div>

      <p>
        {{
          message ||
          `This payroll's pay date, ${longDate(payDate)}, is in a tax period that has ended. To add it to ${year}, confirm the date and amount you paid, and that the related state returns aren't filed yet.`
        }}
      </p>

      <div>
        <p class="late-subhead">When you issue it, Wagon Payroll will:</p>
        <ul class="late-list">
          <li>Add this payroll to your {{ year }} pay and tax totals.</li>
          <li>Update any {{ year }} tax returns for this period that you haven't marked as filed.</li>
          <li>Add any extra tax deposit you now owe. It may already be past due.</li>
          <li>Email {{ employeeName }} if their {{ year }} W-2 changes.</li>
          <li>Make the payslip visible to {{ employeeName }}. This can't be undone.</li>
        </ul>
      </div>

      <p class="late-attestation">{{ attestationText }}</p>

      <div class="field">
        <label for="late-amount">Amount that reached {{ employeeName }}'s account</label>
        <InputNumber
          v-model="amount"
          input-id="late-amount"
          mode="currency"
          currency="USD"
          locale="en-US"
          :min-fraction-digits="2"
          :max-fraction-digits="2"
          :min="0"
          aria-describedby="late-amount-help"
        />
        <small id="late-amount-help">
          Type the take-home pay (net pay) exactly as it shows in your bank record, including cents. This
          is the amount after taxes and deductions.
        </small>
      </div>

      <span class="row">
        <Checkbox v-model="confirmed" binary input-id="late-confirm" />
        <label for="late-confirm">I confirm the statement above is true.</label>
      </span>

      <section v-if="stateJurisdictions.length > 0" class="stack">
        <h3 class="late-subhead">State tax returns</h3>
        <p>
          Answer for the period of this pay date. If you're not sure, check your state tax account before
          you answer.
        </p>
        <fieldset v-for="j in stateJurisdictions" :key="j" class="late-state">
          <legend>{{ stateName(j) }}</legend>
          <template v-for="q in questions.filter((x) => x.jurisdiction === j)" :key="q.jurisdiction">
            <div v-for="k in QUESTION_KEYS" :key="k.flag" class="late-question">
              <span :id="`late-q-${j}-${k.flag}`">{{ q[k.key] }}</span>
              <SelectButton
                v-if="answers[j]"
                v-model="answers[j]![k.flag]"
                :options="ANSWER_OPTIONS"
                option-label="label"
                option-value="value"
                :aria-labelledby="`late-q-${j}-${k.flag}`"
              />
            </div>
          </template>
          <Message v-if="hasYes(j)" severity="error" :closable="false">
            You said a {{ stateName(j) }} return or report for this period is already filed. Wagon Payroll
            can't add this payroll after that. It needs a state correction form, which Wagon Payroll
            doesn't prepare. If you chose Yes by mistake, change it to No. Otherwise, close this window,
            keep the pay date as it is, and keep your own record of this payment for the correction.
          </Message>
        </fieldset>
      </section>

      <p class="late-final">
        Issuing is final. The payslip becomes visible to {{ employeeName }} and this payroll can't be voided.
      </p>
      <div class="row late-actions">
        <span class="late-progress" aria-live="polite">{{ progress }}</span>
        <Button label="Cancel" text severity="secondary" @click="visible = false" />
        <Button
          :label="busy ? 'Issuing…' : `Issue for ${year}`"
          icon="pi pi-send"
          severity="success"
          :disabled="!canSubmit"
          :loading="busy"
          @click="submit"
        />
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.late-heading {
  margin: 0;
  font-size: 1.15rem;
}
.late-heading:focus {
  outline: none;
}
.late-body p {
  margin: 0;
}
.late-subhead {
  font-weight: 600;
  margin: 0 0 0.25rem;
  font-size: 1rem;
}
.late-list {
  margin: 0;
  padding-left: 1.25rem;
}
.late-attestation {
  white-space: pre-line;
  padding: 0.75rem;
  border-left: 3px solid var(--p-primary-color, #888);
  background: var(--p-content-hover-background, transparent);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.late-state {
  border: 1px solid var(--p-surface-border, #ddd);
  border-radius: 6px;
  padding: 0.5rem 0.75rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
}
.late-question {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.late-final {
  font-size: 0.9rem;
}
.late-actions {
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.late-progress {
  flex: 1 1 12rem;
  font-size: 0.85rem;
}
</style>

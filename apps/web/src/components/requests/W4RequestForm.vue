<script setup lang="ts">
/**
 * W-4 form — 2020+ shape, shared w4Payload schema. effective_from is owned
 * by the wizard (top-level); this form fills the rest.
 */
import { computed } from "vue";
import { useField, useForm } from "vee-validate";
import { toTypedSchema } from "@vee-validate/zod";
import { w4Payload } from "@payroll/shared";
import InputNumber from "primevue/inputnumber";
import Select from "primevue/select";
import Checkbox from "primevue/checkbox";
import DatePicker from "primevue/datepicker";
import Textarea from "primevue/textarea";
import type { z } from "zod";

// Wizard injects effectiveFrom at submit time; validate the rest here.
const schema = w4Payload.omit({ effectiveFrom: true });
type W4FormValues = z.input<typeof schema>;

// Explicit generic + useField<number> for the amount fields: primevue 5
// tightened InputNumber's v-model to Nullable<number>, and defineField
// returns Ref<unknown> in this vee-validate version — useField<T> is the
// typed registration path.
/** Date → "YYYY-MM-DD" from its local calendar fields (no UTC shift). */
function localIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const { handleSubmit, defineField, errors } = useForm<W4FormValues>({
  validationSchema: toTypedSchema(schema),
  initialValues: {
    taxYear: new Date().getFullYear(),
    filingStatus: "single",
    federalExempt: false,
    multipleJobs: false,
    dependentsAmount: 0,
    otherIncome: 0,
    deductionsAmount: 0,
    extraWithholding: 0,
    filedDate: localIsoDate(new Date()), // browser-local today, not the UTC day
    note: "",
  },
});

const [taxYear] = defineField("taxYear");
const [filingStatus] = defineField("filingStatus");
const [federalExempt] = defineField("federalExempt");
const [multipleJobs] = defineField("multipleJobs");
const { value: dependentsAmount } = useField<number>("dependentsAmount");
const { value: otherIncome } = useField<number>("otherIncome");
const { value: deductionsAmount } = useField<number>("deductionsAmount");
const { value: extraWithholding } = useField<number>("extraWithholding");
const [filedDateModel] = defineField("filedDate");
const [note] = defineField("note");

// DatePicker works with Date; the schema wants YYYY-MM-DD (local, no UTC shift).
const filedDate = computed({
  get: (): Date | null => {
    const v = filedDateModel.value;
    return typeof v === "string" && v ? new Date(`${v}T00:00:00`) : null;
  },
  set: (d: Date | null) => {
    filedDateModel.value = d ? localIsoDate(d) : "";
  },
});

const filingOptions: { label: string; value: W4FormValues["filingStatus"] }[] = [
  { label: "Single", value: "single" },
  { label: "Married filing jointly", value: "married_joint" },
  { label: "Married filing separately", value: "married_separate" },
  { label: "Head of household", value: "head_of_household" },
];

async function validate(): Promise<Record<string, unknown> | null> {
  const result = await handleSubmit(async (values) => values)();
  return (result as Record<string, unknown> | undefined) ?? null;
}

defineExpose({ validate });
</script>

<template>
  <div class="form-grid">
    <div class="field">
      <label for="taxYear">Tax year</label>
      <InputNumber id="taxYear" v-model="taxYear" :min="2020" :max="2100" :use-grouping="false" :invalid="Boolean(errors.taxYear)" />
      <small class="error-text">{{ errors.taxYear }}</small>
    </div>
    <div class="field">
      <label for="filingStatus">Filing status</label>
      <Select id="filingStatus" v-model="filingStatus" :options="filingOptions" option-label="label" option-value="value" :invalid="Boolean(errors.filingStatus)" />
      <small class="error-text">{{ errors.filingStatus }}</small>
    </div>
    <div class="field">
      <label for="dependentsAmount">Dependents amount (annual)</label>
      <InputNumber id="dependentsAmount" v-model="dependentsAmount" mode="currency" currency="USD" :invalid="Boolean(errors.dependentsAmount)" />
      <small class="error-text">{{ errors.dependentsAmount }}</small>
    </div>
    <div class="field">
      <label for="otherIncome">Other income (annual)</label>
      <InputNumber id="otherIncome" v-model="otherIncome" mode="currency" currency="USD" :invalid="Boolean(errors.otherIncome)" />
      <small class="error-text">{{ errors.otherIncome }}</small>
    </div>
    <div class="field">
      <label for="deductionsAmount">Deductions (annual)</label>
      <InputNumber id="deductionsAmount" v-model="deductionsAmount" mode="currency" currency="USD" :invalid="Boolean(errors.deductionsAmount)" />
      <small class="error-text">{{ errors.deductionsAmount }}</small>
    </div>
    <div class="field">
      <label for="extraWithholding">Extra withholding (per pay period)</label>
      <InputNumber id="extraWithholding" v-model="extraWithholding" mode="currency" currency="USD" :invalid="Boolean(errors.extraWithholding)" />
      <small class="error-text">{{ errors.extraWithholding }}</small>
    </div>
    <div class="field">
      <label for="filedDate">Date filed</label>
      <DatePicker id="filedDate" v-model="filedDate" date-format="yy-mm-dd" :invalid="Boolean(errors.filedDate)" />
      <small class="error-text">{{ errors.filedDate }}</small>
    </div>
    <div class="field">
      <label for="note">Note (optional)</label>
      <Textarea id="note" v-model="note" rows="2" :invalid="Boolean(errors.note)" />
      <small class="error-text">{{ errors.note }}</small>
    </div>
    <div class="field" style="grid-column: 1 / -1; flex-direction: row; align-items: center; gap: 1.5rem">
      <span class="row"><Checkbox v-model="federalExempt" binary input-id="federalExempt" /><label for="federalExempt">Exempt from federal withholding</label></span>
      <span class="row"><Checkbox v-model="multipleJobs" binary input-id="multipleJobs" /><label for="multipleJobs">Multiple jobs / spouse works</label></span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * PAY-163 (Spec 25 (PAY-120)): the work-locality question for one work
 * state — Yonkers yes / no for New York, the county for Maryland, nothing
 * for other states. v-model is the raw answer ("yes" / "no" / county code);
 * localityFromAnswer turns it into a localityCode.
 */
import { computed } from "vue";
import Select from "primevue/select";
import SelectButton from "primevue/selectbutton";
import { COUNTY_OPTIONS, localityFromAnswer, YES_NO } from "../composables/useWorkLocality";

const props = defineProps<{
  stateCode: string;
  employeeName: string;
  /** Prefix for element ids (two dialogs can be mounted at once). */
  idPrefix: string;
  /** Show "Answer this to continue." while unanswered. */
  showRequired?: boolean;
}>();
const answer = defineModel<string>({ required: true });

const unanswered = computed(
  () => props.showRequired && localityFromAnswer(props.stateCode, answer.value) === undefined,
);
</script>

<template>
  <div v-if="stateCode === 'NY'" class="field">
    <label :id="`${idPrefix}YonkersLabel`">
      Does {{ employeeName }} do any of their work in Yonkers?
    </label>
    <SelectButton
      v-model="answer"
      :aria-labelledby="`${idPrefix}YonkersLabel`"
      :options="YES_NO"
      option-label="label"
      option-value="value"
    />
    <p class="muted small">Yonkers taxes people who work there, even if they live somewhere else.</p>
    <p v-if="unanswered" class="muted small">Answer this to continue.</p>
  </div>
  <div v-else-if="stateCode === 'MD'" class="field">
    <label :for="`${idPrefix}County`">Which Maryland county does {{ employeeName }} work in?</label>
    <Select
      v-model="answer"
      :input-id="`${idPrefix}County`"
      :options="COUNTY_OPTIONS"
      option-label="label"
      option-value="value"
      filter
      placeholder="Choose a county"
    />
    <p v-if="unanswered" class="muted small">Answer this to continue.</p>
  </div>
</template>

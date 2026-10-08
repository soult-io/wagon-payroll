<script setup lang="ts">
/**
 * PAY-103 R18: notice for payroll years whose tax tables aren't installed.
 * Always shown while a year is uncovered (not closable). No link or button to
 * Config → Tax tables (owner). Not MissingTaxConfigBanner, which is the
 * filings 409 case with an "Open Tax tables" button.
 */
import { onMounted } from "vue";
import Message from "primevue/message";
import { useTaxTableCoverage } from "../composables/useTaxTableCoverage";

const { load, lines, severity } = useTaxTableCoverage();

onMounted(() => {
  void load();
});
</script>

<template>
  <Message
    v-if="lines.length > 0"
    :severity="severity"
    :closable="false"
    data-testid="missing-tax-tables-banner"
  >
    <div class="stack">
      <span v-for="l in lines" :key="l.year">
        <strong>{{ l.lead }}</strong> {{ l.text }}
      </span>
    </div>
  </Message>
</template>

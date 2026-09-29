<script setup lang="ts">
/**
 * PAY-162: block banner for a year with no federal tax settings (409
 * missing_tax_config), with a link to Config → Tax tables. Copy is built from
 * the year only.
 */
import { RouterLink } from "vue-router";
import Button from "primevue/button";
import Message from "primevue/message";
import { missingTaxConfigText } from "../lib/w2-issues";

defineProps<{ year: number }>();
</script>

<template>
  <Message severity="error" :closable="false" data-testid="missing-tax-config-banner">
    <div class="stack">
      <span>{{ missingTaxConfigText(year) }}</span>
      <RouterLink :to="{ name: 'admin-config' }">
        <Button label="Open Tax tables" icon="pi pi-cog" size="small" />
      </RouterLink>
    </div>
  </Message>
</template>

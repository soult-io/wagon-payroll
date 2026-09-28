<script setup lang="ts">
/**
 * Spec 24 (PAY-116) §9 "State tax account numbers": the employer account
 * number each state gave the company, printed in box 15 of every W-2.
 *
 * Write-only (Spec 24 L10): the typed number lives only in this
 * component's local state, is cleared after every save and when the
 * component goes away, and is never put in a Pinia store, localStorage,
 * sessionStorage or the URL. The page shows only the mask the server sends.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import Button from "primevue/button";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import InputNumber from "primevue/inputnumber";
import InputText from "primevue/inputtext";
import Message from "primevue/message";
import Select from "primevue/select";
import Skeleton from "primevue/skeleton";
import {
  NY_STATE_ID_HINT,
  STATE_ID_MAX_YEAR,
  STATE_ID_MIN_YEAR,
  STATE_NAMES,
  stateName,
} from "@payroll/shared";
import { ApiError, adminSettingsApi, type StateIdList, type StateIdRow } from "../lib/api";
import { useNotify } from "../composables/useNotify";

const notify = useNotify();

const list = ref<StateIdList | null>(null);
const loading = ref(true);
const loadError = ref(false);
const saving = ref(false);
const saveError = ref("");
const removing = ref<string | null>(null);

const stateCode = ref("");
const fromTaxYear = ref<number>(STATE_ID_MIN_YEAR);
/** The typed number. Local only; cleared after save and on unmount. */
const typed = ref("");

const stateOptions = Object.entries(STATE_NAMES)
  .map(([code, name]) => ({ label: name, value: code }))
  .sort((a, b) => (a.label < b.label ? -1 : 1));

const canSave = computed(
  () => stateCode.value !== "" && typed.value.trim() !== "" && Number.isInteger(fromTaxYear.value),
);

async function load() {
  loading.value = true;
  loadError.value = false;
  try {
    list.value = await adminSettingsApi.stateIds();
  } catch {
    loadError.value = true;
  } finally {
    loading.value = false;
  }
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "state_id_year_filed") {
      return "You've already filed the W-2s for that year, so its number can't change here. Enter the new number from the first year you haven't filed.";
    }
    if (err.code === "invalid_body" && Array.isArray(err.details)) {
      const custom = (err.details as { code?: string; message?: string }[]).find(
        (d) => d.code === "custom" && d.message,
      );
      if (custom?.message) return `${custom.message}.`;
      return "Check the number and the tax year, then save again.";
    }
  }
  return notify.errorMessage(err);
}

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  saveError.value = "";
  const state = stateCode.value;
  try {
    await adminSettingsApi.putStateId(state, {
      stateId: typed.value,
      fromTaxYear: fromTaxYear.value,
    });
    notify.success("Saved", `Your ${stateName(state)} account number is on file.`);
    await load();
  } catch (err) {
    saveError.value = errorText(err);
  } finally {
    // Cleared on success and failure alike: the number is never kept around.
    typed.value = "";
    saving.value = false;
  }
}

async function remove(row: StateIdRow) {
  const key = `${row.stateCode}:${row.fromTaxYear}`;
  removing.value = key;
  try {
    await adminSettingsApi.deleteStateId(row.stateCode, row.fromTaxYear);
    notify.success(
      "Removed",
      `${stateName(row.stateCode)} number from ${row.fromTaxYear} removed.`,
    );
    await load();
  } catch (err) {
    notify.error(new Error(errorText(err)), "Could not remove it");
  } finally {
    removing.value = null;
  }
}

function neededText(n: { stateCode: string; taxYear: number; reason: string }): string {
  const state = stateName(n.stateCode);
  return n.reason === "tax_withheld"
    ? `Add your ${state} account number. Your ${n.taxYear} W-2s show ${state} tax withheld.`
    : `Your ${n.taxYear} W-2s show ${state} wages with no ${state} tax withheld. If ${state} gave you an account number, add it.`;
}

onMounted(load);
onBeforeUnmount(() => {
  typed.value = "";
});
</script>

<template>
  <section class="card stack">
    <h3>State tax account numbers</h3>
    <p class="muted small">
      Your state gives you an employer account number when you register for state payroll tax. It
      goes in box 15 of each W-2.
    </p>

    <Skeleton v-if="loading && !list" height="6rem" />
    <Message v-else-if="loadError" severity="error" :closable="false">
      We couldn't load your state account numbers.
      <Button label="Try again" text size="small" icon="pi pi-refresh" @click="load" />
    </Message>
    <template v-else-if="list">
      <Message
        v-for="n in list.needed"
        :key="`${n.stateCode}:${n.taxYear}`"
        :severity="n.reason === 'tax_withheld' ? 'warn' : 'info'"
        :closable="false"
      >
        {{ neededText(n) }}
      </Message>

      <p v-for="d in list.defaults" :key="d.stateCode" class="small" data-testid="state-id-default">
        <strong>{{ stateName(d.stateCode) }}:</strong>
        Using your EIN ({{ d.idMasked }}). Change it if {{ stateName(d.stateCode) }} gave you a
        different number.
      </p>

      <div v-if="list.stateIds.length" class="table-scroll">
        <DataTable :value="list.stateIds" striped-rows>
          <Column header="State">
            <template #body="{ data }">{{ stateName(data.stateCode) }}</template>
          </Column>
          <Column header="From tax year" field="fromTaxYear" />
          <Column header="Account number">
            <template #body="{ data }">{{ data.idMasked }}</template>
          </Column>
          <Column header="">
            <template #body="{ data }">
              <Button
                icon="pi pi-trash"
                text
                severity="danger"
                :aria-label="`Remove ${stateName(data.stateCode)} number from ${data.fromTaxYear}`"
                :loading="removing === `${data.stateCode}:${data.fromTaxYear}`"
                @click="remove(data)"
              />
            </template>
          </Column>
        </DataTable>
      </div>
      <p v-else class="muted small">No state account numbers on file yet.</p>
    </template>

    <div class="form-grid">
      <div class="field">
        <label for="stateIdState">State</label>
        <Select
          v-model="stateCode"
          input-id="stateIdState"
          :options="stateOptions"
          option-label="label"
          option-value="value"
          filter
          placeholder="Choose a state"
        />
      </div>
      <div class="field">
        <label for="stateIdYear">Use from tax year</label>
        <InputNumber
          v-model="fromTaxYear"
          input-id="stateIdYear"
          :use-grouping="false"
          :min="STATE_ID_MIN_YEAR"
          :max="STATE_ID_MAX_YEAR"
        />
      </div>
      <div class="field">
        <label for="stateIdValue">Account number</label>
        <InputText
          id="stateIdValue"
          v-model="typed"
          autocomplete="off"
          spellcheck="false"
          maxlength="64"
        />
        <small v-if="stateCode === 'NY'" class="muted">{{ NY_STATE_ID_HINT }}</small>
        <small v-else class="muted">
          We keep it encrypted and only ever show the last 4 characters.
        </small>
      </div>
    </div>
    <Message v-if="saveError" severity="error" :closable="false">{{ saveError }}</Message>
    <div class="row">
      <Button
        label="Save account number"
        icon="pi pi-save"
        :loading="saving"
        :disabled="!canSave"
        @click="save"
      />
    </div>
  </section>
</template>

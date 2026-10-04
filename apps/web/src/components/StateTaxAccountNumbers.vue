<script setup lang="ts">
/**
 * Spec 24 (PAY-116) §9 "State tax account numbers": the employer account
 * number each state gave the company, printed in box 15 of every W-2.
 *
 * Write-only (Spec 24 L10): the typed number lives only in this
 * component's local state, is cleared after a successful save and when the
 * component goes away, and is never put in a Pinia store, localStorage,
 * sessionStorage or the URL. The page shows only the mask the server sends.
 * The format is checked in the browser with the same rules as the server
 * before anything is sent.
 *
 * Spec 24 (PAY-116) PR-4 (carry-over f): before a save or remove that would
 * change the number on W-2s already given out (the server's `furnished`
 * counts), the owner confirms first. A save of the number already stored
 * changes nothing on the server (`unchanged`), and the page says so.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import InputNumber from "primevue/inputnumber";
import InputText from "primevue/inputtext";
import Message from "primevue/message";
import Select from "primevue/select";
import Skeleton from "primevue/skeleton";
import { useConfirm } from "primevue/useconfirm";
import {
  isCheckedStateIdState,
  normalizeStateId,
  STATE_ID_HINTS,
  STATE_ID_MAX_YEAR,
  STATE_ID_MIN_YEAR,
  STATE_NAMES,
  stateName,
} from "@payroll/shared";
import {
  ApiError,
  adminSettingsApi,
  type StateIdList,
  type StateIdNeeded,
  type StateIdRow,
} from "../lib/api";
import { useNotify } from "../composables/useNotify";
import {
  affectedEmployees,
  affectedYearsText,
  nextRowYear,
  STATE_ID_CHANGE_HEADER,
  stateIdChangeText,
  stateIdRemoveText,
  stateIdUnchangedText,
} from "../lib/w2-filing";

const notify = useNotify();
const confirm = useConfirm();

const GENERAL_HINT =
  "We keep it encrypted. After you save, you'll see at most its last 4 characters, never the full number.";

const list = ref<StateIdList | null>(null);
const loading = ref(true);
const loadError = ref(false);
const saving = ref(false);
const saveError = ref("");
/** Format problem found in the browser, shown under the field. */
const fieldError = ref("");
const removing = ref<string | null>(null);

const stateCode = ref("");
const fromTaxYear = ref<number | null>(STATE_ID_MIN_YEAR);
/** The typed number. Local only; cleared after a successful save and on unmount. */
const typed = ref("");

const stateOptions = Object.entries(STATE_NAMES)
  .map(([code, name]) => ({ label: name, value: code }))
  .sort((a, b) => (a.label < b.label ? -1 : 1));

const yearMissing = computed(() => fromTaxYear.value === null);
/**
 * Spec 24 (PAY-116) PR-4 round 4: no save before the list loaded — the
 * "W-2s already given out" confirm needs its furnished counts.
 */
const listReady = computed(() => list.value !== null && !loadError.value);
const canSave = computed(
  () =>
    listReady.value &&
    stateCode.value !== "" &&
    typed.value.trim() !== "" &&
    fromTaxYear.value !== null &&
    Number.isInteger(fromTaxYear.value),
);

/** The row the current state + year would replace, if any. */
const existing = computed<StateIdRow | null>(
  () =>
    list.value?.stateIds.find(
      (r) => r.stateCode === stateCode.value && r.fromTaxYear === fromTaxYear.value,
    ) ?? null,
);

const stateHint = computed(() => STATE_ID_HINTS[stateCode.value] ?? null);
const numeric = computed(() => isCheckedStateIdState(stateCode.value));
const describedBy = computed(() =>
  [
    fieldError.value ? "stateIdValueError" : null,
    stateHint.value ? "stateIdValueStateHint" : null,
    "stateIdValueHint",
  ]
    .filter((id) => id !== null)
    .join(" "),
);

// A new state or year is a new question: drop a stale error.
watch([stateCode, fromTaxYear], () => {
  fieldError.value = "";
  saveError.value = "";
});

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

/** "2026 on", "2026–2027", or "2026" when the next row starts the year after. */
function usedFor(row: StateIdRow): string {
  const next = nextRowYear(list.value?.stateIds ?? [], row);
  if (next === null) return `${row.fromTaxYear} on`;
  const last = next - 1;
  return last === row.fromTaxYear ? `${row.fromTaxYear}` : `${row.fromTaxYear}–${last}`;
}

function errorText(err: unknown, action: "save" | "remove", state: string): string {
  if (err instanceof ApiError) {
    if (err.code === "state_id_year_filed") {
      const name = stateName(state);
      const year = err.body?.firstOpenYear;
      const open = typeof year === "number" ? String(year) : "the first year you haven't filed yet";
      return action === "save"
        ? `This number is already on W-2s you've marked as filed, so it can't change for those years. If ${name} gave you a new number, set "Use from tax year" to ${open} and save again.`
        : `This number is on W-2s you've already marked as filed, so it can't be removed. If ${name} gave you a new number, add it from ${open}.`;
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

/** PR-4: employees (and years) whose given-out W-2 a change at state + year would correct. */
function affected(state: string, year: number): { n: number; years: string } {
  const furnished = list.value?.furnished ?? [];
  const rows = list.value?.stateIds ?? [];
  const target = { stateCode: state, fromTaxYear: year };
  return {
    n: affectedEmployees(furnished, rows, target),
    years: affectedYearsText(furnished, rows, target),
  };
}

function save() {
  if (!canSave.value || fromTaxYear.value === null) return;
  const state = stateCode.value;
  const year = fromTaxYear.value;
  saveError.value = "";
  const checked = normalizeStateId(state, typed.value);
  if (!checked.ok) {
    // Keep what was typed so it can be corrected; it stays in this component only.
    fieldError.value = `${checked.message}.`;
    void focusNumber();
    return;
  }
  fieldError.value = "";
  const { n, years } = affected(state, year);
  if (n === 0) {
    void put(state, year);
    return;
  }
  confirm.require({
    header: STATE_ID_CHANGE_HEADER,
    message: stateIdChangeText(n, years, state),
    icon: "pi pi-exclamation-triangle",
    rejectProps: { label: "Keep the current number", severity: "secondary", text: true },
    acceptProps: { label: "Save and correct W-2s", severity: "warn" },
    accept: () => put(state, year),
  });
}

async function put(state: string, year: number) {
  saving.value = true;
  try {
    const res = await adminSettingsApi.putStateId(state, {
      stateId: typed.value,
      fromTaxYear: year,
    });
    typed.value = "";
    if (res.unchanged) {
      notify.info("No change", stateIdUnchangedText(state));
    } else {
      notify.success(
        "Saved",
        `Your ${stateName(state)} account number is saved for W-2s from ${year} on.`,
      );
    }
    await load();
  } catch (err) {
    saveError.value = errorText(err, "save", state);
  } finally {
    saving.value = false;
  }
}

function askRemove(row: StateIdRow) {
  const name = stateName(row.stateCode);
  const { n, years } = affected(row.stateCode, row.fromTaxYear);
  const given = n > 0 ? ` ${stateIdRemoveText(n, years, row.stateCode)}` : "";
  confirm.require({
    header: `Remove ${name} account number?`,
    message: `Remove ${name} number ${row.idMasked} (used from ${row.fromTaxYear})? You won't be able to see the full number again, so you'd need to type it in again to add it back. W-2s that show ${name} tax withheld can't be made without a number.${given}`,
    icon: "pi pi-exclamation-triangle",
    rejectProps: { label: "Keep it", severity: "secondary", text: true },
    acceptProps: { label: "Remove number", severity: "danger" },
    accept: () => remove(row),
  });
}

async function remove(row: StateIdRow) {
  removing.value = `${row.stateCode}:${row.fromTaxYear}`;
  try {
    await adminSettingsApi.deleteStateId(row.stateCode, row.fromTaxYear);
    notify.success(
      "Removed",
      `${stateName(row.stateCode)} number from ${row.fromTaxYear} removed.`,
    );
    await load();
  } catch (err) {
    notify.error(new Error(errorText(err, "remove", row.stateCode)), "Could not remove it");
  } finally {
    removing.value = null;
  }
}

async function focusNumber() {
  await nextTick();
  document.getElementById("stateIdValue")?.focus();
}

/** "Use a different number" on an IL/NY EIN default line. */
function useDifferent(state: string) {
  stateCode.value = state;
  void focusNumber();
}

/** "Add number" on a still-needed notice: the earliest needed year of that state. */
function addNeeded(n: StateIdNeeded) {
  const years = (list.value?.needed ?? [])
    .filter((x) => x.stateCode === n.stateCode)
    .map((x) => x.taxYear);
  stateCode.value = n.stateCode;
  fromTaxYear.value = Math.min(...years);
  void focusNumber();
}

function neededText(n: StateIdNeeded): string {
  const state = stateName(n.stateCode);
  return n.reason === "tax_withheld"
    ? `Add your ${state} account number. Your ${n.taxYear} W-2s show ${state} tax withheld, and we can't make those W-2s until the number is on file.`
    : `Your ${n.taxYear} W-2s show ${state} wages but no ${state} tax withheld. They'll print without a ${state} account number unless you add one. If ${state} gave you a number, add it below.`;
}

onMounted(load);
onBeforeUnmount(() => {
  typed.value = "";
});
</script>

<template>
  <section class="card stack state-ids">
    <h3>State tax account numbers</h3>
    <p class="muted small" style="margin: 0">
      Your state gives you a withholding account number when you register to withhold state income
      tax. It goes in box 15 of each W-2. Don't use your state unemployment (UI) account number
      here.
    </p>

    <Skeleton v-if="loading && !list" height="6rem" />
    <Message v-else-if="loadError" severity="error" :closable="false">
      We couldn't load your state account numbers.
      <Button label="Try again" text size="small" icon="pi pi-refresh" @click="load" />
    </Message>
    <template v-else-if="list">
      <template v-if="list.needed.length">
        <h4>Still needed</h4>
        <Message
          v-for="n in list.needed"
          :key="`${n.stateCode}:${n.taxYear}`"
          :severity="n.reason === 'tax_withheld' ? 'warn' : 'info'"
          :closable="false"
        >
          {{ neededText(n) }}
          <Button label="Add number" text size="small" @click="addNeeded(n)" />
        </Message>
      </template>

      <div
        v-for="d in list.defaults"
        :key="d.stateCode"
        class="stack"
        style="gap: 0.25rem"
        data-testid="state-id-default"
      >
        <p class="small" style="margin: 0">
          <strong>{{ stateName(d.stateCode) }}:</strong>
          We're using your EIN ({{ d.idMasked }}) as your {{ stateName(d.stateCode) }} account
          number. If {{ stateName(d.stateCode) }} gave you a different number, add it below.
        </p>
        <Button
          label="Use a different number"
          text
          size="small"
          style="align-self: flex-start; padding-left: 0"
          @click="useDifferent(d.stateCode)"
        />
      </div>

      <div v-if="list.stateIds.length" class="table-scroll">
        <DataTable :value="list.stateIds" striped-rows>
          <Column header="State">
            <template #body="{ data }">{{ stateName(data.stateCode) }}</template>
          </Column>
          <Column header="Used for">
            <template #body="{ data }">{{ usedFor(data) }}</template>
          </Column>
          <Column header="Account number">
            <template #body="{ data }">{{ data.idMasked }}</template>
          </Column>
          <Column header="Actions">
            <template #body="{ data }">
              <Button
                icon="pi pi-trash"
                text
                severity="danger"
                :aria-label="`Remove ${stateName(data.stateCode)} number used from ${data.fromTaxYear}`"
                :loading="removing === `${data.stateCode}:${data.fromTaxYear}`"
                @click="askRemove(data)"
              />
            </template>
          </Column>
        </DataTable>
      </div>
      <p v-else class="muted small" style="margin: 0">No state account numbers on file yet.</p>
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
          class="state-id-year"
          :use-grouping="false"
          :min="STATE_ID_MIN_YEAR"
          :max="STATE_ID_MAX_YEAR"
          :invalid="yearMissing"
          :pt="{
            pcInputText: {
              root: {
                'aria-describedby': yearMissing ? 'stateIdYearError stateIdYearHint' : 'stateIdYearHint',
                'aria-invalid': yearMissing ? 'true' : undefined,
              },
            },
          }"
        />
        <Message
          v-if="yearMissing"
          id="stateIdYearError"
          severity="error"
          size="small"
          variant="simple"
          :closable="false"
        >
          Enter a year from 2026 on.
        </Message>
        <small id="stateIdYearHint" class="muted">
          The first year this number goes on your W-2s. Keep 2026 unless your state gave you a new
          number. Then enter the year the new number starts.
        </small>
      </div>
      <div class="field">
        <label for="stateIdValue">Account number</label>
        <InputText
          id="stateIdValue"
          v-model="typed"
          class="state-id-input"
          autocomplete="off"
          spellcheck="false"
          maxlength="64"
          :inputmode="numeric ? 'numeric' : 'text'"
          :invalid="fieldError !== ''"
          :aria-invalid="fieldError !== '' ? 'true' : undefined"
          :aria-describedby="describedBy"
        />
        <Message
          v-if="fieldError"
          id="stateIdValueError"
          severity="error"
          size="small"
          variant="simple"
          :closable="false"
        >
          {{ fieldError }}
        </Message>
        <small v-if="stateHint" id="stateIdValueStateHint" class="muted">{{ stateHint }}</small>
        <small id="stateIdValueHint" class="muted">{{ GENERAL_HINT }}</small>
      </div>
    </div>
    <p v-if="existing" class="small" data-testid="state-id-replaces">
      This replaces your {{ stateName(existing.stateCode) }} number {{ existing.idMasked }} used
      from {{ existing.fromTaxYear }}.
    </p>
    <Message v-if="saveError" severity="error" :closable="false">{{ saveError }}</Message>
    <div class="row">
      <Button
        :label="existing ? 'Replace account number' : 'Save account number'"
        icon="pi pi-save"
        :loading="saving"
        :disabled="!canSave"
        @click="save"
      />
    </div>
  </section>
</template>

<style scoped>
/*
 * Spec 24 (PAY-116) PR-4: no extra heading margin inside the .stack card.
 * Set here, not inline: the heading markup stays "<h3>State tax account
 * numbers</h3>" (the issue copy points to this label; a test reads it).
 */
.state-ids > h3 {
  margin: 0;
}
/*
 * PrimeVue's hover and focus border rules (.p-inputtext:enabled:hover/:focus)
 * outrank .p-inputtext.p-invalid, so an invalid field that has focus or the
 * pointer lost its red border. Keep the invalid colour in every state.
 */
.state-id-input.p-invalid,
.state-id-input.p-invalid:enabled:hover,
.state-id-input.p-invalid:enabled:focus,
.state-id-year :deep(.p-inputtext.p-invalid),
.state-id-year :deep(.p-inputtext.p-invalid:enabled:hover),
.state-id-year :deep(.p-inputtext.p-invalid:enabled:focus) {
  border-color: var(--p-inputtext-invalid-border-color);
}
</style>

<script setup lang="ts">
/**
 * PAY-163 (Spec 25 (PAY-120), step G1): where an employee lives for local
 * income tax. Shows the residence on file (current, upcoming, history) and
 * lets the admin set a new one or correct the current one (same "Since"
 * date). The home address is only a hint: the server sends its state, never
 * the street, and the admin decides.
 */
import { computed, onMounted, ref } from "vue";
import Button from "primevue/button";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import DatePicker from "primevue/datepicker";
import Dialog from "primevue/dialog";
import Message from "primevue/message";
import Select from "primevue/select";
import Skeleton from "primevue/skeleton";
import { localityName, residenceLocalityOptions, STATE_NAMES, stateName } from "@payroll/shared";
import { ApiError, adminPayrollApi, type ResidenceDetail, type ResidenceRow } from "../lib/api";
import { countryName, countryOptions } from "../composables/useCountries";
import { useDates } from "../composables/useDates";
import { useNotify } from "../composables/useNotify";

const props = defineProps<{ employeeId: number; employeeName: string }>();

const { date, toIso, fromIso } = useDates();
const notify = useNotify();

/** Select value for "Somewhere else in New York" (no city tax where they live). */
const ELSEWHERE = "elsewhere";

const detail = ref<ResidenceDetail | null>(null);
const loading = ref(true);
const loadError = ref(false);
const dialog = ref(false);
const busy = ref(false);
const saveError = ref("");
const form = ref({
  country: "US",
  stateCode: "",
  locality: "",
  effectiveFrom: new Date(),
});

const countries = countryOptions();
const stateOptions = Object.entries(STATE_NAMES)
  .map(([code, name]) => ({ label: name, value: code }))
  .sort((a, b) => (a.label < b.label ? -1 : 1));

const todayIso = () => toIso(new Date()) ?? "";

const isUs = computed(() => form.value.country === "US");
const localityOptions = computed(() => {
  if (!isUs.value) return [];
  const options = residenceLocalityOptions(form.value.stateCode).map((o) => ({
    label: o.name,
    value: o.code as string,
  }));
  if (form.value.stateCode === "MD") options.sort((a, b) => (a.label < b.label ? -1 : 1));
  if (form.value.stateCode === "NY") {
    options.push({ label: "Somewhere else in New York", value: ELSEWHERE });
  }
  return options;
});
const localityLabel = computed(() =>
  form.value.stateCode === "MD"
    ? "Which Maryland county do they live in?"
    : "Do they live in New York City or Yonkers?",
);

/** The open row (no end date): a new entry cannot start before it. */
const openRow = computed(() => detail.value?.history.find((r) => r.effectiveTo === null) ?? null);
const minDate = computed(() => fromIso(openRow.value?.effectiveFrom) ?? undefined);

/** The next residence that starts after today, if one is already on file. */
const upcoming = computed<ResidenceRow | null>(() => {
  const today = todayIso();
  const future = (detail.value?.history ?? []).filter((r) => r.effectiveFrom > today);
  return future.at(-1) ?? null; // history is newest first → last is the nearest
});

const hint = computed(() => detail.value?.addressHint ?? null);
/** The address hint's state, when the home address is a US address we could read. */
const hintState = computed(() => (hint.value?.country === "US" ? hint.value.state : null));
const hintAbroad = computed(() => hint.value !== null && hint.value.country !== "US");

function mismatch(stateCode: string | null): boolean {
  return hintState.value !== null && stateCode !== null && stateCode !== hintState.value;
}

const formMismatch = computed(() => isUs.value && mismatch(form.value.stateCode || null));

const canSave = computed(() => {
  if (!/^[A-Z]{2}$/.test(form.value.country)) return false;
  if (!isUs.value) return true;
  if (!form.value.stateCode) return false;
  return localityOptions.value.length === 0 || form.value.locality !== "";
});

function placeLabel(row: {
  country: string;
  stateCode: string | null;
  localityCode: string | null;
}): string {
  if (row.country !== "US") return `Outside the US (${countryName(row.country)})`;
  const state = row.stateCode ? stateName(row.stateCode) : "";
  return row.localityCode ? `${localityName(row.localityCode)}, ${state}` : state;
}

async function load() {
  loading.value = true;
  loadError.value = false;
  try {
    detail.value = await adminPayrollApi.residence(props.employeeId);
  } catch {
    loadError.value = true;
  } finally {
    loading.value = false;
  }
}

function openDialog() {
  const current = detail.value?.current;
  const min = openRow.value?.effectiveFrom;
  const today = todayIso();
  const start = min && min > today ? min : today;
  form.value = {
    country: current?.country ?? "US",
    stateCode: current?.stateCode ?? hintState.value ?? "",
    locality: current?.localityCode ?? "",
    effectiveFrom: fromIso(start) ?? new Date(),
  };
  saveError.value = "";
  dialog.value = true;
}

function onPlaceChange() {
  form.value.locality = "";
}

function saveErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "We couldn't find this employee. Refresh the page.";
    if (err.code === "invalid_effective_from") {
      const since = date(openRow.value?.effectiveFrom);
      return `Pick a “Since” date on or after ${since}. That's when the current entry starts. Picking that same date corrects the current entry.`;
    }
    if (err.code === "invalid_body") {
      return "Something in this form isn't quite right. Check the state and the city or county, then save again.";
    }
  }
  return notify.errorMessage(err);
}

async function save() {
  const effectiveFrom = toIso(form.value.effectiveFrom);
  if (!effectiveFrom || !canSave.value) return;
  const locality = form.value.locality;
  busy.value = true;
  saveError.value = "";
  try {
    await adminPayrollApi.setResidence(props.employeeId, {
      country: form.value.country,
      stateCode: isUs.value ? form.value.stateCode : null,
      localityCode: isUs.value && locality && locality !== ELSEWHERE ? locality : null,
      effectiveFrom,
    });
    notify.success(
      "Saved",
      `We'll use this for ${props.employeeName} from ${date(effectiveFrom)}.`,
    );
    dialog.value = false;
    await load();
  } catch (err) {
    saveError.value = saveErrorMessage(err);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
defineExpose({ load });
</script>

<template>
  <section class="card" style="margin-top: 1rem">
    <div class="row" style="justify-content: space-between">
      <h3 style="margin: 0">Where {{ employeeName }} lives for tax</h3>
      <Button
        :label="detail?.current ? 'Change' : 'Add where they live'"
        size="small"
        icon="pi pi-home"
        :disabled="!detail"
        @click="openDialog"
      />
    </div>
    <p class="muted small">
      Some cities and counties charge their own income tax, and it depends on where your employee
      lives, not only where they work. Use what {{ employeeName }} put on their state withholding
      form (IT-2104 in New York, MW507 in Maryland). If they haven't filled one in, use their home
      address. We ask for everyone, even in states without city tax, so we can spot the people who
      need it.
    </p>

    <Skeleton v-if="loading" height="4rem" />
    <Message v-else-if="loadError" severity="error" :closable="false">
      We couldn't load where {{ employeeName }} lives.
      <Button label="Try again" text size="small" icon="pi pi-refresh" @click="load" />
    </Message>
    <template v-else-if="detail">
      <dl v-if="detail.current" class="kv">
        <dt>Lives in</dt>
        <dd>{{ placeLabel(detail.current) }}</dd>
        <dt>Since</dt>
        <dd>{{ date(detail.current.effectiveFrom) }}</dd>
        <template v-if="upcoming">
          <dt>Moving to</dt>
          <dd>{{ placeLabel(upcoming) }} from {{ date(upcoming.effectiveFrom) }}</dd>
        </template>
      </dl>
      <Message v-else-if="upcoming" severity="info" :closable="false">
        Starting {{ date(upcoming.effectiveFrom) }}, {{ employeeName }} lives in
        {{ placeLabel(upcoming) }}. Until then we don't know where they live.
      </Message>
      <Message v-else severity="warn" :closable="false">
        We don't know where {{ employeeName }} lives yet.
      </Message>
      <p v-if="hintState" class="muted small">
        Their home address on file is in {{ stateName(hintState) }}.
      </p>
      <p v-else-if="hintAbroad" class="muted small">Their home address on file is outside the US.</p>
      <Message
        v-if="detail.current && mismatch(detail.current.stateCode)"
        severity="warn"
        :closable="false"
      >
        This doesn't match the state in their home address. If they've moved, use Change to update
        it.
      </Message>
      <div v-if="detail.history.length > 1 || upcoming" class="table-scroll">
        <DataTable :value="detail.history" striped-rows>
          <Column header="Lives in">
            <template #body="{ data }">{{ placeLabel(data) }}</template>
          </Column>
          <Column header="From">
            <template #body="{ data }">{{ date(data.effectiveFrom) }}</template>
          </Column>
          <Column header="Until">
            <template #body="{ data }">{{ data.effectiveTo ? date(data.effectiveTo) : "now" }}</template>
          </Column>
        </DataTable>
      </div>
    </template>

    <Dialog
      v-model:visible="dialog"
      modal
      :header="`Where ${employeeName} lives for tax`"
      :style="{ width: '32rem' }"
      :breakpoints="{ '575px': '95vw' }"
    >
      <form class="stack" @submit.prevent="save">
        <div class="form-grid">
          <div class="field">
            <label for="resCountry">Country</label>
            <Select
              v-model="form.country"
              input-id="resCountry"
              :options="countries"
              option-label="name"
              option-value="code"
              filter
              @change="onPlaceChange"
            />
          </div>
          <div v-if="isUs" class="field">
            <label for="resState">State</label>
            <Select
              v-model="form.stateCode"
              input-id="resState"
              :options="stateOptions"
              option-label="label"
              option-value="value"
              filter
              placeholder="Choose a state"
              @change="onPlaceChange"
            />
          </div>
          <div v-if="localityOptions.length > 0" class="field">
            <label for="resLocality">{{ localityLabel }}</label>
            <Select
              v-model="form.locality"
              input-id="resLocality"
              :options="localityOptions"
              option-label="label"
              option-value="value"
              filter
              placeholder="Choose one"
            />
            <p v-if="form.stateCode === 'MD'" class="muted small">
              Baltimore City and Baltimore County are different places. Check the address.
            </p>
          </div>
          <div class="field">
            <label for="resSince">Since</label>
            <DatePicker
              v-model="form.effectiveFrom"
              input-id="resSince"
              date-format="d M yy"
              :min-date="minDate"
              required
            />
            <p class="muted small">
              The date they started living there. If you're not sure, use the date they started
              working for you.
            </p>
          </div>
        </div>
        <p v-if="hintState" class="muted small">
          Their home address on file is in {{ stateName(hintState) }}.
        </p>
        <p v-else-if="hintAbroad" class="muted small">
          Their home address on file is outside the US.
        </p>
        <Message v-if="formMismatch" severity="warn" :closable="false">
          This doesn't match the state in their home address. Double-check before you save.
        </Message>
        <Message v-if="saveError" severity="error" :closable="false" role="alert">
          {{ saveError }}
        </Message>
        <div class="row" style="justify-content: flex-end">
          <Button label="Cancel" text severity="secondary" type="button" @click="dialog = false" />
          <Button type="submit" label="Save" icon="pi pi-save" :loading="busy" :disabled="!canSave" />
        </div>
      </form>
    </Dialog>
  </section>
</template>

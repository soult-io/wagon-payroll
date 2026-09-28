<script setup lang="ts">
/**
 * PAY-163 (Spec 25 (PAY-120), step G1): where an employee lives for local
 * income tax. Shows the residence on file (effective-dated history) and lets
 * the admin set a new one. The home address is only a hint: the server sends
 * its state, never the street, and the admin decides.
 */
import { computed, onMounted, ref } from "vue";
import Button from "primevue/button";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import DatePicker from "primevue/datepicker";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import Message from "primevue/message";
import Select from "primevue/select";
import { localityName, residenceLocalityOptions, STATE_NAMES, stateName } from "@payroll/shared";
import { adminPayrollApi, type ResidenceDetail } from "../lib/api";
import { useDates } from "../composables/useDates";
import { useNotify } from "../composables/useNotify";

const props = defineProps<{ employeeId: number; employeeName: string }>();

const { date, toIso } = useDates();
const notify = useNotify();

/** Select value for "Somewhere else in New York" (no city tax where they live). */
const ELSEWHERE = "elsewhere";

const detail = ref<ResidenceDetail | null>(null);
const dialog = ref(false);
const busy = ref(false);
const form = ref({
  country: "US",
  stateCode: "",
  locality: "",
  effectiveFrom: new Date(),
});

const stateOptions = Object.entries(STATE_NAMES)
  .map(([code, name]) => ({ label: name, value: code }))
  .sort((a, b) => (a.label < b.label ? -1 : 1));

const country = computed(() => form.value.country.trim().toUpperCase());
const isUs = computed(() => country.value === "US");
const localityOptions = computed(() => {
  if (!isUs.value) return [];
  const options = residenceLocalityOptions(form.value.stateCode).map((o) => ({
    label: o.name,
    value: o.code as string,
  }));
  if (form.value.stateCode === "NY") {
    options.push({ label: "Somewhere else in New York", value: ELSEWHERE });
  }
  return options;
});

/** The address hint's state, when the home address is a US address we could read. */
const hintState = computed(() => {
  const hint = detail.value?.addressHint;
  return hint && hint.country === "US" ? hint.state : null;
});

function mismatch(stateCode: string | null): boolean {
  return hintState.value !== null && stateCode !== null && stateCode !== hintState.value;
}

const formMismatch = computed(() => isUs.value && mismatch(form.value.stateCode || null));

const canSave = computed(() => {
  if (!/^[A-Z]{2}$/.test(country.value)) return false;
  if (!isUs.value) return true;
  if (!form.value.stateCode) return false;
  return localityOptions.value.length === 0 || form.value.locality !== "";
});

function placeLabel(row: {
  country: string;
  stateCode: string | null;
  localityCode: string | null;
}) {
  if (row.country !== "US") return `Outside the US (${row.country})`;
  const state = row.stateCode ? stateName(row.stateCode) : "";
  return row.localityCode ? `${localityName(row.localityCode)}, ${state}` : state;
}

async function load() {
  try {
    detail.value = await adminPayrollApi.residence(props.employeeId);
  } catch (err) {
    notify.error(err, "Could not load where this employee lives");
  }
}

function openDialog() {
  const current = detail.value?.current;
  form.value = {
    country: current?.country ?? "US",
    stateCode: current?.stateCode ?? hintState.value ?? "",
    locality: current?.localityCode ?? "",
    effectiveFrom: new Date(),
  };
  dialog.value = true;
}

function onStateChange() {
  form.value.locality = "";
}

async function save() {
  const effectiveFrom = toIso(form.value.effectiveFrom);
  if (!effectiveFrom || !canSave.value) return;
  const locality = form.value.locality;
  busy.value = true;
  try {
    await adminPayrollApi.setResidence(props.employeeId, {
      country: country.value,
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
    notify.error(err, "Could not save where they live");
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
        @click="openDialog"
      />
    </div>
    <p class="muted small">
      Some cities and counties charge their own income tax, and it depends on where your employee
      lives, not only where they work. Use what {{ employeeName }} put on their state withholding
      form (IT-2104 in New York, MW507 in Maryland). If they haven't filled one in, use their home
      address.
    </p>
    <template v-if="detail">
      <dl v-if="detail.current" class="kv">
        <dt>Lives in</dt>
        <dd>{{ placeLabel(detail.current) }}</dd>
        <dt>Since</dt>
        <dd>{{ date(detail.current.effectiveFrom) }}</dd>
      </dl>
      <Message v-else severity="warn" :closable="false">
        We don't know where {{ employeeName }} lives yet.
      </Message>
      <p v-if="hintState" class="muted small">
        Their home address on file is in {{ stateName(hintState) }}.
      </p>
      <Message
        v-if="detail.current && mismatch(detail.current.stateCode)"
        severity="warn"
        :closable="false"
      >
        This doesn't match the state in their home address. Double-check it's right.
      </Message>
      <div v-if="detail.history.length > 1" class="table-scroll">
        <DataTable :value="detail.history" striped-rows>
          <Column header="Lived in">
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
    >
      <form class="stack" @submit.prevent="save">
        <div class="form-grid">
          <div class="field">
            <label for="resCountry">Country (2-letter code)</label>
            <InputText id="resCountry" v-model="form.country" maxlength="2" required />
          </div>
          <div v-if="isUs" class="field">
            <label for="resState">State</label>
            <Select
              id="resState"
              v-model="form.stateCode"
              :options="stateOptions"
              option-label="label"
              option-value="value"
              filter
              placeholder="Choose a state"
              @change="onStateChange"
            />
          </div>
          <div v-if="localityOptions.length > 0" class="field">
            <label for="resLocality">City or county</label>
            <Select
              id="resLocality"
              v-model="form.locality"
              :options="localityOptions"
              option-label="label"
              option-value="value"
              filter
              placeholder="Choose one"
            />
          </div>
          <div class="field">
            <label for="resSince">Since</label>
            <DatePicker id="resSince" v-model="form.effectiveFrom" date-format="yy-mm-dd" required />
          </div>
        </div>
        <p v-if="hintState" class="muted small">
          Their home address on file is in {{ stateName(hintState) }}.
        </p>
        <Message v-if="formMismatch" severity="warn" :closable="false">
          This doesn't match the state in their home address. Double-check before you save.
        </Message>
        <div class="row" style="justify-content: flex-end">
          <Button label="Cancel" text severity="secondary" type="button" @click="dialog = false" />
          <Button type="submit" label="Save" icon="pi pi-save" :loading="busy" :disabled="!canSave" />
        </div>
      </form>
    </Dialog>
  </section>
</template>

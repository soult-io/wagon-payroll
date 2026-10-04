<script setup lang="ts">
/**
 * Admin configuration (frontend spec): tax tables (scalars + bracket grid),
 * company pay schedule (+ manual draft generation), company profile.
 *
 * Rates are shown to the admin as percents (6.2) and stored as decimals
 * (0.062) — the server contract is 0–1 numbers.
 */
import { computed, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import Select from "primevue/select";
import InputText from "primevue/inputtext";
import InputNumber from "primevue/inputnumber";
import ToggleSwitch from "primevue/toggleswitch";
import Checkbox from "primevue/checkbox";
import Skeleton from "primevue/skeleton";
import Tabs from "primevue/tabs";
import TabList from "primevue/tablist";
import Tab from "primevue/tab";
import TabPanels from "primevue/tabpanels";
import TabPanel from "primevue/tabpanel";
import PageHeader from "../../components/PageHeader.vue";
import StateTaxAccountNumbers from "../../components/StateTaxAccountNumbers.vue";
import {
  adminPayrollApi,
  adminSettingsApi,
  type Address,
  type CompanyProfile,
  type PaySchedule,
  type StateTaxConfigRow,
  type W2ContactAdmin,
} from "../../lib/api";
import { useNotify } from "../../composables/useNotify";

const notify = useNotify();

// ------------------------------------------------------------------ tax tab
interface ScalarField {
  key: string;
  label: string;
  kind: "money" | "rate";
}
const SCALAR_FIELDS: ScalarField[] = [
  { key: "standardDeduction", label: "Standard deduction", kind: "money" },
  { key: "socialSecurityRate", label: "Social Security rate (EE)", kind: "rate" },
  { key: "socialSecurityWageCap", label: "Social Security wage cap", kind: "money" },
  { key: "medicareRate", label: "Medicare rate (EE)", kind: "rate" },
  { key: "medicareAdditionalRate", label: "Additional Medicare rate", kind: "rate" },
  { key: "medicareAdditionalThreshold", label: "Additional Medicare threshold", kind: "money" },
  { key: "stateWithholdingRate", label: "State withholding rate", kind: "rate" },
  { key: "employerSocialSecurityRate", label: "Social Security rate (ER)", kind: "rate" },
  { key: "employerMedicareRate", label: "Medicare rate (ER)", kind: "rate" },
  { key: "sutaCreditRate", label: "FUTA SUTA credit rate", kind: "rate" },
  { key: "futaWageCap", label: "FUTA wage cap", kind: "money" },
];

interface BracketEdit {
  minAmount: number | null;
  maxAmount: number | null; // null = no cap (top bracket)
  rate: number | null; // percent in the UI
  top: boolean;
}

const taxLoading = ref(true);
const taxSaving = ref(false);
const availableYears = ref<number[]>([]);
const taxYear = ref<number>(new Date().getFullYear());
const scalars = ref<Record<string, number | null>>({});
const brackets = ref<BracketEdit[]>([]);
/** Cache of loaded rows per year so "new year" can copy the previous one. */
const rawByYear = ref<
  Map<
    number,
    {
      config: Record<string, string>;
      brackets: { minAmount: string; maxAmount: string | null; rate: string }[];
    }
  >
>(new Map());

const yearOptions = computed(() => {
  const current = new Date().getFullYear();
  const years = new Set<number>([...availableYears.value, current, current + 1]);
  return [...years].sort((a, b) => b - a).map((y) => ({ label: String(y), value: y }));
});

/**
 * PAY-18: the SUTA credit is what's configured; the net FUTA rate shown on
 * Form 940 line 8 and accrued per paycheck is 6.0% − credit.
 */
const netFutaRate = computed(() => {
  const credit = scalars.value["sutaCreditRate"];
  if (credit === null || credit === undefined || Number.isNaN(credit)) return null;
  return Math.round((6 - credit) * 1000) / 1000;
});

function fillTaxForm(year: number) {
  const raw = rawByYear.value.get(year) ?? rawByYear.value.get(year - 1); // new year: start from previous year's values
  const next: Record<string, number | null> = {};
  for (const f of SCALAR_FIELDS) {
    const v = raw?.config[f.key];
    const n = v === undefined ? null : Number(v);
    next[f.key] = n === null || Number.isNaN(n) ? null : f.kind === "rate" ? n * 100 : n;
  }
  scalars.value = next;
  brackets.value = (raw?.brackets ?? []).map((b) => ({
    minAmount: Number(b.minAmount),
    maxAmount: b.maxAmount === null ? null : Number(b.maxAmount),
    rate: Number(b.rate) * 100,
    top: b.maxAmount === null,
  }));
  if (brackets.value.length === 0) {
    brackets.value = [{ minAmount: 0, maxAmount: null, rate: null, top: true }];
  }
}

async function loadTax() {
  taxLoading.value = true;
  try {
    const { taxConfig, taxBrackets } = await adminPayrollApi.taxConfig({ jurisdiction: "federal" });
    const map = new Map<
      number,
      {
        config: Record<string, string>;
        brackets: { minAmount: string; maxAmount: string | null; rate: string }[];
      }
    >();
    for (const c of taxConfig) {
      map.set(c.taxYear, { config: { ...c } as unknown as Record<string, string>, brackets: [] });
    }
    for (const b of taxBrackets) {
      map
        .get(b.taxYear)
        ?.brackets.push({ minAmount: b.minAmount, maxAmount: b.maxAmount, rate: b.rate });
    }
    rawByYear.value = map;
    availableYears.value = [...map.keys()];
    fillTaxForm(taxYear.value);
  } catch (err) {
    notify.error(err, "Could not load tax tables");
  } finally {
    taxLoading.value = false;
  }
}

function addBracket() {
  brackets.value.push({ minAmount: null, maxAmount: null, rate: null, top: false });
}

function removeBracket(index: number) {
  brackets.value.splice(index, 1);
}

async function saveTax() {
  const config: Record<string, number> = {};
  for (const f of SCALAR_FIELDS) {
    const v = scalars.value[f.key];
    if (v === null || v === undefined || Number.isNaN(v)) {
      notify.info("Missing value", `Fill in “${f.label}” before saving.`);
      return;
    }
    config[f.key] = f.kind === "rate" ? v / 100 : v;
  }
  const rows = brackets.value
    .map((b, i) => ({
      ordinal: i + 1,
      minAmount: b.minAmount,
      maxAmount: b.top ? null : b.maxAmount,
      rate: b.rate === null ? null : b.rate / 100,
    }))
    .filter((b) => b.minAmount !== null && b.rate !== null) as {
    ordinal: number;
    minAmount: number;
    maxAmount: number | null;
    rate: number;
  }[];
  if (rows.length === 0) {
    notify.info("Brackets required", "Add at least one complete bracket row.");
    return;
  }
  taxSaving.value = true;
  try {
    await adminPayrollApi.putTaxConfig({
      jurisdiction: "federal",
      taxYear: taxYear.value,
      config,
      brackets: rows,
    });
    notify.success("Tax tables saved", `Federal ${taxYear.value} rates and brackets updated.`);
    await loadTax();
  } catch (err) {
    notify.error(err, "Could not save tax tables");
  } finally {
    taxSaving.value = false;
  }
}

watch(taxYear, (y) => fillTaxForm(y));

// --------------------------------------------------------- state taxes tab
// PAY-13: per-state config. jurisdiction is the USPS code ('IL') or
// '<state>:<filing_status>' for status-specific sets (CA); the server falls
// back '<state>:<status>' → '<state>' exactly like the federal tables.
interface StateScalarField {
  key: string;
  label: string;
  kind: "money" | "rate" | "int";
}
const STATE_SCALAR_FIELDS: StateScalarField[] = [
  { key: "flatRate", label: "Flat rate (kind=flat)", kind: "rate" },
  { key: "standardDeduction", label: "Standard deduction", kind: "money" },
  { key: "standardDeductionAlt", label: "Standard deduction (alt)", kind: "money" },
  { key: "altMinAllowances", label: "Alt values when allowances ≥", kind: "int" },
  { key: "lowIncomeExemption", label: "Low-income exemption", kind: "money" },
  { key: "lowIncomeExemptionAlt", label: "Low-income exemption (alt)", kind: "money" },
  { key: "allowanceDeduction", label: "Deduction per allowance", kind: "money" },
  { key: "allowanceCredit", label: "Credit per allowance", kind: "money" },
  {
    key: "additionalAllowanceDeduction",
    label: "Deduction per additional allowance",
    kind: "money",
  },
];
const STATE_KIND_OPTIONS = [
  { label: "No income tax (explicit zero — e.g. TX)", value: "none" },
  { label: "Flat rate (e.g. IL)", value: "flat" },
  { label: "Progressive brackets (e.g. CA)", value: "progressive" },
];

const stateLoading = ref(true);
const stateSaving = ref(false);
const stateJurisdictionOptions = ref<string[]>([]);
const stateJurisdiction = ref<string>("IL");
const stateTaxYear = ref<number>(new Date().getFullYear());
const stateKind = ref<"none" | "flat" | "progressive">("flat");
const stateScalars = ref<Record<string, number | null>>({});
const stateBrackets = ref<BracketEdit[]>([]);
const stateNote = ref("");
/** Cache keyed by `${jurisdiction}:${year}`. */
const rawStateByKey = ref<
  Map<
    string,
    {
      config: StateTaxConfigRow;
      brackets: { minAmount: string; maxAmount: string | null; rate: string }[];
    }
  >
>(new Map());

const stateYearOptions = computed(() => {
  const current = new Date().getFullYear();
  const years = new Set<number>([current, current + 1]);
  for (const key of rawStateByKey.value.keys()) years.add(Number(key.split(":").pop()));
  return [...years].sort((a, b) => b - a).map((y) => ({ label: String(y), value: y }));
});

function stateKey(jurisdiction: string, year: number) {
  return `${jurisdiction}:${year}`;
}

/** Map a raw config row's nullable columns to UI scalars (rates → percents; null stays null). */
function stateScalarsFrom(config: StateTaxConfigRow | undefined): Record<string, number | null> {
  const raw = config as unknown as Record<string, string | number | null> | undefined;
  const next: Record<string, number | null> = {};
  for (const f of STATE_SCALAR_FIELDS) {
    const v = raw?.[f.key];
    const n = v === null || v === undefined ? null : Number(v);
    next[f.key] = n === null || Number.isNaN(n) ? null : f.kind === "rate" ? n * 100 : n;
  }
  return next;
}

function fillStateForm(jurisdiction: string, year: number) {
  const raw =
    rawStateByKey.value.get(stateKey(jurisdiction, year)) ??
    rawStateByKey.value.get(stateKey(jurisdiction, year - 1));
  stateKind.value = raw?.config.kind ?? "flat";
  stateScalars.value = stateScalarsFrom(raw?.config);
  stateBrackets.value = (raw?.brackets ?? []).map((b) => ({
    minAmount: Number(b.minAmount),
    maxAmount: b.maxAmount === null ? null : Number(b.maxAmount),
    rate: Number(b.rate) * 100,
    top: b.maxAmount === null,
  }));
  if (stateBrackets.value.length === 0) {
    stateBrackets.value = [{ minAmount: 0, maxAmount: null, rate: null, top: true }];
  }
  stateNote.value = raw?.config.note ?? "";
}

async function loadStateTax() {
  stateLoading.value = true;
  try {
    const { stateTaxConfig, stateTaxBrackets } = await adminPayrollApi.stateTaxConfig();
    const map = new Map<
      string,
      {
        config: StateTaxConfigRow;
        brackets: { minAmount: string; maxAmount: string | null; rate: string }[];
      }
    >();
    for (const c of stateTaxConfig) {
      map.set(stateKey(c.jurisdiction, c.taxYear), { config: c, brackets: [] });
    }
    for (const b of stateTaxBrackets) {
      map
        .get(stateKey(b.jurisdiction, b.taxYear))
        ?.brackets.push({ minAmount: b.minAmount, maxAmount: b.maxAmount, rate: b.rate });
    }
    rawStateByKey.value = map;
    stateJurisdictionOptions.value = [...new Set(stateTaxConfig.map((c) => c.jurisdiction))].sort();
    if (
      stateJurisdictionOptions.value.length > 0 &&
      !stateJurisdictionOptions.value.includes(stateJurisdiction.value)
    ) {
      stateJurisdiction.value = stateJurisdictionOptions.value[0]!;
    }
    fillStateForm(stateJurisdiction.value, stateTaxYear.value);
  } catch (err) {
    notify.error(err, "Could not load state tax tables");
  } finally {
    stateLoading.value = false;
  }
}

function addStateBracket() {
  stateBrackets.value.push({ minAmount: null, maxAmount: null, rate: null, top: false });
}

function removeStateBracket(index: number) {
  stateBrackets.value.splice(index, 1);
}

async function saveStateTax() {
  const jurisdiction = stateJurisdiction.value.trim().toUpperCase();
  if (!/^[A-Z]{2}(:[A-Z_]+)?$/.test(jurisdiction)) {
    notify.info("Invalid jurisdiction", "Use a USPS code like IL, or CA:married_joint.");
    return;
  }
  const config: Record<string, number | string | null> = { kind: stateKind.value };
  for (const f of STATE_SCALAR_FIELDS) {
    const v = stateScalars.value[f.key];
    config[f.key] =
      v === null || v === undefined || Number.isNaN(v) ? null : f.kind === "rate" ? v / 100 : v;
  }
  config.note = stateNote.value;
  const rows = stateBrackets.value
    .map((b, i) => ({
      ordinal: i + 1,
      minAmount: b.minAmount,
      maxAmount: b.top ? null : b.maxAmount,
      rate: b.rate === null ? null : b.rate / 100,
    }))
    .filter((b) => b.minAmount !== null && b.rate !== null) as {
    ordinal: number;
    minAmount: number;
    maxAmount: number | null;
    rate: number;
  }[];
  if (stateKind.value === "progressive" && rows.length === 0) {
    notify.info("Brackets required", "Progressive states need at least one complete bracket row.");
    return;
  }
  stateSaving.value = true;
  try {
    await adminPayrollApi.putStateTaxConfig({
      jurisdiction,
      taxYear: stateTaxYear.value,
      config: config as never,
      brackets: rows,
    });
    notify.success("State tax saved", `${jurisdiction} ${stateTaxYear.value} updated.`);
    await loadStateTax();
  } catch (err) {
    notify.error(err, "Could not save state tax table");
  } finally {
    stateSaving.value = false;
  }
}

watch([stateJurisdiction, stateTaxYear], ([j, y]) => fillStateForm(j, y));

// ------------------------------------------------------------- schedule tab
const scheduleLoading = ref(true);
const scheduleSaving = ref(false);
const schedule = ref<PaySchedule | null>(null);
const schedForm = ref({ draftDayOfMonth: 15, payDayOfMonth: 28, autoDraft: true, active: true });

const genYear = ref<number>(new Date().getFullYear());
const genMonth = ref<number>(new Date().getMonth() + 1);
const generating = ref(false);
const monthOptions = Array.from({ length: 12 }, (_, i) => ({
  label: new Date(2000, i, 1).toLocaleString("en", { month: "long" }),
  value: i + 1,
}));

async function loadSchedule() {
  scheduleLoading.value = true;
  try {
    const { schedules } = await adminPayrollApi.schedules();
    const company = schedules.find((s) => s.employeeId === null) ?? schedules[0] ?? null;
    schedule.value = company;
    if (company) {
      schedForm.value = {
        draftDayOfMonth: company.draftDayOfMonth,
        payDayOfMonth: company.payDayOfMonth,
        autoDraft: company.autoDraft,
        active: company.active,
      };
    }
  } catch (err) {
    notify.error(err, "Could not load pay schedule");
  } finally {
    scheduleLoading.value = false;
  }
}

async function saveSchedule() {
  scheduleSaving.value = true;
  try {
    const { schedule: saved } = await adminPayrollApi.putSchedule({ ...schedForm.value });
    schedule.value = saved;
    notify.success("Pay schedule saved");
  } catch (err) {
    notify.error(err, "Could not save pay schedule");
  } finally {
    scheduleSaving.value = false;
  }
}

async function generateNow() {
  generating.value = true;
  try {
    const { generated, skipped } = await adminPayrollApi.generate({
      year: genYear.value,
      month: genMonth.value,
    });
    notify.success(
      `Drafts generated: ${generated.length}`,
      skipped.length
        ? `Skipped ${skipped.length}: ${skipped.map((s) => `#${s.employeeId} ${s.reason}`).join("; ")}`
        : undefined,
    );
  } catch (err) {
    notify.error(err, "Could not generate drafts");
  } finally {
    generating.value = false;
  }
}

// -------------------------------------------------------------- company tab
const companyLoading = ref(true);
const companySaving = ref(false);
const company = ref<CompanyProfile | null>(null);
const companyForm = ref({
  legalName: "",
  line1: "",
  line2: "",
  city: "",
  state: "",
  zip: "",
  country: "ES",
  // Write-only: blank means "leave unchanged"; the current value is only ever
  // shown masked (spec 11 D19).
  ein: "",
});

async function loadCompany() {
  companyLoading.value = true;
  try {
    const { company: c } = await adminSettingsApi.company();
    company.value = c;
    companyForm.value = {
      legalName: c.legalName,
      line1: c.address?.line1 ?? "",
      line2: c.address?.line2 ?? "",
      city: c.address?.city ?? "",
      state: c.address?.state ?? "",
      zip: c.address?.zip ?? "",
      country: c.address?.country ?? "ES",
      ein: "",
    };
  } catch (err) {
    notify.error(err, "Could not load company profile");
  } finally {
    companyLoading.value = false;
  }
}

async function saveCompany() {
  if (!companyForm.value.legalName.trim()) {
    notify.info("Legal name required");
    return;
  }
  const ein = companyForm.value.ein.trim();
  if (ein && !/^\d{2}-?\d{7}$/.test(ein)) {
    notify.info("Invalid EIN", "Use the IRS format XX-XXXXXXX.");
    return;
  }
  companySaving.value = true;
  try {
    const address: Address = {
      line1: companyForm.value.line1.trim(),
      city: companyForm.value.city.trim(),
      state: companyForm.value.state.trim(),
      zip: companyForm.value.zip.trim(),
      country: companyForm.value.country.trim().toUpperCase(),
      ...(companyForm.value.line2.trim() ? { line2: companyForm.value.line2.trim() } : {}),
    };
    const { company: saved } = await adminSettingsApi.putCompany({
      legalName: companyForm.value.legalName.trim(),
      address,
      ...(ein ? { ein } : {}),
    });
    company.value = saved;
    companyForm.value.ein = "";
    notify.success("Company profile saved");
  } catch (err) {
    notify.error(err, "Could not save company profile");
  } finally {
    companySaving.value = false;
  }
}

// ------------------------------------------- PAY-208: W-2 contact (S10/S11)
const w2ContactLoading = ref(true);
const w2ContactSaving = ref(false);
const w2Contact = ref<W2ContactAdmin | null>(null);
const w2ContactForm = ref({
  name: "",
  phone: "",
  email: "",
  useCompanyAddress: true,
  line1: "",
  line2: "",
  city: "",
  state: "",
  zip: "",
  country: "US",
});
/** F1: the saved W-2 contact is complete and uses the company address. */
const contactUsesCompanyAddress = computed(() => {
  const c = w2Contact.value;
  return Boolean(c?.name && c.phone && c.email && c.mailingAddress === null);
});
/** S11c: one message per invalid field (client-side; the server re-checks). */
const w2ContactErrors = ref<Record<string, string>>({});

async function loadW2Contact() {
  w2ContactLoading.value = true;
  try {
    const { w2Contact: c } = await adminSettingsApi.w2Contact();
    w2Contact.value = c;
    const a = c.mailingAddress;
    w2ContactForm.value = {
      name: c.name ?? "",
      phone: c.phone ?? "",
      email: c.email ?? "",
      useCompanyAddress: a === null,
      line1: a?.line1 ?? "",
      line2: a?.line2 ?? "",
      city: a?.city ?? "",
      state: a?.state ?? "",
      zip: a?.zip ?? "",
      country: a?.country ?? "US",
    };
  } catch (err) {
    notify.error(err, "Could not load the W-2 contact");
  } finally {
    w2ContactLoading.value = false;
  }
}

function w2ContactValidate(): boolean {
  const f = w2ContactForm.value;
  const errors: Record<string, string> = {};
  if (!f.name.trim()) errors.name = "Enter a name or department.";
  const phone = f.phone.trim();
  if (phone.length < 7 || phone.length > 30 || !/^[0-9+().\-\s]+$/.test(phone)) {
    errors.phone = "Enter a phone number using digits, spaces and + ( ) - . only.";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim()) || f.email.trim().length > 254) {
    errors.email = "Enter an email address, like payroll@example.com.";
  }
  if (!f.useCompanyAddress) {
    if (!f.line1.trim() || !f.city.trim() || !f.state.trim() || !f.zip.trim()) {
      errors.address = "Fill in address line 1, city, state and ZIP.";
    }
    if (f.country.trim().length !== 2) errors.address = "Use a two-letter country code.";
  }
  w2ContactErrors.value = errors;
  return Object.keys(errors).length === 0;
}

async function saveW2Contact() {
  if (!w2ContactValidate()) return;
  const f = w2ContactForm.value;
  w2ContactSaving.value = true;
  try {
    const mailingAddress: Address | null = f.useCompanyAddress
      ? null
      : {
          line1: f.line1.trim(),
          city: f.city.trim(),
          state: f.state.trim(),
          zip: f.zip.trim(),
          country: f.country.trim().toUpperCase(),
          ...(f.line2.trim() ? { line2: f.line2.trim() } : {}),
        };
    const out = await adminSettingsApi.putW2Contact({
      name: f.name.trim(),
      phone: f.phone.trim(),
      email: f.email.trim(),
      mailingAddress,
    });
    w2Contact.value = out.w2Contact;
    notify.success(
      out.changed
        ? "W-2 contact saved. Employees who get W-2s online will be emailed the new details."
        : "W-2 contact saved",
    );
  } catch (err) {
    notify.error(err, "Could not save the W-2 contact");
  } finally {
    w2ContactSaving.value = false;
  }
}

onMounted(() => {
  void loadTax();
  void loadStateTax();
  void loadSchedule();
  void loadCompany();
  void loadW2Contact();
});
</script>

<template>
  <div class="page stack">
    <PageHeader title="Configuration" subtitle="Tax tables, the company pay schedule, and the company profile." />

    <Tabs value="tax">
      <TabList>
        <Tab value="tax">Tax tables</Tab>
        <Tab value="state">State taxes</Tab>
        <Tab value="schedule">Pay schedule</Tab>
        <Tab value="company">Company</Tab>
      </TabList>
      <TabPanels>
        <!-- ------------------------------------------------------------ tax -->
        <TabPanel value="tax">
          <section class="card stack">
            <div class="row">
              <div class="field">
                <label for="taxYear">Tax year</label>
                <Select v-model="taxYear" input-id="taxYear" :options="yearOptions" option-label="label" option-value="value" />
              </div>
              <p class="muted small">Jurisdiction: federal · picking a new year pre-fills from the previous one.</p>
            </div>

            <Skeleton v-if="taxLoading" height="16rem" />
            <template v-else>
              <div class="form-grid">
                <div v-for="f in SCALAR_FIELDS" :key="f.key" class="field">
                  <label :for="`sc-${f.key}`">{{ f.label }}</label>
                  <InputNumber
                    v-model="scalars[f.key]"
                    :input-id="`sc-${f.key}`"
                    v-bind="f.kind === 'money'
                      ? { mode: 'currency' as const, currency: 'USD', locale: 'en-US' }
                      : { suffix: ' %', minFractionDigits: 1, maxFractionDigits: 3, max: 100 }"
                  />
                </div>
              </div>
              <p v-if="netFutaRate !== null" class="muted small" style="margin-top: -0.5rem">
                Net FUTA rate = 6.0% statutory − SUTA credit = <strong>{{ netFutaRate }}%</strong>
                (Form 940 line 8 and per-paycheck accrual). Use 0% credit when no state
                unemployment insurance is paid.
              </p>

              <h3>Withholding brackets</h3>
              <div class="table-scroll">
                <table class="bracket-grid">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>From</th>
                      <th>To (blank = no cap)</th>
                      <th>Rate</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(b, i) in brackets" :key="i">
                      <td>{{ i + 1 }}</td>
                      <td>
                        <InputNumber v-model="b.minAmount" mode="currency" currency="USD" locale="en-US" />
                      </td>
                      <td>
                        <div class="row">
                          <InputNumber v-model="b.maxAmount" mode="currency" currency="USD" locale="en-US" :disabled="b.top" />
                          <ToggleSwitch v-model="b.top" title="No cap (top bracket)" />
                        </div>
                      </td>
                      <td>
                        <InputNumber v-model="b.rate" suffix=" %" :min-fraction-digits="1" :max-fraction-digits="3" :max="100" />
                      </td>
                      <td>
                        <Button icon="pi pi-trash" text severity="danger" :disabled="brackets.length <= 1" @click="removeBracket(i)" />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="row">
                <Button label="Add bracket" icon="pi pi-plus" text @click="addBracket" />
                <Button label="Save tax tables" icon="pi pi-save" :loading="taxSaving" @click="saveTax" />
              </div>
            </template>
          </section>
        </TabPanel>

        <!-- ---------------------------------------------------------- state -->
        <TabPanel value="state">
          <section class="card stack">
            <div class="row">
              <div class="field">
                <label for="stateJurisdiction">Jurisdiction</label>
                <Select
                  v-model="stateJurisdiction"
                  input-id="stateJurisdiction"
                  :options="stateJurisdictionOptions"
                  editable
                  placeholder="IL or CA:married_joint"
                />
              </div>
              <div class="field">
                <label for="stateTaxYear">Tax year</label>
                <Select v-model="stateTaxYear" input-id="stateTaxYear" :options="stateYearOptions" option-label="label" option-value="value" />
              </div>
              <div class="field">
                <label for="stateKind">Computation kind</label>
                <Select v-model="stateKind" input-id="stateKind" :options="STATE_KIND_OPTIONS" option-label="label" option-value="value" />
              </div>
            </div>
            <p class="muted small">
              Jurisdiction is the USPS code (IL) or &lt;state&gt;:&lt;filing_status&gt; for status-specific sets
              (CA publishes separate tables); resolution falls back to the bare state code. Fields left blank are
              unused by that state's form. An unconfigured work state fails run generation loudly — use
              “No income tax” for explicit zero-tax states like TX.
            </p>

            <Skeleton v-if="stateLoading" height="16rem" />
            <template v-else>
              <div class="form-grid">
                <div v-for="f in STATE_SCALAR_FIELDS" :key="f.key" class="field">
                  <label :for="`st-${f.key}`">{{ f.label }}</label>
                  <InputNumber
                    v-model="stateScalars[f.key]"
                    :input-id="`st-${f.key}`"
                    v-bind="f.kind === 'money'
                      ? { mode: 'currency' as const, currency: 'USD', locale: 'en-US' }
                      : f.kind === 'rate'
                        ? { suffix: ' %', minFractionDigits: 1, maxFractionDigits: 3, max: 100 }
                        : { useGrouping: false, min: 0, max: 99 }"
                  />
                </div>
                <div class="field">
                  <label for="stateNote">Statutory source note</label>
                  <InputText id="stateNote" v-model="stateNote" placeholder="e.g. EDD 2026 Method B, 26methb.pdf" />
                </div>
              </div>

              <template v-if="stateKind === 'progressive'">
                <h3>Withholding brackets (annual)</h3>
                <div class="table-scroll">
                  <table class="bracket-grid">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>From</th>
                        <th>To (blank = no cap)</th>
                        <th>Rate</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(b, i) in stateBrackets" :key="i">
                        <td>{{ i + 1 }}</td>
                        <td>
                          <InputNumber v-model="b.minAmount" mode="currency" currency="USD" locale="en-US" />
                        </td>
                        <td>
                          <div class="row">
                            <InputNumber v-model="b.maxAmount" mode="currency" currency="USD" locale="en-US" :disabled="b.top" />
                            <ToggleSwitch v-model="b.top" title="No cap (top bracket)" />
                          </div>
                        </td>
                        <td>
                          <InputNumber v-model="b.rate" suffix=" %" :min-fraction-digits="2" :max-fraction-digits="3" :max="100" />
                        </td>
                        <td>
                          <Button icon="pi pi-trash" text severity="danger" :disabled="stateBrackets.length <= 1" @click="removeStateBracket(i)" />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div class="row">
                  <Button label="Add bracket" icon="pi pi-plus" text @click="addStateBracket" />
                </div>
              </template>

              <div class="row">
                <Button label="Save state tax table" icon="pi pi-save" :loading="stateSaving" @click="saveStateTax" />
              </div>
            </template>
          </section>
        </TabPanel>

        <!-- -------------------------------------------------------- schedule -->
        <TabPanel value="schedule">
          <div class="grid-2">
            <section class="card stack">
              <h3>Company pay schedule</h3>
              <Skeleton v-if="scheduleLoading" height="10rem" />
              <template v-else>
                <div class="form-grid">
                  <div class="field">
                    <label for="draftDay">Draft day of month</label>
                    <InputNumber v-model="schedForm.draftDayOfMonth" input-id="draftDay" :min="1" :max="28" />
                  </div>
                  <div class="field">
                    <label for="payDay">Pay day of month</label>
                    <InputNumber v-model="schedForm.payDayOfMonth" input-id="payDay" :min="1" :max="28" />
                  </div>
                  <div class="field">
                    <label for="autoDraft">Auto-draft monthly</label>
                    <ToggleSwitch v-model="schedForm.autoDraft" input-id="autoDraft" />
                  </div>
                  <div class="field">
                    <label for="schedActive">Schedule active</label>
                    <ToggleSwitch v-model="schedForm.active" input-id="schedActive" />
                  </div>
                </div>
                <div class="row">
                  <Button label="Save schedule" icon="pi pi-save" :loading="scheduleSaving" @click="saveSchedule" />
                </div>
              </template>
            </section>

            <section class="card stack">
              <h3>Generate drafts now</h3>
              <p class="muted small">
                Creates draft runs for every active employee with compensation, for the chosen month. Runs that
                already exist or lack data are skipped.
              </p>
              <div class="form-grid">
                <div class="field">
                  <label for="genYear">Year</label>
                  <InputNumber v-model="genYear" input-id="genYear" :use-grouping="false" :min="2020" :max="2100" />
                </div>
                <div class="field">
                  <label for="genMonth">Month</label>
                  <Select v-model="genMonth" input-id="genMonth" :options="monthOptions" option-label="label" option-value="value" />
                </div>
              </div>
              <div class="row">
                <Button label="Generate" icon="pi pi-bolt" :loading="generating" @click="generateNow" />
              </div>
            </section>
          </div>
        </TabPanel>

        <!-- --------------------------------------------------------- company -->
        <TabPanel value="company">
          <section class="card stack">
            <h3>Company profile</h3>
            <Skeleton v-if="companyLoading" height="10rem" />
            <template v-else>
              <div class="form-grid">
                <div class="field">
                  <label for="legalName">Legal name</label>
                  <InputText id="legalName" v-model="companyForm.legalName" />
                </div>
                <div class="field">
                  <label for="ein">EIN</label>
                  <InputText id="ein" v-model="companyForm.ein" placeholder="XX-XXXXXXX" autocomplete="off" />
                  <small class="muted">
                    Current: {{ company?.einMasked ?? "not set" }} — leave blank to keep it. Encrypted at rest;
                    the change is audit-logged with masked values only.
                  </small>
                </div>
                <div class="field">
                  <label for="cLine1">Address line 1</label>
                  <InputText id="cLine1" v-model="companyForm.line1" />
                </div>
                <div class="field">
                  <label for="cLine2">Address line 2</label>
                  <InputText id="cLine2" v-model="companyForm.line2" />
                </div>
                <div class="field">
                  <label for="cCity">City</label>
                  <InputText id="cCity" v-model="companyForm.city" />
                </div>
                <div class="field">
                  <label for="cState">State/Province</label>
                  <InputText id="cState" v-model="companyForm.state" />
                </div>
                <div class="field">
                  <label for="cZip">ZIP/Postal code</label>
                  <InputText id="cZip" v-model="companyForm.zip" />
                </div>
                <div class="field">
                  <label for="cCountry">Country</label>
                  <InputText id="cCountry" v-model="companyForm.country" maxlength="2" />
                </div>
              </div>
              <div class="row" style="flex-wrap: wrap; gap: 0.75rem; align-items: center">
                <Button label="Save company profile" icon="pi pi-save" :loading="companySaving" @click="saveCompany" />
                <!-- PAY-208 F1 ((j)(3)(vii)): the W-2 contact uses this address. -->
                <span v-if="contactUsesCompanyAddress" class="muted small">
                  The W-2 contact uses this address. Saving a change emails the new details to every employee who gets W-2s online.
                </span>
              </div>
            </template>
          </section>
          <!-- PAY-208 (S10/S11): 26 CFR 31.6051-1(j)(3)(v)(A) — the W-2 contact. -->
          <section class="card stack" style="margin-top: 1rem" data-testid="w2-contact">
            <h3>W-2 contact</h3>
            <p class="muted" style="margin: 0">
              Employees use this contact to ask for a paper W-2 or to stop getting W-2s online. It
              appears in the online-W-2 terms and in W-2 emails, so use details someone checks. The
              address must be one where mail actually reaches you. Until you fill this in, employees
              can't choose online W-2s and everyone gets their W-2 on paper.
            </p>
            <Skeleton v-if="w2ContactLoading" height="8rem" />
            <template v-else>
              <div class="form-grid">
                <div class="field">
                  <label for="w2cName">Name or department</label>
                  <InputText
                    id="w2cName"
                    v-model="w2ContactForm.name"
                    placeholder="e.g. Payroll"
                    :invalid="!!w2ContactErrors.name"
                  />
                  <small v-if="w2ContactErrors.name" class="error-text">{{ w2ContactErrors.name }}</small>
                </div>
                <div class="field">
                  <label for="w2cPhone">Phone</label>
                  <InputText
                    id="w2cPhone"
                    v-model="w2ContactForm.phone"
                    type="tel"
                    autocomplete="off"
                    :invalid="!!w2ContactErrors.phone"
                  />
                  <small v-if="w2ContactErrors.phone" class="error-text">{{ w2ContactErrors.phone }}</small>
                </div>
                <div class="field">
                  <label for="w2cEmail">Email</label>
                  <InputText
                    id="w2cEmail"
                    v-model="w2ContactForm.email"
                    type="email"
                    autocomplete="off"
                    :invalid="!!w2ContactErrors.email"
                  />
                  <small v-if="w2ContactErrors.email" class="error-text">{{ w2ContactErrors.email }}</small>
                </div>
              </div>
              <div class="row" style="gap: 0.5rem; align-items: center">
                <Checkbox v-model="w2ContactForm.useCompanyAddress" input-id="w2cUseCompany" binary />
                <label for="w2cUseCompany">Use the company address for mail</label>
              </div>
              <div v-if="!w2ContactForm.useCompanyAddress" class="form-grid">
                <div class="field">
                  <label for="w2cLine1">Address line 1</label>
                  <InputText id="w2cLine1" v-model="w2ContactForm.line1" />
                </div>
                <div class="field">
                  <label for="w2cLine2">Address line 2</label>
                  <InputText id="w2cLine2" v-model="w2ContactForm.line2" />
                </div>
                <div class="field">
                  <label for="w2cCity">City</label>
                  <InputText id="w2cCity" v-model="w2ContactForm.city" />
                </div>
                <div class="field">
                  <label for="w2cState">State/Province</label>
                  <InputText id="w2cState" v-model="w2ContactForm.state" />
                </div>
                <div class="field">
                  <label for="w2cZip">ZIP/Postal code</label>
                  <InputText id="w2cZip" v-model="w2ContactForm.zip" />
                </div>
                <div class="field">
                  <label for="w2cCountry">Country</label>
                  <InputText id="w2cCountry" v-model="w2ContactForm.country" maxlength="2" />
                </div>
              </div>
              <small v-if="w2ContactErrors.address" class="error-text">{{ w2ContactErrors.address }}</small>
              <div class="row" style="flex-wrap: wrap; gap: 0.75rem; align-items: center">
                <Button
                  label="Save W-2 contact"
                  icon="pi pi-save"
                  :loading="w2ContactSaving"
                  @click="saveW2Contact"
                />
                <span v-if="w2Contact?.name" class="muted small">
                  Saving a change emails the new details to every employee who gets W-2s online.
                </span>
              </div>
            </template>
          </section>
          <StateTaxAccountNumbers style="margin-top: 1rem" />
        </TabPanel>
      </TabPanels>
    </Tabs>
  </div>
</template>

<style scoped>
.bracket-grid {
  width: 100%;
  border-collapse: collapse;
}
.bracket-grid th,
.bracket-grid td {
  text-align: left;
  padding: 0.35rem 0.5rem;
  vertical-align: middle;
}
.bracket-grid th {
  font-size: 0.8rem;
  color: var(--p-text-muted-color, #6b7280);
}
</style>

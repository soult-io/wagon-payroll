<script setup lang="ts">
/**
 * Payslip list (frontend spec): issued payslips separated BY YEAR (owner
 * request 2026-08-01) — a year switcher filters the table and scopes the
 * totals line, since YTD figures are meaningless across calendar years.
 * Row navigates to detail.
 *
 * PAY-19: the W-2 card gates downloads on electronic-delivery consent
 * (Pub 1141 §2.4) — disclosures + an affirmative consent button first,
 * download buttons and a withdraw link afterwards.
 *
 * PAY-206: a corrected W-2 is labelled "{year} W-2 (CORRECTED)"; the PDF
 * link always serves the current figures. D9: after a withdrawal, a year
 * already furnished online keeps its download button (row.downloadable)
 * through electronicW2AccessThrough(year); the consent prompt shows only
 * while some year still needs consent.
 *
 * Spec 24 (PAY-116) PR-4: a ready W-2 explains the two-up pages (from
 * W2_TWO_UP_FROM_YEAR) and, when it has more than one form, why (formCount
 * only — never the states).
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import Button from "primevue/button";
import Message from "primevue/message";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import SelectButton from "primevue/selectbutton";
import PageHeader from "../../components/PageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import {
  type MyW2Year,
  myW2Api,
  payslipsApi,
  type PayslipSummary,
  type W2ConsentStatus,
} from "../../lib/api";
import { electronicW2AccessThrough, W2_CARD_HEADING } from "@payroll/shared";
import { myW2NotReadyText } from "../../lib/w2-issues";
import { myMultiW2Text, twoUpHelpText } from "../../lib/w2-filing";
import { useMoney } from "../../composables/useMoney";
import { useDates } from "../../composables/useDates";
import { useNotify } from "../../composables/useNotify";

const route = useRoute();
const router = useRouter();
const { money } = useMoney();
const { date, longDate, dateTime } = useDates();
const notify = useNotify();

const loading = ref(true);
const payslips = ref<PayslipSummary[]>([]);
/** PAY-11: tax years with a downloadable W-2 (empty for contractors). */
const w2Years = ref<MyW2Year[]>([]);
/** PAY-19: electronic-delivery consent (null while unknown / not a W-2 employee). */
const w2Consent = ref<W2ConsentStatus | null>(null);
const consentBusy = ref(false);

/** PAY-206 (R7): "{year} W-2 (CORRECTED)" when the W-2 replaces one with other figures. */
function w2Label(w2: MyW2Year): string {
  return w2.corrected ? `${w2.year} W-2 (CORRECTED)` : `${w2.year} W-2`;
}
/** Spec 24 (PAY-116) PR-4: help under a downloadable W-2 (two-up pages, more than one form). */
function w2HelpLines(w2: MyW2Year): string[] {
  if (!w2.ready) return [];
  return [myMultiW2Text(w2.formCount, w2.year), twoUpHelpText(w2.year, "employee")].filter(
    (t): t is string => t !== null,
  );
}
/** PAY-206 (D9): rows shown above the consent prompt — downloadable without consent. */
const w2Downloadable = computed(() => w2Years.value.filter((w2) => w2.downloadable));
/** PAY-206 (D9): some year is not downloadable and consent would change that. */
const w2NeedsConsent = computed(() => w2Years.value.some((w2) => !w2.downloadable));

// PAY-17: the selected year is mirrored to ?year= so it survives detail → back
// and browser-back. The default (no param) is the newest year with data.
const selectedYear = ref<string>(typeof route.query.year === "string" ? route.query.year : "");

/** Distinct years present, newest first (keyed on the period, not pay date). */
const years = computed(() =>
  [...new Set(payslips.value.map((p) => p.periodStart.slice(0, 4)))].sort().reverse(),
);

const yearPayslips = computed(() =>
  payslips.value.filter((p) => p.periodStart.startsWith(selectedYear.value)),
);

const ytdGross = computed(() => yearPayslips.value.reduce((sum, p) => sum + p.grossPay, 0));
const ytdNet = computed(() => yearPayslips.value.reduce((sum, p) => sum + p.netPay, 0));

function open(event: { data: PayslipSummary }) {
  // Carry the year query onto the detail URL so its back button can restore it.
  void router.push({
    name: "my-payslip-detail",
    params: { publicId: event.data.publicId },
    query: route.query,
  });
}

watch(selectedYear, (year) => {
  const query = { ...route.query };
  if (!year || year === years.value[0]) delete query.year;
  else query.year = year;
  void router.replace({ query });
});

async function giveConsent() {
  consentBusy.value = true;
  try {
    w2Consent.value = await myW2Api.consentGive();
    w2Years.value = (await myW2Api.list()).w2s;
    notify.success("Consent recorded — your W-2s are ready to download.");
  } catch (err) {
    notify.error(err, "Could not record consent");
  } finally {
    consentBusy.value = false;
  }
}

async function withdrawConsent() {
  consentBusy.value = true;
  try {
    w2Consent.value = await myW2Api.consentWithdraw();
    // PAY-206 (D9): which years stay downloadable is decided by the server.
    w2Years.value = (await myW2Api.list()).w2s;
    notify.success("Consent withdrawn — future W-2s will be furnished on paper.");
  } catch (err) {
    notify.error(err, "Could not withdraw consent");
  } finally {
    consentBusy.value = false;
  }
}

onMounted(async () => {
  try {
    const [{ payslips: rows }, { w2s }] = await Promise.all([payslipsApi.list(), myW2Api.list()]);
    payslips.value = rows;
    w2Years.value = w2s;
    if (w2s.length > 0) {
      w2Consent.value = await myW2Api.consent();
    }
    // A ?year= with no payslips falls back to the newest year with data.
    if (!years.value.includes(selectedYear.value)) {
      selectedYear.value = years.value[0] ?? "";
    }
  } catch (err) {
    notify.error(err, "Could not load payslips");
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="page stack">
    <PageHeader title="Payslips" subtitle="Your issued payslips, newest first." />

    <SelectButton
      v-if="years.length > 1"
      v-model="selectedYear"
      :options="years"
      :allow-empty="false"
      aria-label="Payslip year"
    />

    <div class="card table-scroll">
      <DataTable :value="yearPayslips" :loading="loading" striped-rows row-hover @row-click="open">
        <template #empty>
          <EmptyState
            icon="pi pi-file"
            title="No payslips yet"
            body="Issued payslips will appear here after your first payroll run."
          />
        </template>
        <Column header="Period">
          <template #body="{ data }">{{ date(data.periodStart) }} – {{ date(data.periodEnd) }}</template>
        </Column>
        <Column header="Pay date">
          <template #body="{ data }">{{ date(data.payDate) }}</template>
        </Column>
        <Column header="Gross" class="num">
          <template #body="{ data }">{{ money(data.grossPay) }}</template>
        </Column>
        <Column header="Net pay" class="num">
          <template #body="{ data }"><strong>{{ money(data.netPay) }}</strong></template>
        </Column>
      </DataTable>
    </div>

    <p v-if="yearPayslips.length > 0" class="muted small">
      {{ selectedYear }} totals across {{ yearPayslips.length }} payslip(s): gross
      {{ money(ytdGross) }} · net {{ money(ytdNet) }}
    </p>

    <div v-if="w2Years.length > 0" class="card stack">
      <h3 style="margin: 0">{{ W2_CARD_HEADING }}</h3>
      <p class="muted small" style="margin: 0">
        Your annual W-2 for each year you were paid, available from January of the following year.
      </p>

      <!-- PAY-206 (D9): consent withdrawn — years already furnished online stay downloadable. -->
      <template v-if="w2Consent && !w2Consent.consented">
        <div
          v-for="w2 in w2Downloadable"
          :key="w2.year"
          class="row"
          style="justify-content: space-between"
        >
          <span>
            <strong>{{ w2Label(w2) }}</strong>
            <span class="muted small">{{ " · available since " }}{{ date(w2.availableOn) }}</span>
            <span v-if="w2.corrected" class="muted small" style="display: block">
              This replaces any earlier {{ w2.year }} W-2 you may have. Use this one for your tax
              return.
            </span>
            <span
              v-for="line in w2HelpLines(w2)"
              :key="line"
              class="muted small"
              style="display: block; margin-top: 0.25rem"
            >
              {{ line }}
            </span>
            <span v-if="w2Consent.withdrawnAt" class="muted small" style="display: block">
              You turned off online W-2s. You can still download this one until
              {{ longDate(electronicW2AccessThrough(w2.year)) }}.
            </span>
          </span>
          <a :href="myW2Api.pdfUrl(w2.year)" target="_blank" rel="noopener">
            <Button
              label="Download PDF"
              :aria-label="`Download ${w2Label(w2)} PDF`"
              icon="pi pi-download"
              size="small"
              text
            />
          </a>
        </div>

        <!-- PAY-19: consent gate (Pub 1141 §2.4 disclosures before consent). -->
        <template v-if="w2NeedsConsent">
          <ul class="muted small" style="margin: 0; padding-left: 1.25rem">
            <li v-for="(d, i) in w2Consent.disclosures" :key="i">{{ d }}</li>
          </ul>
          <div>
            <Button
              label="I consent to electronic W-2 delivery"
              icon="pi pi-check"
              size="small"
              :loading="consentBusy"
              @click="giveConsent"
            />
          </div>
        </template>
      </template>

      <template v-else-if="w2Consent?.consented">
        <div v-for="w2 in w2Years" :key="w2.year" class="row" style="justify-content: space-between">
          <span>
            <!-- PAY-206: the current figures replace a copy the employee may hold. -->
            <strong>{{ w2Label(w2) }}</strong>
            <span class="muted small">{{ " · available since " }}{{ date(w2.availableOn) }}</span>
            <span v-if="w2.corrected" class="muted small" style="display: block">
              This replaces any earlier {{ w2.year }} W-2 you may have. Use this one for your tax
              return.
            </span>
            <span
              v-for="line in w2HelpLines(w2)"
              :key="line"
              class="muted small"
              style="display: block; margin-top: 0.25rem"
            >
              {{ line }}
            </span>
          </span>
          <a v-if="w2.ready" :href="myW2Api.pdfUrl(w2.year)" target="_blank" rel="noopener">
            <Button
              label="Download PDF"
              :aria-label="`Download ${w2Label(w2)} PDF`"
              icon="pi pi-download"
              size="small"
              text
            />
          </a>
          <!-- PAY-162: not ready (held, or the form is not in the app yet) — no reason given. -->
          <Message v-else severity="info" :closable="false" role="status">
            {{ myW2NotReadyText(w2.year) }}
          </Message>
        </div>
        <p class="muted small" style="margin: 0">
          Receiving W-2s electronically since {{ dateTime(w2Consent.consentedAt) }} ·
          <a href="#" @click.prevent="withdrawConsent">withdraw consent</a>
        </p>
      </template>
    </div>
  </div>
</template>

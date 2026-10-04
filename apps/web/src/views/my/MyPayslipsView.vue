<script setup lang="ts">
/**
 * Payslip list (frontend spec): issued payslips separated BY YEAR (owner
 * request 2026-08-01) — a year switcher filters the table and scopes the
 * totals line, since YTD figures are meaningless across calendar years.
 * Row navigates to detail.
 *
 * PAY-19 / PAY-208: the W-2 card gates downloads on the employee's
 * agreement to get W-2s online (26 CFR 31.6051-1(j); IRS Pub 15-A (2026),
 * "Furnishing Form W-2 to employees electronically"). The terms render in
 * normal body text, fully expanded, then the access check (open the test
 * PDF, type its code), then the agree button. States: W-2 contact missing
 * (S5, no button), agreed to earlier terms (S2 + S3), not agreed or
 * withdrawn (S22 + S-btn), agreed (S26/S27). The card also shows before
 * January for a year still to come (upcomingYear, OD5).
 *
 * PAY-206: a corrected W-2 is labelled "{year} W-2 (CORRECTED)"; the PDF
 * link always serves the current figures. D9: after a withdrawal, a year
 * already furnished online keeps its download button (row.downloadable)
 * through its access window (server-computed accessThrough, N1).
 *
 * Spec 24 (PAY-116) PR-4: a ready W-2 explains the two-up pages (from
 * W2_TWO_UP_FROM_YEAR) and, when it has more than one form, why (formCount
 * only — never the states).
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import Button from "primevue/button";
import ConfirmDialog from "primevue/confirmdialog";
import InputText from "primevue/inputtext";
import Message from "primevue/message";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import SelectButton from "primevue/selectbutton";
import { useConfirm } from "primevue/useconfirm";
import PageHeader from "../../components/PageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import {
  ApiError,
  type MyW2Year,
  myW2Api,
  payslipsApi,
  type PayslipSummary,
  type W2ConsentStatus,
} from "../../lib/api";
import { addressLine, W2_CARD_HEADING } from "@payroll/shared";
import { myW2NotReadyText } from "../../lib/w2-issues";
import { disclosureParts, myMultiW2Text, twoUpHelpText } from "../../lib/w2-filing";
import { useMoney } from "../../composables/useMoney";
import { useDates } from "../../composables/useDates";
import { useNotify } from "../../composables/useNotify";

const route = useRoute();
const router = useRouter();
const { money } = useMoney();
const { date, longDate } = useDates();
const notify = useNotify();
const confirm = useConfirm();

/** The first tax year an agreement must be on the current terms (server: W2_CONSENT_GATE_FROM_TAX_YEAR). */
const GATE_YEAR = 2026;

const loading = ref(true);
const payslips = ref<PayslipSummary[]>([]);
/** PAY-11: tax years with a W-2 (empty for contractors). */
const w2Years = ref<MyW2Year[]>([]);
/** PAY-208 (OD5): the latest paid year whose W-2 is not out yet. */
const upcomingYear = ref<number | null>(null);
/** PAY-19: the agreement status (null while unknown / not a W-2 employee). */
const w2Consent = ref<W2ConsentStatus | null>(null);
const w2ConsentError = ref(false);
const consentBusy = ref(false);
/** D-B: the code the employee typed from the test PDF. */
const accessCode = ref("");
/** S33 / S25a: an inline message above the agree button. */
const agreeError = ref<string | null>(null);
/** S27: the terms stay reachable after agreeing. */
const showAgreedTerms = ref(false);

const showW2Card = computed(() => w2Years.value.length > 0 || upcomingYear.value !== null);
const company = computed(() => w2Consent.value?.companyName || "Your employer");
const contactMissing = computed(() => w2Consent.value !== null && !w2Consent.value.contactReady);
const agreed = computed(() => w2Consent.value?.consented === true);
const outdated = computed(() => w2Consent.value?.outdated === true);
/** The terms + access check + agree button are on the card. */
const showAgreeForm = computed(
  () => w2Consent.value !== null && !contactMissing.value && !agreed.value,
);
const terms = computed(() => (w2Consent.value?.disclosures ?? []).map(disclosureParts));
const contact = computed(() => w2Consent.value?.contact ?? null);

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
/** S23a / S23b: only a year still to come. */
const upcomingText = computed(() => {
  if (upcomingYear.value === null) return null;
  return agreed.value
    ? `Your ${upcomingYear.value} W-2 isn't posted yet. We'll email you when it's ready to download here.`
    : `Your ${upcomingYear.value} W-2 isn't posted yet.`;
});

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

async function reloadW2(): Promise<void> {
  const list = await myW2Api.list();
  w2Years.value = list.w2s;
  upcomingYear.value = list.upcomingYear;
}

async function reloadConsent(): Promise<void> {
  try {
    w2Consent.value = await myW2Api.consent();
    w2ConsentError.value = false;
  } catch {
    w2ConsentError.value = true;
  }
}

async function giveConsent() {
  const consent = w2Consent.value;
  if (!consent || !accessCode.value.trim()) return;
  consentBusy.value = true;
  agreeError.value = null;
  try {
    w2Consent.value = await myW2Api.consentGive({
      disclosureVersion: consent.disclosureVersion,
      accessCode: accessCode.value.trim(),
    });
    accessCode.value = "";
    await reloadW2();
    const anyDownloadable = w2Years.value.some((w2) => w2.downloadable);
    notify.success(
      "You'll get your W-2s online",
      anyDownloadable
        ? "Your W-2s are ready to download below."
        : `We'll email you when your ${upcomingYear.value ?? "next"} W-2 is posted.`,
    );
  } catch (err) {
    const code = err instanceof ApiError ? err.code : "";
    if (code === "access_check_failed") {
      agreeError.value =
        "That code doesn't match the test PDF. Open the test PDF again and type the code you see. Use the code from the most recent test PDF you opened.";
    } else if (code === "disclosure_changed") {
      await reloadConsent();
      agreeError.value =
        "The terms changed while this page was open. Read the updated terms below, then agree again.";
    } else if (code === "w2_contact_missing") {
      await reloadConsent();
      notify.info(
        `${company.value} hasn't finished setting up online W-2s, so it will give you your W-2 on paper.`,
      );
    } else {
      agreeError.value =
        "We couldn't save your choice. Nothing has changed. Check your connection and try again.";
    }
  } finally {
    consentBusy.value = false;
  }
}

function confirmWithdraw() {
  confirm.require({
    group: "w2-withdraw",
    header: "Withdraw your agreement to online W-2s?",
    rejectProps: { label: "Keep getting W-2s online", severity: "secondary", text: true },
    acceptProps: { label: "Withdraw", severity: "danger" },
    accept: () => void withdrawConsent(),
  });
}

async function withdrawConsent() {
  consentBusy.value = true;
  try {
    const out = await myW2Api.consentWithdraw();
    w2Consent.value = out;
    // PAY-206 (D9): which years stay downloadable is decided by the server.
    await reloadW2();
    notify.success(
      "Withdrawal recorded",
      `It took effect today, ${longDate(out.effectiveOn ?? null)}. Your future W-2s will be on paper. A confirmation email is on its way.`,
    );
  } catch (err) {
    notify.error(
      err,
      "We couldn't save your choice. Nothing has changed. Check your connection and try again.",
    );
  } finally {
    consentBusy.value = false;
  }
}

/** Today as a long date (the withdraw dialog). */
const todayLong = computed(() =>
  new Intl.DateTimeFormat("en-US", { day: "numeric", month: "long", year: "numeric" }).format(
    new Date(),
  ),
);

onMounted(async () => {
  try {
    const [{ payslips: rows }, list] = await Promise.all([payslipsApi.list(), myW2Api.list()]);
    payslips.value = rows;
    w2Years.value = list.w2s;
    upcomingYear.value = list.upcomingYear;
    if (showW2Card.value) await reloadConsent();
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

    <div v-if="showW2Card" class="card stack w2-card">
      <h3 style="margin: 0">{{ W2_CARD_HEADING }}</h3>
      <p class="muted small" style="margin: 0">
        Your annual W-2 for each year you were paid, available from January of the following year.
      </p>

      <Message v-if="w2ConsentError" severity="error" :closable="false">
        We couldn't load your W-2 options. Refresh the page to try again.
      </Message>

      <template v-else-if="w2Consent">
        <!-- One row per year whose W-2 is out (January of the next year). -->
        <div v-for="w2 in w2Years" :key="w2.year" class="w2-row">
          <div class="w2-row-text">
            <!-- PAY-206: the current figures replace a copy the employee may hold. -->
            <strong>{{ w2Label(w2) }}</strong>
            <span class="muted small">{{ " · available since " }}{{ date(w2.availableOn) }}</span>
            <span v-if="w2.corrected && w2.downloadable" class="muted small block">
              This replaces any earlier {{ w2.year }} W-2 you may have. Use this one for your tax
              return.
            </span>
            <template v-if="w2.downloadable">
              <span v-for="line in w2HelpLines(w2)" :key="line" class="muted small block">
                {{ line }}
              </span>
              <!-- S7b: withdrawn, still inside the access window ((j)(3)(v)(C), (j)(6)). -->
              <span v-if="!agreed && w2Consent.withdrawnAt" class="muted small block">
                You withdrew your agreement on {{ longDate(w2Consent.withdrawnAt) }}. You can still
                download this W-2 until {{ longDate(w2.accessThrough) }}.
              </span>
            </template>
            <!-- S4 (+ S4b): ready, but this W-2 comes on paper. -->
            <span v-else-if="w2.ready" class="block">
              {{ company }} will give you this W-2 on paper.
              <template v-if="showAgreeForm">To get it online instead, agree to the terms below.</template>
            </span>
          </div>
          <a v-if="w2.downloadable" :href="myW2Api.pdfUrl(w2.year)" target="_blank" rel="noopener">
            <Button
              label="Download PDF"
              :aria-label="`Download ${w2Label(w2)} PDF`"
              icon="pi pi-download"
              size="small"
              text
            />
          </a>
          <!-- PAY-162: not ready (held, or the form is not in the app yet) — no reason given. -->
          <Message v-else-if="!w2.ready" severity="info" :closable="false" role="status">
            {{ myW2NotReadyText(w2.year) }}
          </Message>
        </div>

        <!-- S23a / S23b: a year still to come (OD5). -->
        <p v-if="upcomingText" style="margin: 0">{{ upcomingText }}</p>

        <!-- N5: the agreed state first — "Withdraw my agreement" stays reachable
             even if the W-2 contact is later incomplete. -->
        <!-- Agreed: S26 + S27. -->
        <template v-if="agreed">
          <p class="small" style="margin: 0">
            You agreed to get your W-2s online on {{ longDate(w2Consent.consentedAt) }}. ·
            <a href="#" @click.prevent="confirmWithdraw">Withdraw my agreement</a>
          </p>
          <p class="small" style="margin: 0">
            <a href="#" :aria-expanded="showAgreedTerms" @click.prevent="showAgreedTerms = !showAgreedTerms">
              See the terms you agreed to
            </a>
          </p>
          <ul v-if="showAgreedTerms" class="w2-terms">
            <li v-for="(t, i) in terms" :key="i">
              <strong v-if="t.lead">{{ t.lead }}</strong> {{ t.body }}
              <span v-if="t.details && contact" class="block">
                {{ addressLine(contact.mailingAddress) }} ·
                <a :href="`tel:${contact.phone}`">{{ contact.phone }}</a> ·
                <a :href="`mailto:${contact.email}`">{{ contact.email }}</a>
              </span>
            </li>
          </ul>
        </template>

        <!-- S5 (A6): no W-2 contact — no terms, no button. -->
        <Message v-else-if="contactMissing" severity="info" :closable="false">
          {{ company }} doesn't offer W-2s online yet, so it will give you your W-2 on paper.
        </Message>

        <!-- Not agreed / withdrawn / earlier terms: the terms, the access check, the button. -->
        <template v-else-if="showAgreeForm">
          <!-- S2: outdated — agreed to earlier terms. -->
          <Message v-if="outdated" severity="warn" :closable="false">
            <strong class="block">Please agree to the updated terms</strong>
            {{ company }} has updated the terms for getting your W-2 online. Read them below and agree
            again to keep getting your W-2s here. Until you do, {{ company }} will give you your W-2s
            for {{ GATE_YEAR }} and later on paper. W-2s you already have online stay available.
          </Message>
          <!-- S22 -->
          <p v-else style="margin: 0">
            Want your W-2 online? Read the terms below. If you agree, you can download your W-2 here
            as soon as it's posted. If you don't, {{ company }} will give it to you on paper.
          </p>

          <h4 style="margin: 0">Before you agree</h4>
          <ul class="w2-terms">
            <li v-for="(t, i) in terms" :key="i">
              <strong v-if="t.lead">{{ t.lead }}</strong> {{ t.body }}
              <span v-if="t.details && contact" class="block">
                {{ addressLine(contact.mailingAddress) }} ·
                <a :href="`tel:${contact.phone}`">{{ contact.phone }}</a> ·
                <a :href="`mailto:${contact.email}`">{{ contact.email }}</a>
              </span>
            </li>
          </ul>

          <!-- D-B (S30-S34): show you can open a PDF before agreeing. -->
          <p style="margin: 0">
            Check you can open your W-2: it will be a PDF file. Open the test PDF, then type the code
            you see in it.
          </p>
          <div class="w2-check">
            <!-- A real link styled as a button: keyboard-reachable, opens in a new tab. -->
            <a
              :href="myW2Api.testPdfUrl()"
              target="_blank"
              rel="noopener"
              class="p-button p-component p-button-outlined p-button-sm test-pdf-link"
            >
              <i class="pi pi-file-pdf" aria-hidden="true" />
              <span>Open test PDF</span>
            </a>
            <div class="field">
              <label for="w2AccessCode">Code from the test PDF</label>
              <InputText
                id="w2AccessCode"
                v-model="accessCode"
                autocomplete="off"
                autocapitalize="characters"
                spellcheck="false"
                maxlength="12"
                :invalid="agreeError !== null"
              />
            </div>
          </div>
          <p class="muted" style="margin: 0">
            If you can't open the test PDF, don't agree. {{ company }} will give you your W-2 on paper.
          </p>
          <Message v-if="agreeError" severity="error" :closable="false" role="alert">
            {{ agreeError }}
          </Message>
          <div>
            <Button
              :label="outdated ? 'I agree to the updated terms' : 'I agree to get my W-2s online'"
              icon="pi pi-check"
              size="small"
              :disabled="!accessCode.trim()"
              :loading="consentBusy"
              @click="giveConsent"
            />
          </div>
        </template>
      </template>
    </div>

    <!-- S6: the withdraw dialog — what changes and what does not ((j)(3)(v)(B)/(C)). -->
    <ConfirmDialog group="w2-withdraw" :style="{ width: '32rem' }" :breakpoints="{ '575px': '92vw' }">
      <template #message>
        <div class="stack" style="gap: 0.5rem">
          <span>If you withdraw today, {{ todayLong }}:</span>
          <ul style="margin: 0; padding-left: 1.25rem">
            <li>{{ company }} will give you your W-2s on paper from today on.</li>
            <li>
              W-2s already given to you online don't change. Each one stays here through October 15
              of the year after its tax year.
            </li>
            <li>You'll get a confirmation email with the date it takes effect.</li>
          </ul>
          <span>You can agree again at any time on this page.</span>
        </div>
      </template>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.block {
  display: block;
}
.w2-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: space-between;
  align-items: flex-start;
}
.w2-row-text {
  flex: 1 1 16rem;
  min-width: 0;
}
/* PAY-208: the terms are legal text — normal body size, not muted. */
.w2-terms {
  margin: 0;
  padding-left: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  overflow-wrap: anywhere;
}
.w2-check {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: flex-end;
}
.test-pdf-link {
  gap: 0.5rem;
  text-decoration: none;
}
.w2-check .field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
</style>

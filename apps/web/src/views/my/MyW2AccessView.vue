<script setup lang="ts">
/**
 * PAY-217: the one screen of a former employee (GET /api/me access
 * "w2_only"). 26 CFR 31.6051-1(j)(6): a W-2 given online stays available
 * through October 15 of the next year (or 90 days after a corrected W-2 is
 * posted, when later), even after the job ends. The list holds only the
 * years given online whose window is still open (server-computed); no
 * payslips, profile or consent. A corrected W-2 is posted here too and
 * labelled CORRECTED (the IMPORTANT mail says a paper copy is coming; the
 * footer says how to ask for paper).
 */
import { computed, onMounted, ref } from "vue";
import Message from "primevue/message";
import PageHeader from "../../components/PageHeader.vue";
import { type FormerW2Info, type MyW2Year, myW2Api } from "../../lib/api";
import { addressLine } from "@payroll/shared";
import { myW2NotReadyText } from "../../lib/w2-issues";
import { myMultiW2Text, twoUpHelpText } from "../../lib/w2-filing";
import { useDates } from "../../composables/useDates";
import { useAuthStore } from "../../stores/auth";
import { pinia } from "../../stores/pinia";

const auth = useAuthStore(pinia);
const { longDate } = useDates();

const loading = ref(true);
const loadError = ref(false);
const w2s = ref<MyW2Year[]>([]);
const former = ref<FormerW2Info | null>(null);

const company = computed(() => former.value?.companyName || "your former employer");
const title = computed(() =>
  former.value?.companyName ? `Your W-2s from ${former.value.companyName}` : "Your W-2s",
);
const contact = computed(() => former.value?.contact ?? null);

/** "{year} W-2 (CORRECTED)" when the W-2 replaces one with other figures. */
function w2Label(w2: MyW2Year): string {
  return w2.corrected ? `${w2.year} W-2 (CORRECTED)` : `${w2.year} W-2`;
}
/** Two-up pages and more-than-one-form help, as on the employee W-2 card. */
function w2HelpLines(w2: MyW2Year): string[] {
  if (!w2.ready) return [];
  return [myMultiW2Text(w2.formCount, w2.year), twoUpHelpText(w2.year, "employee")].filter(
    (t): t is string => t !== null,
  );
}

onMounted(async () => {
  try {
    const out = await myW2Api.list();
    w2s.value = out.w2s;
    former.value = out.former ?? null;
  } catch {
    loadError.value = true;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="page">
    <PageHeader :title="title" />

    <div class="card stack">
      <p style="margin: 0">
        Your job with {{ company }} has ended. You can still sign in here to download the W-2s
        {{ company }} gave you online<template v-if="auth.w2AccessThrough"
          >, through {{ longDate(auth.w2AccessThrough) }}</template
        >.
      </p>

      <Message v-if="loadError" severity="error" :closable="false">
        We couldn't load your W-2s. Refresh the page to try again.
      </Message>
      <p v-else-if="loading" class="muted" style="margin: 0">Loading your W-2s…</p>
      <p v-else-if="w2s.length === 0" style="margin: 0">
        There are no W-2s to download here right now.
      </p>

      <div v-for="w2 in w2s" :key="w2.year" class="w2-row">
        <div class="w2-row-text">
          <strong>{{ w2Label(w2) }}</strong>
          <span class="muted small block">
            Available here through {{ longDate(w2.accessThrough) }}.
          </span>
          <span v-if="w2.corrected && w2.downloadable" class="muted small block">
            This replaces any earlier {{ w2.year }} W-2 you may have. Use this one for your tax
            return.
          </span>
          <template v-if="w2.downloadable">
            <span v-for="line in w2HelpLines(w2)" :key="line" class="muted small block">
              {{ line }}
            </span>
          </template>
        </div>
        <!-- A real link styled as a button: keyboard-reachable, opens in a new tab. -->
        <a
          v-if="w2.downloadable"
          :href="myW2Api.pdfUrl(w2.year)"
          target="_blank"
          rel="noopener"
          class="p-button p-component p-button-text p-button-sm download-link"
          :aria-label="`Download ${w2Label(w2)} PDF`"
        >
          <i class="pi pi-download" aria-hidden="true" />
          <span>Download PDF</span>
        </a>
        <Message v-else-if="!w2.ready" severity="info" :closable="false" role="status">
          {{ myW2NotReadyText(w2.year) }}
        </Message>
        <span v-else class="small">
          Your {{ w2.year }} W-2 is being updated and can't be downloaded right now. Check back
          later, or contact {{ company }} if you need it sooner.
        </span>
      </div>

      <p v-if="contact" class="small footer">
        Questions or need a paper copy? Contact {{ contact.name }},
        <a :href="`tel:${contact.phone}`">{{ contact.phone }}</a>,
        <a :href="`mailto:${contact.email}`">{{ contact.email }}</a>
        <template v-if="contact.mailingAddress">, {{ addressLine(contact.mailingAddress) }}</template>.
      </p>
      <p v-else class="small footer">Questions? Contact {{ company }}.</p>
    </div>
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
.download-link {
  gap: 0.5rem;
  text-decoration: none;
}
.footer {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>

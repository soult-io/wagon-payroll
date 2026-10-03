<script setup lang="ts">
/**
 * App shell (spec 7): role-aware nav, pending-requests badge for admins,
 * global Toast + ConfirmDialog (all mutations get feedback).
 *
 * Nav shape: plain employees see their five links flat. Admins see the
 * ADMIN links flat plus a "My payroll" dropdown holding their employee-area
 * links (an admin is not necessarily an employee; the dropdown only appears
 * when a linked employee record exists). This avoids the duplicated
 * Dashboard/Requests/Settings labels of the original side-by-side layout.
 */
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import Button from "primevue/button";
import Badge from "primevue/badge";
import type Menu from "primevue/menu";
import Toast from "primevue/toast";
import ConfirmDialog from "primevue/confirmdialog";
import { PAYSLIPS_NAV_LABEL } from "@payroll/shared";
import { useAuthStore } from "./stores/auth";
import { pinia } from "./stores/pinia";
import { changeRequestsApi } from "./lib/api";
import { useRuntimeConfig } from "./composables/useRuntimeConfig";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore(pinia);
const signedIn = computed(() => Boolean(auth.user));
const pendingCount = ref(0);
/** True when the signed-in user has a linked employee record (admins may not). */
const hasEmployee = computed(() => auth.employeeLoaded && auth.employmentType !== null);
const myMenu = ref<InstanceType<typeof Menu>>();

/**
 * Runtime config (spec 14 + spec 22): appEnv "qa" renders a persistent banner
 * on EVERY page (incl. login) so prod and QA are never confusable in a
 * screenshot; brandName is the product name in the header.
 */
const { appEnv, brandName } = useRuntimeConfig();

/**
 * PAY-8: worker-type-scoped nav — Payslips only for W-2 employees, Invoices
 * only for contractors. Until the employee record has loaded (or if none
 * exists) neither worker-type-bound item renders.
 */
const employeeNav = computed(() => {
  const items = [{ label: "Dashboard", name: "my-dashboard" }];
  if (auth.employmentType === "w2") items.push({ label: PAYSLIPS_NAV_LABEL, name: "my-payslips" });
  if (auth.employmentType === "1099") items.push({ label: "Invoices", name: "my-invoices" });
  items.push(
    { label: "Requests", name: "my-requests" },
    { label: "Profile", name: "my-profile" },
    { label: "Settings", name: "my-settings" },
  );
  return items;
});

const adminNav = [
  { label: "Dashboard", name: "admin-dashboard" },
  { label: "Calendar", name: "admin-calendar" },
  { label: "Payroll", name: "admin-payroll" },
  { label: "Tax deposits", name: "admin-deposits" },
  { label: "Tax filings", name: "admin-filings" },
  { label: "Employees", name: "admin-employees" },
  { label: "Contractors", name: "admin-contractors" },
  { label: "Requests", name: "admin-requests", badge: true },
  { label: "Config", name: "admin-config" },
  { label: "Settings", name: "admin-settings" },
];

/** Employee-area links, shown to admins inside the "My payroll" dropdown. */
const myMenuItems = computed(() =>
  employeeNav.value.map((item) => ({
    label: item.label,
    command: () => void router.push({ name: item.name }),
  })),
);

/** Active-state for the dropdown button when any employee-area route is shown. */
const myRouteActive = computed(() => route.name?.toString().startsWith("my-") ?? false);

function toggleMyMenu(event: Event) {
  myMenu.value?.toggle(event);
}

async function refreshBadge() {
  if (!auth.isAdmin) {
    pendingCount.value = 0;
    return;
  }
  try {
    const { requests } = await changeRequestsApi.list({ status: "pending" });
    pendingCount.value = requests.length;
  } catch {
    // Badge is best-effort; never block navigation on it.
  }
}

/** Probe once per user: employment type drives the scoped nav (PAY-8). */
watch(
  () => auth.user?.id,
  async (id) => {
    if (!id) return;
    await auth.ensureEmployee(true);
  },
  { immediate: true },
);

watch(
  () => [route.fullPath, auth.user?.id],
  () => void refreshBadge(),
  { immediate: true },
);

async function logout() {
  await auth.logout();
  await router.push({ name: "login" });
}
</script>

<template>
  <div class="shell">
    <!-- In-flow block (not fixed/absolute): pushes the topbar down instead of
         overlapping it, so no layout breaks and no duplicated headers. -->
    <div v-if="appEnv === 'qa'" class="qa-banner" role="status">QA — synthetic data</div>
    <header v-if="signedIn" class="topbar">
      <div class="brand-row">
        <RouterLink :to="{ name: 'my-dashboard' }" class="brand">{{ brandName }}</RouterLink>
        <span class="user-chip">
          {{ auth.user?.name }}
          <span v-if="auth.isAdmin" class="role">admin</span>
        </span>
        <Button label="Sign out" size="small" text icon="pi pi-sign-out" @click="logout" />
      </div>
      <nav class="nav">
        <!-- Plain employees: flat employee-area links. -->
        <template v-if="!auth.isAdmin">
          <RouterLink
            v-for="item in employeeNav"
            :key="item.name"
            :to="{ name: item.name }"
            class="nav-link"
          >
            {{ item.label }}
          </RouterLink>
        </template>
        <!-- Admins: admin links flat + employee area under "My payroll". -->
        <template v-else>
          <RouterLink
            v-for="item in adminNav"
            :key="item.name"
            :to="{ name: item.name }"
            class="nav-link admin-link"
          >
            {{ item.label }}
            <Badge
              v-if="item.badge && pendingCount > 0"
              :value="pendingCount"
              severity="warn"
              class="nav-badge"
            />
          </RouterLink>
          <template v-if="hasEmployee">
            <span class="nav-divider" aria-hidden="true" />
            <button
              type="button"
              class="nav-link my-menu-button"
              :class="{ 'router-link-active': myRouteActive }"
              aria-haspopup="true"
              @click="toggleMyMenu"
            >
              My payroll
              <i class="pi pi-chevron-down my-menu-caret" aria-hidden="true" />
            </button>
            <Menu ref="myMenu" :model="myMenuItems" popup />
          </template>
        </template>
      </nav>
    </header>

    <RouterView />
    <Toast position="bottom-right" />
    <ConfirmDialog :style="{ width: '30rem' }" :breakpoints="{ '575px': '92vw' }" />
  </div>
</template>

<style scoped>
.qa-banner {
  background: #b45309; /* amber-700 — unmistakable, not a brand color */
  color: #fff;
  text-align: center;
  font-weight: 700;
  font-size: 0.85rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 0.3rem 1rem;
}
.topbar {
  background: var(--p-surface-card, #fff);
  border-bottom: 1px solid var(--p-surface-border, #e4e4e7);
  padding: 0.5rem 1rem 0;
  position: sticky;
  top: 0;
  z-index: 10;
}
.brand-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.brand {
  font-size: 1.2rem;
  font-weight: 700;
  text-decoration: none;
  color: inherit;
  margin-right: auto;
}
.user-chip {
  font-size: 0.85rem;
  color: var(--p-text-muted-color, #666);
}
.role {
  margin-left: 0.35rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: var(--p-primary-100, #dbe4f5);
  color: var(--p-primary-700, #25458f);
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.nav {
  display: flex;
  gap: 0.25rem;
  overflow-x: auto;
  margin-top: 0.25rem;
}
.nav-link {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.55rem 0.8rem;
  font-size: 0.9rem;
  text-decoration: none;
  color: var(--p-text-muted-color, #666);
  border-bottom: 2px solid transparent;
  white-space: nowrap;
}
.nav-link:hover {
  color: var(--p-text-color, #1b1b1f);
}
.nav-link.router-link-active {
  color: var(--p-primary-color, #3366cc);
  border-bottom-color: var(--p-primary-color, #3366cc);
  font-weight: 600;
}
.admin-link {
  color: var(--p-primary-700, #25458f);
}
.nav-divider {
  align-self: center;
  width: 1px;
  height: 1.25rem;
  background: var(--p-surface-border, #e4e4e7);
  margin: 0 0.35rem;
}
.nav-badge {
  transform: scale(0.85);
}
.my-menu-button {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  font: inherit;
  font-size: 0.9rem;
}
.my-menu-caret {
  font-size: 0.65rem;
}
</style>

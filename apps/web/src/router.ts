import { createRouter, createWebHistory } from "vue-router";
import { pinia } from "./stores/pinia";
import { useAuthStore } from "./stores/auth";
import { FORMER_W2_ROUTE_NAME, formerEmployeeRedirect } from "./lib/former-access";
import LoginView from "./views/LoginView.vue";

/**
 * Route inventory. Auth screens load eagerly
 * (they ARE the entry); every business screen is a lazy chunk (bundle-size
 * discipline: route-level code-splitting).
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    // ------------------------------------------------------------- public
    { path: "/login", name: "login", component: LoginView, meta: { public: true } },
    {
      path: "/accept-invite",
      name: "accept-invite",
      component: () => import("./views/AcceptInviteView.vue"),
      meta: { public: true },
    },
    {
      path: "/reset-password",
      name: "reset-password",
      component: () => import("./views/ResetPasswordView.vue"),
      meta: { public: true },
    },

    // ------------------------------------------------------- employee /my
    { path: "/", redirect: { name: "my-dashboard" } },
    {
      path: "/my/dashboard",
      name: "my-dashboard",
      component: () => import("./views/my/MyDashboardView.vue"),
      meta: { requiresAuth: true },
    },
    {
      path: "/my/payslips",
      name: "my-payslips",
      component: () => import("./views/my/MyPayslipsView.vue"),
      meta: { requiresAuth: true, workerType: "w2" },
    },
    {
      path: "/my/payslips/:publicId",
      name: "my-payslip-detail",
      component: () => import("./views/my/MyPayslipDetailView.vue"),
      meta: { requiresAuth: true, workerType: "w2" },
    },
    {
      path: "/my/invoices",
      name: "my-invoices",
      component: () => import("./views/my/MyInvoicesView.vue"),
      meta: { requiresAuth: true, workerType: "1099" },
    },
    {
      path: "/my/profile",
      name: "my-profile",
      component: () => import("./views/my/MyProfileView.vue"),
      meta: { requiresAuth: true },
    },
    {
      path: "/my/requests",
      name: "my-requests",
      component: () => import("./views/my/MyRequestsView.vue"),
      meta: { requiresAuth: true },
    },
    {
      path: "/my/requests/new",
      name: "my-request-new",
      component: () => import("./views/my/MyRequestNewView.vue"),
      meta: { requiresAuth: true },
    },
    {
      path: "/my/requests/:publicId",
      name: "my-request-detail",
      component: () => import("./views/my/MyRequestDetailView.vue"),
      meta: { requiresAuth: true },
    },
    // PAY-217: a former employee's only screen — the W-2s given online.
    {
      path: "/my/w2",
      name: "my-w2-access",
      component: () => import("./views/my/MyW2AccessView.vue"),
      meta: { requiresAuth: true },
    },
    {
      path: "/my/settings",
      name: "my-settings",
      component: () => import("./views/my/MySettingsView.vue"),
      meta: { requiresAuth: true },
    },

    // --------------------------------------------------------- admin /admin
    {
      path: "/admin/dashboard",
      name: "admin-dashboard",
      component: () => import("./views/admin/AdminDashboardView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/payroll",
      name: "admin-payroll",
      component: () => import("./views/admin/AdminPayrollView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/payroll/:publicId",
      name: "admin-payroll-run",
      component: () => import("./views/admin/AdminPayrollRunView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/deposits",
      name: "admin-deposits",
      component: () => import("./views/admin/AdminDepositsView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/deposits/:id",
      name: "admin-deposit-detail",
      component: () => import("./views/admin/AdminDepositDetailView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/calendar",
      name: "admin-calendar",
      component: () => import("./views/admin/AdminCalendarView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/filings",
      name: "admin-filings",
      component: () => import("./views/admin/AdminFilingsView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/filings/:id",
      name: "admin-filing",
      component: () => import("./views/admin/AdminFilingDetailView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/employees",
      name: "admin-employees",
      component: () => import("./views/admin/AdminEmployeesView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/employees/:employeeId",
      name: "admin-employee-detail",
      component: () => import("./views/admin/AdminEmployeeDetailView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/contractors",
      name: "admin-contractors",
      component: () => import("./views/admin/AdminContractorsView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/contractors/:employeeId",
      name: "admin-contractor-detail",
      component: () => import("./views/admin/AdminContractorDetailView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/requests",
      name: "admin-requests",
      component: () => import("./views/admin/AdminRequestsView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/requests/:publicId",
      name: "admin-request-detail",
      component: () => import("./views/admin/AdminRequestDetailView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/config",
      name: "admin-config",
      component: () => import("./views/admin/AdminConfigView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/settings",
      name: "admin-settings",
      component: () => import("./views/admin/AdminSettingsView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    // Step-2 stub route — user management now lives in /admin/settings.
    { path: "/admin/users", redirect: { name: "admin-settings" } },

    { path: "/:pathMatch(.*)*", redirect: { name: "my-dashboard" } },
  ],
});

// Hard-reload fallback on chunk-load failure
// Vite fires this when module preloading fails after a deploy; the only correct recovery is a reload.
window.addEventListener("vite:preloadError", () => window.location.reload());

// Router error handler for chunk loading failures
let hadChunkLoadError = false;
router.onError((err, to) => {
  // Check if this is a dynamic import / chunk load failure
  if (
    /dynamically imported module|ChunkLoadError|Importing a module script failed|error loading module/i.test(
      err.message,
    )
  ) {
    // Don't loop - guard with a module-level flag or sessionStorage key
    // so the fallback fires at most once per target path
    const errorKey = `chunk-load-error-${to.fullPath}`;
    if (!sessionStorage.getItem(errorKey) && !hadChunkLoadError) {
      sessionStorage.setItem(errorKey, "1");
      hadChunkLoadError = true;
      // Do a full-page navigation to the target (hard load fetches a fresh index.html)
      window.location.assign(to.fullPath);
    }
  }
});

router.beforeEach(async (to) => {
  const auth = useAuthStore(pinia);
  await auth.ensureLoaded();

  if (to.meta.public) {
    // Signed-in users have no business on the login screen.
    if (to.name === "login" && auth.user) return { name: "my-dashboard" };
    return true;
  }
  if (to.meta.requiresAuth && !auth.user) {
    return { name: "login", query: { redirect: to.fullPath } };
  }
  // PAY-217: a former employee reaches the W-2 screen only — checked before
  // anything that calls an API they are refused (ensureEmployee).
  const former = formerEmployeeRedirect(auth.access, to);
  if (former) return former;
  if (to.name === FORMER_W2_ROUTE_NAME && auth.access !== "w2_only") {
    return { name: "my-dashboard" };
  }
  if (to.name === "my-dashboard" && auth.isAdmin) {
    return { name: "admin-dashboard" };
  }
  if (to.meta.requiresAdmin && !auth.isAdmin) {
    return { name: "my-dashboard" };
  }
  return workerTypeRedirect(to.meta.workerType, auth);
});

/**
 * PAY-8: worker-type-bound routes (Payslips = W-2, Invoices = contractors).
 * A direct URL from the wrong type redirects to the dashboard, matching the
 * scoped nav — no empty pages for features that can never apply.
 */
async function workerTypeRedirect(
  workerType: unknown,
  auth: ReturnType<typeof useAuthStore>,
): Promise<true | { name: "my-dashboard" }> {
  if (!workerType) return true;
  await auth.ensureEmployee();
  return auth.employmentType === workerType ? true : { name: "my-dashboard" };
}

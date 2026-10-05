import { createApp } from "vue";
import PrimeVue from "primevue/config";
import Material from "@primeuix/themes/material";
import ToastService from "primevue/toastservice";
import ConfirmationService from "primevue/confirmationservice";
import "primeicons/primeicons.css";
import "./style.css";
import App from "./App.vue";
import { router } from "./router";
import { pinia } from "./stores/pinia";
import { useAuthStore } from "./stores/auth";
import { setSessionExpiredHandler } from "./lib/session-expired";
import { FORMER_W2_ROUTE_NAME, setW2AccessOnlyHandler } from "./lib/former-access";

// PAY-6: any unexpected 401 (expired/revoked session) redirects straight to
// the login page, preserving the current path for post-login return. No-op
// when nobody is signed in (login/onboarding flows keep their local errors).
setSessionExpiredHandler(() => {
  const auth = useAuthStore(pinia);
  if (!auth.user) return;
  auth.user = null;
  const current = router.currentRoute.value;
  if (current.name === "login") return;
  void router.push({ name: "login", query: { redirect: current.fullPath } });
});

// PAY-217: a 403 w2_access_only means the user is a former employee whose
// scope the SPA had not loaded yet — reload the scope and show the W-2 screen.
setW2AccessOnlyHandler(() => {
  const auth = useAuthStore(pinia);
  if (!auth.user || router.currentRoute.value.name === FORMER_W2_ROUTE_NAME) return;
  auth.access = "w2_only";
  void router.push({ name: FORMER_W2_ROUTE_NAME });
});

const app = createApp(App);

app.use(pinia);
app.use(router);
app.use(PrimeVue, {
  // Material design preset (D2). Current PrimeVue 4.x themes live in
  // @primeuix/themes (@primevue/themes is deprecated).
  theme: {
    preset: Material,
  },
});
app.use(ToastService);
app.use(ConfirmationService);

app.mount("#app");

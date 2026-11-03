<script setup lang="ts">
/**
 * Login (spec 7): password step → TOTP challenge, with backup-code fallback.
 * PAY-259: or a passkey, from the "Sign in with a passkey" button or from the
 * email field's suggestions (autofill). A passkey checked with fingerprint,
 * face or device PIN is a full sign-in; no code is asked.
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Password from "primevue/password";
import Message from "primevue/message";
import { authClient } from "../lib/auth-client";
import { useAuthStore } from "../stores/auth";
import { pinia } from "../stores/pinia";
import { canUsePasskeys, useRuntimeConfig } from "../composables/useRuntimeConfig";
import {
  canAutofillPasskeys,
  credentialStatusText,
  type PasskeySignIn,
  signInWithPasskey,
  TOO_MANY_ATTEMPTS,
} from "../lib/sign-in";

/**
 * The server's sign-in challenge lasts 5 minutes; autofill starts a fresh
 * one before then, so a passkey picked from the suggestions later still works.
 */
const AUTOFILL_RESTART_MS = 4 * 60 * 1000;

const route = useRoute();
const router = useRouter();
const auth = useAuthStore(pinia);
const { brandName, loaded } = useRuntimeConfig();

const email = ref("");
const password = ref("");
const code = ref("");
const step = ref<"password" | "totp" | "backup">("password");
const error = ref("");
const info = ref("");
const busy = ref(false);
const passkeyBusy = ref(false);
const passkeysShown = ref(false);
let autofillTimer: ReturnType<typeof setInterval> | undefined;

function destination(): string {
  const redirect = route.query.redirect;
  // Same-origin paths only: "//host" and "/\host" are protocol-relative.
  return typeof redirect === "string" &&
    redirect.startsWith("/") &&
    !redirect.startsWith("//") &&
    !redirect.startsWith("/\\")
    ? redirect
    : "/";
}

async function finish() {
  await auth.refresh();
  await router.push(destination());
}

function clearMessages() {
  error.value = "";
  info.value = "";
}

async function handlePasskeyResult(result: PasskeySignIn) {
  if (result.kind === "signed-in") {
    await finish();
  } else if (result.kind === "cancelled") {
    info.value = result.text;
  } else if (result.kind === "error") {
    error.value = result.text;
  }
}

/**
 * Offer saved passkeys in the email field's suggestions; never awaited by
 * the form. Each call aborts the previous suggestions request (silently).
 */
async function startAutofill() {
  // Never while the button's attempt is open: a new request would abort it.
  if (step.value !== "password" || passkeyBusy.value || !(await canAutofillPasskeys())) return;
  await handlePasskeyResult(await signInWithPasskey(true));
}

async function submitPasskey() {
  clearMessages();
  passkeyBusy.value = true;
  let result: PasskeySignIn;
  try {
    result = await signInWithPasskey();
    await handlePasskeyResult(result);
  } finally {
    passkeyBusy.value = false;
  }
  // The button's attempt aborted the suggestions: offer them again.
  if (result.kind !== "signed-in" && passkeysShown.value) void startAutofill();
}

onMounted(async () => {
  await loaded;
  passkeysShown.value = canUsePasskeys();
  if (!passkeysShown.value) return;
  void startAutofill();
  autofillTimer = setInterval(() => void startAutofill(), AUTOFILL_RESTART_MS);
});

onBeforeUnmount(() => clearInterval(autofillTimer));

async function submitPassword() {
  clearMessages();
  busy.value = true;
  try {
    const { data, error: err } = await authClient.signIn.email({
      email: email.value,
      password: password.value,
    });
    if (err) {
      // 429: password and passkey sign-in share one rate limit, so a
      // throttle must not read as a wrong password.
      error.value = credentialStatusText(err.status) ?? "Invalid email or password.";
      return;
    }
    if (data && (data as { twoFactorRedirect?: boolean }).twoFactorRedirect) {
      step.value = "totp";
      return;
    }
    await finish();
  } finally {
    busy.value = false;
  }
}

async function submitTotp() {
  error.value = "";
  busy.value = true;
  try {
    const { error: err } = await authClient.twoFactor.verifyTotp({ code: code.value });
    if (err) {
      error.value =
        err.status === 429
          ? TOO_MANY_ATTEMPTS
          : "Invalid code — check your authenticator and try again.";
      return;
    }
    await finish();
  } finally {
    busy.value = false;
  }
}

async function submitBackup() {
  error.value = "";
  busy.value = true;
  try {
    const { error: err } = await authClient.$fetch("/backup-code/verify", {
      method: "POST",
      body: { code: code.value },
    });
    if (err) {
      error.value = err.status === 429 ? TOO_MANY_ATTEMPTS : "Invalid or already-used backup code.";
      return;
    }
    await finish();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="auth-card">
    <!-- Product name as plain text, not a heading: "Sign in" stays the card's
         heading (mobile-login.spec.ts finds it by role). -->
    <p class="auth-brand">{{ brandName }}</p>
    <h2>Sign in</h2>

    <form v-if="step === 'password'" @submit.prevent="submitPassword">
      <label for="email">Email</label>
      <!-- "webauthn" must be the last token: it lets the field offer saved passkeys. -->
      <InputText id="email" v-model="email" type="email" required autocomplete="username webauthn" />
      <label for="password">Password</label>
      <Password
        id="password"
        v-model="password"
        :feedback="false"
        toggle-mask
        required
        autocomplete="current-password"
      />
      <Button type="submit" label="Sign in" :loading="busy" />
      <template v-if="passkeysShown">
        <div class="or-divider" aria-hidden="true"><span>or</span></div>
        <Button
          type="button"
          label="Sign in with a passkey"
          icon="pi pi-key"
          severity="secondary"
          outlined
          aria-describedby="passkeyHelp"
          :loading="passkeyBusy"
          @click="submitPasskey"
        />
        <small id="passkeyHelp" class="muted">
          Use your fingerprint, face, or device PIN. No password or code needed.
        </small>
        <span class="visually-hidden" aria-live="polite">
          {{ passkeyBusy ? "Waiting for your device…" : "" }}
        </span>
      </template>
    </form>

    <form v-else-if="step === 'totp'" @submit.prevent="submitTotp">
      <p>Enter the 6-digit code from your authenticator app.</p>
      <label for="totp">Authenticator code</label>
      <InputText id="totp" v-model="code" inputmode="numeric" required autocomplete="one-time-code" />
      <Button type="submit" label="Verify" :loading="busy" />
      <Button
        type="button"
        label="Use a backup code instead"
        link
        @click="((step = 'backup'), (code = ''), (error = ''))"
      />
    </form>

    <form v-else @submit.prevent="submitBackup">
      <p>Enter one of your single-use backup codes (format <code>xxxxx-xxxxx</code>).</p>
      <label for="backup">Backup code</label>
      <InputText id="backup" v-model="code" required />
      <Button type="submit" label="Verify backup code" :loading="busy" />
      <Button
        type="button"
        label="Back to authenticator code"
        link
        @click="((step = 'totp'), (code = ''), (error = ''))"
      />
    </form>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    <Message v-else-if="info" severity="info" :closable="false">{{ info }}</Message>
  </section>
</template>

<style scoped>
.auth-card {
  max-width: 380px;
  margin: 3rem auto;
  /* Phone widths: keep the form off the screen edges (same 1rem gutter as
     .auth-wrap on the invite/reset views — without it every control spans
     edge-to-edge at ≤380px, which read as the "broken mobile login"). */
  padding: 0 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.auth-brand {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
}
.auth-card h2 {
  margin-top: 0;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.or-divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  color: var(--p-text-muted-color);
  font-size: 0.875rem;
}
.or-divider::before,
.or-divider::after {
  content: "";
  flex: 1;
  border-top: 1px solid var(--p-content-border-color);
}
form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
</style>

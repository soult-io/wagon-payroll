<script setup lang="ts">
/**
 * Login (spec 7): password step → TOTP challenge, with backup-code fallback.
 */
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Password from "primevue/password";
import Message from "primevue/message";
import { authClient } from "../lib/auth-client";
import { useAuthStore } from "../stores/auth";
import { pinia } from "../stores/pinia";
import { useRuntimeConfig } from "../composables/useRuntimeConfig";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore(pinia);
const { brandName } = useRuntimeConfig();

const email = ref("");
const password = ref("");
const code = ref("");
const step = ref<"password" | "totp" | "backup">("password");
const error = ref("");
const busy = ref(false);

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

async function submitPassword() {
  error.value = "";
  busy.value = true;
  try {
    const { data, error: err } = await authClient.signIn.email({
      email: email.value,
      password: password.value,
    });
    if (err) {
      error.value =
        err.status === 403
          ? "This account is disabled. Contact your administrator."
          : "Invalid email or password.";
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
      error.value = "Invalid code — check your authenticator and try again.";
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
      error.value = "Invalid or already-used backup code.";
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
      <InputText id="email" v-model="email" type="email" required autocomplete="email" />
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
form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
</style>

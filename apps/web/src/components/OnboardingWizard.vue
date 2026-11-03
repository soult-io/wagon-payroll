<script setup lang="ts">
/**
 * Onboarding wizard (spec 3 + spec 7): token → password → forced TOTP
 * enrollment (QR + manual secret) → backup codes shown once. Used for both
 * invite acceptance and admin-initiated password reset (same server flow).
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Password from "primevue/password";
import Message from "primevue/message";
import QRCode from "qrcode";

const props = defineProps<{ token: string; mode: "invite" | "reset" }>();

const router = useRouter();

type Step = "loading" | "invalid" | "password" | "totp" | "backup-codes";
const step = ref<Step>("loading");
const error = ref("");
const busy = ref(false);

const email = ref("");
const name = ref("");
const password = ref("");
const confirm = ref("");
const totpURI = ref("");
const qrDataUrl = ref("");
const code = ref("");
const backupCodes = ref<string[]>([]);

const title = computed(() =>
  props.mode === "invite" ? "Welcome — set up your account" : "Reset your password",
);

const manualSecret = computed(() => {
  try {
    return new URL(totpURI.value).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
});

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

onMounted(async () => {
  const res = await post("/api/onboarding/verify-token", { token: props.token });
  if (!res.ok) {
    step.value = "invalid";
    return;
  }
  const data = (await res.json()) as { email: string; name: string };
  email.value = data.email;
  name.value = data.name;
  step.value = "password";
});

async function submitPassword() {
  error.value = "";
  if (password.value !== confirm.value) {
    error.value = "Passwords do not match.";
    return;
  }
  busy.value = true;
  try {
    const res = await post("/api/onboarding/set-password", {
      token: props.token,
      password: password.value,
    });
    if (!res.ok) {
      const data = (await res.json()) as { error?: string; message?: string };
      error.value = data.message ?? "Could not set password.";
      return;
    }
    // Move straight into TOTP enrollment.
    const enable = await post("/api/onboarding/totp-enable", { token: props.token });
    if (!enable.ok) {
      error.value = "Could not start authenticator setup.";
      return;
    }
    const data = (await enable.json()) as { totpURI: string };
    totpURI.value = data.totpURI;
    qrDataUrl.value = await QRCode.toDataURL(data.totpURI, { width: 220, margin: 1 });
    step.value = "totp";
  } finally {
    busy.value = false;
  }
}

async function submitTotp() {
  error.value = "";
  busy.value = true;
  try {
    const res = await post("/api/onboarding/totp-verify", {
      token: props.token,
      code: code.value,
    });
    if (!res.ok) {
      error.value = "Invalid code — check your authenticator and try again.";
      return;
    }
    const data = (await res.json()) as { backupCodes: string[] };
    backupCodes.value = data.backupCodes;
    step.value = "backup-codes";
  } finally {
    busy.value = false;
  }
}

async function copyCodes() {
  await navigator.clipboard.writeText(backupCodes.value.join("\n"));
}
</script>

<template>
  <section class="wizard">
    <h2>{{ title }}</h2>

    <Message v-if="step === 'invalid'" severity="error" :closable="false">
      This link is invalid or has expired. Ask your administrator for a new one.
    </Message>

    <p v-else-if="step === 'loading'">Checking your link…</p>

    <template v-else>
      <ol class="steps">
        <li :class="{ active: step === 'password' }">1. Password</li>
        <li :class="{ active: step === 'totp' }">2. Authenticator</li>
        <li :class="{ active: step === 'backup-codes' }">3. Backup codes</li>
      </ol>
      <p class="who">
        Account: <strong>{{ name }}</strong> ({{ email }})
      </p>

      <form v-if="step === 'password'" @submit.prevent="submitPassword">
        <label for="pw">New password (min 12 characters)</label>
        <Password id="pw" v-model="password" toggle-mask required autocomplete="new-password" />
        <label for="pw2">Confirm password</label>
        <Password id="pw2" v-model="confirm" :feedback="false" required autocomplete="new-password" />
        <Button type="submit" label="Set password" :loading="busy" />
      </form>

      <form v-else-if="step === 'totp'" @submit.prevent="submitTotp">
        <p>Scan this QR code with your authenticator app, then enter the 6-digit code.</p>
        <img v-if="qrDataUrl" :src="qrDataUrl" alt="TOTP QR code" class="qr" />
        <details>
          <summary>Can't scan? Enter the secret manually</summary>
          <code class="secret">{{ manualSecret }}</code>
        </details>
        <label for="code">Authenticator code</label>
        <InputText id="code" v-model="code" inputmode="numeric" required autocomplete="one-time-code" />
        <Button type="submit" label="Verify and finish setup" :loading="busy" />
      </form>

      <div v-else-if="step === 'backup-codes'" class="backup">
        <Message severity="warn" :closable="false">
          Save these backup codes now — each works once, and they are never shown again.
        </Message>
        <ol class="codes">
          <li v-for="c in backupCodes" :key="c"><code>{{ c }}</code></li>
        </ol>
        <p class="muted small">
          After you sign in, you can add a passkey in My settings to sign in with your fingerprint, face,
          or device PIN.
        </p>
        <div class="backup-actions">
          <Button label="Copy codes" icon="pi pi-copy" @click="copyCodes" />
          <Button label="Continue to sign in" @click="router.push({ name: 'login' })" />
        </div>
      </div>
    </template>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
  </section>
</template>

<style scoped>
.wizard {
  max-width: 440px;
  margin: 3rem auto;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.steps {
  display: flex;
  gap: 1rem;
  list-style: none;
  padding: 0;
  color: #777;
}
.steps .active {
  color: #111;
  font-weight: 600;
}
.who {
  margin: 0;
}
.qr {
  align-self: center;
}
.secret {
  word-break: break-all;
}
.codes {
  columns: 2;
  padding-left: 1.25rem;
}
.backup-actions {
  display: flex;
  gap: 0.5rem;
}
</style>

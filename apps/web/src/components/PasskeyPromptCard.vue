<script setup lang="ts">
/**
 * PAY-267: the dashboard's one offer to add a passkey (optional; D39). Shown
 * only right after a password + code sign-in, because adding a passkey needs
 * a sign-in within the last 5 minutes: that way "Add a passkey" works at once
 * instead of asking the person to sign in again. Also needs: no passkey yet,
 * a device with a built-in fingerprint/face/PIN unlock, and no "Not now"
 * (30 days) or "Don't ask again" on file. Copy is product-ux-designer's.
 */
import { onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import Button from "primevue/button";
import Message from "primevue/message";
import { AUTH_METHOD } from "@payroll/shared";
import { myApi } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { addErrorText, addPasskey, isCancelled, isNotFresh } from "../lib/passkeys";
import { canUsePasskeys, useRuntimeConfig } from "../composables/useRuntimeConfig";
import { useNotify } from "../composables/useNotify";

/** Shorter than the server's 5-minute window, so the first click still fits. */
const SHOW_WITHIN_MS = 4 * 60 * 1000;

const notify = useNotify();
const visible = ref(false);
const busy = ref(false);
const info = ref("");
const error = ref("");
const notRecent = ref(false);

async function hasPlatformUnlock(): Promise<boolean> {
  try {
    return (
      (await window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.()) === true
    );
  } catch {
    return false;
  }
}

async function justSignedInWithCode(): Promise<boolean> {
  const { data } = await authClient.getSession();
  const session = data?.session as { authMethod?: unknown; createdAt?: unknown } | undefined;
  if (session?.authMethod !== AUTH_METHOD.passwordTotp) return false;
  const signedInAt = new Date(session.createdAt as string | Date).getTime();
  return Date.now() - signedInAt < SHOW_WITHIN_MS;
}

/** Keep keyboard and screen-reader focus on the page when the card goes away. */
function close() {
  visible.value = false;
  const heading = document.querySelector<HTMLElement>(".page-header h2");
  heading?.setAttribute("tabindex", "-1");
  heading?.focus();
}

async function add() {
  info.value = "";
  error.value = "";
  busy.value = true;
  try {
    const { error: failure } = await addPasskey("");
    if (!failure) {
      notify.success("Passkey added. You can use it next time you sign in.");
      close();
    } else if (isNotFresh(failure)) {
      notRecent.value = true;
    } else if (isCancelled(failure)) {
      info.value = "No passkey was added. You can try again whenever you're ready.";
    } else {
      error.value = addErrorText(failure);
    }
  } finally {
    busy.value = false;
  }
}

async function answer(choice: "not_now" | "never") {
  close();
  try {
    await myApi.passkeyPrompt(choice);
    if (choice === "never") {
      notify.info("We won't ask again. You can add a passkey any time in My settings.");
    }
  } catch (err) {
    notify.error(err, "Could not save your choice");
  }
}

onMounted(async () => {
  try {
    await useRuntimeConfig().loaded;
    if (!canUsePasskeys() || !(await hasPlatformUnlock())) return;
    if (!(await justSignedInWithCode())) return;
    visible.value = (await myApi.security()).passkeyPromptDue;
  } catch {
    // An offer, not a task: if anything fails, don't show it.
  }
});
</script>

<template>
  <section v-if="visible" class="card" data-testid="passkey-prompt">
    <h3>Sign in faster with a passkey</h3>
    <p>
      Next time, use your fingerprint, face, or device PIN instead of typing your password and code.
      It's optional, and your password and code keep working.
    </p>
    <p class="muted small">
      Your device will ask you to confirm. Skip this on a shared computer: anyone who can unlock it
      could sign in as you.
    </p>
    <Message v-if="notRecent" severity="info" :closable="false">
      It's been a few minutes since you signed in, so the passkey wasn't added. You can add one in My
      settings. You'll be asked to sign in again first.
      <RouterLink :to="{ name: 'my-settings' }">Go to My settings</RouterLink>
    </Message>
    <Message v-else-if="info" severity="info" :closable="false">{{ info }}</Message>
    <Message v-else-if="error" severity="error" :closable="false">{{ error }}</Message>
    <div class="row prompt-actions">
      <Button v-if="!notRecent" label="Add a passkey" size="small" :loading="busy" @click="add" />
      <Button
        label="Not now"
        severity="secondary"
        outlined
        size="small"
        :disabled="busy"
        @click="answer('not_now')"
      />
      <Button
        label="Don't ask again"
        severity="secondary"
        text
        size="small"
        :disabled="busy"
        @click="answer('never')"
      />
    </div>
  </section>
</template>

<style scoped>
.prompt-actions {
  flex-wrap: wrap;
}
@media (max-width: 575px) {
  .prompt-actions > :first-child {
    flex: 1 0 100%;
  }
  .prompt-actions > :not(:first-child) {
    flex: 1 1 0;
  }
}
</style>

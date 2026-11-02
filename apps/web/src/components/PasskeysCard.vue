<script setup lang="ts">
/**
 * PAY-259 Passkeys card (My settings → Sign-in and security): list, add,
 * rename and remove this user's passkeys. Copy is product-ux-designer's
 * (PR 4). Adding and removing need a sign-in on this session within the last
 * 5 minutes (server SESSION_NOT_FRESH → "sign in again" dialog); a session
 * that signed in with a backup code can never add or remove, so the buttons
 * are disabled with a note instead of leading to that dead end. Removing
 * signs out other devices only when the user ticks the box.
 */
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import Message from "primevue/message";
import { AUTH_METHOD, MAX_PASSKEYS_PER_USER } from "@payroll/shared";
import { authClient } from "../lib/auth-client";
import {
  addErrorText,
  addPasskey,
  isCancelled,
  isNotFresh,
  listPasskeys,
  NAME_NOT_SAVED,
  passkeyLabel,
  passkeyNameError,
  type PasskeyError,
  type PasskeyRow,
  REMOVE_ERROR,
  removePasskey,
  renameErrorText,
  renamePasskey,
} from "../lib/passkeys";
import { canUsePasskeys, useRuntimeConfig } from "../composables/useRuntimeConfig";
import { useNotify } from "../composables/useNotify";
import { useDates } from "../composables/useDates";
import { useAuthStore } from "../stores/auth";

const props = defineProps<{
  /** How the current session signed in (session.authMethod). */
  currentAuthMethod: string | null;
}>();
const emit = defineEmits<{ "sessions-changed": [] }>();

const notify = useNotify();
const router = useRouter();
const auth = useAuthStore();
const { date } = useDates();

const DEVICE_DETAIL =
  "It may still appear on your device. You can delete it there in your password manager or settings.";

// Neither the controls nor the "not available" line until the runtime config is in.
const configReady = ref(false);
void useRuntimeConfig().loaded.finally(() => {
  configReady.value = true;
});
const available = computed(() => canUsePasskeys());
const backupCodeSession = computed(
  () => props.currentAuthMethod === AUTH_METHOD.passwordBackupCode,
);

const passkeys = ref<PasskeyRow[]>([]);
const loading = ref(true);
const loadFailed = ref(false);
const atLimit = computed(() => passkeys.value.length >= MAX_PASSKEYS_PER_USER);

type CardRow = PasskeyRow & { label: string; a11y: string };

/** Accessible name per row; the date is added only where two names collide. */
const rows = computed<CardRow[]>(() => {
  const labelled = passkeys.value.map((p) => ({ ...p, label: passkeyLabel(p) }));
  const counts = new Map<string, number>();
  for (const p of labelled) counts.set(p.label, (counts.get(p.label) ?? 0) + 1);
  return labelled.map((p) => ({
    ...p,
    a11y: (counts.get(p.label) ?? 0) > 1 ? `${p.label}, added ${date(p.createdAt)}` : p.label,
  }));
});

async function load() {
  try {
    const { data, error } = await listPasskeys();
    loadFailed.value = error !== null;
    passkeys.value = data;
  } catch {
    loadFailed.value = true;
  } finally {
    loading.value = false;
  }
}

// ---------------------------------------------------- sign in again
const signInAgain = ref(false);

async function goSignIn() {
  await auth.logout();
  await router.push({ name: "login", query: { redirect: "/my/settings" } });
}

/** True when the refusal was handled by the "sign in again" dialog. */
function handledNotFresh(error: PasskeyError): boolean {
  if (!isNotFresh(error)) return false;
  addOpen.value = false;
  removeOpen.value = false;
  signInAgain.value = true;
  return true;
}

// ---------------------------------------------------- add
const addOpen = ref(false);
const addName = ref("");
const addBusy = ref(false);
const addInfo = ref<string | null>(null);
const addError = ref<string | null>(null);
const addNameError = computed(() => passkeyNameError(addName.value.trim(), false));

function openAdd() {
  addName.value = "";
  addInfo.value = null;
  addError.value = null;
  addOpen.value = true;
}

async function submitAdd() {
  if (addNameError.value) return;
  addBusy.value = true;
  addInfo.value = null;
  addError.value = null;
  try {
    const { error, nameSaveError } = await addPasskey(addName.value.trim());
    if (error) {
      if (isCancelled(error)) {
        addInfo.value = "No passkey was added. You can try again whenever you're ready.";
      } else if (!handledNotFresh(error)) {
        addError.value = addErrorText(error);
      }
      return;
    }
    addOpen.value = false;
    notify.success("Passkey added. You can use it next time you sign in.");
    if (nameSaveError) notify.error(new Error(NAME_NOT_SAVED), "Name not saved");
    await load();
  } finally {
    addBusy.value = false;
  }
}

// ---------------------------------------------------- rename
const renameOpen = ref(false);
const renameTarget = ref<CardRow | null>(null);
const renameName = ref("");
const renameBusy = ref(false);
const renameError = ref<string | null>(null);
const renameNameError = computed(() => passkeyNameError(renameName.value.trim(), true));

function openRename(row: CardRow) {
  renameTarget.value = row;
  renameName.value = row.label;
  renameError.value = null;
  renameOpen.value = true;
}

async function submitRename() {
  if (!renameTarget.value || renameNameError.value) return;
  renameBusy.value = true;
  renameError.value = null;
  try {
    const { error } = await renamePasskey(renameTarget.value.id, renameName.value.trim());
    if (error) {
      renameError.value = renameErrorText(error);
      return;
    }
    renameOpen.value = false;
    notify.success("Passkey renamed.");
    await load();
  } finally {
    renameBusy.value = false;
  }
}

// ---------------------------------------------------- remove
const removeOpen = ref(false);
const removeTarget = ref<CardRow | null>(null);
const signOutOthers = ref(false);
const removeBusy = ref(false);
const removeError = ref<string | null>(null);

function openRemove(row: CardRow) {
  removeTarget.value = row;
  signOutOthers.value = false;
  removeError.value = null;
  removeOpen.value = true;
}

async function submitRemove() {
  if (!removeTarget.value) return;
  removeBusy.value = true;
  removeError.value = null;
  try {
    const { error } = await removePasskey(removeTarget.value.id);
    if (error) {
      if (!handledNotFresh(error)) removeError.value = REMOVE_ERROR;
      return;
    }
    removeOpen.value = false;
    await load();
    if (!signOutOthers.value) {
      notify.success("Passkey removed.");
      return;
    }
    const { error: revokeError } = await authClient.revokeOtherSessions();
    emit("sessions-changed");
    if (revokeError) {
      notify.error(
        new Error(
          'Passkey removed, but we couldn\'t sign out your other devices. Use "Sign out all others" under Active sessions.',
        ),
        "Other devices still signed in",
      );
      return;
    }
    notify.success("Passkey removed. You're signed out on all other devices.");
  } finally {
    removeBusy.value = false;
  }
}

// The runtime config may still be loading when the card mounts.
watch(
  available,
  (yes) => {
    if (yes) void load();
  },
  { immediate: true },
);
</script>

<template>
  <section class="card">
    <div class="row" style="justify-content: space-between">
      <h3 style="margin: 0">Passkeys</h3>
      <Button
        v-if="available"
        label="Add a passkey"
        icon="pi pi-plus"
        size="small"
        :disabled="loading || loadFailed || atLimit || backupCodeSession"
        @click="openAdd"
      />
    </div>
    <template v-if="available">
      <p class="muted small">
        Sign in with your fingerprint, face, or device PIN instead of typing your password and code.
      </p>
      <Message v-if="backupCodeSession" severity="info" :closable="false">
        You signed in with a backup code. To add or remove passkeys, sign out and sign in again with
        your authenticator code or a passkey.
      </Message>
      <p v-if="loading" class="muted small">Loading your passkeys…</p>
      <p v-else-if="loadFailed" class="small">
        We couldn't load your passkeys. Refresh the page to try again.
      </p>
      <p v-else-if="rows.length === 0" class="muted small">You have no passkeys yet.</p>
      <ul v-else class="passkeys">
        <li v-for="row in rows" :key="row.id" data-testid="passkey-row" class="passkey-row">
          <div>
            <strong>{{ row.label }}</strong>
            <p class="muted small">
              {{ row.backedUp ? "Syncs across your devices" : "Only on this device or key" }}
              · Added {{ date(row.createdAt) }}
            </p>
          </div>
          <div class="row">
            <Button
              icon="pi pi-pencil"
              text
              rounded
              :aria-label="`Rename ${row.a11y}`"
              @click="openRename(row)"
            />
            <Button
              icon="pi pi-trash"
              text
              rounded
              severity="danger"
              :aria-label="`Remove ${row.a11y}`"
              :disabled="backupCodeSession"
              @click="openRemove(row)"
            />
          </div>
        </li>
      </ul>
      <p v-if="atLimit" class="muted small">
        You've added the most passkeys allowed ({{ MAX_PASSKEYS_PER_USER }}). Remove one you no longer use to
        add another.
      </p>
    </template>
    <p v-else-if="configReady" class="muted small">
      Passkeys aren't available here. They need an up-to-date browser and a secure (https) web
      address.
    </p>

    <Dialog v-model:visible="addOpen" modal header="Add a passkey" :style="{ width: '30rem' }" :breakpoints="{ '575px': '92vw' }">
      <form class="stack" @submit.prevent="submitAdd">
        <p class="small">
          Your device will ask for your fingerprint, face, or device PIN. That's all you'll need to
          sign in next time.
        </p>
        <div class="field">
          <label for="passkeyName">Name (optional)</label>
          <InputText
            id="passkeyName"
            v-model="addName"
            :invalid="addNameError !== null"
            :aria-describedby="addNameError ? 'passkeyNameHelp passkeyNameError' : 'passkeyNameHelp'"
            autocomplete="off"
          />
          <small id="passkeyNameHelp" class="muted">
            For example "Work laptop" or "My phone". Leave it blank and we'll name it for you.
          </small>
          <small v-if="addNameError" id="passkeyNameError" class="error-text">{{ addNameError }}</small>
        </div>
        <Message v-if="addInfo" severity="info" :closable="false">{{ addInfo }}</Message>
        <Message v-if="addError" severity="error" :closable="false">{{ addError }}</Message>
        <div class="row">
          <Button type="submit" label="Continue" :loading="addBusy" :disabled="addNameError !== null" />
          <Button label="Cancel" severity="secondary" text @click="addOpen = false" />
        </div>
      </form>
    </Dialog>

    <Dialog v-model:visible="renameOpen" modal header="Rename passkey" :style="{ width: '30rem' }" :breakpoints="{ '575px': '92vw' }">
      <form class="stack" @submit.prevent="submitRename">
        <div class="field">
          <label for="passkeyRename">Name</label>
          <InputText
            id="passkeyRename"
            v-model="renameName"
            :invalid="renameNameError !== null"
            :aria-describedby="renameNameError ? 'passkeyRenameHelp passkeyRenameError' : 'passkeyRenameHelp'"
            autocomplete="off"
          />
          <small id="passkeyRenameHelp" class="muted">Pick a name that tells you which device this is.</small>
          <small v-if="renameNameError" id="passkeyRenameError" class="error-text">{{ renameNameError }}</small>
        </div>
        <Message v-if="renameError" severity="error" :closable="false">{{ renameError }}</Message>
        <div class="row">
          <Button type="submit" label="Save" :loading="renameBusy" :disabled="renameNameError !== null" />
          <Button label="Cancel" severity="secondary" text @click="renameOpen = false" />
        </div>
      </form>
    </Dialog>

    <Dialog v-model:visible="removeOpen" modal header="Remove passkey" :style="{ width: '30rem' }" :breakpoints="{ '575px': '92vw' }">
      <div class="stack">
        <p class="small">
          You won't be able to sign in with "{{ removeTarget?.label }}" anymore. You can still sign in
          with your password and authenticator code.
        </p>
        <p class="muted small">{{ DEVICE_DETAIL }}</p>
        <div class="checkbox-field">
          <Checkbox v-model="signOutOthers" input-id="signOutOthers" binary />
          <div>
            <label for="signOutOthers">Also sign me out on all other devices</label>
            <p class="muted small">Choose this if you lost the device or think someone else used it.</p>
          </div>
        </div>
        <Message v-if="removeError" severity="error" :closable="false">{{ removeError }}</Message>
        <div class="row">
          <Button label="Remove passkey" severity="danger" :loading="removeBusy" @click="submitRemove" />
          <Button label="Cancel" severity="secondary" text @click="removeOpen = false" />
        </div>
      </div>
    </Dialog>

    <Dialog v-model:visible="signInAgain" modal header="Sign in again to continue" :style="{ width: '30rem' }" :breakpoints="{ '575px': '92vw' }">
      <p class="small">
        To keep your account safe, adding or removing a passkey needs a sign-in from the last few
        minutes. Sign in with your password and authenticator code, or with a passkey. You'll come
        straight back to this page.
      </p>
      <div class="row">
        <Button label="Sign in again" @click="goSignIn" />
        <Button label="Cancel" severity="secondary" text @click="signInAgain = false" />
      </div>
    </Dialog>
  </section>
</template>

<style scoped>
.passkeys {
  list-style: none;
  margin: 0.75rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.passkey-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}
.passkey-row > div:first-child {
  min-width: 0;
  overflow-wrap: anywhere;
}
.passkey-row p {
  margin: 0.15rem 0 0;
}
.checkbox-field {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
}
.checkbox-field p {
  margin: 0.15rem 0 0;
}
</style>

<script setup lang="ts">
/**
 * My settings (frontend spec): notification toggles, password change,
 * TOTP management (status + backup codes), active sessions list.
 */
import { onMounted, ref } from "vue";
import Button from "primevue/button";
import ToggleSwitch from "primevue/toggleswitch";
import Password from "primevue/password";
import Dialog from "primevue/dialog";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import { useConfirm } from "primevue/useconfirm";
import PageHeader from "../../components/PageHeader.vue";
import StatusChip from "../../components/StatusChip.vue";
import { myApi, type NotificationSetting } from "../../lib/api";
import { authClient } from "../../lib/auth-client";
import { useNotify } from "../../composables/useNotify";
import { useDates } from "../../composables/useDates";

const notify = useNotify();
const confirm = useConfirm();
const { dateTime } = useDates();

// ------------------------------------------------------- notifications
const EVENT_LABELS: Record<string, { label: string; blurb: string }> = {
  payroll_draft_ready: {
    label: "Payroll draft ready",
    blurb: "When a draft payroll run awaits review (admins)",
  },
  payslip_issued: { label: "Payslip issued", blurb: "When a new payslip is available to you" },
  change_request_submitted: {
    label: "Request submitted",
    blurb: "When an employee submits a change request (admins)",
  },
  change_request_approved: {
    label: "Request approved",
    blurb: "When one of your requests is approved",
  },
  change_request_denied: { label: "Request denied", blurb: "When one of your requests is denied" },
  contractor_invoice_reviewed: {
    label: "Invoice reviewed",
    blurb: "When one of your invoices is approved or rejected (contractors)",
  },
  contractor_invoice_paid: {
    label: "Invoice paid",
    blurb: "When a payment is recorded against one of your invoices (contractors)",
  },
  tax_deposit_due: {
    label: "Tax deposit due",
    blurb: "Reminder before a monthly federal tax deposit due date (admins)",
  },
  tax_filing_due: {
    label: "Tax filing due",
    blurb: "Reminder before a quarterly filing due date, e.g. Form 941 (admins)",
  },
  tax_tables_missing: {
    label: "Tax tables not installed",
    blurb: "When the tax tables for a payroll year aren't installed yet (admins)",
  },
};
const settings = ref<(NotificationSetting & { saving?: boolean })[]>([]);
const settingsLoading = ref(true);

async function loadSettings() {
  try {
    const { settings: rows } = await myApi.notificationSettings();
    settings.value = rows;
  } catch (err) {
    notify.error(err, "Could not load notification settings");
  } finally {
    settingsLoading.value = false;
  }
}

async function toggle(row: NotificationSetting & { saving?: boolean }) {
  row.saving = true;
  try {
    await myApi.putNotificationSettings([{ eventType: row.eventType, enabled: row.enabled }]);
    notify.success("Preference saved");
  } catch (err) {
    row.enabled = !row.enabled; // revert on failure
    notify.error(err, "Could not save preference");
  } finally {
    row.saving = false;
  }
}

// ------------------------------------------------------- password change
const currentPassword = ref("");
const newPassword = ref("");
const passwordBusy = ref(false);

async function changePassword() {
  passwordBusy.value = true;
  try {
    const { error: err } = await authClient.changePassword({
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
      revokeOtherSessions: true,
    });
    if (err) {
      notify.error(new Error(err.message ?? "Password change failed"), "Could not change password");
      return;
    }
    notify.success("Password changed", "Other sessions were signed out.");
    currentPassword.value = "";
    newPassword.value = "";
  } finally {
    passwordBusy.value = false;
  }
}

// ------------------------------------------------------- TOTP management
const security = ref<{ twoFactorEnabled: boolean; backupCodesRemaining: number } | null>(null);
const codesDialog = ref(false);
const newCodes = ref<string[]>([]);

async function loadSecurity() {
  try {
    security.value = await myApi.security();
  } catch (err) {
    notify.error(err, "Could not load security info");
  }
}

function regenerateCodes() {
  confirm.require({
    message:
      "Generate 10 new backup codes? All existing codes stop working immediately. The new codes are shown once.",
    header: "Regenerate backup codes",
    icon: "pi pi-exclamation-triangle",
    rejectProps: { label: "Cancel", severity: "secondary", text: true },
    acceptProps: { label: "Regenerate", severity: "danger" },
    accept: async () => {
      try {
        const { backupCodes } = await myApi.regenerateBackupCodes();
        newCodes.value = backupCodes;
        codesDialog.value = true;
        await loadSecurity();
      } catch (err) {
        notify.error(err, "Could not regenerate codes");
      }
    },
  });
}

async function copyCodes() {
  await navigator.clipboard.writeText(newCodes.value.join("\n"));
  notify.success("Codes copied");
}

// ------------------------------------------------------- sessions
interface SessionRow {
  id: string;
  token: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  current?: boolean;
}
const sessions = ref<SessionRow[]>([]);

async function loadSessions() {
  const { data } = await authClient.listSessions();
  sessions.value = ((data as SessionRow[] | null) ?? []) as SessionRow[];
}

function revokeOthers() {
  confirm.require({
    message: "Sign out every other session on this account?",
    header: "Revoke other sessions",
    icon: "pi pi-sign-out",
    rejectProps: { label: "Cancel", severity: "secondary", text: true },
    acceptProps: { label: "Revoke all", severity: "danger" },
    accept: async () => {
      await authClient.revokeOtherSessions();
      notify.success("Other sessions revoked");
      await loadSessions();
    },
  });
}

onMounted(() => {
  void loadSettings();
  void loadSecurity();
  void loadSessions();
});
</script>

<template>
  <div class="page stack">
    <PageHeader title="Settings" />

    <section class="card">
      <h3>Email notifications</h3>
      <p class="muted small">Security emails (invites, resets, new-device alerts) are always on.</p>
      <div v-if="!settingsLoading" class="settings-list">
        <div v-for="row in settings" :key="row.eventType" class="setting-row">
          <div>
            <strong>{{ EVENT_LABELS[row.eventType]?.label ?? row.eventType }}</strong>
            <p class="muted small">{{ EVENT_LABELS[row.eventType]?.blurb }}</p>
          </div>
          <ToggleSwitch v-model="row.enabled" :disabled="row.saving" @update:model-value="() => toggle(row)" />
        </div>
      </div>
    </section>

    <div class="grid-2">
      <section class="card">
        <h3>Change password</h3>
        <form class="stack" @submit.prevent="changePassword">
          <div class="field">
            <label for="currentPassword">Current password</label>
            <Password id="currentPassword" v-model="currentPassword" :feedback="false" toggle-mask required autocomplete="current-password" />
          </div>
          <div class="field">
            <label for="newPassword">New password (min 12 characters)</label>
            <Password id="newPassword" v-model="newPassword" toggle-mask required autocomplete="new-password" />
          </div>
          <Button
            type="submit"
            label="Change password"
            :loading="passwordBusy"
            :disabled="currentPassword.length === 0 || newPassword.length < 12"
          />
        </form>
      </section>

      <section class="card">
        <h3>Two-factor authentication</h3>
        <div class="row" style="margin-bottom: 0.75rem">
          <StatusChip :status="security?.twoFactorEnabled ? 'active' : 'pending'" />
          <span class="muted small">
            {{ security?.backupCodesRemaining ?? "…" }} backup codes remaining
          </span>
        </div>
        <p class="muted small">
          Re-enrolling your authenticator app happens through an admin-initiated reset (it wipes the old
          enrollment). You can regenerate backup codes yourself at any time.
        </p>
        <Button label="Regenerate backup codes" severity="secondary" icon="pi pi-refresh" @click="regenerateCodes" />
      </section>
    </div>

    <section class="card">
      <div class="row" style="justify-content: space-between">
        <h3 style="margin: 0">Active sessions</h3>
        <Button label="Sign out all others" size="small" text severity="danger" @click="revokeOthers" />
      </div>
      <div class="table-scroll">
        <DataTable :value="sessions" striped-rows>
          <Column header="Created">
            <template #body="{ data }">{{ dateTime(data.createdAt) }}</template>
          </Column>
          <Column header="Expires">
            <template #body="{ data }">{{ dateTime(data.expiresAt) }}</template>
          </Column>
          <Column header="IP">
            <template #body="{ data }">{{ data.ipAddress ?? "—" }}</template>
          </Column>
          <Column header="Device">
            <template #body="{ data }">
              <span class="small">{{ data.userAgent?.slice(0, 60) ?? "—" }}</span>
            </template>
          </Column>
        </DataTable>
      </div>
    </section>

    <Dialog v-model:visible="codesDialog" modal header="Your new backup codes" :style="{ width: '32rem' }">
      <p class="muted small">Each code works once. Store them somewhere safe — they are never shown again.</p>
      <ol class="codes">
        <li v-for="c in newCodes" :key="c"><code>{{ c }}</code></li>
      </ol>
      <div class="row">
        <Button label="Copy codes" icon="pi pi-copy" @click="copyCodes" />
        <Button label="Done" severity="secondary" @click="codesDialog = false" />
      </div>
    </Dialog>
  </div>
</template>

<style scoped>
.settings-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}
.setting-row p {
  margin: 0.15rem 0 0;
}
.codes {
  columns: 2;
  padding-left: 1.25rem;
}
</style>

<script setup lang="ts">
/**
 * Admin settings (frontend spec): email/SMTP status + test send, outbox
 * health, auth-event and audit-event viewers (paginated), and user
 * management (invite / reset / unlock).
 */
import { onMounted, ref } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Skeleton from "primevue/skeleton";
import Tabs from "primevue/tabs";
import TabList from "primevue/tablist";
import Tab from "primevue/tab";
import TabPanels from "primevue/tabpanels";
import TabPanel from "primevue/tabpanel";
import { useConfirm } from "primevue/useconfirm";
import Tag from "primevue/tag";
import PageHeader from "../../components/PageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import {
  adminNotificationsApi,
  adminSettingsApi,
  adminUsersApi,
  type AuditEventRow,
  type AuthEventRow,
  type OutboxHealth,
} from "../../lib/api";
import { authClient } from "../../lib/auth-client";
import { useDates } from "../../composables/useDates";
import { useNotify } from "../../composables/useNotify";

const confirm = useConfirm();
const { dateTime } = useDates();
const notify = useNotify();

// -------------------------------------------------------------- email/outbox
const outboxLoading = ref(true);
const outbox = ref<OutboxHealth | null>(null);
const testing = ref(false);

async function loadOutbox() {
  outboxLoading.value = true;
  try {
    outbox.value = await adminNotificationsApi.outbox();
  } catch (err) {
    notify.error(err, "Could not load outbox");
  } finally {
    outboxLoading.value = false;
  }
}

async function sendTest() {
  testing.value = true;
  try {
    const res = await adminNotificationsApi.testEmail();
    notify.success(
      res.queued ? "Test email queued" : "Test email recorded",
      outbox.value?.emailMode === "log"
        ? "SMTP is not configured — it was written to the outbox/log only."
        : undefined,
    );
    await loadOutbox();
  } catch (err) {
    notify.error(err, "Could not send test email");
  } finally {
    testing.value = false;
  }
}

// ------------------------------------------------------------- audit viewers
const PAGE_SIZE = 50;
const authEvents = ref<AuthEventRow[]>([]);
const authTotal = ref(0);
const authLoading = ref(false);
const auditEvents = ref<AuditEventRow[]>([]);
const auditTotal = ref(0);
const auditLoading = ref(false);
const auditExpanded = ref<Record<number, boolean>>({});

async function loadAuthEvents(offset: number) {
  authLoading.value = true;
  try {
    const page = await adminSettingsApi.authEvents({ limit: PAGE_SIZE, offset });
    authEvents.value = page.events;
    authTotal.value = page.total;
  } catch (err) {
    notify.error(err, "Could not load auth events");
  } finally {
    authLoading.value = false;
  }
}

async function loadAuditEvents(offset: number) {
  auditLoading.value = true;
  try {
    const page = await adminSettingsApi.auditEvents({ limit: PAGE_SIZE, offset });
    auditEvents.value = page.events;
    auditTotal.value = page.total;
  } catch (err) {
    notify.error(err, "Could not load audit events");
  } finally {
    auditLoading.value = false;
  }
}

function pretty(v: unknown): string {
  if (v === null || v === undefined) return "—";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// --------------------------------------------------------------------- users
interface AdminUser {
  id: string;
  email: string;
  name: string;
  role?: string | undefined;
  banned?: boolean | null | undefined;
  banReason?: string | null | undefined;
}

const users = ref<AdminUser[]>([]);
const usersLoading = ref(true);
const inviteName = ref("");
const inviteEmail = ref("");
const inviteRole = ref<"admin" | "employee">("employee");
const roleOptions = [
  { label: "Employee", value: "employee" },
  { label: "Admin", value: "admin" },
];
const inviteBusy = ref(false);
const setupLink = ref("");

async function loadUsers() {
  usersLoading.value = true;
  try {
    const { data } = await authClient.admin.listUsers({ query: { limit: 100 } });
    users.value = ((data as { users?: AdminUser[] } | undefined)?.users ?? []) as AdminUser[];
  } catch {
    notify.error(null, "Could not load users");
  } finally {
    usersLoading.value = false;
  }
}

async function invite() {
  inviteBusy.value = true;
  setupLink.value = "";
  try {
    const res = await adminUsersApi.invite({
      name: inviteName.value.trim(),
      email: inviteEmail.value.trim(),
      role: inviteRole.value,
    });
    notify.success(
      "Invite sent",
      res.smtpMissing
        ? "SMTP is not configured — copy the setup link below manually."
        : "Setup email queued.",
    );
    if (res.smtpMissing) setupLink.value = res.setupLink;
    inviteName.value = "";
    inviteEmail.value = "";
    await loadUsers();
  } catch (err) {
    notify.error(err, "Invite failed");
  } finally {
    inviteBusy.value = false;
  }
}

function resetUser(u: AdminUser) {
  confirm.require({
    message: `Reset ${u.email}? They must re-enroll (new password and two-factor).`,
    header: "Reset user",
    icon: "pi pi-exclamation-triangle",
    rejectProps: { label: "Cancel", severity: "secondary", text: true },
    acceptProps: { label: "Reset", severity: "danger" },
    accept: async () => {
      try {
        const res = await adminUsersApi.reset(u.id);
        notify.success(`Reset link issued for ${u.email}`);
        if (res.smtpMissing) setupLink.value = res.setupLink;
        await loadUsers();
      } catch (err) {
        notify.error(err, "Reset failed");
      }
    },
  });
}

async function unlock(u: AdminUser) {
  try {
    await adminUsersApi.unlock(u.id);
    notify.success(`${u.email} unlocked`);
    await loadUsers();
  } catch (err) {
    notify.error(err, "Unlock failed");
  }
}

function statusOf(u: AdminUser): string {
  if (!u.banned) return "active";
  // PAY-217: former employees.
  if (u.banReason === "w2_access_ended") return "former employee, online W-2 access ended";
  if (u.banReason === "employee_terminated") return "former employee";
  return u.banReason === "pending_enrollment"
    ? "pending enrollment"
    : `disabled (${u.banReason ?? "banned"})`;
}

onMounted(() => {
  void loadOutbox();
  void loadAuthEvents(0);
  void loadAuditEvents(0);
  void loadUsers();
});
</script>

<template>
  <div class="page stack">
    <PageHeader title="Settings" subtitle="Email delivery, the notification outbox, security audit trails, and user accounts." />

    <Tabs value="email">
      <TabList>
        <Tab value="email">Email</Tab>
        <Tab value="outbox">Outbox</Tab>
        <Tab value="auth">Auth events</Tab>
        <Tab value="audit">Audit events</Tab>
        <Tab value="users">Users</Tab>
      </TabList>
      <TabPanels>
        <!-- ----------------------------------------------------------- email -->
        <TabPanel value="email">
          <section class="card stack">
            <h3>SMTP delivery</h3>
            <Skeleton v-if="outboxLoading" height="8rem" />
            <template v-else>
              <dl class="kv">
                <dt>Mode</dt>
                <dd>
                  <Tag
                    :value="outbox?.emailMode === 'smtp' ? 'SMTP configured' : 'Log-only (no SMTP)'"
                    :severity="outbox?.emailMode === 'smtp' ? 'success' : 'warn'"
                  />
                </dd>
                <dt>Host</dt>
                <dd>{{ outbox?.smtp.host ? `${outbox.smtp.host}:${outbox.smtp.port}` : "—" }}</dd>
                <dt>From</dt>
                <dd>{{ outbox?.smtp.from ?? "—" }}</dd>
                <dt>TLS</dt>
                <dd>{{ outbox?.smtp.configured ? (outbox.smtp.secure ? "Yes" : "No (STARTTLS/plain)") : "—" }}</dd>
              </dl>
              <p v-if="outbox?.emailMode === 'log'" class="muted small">
                Emails are logged, not sent. Set SMTP_HOST/SMTP_USER/SMTP_PASS on the server to enable delivery.
              </p>
              <div class="row">
                <Button label="Send test email" icon="pi pi-send" :loading="testing" @click="sendTest" />
                <Button label="Refresh" icon="pi pi-refresh" text @click="loadOutbox" />
              </div>
            </template>
          </section>
        </TabPanel>

        <!-- ---------------------------------------------------------- outbox -->
        <TabPanel value="outbox">
          <section class="card stack">
            <h3>Notification outbox</h3>
            <Skeleton v-if="outboxLoading" height="8rem" />
            <template v-else>
              <div class="row">
                <div v-for="(count, key) in outbox?.counts ?? {}" :key="key" class="count-chip">
                  <span class="muted small">{{ key }}</span>
                  <strong>{{ count }}</strong>
                </div>
              </div>
              <h3>Recent failures</h3>
              <div class="table-scroll">
                <DataTable :value="outbox?.recentFailures ?? []" data-key="id" striped-rows>
                  <template #empty>
                    <EmptyState icon="pi pi-check-circle" title="No failures" body="The outbox is healthy." />
                  </template>
                  <Column field="eventType" header="Event" />
                  <Column field="subject" header="Subject" />
                  <Column field="attempts" header="Attempts" style="width: 6rem" />
                  <Column header="Last attempt">
                    <template #body="{ data }">{{ dateTime(data.lastAttemptAt) }}</template>
                  </Column>
                  <Column header="Error">
                    <template #body="{ data }"><span class="small">{{ data.lastError ?? "—" }}</span></template>
                  </Column>
                </DataTable>
              </div>
            </template>
          </section>
        </TabPanel>

        <!-- ------------------------------------------------------ auth events -->
        <TabPanel value="auth">
          <section class="card stack">
            <h3>Auth events</h3>
            <p class="muted small">Sign-ins, lockouts, two-factor and password events — who, from where, when.</p>
            <div class="table-scroll">
              <DataTable
                :value="authEvents"
                :loading="authLoading"
                data-key="id"
                striped-rows
                lazy
                paginator
                :rows="PAGE_SIZE"
                :total-records="authTotal"
                @page="loadAuthEvents($event.first)"
              >
                <template #empty>
                  <EmptyState icon="pi pi-shield" title="No auth events" body="Nothing recorded yet." />
                </template>
                <Column field="event" header="Event" style="width: 14rem" />
                <Column field="userId" header="User" />
                <Column field="ip" header="IP" style="width: 10rem" />
                <Column header="User agent">
                  <template #body="{ data }"><span class="small">{{ data.userAgent ?? "—" }}</span></template>
                </Column>
                <Column header="When" style="width: 11rem">
                  <template #body="{ data }">{{ dateTime(data.createdAt) }}</template>
                </Column>
              </DataTable>
            </div>
          </section>
        </TabPanel>

        <!-- ----------------------------------------------------- audit events -->
        <TabPanel value="audit">
          <section class="card stack">
            <h3>Audit events</h3>
            <p class="muted small">Every admin mutation — expand a row for the before/after payloads.</p>
            <div class="table-scroll">
              <DataTable
                v-model:expanded-rows="auditExpanded"
                :value="auditEvents"
                :loading="auditLoading"
                data-key="id"
                striped-rows
                lazy
                paginator
                :rows="PAGE_SIZE"
                :total-records="auditTotal"
                @page="loadAuditEvents($event.first)"
              >
                <template #empty>
                  <EmptyState icon="pi pi-history" title="No audit events" body="Nothing recorded yet." />
                </template>
                <Column expander style="width: 3rem" />
                <Column field="action" header="Action" style="width: 16rem" />
                <Column header="Entity">
                  <template #body="{ data }">{{ data.entity }} #{{ data.entityId }}</template>
                </Column>
                <Column field="actorId" header="Actor" />
                <Column header="When" style="width: 11rem">
                  <template #body="{ data }">{{ dateTime(data.createdAt) }}</template>
                </Column>
                <template #expansion="{ data }">
                  <div class="grid-2">
                    <div>
                      <h4 class="muted small">Before</h4>
                      <pre class="audit-pre">{{ pretty(data.before) }}</pre>
                    </div>
                    <div>
                      <h4 class="muted small">After</h4>
                      <pre class="audit-pre">{{ pretty(data.after) }}</pre>
                    </div>
                  </div>
                </template>
              </DataTable>
            </div>
          </section>
        </TabPanel>

        <!-- ----------------------------------------------------------- users -->
        <TabPanel value="users">
          <div class="stack">
            <section class="card stack">
              <h3>Invite user</h3>
              <form class="form-grid" @submit.prevent="invite">
                <div class="field">
                  <label for="invName">Full name</label>
                  <InputText id="invName" v-model="inviteName" required />
                </div>
                <div class="field">
                  <label for="invEmail">Email</label>
                  <InputText id="invEmail" v-model="inviteEmail" type="email" required />
                </div>
                <div class="field">
                  <label for="invRole">Role</label>
                  <Select v-model="inviteRole" input-id="invRole" :options="roleOptions" option-label="label" option-value="value" />
                </div>
                <div class="field">
                  <label>&nbsp;</label>
                  <Button type="submit" label="Send invite" icon="pi pi-envelope" :loading="inviteBusy" />
                </div>
              </form>
              <div v-if="setupLink" class="setup-link">
                <p class="muted small">SMTP is not configured — share this setup link manually (single use):</p>
                <code>{{ setupLink }}</code>
              </div>
              <p class="muted small">
                Prefer inviting from the employee record (Employees → detail) so the account is linked to payroll data.
              </p>
            </section>

            <section class="card table-scroll">
              <DataTable :value="users" :loading="usersLoading" data-key="id" striped-rows>
                <template #empty>
                  <EmptyState icon="pi pi-users" title="No users" body="Invite your first user above." />
                </template>
                <Column field="name" header="Name" />
                <Column field="email" header="Email" />
                <Column field="role" header="Role" style="width: 7rem" />
                <Column header="Status">
                  <template #body="{ data }">{{ statusOf(data) }}</template>
                </Column>
                <Column header="Actions" style="width: 12rem">
                  <template #body="{ data }">
                    <div class="row">
                      <Button label="Reset" size="small" text @click="resetUser(data)" />
                      <Button
                        v-if="data.banned && data.banReason === 'lockout'"
                        label="Unlock"
                        size="small"
                        text
                        @click="unlock(data)"
                      />
                    </div>
                  </template>
                </Column>
              </DataTable>
            </section>
          </div>
        </TabPanel>
      </TabPanels>
    </Tabs>
  </div>
</template>

<style scoped>
.count-chip {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0.5rem 1rem;
  border: 1px solid var(--p-content-border-color, #e5e7eb);
  border-radius: 0.5rem;
}
.audit-pre {
  margin: 0;
  padding: 0.5rem;
  background: var(--p-content-background, #f9fafb);
  border-radius: 0.375rem;
  font-size: 0.75rem;
  max-height: 16rem;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.setup-link {
  padding: 0.75rem;
  background: var(--p-content-background, #f9fafb);
  border-radius: 0.5rem;
}
.setup-link code {
  word-break: break-all;
  font-size: 0.8rem;
}
</style>

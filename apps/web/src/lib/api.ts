/**
 * Typed API client (frontend spec: hand-maintained typed wrapper mirroring
 * apps/server/src/routes — OpenAPI codegen was aspirational; this is the
 * pragmatic choice and stays close to the real endpoints).
 *
 * Same-origin cookies carry the session; every function throws ApiError on
 * non-2xx so views can toast uniformly.
 */

// ---------------------------------------------------------------------------
// DTO types (mirror server responses)
// ---------------------------------------------------------------------------

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export type RunStatus = "draft" | "awaiting_approval" | "approved" | "issued" | "void";
export type RequestStatus = "pending" | "approved" | "denied" | "withdrawn";
export type ChangeRequestType =
  | "address"
  | "mailing_address"
  | "w4"
  | "state_election"
  | "bank_details"
  | "legal_name"
  | "tax_id";

export interface PayslipSummary {
  publicId: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  status: RunStatus;
  grossPay: number;
  netPay: number;
  snapshotHash: string;
  issuedAt: string | null;
}

export interface PayslipDetail extends PayslipSummary {
  snapshot: RunSnapshot;
}

/** PAY-7: a contractor-visible invoice (approved/paid only — D1). */
export interface MyInvoice {
  id: number;
  invoiceDate: string;
  description: string;
  amount: number;
  currency: string;
  status: "approved" | "paid";
  recurringPeriod: string | null;
  payment: {
    payDate: string;
    amount: number;
    method: string;
    reference: string | null;
    backupWithheld: number;
  } | null;
}

export interface RunSnapshot {
  inputs: {
    periodAmount: number;
    frequency: string;
    periodsPerYear: number;
    w4: Record<string, unknown> | null;
    taxConfig: Record<string, unknown>;
    brackets: { ordinal: number; minAmount: string; maxAmount: string | null; rate: string }[];
    priorYtdGross: number;
    periodStart: string;
    periodEnd: string;
    payDate: string;
    company: { legalName: string };
    employee: { legalName: string; preferredName: string | null };
  };
  result: {
    grossPay: number;
    federalWithholding: number;
    socialSecurity: number;
    medicare: number;
    stateWithholding: number;
    totalDeductions: number;
    netPay: number;
    employerSocialSecurity: number;
    employerMedicare: number;
    employerFUTA: number;
    [key: string]: number;
  };
  engineVersion: string;
  templateVersion: string;
  /** YTD accumulations through this run (snapshot template ≥1.1.0). */
  ytd?: {
    gross: number;
    federalWithholding: number;
    socialSecurity: number;
    medicare: number;
    stateWithholding: number;
    totalDeductions: number;
    netPay: number;
  };
  /** Legacy-import only: categories where the ISSUED amount differs from the recomputed result. */
  legacyDeviations?: {
    category: string;
    stored: string;
    recomputed: string;
    reason: string;
  }[];
}

/**
 * Amounts to SHOW on a payslip: engine result with documented legacy
 * deviations overridden to the issued (stored) figures. Mirrors
 * effectivePayslipAmounts() in @payroll/documents — keep in sync.
 */
export function effectivePayslipAmounts(snapshot: RunSnapshot): {
  federalWithholding: number;
  totalDeductions: number;
  netPay: number;
  deviations: { label: string; stored: number; recomputed: number }[];
} {
  const LABELS: Record<string, string> = {
    gross_pay: "Gross Pay",
    federal_withholding: "Federal Income Tax",
    social_security: "Social Security",
    medicare: "Medicare",
    state_withholding: "State Income Tax",
    net_pay: "Net Pay",
  };
  let federal = snapshot.result.federalWithholding;
  let net = snapshot.result.netPay;
  const deviations = (snapshot.legacyDeviations ?? []).map((d) => {
    if (d.category === "federal_withholding") federal = Number(d.stored);
    if (d.category === "net_pay") net = Number(d.stored);
    return {
      label: LABELS[d.category] ?? d.category,
      stored: Number(d.stored),
      recomputed: Number(d.recomputed),
    };
  });
  const totalDeductions =
    deviations.length > 0
      ? Math.round((snapshot.result.grossPay - net) * 100) / 100
      : snapshot.result.totalDeductions;
  return { federalWithholding: federal, totalDeductions, netPay: net, deviations };
}

export interface ChangeRequest {
  publicId: string;
  employeeId: number;
  employeeName?: string;
  requestType: ChangeRequestType;
  payload: Record<string, unknown>;
  effectiveFrom: string;
  status: RequestStatus;
  submittedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  appliedAt: string | null;
}

export interface ChangeRequestComment {
  id: number;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string | null;
}

export interface MyProfile {
  legalName: string;
  preferredName: string | null;
  employmentType: string;
  hireDate: string;
  status: string;
  address: Address | null;
  mailingAddress: Address | null;
  bankDetails: {
    type: string | null;
    routingMasked: string | null;
    accountMasked: string | null;
  } | null;
  taxIdMasked: string | null;
  w4: {
    taxYear: number;
    filingStatus: string;
    federalExempt: boolean;
    dependentsAmount: string;
    otherIncome: string;
    deductionsAmount: string;
    extraWithholding: string;
    effectiveFrom: string;
  } | null;
}

export interface NotificationSetting {
  eventType: string;
  enabled: boolean;
}

export interface PayrollRunRow {
  publicId: string;
  employeeId: number;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  status: RunStatus;
  snapshotHash: string | null;
  createdBy: string;
  createdAt: string | null;
  runSnapshot?: RunSnapshot;
  approvedBy?: string | null;
  approvedAt?: string | null;
  issuedAt?: string | null;
  voidedAt?: string | null;
  voidReason?: string | null;
}

export interface PaySchedule {
  id: number;
  employeeId: number | null;
  frequency: string;
  draftDayOfMonth: number;
  payDayOfMonth: number;
  autoDraft: boolean;
  active: boolean;
}

export interface CompensationRow {
  id: number;
  employeeId: number;
  periodAmount: string;
  frequency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface W4ElectionRow {
  id: number;
  employeeId: number;
  taxYear: number;
  filingStatus: string;
  federalExempt: boolean;
  multipleJobs: boolean;
  dependentsAmount: string;
  otherIncome: string;
  deductionsAmount: string;
  extraWithholding: string;
  effectiveFrom: string;
  filedDate: string;
  renewalDeadline: string | null;
  note: string | null;
}

export interface TaxConfigRow {
  id: number;
  jurisdiction: string;
  taxYear: number;
  standardDeduction: string;
  socialSecurityRate: string;
  socialSecurityWageCap: string;
  medicareRate: string;
  medicareAdditionalRate: string;
  medicareAdditionalThreshold: string;
  stateWithholdingRate: string;
  employerSocialSecurityRate: string;
  employerMedicareRate: string;
  /** Net FUTA rate applied by runs — mirrored from sutaCreditRate (PAY-18). */
  futaRate: string;
  futaWageCap: string;
  /** Configured SUTA credit; net FUTA = 6.0% − this (PAY-18). */
  sutaCreditRate: string;
}

export interface TaxBracketRow {
  id: number;
  jurisdiction: string;
  taxYear: number;
  ordinal: number;
  minAmount: string;
  maxAmount: string | null;
  rate: string;
}

/** PAY-13: state tax config row (state_tax_configs). Nullable fields are unused by the state's form. */
export interface StateTaxConfigRow {
  id: number;
  jurisdiction: string;
  taxYear: number;
  kind: "none" | "flat" | "progressive";
  flatRate: string | null;
  standardDeduction: string | null;
  standardDeductionAlt: string | null;
  altMinAllowances: number | null;
  lowIncomeExemption: string | null;
  lowIncomeExemptionAlt: string | null;
  allowanceDeduction: string | null;
  allowanceCredit: string | null;
  additionalAllowanceDeduction: string | null;
  note: string;
}

export interface WorkStateRow {
  id: number;
  employeeId: number;
  stateCode: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** PAY-163: Yonkers or the Maryland county; null = none (only when confirmed). */
  localityCode: string | null;
  localityConfirmedAt: string | null;
}

/** PAY-163: where an employee lives for local income tax (effective-dated). */
export interface ResidenceRow {
  id: number;
  employeeId: number;
  country: string;
  stateCode: string | null;
  localityCode: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: "admin" | "certificate";
  createdAt: string;
}

export interface ResidenceDetail {
  current: ResidenceRow | null;
  history: ResidenceRow[];
  /** Country and US state of the home address on file (never the street). */
  addressHint: { country: string; state: string | null } | null;
}

export interface LocalTaxCheck {
  enforced: boolean;
  payDate: string;
  employees: {
    employeeId: number;
    name: string;
    status: "ok" | "blocked";
    reasons: string[];
    /** State or locality code behind a hold about a place (e.g. "PA", "NY-NYC"). */
    place: string | null;
    /** Work state code in force, or null when there is no work-state row. */
    workState: string | null;
  }[];
}

/** PAY-13: state withholding election (the IL-W-4 / DE 4 mirror of W4ElectionRow). */
export interface StateElectionRow {
  id: number;
  employeeId: number;
  stateCode: string;
  filingStatus: string;
  allowances: number;
  additionalAllowances: number;
  extraWithholding: string;
  exempt: boolean;
  effectiveFrom: string;
  filedDate: string;
  note: string | null;
}

export interface AdminEmployeeListRow {
  id: number;
  userId: string | null;
  legalName: string;
  preferredName: string | null;
  employmentType: string;
  hireDate: string;
  terminationDate: string | null;
  status: string;
  userEmail: string | null;
  userBanned: boolean | null;
}

export interface AdminEmployeeDetail {
  id: number;
  userId: string | null;
  legalName: string;
  preferredName: string | null;
  employmentType: string;
  hireDate: string;
  terminationDate: string | null;
  status: string;
  address: Address | null;
  mailingAddress: Address | null;
  dateOfBirth: string | null;
  /** Presence flag only (spec 11) — the TIN itself never reaches the browser. */
  hasTaxId: boolean;
  user: {
    id: string;
    email: string | null;
    banned: boolean | null;
    banReason: string | null;
  } | null;
}

export interface InviteResult {
  userId: string;
  email: string;
  setupLink: string;
  smtpMissing: boolean;
  resent?: boolean;
}

export interface OutboxHealth {
  counts: Record<string, number>;
  recentFailures: {
    id: number;
    userId: string;
    eventType: string;
    subject: string;
    attempts: number;
    lastError: string | null;
    lastAttemptAt: string | null;
    createdAt: string | null;
  }[];
  emailMode: "smtp" | "log";
  smtp: {
    configured: boolean;
    host: string | null;
    port: number;
    from: string | null;
    secure: boolean;
  };
}

export interface CompanyProfile {
  id: number;
  legalName: string;
  einMasked: string | null;
  address: Address | null;
}

/** Spec 24 (PAY-116): an employer state tax account number, masked by the server. */
export interface StateIdRow {
  stateCode: string;
  fromTaxYear: number;
  idMasked: string;
  source: "entered";
}

export interface StateIdDefault {
  stateCode: "IL" | "NY";
  idMasked: string;
  source: "ein_default";
}

export interface StateIdNeeded {
  stateCode: string;
  taxYear: number;
  reason: "tax_withheld" | "wages_only";
}

export interface StateIdList {
  stateIds: StateIdRow[];
  defaults: StateIdDefault[];
  needed: StateIdNeeded[];
}

export interface AuthEventRow {
  id: number;
  userId: string | null;
  event: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string | null;
}

export interface AuditEventRow {
  id: number;
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  before: unknown;
  after: unknown;
  createdAt: string | null;
}

export interface Paged<T> {
  events: T[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Fetch core
// ---------------------------------------------------------------------------

import { notifySessionExpired } from "./session-expired";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    // PAY-6: a 401 on a session-gated endpoint means the session expired
    // (idle 12h / absolute 7d, or revoked) — redirect to login instead of
    // letting every in-flight call toast an error. Onboarding endpoints are
    // token-based (no session), so their 401s stay local.
    if (res.status === 401 && !path.startsWith("/api/onboarding/")) {
      notifySessionExpired();
    }
    let code = "request_failed";
    let message = `Request failed (${res.status})`;
    let details: unknown;
    try {
      const data = (await res.json()) as { error?: string; message?: string; details?: unknown };
      if (data.error) code = data.error;
      if (data.message) message = data.message;
      details = data.details;
    } catch {
      // non-JSON error body — keep defaults
    }
    throw new ApiError(res.status, code, message, details);
  }
  // 204 No Content (e.g. DELETE of a state ID) has no body to parse.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const get = <T>(path: string) => request<T>("GET", path);
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});
const put = <T>(path: string, body: unknown) => request<T>("PUT", path, body);
const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
const del = <T>(path: string) => request<T>("DELETE", path);

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Endpoint namespaces
// ---------------------------------------------------------------------------

export const onboardingApi = {
  verifyToken: (token: string) =>
    post<{ email: string; name: string; purpose: string }>("/api/onboarding/verify-token", {
      token,
    }),
  setPassword: (token: string, password: string) =>
    post<{ ok: true; next: string }>("/api/onboarding/set-password", { token, password }),
  totpEnable: (token: string) =>
    post<{ totpURI: string }>("/api/onboarding/totp-enable", { token }),
  totpVerify: (token: string, code: string) =>
    post<{ ok: true; backupCodes: string[] }>("/api/onboarding/totp-verify", { token, code }),
};

export const payslipsApi = {
  list: () => get<{ payslips: PayslipSummary[] }>("/api/payslips"),
  detail: (publicId: string) => get<{ payslip: PayslipDetail }>(`/api/payslips/${publicId}`),
  pdfUrl: (publicId: string) => `/api/payslips/${publicId}/pdf`,
};

export const myInvoicesApi = {
  list: () => get<{ invoices: MyInvoice[] }>("/api/my/invoices"),
  pdfUrl: (id: number) => `/api/my/invoices/${id}/pdf`,
};

export const changeRequestsApi = {
  submit: (input: {
    requestType: ChangeRequestType;
    payload: Record<string, unknown>;
    effectiveFrom: string;
  }) => post<{ request: ChangeRequest }>("/api/change-requests", input),
  list: (filter: { status?: RequestStatus; requestType?: ChangeRequestType } = {}) =>
    get<{ requests: ChangeRequest[] }>(`/api/change-requests${qs(filter)}`),
  detail: (publicId: string) =>
    get<{ request: ChangeRequest; comments: ChangeRequestComment[] }>(
      `/api/change-requests/${publicId}`,
    ),
  comment: (publicId: string, body: string) =>
    post<{ ok: true }>(`/api/change-requests/${publicId}/comments`, { body }),
  approve: (publicId: string, input: { note?: string; effectiveFromOverride?: string } = {}) =>
    post<{ request: ChangeRequest }>(`/api/change-requests/${publicId}/approve`, input),
  deny: (publicId: string, reason: string) =>
    post<{ request: ChangeRequest }>(`/api/change-requests/${publicId}/deny`, { reason }),
  withdraw: (publicId: string) =>
    post<{ request: ChangeRequest }>(`/api/change-requests/${publicId}/withdraw`),
  /** Admin-only reveal-on-demand for tax_id requests (spec 11 D21; audit-logged). */
  revealTaxId: (publicId: string) =>
    get<{ taxId: string }>(`/api/change-requests/${publicId}/reveal-tax-id`),
};

export const myApi = {
  profile: () => get<{ profile: MyProfile }>("/api/my/profile"),
  security: () =>
    get<{ twoFactorEnabled: boolean; backupCodesRemaining: number }>("/api/my/security"),
  regenerateBackupCodes: () => post<{ backupCodes: string[] }>("/api/my/backup-codes"),
  notificationSettings: () =>
    get<{ settings: NotificationSetting[] }>("/api/my/notification-settings"),
  putNotificationSettings: (settings: NotificationSetting[]) =>
    put<{ ok: true }>("/api/my/notification-settings", { settings }),
};

export const adminPayrollApi = {
  runs: (filter: { status?: RunStatus; employeeId?: number; year?: number } = {}) =>
    get<{ runs: PayrollRunRow[] }>(`/api/admin/payroll-runs${qs(filter)}`),
  run: (publicId: string) => get<{ run: PayrollRunRow }>(`/api/admin/payroll-runs/${publicId}`),
  generate: (input: { year: number; month: number; employeeId?: number }) =>
    post<{ generated: PayrollRunRow[]; skipped: { employeeId: number; reason: string }[] }>(
      "/api/admin/payroll-runs/generate",
      input,
    ),
  act: (publicId: string, action: "approve" | "issue" | "void", reason?: string) =>
    post<{ run: PayrollRunRow }>(
      `/api/admin/payroll-runs/${publicId}/${action}`,
      reason ? { reason } : {},
    ),
  schedules: () => get<{ schedules: PaySchedule[] }>("/api/admin/pay-schedules"),
  putSchedule: (input: {
    draftDayOfMonth: number;
    payDayOfMonth: number;
    autoDraft: boolean;
    active: boolean;
  }) => put<{ schedule: PaySchedule }>("/api/admin/pay-schedules", input),
  compensation: (employeeId: number) =>
    get<{ compensation: CompensationRow[] }>(`/api/admin/employees/${employeeId}/compensation`),
  addCompensation: (
    employeeId: number,
    input: {
      periodAmount: number;
      frequency: string;
      effectiveFrom: string;
      effectiveTo?: string | null;
    },
  ) =>
    post<{ compensation: CompensationRow }>(
      `/api/admin/employees/${employeeId}/compensation`,
      input,
    ),
  w4: (employeeId: number) =>
    get<{ w4Elections: W4ElectionRow[] }>(`/api/admin/employees/${employeeId}/w4`),
  addW4: (employeeId: number, input: Record<string, unknown>) =>
    post<{ w4: W4ElectionRow }>(`/api/admin/employees/${employeeId}/w4`, input),
  taxConfig: (filter: { year?: number; jurisdiction?: string } = {}) =>
    get<{ taxConfig: TaxConfigRow[]; taxBrackets: TaxBracketRow[] }>(
      `/api/admin/tax-config${qs(filter)}`,
    ),
  putTaxConfig: (input: {
    jurisdiction: string;
    taxYear: number;
    config: Record<string, number>;
    brackets: { ordinal: number; minAmount: number; maxAmount: number | null; rate: number }[];
  }) => put<{ ok: true }>("/api/admin/tax-config", input),
  // PAY-13: state tax tables, work-state assignment, and state elections.
  stateTaxConfig: (filter: { year?: number; jurisdiction?: string } = {}) =>
    get<{ stateTaxConfig: StateTaxConfigRow[]; stateTaxBrackets: TaxBracketRow[] }>(
      `/api/admin/state-tax-config${qs(filter)}`,
    ),
  putStateTaxConfig: (input: {
    jurisdiction: string;
    taxYear: number;
    config: {
      kind: "none" | "flat" | "progressive";
      flatRate?: number | null;
      standardDeduction?: number | null;
      standardDeductionAlt?: number | null;
      altMinAllowances?: number | null;
      lowIncomeExemption?: number | null;
      lowIncomeExemptionAlt?: number | null;
      allowanceDeduction?: number | null;
      allowanceCredit?: number | null;
      additionalAllowanceDeduction?: number | null;
      note?: string;
    };
    brackets?: { ordinal: number; minAmount: number; maxAmount: number | null; rate: number }[];
  }) => put<{ config: StateTaxConfigRow }>("/api/admin/state-tax-config", input),
  workStates: (employeeId: number) =>
    get<{ workStates: WorkStateRow[] }>(`/api/admin/employees/${employeeId}/work-state`),
  assignWorkState: (
    employeeId: number,
    input: { stateCode: string; effectiveFrom: string; localityCode?: string | null },
  ) => put<{ workState: WorkStateRow }>(`/api/admin/employees/${employeeId}/work-state`, input),
  // PAY-163: work locality (backfill on the open row), residence, and the read-only check.
  setWorkLocality: (
    employeeId: number,
    input: { localityCode: string | null; effectiveOn?: string },
  ) =>
    put<{ workState: WorkStateRow }>(
      `/api/admin/employees/${employeeId}/work-state/locality`,
      input,
    ),
  residence: (employeeId: number) =>
    get<ResidenceDetail>(`/api/admin/employees/${employeeId}/residence`),
  setResidence: (
    employeeId: number,
    input: {
      country: string;
      stateCode: string | null;
      localityCode: string | null;
      effectiveFrom: string;
    },
  ) => put<{ residence: ResidenceRow }>(`/api/admin/employees/${employeeId}/residence`, input),
  localTaxCheck: (payDate?: string) =>
    get<LocalTaxCheck>(`/api/admin/local-tax/check${payDate ? qs({ payDate }) : ""}`),
  stateElections: (employeeId: number, state?: string) =>
    get<{ elections: StateElectionRow[] }>(
      `/api/admin/employees/${employeeId}/state-elections${state ? qs({ state }) : ""}`,
    ),
  addStateElection: (
    employeeId: number,
    input: {
      stateCode: string;
      filingStatus?: string;
      allowances?: number;
      additionalAllowances?: number;
      extraWithholding?: number;
      exempt?: boolean;
      effectiveFrom: string;
      filedDate: string;
      note?: string;
    },
  ) =>
    post<{ election: StateElectionRow }>(
      `/api/admin/employees/${employeeId}/state-elections`,
      input,
    ),
};

export const adminEmployeesApi = {
  list: () => get<{ employees: AdminEmployeeListRow[] }>("/api/admin/employees"),
  detail: (employeeId: number) =>
    get<{ employee: AdminEmployeeDetail }>(`/api/admin/employees/${employeeId}`),
  create: (input: {
    legalName: string;
    preferredName?: string;
    employmentType: string;
    hireDate: string;
    address?: Address;
    taxId?: string;
  }) => post<{ employee: AdminEmployeeDetail }>("/api/admin/employees", input),
  invite: (employeeId: number, input: { email?: string; name?: string } = {}) =>
    post<InviteResult>(`/api/admin/employees/${employeeId}/invite`, input),
  setStatus: (
    employeeId: number,
    input: { status: "active" | "terminated"; terminationDate?: string },
  ) => post<{ employee: AdminEmployeeDetail }>(`/api/admin/employees/${employeeId}/status`, input),
  /** Spec 11 (D20a): admin direct-set of the employee TIN (write-only). */
  setTaxId: (employeeId: number, input: { taxId: string }) =>
    patch<{ employee: AdminEmployeeDetail }>(`/api/admin/employees/${employeeId}`, input),
  /**
   * PAY-20: admin direct-set of the mailing address (effective-dated; writes
   * the same approved change-request history row as an approved request).
   */
  setMailingAddress: (
    employeeId: number,
    input: { mailingAddress: Address; effectiveFrom?: string },
  ) => patch<{ employee: AdminEmployeeDetail }>(`/api/admin/employees/${employeeId}`, input),
};

export const adminUsersApi = {
  invite: (input: { name: string; email: string; role: "admin" | "employee" }) =>
    post<InviteResult>("/api/admin/users", input),
  reset: (userId: string) => post<InviteResult>(`/api/admin/users/${userId}/reset`),
  unlock: (userId: string) => post<{ ok: true }>(`/api/admin/users/${userId}/unlock`),
};

export const adminNotificationsApi = {
  outbox: () => get<OutboxHealth>("/api/admin/notifications/outbox"),
  testEmail: () => post<{ ok: true; queued: boolean }>("/api/admin/settings/test-email"),
};

export const adminSettingsApi = {
  company: () => get<{ company: CompanyProfile }>("/api/admin/company"),
  putCompany: (input: { legalName: string; address?: Address; ein?: string }) =>
    put<{ company: CompanyProfile }>("/api/admin/company", input),
  /** Spec 24 (PAY-116): write-only; reads return masks only. */
  stateIds: () => get<StateIdList>("/api/admin/company/state-ids"),
  putStateId: (stateCode: string, input: { stateId: string; fromTaxYear: number }) =>
    put<{ stateId: StateIdRow }>(
      `/api/admin/company/state-ids/${encodeURIComponent(stateCode)}`,
      input,
    ),
  deleteStateId: (stateCode: string, fromTaxYear: number) =>
    del<void>(`/api/admin/company/state-ids/${encodeURIComponent(stateCode)}/${fromTaxYear}`),
  authEvents: (input: { limit?: number; offset?: number } = {}) =>
    get<Paged<AuthEventRow>>(`/api/admin/audit/auth-events${qs(input)}`),
  auditEvents: (input: { limit?: number; offset?: number } = {}) =>
    get<Paged<AuditEventRow>>(`/api/admin/audit/audit-events${qs(input)}`),
};

// ---------------------------------------------------------------------------
// Spec 10 — contractors
// ---------------------------------------------------------------------------

export type TaxStatus = "us_person" | "nonresident";
export type ContractorEntityType = "individual" | "entity";
export type TaxForm = "w9" | "w8ben" | "w8ben_e" | "w8eci";
export type ServicesLocation = "foreign" | "us" | "mixed";
export type PaymentMethod = "ach" | "check" | "wire" | "card" | "third_party_network";
export type InvoiceStatus = "submitted" | "approved" | "rejected" | "paid" | "void";

export interface UsDayEntry {
  year: number;
  days: number;
  note?: string;
}

export interface ContractorListRow {
  employeeId: number;
  legalName: string;
  preferredName: string | null;
  hireDate: string;
  status: string;
  taxStatus: TaxStatus;
  entityType: ContractorEntityType;
  residenceCountry: string | null;
  taxForm: TaxForm;
  formCollectedAt: string | null;
  formExpiresAt: string | null;
  backupWithholding: boolean;
  servicesLocation: ServicesLocation;
}

export interface ContractorDetails extends ContractorListRow {
  usDaysLog: UsDayEntry[];
  tinMasked: string | null;
}

export interface ContractorPaymentRow {
  id: number;
  invoiceId: number;
  payDate: string;
  amount: string;
  exchangeRate: string | null;
  method: PaymentMethod;
  backupWithheld: string;
  reference: string | null;
  createdAt: string | null;
}

export interface ContractorInvoiceRow {
  id: number;
  employeeId: number;
  invoiceRef: string | null;
  description: string;
  amount: string;
  currency: string;
  invoiceDate: string;
  status: InvoiceStatus;
  submittedBy: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  /** Spec 12: set when generated by a recurring template; NULL = manual. */
  recurringTemplateId: number | null;
  recurringPeriod: string | null;
  createdAt: string | null;
  payment: ContractorPaymentRow | null;
}

export interface ContractorDetail {
  contractor: {
    id: number;
    userId: string | null;
    legalName: string;
    preferredName: string | null;
    hireDate: string;
    status: string;
    details: {
      taxStatus: TaxStatus;
      entityType: ContractorEntityType;
      residenceCountry: string | null;
      taxForm: TaxForm;
      formCollectedAt: string | null;
      formExpiresAt: string | null;
      backupWithholding: boolean;
      servicesLocation: ServicesLocation;
      usDaysLog: UsDayEntry[];
      tinMasked: string | null;
    };
  };
  invoices: ContractorInvoiceRow[];
}

export interface YearEndRow {
  employeeId: number;
  legalName: string;
  taxStatus: TaxStatus;
  entityType: ContractorEntityType;
  taxForm: TaxForm;
  formCollectedAt: string | null;
  formExpiresAt: string | null;
  formExpired: boolean;
  servicesLocation: ServicesLocation;
  review1042: boolean;
  payments: {
    payDate: string;
    amount: string;
    method: string;
    backupWithheld: string;
    reference: string | null;
  }[];
  reportableTotal: number;
  grossTotal: number;
  backupWithheldTotal: number;
  threshold: number;
  formRequired: boolean;
}

export interface ReportingConfigRow {
  id: number;
  taxYear: number;
  necThreshold: string;
  note: string;
}

export interface ContractorCreateInput {
  legalName: string;
  preferredName?: string;
  hireDate: string;
  taxStatus: TaxStatus;
  entityType: ContractorEntityType;
  residenceCountry?: string;
  tin?: string;
  taxForm: TaxForm;
  formCollectedAt?: string;
  backupWithholding?: boolean;
  servicesLocation?: ServicesLocation;
  usDaysLog?: UsDayEntry[];
}

/** Update payload — nullable fields clear the stored value server-side. */
export interface ContractorUpdateInput {
  legalName?: string;
  preferredName?: string | null;
  taxStatus?: TaxStatus;
  entityType?: ContractorEntityType;
  residenceCountry?: string | null;
  tin?: string | null;
  taxForm?: TaxForm;
  formCollectedAt?: string | null;
  backupWithholding?: boolean;
  servicesLocation?: ServicesLocation;
  usDaysLog?: UsDayEntry[];
}

// ---------------------------------------------------------------------------
// Spec 12 — recurring contractor invoices
// ---------------------------------------------------------------------------

export type InvoiceDay = "last_day" | "fixed";

export interface RecurringTemplateRow {
  id: number;
  employeeId: number;
  description: string;
  amount: string;
  currency: string;
  invoiceDay: InvoiceDay;
  invoiceDayOfMonth: number | null;
  payDayOfMonth: number;
  active: boolean;
  startsOn: string;
  endsOn: string | null;
  lastGeneratedPeriod: string | null;
  /** Server-computed next invoice date; null when paused/ended/exhausted. */
  nextGenerationOn: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface RecurringTemplateInput {
  description: string;
  amount: number;
  invoiceDay: InvoiceDay;
  invoiceDayOfMonth?: number | null;
  payDayOfMonth: number;
  startsOn: string;
  endsOn?: string | null;
}

/** Edits affect future generations only (D25); active toggles pause/resume. */
export type RecurringTemplatePatch = Partial<RecurringTemplateInput> & { active?: boolean };

export const adminContractorsApi = {
  list: () => get<{ contractors: ContractorListRow[] }>("/api/admin/contractors"),
  create: (input: ContractorCreateInput) =>
    post<{ employeeId: number }>("/api/admin/contractors", input),
  detail: (employeeId: number) => get<ContractorDetail>(`/api/admin/contractors/${employeeId}`),
  update: (employeeId: number, input: ContractorUpdateInput) =>
    request<{ ok: true }>("PATCH", `/api/admin/contractors/${employeeId}`, input),
  addInvoice: (
    employeeId: number,
    input: { invoiceRef?: string; description: string; amount: number; invoiceDate: string },
  ) =>
    post<{ invoice: ContractorInvoiceRow }>(`/api/admin/contractors/${employeeId}/invoices`, input),
  approve: (invoiceId: number, note?: string) =>
    post<{ invoice: ContractorInvoiceRow }>(
      `/api/admin/invoices/${invoiceId}/approve`,
      note ? { note } : {},
    ),
  reject: (invoiceId: number, note: string) =>
    post<{ invoice: ContractorInvoiceRow }>(`/api/admin/invoices/${invoiceId}/reject`, { note }),
  pay: (
    invoiceId: number,
    input: {
      payDate: string;
      amount: number;
      exchangeRate?: number | null;
      method: PaymentMethod;
      reference?: string;
    },
  ) =>
    post<{ invoice: ContractorInvoiceRow; payment: ContractorPaymentRow }>(
      `/api/admin/invoices/${invoiceId}/pay`,
      input,
    ),
  void: (invoiceId: number, note: string) =>
    post<{ invoice: ContractorInvoiceRow }>(`/api/admin/invoices/${invoiceId}/void`, { note }),
  yearEnd: (year: number) =>
    get<{ taxYear: number; threshold: string; rows: YearEndRow[] }>(
      `/api/admin/contractors/year-end${qs({ year })}`,
    ),
  nec1099Url: (employeeId: number, year: number) =>
    `/api/admin/contractors/${employeeId}/1099-nec?year=${year}`,
  reportingConfig: () =>
    get<{ config: ReportingConfigRow[] }>("/api/admin/contractor-reporting-config"),
  putReportingConfig: (input: { taxYear: number; necThreshold: number; note?: string }) =>
    put<{ config: ReportingConfigRow }>("/api/admin/contractor-reporting-config", input),
  // Spec 12 — recurring invoice templates
  recurringList: (employeeId: number) =>
    get<{ templates: RecurringTemplateRow[] }>(`/api/admin/contractors/${employeeId}/recurring`),
  recurringCreate: (employeeId: number, input: RecurringTemplateInput) =>
    post<{ template: RecurringTemplateRow }>(
      `/api/admin/contractors/${employeeId}/recurring`,
      input,
    ),
  recurringUpdate: (templateId: number, input: RecurringTemplatePatch) =>
    patch<{ template: RecurringTemplateRow }>(`/api/admin/recurring/${templateId}`, input),
  recurringDelete: (templateId: number) =>
    request<{ ok: true }>("DELETE", `/api/admin/recurring/${templateId}`),
};

// ---------------------------------------------------------------------------
// PAY-9 — monthly federal tax deposits (admin, record-only)
// ---------------------------------------------------------------------------

export type TaxDepositStatus = "pending" | "deposited" | "overdue" | "superseded";
export type DepositPeriodKind = "month" | "quarter";

export interface TaxDepositRow {
  id: number;
  jurisdiction: string;
  /** First of the deposit month ("2026-08-01" = the August deposit). */
  periodStart: string;
  amount: string;
  dueDate: string;
  status: TaxDepositStatus;
  /** Stored at write time (PAY-91); never derived from today's schedule. */
  periodKind: DepositPeriodKind;
  /** Set when the row was replaced by a monthly <-> quarterly change (PAY-91). */
  supersededAt: string | null;
  /** List rows only: the state-quarter's overpayment, on its anchor (latest-period) row only. */
  overpaid?: string;
  /** List rows only: the period's payments could not be worked out (data error). */
  paymentsUnavailable?: boolean;
  depositedOn: string | null;
  eftpsConfirmation: string | null;
  remindersSent: number[];
  createdAt: string | null;
  updatedAt: string | null;
}

/** PAY-91: a deposited payment counted against a deposit's period. */
export interface DepositCredit {
  depositId: number;
  periodStart: string;
  periodKind: DepositPeriodKind;
  depositedOn: string;
  /** The whole payment. */
  amount: string;
  /** The part of the payment counted toward this deposit (≤ amount). */
  applied: string;
}

export interface DepositDetail {
  deposit: TaxDepositRow;
  breakdown: DepositBreakdownRow[];
  runs: DepositRunRow[];
  /** The period's withholding (month or quarter). */
  liability: string;
  credits: DepositCredit[];
  /** The state-quarter's overpayment (the note may show on any row). */
  overpaid: string;
  /** True on the one row per state-quarter that carries the "Overpaid" chip. */
  overpaidAnchor: boolean;
  /** The period's payments could not be worked out (data error). */
  paymentsUnavailable: boolean;
  /** Superseded rows only: the deposit(s) that replaced it. */
  replacedBy: { id: number; periodStart: string; periodKind: DepositPeriodKind }[];
}

export interface DepositBreakdownRow {
  category: string;
  amount: string;
}

export interface DepositRunRow {
  publicId: string;
  payDate: string;
  employeeName: string;
  amount: string;
}

export const adminDepositsApi = {
  list: (
    filter: {
      year?: number;
      status?: "pending" | "deposited" | "overdue";
      jurisdiction?: string;
    } = {},
  ) => get<{ deposits: TaxDepositRow[] }>(`/api/admin/tax-deposits${qs(filter)}`),
  detail: (id: number) => get<DepositDetail>(`/api/admin/tax-deposits/${id}`),
  markDeposited: (id: number, input: { depositedOn: string; eftpsConfirmation: string }) =>
    post<{ deposit: TaxDepositRow }>(`/api/admin/tax-deposits/${id}/deposit`, input),
  reminderSchedule: () =>
    get<{ offsets: number[]; defaultOffsets: number[] }>(
      "/api/admin/tax-deposits/reminder-schedule",
    ),
  putReminderSchedule: (offsets: number[]) =>
    put<{ offsets: number[] }>("/api/admin/tax-deposits/reminder-schedule", { offsets }),
  // PAY-27 — EFTPS confirmation attachments (stored encrypted at rest)
  listAttachments: (id: number) =>
    get<{ attachments: DepositAttachment[] }>(`/api/admin/tax-deposits/${id}/attachments`),
  attachmentDownloadUrl: (id: number, attachmentId: number) =>
    `/api/admin/tax-deposits/${id}/attachments/${attachmentId}/download`,
  // Raw-body upload (application/pdf) — request() is JSON-only.
  uploadAttachment: async (id: number, file: File) => {
    const res = await fetch(
      `/api/admin/tax-deposits/${id}/attachments?filename=${encodeURIComponent(file.name)}`,
      { method: "POST", headers: { "content-type": "application/pdf" }, body: file },
    );
    if (!res.ok) {
      if (res.status === 401) notifySessionExpired();
      let code = "request_failed";
      let message = `Request failed (${res.status})`;
      try {
        const data = (await res.json()) as { error?: string; message?: string };
        if (data.error) code = data.error;
        if (data.message) message = data.message;
      } catch {
        // non-JSON error body — keep defaults
      }
      throw new ApiError(res.status, code, message);
    }
    return (await res.json()) as { attachment: DepositAttachment };
  },
};

/** PAY-27: a deposit attachment's metadata (bytes never leave via the list). */
export interface DepositAttachment {
  id: number;
  depositId: number;
  filename: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// PAY-10 — quarterly Form 941 filings (admin, record-only)
// ---------------------------------------------------------------------------

export type TaxFilingStatus = "not_started" | "ready" | "filed";
export type TaxFormType = "941" | "940" | "w2_w3";

export interface Worksheet941 {
  form: "941";
  year: number;
  quarter: number;
  line1Employees: number;
  line2Wages: string;
  line3FederalWithheld: string;
  line5aTaxableSsWages: string;
  line5aTax: string;
  line5cTaxableMedicareWages: string;
  line5cTax: string;
  line5dAdditionalMedicare: string;
  line5eTotal: string;
  line6TotalTaxes: string;
  line7FractionsOfCents: string;
  /** The computed rounding delta (line 7's value when no admin override). */
  line7Computed: string;
  line10TotalAfterAdjustments: string;
  line11ResearchCredit: string;
  line12TotalAfterCredits: string;
  line13Deposits: string;
  line14BalanceDue: string;
  line15Overpayment: string;
  line16: { month1: string; month2: string; month3: string; deMinimis: boolean };
}

/** PAY-11 — annual Form 940 (FUTA) worksheet. */
export interface Worksheet940 {
  form: "940";
  year: number;
  /** PAY-18 rate assumption — absent on worksheets frozen before v1.11. */
  sutaCreditRate?: string;
  futaRate?: string;
  line3TotalPayments: string;
  line7FutaTaxableWages: string;
  line8FutaTax: string;
  line12TotalFutaTax: string;
  /** Sum of frozen employer_futa entries — the accrued-liability truth. */
  futaTaxPerFrozenEntries: string;
  /** Cent-level rounding delta between the frozen entries and line 12. */
  roundingDelta: string;
  /** First quarter whose cumulative FUTA liability exceeded $500, or null. */
  depositThresholdCrossedQuarter: number | null;
  depositDueBy: string | null;
  balanceDue: string;
}

/** PAY-11 — W-3 transmittal aggregate worksheet. */
export interface WorksheetW3 {
  form: "w2_w3";
  year: number;
  employeeCount: number;
  box1Wages: string;
  box2FederalWithheld: string;
  box3SsWages: string;
  box4SsTax: string;
  box5MedicareWages: string;
  box6MedicareTax: string;
}

export type FilingWorksheet = Worksheet941 | Worksheet940 | WorksheetW3;

/** PAY-11 — one employee's W-2 box figures (admin review list; no PII). */
export interface W2FiguresRow {
  employeeId: number;
  legalName: string;
  box1Wages: number;
  box2FederalWithheld: number;
  box3SsWages: number;
  box4SsTax: number;
  box5MedicareWages: number;
  box6MedicareTax: number;
  /** PAY-19 — active electronic-delivery consent on file. */
  consented: boolean;
}

export interface TaxFilingRow {
  id: number;
  formType: TaxFormType;
  year: number;
  /** 1-4 for quarterly forms; 0 for annual forms. */
  quarter: number;
  dueDate: string;
  status: TaxFilingStatus;
  worksheet: FilingWorksheet | null;
  worksheetHash: string | null;
  fractionsOfCents: string;
  filedOn: string | null;
  filingMethod: string | null;
  filingReference: string | null;
  remindersSent: number[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TaxAdjustmentRow {
  id: number;
  filingId: number;
  kind: string;
  noticeDate: string | null;
  amountDue: string;
  abatedAmount: string;
  amountPaid: string;
  paidOn: string | null;
  eftpsConfirmation: string | null;
  note: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AdjustmentInput {
  kind: string;
  noticeDate?: string;
  amountDue: string;
  abatedAmount?: string;
  amountPaid?: string;
  paidOn?: string;
  eftpsConfirmation?: string;
  note?: string;
}

/** PAY-24: a filing attachment's metadata (bytes never leave via the list). */
export interface FilingAttachment {
  id: number;
  filingId: number;
  filename: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: string;
}

/** PAY-25: a worksheet-correction audit row shown on the filing detail. */
export interface FilingCorrection {
  id: string;
  actorId: string;
  before: { worksheetHash?: string | null } | null;
  after: { worksheetHash?: string; reason?: string } | null;
  createdAt: string | null;
}

/** PAY-25: read-only recompute preview (filed filings only). */
export interface WorksheetRecomputePreview {
  beforeWorksheet: TaxFilingRow["worksheet"];
  afterWorksheet: TaxFilingRow["worksheet"];
  beforeHash: string | null;
  afterHash: string;
}

export const adminFilingsApi = {
  list: (filter: { year?: number; status?: TaxFilingStatus; formType?: TaxFormType } = {}) =>
    get<{ filings: TaxFilingRow[] }>(`/api/admin/tax-filings${qs(filter)}`),
  detail: (id: number) =>
    get<{ filing: TaxFilingRow; adjustments: TaxAdjustmentRow[]; corrections: FilingCorrection[] }>(
      `/api/admin/tax-filings/${id}`,
    ),
  markFiled: (
    id: number,
    input: { filedOn: string; filingMethod: string; filingReference: string },
  ) => post<{ filing: TaxFilingRow }>(`/api/admin/tax-filings/${id}/file`, input),
  setFractionsOfCents: (id: number, amount: string) =>
    put<{ filing: TaxFilingRow }>(`/api/admin/tax-filings/${id}/fractions-of-cents`, { amount }),
  // PAY-25 — audited worksheet correction for filed filings
  recomputePreview: (id: number) =>
    get<WorksheetRecomputePreview>(`/api/admin/tax-filings/${id}/recompute`),
  recompute: (id: number, reason: string) =>
    post<{ filing: TaxFilingRow }>(`/api/admin/tax-filings/${id}/recompute`, { reason }),
  addAdjustment: (id: number, input: AdjustmentInput) =>
    post<{ adjustment: TaxAdjustmentRow }>(`/api/admin/tax-filings/${id}/adjustments`, input),
  updateAdjustment: (id: number, adjId: number, input: AdjustmentInput) =>
    put<{ adjustment: TaxAdjustmentRow }>(
      `/api/admin/tax-filings/${id}/adjustments/${adjId}`,
      input,
    ),
  deleteAdjustment: (id: number, adjId: number) =>
    del<{ ok: true }>(`/api/admin/tax-filings/${id}/adjustments/${adjId}`),
  reminderSchedule: () =>
    get<{ offsets: number[]; defaultOffsets: number[] }>(
      "/api/admin/tax-filings/reminder-schedule",
    ),
  putReminderSchedule: (offsets: number[]) =>
    put<{ offsets: number[] }>("/api/admin/tax-filings/reminder-schedule", { offsets }),
  // PAY-11 — annual W-2/W-3 (on-demand PDFs, never stored)
  w2List: (year: number) =>
    get<{ year: number; available: boolean; availableOn: string; w2s: W2FiguresRow[] }>(
      `/api/admin/annual-forms/w2?year=${year}`,
    ),
  w2PdfUrl: (employeeId: number, year: number) =>
    `/api/admin/annual-forms/w2/${employeeId}/pdf?year=${year}`,
  w2PrintPacketUrl: (employeeId: number, year: number) =>
    `/api/admin/annual-forms/w2/${employeeId}/print-packet?year=${year}`,
  w3PdfUrl: (year: number) => `/api/admin/annual-forms/w3/pdf?year=${year}`,
  // PAY-16 — filled official Form 941 PDF from the filing's worksheet
  f941PdfUrl: (id: number) => `/api/admin/tax-filings/${id}/941-pdf`,
  // PAY-33 — filled official Form 940 PDF from the filing's worksheet
  f940PdfUrl: (id: number) => `/api/admin/tax-filings/${id}/940-pdf`,
  // PAY-24 — confirmation/evidence attachments (stored encrypted at rest)
  listAttachments: (id: number) =>
    get<{ attachments: FilingAttachment[] }>(`/api/admin/tax-filings/${id}/attachments`),
  attachmentDownloadUrl: (id: number, attachmentId: number) =>
    `/api/admin/tax-filings/${id}/attachments/${attachmentId}/download`,
  // Raw-body upload (application/pdf) — request() is JSON-only.
  uploadAttachment: async (id: number, file: File) => {
    const res = await fetch(
      `/api/admin/tax-filings/${id}/attachments?filename=${encodeURIComponent(file.name)}`,
      { method: "POST", headers: { "content-type": "application/pdf" }, body: file },
    );
    if (!res.ok) {
      if (res.status === 401) notifySessionExpired();
      let code = "request_failed";
      let message = `Request failed (${res.status})`;
      try {
        const data = (await res.json()) as { error?: string; message?: string };
        if (data.error) code = data.error;
        if (data.message) message = data.message;
      } catch {
        // non-JSON error body — keep defaults
      }
      throw new ApiError(res.status, code, message);
    }
    return (await res.json()) as { attachment: FilingAttachment };
  },
};

/** PAY-19 — W-2 electronic-delivery consent status (disclosures included). */
export interface W2ConsentStatus {
  consented: boolean;
  consentedAt: string | null;
  withdrawnAt: string | null;
  disclosureVersion: string;
  disclosures: readonly string[];
}

/** PAY-11 — employee's own W-2s (available from January of the next year). */
export const myW2Api = {
  list: () => get<{ w2s: { year: number; availableOn: string }[] }>("/api/my/w2"),
  pdfUrl: (year: number) => `/api/my/w2/${year}/pdf`,
  // PAY-19 — electronic-delivery consent (Pub 1141 §2.4)
  consent: () => get<W2ConsentStatus>("/api/my/w2/consent"),
  consentGive: () => post<W2ConsentStatus>("/api/my/w2/consent", {}),
  consentWithdraw: () => del<W2ConsentStatus>("/api/my/w2/consent"),
};

// ---------------------------------------------------------------------------
// PAY-40 — admin calendar (month grid of company date obligations)
// ---------------------------------------------------------------------------

export type CalendarEventKind =
  | "payday_scheduled"
  | "payday_run"
  | "contractor_invoice"
  | "contractor_payment"
  | "deposit_due"
  | "deposit_made"
  | "filing_due"
  | "filing_filed"
  | "filing_generates"
  | "filing_due_projected"
  | "w8_expiry";

export interface CalendarEvent {
  /** "YYYY-MM-DD" — always inside the requested month. */
  date: string;
  kind: CalendarEventKind;
  label: string;
  detail?: string;
  /** vue-router target: { name: "admin-filing", params: { id: 3 } }. */
  link: { name: string; params?: Record<string, string | number> } | null;
}

export const adminCalendarApi = {
  month: (year: number, month: number) =>
    get<{ year: number; month: number; events: CalendarEvent[] }>(
      `/api/admin/calendar${qs({ year, month })}`,
    ),
};

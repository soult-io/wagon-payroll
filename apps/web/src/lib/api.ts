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
/** Statuses a run can still be issued (or voided) from. Server: OPEN_RUN_STATUSES in payroll/runs.ts. */
export const OPEN_RUN_STATUSES: readonly RunStatus[] = ["draft", "awaiting_approval", "approved"];
export function isOpenRun(status: RunStatus): boolean {
  return OPEN_RUN_STATUSES.includes(status);
}
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

/** PAY-193 (D9.8): year-end warning window; dates are company-local, from the server. */
export interface YearEndStatus {
  today: string;
  year: number | null;
  phase: "december" | "after_year_end" | null;
  closesOn: string | null;
  openRuns: { publicId: string; payDate: string; status: RunStatus }[];
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

/** PAY-193 L4: one state's late-issue questions, rendered by the server (shown verbatim). */
export interface LateStateQuestions {
  jurisdiction: string;
  withholdingReturn: string;
  suiWageReport: string;
  annualReconciliation: string;
}

/** PAY-193 L4: `attestation` of a 409 late_payment_confirmation_required. `text` keeps "{netPay}". */
export interface LateAttestationBody {
  version: 1;
  text: string;
  stateQuestions: LateStateQuestions[];
}

export interface LateStateReturn {
  jurisdiction: string;
  withholdingReturnFiled: boolean;
  suiWageReportFiled: boolean;
  annualReconciliationFiled: boolean;
}

export interface LatePayment {
  attestationVersion: 1;
  netPayCents: number;
  stateReturns: LateStateReturn[];
}

/** POST …/approve|issue|void response; `lateIssue` only on a late issue (codes, no amounts). */
export interface IssueResponse {
  run: PayrollRunRow;
  lateIssue?: { taxYear: number; followUps: string[] };
}

/** GET …/payroll-runs/:publicId — `lateIssue` is set when the run was issued late. */
export interface RunDetailResponse {
  run: PayrollRunRow;
  lateIssue: { confirmedBy: string; confirmedAt: string } | null;
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
  /** PAY-208 — W-2 delivery state (dates only, no terms text). */
  w2Consent?: AdminW2ConsentState;
  user: {
    id: string;
    email: string | null;
    banned: boolean | null;
    banReason: string | null;
  } | null;
}

/** PAY-208 — an employee's agreement to online W-2s, as the admin sees it. */
export interface AdminW2ConsentState {
  state: "none" | "current" | "outdated" | "withdrawn";
  consentedAt: string | null;
  withdrawnAt: string | null;
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

/** Spec 24 (PAY-116) PR-4: employees already given a W-2 with a state's line (count only). */
export interface StateIdFurnished {
  stateCode: string;
  taxYear: number;
  employees: number;
}

export interface StateIdList {
  stateIds: StateIdRow[];
  defaults: StateIdDefault[];
  needed: StateIdNeeded[];
  /** PR-4: per unfiled tax year, how many employees already hold a W-2 with that state. */
  furnished: StateIdFurnished[];
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
    /** The whole JSON error body (e.g. firstOpenYear on state_id_year_filed). */
    public body?: Record<string, unknown>,
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
    let body: Record<string, unknown> | undefined;
    try {
      const data = (await res.json()) as { error?: string; message?: string; details?: unknown };
      if (data.error) code = data.error;
      if (data.message) message = data.message;
      details = data.details;
      body = data as Record<string, unknown>;
    } catch {
      // non-JSON error body — keep defaults
    }
    throw new ApiError(res.status, code, message, details, body);
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
  run: (publicId: string) => get<RunDetailResponse>(`/api/admin/payroll-runs/${publicId}`),
  yearEnd: () => get<YearEndStatus>("/api/admin/payroll-runs/year-end"),
  generate: (input: { year: number; month: number; employeeId?: number }) =>
    post<{ generated: PayrollRunRow[]; skipped: { employeeId: number; reason: string }[] }>(
      "/api/admin/payroll-runs/generate",
      input,
    ),
  act: (
    publicId: string,
    action: "approve" | "issue" | "void",
    body: { reason?: string; latePayment?: LatePayment } = {},
  ) => post<IssueResponse>(`/api/admin/payroll-runs/${publicId}/${action}`, body),
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
  /** PAY-208 — record a written withdrawal (effective today; never back-dated). */
  w2ConsentWithdraw: (employeeId: number) =>
    post<{
      w2Consent: AdminW2ConsentState;
      effectiveOn: string;
      confirmation: "email" | "paper_needed" | null;
    }>(`/api/admin/employees/${employeeId}/w2-consent/withdraw`, {}),
  /** PAY-208 (D-A) — change the employee's sign-in email (needs a recent sign-in). */
  changeSignInEmail: (employeeId: number, email: string) =>
    put<{ changed: boolean; pendingEnrollment: boolean; sessionsRevoked: boolean }>(
      `/api/admin/employees/${employeeId}/sign-in-email`,
      { email },
    ),
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

/** PAY-208 — the W-2 contact as entered; contactReady = online W-2s can open. */
export interface W2ContactAdmin {
  name: string | null;
  phone: string | null;
  email: string | null;
  /** null = the company address is used. */
  mailingAddress: Address | null;
  contactReady: boolean;
}

export const adminSettingsApi = {
  company: () => get<{ company: CompanyProfile }>("/api/admin/company"),
  putCompany: (input: { legalName: string; address?: Address; ein?: string }) =>
    put<{ company: CompanyProfile }>("/api/admin/company", input),
  /** PAY-208 — the W-2 contact (26 CFR 31.6051-1(j)(3)(v)(A)). */
  w2Contact: () => get<{ w2Contact: W2ContactAdmin }>("/api/admin/company/w2-contact"),
  putW2Contact: (input: {
    name: string;
    phone: string;
    email: string;
    mailingAddress: Address | null;
  }) =>
    put<{ w2Contact: W2ContactAdmin; changed: boolean }>("/api/admin/company/w2-contact", input),
  /** Spec 24 (PAY-116): write-only; reads return masks only. */
  stateIds: () => get<StateIdList>("/api/admin/company/state-ids"),
  putStateId: (stateCode: string, input: { stateId: string; fromTaxYear: number }) =>
    put<{ stateId: StateIdRow; unchanged: boolean }>(
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
  /** PAY-193: 0 for the period's first row; > 0 for an additional (shortfall) deposit. */
  seq: number;
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
  /** PAY-193: the period's other live rows (same jurisdiction, period, kind), seq ascending. */
  siblings: { id: number; seq: number; status: string; amount: string }[];
  /** PAY-193: what is already deposited toward this row's period (deposited rows/credits only). */
  alreadyDeposited: string;
  /** PAY-193: Σ the period's open (pending/overdue) rows with a lower seq. */
  stillOwedEarlier: string;
  /**
   * PAY-193: on a seq 0 row, the lowest-seq open additional deposit and the
   * total still to pay on the period's additional deposits; else null.
   */
  additionalDeposit: { id: number; amount: string } | null;
  /** PAY-193: federal rows — the Form 941 due date of the row's quarter; null for state rows. */
  form941DueDate: string | null;
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

/** Spec 24 (PAY-116) — one state's W-3 reconciliation row (R9). */
export interface WorksheetW3State {
  state: string;
  w2Lines: number;
  box16: string;
  box17: string;
  runWithholding: string;
  attributedLegacy: string;
  reconciled: boolean;
}

/** PAY-11 — W-3 transmittal aggregate worksheet. Spec 24: state keys for 2026+. */
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
  /** Spec 24 — W-3 box c: number of W-2 forms. */
  w2FormCount?: number;
  /** Spec 24 — one state code, "X" for several, null for none. */
  box15State?: string | null;
  box16StateWages?: string;
  box17StateTax?: string;
  states?: WorksheetW3State[];
  blockedEmployees?: number;
}

export type FilingWorksheet = Worksheet941 | Worksheet940 | WorksheetW3;

/** PAY-162 — W-2 check codes (never amounts). */
export type W2IssueCode =
  | "internal_mismatch"
  | "negative_amount"
  | "box4_over_max"
  | "box4_without_box3"
  | "box6_without_box5"
  | "box4_off_rate"
  | "box6_off_rate"
  // Spec 24 (PAY-116): W-2 state lines.
  | "legacy_state_runs"
  | "missing_state_id"
  | "reconciliation_mismatch"
  | "local_boxes_pending"
  | "missing_state_id_zero_tax"
  | "legacy_runs_without_state"
  | "local_tax_md"
  | "local_tax_ny"
  | "exempt_reciprocity"
  | "ny_all_wages"
  | "period_spans_move"
  // Spec 24 (PAY-116) PR-3: box 15 / EIN cannot be printed (blocks).
  | "state_id_unreadable"
  | "ein_unreadable"
  | "state_id_too_long"
  // Spec 24 (PAY-116) PR-4: the SSN or box f address cannot be read (blocks).
  | "ssn_unreadable"
  | "address_unreadable";

export interface W2Issue {
  code: W2IssueCode;
  severity: "block" | "warn" | "info";
  /** Spec 24 — the state line the issue belongs to. */
  state?: string;
  /** Spec 24 — legacy_state_runs only: the runs without a work state that carry state tax. */
  runs?: { runPublicId: string; payDate: string; stateTax: string }[];
  /** Spec 24 — period_spans_move only: the work-state change date. */
  date?: string;
}

/**
 * Spec 24 (PAY-116) PR-4 — one state's tax check on the admin W-2 list.
 * `deposited` is what was marked as deposited (display only).
 */
export interface W2StateCheck {
  state: string;
  box17: string;
  runWithholding: string;
  attributedLegacy: string;
  deposited: string;
  reconciled: boolean;
}

/** Spec 24 (PAY-116) — one W-2 state line (boxes 15–17); never the state ID. */
export interface W2StateLineRow {
  state: string;
  /** null = empty (second row of a state). */
  box16: string | null;
  box17: string | null;
  form: number;
  row: 1 | 2;
  stateIdSource: "entered" | "ein_default" | null;
}

/**
 * PAY-11 — one employee's W-2 box figures (admin review list; no PII).
 * PAY-162: boxes are money strings ("8000.00"); null while the figures are
 * unreadable or negative. `blocked` = a block issue stands.
 */
export interface W2FiguresRow {
  employeeId: number;
  legalName: string;
  box1Wages: string | null;
  box2FederalWithheld: string | null;
  box3SsWages: string | null;
  box4SsTax: string | null;
  box5MedicareWages: string | null;
  box6MedicareTax: string | null;
  /** Spec 24 — state lines (empty before 2026). */
  stateLines: W2StateLineRow[];
  /** Spec 24 — always empty (local boxes come later). */
  localLines: never[];
  /** Spec 24 — W-2 forms for this employee (two state lines per form). */
  formCount: number;
  issues: W2Issue[];
  blocked: boolean;
  /** PAY-19/PAY-208 — the electronic channel of this tax year (a consent that covers it). */
  consented: boolean;
  /** PAY-208 — agreed to earlier terms; paper for this year until they agree again. */
  consentOutdated: boolean;
  /** PAY-206 — the employee may hold a copy with other figures (renders say CORRECTED). */
  corrected: boolean;
  /** PAY-206 — corrected and the current figures are not yet furnished. */
  correctionToFurnish: boolean;
  /** PAY-206 — how the latest copy reached the employee ("unknown" = backfilled, not recorded). */
  furnished: "none" | "online" | "printed" | "paper" | "unknown";
  /** PAY-206 — company-local date of the latest furnishing. */
  furnishedOn: string | null;
}

/** PAY-162 — one W-2 year on the employee's list; `ready` = downloadable now. */
export interface MyW2Year {
  year: number;
  availableOn: string;
  ready: boolean;
  /** PAY-206 — this W-2 replaces one with other figures (bare flag). */
  corrected: boolean;
  /**
   * PAY-206 (D9) — the PDF can be downloaded now: ready, and an active
   * consent or a year already furnished online inside its access window.
   */
  downloadable: boolean;
  /** Spec 24 (PAY-116) PR-4 — number of W-2 forms; null unless ready. */
  formCount: number | null;
  /** PAY-208 (N1) — last day (ISO) this W-2 stays online, incl. the 90-day corrected rule. */
  accessThrough: string;
}

/** PAY-162 — a filing-level block issue on the tax-filings list. */
export interface FilingIssue {
  code: "missing_tax_config" | "w2_blocked";
  severity: "block";
  year: number;
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
  /** PAY-162 — list rows only: filing-level block issues (codes + year). */
  issues?: FilingIssue[];
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
    input: {
      filedOn: string;
      filingMethod: string;
      filingReference: string;
      /** PAY-193: the worksheet hash shown; a changed worksheet is refused (409 worksheet_changed). */
      expectedWorksheetHash?: string;
    },
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
    get<{
      year: number;
      available: boolean;
      availableOn: string;
      /** PAY-162: the official W-2/W-3 form is bundled for the year. */
      formAvailable: boolean;
      w2s: W2FiguresRow[];
      /** Spec 24 — year-level issues (reconciliation_mismatch per state). */
      yearIssues: W2Issue[];
      /** PR-4 — the year's "your W-2 is ready" email already went out. */
      notified: boolean;
      /** PR-4 — per-state tax check (2026+; [] while W-2 boxes are withheld). */
      stateChecks: W2StateCheck[];
      /** PAY-208 — employees who must agree to the current terms for this year. */
      reconsentNeeded: number;
      /** PAY-208 — the W-2 contact is complete (online W-2s can open). */
      contactReady: boolean;
      /** PAY-208 ((j)(5)(ii)) — consented notices of the year that bounced. */
      undeliveredNotices: { employeeId: number; legalName: string; failedOn: string }[];
    }>(`/api/admin/annual-forms/w2?year=${year}`),
  w2PdfUrl: (employeeId: number, year: number) =>
    `/api/admin/annual-forms/w2/${employeeId}/pdf?year=${year}`,
  w2PrintPacketUrl: (employeeId: number, year: number) =>
    `/api/admin/annual-forms/w2/${employeeId}/print-packet?year=${year}`,
  w3PdfUrl: (year: number) => `/api/admin/annual-forms/w3/pdf?year=${year}`,
  // PAY-206 — the admin gave the employee the current W-2 on paper (idempotent)
  w2MarkGivenOnPaper: (employeeId: number, year: number) =>
    post<{ furnished: "paper"; corrected: boolean }>(
      `/api/admin/annual-forms/w2/${employeeId}/furnished-on-paper?year=${year}`,
      {},
    ),
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

/** PAY-208 — the W-2 contact employees write to (address already resolved). */
export interface W2Contact {
  name: string;
  phone: string;
  email: string;
  mailingAddress: Address | null;
}

/**
 * PAY-19/PAY-208 — online-W-2 agreement status (26 CFR 31.6051-1(j); IRS Pub
 * 15-A (2026), "Furnishing Form W-2 to employees electronically").
 */
export interface W2ConsentStatus {
  /** Agreed to the current terms. */
  consented: boolean;
  /** Agreed to earlier terms: agree again for W-2s from 2026. */
  outdated: boolean;
  consentedAt: string | null;
  withdrawnAt: string | null;
  consentedVersion: string | null;
  /** The current terms version — the one `disclosures` is, sent back on agree. */
  disclosureVersion: string;
  disclosures: readonly string[];
  contactReady: boolean;
  contact: W2Contact | null;
  /** The employer's legal name. */
  companyName: string;
  /** DELETE only: company-local date the withdrawal took effect. */
  effectiveOn?: string;
}

/** PAY-11 — employee's own W-2s (available from January of the next year). */
export const myW2Api = {
  /** PAY-208: + upcomingYear — the latest paid year whose W-2 is not out yet. */
  list: () => get<{ w2s: MyW2Year[]; upcomingYear: number | null }>("/api/my/w2"),
  pdfUrl: (year: number) => `/api/my/w2/${year}/pdf`,
  consent: () => get<W2ConsentStatus>("/api/my/w2/consent"),
  /** PAY-208 D-B: the one-page test PDF with a single-use code. */
  testPdfUrl: () => "/api/my/w2/consent/test-pdf",
  /** Agree to the terms the employee read (disclosureVersion) after the access check (accessCode). */
  consentGive: (input: { disclosureVersion: string; accessCode: string }) =>
    post<W2ConsentStatus>("/api/my/w2/consent", input),
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

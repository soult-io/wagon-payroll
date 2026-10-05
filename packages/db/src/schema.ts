/**
 * Payroll app schema — Drizzle ORM (Postgres 16).
 *
 * Implements EVERY app-owned table of the data model (spec 1).
 *
 * Auth-owned tables (`user`, `session`, `account`, `verification`, `twoFactor`)
 * are intentionally NOT here — they are created by the Better Auth CLI migration
 * in step 2 (spec 1: "Two table families"). App columns that reference Better
 * Auth's `user.id` are TEXT without a FK constraint until then (employees.user_id,
 * change_request_comments.author_id, notification_settings.user_id, etc.).
 *
 * Not representable in Drizzle's schema DSL, applied as a raw SQL migration step
 * (see drizzle/0001_compensation_exclusion.sql):
 *   - exclusion constraint on compensation daterange(effective_from, effective_to)
 *     for non-overlapping effective-dated pay (requires btree_gist).
 *   - trigger rejecting UPDATE on issued payroll_runs except void bookkeeping.
 *   - exclusion constraint on employee_residences windows per employee
 *     (PAY-163, drizzle/0023_spooky_toro.sql).
 */

import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).defaultNow();
/** Money is always NUMERIC(12,2) in the DB (spec 1 cross-cutting rules). */
const money = (name: string) => numeric(name, { precision: 12, scale: 2 });
/** Rates are NUMERIC(6,5). */
const rate = (name: string) => numeric(name, { precision: 6, scale: 5 });

// ---------------------------------------------------------------------------
// 1. Organization & people
// ---------------------------------------------------------------------------

export const company = pgTable("company", {
  id: serial("id").primaryKey(),
  legalName: text("legal_name").notNull(),
  /** Encrypted at rest (app-level AES-256-GCM via SECRETS_DIR key). */
  ein: text("ein"),
  /** {line1,line2,city,state,zip,country} */
  address: jsonb("address"),
  /**
   * PAY-208 (26 CFR 31.6051-1(j)(3)(v)(A)): the W-2 contact — the person or
   * department employees write to about W-2s (withdrawal, paper copies).
   * Employer business data, shown to every employee and in W-2 emails, so
   * stored in plain text like `address`; never logged. Online W-2s stay
   * closed until name, phone, email and a mailing address exist.
   */
  w2ContactName: text("w2_contact_name"),
  w2ContactPhone: text("w2_contact_phone"),
  w2ContactEmail: text("w2_contact_email"),
  /** Optional {line1,line2,city,state,zip,country}; null = use `address`. */
  w2ContactAddress: jsonb("w2_contact_address"),
  createdAt: createdAt(),
});

export const employees = pgTable(
  "employees",
  {
    id: serial("id").primaryKey(),
    /** FK → user.id (Better Auth, TEXT) — constraint added in step 2. NULL until invited. */
    userId: text("user_id").unique(),
    companyId: integer("company_id")
      .notNull()
      .references(() => company.id),
    employmentType: text("employment_type").notNull().default("w2"),
    legalName: text("legal_name").notNull(),
    preferredName: text("preferred_name"),
    dateOfBirth: date("date_of_birth"),
    /** SSN — encrypted at rest, never in logs/responses. */
    taxId: text("tax_id"),
    /** Current address; history lives in change_requests/audit_events. */
    address: jsonb("address"),
    /** Optional mailing address (W-2 box f); same treatment as `address`. */
    mailingAddress: jsonb("mailing_address"),
    /** {routing,account,type} — encrypted at rest. */
    bankDetails: jsonb("bank_details"),
    hireDate: date("hire_date").notNull(),
    terminationDate: date("termination_date"),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("employees_employment_type_check", sql`${t.employmentType} IN ('w2','1099')`),
    check("employees_status_check", sql`${t.status} IN ('active','terminated')`),
  ],
);

// ---------------------------------------------------------------------------
// 2. Payroll configuration (effective-dated where life says so)
// ---------------------------------------------------------------------------

export const compensation = pgTable(
  "compensation",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    /** Amount per pay period. */
    periodAmount: money("period_amount").notNull(),
    frequency: text("frequency").notNull().default("monthly"),
    effectiveFrom: date("effective_from").notNull(),
    /** NULL = open-ended. */
    effectiveTo: date("effective_to"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("compensation_employee_effective_from_uniq").on(t.employeeId, t.effectiveFrom),
    check(
      "compensation_frequency_check",
      sql`${t.frequency} IN ('weekly','biweekly','semimonthly','monthly')`,
    ),
    // Non-overlap across rows is enforced by an exclusion constraint on
    // daterange(effective_from, effective_to) — raw SQL migration, see header.
  ],
);

export const w4Elections = pgTable(
  "w4_elections",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    taxYear: integer("tax_year").notNull(),
    filingStatus: text("filing_status").notNull().default("single"),
    federalExempt: boolean("federal_exempt").notNull().default(false),
    multipleJobs: boolean("multiple_jobs").notNull().default(false),
    dependentsAmount: money("dependents_amount").notNull().default("0"),
    otherIncome: money("other_income").notNull().default("0"),
    deductionsAmount: money("deductions_amount").notNull().default("0"),
    /** Per-period extra withholding. */
    extraWithholding: money("extra_withholding").notNull().default("0"),
    /**
     * NOT retroactive — applies to payments for pay periods ending on or after
     * this date (selected as of min(period end, pay date); Spec 26 (PAY-173) D3).
     */
    effectiveFrom: date("effective_from").notNull(),
    filedDate: date("filed_date").notNull(),
    /** Exempt W-4s expire (IRC §3402(n)). */
    renewalDeadline: date("renewal_deadline"),
    note: text("note").default(""),
    createdAt: createdAt(),
  },
  (t) => [
    unique("w4_elections_employee_year_effective_uniq").on(
      t.employeeId,
      t.taxYear,
      t.effectiveFrom,
    ),
    check(
      "w4_elections_filing_status_check",
      sql`${t.filingStatus} IN ('single','married_joint','married_separate','head_of_household')`,
    ),
  ],
);

export const taxConfig = pgTable(
  "tax_config",
  {
    id: serial("id").primaryKey(),
    jurisdiction: text("jurisdiction").notNull().default("federal"),
    taxYear: integer("tax_year").notNull(),
    standardDeduction: money("standard_deduction").notNull(),
    socialSecurityRate: rate("social_security_rate").notNull(),
    socialSecurityWageCap: money("social_security_wage_cap").notNull(),
    medicareRate: rate("medicare_rate").notNull(),
    medicareAdditionalRate: rate("medicare_additional_rate").notNull(),
    medicareAdditionalThreshold: money("medicare_additional_threshold").notNull(),
    stateWithholdingRate: rate("state_withholding_rate").notNull().default("0"),
    employerSocialSecurityRate: rate("employer_social_security_rate").notNull(),
    employerMedicareRate: rate("employer_medicare_rate").notNull(),
    /**
     * Net FUTA rate applied by payroll runs (statutory 6.0% − suta_credit_rate;
     * mirrored at write time so issued-run snapshots stay the accrual truth).
     */
    futaRate: rate("futa_rate").notNull(),
    futaWageCap: money("futa_wage_cap").notNull(),
    /**
     * PAY-18: SUTA credit against the statutory 6.0% FUTA rate. 0.054 = full
     * credit (employer pays state unemployment); 0 = no SUTA paid → 6.0% net;
     * a partial value covers credit-reduction states without a schema change.
     * The 940 worksheet computes from THIS field.
     */
    sutaCreditRate: rate("suta_credit_rate").notNull().default("0.054"),
  },
  (t) => [unique("tax_config_jurisdiction_year_uniq").on(t.jurisdiction, t.taxYear)],
);

export const taxBrackets = pgTable(
  "tax_brackets",
  {
    id: serial("id").primaryKey(),
    jurisdiction: text("jurisdiction").notNull().default("federal"),
    taxYear: integer("tax_year").notNull(),
    ordinal: integer("ordinal").notNull(),
    minAmount: money("min_amount").notNull(),
    /** NULL = open top bracket. */
    maxAmount: money("max_amount"),
    rate: rate("rate").notNull(),
  },
  (t) => [
    unique("tax_brackets_jurisdiction_year_ordinal_uniq").on(t.jurisdiction, t.taxYear, t.ordinal),
  ],
);

export const paySchedules = pgTable(
  "pay_schedules",
  {
    id: serial("id").primaryKey(),
    /** NULL = company-wide default. */
    employeeId: integer("employee_id").references(() => employees.id),
    frequency: text("frequency").notNull().default("monthly"),
    draftDayOfMonth: integer("draft_day_of_month").notNull().default(15),
    payDayOfMonth: integer("pay_day_of_month").notNull().default(15),
    autoDraft: boolean("auto_draft").notNull().default(true),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "pay_schedules_frequency_check",
      sql`${t.frequency} IN ('weekly','biweekly','semimonthly','monthly')`,
    ),
    check("pay_schedules_draft_day_check", sql`${t.draftDayOfMonth} BETWEEN 1 AND 28`),
    check("pay_schedules_pay_day_check", sql`${t.payDayOfMonth} BETWEEN 1 AND 28`),
  ],
);

// ---------------------------------------------------------------------------
// 3. Payroll runs (immutable once issued — D5)
// ---------------------------------------------------------------------------

export const payrollRuns = pgTable(
  "payroll_runs",
  {
    id: serial("id").primaryKey(),
    /** URL-safe, non-enumerable external id (spec 1 cross-cutting rules). */
    publicId: uuid("public_id").notNull().defaultRandom().unique(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    payDate: date("pay_date").notNull(),
    status: text("status").notNull().default("draft"),
    /**
     * Frozen inputs+outputs: wage, tax config, brackets, W-4 election, prior-YTD,
     * computed result, engineVersion. Payslip PDFs render from THIS, never from
     * live config (D5).
     */
    runSnapshot: jsonb("run_snapshot").notNull(),
    /** SHA-256 of the canonical snapshot JSON (spec documents determinism check). */
    snapshotHash: text("snapshot_hash"),
    /** 'scheduler' or user.id. */
    createdBy: text("created_by"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * Idempotent monthly generation — partial: void runs release the slot so
     * regenerating after a void creates a NEW run row (spec payroll-engine).
     */
    uniqueIndex("payroll_runs_employee_period_start_uniq")
      .on(t.employeeId, t.periodStart)
      .where(sql`${t.status} <> 'void'`),
    check(
      "payroll_runs_status_check",
      sql`${t.status} IN ('draft','awaiting_approval','approved','issued','void')`,
    ),
    // Issued-row immutability trigger: raw SQL migration, see header.
  ],
);

export const payrollEntries = pgTable(
  "payroll_entries",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => payrollRuns.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    amount: money("amount").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("payroll_entries_run_category_uniq").on(t.runId, t.category),
    check(
      "payroll_entries_category_check",
      sql`${t.category} IN ('gross_pay','federal_withholding','social_security','medicare','state_withholding','net_pay','employer_social_security','employer_medicare','employer_futa')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 4. Change requests (D7)
// ---------------------------------------------------------------------------

export const changeRequests = pgTable(
  "change_requests",
  {
    id: serial("id").primaryKey(),
    /** URL-safe, non-enumerable external id. */
    publicId: uuid("public_id").notNull().defaultRandom().unique(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    requestType: text("request_type").notNull(),
    /** Proposed values, same shape as the target field. */
    payload: jsonb("payload").notNull(),
    /** Requested effective date (D7: effective-dated). */
    effectiveFrom: date("effective_from").notNull(),
    status: text("status").notNull().default("pending"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).defaultNow(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Set when the change lands on the target table. */
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "change_requests_type_check",
      sql`${t.requestType} IN ('address','mailing_address','w4','state_election','bank_details','legal_name','tax_id')`,
    ),
    check(
      "change_requests_status_check",
      sql`${t.status} IN ('pending','approved','denied','withdrawn')`,
    ),
    /** One pending request per (employee, field) — partial unique index (spec 4). */
    uniqueIndex("change_requests_one_pending_per_field")
      .on(t.employeeId, t.requestType)
      .where(sql`status = 'pending'`),
  ],
);

export const changeRequestComments = pgTable("change_request_comments", {
  id: serial("id").primaryKey(),
  requestId: integer("request_id")
    .notNull()
    .references(() => changeRequests.id, { onDelete: "cascade" }),
  /** user.id (Better Auth) — FK added in step 2. */
  authorId: text("author_id").notNull(),
  body: text("body").notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// 5. Notifications (D8)
// ---------------------------------------------------------------------------

export const notificationSettings = pgTable(
  "notification_settings",
  {
    /** FK → user.id — constraint added in step 2. */
    userId: text("user_id").notNull(),
    /** See notifications spec event catalog. */
    eventType: text("event_type").notNull(),
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.userId, t.eventType] })],
);

/** Outbox pattern; a pg-boss worker drains it. */
export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    eventType: text("event_type").notNull(),
    subject: text("subject").notNull(),
    bodyHtml: text("body_html").notNull(),
    /** 'suppressed' = user opted out via notification_settings (workflow events). */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** Last send attempt — drives exponential backoff in the drain worker. */
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    createdAt: createdAt(),
    /** Set on success. */
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow(),
    /**
     * PAY-208 (D-A): an explicit recipient that overrides the user-id lookup
     * — used only for the sign-in-email-change notice to the OLD address.
     * PII: never logged, never returned by an API, set to null once the
     * message is sent or fails for good.
     */
    recipientEmail: text("recipient_email"),
  },
  (t) => [
    check(
      "email_outbox_status_check",
      sql`${t.status} IN ('pending','sent','failed','suppressed')`,
    ),
    index("email_outbox_status_idx").on(t.status),
  ],
);

/** Device fingerprints seen at login — drives security_login_new_device (spec 6). */
export const userDevices = pgTable(
  "user_devices",
  {
    userId: text("user_id").notNull(),
    /** SHA-256 of (user-agent + IP /24). */
    fingerprint: text("fingerprint").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.fingerprint] })],
);

// ---------------------------------------------------------------------------
// 6. Audit (payroll-grade, from day one)
// ---------------------------------------------------------------------------

export const authEvents = pgTable("auth_events", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  userId: text("user_id"),
  /** login_success, login_failure, mfa_pass, mfa_fail, password_change, invite_created, session_revoked, ... */
  event: text("event").notNull(),
  ip: inet("ip"),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
});

/** Admin mutations to payroll-critical config. */
export const auditEvents = pgTable("audit_events", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  actorId: text("actor_id").notNull(),
  /** e.g. compensation.update, tax_config.upsert, run.approve */
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// 7. Future-designed (D10): schema only, no UI in v1
// ---------------------------------------------------------------------------

export const timeOff = pgTable(
  "time_off",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    date: date("date").notNull(),
    type: text("type").notNull(),
    note: text("note").default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("time_off_employee_date_uniq").on(t.employeeId, t.date),
    check("time_off_type_check", sql`${t.type} IN ('sick','vacation','holiday','other')`),
  ],
);

// ---------------------------------------------------------------------------
// 8. Spec 10 — 1099 contractors (classification & tax-forms layer)
// ---------------------------------------------------------------------------

/**
 * 1:1 with employees where employment_type='1099' (spec 10 §1). tax_status is
 * STATUS, not location: a US citizen abroad is still 'us_person'. tin is
 * encrypted at rest like employees.tax_id. form_expires_at for w8ben/w8ben_e
 * is computed app-side (collected + 3 calendar years); w9 has no expiry.
 */
export const contractorDetails = pgTable(
  "contractor_details",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    taxStatus: text("tax_status").notNull(),
    entityType: text("entity_type").notNull(),
    /** ISO-3166; required app-side when tax_status='nonresident'. */
    residenceCountry: text("residence_country"),
    /** SSN/EIN/foreign TIN — encrypted at rest (app-level AES-256-GCM). */
    tin: text("tin"),
    taxForm: text("tax_form").notNull(),
    /** NULL = form outstanding (blocks payment, spec 10 §4). */
    formCollectedAt: date("form_collected_at"),
    formExpiresAt: date("form_expires_at"),
    /** TRUE → withhold 24% (missing/incorrect TIN, IRS notice). */
    backupWithholding: boolean("backup_withholding").notNull().default(false),
    /** Contractor's assertion of where work is physically performed. */
    servicesLocation: text("services_location").notNull().default("foreign"),
    /** [{year, days, note}] — sourcing documentation; presence of US days triggers 1042-S review. */
    usDaysLog: jsonb("us_days_log").notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("contractor_details_employee_uniq").on(t.employeeId),
    check(
      "contractor_details_tax_status_check",
      sql`${t.taxStatus} IN ('us_person','nonresident')`,
    ),
    check("contractor_details_entity_type_check", sql`${t.entityType} IN ('individual','entity')`),
    check(
      "contractor_details_tax_form_check",
      sql`${t.taxForm} IN ('w9','w8ben','w8ben_e','w8eci')`,
    ),
    check(
      "contractor_details_services_location_check",
      sql`${t.servicesLocation} IN ('foreign','us','mixed')`,
    ),
  ],
);

/**
 * Spec 12 §1 — recurring invoice templates (1099 only, enforced app-side).
 * invoice_day: 'last_day' = invoice dated the last day of the month;
 * 'fixed' = dated invoice_day_of_month (≤28, no February edge cases).
 * pay_day_of_month is the day of the FOLLOWING month the payment is due.
 * last_generated_period ("YYYY-MM") is the generation guard column (spec §2);
 * the unique partial index on contractor_invoices is the hard belt.
 */
export const contractorRecurringInvoices = pgTable(
  "contractor_recurring_invoices",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    /** e.g. 'Monthly retainer — {month}' ({month}/{year} interpolated at generation). */
    description: text("description").notNull(),
    amount: money("amount").notNull(),
    currency: text("currency").notNull().default("USD"),
    invoiceDay: text("invoice_day").notNull().default("last_day"),
    /** Required when invoice_day='fixed'; NULL otherwise (app-side). */
    invoiceDayOfMonth: integer("invoice_day_of_month"),
    payDayOfMonth: integer("pay_day_of_month").notNull(),
    active: boolean("active").notNull().default(true),
    /** First period to generate for. */
    startsOn: date("starts_on").notNull(),
    /** Contract end; NULL = open-ended. Last period generated, then retires. */
    endsOn: date("ends_on"),
    /** "YYYY-MM" of the last period generated — idempotency guard. */
    lastGeneratedPeriod: text("last_generated_period"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("contractor_recurring_invoices_amount_check", sql`${t.amount} > 0`),
    check(
      "contractor_recurring_invoices_invoice_day_check",
      sql`${t.invoiceDay} IN ('last_day','fixed')`,
    ),
    check(
      "contractor_recurring_invoices_invoice_day_of_month_check",
      sql`${t.invoiceDayOfMonth} BETWEEN 1 AND 28`,
    ),
    check(
      "contractor_recurring_invoices_pay_day_of_month_check",
      sql`${t.payDayOfMonth} BETWEEN 1 AND 28`,
    ),
  ],
);

/**
 * Contractors are paid against INVOICES, not periods (spec 10 §2) — separate
 * from payroll_runs: no snapshot, no engine, no payslip. Status transitions
 * are guarded app-side: submitted→approved|rejected, approved→paid, any→void
 * (void requires a note; paid is otherwise terminal).
 *
 * Spec 12 §4: nullable recurring_template_id (+ recurring_period "YYYY-MM")
 * marks scheduler-generated invoices; manual invoices leave both NULL. The
 * partial unique index guarantees one generated invoice per template per
 * period — the idempotency belt under re-runs and double ticks.
 */
export const contractorInvoices = pgTable(
  "contractor_invoices",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    /** Contractor's own reference/number. */
    invoiceRef: text("invoice_ref"),
    description: text("description").notNull(),
    amount: money("amount").notNull(),
    /** v1: recorded as USD at payment. */
    currency: text("currency").notNull().default("USD"),
    invoiceDate: date("invoice_date").notNull(),
    status: text("status").notNull().default("submitted"),
    /** user.id if contractor self-submits (D16 deferred); NULL = admin-entered. */
    submittedBy: text("submitted_by"),
    /** review_* doubles as void bookkeeping (who/when/note). */
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    /** Spec 12: set when generated by a recurring template; NULL = manual. */
    recurringTemplateId: integer("recurring_template_id").references(
      () => contractorRecurringInvoices.id,
    ),
    /** Spec 12: "YYYY-MM" the invoice was generated for. */
    recurringPeriod: text("recurring_period"),
    createdAt: createdAt(),
  },
  (t) => [
    check("contractor_invoices_amount_check", sql`${t.amount} > 0`),
    check(
      "contractor_invoices_status_check",
      sql`${t.status} IN ('submitted','approved','rejected','paid','void')`,
    ),
    uniqueIndex("contractor_invoices_recurring_period_uniq")
      .on(t.recurringTemplateId, t.recurringPeriod)
      .where(sql`${t.recurringTemplateId} IS NOT NULL`),
  ],
);

/**
 * 1:1 with contractor_invoices in v1 (one payment settles one invoice).
 * method drives the 1099-NEC carve-out: card/third_party_network payments are
 * EXCLUDED from the payer's 1099-NEC (the processor files 1099-K).
 */
export const contractorPayments = pgTable(
  "contractor_payments",
  {
    id: serial("id").primaryKey(),
    invoiceId: integer("invoice_id")
      .notNull()
      .references(() => contractorInvoices.id),
    payDate: date("pay_date").notNull(),
    /** USD actually paid. */
    amount: money("amount").notNull(),
    /** NULL if the invoice was already USD. */
    exchangeRate: numeric("exchange_rate", { precision: 12, scale: 6 }),
    method: text("method").notNull(),
    /** 24% of amount when contractor_details.backup_withholding. */
    backupWithheld: money("backup_withheld").notNull().default("0"),
    /** Check #, wire ref, transaction id. */
    reference: text("reference"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("contractor_payments_invoice_uniq").on(t.invoiceId),
    check(
      "contractor_payments_method_check",
      sql`${t.method} IN ('ach','check','wire','card','third_party_network')`,
    ),
  ],
);

/**
 * Dated 1099-NEC reporting thresholds (spec 10 §3) — same versioned-config
 * pattern as tax_config, never a hardcoded constant. Seeded $600 through
 * 2025, $2,000 for 2026 (OBBBA, inflation-indexed annually from 2027);
 * admin-editable per year. Lookup: exact year, else latest earlier row.
 */
export const contractorReportingConfig = pgTable(
  "contractor_reporting_config",
  {
    id: serial("id").primaryKey(),
    taxYear: integer("tax_year").notNull(),
    necThreshold: money("nec_threshold").notNull(),
    /** e.g. statutory source / indexing note. */
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("contractor_reporting_config_year_uniq").on(t.taxYear)],
);

// ---------------------------------------------------------------------------
// 8b. PAY-9 — monthly federal tax deposits (admin tracking, record-only)
// ---------------------------------------------------------------------------

/**
 * One row per (jurisdiction, period): the monthly depositor's Form 941 deposit
 * for the month — employee federal_withholding + social_security + medicare +
 * employer_social_security + employer_medicare across ISSUED payroll runs with
 * pay_date in the period (employer_futa is Form 940 territory, excluded).
 * jurisdiction is 'federal' today; state codes activate with PAY-13.
 *
 * period_start is the first of the deposit month (same date-typed period
 * convention as payroll_runs). amount is recomputed from issued-run entries
 * while status='pending' so a late-issued run corrects it; once 'deposited'
 * the row is the frozen record (EFTPS confirmation + deposit date).
 *
 * reminders_sent records which configured days-before-due offsets have already
 * fired (e.g. [5, 0]) — the daily sweep never double-mails.
 */
export const taxDeposits = pgTable(
  "tax_deposits",
  {
    id: serial("id").primaryKey(),
    jurisdiction: text("jurisdiction").notNull().default("federal"),
    /** First of the deposit month ("2026-08-01" = the August deposit). */
    periodStart: date("period_start").notNull(),
    amount: money("amount").notNull().default("0"),
    /** 15th of the following month, rolled forward off weekends. */
    dueDate: date("due_date").notNull(),
    status: text("status").notNull().default("pending"),
    depositedOn: date("deposited_on"),
    eftpsConfirmation: text("eftps_confirmation"),
    /** Days-before-due offsets already mailed (dedupe belt for the sweep). */
    remindersSent: jsonb("reminders_sent").notNull().default(sql`'[]'::jsonb`),
    /** 'scheduler' or user.id. */
    createdBy: text("created_by"),
    /**
     * PAY-91 (spec 23 D1): 'month' | 'quarter', stored at write time. Every
     * row written before migration 0022 is 'month' (D7 backfill).
     */
    periodKind: text("period_kind").notNull().default("month"),
    /** Set iff status = 'superseded' (the row was replaced by a period transition). */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    /**
     * PAY-193 L3 (D9.6): 0 for a period's first row; a shortfall row for the
     * same period takes max(seq of its live rows) + 1. Rows before 0026 are 0.
     */
    seq: smallint("seq").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * Spec 23 D2 + PAY-193 D9.6: one LIVE row per (jurisdiction, period_start,
     * period_kind, seq); superseded rows are kept for audit and may share a key.
     */
    uniqueIndex("tax_deposits_live_period_seq_uniq")
      .on(t.jurisdiction, t.periodStart, t.periodKind, t.seq)
      .where(sql`${t.status} <> 'superseded'`),
    check(
      "tax_deposits_status_check",
      sql`${t.status} IN ('pending','deposited','overdue','superseded')`,
    ),
    check("tax_deposits_period_kind_check", sql`${t.periodKind} IN ('month','quarter')`),
    check(
      "tax_deposits_quarter_start_check",
      sql`${t.periodKind} = 'month' OR extract(month from ${t.periodStart}) IN (1,4,7,10)`,
    ),
    check(
      "tax_deposits_federal_month_check",
      sql`${t.jurisdiction} <> 'federal' OR ${t.periodKind} = 'month'`,
    ),
    check(
      "tax_deposits_superseded_check",
      sql`(${t.status} = 'superseded') = (${t.supersededAt} IS NOT NULL) AND (${t.status} <> 'superseded' OR ${t.depositedOn} IS NULL)`,
    ),
    check("tax_deposits_amount_nonneg_check", sql`${t.amount} >= 0`),
    check("tax_deposits_seq_check", sql`${t.seq} >= 0`),
  ],
);

/**
 * Generic admin-editable app settings (key → JSONB value). Introduced for
 * PAY-9's deposit reminder offsets (key 'tax_deposit_reminder_offsets',
 * value int[] of days-before-due); a missing row means the code default.
 * company stays the org PROFILE — knobs that are not profile data live here.
 */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// 8c. PAY-10 — quarterly Form 941 filings (worksheet + tracking, record-only)
// ---------------------------------------------------------------------------

/**
 * One row per (form_type, year, quarter): a filing the company must make.
 * '941' is quarterly (quarter 1-4); annual forms ('940', 'w2_w3') use
 * quarter 0. Status flow: not_started → ready (quarter ended, worksheet
 * computed) → filed (admin records date + method + reference, e.g. the
 * Letterstream Job ID). Record-only: the app never files; the admin files
 * by mail/e-file and records it here.
 *
 * worksheet is the frozen line-by-line 941 computation (JSON) and
 * worksheet_hash its SHA-256 — figures are provably derived from issued-run
 * entry snapshots, recomputed while unfiled, never rewritten once filed.
 * fractions_of_cents (Form 941 line 7) defaults to the computed delta and is
 * admin-editable while unfiled (D4). reminders_sent dedupes the due-date
 * sweep exactly like tax_deposits.
 */
export const taxFilings = pgTable(
  "tax_filings",
  {
    id: serial("id").primaryKey(),
    formType: text("form_type").notNull(),
    year: integer("year").notNull(),
    /** 1-4 for quarterly forms; 0 for annual forms. */
    quarter: integer("quarter").notNull().default(0),
    dueDate: date("due_date").notNull(),
    status: text("status").notNull().default("not_started"),
    /** Frozen line-by-line worksheet (JSON), recomputed while unfiled. */
    worksheet: jsonb("worksheet"),
    /** SHA-256 of the canonical worksheet JSON. */
    worksheetHash: text("worksheet_hash"),
    /** Form 941 line 7 — admin-editable, defaults to the computed delta. */
    fractionsOfCents: money("fractions_of_cents").notNull().default("0"),
    filedOn: date("filed_on"),
    /** e.g. 'letterstream'. */
    filingMethod: text("filing_method"),
    /** e.g. the Letterstream Job ID. */
    filingReference: text("filing_reference"),
    /** Days-before-due offsets already mailed (dedupe belt for the sweep). */
    remindersSent: jsonb("reminders_sent").notNull().default(sql`'[]'::jsonb`),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("tax_filings_form_year_quarter_uniq").on(t.formType, t.year, t.quarter),
    check("tax_filings_form_type_check", sql`${t.formType} IN ('941','940','w2_w3')`),
    check("tax_filings_quarter_check", sql`${t.quarter} BETWEEN 0 AND 4`),
    check("tax_filings_status_check", sql`${t.status} IN ('not_started','ready','filed')`),
  ],
);

/**
 * PAY-10/D3: per-filing notice / penalty / interest records (the CP220
 * lesson) — notices arrive, get partially abated, and are paid separately
 * from deposits. Linked to the filing they belong to; amount_paid feeds the
 * worksheet's line-13 reconciliation so the quarter view matches the actual
 * IRS account state.
 */
export const taxAdjustments = pgTable(
  "tax_adjustments",
  {
    id: serial("id").primaryKey(),
    filingId: integer("filing_id")
      .notNull()
      .references(() => taxFilings.id, { onDelete: "cascade" }),
    /** Notice kind, e.g. 'CP220', 'CP161', 'penalty', 'interest', 'other'. */
    kind: text("kind").notNull(),
    noticeDate: date("notice_date"),
    amountDue: money("amount_due").notNull().default("0"),
    abatedAmount: money("abated_amount").notNull().default("0"),
    amountPaid: money("amount_paid").notNull().default("0"),
    paidOn: date("paid_on"),
    eftpsConfirmation: text("eftps_confirmation"),
    note: text("note").notNull().default(""),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("tax_adjustments_filing_idx").on(t.filingId)],
);

/**
 * PAY-24: confirmation/evidence documents uploaded to a tax filing (e.g. the
 * SSA BSO receipt PDF for a W-2/W-3 submission, an IRS e-file acknowledgment,
 * or the Letterstream proof). These are EXTERNAL record documents, so the
 * "data is truth, PDFs on demand" rule does not apply — the file itself is
 * stored. `data` is AES-256-GCM ciphertext (iv|tag|ct, same key as
 * tax_id/bank_details) because confirmations can carry the EIN.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const filingAttachments = pgTable(
  "filing_attachments",
  {
    id: serial("id").primaryKey(),
    filingId: integer("filing_id")
      .notNull()
      .references(() => taxFilings.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    /** Plaintext byte size of the original upload (for display). */
    sizeBytes: integer("size_bytes").notNull(),
    /** AES-256-GCM ciphertext of the file bytes. */
    data: bytea("data").notNull(),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("filing_attachments_filing_idx").on(t.filingId)],
);

/**
 * PAY-27: EFTPS payment confirmation documents (acknowledgment PDFs /
 * receipts) uploaded to a tax deposit — the documentary evidence behind the
 * deposit row's eftps_confirmation number (PAY-9). Same storage doctrine as
 * filing_attachments: external record document, bytes stored as AES-256-GCM
 * ciphertext (iv|tag|ct) because confirmations can carry the EIN.
 */
export const depositAttachments = pgTable(
  "deposit_attachments",
  {
    id: serial("id").primaryKey(),
    depositId: integer("deposit_id")
      .notNull()
      .references(() => taxDeposits.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    /** Plaintext byte size of the original upload (for display). */
    sizeBytes: integer("size_bytes").notNull(),
    /** AES-256-GCM ciphertext of the file bytes. */
    data: bytea("data").notNull(),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("deposit_attachments_deposit_idx").on(t.depositId)],
);

// ---------------------------------------------------------------------------
// 9. Step-2: setup tokens (spec 3 — invite/reset machinery)
// ---------------------------------------------------------------------------

/**
 * Single-use setup tokens for invites and admin-initiated password resets.
 * Only the SHA-256 hash of the plaintext token is stored; tokens expire ≤ 24h.
 * userId references Better Auth's user.id (FK appended in migration 0003, since
 * auth-owned tables are invisible to drizzle-kit generate).
 */
export const setupTokens = pgTable(
  "setup_tokens",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** SHA-256 hex of the plaintext token. */
    tokenHash: text("token_hash").notNull(),
    purpose: text("purpose").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("setup_tokens_token_hash_uniq").on(t.tokenHash),
    check("setup_tokens_purpose_check", sql`${t.purpose} IN ('invite','reset')`),
    index("setup_tokens_user_id_idx").on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// 10. Step-6: legacy migration ledger (spec 9 — migration & cutover)
// ---------------------------------------------------------------------------

/**
 * Idempotency ledger for the one-time legacy import from an external legacy
 * database (`accounting` schema). Every migrated row is recorded
 * as (entity, source_id) → target_id so re-running `pnpm migrate:legacy` is a
 * no-op, and so migrated rows stay distinguishable from app-created rows for
 * audit/rollback. The table is app-owned but written ONLY by the migration
 * CLI — never by the runtime.
 */
export const legacyMigrationMap = pgTable(
  "legacy_migration_map",
  {
    id: serial("id").primaryKey(),
    /** 'company' | 'employee' | 'compensation' | 'w4' | 'tax_config' | 'tax_brackets' | 'run' */
    entity: text("entity").notNull(),
    /** Source primary key as text (e.g. accounting.payroll_runs.id). */
    sourceId: text("source_id").notNull(),
    /** Target primary key as text (run: payroll_runs.id). */
    targetId: text("target_id").notNull(),
    migratedAt: timestamp("migrated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [unique("legacy_migration_map_entity_source_uniq").on(t.entity, t.sourceId)],
);

// ---------------------------------------------------------------------------
// 11. PAY-19: W-2 electronic-delivery consent (26 CFR 31.6051-1(j); IRS Pub
//     15-A (2026), "Furnishing Form W-2 to employees electronically")
// ---------------------------------------------------------------------------

/**
 * One row per employee: blanket consent to receive Form W-2 electronically
 * instead of on paper, covering every tax year until withdrawn. Withdrawal
 * sets withdrawn_at and re-gates the self-service PDF (the row is kept as
 * the consent history). disclosure_version pins the exact disclosure text
 * the employee agreed to; the paper-copy route stays open regardless
 * (admin prints the packet for non-consenting employees).
 */
export const w2DeliveryConsents = pgTable(
  "w2_delivery_consents",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    /**
     * Version string of the disclosure text shown at consent time. PAY-208:
     * a "2025-01" consent covers tax years before 2026 only; from 2026 the
     * version must be in W2_CONSENT_VERSIONS_FROM_2026 (re-consent).
     */
    disclosureVersion: text("disclosure_version").notNull(),
    consentedAt: timestamp("consented_at", { withTimezone: true }).notNull().defaultNow(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("w2_delivery_consents_employee_uniq").on(t.employeeId)],
);

/**
 * PAY-206: one row per W-2 furnishing event — the employee could hold a copy
 * with these figures from `furnished_at`. Append-only (trigger in migration
 * 0027). `boxes_hash` = w2BoxesHash over boxes 1-6 in cents; it never leaves
 * the database (no API body, log, email or audit payload).
 */
export const w2Furnishings = pgTable(
  "w2_furnishings",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    taxYear: integer("tax_year").notNull(),
    boxesHash: text("boxes_hash").notNull(),
    hashVersion: smallint("hash_version").notNull().default(1),
    corrected: boolean("corrected").notNull(),
    /** portal_notice | employee_download | admin_print | paper_handed | backfill */
    method: text("method").notNull(),
    /** Auth user id for admin/employee actions; null for the scheduler. */
    actorId: text("actor_id"),
    furnishedAt: timestamp("furnished_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("w2_furnishings_employee_year_idx").on(t.employeeId, t.taxYear, t.furnishedAt),
    check("w2_furnishings_tax_year_check", sql`${t.taxYear} BETWEEN 2020 AND 2100`),
    check("w2_furnishings_boxes_hash_check", sql`${t.boxesHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "w2_furnishings_method_check",
      sql`${t.method} IN ('portal_notice','employee_download','admin_print','paper_handed','backfill')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 12. PAY-13 phase 1 — per-state income-tax withholding
// ---------------------------------------------------------------------------

/**
 * Effective-dated, per-year state withholding config — the state mirror of
 * tax_config. jurisdiction is the USPS state code ('IL', 'CA', 'TX') or
 * '<state>:<filing_status>' for status-specific parameter sets (CA publishes
 * separate tables per marital status); resolution falls back
 * '<state>:<status>' → '<state>' exactly like 'federal:<status>' → 'federal'.
 *
 * kind:
 *  - 'none'        — EXPLICIT zero-tax jurisdiction (TX). A row, not an
 *                    absence: unconfigured states fail run generation loudly
 *                    instead of silently withholding $0.
 *  - 'flat'        — flat rate on the allowance-reduced wage base (IL).
 *  - 'progressive' — bracket walk over state_tax_brackets (CA).
 *
 * Generic allowance semantics (which fields a state uses depends on its form):
 *  - allowanceDeduction            annual wage-base deduction per REGULAR
 *                                  allowance (IL-W-4 line 1: $2,925 in 2026)
 *  - allowanceCredit               annual after-bracket credit per REGULAR
 *                                  allowance (CA DE 4: $168.30 in 2026)
 *  - additionalAllowanceDeduction  annual wage-base deduction per ADDITIONAL
 *                                  (estimated-deduction) allowance (CA DE 4
 *                                  item 2 / IL-W-4 line 2: $1,000 both)
 *  - standardDeduction             annual deduction before brackets (CA)
 *  - standardDeductionAlt + altMinAllowances — CA's married split: the alt
 *    standard deduction / low-income exemption applies when regular
 *    allowances >= altMinAllowances (married claiming 2+)
 *  - lowIncomeExemption[_Alt]      annual wage floor: at or below it, nothing
 *                                  is withheld (CA)
 */
export const stateTaxConfigs = pgTable(
  "state_tax_configs",
  {
    id: serial("id").primaryKey(),
    jurisdiction: text("jurisdiction").notNull(),
    taxYear: integer("tax_year").notNull(),
    kind: text("kind").notNull(),
    flatRate: rate("flat_rate"),
    standardDeduction: money("standard_deduction"),
    standardDeductionAlt: money("standard_deduction_alt"),
    altMinAllowances: integer("alt_min_allowances"),
    lowIncomeExemption: money("low_income_exemption"),
    lowIncomeExemptionAlt: money("low_income_exemption_alt"),
    allowanceDeduction: money("allowance_deduction"),
    allowanceCredit: money("allowance_credit"),
    additionalAllowanceDeduction: money("additional_allowance_deduction"),
    /** Statutory source (e.g. 'EDD 2026 Method B, 26methb.pdf'). */
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("state_tax_configs_jurisdiction_year_uniq").on(t.jurisdiction, t.taxYear),
    check("state_tax_configs_kind_check", sql`${t.kind} IN ('none','flat','progressive')`),
  ],
);

/** Per-jurisdiction, per-year state brackets — the mirror of tax_brackets. */
export const stateTaxBrackets = pgTable(
  "state_tax_brackets",
  {
    id: serial("id").primaryKey(),
    jurisdiction: text("jurisdiction").notNull(),
    taxYear: integer("tax_year").notNull(),
    ordinal: integer("ordinal").notNull(),
    minAmount: money("min_amount").notNull(),
    /** NULL = open top bracket. */
    maxAmount: money("max_amount"),
    rate: rate("rate").notNull(),
  },
  (t) => [
    unique("state_tax_brackets_jurisdiction_year_ordinal_uniq").on(
      t.jurisdiction,
      t.taxYear,
      t.ordinal,
    ),
  ],
);

/**
 * Spec 25 (PAY-120) closed locality lists, as SQL for the CHECK constraints.
 * Must equal LOCALITY_CODES / WORK_LOCALITY_CODES in @payroll/shared (a test
 * inserts every shared code). NYC taxes residents only: never a work locality.
 */
const MD_LOCALITY_SQL = sql.raw(
  "'MD-001','MD-003','MD-005','MD-009','MD-011','MD-013','MD-015','MD-017','MD-019','MD-021','MD-023','MD-025'," +
    "'MD-027','MD-029','MD-031','MD-033','MD-035','MD-037','MD-039','MD-041','MD-043','MD-045','MD-047','MD-510'",
);

/**
 * The employee's WORK state, effective-dated (state income tax follows the
 * work location). V1: a single work state per employee — the resolver picks
 * the latest row effective on the period start; multi-state allocation is a
 * phase-2 concern.
 *
 * PAY-163: `locality_code` is the taxing work locality (Yonkers, or the
 * Maryland county). NULL means "no taxing work locality" ONLY when
 * `locality_confirmed_at` is set; rows written before PAY-163 are NULL and
 * unconfirmed.
 */
export const employeeWorkStates = pgTable(
  "employee_work_states",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    /** USPS 2-letter code, uppercase. */
    stateCode: text("state_code").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    /** NULL = open-ended. */
    effectiveTo: date("effective_to"),
    createdAt: createdAt(),
    localityCode: text("locality_code"),
    localityConfirmedAt: timestamp("locality_confirmed_at", { withTimezone: true }),
    /** user.id of the admin who answered the work-locality question. */
    localityConfirmedBy: text("locality_confirmed_by"),
  },
  (t) => [
    unique("employee_work_states_employee_effective_uniq").on(t.employeeId, t.effectiveFrom),
    check("employee_work_states_code_check", sql`${t.stateCode} ~ '^[A-Z]{2}$'`),
    check(
      "employee_work_states_locality_check",
      sql`${t.localityCode} IS NULL OR (${t.localityCode} LIKE ${t.stateCode} || '-%' AND ${t.localityCode} IN ('NY-YONKERS',${MD_LOCALITY_SQL}))`,
    ),
    check(
      "employee_work_states_locality_confirmed_check",
      sql`${t.localityCode} IS NULL OR ${t.localityConfirmedAt} IS NOT NULL`,
    ),
  ],
);

/**
 * PAY-163 (Spec 25) — where the employee lives for local income tax,
 * effective-dated and resolved on the PAY date. The home address is only a
 * hint (ZIP codes cross locality lines); this row is the fact the local-tax
 * guard reads. Codes are plaintext by design (county/city level, needed for
 * grouping); the full address stays encrypted on `employees.address`.
 *
 * Windows are [effective_from, effective_to); an exclusion constraint (raw
 * SQL in the migration) makes overlapping windows for one employee
 * impossible. `source`: 'admin' (entered by an admin) or 'certificate' (set
 * from a local withholding certificate — later step).
 */
export const employeeResidences = pgTable(
  "employee_residences",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    /** ISO 3166-1 alpha-2. */
    country: text("country").notNull(),
    /** USPS code; set exactly when country = 'US'. */
    stateCode: text("state_code"),
    /** One of LOCALITY_CODES, inside `state_code`; required for Maryland. */
    localityCode: text("locality_code"),
    effectiveFrom: date("effective_from").notNull(),
    /** NULL = open-ended. */
    effectiveTo: date("effective_to"),
    source: text("source").notNull().default("admin"),
    /** user.id of the admin who wrote the row. */
    createdBy: text("created_by").notNull(),
    createdAt: createdAt().notNull(),
  },
  (t) => [
    unique("employee_residences_employee_effective_uniq").on(t.employeeId, t.effectiveFrom),
    check("employee_residences_country_check", sql`${t.country} ~ '^[A-Z]{2}$'`),
    check(
      "employee_residences_us_state_check",
      sql`(${t.country} = 'US') = (${t.stateCode} IS NOT NULL)`,
    ),
    check(
      "employee_residences_state_code_check",
      sql`${t.stateCode} IS NULL OR ${t.stateCode} ~ '^[A-Z]{2}$'`,
    ),
    check(
      "employee_residences_locality_check",
      sql`${t.localityCode} IS NULL OR ${t.localityCode} IN ('NY-NYC','NY-YONKERS',${MD_LOCALITY_SQL})`,
    ),
    check(
      "employee_residences_locality_state_check",
      sql`${t.localityCode} IS NULL OR (${t.stateCode} IS NOT NULL AND ${t.localityCode} LIKE ${t.stateCode} || '-%')`,
    ),
    check(
      "employee_residences_md_county_check",
      sql`${t.stateCode} IS DISTINCT FROM 'MD' OR ${t.localityCode} IS NOT NULL`,
    ),
    check(
      "employee_residences_window_check",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
    check("employee_residences_source_check", sql`${t.source} IN ('admin','certificate')`),
  ],
);

/**
 * PAY-163 (Spec 25) — which states / localities have local income tax the
 * employer must withhold, and whether the app computes it ('engine') or must
 * hold the pay run ('unsupported'). Data, maintained by the state/local
 * payroll SME in seeds/local-taxes/coverage.json and loaded by the seed CLI.
 * `code` is a USPS state ('OH') or a locality code ('NY-NYC'); `basis` says
 * whether living there or working there triggers it. A state with no row has
 * no local income tax the employer withholds.
 */
export const localTaxCoverage = pgTable(
  "local_tax_coverage",
  {
    code: text("code").notNull(),
    basis: text("basis").notNull(),
    handling: text("handling").notNull(),
    note: text("note").notNull().default(""),
    /** Official source the row was checked against. */
    source: text("source").notNull().default(""),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "local_tax_coverage_pk", columns: [t.code, t.basis] }),
    check("local_tax_coverage_code_check", sql`${t.code} ~ '^[A-Z]{2}(-[A-Z0-9]{2,10})?$'`),
    check("local_tax_coverage_basis_check", sql`${t.basis} IN ('residence','work')`),
    check("local_tax_coverage_handling_check", sql`${t.handling} IN ('unsupported','engine')`),
  ],
);

/**
 * Generic per-state withholding elections, effective-dated like the federal
 * W-4 (w4_elections): latest row effective on the period start wins. Fields
 * are the union of IL-W-4 and DE 4 concepts (see stateTaxConfigs); states
 * ignore the fields they don't use. Exempt zeroes state withholding only.
 */
export const stateWithholdingElections = pgTable(
  "state_withholding_elections",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    stateCode: text("state_code").notNull(),
    filingStatus: text("filing_status").notNull().default("single"),
    /** Regular allowances (IL-W-4 line 1 / DE 4 item 1). */
    allowances: integer("allowances").notNull().default(0),
    /** Estimated-deduction allowances (DE 4 item 2 / IL-W-4 line 2). */
    additionalAllowances: integer("additional_allowances").notNull().default(0),
    /** Flat per-period add-on (IL-W-4 line 3 / DE 4 item 3). */
    extraWithholding: money("extra_withholding").notNull().default("0"),
    exempt: boolean("exempt").notNull().default(false),
    /**
     * NOT retroactive — applies to payments for pay periods ending on or after
     * this date (selected as of min(period end, pay date); Spec 26 (PAY-173) D3).
     */
    effectiveFrom: date("effective_from").notNull(),
    filedDate: date("filed_date").notNull(),
    note: text("note").default(""),
    createdAt: createdAt(),
  },
  (t) => [
    unique("state_withholding_elections_employee_state_effective_uniq").on(
      t.employeeId,
      t.stateCode,
      t.effectiveFrom,
    ),
    check(
      "state_withholding_elections_status_check",
      sql`${t.filingStatus} IN ('single','married_joint','married_separate','head_of_household')`,
    ),
    check("state_withholding_elections_allowances_check", sql`${t.allowances} >= 0`),
    check("state_withholding_elections_additional_check", sql`${t.additionalAllowances} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// 13. PAY-48 — per-state deposit due-date schedules
// ---------------------------------------------------------------------------

export const stateDepositSchedules = pgTable(
  "state_deposit_schedules",
  {
    id: serial("id").primaryKey(),
    stateCode: text("state_code").notNull(),
    taxYear: integer("tax_year").notNull(),
    frequency: text("frequency").notNull(),
    dueDay: integer("due_day"),
    note: text("note").notNull().default(""),
    source: text("source").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("state_deposit_schedules_state_year_uniq").on(t.stateCode, t.taxYear),
    check("state_deposit_schedules_state_code_check", sql`${t.stateCode} ~ '^[A-Z]{2}$'`),
    check(
      "state_deposit_schedules_frequency_check",
      sql`${t.frequency} IN ('monthly','quarterly')`,
    ),
  ],
);

/**
 * Spec 24 (PAY-116) — the employer's state withholding account number, per
 * state and first tax year. The W-2 for tax year Y uses the row with the
 * greatest `from_tax_year` ≤ Y (box 15). IL and NY fall back to the company
 * EIN at render time when no row applies; that default is never copied
 * here. `state_id` is encrypted at rest ("enc:v1:", field-encryption.ts)
 * and write-only: API reads, audit rows and the UI see a mask only. The
 * encrypted CHECK makes a plaintext write fail in the database: 39 is the
 * base64url length of the smallest ciphertext (12-byte IV + 16-byte tag +
 * 1 byte).
 */
export const companyStateIds = pgTable(
  "company_state_ids",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => company.id),
    stateCode: text("state_code").notNull(),
    /** First tax year this ID applies to; W-2 for year Y uses max(from_tax_year) ≤ Y. */
    fromTaxYear: integer("from_tax_year").notNull(),
    /** Employer state account number — encrypted at rest ("enc:v1:"), write-only. Spec 24 (PAY-116). */
    stateId: text("state_id").notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("company_state_ids_company_state_year_uniq").on(t.companyId, t.stateCode, t.fromTaxYear),
    check("company_state_ids_state_code_check", sql`${t.stateCode} ~ '^[A-Z]{2}$'`),
    check("company_state_ids_year_check", sql`${t.fromTaxYear} BETWEEN 2000 AND 2100`),
    check("company_state_ids_encrypted_check", sql`${t.stateId} ~ '^enc:v1:[A-Za-z0-9_-]{39,}$'`),
  ],
);

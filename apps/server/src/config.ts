/**
 * Server configuration — env-driven, secrets read as FILES from SECRETS_DIR
 * (spec 8: secrets are never env values).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBrandName, parseDisplayName } from "@payroll/shared";

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: string;
  /**
   * Deployment environment label (spec 14): "qa" enables the QA banner + the
   * QA-only mailbox endpoint; anything else (incl. unset → "production") is
   * byte-identical to pre-spec-14 behavior.
   */
  appEnv: string;
  logLevel: string;
  /** Display timezone for dates (DB stores TIMESTAMPTZ). */
  appTz: string;
  /** Public base URL of the app (behind NPM proxy in prod). */
  baseUrl: string;
  /**
   * Product name shown in the SPA, emails, and TOTP enrollment (spec 22):
   * BRAND_NAME, default "Wagon Payroll". Validated at boot.
   */
  brandName: string;
  /**
   * TOTP issuer / app name shown in authenticator apps: TOTP_ISSUER when set
   * and non-empty, else brandName (spec 22 D3).
   */
  totpIssuer: string;
  /** Directory holding secret files: db-password, smtp-password, encryption-key, session-secret. */
  secretsDir: string;
  /** Resolved session secret (from $SECRETS_DIR/session-secret; dev fallback allowed). */
  sessionSecret: string;
  /** AES-256-GCM key for field-level encryption (bank_details, tax_id, ein). */
  encryptionKey: string;
  /** Mailpit HTTP API base URL — only used by the QA-only mailbox endpoint. */
  mailpitUrl: string;
  /**
   * Read-only export API bearer token (from $SECRETS_DIR/export-token).
   * Absent = export endpoint disabled (503). No dev fallback: an export
   * credential is always an explicit deployment decision.
   */
  exportToken?: string | undefined;
  /** 'smtp' = real sending; 'log' = dev mode: log emails, mark sent (spec 6 dev flag). */
  emailMode: "smtp" | "log";
  db: {
    host: string;
    port: number;
    name: string;
    user: string;
  };
  smtp: {
    host: string;
    port: number;
    user: string;
    from: string;
    /** From $SECRETS_DIR/smtp-password (never an env value); only read when SMTP_USER is set. */
    password?: string | undefined;
    /** true = implicit TLS (port 465-style); false = STARTTLS/plain per port. */
    secure: boolean;
  };
}

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

/** Read a secret from $SECRETS_DIR/<name>; returns undefined when absent (dev tolerance). */
export function readSecret(
  config: Pick<AppConfig, "secretsDir">,
  name: string,
): string | undefined {
  try {
    return readFileSync(join(config.secretsDir, name), "utf8").trim();
  } catch {
    return undefined;
  }
}

/**
 * APP_TZ sets the company-local "today" for the issue-time pay-date check
 * (Spec 26 (PAY-173) D9). An invalid zone fails boot instead of failing
 * every issue.
 */
function assertTimeZone(zone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new Error(
      `APP_TZ "${zone}" is not a valid IANA time zone (for example "America/New_York")`,
    );
  }
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const secretsDir = env("SECRETS_DIR", "./secrets");
  const nodeEnv = env("NODE_ENV", "development");
  const brandName = parseBrandName(process.env.BRAND_NAME);
  // Validated like BRAND_NAME (spec 22 D1/D3); an invalid value fails boot.
  const envTotpIssuer = parseDisplayName(process.env.TOTP_ISSUER, "TOTP_ISSUER");
  const base: Omit<AppConfig, "totpIssuer"> = {
    port: Number(env("PORT", "8927")),
    host: env("HOST", "0.0.0.0"),
    nodeEnv,
    appEnv: env("APP_ENV", "production"),
    logLevel: env("LOG_LEVEL", "info"),
    appTz: env("APP_TZ", "Europe/Madrid"),
    baseUrl: env("BASE_URL", `http://localhost:${Number(env("PORT", "8927"))}`),
    brandName,
    secretsDir,
    // In production the session secret MUST come from the secrets dir; in dev
    // a fixed fallback keeps local iteration sane (logged loudly at boot).
    sessionSecret:
      readSecret({ secretsDir }, "session-secret") ??
      (nodeEnv === "production"
        ? (() => {
            throw new Error("session-secret missing from SECRETS_DIR in production");
          })()
        : "dev-only-insecure-session-secret"),
    encryptionKey:
      readSecret({ secretsDir }, "encryption-key") ??
      (nodeEnv === "production"
        ? (() => {
            throw new Error("encryption-key missing from SECRETS_DIR in production");
          })()
        : "dev-only-insecure-encryption-key-0123456789abcdef"),
    exportToken: readSecret({ secretsDir }, "export-token"),
    mailpitUrl: env("MAILPIT_URL", "http://localhost:8025"),
    db: {
      host: env("DB_HOST", "localhost"),
      port: Number(env("DB_PORT", "5432")),
      name: env("DB_NAME", "payroll"),
      user: env("DB_USER", "payroll"),
    },
    smtp: {
      host: env("SMTP_HOST"),
      port: Number(env("SMTP_PORT", "587")),
      user: env("SMTP_USER"),
      from: env("SMTP_FROM"),
      // The smtp-password secret file is only read when SMTP auth is actually
      // configured (SMTP_USER set). Targets without credentials — e.g. QA's
      // Mailpit, which takes no auth — need no /run/secrets/smtp-password at
      // all. When SMTP_USER IS set the behavior is unchanged (prod identical).
      password: env("SMTP_USER") ? readSecret({ secretsDir }, "smtp-password") : undefined,
      secure: env("SMTP_SECURE", "false") === "true",
    },
    // Dev mode without SMTP: log emails instead of sending (spec 6 config flag).
    emailMode: ((): "smtp" | "log" => {
      const mode = env("EMAIL_MODE");
      if (mode === "smtp" || mode === "log") return mode;
      return env("SMTP_HOST") ? "smtp" : "log";
    })(),
  };
  const merged = { ...base, ...overrides };
  assertTimeZone(merged.appTz);
  // The issuer follows the MERGED brand name (so a brandName override moves it
  // too) unless TOTP_ISSUER or an explicit totpIssuer override is set.
  return { ...merged, totpIssuer: overrides.totpIssuer ?? envTotpIssuer ?? merged.brandName };
}

/** Assemble the postgres connection URL; password from the secrets dir (or dev default). */
export function databaseUrl(config: AppConfig, password?: string): string {
  const pw = password ?? readSecret(config, "db-password") ?? "payroll";
  return `postgres://${config.db.user}:${encodeURIComponent(pw)}@${config.db.host}:${config.db.port}/${config.db.name}`;
}

/** True when SMTP is configured enough to attempt sending (step 4 wires actual sending). */
export function smtpConfigured(config: AppConfig): boolean {
  return Boolean(config.smtp.host && config.smtp.from);
}

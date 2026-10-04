/**
 * Field-level encryption at rest (spec data-model cross-cutting): AES-256-GCM
 * with the SECRETS_DIR-mounted key, for bank_details / tax_id / company.ein.
 * Format: "enc:v1:<base64url(iv|tag|ciphertext)>" — self-describing, so
 * plaintext legacy rows remain readable (decryptField passes them through).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

function keyBytes(key: string): Buffer {
  // Any-length secret → 32-byte key (documented dev fallback is 64 hex chars;
  // hashing normalizes both).
  return createHash("sha256").update(key, "utf8").digest();
}

let appKey: string | null = null;

/**
 * Spec 24 (PAY-116) PR-3 R1: register the running app's field key (buildApp,
 * once per app). Read-only paths that predate a key parameter — the W-2
 * readiness checks behind isMyW2Ready / yearW2BlockCodes / the W-2 list —
 * read it through fieldKey(). The key already lives in the app's config for
 * the whole process; this adds no copy outside memory.
 */
export function registerFieldKey(key: string): void {
  appKey = key;
}

/** The registered field key; throws (fail closed) when no app registered one. */
export function fieldKey(): string {
  if (appKey === null) throw new Error("field encryption key not registered");
  return appKey;
}

export function encryptField(plaintext: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64url");
}

export function decryptField(value: string, key: string): string {
  if (!value.startsWith(PREFIX)) return value; // plaintext legacy tolerance
  const raw = Buffer.from(value.slice(PREFIX.length), "base64url");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/**
 * Binary siblings for bytea storage (PAY-24 filing attachments) — same
 * AES-256-GCM, same iv|tag|ct layout as the "enc:v1:" string format, minus
 * the prefix/base64 (the column type is self-describing).
 */
export function encryptBytes(plaintext: Buffer, key: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decryptBytes(value: Buffer, key: string): Buffer {
  const iv = value.subarray(0, 12);
  const tag = value.subarray(12, 28);
  const ct = value.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** "••••1234" — decrypts when needed, tolerates plaintext, never throws on shape. */
export function maskLast4(value: string | null | undefined, key: string): string | null {
  if (!value) return null;
  try {
    const plain = decryptField(value, key);
    return `••••${plain.slice(-4)}`;
  } catch {
    return "••••????";
  }
}

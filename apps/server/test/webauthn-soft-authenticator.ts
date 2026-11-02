/**
 * PAY-259 PR 3 test helper: a software WebAuthn authenticator (ES256, "none"
 * attestation) that produces RegistrationResponseJSON and
 * AuthenticationResponseJSON the way a browser would, so the passkey
 * endpoints can be driven end to end without a real device.
 *
 * - Key pair: node:crypto P-256, generated per authenticator (synthetic).
 * - COSE key {1:2, 3:-7, -1:1, -2:x, -3:y}, CBOR-encoded by a minimal local
 *   encoder (maps, ints, byte/text strings only).
 * - authData = sha256(rpID) | flags | signCount (4 BE) | [aaguid | len | credId | coseKey].
 * - Flags: UP 0x01, UV 0x04 (toggle), BE 0x08 / BS 0x10 (optional), AT 0x40.
 * - Assertion signature: ECDSA-SHA256 (DER) over authData | sha256(clientDataJSON).
 *
 * Never log or snapshot what this produces: tests compare values, never print them.
 */

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

// ---------------------------------------------------------------- CBOR

type CborValue = number | string | Uint8Array | CborMap;
type CborMap = Map<number | string, CborValue>;

function cborHead(major: number, n: number): Buffer {
  const m = major << 5;
  if (n < 24) return Buffer.from([m | n]);
  if (n < 0x100) return Buffer.from([m | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = m | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = m | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

/** Minimal CBOR encoder: unsigned/negative ints, byte strings, text strings, maps. */
export function cborEncode(value: CborValue): Buffer {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("cbor: integers only");
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([cborHead(2, value.length), Buffer.from(value)]);
  }
  const parts: Buffer[] = [cborHead(5, value.size)];
  for (const [k, v] of value) {
    parts.push(cborEncode(k), cborEncode(v));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- base64url

export function b64url(data: Uint8Array | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return buf.toString("base64url");
}

function sha256(data: Uint8Array | string): Buffer {
  return createHash("sha256").update(data).digest();
}

// ---------------------------------------------------------------- types

export interface RegistrationResponseJSON {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports: string[];
  };
  clientExtensionResults: Record<string, never>;
  authenticatorAttachment: "platform";
}

export interface AuthenticationResponseJSON {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
  clientExtensionResults: Record<string, never>;
  authenticatorAttachment: "platform";
}

/** The parts of PublicKeyCredentialCreation/RequestOptionsJSON the authenticator reads. */
export interface CeremonyOptions {
  challenge: string;
  rp?: { id?: string };
  rpId?: string;
  user?: { id?: string };
}

export interface CeremonyOverrides {
  /** User verification flag (default true). */
  uv?: boolean;
  /** User presence flag (default true). */
  up?: boolean;
  /** signCount written into authData (registration default 0; assertion default previous + 1). */
  signCount?: number;
  /** clientDataJSON.origin (default the authenticator's origin). */
  origin?: string;
  /** RP ID hashed into authData (default: options rp id, else the authenticator's). */
  rpId?: string;
  /** clientDataJSON.challenge (default the options challenge). */
  challenge?: string;
  /** clientDataJSON.type (default webauthn.create / webauthn.get). */
  clientDataType?: string;
  /** Credential id put on the JSON (default the real one). */
  id?: string;
  /** PublicKeyCredential.type on the JSON (default "public-key"). */
  credentialType?: string;
  backupEligible?: boolean;
  backedUp?: boolean;
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

// ---------------------------------------------------------------- authenticator

export class SoftAuthenticator {
  readonly credentialId: Buffer;
  readonly aaguid: Buffer = Buffer.alloc(16);
  private readonly privateKey: KeyObject;
  private readonly coseKey: Buffer;
  /** Last signCount this authenticator emitted. */
  signCount = 0;
  /** user.id (base64url) from the registration options, returned as userHandle. */
  userHandle: string | undefined;

  constructor(
    readonly rpId: string,
    readonly origin: string,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    const x = Buffer.from(jwk.x!, "base64url");
    const y = Buffer.from(jwk.y!, "base64url");
    this.coseKey = cborEncode(
      new Map<number, CborValue>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, x],
        [-3, y],
      ]),
    );
    this.credentialId = randomBytes(32);
  }

  /** base64url credential id (= passkey."credentialID" after registration). */
  get id(): string {
    return b64url(this.credentialId);
  }

  /** The COSE public key as Better Auth stores it (passkey."publicKey": standard base64). */
  get storedPublicKey(): string {
    return this.coseKey.toString("base64");
  }

  private authData(rpId: string, flags: number, signCount: number, attested: boolean): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(signCount >>> 0, 0);
    const parts = [sha256(rpId), Buffer.from([flags]), counter];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length, 0);
      parts.push(this.aaguid, len, this.credentialId, this.coseKey);
    }
    return Buffer.concat(parts);
  }

  private flags(o: CeremonyOverrides, attested: boolean): number {
    let f = 0;
    if (o.up !== false) f |= FLAG_UP;
    if (o.uv !== false) f |= FLAG_UV;
    if (o.backupEligible) f |= FLAG_BE;
    if (o.backedUp) f |= FLAG_BS;
    if (attested) f |= FLAG_AT;
    return f;
  }

  private clientData(type: string, options: CeremonyOptions, o: CeremonyOverrides): string {
    return JSON.stringify({
      type: o.clientDataType ?? type,
      challenge: o.challenge ?? options.challenge,
      origin: o.origin ?? this.origin,
      crossOrigin: false,
    });
  }

  /** navigator.credentials.create() equivalent. */
  register(options: CeremonyOptions, o: CeremonyOverrides = {}): RegistrationResponseJSON {
    const rpId = o.rpId ?? options.rp?.id ?? this.rpId;
    const signCount = o.signCount ?? 0;
    this.signCount = signCount;
    this.userHandle = options.user?.id;
    const clientDataJSON = this.clientData("webauthn.create", options, o);
    const authData = this.authData(rpId, this.flags(o, true), signCount, true);
    const attestationObject = cborEncode(
      new Map<string, CborValue>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    const id = o.id ?? this.id;
    return {
      id,
      rawId: id,
      type: (o.credentialType ?? "public-key") as "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** navigator.credentials.get() equivalent. */
  assert(options: CeremonyOptions, o: CeremonyOverrides = {}): AuthenticationResponseJSON {
    const rpId = o.rpId ?? options.rpId ?? this.rpId;
    const signCount = o.signCount ?? this.signCount + 1;
    this.signCount = signCount;
    const clientDataJSON = this.clientData("webauthn.get", options, o);
    const authData = this.authData(rpId, this.flags(o, false), signCount, false);
    const signature = sign(
      "sha256",
      Buffer.concat([authData, sha256(clientDataJSON)]),
      this.privateKey,
    );
    const id = o.id ?? this.id;
    return {
      id,
      rawId: id,
      type: (o.credentialType ?? "public-key") as "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        ...(this.userHandle ? { userHandle: this.userHandle } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}

// ---------------------------------------------------------------- cookies

/**
 * The raw "name=value" pair of the cookie `name` in a Set-Cookie list, not
 * URL-decoded, ready to send back in a Cookie header. Null when absent.
 */
export function rawCookiePair(
  setCookies: string | string[] | undefined,
  name: string,
): string | null {
  if (!setCookies) return null;
  const list = Array.isArray(setCookies) ? setCookies : [setCookies];
  for (const c of list) {
    const pair = c.split(";")[0]!.trim();
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq) === name) return pair;
  }
  return null;
}

/** Better Auth's passkey challenge cookie with cookiePrefix "payroll" (non-secure). */
export const PASSKEY_CHALLENGE_COOKIE = "payroll.better-auth-passkey";

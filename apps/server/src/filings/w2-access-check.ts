/**
 * PAY-208 D-B (federal SME minimum design; 26 CFR 31.6051-1(j)(2)(i): consent
 * "in any manner that reasonably demonstrates that the recipient can access
 * the Form W-2 in the electronic format in which it will be furnished"):
 * the access-check codes behind the "Open test PDF" step.
 *
 * Each test PDF gets a new random code (A-Z/2-9 without look-alikes), held
 * server-side bound to the employee — one pending code per employee, so a
 * new test PDF replaces the previous code. A code works once, for
 * CODE_TTL_MS, compared case-insensitively; after MAX_FAILURES wrong
 * attempts it is dropped and a new test PDF is needed. Only a SHA-256 of the
 * code is kept; the code itself exists only inside the PDF bytes — never in
 * a JSON body, URL, header, file name, audit row or log line.
 *
 * In memory, per app instance: a restart drops pending codes (the employee
 * opens the test PDF again). The app runs as one process.
 */

import { createHash, randomInt, timingSafeEqual } from "node:crypto";

/** No 0/O, 1/I/L: nothing a reader can confuse. */
export const ACCESS_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ACCESS_CODE_LENGTH = 6;
/** About 30 minutes. */
export const CODE_TTL_MS = 30 * 60 * 1000;
/** Wrong attempts before the code stops working. */
export const MAX_FAILURES = 5;

interface Pending {
  digest: Buffer;
  expiresAt: number;
  failures: number;
}

function digestOf(code: string): Buffer {
  return createHash("sha256").update(code.trim().toUpperCase()).digest();
}

export interface AccessCodeStore {
  /** A new code for the employee (replaces any pending one). */
  issue(employeeId: number): string;
  /**
   * True when `code` is the employee's pending, unexpired code — then it is
   * used up. A wrong code counts a failure; the MAX_FAILURES-th drops it.
   */
  consume(employeeId: number, code: unknown): boolean;
}

export function createAccessCodeStore(now: () => number = Date.now): AccessCodeStore {
  const pending = new Map<number, Pending>();

  function prune(): void {
    const t = now();
    for (const [id, p] of pending) if (p.expiresAt <= t) pending.delete(id);
  }

  return {
    issue(employeeId) {
      prune();
      let code = "";
      for (let i = 0; i < ACCESS_CODE_LENGTH; i += 1) {
        code += ACCESS_CODE_ALPHABET[randomInt(ACCESS_CODE_ALPHABET.length)];
      }
      pending.set(employeeId, {
        digest: digestOf(code),
        expiresAt: now() + CODE_TTL_MS,
        failures: 0,
      });
      return code;
    },
    consume(employeeId, code) {
      const p = pending.get(employeeId);
      if (p === undefined || typeof code !== "string" || code.length > 64) return false;
      if (p.expiresAt <= now()) {
        pending.delete(employeeId);
        return false;
      }
      if (timingSafeEqual(digestOf(code), p.digest)) {
        pending.delete(employeeId);
        return true;
      }
      p.failures += 1;
      if (p.failures >= MAX_FAILURES) pending.delete(employeeId);
      return false;
    },
  };
}

/**
 * Chromium virtual authenticator over CDP (PAY-259 spec §9, E2E).
 *
 * `addVirtualAuthenticator(page)` gives the page a platform-style passkey
 * authenticator: CTAP2, internal transport, resident keys, user verification
 * on and passing, presence simulated so no prompt blocks the test.
 *
 * S11: never log credential material. `credentials()` returns what the
 * authenticator holds so a test can COUNT it; do not print ids, keys or
 * user handles, and do not attach them to the report.
 */

import type { CDPSession, Page } from "@playwright/test";

export interface VirtualAuthenticator {
  cdp: CDPSession;
  authenticatorId: string;
  /** Credentials the authenticator holds. Count them; never log them (S11). */
  credentials(): Promise<unknown[]>;
  /** Make the next ceremony report user verification as passed or failed. */
  setUserVerified(isUserVerified: boolean): Promise<void>;
  /** Remove the authenticator and detach the CDP session. */
  remove(): Promise<void>;
}

/** Attach a passing, user-verifying virtual authenticator to `page` (chromium only). */
export async function addVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    cdp,
    authenticatorId,
    async credentials() {
      const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
      return credentials;
    },
    async setUserVerified(isUserVerified: boolean) {
      await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified });
    },
    async remove() {
      await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
      await cdp.detach();
    },
  };
}

/** What {@link holdPasskeyAutofill} adds to the page's window. */
interface AutofillHold {
  __e2eAutofillRequests: number;
  __e2eReleaseAutofill: () => number;
}

/**
 * Hold the page's passkey autofill (conditional mediation) requests.
 *
 * Why: with `automaticPresenceSimulation`, Chrome's virtual authenticator
 * answers a conditional request at once, as if the user had picked the
 * passkey from the email field's suggestions (probed 2026-11-03, chromium
 * 1243). Left alone, every visit to /login would sign in by itself before a
 * test could click anything. A real user who ignores the suggestions leaves
 * the request pending; this reproduces that.
 *
 * Every `navigator.credentials.get({ mediation: "conditional" })` is counted
 * and held. It rejects with the signal's reason when the page aborts it (a
 * button ceremony aborts the autofill one, as a real browser does). The page
 * function `__e2eReleaseAutofill()` sends the held requests on to the browser
 * unchanged: the stand-in for the user picking the passkey, which is browser
 * UI no test can click. Other `get` calls pass straight through.
 *
 * Call before the first navigation (an init script runs on every page load).
 */
export async function holdPasskeyAutofill(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const container = navigator.credentials;
    const original = container.get.bind(container);
    const held: Array<() => void> = [];
    const hold = window as unknown as AutofillHold;
    hold.__e2eAutofillRequests = 0;
    hold.__e2eReleaseAutofill = () => {
      const pending = held.splice(0);
      for (const send of pending) send();
      return pending.length;
    };
    container.get = (options?: CredentialRequestOptions) => {
      if (options?.mediation !== "conditional") return original(options);
      hold.__e2eAutofillRequests++;
      return new Promise<Credential | null>((resolve, reject) => {
        const signal = options.signal;
        const aborted = () =>
          reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        if (signal?.aborted) return aborted();
        signal?.addEventListener("abort", aborted, { once: true });
        held.push(() => {
          if (signal?.aborted) return;
          signal?.removeEventListener("abort", aborted);
          original(options).then(resolve, reject);
        });
      });
    };
  });
}

/** How many autofill requests the page has made since it loaded. */
export function autofillRequests(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as AutofillHold).__e2eAutofillRequests ?? 0);
}

/** Send the held autofill requests to the browser; returns how many there were. */
export function releaseAutofill(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as AutofillHold).__e2eReleaseAutofill?.() ?? 0);
}

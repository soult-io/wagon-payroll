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

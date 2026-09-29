/**
 * PAY-173 review, LOW 6: APP_TZ drives the issue-time "today" (Spec 26 D9).
 * An invalid IANA zone must fail startup with a clear message, not make every
 * issue return 500.
 */

import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const saved = process.env.APP_TZ;

afterEach(() => {
  if (saved === undefined) delete process.env.APP_TZ;
  else process.env.APP_TZ = saved;
});

describe("APP_TZ validation at config load", () => {
  it("accepts a valid IANA zone and the default", () => {
    process.env.APP_TZ = "America/Chicago";
    expect(loadConfig().appTz).toBe("America/Chicago");
    delete process.env.APP_TZ;
    expect(loadConfig().appTz).toBe("Europe/Madrid");
  });

  it("rejects an invalid zone from the environment", () => {
    process.env.APP_TZ = "Mars/Olympus_Mons";
    expect(() => loadConfig()).toThrow(/APP_TZ.*Mars\/Olympus_Mons.*IANA/);
  });

  it("rejects an invalid zone from an override", () => {
    delete process.env.APP_TZ;
    expect(() => loadConfig({ appTz: "not a zone" })).toThrow(/APP_TZ/);
  });
});

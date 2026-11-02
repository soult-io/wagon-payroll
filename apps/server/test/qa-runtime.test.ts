/**
 * Spec 14 runtime config: the public /api/runtime-config endpoint (appEnv
 * label + spec 22 brand name only, unauthenticated) and the smtp-password
 * secret being optional when SMTP auth is not configured (QA's Mailpit takes
 * no credentials).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createTestApp, type TestContext } from "./helpers.js";

describe("GET /api/runtime-config", () => {
  let ctx: TestContext;
  let qaCtx: TestContext;

  afterAll(async () => {
    await ctx?.close();
    await qaCtx?.close();
  });

  it("is unauthenticated and returns the env label only (default: production)", async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({ method: "GET", url: "/api/runtime-config" });
    expect(res.statusCode).toBe(200);
    // Exact key set (spec 22 D2): the env label and the display name, nothing else.
    expect(res.json()).toEqual({
      appEnv: "production",
      brandName: "Wagon Payroll",
      passkeysAvailable: true,
    });
  });

  it("reports APP_ENV=qa when configured", async () => {
    qaCtx = await createTestApp({ appEnv: "qa" });
    const res = await qaCtx.app.inject({ method: "GET", url: "/api/runtime-config" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      appEnv: "qa",
      brandName: "Wagon Payroll",
      passkeysAvailable: true,
    });
  });

  it("reports an operator-set brand name (spec 22 D2)", async () => {
    const brandCtx = await createTestApp({ brandName: "Acme Payroll" });
    try {
      const res = await brandCtx.app.inject({ method: "GET", url: "/api/runtime-config" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        appEnv: "production",
        brandName: "Acme Payroll",
        passkeysAvailable: true,
      });
    } finally {
      await brandCtx.close();
    }
  });
});

describe("smtp-password secret optionality", () => {
  const secretsDir = mkdtempSync(join(tmpdir(), "payroll-qa-config-"));

  afterAll(() => {
    rmSync(secretsDir, { recursive: true, force: true });
  });

  function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(env)) {
      saved[key] = process.env[key];
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    try {
      fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("does not require /run/secrets/smtp-password when SMTP_USER is unset (Mailpit-style)", () => {
    withEnv(
      {
        SECRETS_DIR: secretsDir,
        SMTP_USER: undefined,
        SMTP_HOST: "mailpit",
        SMTP_FROM: "qa@example.test",
      },
      () => {
        // No smtp-password file exists at all — load must still succeed.
        const config = loadConfig();
        expect(config.smtp.user).toBe("");
        expect(config.smtp.password).toBeUndefined();
      },
    );
  });

  it("still reads the secret file when SMTP_USER is set (prod behavior unchanged)", () => {
    writeFileSync(join(secretsDir, "smtp-password"), "prod-smtp-secret\n");
    withEnv({ SECRETS_DIR: secretsDir, SMTP_USER: "payroll@example.com" }, () => {
      const config = loadConfig();
      expect(config.smtp.password).toBe("prod-smtp-secret");
    });
  });
});

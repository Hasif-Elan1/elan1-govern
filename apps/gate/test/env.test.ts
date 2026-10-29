import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readGateEnv } from "../src/env";

const base = { ...process.env };
afterEach(() => {
  process.env.APP_ENV = base.APP_ENV;
});

describe("startup config", () => {
  it("fails when a secret is missing", () => {
    const { GATE_MASTER_KEY: _drop, ...rest } = base;
    expect(() => readGateEnv(rest)).toThrow(/GATE_MASTER_KEY is required/);
    expect(() => readGateEnv({ ...base, GATE_MASTER_KEY: "" })).toThrow(/GATE_MASTER_KEY is required/);
  });
  it("fails when a secret is weak", () => {
    expect(() => readGateEnv({ ...base, INTERNAL_API_SECRET: "changeme" })).toThrow(/64 hex characters/);
    expect(() => readGateEnv({ ...base, INTERNAL_API_SECRET: "ab".repeat(32) })).toThrow(/looks weak/);
  });
  it("refuses the .env.example secrets in production", () => {
    expect(() => readGateEnv(base)).not.toThrow();
    process.env.APP_ENV = "production";
    expect(() => readGateEnv(base)).toThrow(/example value from .env.example/);
    const fresh = "0123456789abcdef".repeat(4);
    const real = { ...base, GATE_MASTER_KEY: fresh, INTERNAL_API_SECRET: fresh.split("").reverse().join(""), APPROVAL_LINK_SECRET: `fedcba98${fresh.slice(8)}` };
    expect(() => readGateEnv(real)).not.toThrow();
  });
  it("refuses the sample console demo password in production, and allows none", () => {
    const fresh = "0123456789abcdef".repeat(4);
    const real = { ...base, GATE_MASTER_KEY: fresh, INTERNAL_API_SECRET: fresh.split("").reverse().join(""), APPROVAL_LINK_SECRET: `fedcba98${fresh.slice(8)}` };
    const example = readFileSync(resolve(__dirname, "../../../.env.example"), "utf8");
    const sample = example.split("\n").find((l) => l.startsWith("DEMO_CONSOLE_PASSWORD="))!.slice("DEMO_CONSOLE_PASSWORD=".length);
    expect(sample.length).toBeGreaterThanOrEqual(12);
    process.env.APP_ENV = "production";
    expect(() => readGateEnv({ ...real, DEMO_CONSOLE_PASSWORD: sample, APP_ENV: "production" })).toThrow(/DEMO_CONSOLE_PASSWORD is the example value/);
    expect(() => readGateEnv({ ...real, DEMO_CONSOLE_PASSWORD: "a real demo password", APP_ENV: "production" })).not.toThrow();
    expect(() => readGateEnv({ ...real, DEMO_CONSOLE_PASSWORD: undefined, APP_ENV: "production" })).not.toThrow();
    expect(() => readGateEnv({ ...real, DEMO_CONSOLE_PASSWORD: "short", APP_ENV: "development" })).toThrow(/at least 12/);
  });
});

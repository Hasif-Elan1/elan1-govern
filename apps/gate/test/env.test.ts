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
});

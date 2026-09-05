import { describe, expect, it } from "vitest";
import { createReleaseConfig, readReleaseInputs } from "./config.mjs";

const environment = {
  VITE_AUTH_BROKER_URL: "https://auth.subtrack.app/functions/v1/auth-broker",
  VITE_SUPABASE_URL: "https://subtrack-live.supabase.co",
  VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_abcdefghijklmnopqrstuvwxyz",
};
const { base, capability } = readReleaseInputs();
const build = (changes = {}) =>
  createReleaseConfig({ ...environment, ...changes }, base, capability);

describe("installer configuration", () => {
  it("aligns independent broker/data hosts without inheriting placeholder permissions", () => {
    const config = build();
    const security = config.app.security;
    expect(security.csp).toContain("https://auth.subtrack.app");
    expect(security.csp).toContain("https://subtrack-live.supabase.co");
    expect(security.csp).not.toMatch(/replace-me|unsafe-eval|\*/);
    expect(security.capabilities).toHaveLength(1);
    expect(security.capabilities[0].permissions).toContainEqual({
      identifier: "opener:allow-open-url",
      allow: [
        {
          url: "https://auth.subtrack.app/functions/v1/auth-broker/v1/desktop/authorize?*",
        },
      ],
    });
    expect(JSON.stringify(config)).not.toContain(
      environment.VITE_SUPABASE_PUBLISHABLE_KEY,
    );
    expect(base.app.security.csp).toContain("replace-me");
  });

  it.each([
    undefined,
    "http://auth.subtrack.app",
    "https://replace-me.supabase.co",
    "https://auth.subtrack.app/?secret=sensitive",
    "https://user:password@auth.subtrack.app",
    "https://auth.subtrack.app/#fragment",
    "https://auth.subtrack.app:8443",
    "https://auth.subtrack.app/path/*",
    "https://auth.subtrack.app/path/%22",
  ])("rejects an unsafe broker without printing its value (%#)", (url) => {
    expect(() => build({ VITE_AUTH_BROKER_URL: url })).toThrow(
      /VITE_AUTH_BROKER_URL/,
    );
    try {
      build({ VITE_AUTH_BROKER_URL: url });
    } catch (error) {
      expect(error.message).not.toMatch(/sensitive|password@/);
    }
  });

  it("rejects paths on the data origin", () => {
    expect(() =>
      build({ VITE_SUPABASE_URL: "https://subtrack-live.supabase.co/rest/v1" }),
    ).toThrow(/VITE_SUPABASE_URL/);
  });

  it.each([
    "sb_secret_abcdefghijklmnopqrstuvwxyz",
    "service_role",
    "eyJhbGciOiJIUzI1NiJ9",
    "sb_publishable_replace_me",
    "",
  ])("rejects secret, legacy, and placeholder keys (%#)", (key) => {
    expect(() => build({ VITE_SUPABASE_PUBLISHABLE_KEY: key })).toThrow(
      /publishable key/,
    );
  });

  it("normalizes trailing slashes without broadening the authorize path", () => {
    const config = build({
      VITE_AUTH_BROKER_URL: environment.VITE_AUTH_BROKER_URL + "/",
    });
    expect(JSON.stringify(config)).toContain(
      "/auth-broker/v1/desktop/authorize?*",
    );
    expect(JSON.stringify(config)).not.toContain("/auth-broker//");
  });

  it("rejects an unversioned desktop", () => {
    expect(() =>
      createReleaseConfig(
        environment,
        { ...base, version: "0.0.0" },
        capability,
      ),
    ).toThrow(/release version/);
  });
});

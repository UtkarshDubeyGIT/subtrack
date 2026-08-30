import { describe, expect, it } from "vitest";
import { loadBrokerConfig } from "./config";

const valid = {
  AUTH_BROKER_ALLOWED_ORIGINS: "tauri://localhost,http://tauri.localhost",
  AUTH_BROKER_CLEANUP_SECRET: "cleanup-secret-at-least-thirty-two-bytes",
  AUTH_BROKER_HASH_KEY: "hash-secret-at-least-thirty-two-bytes-long",
  AUTH_BROKER_PUBLIC_URL:
    "https://project.supabase.co/functions/v1/auth-broker",
  AUTH_BROKER_REDIRECT_ALLOWLIST: "subtrack://auth/callback",
  CLERK_FRONTEND_API_URL: "https://example.clerk.accounts.dev",
  CLERK_OAUTH_CLIENT_ID: "oauth_client_123",
  CLERK_OAUTH_CLIENT_SECRET: "replace-at-deploy",
  CLERK_SECRET_KEY: "replace-at-deploy",
  SUPABASE_SERVICE_ROLE_KEY: "replace-at-deploy",
  SUPABASE_URL: "https://project.supabase.co",
};

describe("broker configuration", () => {
  it("loads exact server-only origins and redirect allowlist", () => {
    expect(loadBrokerConfig(valid)).toMatchObject({
      allowedOrigins: ["tauri://localhost", "http://tauri.localhost"],
      brokerPublicUrl: "https://project.supabase.co/functions/v1/auth-broker",
      clerkCallbackUrl:
        "https://project.supabase.co/functions/v1/auth-broker/v1/desktop/callback",
      redirectAllowlist: ["subtrack://auth/callback"],
    });
  });

  it.each([
    { ...valid, AUTH_BROKER_HASH_KEY: "short" },
    { ...valid, AUTH_BROKER_PUBLIC_URL: "http://broker.example" },
    {
      ...valid,
      AUTH_BROKER_PUBLIC_URL: "https://user:pass@broker.example/path",
    },
    {
      ...valid,
      AUTH_BROKER_PUBLIC_URL: "https://broker.example/functions/%2e%2e/private",
    },
    {
      ...valid,
      AUTH_BROKER_REDIRECT_ALLOWLIST:
        "subtrack://auth/callback,https://evil.test",
    },
    { ...valid, AUTH_BROKER_ALLOWED_ORIGINS: "*" },
    {
      ...valid,
      AUTH_BROKER_ALLOWED_ORIGINS: "https://user:pass@example.test",
    },
    { ...valid, CLERK_OAUTH_CLIENT_SECRET: "" },
  ])(
    "fails closed without including secret values in the error",
    (candidate) => {
      expect(() => loadBrokerConfig(candidate)).toThrow(
        "invalid_broker_configuration",
      );
      try {
        loadBrokerConfig(candidate);
      } catch (error) {
        expect(String(error)).not.toContain("replace-at-deploy");
      }
    },
  );
});

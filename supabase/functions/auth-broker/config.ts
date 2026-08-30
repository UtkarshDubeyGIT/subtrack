import { z } from "zod";
import type { BrokerOptions } from "./broker.ts";

const required = z.string().min(1).max(4_096);
const secret = z.string().min(32).max(4_096);

export type BrokerConfig = Readonly<{
  allowedOrigins: readonly string[];
  brokerPublicUrl: string;
  cleanupSecret: string;
  clerkBackendApiUrl: string;
  clerkCallbackUrl: string;
  clerkFrontendApiUrl: string;
  clerkOAuthClientId: string;
  clerkOAuthClientSecret: string;
  clerkSecretKey: string;
  options: BrokerOptions;
  redirectAllowlist: readonly string[];
  supabaseServiceRoleKey: string;
  supabaseUrl: string;
}>;

export function loadBrokerConfig(
  environment: Readonly<Record<string, string | undefined>>,
) {
  try {
    const brokerPublicUrl = exactHttpsBaseUrl(
      required.parse(environment.AUTH_BROKER_PUBLIC_URL),
    );
    const clerkFrontendApiUrl = exactHttpsOrigin(
      required.parse(environment.CLERK_FRONTEND_API_URL),
    );
    const supabaseUrl = exactHttpsOrigin(
      required.parse(environment.SUPABASE_URL),
    );
    const redirectAllowlist = required
      .parse(environment.AUTH_BROKER_REDIRECT_ALLOWLIST)
      .split(",")
      .map((value) => value.trim());
    if (
      redirectAllowlist.length === 0 ||
      new Set(redirectAllowlist).size !== redirectAllowlist.length ||
      redirectAllowlist.some((value) => value !== "subtrack://auth/callback")
    ) {
      throw new Error("invalid_redirect_allowlist");
    }
    const allowedOrigins = required
      .parse(environment.AUTH_BROKER_ALLOWED_ORIGINS)
      .split(",")
      .map((value) => value.trim());
    const supportedTauriOrigins = new Set([
      "tauri://localhost",
      "http://tauri.localhost",
    ]);
    if (
      allowedOrigins.length === 0 ||
      new Set(allowedOrigins).size !== allowedOrigins.length ||
      allowedOrigins.some((value) => !supportedTauriOrigins.has(value))
    ) {
      throw new Error("invalid_allowed_origins");
    }
    const hashKey = secret.parse(environment.AUTH_BROKER_HASH_KEY);
    const cleanupSecret = secret.parse(environment.AUTH_BROKER_CLEANUP_SECRET);
    const config: BrokerConfig = {
      allowedOrigins,
      brokerPublicUrl,
      cleanupSecret,
      clerkBackendApiUrl: "https://api.clerk.com/v1",
      clerkCallbackUrl: `${brokerPublicUrl}/v1/desktop/callback`,
      clerkFrontendApiUrl,
      clerkOAuthClientId: required.parse(environment.CLERK_OAUTH_CLIENT_ID),
      clerkOAuthClientSecret: required.parse(
        environment.CLERK_OAUTH_CLIENT_SECRET,
      ),
      clerkSecretKey: required.parse(environment.CLERK_SECRET_KEY),
      options: {
        allowedOrigins,
        accessTokenMaxTtlMs: 5 * 60_000,
        authorizationCodeTtlMs: 60_000,
        authorizationTtlMs: 5 * 60_000,
        hashKey,
        publicBaseUrl: brokerPublicUrl,
        rateLimit: { ipAttempts: 30, transactionAttempts: 5, windowMs: 60_000 },
        redirectAllowlist,
        refreshTtlMs: 30 * 24 * 60 * 60_000,
      },
      redirectAllowlist,
      supabaseServiceRoleKey: required.parse(
        environment.SUPABASE_SERVICE_ROLE_KEY,
      ),
      supabaseUrl,
    };
    return config;
  } catch {
    throw new Error("invalid_broker_configuration");
  }
}

function exactHttpsOrigin(candidate: string) {
  const url = new URL(candidate);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("invalid_origin");
  }
  return url.origin;
}

function exactHttpsBaseUrl(candidate: string) {
  const url = new URL(candidate);
  if (
    candidate !== candidate.trim() ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    candidate.includes("\\") ||
    /%(?:2e|2f|5c)/i.test(candidate) ||
    !safePath(url.pathname)
  ) {
    throw new Error("invalid_base_url");
  }
  return url.pathname === "/"
    ? url.origin
    : `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

function safePath(pathname: string) {
  if (pathname.includes("//")) return false;
  return pathname
    .split("/")
    .filter(Boolean)
    .every(
      (segment) =>
        /^[A-Za-z0-9._~-]+$/.test(segment) &&
        segment !== "." &&
        segment !== "..",
    );
}

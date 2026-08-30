import { beforeEach, describe, expect, it } from "vitest";
import { HttpAuthBroker } from "../../../apps/desktop/src/auth/broker-client";
import {
  AuthBrokerService,
  type BrokerOptions,
  type SecurityEvent,
} from "./broker";
import { FakeIdentityProvider } from "./testing/fake-identity-provider";
import { InMemoryBrokerStore } from "./testing/in-memory-store";

const redirectUri = "subtrack://auth/callback";
const brokerBaseUrl = "https://project.supabase.co/functions/v1/auth-broker";
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const state = "state_123";
let now: number;
let provider: FakeIdentityProvider;
let store: InMemoryBrokerStore;
let events: SecurityEvent[];
let service: AuthBrokerService;

const options: BrokerOptions = {
  allowedOrigins: ["tauri://localhost", "http://tauri.localhost"],
  accessTokenMaxTtlMs: 5 * 60_000,
  authorizationCodeTtlMs: 60_000,
  authorizationTtlMs: 5 * 60_000,
  hashKey: "test-hash-key-with-at-least-thirty-two-bytes",
  publicBaseUrl: brokerBaseUrl,
  rateLimit: { ipAttempts: 10, transactionAttempts: 3, windowMs: 60_000 },
  redirectAllowlist: [redirectUri],
  refreshTtlMs: 30 * 24 * 60 * 60_000,
};

beforeEach(() => {
  now = 1_800_000_000_000;
  provider = new FakeIdentityProvider(() => now);
  store = new InMemoryBrokerStore();
  events = [];
  service = new AuthBrokerService({
    clock: () => now,
    events: {
      record: (event) => {
        events.push(event);
      },
    },
    options,
    provider,
    store,
  });
});

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-real-ip", "203.0.113.9");
  return service.handle(
    new Request(`${brokerBaseUrl}${path}`, { ...init, headers }),
  );
}

async function authorize() {
  const response = await request(
    `/v1/desktop/authorize?state=${state}&code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(redirectUri)}`,
  );
  expect(response.status).toBe(302);
  const providerUrl = new URL(response.headers.get("location")!);
  return providerUrl.searchParams.get("state")!;
}

async function callback(transactionId: string) {
  const response = await request(
    `/v1/desktop/callback?state=${transactionId}&code=provider_valid`,
  );
  expect(response.status).toBe(302);
  const appUrl = new URL(response.headers.get("location")!);
  return {
    code: appUrl.searchParams.get("code")!,
    state: appUrl.searchParams.get("state")!,
  };
}

async function exchange(code: string, codeVerifier = verifier) {
  return request("/v1/desktop/session/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, codeVerifier }),
  });
}

async function establish() {
  const transactionId = await authorize();
  const appCallback = await callback(transactionId);
  const response = await exchange(appCallback.code);
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    accessToken: string;
    expiresAt: number;
    refreshCredential: string;
    subject: string;
  }>;
}

describe("auth broker lifecycle", () => {
  it("completes authorization, single-use PKCE exchange, refresh rotation, and revocation", async () => {
    const first = await establish();
    expect(first).toMatchObject({ subject: "user_123" });
    expect(first.accessToken).toContain("fake-clerk-jwt");

    const refreshed = await request("/v1/desktop/session/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshCredential: first.refreshCredential }),
    });
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as typeof first;
    expect(second.refreshCredential).not.toBe(first.refreshCredential);

    const revoked = await request("/v1/desktop/session/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshCredential: second.refreshCredential }),
    });
    expect(revoked.status).toBe(204);
    expect(provider.revokedSessions).toEqual(["clerk_session_123"]);
    expect(await store.containsRawSecret(first.refreshCredential)).toBe(false);
  });

  it("rejects PKCE mismatch and authorization-code replay with generic errors", async () => {
    const transactionId = await authorize();
    const appCallback = await callback(transactionId);

    const mismatch = await exchange(appCallback.code, "x".repeat(64));
    expect(mismatch.status).toBe(401);
    await expect(mismatch.json()).resolves.toEqual({
      error: "authentication_failed",
    });

    const replayTransaction = await authorize();
    const replayCallback = await callback(replayTransaction);
    const first = await exchange(replayCallback.code);
    expect(first.status).toBe(200);
    const replay = await exchange(replayCallback.code);
    expect(replay.status).toBe(401);
  });

  it("rejects expired authorization codes", async () => {
    const transactionId = await authorize();
    const appCallback = await callback(transactionId);
    now += options.authorizationCodeTtlMs + 1;
    expect((await exchange(appCallback.code)).status).toBe(401);
  });

  it("rejects redirect mismatch and malformed bounded inputs", async () => {
    const mismatch = await request(
      `/v1/desktop/authorize?state=${state}&code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent("subtrack://evil/callback")}`,
    );
    expect(mismatch.status).toBe(400);
    const malformed = await request("/v1/desktop/session/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "x".repeat(2_000), codeVerifier: "short" }),
    });
    expect(malformed.status).toBe(400);
  });

  it("rejects an overlong provider session token", async () => {
    provider.tokenTtlMs = options.accessTokenMaxTtlMs + 1;
    expect((await establishAttempt()).status).toBe(401);
  });

  it("detects rotated credential reuse and revokes the whole family and Clerk session", async () => {
    const first = await establish();
    const refreshed = await request("/v1/desktop/session/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshCredential: first.refreshCredential }),
    });
    const second = (await refreshed.json()) as typeof first;

    expect(
      (
        await request("/v1/desktop/session/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshCredential: first.refreshCredential }),
        })
      ).status,
    ).toBe(401);
    expect(provider.revokedSessions).toContain("clerk_session_123");
    expect(
      (
        await request("/v1/desktop/session/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshCredential: second.refreshCredential }),
        })
      ).status,
    ).toBe(401);
  });

  it("fails closed and revokes the family when Clerk reports a revoked session", async () => {
    const session = await establish();
    provider.revoked = true;
    const response = await request("/v1/desktop/session/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshCredential: session.refreshCredential }),
    });
    expect(response.status).toBe(401);
    expect(events.at(-1)).toMatchObject({
      name: "refresh_rejected",
      reason: "provider_revoked",
    });
  });

  it("keeps an active refresh family retryable when Clerk is temporarily unavailable", async () => {
    const session = await establish();
    provider.unavailable = true;
    const response = await request("/v1/desktop/session/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshCredential: session.refreshCredential }),
    });

    expect(response.status).toBe(503);
    expect(events.at(-1)).toMatchObject({
      name: "refresh_rejected",
      reason: "provider_unavailable",
    });
    provider.unavailable = false;
    const retry = await request("/v1/desktop/session/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshCredential: session.refreshCredential }),
    });
    expect(retry.status).toBe(200);
  });

  it("throttles per IP and per transaction", async () => {
    const limited = new AuthBrokerService({
      clock: () => now,
      events: {
        record: (event) => {
          events.push(event);
        },
      },
      options: {
        ...options,
        rateLimit: { ...options.rateLimit, ipAttempts: 2 },
      },
      provider,
      store,
    });
    const url = `${brokerBaseUrl}/v1/desktop/authorize?state=${state}&code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(redirectUri)}`;
    const init = { headers: { "x-real-ip": "203.0.113.20" } };
    expect((await limited.handle(new Request(url, init))).status).toBe(302);
    expect((await limited.handle(new Request(url, init))).status).toBe(302);
    expect((await limited.handle(new Request(url, init))).status).toBe(429);

    const transactionId = await authorize();
    for (
      let attempt = 0;
      attempt < options.rateLimit.transactionAttempts;
      attempt += 1
    ) {
      expect(
        (
          await request(
            `/v1/desktop/callback?state=${transactionId}&code=provider_invalid_${attempt}`,
          )
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await request(
          `/v1/desktop/callback?state=${transactionId}&code=provider_invalid_final`,
        )
      ).status,
    ).toBe(429);
  });

  it("cleans expired transactions and credentials", async () => {
    await establish();
    now += options.refreshTtlMs + 1;
    await expect(service.cleanup()).resolves.toMatchObject({
      credentials: 1,
      transactions: 1,
    });
  });

  it("records only structured non-sensitive events", async () => {
    const secretCode = "secret-code-never-log";
    await exchange(secretCode, "wrong-verifier-never-log".repeat(3));
    const serialized = JSON.stringify(events);
    expect(serialized).not.toMatch(
      /secret-code|wrong-verifier|203\.0\.113|person@|token/i,
    );
    expect(events.at(-1)).toMatchObject({ name: "exchange_rejected" });
  });

  it("handles approved Tauri preflight with a minimal non-credentialed CORS policy", async () => {
    const response = await service.handle(
      new Request(`${brokerBaseUrl}/v1/desktop/session/exchange`, {
        method: "OPTIONS",
        headers: {
          origin: "tauri://localhost",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "tauri://localhost",
    );
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "POST, OPTIONS",
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "content-type",
    );
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("denies unapproved preflight and never emits wildcard CORS", async () => {
    const response = await service.handle(
      new Request(`${brokerBaseUrl}/v1/desktop/session/refresh`, {
        method: "OPTIONS",
        headers: {
          origin: "https://attacker.example",
          "access-control-request-method": "POST",
        },
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(JSON.stringify([...response.headers])).not.toContain("*");
  });

  it("applies approved CORS to generic client errors but not missing-origin responses", async () => {
    const approved = await request("/v1/desktop/session/exchange", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://tauri.localhost",
      },
      body: "{}",
    });
    expect(approved.status).toBe(400);
    expect(approved.headers.get("access-control-allow-origin")).toBe(
      "http://tauri.localhost",
    );

    const missing = await request("/v1/desktop/session/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(missing.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("desktop client contract", () => {
  it("exchanges, refreshes, and revokes through the existing HttpAuthBroker adapter", async () => {
    const fetcher = (input: string, init: RequestInit) =>
      service.handle(
        new Request(input, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init.headers)),
            "x-real-ip": "203.0.113.40",
          },
        }),
      );
    const desktop = new HttpAuthBroker(brokerBaseUrl, fetcher);
    const transactionId = await authorize();
    const appCallback = await callback(transactionId);
    const established = await desktop.exchange({
      code: appCallback.code,
      codeVerifier: verifier,
    });
    const refreshed = await desktop.refresh(established.refreshCredential);
    expect(refreshed.refreshCredential).not.toBe(established.refreshCredential);
    await expect(
      desktop.revoke(refreshed.refreshCredential),
    ).resolves.toBeUndefined();
  });

  it("preserves a retryable desktop refresh across provider unavailability", async () => {
    const fetcher = (input: string, init: RequestInit) =>
      service.handle(
        new Request(input, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init.headers)),
            "x-real-ip": "203.0.113.41",
          },
        }),
      );
    const desktop = new HttpAuthBroker(brokerBaseUrl, fetcher);
    const established = await establish();
    provider.unavailable = true;

    await expect(
      desktop.refresh(established.refreshCredential),
    ).rejects.toMatchObject({ reason: "transient" });
    provider.unavailable = false;
    await expect(
      desktop.refresh(established.refreshCredential),
    ).resolves.toMatchObject({ subject: "user_123" });
  });
});

async function establishAttempt() {
  const transactionId = await authorize();
  const appCallback = await callback(transactionId);
  return exchange(appCallback.code);
}

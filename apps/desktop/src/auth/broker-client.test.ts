import { describe, expect, it, vi } from "vitest";
import { HttpAuthBroker } from "./broker-client";

const validSession = {
  accessToken: "access-token",
  expiresAt: 2_000_000_000_000,
  refreshCredential: "refresh-credential",
  subject: "user_123",
};

describe("HttpAuthBroker", () => {
  it("exchanges a one-time code through the configured HTTPS broker", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(validSession), { status: 200 }),
    );
    const broker = new HttpAuthBroker(
      "https://auth.example.test/functions/v1/auth-broker",
      fetcher,
    );

    await expect(
      broker.exchange({ code: "one-time-code", codeVerifier: "pkce-verifier" }),
    ).resolves.toEqual(validSession);
    expect(fetcher).toHaveBeenCalledWith(
      "https://auth.example.test/functions/v1/auth-broker/v1/desktop/session/exchange",
      expect.objectContaining({
        body: JSON.stringify({
          code: "one-time-code",
          codeVerifier: "pkce-verifier",
        }),
        method: "POST",
      }),
    );
  });

  it("rejects non-HTTPS endpoints before sending credentials", () => {
    expect(
      () => new HttpAuthBroker("http://auth.example.test", vi.fn()),
    ).toThrow("Auth broker must use HTTPS.");
  });

  it.each([
    "https://user:secret@auth.example.test/functions/v1/auth-broker",
    "https://auth.example.test/functions/v1/auth-broker?token=secret",
    "https://auth.example.test/functions/v1/auth-broker#fragment",
    "https://auth.example.test/functions/%2e%2e/private",
  ])("rejects an unsafe broker base URL %s", (candidate) => {
    expect(() => new HttpAuthBroker(candidate, vi.fn())).toThrow(
      "Invalid auth broker URL.",
    );
  });

  it("rejects malformed broker sessions", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ ...validSession, accessToken: "" }), {
          status: 200,
        }),
    );
    const broker = new HttpAuthBroker("https://auth.example.test", fetcher);

    await expect(
      broker.exchange({ code: "one-time-code", codeVerifier: "pkce-verifier" }),
    ).rejects.toMatchObject({
      reason: "transient",
    });
  });

  it("maps revoked refresh credentials without exposing the response body", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("person@example.com refresh=secret", { status: 401 }),
    );
    const broker = new HttpAuthBroker("https://auth.example.test", fetcher);

    await expect(broker.refresh("refresh-secret")).rejects.toMatchObject({
      reason: "revoked",
      message: "Authentication broker rejected the session.",
    });
  });
});

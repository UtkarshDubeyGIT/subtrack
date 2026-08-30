import { describe, expect, it, vi } from "vitest";
import { IdentityProviderError } from "./contracts";
import { ClerkOAuthProvider } from "./clerk-oauth-provider";

const issuer = "https://example.clerk.accounts.dev";
const callbackUrl = "https://broker.example/v1/desktop/callback";

function jwt(
  claims: object,
  header: object = { alg: "RS256", kid: "key_123", typ: "JWT" },
  signature = "signature",
) {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode(header)}.${encode(claims)}.${signature}`;
}

function standardClaims(overrides: Record<string, unknown> = {}) {
  return {
    exp: 1_800_000_300,
    iat: 1_800_000_000,
    iss: issuer,
    nbf: 1_800_000_000,
    role: "authenticated",
    sid: "sess_123",
    sub: "user_123",
    ...overrides,
  };
}

describe("ClerkOAuthProvider", () => {
  it("uses Clerk's authorization-code endpoint with an exact callback and opaque state", async () => {
    const provider = createProvider(vi.fn());
    const url = new URL(
      await provider.authorizationUrl({
        callbackUrl,
        transactionId: "transaction_123",
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(`${issuer}/oauth/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "oauth_client_123",
      redirect_uri: callbackUrl,
      response_type: "code",
      scope: "openid",
      state: "transaction_123",
    });
  });

  it("exchanges the Clerk code server-side and requires subject/session claims", async () => {
    const oauthToken = jwt({
      aud: "oauth_client_123",
      exp: 1_800_003_600,
      iss: issuer,
      sid: "sess_123",
      sub: "user_123",
    });
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: oauthToken, token_type: "Bearer" }),
          {
            status: 200,
          },
        ),
    );
    const provider = createProvider(fetcher);
    await expect(
      provider.completeAuthorization({
        providerCode: "clerk_code",
        transactionId: "tx_123",
      }),
    ).resolves.toEqual({ providerSessionId: "sess_123", subject: "user_123" });
    expect(fetcher).toHaveBeenCalledWith(
      `${issuer}/oauth/token`,
      expect.objectContaining({
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "clerk_code",
          redirect_uri: callbackUrl,
        }).toString(),
      }),
    );
  });

  it("issues a standard short-lived Clerk session token with the required Supabase role", async () => {
    const access = jwt({
      exp: 1_800_000_300,
      iat: 1_800_000_000,
      iss: issuer,
      nbf: 1_800_000_000,
      role: "authenticated",
      sid: "sess_123",
      sub: "user_123",
    });
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ jwt: access }), { status: 200 }),
    );
    const provider = createProvider(fetcher);
    await expect(
      provider.issueSessionToken("sess_123", "user_123"),
    ).resolves.toEqual({
      token: access,
      expiresAt: 1_800_000_300_000,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.clerk.com/v1/sessions/sess_123/tokens",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("classifies a rejected Clerk network request as retryable unavailability", async () => {
    const provider = createProvider(
      vi.fn(async () => {
        throw new TypeError("network failed with secret-bearing detail");
      }),
    );

    await expect(
      provider.issueSessionToken("sess_123", "user_123"),
    ).rejects.toEqual(new IdentityProviderError("unavailable"));
  });

  it("rejects a standard session token whose remaining lifetime exceeds five minutes", async () => {
    const access = jwt({
      exp: 1_800_000_301,
      iat: 1_800_000_000,
      iss: issuer,
      nbf: 1_800_000_000,
      role: "authenticated",
      sid: "sess_123",
      sub: "user_123",
    });
    const provider = createProvider(
      vi.fn(async () =>
        Promise.resolve(
          new Response(JSON.stringify({ jwt: access }), { status: 200 }),
        ),
      ),
    );
    await expect(
      provider.issueSessionToken("sess_123", "user_123"),
    ).rejects.toEqual(new IdentityProviderError("invalid"));
  });

  it.each([
    ["missing role", jwt(standardClaims({ role: undefined }))],
    ["wrong role", jwt(standardClaims({ role: "service_role" }))],
    ["wrong issuer", jwt(standardClaims({ iss: "https://evil.example" }))],
    ["mismatched subject", jwt(standardClaims({ sub: "user_other" }))],
    ["mismatched session", jwt(standardClaims({ sid: "sess_other" }))],
    ["expired", jwt(standardClaims({ exp: 1_800_000_000 }))],
    ["not yet valid", jwt(standardClaims({ nbf: 1_800_000_001 }))],
    [
      "symmetric algorithm",
      jwt(standardClaims(), { alg: "HS256", kid: "key_123", typ: "JWT" }),
    ],
    ["missing key id", jwt(standardClaims(), { alg: "RS256", typ: "JWT" })],
    ["malformed compact token", "not-a-jwt"],
    ["malformed signature", jwt(standardClaims(), undefined, "***")],
  ])("rejects a %s session token", async (_case, access) => {
    const provider = createProvider(
      vi.fn(async () =>
        Promise.resolve(
          new Response(JSON.stringify({ jwt: access }), { status: 200 }),
        ),
      ),
    );
    await expect(
      provider.issueSessionToken("sess_123", "user_123"),
    ).rejects.toEqual(new IdentityProviderError("invalid"));
  });

  it.each([1_799_999_999, 1_800_086_401])(
    "rejects expired or unreasonably long-lived OAuth identity token exp=%s",
    async (exp) => {
      const oauthToken = jwt({
        aud: "oauth_client_123",
        exp,
        iss: issuer,
        sid: "sess_123",
        sub: "user_123",
      });
      const provider = createProvider(
        vi.fn(
          async () =>
            new Response(JSON.stringify({ access_token: oauthToken }), {
              status: 200,
            }),
        ),
      );
      await expect(
        provider.completeAuthorization({
          providerCode: "code",
          transactionId: "tx",
        }),
      ).rejects.toEqual(new IdentityProviderError("invalid"));
    },
  );

  it("revokes the Clerk session and maps provider bodies to a generic error", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response("person@example.com secret-key", { status: 401 }),
      );
    const provider = createProvider(fetcher);
    await expect(provider.revokeSession("sess_123")).resolves.toBeUndefined();
    await expect(
      provider.issueSessionToken("sess_123", "user_123"),
    ).rejects.toEqual(new IdentityProviderError("revoked"));
  });
});

function createProvider(fetcher: typeof fetch | ReturnType<typeof vi.fn>) {
  return new ClerkOAuthProvider({
    backendApiUrl: "https://api.clerk.com/v1",
    callbackUrl,
    clientId: "oauth_client_123",
    clientSecret: "oauth_secret_never_client_side",
    fetcher: fetcher as typeof fetch,
    frontendApiUrl: issuer,
    secretKey: "sk_test_server_only",
    clock: () => 1_800_000_000_000,
    oauthAccessTokenMaxTtlMs: 24 * 60 * 60_000,
    sessionTokenMaxTtlMs: 5 * 60_000,
  });
}

import {
  IdentityProviderError,
  type IdentityProvider,
  type ProviderSessionToken,
  type ProviderIdentity,
} from "../contracts.ts";

export class FakeIdentityProvider implements IdentityProvider {
  readonly revokedSessions: string[] = [];
  revoked = false;
  unavailable = false;
  tokenTtlMs = 5 * 60_000;

  constructor(private readonly clock: () => number) {}

  authorizationUrl(input: {
    callbackUrl: string;
    transactionId: string;
  }): Promise<string> {
    const url = new URL("https://identity.example.test/sign-in");
    url.searchParams.set("callback_url", input.callbackUrl);
    url.searchParams.set("state", input.transactionId);
    return Promise.resolve(url.toString());
  }

  completeAuthorization(input: {
    providerCode: string;
    transactionId: string;
  }): Promise<ProviderIdentity> {
    if (input.providerCode !== "provider_valid") {
      return Promise.reject(new IdentityProviderError("invalid"));
    }
    return Promise.resolve({
      providerSessionId: "clerk_session_123",
      subject: "user_123",
    });
  }

  issueSessionToken(): Promise<ProviderSessionToken> {
    if (this.unavailable)
      return Promise.reject(new IdentityProviderError("unavailable"));
    if (this.revoked)
      return Promise.reject(new IdentityProviderError("revoked"));
    return Promise.resolve({
      token: "fake-clerk-jwt",
      expiresAt: this.clock() + this.tokenTtlMs,
    });
  }

  revokeSession(providerSessionId: string): Promise<void> {
    if (!this.revokedSessions.includes(providerSessionId)) {
      this.revokedSessions.push(providerSessionId);
    }
    return Promise.resolve();
  }
}

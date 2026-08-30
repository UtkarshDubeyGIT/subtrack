import { z } from "zod";
import {
  IdentityProviderError,
  type IdentityProvider,
  type ProviderIdentity,
  type ProviderSessionToken,
} from "./contracts.ts";

type Options = Readonly<{
  backendApiUrl: string;
  callbackUrl: string;
  clientId: string;
  clientSecret: string;
  clock?: () => number;
  fetcher?: typeof fetch;
  frontendApiUrl: string;
  oauthAccessTokenMaxTtlMs?: number;
  secretKey: string;
  sessionTokenMaxTtlMs?: number;
}>;

const oauthResponseSchema = z.object({
  access_token: z.string().min(1).max(16_384),
});
const sessionTokenSchema = z.object({ jwt: z.string().min(1).max(16_384) });
const oauthClaimsSchema = z.object({
  aud: z.string(),
  exp: z.number().int().positive(),
  iss: z.string(),
  sid: z.string().min(1).max(512),
  sub: z.string().min(1).max(512),
});
const standardSessionHeaderSchema = z.object({
  alg: z.string().regex(/^(?:RS|PS|ES)(?:256|384|512)$|^EdDSA$/),
  kid: z.string().min(1).max(512),
  typ: z.literal("JWT"),
});
const standardSessionClaimsSchema = z.object({
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
  iss: z.string(),
  nbf: z.number().int().positive(),
  role: z.literal("authenticated"),
  sid: z.string().min(1).max(512),
  sub: z.string().min(1).max(512),
});

export class ClerkOAuthProvider implements IdentityProvider {
  private readonly fetcher: typeof fetch;
  private readonly backendApiUrl: string;
  private readonly frontendApiUrl: string;
  private readonly clock: () => number;
  private readonly oauthAccessTokenMaxTtlMs: number;
  private readonly sessionTokenMaxTtlMs: number;

  constructor(private readonly options: Options) {
    this.fetcher = options.fetcher ?? fetch;
    this.backendApiUrl = exactHttpsOrigin(options.backendApiUrl, true);
    this.frontendApiUrl = exactHttpsOrigin(options.frontendApiUrl, false);
    this.clock = options.clock ?? Date.now;
    this.oauthAccessTokenMaxTtlMs =
      options.oauthAccessTokenMaxTtlMs ?? 24 * 60 * 60_000;
    this.sessionTokenMaxTtlMs = options.sessionTokenMaxTtlMs ?? 5 * 60_000;
    const callback = new URL(options.callbackUrl);
    if (callback.protocol !== "https:" || callback.search || callback.hash) {
      throw new Error("invalid_clerk_callback_url");
    }
  }

  authorizationUrl(input: {
    callbackUrl: string;
    transactionId: string;
  }): Promise<string> {
    if (input.callbackUrl !== this.options.callbackUrl) {
      return Promise.reject(new IdentityProviderError("invalid"));
    }
    const url = new URL("/oauth/authorize", this.frontendApiUrl);
    url.search = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: this.options.callbackUrl,
      response_type: "code",
      scope: "openid",
      state: input.transactionId,
    }).toString();
    return Promise.resolve(url.toString());
  }

  async completeAuthorization(input: {
    providerCode: string;
    transactionId: string;
  }): Promise<ProviderIdentity> {
    const response = await this.request(
      new URL("/oauth/token", this.frontendApiUrl).toString(),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Basic ${btoa(`${this.options.clientId}:${this.options.clientSecret}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: input.providerCode,
          redirect_uri: this.options.callbackUrl,
        }).toString(),
        redirect: "error",
        referrerPolicy: "no-referrer",
      },
    );
    if (!response.ok) throw providerHttpError(response.status);
    try {
      const oauth = oauthResponseSchema.parse(await response.json());
      const claims = oauthClaimsSchema.parse(
        parseJwtClaims(oauth.access_token),
      );
      const now = this.clock();
      if (
        claims.iss !== this.frontendApiUrl ||
        claims.aud !== this.options.clientId ||
        claims.exp * 1_000 <= now ||
        claims.exp * 1_000 - now > this.oauthAccessTokenMaxTtlMs
      ) {
        throw new Error("invalid_oauth_claims");
      }
      return { providerSessionId: claims.sid, subject: claims.sub };
    } catch {
      throw new IdentityProviderError("invalid");
    }
  }

  async issueSessionToken(
    providerSessionId: string,
    subject: string,
  ): Promise<ProviderSessionToken> {
    const path = `sessions/${encodeURIComponent(providerSessionId)}/tokens`;
    const response = await this.request(
      new URL(path, this.backendApiUrl).toString(),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.options.secretKey}`,
          "content-type": "application/json",
        },
        body: "{}",
        redirect: "error",
        referrerPolicy: "no-referrer",
      },
    );
    if (!response.ok) throw providerHttpError(response.status);
    try {
      const token = sessionTokenSchema.parse(await response.json());
      const parsed = parseJwt(token.jwt);
      standardSessionHeaderSchema.parse(parsed.header);
      const claims = standardSessionClaimsSchema.parse(parsed.claims);
      const now = this.clock();
      if (
        claims.iss !== this.frontendApiUrl ||
        claims.sid !== providerSessionId ||
        claims.sub !== subject ||
        claims.nbf * 1_000 > now ||
        claims.iat * 1_000 > now ||
        claims.exp * 1_000 <= now ||
        claims.exp * 1_000 - now > this.sessionTokenMaxTtlMs
      ) {
        throw new Error("invalid_session_token");
      }
      return { token: token.jwt, expiresAt: claims.exp * 1_000 };
    } catch {
      throw new IdentityProviderError("invalid");
    }
  }

  async revokeSession(providerSessionId: string): Promise<void> {
    const path = `sessions/${encodeURIComponent(providerSessionId)}/revoke`;
    const response = await this.request(
      new URL(path, this.backendApiUrl).toString(),
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.secretKey}` },
        body: null,
        redirect: "error",
        referrerPolicy: "no-referrer",
      },
    );
    if (!response.ok) throw providerHttpError(response.status);
  }

  private async request(input: string, init: RequestInit) {
    try {
      return await this.fetcher(input, init);
    } catch {
      throw new IdentityProviderError("unavailable");
    }
  }
}

function parseJwtClaims(token: string): unknown {
  return parseJwt(token).claims;
}

function parseJwt(token: string) {
  const [header, claims, signature, ...extra] = token.split(".");
  if (
    !header ||
    !claims ||
    !signature ||
    extra.length > 0 ||
    [header, claims, signature].some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  ) {
    throw new Error("malformed_jwt");
  }
  return {
    header: parseBase64Json(header),
    claims: parseBase64Json(claims),
  };
}

function parseBase64Json(value: string): unknown {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return JSON.parse(atob(padded)) as unknown;
}

function providerHttpError(status: number) {
  return new IdentityProviderError(
    status === 401 || status === 403 || status === 404
      ? "revoked"
      : "unavailable",
  );
}

function exactHttpsOrigin(candidate: string, allowV1Path: boolean) {
  const url = new URL(candidate);
  const validPath = allowV1Path
    ? url.pathname === "/v1" || url.pathname === "/v1/"
    : url.pathname === "/";
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !validPath ||
    url.search ||
    url.hash
  ) {
    throw new Error("invalid_clerk_origin");
  }
  return allowV1Path ? `${url.origin}/v1/` : url.origin;
}

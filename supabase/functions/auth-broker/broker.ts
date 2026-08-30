import { z } from "zod";
import {
  IdentityProviderError,
  type AuthorizationTransaction,
  type BrokerStore,
  type CredentialFamily,
  type IdentityProvider,
  type ProviderSessionToken,
  type RefreshCredentialRecord,
} from "./contracts.ts";

const boundedOpaque = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._~-]+$/);
const codeVerifierSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/);
const authorizeSchema = z.object({
  state: boundedOpaque,
  code_challenge: z
    .string()
    .min(43)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  code_challenge_method: z.literal("S256"),
  redirect_uri: z.string().min(1).max(512),
});
const callbackSchema = z.object({
  state: boundedOpaque,
  code: z.string().min(1).max(2_048),
});
const exchangeSchema = z
  .object({ code: boundedOpaque, codeVerifier: codeVerifierSchema })
  .strict();
const refreshSchema = z
  .object({
    refreshCredential: z
      .string()
      .min(32)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

export type BrokerOptions = Readonly<{
  allowedOrigins: readonly string[];
  accessTokenMaxTtlMs: number;
  authorizationCodeTtlMs: number;
  authorizationTtlMs: number;
  hashKey: string;
  publicBaseUrl: string;
  rateLimit: Readonly<{
    ipAttempts: number;
    transactionAttempts: number;
    windowMs: number;
  }>;
  redirectAllowlist: readonly string[];
  refreshTtlMs: number;
}>;

export type SecurityEvent = Readonly<{
  name:
    | "authorization_started"
    | "callback_completed"
    | "callback_rejected"
    | "exchange_completed"
    | "exchange_rejected"
    | "refresh_completed"
    | "refresh_rejected"
    | "credential_reuse_detected"
    | "session_revoked"
    | "rate_limited"
    | "cleanup_completed";
  reason?: string;
}>;

type Dependencies = Readonly<{
  clock: () => number;
  events: { record(event: SecurityEvent): void | Promise<void> };
  options: BrokerOptions;
  provider: IdentityProvider;
  store: BrokerStore;
}>;

export class AuthBrokerService {
  constructor(private readonly dependencies: Dependencies) {
    if (dependencies.options.hashKey.length < 32)
      throw new Error("hash_key_too_short");
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const routePath = this.routePath(url.pathname);
    const corsRoute = isCorsRoute(routePath);
    if (request.method === "OPTIONS" && corsRoute) {
      return this.preflight(request);
    }
    let response: Response;
    try {
      if (!(await this.allowIp(request))) {
        response = await this.rateLimited();
      } else if (
        request.method === "GET" &&
        routePath === "/v1/desktop/authorize"
      ) {
        response = await this.authorize(url);
      } else if (
        request.method === "GET" &&
        routePath === "/v1/desktop/callback"
      ) {
        response = await this.callback(url);
      } else if (
        request.method === "POST" &&
        routePath === "/v1/desktop/session/exchange"
      ) {
        response = await this.exchange(request);
      } else if (
        request.method === "POST" &&
        routePath === "/v1/desktop/session/refresh"
      ) {
        response = await this.refresh(request);
      } else if (
        request.method === "POST" &&
        routePath === "/v1/desktop/session/revoke"
      ) {
        response = await this.revoke(request);
      } else {
        response = json(404, { error: "not_found" });
      }
    } catch {
      response = json(500, { error: "broker_unavailable" });
    }
    return corsRoute ? this.withCors(response, request) : response;
  }

  async cleanup() {
    const result = await this.dependencies.store.cleanup(
      this.dependencies.clock(),
    );
    await this.record({ name: "cleanup_completed" });
    return result;
  }

  private async authorize(url: URL): Promise<Response> {
    const parsed = authorizeSchema.safeParse(
      Object.fromEntries(url.searchParams),
    );
    if (
      !parsed.success ||
      !this.dependencies.options.redirectAllowlist.includes(
        parsed.data.redirect_uri,
      )
    ) {
      return json(400, { error: "invalid_request" });
    }
    const now = this.dependencies.clock();
    const transactionId = randomOpaque(32);
    const transaction: AuthorizationTransaction = {
      id: transactionId,
      state: parsed.data.state,
      codeChallenge: parsed.data.code_challenge,
      redirectUri: parsed.data.redirect_uri,
      createdAt: now,
      expiresAt: now + this.dependencies.options.authorizationTtlMs,
      status: "pending",
    };
    await this.dependencies.store.createAuthorization(transaction);
    const callbackUrl = `${this.dependencies.options.publicBaseUrl}/v1/desktop/callback`;
    const location = await this.dependencies.provider.authorizationUrl({
      callbackUrl,
      transactionId,
    });
    await this.record({ name: "authorization_started" });
    return redirect(location);
  }

  private async callback(url: URL): Promise<Response> {
    const parsed = callbackSchema.safeParse(
      Object.fromEntries(url.searchParams),
    );
    if (!parsed.success) return json(400, { error: "invalid_request" });
    if (!(await this.allowTransaction(`callback:${parsed.data.state}`))) {
      return this.rateLimited();
    }
    const transaction = await this.dependencies.store.getAuthorization(
      parsed.data.state,
    );
    const now = this.dependencies.clock();
    if (
      !transaction ||
      transaction.status !== "pending" ||
      transaction.expiresAt <= now
    ) {
      await this.record({
        name: "callback_rejected",
        reason: "invalid_transaction",
      });
      return json(401, { error: "authentication_failed" });
    }
    try {
      const identity = await this.dependencies.provider.completeAuthorization({
        providerCode: parsed.data.code,
        transactionId: transaction.id,
      });
      const authorizationCode = randomOpaque(32);
      const completed = await this.dependencies.store.completeAuthorization(
        transaction.id,
        {
          authorizationCodeHash: await this.hash(authorizationCode),
          authorizationCodeExpiresAt:
            now + this.dependencies.options.authorizationCodeTtlMs,
          providerSessionId: identity.providerSessionId,
          subject: identity.subject,
        },
        now,
      );
      if (!completed) return json(401, { error: "authentication_failed" });
      const appCallback = new URL(transaction.redirectUri);
      appCallback.searchParams.set("code", authorizationCode);
      appCallback.searchParams.set("state", transaction.state);
      await this.record({ name: "callback_completed" });
      return redirect(appCallback.toString());
    } catch {
      await this.record({
        name: "callback_rejected",
        reason: "provider_rejected",
      });
      return json(401, { error: "authentication_failed" });
    }
  }

  private async exchange(request: Request): Promise<Response> {
    const parsed = exchangeSchema.safeParse(await safeJson(request));
    if (!parsed.success) return json(400, { error: "invalid_request" });
    const codeHash = await this.hash(parsed.data.code);
    if (!(await this.allowTransaction(`exchange:${codeHash}`)))
      return this.rateLimited();
    const now = this.dependencies.clock();
    const transaction = await this.dependencies.store.consumeAuthorizationCode(
      codeHash,
      now,
    );
    if (
      !transaction ||
      !transaction.providerSessionId ||
      !transaction.subject ||
      (await pkceChallenge(parsed.data.codeVerifier)) !==
        transaction.codeChallenge
    ) {
      await this.record({ name: "exchange_rejected", reason: "invalid_grant" });
      return json(401, { error: "authentication_failed" });
    }
    try {
      const access = await this.issueValidatedToken(
        transaction.providerSessionId,
        transaction.subject,
        now,
      );
      const refreshCredential = randomOpaque(48);
      const family: CredentialFamily = {
        id: randomOpaque(24),
        providerSessionId: transaction.providerSessionId,
        subject: transaction.subject,
        createdAt: now,
      };
      const credential: RefreshCredentialRecord = {
        hash: await this.hash(refreshCredential),
        familyId: family.id,
        generation: 0,
        createdAt: now,
        expiresAt: now + this.dependencies.options.refreshTtlMs,
      };
      await this.dependencies.store.createCredentialFamily(family, credential);
      await this.record({ name: "exchange_completed" });
      return sessionResponse(access, refreshCredential, family.subject);
    } catch (error) {
      await this.record({
        name: "exchange_rejected",
        reason:
          error instanceof IdentityProviderError
            ? `provider_${error.reason}`
            : "invalid_token",
      });
      return json(401, { error: "authentication_failed" });
    }
  }

  private async refresh(request: Request): Promise<Response> {
    const parsed = refreshSchema.safeParse(await safeJson(request));
    if (!parsed.success) return json(400, { error: "invalid_request" });
    const oldHash = await this.hash(parsed.data.refreshCredential);
    if (!(await this.allowTransaction(`refresh:${oldHash}`)))
      return this.rateLimited();
    const now = this.dependencies.clock();
    const inspection = await this.dependencies.store.inspectRefresh(
      oldHash,
      now,
    );
    if (inspection.status === "used") {
      await this.revokeFamilyAndProvider(
        inspection.family.id,
        inspection.family.providerSessionId,
        now,
      );
      await this.record({
        name: "credential_reuse_detected",
        reason: "rotated_credential_reused",
      });
      return json(401, { error: "authentication_failed" });
    }
    if (inspection.status !== "active") {
      await this.record({
        name: "refresh_rejected",
        reason: inspection.status,
      });
      return json(401, { error: "authentication_failed" });
    }
    try {
      const access = await this.issueValidatedToken(
        inspection.family.providerSessionId,
        inspection.family.subject,
        now,
      );
      const refreshCredential = randomOpaque(48);
      const replacement: RefreshCredentialRecord = {
        hash: await this.hash(refreshCredential),
        familyId: inspection.family.id,
        generation: inspection.credential.generation + 1,
        createdAt: now,
        expiresAt: now + this.dependencies.options.refreshTtlMs,
      };
      const rotation = await this.dependencies.store.rotateRefresh(
        oldHash,
        replacement,
        now,
      );
      if (rotation.status !== "rotated") {
        if (rotation.family) {
          await this.revokeFamilyAndProvider(
            rotation.family.id,
            rotation.family.providerSessionId,
            now,
          );
        }
        await this.record({
          name: "credential_reuse_detected",
          reason: "rotation_race",
        });
        return json(401, { error: "authentication_failed" });
      }
      await this.record({ name: "refresh_completed" });
      return sessionResponse(
        access,
        refreshCredential,
        inspection.family.subject,
      );
    } catch (error) {
      const unavailable =
        error instanceof IdentityProviderError &&
        error.reason === "unavailable";
      if (
        error instanceof IdentityProviderError &&
        error.reason === "revoked"
      ) {
        await this.revokeFamilyAndProvider(
          inspection.family.id,
          inspection.family.providerSessionId,
          now,
        );
        await this.record({
          name: "refresh_rejected",
          reason: "provider_revoked",
        });
      } else {
        await this.record({
          name: "refresh_rejected",
          reason: "provider_unavailable",
        });
      }
      return json(unavailable ? 503 : 401, {
        error: unavailable
          ? "authentication_unavailable"
          : "authentication_failed",
      });
    }
  }

  private async revoke(request: Request): Promise<Response> {
    const parsed = refreshSchema.safeParse(await safeJson(request));
    if (!parsed.success) return json(400, { error: "invalid_request" });
    const hash = await this.hash(parsed.data.refreshCredential);
    const inspection = await this.dependencies.store.inspectRefresh(
      hash,
      this.dependencies.clock(),
    );
    if (
      inspection.status === "active" ||
      inspection.status === "used" ||
      inspection.status === "family_revoked"
    ) {
      await this.revokeFamilyAndProvider(
        inspection.family.id,
        inspection.family.providerSessionId,
        this.dependencies.clock(),
      );
    }
    await this.record({ name: "session_revoked" });
    return empty(204);
  }

  private async issueValidatedToken(
    providerSessionId: string,
    subject: string,
    now: number,
  ) {
    const token = await this.dependencies.provider.issueSessionToken(
      providerSessionId,
      subject,
    );
    if (
      token.expiresAt <= now ||
      token.expiresAt - now > this.dependencies.options.accessTokenMaxTtlMs ||
      token.token.length === 0 ||
      token.token.length > 16_384
    ) {
      throw new Error("invalid_provider_token");
    }
    return token;
  }

  private async revokeFamilyAndProvider(
    familyId: string,
    providerSessionId: string,
    now: number,
  ) {
    await this.dependencies.store.revokeFamily(familyId, now);
    try {
      await this.dependencies.provider.revokeSession(providerSessionId);
    } catch {
      // The local family stays revoked even if provider revocation is temporarily unavailable.
    }
  }

  private async allowIp(request: Request) {
    const ip = request.headers.get("x-real-ip") ?? "unknown";
    return this.dependencies.store.takeRateLimit(
      await this.hash(`ip:${ip}`),
      this.dependencies.options.rateLimit.ipAttempts,
      this.dependencies.options.rateLimit.windowMs,
      this.dependencies.clock(),
    );
  }

  private async allowTransaction(value: string) {
    return this.dependencies.store.takeRateLimit(
      await this.hash(value),
      this.dependencies.options.rateLimit.transactionAttempts,
      this.dependencies.options.rateLimit.windowMs,
      this.dependencies.clock(),
    );
  }

  private async hash(value: string) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.dependencies.options.hashKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(value),
    );
    return bytesToBase64Url(new Uint8Array(digest));
  }

  private record(event: SecurityEvent) {
    return Promise.resolve(this.dependencies.events.record(event));
  }

  private async rateLimited() {
    await this.record({ name: "rate_limited" });
    return json(429, { error: "rate_limited" }, { "retry-after": "60" });
  }

  private routePath(pathname: string) {
    const prefix = new URL(
      this.dependencies.options.publicBaseUrl,
    ).pathname.replace(/\/$/, "");
    if (!prefix) return pathname;
    if (pathname === prefix) return "/";
    return pathname.startsWith(`${prefix}/`)
      ? pathname.slice(prefix.length)
      : "";
  }

  private preflight(request: Request) {
    const origin = request.headers.get("origin");
    const requestedMethod = request.headers.get(
      "access-control-request-method",
    );
    const requestedHeaders = (
      request.headers.get("access-control-request-headers") ?? ""
    )
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (
      !origin ||
      !this.dependencies.options.allowedOrigins.includes(origin) ||
      requestedMethod !== "POST" ||
      requestedHeaders.some((header) => header !== "content-type")
    ) {
      return json(403, { error: "cors_denied" });
    }
    const response = empty(204);
    response.headers.set("access-control-allow-origin", origin);
    response.headers.set("access-control-allow-methods", "POST, OPTIONS");
    response.headers.set("access-control-allow-headers", "content-type");
    response.headers.set("access-control-max-age", "600");
    response.headers.set("vary", "Origin");
    return response;
  }

  private withCors(response: Response, request: Request) {
    const origin = request.headers.get("origin");
    if (origin && this.dependencies.options.allowedOrigins.includes(origin)) {
      response.headers.set("access-control-allow-origin", origin);
      response.headers.set("vary", "Origin");
    }
    return response;
  }
}

function isCorsRoute(path: string) {
  return (
    path === "/v1/desktop/session/exchange" ||
    path === "/v1/desktop/session/refresh" ||
    path === "/v1/desktop/session/revoke"
  );
}

async function safeJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) return null;
  const text = await request.text();
  if (text.length === 0 || text.length > 16_384) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function pkceChallenge(verifier: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

function randomOpaque(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function sessionResponse(
  access: ProviderSessionToken,
  refreshCredential: string,
  subject: string,
) {
  return json(200, {
    accessToken: access.token,
    expiresAt: access.expiresAt,
    refreshCredential,
    subject,
  });
}

function json(
  status: number,
  body: object,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "referrer-policy": "no-referrer",
      ...headers,
    },
  });
}

function redirect(location: string) {
  return new Response(null, {
    status: 302,
    headers: {
      "cache-control": "no-store",
      location,
      "referrer-policy": "no-referrer",
    },
  });
}

function empty(status: number) {
  return new Response(null, {
    status,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

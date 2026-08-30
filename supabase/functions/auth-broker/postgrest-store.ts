import { z } from "zod";
import type {
  AuthorizationTransaction,
  BrokerStore,
  CredentialFamily,
  RefreshCredentialRecord,
  RefreshInspection,
  RotationResult,
} from "./contracts.ts";

type Options = Readonly<{
  serviceRoleKey: string;
  supabaseUrl: string;
  fetcher?: typeof fetch;
}>;

export class PostgrestBrokerStore implements BrokerStore {
  private readonly fetcher: typeof fetch;
  private readonly rpcBase: string;

  constructor(private readonly options: Options) {
    const url = new URL(options.supabaseUrl);
    if (
      url.protocol !== "https:" &&
      url.hostname !== "127.0.0.1" &&
      url.hostname !== "localhost"
    ) {
      throw new Error("invalid_supabase_url");
    }
    this.rpcBase = new URL("/rest/v1/rpc/", url).toString();
    this.fetcher = options.fetcher ?? fetch;
  }

  async createAuthorization(transaction: AuthorizationTransaction) {
    await this.rpc("broker_create_authorization", {
      p_transaction: transaction,
    });
  }

  getAuthorization(id: string) {
    return this.rpc<AuthorizationTransaction | null>(
      "broker_get_authorization",
      { p_id: id },
    );
  }

  completeAuthorization(
    id: string,
    completion: Pick<
      AuthorizationTransaction,
      | "authorizationCodeExpiresAt"
      | "authorizationCodeHash"
      | "providerSessionId"
      | "subject"
    >,
    now: number,
  ) {
    return this.rpc<boolean>("broker_complete_authorization", {
      p_completion: completion,
      p_id: id,
      p_now_ms: now,
    });
  }

  consumeAuthorizationCode(hash: string, now: number) {
    return this.rpc<AuthorizationTransaction | null>(
      "broker_consume_authorization_code",
      {
        p_hash: hash,
        p_now_ms: now,
      },
    );
  }

  async createCredentialFamily(
    family: CredentialFamily,
    credential: RefreshCredentialRecord,
  ) {
    await this.rpc("broker_create_credential_family", {
      p_credential: credential,
      p_family: family,
    });
  }

  inspectRefresh(hash: string, now: number) {
    return this.rpc<RefreshInspection>("broker_inspect_refresh", {
      p_hash: hash,
      p_now_ms: now,
    });
  }

  rotateRefresh(
    oldHash: string,
    replacement: RefreshCredentialRecord,
    now: number,
  ) {
    return this.rpc<RotationResult>("broker_rotate_refresh", {
      p_now_ms: now,
      p_old_hash: oldHash,
      p_replacement: replacement,
    });
  }

  async revokeFamily(familyId: string, now: number) {
    await this.rpc("broker_revoke_family", {
      p_family_id: familyId,
      p_now_ms: now,
    });
  }

  takeRateLimit(keyHash: string, limit: number, windowMs: number, now: number) {
    return this.rpc<boolean>("broker_take_rate_limit", {
      p_key_hash: keyHash,
      p_limit: limit,
      p_now_ms: now,
      p_window_ms: windowMs,
    });
  }

  cleanup(now: number) {
    return this.rpc<{
      credentials: number;
      transactions: number;
      rateLimits: number;
    }>("broker_cleanup", { p_now_ms: now });
  }

  private async rpc<T = unknown>(name: string, body: object): Promise<T> {
    const response = await this.fetcher(`${this.rpcBase}${name}`, {
      method: "POST",
      headers: {
        apikey: this.options.serviceRoleKey,
        authorization: `Bearer ${this.options.serviceRoleKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) throw new Error("broker_store_unavailable");
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("broker_store_invalid_response");
    }
  }
}

export const securityEventSchema = z.object({
  name: z.string().min(1).max(64),
  reason: z.string().min(1).max(64).optional(),
});

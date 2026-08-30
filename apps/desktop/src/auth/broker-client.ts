import { z } from "zod";
import { AuthExchangeError } from "./auth-controller";
import type { AuthBroker, BrokerSession } from "./types";
import { joinAuthBrokerPath, parseAuthBrokerBaseUrl } from "./broker-url";

const brokerSessionSchema = z.object({
  accessToken: z.string().min(1).max(16_384),
  expiresAt: z.number().int().positive(),
  refreshCredential: z.string().min(1).max(4_096),
  subject: z.string().min(1).max(512),
});

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export class HttpAuthBroker implements AuthBroker {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetcher: Fetcher = fetch,
  ) {
    this.baseUrl = parseAuthBrokerBaseUrl(baseUrl);
  }

  exchange(input: {
    code: string;
    codeVerifier: string;
  }): Promise<BrokerSession> {
    return this.request("/v1/desktop/session/exchange", input);
  }

  refresh(refreshCredential: string): Promise<BrokerSession> {
    return this.request("/v1/desktop/session/refresh", { refreshCredential });
  }

  async revoke(refreshCredential: string): Promise<void> {
    await this.request(
      "/v1/desktop/session/revoke",
      { refreshCredential },
      true,
    );
  }

  private async request(
    path: string,
    body: object,
    emptyResponse = false,
  ): Promise<BrokerSession> {
    let response: Response;
    try {
      response = await this.fetcher(joinAuthBrokerPath(this.baseUrl, path), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new AuthExchangeError(
        "transient",
        "Authentication broker is unavailable.",
      );
    }

    if (!response.ok) {
      const reason =
        response.status === 401 || response.status === 403
          ? "revoked"
          : "transient";
      throw new AuthExchangeError(
        reason,
        "Authentication broker rejected the session.",
      );
    }
    if (emptyResponse) return {} as BrokerSession;

    try {
      return brokerSessionSchema.parse(await response.json());
    } catch {
      throw new AuthExchangeError(
        "transient",
        "Authentication broker returned an invalid response.",
      );
    }
  }
}

export type DataPlaneAccessTokenLease = Readonly<{
  token: string;
  isCurrent: () => boolean;
}>;

export type DataPlaneClientOptions = Readonly<{
  accessToken: (
    signal?: AbortSignal,
  ) => Promise<DataPlaneAccessTokenLease | null>;
  publishableKey: string;
  supabaseUrl: string;
}>;

export type DataPlaneRequest = Omit<RequestInit, "headers"> &
  Readonly<{ prefer?: string; query?: URLSearchParams }>;

export type DataPlaneTransport = Readonly<{
  request(target: unknown, init: DataPlaneRequest): Promise<unknown>;
}>;

const TABLES = new Set([
  "fx_rates",
  "reminder_deliveries",
  "reminder_overrides",
  "renewal_events",
  "security_audit_events",
  "subscriptions",
  "user_preferences",
]);
const RPCS = new Set([
  "rpc/acknowledge_reminder_delivery",
  "rpc/calendar_events_page",
  "rpc/renewal_history_page",
  "rpc/subscriptions_page",
]);

export class DataPlaneError extends Error {
  constructor(
    public readonly reason: "auth" | "conflict" | "invalid" | "unavailable",
  ) {
    super("data_plane_request_failed");
  }
}

export function createDataPlaneTransport(raw: DataPlaneClientOptions) {
  let accessToken: DataPlaneClientOptions["accessToken"];
  let publishableKey: string;
  let restBase: URL;
  const pendingTokenAcquisitions = new Set<Promise<unknown>>();
  const maximumPendingTokenAcquisitions = 2;
  try {
    accessToken = raw.accessToken;
    const suppliedKey = raw.publishableKey;
    const suppliedUrl = raw.supabaseUrl;
    if (
      typeof accessToken !== "function" ||
      typeof suppliedKey !== "string" ||
      typeof suppliedUrl !== "string" ||
      suppliedKey !== suppliedKey.trim() ||
      suppliedUrl !== suppliedUrl.trim() ||
      suppliedKey.length === 0 ||
      hasServerCredential(suppliedKey)
    ) {
      throw new DataPlaneError("invalid");
    }
    const url = new URL(suppliedUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new DataPlaneError("invalid");
    }
    publishableKey = suppliedKey;
    restBase = new URL("/rest/v1/", url);
  } catch {
    throw new DataPlaneError("invalid");
  }

  return Object.freeze({
    async request(target: unknown, init: DataPlaneRequest) {
      if (
        typeof target !== "string" ||
        (!TABLES.has(target) && !RPCS.has(target))
      ) {
        throw new DataPlaneError("invalid");
      }
      const { body, method, signal } = init;
      let token: string;
      let isCurrent = () => true;
      try {
        const suppliedToken: unknown = await acquireAccessToken(signal);
        if (typeof suppliedToken !== "object" || suppliedToken === null) {
          throw new DataPlaneError("auth");
        }
        const tokenDescriptor = Object.getOwnPropertyDescriptor(
          suppliedToken,
          "token",
        );
        const currentDescriptor = Object.getOwnPropertyDescriptor(
          suppliedToken,
          "isCurrent",
        );
        if (
          !tokenDescriptor ||
          !Object.hasOwn(tokenDescriptor, "value") ||
          !currentDescriptor ||
          !Object.hasOwn(currentDescriptor, "value") ||
          typeof currentDescriptor.value !== "function"
        ) {
          throw new DataPlaneError("auth");
        }
        token = tokenDescriptor.value as string;
        isCurrent = currentDescriptor.value as () => boolean;
        if (
          typeof token !== "string" ||
          token.length === 0 ||
          token.length > 16_384 ||
          token !== token.trim() ||
          hasServerCredential(token)
        ) {
          throw new DataPlaneError("auth");
        }
      } catch (error) {
        if (error instanceof DataPlaneError && error.reason === "unavailable") {
          throw error;
        }
        throw new DataPlaneError("auth");
      }

      const url = new URL(target, restBase);
      url.search = init.query?.toString() ?? "";
      const headers = Object.freeze({
        accept: "application/json",
        apikey: publishableKey,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        prefer: init.prefer ?? "return=representation",
      });
      try {
        if (isCurrent() !== true) throw new DataPlaneError("auth");
      } catch {
        throw new DataPlaneError("auth");
      }
      let response: Response;
      try {
        response = await fetch(url.toString(), {
          body,
          cache: "no-store",
          method,
          signal,
          headers,
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
        });
      } catch {
        throw new DataPlaneError("unavailable");
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new DataPlaneError("auth");
        }
        if (response.status === 409) throw new DataPlaneError("conflict");
        if (response.status === 400 || response.status === 422) {
          throw new DataPlaneError("invalid");
        }
        throw new DataPlaneError("unavailable");
      }
      if (response.status === 204) return null;
      try {
        return (await response.json()) as unknown;
      } catch {
        throw new DataPlaneError("invalid");
      }
    },
  }) satisfies DataPlaneTransport;

  async function acquireAccessToken(signal: AbortSignal | null | undefined) {
    if (signal?.aborted) throw new DataPlaneError("unavailable");
    if (pendingTokenAcquisitions.size >= maximumPendingTokenAcquisitions) {
      throw new DataPlaneError("unavailable");
    }
    const acquisition = Promise.resolve().then(() => {
      if (signal?.aborted) throw new DataPlaneError("unavailable");
      return accessToken(signal ?? undefined);
    });
    pendingTokenAcquisitions.add(acquisition);
    void acquisition
      .finally(() => pendingTokenAcquisitions.delete(acquisition))
      .catch(() => undefined);
    return waitForAccessToken(acquisition, signal);
  }
}

function waitForAccessToken<T>(
  acquisition: Promise<T>,
  signal: AbortSignal | null | undefined,
) {
  if (!signal) return acquisition;
  if (signal.aborted) return Promise.reject(new DataPlaneError("unavailable"));
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      reject(new DataPlaneError("unavailable"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    void acquisition.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(
          error instanceof Error
            ? error
            : new Error("access_token_acquisition_failed"),
        );
      },
    );
  });
}

function hasServerCredential(candidate: unknown) {
  if (typeof candidate !== "string") return true;
  if (candidate.startsWith("sb_secret_")) return true;
  const payload = candidate.split(".")[1];
  if (!payload) return false;
  try {
    const decoded: unknown = JSON.parse(
      atob(
        payload
          .replaceAll("-", "+")
          .replaceAll("_", "/")
          .padEnd(Math.ceil(payload.length / 4) * 4, "="),
      ),
    );
    return (
      typeof decoded === "object" &&
      decoded !== null &&
      Object.hasOwn(decoded, "role") &&
      (decoded as { role?: unknown }).role === "service_role"
    );
  } catch {
    return false;
  }
}

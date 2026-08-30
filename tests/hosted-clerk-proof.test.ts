import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import {
  classifyNegativeStatus,
  discoverSupabasePublicKeys,
  formatRedactedFailure,
  formatRedactedResult,
  HostedProofError,
  persistRedactedResult,
  runHostedDataPlaneProof,
  selectPublicSupabaseKeys,
  validateClerkSessionToken,
} from "../scripts/hosted-clerk-proof/core.mjs";

const issuer = "https://steady-ladybug-22.clerk.accounts.dev";
const nowSeconds = 1_786_000_000;

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function standardToken(
  header: Record<string, unknown> = { alg: "RS256", kid: "key_fixture" },
  payload: Record<string, unknown> = {
    iss: issuer,
    sub: "user_fixture_proof",
    role: "authenticated",
    iat: nowSeconds,
    exp: nowSeconds + 60,
  },
) {
  return `${encode(header)}.${encode(payload)}.signature`;
}

function stagedJsonPost(
  port: number,
  origin: string,
  body: string,
  host = `127.0.0.1:${port}`,
) {
  const socket = connect({ host: "127.0.0.1", port });
  let response = "";
  const ready = new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(
        [
          "POST /token HTTP/1.1",
          `Host: ${host}`,
          `Origin: ${origin}`,
          "Content-Type: application/json",
          `Content-Length: ${Buffer.byteLength(body)}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );
      resolve();
    });
  });
  const status = new Promise<number>((resolve, reject) => {
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.once("error", reject);
    socket.once("end", () => {
      const match = /^HTTP\/1\.1 (\d{3})/.exec(response);
      if (match?.[1] === undefined) reject(new Error("missing status"));
      else resolve(Number(match[1]));
    });
  });
  return { ready, sendBody: () => socket.end(body), status };
}

function rawHttpRequest(
  port: number,
  target: string,
  options: { host?: string; method?: string } = {},
) {
  const socket = connect({ host: "127.0.0.1", port });
  let response = "";
  return new Promise<{ body: string; status: number }>((resolve, reject) => {
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.once("connect", () => {
      socket.end(
        [
          `${options.method ?? "GET"} ${target} HTTP/1.1`,
          `Host: ${options.host ?? `127.0.0.1:${port}`}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.once("end", () => {
      const status = /^HTTP\/1\.1 (\d{3})/.exec(response)?.[1];
      if (status === undefined) {
        reject(new Error("missing status"));
        return;
      }
      const wireBody = response.split("\r\n\r\n", 2)[1] ?? "";
      resolve({
        body: wireBody.trim() === "0" ? "" : wireBody,
        status: Number(status),
      });
    });
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function createBrowserScriptHarness(
  options: {
    clerkLoad?: () => Promise<void>;
    fetcher?: (path: string) => Promise<{ ok: boolean }>;
    replaceState?: () => void;
    session?: unknown;
  } = {},
) {
  const { startLoopbackTokenReceiver } = await import(
    "../scripts/hosted-clerk-proof/loopback.mjs"
  );
  const receiver = await startLoopbackTokenReceiver({
    state: "y".repeat(43),
    timeoutMs: 2_000,
  });
  void receiver.token.catch(() => undefined);
  const requestUrl = new URL(receiver.url);
  requestUrl.search = "?__clerk_db_jwt=browser.header.fixture_signature";
  const response = await fetch(requestUrl);
  const html = await response.text();
  const browserScript = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(
    html,
  )?.[1];
  if (browserScript === undefined) {
    await receiver.close();
    throw new Error("missing browser script");
  }

  const events: string[] = [];
  const location = {
    href: requestUrl.toString(),
    origin: requestUrl.origin,
  };
  let loadListener: (() => Promise<void>) | undefined;
  let cancelListener: (() => Promise<void>) | undefined;
  let sessionListener: ((value: { session: unknown }) => void) | undefined;
  let statusText = "Complete sign-in in this window.";
  const cancelElement = {
    disabled: false,
    addEventListener: (event: string, listener: () => Promise<void>) => {
      if (event === "click") cancelListener = listener;
    },
  };
  const signInElement = {
    replaceChildren: () => {
      events.push("clear");
    },
  };
  const statusElement = {
    get textContent() {
      return statusText;
    },
    set textContent(value: string) {
      statusText = value;
      events.push(`status:${value}`);
    },
  };
  const elements = new Map<string, unknown>([
    ["cancel", cancelElement],
    ["sign-in", signInElement],
    ["status", statusElement],
  ]);
  const clerkFixture = {
    addListener: (listener: (value: { session: unknown }) => void) => {
      events.push("listener");
      sessionListener = listener;
    },
    load: async (loadOptions: {
      signInForceRedirectUrl: string;
      signUpForceRedirectUrl: string;
    }) => {
      events.push("load");
      expect(location.href).toContain("?__clerk_db_jwt=");
      expect(loadOptions.signInForceRedirectUrl).toBe(`${location.origin}/`);
      expect(loadOptions.signUpForceRedirectUrl).toBe(`${location.origin}/`);
      await options.clerkLoad?.();
    },
    mountSignIn: () => {
      events.push("mount");
    },
    session: options.session ?? null,
  };
  runInNewContext(browserScript, {
    Clerk: clerkFixture,
    document: {
      getElementById: (id: string) => elements.get(id),
    },
    fetch: async (path: string) => {
      events.push(`fetch:${path}`);
      return (await options.fetcher?.(path)) ?? { ok: true };
    },
    window: {
      __internal_ClerkUICtor: class {},
      addEventListener: (event: string, listener: () => Promise<void>) => {
        if (event === "load") loadListener = listener;
      },
      history: {
        replaceState: (_state: null, _unused: string, path: string) => {
          events.push("history");
          options.replaceState?.();
          location.href = `${location.origin}${path}`;
        },
      },
      location,
    },
  });

  return {
    cancel: async () => {
      if (cancelListener === undefined)
        throw new Error("missing cancel listener");
      await cancelListener();
    },
    close: () => receiver.close(),
    emitSession: (session: unknown) => sessionListener?.({ session }),
    events,
    get cancelDisabled() {
      return cancelElement.disabled;
    },
    location,
    start: async () => {
      if (loadListener === undefined) throw new Error("missing load listener");
      await loadListener();
    },
    get statusText() {
      return statusText;
    },
  };
}

describe("hosted Clerk proof token boundary", () => {
  it("accepts the exact current standard session token without returning claims", () => {
    expect(
      validateClerkSessionToken(standardToken(), { nowSeconds }),
    ).toBeUndefined();
  });

  it("rejects a symmetrically signed token with a generic error", () => {
    expect(() =>
      validateClerkSessionToken(
        standardToken({ alg: "HS256", kid: "decoded-secret-kid" }),
        { nowSeconds },
      ),
    ).toThrowError("hosted_proof_failed");
  });

  it("rejects an asymmetric token without a bounded key identifier", () => {
    expect(() =>
      validateClerkSessionToken(standardToken({ alg: "RS256" }), {
        nowSeconds,
      }),
    ).toThrowError("hosted_proof_failed");
  });

  it("rejects a token from any other issuer", () => {
    expect(() =>
      validateClerkSessionToken(
        standardToken(undefined, {
          iss: "https://attacker.example",
          sub: "user_fixture_proof",
          role: "authenticated",
          iat: nowSeconds,
          exp: nowSeconds + 60,
        }),
        { nowSeconds },
      ),
    ).toThrowError("hosted_proof_failed");
  });

  it("rejects a standard token without the authenticated role", () => {
    expect(() =>
      validateClerkSessionToken(
        standardToken(undefined, {
          iss: issuer,
          sub: "user_fixture_proof",
          role: "anon",
          iat: nowSeconds,
          exp: nowSeconds + 60,
        }),
        { nowSeconds },
      ),
    ).toThrowError("hosted_proof_failed");
  });

  it("rejects an expired standard token", () => {
    expect(() =>
      validateClerkSessionToken(
        standardToken(undefined, {
          iss: issuer,
          sub: "user_fixture_proof",
          role: "authenticated",
          iat: nowSeconds - 60,
          exp: nowSeconds,
        }),
        { nowSeconds },
      ),
    ).toThrowError("hosted_proof_failed");
  });

  it("rejects a token whose issued lifetime exceeds five minutes", () => {
    expect(() =>
      validateClerkSessionToken(
        standardToken(undefined, {
          iss: issuer,
          sub: "user_fixture_proof",
          role: "authenticated",
          iat: nowSeconds,
          exp: nowSeconds + 301,
        }),
        { nowSeconds },
      ),
    ).toThrowError("hosted_proof_failed");
  });

  it("rejects a token without a bounded Clerk subject", () => {
    expect(() =>
      validateClerkSessionToken(
        standardToken(undefined, {
          iss: issuer,
          role: "authenticated",
          iat: nowSeconds,
          exp: nowSeconds + 60,
        }),
        { nowSeconds },
      ),
    ).toThrowError("hosted_proof_failed");
  });

  it("rejects an oversized compact token before decoding claims", () => {
    const [header, payload] = standardToken().split(".");
    const oversized = `${header}.${payload}.${"x".repeat(20_000)}`;
    expect(() =>
      validateClerkSessionToken(oversized, { nowSeconds }),
    ).toThrowError("hosted_proof_failed");
  });

  it("classifies every rejected claim or structure only as aggregate token contract", () => {
    const error = (() => {
      try {
        validateClerkSessionToken(
          standardToken(undefined, {
            iss: "https://secret-issuer.example",
            sub: "personal_identity_secret",
            role: "secret-role",
            iat: nowSeconds,
            exp: nowSeconds + 60,
          }),
          { nowSeconds },
        );
      } catch (caught) {
        return caught;
      }
      throw new Error("expected token rejection");
    })();

    const serialized = formatRedactedFailure(error);
    expect(JSON.parse(serialized).failure).toEqual({ code: "token_contract" });
    expect(serialized).not.toMatch(
      /secret-issuer|personal_identity|secret-role|"iss"|"sub"|"role"|claim/i,
    );
  });
});

describe("Supabase public-key discovery boundary", () => {
  it("selects only publishable and anon keys without reading elevated keys", () => {
    const elevated = (type: string, name: string) => {
      const entry: Record<string, unknown> = { type, name };
      Object.defineProperty(entry, "api_key", {
        enumerable: true,
        get: () => {
          throw new Error("service-key-was-accessed");
        },
      });
      return entry;
    };

    expect(
      selectPublicSupabaseKeys([
        elevated("secret", "default"),
        elevated("legacy", "service_role"),
        {
          type: "publishable",
          name: "default",
          api_key: "sb_publishable_fixture",
        },
        { type: "legacy", name: "anon", api_key: standardToken() },
      ]),
    ).toEqual({
      publishableKey: "sb_publishable_fixture",
      negativeToken: standardToken(),
    });
  });

  it("uses only the pinned CLI public-key listing without reveal", async () => {
    const calls: string[][] = [];
    const result = await discoverSupabasePublicKeys({
      runCli: async (args: string[]) => {
        calls.push(args);
        return JSON.stringify([
          {
            type: "publishable",
            name: "default",
            api_key: "sb_publishable_fixture",
          },
          { type: "legacy", name: "anon", api_key: standardToken() },
        ]);
      },
    });

    expect(calls).toEqual([
      [
        "projects",
        "api-keys",
        "--project-ref",
        "qjsyhvclllikkopjfqtc",
        "--output",
        "json",
      ],
    ]);
    expect(calls.flat()).not.toContain("--reveal");
    expect(result.publishableKey).toBe("sb_publishable_fixture");
  });

  it("classifies secret-bearing CLI failures only as public-key discovery", async () => {
    const error = await discoverSupabasePublicKeys({
      runCli: async () => {
        throw new Error(
          `CLI output ${standardToken()} sb_publishable_secret personal@example.com`,
        );
      },
    }).catch((caught: unknown) => caught);

    const serialized = formatRedactedFailure(error);
    expect(JSON.parse(serialized).failure).toEqual({
      code: "public_key_discovery",
    });
    expect(serialized).not.toMatch(
      /CLI output|personal@example|sb_publishable_secret|eyJ/,
    );
  });
});

describe("hosted Data API proof", () => {
  it("reconstructs a closed stage-only failure with a safe HTTP status", () => {
    const error = new HostedProofError("positive_update", 503);
    Object.assign(error, {
      token: standardToken(),
      responseBody: "personal@example.com",
      requestUrl: "https://example.test/rest/v1?secret=value",
    });

    const serialized = formatRedactedFailure(error);

    expect(JSON.parse(serialized)).toEqual({
      outcome: "failed",
      issuer,
      project: "subtrack-dev",
      projectRef: "qjsyhvclllikkopjfqtc",
      failure: { code: "positive_update", status: 503 },
    });
    expect(serialized).not.toMatch(
      /personal@example|secret=value|eyJ|token|responseBody|requestUrl/,
    );
  });

  it("reconstructs a non-HTTP stage without reading hostile error properties", () => {
    const error = new HostedProofError("browser_launch");
    for (const property of [
      "message",
      "stack",
      "cause",
      "reason",
      "status",
      "body",
      "headers",
      "url",
      "token",
      "identity",
      "cliOutput",
    ]) {
      Object.defineProperty(error, property, {
        configurable: true,
        get: () => {
          throw new Error(`secret-bearing-${property}`);
        },
      });
    }

    expect(JSON.parse(formatRedactedFailure(error))).toEqual({
      outcome: "failed",
      issuer,
      project: "subtrack-dev",
      projectRef: "qjsyhvclllikkopjfqtc",
      failure: { code: "browser_launch" },
    });
  });

  it("maps an arbitrary hostile error to transport without invoking traps", () => {
    let trapReads = 0;
    const error = new Proxy(Object.create(null), {
      get: () => {
        trapReads += 1;
        throw new Error(`secret ${standardToken()}`);
      },
      getOwnPropertyDescriptor: () => {
        trapReads += 1;
        throw new Error("secret descriptor");
      },
      has: () => {
        trapReads += 1;
        throw new Error("secret property");
      },
      ownKeys: () => {
        trapReads += 1;
        throw new Error("secret keys");
      },
    });

    expect(JSON.parse(formatRedactedFailure(error))).toEqual({
      outcome: "failed",
      issuer,
      project: "subtrack-dev",
      projectRef: "qjsyhvclllikkopjfqtc",
      failure: { code: "transport_or_configuration" },
    });
    expect(trapReads).toBe(0);
  });

  it("reconstructs failure output without inherited serialization hooks", () => {
    let serialized = "";
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value: () => "secret hook bearer-secret-value",
    });
    try {
      serialized = formatRedactedFailure(
        new HostedProofError("positive_read", 502),
      );
    } finally {
      Reflect.deleteProperty(Object.prototype, "toJSON");
    }

    expect(JSON.parse(serialized)).toEqual({
      outcome: "failed",
      issuer,
      project: "subtrack-dev",
      projectRef: "qjsyhvclllikkopjfqtc",
      failure: { code: "positive_read", status: 502 },
    });
    expect(serialized).not.toMatch(/secret hook|eyJ/);
  });

  it("performs no Data API I/O before the Clerk token passes validation", async () => {
    let requests = 0;
    const error = await runHostedDataPlaneProof({
      fetcher: async () => {
        requests += 1;
        throw new Error("must-not-run");
      },
      fixtureId: "sub_proof_invalid_token",
      negativeToken: standardToken(),
      nowSeconds,
      publishableKey: "sb_publishable_fixture",
      sessionToken: standardToken({
        alg: "HS256",
        kid: "symmetric_fixture",
      }),
      timestamp: "2026-08-06T00:00:00.000Z",
      today: "2026-08-06",
    }).catch((caught: unknown) => caught);

    expect(String(error)).toBe("Error: hosted_proof_failed");
    expect(requests).toBe(0);
  });

  it("serializes only the approved redacted evidence fields", () => {
    const serialized = formatRedactedResult({
      outcome: "passed",
      timestamp: "2026-08-06T00:00:00.000Z",
      issuer,
      project: "subtrack-dev",
      projectRef: "qjsyhvclllikkopjfqtc",
      fixtureId: "sub_proof_redacted",
      positive: { create: 201, read: 200, update: 200, delete: 200 },
      negative: { status: 401, classification: "denied" },
      cleanup: { status: 200, outcome: "removed" },
      sessionToken: standardToken(),
      publishableKey: "sb_publishable_must_not_persist",
      responseBody: "personal@example.com",
    });

    expect(JSON.parse(serialized)).toEqual({
      outcome: "passed",
      timestamp: "2026-08-06T00:00:00.000Z",
      issuer,
      project: "subtrack-dev",
      projectRef: "qjsyhvclllikkopjfqtc",
      fixtureId: "sub_proof_redacted",
      positive: { create: 201, read: 200, update: 200, delete: 200 },
      negative: { status: 401, classification: "denied" },
      cleanup: { status: 200, outcome: "removed" },
    });
    expect(serialized).not.toMatch(
      /must_not_persist|personal@example|eyJ|sessionToken|publishableKey|responseBody/,
    );
  });

  it("persists only redacted evidence through a private atomic file", async () => {
    const writes: Array<{
      path: string;
      data: string;
      options: Record<string, unknown>;
    }> = [];
    const renames: string[][] = [];
    const result = {
      outcome: "passed",
      timestamp: "2026-08-06T00:00:00.000Z",
      issuer,
      project: "subtrack-dev",
      projectRef: "qjsyhvclllikkopjfqtc",
      fixtureId: "sub_proof_persisted",
      positive: { create: 201, read: 200, update: 200, delete: 200 },
      negative: { status: 403, classification: "denied" },
      cleanup: { status: 200, outcome: "removed" },
      token: standardToken(),
    };

    await persistRedactedResult(result, {
      evidencePath: "/proof/result.json",
      randomBytes: () => Buffer.alloc(8, 7),
      renameFile: async (...paths: string[]) => {
        renames.push(paths);
      },
      writeFile: async (
        path: string,
        data: string,
        options: Record<string, unknown>,
      ) => {
        writes.push({ path, data, options });
      },
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.options).toMatchObject({ flag: "wx", mode: 0o600 });
    expect(writes[0]?.data).not.toContain(standardToken());
    expect(renames).toEqual([[writes[0]?.path, "/proof/result.json"]]);
  });

  it("distinguishes denial, boundary bypass, and configuration statuses", () => {
    expect(classifyNegativeStatus(401)).toBe("denied");
    expect(classifyNegativeStatus(403)).toBe("denied");
    expect(classifyNegativeStatus(200)).toBe("boundary_failed");
    expect(classifyNegativeStatus(404)).toBe("network_or_configuration");
    expect(classifyNegativeStatus(503)).toBe("network_or_configuration");
  });

  it("proves owner CRUD and signed non-Clerk denial with redacted statuses", async () => {
    const fixtureId = "sub_proof_fixture";
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const responses = [
      new Response(JSON.stringify([{ id: fixtureId, version: 1 }]), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify([{ id: fixtureId, version: 1 }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify([{ id: fixtureId, version: 2 }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response("negative-token-body-must-not-leak", { status: 401 }),
      new Response(JSON.stringify([{ id: fixtureId }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ];
    const fetcher = async (input: string | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    };

    const result = await runHostedDataPlaneProof({
      fetcher,
      fixtureId,
      negativeToken: standardToken(),
      nowSeconds,
      publishableKey: "sb_publishable_fixture",
      sessionToken: standardToken(),
      timestamp: "2026-08-06T00:00:00.000Z",
      today: "2026-08-06",
    });

    expect(result).toEqual({
      outcome: "passed",
      timestamp: "2026-08-06T00:00:00.000Z",
      issuer,
      project: "subtrack-dev",
      projectRef: "qjsyhvclllikkopjfqtc",
      fixtureId,
      positive: { create: 201, read: 200, update: 200, delete: 200 },
      negative: { status: 401, classification: "denied" },
      cleanup: { status: 200, outcome: "removed" },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /standardToken|negative-token-body|authorization|apikey/i,
    );
    expect(calls).toHaveLength(5);
  });

  it("reports only the received create status and still cleans up", async () => {
    const fixtureId = "sub_proof_create_status";
    const calls: RequestInit[] = [];
    const responses = [
      new Response("secret create response", { status: 503 }),
      new Response(JSON.stringify([{ id: fixtureId }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ];

    const error = await runHostedDataPlaneProof({
      fetcher: async (_input: string | URL, init?: RequestInit) => {
        calls.push(init ?? {});
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      },
      fixtureId,
      negativeToken: standardToken(),
      nowSeconds,
      publishableKey: "sb_publishable_fixture",
      sessionToken: standardToken(),
      timestamp: "2026-08-06T00:00:00.000Z",
      today: "2026-08-06",
    }).catch((caught: unknown) => caught);

    const serialized = formatRedactedFailure(error);
    expect(JSON.parse(serialized).failure).toEqual({
      code: "positive_create",
      status: 503,
    });
    expect(serialized).not.toContain("secret create response");
    expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE"]);
  });

  it("reads an HTTP status from the native response slot, not a hostile getter", async () => {
    const fixtureId = "sub_proof_native_status";
    const hostile = new Response("secret create response", { status: 503 });
    let getterReads = 0;
    Object.defineProperty(hostile, "status", {
      get: () => {
        getterReads += 1;
        return 418;
      },
    });
    const responses = [
      hostile,
      new Response(JSON.stringify([{ id: fixtureId }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ];

    const error = await runHostedDataPlaneProof({
      fetcher: async () => {
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      },
      fixtureId,
      negativeToken: standardToken(),
      nowSeconds,
      publishableKey: "sb_publishable_fixture",
      sessionToken: standardToken(),
      timestamp: "2026-08-06T00:00:00.000Z",
      today: "2026-08-06",
    }).catch((caught: unknown) => caught);

    expect(JSON.parse(formatRedactedFailure(error)).failure).toEqual({
      code: "positive_create",
      status: 503,
    });
    expect(getterReads).toBe(0);
  });

  it("reports only the received read status and still cleans up", async () => {
    const fixtureId = "sub_proof_read_status";
    const methods: Array<string | undefined> = [];
    const responses = [
      new Response(JSON.stringify([{ id: fixtureId, version: 1 }]), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
      new Response("secret read response", { status: 502 }),
      new Response(JSON.stringify([{ id: fixtureId }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ];

    const error = await runHostedDataPlaneProof({
      fetcher: async (_input: string | URL, init?: RequestInit) => {
        methods.push(init?.method);
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      },
      fixtureId,
      negativeToken: standardToken(),
      nowSeconds,
      publishableKey: "sb_publishable_fixture",
      sessionToken: standardToken(),
      timestamp: "2026-08-06T00:00:00.000Z",
      today: "2026-08-06",
    }).catch((caught: unknown) => caught);

    expect(JSON.parse(formatRedactedFailure(error)).failure).toEqual({
      code: "positive_read",
      status: 502,
    });
    expect(methods).toEqual(["POST", "GET", "DELETE"]);
  });

  it("removes the fixture after a partial positive-proof failure", async () => {
    const fixtureId = "sub_proof_partial";
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const responses = [
      new Response(JSON.stringify([{ id: fixtureId, version: 1 }]), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify([{ id: fixtureId, version: 1 }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response("database-body-secret", { status: 500 }),
      new Response(JSON.stringify([{ id: fixtureId }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ];
    const fetcher = async (input: string | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    };

    const error = await runHostedDataPlaneProof({
      fetcher,
      fixtureId,
      negativeToken: standardToken(),
      nowSeconds,
      publishableKey: "sb_publishable_fixture",
      sessionToken: standardToken(),
      timestamp: "2026-08-06T00:00:00.000Z",
      today: "2026-08-06",
    }).catch((caught: unknown) => caught);

    const serialized = formatRedactedFailure(error);
    expect(JSON.parse(serialized).failure).toEqual({
      code: "positive_update",
      status: 500,
    });
    expect(serialized).not.toContain("database-body-secret");
    expect(calls.at(-1)?.init?.method).toBe("DELETE");
    expect(calls).toHaveLength(4);
  });

  it("reports a negative-route outage as configuration rather than denial", async () => {
    const fixtureId = "sub_proof_negative_config";
    const responses = [
      new Response(JSON.stringify([{ id: fixtureId, version: 1 }]), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify([{ id: fixtureId, version: 1 }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify([{ id: fixtureId, version: 2 }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(null, { status: 404 }),
      new Response(JSON.stringify([{ id: fixtureId }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ];

    const error = await runHostedDataPlaneProof({
      fetcher: async () => {
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      },
      fixtureId,
      negativeToken: standardToken(),
      nowSeconds,
      publishableKey: "sb_publishable_fixture",
      sessionToken: standardToken(),
      timestamp: "2026-08-06T00:00:00.000Z",
      today: "2026-08-06",
    }).catch((caught: unknown) => caught);

    expect(JSON.parse(formatRedactedFailure(error)).failure).toEqual({
      code: "negative_configuration",
      status: 404,
    });
    expect(responses).toHaveLength(0);
  });

  it("classifies a signed non-Clerk success only as a boundary failure status", async () => {
    const fixtureId = "sub_proof_negative_boundary";
    const responses = [
      new Response(JSON.stringify([{ id: fixtureId, version: 1 }]), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify([{ id: fixtureId, version: 1 }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify([{ id: fixtureId, version: 2 }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response("secret boundary response", { status: 200 }),
      new Response(JSON.stringify([{ id: fixtureId }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ];

    const error = await runHostedDataPlaneProof({
      fetcher: async () => {
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      },
      fixtureId,
      negativeToken: standardToken(),
      nowSeconds,
      publishableKey: "sb_publishable_fixture",
      sessionToken: standardToken(),
      timestamp: "2026-08-06T00:00:00.000Z",
      today: "2026-08-06",
    }).catch((caught: unknown) => caught);

    const serialized = formatRedactedFailure(error);
    expect(JSON.parse(serialized).failure).toEqual({
      code: "negative_boundary",
      status: 200,
    });
    expect(serialized).not.toContain("secret boundary response");
  });

  it("fails closed with a redacted cleanup classification", async () => {
    const fixtureId = "sub_proof_cleanup_failure";
    const responses = [
      new Response(JSON.stringify([{ id: fixtureId, version: 1 }]), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify([{ id: fixtureId, version: 1 }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify([{ id: fixtureId, version: 2 }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(null, { status: 403 }),
      new Response("cleanup-database-secret", { status: 500 }),
    ];

    const error = await runHostedDataPlaneProof({
      fetcher: async () => {
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      },
      fixtureId,
      negativeToken: standardToken(),
      nowSeconds,
      publishableKey: "sb_publishable_fixture",
      sessionToken: standardToken(),
      timestamp: "2026-08-06T00:00:00.000Z",
      today: "2026-08-06",
    }).catch((caught: unknown) => caught);

    expect(JSON.parse(formatRedactedFailure(error)).failure).toEqual({
      code: "cleanup",
      status: 500,
    });
    expect(formatRedactedFailure(error)).not.toContain(
      "cleanup-database-secret",
    );
  });
});

describe("loopback-only token handoff", () => {
  it("rejects a non-base64url channel before binding a listener", async () => {
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );

    await expect(
      startLoopbackTokenReceiver({
        state: '"'.repeat(43),
        timeoutMs: 2_000,
      }),
    ).rejects.toThrowError("hosted_proof_failed");
  });

  it("serves a no-store browser sign-in page with exact Clerk runtime versions", async () => {
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );
    const receiver = await startLoopbackTokenReceiver({
      state: "p".repeat(43),
      timeoutMs: 2_000,
    });
    void receiver.token.catch(() => undefined);

    const response = await fetch(receiver.url);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(html).toContain("@clerk/clerk-js@6.26.0/dist/clerk.browser.js");
    expect(html).toContain("@clerk/ui@1.28.0/dist/ui.browser.js");
    expect(html).toContain("Clerk.mountSignIn");
    expect(html).toContain("getToken({ skipCache: true })");
    expect(html).toContain('reportFailure("browser_ui")');
    expect(html).toContain('reportFailure("token_handoff")');
    expect(html).not.toMatch(/\.message|\.stack|\.cause/);
    expect(html).not.toMatch(
      /getToken\([^)]*template|localStorage|sessionStorage|indexedDB/i,
    );
    await receiver.close();
  });

  it("serves the initial page for one exact opaque development-browser handshake without reflecting it", async () => {
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );
    const receiver = await startLoopbackTokenReceiver({
      state: "j".repeat(43),
      timeoutMs: 2_000,
    });
    void receiver.token.catch(() => undefined);
    const handshake = "fixture_header.fixture_payload.fixture_signature";
    const requestUrl = new URL(receiver.url);
    requestUrl.search = `?__clerk_db_jwt=${handshake}`;

    const response = await fetch(requestUrl);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(html).not.toContain(handshake);
    await receiver.close();
  });

  it("lets Clerk load consume the handshake before clearing history and continuing", async () => {
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );
    const receiver = await startLoopbackTokenReceiver({
      state: "k".repeat(43),
      timeoutMs: 2_000,
    });
    void receiver.token.catch(() => undefined);
    const requestUrl = new URL(receiver.url);
    requestUrl.search = "?__clerk_db_jwt=browser.header.fixture_signature";
    const response = await fetch(requestUrl);
    const html = await response.text();
    const browserScript = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(
      html,
    )?.[1];
    expect(browserScript).toBeDefined();
    expect(html).not.toContain("__clerk_db_jwt");

    const events: string[] = [];
    let loadListener: (() => Promise<void>) | undefined;
    const location = {
      href: requestUrl.toString(),
      origin: requestUrl.origin,
    };
    const inertElement = () => ({
      addEventListener: () => undefined,
      replaceChildren: () => undefined,
      textContent: "",
    });
    const elements = new Map([
      ["cancel", inertElement()],
      ["sign-in", inertElement()],
      ["status", inertElement()],
    ]);
    const windowFixture = {
      __internal_ClerkUICtor: class {},
      addEventListener: (event: string, listener: () => Promise<void>) => {
        if (event === "load") loadListener = listener;
      },
      history: {
        replaceState: (_state: null, _unused: string, path: string) => {
          events.push("history");
          location.href = `${location.origin}${path}`;
        },
      },
      location,
    };
    const clerkFixture = {
      addListener: () => {
        events.push("listener");
      },
      load: async (options: {
        signInForceRedirectUrl: string;
        signUpForceRedirectUrl: string;
      }) => {
        events.push("load");
        expect(location.href).toContain("?__clerk_db_jwt=");
        expect(options.signInForceRedirectUrl).toBe(`${location.origin}/`);
        expect(options.signUpForceRedirectUrl).toBe(`${location.origin}/`);
      },
      mountSignIn: () => {
        events.push("mount");
        expect(location.href).toBe(`${location.origin}/`);
      },
      session: null,
    };
    let fetchCalls = 0;
    runInNewContext(browserScript, {
      Clerk: clerkFixture,
      document: {
        getElementById: (id: string) => elements.get(id),
      },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("unexpected fetch");
      },
      window: windowFixture,
    });

    expect(loadListener).toBeDefined();
    await loadListener?.();
    expect(events).toEqual(["load", "history", "listener", "mount"]);
    expect(fetchCalls).toBe(0);
    await receiver.close();
  });

  it("scrubs a rejected Clerk load before reporting the browser failure", async () => {
    const page = await createBrowserScriptHarness({
      clerkLoad: async () => {
        throw new Error("synthetic load rejection");
      },
    });

    try {
      await page.start();

      expect(page.events).toEqual([
        "load",
        "history",
        "fetch:/failure",
        "status:Clerk sign-in could not start. Return to the terminal.",
        "clear",
      ]);
      expect(page.location.href).toBe(`${page.location.origin}/`);
      expect(page.events).not.toContain("listener");
      expect(page.events).not.toContain("mount");
      expect(page.events).not.toContain("fetch:/token");
      expect(page.events).not.toContain("fetch:/cancel");
    } finally {
      await page.close();
    }
  });

  it("scrubs an immediate cancellation while Clerk load is pending and stops continuation", async () => {
    const load = deferred();
    const page = await createBrowserScriptHarness({
      clerkLoad: () => load.promise,
    });

    try {
      const loading = page.start();
      await page.cancel();
      load.resolve();
      await loading;

      expect(page.events).toEqual([
        "load",
        "history",
        "fetch:/cancel",
        "status:Proof cancelled. Return to the terminal.",
        "clear",
      ]);
      expect(page.location.href).toBe(`${page.location.origin}/`);
      expect(page.events).not.toContain("listener");
      expect(page.events).not.toContain("mount");
      expect(page.events).not.toContain("fetch:/failure");
      expect(page.events).not.toContain("fetch:/token");
    } finally {
      load.resolve();
      await page.close();
    }
  });

  it("lets cancellation win while session token acquisition is pending", async () => {
    const token = deferred<string>();
    const tokenRequested = deferred();
    const page = await createBrowserScriptHarness({
      session: {
        getToken: () => {
          tokenRequested.resolve();
          return token.promise;
        },
      },
    });

    try {
      const starting = page.start();
      await tokenRequested.promise;
      await page.cancel();
      token.resolve(standardToken());
      await starting;

      expect(page.events).toEqual([
        "load",
        "history",
        "listener",
        "fetch:/cancel",
        "status:Proof cancelled. Return to the terminal.",
        "clear",
      ]);
      expect(page.events).not.toContain("fetch:/token");
      expect(page.events).not.toContain("fetch:/failure");
    } finally {
      token.resolve(standardToken());
      await page.close();
    }
  });

  it("lets an accepted token handoff win before its browser continuation", async () => {
    const tokenPosted = deferred();
    const tokenResponse = deferred<{ ok: boolean }>();
    const page = await createBrowserScriptHarness({
      fetcher: (path) => {
        if (path === "/token") {
          tokenPosted.resolve();
          return tokenResponse.promise;
        }
        return Promise.resolve({ ok: true });
      },
      session: {
        getToken: async () => standardToken(),
      },
    });

    try {
      const starting = page.start();
      await tokenPosted.promise;
      expect(page.cancelDisabled).toBe(true);
      await page.cancel();
      tokenResponse.resolve({ ok: true });
      await starting;

      expect(page.events).toEqual([
        "load",
        "history",
        "listener",
        "fetch:/token",
        "status:Token received. Return to the terminal for the redacted result.",
        "clear",
      ]);
      expect(page.events).not.toContain("fetch:/cancel");
      expect(page.events).not.toContain("fetch:/failure");
    } finally {
      tokenResponse.resolve({ ok: true });
      await page.close();
    }
  });

  it("settles a load-failure and cancellation race through only one reporting path", async () => {
    const failureStarted = deferred();
    const failureResponse = deferred<{ ok: boolean }>();
    const page = await createBrowserScriptHarness({
      clerkLoad: async () => {
        throw new Error("synthetic load rejection");
      },
      fetcher: (path) => {
        if (path === "/failure") {
          failureStarted.resolve();
          return failureResponse.promise;
        }
        return Promise.resolve({ ok: true });
      },
    });

    try {
      const loading = page.start();
      await failureStarted.promise;
      await page.cancel();
      failureResponse.resolve({ ok: true });
      await loading;

      expect(page.events).toEqual([
        "load",
        "history",
        "fetch:/failure",
        "status:Clerk sign-in could not start. Return to the terminal.",
        "clear",
      ]);
      expect(page.events.filter((event) => event === "history")).toHaveLength(
        1,
      );
      expect(page.events).not.toContain("fetch:/cancel");
      expect(page.events).not.toContain("listener");
      expect(page.events).not.toContain("mount");
      expect(page.events).not.toContain("fetch:/token");
    } finally {
      failureResponse.resolve({ ok: true });
      await page.close();
    }
  });

  it("fails locally without auth or handoff work when browser history cannot be scrubbed", async () => {
    const page = await createBrowserScriptHarness({
      replaceState: () => {
        throw new Error("synthetic history failure");
      },
    });

    try {
      await expect(page.start()).resolves.toBeUndefined();
      await page.cancel();

      expect(page.events).toEqual([
        "load",
        "history",
        "status:Proof stopped because the browser address could not be cleared. Close this tab and return to the terminal.",
        "clear",
      ]);
      expect(page.statusText).toBe(
        "Proof stopped because the browser address could not be cleared. Close this tab and return to the terminal.",
      );
      expect(page.cancelDisabled).toBe(true);
      expect(page.events.filter((event) => event === "history")).toHaveLength(
        1,
      );
      expect(page.events.some((event) => event.startsWith("fetch:"))).toBe(
        false,
      );
      expect(page.events).not.toContain("listener");
      expect(page.events).not.toContain("mount");
      expect(page.location.href).toContain("?__clerk_db_jwt=");
    } finally {
      await page.close();
    }
  });

  it("accepts a development-browser handshake request target only once", async () => {
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );
    const receiver = await startLoopbackTokenReceiver({
      state: "w".repeat(43),
      timeoutMs: 2_000,
    });
    void receiver.token.catch(() => undefined);
    const requestUrl = new URL(receiver.url);
    requestUrl.search =
      "?__clerk_db_jwt=replay_header.replay_payload.replay_signature";

    const first = await fetch(requestUrl);
    await first.text();
    const replay = await fetch(requestUrl);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(403);
    expect(await replay.text()).toBe("");
    await receiver.close();
  });

  it("accepts a bounded compact handshake and rejects the next byte", async () => {
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );
    const receiver = await startLoopbackTokenReceiver({
      state: "x".repeat(43),
      timeoutMs: 2_000,
    });
    void receiver.token.catch(() => undefined);
    const overlong = `a.b.${"c".repeat(8_189)}`;
    const bounded = `a.b.${"c".repeat(8_188)}`;

    const rejected = await fetch(`${receiver.url}?__clerk_db_jwt=${overlong}`);
    const accepted = await fetch(`${receiver.url}?__clerk_db_jwt=${bounded}`);

    expect(overlong).toHaveLength(8_193);
    expect(bounded).toHaveLength(8_192);
    expect(rejected.status).toBe(403);
    expect(await rejected.text()).toBe("");
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).not.toContain(bounded);
    await receiver.close();
  });

  it("rejects duplicate, extra, malformed, and ambiguously encoded handshake targets without reflection", async () => {
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );
    const receiver = await startLoopbackTokenReceiver({
      state: "e".repeat(43),
      timeoutMs: 2_000,
    });
    void receiver.token.catch(() => undefined);
    const port = Number(new URL(receiver.url).port);
    const hostileTargets = [
      "/?__clerk_db_jwt=",
      "/?__clerk_db_jwt=only.two",
      "/?__clerk_db_jwt=empty..segment",
      "/?__clerk_db_jwt=a.b.c&__clerk_db_jwt=d.e.f",
      "/?__clerk_db_jwt=a.b.c&next=fixture",
      "/?%5F%5Fclerk_db_jwt=a.b.c",
      "/?__clerk_db_jwt=a%2Eb%2Ec",
      "/?__clerk_db_jwt=a.b.c%26next%3Dfixture",
      "/?__clerk_db_jwt=a.b.c#fragment",
      "/%2F?__clerk_db_jwt=a.b.c",
      "//?__clerk_db_jwt=a.b.c",
      "/other?__clerk_db_jwt=a.b.c",
    ];

    for (const target of hostileTargets) {
      const response = await rawHttpRequest(port, target);
      expect(response.status, target).toBe(403);
      expect(response.body, target).toBe("");
      expect(response.body, target).not.toContain("a.b.c");
    }

    const accepted = await rawHttpRequest(
      port,
      "/?__clerk_db_jwt=exact.header.signature",
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body).not.toContain("exact.header.signature");
    await receiver.close();
  });

  it("rejects handshake-shaped requests with another method, path form, or Host", async () => {
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );
    const receiver = await startLoopbackTokenReceiver({
      state: "v".repeat(43),
      timeoutMs: 2_000,
    });
    void receiver.token.catch(() => undefined);
    const loopbackUrl = new URL(receiver.url);
    const port = Number(loopbackUrl.port);
    const target = "/?__clerk_db_jwt=exact.header.signature";

    const wrongMethod = await rawHttpRequest(port, target, { method: "HEAD" });
    const absoluteForm = await rawHttpRequest(
      port,
      `${loopbackUrl.origin}${target}`,
    );
    const wrongHost = await rawHttpRequest(port, target, {
      host: "attacker.example",
    });

    expect(wrongMethod.status).toBe(403);
    expect(wrongMethod.body).toBe("");
    expect(absoluteForm.status).toBe(403);
    expect(absoluteForm.body).toBe("");
    expect(wrongHost.status).toBe(403);
    expect(wrongHost.body).toBe("");
    await receiver.close();
  });

  it("documents a clean development-handshake rerun and immediate session teardown", async () => {
    const runbook = await readFile(
      "docs/security/hosted-clerk-proof.md",
      "utf8",
    );

    expect(runbook).toContain("Close every old loopback or Clerk sign-in tab");
    expect(runbook).toContain("start a fresh command");
    expect(runbook).toContain("Clerk.load()");
    expect(runbook).toContain("history.replaceState");
    expect(runbook).toContain(
      "successful load, rejected load, or cancellation while loading",
    );
    expect(runbook).toContain(
      "performs no authentication or loopback handoff work",
    );
    expect(runbook).toContain(
      "Cancellation wins while token acquisition is pending",
    );
    expect(runbook).toMatch(
      /token delivery starts,\s+cancellation is disabled and\s+inert/,
    );
    expect(runbook).toContain("end the Clerk test session");
    expect(runbook).toMatch(/re-enable bot protection\s+immediately/);
  });

  it("accepts one exact-origin JSON handoff carrying the per-run state", async () => {
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );
    const state = "s".repeat(43);
    const receiver = await startLoopbackTokenReceiver({
      state,
      timeoutMs: 2_000,
    });
    const origin = new URL(receiver.url).origin;

    const response = await fetch(new URL("/token", origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify({ state, token: standardToken() }),
    });

    expect(response.status).toBe(204);
    await expect(receiver.token).resolves.toBe(standardToken());
    await receiver.close();
  });

  it("accepts the single-use state only once under concurrent replay", async () => {
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );
    const state = "r".repeat(43);
    const receiver = await startLoopbackTokenReceiver({
      state,
      timeoutMs: 2_000,
    });
    const origin = new URL(receiver.url).origin;
    const submit = (token: string) =>
      fetch(new URL("/token", origin), {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ state, token }),
      }).then(
        (response) => response.status,
        () => -1,
      );

    const statuses = await Promise.all([
      submit(standardToken()),
      submit(`${standardToken()}-replay`),
    ]);

    expect(statuses.filter((status) => status === 204)).toHaveLength(1);
    await receiver.token;
    await receiver.close();
  });

  it("rejects a replay whose headers arrived before the first body", async () => {
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );
    const state = "q".repeat(43);
    const receiver = await startLoopbackTokenReceiver({
      state,
      timeoutMs: 2_000,
    });
    const url = new URL(receiver.url);
    const first = stagedJsonPost(
      Number(url.port),
      url.origin,
      JSON.stringify({ state, token: standardToken() }),
    );
    const replay = stagedJsonPost(
      Number(url.port),
      url.origin,
      JSON.stringify({ state, token: `${standardToken()}-replay` }),
    );
    await Promise.all([first.ready, replay.ready]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    first.sendBody();
    replay.sendBody();
    const statuses = await Promise.all([first.status, replay.status]);

    expect(statuses.filter((status) => status === 204)).toHaveLength(1);
    await receiver.token;
    await receiver.close();
  });

  it("rejects an oversized handoff body without accepting its token", async () => {
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );
    const state = "b".repeat(43);
    const receiver = await startLoopbackTokenReceiver({
      state,
      timeoutMs: 2_000,
    });
    void receiver.token.catch(() => undefined);
    const origin = new URL(receiver.url).origin;

    const response = await fetch(new URL("/token", origin), {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ state, token: "x".repeat(20_000) }),
    });

    expect(response.status).toBe(413);
    await receiver.close();
  });

  it("rejects a handoff payload with unexpected fields", async () => {
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );
    const state = "m".repeat(43);
    const receiver = await startLoopbackTokenReceiver({
      state,
      timeoutMs: 2_000,
    });
    void receiver.token.catch(() => undefined);
    const origin = new URL(receiver.url).origin;

    const response = await fetch(new URL("/token", origin), {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        state,
        token: standardToken(),
        persistedToken: standardToken(),
      }),
    });

    expect(response.status).toBe(400);
    await receiver.close();
  });

  it("rejects a hostile browser origin", async () => {
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );
    const state = "o".repeat(43);
    const receiver = await startLoopbackTokenReceiver({
      state,
      timeoutMs: 2_000,
    });
    void receiver.token.catch(() => undefined);
    const origin = new URL(receiver.url).origin;

    const response = await fetch(new URL("/token", origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ state, token: standardToken() }),
    });

    expect(response.status).toBe(403);
    await receiver.close();
  });

  it("rejects a hostile Host header even from the loopback socket", async () => {
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );
    const state = "h".repeat(43);
    const receiver = await startLoopbackTokenReceiver({
      state,
      timeoutMs: 2_000,
    });
    void receiver.token.catch(() => undefined);
    const url = new URL(receiver.url);
    const hostile = stagedJsonPost(
      Number(url.port),
      url.origin,
      JSON.stringify({ state, token: standardToken() }),
      "attacker.example",
    );
    await hostile.ready;
    hostile.sendBody();

    await expect(hostile.status).resolves.toBe(403);
    await receiver.close();
  });

  it("times out and shuts down without receiving a token", async () => {
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );
    const receiver = await startLoopbackTokenReceiver({
      state: "t".repeat(43),
      timeoutMs: 20,
    });

    await expect(receiver.token).rejects.toThrowError("hosted_proof_failed");
    await expect(fetch(receiver.url)).rejects.toBeDefined();
    await receiver.close();
  });

  it("fails closed and shuts down when the browser cancels", async () => {
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );
    const state = "c".repeat(43);
    const receiver = await startLoopbackTokenReceiver({
      state,
      timeoutMs: 2_000,
    });
    const origin = new URL(receiver.url).origin;
    const rejectedToken = receiver.token.catch((caught: unknown) => caught);

    const response = await fetch(new URL("/cancel", origin), {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ state }),
    });

    expect(response.status).toBe(204);
    const error = await rejectedToken;
    expect(JSON.parse(formatRedactedFailure(error)).failure).toEqual({
      code: "user_cancelled",
    });
    const settledHandshake = new URL(receiver.url);
    settledHandshake.search = "?__clerk_db_jwt=settled.header.signature";
    await expect(fetch(settledHandshake)).rejects.toBeDefined();
    await receiver.close();
  });

  it("accepts only a safe browser UI failure code and shuts down", async () => {
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );
    const state = "u".repeat(43);
    const receiver = await startLoopbackTokenReceiver({
      state,
      timeoutMs: 2_000,
    });
    const origin = new URL(receiver.url).origin;
    const rejectedToken = receiver.token.catch((caught: unknown) => caught);

    const response = await fetch(new URL("/failure", origin), {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ state, code: "browser_ui" }),
    });
    if (response.status !== 204) await receiver.close();
    const error = await rejectedToken;

    expect(response.status).toBe(204);
    expect(JSON.parse(formatRedactedFailure(error)).failure).toEqual({
      code: "browser_ui",
    });
    await receiver.close();
  });

  it("accepts only a safe token-handoff failure code and shuts down", async () => {
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );
    const state = "f".repeat(43);
    const receiver = await startLoopbackTokenReceiver({
      state,
      timeoutMs: 2_000,
    });
    const origin = new URL(receiver.url).origin;
    const rejectedToken = receiver.token.catch((caught: unknown) => caught);

    const response = await fetch(new URL("/failure", origin), {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ state, code: "token_handoff" }),
    });
    if (response.status !== 204) await receiver.close();
    const error = await rejectedToken;

    expect(response.status).toBe(204);
    expect(JSON.parse(formatRedactedFailure(error)).failure).toEqual({
      code: "token_handoff",
    });
    await receiver.close();
  });

  it("rejects unallowlisted browser failure detail without reflecting it", async () => {
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );
    const state = "d".repeat(43);
    const receiver = await startLoopbackTokenReceiver({
      state,
      timeoutMs: 2_000,
    });
    void receiver.token.catch(() => undefined);
    const origin = new URL(receiver.url).origin;

    const response = await fetch(new URL("/failure", origin), {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        state,
        code: "browser_ui",
        message: `secret ${standardToken()} personal@example.com`,
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
    await receiver.close();
  });
});

describe("one-shot hosted proof command", () => {
  it("exposes one fixed command backed by the repository-pinned Supabase CLI", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8"));
    const cli = await readFile("scripts/hosted-clerk-proof/cli.mjs", "utf8");
    const ignore = await readFile(".gitignore", "utf8");

    expect(manifest.scripts["prove:hosted-clerk:subtrack-dev"]).toBe(
      "node scripts/hosted-clerk-proof/cli.mjs",
    );
    expect(cli).toContain("node_modules/.bin/supabase");
    expect(cli).toContain("qjsyhvclllikkopjfqtc");
    expect(cli).toContain("steady-ladybug-22.clerk.accounts.dev");
    expect(cli).not.toMatch(/\bnpx\b|@latest|--reveal|service_role|sb_secret_/);
    expect(ignore).toMatch(/^\.proof\/$/m);
  });

  it("prints only the reconstructed closed failure contract", async () => {
    const execution = await new Promise<{
      code: number | string | undefined;
      stderr: string;
      stdout: string;
    }>((resolveExecution) => {
      execFile(
        process.execPath,
        ["scripts/hosted-clerk-proof/cli.mjs", "unexpected-secret-argument"],
        { cwd: process.cwd(), encoding: "utf8" },
        (error, stdout, stderr) => {
          resolveExecution({
            code:
              error !== null && "code" in error
                ? (error.code ?? undefined)
                : undefined,
            stderr,
            stdout,
          });
        },
      );
    });

    expect(execution.code).toBe(1);
    expect(execution.stdout).toBe("");
    expect(JSON.parse(execution.stderr)).toEqual({
      outcome: "failed",
      issuer,
      project: "subtrack-dev",
      projectRef: "qjsyhvclllikkopjfqtc",
      failure: { code: "transport_or_configuration" },
    });
    expect(execution.stderr).not.toMatch(
      /unexpected-secret-argument|message|stack|body|header|url|token|identity|cli/i,
    );
  });

  it("opens the browser, runs the proof, persists redacted evidence, and closes", async () => {
    const { runHostedProofHarness } = await import(
      "../scripts/hosted-clerk-proof/command.mjs"
    );
    const token = standardToken();
    const result = {
      outcome: "passed",
      timestamp: "2026-08-06T00:00:00.000Z",
      issuer,
      project: "subtrack-dev",
      projectRef: "qjsyhvclllikkopjfqtc",
      fixtureId: "sub_proof_07070707070707070707070707070707",
      positive: { create: 201, read: 200, update: 200, delete: 200 },
      negative: { status: 401, classification: "denied" },
      cleanup: { status: 200, outcome: "removed" },
    };
    const events: string[] = [];
    const output: string[] = [];

    await expect(
      runHostedProofHarness({
        discoverKeys: async () => {
          events.push("keys");
          return {
            publishableKey: "sb_publishable_fixture",
            negativeToken: `${token}-negative`,
          };
        },
        now: () => new Date("2026-08-06T00:00:00.000Z"),
        openBrowser: async (url: string) => {
          events.push(`browser:${new URL(url).hostname}`);
        },
        persist: async (value: unknown) => {
          events.push("persist");
          expect(value).toEqual(result);
        },
        print: (value: string) => {
          events.push("print");
          output.push(value);
        },
        prove: async (options: Record<string, unknown>) => {
          events.push("prove");
          expect(options.sessionToken).toBe(token);
          return result;
        },
        randomBytes: (size: number) => Buffer.alloc(size, 7),
        startReceiver: async ({ state }: { state: string }) => {
          expect(state).toHaveLength(43);
          events.push("receiver");
          return {
            url: "http://127.0.0.1:49152/",
            token: Promise.resolve(token),
            close: async () => {
              events.push("close");
            },
          };
        },
      }),
    ).resolves.toEqual(result);

    expect(events).toEqual([
      "keys",
      "receiver",
      "browser:127.0.0.1",
      "prove",
      "persist",
      "print",
      "close",
    ]);
    expect(output.join("\n")).not.toContain(token);
  });

  it("classifies key discovery before opening a browser or persisting evidence", async () => {
    const { runHostedProofHarness } = await import(
      "../scripts/hosted-clerk-proof/command.mjs"
    );
    let laterCalls = 0;

    const error = await runHostedProofHarness({
      discoverKeys: async () => {
        throw new Error(`secret CLI ${standardToken()}`);
      },
      now: () => new Date("2026-08-06T00:00:00.000Z"),
      openBrowser: async () => {
        laterCalls += 1;
      },
      persist: async () => {
        laterCalls += 1;
      },
      print: () => {
        laterCalls += 1;
      },
      prove: async () => {
        laterCalls += 1;
      },
      randomBytes: (size: number) => Buffer.alloc(size, 1),
      startReceiver: async () => {
        laterCalls += 1;
        throw new Error("must-not-run");
      },
    }).catch((caught: unknown) => caught);

    expect(JSON.parse(formatRedactedFailure(error)).failure).toEqual({
      code: "public_key_discovery",
    });
    expect(laterCalls).toBe(0);
  });

  it("classifies an opaque receiver rejection only as token handoff", async () => {
    const { runHostedProofHarness } = await import(
      "../scripts/hosted-clerk-proof/command.mjs"
    );
    let proofOrPersistenceCalls = 0;
    let closed = false;

    const error = await runHostedProofHarness({
      discoverKeys: async () => ({
        publishableKey: "sb_publishable_fixture",
        negativeToken: standardToken(),
      }),
      now: () => new Date("2026-08-06T00:00:00.000Z"),
      openBrowser: async () => undefined,
      persist: async () => {
        proofOrPersistenceCalls += 1;
      },
      print: () => {
        proofOrPersistenceCalls += 1;
      },
      prove: async () => {
        proofOrPersistenceCalls += 1;
      },
      randomBytes: (size: number) => Buffer.alloc(size, 2),
      startReceiver: async () => ({
        url: "http://127.0.0.1:49152/",
        token: Promise.reject(
          new Error(`secret handoff ${standardToken()} personal@example.com`),
        ),
        close: async () => {
          closed = true;
        },
      }),
    }).catch((caught: unknown) => caught);

    const serialized = formatRedactedFailure(error);
    expect(JSON.parse(serialized).failure).toEqual({
      code: "token_handoff",
    });
    expect(serialized).not.toMatch(/secret handoff|personal@example|eyJ/);
    expect(proofOrPersistenceCalls).toBe(0);
    expect(closed).toBe(true);
  });

  it("closes cleanly without an unhandled token rejection when browser launch fails", async () => {
    const { runHostedProofHarness } = await import(
      "../scripts/hosted-clerk-proof/command.mjs"
    );
    const { startLoopbackTokenReceiver } = await import(
      "../scripts/hosted-clerk-proof/loopback.mjs"
    );

    const error = await runHostedProofHarness({
      discoverKeys: async () => ({
        publishableKey: "sb_publishable_fixture",
        negativeToken: standardToken(),
      }),
      now: () => new Date("2026-08-06T00:00:00.000Z"),
      openBrowser: async () => {
        throw new Error("browser-command-secret");
      },
      persist: async () => undefined,
      print: () => undefined,
      prove: async () => {
        throw new Error("must-not-run");
      },
      randomBytes: (size: number) => Buffer.alloc(size, 9),
      startReceiver: startLoopbackTokenReceiver,
    }).catch((caught: unknown) => caught);

    expect(JSON.parse(formatRedactedFailure(error)).failure).toEqual({
      code: "browser_launch",
    });
    expect(formatRedactedFailure(error)).not.toContain(
      "browser-command-secret",
    );
  });
});

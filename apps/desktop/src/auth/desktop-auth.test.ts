import { describe, expect, it, vi } from "vitest";
import { createDesktopAuthRuntime } from "./desktop-auth";

const brokerSession = {
  accessToken: "access-token-never-rendered",
  expiresAt: 2_000_000_000_000,
  refreshCredential: "refresh-secret",
  subject: "user_123",
};
const codeVerifier = "v".repeat(64);

function configured(overrides: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>();
  const invoke = vi.fn(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "read_session_secret")
        return values.get("session") ?? null;
      if (command === "write_session_secret")
        values.set("session", args?.session);
      if (command === "clear_session_secret") values.delete("session");
      return undefined;
    },
  );
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/revoke")) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(brokerSession), { status: 200 });
  });
  const openUrl = vi.fn(async () => undefined);
  const runtime = createDesktopAuthRuntime(
    {
      VITE_AUTH_BROKER_URL:
        "https://auth.example.test/functions/v1/auth-broker",
    },
    {
      fetcher,
      invoke,
      openUrl,
      createPkce: async () => ({
        state: "state_456",
        verifier: codeVerifier,
        challenge: "challenge_123",
      }),
      ...overrides,
    },
  );
  return { fetcher, invoke, openUrl, runtime };
}

describe("desktop authentication composition", () => {
  it("coalesces concurrent secure startup into one credential refresh", async () => {
    let resolveRefresh!: (response: Response) => void;
    const refreshing = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const invoke = vi.fn(async (command: string) => {
      if (command === "read_session_secret") {
        return { refreshCredential: "refresh-old", subject: "user_123" };
      }
      return undefined;
    });
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/refresh")) return refreshing;
      return new Response(null, { status: 204 });
    });
    const { runtime } = configured({ fetcher, invoke });

    const first = runtime.boot();
    const second = runtime.boot();
    await vi.waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        expect.stringMatching(/\/refresh$/),
        expect.anything(),
      ),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolveRefresh(
      new Response(JSON.stringify(brokerSession), { status: 200 }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "signed_in", subject: "user_123" },
      { status: "signed_in", subject: "user_123" },
    ]);
  });
  it("does not restart verification when PKCE creation finishes after sign-out", async () => {
    let resolvePkce!: (binding: {
      state: string;
      verifier: string;
      challenge: string;
    }) => void;
    const creatingPkce = new Promise<Parameters<typeof resolvePkce>[0]>(
      (resolve) => {
        resolvePkce = resolve;
      },
    );
    const openUrl = vi.fn(async () => undefined);
    const { runtime } = configured({
      createPkce: () => creatingPkce,
      openUrl,
    });
    await runtime.boot();

    const beginning = runtime.beginSignIn();
    await runtime.signOut();
    resolvePkce({
      state: "state_456",
      verifier: codeVerifier,
      challenge: "challenge_123",
    });

    await expect(beginning).resolves.toEqual({ status: "signed_out" });
    expect(openUrl).not.toHaveBeenCalled();
    expect(runtime.snapshot()).toEqual({ status: "signed_out" });
  });

  it("does not let older sign-out cleanup replace a newly started verification", async () => {
    let resolveRevoke!: () => void;
    const revoking = new Promise<void>((resolve) => {
      resolveRevoke = resolve;
    });
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/revoke")) {
        await revoking;
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify(brokerSession), { status: 200 });
    });
    const { runtime } = configured({ fetcher });
    await runtime.boot();
    await runtime.beginSignIn();
    await runtime.handleCallback(
      "subtrack://auth/callback?code=code_123&state=state_456",
    );

    const signingOut = runtime.signOut();
    await vi.waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        expect.stringMatching(/\/revoke$/),
        expect.anything(),
      ),
    );
    await expect(runtime.beginSignIn()).resolves.toEqual({
      status: "verification_pending",
    });
    resolveRevoke();

    await expect(signingOut).resolves.toEqual({
      status: "verification_pending",
    });
    expect(runtime.snapshot()).toEqual({ status: "verification_pending" });
  });

  it("ignores a late callback from an abandoned verification attempt", async () => {
    const createPkce = vi
      .fn()
      .mockResolvedValueOnce({
        state: "state_old",
        verifier: codeVerifier,
        challenge: "challenge_old",
      })
      .mockResolvedValueOnce({
        state: "state_new",
        verifier: codeVerifier,
        challenge: "challenge_new",
      });
    const { fetcher, runtime } = configured({ createPkce });
    await runtime.boot();
    await runtime.beginSignIn();
    await runtime.signOut();
    await runtime.beginSignIn();

    await expect(
      runtime.handleCallback(
        "subtrack://auth/callback?code=code_old&state=state_old",
      ),
    ).resolves.toEqual({ status: "verification_pending" });
    await expect(
      runtime.handleCallback(
        "subtrack://auth/callback?code=code_new&state=state_new",
      ),
    ).resolves.toEqual({ status: "signed_in", subject: "user_123" });
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringMatching(/\/exchange$/),
      expect.objectContaining({
        body: JSON.stringify({ code: "code_new", codeVerifier }),
      }),
    );
  });

  it("coalesces repeated sign-in activation into one PKCE browser attempt", async () => {
    let resolvePkce!: (binding: {
      state: string;
      verifier: string;
      challenge: string;
    }) => void;
    const creating = new Promise<Parameters<typeof resolvePkce>[0]>(
      (resolve) => {
        resolvePkce = resolve;
      },
    );
    const createPkce = vi.fn(() => creating);
    const openUrl = vi.fn(async () => undefined);
    const { runtime } = configured({ createPkce, openUrl });
    await runtime.boot();

    const first = runtime.beginSignIn();
    const second = runtime.beginSignIn();
    expect(runtime.snapshot()).toEqual({ status: "verification_pending" });
    expect(createPkce).toHaveBeenCalledOnce();
    resolvePkce({
      state: "state_one",
      verifier: codeVerifier,
      challenge: "challenge_one",
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "verification_pending" },
      { status: "verification_pending" },
    ]);
    expect(openUrl).toHaveBeenCalledOnce();
  });

  it("keeps token accessors from replacing a verification-owned route", async () => {
    const neverCreates = new Promise<never>(() => undefined);
    const { runtime } = configured({ createPkce: () => neverCreates });
    await runtime.boot();

    void runtime.beginSignIn();
    expect(runtime.snapshot()).toEqual({ status: "verification_pending" });
    await expect(runtime.accessToken()).resolves.toBeNull();
    await expect(runtime.accessTokenLease()).resolves.toBeNull();
    expect(runtime.snapshot()).toEqual({ status: "verification_pending" });
  });

  it("does not republish a prior signed-in account during a new verification", async () => {
    const neverCreates = new Promise<never>(() => undefined);
    const createPkce = vi
      .fn()
      .mockResolvedValueOnce({
        state: "state_456",
        verifier: codeVerifier,
        challenge: "challenge_123",
      })
      .mockReturnValueOnce(neverCreates);
    const { runtime } = configured({ createPkce });
    await runtime.boot();
    await runtime.beginSignIn();
    await runtime.handleCallback(
      "subtrack://auth/callback?code=code_123&state=state_456",
    );

    void runtime.beginSignIn();
    expect(runtime.snapshot()).toEqual({ status: "verification_pending" });
    await expect(runtime.accessToken()).resolves.toBeNull();
    await expect(runtime.accessTokenLease()).resolves.toBeNull();
    expect(runtime.snapshot()).toEqual({ status: "verification_pending" });
  });

  it.each(["accessToken", "accessTokenLease"] as const)(
    "does not let %s refresh the prior account after a new callback is bound",
    async (accessor) => {
      const createPkce = vi
        .fn()
        .mockResolvedValueOnce({
          state: "state_a",
          verifier: codeVerifier,
          challenge: "challenge_a",
        })
        .mockResolvedValueOnce({
          state: "state_b",
          verifier: codeVerifier,
          challenge: "challenge_b",
        });
      let exchanges = 0;
      let refreshes = 0;
      const fetcher = vi.fn(async (url: string) => {
        if (url.endsWith("/refresh")) {
          refreshes += 1;
          return new Response(null, { status: 401 });
        }
        if (url.endsWith("/exchange")) {
          exchanges += 1;
          return new Response(
            JSON.stringify({
              ...brokerSession,
              accessToken: `access-${exchanges}`,
              expiresAt: exchanges === 1 ? 1 : 2_000_000_000_000,
              refreshCredential: `refresh-${exchanges}`,
              subject: exchanges === 1 ? "user_a" : "user_b",
            }),
            { status: 200 },
          );
        }
        return new Response(null, { status: 204 });
      });
      const { runtime } = configured({ createPkce, fetcher });
      await runtime.boot();
      await runtime.beginSignIn();
      await runtime.handleCallback(
        "subtrack://auth/callback?code=code_a&state=state_a",
      );
      await runtime.beginSignIn();

      await expect(runtime[accessor]()).resolves.toBeNull();
      expect(runtime.snapshot()).toEqual({ status: "verification_pending" });
      expect(refreshes).toBe(0);
      await expect(
        runtime.handleCallback(
          "subtrack://auth/callback?code=code_b&state=state_b",
        ),
      ).resolves.toEqual({ status: "signed_in", subject: "user_b" });
      expect(exchanges).toBe(2);
    },
  );

  it("does not create an unhandled rejection when final publication fails", async () => {
    const { runtime } = configured();
    await runtime.boot();
    let pendingPublications = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    const unsubscribe = runtime.subscribe((snapshot) => {
      if (snapshot.status !== "verification_pending") return;
      pendingPublications += 1;
      if (pendingPublications === 2) throw new Error("listener failure");
    });

    await expect(runtime.beginSignIn()).rejects.toThrow("listener failure");
    await new Promise((resolve) => setTimeout(resolve, 0));

    unsubscribe();
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it("starts a fresh attempt after cancel even when the old PKCE never settles", async () => {
    const neverCreates = new Promise<never>(() => undefined);
    const createPkce = vi
      .fn()
      .mockReturnValueOnce(neverCreates)
      .mockResolvedValueOnce({
        state: "state_new",
        verifier: codeVerifier,
        challenge: "challenge_new",
      });
    const { runtime } = configured({ createPkce });
    await runtime.boot();

    void runtime.beginSignIn();
    await runtime.signOut();
    await expect(runtime.beginSignIn()).resolves.toEqual({
      status: "verification_pending",
    });
    expect(createPkce).toHaveBeenCalledTimes(2);
  });

  it("does not let a late opener failure replace a successful callback", async () => {
    let rejectOpen!: (reason?: unknown) => void;
    const opening = new Promise<void>((_resolve, reject) => {
      rejectOpen = reject;
    });
    const openUrl = vi.fn(() => opening);
    const { runtime } = configured({ openUrl });
    await runtime.boot();
    const beginning = runtime.beginSignIn();
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledOnce());

    await expect(
      runtime.handleCallback(
        "subtrack://auth/callback?code=code_123&state=state_456",
      ),
    ).resolves.toEqual({ status: "signed_in", subject: "user_123" });
    rejectOpen(new Error("late opener failure"));

    await expect(beginning).resolves.toEqual({
      status: "signed_in",
      subject: "user_123",
    });
    expect(runtime.snapshot()).toEqual({
      status: "signed_in",
      subject: "user_123",
    });
  });

  it("lets a claimed callback finish when the opener fails during exchange", async () => {
    let rejectOpen!: (reason?: unknown) => void;
    const opening = new Promise<void>((_resolve, reject) => {
      rejectOpen = reject;
    });
    let resolveExchange!: (response: Response) => void;
    const exchanging = new Promise<Response>((resolve) => {
      resolveExchange = resolve;
    });
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/exchange")) return exchanging;
      return new Response(null, { status: 204 });
    });
    const openUrl = vi.fn(() => opening);
    const { runtime } = configured({
      fetcher,
      openUrl,
    });
    await runtime.boot();
    const beginning = runtime.beginSignIn();
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledOnce());

    const completing = runtime.handleCallback(
      "subtrack://auth/callback?code=code_123&state=state_456",
    );
    await vi.waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        expect.stringMatching(/\/exchange$/),
        expect.anything(),
      ),
    );
    rejectOpen(new Error("late opener failure"));
    await expect(beginning).resolves.toEqual({
      status: "verification_pending",
    });
    resolveExchange(
      new Response(JSON.stringify(brokerSession), { status: 200 }),
    );

    await expect(completing).resolves.toEqual({
      status: "signed_in",
      subject: "user_123",
    });
    expect(runtime.snapshot()).toEqual({
      status: "signed_in",
      subject: "user_123",
    });
  });

  it("preserves runtime-only states when an unsolicited callback has no binding", async () => {
    const { runtime } = configured();
    await expect(runtime.handleCallback("not-a-callback")).resolves.toEqual({
      status: "starting",
    });

    await runtime.boot();
    const failing = configured({
      openUrl: vi.fn(async () => {
        throw new Error("unavailable");
      }),
    }).runtime;
    await failing.boot();
    await failing.beginSignIn();
    expect(failing.snapshot()).toMatchObject({ status: "error" });
    await expect(
      failing.handleCallback("not-a-callback"),
    ).resolves.toMatchObject({ status: "error" });
  });

  it("boots unconfigured into an honest setup-required state without native or network work", async () => {
    const fetcher = vi.fn();
    const invoke = vi.fn();
    const runtime = createDesktopAuthRuntime(
      {},
      { fetcher, invoke, openUrl: vi.fn() },
    );

    await expect(runtime.boot()).resolves.toEqual({
      status: "setup_required",
      message: "Authentication broker is not configured.",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects a broker URL containing credentials, paths, query data, or fragments", async () => {
    const fetcher = vi.fn();
    const runtime = createDesktopAuthRuntime(
      {
        VITE_AUTH_BROKER_URL:
          "https://user:secret@auth.example.test/path?token=x#fragment",
      },
      { fetcher, invoke: vi.fn(), openUrl: vi.fn() },
    );
    await expect(runtime.boot()).resolves.toEqual({
      status: "setup_required",
      message: "Authentication broker configuration is invalid.",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("boots a configured environment by restoring through the native vault", async () => {
    const { invoke, runtime } = configured();
    await expect(runtime.boot()).resolves.toEqual({ status: "signed_out" });
    expect(invoke).toHaveBeenCalledWith("read_session_secret");
  });

  it("opens the system-browser PKCE flow and exchanges only a validated callback", async () => {
    const { fetcher, openUrl, runtime } = configured();
    await runtime.boot();
    await expect(runtime.beginSignIn()).resolves.toEqual({
      status: "verification_pending",
    });

    expect(openUrl).toHaveBeenCalledWith(
      "https://auth.example.test/functions/v1/auth-broker/v1/desktop/authorize?state=state_456&code_challenge=challenge_123&code_challenge_method=S256&redirect_uri=subtrack%3A%2F%2Fauth%2Fcallback",
    );
    await expect(
      runtime.handleCallback(
        "subtrack://auth/callback?code=code_123&state=state_456",
      ),
    ).resolves.toEqual({ status: "signed_in", subject: "user_123" });
    expect(fetcher).toHaveBeenCalledWith(
      "https://auth.example.test/functions/v1/auth-broker/v1/desktop/session/exchange",
      expect.objectContaining({
        body: JSON.stringify({ code: "code_123", codeVerifier }),
      }),
    );
    expect(JSON.stringify(runtime.snapshot())).not.toMatch(
      /access-token|refresh-secret/,
    );
  });

  it("signs out and clears native state without rendering provider failures or credentials", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/revoke")) {
        return new Response("person@example.com token=refresh-secret", {
          status: 503,
        });
      }
      return new Response(JSON.stringify(brokerSession), { status: 200 });
    });
    const { invoke, runtime } = configured({ fetcher });
    await runtime.boot();
    await runtime.beginSignIn();
    await runtime.handleCallback(
      "subtrack://auth/callback?code=code_123&state=state_456",
    );

    await expect(runtime.signOut()).resolves.toEqual({ status: "signed_out" });
    expect(invoke).toHaveBeenCalledWith("clear_session_secret");
    expect(JSON.stringify(runtime.snapshot())).not.toMatch(
      /person@|token|refresh-secret/i,
    );
  });

  it("provides the current access token only to authenticated data callers", async () => {
    const { runtime } = configured();
    await runtime.boot();
    await expect(runtime.accessToken()).resolves.toBeNull();
    await runtime.beginSignIn();
    await runtime.handleCallback(
      "subtrack://auth/callback?code=code_123&state=state_456",
    );

    await expect(runtime.accessToken()).resolves.toBe(
      "access-token-never-rendered",
    );

    await runtime.signOut();
    await expect(runtime.accessToken()).resolves.toBeNull();
  });

  it("expires the desktop route when an active token can no longer refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T00:00:00.000Z"));
    const values = new Map<string, unknown>();
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === "read_session_secret")
          return values.get("session") ?? null;
        if (command === "write_session_secret")
          values.set("session", args?.session);
        if (command === "clear_session_secret") values.delete("session");
        return undefined;
      },
    );
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/refresh")) return new Response(null, { status: 401 });
      return new Response(
        JSON.stringify({
          ...brokerSession,
          expiresAt: Date.now() + 1_000,
        }),
        { status: 200 },
      );
    });
    const runtime = createDesktopAuthRuntime(
      {
        VITE_AUTH_BROKER_URL:
          "https://auth.example.test/functions/v1/auth-broker",
      },
      {
        fetcher,
        invoke,
        openUrl: vi.fn(async () => undefined),
        createPkce: async () => ({
          state: "state_456",
          verifier: codeVerifier,
          challenge: "challenge_123",
        }),
      },
    );
    try {
      await runtime.boot();
      await runtime.beginSignIn();
      await runtime.handleCallback(
        "subtrack://auth/callback?code=code_123&state=state_456",
      );
      vi.advanceTimersByTime(1_000);

      await expect(runtime.accessToken()).resolves.toBeNull();
      expect(runtime.snapshot()).toEqual({
        status: "signed_out",
        reason: "session_expired",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

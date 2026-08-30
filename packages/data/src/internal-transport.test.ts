import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataPlaneTransport } from "./internal-transport";

afterEach(() => vi.unstubAllGlobals());

const leased = (token: string) => ({ token, isCurrent: () => true });

describe("internal PostgREST transport", () => {
  it("rejects an already-aborted request before token acquisition", async () => {
    const accessToken = vi.fn(async () =>
      leased("standard-clerk-session-token"),
    );
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const transport = createDataPlaneTransport({
      accessToken,
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      transport.request("subscriptions", {
        method: "GET",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ reason: "unavailable" });
    expect(accessToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("settles an abort while an access-token lease is unresolved", async () => {
    const accessToken = vi.fn((signal?: AbortSignal) => {
      void signal;
      return new Promise<ReturnType<typeof leased>>(() => undefined);
    });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const transport = createDataPlaneTransport({
      accessToken,
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    });
    const controller = new AbortController();
    const request = transport
      .request("subscriptions", {
        method: "GET",
        signal: controller.signal,
      })
      .catch((error: unknown) => error);

    await vi.waitFor(() => expect(accessToken).toHaveBeenCalledOnce());
    expect(accessToken).toHaveBeenCalledWith(controller.signal);
    controller.abort();

    await expect(
      Promise.race([
        request,
        new Promise((resolve) =>
          setTimeout(() => resolve("token-acquisition-still-pending"), 25),
        ),
      ]),
    ).resolves.toMatchObject({ reason: "unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds unresolved access-token acquisitions during rapid cancellation", async () => {
    const accessToken = vi.fn((signal?: AbortSignal) => {
      void signal;
      return new Promise<ReturnType<typeof leased>>(() => undefined);
    });
    vi.stubGlobal("fetch", vi.fn());
    const transport = createDataPlaneTransport({
      accessToken,
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    });
    const controllers: AbortController[] = [];
    const requests: Promise<unknown>[] = [];

    for (let index = 0; index < 8; index += 1) {
      const controller = new AbortController();
      controllers.push(controller);
      requests.push(
        transport
          .request("subscriptions", {
            method: "GET",
            signal: controller.signal,
          })
          .catch((error: unknown) => error),
      );
      await Promise.resolve();
      if (index >= 2) controllers[index - 2]?.abort();
    }
    controllers.forEach((controller) => controller.abort());

    const outcomes = await Promise.all(requests);
    expect(accessToken).toHaveBeenCalledTimes(2);
    expect(outcomes).toHaveLength(8);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "unavailable" }),
      ]),
    );
  });

  it("recovers after an aborted token lease rejects", async () => {
    let rejectFirst!: (reason?: unknown) => void;
    const firstLease = new Promise<ReturnType<typeof leased>>(
      (_resolve, reject) => {
        rejectFirst = reject;
      },
    );
    const accessToken = vi
      .fn<(_: AbortSignal | undefined) => Promise<ReturnType<typeof leased>>>()
      .mockReturnValueOnce(firstLease)
      .mockResolvedValueOnce(leased("fresh-clerk-session-token"));
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const transport = createDataPlaneTransport({
      accessToken,
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    });
    const controller = new AbortController();
    const canceled = transport
      .request("subscriptions", {
        method: "GET",
        signal: controller.signal,
      })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(accessToken).toHaveBeenCalledOnce());
    controller.abort();
    rejectFirst(new Error("late-provider-rejection"));

    await expect(canceled).resolves.toMatchObject({ reason: "unavailable" });
    await expect(
      transport.request("subscriptions", { method: "GET" }),
    ).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects a plain unleased token before credentialed I/O", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const transport = createDataPlaneTransport({
      accessToken: async () => "unleased-session-token" as never,
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    });

    await expect(
      transport.request("subscriptions", { method: "GET" }),
    ).rejects.toMatchObject({ reason: "auth" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "https://evil.example/subscriptions",
    "//evil.example/subscriptions",
    "/subscriptions",
    "subscriptions/child",
    "rpc/private",
    "subscriptions%2fchild",
    "subscriptions?redirect=evil",
    "subscriptions#fragment",
    "subscriptions\\child",
  ])("rejects hostile target %s before token acquisition", async (target) => {
    const accessToken = vi.fn(async () =>
      leased("standard-clerk-session-token"),
    );
    const transport = createDataPlaneTransport({
      accessToken,
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    });

    await expect(
      transport.request(target, { method: "GET" }),
    ).rejects.toMatchObject({ reason: "invalid" });
    expect(accessToken).not.toHaveBeenCalled();
  });

  it("snapshots canonical options once and ignores later mutation", async () => {
    let keyReads = 0;
    const raw = {
      accessToken: async () => leased("standard-clerk-session-token"),
      get publishableKey() {
        keyReads += 1;
        return keyReads === 1 ? "sb_publishable_fixture" : "sb_secret_mutated";
      },
      supabaseUrl: "https://project.supabase.co",
    };
    const fetcher = vi.fn<
      (input: string, init?: RequestInit) => Promise<Response>
    >(async () =>
      Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const transport = createDataPlaneTransport(raw);
    Object.defineProperty(raw, "publishableKey", { value: "sb_secret_later" });

    await transport.request("subscriptions", { method: "GET" });

    expect(keyReads).toBe(1);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      apikey: "sb_publishable_fixture",
    });
  });

  it.each([" sb_secret_padded", "sb_secret_padded "])(
    "rejects padded secret key %s generically",
    (publishableKey) => {
      expect(() =>
        createDataPlaneTransport({
          accessToken: async () => leased("session"),
          publishableKey,
          supabaseUrl: "https://project.supabase.co",
        }),
      ).toThrow("data_plane_request_failed");
    },
  );

  it("redacts throwing option getters", () => {
    const raw = {
      accessToken: async () => leased("session"),
      get publishableKey(): string {
        throw new Error("raw-option-secret");
      },
      supabaseUrl: "https://project.supabase.co",
    };
    expect(() => createDataPlaneTransport(raw)).toThrow(
      "data_plane_request_failed",
    );
  });

  it.each([null, 42, {}, new String("token"), " sb_secret_token"])(
    "rejects hostile token value generically",
    async (value) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const transport = createDataPlaneTransport({
        accessToken: async () => value as never,
        publishableKey: "sb_publishable_fixture",
        supabaseUrl: "https://project.supabase.co",
      });
      await expect(
        transport.request("subscriptions", { method: "GET" }),
      ).rejects.toMatchObject({ reason: "auth" });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("ignores hostile trusted request overrides", async () => {
    const fetcher = vi.fn<
      (input: string, init?: RequestInit) => Promise<Response>
    >(async () =>
      Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const transport = createDataPlaneTransport({
      accessToken: async () => leased("standard-clerk-session-token"),
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    });
    await transport.request("subscriptions", {
      method: "GET",
      headers: { authorization: "Bearer evil", apikey: "sb_secret_evil" },
      cache: "force-cache",
      credentials: "include",
      redirect: "follow",
    } as never);
    const [input, init] = fetcher.mock.calls[0] ?? [];
    if (input === undefined) throw new Error("missing request");
    expect(init).toMatchObject({
      credentials: "omit",
      redirect: "error",
      headers: {
        apikey: "sb_publishable_fixture",
        authorization: "Bearer standard-clerk-session-token",
      },
    });
    expect(new Request(input, init).cache).toBe("no-store");
  });

  it("checks a token lease synchronously at the fetch dispatch boundary", async () => {
    let current = true;
    let resolveLease!: (lease: {
      token: string;
      isCurrent: () => boolean;
    }) => void;
    const lease = new Promise<Parameters<typeof resolveLease>[0]>((resolve) => {
      resolveLease = resolve;
    });
    const isCurrent = vi.fn(() => current);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const transport = createDataPlaneTransport({
      accessToken: () => lease,
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    });
    const request = transport.request("subscriptions", { method: "GET" });
    current = false;
    resolveLease({
      token: "standard-clerk-session-token",
      isCurrent,
    });

    await expect(request).rejects.toMatchObject({ reason: "auth" });
    expect(isCurrent).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("classifies a throwing lease validator as an authentication failure", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const transport = createDataPlaneTransport({
      accessToken: async () => ({
        token: "standard-clerk-session-token",
        isCurrent() {
          throw new Error("lease-secret");
        },
      }),
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    });

    const error = await transport
      .request("subscriptions", { method: "GET" })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: "auth" });
    expect(String(error)).not.toContain("lease-secret");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([400, 422])(
    "classifies permanent HTTP %s write rejection as invalid",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("constraint detail", { status })),
      );
      const transport = createDataPlaneTransport({
        accessToken: async () => leased("standard-clerk-session-token"),
        publishableKey: "sb_publishable_fixture",
        supabaseUrl: "https://project.supabase.co",
      });

      const error = await transport
        .request("subscriptions", { method: "POST", body: "{}" })
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ reason: "invalid" });
      expect(String(error)).not.toContain("constraint detail");
    },
  );
});

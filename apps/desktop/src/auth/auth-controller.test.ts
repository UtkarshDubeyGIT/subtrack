import { describe, expect, it, vi } from "vitest";
import { createDataPlaneRepositories } from "@subtrack/data";
import { AuthController, AuthExchangeError } from "./auth-controller";
import type { AuthBroker, PersistedSession, SessionVault } from "./types";

const callback = "subtrack://auth/callback?code=code_123&state=state_456";
const codeVerifier = "v".repeat(64);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function setup(
  stored: PersistedSession | null = null,
  options?: { clock?: () => number; refreshSkewMs?: number },
) {
  let persisted = stored;
  const vault: SessionVault = {
    read: vi.fn(async () => persisted),
    write: vi.fn(async (value) => {
      persisted = value;
    }),
    clear: vi.fn(async () => {
      persisted = null;
    }),
  };
  const broker: AuthBroker = {
    exchange: vi.fn(async () => ({
      accessToken: "access-short-lived",
      expiresAt: 2_000_000_000_000,
      refreshCredential: "refresh-secret",
      subject: "user_123",
    })),
    refresh: vi.fn(async () => ({
      accessToken: "access-refreshed",
      expiresAt: 2_000_000_000_000,
      refreshCredential: "refresh-rotated",
      subject: "user_123",
    })),
    revoke: vi.fn(async () => undefined),
  };

  return {
    broker,
    controller: new AuthController(broker, vault, options),
    vault,
  };
}

describe("AuthController", () => {
  it("exchanges a trusted callback once and persists only the refresh credential", async () => {
    const { broker, controller, vault } = setup();
    controller.expectCallback({ state: "state_456", codeVerifier });

    await expect(controller.completeCallback(callback)).resolves.toEqual({
      status: "signed_in",
      subject: "user_123",
    });
    expect(broker.exchange).toHaveBeenCalledWith({
      code: "code_123",
      codeVerifier,
    });
    expect(vault.write).toHaveBeenCalledWith({
      refreshCredential: "refresh-secret",
      subject: "user_123",
    });
    expect(JSON.stringify(controller.snapshot())).not.toContain(
      "access-short-lived",
    );

    await expect(controller.completeCallback(callback)).resolves.toEqual({
      status: "signed_in",
      subject: "user_123",
    });
    expect(broker.exchange).toHaveBeenCalledOnce();
  });

  it("exposes the short-lived access token only through the in-memory data boundary", async () => {
    const { controller } = setup();
    await expect(controller.accessToken()).resolves.toBeNull();
    controller.expectCallback({ state: "state_456", codeVerifier });

    await controller.completeCallback(callback);
    await expect(controller.accessToken()).resolves.toBe("access-short-lived");

    await controller.signOut();
    await expect(controller.accessToken()).resolves.toBeNull();
  });

  it("restores a session by refreshing the OS-protected credential and rotates it", async () => {
    const { broker, controller, vault } = setup({
      refreshCredential: "refresh-old",
      subject: "user_123",
    });

    await expect(controller.restore()).resolves.toEqual({
      status: "signed_in",
      subject: "user_123",
    });
    expect(broker.refresh).toHaveBeenCalledWith("refresh-old");
    expect(vault.write).toHaveBeenCalledWith({
      refreshCredential: "refresh-rotated",
      subject: "user_123",
    });
  });

  it("coalesces concurrent restore attempts for one rotating credential", async () => {
    const pending = deferred<{
      accessToken: string;
      expiresAt: number;
      refreshCredential: string;
      subject: string;
    }>();
    const { broker, controller } = setup({
      refreshCredential: "refresh-old",
      subject: "user_123",
    });
    vi.mocked(broker.refresh).mockReturnValue(pending.promise);

    const first = controller.restore();
    const second = controller.restore();
    await vi.waitFor(() => expect(broker.refresh).toHaveBeenCalledOnce());
    pending.resolve({
      accessToken: "access-restored",
      expiresAt: 2_000_000_000_000,
      refreshCredential: "refresh-rotated",
      subject: "user_123",
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "signed_in", subject: "user_123" },
      { status: "signed_in", subject: "user_123" },
    ]);
    expect(broker.refresh).toHaveBeenCalledOnce();
  });

  it("coalesces restore and active-token refresh against one rotating credential", async () => {
    let now = 1_000_000;
    const { broker, controller } = setup(null, {
      clock: () => now,
      refreshSkewMs: 0,
    });
    vi.mocked(broker.exchange).mockResolvedValue({
      accessToken: "access-expiring",
      expiresAt: now + 1_000,
      refreshCredential: "refresh-one-use",
      subject: "user_123",
    });
    vi.mocked(broker.refresh).mockResolvedValue({
      accessToken: "access-restored",
      expiresAt: now + 60_000,
      refreshCredential: "refresh-rotated",
      subject: "user_123",
    });
    controller.expectCallback({ state: "state_456", codeVerifier });
    await controller.completeCallback(callback);
    now += 1_000;

    const restoring = controller.restore();
    const refreshing = controller.accessToken();

    await expect(restoring).resolves.toEqual({
      status: "signed_in",
      subject: "user_123",
    });
    await expect(refreshing).resolves.toBe("access-restored");
    expect(broker.refresh).toHaveBeenCalledOnce();
    expect(broker.refresh).toHaveBeenCalledWith("refresh-one-use");
  });

  it("clears a revoked persisted session and returns a safe signed-out state", async () => {
    const { broker, controller, vault } = setup({
      refreshCredential: "refresh-revoked",
      subject: "user_123",
    });
    vi.mocked(broker.refresh).mockRejectedValue(
      new AuthExchangeError(
        "revoked",
        "server leaked person@example.com token=secret",
      ),
    );

    await expect(controller.restore()).resolves.toEqual({
      status: "signed_out",
      reason: "session_expired",
    });
    expect(vault.clear).toHaveBeenCalledOnce();
    expect(JSON.stringify(controller.snapshot())).not.toMatch(
      /person@|secret|refresh-revoked/i,
    );
  });

  it("expires a revoked restored session even when native cleanup fails", async () => {
    const { broker, controller, vault } = setup({
      refreshCredential: "refresh-revoked",
      subject: "user_123",
    });
    vi.mocked(broker.refresh).mockRejectedValue(
      new AuthExchangeError("revoked", "revoked"),
    );
    vi.mocked(vault.clear).mockRejectedValue(new Error("vault unavailable"));

    await expect(controller.restore()).resolves.toEqual({
      status: "signed_out",
      reason: "session_expired",
    });
    expect(controller.snapshot()).toEqual({
      status: "signed_out",
      reason: "session_expired",
    });
  });

  it("publishes restored-session expiry while native cleanup never settles", async () => {
    const neverClears = new Promise<never>(() => undefined);
    const { broker, controller, vault } = setup({
      refreshCredential: "refresh-revoked",
      subject: "user_123",
    });
    vi.mocked(broker.refresh).mockRejectedValue(
      new AuthExchangeError("revoked", "revoked"),
    );
    vi.mocked(vault.clear).mockReturnValue(neverClears);

    await expect(
      Promise.race([
        controller.restore(),
        new Promise((resolve) => setTimeout(() => resolve("timed_out"), 100)),
      ]),
    ).resolves.toEqual({ status: "signed_out", reason: "session_expired" });
  });

  it("revokes the server credential and clears local state even if revocation fails", async () => {
    const { broker, controller, vault } = setup({
      refreshCredential: "refresh-old",
      subject: "user_123",
    });
    await controller.restore();
    vi.mocked(broker.revoke).mockRejectedValue(
      new Error("offline token=refresh-old"),
    );

    await expect(controller.signOut()).resolves.toEqual({
      status: "signed_out",
    });
    expect(broker.revoke).toHaveBeenCalledWith("refresh-rotated");
    expect(vault.clear).toHaveBeenCalledOnce();
  });

  it("attempts local cleanup even when the native vault cannot read for revocation", async () => {
    const { controller, vault } = setup();
    vi.mocked(vault.read).mockRejectedValue(
      new Error("keychain read leaked token=secret"),
    );

    await expect(controller.signOut()).resolves.toEqual({
      status: "signed_out",
    });
    expect(vault.clear).toHaveBeenCalledOnce();
    expect(JSON.stringify(controller.snapshot())).not.toMatch(/token|secret/i);
  });

  it("invalidates an interrupted verification before signing out", async () => {
    const { broker, controller } = setup();
    controller.expectCallback({ state: "state_456", codeVerifier });

    await controller.signOut();

    await expect(controller.completeCallback(callback)).resolves.toEqual({
      status: "signed_out",
    });
    expect(broker.exchange).not.toHaveBeenCalled();
  });

  it("ignores a stale callback without consuming the current binding", async () => {
    const { broker, controller } = setup();
    controller.expectCallback({ state: "state_old", codeVerifier });
    await controller.signOut();
    controller.expectCallback({ state: "state_new", codeVerifier });

    await expect(
      controller.completeCallback(
        "subtrack://auth/callback?code=code_old&state=state_old",
      ),
    ).resolves.toEqual({ status: "signed_out" });
    await expect(
      controller.completeCallback(
        "subtrack://auth/callback?code=code_new&state=state_new",
      ),
    ).resolves.toEqual({ status: "signed_in", subject: "user_123" });
    expect(broker.exchange).toHaveBeenCalledOnce();
    expect(broker.exchange).toHaveBeenCalledWith({
      code: "code_new",
      codeVerifier,
    });
  });

  it("ignores unsolicited malformed callbacks when no binding is active", async () => {
    const { controller } = setup();
    await expect(
      controller.completeCallback("not-a-callback"),
    ).resolves.toEqual({ status: "signed_out" });
    controller.expectCallback({ state: "state_456", codeVerifier });
    await controller.completeCallback(callback);

    await expect(
      controller.completeCallback("not-a-callback"),
    ).resolves.toEqual({ status: "signed_in", subject: "user_123" });
  });

  it("does not accept a callback that completes after sign-out", async () => {
    const pending = deferred<{
      accessToken: string;
      expiresAt: number;
      refreshCredential: string;
      subject: string;
    }>();
    const { broker, controller, vault } = setup();
    vi.mocked(broker.exchange).mockReturnValue(pending.promise);
    controller.expectCallback({ state: "state_456", codeVerifier });
    const completing = controller.completeCallback(callback);
    await vi.waitFor(() => expect(broker.exchange).toHaveBeenCalledOnce());

    const signingOut = controller.signOut();
    pending.resolve({
      accessToken: "late-access",
      expiresAt: 2_000_000_000_000,
      refreshCredential: "late-refresh",
      subject: "user_late",
    });

    await expect(completing).resolves.toEqual({ status: "signed_out" });
    await expect(signingOut).resolves.toEqual({ status: "signed_out" });
    expect(controller.snapshot()).toEqual({ status: "signed_out" });
    expect(vault.write).not.toHaveBeenCalled();
  });

  it("ignores a callback failure that arrives after sign-out", async () => {
    const pending = deferred<never>();
    const { broker, controller } = setup();
    vi.mocked(broker.exchange).mockReturnValue(pending.promise);
    controller.expectCallback({ state: "state_456", codeVerifier });
    const completing = controller.completeCallback(callback);
    await vi.waitFor(() => expect(broker.exchange).toHaveBeenCalledOnce());

    const signingOut = controller.signOut();
    pending.reject(new Error("late secret-bearing broker failure"));

    await expect(completing).resolves.toEqual({ status: "signed_out" });
    await expect(signingOut).resolves.toEqual({ status: "signed_out" });
  });

  it("does not restore a session that completes after sign-out", async () => {
    const pending = deferred<{
      accessToken: string;
      expiresAt: number;
      refreshCredential: string;
      subject: string;
    }>();
    const { broker, controller, vault } = setup({
      refreshCredential: "refresh-old",
      subject: "user_123",
    });
    vi.mocked(broker.refresh).mockReturnValue(pending.promise);
    const restoring = controller.restore();
    await vi.waitFor(() => expect(broker.refresh).toHaveBeenCalledOnce());

    const signingOut = controller.signOut();
    pending.resolve({
      accessToken: "late-access",
      expiresAt: 2_000_000_000_000,
      refreshCredential: "late-refresh",
      subject: "user_late",
    });

    await expect(restoring).resolves.toEqual({ status: "signed_out" });
    await expect(signingOut).resolves.toEqual({ status: "signed_out" });
    expect(vault.write).not.toHaveBeenCalled();
  });

  it("does not let an older restore failure erase a newer callback session", async () => {
    const pendingRestore = deferred<never>();
    const { broker, controller, vault } = setup({
      refreshCredential: "refresh-old",
      subject: "user_old",
    });
    vi.mocked(broker.refresh).mockReturnValue(pendingRestore.promise);
    const restoring = controller.restore();
    await vi.waitFor(() => expect(broker.refresh).toHaveBeenCalledOnce());

    controller.expectCallback({ state: "state_456", codeVerifier });
    const completing = controller.completeCallback(callback);
    pendingRestore.reject(new AuthExchangeError("revoked", "old revoked"));

    await expect(restoring).resolves.toEqual({ status: "signed_out" });
    await expect(completing).resolves.toEqual({
      status: "signed_in",
      subject: "user_123",
    });
    expect(controller.snapshot()).toEqual({
      status: "signed_in",
      subject: "user_123",
    });
    expect(vault.clear).not.toHaveBeenCalled();
  });

  it("serializes a new callback behind an older sign-out cleanup", async () => {
    const pendingRevoke = deferred<void>();
    const { broker, controller, vault } = setup();
    controller.expectCallback({ state: "state_456", codeVerifier });
    await controller.completeCallback(callback);
    vi.mocked(broker.revoke).mockReturnValue(pendingRevoke.promise);
    vi.mocked(broker.exchange).mockResolvedValue({
      accessToken: "new-access",
      expiresAt: 2_000_000_000_000,
      refreshCredential: "new-refresh",
      subject: "user_new",
    });

    const signingOut = controller.signOut();
    await vi.waitFor(() => expect(broker.revoke).toHaveBeenCalledOnce());
    controller.expectCallback({ state: "state_456", codeVerifier });
    const completing = controller.completeCallback(callback);
    pendingRevoke.resolve();

    await expect(signingOut).resolves.toEqual({ status: "signed_out" });
    await expect(completing).resolves.toEqual({
      status: "signed_in",
      subject: "user_new",
    });
    await expect(controller.accessToken()).resolves.toBe("new-access");
    expect(vault.write).toHaveBeenLastCalledWith({
      refreshCredential: "new-refresh",
      subject: "user_new",
    });
  });

  it("refreshes and rotates an expired access token before returning it", async () => {
    let now = 1_000_000;
    const { broker, controller, vault } = setup(null, {
      clock: () => now,
      refreshSkewMs: 0,
    });
    vi.mocked(broker.exchange).mockResolvedValue({
      accessToken: "access-expiring",
      expiresAt: now + 1_000,
      refreshCredential: "refresh-first",
      subject: "user_123",
    });
    controller.expectCallback({ state: "state_456", codeVerifier });
    await controller.completeCallback(callback);
    now += 1_000;

    await expect(controller.accessToken()).resolves.toBe("access-refreshed");
    expect(broker.refresh).toHaveBeenCalledWith("refresh-first");
    expect(vault.write).toHaveBeenLastCalledWith({
      refreshCredential: "refresh-rotated",
      subject: "user_123",
    });
  });

  it("keeps an expired session retryable after a transient refresh outage", async () => {
    let now = 1_000_000;
    const { broker, controller, vault } = setup(null, {
      clock: () => now,
      refreshSkewMs: 0,
    });
    vi.mocked(broker.exchange).mockResolvedValue({
      accessToken: "access-expiring",
      expiresAt: now + 1_000,
      refreshCredential: "refresh-first",
      subject: "user_123",
    });
    controller.expectCallback({ state: "state_456", codeVerifier });
    await controller.completeCallback(callback);
    now += 1_000;
    vi.mocked(broker.refresh)
      .mockRejectedValueOnce(
        new AuthExchangeError("transient", "provider unavailable"),
      )
      .mockResolvedValueOnce({
        accessToken: "access-after-retry",
        expiresAt: now + 60_000,
        refreshCredential: "refresh-after-retry",
        subject: "user_123",
      });

    await expect(controller.accessToken()).resolves.toBeNull();
    expect(controller.snapshot()).toEqual({
      status: "signed_in",
      subject: "user_123",
    });
    expect(vault.clear).not.toHaveBeenCalled();
    await expect(controller.accessToken()).resolves.toBe("access-after-retry");
    expect(broker.refresh).toHaveBeenCalledTimes(2);
  });

  it("expires an active revoked session even when native cleanup fails", async () => {
    let now = 1_000_000;
    const { broker, controller, vault } = setup(null, {
      clock: () => now,
      refreshSkewMs: 0,
    });
    vi.mocked(broker.exchange).mockResolvedValue({
      accessToken: "access-expiring",
      expiresAt: now + 1_000,
      refreshCredential: "refresh-first",
      subject: "user_123",
    });
    controller.expectCallback({ state: "state_456", codeVerifier });
    await controller.completeCallback(callback);
    now += 1_000;
    vi.mocked(broker.refresh).mockRejectedValue(
      new AuthExchangeError("revoked", "revoked"),
    );
    vi.mocked(vault.clear).mockRejectedValue(new Error("vault unavailable"));

    await expect(controller.accessToken()).resolves.toBeNull();
    expect(controller.snapshot()).toEqual({
      status: "signed_out",
      reason: "session_expired",
    });
  });

  it("publishes active-session expiry while native cleanup never settles", async () => {
    let now = 1_000_000;
    const neverClears = new Promise<never>(() => undefined);
    const { broker, controller, vault } = setup(null, {
      clock: () => now,
      refreshSkewMs: 0,
    });
    vi.mocked(broker.exchange).mockResolvedValue({
      accessToken: "access-expiring",
      expiresAt: now + 1_000,
      refreshCredential: "refresh-first",
      subject: "user_123",
    });
    controller.expectCallback({ state: "state_456", codeVerifier });
    await controller.completeCallback(callback);
    now += 1_000;
    vi.mocked(broker.refresh).mockRejectedValue(
      new AuthExchangeError("revoked", "revoked"),
    );
    vi.mocked(vault.clear).mockReturnValue(neverClears);

    await expect(
      Promise.race([
        controller.accessToken(),
        new Promise((resolve) => setTimeout(() => resolve("timed_out"), 100)),
      ]),
    ).resolves.toBeNull();
    expect(controller.snapshot()).toEqual({
      status: "signed_out",
      reason: "session_expired",
    });
  });

  it("makes sign-out durable and accepts a new callback while an old refresh never settles", async () => {
    let now = 1_000_000;
    const neverRefreshes = new Promise<never>(() => undefined);
    const { broker, controller, vault } = setup(null, {
      clock: () => now,
      refreshSkewMs: 0,
    });
    vi.mocked(broker.exchange)
      .mockResolvedValueOnce({
        accessToken: "access-old",
        expiresAt: now + 1_000,
        refreshCredential: "refresh-old",
        subject: "user_old",
      })
      .mockResolvedValueOnce({
        accessToken: "access-new",
        expiresAt: now + 60_000,
        refreshCredential: "refresh-new",
        subject: "user_new",
      });
    controller.expectCallback({ state: "state_456", codeVerifier });
    await controller.completeCallback(callback);
    now += 1_000;
    vi.mocked(broker.refresh).mockReturnValue(neverRefreshes);
    void controller.accessToken();
    await vi.waitFor(() => expect(broker.refresh).toHaveBeenCalledOnce());

    await expect(controller.signOut()).resolves.toEqual({
      status: "signed_out",
    });
    expect(vault.clear).toHaveBeenCalledOnce();
    controller.expectCallback({ state: "state_new", codeVerifier });
    await expect(
      controller.completeCallback(
        "subtrack://auth/callback?code=code_new&state=state_new",
      ),
    ).resolves.toEqual({ status: "signed_in", subject: "user_new" });
    await expect(controller.accessToken()).resolves.toBe("access-new");
    expect(vault.write).toHaveBeenLastCalledWith({
      refreshCredential: "refresh-new",
      subject: "user_new",
    });
  });

  it("starts the new session refresh when an older generation refresh never settles", async () => {
    let now = 1_000_000;
    const neverRefreshes = new Promise<never>(() => undefined);
    const { broker, controller } = setup(null, {
      clock: () => now,
      refreshSkewMs: 0,
    });
    vi.mocked(broker.exchange)
      .mockResolvedValueOnce({
        accessToken: "access-old",
        expiresAt: now + 1_000,
        refreshCredential: "refresh-old",
        subject: "user_old",
      })
      .mockResolvedValueOnce({
        accessToken: "access-new",
        expiresAt: now + 2_000,
        refreshCredential: "refresh-new",
        subject: "user_new",
      });
    vi.mocked(broker.refresh)
      .mockReturnValueOnce(neverRefreshes)
      .mockResolvedValueOnce({
        accessToken: "access-new-refreshed",
        expiresAt: now + 60_000,
        refreshCredential: "refresh-new-rotated",
        subject: "user_new",
      });

    controller.expectCallback({ state: "state_456", codeVerifier });
    await controller.completeCallback(callback);
    now += 1_000;
    void controller.accessToken();
    await vi.waitFor(() => expect(broker.refresh).toHaveBeenCalledOnce());

    await controller.signOut();
    controller.expectCallback({ state: "state_new", codeVerifier });
    await controller.completeCallback(
      "subtrack://auth/callback?code=code_new&state=state_new",
    );
    now += 2_000;

    await expect(controller.accessToken()).resolves.toBe(
      "access-new-refreshed",
    );
    expect(broker.refresh).toHaveBeenCalledTimes(2);
    expect(broker.refresh).toHaveBeenLastCalledWith("refresh-new");
  });

  it("never authorizes an account A request with account B's later token", async () => {
    let now = 1_000_000;
    const pendingRefresh = deferred<{
      accessToken: string;
      expiresAt: number;
      refreshCredential: string;
      subject: string;
    }>();
    const { broker, controller } = setup(null, {
      clock: () => now,
      refreshSkewMs: 0,
    });
    vi.mocked(broker.exchange)
      .mockResolvedValueOnce({
        accessToken: "access-a",
        expiresAt: now + 1_000,
        refreshCredential: "refresh-a",
        subject: "user_a",
      })
      .mockResolvedValueOnce({
        accessToken: "access-b",
        expiresAt: now + 60_000,
        refreshCredential: "refresh-b",
        subject: "user_b",
      });
    vi.mocked(broker.refresh).mockReturnValueOnce(pendingRefresh.promise);
    controller.expectCallback({ state: "state_456", codeVerifier });
    await controller.completeCallback(callback);
    now += 1_000;

    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const repositories = createDataPlaneRepositories({
      accessToken: () => controller.accessTokenLease(),
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    });
    const accountARequest = repositories.preferences.create({
      timezone: "Asia/Kolkata",
      homeCurrency: "USD",
      reminderLeadDays: [7, 3, 1],
      emailRemindersEnabled: false,
      locale: "en-IN",
    });
    await vi.waitFor(() => expect(broker.refresh).toHaveBeenCalledOnce());

    await controller.signOut();
    controller.expectCallback({ state: "state_b", codeVerifier });
    await controller.completeCallback(
      "subtrack://auth/callback?code=code_b&state=state_b",
    );
    await expect(
      Promise.race([
        accountARequest,
        new Promise((resolve) => setTimeout(() => resolve("timed_out"), 100)),
      ]),
    ).rejects.toMatchObject({ reason: "auth" });
    expect(fetcher).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("invalidates a fresh-token dispatch when sign-out runs in the handoff microtask", async () => {
    const { controller } = setup();
    controller.expectCallback({ state: "state_456", codeVerifier });
    await controller.completeCallback(callback);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const repositories = createDataPlaneRepositories({
      accessToken: () => controller.accessTokenLease(),
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    });

    const request = repositories.preferences.get();
    let signingOut: Promise<unknown> | undefined;
    queueMicrotask(() => {
      signingOut = controller.signOut();
    });

    await expect(request).rejects.toMatchObject({ reason: "auth" });
    expect(fetcher).not.toHaveBeenCalled();
    await signingOut;
    vi.unstubAllGlobals();
  });

  it("keeps local sign-out durable and permits a new callback while revoke never settles", async () => {
    const neverRevokes = new Promise<never>(() => undefined);
    const { broker, controller, vault } = setup();
    controller.expectCallback({ state: "state_456", codeVerifier });
    await controller.completeCallback(callback);
    vi.mocked(broker.revoke).mockReturnValue(neverRevokes);

    void controller.signOut();
    await vi.waitFor(() => expect(vault.clear).toHaveBeenCalledOnce());
    expect(controller.snapshot()).toEqual({ status: "signed_out" });
    controller.expectCallback({ state: "state_new", codeVerifier });
    vi.mocked(broker.exchange).mockResolvedValue({
      accessToken: "access-new",
      expiresAt: 2_000_000_000_000,
      refreshCredential: "refresh-new",
      subject: "user_new",
    });

    await expect(
      controller.completeCallback(
        "subtrack://auth/callback?code=code_new&state=state_new",
      ),
    ).resolves.toEqual({ status: "signed_in", subject: "user_new" });
    expect(vault.write).toHaveBeenLastCalledWith({
      refreshCredential: "refresh-new",
      subject: "user_new",
    });
  });
});

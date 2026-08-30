import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataPlaneRepositories } from "./index";

const leased = (token: string) => ({ token, isCurrent: () => true });

const repositoryOptions = {
  accessToken: () => Promise.resolve(leased("standard-clerk-session-token")),
  publishableKey: "sb_publishable_fixture",
  supabaseUrl: "https://project.supabase.co",
};

const deliveredRow = {
  owner_user_id: "user_fixture",
  idempotency_key: "sub_a|2026-09-15|7|native",
  subscription_id: "sub_a",
  occurrence_date: "2026-09-15",
  channel: "native",
  state: "delivered",
  attempt_count: 1,
  scheduled_for: "2026-09-08T13:00:00.000Z",
  delivered_at: "2026-09-08T13:00:05.000Z",
  error_code: null,
  version: 3,
  created_at: "2026-08-30T00:00:00.000Z",
  updated_at: "2026-09-08T13:00:05.000Z",
};

const parseRequestBody = (body: unknown) =>
  JSON.parse(typeof body === "string" ? body : "") as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reminder delivery acknowledgement", () => {
  it("posts the acknowledgement RPC and returns the advanced delivery", async () => {
    const fetcher = vi.fn(async () => {
      return new Response(JSON.stringify(deliveredRow), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const delivery = await createDataPlaneRepositories(
      repositoryOptions,
    ).reminders.acknowledgeDelivery({
      idempotencyKey: "sub_a|2026-09-15|7|native",
      state: "delivered",
    });

    expect(delivery).toEqual({
      idempotencyKey: "sub_a|2026-09-15|7|native",
      subscriptionId: "sub_a",
      occurrenceDate: "2026-09-15",
      channel: "native",
      state: "delivered",
      attemptCount: 1,
      scheduledFor: "2026-09-08T13:00:00.000Z",
      deliveredAt: "2026-09-08T13:00:05.000Z",
      errorCode: null,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const call = fetcher.mock.calls[0] as unknown as
      | [string | URL | Request, RequestInit | undefined]
      | undefined;
    if (!call) throw new Error("fetch was not called");
    const [urlInput, init] = call;
    const url = new URL(urlInput instanceof Request ? urlInput.url : urlInput);
    expect(url.pathname).toBe("/rest/v1/rpc/acknowledge_reminder_delivery");
    expect(init?.method).toBe("POST");
    expect(parseRequestBody(init?.body)).toEqual({
      p_idempotency_key: "sub_a|2026-09-15|7|native",
      p_state: "delivered",
      p_error_code: null,
    });
  });

  it("carries the error code on a failure report", async () => {
    const failedRow = {
      ...deliveredRow,
      state: "failed",
      delivered_at: null,
      error_code: "NOTIFICATION_API_ERROR",
    };
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify(failedRow), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);

    const delivery = await createDataPlaneRepositories(
      repositoryOptions,
    ).reminders.acknowledgeDelivery({
      idempotencyKey: "sub_a|2026-09-15|7|native",
      state: "failed",
      errorCode: "NOTIFICATION_API_ERROR",
    });

    expect(delivery.state).toBe("failed");
    expect(delivery.errorCode).toBe("NOTIFICATION_API_ERROR");
    const failureCall = fetcher.mock.calls[0] as unknown as
      | [unknown, RequestInit]
      | undefined;
    if (!failureCall) throw new Error("fetch was not called");
    expect(parseRequestBody(failureCall[1].body)).toEqual({
      p_idempotency_key: "sub_a|2026-09-15|7|native",
      p_state: "failed",
      p_error_code: "NOTIFICATION_API_ERROR",
    });
  });

  it.each([
    [
      "a failure without a code",
      { idempotencyKey: "k", state: "failed" } as const,
    ],
    [
      "a non-failure carrying a code",
      { idempotencyKey: "k", state: "delivered", errorCode: "X" } as const,
    ],
    [
      "a state the server would refuse",
      { idempotencyKey: "k", state: "pending" } as never,
    ],
    [
      "an empty idempotency key",
      { idempotencyKey: "", state: "claimed" } as const,
    ],
    [
      "a malformed error code",
      {
        idempotencyKey: "k",
        state: "failed",
        errorCode: "not a code",
      } as const,
    ],
  ])("rejects %s before any credentialed I/O", async (_label, input) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(
      createDataPlaneRepositories(
        repositoryOptions,
      ).reminders.acknowledgeDelivery(input),
    ).rejects.toMatchObject({ reason: "invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a server response that violates the delivery invariants", async () => {
    // delivered without a delivered_at instant is not a legal row.
    const corrupt = { ...deliveredRow, delivered_at: null };
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify(corrupt), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);

    await expect(
      createDataPlaneRepositories(
        repositoryOptions,
      ).reminders.acknowledgeDelivery({
        idempotencyKey: "k",
        state: "delivered",
      }),
    ).rejects.toMatchObject({ reason: "invalid" });
  });
});

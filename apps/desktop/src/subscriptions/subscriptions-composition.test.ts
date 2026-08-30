import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopSubscriptionsRuntime } from "./subscriptions-composition";

const environment = {
  VITE_SUPABASE_URL: "https://project.supabase.co",
  VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
};

afterEach(() => vi.unstubAllGlobals());

describe("desktop subscription composition", () => {
  it("fails closed without public data-plane configuration or token work", async () => {
    const accessToken = vi.fn(async () => ({
      token: "must-not-be-read",
      isCurrent: () => true,
    }));
    const runtime = createDesktopSubscriptionsRuntime({}, { accessToken });
    runtime.activate("user_a");

    await expect(runtime.boot()).resolves.toEqual({
      status: "error",
      message: "Private subscription sync is not configured.",
      retryable: false,
    });
    expect(accessToken).not.toHaveBeenCalled();
  });

  it("loads authenticated subscription and renewal repositories with generation-bound leases", async () => {
    const lease = {
      token: "clerk-session-fixture",
      isCurrent: vi.fn(() => true),
    };
    const accessToken = vi.fn(async () => lease);
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      const body = url.pathname.endsWith("/rpc/calendar_events_page")
        ? {
            events: [],
            next_cursor: null,
            complete: true,
            truncated: false,
            authoritative: true,
            work: {
              source_rows_scanned: 0,
              recurrence_candidates: 0,
              correction_rows_scanned: 0,
              phases_completed: 1,
            },
          }
        : { items: [], next_cursor: null, complete: true };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const runtime = createDesktopSubscriptionsRuntime(environment, {
      accessToken,
    });
    runtime.activate("user_a");

    await expect(runtime.boot()).resolves.toMatchObject({
      status: "ready",
      items: [],
      calendarEvents: [],
    });
    await expect(
      runtime.loadCalendarRange({
        rangeStart: "2026-07-26",
        rangeEnd: "2026-12-04",
      }),
    ).resolves.toMatchObject({ status: "ready", calendarEvents: [] });
    expect(accessToken).toHaveBeenCalledTimes(2);
    expect(lease.isCurrent).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls
        .map(
          ([url]) =>
            new URL(
              typeof url === "string"
                ? url
                : url instanceof URL
                  ? url.href
                  : url.url,
            ).pathname,
        )
        .sort(),
    ).toEqual([
      "/rest/v1/rpc/calendar_events_page",
      "/rest/v1/rpc/subscriptions_page",
    ]);
    const calendarRequest = fetcher.mock.calls.find(([url]) =>
      new URL(
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
      ).pathname.endsWith("/rpc/calendar_events_page"),
    );
    if (!calendarRequest) throw new Error("missing calendar RPC request");
    expect(calendarRequest[1]?.method).toBe("POST");
    const calendarRequestBody = calendarRequest[1]?.body;
    if (typeof calendarRequestBody !== "string") {
      throw new Error("calendar RPC request body must be JSON text");
    }
    expect(JSON.parse(calendarRequestBody)).toEqual({
      p_range_start: "2026-07-26",
      p_range_end: "2026-12-04",
      p_filter: "all",
      p_query: "",
      p_page_size: 256,
      p_cursor: null,
    });
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({
        cache: "no-store",
        credentials: "omit",
      });
    }
  });

  it("preserves lease currentness and blocks stale fetch dispatch", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const runtime = createDesktopSubscriptionsRuntime(environment, {
      accessToken: async () => ({
        token: "stale-clerk-session-fixture",
        isCurrent: () => false,
      }),
    });
    runtime.activate("user_a");

    await expect(runtime.boot()).resolves.toEqual({
      status: "error",
      message: "Subscriptions could not be loaded.",
      retryable: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

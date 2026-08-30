import {
  createLifecycleState,
  createRecurrenceRule,
  createRecurringSubscription,
} from "@subtrack/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataPlaneRepositories } from ".";

const leased = (token: string) => ({ token, isCurrent: () => true });

function parseRequestBody(body: BodyInit | null | undefined) {
  if (typeof body !== "string") {
    throw new Error("expected_string_request_body");
  }
  return JSON.parse(body) as Record<string, unknown>;
}

const subscription = createRecurringSubscription({
  kind: "recurring",
  id: "sub_fixture_a",
  serviceName: "Fixture Streaming",
  amount: { minorUnits: 1299, currency: "USD" },
  timezone: "UTC",
  startDate: "2026-01-31",
  nextRenewalDate: "2026-02-28",
  recurrence: createRecurrenceRule("monthly"),
  lifecycle: createLifecycleState({
    status: "active",
    since: "2026-01-31",
  }),
});
const metadata = {
  planName: null,
  accountEmail: null,
  paymentLabel: null,
  managementUrl: null,
  notes: null,
} as const;

function renewalRow(
  input: Readonly<{
    occurrenceDate: string;
    createdAt: string;
    originalOccurrenceDate?: string;
  }>,
) {
  const originalOccurrenceDate =
    input.originalOccurrenceDate ?? input.occurrenceDate;
  const corrected = input.originalOccurrenceDate !== undefined;
  return {
    owner_user_id: "user_fixture_a",
    idempotency_key: `renewal:v1:sub_fixture_a:${originalOccurrenceDate}`,
    subscription_id: "sub_fixture_a",
    occurrence_date: input.occurrenceDate,
    amount_minor: corrected ? 1399 : 1299,
    currency_code: "USD",
    state: corrected ? "corrected" : "expected",
    confirmed_on: null,
    corrected_on: corrected ? "2026-08-04" : null,
    skipped_on: null,
    original_occurrence_date: corrected ? originalOccurrenceDate : null,
    original_amount_minor: corrected ? 1299 : null,
    original_currency_code: corrected ? "USD" : null,
    version: corrected ? 2 : 1,
    created_at: input.createdAt,
    updated_at: input.createdAt,
  };
}

function subscriptionRow(
  input: Readonly<{ id: string; createdAt: string; serviceName?: string }>,
) {
  return {
    owner_user_id: "user_fixture_a",
    id: input.id,
    kind: "recurring",
    service_name: input.serviceName ?? input.id,
    plan_name: null,
    amount_minor: 1299,
    currency_code: "USD",
    timezone: "UTC",
    lifecycle_status: "active",
    lifecycle_since: "2026-01-31",
    trial_ends_on: null,
    lifecycle_access_ends_on: null,
    start_date: "2026-01-31",
    purchased_on: null,
    access_ends_on: null,
    next_renewal_date: "2026-08-31",
    recurrence_unit: "month",
    recurrence_interval: 1,
    account_email: null,
    payment_label: null,
    management_url: null,
    category: null,
    notes: null,
    version: 1,
    created_at: input.createdAt,
    updated_at: input.createdAt,
  };
}

function jsonRows(rows: readonly unknown[]) {
  return Promise.resolve(
    new Response(JSON.stringify(rows), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("authenticated data-plane client", () => {
  it.each([
    "sb_secret_fixture",
    `header.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.signature`,
  ])("rejects a server credential at the client boundary", (key) => {
    expect(() =>
      createDataPlaneRepositories({
        accessToken: () => Promise.resolve(leased("session")),
        publishableKey: key,
        supabaseUrl: "https://project.supabase.co",
      }),
    ).toThrow("data_plane_request_failed");
  });

  it("validates preference writes before issuing a request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const repository = createDataPlaneRepositories({
      accessToken: () => Promise.resolve(leased("session")),
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    }).preferences;
    await expect(
      repository.create({
        timezone: "UTC",
        homeCurrency: "NOT_MONEY",
        reminderLeadDays: [7, 1],
        emailRemindersEnabled: false,
        locale: "en",
      }),
    ).rejects.toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("redacts server response bodies from repository errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response("person@example.com database-secret", { status: 500 }),
        ),
      ),
    );
    const repository = createDataPlaneRepositories({
      accessToken: () => Promise.resolve(leased("session")),
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    }).subscriptions;
    const error = await repository.list().catch((caught: unknown) => caught);
    expect(String(error)).toBe("Error: data_plane_request_failed");
    expect(String(error)).not.toMatch(/person@example|database-secret/);
  });
});

describe("authenticated subscription repository", () => {
  it("returns stable bounded ledger pages instead of accumulating an account", async () => {
    const rows = [
      subscriptionRow({
        id: "sub_fixture_a",
        serviceName: "Alpha",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      subscriptionRow({
        id: "sub_fixture_b",
        serviceName: "Beta",
        createdAt: "2026-08-02T00:00:00.000Z",
      }),
      subscriptionRow({
        id: "sub_fixture_c",
        serviceName: "Gamma",
        createdAt: "2026-08-03T00:00:00.000Z",
      }),
    ];
    const cursor = "8c16601f56324dcfa888a129cbe2f026";
    const fetcher = vi.fn<typeof fetch>(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const body = parseRequestBody(init?.body);
        return new Response(
          JSON.stringify(
            body.p_cursor === null
              ? {
                  items: rows.slice(0, 2),
                  next_cursor: cursor,
                  complete: false,
                }
              : { items: [rows[2]], next_cursor: null, complete: true },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetcher);
    const repository = createDataPlaneRepositories({
      accessToken: () =>
        Promise.resolve(leased("standard-clerk-session-token")),
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    }).subscriptions as unknown as {
      listPage?: (
        input: Readonly<{ cursor: string | null; pageSize: number }>,
      ) => Promise<{
        items: readonly unknown[];
        nextCursor: string | null;
        complete: boolean;
      }>;
    };

    const first =
      (await repository.listPage?.({ cursor: null, pageSize: 2 })) ?? null;

    expect(first).toMatchObject({
      items: [
        { subscription: { id: "sub_fixture_a" } },
        { subscription: { id: "sub_fixture_b" } },
      ],
      nextCursor: expect.any(String),
      complete: false,
    });
    if (!first) return;
    const second = await repository.listPage?.({
      cursor: first.nextCursor,
      pageSize: 2,
    });
    expect(second).toMatchObject({
      items: [{ subscription: { id: "sub_fixture_c" } }],
      nextCursor: null,
      complete: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [firstUrlInput, firstInit] = fetcher.mock.calls[0] ?? [];
    const [secondUrlInput, secondInit] = fetcher.mock.calls[1] ?? [];
    if (firstUrlInput === undefined || secondUrlInput === undefined) {
      throw new Error("expected ledger requests");
    }
    for (const urlInput of [firstUrlInput, secondUrlInput]) {
      const url = new URL(
        urlInput instanceof Request
          ? urlInput.url
          : urlInput instanceof URL
            ? urlInput.href
            : urlInput,
      );
      expect(url.pathname).toBe("/rest/v1/rpc/subscriptions_page");
      expect(url.search).toBe("");
      expect(url.href).not.toMatch(/sub_fixture|Alpha|Beta|Gamma|owner/u);
    }
    expect(firstInit?.method).toBe("POST");
    expect(parseRequestBody(firstInit?.body)).toEqual({
      p_page_size: 2,
      p_cursor: null,
    });
    expect(parseRequestBody(secondInit?.body)).toEqual({
      p_page_size: 2,
      p_cursor: cursor,
    });
  });

  it("rejects a non-opaque ledger continuation returned by the server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              items: [
                subscriptionRow({
                  id: "sub_fixture_a",
                  createdAt: "2026-08-01T00:00:00.000Z",
                }),
              ],
              next_cursor: "sub_fixture_a:owner_fixture",
              complete: false,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const repository = createDataPlaneRepositories({
      accessToken: () =>
        Promise.resolve(leased("standard-clerk-session-token")),
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    }).subscriptions as unknown as {
      listPage?: (
        input: Readonly<{ cursor: null; pageSize: number }>,
      ) => Promise<unknown>;
    };

    const operation =
      repository.listPage?.({ cursor: null, pageSize: 2 }) ??
      Promise.resolve(null);

    await expect(operation).rejects.toMatchObject({ reason: "invalid" });
  });

  it("writes a validated subscription without accepting an owner identifier", async () => {
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
      const written = parseRequestBody(init?.body);
      return new Response(
        JSON.stringify([
          {
            ...written,
            id: subscription.id,
            plan_name: null,
            account_email: null,
            payment_label: null,
            management_url: null,
            notes: null,
            owner_user_id: "user_fixture_a",
            version: 1,
            created_at: "2026-08-04T12:00:00.000Z",
            updated_at: "2026-08-04T12:00:00.000Z",
          },
        ]),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const repository = createDataPlaneRepositories({
      accessToken: () =>
        Promise.resolve(leased("standard-clerk-session-token")),
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    }).subscriptions;

    const persisted = await repository.create({ subscription, metadata });

    const request = fetcher.mock.calls[0];
    if (request === undefined) throw new Error("missing request");
    const requestUrl = new URL(request[0]);
    expect(`${requestUrl.origin}${requestUrl.pathname}`).toBe(
      "https://project.supabase.co/rest/v1/subscriptions",
    );
    const projection = requestUrl.searchParams.get("select");
    expect(projection).not.toContain("*");
    expect(projection?.split(",")).toEqual(
      expect.arrayContaining([
        "owner_user_id",
        "id",
        "kind",
        "timezone",
        "version",
        "created_at",
        "updated_at",
      ]),
    );
    const body = parseRequestBody(request?.[1]?.body);
    expect(body).not.toHaveProperty("owner_user_id");
    expect(body).toMatchObject({
      id: "sub_fixture_a",
      amount_minor: 1299,
      currency_code: "USD",
      recurrence_unit: "month",
      recurrence_interval: 1,
    });
    expect(persisted).toMatchObject({ subscription, version: 1 });
  });

  it("rejects malformed rows returned by the data plane", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(JSON.stringify([{ id: "sub_untrusted" }]), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
    const repository = createDataPlaneRepositories({
      accessToken: () =>
        Promise.resolve(leased("standard-clerk-session-token")),
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    }).subscriptions;

    await expect(repository.list()).rejects.toMatchObject({
      reason: "invalid",
    });
  });

  it("uses optimistic version matching without exposing ownership on update", async () => {
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      const written = parseRequestBody(init?.body);
      return new Response(
        JSON.stringify([
          {
            ...written,
            id: subscription.id,
            plan_name: null,
            account_email: null,
            payment_label: null,
            management_url: null,
            notes: null,
            owner_user_id: "user_fixture_a",
            version: 3,
            created_at: "2026-08-04T12:00:00.000Z",
            updated_at: "2026-08-04T12:01:00.000Z",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const repository = createDataPlaneRepositories({
      accessToken: () =>
        Promise.resolve(leased("standard-clerk-session-token")),
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    }).subscriptions;

    await repository.update({ subscription, metadata }, 2);

    const request = fetcher.mock.calls[0];
    expect(request?.[0]).toContain("id=eq.sub_fixture_a");
    expect(request?.[0]).toContain("version=eq.2");
    expect(parseRequestBody(request?.[1]?.body)).not.toHaveProperty(
      "owner_user_id",
    );
    expect(parseRequestBody(request?.[1]?.body)).not.toHaveProperty("id");
    expect(Object.keys(parseRequestBody(request?.[1]?.body)).sort()).toEqual(
      [
        "access_ends_on",
        "account_email",
        "amount_minor",
        "category",
        "currency_code",
        "kind",
        "lifecycle_access_ends_on",
        "lifecycle_since",
        "lifecycle_status",
        "management_url",
        "next_renewal_date",
        "notes",
        "payment_label",
        "plan_name",
        "purchased_on",
        "recurrence_interval",
        "recurrence_unit",
        "service_name",
        "start_date",
        "timezone",
        "trial_ends_on",
      ].sort(),
    );
  });
});

describe("authenticated calendar query repository", () => {
  it("reconciles bounded phases before returning an authoritative page", async () => {
    const phaseCursor = "b6b4fc63d21247f7a21b065257e881cf";
    const pageCursor = "fa0d24c54f7f4f569a07f0f2f8e56016";
    const authoritativeResponse = {
      events: [
        {
          id: "sub_fixture_a:expected_charge:2026-08-31",
          subscription_id: "sub_fixture_a",
          service_name: "Fixture Streaming",
          plan_name: null,
          category: "Streaming",
          event_date: "2026-08-31",
          event_kind: "expected_charge",
          original_date: null,
        },
      ],
      next_cursor: pageCursor,
      complete: false,
      truncated: true,
      authoritative: true,
      work: {
        source_rows_scanned: 0,
        recurrence_candidates: 0,
        correction_rows_scanned: 7,
        phases_completed: 2,
      },
    };
    const fetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        void _input;
        const body = parseRequestBody(init?.body);
        const response =
          body.p_cursor === null
            ? {
                events: [],
                next_cursor: phaseCursor,
                complete: false,
                truncated: true,
                authoritative: false,
                work: {
                  source_rows_scanned: 256,
                  recurrence_candidates: 47_616,
                  correction_rows_scanned: 0,
                  phases_completed: 1,
                },
              }
            : authoritativeResponse;
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", fetcher);
    const repositories = createDataPlaneRepositories({
      accessToken: () =>
        Promise.resolve(leased("standard-clerk-session-token")),
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    }) as unknown as {
      calendar?: {
        listPage(input: Readonly<Record<string, unknown>>): Promise<unknown>;
      };
    };
    const request = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
      filter: "charges",
      query: "fixture",
      pageSize: 256,
      cursor: null,
    } as const;

    const result = (await repositories.calendar?.listPage(request)) ?? null;

    expect(result).toEqual({
      events: [
        {
          id: "sub_fixture_a:expected_charge:2026-08-31",
          subscriptionId: "sub_fixture_a",
          serviceName: "Fixture Streaming",
          planName: null,
          category: "Streaming",
          date: "2026-08-31",
          kind: "expected_charge",
        },
      ],
      nextCursor: pageCursor,
      complete: false,
      truncated: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [urlInput, init] = fetcher.mock.calls[0] ?? [];
    if (urlInput === undefined) throw new Error("expected calendar request");
    const requestUrl =
      urlInput instanceof Request
        ? urlInput.url
        : urlInput instanceof URL
          ? urlInput.href
          : urlInput;
    expect(new URL(requestUrl).pathname).toBe(
      "/rest/v1/rpc/calendar_events_page",
    );
    expect(init?.method).toBe("POST");
    expect(parseRequestBody(init?.body)).toEqual({
      p_range_start: request.rangeStart,
      p_range_end: request.rangeEnd,
      p_filter: request.filter,
      p_query: request.query,
      p_page_size: request.pageSize,
      p_cursor: request.cursor,
    });
    expect(parseRequestBody(init?.body)).not.toHaveProperty("owner_user_id");
    expect(parseRequestBody(fetcher.mock.calls[1]?.[1]?.body)).toEqual({
      p_range_start: request.rangeStart,
      p_range_end: request.rangeEnd,
      p_filter: request.filter,
      p_query: request.query,
      p_page_size: request.pageSize,
      p_cursor: phaseCursor,
    });
  });

  it("passes percent, underscore, and escape characters as literal search text", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            events: [],
            next_cursor: null,
            complete: true,
            truncated: false,
            authoritative: true,
            work: {
              source_rows_scanned: 1,
              recurrence_candidates: 0,
              correction_rows_scanned: 0,
              phases_completed: 1,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const repository = createDataPlaneRepositories({
      accessToken: () =>
        Promise.resolve(leased("standard-clerk-session-token")),
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    }).calendar;

    await repository.listPage({
      rangeStart: "2026-08-01",
      rangeEnd: "2026-08-31",
      filter: "all",
      query: String.raw`50%_off\\plan`,
      pageSize: 25,
      cursor: null,
    });

    const literalRequest = fetcher.mock.calls[0];
    if (!literalRequest) throw new Error("missing literal search request");
    expect(parseRequestBody(literalRequest[1]?.body)).toMatchObject({
      p_query: String.raw`50%_off\\plan`,
    });
  });
});

describe("authenticated renewal repository", () => {
  it("loads history through an opaque POST continuation without URL identities", async () => {
    const first = renewalRow({
      occurrenceDate: "2026-08-01",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const second = renewalRow({
      occurrenceDate: "2026-08-02",
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    const cursor = "34c1aac87b984845a7802733c65222ad";
    const fetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const body = parseRequestBody(init?.body);
        return new Response(
          JSON.stringify(
            body.p_cursor === null
              ? { events: [first], next_cursor: cursor, complete: false }
              : { events: [second], next_cursor: null, complete: true },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetcher);
    const repository = createDataPlaneRepositories({
      accessToken: () =>
        Promise.resolve(leased("standard-clerk-session-token")),
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    }).renewals;

    const firstPage = await repository.listPage({
      subscriptionId: "sub_fixture_a",
      cursor: null,
      pageSize: 1,
    });
    const secondPage = await repository.listPage({
      subscriptionId: "sub_fixture_a",
      cursor: firstPage.nextCursor,
      pageSize: 1,
    });

    expect(firstPage).toMatchObject({
      events: [{ event: { occurrenceDate: "2026-08-01" } }],
      nextCursor: cursor,
      complete: false,
    });
    expect(secondPage).toMatchObject({
      events: [{ event: { occurrenceDate: "2026-08-02" } }],
      nextCursor: null,
      complete: true,
    });
    for (const [urlInput, init] of fetcher.mock.calls) {
      const url = new URL(
        urlInput instanceof Request ? urlInput.url : urlInput,
      );
      expect(url.pathname).toBe("/rest/v1/rpc/renewal_history_page");
      expect(url.search).toBe("");
      expect(url.href).not.toContain("sub_fixture_a");
      expect(init?.method).toBe("POST");
    }
    expect(parseRequestBody(fetcher.mock.calls[0]?.[1]?.body)).toEqual({
      p_subscription_id: "sub_fixture_a",
      p_page_size: 1,
      p_cursor: null,
    });
    expect(parseRequestBody(fetcher.mock.calls[1]?.[1]?.body)).toEqual({
      p_subscription_id: "sub_fixture_a",
      p_page_size: 1,
      p_cursor: cursor,
    });
  });

  it("paginates a server-capped range through an in-range corrected original", async () => {
    const first = renewalRow({
      occurrenceDate: "2026-08-01",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const second = renewalRow({
      occurrenceDate: "2026-08-02",
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    const corrected = renewalRow({
      occurrenceDate: "2027-01-01",
      originalOccurrenceDate: "2026-08-03",
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (
        url.searchParams.get("order") ===
        "created_at.desc,owner_user_id.desc,idempotency_key.desc"
      ) {
        return jsonRows([corrected]);
      }
      return url.searchParams.get("and")?.includes("created_at.gt")
        ? jsonRows([corrected])
        : jsonRows([first, second]);
    });
    vi.stubGlobal("fetch", fetcher);
    const repository = createDataPlaneRepositories({
      accessToken: () =>
        Promise.resolve(leased("standard-clerk-session-token")),
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    }).renewals;

    const result = await repository.listRange({
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
      maxEvents: 512,
    });

    expect(result).toMatchObject({
      truncated: false,
      events: [
        { event: { occurrenceDate: "2026-08-01" } },
        { event: { occurrenceDate: "2026-08-02" } },
        {
          event: {
            occurrenceDate: "2027-01-01",
            original: { occurrenceDate: "2026-08-03" },
          },
        },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const request = fetcher.mock.calls[0];
    if (!request) throw new Error("missing request");
    const url = new URL(
      request[0] instanceof Request ? request[0].url : request[0],
    );
    expect(url.pathname).toBe("/rest/v1/renewal_events");
    expect(url.searchParams.get("limit")).toBe("1");
    expect(url.searchParams.get("order")).toBe(
      "created_at.desc,owner_user_id.desc,idempotency_key.desc",
    );
    expect(url.searchParams.get("or")).toBe(
      "(and(occurrence_date.gte.2026-07-26,occurrence_date.lte.2026-12-04),and(original_occurrence_date.gte.2026-07-26,original_occurrence_date.lte.2026-12-04))",
    );
  });

  it("returns an explicit truncation result after proving one extra match", async () => {
    const rows = [
      renewalRow({
        occurrenceDate: "2026-08-01",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      renewalRow({
        occurrenceDate: "2026-08-02",
        createdAt: "2026-08-02T00:00:00.000Z",
      }),
      renewalRow({
        occurrenceDate: "2026-08-03",
        createdAt: "2026-08-03T00:00:00.000Z",
      }),
    ];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.searchParams.get("order")?.includes(".desc")) {
        return jsonRows([rows[2]]);
      }
      return url.searchParams.get("and")?.includes("created_at.gt")
        ? jsonRows([rows[2]])
        : jsonRows(rows.slice(0, 2));
    });
    vi.stubGlobal("fetch", fetcher);
    const repository = createDataPlaneRepositories({
      accessToken: () =>
        Promise.resolve(leased("standard-clerk-session-token")),
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    }).renewals;

    await expect(
      repository.listRange({
        rangeStart: "2026-08-01",
        rangeEnd: "2026-08-31",
        maxEvents: 2,
      }),
    ).resolves.toMatchObject({
      truncated: true,
      events: [
        { event: { occurrenceDate: "2026-08-01" } },
        { event: { occurrenceDate: "2026-08-02" } },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects a repeated pagination cursor instead of looping", async () => {
    const first = renewalRow({
      occurrenceDate: "2026-08-01",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const highWater = renewalRow({
      occurrenceDate: "2026-08-02",
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return url.searchParams.get("order")?.includes(".desc")
        ? jsonRows([highWater])
        : jsonRows([first]);
    });
    vi.stubGlobal("fetch", fetcher);
    const repository = createDataPlaneRepositories({
      accessToken: () =>
        Promise.resolve(leased("standard-clerk-session-token")),
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    }).renewals;

    await expect(
      repository.listRange({
        rangeStart: "2026-08-01",
        rangeEnd: "2026-08-31",
        maxEvents: 512,
      }),
    ).rejects.toMatchObject({ reason: "invalid" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("checks a fresh token lease before every paginated dispatch", async () => {
    const first = renewalRow({
      occurrenceDate: "2026-08-01",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const highWater = renewalRow({
      occurrenceDate: "2026-08-02",
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    let leaseNumber = 0;
    const accessToken = vi.fn(async () => {
      const currentLease = (leaseNumber += 1);
      return {
        token: "standard-clerk-session-token",
        isCurrent: () => currentLease < 3,
      };
    });
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return url.searchParams.get("order")?.includes(".desc")
        ? jsonRows([highWater])
        : jsonRows([first]);
    });
    vi.stubGlobal("fetch", fetcher);
    const repository = createDataPlaneRepositories({
      accessToken,
      publishableKey: "sb_publishable_fixture",
      supabaseUrl: "https://project.supabase.co",
    }).renewals;

    await expect(
      repository.listRange({
        rangeStart: "2026-08-01",
        rangeEnd: "2026-08-31",
        maxEvents: 512,
      }),
    ).rejects.toMatchObject({ reason: "auth" });
    expect(accessToken).toHaveBeenCalledTimes(3);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

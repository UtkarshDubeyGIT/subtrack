import { afterEach, describe, expect, it, vi } from "vitest";
import * as dataModule from ".";
import {
  createDataPlaneRepositories,
  DataPlaneError,
  type SubscriptionWrite,
} from ".";
import {
  createLifecycleState,
  correctRenewal,
  createExpectedRenewal,
  createRecurrenceRule,
  createRecurringSubscription,
} from "@subtrack/domain";

const leased = (token: string) => ({ token, isCurrent: () => true });

const options = {
  accessToken: () => Promise.resolve(leased("standard-clerk-session-token")),
  publishableKey: "sb_publishable_fixture",
  supabaseUrl: "https://project.supabase.co",
};
const emptyMetadata = {
  planName: null,
  accountEmail: null,
  paymentLabel: null,
  managementUrl: null,
  notes: null,
} as const;

afterEach(() => vi.unstubAllGlobals());

function parseRequestBody(body: BodyInit | null | undefined) {
  if (typeof body !== "string") throw new Error("expected_string_body");
  return JSON.parse(body) as Record<string, unknown>;
}

describe("data-plane credential boundary", () => {
  it("does not expose the credential-bearing transport", () => {
    expect(dataModule).not.toHaveProperty("AuthenticatedPostgrestClient");
    const repositories = createDataPlaneRepositories(options);
    for (const repository of Object.values(repositories)) {
      expect(Object.getOwnPropertyNames(repository)).not.toContain("client");
      expect(Object.values(repository)).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ request: expect.any(Function) }),
        ]),
      );
    }
  });

  it("redacts an access-token provider failure without issuing a request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const repositories = createDataPlaneRepositories({
      ...options,
      accessToken: () => Promise.reject(new Error("provider-secret")),
    });

    const error = await repositories.subscriptions
      .list()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DataPlaneError);
    expect(String(error)).toBe("Error: data_plane_request_failed");
    expect(String(error)).not.toContain("provider-secret");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "sb_secret_fixture",
    `header.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.signature`,
  ])(
    "rejects a server credential returned as an access token",
    async (token) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const repositories = createDataPlaneRepositories({
        ...options,
        accessToken: () => Promise.resolve(leased(token)),
      });

      await expect(repositories.subscriptions.list()).rejects.toMatchObject({
        reason: "auth",
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});

describe("subscription write integrity", () => {
  it("rejects a recurrence-misaligned runtime value before I/O", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const repositories = createDataPlaneRepositories(options);
    const forged = {
      kind: "recurring",
      id: "sub_forged",
      serviceName: "Forged",
      amount: { minorUnits: 100, currency: "USD", exponent: 2 },
      timezone: "UTC",
      startDate: "2026-01-31",
      nextRenewalDate: "2026-02-27",
      recurrence: { unit: "month", interval: 1 },
      lifecycle: { status: "active", since: "2026-01-31" },
    } as const;

    const error = await repositories.subscriptions
      .create({
        subscription: forged,
        metadata: emptyMetadata,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DataPlaneError);
    expect(String(error)).toBe("Error: data_plane_request_failed");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a forged one-time subscription before I/O", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const forged = {
      kind: "one_time",
      id: "one_time_forged",
      serviceName: "Forged purchase",
      amount: { minorUnits: 100, currency: "USD", exponent: 2 },
      timezone: "UTC",
      purchasedOn: "2026-02-01",
      accessEndsOn: "2026-01-31",
      lifecycle: { status: "active", since: "2026-02-01" },
    } as unknown as SubscriptionWrite["subscription"];

    await expect(
      createDataPlaneRepositories(options).subscriptions.create({
        subscription: forged,
        metadata: emptyMetadata,
      }),
    ).rejects.toMatchObject({ reason: "invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["unsupported currency", { amount: { minorUnits: 100, currency: "ZZZ" } }],
    [
      "unsafe money",
      { amount: { minorUnits: 9007199254740992, currency: "USD" } },
    ],
    ["invalid timezone", { timezone: "Mars/Olympus" }],
    [
      "incomplete trial",
      { lifecycle: { status: "trial", since: "2026-01-31" } },
    ],
  ])("rejects %s before I/O", async (_label, replacement) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const valid = createRecurringSubscription({
      kind: "recurring",
      id: "sub_runtime_validation",
      serviceName: "Runtime Validation",
      amount: { minorUnits: 100, currency: "USD" },
      timezone: "UTC",
      startDate: "2026-01-31",
      nextRenewalDate: "2026-02-28",
      recurrence: createRecurrenceRule("monthly"),
      lifecycle: createLifecycleState({
        status: "active",
        since: "2026-01-31",
      }),
    });
    const forged = {
      ...valid,
      ...replacement,
    } as unknown as SubscriptionWrite["subscription"];

    await expect(
      createDataPlaneRepositories(options).subscriptions.create({
        subscription: forged,
        metadata: emptyMetadata,
      }),
    ).rejects.toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("round-trips explicit subscription metadata", async () => {
    const metadata = {
      planName: "Family",
      accountEmail: "owner@example.test",
      paymentLabel: "Personal card",
      managementUrl: "https://billing.example.test/account",
      category: "Entertainment",
      notes: "Annual discount",
    } as const;
    const subscription = createRecurringSubscription({
      kind: "recurring",
      id: "sub_metadata",
      serviceName: "Metadata Fixture",
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
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
      const body = parseRequestBody(init?.body);
      return new Response(
        JSON.stringify([
          {
            ...body,
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
    const repositories = createDataPlaneRepositories(options);

    const result = await repositories.subscriptions.create({
      subscription,
      metadata,
    });

    expect(result.metadata).toEqual(metadata);
    expect(parseRequestBody(fetcher.mock.calls[0]?.[1]?.body)).toMatchObject({
      plan_name: "Family",
      account_email: "owner@example.test",
      payment_label: "Personal card",
      management_url: "https://billing.example.test/account",
      category: "Entertainment",
      notes: "Annual discount",
    });
  });
});

describe("renewal history integrity", () => {
  it.each([
    "state",
    "idempotencyKey",
    "subscriptionId",
    "occurrenceDate",
    "originalOccurrenceDate",
    "nestedMoney",
  ] as const)(
    "rejects an alternating %s accessor before token acquisition or fetch",
    async (field) => {
      const token = vi.fn(() => Promise.resolve(leased("should-not-be-read")));
      const fetcher = vi.fn();
      const accessor = vi
        .fn()
        .mockReturnValueOnce("first")
        .mockReturnValue("second");
      const expected = {
        state: "expected",
        idempotencyKey: "renewal:v1:sub_accessor:2026-02-01",
        subscriptionId: "sub_accessor",
        occurrenceDate: "2026-02-01",
        amount: { minorUnits: 100, currency: "USD", exponent: 2 },
      };
      const corrected = {
        ...expected,
        state: "corrected",
        occurrenceDate: "2026-02-02",
        correctedOn: "2026-02-02",
        original: {
          occurrenceDate: "2026-02-01",
          amount: { minorUnits: 100, currency: "USD", exponent: 2 },
        },
      };
      const event =
        field === "originalOccurrenceDate" || field === "nestedMoney"
          ? corrected
          : expected;
      if (field === "originalOccurrenceDate") {
        Object.defineProperty(corrected.original, "occurrenceDate", {
          enumerable: true,
          get: accessor,
        });
      } else if (field === "nestedMoney") {
        Object.defineProperty(corrected.original.amount, "minorUnits", {
          enumerable: true,
          get: accessor,
        });
      } else {
        Object.defineProperty(event, field, {
          enumerable: true,
          get: accessor,
        });
      }
      vi.stubGlobal("fetch", fetcher);

      const error = await createDataPlaneRepositories({
        ...options,
        accessToken: token,
      })
        .renewals.save(event as never)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DataPlaneError);
      expect(String(error)).toBe("Error: data_plane_request_failed");
      expect(accessor).not.toHaveBeenCalled();
      expect(token).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("redacts an invalid renewal filter before token acquisition or fetch", async () => {
    const token = vi.fn(() => Promise.resolve(leased("should-not-be-read")));
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const error = await createDataPlaneRepositories({
      ...options,
      accessToken: token,
    })
      .renewals.list("invalid/filter")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DataPlaneError);
    expect(String(error)).toBe("Error: data_plane_request_failed");
    expect(String(error)).not.toContain("invalid/filter");
    expect(token).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a persisted renewal whose stable key does not match its identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify([
              {
                owner_user_id: "user_fixture_a",
                idempotency_key: "forged",
                subscription_id: "sub_forged",
                occurrence_date: "2026-02-01",
                amount_minor: 100,
                currency_code: "USD",
                state: "expected",
                confirmed_on: null,
                corrected_on: null,
                skipped_on: null,
                original_occurrence_date: null,
                original_amount_minor: null,
                original_currency_code: null,
                version: 1,
                created_at: "2026-08-04T12:00:00.000Z",
                updated_at: "2026-08-04T12:00:00.000Z",
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );

    await expect(
      createDataPlaneRepositories(options).renewals.list(),
    ).rejects.toMatchObject({ reason: "invalid" });
  });

  it("redacts an unsupported currency from a successful renewal row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify([
              {
                owner_user_id: "user_fixture_a",
                idempotency_key: "renewal:v1:sub_forged:2026-02-01",
                subscription_id: "sub_forged",
                occurrence_date: "2026-02-01",
                amount_minor: 100,
                currency_code: "ZZZ",
                state: "expected",
                confirmed_on: null,
                corrected_on: null,
                skipped_on: null,
                original_occurrence_date: null,
                original_amount_minor: null,
                original_currency_code: null,
                version: 1,
                created_at: "2026-08-04T12:00:00.000Z",
                updated_at: "2026-08-04T12:00:00.000Z",
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );

    const error = await createDataPlaneRepositories(options)
      .renewals.list()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DataPlaneError);
    expect(String(error)).toBe("Error: data_plane_request_failed");
    expect(String(error)).not.toContain("ZZZ");
  });

  it("redacts an invalid date from a successful renewal row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify([
              {
                owner_user_id: "user_fixture_a",
                idempotency_key: "renewal:v1:sub_forged:2026-02-30",
                subscription_id: "sub_forged",
                occurrence_date: "2026-02-30",
                amount_minor: 100,
                currency_code: "USD",
                state: "expected",
                confirmed_on: null,
                corrected_on: null,
                skipped_on: null,
                original_occurrence_date: null,
                original_amount_minor: null,
                original_currency_code: null,
                version: 1,
                created_at: "2026-08-04T12:00:00.000Z",
                updated_at: "2026-08-04T12:00:00.000Z",
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );

    const error = await createDataPlaneRepositories(options)
      .renewals.list()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DataPlaneError);
    expect(String(error)).toBe("Error: data_plane_request_failed");
    expect(String(error)).not.toContain("2026-02-30");
  });

  it("rejects a forged expected renewal before credentialed I/O", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(
      createDataPlaneRepositories(options).renewals.save({
        state: "expected",
        idempotencyKey: "forged",
        subscriptionId: { toString: () => "sub_forged" },
        occurrenceDate: "2026-02-01",
        amount: { minorUnits: 100, currency: "USD", exponent: 2 },
      } as never),
    ).rejects.toMatchObject({ reason: "invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a forged confirmed renewal with a redacted error and no I/O", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const error = await createDataPlaneRepositories(options)
      .renewals.save({
        state: "confirmed",
        idempotencyKey: "renewal:v1:sub_forged:2026-02-01",
        subscriptionId: "sub_forged",
        occurrenceDate: "2026-02-01",
        amount: { minorUnits: 100, currency: "USD", exponent: 2 },
        confirmedOn: "2026-01-31",
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DataPlaneError);
    expect(String(error)).toBe("Error: data_plane_request_failed");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a forged corrected renewal with an invalid original snapshot before I/O", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(
      createDataPlaneRepositories(options).renewals.save({
        state: "corrected",
        idempotencyKey: "renewal:v1:sub_forged:2026-02-01",
        subscriptionId: "sub_forged",
        occurrenceDate: "2026-02-02",
        amount: { minorUnits: 90, currency: "EUR", exponent: 2 },
        correctedOn: "2026-02-02",
        original: {
          occurrenceDate: "2026-02-01",
          amount: { minorUnits: -1, currency: "USD", exponent: 2 },
        },
      }),
    ).rejects.toMatchObject({ reason: "invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a forged skipped renewal before I/O", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(
      createDataPlaneRepositories(options).renewals.save({
        state: "skipped",
        idempotencyKey: "renewal:v1:sub_forged:2026-02-01",
        subscriptionId: "sub_forged",
        occurrenceDate: "2026-02-01",
        amount: { minorUnits: 100, currency: "USD", exponent: 2 },
        skippedOn: "2026-01-31",
      }),
    ).rejects.toMatchObject({ reason: "invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("round-trips the original currency of a cross-currency correction", async () => {
    const subscription = createRecurringSubscription({
      kind: "recurring",
      id: "sub_cross_currency",
      serviceName: "Cross Currency",
      amount: { minorUnits: 1299, currency: "USD" },
      timezone: "UTC",
      startDate: "2026-01-01",
      nextRenewalDate: "2026-02-01",
      recurrence: createRecurrenceRule("monthly"),
      lifecycle: createLifecycleState({
        status: "active",
        since: "2026-01-01",
      }),
    });
    const expected = createExpectedRenewal(subscription, "2026-02-01");
    const correction = {
      correctedOn: "2026-02-02",
      occurrenceDate: "2026-02-01",
      amount: { minorUnits: 1199, currency: "EUR" },
    } as const;
    const corrected = correctRenewal(expected, correction);
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
      const body = parseRequestBody(init?.body);
      return new Response(
        JSON.stringify([
          {
            ...body,
            idempotency_key: corrected.idempotencyKey,
            subscription_id: corrected.subscriptionId,
            original_currency_code: "USD",
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
    const repositories = createDataPlaneRepositories(options);

    const persisted = await repositories.renewals.correct(
      expected,
      correction,
      2,
    );

    expect(persisted.event).toMatchObject({
      amount: { currency: "EUR" },
      original: { amount: { currency: "USD" } },
    });
    expect(parseRequestBody(fetcher.mock.calls[0]?.[1]?.body)).toMatchObject({
      currency_code: "EUR",
      original_currency_code: "USD",
    });
    expect(
      parseRequestBody(fetcher.mock.calls[0]?.[1]?.body),
    ).not.toHaveProperty("idempotency_key");
    expect(
      parseRequestBody(fetcher.mock.calls[0]?.[1]?.body),
    ).not.toHaveProperty("subscription_id");
    expect(
      Object.keys(parseRequestBody(fetcher.mock.calls[0]?.[1]?.body)).sort(),
    ).toEqual(
      [
        "amount_minor",
        "confirmed_on",
        "corrected_on",
        "currency_code",
        "occurrence_date",
        "original_amount_minor",
        "original_currency_code",
        "original_occurrence_date",
        "skipped_on",
        "state",
      ].sort(),
    );
  });
});

describe("optimistic repository writes", () => {
  it("treats an empty conditional preference update as a conflict", async () => {
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
    const repositories = createDataPlaneRepositories(options);

    await expect(
      repositories.preferences.update(
        {
          timezone: "UTC",
          homeCurrency: "USD",
          reminderLeadDays: [7, 1],
          emailRemindersEnabled: false,
          locale: "en",
        },
        2,
      ),
    ).rejects.toMatchObject({ reason: "conflict" });
    expect(fetcher.mock.calls[0]?.[0]).toContain("version=eq.2");
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("PATCH");
  });

  it("treats an empty conditional subscription update as a conflict", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
    const subscription = createRecurringSubscription({
      kind: "recurring",
      id: "sub_conflict",
      serviceName: "Conflict",
      amount: { minorUnits: 100, currency: "USD" },
      timezone: "UTC",
      startDate: "2026-01-01",
      nextRenewalDate: "2026-02-01",
      recurrence: createRecurrenceRule("monthly"),
      lifecycle: createLifecycleState({
        status: "active",
        since: "2026-01-01",
      }),
    });

    await expect(
      createDataPlaneRepositories(options).subscriptions.update(
        { subscription, metadata: emptyMetadata },
        2,
      ),
    ).rejects.toMatchObject({ reason: "conflict" });
  });

  it("treats an empty conditional renewal update as a conflict", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
    const subscription = createRecurringSubscription({
      kind: "recurring",
      id: "sub_renewal_conflict",
      serviceName: "Renewal conflict",
      amount: { minorUnits: 100, currency: "USD" },
      timezone: "UTC",
      startDate: "2026-01-01",
      nextRenewalDate: "2026-02-01",
      recurrence: createRecurrenceRule("monthly"),
      lifecycle: createLifecycleState({
        status: "active",
        since: "2026-01-01",
      }),
    });

    await expect(
      createDataPlaneRepositories(options).renewals.confirm(
        createExpectedRenewal(subscription, "2026-02-01"),
        "2026-02-02",
        2,
      ),
    ).rejects.toMatchObject({ reason: "conflict" });
  });

  it("requires a version and reports a stale subscription deletion", async () => {
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
    const repositories = createDataPlaneRepositories(options);

    await expect(
      repositories.subscriptions.delete("sub_fixture_a", 3),
    ).rejects.toMatchObject({ reason: "conflict" });
    expect(fetcher.mock.calls[0]?.[0]).toContain("version=eq.3");
  });
});

describe("reminder override lifecycle", () => {
  it("reloads a validated reminder override", async () => {
    const row = {
      owner_user_id: "user_fixture_a",
      subscription_id: "sub_fixture_a",
      lead_days: [7, 1],
      channels: ["in_app", "email"],
      version: 2,
      created_at: "2026-08-04T12:00:00.000Z",
      updated_at: "2026-08-04T12:01:00.000Z",
    };
    const pages = [[row], [row], []];
    const fetcher = vi.fn<
      (input: string, init?: RequestInit) => Promise<Response>
    >(async () =>
      Promise.resolve(
        new Response(JSON.stringify(pages.shift() ?? []), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const repositories = createDataPlaneRepositories(options);

    await expect(repositories.reminders.listOverrides()).resolves.toEqual([
      {
        subscriptionId: "sub_fixture_a",
        leadDays: [7, 1],
        channels: ["in_app", "email"],
        version: 2,
        createdAt: "2026-08-04T12:00:00.000Z",
        updatedAt: "2026-08-04T12:01:00.000Z",
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("requires an optimistic version when deleting an override", async () => {
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
    const repositories = createDataPlaneRepositories(options);

    await expect(
      repositories.reminders.deleteOverride("sub_fixture_a", 2),
    ).rejects.toMatchObject({ reason: "conflict" });
    expect(fetcher.mock.calls[0]?.[0]).toContain("version=eq.2");
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });
});

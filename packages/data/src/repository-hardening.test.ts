import {
  createExpectedRenewal,
  createLifecycleState,
  createRecurrenceRule,
  createRecurringSubscription,
  type RenewalEvent,
} from "@subtrack/domain";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDataPlaneRepositories,
  DataPlaneError,
  type SubscriptionWrite,
} from ".";

const leased = (token: string) => ({ token, isCurrent: () => true });

const options = {
  accessToken: () => Promise.resolve(leased("standard-clerk-session-token")),
  publishableKey: "sb_publishable_fixture",
  supabaseUrl: "https://project.supabase.co",
};
const timestamp = "2026-08-05T12:00:00.000Z";
const subscription = createRecurringSubscription({
  kind: "recurring",
  id: "sub_repository_hardening",
  serviceName: "Repository hardening",
  amount: { minorUnits: 100, currency: "USD" },
  timezone: "UTC",
  startDate: "2026-01-01",
  nextRenewalDate: "2026-02-01",
  recurrence: createRecurrenceRule("monthly"),
  lifecycle: createLifecycleState({ status: "active", since: "2026-01-01" }),
});
const emptyMetadata = {
  planName: null,
  accountEmail: null,
  paymentLabel: null,
  managementUrl: null,
  notes: null,
} as const;
const subscriptionRow = {
  owner_user_id: "user_fixture_a",
  id: subscription.id,
  kind: "recurring",
  service_name: subscription.serviceName,
  plan_name: null,
  amount_minor: 100,
  currency_code: "USD",
  timezone: "UTC",
  lifecycle_status: "active",
  lifecycle_since: "2026-01-01",
  trial_ends_on: null,
  lifecycle_access_ends_on: null,
  start_date: "2026-01-01",
  purchased_on: null,
  access_ends_on: null,
  next_renewal_date: "2026-02-01",
  recurrence_unit: "month",
  recurrence_interval: 1,
  account_email: null,
  payment_label: null,
  management_url: null,
  category: null,
  notes: null,
  version: 1,
  created_at: timestamp,
  updated_at: timestamp,
} as const;
const renewal = createExpectedRenewal(subscription, "2026-02-01");
const panVectors = [
  { name: "contiguous", value: "4111111111111111", containsPan: true },
  { name: "ASCII-spaced", value: "4111 1111 1111 1111", containsPan: true },
  { name: "hyphenated", value: "4111-1111-1111-1111", containsPan: true },
  { name: "dotted", value: "4111.1111.1111.1111", containsPan: true },
  {
    name: "Unicode-spaced",
    value: "4111\u00a01111\u00a01111\u00a01111",
    containsPan: true,
  },
  { name: "masked last four", value: "Visa •••• 4242", containsPan: false },
  { name: "IMEI", value: "490154203237518", containsPan: false },
  {
    name: "unrelated Luhn-valid identifier",
    value: "1234567890123452",
    containsPan: false,
  },
] as const;
const rejectedMetadataCases: ReadonlyArray<
  readonly [string, Partial<SubscriptionWrite["metadata"]>]
> = [
  [
    "management URL username/password",
    { managementUrl: "https://repo-user:repo-password@example.test/manage" },
  ],
  ...panVectors
    .filter((vector) => vector.containsPan)
    .flatMap(
      (vector) =>
        [
          [
            `${vector.name} PAN in payment label`,
            { paymentLabel: `Card ${vector.value}` },
          ],
          [
            `${vector.name} PAN in notes`,
            { notes: `Never persist ${vector.value}` },
          ],
        ] as const,
    ),
];

afterEach(() => vi.unstubAllGlobals());

function response(rows: readonly unknown[]) {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("subscription metadata credential screening", () => {
  it.each(rejectedMetadataCases)(
    "rejects %s generically before credentialed I/O",
    async (_name, change) => {
      const accessToken = vi.fn(() => Promise.resolve(leased("unused-token")));
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const write = {
        subscription,
        metadata: { ...emptyMetadata, ...change },
      } as SubscriptionWrite;

      const error = await createDataPlaneRepositories({
        ...options,
        accessToken,
      })
        .subscriptions.create(write)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DataPlaneError);
      expect(error).toMatchObject({ reason: "invalid" });
      expect(String(error)).toBe("Error: data_plane_request_failed");
      expect(accessToken).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(panVectors.filter((vector) => !vector.containsPan))(
    "allows $name metadata without a PAN false positive",
    async ({ value }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: string, init?: RequestInit) => {
          if (typeof init?.body !== "string") throw new Error("missing body");
          const body = JSON.parse(init.body) as Record<string, unknown>;
          return response([{ ...subscriptionRow, ...body }]);
        }),
      );
      await expect(
        createDataPlaneRepositories(options).subscriptions.create({
          subscription,
          metadata: { ...emptyMetadata, paymentLabel: value },
        }),
      ).resolves.toMatchObject({
        subscription: { id: subscription.id },
        metadata: { paymentLabel: value },
      });
    },
  );
});

describe("deterministic collection pagination and projections", () => {
  const cases: ReadonlyArray<{
    name: string;
    rows: readonly unknown[];
    cursorColumns: readonly string[];
    invoke: (
      repositories: ReturnType<typeof createDataPlaneRepositories>,
    ) => Promise<readonly unknown[]>;
    fx?: boolean;
  }> = [
    {
      name: "subscriptions",
      rows: Array.from({ length: 5 }, (_, index) => ({
        ...subscriptionRow,
        id: `sub_page_0${index + 1}`,
        created_at: `2026-08-05T12:00:0${index}.000Z`,
      })),
      cursorColumns: ["created_at", "owner_user_id", "id"],
      invoke: (repositories) => repositories.subscriptions.list(),
    },
    {
      name: "renewals",
      rows: Array.from({ length: 5 }, (_, index) => ({
        owner_user_id: "user_fixture_a",
        idempotency_key: `renewal:v1:${renewal.subscriptionId}:2026-02-0${index + 1}`,
        subscription_id: renewal.subscriptionId,
        occurrence_date: `2026-02-0${index + 1}`,
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
        created_at: `2026-08-05T12:00:0${index}.000Z`,
        updated_at: timestamp,
      })),
      cursorColumns: ["created_at", "owner_user_id", "idempotency_key"],
      invoke: (repositories) => repositories.renewals.list(),
    },
    {
      name: "reminder overrides",
      rows: Array.from({ length: 5 }, (_, index) => ({
        owner_user_id: "user_fixture_a",
        subscription_id: `sub_page_0${index + 1}`,
        lead_days: [7],
        channels: ["email"],
        version: 1,
        created_at: `2026-08-05T12:00:0${index}.000Z`,
        updated_at: timestamp,
      })),
      cursorColumns: ["created_at", "owner_user_id", "subscription_id"],
      invoke: (repositories) => repositories.reminders.listOverrides(),
    },
    {
      name: "reminder deliveries",
      rows: Array.from({ length: 5 }, (_, index) => ({
        owner_user_id: "user_fixture_a",
        idempotency_key: `delivery_repository_0${index + 1}`,
        subscription_id: subscription.id,
        occurrence_date: `2026-02-0${index + 1}`,
        channel: "email",
        state: "pending",
        attempt_count: 0,
        scheduled_for: timestamp,
        delivered_at: null,
        error_code: null,
        version: 1,
        created_at: `2026-08-05T12:00:0${index}.000Z`,
        updated_at: timestamp,
      })),
      cursorColumns: ["created_at", "owner_user_id", "idempotency_key"],
      invoke: (repositories) => repositories.reminders.listDeliveries(),
    },
    {
      name: "FX rates",
      rows: ["CAD", "EUR", "GBP", "INR", "JPY"].map((quote, index) => ({
        base_currency: "USD",
        quote_currency: quote,
        rate: "999999999999999999.123456789012",
        effective_at: `2026-08-05T11:00:0${index}.000Z`,
        provider_code: "FIXTURE",
        created_at: `2026-08-05T12:00:0${index}.000Z`,
      })),
      cursorColumns: [
        "created_at",
        "base_currency",
        "quote_currency",
        "effective_at",
      ],
      invoke: (repositories) => repositories.fxRates.list("USD"),
      fx: true,
    },
    {
      name: "security audit history",
      rows: Array.from({ length: 5 }, (_, index) => ({
        owner_user_id: "user_fixture_a",
        id: index + 1,
        event_type: "export_requested",
        occurred_at: timestamp,
        request_id: "request_repository_hardening",
        version: 1,
        created_at: `2026-08-05T12:00:0${index}.000Z`,
        updated_at: timestamp,
      })),
      cursorColumns: ["created_at", "owner_user_id", "id"],
      invoke: (repositories) => repositories.securityAudit.list(),
    },
  ];

  it.each(cases)(
    "drains $name through a lower server cap with immutable keysets",
    async ({ rows, cursorColumns, invoke, fx }) => {
      const requestedUrls: URL[] = [];
      const pages = [
        [rows.at(-1)],
        rows.slice(0, 2),
        rows.slice(2, 4),
        rows.slice(4),
        [],
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          const url = new URL(input);
          requestedUrls.push(url);
          return response(pages.shift() ?? []);
        }),
      );

      const result = await invoke(createDataPlaneRepositories(options));

      expect(result).toHaveLength(5);
      expect(requestedUrls).toHaveLength(5);
      expect(
        requestedUrls.every((url) => !url.searchParams.has("offset")),
      ).toBe(true);
      expect(requestedUrls[0]?.searchParams.get("limit")).toBe("1");
      expect(requestedUrls[0]?.searchParams.get("order")).toBe(
        cursorColumns.map((column) => `${column}.desc`).join(","),
      );
      for (const url of requestedUrls.slice(1)) {
        expect(url.searchParams.get("limit")).toBe("1000");
        expect(url.searchParams.get("order")).toBe(
          cursorColumns.map((column) => `${column}.asc`).join(","),
        );
        expect(url.searchParams.get("and")).toBeTruthy();
      }
      for (const url of requestedUrls) {
        expect(url.searchParams.get("select")).toBeTruthy();
        expect(url.searchParams.get("select")).not.toContain("*");
      }
      if (fx) {
        expect(requestedUrls[0]?.searchParams.get("select")).toContain(
          "rate::text",
        );
        expect(result.at(-1)).toMatchObject({
          rate: "999999999999999999.123456789012",
        });
      }
    },
  );

  it("continues after an exact multiple of a lower server cap", async () => {
    const rows = cases[0]!.rows.slice(0, 4);
    const pages = [[rows.at(-1)], rows.slice(0, 2), rows.slice(2), []];
    const fetcher = vi.fn(async () => response(pages.shift() ?? []));
    vi.stubGlobal("fetch", fetcher);

    await expect(
      createDataPlaneRepositories(options).subscriptions.list(),
    ).resolves.toHaveLength(4);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("uses its high-water keyset across between-page deletion and insertion", async () => {
    const rows = cases.at(-1)!.rows;
    const insertedAfterHighWater = {
      ...(rows[0] as Record<string, unknown>),
      id: 6,
      created_at: "2026-08-05T12:00:06.000Z",
    };
    const pages = [[rows.at(-1)], rows.slice(0, 2), [rows[3], rows[4]], []];
    const requestedUrls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        requestedUrls.push(new URL(input));
        void insertedAfterHighWater;
        return response(pages.shift() ?? []);
      }),
    );

    const result =
      await createDataPlaneRepositories(options).securityAudit.list();

    expect(result.map((event) => event.id)).toEqual([5, 4, 2, 1]);
    expect(result).not.toContainEqual(expect.objectContaining({ id: 6 }));
    expect(
      requestedUrls.slice(1).every((url) => url.searchParams.has("and")),
    ).toBe(true);
  });

  it("does not move a row between pages when its presentation sort changes", async () => {
    const rows = cases[0]!.rows;
    const moved = {
      ...(rows[2] as Record<string, unknown>),
      next_renewal_date: "2026-01-01",
    };
    const pages = [
      [rows.at(-1)],
      rows.slice(0, 2),
      [moved, rows[3]],
      rows.slice(4),
      [],
    ];
    const requestedUrls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        requestedUrls.push(new URL(input));
        return response(pages.shift() ?? []);
      }),
    );

    const result =
      await createDataPlaneRepositories(options).subscriptions.list();

    expect(result.map(({ subscription: item }) => item.id)).toEqual([
      "sub_page_03",
      "sub_page_01",
      "sub_page_02",
      "sub_page_04",
      "sub_page_05",
    ]);
    expect(
      requestedUrls.every(
        (url) => !url.searchParams.get("order")?.includes("next_renewal_date"),
      ),
    ).toBe(true);
  });

  it("rejects a repeated page generically instead of looping", async () => {
    const rows = cases[0]!.rows.slice(0, 3);
    const repeated = rows.slice(0, 2);
    const pages = [[rows.at(-1)], repeated, repeated];
    const fetcher = vi.fn(async () => response(pages.shift() ?? repeated));
    vi.stubGlobal("fetch", fetcher);

    await expect(
      createDataPlaneRepositories(options).subscriptions.list(),
    ).rejects.toMatchObject({ reason: "invalid" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("uses explicit projections for every mutation representation", async () => {
    const source = await readFile(new URL("index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/select:\s*["'`]\*["'`]/);
  });
});

describe("renewal repository transition surface", () => {
  it("rejects the legacy generic valid-version save before I/O", async () => {
    const accessToken = vi.fn(() => Promise.resolve(leased("unused-token")));
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const repository = createDataPlaneRepositories({ ...options, accessToken })
      .renewals as unknown as {
      save(event: RenewalEvent, expectedVersion: number): Promise<unknown>;
    };

    await expect(repository.save(renewal, 1)).rejects.toMatchObject({
      reason: "invalid",
    });
    expect(accessToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("exposes fixed confirm/skip/correct mutations with optimistic versions", async () => {
    const repository = createDataPlaneRepositories(options)
      .renewals as unknown as {
      confirm: unknown;
      correct: unknown;
      skip: unknown;
    };
    expect(typeof repository.confirm).toBe("function");
    expect(typeof repository.skip).toBe("function");
    expect(typeof repository.correct).toBe("function");
  });

  it("confirms with a fixed PATCH surface and preserves version conflicts", async () => {
    const requested: Array<{ url: URL; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        if (typeof init?.body !== "string") throw new Error("missing body");
        const body = JSON.parse(init.body) as unknown;
        requested.push({ url: new URL(input), body });
        return response([]);
      }),
    );
    const repository = createDataPlaneRepositories(options)
      .renewals as unknown as {
      confirm(
        event: RenewalEvent,
        confirmedOn: string,
        expectedVersion: number,
      ): Promise<unknown>;
    };
    if (typeof repository.confirm !== "function") {
      expect(repository.confirm).toBeTypeOf("function");
      return;
    }

    await expect(
      repository.confirm(renewal, "2026-02-02", 2),
    ).rejects.toMatchObject({ reason: "conflict" });
    expect(requested).toHaveLength(1);
    expect(requested[0]?.url.searchParams.get("version")).toBe("eq.2");
    expect(requested[0]?.url.searchParams.get("select")).not.toBe("*");
    expect(requested[0]?.body).toEqual({
      state: "confirmed",
      confirmed_on: "2026-02-02",
    });
  });

  it("creates only the expected-event representation", async () => {
    const requested: Array<{ url: URL; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        if (typeof init?.body !== "string") throw new Error("missing body");
        requested.push({
          url: new URL(input),
          body: JSON.parse(init.body) as unknown,
        });
        return response([
          {
            owner_user_id: "user_fixture_a",
            idempotency_key: renewal.idempotencyKey,
            subscription_id: renewal.subscriptionId,
            occurrence_date: renewal.occurrenceDate,
            amount_minor: renewal.amount.minorUnits,
            currency_code: renewal.amount.currency,
            state: "expected",
            confirmed_on: null,
            corrected_on: null,
            skipped_on: null,
            original_occurrence_date: null,
            original_amount_minor: null,
            original_currency_code: null,
            version: 1,
            created_at: timestamp,
            updated_at: timestamp,
          },
        ]);
      }),
    );

    await createDataPlaneRepositories(options).renewals.save(renewal);

    expect(requested).toHaveLength(1);
    expect(requested[0]?.body).toEqual({
      idempotency_key: renewal.idempotencyKey,
      subscription_id: renewal.subscriptionId,
      occurrence_date: renewal.occurrenceDate,
      amount_minor: renewal.amount.minorUnits,
      currency_code: renewal.amount.currency,
    });
    expect(requested[0]?.url.searchParams.get("select")).not.toBe("*");
  });
});

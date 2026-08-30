import {
  createLifecycleState,
  createRecurrenceRule,
  createRecurringSubscription,
} from "@subtrack/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  containsProhibitedSubscriptionSecret,
  createDataPlaneRepositories,
  DataPlaneError,
} from ".";

const leased = (token: string) => ({ token, isCurrent: () => true });
const options = {
  accessToken: () => Promise.resolve(leased("standard-clerk-session-token")),
  publishableKey: "sb_publishable_fixture",
  supabaseUrl: "https://project.supabase.co",
};
const subscription = createRecurringSubscription({
  kind: "recurring",
  id: "sub_management",
  serviceName: "Management fixture",
  amount: { minorUnits: 1299, currency: "USD" },
  timezone: "UTC",
  startDate: "2026-08-31",
  nextRenewalDate: "2026-08-31",
  recurrence: createRecurrenceRule("monthly"),
  lifecycle: createLifecycleState({ status: "active", since: "2026-08-06" }),
});
const metadata = {
  planName: null,
  accountEmail: null,
  paymentLabel: null,
  managementUrl: null,
  category: "Streaming",
  notes: null,
} as const;
const metadataWithoutCategory = {
  planName: null,
  accountEmail: null,
  paymentLabel: null,
  managementUrl: null,
  notes: null,
} as const;
const timestamp = "2026-08-06T12:00:00.000Z";
const fullyEncodedCvvUrl =
  "https://example.test/manage?secret=%43%56%56%20%23%31%32%33";
const fullwidthVisaPan = "４１１１１１１１１１１１１１１１";
const fullyEncodedUserinfoUrl =
  "https://%75%73%65%72%3A%70%61%73%73%40billing.example.test/manage";
const fullwidthUserinfoUrl = "https://user：pass＠billing.example.test/manage";

function parseBody(body: BodyInit | null | undefined) {
  if (typeof body !== "string") throw new Error("expected_body");
  return JSON.parse(body) as Record<string, unknown>;
}

function responseRow(
  written: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    ...written,
    owner_user_id: "user_fixture_a",
    version: 1,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function completeSubscriptionRow(overrides: Record<string, unknown> = {}) {
  return responseRow({
    id: subscription.id,
    kind: "recurring",
    service_name: subscription.serviceName,
    plan_name: null,
    amount_minor: 1299,
    currency_code: "USD",
    timezone: "UTC",
    lifecycle_status: "active",
    lifecycle_since: "2026-08-06",
    trial_ends_on: null,
    lifecycle_access_ends_on: null,
    start_date: "2026-08-31",
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
    ...overrides,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("subscription-management repository boundary", () => {
  it.each([fullyEncodedCvvUrl, fullwidthVisaPan])(
    "exports a sensitive-text policy that rejects %s",
    (value) => {
      expect(containsProhibitedSubscriptionSecret(value)).toBe(true);
    },
  );

  it.each([
    "IMEI 490154203237518",
    "Invoice 1234567890123452",
    "Visa •••• 4242",
  ])("exports a sensitive-text policy that preserves %s", (value) => {
    expect(containsProhibitedSubscriptionSecret(value)).toBe(false);
  });

  it("persists and returns the optional category without accepting ownership", async () => {
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
      const written = parseBody(init?.body);
      return new Response(JSON.stringify([responseRow(written)]), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const persisted = await createDataPlaneRepositories(
      options,
    ).subscriptions.create({
      subscription,
      metadata,
    });

    expect(parseBody(fetcher.mock.calls[0]?.[1]?.body)).toMatchObject({
      category: "Streaming",
    });
    expect(parseBody(fetcher.mock.calls[0]?.[1]?.body)).not.toHaveProperty(
      "owner_user_id",
    );
    expect(persisted.metadata.category).toBe("Streaming");
  });

  it.each([
    ["notes", "CVV: 123"],
    ["notes", "security code = 1234"],
    ["notes", "password: correct-horse-battery-staple"],
    ["notes", "recovery code: ABCD-EFGH-IJKL"],
    ["paymentLabel", "Visa CVV 123"],
  ] as const)(
    "rejects obvious sensitive %s content before network dispatch",
    async (field, value) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const write = {
        subscription,
        metadata: { ...metadataWithoutCategory, [field]: value },
      };

      const error = await createDataPlaneRepositories(options)
        .subscriptions.create(write)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DataPlaneError);
      expect(error).toMatchObject({ reason: "invalid" });
      expect(String(error)).toBe("Error: data_plane_request_failed");
      expect(String(error)).not.toContain(value);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://user:pass@billing.example.test/manage",
    fullyEncodedUserinfoUrl,
    fullwidthUserinfoUrl,
  ])(
    "rejects URI-userinfo management URL %s before network dispatch",
    async (managementUrl) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);

      const error = await createDataPlaneRepositories(options)
        .subscriptions.create({
          subscription,
          metadata: { ...metadata, managementUrl },
        })
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ reason: "invalid" });
      expect(String(error)).not.toContain(managementUrl);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["accountEmail", "4111111111111111@example.test"],
    ["managementUrl", "https://example.test/manage/4111-1111-1111-1111"],
    ["managementUrl", "https://example.test/manage?CVV=%23123"],
    ["managementUrl", fullyEncodedCvvUrl],
    ["notes", "CVV #123"],
    ["notes", "4111\u20111111\u20111111\u20111111"],
    ["notes", fullwidthVisaPan],
    ["paymentLabel", "6759000000000000"],
    ["category", "2200000000000004"],
  ] as const)(
    "rejects sensitive bypass in persisted %s",
    async (field, value) => {
      const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
        const written = parseBody(init?.body);
        return new Response(JSON.stringify([responseRow(written)]), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", fetcher);

      const error = await createDataPlaneRepositories(options)
        .subscriptions.create({
          subscription,
          metadata: { ...metadata, [field]: value },
        })
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ reason: "invalid" });
      expect(String(error)).not.toContain(value);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("applies the same sensitive policy to service names", async () => {
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
      const written = parseBody(init?.body);
      return new Response(JSON.stringify([responseRow(written)]), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(
      createDataPlaneRepositories(options).subscriptions.create({
        subscription: {
          ...subscription,
          serviceName: "Card 5060990000000008",
        },
        metadata,
      }),
    ).rejects.toMatchObject({ reason: "invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["notes", "Invoice 12345"],
    ["notes", "Invoice 1234567890123452"],
    ["notes", "Password manager family plan"],
    ["accountEmail", "490154203237518@example.test"],
    ["managementUrl", "https://example.test/invoice/1234567890123452"],
    ["paymentLabel", "Visa •••• 4242"],
  ] as const)("allows ordinary safe %s content", async (field, value) => {
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
      const written = parseBody(init?.body);
      return new Response(JSON.stringify([responseRow(written)]), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(
      createDataPlaneRepositories(options).subscriptions.create({
        subscription,
        metadata: { ...metadataWithoutCategory, [field]: value },
      }),
    ).resolves.toBeDefined();
  });

  it("redacts prohibited sensitive content returned by the server", async () => {
    const sensitive = "password: leaked-server-value";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify([completeSubscriptionRow({ notes: sensitive })]),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );

    const error = await createDataPlaneRepositories(options)
      .subscriptions.create({ subscription, metadata: metadataWithoutCategory })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DataPlaneError);
    expect(error).toMatchObject({ reason: "invalid" });
    expect(String(error)).not.toContain(sensitive);
  });

  it.each([
    ["service_name", "MIR 2200000000000004"],
    ["account_email", "4111111111111111@example.test"],
    ["management_url", "https://example.test/manage?CVV=%23123"],
    ["management_url", fullyEncodedCvvUrl],
    ["management_url", fullyEncodedUserinfoUrl],
    ["management_url", fullwidthUserinfoUrl],
    ["notes", fullwidthVisaPan],
  ] as const)(
    "rejects sensitive persisted %s without reflecting its value",
    async (field, value) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Promise.resolve(
            new Response(
              JSON.stringify([completeSubscriptionRow({ [field]: value })]),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            ),
          ),
        ),
      );

      const error = await createDataPlaneRepositories(options)
        .subscriptions.create({ subscription, metadata })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ reason: "invalid" });
      expect(String(error)).not.toContain(value);
    },
  );
});

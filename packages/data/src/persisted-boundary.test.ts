import {
  createLifecycleState,
  createRecurrenceRule,
  createRecurringSubscription,
  createExpectedRenewal,
} from "@subtrack/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataPlaneRepositories, DataPlaneError } from ".";

const leased = (token: string) => ({ token, isCurrent: () => true });

const options = {
  accessToken: () => Promise.resolve(leased("standard-clerk-session-token")),
  publishableKey: "sb_publishable_fixture",
  supabaseUrl: "https://project.supabase.co",
};
const timestamp = "2026-08-05T12:00:00.000Z";
const subscription = createRecurringSubscription({
  kind: "recurring",
  id: "sub_boundary",
  serviceName: "Boundary",
  amount: { minorUnits: 100, currency: "USD" },
  timezone: "UTC",
  startDate: "2026-01-01",
  nextRenewalDate: "2026-02-01",
  recurrence: createRecurrenceRule("monthly"),
  lifecycle: createLifecycleState({ status: "active", since: "2026-01-01" }),
});
const subscriptionWrite = {
  subscription,
  metadata: {
    planName: null,
    accountEmail: null,
    paymentLabel: null,
    managementUrl: null,
    notes: null,
  },
} as const;
const subscriptionRow = {
  owner_user_id: "user_fixture_a",
  id: "sub_boundary",
  kind: "recurring",
  service_name: "Boundary",
  plan_name: null,
  amount_minor: 100,
  currency_code: "USD",
  timezone: "Mars/shape-valid-subscription-leak",
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
  notes: null,
  version: 1,
  created_at: timestamp,
  updated_at: timestamp,
} as const;
const preferencesInput = {
  timezone: "UTC",
  homeCurrency: "USD",
  reminderLeadDays: [7, 1],
  emailRemindersEnabled: false,
  locale: "en",
};
const preferencesRow = {
  owner_user_id: "user_fixture_a",
  timezone: "Mars/shape-valid-preference-leak",
  home_currency: "USD",
  reminder_lead_days: [7, 1],
  email_reminders_enabled: false,
  locale: "en",
  version: 1,
  created_at: timestamp,
  updated_at: timestamp,
} as const;
const overrideInput = {
  subscriptionId: "sub_boundary",
  leadDays: [7],
  channels: ["email" as const],
};
const overrideRow = {
  owner_user_id: "user_fixture_a",
  subscription_id: "persisted/override-leak",
  lead_days: [7],
  channels: ["email"],
  version: 1,
  created_at: timestamp,
  updated_at: timestamp,
} as const;

afterEach(() => vi.unstubAllGlobals());

function respondWith(row: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify([row]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );
}

async function expectGenericInvalid(
  invoke: () => Promise<unknown>,
  adversarialValue: string,
) {
  const error = await invoke().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(DataPlaneError);
  expect(error).toMatchObject({ reason: "invalid" });
  expect(String(error)).toBe("Error: data_plane_request_failed");
  expect(String(error)).not.toContain(adversarialValue);
}

describe("persisted row boundary", () => {
  it.each([
    ["list", () => createDataPlaneRepositories(options).subscriptions.list()],
    [
      "create",
      () =>
        createDataPlaneRepositories(options).subscriptions.create(
          subscriptionWrite,
        ),
    ],
    [
      "update",
      () =>
        createDataPlaneRepositories(options).subscriptions.update(
          subscriptionWrite,
          1,
        ),
    ],
  ])(
    "redacts a semantically invalid subscription returned by %s",
    async (_name, invoke) => {
      respondWith(subscriptionRow);
      await expectGenericInvalid(invoke, subscriptionRow.timezone);
    },
  );

  it.each([
    ["get", () => createDataPlaneRepositories(options).preferences.get()],
    [
      "create",
      () =>
        createDataPlaneRepositories(options).preferences.create(
          preferencesInput,
        ),
    ],
    [
      "update",
      () =>
        createDataPlaneRepositories(options).preferences.update(
          preferencesInput,
          1,
        ),
    ],
  ])(
    "redacts a semantically invalid preference returned by %s",
    async (_name, invoke) => {
      respondWith(preferencesRow);
      await expectGenericInvalid(invoke, preferencesRow.timezone);
    },
  );

  const invalidCanonicalPreferenceRows = [
    {
      name: "empty reminder lead array",
      row: { ...preferencesRow, timezone: "UTC", reminder_lead_days: [] },
      marker: "[]",
    },
    {
      name: "eleven-element reminder lead array",
      row: {
        ...preferencesRow,
        timezone: "UTC",
        reminder_lead_days: Array.from({ length: 11 }, (_, index) => index),
      },
      marker: "10",
    },
    {
      name: "invalid locale syntax",
      row: {
        ...preferencesRow,
        timezone: "UTC",
        locale: "not a locale preference leak",
      },
      marker: "not a locale preference leak",
    },
  ];
  const preferenceResponsePaths = [
    {
      name: "get",
      invoke: () => createDataPlaneRepositories(options).preferences.get(),
    },
    {
      name: "create",
      invoke: () =>
        createDataPlaneRepositories(options).preferences.create(
          preferencesInput,
        ),
    },
    {
      name: "update",
      invoke: () =>
        createDataPlaneRepositories(options).preferences.update(
          preferencesInput,
          1,
        ),
    },
  ];

  it.each(
    invalidCanonicalPreferenceRows.flatMap((invalid) =>
      preferenceResponsePaths.map((path) => ({
        ...invalid,
        name: `${invalid.name} from ${path.name}`,
        invoke: path.invoke,
      })),
    ),
  )(
    "redacts $name returned by the canonical preference response path",
    async ({ row, marker, invoke }) => {
      respondWith(row);
      await expectGenericInvalid(invoke, marker);
    },
  );

  it.each([
    [
      "create",
      () =>
        createDataPlaneRepositories(options).reminders.createOverride(
          overrideInput,
        ),
    ],
    [
      "update",
      () =>
        createDataPlaneRepositories(options).reminders.updateOverride(
          overrideInput,
          1,
        ),
    ],
    [
      "list",
      () => createDataPlaneRepositories(options).reminders.listOverrides(),
    ],
  ])(
    "redacts a semantically invalid reminder override returned by %s",
    async (_name, invoke) => {
      respondWith(overrideRow);
      await expectGenericInvalid(invoke, overrideRow.subscription_id);
    },
  );

  it("redacts a semantically invalid renewal returned by save", async () => {
    const renewal = createExpectedRenewal(subscription, "2026-02-01");
    respondWith({
      owner_user_id: "user_fixture_a",
      idempotency_key: renewal.idempotencyKey,
      subscription_id: renewal.subscriptionId,
      occurrence_date: "2026-02-30-renewal-leak",
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
      created_at: timestamp,
      updated_at: timestamp,
    });

    await expectGenericInvalid(
      () => createDataPlaneRepositories(options).renewals.save(renewal),
      "2026-02-30-renewal-leak",
    );
  });

  it("rejects contradictory recurring/one-time response fields generically", async () => {
    const purchasedOn = "2026-01-02-subscription-discriminant-leak";
    respondWith({
      ...subscriptionRow,
      timezone: "UTC",
      purchased_on: purchasedOn,
    });

    await expectGenericInvalid(
      () => createDataPlaneRepositories(options).subscriptions.list(),
      purchasedOn,
    );
  });

  it("rejects credential-bearing management URLs from persisted rows", async () => {
    const managementUrl = "https://row-user:row-password@example.test/manage";
    respondWith({
      ...subscriptionRow,
      timezone: "UTC",
      management_url: managementUrl,
    });

    await expectGenericInvalid(
      () => createDataPlaneRepositories(options).subscriptions.list(),
      managementUrl,
    );
  });

  it("rejects contradictory renewal response fields generically", async () => {
    const confirmedOn = "2026-02-02-renewal-state-leak";
    respondWith({
      owner_user_id: "user_fixture_a",
      idempotency_key: "renewal:v1:sub_boundary:2026-02-01",
      subscription_id: "sub_boundary",
      occurrence_date: "2026-02-01",
      amount_minor: 100,
      currency_code: "USD",
      state: "expected",
      confirmed_on: confirmedOn,
      corrected_on: null,
      skipped_on: null,
      original_occurrence_date: null,
      original_amount_minor: null,
      original_currency_code: null,
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
    });

    await expectGenericInvalid(
      () => createDataPlaneRepositories(options).renewals.list(),
      confirmedOn,
    );
  });

  it("rejects a shape-valid delivery with an invalid calendar date generically", async () => {
    const occurrenceDate = "2026-02-30-delivery-leak";
    respondWith({
      owner_user_id: "user_fixture_a",
      idempotency_key: "delivery_boundary",
      subscription_id: "sub_boundary",
      occurrence_date: occurrenceDate,
      channel: "email",
      state: "pending",
      attempt_count: 0,
      scheduled_for: timestamp,
      delivered_at: null,
      error_code: null,
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
    });

    await expectGenericInvalid(
      () => createDataPlaneRepositories(options).reminders.listDeliveries(),
      occurrenceDate,
    );
  });

  it("rejects contradictory delivery response fields generically", async () => {
    const deliveredAt = "2026-08-05T12:01:00.000Z";
    respondWith({
      owner_user_id: "user_fixture_a",
      idempotency_key: "delivery_state_boundary",
      subscription_id: "sub_boundary",
      occurrence_date: "2026-02-01",
      channel: "email",
      state: "pending",
      attempt_count: 0,
      scheduled_for: timestamp,
      delivered_at: deliveredAt,
      error_code: null,
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
    });

    await expectGenericInvalid(
      () => createDataPlaneRepositories(options).reminders.listDeliveries(),
      deliveredAt,
    );
  });

  it("rejects a shape-valid FX row with an unsupported currency generically", async () => {
    const currency = "ZZZ";
    respondWith({
      base_currency: currency,
      quote_currency: "USD",
      rate: "1.250000000000",
      effective_at: timestamp,
      provider_code: "FIXTURE",
      created_at: timestamp,
    });

    await expectGenericInvalid(
      () => createDataPlaneRepositories(options).fxRates.list("USD"),
      currency,
    );
  });

  it("rejects JSON-number FX rates instead of accepting precision loss", async () => {
    respondWith({
      base_currency: "USD",
      quote_currency: "INR",
      rate: 83.25,
      effective_at: timestamp,
      provider_code: "FIXTURE",
      created_at: timestamp,
    });

    await expectGenericInvalid(
      () => createDataPlaneRepositories(options).fxRates.list("USD"),
      "83.25",
    );
  });

  it("rejects a shape-valid audit row with an invalid owner generically", async () => {
    const owner = " audit-owner-leak ";
    respondWith({
      owner_user_id: owner,
      id: 1,
      event_type: "export_requested",
      occurred_at: timestamp,
      request_id: "request_boundary",
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
    });

    await expectGenericInvalid(
      () => createDataPlaneRepositories(options).securityAudit.list(),
      owner,
    );
  });
});

import { describe, expect, it } from "vitest";
import { createLifecycleState } from "./lifecycle";
import { createRecurrenceRule } from "./recurrence";
import {
  createOneTimeSubscription,
  createRecurringSubscription,
  expireOneTimeIfDue,
} from "./subscription";

describe("validated subscription types", () => {
  it("creates a recurring subscription with exact money and recurrence", () => {
    expect(
      createRecurringSubscription({
        kind: "recurring",
        id: "sub_streaming_1",
        serviceName: "Example Streaming",
        amount: { minorUnits: 1299, currency: "USD" },
        timezone: "America/New_York",
        startDate: "2026-01-31",
        nextRenewalDate: "2026-02-28",
        recurrence: createRecurrenceRule("monthly"),
        lifecycle: createLifecycleState({
          status: "active",
          since: "2026-01-31",
        }),
      }),
    ).toMatchObject({
      kind: "recurring",
      amount: { minorUnits: 1299, currency: "USD", exponent: 2 },
      recurrence: { unit: "month", interval: 1 },
    });
  });

  it("creates a subscription-like one-time item without recurrence", () => {
    expect(
      createOneTimeSubscription({
        kind: "one_time",
        id: "sub_lifetime_1",
        serviceName: "Lifetime Tool",
        amount: { minorUnits: 4999, currency: "USD" },
        timezone: "Asia/Kolkata",
        purchasedOn: "2026-01-10",
        accessEndsOn: null,
        lifecycle: createLifecycleState({
          status: "active",
          since: "2026-01-10",
        }),
      }),
    ).toEqual({
      kind: "one_time",
      id: "sub_lifetime_1",
      serviceName: "Lifetime Tool",
      amount: { minorUnits: 4999, currency: "USD", exponent: 2 },
      timezone: "Asia/Kolkata",
      purchasedOn: "2026-01-10",
      accessEndsOn: null,
      lifecycle: { status: "active", since: "2026-01-10" },
    });
  });

  it.each([
    { field: "id", value: "has spaces" },
    { field: "serviceName", value: "   " },
    { field: "amount", value: { minorUnits: -1, currency: "USD" } },
    { field: "timezone", value: "Invalid/Zone" },
  ])("rejects invalid recurring $field", ({ field, value }) => {
    const input = {
      kind: "recurring" as const,
      id: "sub_1",
      serviceName: "Service",
      amount: { minorUnits: 100, currency: "USD" },
      timezone: "UTC",
      startDate: "2026-01-01",
      nextRenewalDate: "2026-02-01",
      recurrence: createRecurrenceRule("monthly"),
      lifecycle: createLifecycleState({
        status: "active",
        since: "2026-01-01",
      }),
      [field]: value,
    };
    expect(() => createRecurringSubscription(input)).toThrow();
  });

  it("rejects recurrence data on a one-time item", () => {
    expect(() =>
      createOneTimeSubscription({
        kind: "one_time",
        id: "sub_1",
        serviceName: "Service",
        amount: { minorUnits: 100, currency: "USD" },
        timezone: "UTC",
        purchasedOn: "2026-01-01",
        accessEndsOn: null,
        lifecycle: createLifecycleState({
          status: "active",
          since: "2026-01-01",
        }),
        recurrence: createRecurrenceRule("annual"),
      } as never),
    ).toThrow("One-time subscriptions cannot have recurrence");
  });

  it("rejects incorrect runtime kind discriminants", () => {
    const base = {
      id: "sub_1",
      serviceName: "Service",
      amount: { minorUnits: 100, currency: "USD" },
      timezone: "UTC",
      lifecycle: createLifecycleState({
        status: "active",
        since: "2026-01-01",
      }),
    };
    expect(() =>
      createRecurringSubscription({
        ...base,
        kind: "one_time",
        startDate: "2026-01-01",
        nextRenewalDate: "2026-02-01",
        recurrence: createRecurrenceRule("monthly"),
      } as never),
    ).toThrow("Expected recurring subscription");
    expect(() =>
      createOneTimeSubscription({
        ...base,
        kind: "recurring",
        purchasedOn: "2026-01-01",
        accessEndsOn: null,
      } as never),
    ).toThrow("Expected one-time subscription");
  });

  it("rejects a next renewal that is not on the anchored recurrence", () => {
    expect(() =>
      createRecurringSubscription({
        kind: "recurring",
        id: "sub_1",
        serviceName: "Service",
        amount: { minorUnits: 100, currency: "USD" },
        timezone: "UTC",
        startDate: "2024-01-31",
        nextRenewalDate: "2024-02-15",
        recurrence: createRecurrenceRule("monthly"),
        lifecycle: createLifecycleState({
          status: "active",
          since: "2024-01-31",
        }),
      }),
    ).toThrow("nextRenewalDate must be an occurrence of the recurrence");
  });

  it.each([
    {
      label: "weekly",
      startDate: "2026-01-05",
      nextRenewalDate: "2026-01-19",
      recurrence: createRecurrenceRule("weekly"),
    },
    {
      label: "monthly",
      startDate: "2026-01-15",
      nextRenewalDate: "2026-03-15",
      recurrence: createRecurrenceRule("monthly"),
    },
    {
      label: "quarterly",
      startDate: "2026-01-15",
      nextRenewalDate: "2026-10-15",
      recurrence: createRecurrenceRule("quarterly"),
    },
    {
      label: "semiannual",
      startDate: "2026-01-15",
      nextRenewalDate: "2027-01-15",
      recurrence: createRecurrenceRule("semiannual"),
    },
    {
      label: "annual",
      startDate: "2024-02-28",
      nextRenewalDate: "2026-02-28",
      recurrence: createRecurrenceRule("annual"),
    },
    {
      label: "custom 18-month",
      startDate: "2024-02-29",
      nextRenewalDate: "2025-08-29",
      recurrence: createRecurrenceRule({ unit: "month", interval: 18 }),
    },
    {
      label: "month-end",
      startDate: "2024-01-31",
      nextRenewalDate: "2024-03-31",
      recurrence: createRecurrenceRule("monthly"),
    },
    {
      label: "leap anchor",
      startDate: "2024-02-29",
      nextRenewalDate: "2028-02-29",
      recurrence: createRecurrenceRule("annual"),
    },
  ])(
    "accepts an aligned $label renewal",
    ({ startDate, nextRenewalDate, recurrence }) => {
      expect(
        createRecurringSubscription({
          kind: "recurring",
          id: "sub_aligned",
          serviceName: "Aligned service",
          amount: { minorUnits: 100, currency: "USD" },
          timezone: "UTC",
          startDate,
          nextRenewalDate,
          recurrence,
          lifecycle: createLifecycleState({
            status: "active",
            since: startDate,
          }),
        }).nextRenewalDate,
      ).toBe(nextRenewalDate);
    },
  );
});

describe("one-time access expiry", () => {
  it("expires finite one-time access when its calendar end date arrives", () => {
    const item = createOneTimeSubscription({
      kind: "one_time",
      id: "sub_pass_1",
      serviceName: "Annual Pass",
      amount: { minorUnits: 10000, currency: "INR" },
      timezone: "Asia/Kolkata",
      purchasedOn: "2026-01-01",
      accessEndsOn: "2026-12-31",
      lifecycle: createLifecycleState({
        status: "active",
        since: "2026-01-01",
      }),
    });

    expect(expireOneTimeIfDue(item, "2026-12-30").lifecycle.status).toBe(
      "active",
    );
    expect(expireOneTimeIfDue(item, "2026-12-31").lifecycle).toEqual({
      status: "expired",
      since: "2026-12-31",
    });
  });

  it("never auto-expires lifetime access", () => {
    const item = createOneTimeSubscription({
      kind: "one_time",
      id: "sub_lifetime_1",
      serviceName: "Lifetime",
      amount: { minorUnits: 100, currency: "USD" },
      timezone: "UTC",
      purchasedOn: "2026-01-01",
      accessEndsOn: null,
      lifecycle: createLifecycleState({
        status: "active",
        since: "2026-01-01",
      }),
    });
    expect(expireOneTimeIfDue(item, "2099-12-31")).toEqual(item);
  });

  it("records the access-end date when expiry processing runs late", () => {
    const item = createOneTimeSubscription({
      kind: "one_time",
      id: "sub_pass_2",
      serviceName: "Finite Pass",
      amount: { minorUnits: 100, currency: "USD" },
      timezone: "UTC",
      purchasedOn: "2026-01-01",
      accessEndsOn: "2026-12-31",
      lifecycle: createLifecycleState({
        status: "active",
        since: "2026-01-01",
      }),
    });
    expect(expireOneTimeIfDue(item, "2027-01-03").lifecycle).toEqual({
      status: "expired",
      since: "2026-12-31",
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  createLifecycleState,
  createOneTimeSubscription,
  createRecurringSubscription,
} from ".";

const lifecycle = createLifecycleState({
  status: "active",
  since: "2026-01-01",
});

describe("domain primitive boundary", () => {
  it("rejects undefined timezone instead of using the host default", () => {
    expect(() =>
      createRecurringSubscription({
        kind: "recurring",
        id: "sub_bad_timezone",
        serviceName: "Bad timezone",
        amount: { minorUnits: 100, currency: "USD" },
        timezone: undefined,
        startDate: "2026-01-01",
        nextRenewalDate: "2026-02-01",
        recurrence: { unit: "month", interval: 1 },
        lifecycle,
      } as never),
    ).toThrow();
  });

  it("rejects inherited recurrence keys", () => {
    const recurrence = Object.create({ unit: "month", interval: 1 }) as object;
    expect(() =>
      createRecurringSubscription({
        kind: "recurring",
        id: "sub_inherited",
        serviceName: "Inherited",
        amount: { minorUnits: 100, currency: "USD" },
        timezone: "UTC",
        startDate: "2026-01-01",
        nextRenewalDate: "2026-02-01",
        recurrence,
        lifecycle,
      } as never),
    ).toThrow();
  });

  it("rejects coercive primitives and malformed one-time discriminants", () => {
    expect(() =>
      createOneTimeSubscription({
        kind: "one_time",
        id: { toString: () => "sub_coerced" },
        serviceName: "Coercive",
        amount: { minorUnits: 100, currency: "USD" },
        timezone: "UTC",
        purchasedOn: "2026-01-01",
        accessEndsOn: undefined,
        lifecycle,
      } as never),
    ).toThrow();
  });
});

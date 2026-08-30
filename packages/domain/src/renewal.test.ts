import { describe, expect, it, vi } from "vitest";
import { createLifecycleState, transitionLifecycle } from "./lifecycle";
import { createRecurrenceRule } from "./recurrence";
import {
  advanceDueRenewals,
  confirmRenewal,
  correctRenewal,
  createExpectedRenewal,
  createRenewalEvent,
  renewalIdempotencyInput,
  renewalIdempotencyKey,
  skipRenewal,
} from "./renewal";
import {
  createRecurringSubscription,
  resumeRecurringSubscription,
} from "./subscription";

function monthly(status: "active" | "paused" | "canceled" = "active") {
  const lifecycle =
    status === "canceled"
      ? createLifecycleState({
          status: "canceled",
          since: "2024-02-15",
          accessEndsOn: "2024-02-29",
        })
      : createLifecycleState({ status, since: "2024-01-01" });
  return createRecurringSubscription({
    kind: "recurring",
    id: "sub_month_end",
    serviceName: "Month End Service",
    amount: { minorUnits: 1299, currency: "USD" },
    timezone: "America/New_York",
    startDate: "2024-01-31",
    nextRenewalDate: "2024-01-31",
    recurrence: createRecurrenceRule("monthly"),
    lifecycle,
  });
}

describe("renewal idempotency", () => {
  it("builds stable versioned inputs and keys from identity plus calendar occurrence", () => {
    expect(renewalIdempotencyInput("sub_month_end", "2024-02-29")).toEqual({
      version: 1,
      subscriptionId: "sub_month_end",
      occurrenceDate: "2024-02-29",
    });
    expect(renewalIdempotencyKey("sub_month_end", "2024-02-29")).toBe(
      "renewal:v1:sub_month_end:2024-02-29",
    );
    expect(renewalIdempotencyKey("sub_month_end", "2024-02-29")).toBe(
      renewalIdempotencyKey("sub_month_end", "2024-02-29"),
    );
  });

  it("rejects a coercive subscription identifier without invoking it", () => {
    const toString = vi.fn(() => "sub_month_end");

    expect(() =>
      renewalIdempotencyKey({ toString } as unknown as string, "2024-02-29"),
    ).toThrow("Invalid subscription id");
    expect(toString).not.toHaveBeenCalled();
  });
});

describe("advancing due renewals", () => {
  it("creates expected events and advances without mandatory confirmation", () => {
    const result = advanceDueRenewals(monthly(), "2024-04-30", 12);
    expect(
      result.events.map((event) => [event.occurrenceDate, event.state]),
    ).toEqual([
      ["2024-01-31", "expected"],
      ["2024-02-29", "expected"],
      ["2024-03-31", "expected"],
      ["2024-04-30", "expected"],
    ]);
    expect(result.subscription.nextRenewalDate).toBe("2024-05-31");
    expect(result.hasMoreDue).toBe(false);
  });

  it("snapshots exact money on each event", () => {
    const [event] = advanceDueRenewals(monthly(), "2024-01-31", 1).events;
    expect(event?.amount).toEqual({
      minorUnits: 1299,
      currency: "USD",
      exponent: 2,
    });
  });

  it("processes deterministic bounded batches and reports remaining work", () => {
    const result = advanceDueRenewals(monthly(), "2024-04-30", 2);
    expect(result.events.map((event) => event.occurrenceDate)).toEqual([
      "2024-01-31",
      "2024-02-29",
    ]);
    expect(result.subscription.nextRenewalDate).toBe("2024-03-31");
    expect(result.hasMoreDue).toBe(true);
  });

  it.each([0, 513])("rejects renewal batch bound %s", (maxEvents) => {
    expect(() =>
      advanceDueRenewals(monthly(), "2024-04-30", maxEvents),
    ).toThrow("maxEvents must be an integer between 1 and 512");
  });

  it.each(["paused", "canceled"] as const)(
    "does not forecast while %s",
    (status) => {
      const subscription = monthly(status);
      const result = advanceDueRenewals(subscription, "2024-04-30", 12);
      expect(result).toEqual({ subscription, events: [], hasMoreDue: false });
    },
  );

  it("resumes after one paused occurrence at the next anchored date", () => {
    const paused = monthly("paused");
    const resumed = resumeRecurringSubscription(paused, "2024-02-15");
    expect(resumed.startDate).toBe("2024-01-31");
    expect(resumed.nextRenewalDate).toBe("2024-02-29");
    expect(resumed.lifecycle).toEqual({
      status: "active",
      since: "2024-02-15",
    });
  });

  it("skips several paused occurrences without resetting the recurrence anchor", () => {
    const resumed = resumeRecurringSubscription(
      monthly("paused"),
      "2024-05-15",
    );
    expect(resumed.startDate).toBe("2024-01-31");
    expect(resumed.nextRenewalDate).toBe("2024-05-31");
  });

  it("retains an anchored occurrence when resume is exactly on its billing date", () => {
    expect(
      resumeRecurringSubscription(monthly("paused"), "2024-03-31")
        .nextRenewalDate,
    ).toBe("2024-03-31");
  });

  it("emits no paused-period event after a safe resume", () => {
    const resumed = resumeRecurringSubscription(
      monthly("paused"),
      "2024-05-15",
    );
    expect(
      advanceDueRenewals(resumed, "2024-05-31", 12).events.map(
        (event) => event.occurrenceDate,
      ),
    ).toEqual(["2024-05-31"]);
  });

  it("defensively skips paused history after a lifecycle-only resume", () => {
    const paused = monthly("paused");
    const unsafelyResumed = {
      ...paused,
      lifecycle: transitionLifecycle(paused.lifecycle, {
        type: "resume",
        on: "2024-02-15",
      }),
    };
    expect(
      advanceDueRenewals(unsafelyResumed, "2024-02-29", 12).events.map(
        (event) => event.occurrenceDate,
      ),
    ).toEqual(["2024-02-29"]);
  });
});

describe("renewal event history", () => {
  it("rejects an accessor-backed renewal state without invoking it", () => {
    const state = vi
      .fn()
      .mockReturnValueOnce("expected")
      .mockReturnValue("corrected");
    const input = {
      idempotencyKey: "renewal:v1:sub_month_end:2024-01-31",
      subscriptionId: "sub_month_end",
      occurrenceDate: "2024-01-31",
      amount: { minorUnits: 1299, currency: "USD", exponent: 2 },
    };
    Object.defineProperty(input, "state", { enumerable: true, get: state });

    expect(() => createRenewalEvent(input as never)).toThrow(
      "Invalid renewal event",
    );
    expect(state).not.toHaveBeenCalled();
  });

  it("rejects an accessor-backed subscription ID without invoking it", () => {
    const subscriptionId = vi
      .fn()
      .mockReturnValueOnce("sub_month_end")
      .mockReturnValue("sub_other");
    const input = {
      state: "expected",
      idempotencyKey: "renewal:v1:sub_month_end:2024-01-31",
      occurrenceDate: "2024-01-31",
      amount: { minorUnits: 1299, currency: "USD", exponent: 2 },
    };
    Object.defineProperty(input, "subscriptionId", {
      enumerable: true,
      get: subscriptionId,
    });

    expect(() => createRenewalEvent(input as never)).toThrow(
      "Invalid renewal event",
    );
    expect(subscriptionId).not.toHaveBeenCalled();
  });

  it("rejects an alternating occurrence accessor without invoking it", () => {
    const occurrenceDate = vi
      .fn()
      .mockReturnValueOnce("2024-01-31")
      .mockReturnValue("2024-02-01");
    const input = {
      state: "expected",
      idempotencyKey: "renewal:v1:sub_month_end:2024-01-31",
      subscriptionId: "sub_month_end",
      amount: { minorUnits: 1299, currency: "USD", exponent: 2 },
    };
    Object.defineProperty(input, "occurrenceDate", {
      enumerable: true,
      get: occurrenceDate,
    });

    expect(() => createRenewalEvent(input as never)).toThrow(
      "Invalid renewal event",
    );
    expect(occurrenceDate).not.toHaveBeenCalled();
  });

  it("rejects accessor-backed renewal money without invoking it", () => {
    const minorUnits = vi.fn().mockReturnValueOnce(1299).mockReturnValue(1);
    const amount = { currency: "USD", exponent: 2 };
    Object.defineProperty(amount, "minorUnits", {
      enumerable: true,
      get: minorUnits,
    });

    expect(() =>
      createRenewalEvent({
        state: "expected",
        idempotencyKey: "renewal:v1:sub_month_end:2024-01-31",
        subscriptionId: "sub_month_end",
        occurrenceDate: "2024-01-31",
        amount,
      } as never),
    ).toThrow("Invalid renewal event");
    expect(minorUnits).not.toHaveBeenCalled();
  });

  it("rejects an accessor-backed original occurrence without invoking it", () => {
    const occurrenceDate = vi
      .fn()
      .mockReturnValueOnce("2024-01-31")
      .mockReturnValue("2024-02-01");
    const original = {
      amount: { minorUnits: 1299, currency: "USD", exponent: 2 },
    };
    Object.defineProperty(original, "occurrenceDate", {
      enumerable: true,
      get: occurrenceDate,
    });

    expect(() =>
      createRenewalEvent({
        state: "corrected",
        idempotencyKey: "renewal:v1:sub_month_end:2024-01-31",
        subscriptionId: "sub_month_end",
        occurrenceDate: "2024-02-01",
        amount: { minorUnits: 1399, currency: "USD", exponent: 2 },
        correctedOn: "2024-02-01",
        original,
      } as never),
    ).toThrow("Invalid renewal event");
    expect(occurrenceDate).not.toHaveBeenCalled();
  });

  it("creates an expected renewal from canonical non-negative money", () => {
    expect(() =>
      createExpectedRenewal(
        {
          id: "sub_month_end",
          amount: { minorUnits: -1, currency: "USD", exponent: 2 },
        },
        "2024-01-31",
      ),
    ).toThrow("Renewal amount cannot be negative");
  });

  it("rejects accessor-backed expected-renewal source data", () => {
    const id = vi
      .fn()
      .mockReturnValueOnce("sub_month_end")
      .mockReturnValue("sub_other");
    const subscription = {
      amount: { minorUnits: 1299, currency: "USD", exponent: 2 },
    };
    Object.defineProperty(subscription, "id", { enumerable: true, get: id });

    expect(() =>
      createExpectedRenewal(subscription as never, "2024-01-31"),
    ).toThrow("Invalid renewal event");
    expect(id).not.toHaveBeenCalled();
  });

  it("returns a recursively immutable revalidated renewal snapshot", () => {
    const event = createRenewalEvent({
      state: "corrected",
      idempotencyKey: "renewal:v1:sub_month_end:2024-01-31",
      subscriptionId: "sub_month_end",
      occurrenceDate: "2024-02-01",
      amount: { minorUnits: 1399, currency: "USD", exponent: 2 },
      correctedOn: "2024-02-01",
      original: {
        occurrenceDate: "2024-01-31",
        amount: { minorUnits: 1299, currency: "USD", exponent: 2 },
      },
    });

    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.amount)).toBe(true);
    expect(event.state).toBe("corrected");
    if (event.state === "corrected") {
      expect(Object.isFrozen(event.original)).toBe(true);
      expect(Object.isFrozen(event.original.amount)).toBe(true);
    }
  });

  it("rejects an expected event whose key does not match its identity", () => {
    expect(() =>
      createRenewalEvent({
        state: "expected",
        idempotencyKey: "forged",
        subscriptionId: "sub_month_end",
        occurrenceDate: "2024-01-31",
        amount: { minorUnits: 1299, currency: "USD", exponent: 2 },
      }),
    ).toThrow("Invalid renewal idempotency key");
  });

  it("rejects a forged confirmed event before its occurrence", () => {
    expect(() =>
      createRenewalEvent({
        state: "confirmed",
        idempotencyKey: "renewal:v1:sub_month_end:2024-01-31",
        subscriptionId: "sub_month_end",
        occurrenceDate: "2024-01-31",
        amount: { minorUnits: 1299, currency: "USD", exponent: 2 },
        confirmedOn: "2024-01-30",
      }),
    ).toThrow("confirmedOn cannot be before occurrenceDate");
  });

  it("rejects a forged skipped event before its occurrence", () => {
    expect(() =>
      createRenewalEvent({
        state: "skipped",
        idempotencyKey: "renewal:v1:sub_month_end:2024-01-31",
        subscriptionId: "sub_month_end",
        occurrenceDate: "2024-01-31",
        amount: { minorUnits: 1299, currency: "USD", exponent: 2 },
        skippedOn: "2024-01-30",
      }),
    ).toThrow("skippedOn cannot be before occurrenceDate");
  });

  it("keeps a corrected event keyed to its original occurrence", () => {
    expect(() =>
      createRenewalEvent({
        state: "corrected",
        idempotencyKey: "renewal:v1:sub_month_end:2024-02-01",
        subscriptionId: "sub_month_end",
        occurrenceDate: "2024-02-01",
        amount: { minorUnits: 1399, currency: "USD", exponent: 2 },
        correctedOn: "2024-02-01",
        original: {
          occurrenceDate: "2024-01-31",
          amount: { minorUnits: 1299, currency: "USD", exponent: 2 },
        },
      }),
    ).toThrow("Invalid renewal idempotency key");
  });

  it("confirms an expected event explicitly", () => {
    const expected = createExpectedRenewal(monthly(), "2024-01-31");
    expect(confirmRenewal(expected, "2024-02-01")).toMatchObject({
      state: "confirmed",
      confirmedOn: "2024-02-01",
    });
  });

  it("does not confirm a structurally forged expected event", () => {
    expect(() =>
      confirmRenewal(
        {
          state: "expected",
          idempotencyKey: "forged",
          subscriptionId: "sub_month_end",
          occurrenceDate: "2024-01-31",
          amount: { minorUnits: 1299, currency: "USD", exponent: 2 },
        },
        "2024-02-01",
      ),
    ).toThrow("Invalid renewal idempotency key");
  });

  it("corrects an event while retaining its original snapshot", () => {
    const expected = createExpectedRenewal(monthly(), "2024-01-31");
    expect(
      correctRenewal(expected, {
        correctedOn: "2024-02-01",
        occurrenceDate: "2024-02-01",
        amount: { minorUnits: 1399, currency: "USD" },
      }),
    ).toMatchObject({
      state: "corrected",
      occurrenceDate: "2024-02-01",
      amount: { minorUnits: 1399, currency: "USD", exponent: 2 },
      original: {
        occurrenceDate: "2024-01-31",
        amount: { minorUnits: 1299, currency: "USD", exponent: 2 },
      },
    });
  });

  it("does not correct a structurally forged source event", () => {
    expect(() =>
      correctRenewal(
        {
          state: "expected",
          idempotencyKey: "forged",
          subscriptionId: "sub_month_end",
          occurrenceDate: "2024-01-31",
          amount: { minorUnits: 1299, currency: "USD", exponent: 2 },
        },
        {
          correctedOn: "2024-02-01",
          occurrenceDate: "2024-02-01",
          amount: { minorUnits: 1399, currency: "USD" },
        },
      ),
    ).toThrow("Invalid renewal idempotency key");
  });

  it("rejects accessor-backed correction data without invoking it", () => {
    const correctedOn = vi
      .fn()
      .mockReturnValueOnce("2024-02-01")
      .mockReturnValue("2024-01-01");
    const correction = {
      occurrenceDate: "2024-02-01",
      amount: { minorUnits: 1399, currency: "USD" },
    };
    Object.defineProperty(correction, "correctedOn", {
      enumerable: true,
      get: correctedOn,
    });

    expect(() =>
      correctRenewal(
        createExpectedRenewal(monthly(), "2024-01-31"),
        correction as never,
      ),
    ).toThrow("Invalid renewal event");
    expect(correctedOn).not.toHaveBeenCalled();
  });

  it("marks an expected event skipped without deleting history", () => {
    const expected = createExpectedRenewal(monthly(), "2024-01-31");
    expect(skipRenewal(expected, "2024-01-31")).toMatchObject({
      state: "skipped",
      skippedOn: "2024-01-31",
      idempotencyKey: expected.idempotencyKey,
    });
  });

  it("does not skip a structurally forged expected event", () => {
    expect(() =>
      skipRenewal(
        {
          state: "expected",
          idempotencyKey: "forged",
          subscriptionId: "sub_month_end",
          occurrenceDate: "2024-01-31",
          amount: { minorUnits: 1299, currency: "USD", exponent: 2 },
        },
        "2024-02-01",
      ),
    ).toThrow("Invalid renewal idempotency key");
  });

  it("rejects contradictory terminal transitions", () => {
    const skipped = skipRenewal(
      createExpectedRenewal(monthly(), "2024-01-31"),
      "2024-01-31",
    );
    expect(() => confirmRenewal(skipped, "2024-02-01")).toThrow(
      "Only expected renewals can be confirmed",
    );
  });

  it("rejects confirmation before the event occurrence", () => {
    const expected = createExpectedRenewal(monthly(), "2024-01-31");
    expect(() => confirmRenewal(expected, "2024-01-30")).toThrow(
      "confirmedOn cannot be before occurrenceDate",
    );
  });

  it("rejects correction before the event occurrence", () => {
    const expected = createExpectedRenewal(monthly(), "2024-01-31");
    expect(() =>
      correctRenewal(expected, {
        correctedOn: "2024-01-30",
        occurrenceDate: "2024-02-01",
        amount: { minorUnits: 1399, currency: "USD" },
      }),
    ).toThrow("correctedOn cannot be before occurrenceDate");
  });

  it("rejects skipping before the event occurrence", () => {
    const expected = createExpectedRenewal(monthly(), "2024-01-31");
    expect(() => skipRenewal(expected, "2024-01-30")).toThrow(
      "skippedOn cannot be before occurrenceDate",
    );
  });
});

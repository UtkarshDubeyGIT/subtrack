import {
  confirmRenewal,
  correctRenewal,
  createExpectedRenewal,
  createLifecycleState,
  createOneTimeSubscription,
  createRecurrenceRule,
  createRecurringSubscription,
  skipRenewal,
  type LifecycleState,
  type RecurrenceRule,
} from "@subtrack/domain";
import type {
  PersistedRenewalEvent,
  PersistedSubscription,
} from "@subtrack/data";
import { describe, expect, it } from "vitest";
import type { ManagedSubscription } from "./subscriptions-runtime";
import {
  addCalendarDays,
  buildCalendarAgenda,
  createBillingDateProposalRange,
  createCalendarMonthWindow,
  filterCalendarEvents,
  isBillingDateProposalValid,
  shiftCalendarMonth,
} from "./calendar-agenda-model";

function recurring(
  id: string,
  serviceName: string,
  nextRenewalDate = "2026-08-31",
  lifecycle: LifecycleState = {
    status: "active",
    since: "2026-01-31",
  },
  startDate = "2026-01-31",
  recurrence: RecurrenceRule = createRecurrenceRule("monthly"),
): ManagedSubscription {
  const record: PersistedSubscription = {
    subscription: createRecurringSubscription({
      kind: "recurring",
      id,
      serviceName,
      amount: { minorUnits: 1299, currency: "USD" },
      timezone: "UTC",
      startDate,
      nextRenewalDate,
      recurrence,
      lifecycle: createLifecycleState(lifecycle),
    }),
    metadata: {
      planName: "Standard",
      accountEmail: null,
      paymentLabel: null,
      managementUrl: null,
      category: "Streaming",
      notes: null,
    },
    version: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  return { record, syncStatus: "synced" };
}

function oneTime(
  id: string,
  serviceName: string,
  purchasedOn: string,
  accessEndsOn: string | null,
): ManagedSubscription {
  const record: PersistedSubscription = {
    subscription: createOneTimeSubscription({
      kind: "one_time",
      id,
      serviceName,
      amount: { minorUnits: 4900, currency: "USD" },
      timezone: "UTC",
      purchasedOn,
      accessEndsOn,
      lifecycle: createLifecycleState({ status: "active", since: purchasedOn }),
    }),
    metadata: {
      planName: null,
      accountEmail: null,
      paymentLabel: null,
      managementUrl: null,
      category: "Software",
      notes: null,
    },
    version: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  return { record, syncStatus: "synced" };
}

function persistedEvent(
  event: PersistedRenewalEvent["event"],
): PersistedRenewalEvent {
  return {
    event,
    version: 2,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  };
}

describe("calendar agenda model", () => {
  it("projects anchored recurring charges with deterministic same-day ordering", () => {
    const result = buildCalendarAgenda({
      items: [
        recurring("sub_beta", "Beta storage"),
        recurring("sub_alpha", "Alpha streaming"),
      ],
      renewalEvents: [],
      rangeStart: "2026-08-01",
      rangeEnd: "2026-09-30",
    });

    expect(
      result.events.map(({ date, kind, serviceName }) => ({
        date,
        kind,
        serviceName,
      })),
    ).toEqual([
      {
        date: "2026-08-31",
        kind: "expected_charge",
        serviceName: "Alpha streaming",
      },
      {
        date: "2026-08-31",
        kind: "expected_charge",
        serviceName: "Beta storage",
      },
      {
        date: "2026-09-30",
        kind: "expected_charge",
        serviceName: "Alpha streaming",
      },
      {
        date: "2026-09-30",
        kind: "expected_charge",
        serviceName: "Beta storage",
      },
    ]);
    expect(result.truncated).toBe(false);
  });

  it("keeps lifecycle, one-time, access, and corrected billing truth distinct", () => {
    const correctedRecord = recurring(
      "sub_corrected",
      "Corrected cloud",
      "2026-08-20",
      { status: "active", since: "2026-05-20" },
      "2026-05-20",
    );
    const original = createExpectedRenewal(
      correctedRecord.record.subscription.kind === "recurring"
        ? correctedRecord.record.subscription
        : (() => {
            throw new Error("fixture");
          })(),
      "2026-08-20",
    );
    const corrected = correctRenewal(original, {
      correctedOn: "2026-08-21",
      occurrenceDate: "2026-08-22",
      amount: { minorUnits: 1499, currency: "USD" },
    });

    const result = buildCalendarAgenda({
      items: [
        oneTime("sub_once", "Lifetime editor", "2026-08-03", "2026-09-01"),
        recurring("sub_paused", "Paused music", "2026-08-31", {
          status: "paused",
          since: "2026-08-12",
        }),
        recurring("sub_canceled", "Canceled news", "2026-08-31", {
          status: "canceled",
          since: "2026-08-13",
          accessEndsOn: "2026-08-31",
        }),
        recurring(
          "sub_trial",
          "Trial design",
          "2026-08-15",
          {
            status: "trial",
            since: "2026-08-01",
            trialEndsOn: "2026-08-15",
          },
          "2026-08-15",
        ),
        correctedRecord,
      ],
      renewalEvents: [persistedEvent(corrected)],
      rangeStart: "2026-08-01",
      rangeEnd: "2026-08-31",
    });

    expect(
      result.events.map(
        ({ date, kind, serviceName }) => `${date}:${kind}:${serviceName}`,
      ),
    ).toEqual([
      "2026-08-03:one_time_purchase:Lifetime editor",
      "2026-08-12:paused:Paused music",
      "2026-08-13:canceled:Canceled news",
      "2026-08-15:trial_deadline:Trial design",
      "2026-08-22:corrected_charge:Corrected cloud",
      "2026-08-31:access_expiry:Canceled news",
    ]);
    expect(result.events.some(({ date }) => date === "2026-08-20")).toBe(false);
  });

  it("suppresses terminal history by original identity without hiding a correction-date collision", () => {
    const correctedRecord = recurring(
      "sub_corrected",
      "Corrected cloud",
      "2026-08-31",
    );
    const confirmedRecord = recurring(
      "sub_confirmed",
      "Confirmed hosting",
      "2026-08-31",
    );
    const skippedRecord = recurring(
      "sub_skipped",
      "Skipped journal",
      "2026-08-31",
    );
    const recurringSubscription = (record: ManagedSubscription) => {
      const subscription = record.record.subscription;
      if (subscription.kind !== "recurring") throw new Error("fixture");
      return subscription;
    };
    const corrected = correctRenewal(
      createExpectedRenewal(
        recurringSubscription(correctedRecord),
        "2026-08-31",
      ),
      {
        correctedOn: "2026-09-01",
        occurrenceDate: "2026-09-30",
        amount: { minorUnits: 1499, currency: "USD" },
      },
    );
    const confirmed = confirmRenewal(
      createExpectedRenewal(
        recurringSubscription(confirmedRecord),
        "2026-08-31",
      ),
      "2026-08-31",
    );
    const skipped = skipRenewal(
      createExpectedRenewal(recurringSubscription(skippedRecord), "2026-08-31"),
      "2026-08-31",
    );

    const result = buildCalendarAgenda({
      items: [correctedRecord, confirmedRecord, skippedRecord],
      renewalEvents: [
        persistedEvent(corrected),
        persistedEvent(confirmed),
        persistedEvent(skipped),
      ],
      rangeStart: "2026-08-01",
      rangeEnd: "2026-09-30",
    });

    expect(
      result.events
        .filter(({ serviceName }) => serviceName === "Corrected cloud")
        .map(({ date, kind }) => `${date}:${kind}`),
    ).toEqual(["2026-09-30:corrected_charge", "2026-09-30:expected_charge"]);
    expect(
      result.events
        .filter(({ serviceName }) => serviceName === "Confirmed hosting")
        .map(({ date, kind }) => `${date}:${kind}`),
    ).toEqual(["2026-09-30:expected_charge"]);
    expect(
      result.events
        .filter(({ serviceName }) => serviceName === "Skipped journal")
        .map(({ date, kind }) => `${date}:${kind}`),
    ).toEqual(["2026-09-30:expected_charge"]);
  });

  it("keeps two corrected originals that share one final date distinct", () => {
    const correctedRecord = recurring(
      "sub_corrected",
      "Corrected cloud",
      "2026-08-31",
    );
    const subscription = correctedRecord.record.subscription;
    if (subscription.kind !== "recurring") throw new Error("fixture");
    const august = correctRenewal(
      createExpectedRenewal(subscription, "2026-08-31"),
      {
        correctedOn: "2026-09-01",
        occurrenceDate: "2026-10-15",
        amount: { minorUnits: 1399, currency: "USD" },
      },
    );
    const september = correctRenewal(
      createExpectedRenewal(subscription, "2026-09-30"),
      {
        correctedOn: "2026-10-01",
        occurrenceDate: "2026-10-15",
        amount: { minorUnits: 1499, currency: "USD" },
      },
    );

    const result = buildCalendarAgenda({
      items: [correctedRecord],
      renewalEvents: [persistedEvent(august), persistedEvent(september)],
      rangeStart: "2026-08-01",
      rangeEnd: "2026-10-31",
    });

    expect(
      result.events.map(({ date, kind, originalDate }) => ({
        date,
        kind,
        originalDate,
      })),
    ).toEqual([
      {
        date: "2026-10-15",
        kind: "corrected_charge",
        originalDate: "2026-08-31",
      },
      {
        date: "2026-10-15",
        kind: "corrected_charge",
        originalDate: "2026-09-30",
      },
      {
        date: "2026-10-31",
        kind: "expected_charge",
        originalDate: undefined,
      },
    ]);
    expect(new Set(result.events.map(({ id }) => id)).size).toBe(3);
  });

  it("bounds large projections and filters the in-memory result without writes", () => {
    const dailyRecord = recurring(
      "sub_daily",
      "Daily archive",
      "2026-08-01",
      { status: "active", since: "2026-08-01" },
      "2026-08-01",
      createRecurrenceRule({ unit: "day", interval: 1 }),
    );

    const result = buildCalendarAgenda({
      items: [dailyRecord],
      renewalEvents: [],
      rangeStart: "2026-08-01",
      rangeEnd: "2027-08-01",
      maxEvents: 7,
    });

    expect(result.events.map(({ date }) => date)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
    ]);
    expect(result.truncated).toBe(true);
    expect(
      filterCalendarEvents(result.events, {
        filter: "charges",
        query: "daily ARCHIVE",
      }),
    ).toHaveLength(7);
    expect(
      filterCalendarEvents(result.events, {
        filter: "trials",
        query: "",
      }),
    ).toEqual([]);

    expect(
      buildCalendarAgenda({
        items: [],
        renewalEvents: [],
        rangeStart: "2026-08-01",
        rangeEnd: "2026-08-31",
      }),
    ).toEqual({
      events: [],
      truncated: false,
      work: {
        itemsExamined: 0,
        recurrenceSeeks: 0,
        recurrenceAdvances: 0,
        recurrenceDatesExamined: 0,
      },
    });
  });

  it("seeks into a 1990 daily schedule and accounts for real cursor work", () => {
    const result = buildCalendarAgenda({
      items: [
        recurring(
          "sub_old_daily",
          "Long-running daily",
          "2026-08-01",
          { status: "active", since: "1990-01-01" },
          "1990-01-01",
          createRecurrenceRule({ unit: "day", interval: 1 }),
        ),
      ],
      renewalEvents: [],
      rangeStart: "2026-08-01",
      rangeEnd: "2026-08-31",
      maxEvents: 7,
    });

    expect(result.events.map(({ date }) => date)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
    ]);
    expect(result.truncated).toBe(true);
    expect(result.work).toEqual({
      itemsExamined: 1,
      recurrenceSeeks: 1,
      recurrenceAdvances: 7,
      recurrenceDatesExamined: 8,
    });
  });

  it("counts every date examined while a direct seek corrects a mid-interval estimate", () => {
    const result = buildCalendarAgenda({
      items: [
        recurring(
          "sub_monthly_cursor",
          "Monthly cursor",
          "2026-08-01",
          { status: "active", since: "2026-01-01" },
          "2026-01-01",
          createRecurrenceRule({ unit: "month", interval: 1 }),
        ),
      ],
      renewalEvents: [],
      rangeStart: "2026-08-02",
      rangeEnd: "2026-10-31",
      maxEvents: 1,
    });

    expect(result.events.map(({ date }) => date)).toEqual(["2026-09-01"]);
    expect(result.truncated).toBe(true);
    expect(result.work).toEqual({
      itemsExamined: 1,
      recurrenceSeeks: 1,
      recurrenceAdvances: 2,
      recurrenceDatesExamined: 3,
    });
  });

  it("applies the active predicate before finalizing the bounded top-K", () => {
    const items = Array.from({ length: 257 }, (_, index) =>
      oneTime(
        `sub_dense_${String(index).padStart(3, "0")}`,
        index === 256
          ? "Needle service"
          : `Archive ${String(index).padStart(3, "0")}`,
        "2026-08-20",
        null,
      ),
    );

    const result = buildCalendarAgenda({
      items,
      renewalEvents: [],
      rangeStart: "2026-08-01",
      rangeEnd: "2026-08-31",
      maxEvents: 5,
      filter: "all",
      query: "needle",
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      subscriptionId: "sub_dense_256",
      serviceName: "Needle service",
    });
    expect(result.truncated).toBe(false);
  });

  it("bounds recurring work to one account seed plus the selected top-K", () => {
    const items = Array.from({ length: 600 }, (_, index) =>
      recurring(
        `sub_scale_${String(index).padStart(3, "0")}`,
        `Scale ${String(index).padStart(3, "0")}`,
      ),
    );

    const result = buildCalendarAgenda({
      items,
      renewalEvents: [],
      rangeStart: "2026-08-01",
      rangeEnd: "2026-09-30",
      maxEvents: 7,
    });

    expect(result.events).toHaveLength(7);
    expect(result.truncated).toBe(true);
    expect(result.work).toEqual({
      itemsExamined: 600,
      recurrenceSeeks: 600,
      recurrenceAdvances: 7,
      recurrenceDatesExamined: 607,
    });
  });

  it("builds timezone-neutral month navigation and a complete six-week grid", () => {
    const window = createCalendarMonthWindow("2026-08-15", 1);

    expect(window).toEqual({
      monthStart: "2026-08-01",
      monthEnd: "2026-08-31",
      gridStart: "2026-07-27",
      gridEnd: "2026-09-06",
      dates: expect.arrayContaining([
        "2026-07-27",
        "2026-08-01",
        "2026-08-31",
        "2026-09-06",
      ]),
    });
    expect(window.dates).toHaveLength(42);
    expect(shiftCalendarMonth("2026-01-01", 1)).toBe("2026-02-01");
    expect(shiftCalendarMonth("2026-03-01", -1)).toBe("2026-02-01");
    expect(addCalendarDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addCalendarDays("2028-02-29", 1)).toBe("2028-03-01");
  });

  it("bounds a current-occurrence proposal before the following recurrence", () => {
    const monthly = recurring("sub_monthly", "Monthly plan", "2026-08-31")
      .record.subscription;
    const daily = recurring(
      "sub_daily",
      "Daily plan",
      "2026-08-31",
      { status: "active", since: "2026-08-31" },
      "2026-08-31",
      createRecurrenceRule({ unit: "day", interval: 1 }),
    ).record.subscription;

    expect(createBillingDateProposalRange(monthly, "2026-08-15")).toEqual({
      minDate: "2026-08-15",
      maxDate: "2026-09-29",
    });
    expect(createBillingDateProposalRange(daily, "2026-08-31")).toEqual({
      minDate: "2026-08-31",
      maxDate: "2026-08-31",
    });
    expect(createBillingDateProposalRange(monthly, "2026-10-01")).toBeNull();
    expect(
      isBillingDateProposalValid("2026-08-28", {
        minDate: "2026-08-15",
        maxDate: "2026-09-29",
      }),
    ).toBe(true);
    expect(
      isBillingDateProposalValid("2026-08-14", {
        minDate: "2026-08-15",
        maxDate: "2026-09-29",
      }),
    ).toBe(false);
    expect(
      isBillingDateProposalValid("2026-08-xx", {
        minDate: "2026-08-15",
        maxDate: "2026-09-29",
      }),
    ).toBe(false);
  });

  it("finds the proposal boundary on a long-running daily schedule", () => {
    const subscription = recurring(
      "sub_old_daily",
      "Long-running daily",
      "2026-08-01",
      { status: "active", since: "1990-01-01" },
      "1990-01-01",
      createRecurrenceRule({ unit: "day", interval: 1 }),
    ).record.subscription;

    expect(createBillingDateProposalRange(subscription, "2026-08-01")).toEqual({
      minDate: "2026-08-01",
      maxDate: "2026-08-01",
    });
  });

  it.each([
    createRecurrenceRule("annual"),
    createRecurrenceRule({ unit: "day", interval: 1200 }),
  ])(
    "saturates a %j proposal with no occurrence after the supported maximum date",
    (recurrence) => {
      const subscription = recurring(
        `sub_max_${recurrence.unit}`,
        "Boundary schedule",
        "9999-12-31",
        { status: "active", since: "9999-12-31" },
        "9999-12-31",
        recurrence,
      ).record.subscription;

      expect(
        createBillingDateProposalRange(subscription, "9999-12-31"),
      ).toEqual({
        minDate: "9999-12-31",
        maxDate: "9999-12-31",
      });
    },
  );
});

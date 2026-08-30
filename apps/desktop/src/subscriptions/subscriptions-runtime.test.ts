import {
  createExpectedRenewal,
  createLifecycleState,
  createOneTimeSubscription,
  createRecurrenceRule,
  createRecurringSubscription,
  type LifecycleAction,
} from "@subtrack/domain";
import {
  type CalendarEvent,
  type CalendarPage,
  type CalendarPageQuery,
  DataPlaneError,
  type PersistedRenewalEvent,
  type PersistedSubscription,
  type RenewalHistoryPage,
  type RepositoryPage,
  type SubscriptionWrite,
} from "@subtrack/data";
import { describe, expect, it, vi } from "vitest";
import { createSubscriptionsRuntime } from "./subscriptions-runtime";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function record(
  overrides: Partial<PersistedSubscription> = {},
): PersistedSubscription {
  return {
    subscription: createRecurringSubscription({
      kind: "recurring",
      id: "sub_alpha",
      serviceName: "Alpha streaming",
      amount: { minorUnits: 1299, currency: "USD" },
      timezone: "UTC",
      startDate: "2026-01-31",
      nextRenewalDate: "2026-08-31",
      recurrence: createRecurrenceRule("monthly"),
      lifecycle: createLifecycleState({
        status: "active",
        since: "2026-01-31",
      }),
    }),
    metadata: {
      planName: "Standard",
      accountEmail: null,
      paymentLabel: "Visa •••• 4242",
      managementUrl: null,
      category: "Streaming",
      notes: null,
    },
    version: 2,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

function repositories(initial: readonly PersistedSubscription[] = [record()]) {
  return {
    subscriptionRepository: {
      list: vi.fn(async () => initial),
      listPage: vi.fn(
        async (): Promise<RepositoryPage<PersistedSubscription>> => ({
          items: initial.slice(0, 50),
          nextCursor: initial.length > 50 ? "ledger-page-2" : null,
          complete: initial.length <= 50,
        }),
      ),
      get: vi.fn(async (id: string) => {
        return initial.find((item) => item.subscription.id === id) ?? null;
      }),
      create: vi.fn(async (write: SubscriptionWrite) => ({
        subscription: write.subscription,
        metadata: {
          ...write.metadata,
          category: write.metadata.category ?? null,
        },
        version: 1,
        createdAt: "2026-08-06T12:00:00.000Z",
        updatedAt: "2026-08-06T12:00:00.000Z",
      })),
      update: vi.fn(
        async (write: SubscriptionWrite, expectedVersion: number) => ({
          subscription: write.subscription,
          metadata: {
            ...write.metadata,
            category: write.metadata.category ?? null,
          },
          version: expectedVersion + 1,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-06T12:00:00.000Z",
        }),
      ),
      delete: vi.fn(async (): Promise<void> => undefined),
    },
    renewalRepository: {
      list: vi.fn(async () => [] as readonly PersistedRenewalEvent[]),
      listPage: vi.fn(
        async (): Promise<RenewalHistoryPage> => ({
          events: [] as readonly PersistedRenewalEvent[],
          nextCursor: null,
          complete: true,
        }),
      ),
      listRange: vi.fn(async () => ({ events: [], truncated: false })),
    },
    calendarRepository: {
      listPage: vi.fn(
        async (_input: CalendarPageQuery): Promise<CalendarPage> => {
          void _input;
          return calendarPage();
        },
      ),
    },
  };
}

function writeFrom(source = record()): SubscriptionWrite {
  return {
    subscription: source.subscription,
    metadata: source.metadata,
  };
}

function renewalEvent(date = "2026-08-31"): PersistedRenewalEvent {
  const source = record().subscription;
  if (source.kind !== "recurring") throw new Error("fixture");
  return {
    event: createExpectedRenewal(source, date),
    version: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function calendarEvent(date = "2026-08-31"): CalendarEvent {
  return {
    id: `sub_alpha:expected_charge:${date}`,
    subscriptionId: "sub_alpha",
    serviceName: "Alpha streaming",
    planName: "Standard",
    category: "Streaming",
    date,
    kind: "expected_charge",
  };
}

function calendarPage(
  events: readonly CalendarEvent[] = [],
  incomplete = false,
): CalendarPage {
  return {
    events,
    nextCursor: incomplete ? "calendar-page-2" : null,
    complete: !incomplete,
    truncated: incomplete,
  };
}

describe("subscriptions runtime", () => {
  it("deduplicates an identical in-flight and loaded calendar range", async () => {
    const dependencies = repositories();
    const calendarLoad = deferred<CalendarPage>();
    dependencies.calendarRepository.listPage.mockReturnValue(
      calendarLoad.promise,
    );
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    const range = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
    } as const;

    const first = runtime.loadCalendarRange(range);
    const duplicate = runtime.loadCalendarRange(range);

    expect(dependencies.calendarRepository.listPage).toHaveBeenCalledOnce();
    calendarLoad.resolve(calendarPage());
    await Promise.all([first, duplicate]);
    await runtime.loadCalendarRange(range);
    expect(dependencies.calendarRepository.listPage).toHaveBeenCalledOnce();
  });

  it("joins the original request when navigation returns to pending range A", async () => {
    const dependencies = repositories();
    const firstA = deferred<CalendarPage>();
    const rangeB = deferred<CalendarPage>();
    dependencies.calendarRepository.listPage
      .mockReturnValueOnce(firstA.promise)
      .mockReturnValueOnce(rangeB.promise);
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    const rangeA = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
    } as const;
    const secondRange = {
      rangeStart: "2026-08-30",
      rangeEnd: "2027-01-08",
    } as const;

    const originalARequest = runtime.loadCalendarRange(rangeA);
    const secondRequest = runtime.loadCalendarRange(secondRange);
    const joinedARequest = runtime.loadCalendarRange(rangeA);

    expect(joinedARequest).toBe(originalARequest);
    expect(dependencies.calendarRepository.listPage).toHaveBeenCalledTimes(2);
    firstA.resolve(calendarPage([calendarEvent()]));
    await joinedARequest;
    rangeB.resolve(calendarPage());
    await secondRequest;
    expect(runtime.snapshot()).toMatchObject({
      calendarRange: {
        status: "ready",
        requested: rangeA,
        loaded: rangeA,
      },
    });
  });

  it("bounds rapid pending alternation to the two exact range requests", async () => {
    const dependencies = repositories();
    const firstA = deferred<CalendarPage>();
    const rangeB = deferred<CalendarPage>();
    dependencies.calendarRepository.listPage
      .mockReturnValueOnce(firstA.promise)
      .mockReturnValueOnce(rangeB.promise);
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    const ranges = [
      { rangeStart: "2026-07-26", rangeEnd: "2026-12-04" },
      { rangeStart: "2026-08-30", rangeEnd: "2027-01-08" },
    ] as const;

    const requests = Array.from({ length: 20 }, (_, index) =>
      runtime.loadCalendarRange(ranges[index % ranges.length]!),
    );

    expect(dependencies.calendarRepository.listPage).toHaveBeenCalledTimes(2);
    firstA.resolve(calendarPage([calendarEvent()]));
    rangeB.resolve(calendarPage());
    await Promise.all(requests);
  });

  it("aborts displaced ranges to keep distinct navigation work at two requests", async () => {
    const dependencies = repositories();
    const releases: Array<() => void> = [];
    const activeSignals = new Set<AbortSignal>();
    const observedSignals: AbortSignal[] = [];
    let maximumActive = 0;
    dependencies.calendarRepository.listPage.mockImplementation(
      (input) =>
        new Promise<CalendarPage>((resolve) => {
          const signal = input.signal;
          if (signal) {
            observedSignals.push(signal);
            activeSignals.add(signal);
            maximumActive = Math.max(maximumActive, activeSignals.size);
            signal.addEventListener(
              "abort",
              () => {
                activeSignals.delete(signal);
                resolve(calendarPage());
              },
              { once: true },
            );
          }
          releases.push(() => {
            if (signal) activeSignals.delete(signal);
            resolve(calendarPage());
          });
        }),
    );
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();

    const requests = Array.from({ length: 8 }, (_, index) =>
      runtime.loadCalendarRange({
        rangeStart: `2026-${String(index + 1).padStart(2, "0")}-01`,
        rangeEnd: `2026-${String(index + 1).padStart(2, "0")}-28`,
      }),
    );

    expect(observedSignals).toHaveLength(8);
    expect(maximumActive).toBeLessThanOrEqual(2);
    releases.forEach((release) => release());
    await Promise.all(requests);
  });

  it("aborts every owned calendar request on account reset", async () => {
    const dependencies = repositories();
    const signals: AbortSignal[] = [];
    dependencies.calendarRepository.listPage.mockImplementation(
      (input) =>
        new Promise<CalendarPage>((resolve) => {
          const signal = input.signal;
          if (!signal) return;
          signals.push(signal);
          signal.addEventListener("abort", () => resolve(calendarPage()), {
            once: true,
          });
        }),
    );
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    const requests = [
      runtime.loadCalendarRange({
        rangeStart: "2026-07-26",
        rangeEnd: "2026-12-04",
      }),
      runtime.loadCalendarRange({
        rangeStart: "2026-08-30",
        rangeEnd: "2027-01-08",
      }),
    ];

    runtime.reset();

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await Promise.all(requests);
    expect(runtime.snapshot()).toEqual({ status: "loading" });
  });

  it("publishes an initial calendar-range failure and retries that exact range", async () => {
    const dependencies = repositories();
    dependencies.calendarRepository.listPage
      .mockRejectedValueOnce(new DataPlaneError("unavailable"))
      .mockResolvedValueOnce(calendarPage([calendarEvent()]));
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    const range = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
    } as const;

    await runtime.loadCalendarRange(range);

    expect(runtime.snapshot()).toMatchObject({
      status: "ready",
      calendarEvents: [],
      calendarRange: {
        status: "error",
        requested: range,
        loaded: null,
      },
    });
    await runtime.retryCalendarRange();
    expect(runtime.snapshot()).toMatchObject({
      status: "ready",
      calendarEvents: [calendarEvent()],
      calendarRange: {
        status: "ready",
        requested: range,
        loaded: range,
      },
    });
    expect(dependencies.calendarRepository.listPage).toHaveBeenCalledTimes(2);
  });

  it("keeps the prior loaded identity when a later range fails", async () => {
    const dependencies = repositories();
    dependencies.calendarRepository.listPage
      .mockResolvedValueOnce(calendarPage([calendarEvent()]))
      .mockRejectedValueOnce(new DataPlaneError("unavailable"));
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    const firstRange = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
    } as const;
    const laterRange = {
      rangeStart: "2026-08-30",
      rangeEnd: "2027-01-08",
    } as const;
    await runtime.loadCalendarRange(firstRange);

    await runtime.loadCalendarRange(laterRange);

    expect(runtime.snapshot()).toMatchObject({
      status: "ready",
      calendarEvents: [calendarEvent()],
      calendarRange: {
        status: "error",
        requested: laterRange,
        loaded: firstRange,
      },
    });
  });

  it("publishes an incomplete bounded server page as honest earliest truth", async () => {
    const dependencies = repositories();
    dependencies.calendarRepository.listPage.mockResolvedValueOnce(
      calendarPage([calendarEvent()], true),
    );
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    const range = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
    } as const;

    await runtime.loadCalendarRange(range);

    expect(runtime.snapshot()).toMatchObject({
      status: "ready",
      calendarEvents: [calendarEvent()],
      calendarRange: {
        status: "ready",
        requested: range,
        loaded: range,
        complete: false,
        nextCursor: "calendar-page-2",
      },
    });
  });

  it("rejects a failed stale overlap after the latest range has loaded", async () => {
    const dependencies = repositories();
    const stale = deferred<CalendarPage>();
    const latest = deferred<CalendarPage>();
    dependencies.calendarRepository.listPage
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(latest.promise);
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    const staleRange = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
    } as const;
    const latestRange = {
      rangeStart: "2026-08-30",
      rangeEnd: "2027-01-08",
    } as const;

    const staleLoad = runtime.loadCalendarRange(staleRange);
    const latestLoad = runtime.loadCalendarRange(latestRange);
    expect(runtime.snapshot()).toMatchObject({
      calendarRange: {
        status: "pending",
        requested: latestRange,
        loaded: null,
      },
    });
    latest.resolve(calendarPage([calendarEvent()]));
    await latestLoad;
    stale.reject(new DataPlaneError("unavailable"));
    await staleLoad;

    expect(runtime.snapshot()).toMatchObject({
      calendarEvents: [calendarEvent()],
      calendarRange: {
        status: "ready",
        requested: latestRange,
        loaded: latestRange,
      },
    });
  });

  it("rejects a pending overlap after returning to the already loaded range", async () => {
    const dependencies = repositories();
    const later = deferred<CalendarPage>();
    dependencies.calendarRepository.listPage
      .mockResolvedValueOnce(calendarPage([calendarEvent()]))
      .mockReturnValueOnce(later.promise);
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    const loadedRange = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
    } as const;
    const laterRange = {
      rangeStart: "2026-08-30",
      rangeEnd: "2027-01-08",
    } as const;
    await runtime.loadCalendarRange(loadedRange);

    const laterLoad = runtime.loadCalendarRange(laterRange);
    await runtime.loadCalendarRange(loadedRange);
    later.resolve(calendarPage());
    await laterLoad;

    expect(runtime.snapshot()).toMatchObject({
      calendarEvents: [calendarEvent()],
      calendarRange: {
        status: "ready",
        requested: loadedRange,
        loaded: loadedRange,
      },
    });
    expect(dependencies.calendarRepository.listPage).toHaveBeenCalledTimes(2);
  });

  it("loads a bounded calendar range and drops a stale account generation", async () => {
    const dependencies = repositories();
    const calendarLoad = deferred<CalendarPage>();
    dependencies.calendarRepository.listPage.mockReturnValueOnce(
      calendarLoad.promise,
    );
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    const event = calendarEvent();
    const loading = runtime.loadCalendarRange({
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
    });
    calendarLoad.resolve(calendarPage([event]));

    await expect(loading).resolves.toMatchObject({
      status: "ready",
      calendarEvents: [event],
    });
    expect(dependencies.calendarRepository.listPage).toHaveBeenCalledWith(
      expect.objectContaining({
        rangeStart: "2026-07-26",
        rangeEnd: "2026-12-04",
        filter: "all",
        query: "",
        pageSize: 256,
        cursor: null,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(dependencies.renewalRepository.list).not.toHaveBeenCalled();

    const staleCalendarLoad = deferred<CalendarPage>();
    dependencies.calendarRepository.listPage.mockReturnValueOnce(
      staleCalendarLoad.promise,
    );
    runtime.activate("user_b");
    await runtime.boot();
    const staleLoading = runtime.loadCalendarRange({
      rangeStart: "2027-01-01",
      rangeEnd: "2027-05-31",
    });
    runtime.activate("user_c");
    staleCalendarLoad.resolve(calendarPage([event]));
    await staleLoading;
    expect(runtime.snapshot()).toEqual({ status: "loading" });
  });

  it("loads server-bounded calendar events with the complete active predicate", async () => {
    const dependencies = repositories();
    const serverEvent = {
      id: "sub_alpha:expected_charge:2026-08-31",
      subscriptionId: "sub_alpha",
      serviceName: "Alpha streaming",
      planName: "Standard",
      category: "Streaming",
      date: "2026-08-31",
      kind: "expected_charge",
    } as const;
    dependencies.calendarRepository.listPage.mockResolvedValueOnce({
      events: [serverEvent],
      nextCursor: "opaque-calendar-cursor",
      complete: false,
      truncated: true,
    });
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    const request = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
      filter: "charges",
      query: "alpha",
    } as const;

    await runtime.loadCalendarRange(request as never);

    expect(dependencies.calendarRepository.listPage).toHaveBeenCalledWith(
      expect.objectContaining({
        ...request,
        pageSize: 256,
        cursor: null,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(dependencies.renewalRepository.listRange).not.toHaveBeenCalled();
    expect(runtime.snapshot()).toMatchObject({
      status: "ready",
      calendarEvents: [serverEvent],
      calendarRange: {
        status: "ready",
        requested: request,
        loaded: request,
        complete: false,
        nextCursor: "opaque-calendar-cursor",
      },
    });
  });

  it("reloads the selected authoritative range after a successful create", async () => {
    const dependencies = repositories();
    const range = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
    } as const;
    const created = record().subscription;
    if (created.kind !== "recurring") throw new Error("fixture");
    const write: SubscriptionWrite = {
      subscription: createRecurringSubscription({
        ...created,
        id: "sub_beta",
        serviceName: "Beta storage",
      }),
      metadata: record().metadata,
    };
    dependencies.calendarRepository.listPage
      .mockResolvedValueOnce(calendarPage([calendarEvent()]))
      .mockResolvedValueOnce(
        calendarPage([
          calendarEvent(),
          {
            ...calendarEvent(),
            id: "sub_beta:expected_charge:2026-08-31",
            subscriptionId: "sub_beta",
            serviceName: "Beta storage",
          },
        ]),
      );
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    await runtime.loadCalendarRange(range);

    await runtime.create(write);

    expect(dependencies.calendarRepository.listPage).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot()).toMatchObject({
      calendarEvents: [
        calendarEvent(),
        { subscriptionId: "sub_beta", serviceName: "Beta storage" },
      ],
      calendarRange: { status: "ready", requested: range, loaded: range },
    });
  });

  it("reloads the same authoritative range after a successful reschedule update", async () => {
    const dependencies = repositories();
    const range = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
    } as const;
    const current = record().subscription;
    if (current.kind !== "recurring") throw new Error("fixture");
    const moved = record({
      subscription: createRecurringSubscription({
        ...current,
        startDate: "2026-09-28",
        nextRenewalDate: "2026-09-28",
      }),
    });
    dependencies.calendarRepository.listPage
      .mockResolvedValueOnce(calendarPage([calendarEvent()]))
      .mockResolvedValueOnce(calendarPage([calendarEvent("2026-09-28")]));
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    await runtime.loadCalendarRange(range);

    await runtime.update(writeFrom(moved));

    expect(dependencies.calendarRepository.listPage).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot()).toMatchObject({
      items: [
        {
          record: { subscription: { nextRenewalDate: "2026-09-28" } },
        },
      ],
      calendarEvents: [{ date: "2026-09-28" }],
      calendarRange: { status: "ready", requested: range, loaded: range },
    });
  });

  it("reloads the selected range after a successful lifecycle change", async () => {
    const dependencies = repositories();
    const range = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
    } as const;
    dependencies.calendarRepository.listPage
      .mockResolvedValueOnce(calendarPage([calendarEvent()]))
      .mockResolvedValueOnce(
        calendarPage([
          {
            ...calendarEvent("2026-08-06"),
            id: "sub_alpha:paused:2026-08-06",
            kind: "paused",
          },
        ]),
      );
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    await runtime.loadCalendarRange(range);

    await runtime.transition("sub_alpha", {
      type: "pause",
      on: "2026-08-06",
    });

    expect(dependencies.calendarRepository.listPage).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot()).toMatchObject({
      calendarEvents: [{ kind: "paused", date: "2026-08-06" }],
      calendarRange: { status: "ready", requested: range, loaded: range },
    });
  });

  it("reloads the selected range after a successful delete", async () => {
    const dependencies = repositories();
    const range = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
    } as const;
    dependencies.calendarRepository.listPage
      .mockResolvedValueOnce(calendarPage([calendarEvent()]))
      .mockResolvedValueOnce(calendarPage());
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    await runtime.loadCalendarRange(range);

    await runtime.remove("sub_alpha");

    expect(dependencies.calendarRepository.listPage).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot()).toMatchObject({
      items: [],
      calendarEvents: [],
      calendarRange: { status: "ready", requested: range, loaded: range },
    });
  });

  it("reloads commit-ambiguous truth after rollback and again after retry succeeds", async () => {
    const dependencies = repositories();
    const range = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
    } as const;
    const changed = record({
      subscription: {
        ...record().subscription,
        serviceName: "Edited locally",
      },
    });
    dependencies.subscriptionRepository.update
      .mockRejectedValueOnce(new DataPlaneError("unavailable"))
      .mockResolvedValueOnce(changed);
    dependencies.calendarRepository.listPage
      .mockResolvedValueOnce(calendarPage([calendarEvent()]))
      .mockResolvedValueOnce(calendarPage([calendarEvent("2026-09-28")]))
      .mockResolvedValueOnce(
        calendarPage([{ ...calendarEvent(), serviceName: "Edited locally" }]),
      );
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    await runtime.loadCalendarRange(range);

    await runtime.update(writeFrom(changed));

    expect(dependencies.calendarRepository.listPage).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot()).toMatchObject({
      calendarEvents: [{ date: "2026-09-28" }],
      mutation: { status: "retry" },
    });
    await runtime.retry();
    expect(dependencies.calendarRepository.listPage).toHaveBeenCalledTimes(3);
    expect(runtime.snapshot()).toMatchObject({
      calendarEvents: [{ serviceName: "Edited locally" }],
      mutation: null,
      calendarRange: { status: "ready", requested: range, loaded: range },
    });
  });

  it("invalidates a conflicting reschedule and reloads divergent server truth", async () => {
    const dependencies = repositories();
    const range = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
    } as const;
    const current = record().subscription;
    if (current.kind !== "recurring") throw new Error("fixture");
    const moved = record({
      subscription: createRecurringSubscription({
        ...current,
        startDate: "2026-09-28",
        nextRenewalDate: "2026-09-28",
      }),
    });
    dependencies.subscriptionRepository.update.mockRejectedValueOnce(
      new DataPlaneError("conflict"),
    );
    dependencies.calendarRepository.listPage
      .mockResolvedValueOnce(calendarPage([calendarEvent()]))
      .mockResolvedValueOnce(calendarPage([calendarEvent("2026-09-28")]));
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    await runtime.loadCalendarRange(range);

    await runtime.update(writeFrom(moved));

    expect(dependencies.calendarRepository.listPage).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot()).toMatchObject({
      items: [{ record: { subscription: { nextRenewalDate: "2026-08-31" } } }],
      calendarEvents: [{ date: "2026-09-28" }],
      calendarRange: { status: "ready", requested: range, loaded: range },
      mutation: { status: "conflict" },
    });
  });

  it("reloads after a conflicting create instead of reusing the same range", async () => {
    const dependencies = repositories();
    const range = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
    } as const;
    const recurring = record().subscription;
    if (recurring.kind !== "recurring") throw new Error("fixture");
    const write: SubscriptionWrite = {
      subscription: createRecurringSubscription({
        ...recurring,
        id: "sub_beta",
        serviceName: "Beta storage",
      }),
      metadata: record().metadata,
    };
    dependencies.subscriptionRepository.create.mockRejectedValueOnce(
      new DataPlaneError("conflict"),
    );
    dependencies.calendarRepository.listPage
      .mockResolvedValueOnce(calendarPage([calendarEvent()]))
      .mockResolvedValueOnce(
        calendarPage([
          calendarEvent(),
          {
            ...calendarEvent(),
            id: "sub_beta:expected_charge:2026-08-31",
            subscriptionId: "sub_beta",
            serviceName: "Beta storage",
          },
        ]),
      );
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    await runtime.loadCalendarRange(range);

    await runtime.create(write);

    expect(dependencies.calendarRepository.listPage).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot()).toMatchObject({
      items: [{ record: { subscription: { id: "sub_alpha" } } }],
      calendarEvents: [
        calendarEvent(),
        { subscriptionId: "sub_beta", serviceName: "Beta storage" },
      ],
      mutation: { status: "conflict" },
    });
  });

  it("reloads after a commit-ambiguous lifecycle failure", async () => {
    const dependencies = repositories();
    const range = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
    } as const;
    dependencies.subscriptionRepository.update.mockRejectedValueOnce(
      new DataPlaneError("unavailable"),
    );
    dependencies.calendarRepository.listPage
      .mockResolvedValueOnce(calendarPage([calendarEvent()]))
      .mockResolvedValueOnce(
        calendarPage([
          {
            ...calendarEvent("2026-08-06"),
            id: "sub_alpha:paused:2026-08-06",
            kind: "paused",
          },
        ]),
      );
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    await runtime.loadCalendarRange(range);

    await runtime.transition("sub_alpha", {
      type: "pause",
      on: "2026-08-06",
    });

    expect(dependencies.calendarRepository.listPage).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot()).toMatchObject({
      items: [
        { record: { subscription: { lifecycle: { status: "active" } } } },
      ],
      calendarEvents: [{ kind: "paused", date: "2026-08-06" }],
      mutation: { status: "retry", kind: "lifecycle" },
    });
  });

  it("reloads after a commit-ambiguous delete while rolling the ledger back", async () => {
    const dependencies = repositories();
    const range = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
    } as const;
    dependencies.subscriptionRepository.delete.mockRejectedValueOnce(
      new DataPlaneError("unavailable"),
    );
    dependencies.calendarRepository.listPage
      .mockResolvedValueOnce(calendarPage([calendarEvent()]))
      .mockResolvedValueOnce(calendarPage());
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    await runtime.loadCalendarRange(range);

    await runtime.remove("sub_alpha");

    expect(dependencies.calendarRepository.listPage).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot()).toMatchObject({
      items: [{ record: { subscription: { id: "sub_alpha" } } }],
      calendarEvents: [],
      calendarRange: { status: "ready", requested: range, loaded: range },
      mutation: { status: "retry", kind: "delete" },
    });
  });

  it("keeps ambiguous truth non-authoritative until a failed reload is retried", async () => {
    const dependencies = repositories();
    const range = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
    } as const;
    dependencies.subscriptionRepository.update.mockRejectedValueOnce(
      new DataPlaneError("unavailable"),
    );
    dependencies.calendarRepository.listPage
      .mockResolvedValueOnce(calendarPage([calendarEvent()]))
      .mockRejectedValueOnce(new DataPlaneError("unavailable"))
      .mockResolvedValueOnce(calendarPage([calendarEvent("2026-09-28")]));
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    await runtime.loadCalendarRange(range);

    await runtime.update(writeFrom());

    expect(runtime.snapshot()).toMatchObject({
      calendarEvents: [],
      calendarRange: { status: "error", requested: range, loaded: null },
      mutation: { status: "retry" },
    });
    await runtime.loadCalendarRange(range);
    expect(dependencies.calendarRepository.listPage).toHaveBeenCalledTimes(3);
    expect(runtime.snapshot()).toMatchObject({
      calendarEvents: [{ date: "2026-09-28" }],
      calendarRange: { status: "ready", requested: range, loaded: range },
    });
  });

  it("drops an ambiguous-write reload when the account generation changes", async () => {
    const dependencies = repositories();
    const reload = deferred<CalendarPage>();
    const range = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
    } as const;
    dependencies.subscriptionRepository.update.mockRejectedValueOnce(
      new DataPlaneError("conflict"),
    );
    dependencies.calendarRepository.listPage
      .mockResolvedValueOnce(calendarPage([calendarEvent()]))
      .mockReturnValueOnce(reload.promise);
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    await runtime.loadCalendarRange(range);

    const mutation = runtime.update(writeFrom());
    await vi.waitFor(() =>
      expect(dependencies.calendarRepository.listPage).toHaveBeenCalledTimes(2),
    );
    runtime.activate("user_b");
    reload.resolve(calendarPage([calendarEvent("2026-09-28")]));
    await mutation;

    expect(runtime.snapshot()).toEqual({ status: "loading" });
  });

  it("aborts an in-flight pre-mutation page before authoritative reload", async () => {
    const dependencies = repositories();
    const stalePage = deferred<CalendarPage>();
    const observedSignals: AbortSignal[] = [];
    dependencies.calendarRepository.listPage
      .mockImplementationOnce((request) => {
        if (request.signal) observedSignals.push(request.signal);
        return stalePage.promise;
      })
      .mockResolvedValueOnce(calendarPage([calendarEvent("2026-09-28")]));
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    const range = {
      rangeStart: "2026-07-26",
      rangeEnd: "2026-12-04",
    } as const;
    const loading = runtime.loadCalendarRange(range);

    const updating = runtime.update(writeFrom());
    await vi.waitFor(() => expect(observedSignals[0]?.aborted).toBe(true));
    stalePage.resolve(calendarPage([calendarEvent()]));
    await Promise.all([loading, updating]);

    expect(runtime.snapshot()).toMatchObject({
      calendarEvents: [{ date: "2026-09-28" }],
      calendarRange: { status: "ready", requested: range, loaded: range },
    });
  });

  it("loads private records into a ready in-memory ledger", async () => {
    const dependencies = repositories();
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");

    await expect(runtime.boot()).resolves.toMatchObject({
      status: "ready",
      items: [{ record: record(), syncStatus: "synced" }],
      ledger: { status: "ready", complete: true, nextCursor: null },
      selectedId: "sub_alpha",
      history: { status: "idle", events: [] },
      mutation: null,
    });
    expect(dependencies.subscriptionRepository.list).not.toHaveBeenCalled();
    expect(dependencies.subscriptionRepository.listPage).toHaveBeenCalledOnce();
  });

  it("boots a 20,000-record account from one bounded ledger page", async () => {
    const base = record();
    const account = Array.from({ length: 20_000 }, (_, index) => ({
      ...base,
      subscription: {
        ...base.subscription,
        id: `sub_scale_${String(index).padStart(5, "0")}`,
        serviceName: `Scale service ${index}`,
      },
    }));
    const dependencies = repositories(account);
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_scale");

    await runtime.boot();

    expect(dependencies.subscriptionRepository.list).not.toHaveBeenCalled();
    expect(dependencies.subscriptionRepository.listPage).toHaveBeenCalledWith({
      cursor: null,
      pageSize: 50,
    });
    const snapshot = runtime.snapshot();
    if (snapshot.status !== "ready") throw new Error("fixture");
    expect(snapshot.items).toHaveLength(50);
    expect(snapshot.items[0]?.record.subscription.id).toBe("sub_scale_00000");
    expect(snapshot.ledger).toEqual({
      status: "ready",
      complete: false,
      nextCursor: "ledger-page-2",
    });
  });

  it("appends a stable ledger page without replacing the selected record", async () => {
    const alpha = record();
    const beta = record({
      subscription: {
        ...record().subscription,
        id: "sub_beta",
        serviceName: "Beta storage",
      },
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    });
    const dependencies = repositories([alpha]);
    dependencies.subscriptionRepository.listPage
      .mockResolvedValueOnce({
        items: [alpha],
        nextCursor: "ledger-page-2",
        complete: false,
      })
      .mockResolvedValueOnce({
        items: [beta],
        nextCursor: null,
        complete: true,
      });
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    const loadMore = (
      runtime as unknown as {
        loadMoreSubscriptions?: () => Promise<unknown>;
      }
    ).loadMoreSubscriptions;

    await loadMore?.();

    expect(
      dependencies.subscriptionRepository.listPage,
    ).toHaveBeenNthCalledWith(2, { cursor: "ledger-page-2", pageSize: 50 });
    expect(runtime.snapshot()).toMatchObject({
      status: "ready",
      selectedId: "sub_alpha",
      ledger: { status: "ready", complete: true, nextCursor: null },
    });
    const snapshot = runtime.snapshot();
    if (snapshot.status !== "ready") throw new Error("fixture");
    expect(
      snapshot.items.map(({ record: item }) => item.subscription.id),
    ).toEqual(["sub_alpha", "sub_beta"]);
  });

  it("publishes an honest optimistic create before replacing it with the server row", async () => {
    const dependencies = repositories([]);
    const creating = deferred<PersistedSubscription>();
    dependencies.subscriptionRepository.create.mockReturnValueOnce(
      creating.promise,
    );
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    const write = writeFrom();

    const operation = runtime.create(write);

    expect(runtime.snapshot()).toMatchObject({
      status: "ready",
      items: [
        {
          record: { subscription: { id: "sub_alpha" } },
          syncStatus: "pending",
        },
      ],
      mutation: { status: "pending", kind: "create" },
    });
    creating.resolve(record({ version: 1 }));
    await expect(operation).resolves.toMatchObject({
      items: [{ record: { version: 1 }, syncStatus: "synced" }],
      mutation: null,
      announcement: "Subscription added.",
    });
  });

  it("rolls back an unavailable optimistic edit and retries the same in-memory write", async () => {
    const dependencies = repositories();
    const changed = record({
      subscription: {
        ...record().subscription,
        serviceName: "Edited locally",
      },
    });
    dependencies.subscriptionRepository.update
      .mockRejectedValueOnce(new DataPlaneError("unavailable"))
      .mockResolvedValueOnce(changed);
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();

    await runtime.update(writeFrom(changed));

    expect(runtime.snapshot()).toMatchObject({
      items: [
        {
          record: { subscription: { serviceName: "Alpha streaming" } },
          syncStatus: "synced",
        },
      ],
      mutation: {
        status: "retry",
        kind: "update",
        message: "Change not saved. Check your connection and retry.",
      },
    });
    await runtime.retry();
    expect(runtime.snapshot()).toMatchObject({
      items: [
        {
          record: { subscription: { serviceName: "Edited locally" } },
          syncStatus: "synced",
        },
      ],
      mutation: null,
      announcement: "Subscription updated.",
    });
    expect(dependencies.subscriptionRepository.update).toHaveBeenNthCalledWith(
      2,
      writeFrom(changed),
      2,
    );
  });

  it("uses one generic conflict state for stale and non-existent identifiers", async () => {
    const dependencies = repositories();
    dependencies.subscriptionRepository.update.mockRejectedValueOnce(
      new DataPlaneError("conflict"),
    );
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();
    const changed = record({
      subscription: { ...record().subscription, serviceName: "Private name" },
    });

    await runtime.update(writeFrom(changed));
    const stale = runtime.snapshot();
    expect(stale).toMatchObject({
      mutation: {
        status: "conflict",
        message:
          "This item changed or is unavailable. Reload before continuing.",
      },
    });
    expect(JSON.stringify(stale)).not.toContain("Private name");

    await runtime.remove("sub_not_visible");
    const missing = runtime.snapshot();
    expect(missing).toMatchObject({
      mutation: {
        status: "conflict",
        message:
          "This item changed or is unavailable. Reload before continuing.",
      },
    });
    expect(JSON.stringify(missing)).not.toContain("sub_not_visible");
  });

  it.each([
    [
      { type: "pause", on: "2026-08-06" },
      { status: "paused", since: "2026-08-06" },
    ],
    [
      { type: "cancel", on: "2026-08-06", accessEndsOn: "2026-08-31" },
      { status: "canceled", since: "2026-08-06", accessEndsOn: "2026-08-31" },
    ],
    [
      { type: "expire", on: "2026-08-06" },
      { status: "expired", since: "2026-08-06" },
    ],
  ] as const)(
    "routes the %s lifecycle action through domain validation and optimistic version 2",
    async (action, lifecycle) => {
      const dependencies = repositories();
      const runtime = createSubscriptionsRuntime(dependencies);
      runtime.activate("user_a");
      await runtime.boot();

      await runtime.transition("sub_alpha", action as LifecycleAction);

      const update = dependencies.subscriptionRepository.update.mock.calls[0];
      expect(update?.[0].subscription.lifecycle).toEqual(lifecycle);
      expect(update?.[1]).toBe(2);
    },
  );

  it("resumes on the first anchored renewal at or after the resume date", async () => {
    const active = record().subscription;
    if (active.kind !== "recurring") throw new Error("fixture_invalid");
    const paused = record({
      subscription: createRecurringSubscription({
        ...active,
        lifecycle: { status: "paused", since: "2026-07-01" },
      }),
    });
    const dependencies = repositories([paused]);
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();

    await runtime.transition("sub_alpha", {
      type: "resume",
      on: "2026-09-01",
    });

    expect(
      dependencies.subscriptionRepository.update.mock.calls[0]?.[0]
        .subscription,
    ).toMatchObject({
      nextRenewalDate: "2026-09-30",
      lifecycle: { status: "active", since: "2026-09-01" },
    });
  });

  it("restarts recurring billing on the first anchored occurrence at or after restart", async () => {
    const recurring = record().subscription;
    if (recurring.kind !== "recurring") throw new Error("fixture_invalid");
    const expired = record({
      subscription: createRecurringSubscription({
        ...recurring,
        nextRenewalDate: "2026-02-28",
        lifecycle: { status: "expired", since: "2026-08-01" },
      }),
    });
    const dependencies = repositories([expired]);
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();

    await runtime.transition("sub_alpha", {
      type: "restart",
      on: "2026-08-15",
    });

    expect(
      dependencies.subscriptionRepository.update.mock.calls[0]?.[0]
        .subscription,
    ).toMatchObject({
      nextRenewalDate: "2026-08-31",
      lifecycle: { status: "active", since: "2026-08-15" },
    });
  });

  it("refuses to restart expired one-time access without explicit future access truth", async () => {
    const expired = record({
      subscription: createOneTimeSubscription({
        kind: "one_time",
        id: "sub_alpha",
        serviceName: "Ended pass",
        amount: { minorUnits: 1299, currency: "USD" },
        timezone: "UTC",
        purchasedOn: "2026-01-01",
        accessEndsOn: "2026-07-31",
        lifecycle: { status: "expired", since: "2026-07-31" },
      }),
    });
    const dependencies = repositories([expired]);
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();

    await runtime.transition("sub_alpha", {
      type: "restart",
      on: "2026-08-15",
    });

    expect(dependencies.subscriptionRepository.update).not.toHaveBeenCalled();
    expect(runtime.snapshot()).toMatchObject({
      mutation: {
        status: "error",
        kind: "lifecycle",
        message: "That lifecycle change is not available.",
      },
    });
  });

  it("removes optimistically, restores on network failure, and retries permanently", async () => {
    const dependencies = repositories();
    const deleting = deferred<void>();
    dependencies.subscriptionRepository.delete
      .mockReturnValueOnce(deleting.promise)
      .mockResolvedValueOnce(undefined);
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();

    const operation = runtime.remove("sub_alpha");
    expect(runtime.snapshot()).toMatchObject({
      items: [],
      mutation: { status: "pending", kind: "delete" },
    });
    deleting.reject(new DataPlaneError("unavailable"));
    await operation;
    expect(runtime.snapshot()).toMatchObject({
      items: [{ record: { subscription: { id: "sub_alpha" } } }],
      mutation: { status: "retry", kind: "delete" },
    });

    await runtime.retry();
    expect(runtime.snapshot()).toMatchObject({
      items: [],
      mutation: null,
      announcement: "Subscription permanently deleted.",
    });
    expect(dependencies.subscriptionRepository.delete).toHaveBeenNthCalledWith(
      2,
      "sub_alpha",
      2,
    );
  });

  it("loads retained renewal history and drops it synchronously on account change", async () => {
    const dependencies = repositories();
    const history = deferred<RenewalHistoryPage>();
    dependencies.renewalRepository.listPage.mockReturnValueOnce(
      history.promise,
    );
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();

    const selecting = runtime.select("sub_alpha");
    expect(runtime.snapshot()).toMatchObject({
      selectedId: "sub_alpha",
      history: { status: "loading", events: [] },
    });
    runtime.activate("user_b");
    expect(runtime.snapshot()).toEqual({ status: "loading" });
    history.resolve({ events: [], nextCursor: null, complete: true });
    await selecting;
    expect(runtime.snapshot()).toEqual({ status: "loading" });
  });

  it("loads renewal history progressively with a stable cursor", async () => {
    const dependencies = repositories();
    const august = renewalEvent("2026-08-31");
    const september = renewalEvent("2026-09-30");
    dependencies.renewalRepository.listPage
      .mockResolvedValueOnce({
        events: [august],
        nextCursor: "history-page-2",
        complete: false,
      })
      .mockResolvedValueOnce({
        events: [september],
        nextCursor: null,
        complete: true,
      });
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");
    await runtime.boot();

    await runtime.select("sub_alpha");
    const loadMoreHistory = (
      runtime as unknown as { loadMoreHistory?: () => Promise<unknown> }
    ).loadMoreHistory;
    await loadMoreHistory?.();

    expect(dependencies.renewalRepository.list).not.toHaveBeenCalled();
    expect(dependencies.renewalRepository.listPage).toHaveBeenNthCalledWith(1, {
      subscriptionId: "sub_alpha",
      cursor: null,
      pageSize: 20,
    });
    expect(dependencies.renewalRepository.listPage).toHaveBeenNthCalledWith(2, {
      subscriptionId: "sub_alpha",
      cursor: "history-page-2",
      pageSize: 20,
    });
    expect(runtime.snapshot()).toMatchObject({
      status: "ready",
      selectedId: "sub_alpha",
      history: {
        status: "ready",
        events: [august, september],
        nextCursor: null,
        complete: true,
      },
    });
  });

  it("redacts load failures and supports an explicit reload", async () => {
    const dependencies = repositories();
    dependencies.subscriptionRepository.listPage
      .mockRejectedValueOnce(new Error("person@example.test secret response"))
      .mockResolvedValueOnce({
        items: [record()],
        nextCursor: null,
        complete: true,
      });
    const runtime = createSubscriptionsRuntime(dependencies);
    runtime.activate("user_a");

    const failed = await runtime.boot();
    expect(failed).toEqual({
      status: "error",
      message: "Subscriptions could not be loaded.",
      retryable: true,
    });
    expect(JSON.stringify(failed)).not.toMatch(
      /person@example|secret response/,
    );

    await expect(runtime.reload()).resolves.toMatchObject({ status: "ready" });
  });
});

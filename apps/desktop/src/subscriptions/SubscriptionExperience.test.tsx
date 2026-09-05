// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  confirmRenewal,
  createExpectedRenewal,
  createLifecycleState,
  createOneTimeSubscription,
  createRecurrenceRule,
  createRecurringSubscription,
  type LifecycleState,
} from "@subtrack/domain";
import {
  type CalendarEvent,
  type CalendarPage,
  type CalendarPageQuery,
  DataPlaneError,
  type PersistedRenewalEvent,
  type PersistedSubscription,
  type SubscriptionWrite,
} from "@subtrack/data";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubscriptionExperience } from "./SubscriptionExperience";
import { buildCalendarAgenda } from "./calendar-agenda-model";
import { createSubscriptionsRuntime } from "./subscriptions-runtime";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function persisted(
  lifecycle: LifecycleState = { status: "active", since: "2026-01-31" },
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
      lifecycle: createLifecycleState(lifecycle),
    }),
    metadata: {
      planName: "Standard",
      accountEmail: null,
      paymentLabel: "Visa •••• 4242",
      managementUrl: "https://example.test/manage",
      category: "Streaming",
      notes: null,
    },
    version: 2,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

function normalizePersisted(
  write: SubscriptionWrite,
  version: number,
): PersistedSubscription {
  return {
    subscription: write.subscription,
    metadata: {
      ...write.metadata,
      category: write.metadata.category ?? null,
    },
    version,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-06T12:00:00.000Z",
  };
}

function expectedCalendarEvent(
  subscriptionId = "sub_alpha",
  serviceName = "Alpha streaming",
): CalendarEvent {
  return {
    id: `${subscriptionId}:expected_charge:2026-08-31`,
    subscriptionId,
    serviceName,
    planName: "Standard",
    category: "Streaming",
    date: "2026-08-31",
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

function setup(
  records: readonly PersistedSubscription[] = [persisted()],
  history: readonly PersistedRenewalEvent[] = [],
  options: Readonly<{
    locale?: string;
    timezone?: string;
    today?: (() => string) | null;
    ledgerPages?: readonly Readonly<{
      items: readonly PersistedSubscription[];
      nextCursor: string | null;
      complete: boolean;
    }>[];
  }> = {},
) {
  let ledgerPageIndex = 0;
  const repository = {
    list: vi.fn(async () => records),
    listPage: vi.fn(
      async () =>
        options.ledgerPages?.[ledgerPageIndex++] ?? {
          items: records,
          nextCursor: null,
          complete: true,
        },
    ),
    get: vi.fn(
      async (id: string) =>
        records.find((record) => record.subscription.id === id) ?? null,
    ),
    create: vi.fn(async (write: SubscriptionWrite) =>
      normalizePersisted(write, 1),
    ),
    update: vi.fn(async (write: SubscriptionWrite, expectedVersion: number) =>
      normalizePersisted(write, expectedVersion + 1),
    ),
    delete: vi.fn(async (): Promise<void> => undefined),
  };
  const renewals = {
    list: vi.fn(async () => history),
    listPage: vi.fn(async () => ({
      events: history,
      nextCursor: null,
      complete: true,
    })),
  };
  const calendar = {
    listPage: vi.fn(async (input: CalendarPageQuery): Promise<CalendarPage> => {
      const projection = buildCalendarAgenda({
        items: records.map((record) => ({
          record,
          syncStatus: "synced" as const,
        })),
        renewalEvents: history,
        rangeStart: input.rangeStart,
        rangeEnd: input.rangeEnd,
        filter: input.filter,
        query: input.query,
        maxEvents: 256,
      });
      return {
        events: projection.events,
        nextCursor: projection.truncated ? "calendar-page-2" : null,
        complete: !projection.truncated,
        truncated: projection.truncated,
      };
    }),
  };
  const runtime = createSubscriptionsRuntime({
    subscriptionRepository: repository,
    renewalRepository: renewals,
    calendarRepository: calendar,
    now: () => "2026-08-06T12:00:00.000Z",
  });
  runtime.activate("user_a");
  const today = Object.hasOwn(options, "today")
    ? options.today
    : () => "2026-08-06";
  render(
    <SubscriptionExperience
      runtime={runtime}
      homeCurrency="USD"
      timezone={options.timezone ?? "UTC"}
      locale={options.locale ?? "en-US"}
      {...(today ? { today } : {})}
      createId={() => "sub_created"}
    />,
  );
  return { calendar, renewals, repository, runtime };
}

async function openQuickAdd() {
  fireEvent.keyDown(document, { key: "n", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", {
    name: "Add a subscription",
  });
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByLabelText("Service"));
  });
  return dialog;
}

describe("SubscriptionExperience", () => {
  it("switches workspace views with arrow keys without losing the selected calendar date", async () => {
    setup();
    const user = userEvent.setup();
    const subscriptions = await screen.findByRole("tab", {
      name: "Subscriptions",
    });
    const calendar = screen.getByRole("tab", { name: "Calendar" });
    expect(subscriptions.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("grid")).toBeNull();

    subscriptions.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(calendar);
    expect(calendar.getAttribute("aria-selected")).toBe("true");
    const date = await screen.findByRole("gridcell", {
      name: /Monday, August 31, 2026/u,
    });
    await user.click(date);
    await user.click(subscriptions);
    expect(screen.queryByRole("grid")).toBeNull();
    await user.keyboard("{End}");
    expect(date.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(calendar);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(subscriptions);
    expect(screen.queryByRole("grid")).toBeNull();
  });

  it("searches service, plan, and category without changing the spending summary", async () => {
    const beta = persisted();
    setup([
      persisted(),
      {
        ...beta,
        subscription: {
          ...beta.subscription,
          id: "sub_beta",
          serviceName: "Beta storage",
        },
        metadata: {
          ...beta.metadata,
          planName: "Family",
          category: "Productivity",
        },
      },
    ]);
    const user = userEvent.setup();
    const search = await screen.findByRole("searchbox", {
      name: "Search subscriptions",
    });
    const ledger = screen.getByRole("region", { name: "Current ledger" });
    const spend = screen.getByRole("region", { name: "Committed spend" });
    const originalSpend = spend.textContent;
    for (const query of ["  BETA  ", "family", "productivity"]) {
      await user.clear(search);
      await user.type(search, query);
      expect(
        within(ledger).getByRole("button", { name: /Beta storage/u }),
      ).toBeTruthy();
      expect(
        within(ledger).queryByRole("button", { name: /Alpha streaming/u }),
      ).toBeNull();
      expect(spend.textContent).toBe(originalSpend);
    }
    await user.clear(search);
    await user.type(search, "No match");
    expect(within(ledger).getByText("No matching subscriptions")).toBeTruthy();
    await user.click(
      within(ledger).getByRole("button", { name: "Clear search" }),
    );
    expect(
      within(ledger).getByRole("button", { name: /Alpha streaming/u }),
    ).toBeTruthy();
    expect(
      within(ledger).getByRole("button", { name: /Beta storage/u }),
    ).toBeTruthy();
  });

  it("sorts subscriptions by renewal date or service name", async () => {
    const beta = persisted();
    if (beta.subscription.kind !== "recurring")
      throw new Error("Expected recurring fixture");
    setup([
      persisted(),
      {
        ...beta,
        subscription: {
          ...beta.subscription,
          id: "sub_beta",
          serviceName: "Beta storage",
          nextRenewalDate: "2026-08-12",
        },
      },
    ]);
    const user = userEvent.setup();
    const ledger = await screen.findByRole("region", {
      name: "Current ledger",
    });
    expect(within(ledger).getAllByRole("button")[0]?.textContent).toContain(
      "Beta storage",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Sort subscriptions" }),
      "name",
    );
    expect(within(ledger).getAllByRole("button")[0]?.textContent).toContain(
      "Alpha streaming",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Sort subscriptions" }),
      "renewal",
    );
    expect(within(ledger).getAllByRole("button")[0]?.textContent).toContain(
      "Beta storage",
    );
  });

  it("settles one successful calendar read across snapshot rerenders", async () => {
    const held = deferred<CalendarPage>();
    const { calendar } = setup();
    calendar.listPage
      .mockReset()
      .mockResolvedValueOnce(calendarPage())
      .mockResolvedValueOnce(calendarPage())
      .mockResolvedValueOnce(calendarPage())
      .mockReturnValue(held.promise);

    try {
      await waitFor(() => {
        expect(calendar.listPage).toHaveBeenCalled();
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calendar.listPage).toHaveBeenCalledOnce();
    } finally {
      held.resolve(calendarPage());
    }
  });

  it("withholds projection after an initial range failure and retries", async () => {
    const { calendar } = setup();
    calendar.listPage
      .mockReset()
      .mockRejectedValueOnce(new DataPlaneError("unavailable"))
      .mockResolvedValueOnce(calendarPage([expectedCalendarEvent()]));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Calendar" }));

    expect(await screen.findByText("Calendar range unavailable")).toBeTruthy();
    expect(
      screen.getByRole("gridcell", {
        name: /Monday, August 31, 2026\. Events unavailable/u,
      }),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Retry calendar range" }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("gridcell", {
          name: /Monday, August 31, 2026\. 1 event/u,
        }),
      ).toBeTruthy();
    });
    expect(calendar.listPage).toHaveBeenCalledTimes(2);
  });

  it("withholds a later month when its correction range fails", async () => {
    const { calendar } = setup();
    calendar.listPage
      .mockReset()
      .mockResolvedValueOnce(calendarPage([expectedCalendarEvent()]))
      .mockRejectedValueOnce(new DataPlaneError("unavailable"));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Calendar" }));
    await waitFor(() => {
      expect(
        screen.getByRole("gridcell", {
          name: /Monday, August 31, 2026\. 1 event/u,
        }),
      ).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: "Next month" }));

    expect(await screen.findByText("Calendar range unavailable")).toBeTruthy();
    expect(
      screen.getByRole("gridcell", {
        name: /Wednesday, September 30, 2026\. Events unavailable/u,
      }),
    ).toBeTruthy();
  });

  it("labels an incomplete bounded page without discarding its verified events", async () => {
    const { calendar } = setup();
    calendar.listPage
      .mockReset()
      .mockResolvedValueOnce(calendarPage([expectedCalendarEvent()], true));

    fireEvent.click(await screen.findByRole("tab", { name: "Calendar" }));

    expect(
      await screen.findByText(/Showing the earliest 256 matching events/u),
    ).toBeTruthy();
    expect(
      screen.getByRole("gridcell", {
        name: /Monday, August 31, 2026\. 1 event/u,
      }),
    ).toBeTruthy();
  });

  it("keeps the new account range authoritative after a stale generation completes", async () => {
    const stale = deferred<CalendarPage>();
    const { calendar, repository, runtime } = setup();
    calendar.listPage
      .mockReset()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(
        calendarPage([expectedCalendarEvent("sub_beta", "Beta streaming")]),
      );
    const betaSeed = persisted();
    const beta: PersistedSubscription = {
      ...betaSeed,
      subscription: {
        ...betaSeed.subscription,
        id: "sub_beta",
        serviceName: "Beta streaming",
      },
    };
    repository.listPage.mockResolvedValueOnce({
      items: [beta],
      nextCursor: null,
      complete: true,
    });

    fireEvent.click(await screen.findByRole("tab", { name: "Calendar" }));
    await waitFor(() => expect(calendar.listPage).toHaveBeenCalledOnce());
    await act(async () => {
      runtime.activate("user_b");
      await runtime.boot();
    });
    await waitFor(() => {
      expect(calendar.listPage).toHaveBeenCalledTimes(2);
      expect(screen.getAllByText("Beta streaming").length).toBeGreaterThan(0);
      expect(
        screen.getByRole("gridcell", {
          name: /Monday, August 31, 2026\. 1 event/u,
        }),
      ).toBeTruthy();
    });

    await act(async () => {
      stale.resolve(calendarPage([], true));
      await stale.promise;
    });

    expect(screen.queryByText("Alpha streaming")).toBeNull();
    expect(
      screen.queryByText(/Showing the earliest 256 matching events/u),
    ).toBeNull();
    expect(
      screen.getByRole("gridcell", {
        name: /Monday, August 31, 2026\. 1 event/u,
      }),
    ).toBeTruthy();
  });

  it("opens compact quick add with Ctrl+N, focuses Service, and restores focus on Escape", async () => {
    const localWrite = vi.spyOn(Storage.prototype, "setItem");
    setup([]);
    const quickAdd = await screen.findByRole("button", {
      name: "Add subscription",
    });
    expect(quickAdd.getAttribute("aria-keyshortcuts")).toContain("Control+N");

    await openQuickAdd();

    expect(screen.getByRole("textbox", { name: "Amount" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Currency" })).toBeTruthy();
    expect(screen.getByLabelText("Next renewal")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Repeats" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(quickAdd);
    });
    expect(localWrite).not.toHaveBeenCalled();
  });

  it("contains keyboard focus inside the quick-add dialog", async () => {
    setup([]);
    const user = userEvent.setup();
    const dialog = await openQuickAdd();
    const close = within(dialog).getByRole("button", { name: "Close" });
    const submit = within(dialog).getByRole("button", {
      name: "Add subscription",
    });

    close.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(submit);

    await user.tab();
    expect(document.activeElement).toBe(close);
  });

  it("uses curated service defaults without inventing amount or renewal date", async () => {
    setup([]);
    const user = userEvent.setup();
    await openQuickAdd();

    await user.type(screen.getByLabelText("Service"), "Netflix");
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Amount" }).value,
    ).toBe("");
    expect(screen.getByLabelText<HTMLInputElement>("Next renewal").value).toBe(
      "",
    );
    await user.click(screen.getByRole("button", { name: "More details" }));
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Category" }).value,
    ).toBe("Streaming");
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Management link" })
        .value,
    ).toBe("https://www.netflix.com/account");
  });

  it("captures one-time access without routing it through recurring fields", async () => {
    const { repository } = setup([]);
    const user = userEvent.setup();
    const dialog = await openQuickAdd();

    await user.type(screen.getByLabelText("Service"), "Lifetime editor");
    await user.selectOptions(screen.getByLabelText("Item type"), "one_time");
    await user.type(screen.getByRole("textbox", { name: "Amount" }), "49.00");
    await user.type(screen.getByLabelText("Purchase date"), "2026-08-06");
    expect(screen.queryByLabelText("Next renewal")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Repeats" })).toBeNull();

    await user.click(
      within(dialog).getByRole("button", { name: "Add subscription" }),
    );
    await waitFor(() => expect(repository.create).toHaveBeenCalledOnce());
    const write = repository.create.mock.calls[0]?.[0];
    expect(write?.subscription.kind).toBe("one_time");
    if (write?.subscription.kind !== "one_time") {
      throw new Error("expected_one_time");
    }
    expect(write.subscription.purchasedOn).toBe("2026-08-06");
  });

  it("adds by keyboard with an honest pending row and completion announcement", async () => {
    const { repository } = setup([]);
    const creating = deferred<PersistedSubscription>();
    repository.create.mockReturnValueOnce(creating.promise);
    const user = userEvent.setup();
    const dialog = await openQuickAdd();

    await user.type(screen.getByLabelText("Service"), "Nebula");
    await user.type(screen.getByRole("textbox", { name: "Amount" }), "12.99");
    await user.type(screen.getByLabelText("Next renewal"), "2026-09-06");
    const add = within(dialog).getByRole("button", {
      name: "Add subscription",
    });
    add.focus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("button", { name: "Adding…" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText("Saving securely…")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /Nebula.*Next renewal.*Sep 6, 2026.*\$12\.99.*Active.*Pending sync/i,
      }),
    ).toBeTruthy();
    const write = repository.create.mock.calls[0]?.[0];
    if (!write) throw new Error("missing_write");
    creating.resolve(normalizePersisted(write, 1));

    expect(await screen.findByText("Subscription added.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("blocks obvious credentials before repository I/O and explains the privacy boundary", async () => {
    const { repository } = setup([]);
    const user = userEvent.setup();
    const dialog = await openQuickAdd();
    await user.type(screen.getByLabelText("Service"), "Unsafe");
    await user.type(screen.getByRole("textbox", { name: "Amount" }), "1.00");
    await user.type(screen.getByLabelText("Next renewal"), "2026-09-06");
    await user.click(screen.getByRole("button", { name: "More details" }));
    await user.type(screen.getByRole("textbox", { name: "Notes" }), "CVV: 123");
    await user.click(
      within(dialog).getByRole("button", { name: "Add subscription" }),
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(
      "Remove card numbers, security codes, passwords, or recovery codes.",
    );
    expect(alert.textContent).not.toContain("123");
    expect(
      screen.getByText(
        /Never add passwords, full card numbers, or security codes/i,
      ),
    ).toBeTruthy();
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("edits optional metadata using the current optimistic version", async () => {
    const { repository } = setup();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: /^Alpha streaming\. Next renewal:/u,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Edit subscription" }));

    const plan = screen.getByRole("textbox", { name: "Plan" });
    await user.clear(plan);
    await user.type(plan, "Family");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(repository.update).toHaveBeenCalledOnce());
    expect(repository.update.mock.calls[0]?.[0].metadata.planName).toBe(
      "Family",
    );
    expect(repository.update.mock.calls[0]?.[1]).toBe(2);
    expect(await screen.findByText("Subscription updated.")).toBeTruthy();
  });

  it("makes persisted trial boundaries unavailable to misleading edit success", async () => {
    setup([
      persisted({
        status: "trial",
        since: "2026-01-31",
        trialEndsOn: "2026-08-24",
      }),
    ]);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: /^Alpha streaming\. Next renewal:/u,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Edit subscription" }));

    expect(screen.getByLabelText(/Trial ends/)).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText(/trial boundary cannot be edited/i)).toBeTruthy();
  });

  it("derives create lifecycle today from the configured account timezone", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-07T01:30:00.000Z"));
    const { repository } = setup([], [], {
      timezone: "America/Los_Angeles",
      today: null,
    });
    await openQuickAdd();
    fireEvent.change(screen.getByLabelText("Service"), {
      target: { value: "Los Angeles billing" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Amount" }), {
      target: { value: "10.00" },
    });
    fireEvent.change(screen.getByLabelText("Next renewal"), {
      target: { value: "2026-09-06" },
    });
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Add subscription",
      }),
    );

    await waitFor(() => expect(repository.create).toHaveBeenCalledOnce());
    expect(
      repository.create.mock.calls[0]?.[0].subscription.lifecycle.since,
    ).toBe("2026-08-06");
  });

  it("canonicalizes underscore locales before any Intl formatting", async () => {
    setup([persisted()], [], { locale: "en_US" });
    expect((await screen.findAllByText("$12.99")).length).toBeGreaterThan(0);
  });

  it("moves focus into lifecycle confirmation before accepting keyboard input", async () => {
    setup();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: /^Alpha streaming\. Next renewal:/u,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText("Change date"));
    });
  });

  it.each([
    [
      { status: "active", since: "2026-01-31" } as const,
      "Pause",
      "Pause subscription",
      { status: "paused", since: "2026-08-06" },
    ],
    [
      { status: "paused", since: "2026-07-01" } as const,
      "Resume",
      "Resume subscription",
      { status: "active", since: "2026-08-06" },
    ],
    [
      { status: "active", since: "2026-01-31" } as const,
      "Cancel",
      "Cancel subscription",
      {
        status: "canceled",
        since: "2026-08-06",
        accessEndsOn: "2026-08-31",
      },
    ],
    [
      {
        status: "canceled",
        since: "2026-08-01",
        accessEndsOn: "2026-08-06",
      } as const,
      "Expire",
      "Expire subscription",
      { status: "expired", since: "2026-08-06" },
    ],
    [
      { status: "expired", since: "2026-08-01" } as const,
      "Restart",
      "Restart subscription",
      { status: "active", since: "2026-08-06" },
    ],
  ])(
    "confirms %s → %s through the domain lifecycle surface",
    async (initial, action, confirmName, expected) => {
      const { repository } = setup([persisted(initial)]);
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole("button", {
          name: /^Alpha streaming\. Next renewal:/u,
        }),
      );
      await user.click(screen.getByRole("button", { name: action }));
      expect(
        screen.getByRole("dialog", { name: `${action} Alpha streaming` }),
      ).toBeTruthy();
      if (action === "Cancel") {
        await user.type(
          screen.getByLabelText("Paid access ends"),
          "2026-08-31",
        );
      }
      await user.click(screen.getByRole("button", { name: confirmName }));

      await waitFor(() => expect(repository.update).toHaveBeenCalledOnce());
      expect(
        repository.update.mock.calls[0]?.[0].subscription.lifecycle,
      ).toEqual(expected);
      expect(repository.update.mock.calls[0]?.[1]).toBe(2);
    },
  );

  it("closes a failed lifecycle modal so retry remains keyboard reachable", async () => {
    const { repository } = setup();
    repository.update.mockRejectedValueOnce(new DataPlaneError("unavailable"));
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: /^Alpha streaming\. Next renewal:/u,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Pause" }));
    await user.click(
      screen.getByRole("button", { name: "Pause subscription" }),
    );

    expect(
      await screen.findByRole("button", { name: "Retry change" }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("rolls back a failed permanent delete and exposes an explicit retry", async () => {
    const { repository } = setup();
    const deleting = deferred<void>();
    repository.delete
      .mockReturnValueOnce(deleting.promise)
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: /^Alpha streaming\. Next renewal:/u,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Delete permanently" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Permanently delete" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: /^Alpha streaming\. Next renewal:/u,
        }),
      ).toBeNull(),
    );
    deleting.reject(new DataPlaneError("unavailable"));
    expect(
      await screen.findByRole("button", {
        name: /^Alpha streaming\. Next renewal:/u,
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Change not saved");
    const retry = screen.getByRole("button", { name: "Retry change" });
    retry.focus();
    expect(document.activeElement).toBe(retry);
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: /^Alpha streaming\. Next renewal:/u,
        }),
      ).toBeNull(),
    );
  });

  it("shows a generic conflict and reloads the latest server state", async () => {
    const latest = persisted(undefined, {
      subscription: {
        ...persisted().subscription,
        serviceName: "Latest server name",
      },
      metadata: { ...persisted().metadata, planName: "Winner plan" },
      version: 3,
    });
    const { repository } = setup();
    repository.update.mockRejectedValueOnce(new DataPlaneError("conflict"));
    repository.listPage.mockResolvedValueOnce({
      items: [latest],
      nextCursor: null,
      complete: true,
    });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: /^Alpha streaming\. Next renewal:/u,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Edit subscription" }));
    const plan = screen.getByRole("textbox", { name: "Plan" });
    await user.clear(plan);
    await user.type(plan, "Private local edit");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "This item changed or is unavailable. Reload before continuing.",
    );
    expect(alert.textContent).not.toContain("sub_alpha");
    expect(screen.queryByRole("dialog")).toBeNull();
    const reload = screen.getByRole("button", { name: "Reload latest" });
    reload.focus();
    expect(document.activeElement).toBe(reload);
    await user.keyboard("{Enter}");
    expect(
      await screen.findByRole("button", {
        name: /^Latest server name\. Next renewal:/u,
      }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", {
        name: /^Latest server name\. Next renewal:/u,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Edit subscription" }));
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Plan" }).value,
    ).toBe("Winner plan");
  });

  it("closes a failed edit modal so in-memory retry is keyboard reachable", async () => {
    const { repository } = setup();
    repository.update.mockRejectedValueOnce(new DataPlaneError("unavailable"));
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: /^Alpha streaming\. Next renewal:/u,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Edit subscription" }));
    await user.clear(screen.getByRole("textbox", { name: "Plan" }));
    await user.type(screen.getByRole("textbox", { name: "Plan" }), "Family");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByRole("button", { name: "Retry change" }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("restores focus to a connected fallback when the invoking control detaches", async () => {
    setup([]);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: "Add your first subscription",
      }),
    );
    await user.type(screen.getByLabelText("Service"), "Connected focus");
    await user.type(screen.getByRole("textbox", { name: "Amount" }), "1.00");
    await user.type(screen.getByLabelText("Next renewal"), "2026-09-06");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Add subscription",
      }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Add subscription" }),
    );
  });

  it("prefills canceled expiry at the paid-access boundary", async () => {
    setup([
      persisted({
        status: "canceled",
        since: "2026-08-01",
        accessEndsOn: "2026-08-31",
      }),
    ]);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: /^Alpha streaming\. Next renewal:/u,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Expire" }));

    const date = screen.getByLabelText<HTMLInputElement>("Change date");
    expect(date.value).toBe("2026-08-31");
    expect(date.min).toBe("2026-08-31");
  });

  it("formats maximum safe minor units without floating-point cent loss", async () => {
    const recurring = persisted().subscription;
    if (recurring.kind !== "recurring") throw new Error("expected_recurring");
    setup([
      persisted(undefined, {
        subscription: createRecurringSubscription({
          ...recurring,
          amount: { minorUnits: Number.MAX_SAFE_INTEGER, currency: "USD" },
        }),
      }),
    ]);

    expect(
      (await screen.findAllByText("$90,071,992,547,409.91")).length,
    ).toBeGreaterThan(0);
  });

  it("gives each ledger row a distinguishing accessible billing summary", async () => {
    setup();

    expect(
      await screen.findByRole("button", {
        name: /Alpha streaming.*Next renewal.*Aug 31, 2026.*\$12\.99.*Active/i,
      }),
    ).toBeTruthy();
  });

  it("loads the next ledger page without dropping selection or button focus", async () => {
    const alpha = persisted();
    const beta = persisted(undefined, {
      subscription: {
        ...persisted().subscription,
        id: "sub_beta",
        serviceName: "Beta storage",
      },
    });
    setup([alpha], [], {
      ledgerPages: [
        {
          items: [alpha],
          nextCursor: "ledger-page-2",
          complete: false,
        },
        { items: [beta], nextCursor: null, complete: true },
      ],
    });
    const user = userEvent.setup();
    const loadMore = await screen.findByRole("button", {
      name: "Load more subscriptions",
    });
    loadMore.focus();

    await user.click(loadMore);

    expect(
      await screen.findByRole("button", { name: /Beta storage/u }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(loadMore);
    expect(loadMore.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("2 subscriptions loaded")).toBeTruthy();
    expect(
      screen
        .getByRole("button", {
          name: /^Alpha streaming\. Next renewal:/u,
        })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("does not offer a stale one-time restart without future access truth", async () => {
    const oneTime = createOneTimeSubscription({
      kind: "one_time",
      id: "sub_alpha",
      serviceName: "Ended pass",
      amount: { minorUnits: 1299, currency: "USD" },
      timezone: "UTC",
      purchasedOn: "2026-01-01",
      accessEndsOn: "2026-07-31",
      lifecycle: { status: "expired", since: "2026-07-31" },
    });
    setup([persisted(undefined, { subscription: oneTime })]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Ended pass/ }));

    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
  });

  it("keeps expired items in Archive & history and loads retained renewal events", async () => {
    const recurring = persisted().subscription;
    if (recurring.kind !== "recurring") throw new Error("expected_recurring");
    const expired = persisted(
      { status: "expired", since: "2026-08-01" },
      {
        subscription: createRecurringSubscription({
          ...recurring,
          id: "sub_archive",
          serviceName: "Archived service",
          lifecycle: { status: "expired", since: "2026-08-01" },
        }),
      },
    );
    const expected = createExpectedRenewal(expired.subscription, "2026-08-31");
    const confirmed = confirmRenewal(expected, "2026-08-31");
    const history: PersistedRenewalEvent = {
      event: confirmed,
      version: 2,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    };
    const { renewals } = setup([persisted(), expired], [history]);
    const user = userEvent.setup();

    const archive = await screen.findByRole("region", {
      name: "Archive and history",
    });
    expect(archive.textContent).toContain("Archived service");
    await user.click(screen.getByRole("button", { name: /Archived service/ }));

    expect(await screen.findByText("Confirmed renewal")).toBeTruthy();
    expect(renewals.listPage).toHaveBeenCalledWith({
      subscriptionId: "sub_archive",
      cursor: null,
      pageSize: 20,
    });
  });

  it("routes a confirmed calendar proposal through the domain and authenticated update", async () => {
    const { repository, runtime } = setup([persisted()], [], {
      today: () => "2026-08-31",
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Calendar" }));

    const move = await screen.findByRole("button", {
      name: "Propose new billing date",
    });
    await user.click(move);
    const dialog = screen.getByRole("dialog", {
      name: "Confirm billing date change",
    });
    fireEvent.change(within(dialog).getByLabelText("Proposed billing date"), {
      target: { value: "2026-09-28" },
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Confirm billing date" }),
    );

    await waitFor(() => expect(repository.update).toHaveBeenCalledOnce());
    const [write, expectedVersion] = repository.update.mock.calls[0]!;
    expect(expectedVersion).toBe(2);
    expect(write.subscription).toMatchObject({
      id: "sub_alpha",
      startDate: "2026-09-28",
      nextRenewalDate: "2026-09-28",
      recurrence: { unit: "month", interval: 1 },
      lifecycle: { status: "active", since: "2026-01-31" },
    });
    expect(write.metadata).toEqual(persisted().metadata);
    expect(runtime.snapshot()).toMatchObject({
      status: "ready",
      selectedId: "sub_alpha",
      mutation: null,
    });
    expect(document.activeElement).toBe(
      screen.getByRole("gridcell", {
        name: /Monday, August 31, 2026/u,
      }),
    );
  });

  it("uses an in-place agenda action and hands focus to stable billing details", async () => {
    const beta = persisted(
      { status: "active", since: "2026-01-31" },
      {
        subscription: createRecurringSubscription({
          kind: "recurring",
          id: "sub_beta",
          serviceName: "Beta storage",
          amount: { minorUnits: 1599, currency: "USD" },
          timezone: "UTC",
          startDate: "2026-01-31",
          nextRenewalDate: "2026-08-31",
          recurrence: createRecurrenceRule("monthly"),
          lifecycle: createLifecycleState({
            status: "active",
            since: "2026-01-31",
          }),
        }),
      },
    );
    setup([persisted(), beta], [], { today: () => "2026-08-31" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Calendar" }));

    const detailAction = await screen.findByRole("button", {
      name: /Show details for Beta storage/u,
    });
    expect(detailAction.getAttribute("aria-controls")).toBe(
      "subscription-detail",
    );
    expect(window.location.hash).toBe("");
    await user.click(detailAction);

    const detail = screen.getByRole("complementary", {
      name: "Billing details for Beta storage",
    });
    await waitFor(() => expect(document.activeElement).toBe(detail));
    expect(detail.id).toBe("subscription-detail");
    expect(window.location.hash).toBe("");
    expect(
      screen.getByRole("status", { name: "Subscription detail result" })
        .textContent,
    ).toBe("Showing billing details for Beta storage.");
  });
});

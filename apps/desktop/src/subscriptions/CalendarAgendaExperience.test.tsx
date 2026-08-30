// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useState, type ComponentProps } from "react";
import {
  createLifecycleState,
  createOneTimeSubscription,
  createRecurrenceRule,
  createRecurringSubscription,
  type LifecycleState,
} from "@subtrack/domain";
import type {
  PersistedRenewalEvent,
  PersistedSubscription,
} from "@subtrack/data";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarAgendaExperience as CalendarAgendaExperienceView } from "./CalendarAgendaExperience";
import { buildCalendarAgenda } from "./calendar-agenda-model";
import type {
  CalendarRange,
  ManagedSubscription,
} from "./subscriptions-runtime";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function item(
  id: string,
  serviceName: string,
  startDate: string,
  nextRenewalDate: string,
  lifecycle: LifecycleState,
  recurrence = createRecurrenceRule("monthly"),
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

function oneTimeItem(
  id: string,
  serviceName: string,
  purchasedOn: string,
): ManagedSubscription {
  const record: PersistedSubscription = {
    subscription: createOneTimeSubscription({
      kind: "one_time",
      id,
      serviceName,
      amount: { minorUnits: 4900, currency: "USD" },
      timezone: "UTC",
      purchasedOn,
      accessEndsOn: null,
      lifecycle: createLifecycleState({
        status: "active",
        since: purchasedOn,
      }),
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

type CalendarTestProps = Omit<
  ComponentProps<typeof CalendarAgendaExperienceView>,
  "events"
> &
  Readonly<{ renewalEvents: readonly PersistedRenewalEvent[] }>;

function CalendarAgendaExperience({
  renewalEvents,
  onCalendarRangeChange,
  ...props
}: CalendarTestProps) {
  const [request, setRequest] = useState<CalendarRange>({
    rangeStart: "2026-07-26",
    rangeEnd: "2027-01-08",
    filter: "all",
    query: "",
  });
  const handleRangeChange = useCallback(
    (next: CalendarRange) => {
      setRequest(next);
      return onCalendarRangeChange?.(next);
    },
    [onCalendarRangeChange],
  );
  const projection = buildCalendarAgenda({
    items: props.items,
    renewalEvents,
    rangeStart: request.rangeStart,
    rangeEnd: request.rangeEnd,
    filter: request.filter,
    query: request.query,
    maxEvents: 511,
  });
  return (
    <CalendarAgendaExperienceView
      {...props}
      events={projection.events}
      onCalendarRangeChange={handleRangeChange}
    />
  );
}

describe("CalendarAgendaExperience", () => {
  it("synchronizes an accessible month grid and agenda with keyboard navigation", async () => {
    const localWrite = vi.spyOn(Storage.prototype, "setItem");
    const onSelectSubscription = vi.fn();
    const user = userEvent.setup();
    render(
      <CalendarAgendaExperience
        items={[
          item("sub_trial", "Trial design", "2026-08-15", "2026-08-15", {
            status: "trial",
            since: "2026-08-01",
            trialEndsOn: "2026-08-15",
          }),
          item("sub_alpha", "Alpha streaming", "2026-01-31", "2026-08-31", {
            status: "active",
            since: "2026-01-31",
          }),
        ]}
        renewalEvents={[]}
        selectedSubscriptionId={null}
        locale="en-US"
        timezone="America/Los_Angeles"
        today="2026-08-15"
        mutationPending={false}
        onSelectSubscription={onSelectSubscription}
        onRescheduleSubscription={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("region", { name: "Renewal calendar and agenda" }),
    ).toBeTruthy();
    const grid = screen.getByRole("grid", {
      name: "August 2026 renewal calendar",
    });
    expect(within(grid).getAllByRole("gridcell")).toHaveLength(42);
    const selected = within(grid).getByRole("gridcell", {
      name: /Saturday, August 15, 2026\. 1 event/u,
    });
    expect(selected.getAttribute("aria-selected")).toBe("true");
    expect(selected.tabIndex).toBe(0);

    const agenda = screen.getByRole("region", {
      name: "Agenda for Saturday, August 15, 2026",
    });
    const detail = within(agenda).getByRole("button", {
      name: /Show details for Trial design/u,
    });
    expect(within(agenda).getByText("Trial converts")).toBeTruthy();
    await user.click(detail);
    expect(onSelectSubscription).toHaveBeenCalledWith("sub_trial");

    selected.focus();
    await user.keyboard("{ArrowRight}");
    const nextDay = within(grid).getByRole("gridcell", {
      name: /Sunday, August 16, 2026\. No events/u,
    });
    expect(document.activeElement).toBe(nextDay);
    expect(nextDay.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Nothing scheduled for this day.")).toBeTruthy();
    expect(screen.getByText("Next in this view")).toBeTruthy();
    expect(screen.getAllByText("Alpha streaming").length).toBeGreaterThan(0);

    await user.keyboard("{PageDown}");
    expect(
      screen.getByRole("grid", {
        name: "September 2026 renewal calendar",
      }),
    ).toBeTruthy();
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(
      /September 16, 2026/u,
    );
    await user.keyboard("{PageUp}");
    expect(
      screen.getByRole("grid", {
        name: "August 2026 renewal calendar",
      }),
    ).toBeTruthy();
    expect(localWrite).not.toHaveBeenCalled();
  });

  it("keeps focused search and event filters synchronized with the agenda", async () => {
    const user = userEvent.setup();
    render(
      <CalendarAgendaExperience
        items={[
          item("sub_trial", "Trial design", "2026-08-15", "2026-08-15", {
            status: "trial",
            since: "2026-08-01",
            trialEndsOn: "2026-08-15",
          }),
          item("sub_alpha", "Alpha streaming", "2026-01-31", "2026-08-31", {
            status: "active",
            since: "2026-01-31",
          }),
        ]}
        renewalEvents={[]}
        selectedSubscriptionId={null}
        locale="en-US"
        timezone="UTC"
        today="2026-08-15"
        mutationPending={false}
        onSelectSubscription={vi.fn()}
        onRescheduleSubscription={vi.fn()}
      />,
    );

    const search = screen.getByRole("searchbox", {
      name: "Search calendar",
    });
    await user.type(search, "alpha");
    expect(
      screen.getByRole("gridcell", {
        name: /Saturday, August 15, 2026\. No events/u,
      }),
    ).toBeTruthy();
    expect(screen.queryByText("Trial design")).toBeNull();
    expect(screen.getAllByText("Alpha streaming").length).toBeGreaterThan(0);

    await user.clear(search);
    const charges = screen.getByRole("button", { name: "Charges" });
    await user.click(charges);
    expect(charges.getAttribute("aria-pressed")).toBe("true");
    await user.click(
      screen.getByRole("gridcell", {
        name: /Monday, August 31, 2026\. 1 event/u,
      }),
    );
    expect(screen.getByText("Expected charge")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Trials" }));
    expect(
      screen.getByRole("gridcell", {
        name: /Monday, August 31, 2026\. No events/u,
      }),
    ).toBeTruthy();
    expect(screen.queryByText("Expected charge")).toBeNull();
  });

  it("finds an in-range match beyond the default top-K cap", async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 257 }, (_, index) =>
      oneTimeItem(
        `sub_dense_${String(index).padStart(3, "0")}`,
        index === 256
          ? "Needle service"
          : `Archive ${String(index).padStart(3, "0")}`,
        "2026-08-20",
      ),
    );
    render(
      <CalendarAgendaExperience
        items={items}
        renewalEvents={[]}
        selectedSubscriptionId={null}
        locale="en-US"
        timezone="UTC"
        today="2026-08-20"
        mutationPending={false}
        onSelectSubscription={vi.fn()}
        onRescheduleSubscription={vi.fn()}
      />,
    );

    await user.type(
      screen.getByRole("searchbox", { name: "Search calendar" }),
      "needle",
    );

    expect(
      screen.getByRole("button", { name: /Show details for Needle service/u }),
    ).toBeTruthy();
  });

  it("distinguishes no search matches from a genuinely empty day", async () => {
    const user = userEvent.setup();
    render(
      <CalendarAgendaExperience
        items={[oneTimeItem("sub_alpha", "Alpha editor", "2026-08-20")]}
        renewalEvents={[]}
        selectedSubscriptionId={null}
        locale="en-US"
        timezone="UTC"
        today="2026-08-20"
        mutationPending={false}
        onSelectSubscription={vi.fn()}
        onRescheduleSubscription={vi.fn()}
      />,
    );

    await user.type(
      screen.getByRole("searchbox", { name: "Search calendar" }),
      "missing",
    );

    expect(
      screen.getByText("No calendar events match “missing” in this view."),
    ).toBeTruthy();
    expect(screen.queryByText("Nothing scheduled for this day.")).toBeNull();
    expect(screen.queryByText("No renewal events in this view.")).toBeNull();
  });

  it("announces equal-count search result changes while search keeps focus", async () => {
    const user = userEvent.setup();
    render(
      <CalendarAgendaExperience
        items={[
          oneTimeItem("sub_alpha", "Alpha editor", "2026-08-20"),
          oneTimeItem("sub_beta", "Beta editor", "2026-08-20"),
        ]}
        renewalEvents={[]}
        selectedSubscriptionId={null}
        locale="en-US"
        timezone="UTC"
        today="2026-08-20"
        mutationPending={false}
        onSelectSubscription={vi.fn()}
        onRescheduleSubscription={vi.fn()}
      />,
    );
    const search = screen.getByRole("searchbox", { name: "Search calendar" });
    const status = screen.getByRole("status", { name: "Calendar results" });

    await user.type(search, "alpha");
    expect(status.textContent).toBe(
      "1 calendar event matching “alpha” in this view.",
    );
    expect(document.activeElement).toBe(search);

    await user.clear(search);
    await user.type(search, "beta");
    expect(status.textContent).toBe(
      "1 calendar event matching “beta” in this view.",
    );
    expect(document.activeElement).toBe(search);
  });

  it("follows timezone today changes until the person explicitly selects a date", async () => {
    const props = {
      items: [] as readonly ManagedSubscription[],
      renewalEvents: [],
      selectedSubscriptionId: null,
      locale: "en-US",
      mutationPending: false,
      onSelectSubscription: vi.fn(),
      onRescheduleSubscription: vi.fn(),
    };
    const { rerender } = render(
      <CalendarAgendaExperience
        {...props}
        timezone="America/Los_Angeles"
        today="2026-08-15"
      />,
    );

    rerender(
      <CalendarAgendaExperience
        {...props}
        timezone="Asia/Tokyo"
        today="2026-08-16"
      />,
    );
    expect(
      screen
        .getByRole("gridcell", { name: /Sunday, August 16, 2026/u })
        .getAttribute("aria-selected"),
    ).toBe("true");

    await userEvent.click(
      screen.getByRole("gridcell", { name: /Thursday, August 20, 2026/u }),
    );
    rerender(
      <CalendarAgendaExperience
        {...props}
        timezone="Pacific/Auckland"
        today="2026-08-17"
      />,
    );
    expect(
      screen
        .getByRole("gridcell", { name: /Thursday, August 20, 2026/u })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByText(/Pacific\/Auckland/u)).toBeTruthy();
    expect(screen.getByText("No renewal events in this view.")).toBeTruthy();
  });

  it("requires confirmation for drag and keyboard billing-date proposals", async () => {
    const onRescheduleSubscription = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(
      <CalendarAgendaExperience
        items={[
          item("sub_alpha", "Alpha streaming", "2026-01-31", "2026-08-31", {
            status: "active",
            since: "2026-01-31",
          }),
        ]}
        renewalEvents={[]}
        selectedSubscriptionId="sub_alpha"
        locale="en-US"
        timezone="UTC"
        today="2026-08-31"
        mutationPending={false}
        onSelectSubscription={vi.fn()}
        onRescheduleSubscription={onRescheduleSubscription}
      />,
    );

    const move = screen.getByRole("button", {
      name: "Propose new billing date",
    });
    expect(move.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      document.getElementById(move.getAttribute("aria-describedby")!)
        ?.textContent,
    ).toBe("Alpha streaming");
    const eventRow = move.closest("li");
    if (!eventRow) throw new Error("expected agenda row");
    expect(eventRow.draggable).toBe(true);
    const transfer = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "move",
      dropEffect: "move",
      setData: (type: string, value: string) => transfer.set(type, value),
      getData: (type: string) => transfer.get(type) ?? "",
    };
    fireEvent.dragStart(eventRow, { dataTransfer });
    const target = screen.getByRole("gridcell", {
      name: /Saturday, August 29, 2026/u,
    });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    let dialog = screen.getByRole("dialog", {
      name: "Confirm billing date change",
    });
    expect(
      within(dialog).getByLabelText<HTMLInputElement>("Proposed billing date")
        .value,
    ).toBe("2026-08-29");
    expect(onRescheduleSubscription).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", { name: "Keep current date" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onRescheduleSubscription).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByRole("gridcell", {
        name: /Monday, August 31, 2026/u,
      }),
    );

    await user.click(move);
    dialog = screen.getByRole("dialog", {
      name: "Confirm billing date change",
    });
    fireEvent.change(within(dialog).getByLabelText("Proposed billing date"), {
      target: { value: "2026-09-02" },
    });
    expect(onRescheduleSubscription).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", { name: "Confirm billing date" }),
    );
    await waitFor(() =>
      expect(onRescheduleSubscription).toHaveBeenCalledWith(
        "sub_alpha",
        "2026-09-02",
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(move);
  });

  it("does not offer a schedule rewrite for a later projected occurrence", async () => {
    const user = userEvent.setup();
    render(
      <CalendarAgendaExperience
        items={[
          item("sub_alpha", "Alpha streaming", "2026-01-31", "2026-08-31", {
            status: "active",
            since: "2026-01-31",
          }),
        ]}
        renewalEvents={[]}
        selectedSubscriptionId="sub_alpha"
        locale="en-US"
        timezone="UTC"
        today="2026-08-31"
        mutationPending={false}
        onSelectSubscription={vi.fn()}
        onRescheduleSubscription={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Next month" }));

    expect(
      screen.getByRole("region", {
        name: "Agenda for Wednesday, September 30, 2026",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Expected charge")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Propose new billing date" }),
    ).toBeNull();
  });

  it("rejects a proposal before the account day without mutating", async () => {
    const onRescheduleSubscription = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(
      <CalendarAgendaExperience
        items={[
          item("sub_alpha", "Alpha streaming", "2026-01-31", "2026-08-31", {
            status: "active",
            since: "2026-01-31",
          }),
        ]}
        renewalEvents={[]}
        selectedSubscriptionId="sub_alpha"
        locale="en-US"
        timezone="UTC"
        today="2026-08-15"
        mutationPending={false}
        onSelectSubscription={vi.fn()}
        onRescheduleSubscription={onRescheduleSubscription}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Propose new billing date" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Confirm billing date change",
    });
    const date = within(dialog).getByLabelText<HTMLInputElement>(
      "Proposed billing date",
    );
    expect(date.min).toBe("2026-08-15");
    expect(date.max).toBe("2026-09-29");
    fireEvent.change(date, { target: { value: "2026-08-14" } });
    await user.click(
      within(dialog).getByRole("button", { name: "Confirm billing date" }),
    );

    expect(within(dialog).getByRole("alert").textContent).toContain(
      "Choose a billing date from August 15 through September 29, 2026.",
    );
    expect(onRescheduleSubscription).not.toHaveBeenCalled();
  });

  it("does not let a daily proposal consume the next scheduled occurrence", async () => {
    const onRescheduleSubscription = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(
      <CalendarAgendaExperience
        items={[
          item(
            "sub_daily",
            "Daily archive",
            "2026-08-31",
            "2026-08-31",
            { status: "active", since: "2026-08-31" },
            createRecurrenceRule({ unit: "day", interval: 1 }),
          ),
        ]}
        renewalEvents={[]}
        selectedSubscriptionId="sub_daily"
        locale="en-US"
        timezone="UTC"
        today="2026-08-31"
        mutationPending={false}
        onSelectSubscription={vi.fn()}
        onRescheduleSubscription={onRescheduleSubscription}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Propose new billing date" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Confirm billing date change",
    });
    const date = within(dialog).getByLabelText<HTMLInputElement>(
      "Proposed billing date",
    );
    expect(date.min).toBe("2026-08-31");
    expect(date.max).toBe("2026-08-31");
    fireEvent.change(date, { target: { value: "2026-09-01" } });
    await user.click(
      within(dialog).getByRole("button", { name: "Confirm billing date" }),
    );

    expect(within(dialog).getByRole("alert").textContent).toContain(
      "Choose a billing date on August 31, 2026.",
    );
    expect(onRescheduleSubscription).not.toHaveBeenCalled();
  });

  it("requests the visible bounded calendar window with the complete predicate", async () => {
    const onCalendarRangeChange = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(
      <CalendarAgendaExperience
        items={[]}
        renewalEvents={[]}
        selectedSubscriptionId={null}
        locale="en-US"
        timezone="UTC"
        today="2026-08-15"
        mutationPending={false}
        onSelectSubscription={vi.fn()}
        onRescheduleSubscription={vi.fn()}
        onCalendarRangeChange={onCalendarRangeChange}
      />,
    );

    await waitFor(() =>
      expect(onCalendarRangeChange).toHaveBeenCalledWith({
        rangeStart: "2026-07-26",
        rangeEnd: "2026-12-04",
        filter: "all",
        query: "",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Charges" }));
    await user.type(
      screen.getByRole("searchbox", { name: "Search calendar" }),
      "alpha",
    );
    await waitFor(() =>
      expect(onCalendarRangeChange).toHaveBeenLastCalledWith({
        rangeStart: "2026-07-26",
        rangeEnd: "2026-12-04",
        filter: "charges",
        query: "alpha",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Next month" }));
    await waitFor(() =>
      expect(onCalendarRangeChange).toHaveBeenLastCalledWith({
        rangeStart: "2026-08-30",
        rangeEnd: "2027-01-08",
        filter: "charges",
        query: "alpha",
      }),
    );
  });
});

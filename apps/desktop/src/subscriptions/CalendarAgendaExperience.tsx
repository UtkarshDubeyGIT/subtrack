import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { parseCalendarDate } from "@subtrack/domain";
import type { CalendarEvent } from "@subtrack/data";
import {
  addCalendarDays,
  createBillingDateProposalRange,
  createCalendarMonthWindow,
  isBillingDateProposalValid,
  shiftCalendarMonth,
  type CalendarAgendaEvent,
  type CalendarAgendaFilter,
  type BillingDateProposalRange,
} from "./calendar-agenda-model";
import type {
  CalendarRange,
  CalendarRangeState,
  ManagedSubscription,
} from "./subscriptions-runtime";

type CalendarAgendaExperienceProps = Readonly<{
  items: readonly ManagedSubscription[];
  events: readonly CalendarEvent[];
  selectedSubscriptionId: string | null;
  locale: string;
  timezone: string;
  today: string;
  mutationPending: boolean;
  onSelectSubscription: (id: string) => void | Promise<unknown>;
  onRescheduleSubscription: (
    id: string,
    date: string,
  ) => void | Promise<unknown>;
  onCalendarRangeChange?: (range: CalendarRange) => void | Promise<unknown>;
  calendarRangeState?: CalendarRangeState;
  onRetryCalendarRange?: () => void | Promise<unknown>;
}>;

type DateProposal = Readonly<{
  event: CalendarAgendaEvent;
  date: string;
  error: string | null;
  range: BillingDateProposalRange;
}>;

const calendarFilters: readonly Readonly<{
  value: CalendarAgendaFilter;
  label: string;
}>[] = [
  { value: "all", label: "All" },
  { value: "trials", label: "Trials" },
  { value: "charges", label: "Charges" },
  { value: "access", label: "Access" },
  { value: "changes", label: "Changes" },
];

function calendarFilterLabel(filter: CalendarAgendaFilter) {
  return (
    calendarFilters.find((candidate) => candidate.value === filter)?.label ??
    "Calendar"
  );
}

type CalendarRangeNotice = Readonly<{
  status: "pending" | "error" | "truncated";
  title: string;
  body: string;
  announcement: string;
  retryable: boolean;
}>;

function sameCalendarRange(left: CalendarRange | null, right: CalendarRange) {
  return (
    left !== null &&
    left.rangeStart === right.rangeStart &&
    left.rangeEnd === right.rangeEnd &&
    (left.filter ?? "all") === (right.filter ?? "all") &&
    (left.query ?? "").trim() === (right.query ?? "").trim()
  );
}

function calendarRangeNotice(
  state: CalendarRangeState | undefined,
  current: CalendarRange,
): CalendarRangeNotice | null {
  if (
    state === undefined ||
    (state.status === "ready" && sameCalendarRange(state.loaded, current))
  ) {
    return null;
  }
  const identity = `${current.rangeStart} through ${current.rangeEnd}`;
  if (state.status === "error" && sameCalendarRange(state.requested, current)) {
    return {
      status: "error",
      title: "Calendar range unavailable",
      body: `Saved corrections for ${identity} could not be verified. Retry before relying on projected charges.`,
      announcement: `Calendar range unavailable for ${identity}.`,
      retryable: true,
    };
  }
  if (
    state.status === "truncated" &&
    sameCalendarRange(state.requested, current)
  ) {
    return {
      status: "truncated",
      title: "Calendar range is too dense to verify",
      body: `More than 512 saved events match ${identity}. Narrow your search or filters to see a complete calendar.`,
      announcement: `Calendar range ${identity} is truncated and unavailable.`,
      retryable: true,
    };
  }
  return {
    status: "pending",
    title: "Checking saved corrections",
    body: `Verifying ${identity} before showing projected charges.`,
    announcement: `Checking saved corrections for ${identity}.`,
    retryable: false,
  };
}

export function CalendarAgendaExperience({
  items,
  events,
  selectedSubscriptionId,
  locale,
  timezone,
  today,
  mutationPending,
  onSelectSubscription,
  onRescheduleSubscription,
  onCalendarRangeChange,
  calendarRangeState,
  onRetryCalendarRange,
}: CalendarAgendaExperienceProps) {
  const displayLocale = canonicalLocale(locale);
  const [selectedDate, setSelectedDate] = useState(today);
  const [visibleMonth, setVisibleMonth] = useState(() => monthStart(today));
  const [filter, setFilter] = useState<CalendarAgendaFilter>("all");
  const [query, setQuery] = useState("");
  const [proposal, setProposal] = useState<DateProposal | null>(null);
  const [proposalSaving, setProposalSaving] = useState(false);
  const previousToday = useRef(today);
  const focusDateAfterRender = useRef(false);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const draggedEventId = useRef<string | null>(null);
  const proposalReturnFocus = useRef<HTMLElement | null>(null);
  const weekStartsOn = localeStartsOnSunday(displayLocale) ? 0 : 1;
  const monthWindow = useMemo(
    () => createCalendarMonthWindow(visibleMonth, weekStartsOn),
    [visibleMonth, weekStartsOn],
  );
  const calendarRangeEnd = addCalendarDays(monthWindow.gridEnd, 90);
  const normalizedQuery = query.trim();
  const currentCalendarRange: CalendarRange = useMemo(
    () => ({
      rangeStart: monthWindow.gridStart,
      rangeEnd: calendarRangeEnd,
      filter,
      query: normalizedQuery,
    }),
    [calendarRangeEnd, filter, monthWindow.gridStart, normalizedQuery],
  );
  const rangeAuthoritative =
    calendarRangeState === undefined ||
    (calendarRangeState.status === "ready" &&
      sameCalendarRange(calendarRangeState.loaded, currentCalendarRange));
  const rangeNotice = calendarRangeNotice(
    calendarRangeState,
    currentCalendarRange,
  );

  useEffect(() => {
    if (
      calendarRangeState !== undefined &&
      calendarRangeState.status !== "idle" &&
      sameCalendarRange(calendarRangeState.requested, currentCalendarRange)
    ) {
      return;
    }
    void onCalendarRangeChange?.({
      rangeStart: monthWindow.gridStart,
      rangeEnd: calendarRangeEnd,
      filter,
      query: normalizedQuery,
    });
  }, [
    calendarRangeEnd,
    calendarRangeState,
    currentCalendarRange,
    filter,
    monthWindow.gridStart,
    normalizedQuery,
    onCalendarRangeChange,
  ]);

  const projection = useMemo(
    () => ({
      events: rangeAuthoritative ? events : [],
      truncated:
        rangeAuthoritative &&
        calendarRangeState?.status === "ready" &&
        !calendarRangeState.complete,
    }),
    [calendarRangeState, events, rangeAuthoritative],
  );
  const visibleEvents = projection.events;
  const eventsByDate = useMemo(
    () => groupEventsByDate(visibleEvents),
    [visibleEvents],
  );
  const selectedEvents = eventsByDate.get(selectedDate) ?? [];
  const hasActivePredicate = filter !== "all" || normalizedQuery.length > 0;
  const noMatches = hasActivePredicate && projection.events.length === 0;
  const nextEvents =
    selectedEvents.length === 0
      ? visibleEvents.filter((event) => event.date > selectedDate).slice(0, 5)
      : [];

  useEffect(() => {
    if (today === previousToday.current) return;
    const priorToday = previousToday.current;
    previousToday.current = today;
    setSelectedDate((current) => {
      if (current !== priorToday) return current;
      setVisibleMonth(monthStart(today));
      return today;
    });
  }, [today]);

  useEffect(() => {
    if (!focusDateAfterRender.current) return;
    focusDateAfterRender.current = false;
    cellRefs.current.get(selectedDate)?.focus();
  }, [selectedDate, visibleMonth]);

  const selectDate = (date: string, focus: boolean) => {
    setSelectedDate(date);
    setVisibleMonth(monthStart(date));
    focusDateAfterRender.current = focus;
  };
  const navigateMonth = (delta: number, focus: boolean) => {
    selectDate(sameDayInShiftedMonth(selectedDate, delta), focus);
  };
  const monthLabel = formatMonth(visibleMonth, displayLocale);
  const selectedDateLabel = formatFullDate(selectedDate, displayLocale);
  const itemsById = useMemo(
    () =>
      new Map(
        items.map(
          (managed) => [managed.record.subscription.id, managed] as const,
        ),
      ),
    [items],
  );
  const proposalRangeFor = (event: CalendarAgendaEvent) => {
    const managed = itemsById.get(event.subscriptionId);
    if (
      event.kind !== "expected_charge" ||
      managed?.syncStatus !== "synced" ||
      managed.record.subscription.kind !== "recurring" ||
      event.date !== managed.record.subscription.nextRenewalDate ||
      mutationPending
    ) {
      return null;
    }
    return createBillingDateProposalRange(managed.record.subscription, today);
  };
  const canReschedule = (event: CalendarAgendaEvent) =>
    proposalRangeFor(event) !== null;
  const openProposal = (
    event: CalendarAgendaEvent,
    date: string,
    returnFocus?: HTMLElement | null,
  ) => {
    const range = proposalRangeFor(event);
    if (!range) return;
    proposalReturnFocus.current =
      returnFocus ??
      (document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
        ? document.activeElement
        : (cellRefs.current.get(selectedDate) ?? null));
    setProposal({
      event,
      date,
      error: proposalDateError(date, range, displayLocale),
      range,
    });
  };
  const closeProposal = () => {
    const returnFocus = proposalReturnFocus.current;
    proposalReturnFocus.current = null;
    setProposal(null);
    setProposalSaving(false);
    queueMicrotask(() => {
      const target = returnFocus?.isConnected
        ? returnFocus
        : cellRefs.current.get(selectedDate);
      target?.focus();
    });
  };
  const confirmProposal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!proposal || proposalSaving || mutationPending) return;
    const currentRange = proposalRangeFor(proposal.event);
    if (!currentRange) {
      setProposal({
        ...proposal,
        error:
          "This billing date is no longer current. Keep the saved schedule and reload the calendar.",
      });
      return;
    }
    const validationError = proposalDateError(
      proposal.date,
      currentRange,
      displayLocale,
    );
    if (validationError) {
      setProposal({
        ...proposal,
        error: validationError,
        range: currentRange,
      });
      return;
    }
    setProposalSaving(true);
    try {
      await onRescheduleSubscription(
        proposal.event.subscriptionId,
        proposal.date,
      );
      closeProposal();
    } catch {
      setProposalSaving(false);
      setProposal({
        ...proposal,
        error:
          "Billing date change could not be saved. Keep the current date and try again.",
      });
    }
  };
  const dropOnDate = (
    event: ReactDragEvent<HTMLButtonElement>,
    date: string,
  ) => {
    const id =
      draggedEventId.current ??
      event.dataTransfer.getData("application/x-subtrack-renewal");
    draggedEventId.current = null;
    const dragged = visibleEvents.find((candidate) => candidate.id === id);
    if (!dragged || !canReschedule(dragged) || dragged.date === date) return;
    event.preventDefault();
    openProposal(dragged, date);
  };

  return (
    <section
      className="calendar-agenda-experience"
      aria-label="Renewal calendar and agenda"
    >
      <header className="calendar-agenda-header">
        <div>
          <p className="eyebrow">RENEWAL CALENDAR</p>
          <h3>What changes next</h3>
          <p>
            {rangeAuthoritative
              ? `Based on your saved renewal dates in ${timezone}. Dates stay on their calendar day.`
              : `Loading your saved dates in ${timezone} before showing this range.`}
          </p>
        </div>
        <nav className="month-navigation" aria-label="Calendar month">
          <button
            type="button"
            className="secondary-button calendar-nav-button"
            aria-label="Previous month"
            onClick={() => navigateMonth(-1, false)}
          >
            <span aria-hidden="true">←</span>
          </button>
          <h4 aria-live="polite">{monthLabel}</h4>
          <button
            type="button"
            className="secondary-button calendar-nav-button"
            aria-label="Next month"
            onClick={() => navigateMonth(1, false)}
          >
            <span aria-hidden="true">→</span>
          </button>
          <button
            type="button"
            className="secondary-button today-button"
            onClick={() => selectDate(today, false)}
          >
            Today
          </button>
        </nav>
      </header>

      <div className="calendar-tools">
        <label className="calendar-search">
          <span>Search calendar</span>
          <input
            type="search"
            value={query}
            placeholder="Service, plan, or category"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <fieldset className="calendar-filter">
          <legend>Filter events</legend>
          <div>
            {calendarFilters.map((choice) => (
              <button
                key={choice.value}
                type="button"
                aria-pressed={filter === choice.value}
                onClick={() => setFilter(choice.value)}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      <p
        className="calendar-results-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label="Calendar results"
      >
        {rangeNotice?.announcement ??
          calendarResultAnnouncement(
            projection.events.length,
            filter,
            normalizedQuery,
          )}
      </p>

      {rangeNotice ? (
        <div
          className="calendar-range-state"
          data-status={rangeNotice.status}
          role={rangeNotice.status === "pending" ? "status" : "alert"}
          aria-atomic="true"
        >
          <span className="calendar-range-state-mark" aria-hidden="true" />
          <div>
            <strong>{rangeNotice.title}</strong>
            <p>{rangeNotice.body}</p>
          </div>
          {rangeNotice.retryable && onRetryCalendarRange ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => void onRetryCalendarRange()}
            >
              Retry calendar range
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="calendar-agenda-layout">
        <div className="calendar-scroll">
          <div
            key={visibleMonth}
            className="calendar-month-frame"
            data-month={visibleMonth}
          >
            <div
              className="calendar-grid"
              role="grid"
              aria-label={`${monthLabel} renewal calendar`}
            >
              <div className="calendar-week calendar-weekdays" role="row">
                {weekdayLabels(weekStartsOn, displayLocale).map((label) => (
                  <span
                    key={label.long}
                    role="columnheader"
                    aria-label={label.long}
                  >
                    {label.short}
                  </span>
                ))}
              </div>
              {Array.from({ length: 6 }, (_, weekIndex) => (
                <div className="calendar-week" role="row" key={weekIndex}>
                  {monthWindow.dates
                    .slice(weekIndex * 7, weekIndex * 7 + 7)
                    .map((date) => {
                      const dayEvents = eventsByDate.get(date) ?? [];
                      const selected = date === selectedDate;
                      const label = `${formatFullDate(date, displayLocale)}. ${
                        !rangeAuthoritative
                          ? "Events unavailable"
                          : dayEvents.length === 0
                            ? "No events"
                            : `${dayEvents.length} ${dayEvents.length === 1 ? "event" : "events"}`
                      }`;
                      return (
                        <button
                          key={date}
                          ref={(node) => {
                            if (node) cellRefs.current.set(date, node);
                            else cellRefs.current.delete(date);
                          }}
                          type="button"
                          role="gridcell"
                          className="calendar-day"
                          data-outside-month={
                            monthStart(date) !== visibleMonth || undefined
                          }
                          data-selected={selected || undefined}
                          aria-label={label}
                          aria-selected={selected}
                          aria-current={date === today ? "date" : undefined}
                          tabIndex={selected ? 0 : -1}
                          onClick={() => selectDate(date, false)}
                          onDragOver={(event) => {
                            if (!draggedEventId.current) return;
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                          }}
                          onDrop={(event) => dropOnDate(event, date)}
                          onKeyDown={(event) =>
                            handleCalendarKey(event, date, {
                              selectDate,
                              navigateMonth,
                            })
                          }
                        >
                          <span
                            className="calendar-day-number"
                            aria-hidden="true"
                          >
                            {Number(date.slice(-2))}
                          </span>
                          <span
                            className="calendar-event-notches"
                            aria-hidden="true"
                          >
                            {dayEvents.slice(0, 3).map((event) => (
                              <span
                                key={event.id}
                                className={`calendar-event-notch event-${event.kind}`}
                              />
                            ))}
                            {dayEvents.length > 3 ? (
                              <small>{`+${dayEvents.length - 3}`}</small>
                            ) : null}
                          </span>
                        </button>
                      );
                    })}
                </div>
              ))}
            </div>
          </div>
        </div>

        <aside
          className="calendar-agenda-panel"
          role="region"
          aria-label={`Agenda for ${selectedDateLabel}`}
        >
          <div className="agenda-heading">
            <p className="eyebrow">SELECTED DAY</p>
            <h4>{selectedDateLabel}</h4>
          </div>
          <div className="agenda-announcement" aria-live="polite">
            {!rangeAuthoritative
              ? "Events are unavailable until saved corrections for this range are verified."
              : selectedEvents.length === 0
                ? "No events on the selected day."
                : `${selectedEvents.length} ${selectedEvents.length === 1 ? "event" : "events"} on the selected day.`}
          </div>
          {rangeAuthoritative && noMatches ? (
            <div className="calendar-empty-account calendar-no-matches">
              <strong>
                {normalizedQuery.length > 0
                  ? `No calendar events match “${normalizedQuery}” in this view.`
                  : `No ${calendarFilterLabel(filter).toLocaleLowerCase()} events match this view.`}
              </strong>
              <p>Change the search or filter to see other private events.</p>
            </div>
          ) : null}
          {rangeAuthoritative &&
          !hasActivePredicate &&
          projection.events.length === 0 ? (
            <div className="calendar-empty-account">
              <strong>No renewal events in this view.</strong>
              <p>Add a subscription to start your private calendar.</p>
            </div>
          ) : null}
          {rangeAuthoritative && !noMatches && selectedEvents.length === 0 ? (
            <div className="empty-day-agenda">
              <p>Nothing scheduled for this day.</p>
              {nextEvents.length > 0 ? (
                <strong>Next in this view</strong>
              ) : null}
            </div>
          ) : null}
          <AgendaList
            events={
              rangeAuthoritative
                ? selectedEvents.length > 0
                  ? selectedEvents
                  : nextEvents
                : []
            }
            selectedSubscriptionId={selectedSubscriptionId}
            onSelectSubscription={onSelectSubscription}
            canReschedule={canReschedule}
            onOpenProposal={openProposal}
            onDragStart={(event, row) => {
              draggedEventId.current = event.id;
              proposalReturnFocus.current =
                row.querySelector<HTMLButtonElement>(".agenda-move-button");
            }}
            onDragEnd={() => {
              draggedEventId.current = null;
            }}
          />
          {rangeAuthoritative && projection.truncated ? (
            <p className="projection-limit-note">
              Showing the earliest 256 matching events. More events are
              available in this view.
            </p>
          ) : null}
        </aside>
      </div>

      {proposal ? (
        <DateProposalDialog
          proposal={proposal}
          locale={displayLocale}
          pending={proposalSaving || mutationPending}
          onChange={(date) =>
            setProposal({
              ...proposal,
              date,
              error: proposalDateError(date, proposal.range, displayLocale),
            })
          }
          onClose={closeProposal}
          onSubmit={(event) => void confirmProposal(event)}
        />
      ) : null}
    </section>
  );
}

function AgendaList({
  events,
  selectedSubscriptionId,
  onSelectSubscription,
  canReschedule,
  onOpenProposal,
  onDragStart,
  onDragEnd,
}: Readonly<{
  events: readonly CalendarAgendaEvent[];
  selectedSubscriptionId: string | null;
  onSelectSubscription: (id: string) => void | Promise<unknown>;
  canReschedule: (event: CalendarAgendaEvent) => boolean;
  onOpenProposal: (
    event: CalendarAgendaEvent,
    date: string,
    returnFocus?: HTMLElement | null,
  ) => void;
  onDragStart: (event: CalendarAgendaEvent, row: HTMLLIElement) => void;
  onDragEnd: () => void;
}>) {
  if (events.length === 0) return null;
  return (
    <ol className="calendar-agenda-list">
      {events.map((event) => (
        <li
          key={event.id}
          data-kind={event.kind}
          draggable={canReschedule(event)}
          onDragStart={(dragEvent) => {
            if (!canReschedule(event)) return;
            dragEvent.dataTransfer.effectAllowed = "move";
            dragEvent.dataTransfer.setData(
              "application/x-subtrack-renewal",
              event.id,
            );
            onDragStart(event, dragEvent.currentTarget);
          }}
          onDragEnd={onDragEnd}
        >
          <span
            className={`agenda-kind-mark event-${event.kind}`}
            aria-hidden="true"
          />
          <div className="agenda-event-actions">
            <button
              type="button"
              className="agenda-detail-button"
              data-selected={
                event.subscriptionId === selectedSubscriptionId || undefined
              }
              aria-label={`Show details for ${event.serviceName}. ${eventKindLabel(event.kind)} on ${event.date}`}
              aria-controls="subscription-detail"
              aria-pressed={event.subscriptionId === selectedSubscriptionId}
              onClick={() => {
                void onSelectSubscription(event.subscriptionId);
              }}
            >
              <span>
                <small>{eventKindLabel(event.kind)}</small>
                <strong id={agendaServiceDescriptionId(event.id)}>
                  {event.serviceName}
                </strong>
              </span>
              <span aria-hidden="true">↗</span>
            </button>
            {canReschedule(event) ? (
              <button
                type="button"
                className="agenda-move-button"
                aria-label="Propose new billing date"
                aria-describedby={agendaServiceDescriptionId(event.id)}
                title="Move billing date"
                onClick={(clickEvent) =>
                  onOpenProposal(event, event.date, clickEvent.currentTarget)
                }
              >
                <span aria-hidden="true">↔</span>
              </button>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function calendarResultAnnouncement(
  count: number,
  filter: CalendarAgendaFilter,
  normalizedQuery: string,
) {
  const eventLabel = count === 1 ? "event" : "events";
  if (normalizedQuery.length > 0) {
    return `${count} calendar ${eventLabel} matching “${normalizedQuery}” in this view.`;
  }
  if (filter !== "all") {
    return `${count} calendar ${eventLabel} in the ${calendarFilterLabel(filter)} filter.`;
  }
  return `${count} calendar ${eventLabel} in this view.`;
}

function DateProposalDialog({
  proposal,
  locale,
  pending,
  onChange,
  onClose,
  onSubmit,
}: Readonly<{
  proposal: DateProposal;
  locale: string;
  pending: boolean;
  onChange: (date: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}>) {
  return (
    <div className="dialog-backdrop">
      <section
        className="confirm-dialog calendar-date-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="calendar-date-dialog-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else {
            trapDialogFocus(event);
          }
        }}
      >
        <p className="eyebrow">BILLING TRUTH CHANGE</p>
        <h2 id="calendar-date-dialog-title">Confirm billing date change</h2>
        <p>
          Move {proposal.event.serviceName} from{" "}
          <strong>{formatFullDate(proposal.event.date, locale)}</strong>. Future
          projections change only after you confirm.
        </p>
        <form onSubmit={onSubmit}>
          {proposal.error ? <p role="alert">{proposal.error}</p> : null}
          <fieldset disabled={pending}>
            <label>
              Proposed billing date
              <input
                autoFocus
                type="date"
                required
                min={proposal.range.minDate}
                max={proposal.range.maxDate}
                value={proposal.date}
                onChange={(event) => onChange(event.currentTarget.value)}
              />
            </label>
          </fieldset>
          <footer className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={pending}
              onClick={onClose}
            >
              Keep current date
            </button>
            <button type="submit" disabled={pending} aria-busy={pending}>
              {pending ? "Saving…" : "Confirm billing date"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function handleCalendarKey(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  date: string,
  actions: Readonly<{
    selectDate: (date: string, focus: boolean) => void;
    navigateMonth: (delta: number, focus: boolean) => void;
  }>,
) {
  const dayDelta: Readonly<Record<string, number>> = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -7,
    ArrowDown: 7,
  };
  const delta = dayDelta[event.key];
  if (delta !== undefined) {
    event.preventDefault();
    actions.selectDate(addCalendarDays(date, delta), true);
  } else if (event.key === "PageUp" || event.key === "PageDown") {
    event.preventDefault();
    actions.navigateMonth(event.key === "PageUp" ? -1 : 1, true);
  }
}

function trapDialogFocus(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  );
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function groupEventsByDate(events: readonly CalendarAgendaEvent[]) {
  const groups = new Map<string, CalendarAgendaEvent[]>();
  for (const event of events) {
    const group = groups.get(event.date);
    if (group) group.push(event);
    else groups.set(event.date, [event]);
  }
  return groups;
}

function eventKindLabel(kind: CalendarAgendaEvent["kind"]) {
  const labels: Readonly<Record<CalendarAgendaEvent["kind"], string>> = {
    trial_deadline: "Trial converts",
    expected_charge: "Expected charge",
    one_time_purchase: "One-time purchase",
    access_expiry: "Access ends",
    paused: "Paused",
    canceled: "Canceled",
    corrected_charge: "Corrected charge",
  };
  return labels[kind];
}

function proposalDateError(
  date: string,
  range: BillingDateProposalRange,
  locale: string,
) {
  if (isBillingDateProposalValid(date, range)) return null;
  if (range.minDate === range.maxDate) {
    return `Choose a billing date on ${formatFullDateWithoutWeekday(range.minDate, locale)}.`;
  }
  return `Choose a billing date from ${formatMonthDay(range.minDate, locale)} through ${formatFullDateWithoutWeekday(range.maxDate, locale)}.`;
}

function agendaServiceDescriptionId(eventId: string) {
  return `agenda-service-${eventId.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
}

function monthStart(date: string) {
  const { year, month } = parseCalendarDate(date);
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function sameDayInShiftedMonth(date: string, delta: number) {
  const { day } = parseCalendarDate(date);
  const targetMonth = shiftCalendarMonth(monthStart(date), delta);
  const targetParts = parseCalendarDate(targetMonth);
  const lastDay = new Date(
    Date.UTC(targetParts.year, targetParts.month, 0),
  ).getUTCDate();
  return `${targetMonth.slice(0, 8)}${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

function formatMonth(date: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

function formatFullDate(date: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

function formatFullDateWithoutWeekday(date: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

function formatMonthDay(date: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

function weekdayLabels(weekStartsOn: 0 | 1, locale: string) {
  const sunday = new Date("2026-08-02T00:00:00.000Z");
  return Array.from({ length: 7 }, (_, index) => {
    const offset = (index + weekStartsOn) % 7;
    const date = new Date(sunday);
    date.setUTCDate(sunday.getUTCDate() + offset);
    return {
      short: new Intl.DateTimeFormat(locale, {
        weekday: "narrow",
        timeZone: "UTC",
      }).format(date),
      long: new Intl.DateTimeFormat(locale, {
        weekday: "long",
        timeZone: "UTC",
      }).format(date),
    };
  });
}

function localeStartsOnSunday(locale: string) {
  return /^(?:en-US|en-CA|ja-JP|ko-KR)(?:-|$)/iu.test(locale);
}

function canonicalLocale(locale: string) {
  try {
    return Intl.getCanonicalLocales(locale.replaceAll("_", "-"))[0] ?? "en-US";
  } catch {
    return "en-US";
  }
}

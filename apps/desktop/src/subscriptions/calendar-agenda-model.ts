import {
  createRecurrenceCursor,
  parseCalendarDate,
  type RecurrenceCursor,
} from "@subtrack/domain";
import type {
  PersistedRenewalEvent,
  PersistedSubscription,
} from "@subtrack/data";
import type { ManagedSubscription } from "./subscriptions-runtime";

export type CalendarAgendaEventKind =
  | "trial_deadline"
  | "expected_charge"
  | "one_time_purchase"
  | "access_expiry"
  | "paused"
  | "canceled"
  | "corrected_charge";

export type CalendarAgendaEvent = Readonly<{
  id: string;
  subscriptionId: string;
  serviceName: string;
  planName: string | null;
  category: string | null;
  date: string;
  kind: CalendarAgendaEventKind;
  originalDate?: string;
}>;

export type CalendarAgendaResult = Readonly<{
  events: readonly CalendarAgendaEvent[];
  truncated: boolean;
  work: Readonly<{
    itemsExamined: number;
    recurrenceSeeks: number;
    recurrenceAdvances: number;
    recurrenceDatesExamined: number;
  }>;
}>;

export type CalendarAgendaFilter =
  | "all"
  | "trials"
  | "charges"
  | "access"
  | "changes";

const DEFAULT_MAX_EVENTS = 256;

export type BillingDateProposalRange = Readonly<{
  minDate: string;
  maxDate: string;
}>;

export function createBillingDateProposalRange(
  subscription: PersistedSubscription["subscription"],
  today: string,
): BillingDateProposalRange | null {
  parseCalendarDate(today);
  if (
    subscription.kind !== "recurring" ||
    subscription.lifecycle.status !== "active" ||
    subscription.nextRenewalDate < today
  ) {
    return null;
  }
  const occurrenceCursor = createRecurrenceCursor({
    anchorDate: subscription.startDate,
    recurrence: subscription.recurrence,
    fromDate: subscription.nextRenewalDate,
    endDate: "9999-12-31",
    timezone: subscription.timezone,
  });
  const currentOrFollowingOccurrence = occurrenceCursor.next().date;
  const followingOccurrence =
    currentOrFollowingOccurrence === subscription.nextRenewalDate
      ? occurrenceCursor.next().date
      : currentOrFollowingOccurrence;
  const maxDate = followingOccurrence
    ? addCalendarDays(followingOccurrence, -1)
    : "9999-12-31";
  if (maxDate < today) return null;
  return { minDate: today, maxDate };
}

export function isBillingDateProposalValid(
  date: string,
  range: BillingDateProposalRange,
) {
  try {
    parseCalendarDate(date);
  } catch {
    return false;
  }
  return date >= range.minDate && date <= range.maxDate;
}

function compareEvents(left: CalendarAgendaEvent, right: CalendarAgendaEvent) {
  return (
    left.date.localeCompare(right.date) ||
    left.serviceName.localeCompare(right.serviceName) ||
    left.kind.localeCompare(right.kind) ||
    left.subscriptionId.localeCompare(right.subscriptionId) ||
    left.id.localeCompare(right.id)
  );
}

export function buildCalendarAgenda(
  _input: Readonly<{
    items: readonly ManagedSubscription[];
    renewalEvents: readonly PersistedRenewalEvent[];
    rangeStart: string;
    rangeEnd: string;
    maxEvents?: number;
    filter?: CalendarAgendaFilter;
    query?: string;
  }>,
): CalendarAgendaResult {
  parseCalendarDate(_input.rangeStart);
  parseCalendarDate(_input.rangeEnd);
  if (_input.rangeEnd < _input.rangeStart) {
    throw new Error("Calendar range end cannot precede its start");
  }
  const maxEvents = _input.maxEvents ?? DEFAULT_MAX_EVENTS;
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 511) {
    throw new Error("maxEvents must be an integer between 1 and 511");
  }
  const recordsById = new Map(
    _input.items.map(({ record }) => [record.subscription.id, record] as const),
  );
  const filter = _input.filter ?? "all";
  const query = (_input.query ?? "").trim().toLocaleLowerCase();
  const persistedOccurrenceKeys = new Set<string>();
  for (const { event } of _input.renewalEvents) {
    const identityDate =
      event.state === "corrected"
        ? event.original.occurrenceDate
        : event.occurrenceDate;
    persistedOccurrenceKeys.add(`${event.subscriptionId}:${identityDate}`);
  }
  type RecurrenceSource = Readonly<{
    record: PersistedSubscription;
    cursor: RecurrenceCursor;
  }>;
  type Candidate = Readonly<{
    event: CalendarAgendaEvent;
    recurrenceSource?: RecurrenceSource;
  }>;
  const candidates = new MinHeap<Candidate>((left, right) =>
    compareEvents(left.event, right.event),
  );
  const events: CalendarAgendaEvent[] = [];
  const queuedIds = new Set<string>();
  let recurrenceSeeks = 0;
  let recurrenceAdvances = 0;
  let recurrenceDatesExamined = 0;
  const enqueue = (
    record: PersistedSubscription,
    kind: CalendarAgendaEventKind,
    date: string,
    originalDate?: string,
    recurrenceSource?: RecurrenceSource,
    persistedIdentity?: string,
  ) => {
    if (date < _input.rangeStart || date > _input.rangeEnd) return false;
    const subscription = record.subscription;
    const id = `${subscription.id}:${kind}:${date}${
      persistedIdentity === undefined ? "" : `:${persistedIdentity}`
    }`;
    if (queuedIds.has(id)) return false;
    const event: CalendarAgendaEvent = {
      id,
      subscriptionId: subscription.id,
      serviceName: subscription.serviceName,
      planName: record.metadata.planName,
      category: record.metadata.category,
      date,
      kind,
      ...(originalDate === undefined ? {} : { originalDate }),
    };
    if (
      !eventMatchesFilter(event, filter) ||
      !eventMatchesQuery(event, query)
    ) {
      return false;
    }
    queuedIds.add(id);
    candidates.push({
      event,
      ...(recurrenceSource === undefined ? {} : { recurrenceSource }),
    });
    return true;
  };
  const queueNextRecurring = (source: RecurrenceSource) => {
    const subscription = source.record.subscription;
    if (subscription.kind !== "recurring") return;
    while (true) {
      const step = source.cursor.next();
      recurrenceSeeks += step.work.seekOperations;
      recurrenceAdvances += step.work.advanceOperations;
      recurrenceDatesExamined += step.work.datesExamined;
      if (!step.date) return;
      if (
        !persistedOccurrenceKeys.has(`${subscription.id}:${step.date}`) &&
        enqueue(source.record, "expected_charge", step.date, undefined, source)
      ) {
        return;
      }
    }
  };
  const seedRecurring = (record: PersistedSubscription, fromDate: string) => {
    const subscription = record.subscription;
    if (subscription.kind !== "recurring") return;
    queueNextRecurring({
      record,
      cursor: createRecurrenceCursor({
        anchorDate: subscription.startDate,
        recurrence: subscription.recurrence,
        fromDate,
        endDate: _input.rangeEnd,
        timezone: subscription.timezone,
      }),
    });
  };

  for (const { record } of _input.items) {
    const subscription = record.subscription;
    if (subscription.kind === "one_time") {
      enqueue(record, "one_time_purchase", subscription.purchasedOn);
      if (subscription.accessEndsOn !== null) {
        enqueue(record, "access_expiry", subscription.accessEndsOn);
      }
    }
    const lifecycle = subscription.lifecycle;
    if (lifecycle.status === "trial") {
      enqueue(record, "trial_deadline", lifecycle.trialEndsOn);
    } else if (lifecycle.status === "paused") {
      enqueue(record, "paused", lifecycle.since);
    } else if (lifecycle.status === "canceled") {
      enqueue(record, "canceled", lifecycle.since);
      enqueue(record, "access_expiry", lifecycle.accessEndsOn);
    } else if (lifecycle.status === "expired") {
      enqueue(record, "access_expiry", lifecycle.since);
    } else if (subscription.kind === "recurring") {
      const predicateProbe: CalendarAgendaEvent = {
        id: "predicate-probe",
        subscriptionId: subscription.id,
        serviceName: subscription.serviceName,
        planName: record.metadata.planName,
        category: record.metadata.category,
        date: _input.rangeStart,
        kind: "expected_charge",
      };
      if (
        eventMatchesFilter(predicateProbe, filter) &&
        eventMatchesQuery(predicateProbe, query)
      ) {
        seedRecurring(
          record,
          subscription.nextRenewalDate > _input.rangeStart
            ? subscription.nextRenewalDate
            : _input.rangeStart,
        );
      }
    }
  }

  for (const { event } of _input.renewalEvents) {
    if (event.state !== "corrected") continue;
    const record = recordsById.get(event.subscriptionId);
    if (record) {
      enqueue(
        record,
        "corrected_charge",
        event.occurrenceDate,
        event.original.occurrenceDate,
        undefined,
        event.idempotencyKey,
      );
    }
  }
  while (events.length < maxEvents && candidates.size > 0) {
    const candidate = candidates.pop();
    if (!candidate) break;
    events.push(candidate.event);
    if (candidate.recurrenceSource) {
      queueNextRecurring(candidate.recurrenceSource);
    }
  }
  return {
    events,
    truncated: candidates.size > 0,
    work: {
      itemsExamined: _input.items.length,
      recurrenceSeeks,
      recurrenceAdvances,
      recurrenceDatesExamined,
    },
  };
}

export function filterCalendarEvents(
  events: readonly CalendarAgendaEvent[],
  input: Readonly<{ filter: CalendarAgendaFilter; query: string }>,
) {
  const query = input.query.trim().toLocaleLowerCase();
  return events.filter((event) => {
    if (!eventMatchesFilter(event, input.filter)) return false;
    if (query.length === 0) return true;
    return [event.serviceName, event.planName, event.category]
      .filter((value): value is string => value !== null)
      .some((value) => value.toLocaleLowerCase().includes(query));
  });
}

function eventMatchesFilter(
  event: CalendarAgendaEvent,
  filter: CalendarAgendaFilter,
) {
  if (filter === "all") return true;
  if (filter === "trials") return event.kind === "trial_deadline";
  if (filter === "charges") {
    return (
      event.kind === "expected_charge" ||
      event.kind === "corrected_charge" ||
      event.kind === "one_time_purchase"
    );
  }
  if (filter === "access") return event.kind === "access_expiry";
  return (
    event.kind === "paused" ||
    event.kind === "canceled" ||
    event.kind === "corrected_charge"
  );
}

function eventMatchesQuery(event: CalendarAgendaEvent, query: string) {
  if (query.length === 0) return true;
  return [event.serviceName, event.planName, event.category]
    .filter((value): value is string => value !== null)
    .some((value) => value.toLocaleLowerCase().includes(query));
}

class MinHeap<T> {
  readonly #values: T[] = [];
  readonly #compare: (left: T, right: T) => number;

  constructor(compare: (left: T, right: T) => number) {
    this.#compare = compare;
  }

  get size() {
    return this.#values.length;
  }

  push(value: T) {
    this.#values.push(value);
    let index = this.#values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.#compare(this.#values[parent]!, value) <= 0) break;
      this.#values[index] = this.#values[parent]!;
      index = parent;
    }
    this.#values[index] = value;
  }

  pop() {
    const first = this.#values[0];
    const last = this.#values.pop();
    if (
      first === undefined ||
      last === undefined ||
      this.#values.length === 0
    ) {
      return first;
    }
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.#values.length) break;
      const right = left + 1;
      const child =
        right < this.#values.length &&
        this.#compare(this.#values[right]!, this.#values[left]!) < 0
          ? right
          : left;
      if (this.#compare(this.#values[child]!, last) >= 0) break;
      this.#values[index] = this.#values[child]!;
      index = child;
    }
    this.#values[index] = last;
    return first;
  }
}

export type CalendarMonthWindow = Readonly<{
  monthStart: string;
  monthEnd: string;
  gridStart: string;
  gridEnd: string;
  dates: readonly string[];
}>;

export function addCalendarDays(date: string, days: number) {
  const parts = parseCalendarDate(date);
  if (!Number.isInteger(days)) throw new Error("days must be an integer");
  return formatUtcCalendarDate(
    new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days)),
  );
}

export function shiftCalendarMonth(month: string, delta: number) {
  const parts = parseCalendarDate(month);
  if (!Number.isInteger(delta)) throw new Error("delta must be an integer");
  return formatUtcCalendarDate(
    new Date(Date.UTC(parts.year, parts.month - 1 + delta, 1)),
  );
}

export function createCalendarMonthWindow(
  date: string,
  weekStartsOn: 0 | 1,
): CalendarMonthWindow {
  const parts = parseCalendarDate(date);
  if (weekStartsOn !== 0 && weekStartsOn !== 1) {
    throw new Error("weekStartsOn must be Sunday or Monday");
  }
  const monthStart = formatUtcCalendarDate(
    new Date(Date.UTC(parts.year, parts.month - 1, 1)),
  );
  const monthEnd = formatUtcCalendarDate(
    new Date(Date.UTC(parts.year, parts.month, 0)),
  );
  const weekday = new Date(`${monthStart}T00:00:00.000Z`).getUTCDay();
  const leadingDays = (weekday - weekStartsOn + 7) % 7;
  const gridStart = addCalendarDays(monthStart, -leadingDays);
  const dates = Array.from({ length: 42 }, (_, index) =>
    addCalendarDays(gridStart, index),
  );
  return {
    monthStart,
    monthEnd,
    gridStart,
    gridEnd: dates[41]!,
    dates,
  };
}

function formatUtcCalendarDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

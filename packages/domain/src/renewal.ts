import { createMoney, type Money } from "./money";
import { parseCalendarDate, projectOccurrences } from "./recurrence";
import type { RecurringSubscription } from "./subscription";

interface RenewalBase {
  readonly idempotencyKey: string;
  readonly subscriptionId: string;
  readonly occurrenceDate: string;
  readonly amount: Money;
}

export type ExpectedRenewal = RenewalBase & Readonly<{ state: "expected" }>;
export type ConfirmedRenewal = RenewalBase &
  Readonly<{ state: "confirmed"; confirmedOn: string }>;
export type CorrectedRenewal = RenewalBase &
  Readonly<{
    state: "corrected";
    correctedOn: string;
    original: Readonly<{ occurrenceDate: string; amount: Money }>;
  }>;
export type SkippedRenewal = RenewalBase &
  Readonly<{ state: "skipped"; skippedOn: string }>;
export type RenewalEvent =
  | ExpectedRenewal
  | ConfirmedRenewal
  | CorrectedRenewal
  | SkippedRenewal;

export interface RenewalIdempotencyInput {
  readonly version: 1;
  readonly subscriptionId: string;
  readonly occurrenceDate: string;
}

export function renewalIdempotencyInput(
  subscriptionId: string,
  occurrenceDate: string,
): RenewalIdempotencyInput {
  if (
    typeof subscriptionId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(subscriptionId)
  ) {
    throw new Error("Invalid subscription id");
  }
  parseCalendarDate(occurrenceDate);
  return { version: 1, subscriptionId, occurrenceDate };
}

export function renewalIdempotencyKey(
  subscriptionId: string,
  occurrenceDate: string,
): string {
  const input = renewalIdempotencyInput(subscriptionId, occurrenceDate);
  return `renewal:v${input.version}:${input.subscriptionId}:${input.occurrenceDate}`;
}

function ownDataProperty(input: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new Error("Invalid renewal event");
  }
  return descriptor.value;
}

function snapshotMoney(input: unknown): Money {
  if (typeof input !== "object" || input === null) {
    throw new Error("Invalid renewal event");
  }
  const minorUnits = ownDataProperty(input, "minorUnits");
  const currency = ownDataProperty(input, "currency");
  if (typeof minorUnits !== "number" || typeof currency !== "string") {
    throw new Error("Invalid renewal event");
  }
  return createMoney({ minorUnits, currency });
}

function canonicalRenewalSnapshot(input: RenewalEvent): RenewalEvent {
  if (typeof input !== "object" || input === null) {
    throw new Error("Invalid renewal event");
  }
  const state = ownDataProperty(input, "state");
  const idempotencyKey = ownDataProperty(input, "idempotencyKey");
  const subscriptionId = ownDataProperty(input, "subscriptionId");
  const occurrenceDate = ownDataProperty(input, "occurrenceDate");
  const amountInput = ownDataProperty(input, "amount");
  if (
    typeof idempotencyKey !== "string" ||
    typeof subscriptionId !== "string" ||
    typeof occurrenceDate !== "string" ||
    typeof amountInput !== "object" ||
    amountInput === null
  ) {
    throw new Error("Invalid renewal event");
  }
  parseCalendarDate(occurrenceDate);
  let correctedOriginal:
    | Readonly<{ occurrenceDate: string; amount: Money }>
    | undefined;
  let correctedOn: string | undefined;
  if (state === "corrected") {
    const correctedOnInput = ownDataProperty(input, "correctedOn");
    const originalInput = ownDataProperty(input, "original");
    if (
      typeof correctedOnInput !== "string" ||
      typeof originalInput !== "object" ||
      originalInput === null
    ) {
      throw new Error("Invalid corrected renewal");
    }
    const originalOccurrenceDate = ownDataProperty(
      originalInput,
      "occurrenceDate",
    );
    const originalAmountInput = ownDataProperty(originalInput, "amount");
    if (typeof originalOccurrenceDate !== "string") {
      throw new Error("Invalid corrected renewal");
    }
    parseCalendarDate(correctedOnInput);
    parseCalendarDate(originalOccurrenceDate);
    if (correctedOnInput < originalOccurrenceDate) {
      throw new Error("correctedOn cannot be before occurrenceDate");
    }
    const originalAmount = snapshotMoney(originalAmountInput);
    if (originalAmount.minorUnits < 0) {
      throw new Error("Renewal amount cannot be negative");
    }
    correctedOn = correctedOnInput;
    correctedOriginal = {
      occurrenceDate: originalOccurrenceDate,
      amount: originalAmount,
    };
  }
  const expectedKey = renewalIdempotencyKey(
    subscriptionId,
    correctedOriginal?.occurrenceDate ?? occurrenceDate,
  );
  if (idempotencyKey !== expectedKey) {
    throw new Error("Invalid renewal idempotency key");
  }
  const amount = snapshotMoney(amountInput);
  if (amount.minorUnits < 0)
    throw new Error("Renewal amount cannot be negative");
  const base = {
    idempotencyKey: expectedKey,
    subscriptionId,
    occurrenceDate,
    amount,
  };
  if (state === "expected") return { ...base, state: "expected" };
  if (state === "confirmed") {
    const confirmedOn = ownDataProperty(input, "confirmedOn");
    if (typeof confirmedOn !== "string")
      throw new Error("Invalid renewal event");
    parseCalendarDate(confirmedOn);
    if (confirmedOn < occurrenceDate) {
      throw new Error("confirmedOn cannot be before occurrenceDate");
    }
    return { ...base, state: "confirmed", confirmedOn };
  }
  if (state === "skipped") {
    const skippedOn = ownDataProperty(input, "skippedOn");
    if (typeof skippedOn !== "string") throw new Error("Invalid renewal event");
    parseCalendarDate(skippedOn);
    if (skippedOn < occurrenceDate) {
      throw new Error("skippedOn cannot be before occurrenceDate");
    }
    return { ...base, state: "skipped", skippedOn };
  }
  if (
    state === "corrected" &&
    correctedOn !== undefined &&
    correctedOriginal !== undefined
  ) {
    return {
      ...base,
      state: "corrected",
      correctedOn,
      original: correctedOriginal,
    };
  }
  throw new Error("Invalid renewal event");
}

function freezeRenewalSnapshot(event: RenewalEvent): RenewalEvent {
  Object.freeze(event.amount);
  if (event.state === "corrected") {
    Object.freeze(event.original.amount);
    Object.freeze(event.original);
  }
  return Object.freeze(event);
}

export function createRenewalEvent(input: RenewalEvent): RenewalEvent {
  const snapshot = canonicalRenewalSnapshot(input);
  const revalidated = canonicalRenewalSnapshot(snapshot);
  return freezeRenewalSnapshot(revalidated);
}

export function createExpectedRenewal(
  subscription: Pick<RecurringSubscription, "id" | "amount">,
  occurrenceDate: string,
): ExpectedRenewal {
  if (typeof subscription !== "object" || subscription === null) {
    throw new Error("Invalid renewal event");
  }
  const subscriptionId = ownDataProperty(subscription, "id");
  const amount = snapshotMoney(ownDataProperty(subscription, "amount"));
  if (typeof subscriptionId !== "string") {
    throw new Error("Invalid renewal event");
  }
  return createRenewalEvent({
    idempotencyKey: renewalIdempotencyKey(subscriptionId, occurrenceDate),
    subscriptionId,
    occurrenceDate,
    amount,
    state: "expected",
  }) as ExpectedRenewal;
}

export function confirmRenewal(
  event: RenewalEvent,
  confirmedOn: string,
): ConfirmedRenewal {
  const canonical = createRenewalEvent(event);
  parseCalendarDate(confirmedOn);
  if (canonical.state !== "expected")
    throw new Error("Only expected renewals can be confirmed");
  if (confirmedOn < canonical.occurrenceDate)
    throw new Error("confirmedOn cannot be before occurrenceDate");
  return createRenewalEvent({
    ...canonical,
    state: "confirmed",
    confirmedOn,
  }) as ConfirmedRenewal;
}

export function skipRenewal(
  event: RenewalEvent,
  skippedOn: string,
): SkippedRenewal {
  const canonical = createRenewalEvent(event);
  parseCalendarDate(skippedOn);
  if (canonical.state !== "expected")
    throw new Error("Only expected renewals can be skipped");
  if (skippedOn < canonical.occurrenceDate)
    throw new Error("skippedOn cannot be before occurrenceDate");
  return createRenewalEvent({
    ...canonical,
    state: "skipped",
    skippedOn,
  }) as SkippedRenewal;
}

export function correctRenewal(
  event: RenewalEvent,
  correction: Readonly<{
    correctedOn: string;
    occurrenceDate: string;
    amount: Readonly<{ minorUnits: number; currency: string }>;
  }>,
): CorrectedRenewal {
  const canonical = createRenewalEvent(event);
  if (typeof correction !== "object" || correction === null) {
    throw new Error("Invalid renewal correction");
  }
  const correctedOn = ownDataProperty(correction, "correctedOn");
  const occurrenceDate = ownDataProperty(correction, "occurrenceDate");
  const amount = snapshotMoney(ownDataProperty(correction, "amount"));
  if (typeof correctedOn !== "string" || typeof occurrenceDate !== "string") {
    throw new Error("Invalid renewal event");
  }
  parseCalendarDate(correctedOn);
  parseCalendarDate(occurrenceDate);
  if (canonical.state !== "expected" && canonical.state !== "confirmed") {
    throw new Error("Only expected or confirmed renewals can be corrected");
  }
  if (correctedOn < canonical.occurrenceDate)
    throw new Error("correctedOn cannot be before occurrenceDate");
  if (amount.minorUnits < 0)
    throw new Error("Renewal amount cannot be negative");
  return createRenewalEvent({
    idempotencyKey: canonical.idempotencyKey,
    subscriptionId: canonical.subscriptionId,
    occurrenceDate,
    amount,
    state: "corrected",
    correctedOn,
    original: {
      occurrenceDate: canonical.occurrenceDate,
      amount: canonical.amount,
    },
  }) as CorrectedRenewal;
}

export interface AdvanceRenewalsResult {
  readonly subscription: RecurringSubscription;
  readonly events: readonly ExpectedRenewal[];
  readonly hasMoreDue: boolean;
}

function nextCalendarDate(value: string): string {
  const { year, month, day } = parseCalendarDate(value);
  return new Date(Date.UTC(year, month - 1, day + 1))
    .toISOString()
    .slice(0, 10);
}

export function advanceDueRenewals(
  subscription: RecurringSubscription,
  asOfDate: string,
  maxEvents: number,
): AdvanceRenewalsResult {
  parseCalendarDate(asOfDate);
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 512) {
    throw new Error("maxEvents must be an integer between 1 and 512");
  }
  if (
    subscription.lifecycle.status !== "active" &&
    subscription.lifecycle.status !== "trial"
  ) {
    return { subscription, events: [], hasMoreDue: false };
  }
  const eligibleFromDate =
    subscription.lifecycle.status === "active" &&
    subscription.lifecycle.since > subscription.nextRenewalDate
      ? subscription.lifecycle.since
      : subscription.nextRenewalDate;
  const [eligibleNextRenewal] = projectOccurrences({
    anchorDate: subscription.startDate,
    recurrence: subscription.recurrence,
    fromDate: eligibleFromDate,
    endDate: "9999-12-31",
    maxCount: 1,
    timezone: subscription.timezone,
  });
  if (eligibleNextRenewal === undefined)
    throw new Error("Recurrence has no next renewal");
  const eligibleSubscription: RecurringSubscription = {
    ...subscription,
    nextRenewalDate: eligibleNextRenewal,
  };
  if (eligibleNextRenewal > asOfDate) {
    return {
      subscription: eligibleSubscription,
      events: [],
      hasMoreDue: false,
    };
  }

  const dueDates = projectOccurrences({
    anchorDate: subscription.startDate,
    recurrence: subscription.recurrence,
    fromDate: eligibleNextRenewal,
    endDate: asOfDate,
    maxCount: maxEvents,
    timezone: subscription.timezone,
  });
  if (dueDates.length === 0)
    throw new Error("nextRenewalDate is not reachable by recurrence");
  const lastDueDate = dueDates[dueDates.length - 1];
  if (lastDueDate === undefined)
    throw new Error("Unreachable empty renewal batch");
  const [nextRenewalDate] = projectOccurrences({
    anchorDate: subscription.startDate,
    recurrence: subscription.recurrence,
    fromDate: nextCalendarDate(lastDueDate),
    endDate: "9999-12-31",
    maxCount: 1,
    timezone: subscription.timezone,
  });
  if (nextRenewalDate === undefined)
    throw new Error("Recurrence has no next renewal");

  const advanced: RecurringSubscription = {
    ...eligibleSubscription,
    nextRenewalDate,
  };
  return {
    subscription: advanced,
    events: dueDates.map((date) =>
      createExpectedRenewal(eligibleSubscription, date),
    ),
    hasMoreDue: nextRenewalDate <= asOfDate,
  };
}

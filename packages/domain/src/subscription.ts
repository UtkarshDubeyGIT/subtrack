import {
  createLifecycleState,
  transitionLifecycle,
  type LifecycleState,
} from "./lifecycle";
import { createMoney, type Money } from "./money";
import {
  assertTimezone,
  createRecurrenceRule,
  parseCalendarDate,
  projectOccurrences,
  type RecurrenceRule,
} from "./recurrence";

interface SubscriptionBase {
  readonly id: string;
  readonly serviceName: string;
  readonly amount: Money;
  readonly timezone: string;
  readonly lifecycle: LifecycleState;
}

export interface RecurringSubscription extends SubscriptionBase {
  readonly kind: "recurring";
  readonly startDate: string;
  readonly nextRenewalDate: string;
  readonly recurrence: RecurrenceRule;
}

export interface OneTimeSubscription extends SubscriptionBase {
  readonly kind: "one_time";
  readonly purchasedOn: string;
  readonly accessEndsOn: string | null;
}

type AmountInput = Readonly<{ minorUnits: number; currency: string }>;

export interface RecurringSubscriptionInput {
  readonly kind: "recurring";
  readonly id: string;
  readonly serviceName: string;
  readonly amount: AmountInput;
  readonly timezone: string;
  readonly startDate: string;
  readonly nextRenewalDate: string;
  readonly recurrence: RecurrenceRule;
  readonly lifecycle: LifecycleState;
}

export interface OneTimeSubscriptionInput {
  readonly kind: "one_time";
  readonly id: string;
  readonly serviceName: string;
  readonly amount: AmountInput;
  readonly timezone: string;
  readonly purchasedOn: string;
  readonly accessEndsOn: string | null;
  readonly lifecycle: LifecycleState;
}

function validatedBase(input: {
  readonly id: string;
  readonly serviceName: string;
  readonly amount: AmountInput;
  readonly timezone: string;
  readonly lifecycle: LifecycleState;
}): SubscriptionBase {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.id !== "string" ||
    typeof input.serviceName !== "string" ||
    typeof input.timezone !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.id)
  )
    throw new Error("Invalid subscription id");
  const serviceName = input.serviceName.trim();
  if (serviceName.length === 0 || serviceName.length > 160) {
    throw new Error("Invalid service name");
  }
  const amount = createMoney(input.amount);
  if (amount.minorUnits < 0)
    throw new Error("Subscription amount cannot be negative");
  assertTimezone(input.timezone);
  return {
    id: input.id,
    serviceName,
    amount,
    timezone: input.timezone,
    lifecycle: createLifecycleState(input.lifecycle),
  };
}

export function createRecurringSubscription(
  input: RecurringSubscriptionInput,
): RecurringSubscription {
  if (
    typeof input !== "object" ||
    input === null ||
    !Object.hasOwn(input, "kind") ||
    input.kind !== "recurring" ||
    !Object.hasOwn(input, "recurrence")
  )
    throw new Error("Expected recurring subscription");
  parseCalendarDate(input.startDate);
  parseCalendarDate(input.nextRenewalDate);
  if (input.nextRenewalDate < input.startDate) {
    throw new Error("nextRenewalDate cannot be before startDate");
  }
  const recurrence = createRecurrenceRule(input.recurrence);
  const [alignedRenewal] = projectOccurrences({
    anchorDate: input.startDate,
    recurrence,
    fromDate: input.nextRenewalDate,
    endDate: input.nextRenewalDate,
    maxCount: 1,
    timezone: input.timezone,
  });
  if (alignedRenewal !== input.nextRenewalDate) {
    throw new Error("nextRenewalDate must be an occurrence of the recurrence");
  }
  return {
    ...validatedBase(input),
    kind: "recurring",
    startDate: input.startDate,
    nextRenewalDate: input.nextRenewalDate,
    recurrence,
  };
}

export function createOneTimeSubscription(
  input: OneTimeSubscriptionInput,
): OneTimeSubscription {
  if (
    typeof input !== "object" ||
    input === null ||
    !Object.hasOwn(input, "kind") ||
    input.kind !== "one_time"
  )
    throw new Error("Expected one-time subscription");
  if (Object.hasOwn(input, "recurrence"))
    throw new Error("One-time subscriptions cannot have recurrence");
  parseCalendarDate(input.purchasedOn);
  if (input.accessEndsOn !== null) {
    if (typeof input.accessEndsOn !== "string") {
      throw new Error("Invalid access end date");
    }
    parseCalendarDate(input.accessEndsOn);
    if (input.accessEndsOn < input.purchasedOn) {
      throw new Error("accessEndsOn cannot be before purchasedOn");
    }
  }
  return {
    ...validatedBase(input),
    kind: "one_time",
    purchasedOn: input.purchasedOn,
    accessEndsOn: input.accessEndsOn,
  };
}

export function expireOneTimeIfDue(
  subscription: OneTimeSubscription,
  asOfDate: string,
): OneTimeSubscription {
  parseCalendarDate(asOfDate);
  if (
    subscription.accessEndsOn === null ||
    asOfDate < subscription.accessEndsOn ||
    subscription.lifecycle.status !== "active"
  ) {
    return subscription;
  }
  return {
    ...subscription,
    lifecycle: transitionLifecycle(subscription.lifecycle, {
      type: "expire",
      on: subscription.accessEndsOn,
    }),
  };
}

export function resumeRecurringSubscription(
  subscription: RecurringSubscription,
  resumeOn: string,
): RecurringSubscription {
  return reactivateRecurringSubscription(subscription, "resume", resumeOn);
}

export function restartRecurringSubscription(
  subscription: RecurringSubscription,
  restartOn: string,
): RecurringSubscription {
  return reactivateRecurringSubscription(subscription, "restart", restartOn);
}

function reactivateRecurringSubscription(
  subscription: RecurringSubscription,
  type: "resume" | "restart",
  on: string,
) {
  const lifecycle = transitionLifecycle(subscription.lifecycle, { type, on });
  const [nextRenewalDate] = projectOccurrences({
    anchorDate: subscription.startDate,
    recurrence: subscription.recurrence,
    fromDate: on,
    endDate: "9999-12-31",
    maxCount: 1,
    timezone: subscription.timezone,
  });
  if (nextRenewalDate === undefined)
    throw new Error("Recurrence has no reactivation occurrence");
  return { ...subscription, lifecycle, nextRenewalDate };
}

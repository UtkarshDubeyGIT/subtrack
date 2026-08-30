import {
  createLifecycleState,
  createMoney,
  createOneTimeSubscription,
  createRecurrenceRule,
  createRecurringSubscription,
  currencyExponent,
  parseCalendarDate,
  type RecurrencePreset,
  type RecurrenceUnit,
} from "@subtrack/domain";
import {
  containsProhibitedSubscriptionSecret,
  type PersistedSubscription,
  type SubscriptionWrite,
} from "@subtrack/data";

export type SubscriptionKind = "recurring" | "one_time";
export type RecurrenceChoice = RecurrencePreset | "custom";

export type SubscriptionDraft = Readonly<{
  kind: SubscriptionKind;
  serviceName: string;
  planName: string;
  amount: string;
  currency: string;
  timezone: string;
  startDate: string;
  nextRenewalDate: string;
  recurrence: RecurrenceChoice;
  customRecurrenceUnit: RecurrenceUnit;
  customRecurrenceInterval: string;
  trialEndsOn: string;
  purchasedOn: string;
  accessEndsOn: string;
  accountEmail: string;
  paymentLabel: string;
  managementUrl: string;
  category: string;
  notes: string;
  curatedDefaults: Readonly<{
    category: string | null;
    managementUrl: string | null;
    categoryCustomized: boolean;
    managementUrlCustomized: boolean;
  }>;
}>;

export type SubscriptionDraftErrors = Readonly<
  Partial<Record<keyof SubscriptionDraft, string>>
>;

export type SubscriptionDraftResult =
  | Readonly<{ success: true; write: SubscriptionWrite }>
  | Readonly<{ success: false; errors: SubscriptionDraftErrors }>;

export const CURATED_SERVICES = Object.freeze([
  {
    name: "Netflix",
    category: "Streaming",
    managementUrl: "https://www.netflix.com/account",
  },
  {
    name: "Spotify",
    category: "Music",
    managementUrl: "https://www.spotify.com/account",
  },
  {
    name: "Adobe Creative Cloud",
    category: "Creative tools",
    managementUrl: "https://account.adobe.com/plans",
  },
  {
    name: "GitHub",
    category: "Developer tools",
    managementUrl: "https://github.com/settings/billing",
  },
  {
    name: "Notion",
    category: "Productivity",
    managementUrl: "https://www.notion.so/my-integrations",
  },
] as const);

export function createSubscriptionDraft(defaults: {
  homeCurrency: string;
  timezone: string;
}): SubscriptionDraft {
  return {
    kind: "recurring",
    serviceName: "",
    planName: "",
    amount: "",
    currency: defaults.homeCurrency,
    timezone: defaults.timezone,
    startDate: "",
    nextRenewalDate: "",
    recurrence: "monthly",
    customRecurrenceUnit: "month",
    customRecurrenceInterval: "1",
    trialEndsOn: "",
    purchasedOn: "",
    accessEndsOn: "",
    accountEmail: "",
    paymentLabel: "",
    managementUrl: "",
    category: "",
    notes: "",
    curatedDefaults: {
      category: null,
      managementUrl: null,
      categoryCustomized: false,
      managementUrlCustomized: false,
    },
  };
}

export function applyCuratedServiceDefaults(
  draft: SubscriptionDraft,
  serviceName: string,
): SubscriptionDraft {
  const match = CURATED_SERVICES.find(
    (service) =>
      service.name.toLowerCase() === serviceName.trim().toLowerCase(),
  );
  const categoryCustomized =
    draft.curatedDefaults.categoryCustomized ||
    (draft.curatedDefaults.category !== null &&
      draft.category !== draft.curatedDefaults.category);
  const managementUrlCustomized =
    draft.curatedDefaults.managementUrlCustomized ||
    (draft.curatedDefaults.managementUrl !== null &&
      draft.managementUrl !== draft.curatedDefaults.managementUrl);
  if (!match) {
    return {
      ...draft,
      serviceName,
      category: categoryCustomized ? draft.category : "",
      managementUrl: managementUrlCustomized ? draft.managementUrl : "",
      curatedDefaults: {
        category: null,
        managementUrl: null,
        categoryCustomized,
        managementUrlCustomized,
      },
    };
  }
  return {
    ...draft,
    serviceName: match.name,
    category: categoryCustomized ? draft.category : match.category,
    managementUrl: managementUrlCustomized
      ? draft.managementUrl
      : match.managementUrl,
    curatedDefaults: {
      category: categoryCustomized ? null : match.category,
      managementUrl: managementUrlCustomized ? null : match.managementUrl,
      categoryCustomized,
      managementUrlCustomized,
    },
  };
}

export function validateSubscriptionDraft(
  draft: SubscriptionDraft,
  context: Readonly<{ id: string; today: string }>,
): SubscriptionDraftResult {
  const errors: Partial<Record<keyof SubscriptionDraft, string>> = {};
  const serviceName = draft.serviceName.trim();
  if (!serviceName) errors.serviceName = "Enter a service name.";
  else if (serviceName.length > 160)
    errors.serviceName = "Use 160 characters or fewer.";
  else if (containsProhibitedSubscriptionSecret(serviceName))
    errors.serviceName = sensitiveMessage;

  let minorUnits: number | undefined;
  if (!draft.amount.trim()) errors.amount = "Enter an amount.";
  else {
    try {
      minorUnits = parseMinorUnits(draft.amount, draft.currency);
    } catch {
      errors.amount = "Enter a valid amount for this currency.";
    }
  }

  try {
    currencyExponent(draft.currency);
  } catch {
    errors.currency = "Use a supported three-letter currency code.";
  }
  try {
    parseCalendarDate(context.today);
  } catch {
    errors.timezone =
      "Calendar defaults are unavailable. Reload and try again.";
  }

  const planName = optionalText(draft.planName, 160, "planName", errors);
  const category = optionalText(draft.category, 80, "category", errors);
  const paymentLabel = optionalText(
    draft.paymentLabel,
    80,
    "paymentLabel",
    errors,
  );
  const notes = optionalText(draft.notes, 4000, "notes", errors);
  const accountEmail = optionalValue(draft.accountEmail);
  if (
    accountEmail !== null &&
    (accountEmail.length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(accountEmail))
  ) {
    errors.accountEmail = "Enter a valid account email.";
  } else if (
    accountEmail !== null &&
    containsProhibitedSubscriptionSecret(accountEmail)
  ) {
    errors.accountEmail = sensitiveMessage;
  }
  const managementUrl = optionalValue(draft.managementUrl);
  if (managementUrl !== null) {
    try {
      const url = new URL(managementUrl);
      if (
        url.protocol !== "https:" ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        managementUrl.length > 2048
      ) {
        throw new Error("invalid");
      }
      if (containsProhibitedSubscriptionSecret(managementUrl)) {
        errors.managementUrl = sensitiveMessage;
      }
    } catch {
      errors.managementUrl = "Use an https link without embedded credentials.";
    }
  }

  if (draft.kind === "recurring" && !draft.nextRenewalDate.trim()) {
    errors.nextRenewalDate = "Choose the next renewal date.";
  }
  if (draft.kind === "one_time" && !draft.purchasedOn.trim()) {
    errors.purchasedOn = "Choose the purchase date.";
  }
  if (Object.keys(errors).length > 0 || minorUnits === undefined) {
    return { success: false, errors };
  }

  const metadata = {
    planName,
    accountEmail,
    paymentLabel,
    managementUrl,
    category,
    notes,
  };
  try {
    const amount = createMoney({ minorUnits, currency: draft.currency });
    if (draft.kind === "one_time") {
      const purchasedOn = draft.purchasedOn.trim();
      const accessEndsOn = optionalValue(draft.accessEndsOn);
      return {
        success: true,
        write: {
          subscription: createOneTimeSubscription({
            kind: "one_time",
            id: context.id,
            serviceName,
            amount,
            timezone: draft.timezone,
            purchasedOn,
            accessEndsOn,
            lifecycle: createLifecycleState({
              status: "active",
              since: context.today,
            }),
          }),
          metadata,
        },
      };
    }

    const nextRenewalDate = draft.nextRenewalDate.trim();
    const startDate = draft.startDate.trim() || nextRenewalDate;
    const recurrence =
      draft.recurrence === "custom"
        ? createRecurrenceRule({
            unit: draft.customRecurrenceUnit,
            interval: Number(draft.customRecurrenceInterval),
          })
        : createRecurrenceRule(draft.recurrence);
    const trialEndsOn = optionalValue(draft.trialEndsOn);
    const lifecycle =
      trialEndsOn === null
        ? createLifecycleState({ status: "active", since: context.today })
        : createLifecycleState({
            status: "trial",
            since: startDate,
            trialEndsOn,
          });
    return {
      success: true,
      write: {
        subscription: createRecurringSubscription({
          kind: "recurring",
          id: context.id,
          serviceName,
          amount,
          timezone: draft.timezone,
          startDate,
          nextRenewalDate,
          recurrence,
          lifecycle,
        }),
        metadata,
      },
    };
  } catch {
    const field =
      draft.kind === "recurring" ? "nextRenewalDate" : "purchasedOn";
    return {
      success: false,
      errors: {
        [field]:
          draft.kind === "recurring"
            ? "Use a valid renewal date aligned with the recurrence."
            : "Use valid purchase and access dates.",
      },
    };
  }
}

export function draftFromPersistedSubscription(
  persisted: PersistedSubscription,
): SubscriptionDraft {
  const { subscription, metadata } = persisted;
  const recurrence =
    subscription.kind === "recurring"
      ? recurrenceChoice(
          subscription.recurrence.unit,
          subscription.recurrence.interval,
        )
      : "monthly";
  return {
    kind: subscription.kind,
    serviceName: subscription.serviceName,
    planName: metadata.planName ?? "",
    amount: formatMinorUnits(
      subscription.amount.minorUnits,
      subscription.amount.exponent,
    ),
    currency: subscription.amount.currency,
    timezone: subscription.timezone,
    startDate: subscription.kind === "recurring" ? subscription.startDate : "",
    nextRenewalDate:
      subscription.kind === "recurring" ? subscription.nextRenewalDate : "",
    recurrence,
    customRecurrenceUnit:
      subscription.kind === "recurring"
        ? subscription.recurrence.unit
        : "month",
    customRecurrenceInterval:
      subscription.kind === "recurring"
        ? String(subscription.recurrence.interval)
        : "1",
    trialEndsOn:
      subscription.lifecycle.status === "trial"
        ? subscription.lifecycle.trialEndsOn
        : "",
    purchasedOn:
      subscription.kind === "one_time" ? subscription.purchasedOn : "",
    accessEndsOn:
      subscription.kind === "one_time" ? (subscription.accessEndsOn ?? "") : "",
    accountEmail: metadata.accountEmail ?? "",
    paymentLabel: metadata.paymentLabel ?? "",
    managementUrl: metadata.managementUrl ?? "",
    category: metadata.category ?? "",
    notes: metadata.notes ?? "",
    curatedDefaults: {
      category: null,
      managementUrl: null,
      categoryCustomized: true,
      managementUrlCustomized: true,
    },
  };
}

function optionalText(
  value: string,
  maximum: number,
  field: keyof SubscriptionDraft,
  errors: Partial<Record<keyof SubscriptionDraft, string>>,
) {
  const normalized = optionalValue(value);
  if (normalized === null) return null;
  if (normalized.length > maximum) {
    errors[field] = `Use ${maximum} characters or fewer.`;
  } else if (containsProhibitedSubscriptionSecret(normalized)) {
    errors[field] = sensitiveMessage;
  }
  return normalized;
}

function optionalValue(value: string) {
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function parseMinorUnits(value: string, currency: string) {
  const exponent = currencyExponent(currency);
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(value.trim());
  if (!match) throw new Error("invalid_amount");
  const fraction = match[2] ?? "";
  if (fraction.length > exponent) throw new Error("invalid_amount");
  const scale = 10 ** exponent;
  const whole = Number(match[1]);
  const fractional = Number(fraction.padEnd(exponent, "0") || "0");
  const result = whole * scale + fractional;
  if (!Number.isSafeInteger(result)) throw new Error("invalid_amount");
  return result;
}

function formatMinorUnits(minorUnits: number, exponent: number) {
  if (exponent === 0) return String(minorUnits);
  const scale = 10 ** exponent;
  const whole = Math.floor(minorUnits / scale);
  const fraction = String(minorUnits % scale).padStart(exponent, "0");
  return `${whole}.${fraction}`;
}

function recurrenceChoice(
  unit: RecurrenceUnit,
  interval: number,
): RecurrenceChoice {
  if (unit === "week" && interval === 1) return "weekly";
  if (unit === "month" && interval === 1) return "monthly";
  if (unit === "month" && interval === 3) return "quarterly";
  if (unit === "month" && interval === 6) return "semiannual";
  if (unit === "year" && interval === 1) return "annual";
  return "custom";
}

const sensitiveMessage =
  "Remove card numbers, security codes, passwords, or recovery codes.";

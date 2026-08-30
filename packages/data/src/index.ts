import {
  assertTimezone,
  confirmRenewal,
  correctRenewal,
  currencyExponent,
  createLifecycleState,
  createMoney,
  createOneTimeSubscription,
  createRecurringSubscription,
  createRenewalEvent,
  parseCalendarDate,
  skipRenewal,
  type ExpectedRenewal,
  type OneTimeSubscription,
  type RecurringSubscription,
  type RenewalEvent,
} from "@subtrack/domain";
import { z } from "zod";
import {
  createDataPlaneTransport,
  DataPlaneError,
  type DataPlaneClientOptions,
  type DataPlaneTransport,
} from "./internal-transport";

export { DataPlaneError } from "./internal-transport";
export type {
  DataPlaneAccessTokenLease,
  DataPlaneClientOptions,
} from "./internal-transport";

export type Subscription = RecurringSubscription | OneTimeSubscription;

export type SubscriptionMetadata = Readonly<{
  planName: string | null;
  accountEmail: string | null;
  paymentLabel: string | null;
  managementUrl: string | null;
  category: string | null;
  notes: string | null;
}>;

export type SubscriptionMetadataInput = Readonly<
  Omit<SubscriptionMetadata, "category"> & { category?: string | null }
>;

export type SubscriptionWrite = Readonly<{
  subscription: Subscription;
  metadata: SubscriptionMetadataInput;
}>;

export type PersistedSubscription = Readonly<{
  subscription: Subscription;
  metadata: SubscriptionMetadata;
  version: number;
  createdAt: string;
  updatedAt: string;
}>;

const timestamp = z.string().datetime({ offset: true });
const collectionPageSize = 1000;
type CursorValue = string | number;
const opaqueCursorSchema = z.string().regex(/^[a-f0-9]{32}$/u);
type CollectionKeyset<T> = Readonly<{
  columns: readonly string[];
  values: (row: T) => readonly CursorValue[];
  compareRows?: (left: T, right: T) => number;
}>;
const subscriptionProjection = [
  "owner_user_id",
  "id",
  "kind",
  "service_name",
  "plan_name",
  "amount_minor",
  "currency_code",
  "timezone",
  "lifecycle_status",
  "lifecycle_since",
  "trial_ends_on",
  "lifecycle_access_ends_on",
  "start_date",
  "purchased_on",
  "access_ends_on",
  "next_renewal_date",
  "recurrence_unit",
  "recurrence_interval",
  "account_email",
  "payment_label",
  "management_url",
  "category",
  "notes",
  "version",
  "created_at",
  "updated_at",
].join(",");
const preferencesProjection = [
  "owner_user_id",
  "timezone",
  "home_currency",
  "reminder_lead_days",
  "email_reminders_enabled",
  "locale",
  "version",
  "created_at",
  "updated_at",
].join(",");
const renewalProjection = [
  "owner_user_id",
  "idempotency_key",
  "subscription_id",
  "occurrence_date",
  "amount_minor",
  "currency_code",
  "state",
  "confirmed_on",
  "corrected_on",
  "skipped_on",
  "original_occurrence_date",
  "original_amount_minor",
  "original_currency_code",
  "version",
  "created_at",
  "updated_at",
].join(",");
const reminderOverrideProjection = [
  "owner_user_id",
  "subscription_id",
  "lead_days",
  "channels",
  "version",
  "created_at",
  "updated_at",
].join(",");
const reminderDeliveryProjection = [
  "owner_user_id",
  "idempotency_key",
  "subscription_id",
  "occurrence_date",
  "channel",
  "state",
  "attempt_count",
  "scheduled_for",
  "delivered_at",
  "error_code",
  "version",
  "created_at",
  "updated_at",
].join(",");
const fxRateProjection = [
  "base_currency",
  "quote_currency",
  "rate::text",
  "effective_at",
  "provider_code",
  "created_at",
].join(",");
const auditEventProjection = [
  "owner_user_id",
  "id",
  "event_type",
  "occurred_at",
  "request_id",
  "version",
  "created_at",
  "updated_at",
].join(",");

const credentialFreeHttpsUrl = z
  .url({ protocol: /^https$/ })
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return url.username.length === 0 && url.password.length === 0;
  })
  .refine((value) => !containsProhibitedSubscriptionSecret(value));
const accountEmailSchema = z
  .string()
  .email()
  .max(320)
  .refine((value) => !containsProhibitedSubscriptionSecret(value));
const paymentLabelSchema = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => !containsProhibitedSubscriptionSecret(value));
const subscriptionNotesSchema = z
  .string()
  .max(4000)
  .refine((value) => !containsProhibitedSubscriptionSecret(value));
const safeMetadataTextSchema = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => !containsProhibitedSubscriptionSecret(value));
const subscriptionMetadataSchema = z
  .object({
    planName: safeMetadataTextSchema(160).nullable(),
    accountEmail: accountEmailSchema.nullable(),
    paymentLabel: paymentLabelSchema.nullable(),
    managementUrl: credentialFreeHttpsUrl.nullable(),
    category: safeMetadataTextSchema(80).nullable().default(null),
    notes: subscriptionNotesSchema.nullable(),
  })
  .strict();
const subscriptionRowSchema = z
  .object({
    id: z.string().min(1).max(128),
    owner_user_id: z.string().min(1).max(512),
    kind: z.enum(["recurring", "one_time"]),
    service_name: safeMetadataTextSchema(160),
    plan_name: z.string().min(1).max(160).nullable(),
    amount_minor: z.number().int().safe().nonnegative(),
    currency_code: z.string().length(3),
    timezone: z.string().min(1).max(128),
    lifecycle_status: z.enum([
      "trial",
      "active",
      "paused",
      "canceled",
      "expired",
    ]),
    lifecycle_since: z.string(),
    trial_ends_on: z.string().nullable(),
    lifecycle_access_ends_on: z.string().nullable(),
    start_date: z.string().nullable(),
    purchased_on: z.string().nullable(),
    access_ends_on: z.string().nullable(),
    next_renewal_date: z.string().nullable(),
    recurrence_unit: z.enum(["day", "week", "month", "year"]).nullable(),
    recurrence_interval: z.number().int().min(1).max(1200).nullable(),
    account_email: accountEmailSchema.nullable(),
    payment_label: paymentLabelSchema.nullable(),
    management_url: credentialFreeHttpsUrl.nullable(),
    category: safeMetadataTextSchema(80).nullable(),
    notes: subscriptionNotesSchema.nullable(),
    version: z.number().int().positive(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict()
  .superRefine((row, context) => {
    const valid =
      row.kind === "recurring"
        ? row.start_date !== null &&
          row.purchased_on === null &&
          row.access_ends_on === null &&
          row.next_renewal_date !== null &&
          row.recurrence_unit !== null &&
          row.recurrence_interval !== null
        : row.start_date === null &&
          row.purchased_on !== null &&
          row.next_renewal_date === null &&
          row.recurrence_unit === null &&
          row.recurrence_interval === null;
    if (!valid) context.addIssue({ code: "custom", message: "invalid" });
  });
const subscriptionPageSchema = z
  .object({
    items: z.array(subscriptionRowSchema).max(100),
    next_cursor: opaqueCursorSchema.nullable(),
    complete: z.boolean(),
  })
  .strict()
  .superRefine((page, context) => {
    if (page.complete !== (page.next_cursor === null)) {
      context.addIssue({ code: "custom", message: "invalid" });
    }
  });

const persistedFields = {
  version: z.number().int().positive(),
  created_at: timestamp,
  updated_at: timestamp,
};
const preferencesInputSchema = z
  .object({
    timezone: z.string().min(1).max(128),
    homeCurrency: z.string().regex(/^[A-Z]{3}$/),
    reminderLeadDays: z.array(z.number().int().min(0).max(365)).min(1).max(10),
    emailRemindersEnabled: z.boolean(),
    locale: z.string().regex(/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/),
  })
  .strict();
const preferencesRowSchema = z
  .object({
    owner_user_id: z.string().min(1).max(512),
    timezone: z.string().min(1).max(128),
    home_currency: z.string().regex(/^[A-Z]{3}$/),
    reminder_lead_days: z.array(z.number().int().min(0).max(365)),
    email_reminders_enabled: z.boolean(),
    locale: z.string(),
    ...persistedFields,
  })
  .strict();
const renewalRowSchema = z
  .object({
    owner_user_id: z.string().min(1).max(512),
    idempotency_key: z.string().min(1).max(256),
    subscription_id: z.string().min(1).max(128),
    occurrence_date: z.string(),
    amount_minor: z.number().int().safe().nonnegative(),
    currency_code: z.string().length(3),
    state: z.enum(["expected", "confirmed", "corrected", "skipped"]),
    confirmed_on: z.string().nullable(),
    corrected_on: z.string().nullable(),
    skipped_on: z.string().nullable(),
    original_occurrence_date: z.string().nullable(),
    original_amount_minor: z.number().int().safe().nonnegative().nullable(),
    original_currency_code: z.string().length(3).nullable(),
    ...persistedFields,
  })
  .strict()
  .superRefine((row, context) => {
    const noConfirmation = row.confirmed_on === null;
    const noCorrection =
      row.corrected_on === null &&
      row.original_occurrence_date === null &&
      row.original_amount_minor === null &&
      row.original_currency_code === null;
    const noSkip = row.skipped_on === null;
    const valid =
      (row.state === "expected" && noConfirmation && noCorrection && noSkip) ||
      (row.state === "confirmed" &&
        row.confirmed_on !== null &&
        noCorrection &&
        noSkip) ||
      (row.state === "corrected" &&
        noConfirmation &&
        row.corrected_on !== null &&
        row.original_occurrence_date !== null &&
        row.original_amount_minor !== null &&
        row.original_currency_code !== null &&
        noSkip) ||
      (row.state === "skipped" &&
        noConfirmation &&
        noCorrection &&
        row.skipped_on !== null);
    if (!valid) context.addIssue({ code: "custom", message: "invalid" });
  });
const renewalHistoryPageSchema = z
  .object({
    events: z.array(renewalRowSchema).max(100),
    next_cursor: opaqueCursorSchema.nullable(),
    complete: z.boolean(),
  })
  .strict()
  .superRefine((page, context) => {
    if (page.complete !== (page.next_cursor === null)) {
      context.addIssue({ code: "custom", message: "invalid" });
    }
  });
const reminderOverrideInputSchema = z
  .object({
    subscriptionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    leadDays: z.array(z.number().int().min(0).max(365)).min(1).max(10),
    channels: z
      .array(z.enum(["in_app", "native", "email"]))
      .min(1)
      .max(3),
  })
  .strict();
const reminderOverrideRowSchema = z
  .object({
    owner_user_id: z.string().min(1).max(512),
    subscription_id: z.string(),
    lead_days: z.array(z.number().int()),
    channels: z.array(z.enum(["in_app", "native", "email"])),
    ...persistedFields,
  })
  .strict();
const reminderDeliveryRowSchema = z
  .object({
    owner_user_id: z.string().min(1).max(512),
    idempotency_key: z.string().min(1).max(256),
    subscription_id: z.string().min(1).max(128),
    occurrence_date: z.string(),
    channel: z.enum(["in_app", "native", "email"]),
    state: z.enum(["pending", "claimed", "delivered", "failed", "canceled"]),
    attempt_count: z.number().int().min(0).max(20),
    scheduled_for: timestamp,
    delivered_at: timestamp.nullable(),
    error_code: z
      .string()
      .regex(/^[A-Z0-9_]{1,64}$/)
      .nullable(),
    ...persistedFields,
  })
  .strict()
  .superRefine((row, context) => {
    const valid =
      (row.state === "delivered" &&
        row.delivered_at !== null &&
        row.error_code === null) ||
      (row.state === "failed" &&
        row.delivered_at === null &&
        row.error_code !== null) ||
      ((row.state === "pending" ||
        row.state === "claimed" ||
        row.state === "canceled") &&
        row.delivered_at === null &&
        row.error_code === null);
    if (!valid) context.addIssue({ code: "custom", message: "invalid" });
  });
const fxRateRowSchema = z
  .object({
    base_currency: z.string().length(3),
    quote_currency: z.string().length(3),
    rate: z
      .string()
      .regex(/^(?:0|[1-9]\d{0,17})\.\d{12}$/)
      .refine((value) => /[1-9]/.test(value)),
    effective_at: timestamp,
    provider_code: z.string().regex(/^[A-Z0-9_]{1,32}$/),
    created_at: timestamp,
  })
  .strict();
const auditEventRowSchema = z
  .object({
    owner_user_id: z.string().min(1).max(512),
    id: z.number().int().positive(),
    event_type: z.enum([
      "export_requested",
      "deletion_requested",
      "credential_reuse_detected",
      "session_revoked",
    ]),
    occurred_at: timestamp,
    request_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .nullable(),
    ...persistedFields,
  })
  .strict();

const calendarEventKindSchema = z.enum([
  "trial_deadline",
  "expected_charge",
  "one_time_purchase",
  "access_expiry",
  "paused",
  "canceled",
  "corrected_charge",
]);
const calendarEventRowSchema = z
  .object({
    id: z.string().min(1).max(768),
    subscription_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    service_name: z.string().trim().min(1).max(160),
    plan_name: z.string().min(1).max(160).nullable(),
    category: z.string().min(1).max(80).nullable(),
    event_date: z.string(),
    event_kind: calendarEventKindSchema,
    original_date: z.string().nullable(),
  })
  .strict();
const calendarPageSchema = z
  .object({
    events: z.array(calendarEventRowSchema).max(256),
    next_cursor: opaqueCursorSchema.nullable(),
    complete: z.boolean(),
    truncated: z.boolean(),
    authoritative: z.boolean(),
    work: z
      .object({
        source_rows_scanned: z.number().int().min(0).max(256),
        recurrence_candidates: z.number().int().min(0).max(47_616),
        correction_rows_scanned: z.number().int().min(0).max(1024),
        phases_completed: z.number().int().positive(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const valid = value.authoritative
      ? value.complete
        ? value.next_cursor === null && !value.truncated
        : value.next_cursor !== null && value.truncated
      : value.events.length === 0 &&
        !value.complete &&
        value.next_cursor !== null &&
        value.truncated;
    if (!valid) context.addIssue({ code: "custom", message: "invalid" });
  });

export function createDataPlaneRepositories(options: DataPlaneClientOptions) {
  const client = createDataPlaneTransport(options);
  return {
    calendar: new CalendarEventRepository(client),
    subscriptions: new SubscriptionRepository(client),
    preferences: new UserPreferencesRepository(client),
    renewals: new RenewalEventRepository(client),
    reminders: new ReminderRepository(client),
    fxRates: new FxRateRepository(client),
    securityAudit: new SecurityAuditRepository(client),
  } as const;
}

export class SubscriptionRepository {
  readonly #client: DataPlaneTransport;
  constructor(client: DataPlaneTransport) {
    this.#client = client;
  }

  async list(): Promise<readonly PersistedSubscription[]> {
    return readAllRows(
      this.#client,
      "subscriptions",
      new URLSearchParams({
        select: subscriptionProjection,
        order: "next_renewal_date.asc.nullslast,id.asc",
      }),
      subscriptionRowSchema,
      subscriptionFromRow,
      {
        columns: ["created_at", "owner_user_id", "id"],
        values: (row) => [row.created_at, row.owner_user_id, row.id],
        compareRows: (left, right) =>
          compareNullableText(
            left.next_renewal_date,
            right.next_renewal_date,
          ) || compareText(left.id, right.id),
      },
    );
  }

  async listPage(input: Readonly<{ cursor: string | null; pageSize: number }>) {
    const page = validatePageInput(input);
    const rawResponse = await this.#client.request("rpc/subscriptions_page", {
      method: "POST",
      body: JSON.stringify({
        p_page_size: page.pageSize,
        p_cursor: page.cursor,
      }),
    });
    const response = validatePersisted(() =>
      subscriptionPageSchema.parse(rawResponse),
    );
    return {
      items: validatePersisted(() => response.items.map(subscriptionFromRow)),
      nextCursor: response.next_cursor,
      complete: response.complete,
    } as const;
  }

  async get(id: string): Promise<PersistedSubscription | null> {
    const parsedId = validateSubscriptionId(id);
    const rows = parseRows(
      subscriptionRowSchema,
      await this.#client.request("subscriptions", {
        method: "GET",
        query: new URLSearchParams({
          select: subscriptionProjection,
          id: `eq.${parsedId}`,
          limit: "1",
        }),
      }),
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new DataPlaneError("invalid");
    return validatePersisted(() => subscriptionFromRow(rows[0]!));
  }

  async create(input: SubscriptionWrite): Promise<PersistedSubscription> {
    const body = validateWrite(() => subscriptionToCreateRow(input));
    const response = await this.#client.request("subscriptions", {
      method: "POST",
      query: new URLSearchParams({ select: subscriptionProjection }),
      body: JSON.stringify(body),
    });
    return parseSingleSubscription(response);
  }

  async update(
    input: SubscriptionWrite,
    expectedVersion: number,
  ): Promise<PersistedSubscription> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new DataPlaneError("invalid");
    }
    const validated = validateWrite(() => subscriptionToCreateRow(input));
    const { id, ...body } = validated;
    const response = await this.#client.request("subscriptions", {
      method: "PATCH",
      query: new URLSearchParams({
        id: `eq.${id}`,
        version: `eq.${expectedVersion}`,
        select: subscriptionProjection,
      }),
      body: JSON.stringify(body),
    });
    if (Array.isArray(response) && response.length === 0) {
      throw new DataPlaneError("conflict");
    }
    return parseSingleSubscription(response);
  }

  async delete(id: string, expectedVersion: number): Promise<void> {
    const parsedId = validateWrite(() =>
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,128}$/)
        .parse(id),
    );
    assertExpectedVersion(expectedVersion);
    const response = await this.#client.request("subscriptions", {
      method: "DELETE",
      query: new URLSearchParams({
        id: `eq.${parsedId}`,
        version: `eq.${expectedVersion}`,
        select: "id",
      }),
    });
    const affected = z
      .array(z.object({ id: z.literal(parsedId) }).strict())
      .max(1)
      .safeParse(response);
    if (!affected.success) throw new DataPlaneError("invalid");
    if (affected.data.length === 0) throw new DataPlaneError("conflict");
  }
}

export type UserPreferences = Readonly<
  z.infer<typeof preferencesInputSchema> & {
    version: number;
    createdAt: string;
    updatedAt: string;
  }
>;

export class UserPreferencesRepository {
  readonly #client: DataPlaneTransport;
  constructor(client: DataPlaneTransport) {
    this.#client = client;
  }

  async get(): Promise<UserPreferences | null> {
    const rows = parseRows(
      preferencesRowSchema,
      await this.#client.request("user_preferences", {
        method: "GET",
        query: new URLSearchParams({
          select: preferencesProjection,
          limit: "1",
        }),
      }),
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new DataPlaneError("invalid");
    return validatePersisted(() => preferencesFromRow(rows[0]!));
  }

  async create(input: z.input<typeof preferencesInputSchema>) {
    const body = validateWrite(() => preferencesToRow(input));
    const response = await this.#client.request("user_preferences", {
      method: "POST",
      query: new URLSearchParams({ select: preferencesProjection }),
      body: JSON.stringify(body),
    });
    return validatePersisted(() =>
      preferencesFromRow(parseOne(preferencesRowSchema, response)),
    );
  }

  async update(
    input: z.input<typeof preferencesInputSchema>,
    expectedVersion: number,
  ) {
    assertExpectedVersion(expectedVersion);
    const response = await this.#client.request("user_preferences", {
      method: "PATCH",
      query: new URLSearchParams({
        version: `eq.${expectedVersion}`,
        select: preferencesProjection,
      }),
      body: JSON.stringify(validateWrite(() => preferencesToRow(input))),
    });
    const row = parseConditionalOne(preferencesRowSchema, response);
    return validatePersisted(() => preferencesFromRow(row));
  }
}

export type PersistedRenewalEvent = Readonly<{
  event: RenewalEvent;
  version: number;
  createdAt: string;
  updatedAt: string;
}>;

export type RenewalRangeResult = Readonly<{
  events: readonly PersistedRenewalEvent[];
  truncated: boolean;
}>;

export type RepositoryPage<T> = Readonly<{
  items: readonly T[];
  nextCursor: string | null;
  complete: boolean;
}>;

export type RenewalHistoryPage = Readonly<{
  events: readonly PersistedRenewalEvent[];
  nextCursor: string | null;
  complete: boolean;
}>;

export type CalendarEventKind = z.infer<typeof calendarEventKindSchema>;
export type CalendarEvent = Readonly<{
  id: string;
  subscriptionId: string;
  serviceName: string;
  planName: string | null;
  category: string | null;
  date: string;
  kind: CalendarEventKind;
  originalDate?: string;
}>;
export type CalendarPage = Readonly<{
  events: readonly CalendarEvent[];
  nextCursor: string | null;
  complete: boolean;
  truncated: boolean;
}>;
export type CalendarPageQuery = Readonly<{
  rangeStart: string;
  rangeEnd: string;
  filter: "all" | "trials" | "charges" | "access" | "changes";
  query: string;
  pageSize: number;
  cursor: string | null;
  signal?: AbortSignal;
}>;

export class CalendarEventRepository {
  readonly #client: DataPlaneTransport;
  constructor(client: DataPlaneTransport) {
    this.#client = client;
  }

  async listPage(input: CalendarPageQuery): Promise<CalendarPage> {
    const request = validateWrite(() => {
      const start = parseCalendarDate(input.rangeStart);
      const end = parseCalendarDate(input.rangeEnd);
      const rangeDays = Math.round(
        (Date.UTC(end.year, end.month - 1, end.day) -
          Date.UTC(start.year, start.month - 1, start.day)) /
          86_400_000,
      );
      const query = z.string().max(160).parse(input.query).trim();
      const filter = z
        .enum(["all", "trials", "charges", "access", "changes"])
        .parse(input.filter);
      const pageSize = z.number().int().min(1).max(256).parse(input.pageSize);
      const cursor = opaqueCursorSchema.nullable().parse(input.cursor);
      if (rangeDays < 0 || rangeDays > 185) throw new Error("invalid");
      return { cursor, filter, pageSize, query };
    });
    let cursor = request.cursor;
    let response: z.infer<typeof calendarPageSchema>;
    while (true) {
      const rawResponse = await this.#client.request(
        "rpc/calendar_events_page",
        {
          method: "POST",
          signal: input.signal,
          body: JSON.stringify({
            p_range_start: input.rangeStart,
            p_range_end: input.rangeEnd,
            p_filter: request.filter,
            p_query: request.query,
            p_page_size: request.pageSize,
            p_cursor: cursor,
          }),
        },
      );
      response = validatePersisted(() => calendarPageSchema.parse(rawResponse));
      if (response.authoritative) break;
      if (response.next_cursor === cursor) throw new DataPlaneError("invalid");
      cursor = response.next_cursor;
    }
    const ids = new Set<string>();
    const events = validatePersisted(() =>
      response.events.map((row) => {
        parseCalendarDate(row.event_date);
        if (
          row.event_date < input.rangeStart ||
          row.event_date > input.rangeEnd ||
          ids.has(row.id)
        ) {
          throw new Error("invalid");
        }
        if (row.original_date !== null) parseCalendarDate(row.original_date);
        ids.add(row.id);
        return {
          id: row.id,
          subscriptionId: row.subscription_id,
          serviceName: row.service_name,
          planName: row.plan_name,
          category: row.category,
          date: row.event_date,
          kind: row.event_kind,
          ...(row.original_date === null
            ? {}
            : { originalDate: row.original_date }),
        } satisfies CalendarEvent;
      }),
    );
    return {
      events,
      nextCursor: response.next_cursor,
      complete: response.complete,
      truncated: response.truncated,
    };
  }
}

export class RenewalEventRepository {
  readonly #client: DataPlaneTransport;
  constructor(client: DataPlaneTransport) {
    this.#client = client;
  }

  async list(
    subscriptionId?: string,
  ): Promise<readonly PersistedRenewalEvent[]> {
    const query = new URLSearchParams({
      select: renewalProjection,
      order: "occurrence_date.asc,idempotency_key.asc",
    });
    if (subscriptionId !== undefined) {
      const parsedSubscriptionId = validateWrite(() =>
        z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,128}$/)
          .parse(subscriptionId),
      );
      query.set("subscription_id", `eq.${parsedSubscriptionId}`);
    }
    return readAllRows(
      this.#client,
      "renewal_events",
      query,
      renewalRowSchema,
      renewalFromRow,
      {
        columns: ["created_at", "owner_user_id", "idempotency_key"],
        values: (row) => [
          row.created_at,
          row.owner_user_id,
          row.idempotency_key,
        ],
        compareRows: (left, right) =>
          compareText(left.occurrence_date, right.occurrence_date) ||
          compareText(left.idempotency_key, right.idempotency_key),
      },
    );
  }

  async listPage(
    input: Readonly<{
      subscriptionId: string;
      cursor: string | null;
      pageSize: number;
    }>,
  ): Promise<RenewalHistoryPage> {
    const subscriptionId = validateSubscriptionId(input.subscriptionId);
    const page = validatePageInput(input);
    const rawResponse = await this.#client.request("rpc/renewal_history_page", {
      method: "POST",
      body: JSON.stringify({
        p_subscription_id: subscriptionId,
        p_page_size: page.pageSize,
        p_cursor: page.cursor,
      }),
    });
    const response = validatePersisted(() =>
      renewalHistoryPageSchema.parse(rawResponse),
    );
    return {
      events: validatePersisted(() => response.events.map(renewalFromRow)),
      nextCursor: response.next_cursor,
      complete: response.complete,
    };
  }

  async listRange(
    input: Readonly<{
      rangeStart: string;
      rangeEnd: string;
      maxEvents: number;
    }>,
  ): Promise<RenewalRangeResult> {
    const range = validateWrite(() => {
      parseCalendarDate(input.rangeStart);
      parseCalendarDate(input.rangeEnd);
      if (
        input.rangeEnd < input.rangeStart ||
        !Number.isInteger(input.maxEvents) ||
        input.maxEvents < 1 ||
        input.maxEvents > 512
      ) {
        throw new Error("invalid renewal range");
      }
      return input;
    });
    const baseQuery = new URLSearchParams({
      select: renewalProjection,
      or: `(and(occurrence_date.gte.${range.rangeStart},occurrence_date.lte.${range.rangeEnd}),and(original_occurrence_date.gte.${range.rangeStart},original_occurrence_date.lte.${range.rangeEnd}))`,
    });
    const keyset: CollectionKeyset<z.infer<typeof renewalRowSchema>> = {
      columns: ["created_at", "owner_user_id", "idempotency_key"],
      values: (row) => [row.created_at, row.owner_user_id, row.idempotency_key],
    };
    const highWaterQuery = new URLSearchParams(baseQuery);
    highWaterQuery.set(
      "order",
      keyset.columns.map((column) => `${column}.desc`).join(","),
    );
    highWaterQuery.set("limit", "1");
    const highWaterRows = parseRows(
      renewalRowSchema,
      await this.#client.request("renewal_events", {
        method: "GET",
        query: highWaterQuery,
      }),
    );
    if (highWaterRows.length === 0) return { events: [], truncated: false };
    if (highWaterRows.length !== 1) throw new DataPlaneError("invalid");
    const highWater = validatePersisted(() => {
      renewalFromRow(highWaterRows[0]!);
      return readCursor(keyset, highWaterRows[0]!);
    });
    const rows: z.infer<typeof renewalRowSchema>[] = [];
    let previous: readonly CursorValue[] | undefined;
    while (true) {
      const pageLimit = Math.min(512, range.maxEvents + 1 - rows.length);
      const query = new URLSearchParams(baseQuery);
      query.set(
        "order",
        keyset.columns.map((column) => `${column}.asc`).join(","),
      );
      query.set("limit", String(pageLimit));
      query.set("and", cursorWindowFilter(keyset.columns, previous, highWater));
      const page = parseRows(
        renewalRowSchema,
        await this.#client.request("renewal_events", { method: "GET", query }),
      );
      if (page.length === 0 || page.length > pageLimit) {
        throw new DataPlaneError("invalid");
      }
      const validatedPage = validatePersisted(() =>
        page.map((row) => ({
          cursor: readCursor(keyset, row),
          row,
          value: renewalFromRow(row),
        })),
      );
      let pagePrevious = previous;
      for (const item of validatedPage) {
        if (
          (pagePrevious !== undefined &&
            compareCursors(item.cursor, pagePrevious) <= 0) ||
          compareCursors(item.cursor, highWater) > 0
        ) {
          throw new DataPlaneError("invalid");
        }
        pagePrevious = item.cursor;
      }
      for (const item of validatedPage) {
        rows.push(item.row);
        previous = item.cursor;
        if (rows.length > range.maxEvents) {
          return renewalRangeResult(rows.slice(0, range.maxEvents), true);
        }
        if (compareCursors(item.cursor, highWater) === 0) {
          return renewalRangeResult(rows, false);
        }
      }
    }
  }

  async save(event: RenewalEvent, ...legacyExpectedVersion: never[]) {
    if (legacyExpectedVersion.length !== 0) throw new DataPlaneError("invalid");
    const validated = validateWrite(() => createRenewalEvent(event));
    if (validated.state !== "expected") throw new DataPlaneError("invalid");
    const response = await this.#client.request("renewal_events", {
      method: "POST",
      query: new URLSearchParams({ select: renewalProjection }),
      body: JSON.stringify(renewalToCreateRow(validated)),
    });
    return validatePersisted(() =>
      renewalFromRow(parseOne(renewalRowSchema, response)),
    );
  }

  async confirm(
    event: ExpectedRenewal,
    confirmedOn: string,
    expectedVersion: number,
  ) {
    const transitioned = validateWrite(() =>
      confirmRenewal(event, confirmedOn),
    );
    return this.#transition(
      transitioned.idempotencyKey,
      { state: "confirmed", confirmed_on: transitioned.confirmedOn },
      expectedVersion,
    );
  }

  async skip(
    event: ExpectedRenewal,
    skippedOn: string,
    expectedVersion: number,
  ) {
    const transitioned = validateWrite(() => skipRenewal(event, skippedOn));
    return this.#transition(
      transitioned.idempotencyKey,
      { state: "skipped", skipped_on: transitioned.skippedOn },
      expectedVersion,
    );
  }

  async correct(
    event: RenewalEvent,
    correction: Parameters<typeof correctRenewal>[1],
    expectedVersion: number,
  ) {
    const transitioned = validateWrite(() => correctRenewal(event, correction));
    return this.#transition(
      transitioned.idempotencyKey,
      {
        occurrence_date: transitioned.occurrenceDate,
        amount_minor: transitioned.amount.minorUnits,
        currency_code: transitioned.amount.currency,
        state: "corrected",
        confirmed_on: null,
        corrected_on: transitioned.correctedOn,
        skipped_on: null,
        original_occurrence_date: transitioned.original.occurrenceDate,
        original_amount_minor: transitioned.original.amount.minorUnits,
        original_currency_code: transitioned.original.amount.currency,
      },
      expectedVersion,
    );
  }

  async #transition(
    idempotencyKey: string,
    body: Readonly<Record<string, unknown>>,
    expectedVersion: number,
  ) {
    assertExpectedVersion(expectedVersion);
    const response = await this.#client.request("renewal_events", {
      method: "PATCH",
      query: new URLSearchParams({
        idempotency_key: `eq.${idempotencyKey}`,
        version: `eq.${expectedVersion}`,
        select: renewalProjection,
      }),
      body: JSON.stringify(body),
    });
    const row = parseConditionalOne(renewalRowSchema, response);
    return validatePersisted(() => renewalFromRow(row));
  }
}

export type ReminderOverride = Readonly<
  z.infer<typeof reminderOverrideInputSchema> & {
    version: number;
    createdAt: string;
    updatedAt: string;
  }
>;
export type ReminderDelivery = Readonly<{
  idempotencyKey: string;
  subscriptionId: string;
  occurrenceDate: string;
  channel: "in_app" | "native" | "email";
  state: "pending" | "claimed" | "delivered" | "failed" | "canceled";
  attemptCount: number;
  scheduledFor: string;
  deliveredAt: string | null;
  errorCode: string | null;
}>;

export class ReminderRepository {
  readonly #client: DataPlaneTransport;
  constructor(client: DataPlaneTransport) {
    this.#client = client;
  }

  async createOverride(input: z.input<typeof reminderOverrideInputSchema>) {
    const override = validateWrite(() =>
      reminderOverrideInputSchema.parse(input),
    );
    const response = await this.#client.request("reminder_overrides", {
      method: "POST",
      query: new URLSearchParams({ select: reminderOverrideProjection }),
      body: JSON.stringify(overrideToRow(override)),
    });
    return validatePersisted(() =>
      overrideFromRow(parseOne(reminderOverrideRowSchema, response)),
    );
  }

  async updateOverride(
    input: z.input<typeof reminderOverrideInputSchema>,
    expectedVersion: number,
  ) {
    const override = validateWrite(() =>
      reminderOverrideInputSchema.parse(input),
    );
    assertExpectedVersion(expectedVersion);
    const response = await this.#client.request("reminder_overrides", {
      method: "PATCH",
      query: new URLSearchParams({
        subscription_id: `eq.${override.subscriptionId}`,
        version: `eq.${expectedVersion}`,
        select: reminderOverrideProjection,
      }),
      body: JSON.stringify({
        lead_days: override.leadDays,
        channels: override.channels,
      }),
    });
    const row = parseConditionalOne(reminderOverrideRowSchema, response);
    return validatePersisted(() => overrideFromRow(row));
  }

  async listOverrides(): Promise<readonly ReminderOverride[]> {
    return readAllRows(
      this.#client,
      "reminder_overrides",
      new URLSearchParams({
        select: reminderOverrideProjection,
        order: "subscription_id.asc",
      }),
      reminderOverrideRowSchema,
      overrideFromRow,
      {
        columns: ["created_at", "owner_user_id", "subscription_id"],
        values: (row) => [
          row.created_at,
          row.owner_user_id,
          row.subscription_id,
        ],
        compareRows: (left, right) =>
          compareText(left.subscription_id, right.subscription_id),
      },
    );
  }

  async deleteOverride(subscriptionId: string, expectedVersion: number) {
    const parsedId = validateWrite(() =>
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,128}$/)
        .parse(subscriptionId),
    );
    assertExpectedVersion(expectedVersion);
    const response = await this.#client.request("reminder_overrides", {
      method: "DELETE",
      query: new URLSearchParams({
        subscription_id: `eq.${parsedId}`,
        version: `eq.${expectedVersion}`,
        select: "subscription_id",
      }),
    });
    const affected = z
      .array(z.object({ subscription_id: z.literal(parsedId) }).strict())
      .max(1)
      .safeParse(response);
    if (!affected.success) throw new DataPlaneError("invalid");
    if (affected.data.length === 0) throw new DataPlaneError("conflict");
  }

  async listDeliveries(): Promise<readonly ReminderDelivery[]> {
    return readAllRows(
      this.#client,
      "reminder_deliveries",
      new URLSearchParams({
        select: reminderDeliveryProjection,
        order: "scheduled_for.asc,idempotency_key.asc",
      }),
      reminderDeliveryRowSchema,
      deliveryFromRow,
      {
        columns: ["created_at", "owner_user_id", "idempotency_key"],
        values: (row) => [
          row.created_at,
          row.owner_user_id,
          row.idempotency_key,
        ],
        compareRows: (left, right) =>
          compareText(left.scheduled_for, right.scheduled_for) ||
          compareText(left.idempotency_key, right.idempotency_key),
      },
    );
  }

  /**
   * Advance one of the caller's own deliveries through the server-validated
   * acknowledgement function. Direct writes to reminder_deliveries are denied
   * to clients by policy; this RPC is the only legal path, and it enforces
   * ownership from the verified token plus the legal state transitions.
   */
  async acknowledgeDelivery(
    input: z.input<typeof reminderAcknowledgementSchema>,
  ): Promise<ReminderDelivery> {
    const acknowledgement = validateWrite(() =>
      reminderAcknowledgementSchema.parse(input),
    );
    const response = await this.#client.request(
      "rpc/acknowledge_reminder_delivery",
      {
        method: "POST",
        body: JSON.stringify({
          p_idempotency_key: acknowledgement.idempotencyKey,
          p_state: acknowledgement.state,
          p_error_code: acknowledgement.errorCode ?? null,
        }),
      },
    );
    return validatePersisted(() =>
      deliveryFromRow(reminderDeliveryRowSchema.parse(response)),
    );
  }
}

const reminderAcknowledgementSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(256),
    state: z.enum(["claimed", "delivered", "failed", "canceled"]),
    errorCode: z
      .string()
      .regex(/^[A-Z0-9_]{1,64}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    // Mirrors the server rule: a failure must carry a code and only a
    // failure may carry one. Enforcing it here keeps an illegal pairing
    // from ever leaving the process.
    const legal =
      value.state === "failed"
        ? value.errorCode !== undefined
        : value.errorCode === undefined;
    if (!legal) context.addIssue({ code: "custom", message: "invalid" });
  });

export type ReminderAcknowledgement = z.input<
  typeof reminderAcknowledgementSchema
>;

export type FxRate = Readonly<{
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  effectiveAt: string;
  providerCode: string;
}>;

export class FxRateRepository {
  readonly #client: DataPlaneTransport;
  constructor(client: DataPlaneTransport) {
    this.#client = client;
  }

  async list(baseCurrency: string): Promise<readonly FxRate[]> {
    const base = validateWrite(() =>
      z
        .string()
        .regex(/^[A-Z]{3}$/)
        .parse(baseCurrency),
    );
    return readAllRows(
      this.#client,
      "fx_rates",
      new URLSearchParams({
        select: fxRateProjection,
        base_currency: `eq.${base}`,
        order: "effective_at.desc,quote_currency.asc",
      }),
      fxRateRowSchema,
      fxRateFromRow,
      {
        columns: [
          "created_at",
          "base_currency",
          "quote_currency",
          "effective_at",
        ],
        values: (row) => [
          row.created_at,
          row.base_currency,
          row.quote_currency,
          row.effective_at,
        ],
        compareRows: (left, right) =>
          compareText(right.effective_at, left.effective_at) ||
          compareText(left.quote_currency, right.quote_currency),
      },
    );
  }
}

export type SecurityAuditEvent = Readonly<{
  id: number;
  eventType: z.infer<typeof auditEventRowSchema>["event_type"];
  occurredAt: string;
  requestId: string | null;
}>;

export class SecurityAuditRepository {
  readonly #client: DataPlaneTransport;
  constructor(client: DataPlaneTransport) {
    this.#client = client;
  }

  async list(): Promise<readonly SecurityAuditEvent[]> {
    return readAllRows(
      this.#client,
      "security_audit_events",
      new URLSearchParams({
        select: auditEventProjection,
        order: "occurred_at.desc,id.desc",
      }),
      auditEventRowSchema,
      auditEventFromRow,
      {
        columns: ["created_at", "owner_user_id", "id"],
        values: (row) => [row.created_at, row.owner_user_id, row.id],
        compareRows: (left, right) =>
          compareText(right.occurred_at, left.occurred_at) ||
          right.id - left.id,
      },
    );
  }
}

function subscriptionToCreateRow(input: SubscriptionWrite) {
  const metadata = subscriptionMetadataSchema.parse(input.metadata);
  const subscription = input.subscription;
  const validated =
    subscription.kind === "recurring"
      ? createRecurringSubscription({
          ...subscription,
          recurrence: { ...subscription.recurrence },
          amount: { ...subscription.amount },
          lifecycle: { ...subscription.lifecycle },
        })
      : createOneTimeSubscription({
          ...subscription,
          amount: { ...subscription.amount },
          lifecycle: { ...subscription.lifecycle },
        });
  if (containsProhibitedSubscriptionSecret(validated.serviceName)) {
    throw new Error("invalid");
  }
  const lifecycle = createLifecycleState(validated.lifecycle);
  const base = {
    id: validated.id,
    kind: validated.kind,
    service_name: validated.serviceName,
    plan_name: metadata.planName,
    amount_minor: validated.amount.minorUnits,
    currency_code: validated.amount.currency,
    timezone: validated.timezone,
    lifecycle_status: lifecycle.status,
    lifecycle_since: lifecycle.since,
    trial_ends_on: lifecycle.status === "trial" ? lifecycle.trialEndsOn : null,
    lifecycle_access_ends_on:
      lifecycle.status === "canceled" ? lifecycle.accessEndsOn : null,
    account_email: metadata.accountEmail,
    payment_label: metadata.paymentLabel,
    management_url: metadata.managementUrl,
    category: metadata.category,
    notes: metadata.notes,
  };
  if (validated.kind === "recurring") {
    return {
      ...base,
      start_date: validated.startDate,
      purchased_on: null,
      access_ends_on: null,
      next_renewal_date: validated.nextRenewalDate,
      recurrence_unit: validated.recurrence.unit,
      recurrence_interval: validated.recurrence.interval,
    };
  }
  return {
    ...base,
    start_date: null,
    purchased_on: validated.purchasedOn,
    access_ends_on: validated.accessEndsOn,
    next_renewal_date: null,
    recurrence_unit: null,
    recurrence_interval: null,
  };
}

function parseSingleSubscription(value: unknown): PersistedSubscription {
  return validatePersisted(() =>
    subscriptionFromRow(parseOne(subscriptionRowSchema, value)),
  );
}

function subscriptionFromRow(
  row: z.infer<typeof subscriptionRowSchema>,
): PersistedSubscription {
  assertPersistedOwner(row.owner_user_id);
  const lifecycle = createLifecycleState(
    row.lifecycle_status === "trial"
      ? {
          status: "trial",
          since: row.lifecycle_since,
          trialEndsOn: row.trial_ends_on ?? "",
        }
      : row.lifecycle_status === "canceled"
        ? {
            status: "canceled",
            since: row.lifecycle_since,
            accessEndsOn: row.lifecycle_access_ends_on ?? "",
          }
        : { status: row.lifecycle_status, since: row.lifecycle_since },
  );
  const subscription =
    row.kind === "recurring"
      ? createRecurringSubscription({
          kind: "recurring",
          id: row.id,
          serviceName: row.service_name,
          amount: {
            minorUnits: row.amount_minor,
            currency: row.currency_code,
          },
          timezone: row.timezone,
          startDate: row.start_date ?? "",
          nextRenewalDate: row.next_renewal_date ?? "",
          recurrence: {
            unit: row.recurrence_unit ?? "",
            interval: row.recurrence_interval ?? 0,
          } as never,
          lifecycle,
        })
      : createOneTimeSubscription({
          kind: "one_time",
          id: row.id,
          serviceName: row.service_name,
          amount: {
            minorUnits: row.amount_minor,
            currency: row.currency_code,
          },
          timezone: row.timezone,
          purchasedOn: row.purchased_on ?? "",
          accessEndsOn: row.access_ends_on,
          lifecycle,
        });
  const metadata = subscriptionMetadataSchema.parse({
    planName: row.plan_name,
    accountEmail: row.account_email,
    paymentLabel: row.payment_label,
    managementUrl: row.management_url,
    category: row.category,
    notes: row.notes,
  });
  return {
    subscription,
    metadata,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function preferencesFromRow(
  row: z.infer<typeof preferencesRowSchema>,
): UserPreferences {
  assertPersistedOwner(row.owner_user_id);
  const preferences = preferencesInputSchema.parse({
    timezone: row.timezone,
    homeCurrency: row.home_currency,
    reminderLeadDays: row.reminder_lead_days,
    emailRemindersEnabled: row.email_reminders_enabled,
    locale: row.locale,
  });
  assertTimezone(preferences.timezone);
  currencyExponent(preferences.homeCurrency);
  return {
    ...preferences,
    reminderLeadDays: [...preferences.reminderLeadDays],
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function preferencesToRow(input: z.input<typeof preferencesInputSchema>) {
  const preferences = preferencesInputSchema.parse(input);
  assertTimezone(preferences.timezone);
  currencyExponent(preferences.homeCurrency);
  return {
    timezone: preferences.timezone,
    home_currency: preferences.homeCurrency,
    reminder_lead_days: preferences.reminderLeadDays,
    email_reminders_enabled: preferences.emailRemindersEnabled,
    locale: preferences.locale,
  };
}

function renewalToCreateRow(event: ExpectedRenewal) {
  parseCalendarDate(event.occurrenceDate);
  const amount = createMoney(event.amount);
  return {
    idempotency_key: event.idempotencyKey,
    subscription_id: event.subscriptionId,
    occurrence_date: event.occurrenceDate,
    amount_minor: amount.minorUnits,
    currency_code: amount.currency,
  };
}

function renewalFromRow(
  row: z.infer<typeof renewalRowSchema>,
): PersistedRenewalEvent {
  assertPersistedOwner(row.owner_user_id);
  parseCalendarDate(row.occurrence_date);
  const amount = createMoney({
    minorUnits: row.amount_minor,
    currency: row.currency_code,
  });
  const base = {
    idempotencyKey: row.idempotency_key,
    subscriptionId: row.subscription_id,
    occurrenceDate: row.occurrence_date,
    amount,
  };
  let event: RenewalEvent;
  if (row.state === "confirmed") {
    parseCalendarDate(row.confirmed_on ?? "");
    event = { ...base, state: "confirmed", confirmedOn: row.confirmed_on! };
  } else if (row.state === "corrected") {
    parseCalendarDate(row.corrected_on ?? "");
    parseCalendarDate(row.original_occurrence_date ?? "");
    event = {
      ...base,
      state: "corrected",
      correctedOn: row.corrected_on!,
      original: {
        occurrenceDate: row.original_occurrence_date!,
        amount: createMoney({
          minorUnits: row.original_amount_minor ?? Number.NaN,
          currency: row.original_currency_code ?? "",
        }),
      },
    };
  } else if (row.state === "skipped") {
    parseCalendarDate(row.skipped_on ?? "");
    event = { ...base, state: "skipped", skippedOn: row.skipped_on! };
  } else {
    event = { ...base, state: "expected" };
  }
  event = createRenewalEvent(event);
  return {
    event,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function renewalRangeResult(
  rows: readonly z.infer<typeof renewalRowSchema>[],
  truncated: boolean,
): RenewalRangeResult {
  return validatePersisted(() => ({
    events: rows
      .map(renewalFromRow)
      .sort(
        (left, right) =>
          compareText(left.event.occurrenceDate, right.event.occurrenceDate) ||
          compareText(left.event.idempotencyKey, right.event.idempotencyKey),
      ),
    truncated,
  }));
}

function overrideFromRow(
  row: z.infer<typeof reminderOverrideRowSchema>,
): ReminderOverride {
  assertPersistedOwner(row.owner_user_id);
  const validated = reminderOverrideInputSchema.parse({
    subscriptionId: row.subscription_id,
    leadDays: row.lead_days,
    channels: row.channels,
  });
  return {
    ...validated,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function overrideToRow(input: z.infer<typeof reminderOverrideInputSchema>) {
  return {
    subscription_id: input.subscriptionId,
    lead_days: input.leadDays,
    channels: input.channels,
  };
}

function deliveryFromRow(
  row: z.infer<typeof reminderDeliveryRowSchema>,
): ReminderDelivery {
  assertPersistedOwner(row.owner_user_id);
  parseCalendarDate(row.occurrence_date);
  return {
    idempotencyKey: row.idempotency_key,
    subscriptionId: row.subscription_id,
    occurrenceDate: row.occurrence_date,
    channel: row.channel,
    state: row.state,
    attemptCount: row.attempt_count,
    scheduledFor: row.scheduled_for,
    deliveredAt: row.delivered_at,
    errorCode: row.error_code,
  };
}

function fxRateFromRow(row: z.infer<typeof fxRateRowSchema>): FxRate {
  currencyExponent(row.base_currency);
  currencyExponent(row.quote_currency);
  return {
    baseCurrency: row.base_currency,
    quoteCurrency: row.quote_currency,
    rate: row.rate,
    effectiveAt: row.effective_at,
    providerCode: row.provider_code,
  };
}

function auditEventFromRow(
  row: z.infer<typeof auditEventRowSchema>,
): SecurityAuditEvent {
  assertPersistedOwner(row.owner_user_id);
  return {
    id: row.id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    requestId: row.request_id,
  };
}

async function readAllRows<T, U>(
  client: DataPlaneTransport,
  target: string,
  baseQuery: URLSearchParams,
  schema: z.ZodType<T>,
  convert: (row: T) => U,
  keyset: CollectionKeyset<T>,
): Promise<U[]> {
  const highWaterQuery = new URLSearchParams(baseQuery);
  highWaterQuery.set(
    "order",
    keyset.columns.map((column) => `${column}.desc`).join(","),
  );
  highWaterQuery.set("limit", "1");
  highWaterQuery.delete("offset");
  const highWaterRows = parseRows(
    schema,
    await client.request(target, { method: "GET", query: highWaterQuery }),
  );
  if (highWaterRows.length === 0) return [];
  if (highWaterRows.length !== 1) throw new DataPlaneError("invalid");
  const highWater = validatePersisted(() => {
    convert(highWaterRows[0]!);
    return readCursor(keyset, highWaterRows[0]!);
  });

  const result: Array<{ row: T; value: U }> = [];
  let previous: readonly CursorValue[] | undefined;
  while (true) {
    const query = new URLSearchParams(baseQuery);
    query.set(
      "order",
      keyset.columns.map((column) => `${column}.asc`).join(","),
    );
    query.set("limit", String(collectionPageSize));
    query.delete("offset");
    query.set("and", cursorWindowFilter(keyset.columns, previous, highWater));
    const page = parseRows(
      schema,
      await client.request(target, { method: "GET", query }),
    );
    if (page.length === 0) {
      if (keyset.compareRows) {
        result.sort((left, right) => keyset.compareRows!(left.row, right.row));
      }
      return result.map(({ value }) => value);
    }
    if (page.length > collectionPageSize) throw new DataPlaneError("invalid");

    const validatedPage = validatePersisted(() =>
      page.map((row) => ({
        cursor: readCursor(keyset, row),
        row,
        value: convert(row),
      })),
    );
    for (const item of validatedPage) {
      if (
        (previous !== undefined &&
          compareCursors(item.cursor, previous) <= 0) ||
        compareCursors(item.cursor, highWater) > 0
      ) {
        throw new DataPlaneError("invalid");
      }
      result.push({ row: item.row, value: item.value });
      previous = item.cursor;
    }
  }
}

function validatePageInput(
  input: Readonly<{ cursor: string | null; pageSize: number }>,
) {
  return validateWrite(() => ({
    cursor: opaqueCursorSchema.nullable().parse(input.cursor),
    pageSize: z.number().int().min(1).max(100).parse(input.pageSize),
  }));
}

function validateSubscriptionId(id: string) {
  return validateWrite(() =>
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .parse(id),
  );
}

function readCursor<T>(keyset: CollectionKeyset<T>, row: T) {
  const values = keyset.values(row);
  if (values.length !== keyset.columns.length) throw new Error("invalid");
  for (const value of values) {
    if (
      (typeof value !== "string" || value.length === 0) &&
      (typeof value !== "number" || !Number.isSafeInteger(value))
    ) {
      throw new Error("invalid");
    }
  }
  return values;
}

function cursorWindowFilter(
  columns: readonly string[],
  previous: readonly CursorValue[] | undefined,
  highWater: readonly CursorValue[],
) {
  const filters = [lexicographicFilter(columns, highWater, "through")];
  if (previous !== undefined) {
    filters.unshift(lexicographicFilter(columns, previous, "after"));
  }
  return `(${filters.join(",")})`;
}

function lexicographicFilter(
  columns: readonly string[],
  values: readonly CursorValue[],
  direction: "after" | "through",
) {
  const alternatives = columns.map((column, index) => {
    const terms = columns
      .slice(0, index)
      .map(
        (prefix, prefixIndex) =>
          `${prefix}.eq.${postgrestLiteral(values[prefixIndex]!)}`,
      );
    const operator =
      direction === "after"
        ? "gt"
        : index === columns.length - 1
          ? "lte"
          : "lt";
    terms.push(`${column}.${operator}.${postgrestLiteral(values[index]!)}`);
    return terms.length === 1 ? terms[0]! : `and(${terms.join(",")})`;
  });
  return `or(${alternatives.join(",")})`;
}

function postgrestLiteral(value: CursorValue) {
  if (typeof value === "number") return String(value);
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function compareCursors(
  left: readonly CursorValue[],
  right: readonly CursorValue[],
) {
  if (left.length !== right.length) throw new DataPlaneError("invalid");
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    if (typeof leftValue !== typeof rightValue) {
      throw new DataPlaneError("invalid");
    }
    const comparison =
      typeof leftValue === "number"
        ? leftValue - (rightValue as number)
        : compareText(leftValue, rightValue as string);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNullableText(left: string | null, right: string | null) {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return compareText(left, right);
}

function parseRows<T>(schema: z.ZodType<T>, value: unknown): T[] {
  const parsed = z.array(schema).safeParse(value);
  if (!parsed.success) throw new DataPlaneError("invalid");
  return parsed.data;
}

function parseOne<T>(schema: z.ZodType<T>, value: unknown): T {
  const rows = parseRows(schema, value);
  if (rows.length !== 1) throw new DataPlaneError("invalid");
  return rows[0]!;
}

function parseConditionalOne<T>(schema: z.ZodType<T>, value: unknown): T {
  if (Array.isArray(value) && value.length === 0) {
    throw new DataPlaneError("conflict");
  }
  return parseOne(schema, value);
}

function assertExpectedVersion(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DataPlaneError("invalid");
  }
}

function assertPersistedOwner(value: string) {
  if (value.length < 1 || value.length > 512 || value !== value.trim()) {
    throw new Error("invalid");
  }
}

function containsPaymentCardNumber(value: string) {
  const candidates = value.match(/[0-9](?:[0-9.\-\p{White_Space}]*[0-9])?/gu);
  for (const candidate of candidates ?? []) {
    const digits = candidate.replace(/[^0-9]/gu, "");
    if (isPlausiblePaymentNetworkPan(digits) && passesLuhn(digits)) {
      return true;
    }
  }
  return false;
}

export function containsProhibitedSubscriptionSecret(value: string) {
  return [...sensitiveTextVariants(value)].some(
    containsProhibitedNormalizedText,
  );
}

function containsProhibitedNormalizedText(value: string) {
  if (containsPaymentCardNumber(value)) return true;
  const labeledSecurityCode =
    /\b(?:cvv2?|cvc2?|cid|security\s*code)\b[\s:=#-]*\d{3,4}\b/iu;
  const labeledCredential = /\b(?:password|passcode)\b\s*(?::|=)\s*\S{4,}/iu;
  const labeledRecoveryCode =
    /\b(?:recovery|backup)\s+code\b\s*(?::|=)\s*[a-z0-9][a-z0-9 -]{5,}/iu;
  const labeledBankCredential =
    /\b(?:(?:bank\s+)?account|routing|sort)\s+(?:number|code)\b\s*(?::|=)\s*[a-z0-9][a-z0-9 -]{3,}/iu;
  return (
    labeledSecurityCode.test(value) ||
    labeledCredential.test(value) ||
    labeledRecoveryCode.test(value) ||
    labeledBankCredential.test(value)
  );
}

function sensitiveTextVariants(value: string) {
  const variants = new Set<string>();
  let current = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const normalized = current
      .normalize("NFKC")
      .replace(/[\p{Dash_Punctuation}\u2212]/gu, "-")
      .replaceAll("+", " ");
    variants.add(normalized);
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return variants;
}

function isPlausiblePaymentNetworkPan(digits: string) {
  const length = digits.length;
  const prefix2 = Number(digits.slice(0, 2));
  const prefix3 = Number(digits.slice(0, 3));
  const prefix4 = Number(digits.slice(0, 4));
  const prefix6 = Number(digits.slice(0, 6));
  const visa = digits.startsWith("4") && [13, 16, 19].includes(length);
  const mastercard =
    length === 16 &&
    ((prefix2 >= 51 && prefix2 <= 55) || (prefix4 >= 2221 && prefix4 <= 2720));
  const amex = length === 15 && (prefix2 === 34 || prefix2 === 37);
  const discover =
    (length === 16 || length === 19) &&
    (digits.startsWith("6011") ||
      prefix2 === 65 ||
      (prefix3 >= 644 && prefix3 <= 649) ||
      (prefix6 >= 622126 && prefix6 <= 622925));
  const jcb =
    length >= 16 && length <= 19 && prefix4 >= 3528 && prefix4 <= 3589;
  const diners =
    length === 14 &&
    ((prefix3 >= 300 && prefix3 <= 305) ||
      prefix2 === 36 ||
      prefix2 === 38 ||
      prefix2 === 39);
  const unionPay = length >= 16 && length <= 19 && digits.startsWith("62");
  const maestro =
    length >= 12 &&
    length <= 19 &&
    ([5018, 5020, 5038].includes(prefix4) || (prefix2 >= 56 && prefix2 <= 69));
  const mir =
    length >= 16 && length <= 19 && prefix4 >= 2200 && prefix4 <= 2204;
  const rupay =
    length === 16 &&
    (prefix3 === 508 ||
      prefix2 === 60 ||
      prefix2 === 81 ||
      prefix2 === 82 ||
      prefix4 === 6521 ||
      prefix4 === 6522);
  const verve =
    [16, 18, 19].includes(length) &&
    ((prefix6 >= 506099 && prefix6 <= 506198) ||
      (prefix6 >= 650002 && prefix6 <= 650027));
  const uatp = length === 15 && digits.startsWith("1");
  return (
    visa ||
    mastercard ||
    amex ||
    discover ||
    jcb ||
    diners ||
    unionPay ||
    maestro ||
    mir ||
    rupay ||
    verve ||
    uatp
  );
}

function passesLuhn(digits: string) {
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function validatePersisted<T>(validate: () => T): T {
  try {
    return validate();
  } catch {
    throw new DataPlaneError("invalid");
  }
}

function validateWrite<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof DataPlaneError) throw error;
    throw new DataPlaneError("invalid");
  }
}

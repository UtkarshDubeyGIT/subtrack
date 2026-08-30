import {
  parseCalendarDate,
  restartRecurringSubscription,
  resumeRecurringSubscription,
  transitionLifecycle,
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
  type SubscriptionMetadata,
  type SubscriptionWrite,
} from "@subtrack/data";

export type SubscriptionRepositoryBoundary = Readonly<{
  listPage(
    input: Readonly<{
      cursor: string | null;
      pageSize: number;
    }>,
  ): Promise<RepositoryPage<PersistedSubscription>>;
  get(id: string): Promise<PersistedSubscription | null>;
  create(input: SubscriptionWrite): Promise<PersistedSubscription>;
  update(
    input: SubscriptionWrite,
    expectedVersion: number,
  ): Promise<PersistedSubscription>;
  delete(id: string, expectedVersion: number): Promise<void>;
}>;

export type RenewalHistoryRepositoryBoundary = Readonly<{
  listPage(
    input: Readonly<{
      subscriptionId: string;
      cursor: string | null;
      pageSize: number;
    }>,
  ): Promise<RenewalHistoryPage>;
}>;

export type CalendarRepositoryBoundary = Readonly<{
  listPage(input: CalendarPageQuery): Promise<CalendarPage>;
}>;

export type CalendarRange = Readonly<{
  rangeStart: string;
  rangeEnd: string;
  filter?: CalendarPageQuery["filter"];
  query?: string;
}>;

export type CalendarRangeState =
  | Readonly<{ status: "idle"; requested: null; loaded: null }>
  | Readonly<{
      status: "pending";
      requested: CalendarRange;
      loaded: CalendarRange | null;
    }>
  | Readonly<{
      status: "ready";
      requested: CalendarRange;
      loaded: CalendarRange;
      complete: boolean;
      nextCursor: string | null;
    }>
  | Readonly<{
      status: "error" | "truncated";
      requested: CalendarRange;
      loaded: CalendarRange | null;
      message: string;
    }>;

export type ManagedSubscription = Readonly<{
  record: PersistedSubscription;
  syncStatus: "synced" | "pending";
}>;

export type LedgerPageState =
  | Readonly<{
      status: "ready" | "loading_more";
      complete: boolean;
      nextCursor: string | null;
    }>
  | Readonly<{
      status: "error";
      complete: false;
      nextCursor: string;
      message: string;
    }>;

export type MutationKind = "create" | "update" | "lifecycle" | "delete";
export type MutationState =
  | Readonly<{ status: "pending"; kind: MutationKind }>
  | Readonly<{
      status: "retry" | "conflict" | "error";
      kind: MutationKind;
      message: string;
    }>;

export type RenewalHistoryState =
  | Readonly<{ status: "idle" | "loading"; events: readonly [] }>
  | Readonly<{
      status: "ready" | "loading_more";
      events: readonly PersistedRenewalEvent[];
      complete: boolean;
      nextCursor: string | null;
    }>
  | Readonly<{
      status: "error";
      events: readonly PersistedRenewalEvent[];
      complete: false;
      nextCursor: string | null;
      message: string;
    }>;

export type SubscriptionsSnapshot =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error"; message: string; retryable: boolean }>
  | Readonly<{
      status: "ready";
      items: readonly ManagedSubscription[];
      ledger: LedgerPageState;
      calendarEvents: readonly CalendarEvent[];
      calendarRange: CalendarRangeState;
      selectedId: string | null;
      history: RenewalHistoryState;
      mutation: MutationState | null;
      announcement: string | null;
    }>;

export interface SubscriptionsRuntime {
  snapshot(): SubscriptionsSnapshot;
  activate(subject: string): SubscriptionsSnapshot;
  subscribe(listener: (snapshot: SubscriptionsSnapshot) => void): () => void;
  boot(): Promise<SubscriptionsSnapshot>;
  reload(): Promise<SubscriptionsSnapshot>;
  loadMoreSubscriptions(): Promise<SubscriptionsSnapshot>;
  loadCalendarRange(input: CalendarRange): Promise<SubscriptionsSnapshot>;
  retryCalendarRange(): Promise<SubscriptionsSnapshot>;
  select(id: string): Promise<SubscriptionsSnapshot>;
  loadMoreHistory(): Promise<SubscriptionsSnapshot>;
  create(write: SubscriptionWrite): Promise<SubscriptionsSnapshot>;
  update(write: SubscriptionWrite): Promise<SubscriptionsSnapshot>;
  transition(
    id: string,
    action: LifecycleAction,
  ): Promise<SubscriptionsSnapshot>;
  remove(id: string): Promise<SubscriptionsSnapshot>;
  retry(): Promise<SubscriptionsSnapshot>;
  reset(): SubscriptionsSnapshot;
}

type ReadySnapshot = Extract<SubscriptionsSnapshot, { status: "ready" }>;
type RetryDescriptor = Readonly<{
  kind: MutationKind;
  before: readonly ManagedSubscription[];
  optimistic: readonly ManagedSubscription[];
  selectedId: string | null;
  execute: () => Promise<PersistedSubscription | void>;
  apply: (
    result: PersistedSubscription | void,
    current: ReadySnapshot,
  ) => readonly ManagedSubscription[];
  successMessage: string;
}>;

const ledgerPageSize = 50;
const historyPageSize = 20;
const calendarPageSize = 256;

export function createSubscriptionsRuntime(input: {
  subscriptionRepository: SubscriptionRepositoryBoundary;
  renewalRepository: RenewalHistoryRepositoryBoundary;
  calendarRepository: CalendarRepositoryBoundary;
  now?: () => string;
}): SubscriptionsRuntime {
  let state: SubscriptionsSnapshot = { status: "loading" };
  let generation = 0;
  let activeSubject: string | null = null;
  let loadPromise: Promise<SubscriptionsSnapshot> | null = null;
  let ledgerLoadPromise: Promise<SubscriptionsSnapshot> | null = null;
  let historyLoadGeneration = 0;
  let historyLoadPromise: Promise<SubscriptionsSnapshot> | null = null;
  let calendarLoadGeneration = 0;
  const calendarLoads = new Map<
    string,
    Readonly<{
      controller: AbortController;
      promise: Promise<SubscriptionsSnapshot>;
    }>
  >();
  let currentCalendarRequestKey: string | null = null;
  const maximumCalendarConcurrency = 2;
  let loadedCalendarPage: Readonly<{
    key: string;
    request: CalendarRange;
    page: CalendarPage;
  }> | null = null;
  let mutationRunning = false;
  let retryDescriptor: RetryDescriptor | null = null;
  const listeners = new Set<(snapshot: SubscriptionsSnapshot) => void>();
  const emit = () => {
    for (const listener of listeners) listener(state);
    return state;
  };

  const runtime: SubscriptionsRuntime = {
    snapshot: () => state,
    activate(subject) {
      if (activeSubject === subject) return state;
      generation += 1;
      activeSubject = subject;
      loadPromise = null;
      ledgerLoadPromise = null;
      historyLoadGeneration += 1;
      historyLoadPromise = null;
      calendarLoadGeneration += 1;
      abortCalendarLoads();
      currentCalendarRequestKey = null;
      loadedCalendarPage = null;
      mutationRunning = false;
      retryDescriptor = null;
      state = { status: "loading" };
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    boot() {
      if (loadPromise) return loadPromise;
      const operationGeneration = generation;
      state = { status: "loading" };
      emit();
      const operation = (async () => {
        try {
          const page = await input.subscriptionRepository.listPage({
            cursor: null,
            pageSize: ledgerPageSize,
          });
          if (operationGeneration !== generation) return state;
          const items = sortItems(
            page.items.map((record) => ({ record, syncStatus: "synced" })),
          );
          state = {
            status: "ready",
            items,
            ledger: {
              status: "ready",
              complete: page.complete,
              nextCursor: page.nextCursor,
            },
            calendarEvents: [],
            calendarRange: { status: "idle", requested: null, loaded: null },
            selectedId: items[0]?.record.subscription.id ?? null,
            history: { status: "idle", events: [] },
            mutation: null,
            announcement: null,
          };
        } catch {
          if (operationGeneration !== generation) return state;
          state = {
            status: "error",
            message: "Subscriptions could not be loaded.",
            retryable: true,
          };
        }
        return emit();
      })();
      const tracked = operation.finally(() => {
        if (loadPromise === tracked) loadPromise = null;
      });
      loadPromise = tracked;
      return tracked;
    },
    reload() {
      loadPromise = null;
      ledgerLoadPromise = null;
      historyLoadGeneration += 1;
      historyLoadPromise = null;
      calendarLoadGeneration += 1;
      abortCalendarLoads();
      currentCalendarRequestKey = null;
      loadedCalendarPage = null;
      retryDescriptor = null;
      mutationRunning = false;
      return runtime.boot();
    },
    loadMoreSubscriptions() {
      if (
        state.status !== "ready" ||
        state.ledger.complete ||
        state.ledger.status === "loading_more"
      ) {
        return Promise.resolve(state);
      }
      if (ledgerLoadPromise) return ledgerLoadPromise;
      const cursor = state.ledger.nextCursor;
      if (cursor === null) return Promise.resolve(state);
      const operationGeneration = generation;
      state = {
        ...state,
        ledger: {
          status: "loading_more",
          complete: false,
          nextCursor: cursor,
        },
      };
      emit();
      const operation = (async () => {
        try {
          const page = await input.subscriptionRepository.listPage({
            cursor,
            pageSize: ledgerPageSize,
          });
          if (operationGeneration !== generation || state.status !== "ready") {
            return state;
          }
          state = {
            ...state,
            items: sortItems(mergeSubscriptionPage(state.items, page.items)),
            ledger: {
              status: "ready",
              complete: page.complete,
              nextCursor: page.nextCursor,
            },
          };
        } catch {
          if (operationGeneration !== generation || state.status !== "ready") {
            return state;
          }
          state = {
            ...state,
            ledger: {
              status: "error",
              complete: false,
              nextCursor: cursor,
              message: "More subscriptions could not be loaded.",
            },
          };
        }
        return emit();
      })();
      const tracked = operation.finally(() => {
        if (ledgerLoadPromise === tracked) ledgerLoadPromise = null;
      });
      ledgerLoadPromise = tracked;
      return tracked;
    },
    loadCalendarRange(range) {
      if (state.status !== "ready") return Promise.resolve(state);
      let filter: CalendarPageQuery["filter"];
      let query: string;
      try {
        parseCalendarDate(range.rangeStart);
        parseCalendarDate(range.rangeEnd);
        if (range.rangeEnd < range.rangeStart) return Promise.resolve(state);
        filter = range.filter ?? "all";
        if (
          !["all", "trials", "charges", "access", "changes"].includes(filter)
        ) {
          return Promise.resolve(state);
        }
        if (range.query !== undefined && typeof range.query !== "string") {
          return Promise.resolve(state);
        }
        query = (range.query ?? "").trim();
        if (query.length > 160) return Promise.resolve(state);
      } catch {
        return Promise.resolve(state);
      }
      const requested: CalendarRange = {
        rangeStart: range.rangeStart,
        rangeEnd: range.rangeEnd,
        ...(range.filter === undefined ? {} : { filter }),
        ...(range.query === undefined ? {} : { query }),
      };
      const key = calendarRangeKey({ ...requested, filter, query });
      const existingLoad = calendarLoads.get(key);
      if (existingLoad) {
        currentCalendarRequestKey = key;
        state = {
          ...state,
          calendarRange: {
            status: "pending",
            requested,
            loaded: state.calendarRange.loaded,
          },
        };
        emit();
        return existingLoad.promise;
      }
      if (loadedCalendarPage?.key === key) {
        abortCalendarLoads();
        currentCalendarRequestKey = key;
        if (
          state.calendarRange.status !== "ready" ||
          calendarRangeKey(state.calendarRange.requested) !== key
        ) {
          state = {
            ...state,
            calendarEvents: [...loadedCalendarPage.page.events],
            calendarRange: {
              status: "ready",
              requested: loadedCalendarPage.request,
              loaded: loadedCalendarPage.request,
              complete: loadedCalendarPage.page.complete,
              nextCursor: loadedCalendarPage.page.nextCursor,
            },
          };
          return Promise.resolve(emit());
        }
        return Promise.resolve(state);
      }
      const operationGeneration = generation;
      const requestGeneration = calendarLoadGeneration;
      const previouslyLoaded = state.calendarRange.loaded;
      while (calendarLoads.size >= maximumCalendarConcurrency) {
        const oldest = calendarLoads.entries().next().value as
          | [
              string,
              Readonly<{
                controller: AbortController;
                promise: Promise<SubscriptionsSnapshot>;
              }>,
            ]
          | undefined;
        if (!oldest) break;
        oldest[1].controller.abort();
        calendarLoads.delete(oldest[0]);
      }
      const controller = new AbortController();
      currentCalendarRequestKey = key;
      state = {
        ...state,
        calendarRange: {
          status: "pending",
          requested,
          loaded: previouslyLoaded,
        },
      };
      emit();
      const operation = (async () => {
        try {
          const result = await input.calendarRepository.listPage({
            rangeStart: range.rangeStart,
            rangeEnd: range.rangeEnd,
            filter,
            query,
            pageSize: calendarPageSize,
            cursor: null,
            signal: controller.signal,
          });
          if (
            operationGeneration !== generation ||
            requestGeneration !== calendarLoadGeneration ||
            currentCalendarRequestKey !== key ||
            controller.signal.aborted ||
            state.status !== "ready"
          ) {
            return state;
          }
          loadedCalendarPage = { key, request: requested, page: result };
          state = {
            ...state,
            calendarEvents: [...result.events],
            calendarRange: {
              status: "ready",
              requested,
              loaded: requested,
              complete: result.complete,
              nextCursor: result.nextCursor,
            },
          };
          return emit();
        } catch {
          if (
            operationGeneration !== generation ||
            requestGeneration !== calendarLoadGeneration ||
            currentCalendarRequestKey !== key ||
            controller.signal.aborted ||
            state.status !== "ready"
          ) {
            return state;
          }
          state = {
            ...state,
            calendarRange: {
              status: "error",
              requested,
              loaded: previouslyLoaded,
              message: "Calendar events could not be loaded.",
            },
          };
          return emit();
        }
      })();
      const tracked = operation.finally(() => {
        if (calendarLoads.get(key)?.promise === tracked) {
          calendarLoads.delete(key);
        }
      });
      calendarLoads.set(key, { controller, promise: tracked });
      return tracked;
    },
    retryCalendarRange() {
      if (
        state.status !== "ready" ||
        (state.calendarRange.status !== "error" &&
          state.calendarRange.status !== "truncated")
      ) {
        return Promise.resolve(state);
      }
      return runtime.loadCalendarRange(state.calendarRange.requested);
    },
    select(id) {
      return selectSubscription(id);
    },
    loadMoreHistory() {
      if (
        state.status !== "ready" ||
        state.selectedId === null ||
        state.history.status === "idle" ||
        state.history.status === "loading" ||
        state.history.status === "loading_more" ||
        !("complete" in state.history) ||
        state.history.complete
      ) {
        return Promise.resolve(state);
      }
      if (historyLoadPromise) return historyLoadPromise;
      return loadHistoryPage(
        state.selectedId,
        state.history.nextCursor,
        state.history.events,
      );
    },
    create(write) {
      if (state.status !== "ready" || mutationRunning) {
        return Promise.resolve(state);
      }
      const id = safeSubscriptionId(write);
      if (id === null || findItem(state.items, id)) {
        return Promise.resolve(publishMissing("create"));
      }
      const optimisticRecord = persistedFromWrite(
        write,
        input.now?.() ?? new Date().toISOString(),
      );
      const optimistic = sortItems([
        ...state.items,
        { record: optimisticRecord, syncStatus: "pending" },
      ]);
      return perform({
        kind: "create",
        before: state.items,
        optimistic,
        selectedId: id,
        execute: () => input.subscriptionRepository.create(write),
        apply: (result, current) =>
          replaceItem(current.items, id, result as PersistedSubscription),
        successMessage: "Subscription added.",
      });
    },
    update(write) {
      return updateFromWrite(write, "update");
    },
    transition(id, action) {
      if (state.status !== "ready" || mutationRunning) {
        return Promise.resolve(state);
      }
      const item = findItem(state.items, id);
      if (!item) return Promise.resolve(publishMissing("lifecycle"));
      try {
        const current = item.record.subscription;
        const subscription =
          action.type === "resume"
            ? current.kind === "recurring"
              ? resumeRecurringSubscription(current, action.on)
              : invalidLifecycle()
            : action.type === "restart"
              ? current.kind === "recurring"
                ? restartRecurringSubscription(current, action.on)
                : invalidLifecycle()
              : action.type === "pause" && current.kind !== "recurring"
                ? invalidLifecycle()
                : {
                    ...current,
                    lifecycle: transitionLifecycle(current.lifecycle, action),
                  };
        return updateFromWrite(
          { subscription, metadata: item.record.metadata },
          "lifecycle",
        );
      } catch {
        state = {
          ...state,
          mutation: {
            status: "error",
            kind: "lifecycle",
            message: "That lifecycle change is not available.",
          },
          announcement: null,
        };
        return Promise.resolve(emit());
      }
    },
    remove(id) {
      if (state.status !== "ready" || mutationRunning) {
        return Promise.resolve(state);
      }
      const item = findItem(state.items, id);
      if (!item) return Promise.resolve(publishMissing("delete"));
      const optimistic = state.items.filter(
        (candidate) => candidate.record.subscription.id !== id,
      );
      return perform({
        kind: "delete",
        before: state.items,
        optimistic,
        selectedId: optimistic[0]?.record.subscription.id ?? null,
        execute: () =>
          input.subscriptionRepository.delete(id, item.record.version),
        apply: (_result, current) =>
          current.items.filter(
            (candidate) => candidate.record.subscription.id !== id,
          ),
        successMessage: "Subscription permanently deleted.",
      });
    },
    retry() {
      if (!retryDescriptor || mutationRunning) return Promise.resolve(state);
      return perform(retryDescriptor);
    },
    reset() {
      generation += 1;
      activeSubject = null;
      loadPromise = null;
      ledgerLoadPromise = null;
      historyLoadGeneration += 1;
      historyLoadPromise = null;
      calendarLoadGeneration += 1;
      abortCalendarLoads();
      currentCalendarRequestKey = null;
      loadedCalendarPage = null;
      mutationRunning = false;
      retryDescriptor = null;
      state = { status: "loading" };
      return emit();
    },
  };

  async function selectSubscription(
    id: string,
  ): Promise<SubscriptionsSnapshot> {
    if (state.status !== "ready" || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)) {
      return state;
    }
    const operationGeneration = generation;
    const selectionGeneration = ++historyLoadGeneration;
    historyLoadPromise = null;
    let item = findItem(state.items, id);
    if (item === undefined) {
      state = {
        ...state,
        history: { status: "loading", events: [] },
        announcement: null,
      };
      emit();
      try {
        const record = await input.subscriptionRepository.get(id);
        if (
          operationGeneration !== generation ||
          selectionGeneration !== historyLoadGeneration ||
          state.status !== "ready"
        ) {
          return state;
        }
        if (record === null) return publishMissing("update");
        state = {
          ...state,
          items: sortItems(mergeSubscriptionPage(state.items, [record])),
        };
        item = findItem(state.items, id);
      } catch {
        if (
          operationGeneration !== generation ||
          selectionGeneration !== historyLoadGeneration ||
          state.status !== "ready"
        ) {
          return state;
        }
        return publishMissing("update");
      }
    }
    if (!item || state.status !== "ready") return state;
    state = {
      ...state,
      selectedId: id,
      history: { status: "loading", events: [] },
      announcement: null,
    };
    emit();
    return loadHistoryPage(id, null, [], selectionGeneration);
  }

  function loadHistoryPage(
    subscriptionId: string,
    cursor: string | null,
    priorEvents: readonly PersistedRenewalEvent[],
    existingGeneration?: number,
  ) {
    if (state.status !== "ready") return Promise.resolve(state);
    const operationGeneration = generation;
    const requestGeneration = existingGeneration ?? ++historyLoadGeneration;
    state = {
      ...state,
      history:
        priorEvents.length === 0 && cursor === null
          ? { status: "loading", events: [] }
          : {
              status: "loading_more",
              events: priorEvents,
              complete: false,
              nextCursor: cursor,
            },
    };
    emit();
    const operation = (async () => {
      try {
        const page = await input.renewalRepository.listPage({
          subscriptionId,
          cursor,
          pageSize: historyPageSize,
        });
        if (
          operationGeneration !== generation ||
          requestGeneration !== historyLoadGeneration ||
          state.status !== "ready" ||
          state.selectedId !== subscriptionId
        ) {
          return state;
        }
        state = {
          ...state,
          history: {
            status: "ready",
            events: mergeRenewalHistory(priorEvents, page.events),
            complete: page.complete,
            nextCursor: page.nextCursor,
          },
        };
      } catch {
        if (
          operationGeneration !== generation ||
          requestGeneration !== historyLoadGeneration ||
          state.status !== "ready" ||
          state.selectedId !== subscriptionId
        ) {
          return state;
        }
        state = {
          ...state,
          history: {
            status: "error",
            events: priorEvents,
            complete: false,
            nextCursor: cursor,
            message: "History could not be loaded.",
          },
        };
      }
      return emit();
    })();
    const tracked = operation.finally(() => {
      if (historyLoadPromise === tracked) historyLoadPromise = null;
    });
    historyLoadPromise = tracked;
    return tracked;
  }

  function updateFromWrite(
    write: SubscriptionWrite,
    kind: "update" | "lifecycle",
  ): Promise<SubscriptionsSnapshot> {
    if (state.status !== "ready" || mutationRunning) {
      return Promise.resolve(state);
    }
    const id = safeSubscriptionId(write);
    if (id === null) return Promise.resolve(publishMissing(kind));
    const item = findItem(state.items, id);
    if (!item) return Promise.resolve(publishMissing(kind));
    const optimisticRecord: PersistedSubscription = {
      subscription: write.subscription,
      metadata: normalizeMetadata(write.metadata),
      version: item.record.version,
      createdAt: item.record.createdAt,
      updatedAt: item.record.updatedAt,
    };
    const optimistic = replaceItem(
      state.items,
      id,
      optimisticRecord,
      "pending",
    );
    return perform({
      kind,
      before: state.items,
      optimistic,
      selectedId: id,
      execute: () =>
        input.subscriptionRepository.update(write, item.record.version),
      apply: (result, current) =>
        replaceItem(current.items, id, result as PersistedSubscription),
      successMessage:
        kind === "lifecycle"
          ? "Subscription status updated."
          : "Subscription updated.",
    });
  }

  async function perform(
    descriptor: RetryDescriptor,
  ): Promise<SubscriptionsSnapshot> {
    if (state.status !== "ready") return state;
    mutationRunning = true;
    retryDescriptor = null;
    const operationGeneration = generation;
    state = {
      ...state,
      items: descriptor.optimistic,
      selectedId: descriptor.selectedId,
      history: { status: "idle", events: [] },
      mutation: { status: "pending", kind: descriptor.kind },
      announcement: null,
    };
    emit();
    try {
      const result = await descriptor.execute();
      if (operationGeneration !== generation || state.status !== "ready") {
        return state;
      }
      state = {
        ...state,
        items: sortItems(descriptor.apply(result, state)),
        mutation: null,
        announcement: descriptor.successMessage,
      };
      const refreshRange = invalidateCalendarTruth();
      if (refreshRange !== null) {
        emit();
        await runtime.loadCalendarRange(refreshRange);
      }
    } catch (error) {
      if (operationGeneration !== generation || state.status !== "ready") {
        return state;
      }
      const failure = mutationFailure(error, descriptor.kind);
      if (failure.status === "retry") retryDescriptor = descriptor;
      state = {
        ...state,
        items: descriptor.before,
        selectedId: selectionAfterRollback(
          descriptor.before,
          descriptor.selectedId,
        ),
        mutation: failure,
        announcement: null,
      };
      if (calendarTruthMayHaveChanged(error)) {
        const refreshRange = invalidateCalendarTruth();
        if (refreshRange !== null) {
          emit();
          await runtime.loadCalendarRange(refreshRange);
        }
      }
    } finally {
      if (operationGeneration === generation) mutationRunning = false;
    }
    return emit();
  }

  function publishMissing(kind: MutationKind) {
    if (state.status !== "ready") return state;
    retryDescriptor = null;
    state = {
      ...state,
      mutation: {
        status: "conflict",
        kind,
        message:
          "This item changed or is unavailable. Reload before continuing.",
      },
      announcement: null,
    };
    return emit();
  }

  return runtime;

  function abortCalendarLoads() {
    for (const { controller } of calendarLoads.values()) controller.abort();
    calendarLoads.clear();
  }

  function invalidateCalendarTruth(): CalendarRange | null {
    if (state.status !== "ready") return null;
    const requested =
      state.calendarRange.status === "idle"
        ? null
        : state.calendarRange.requested;
    calendarLoadGeneration += 1;
    abortCalendarLoads();
    currentCalendarRequestKey = null;
    loadedCalendarPage = null;
    state = {
      ...state,
      calendarEvents: [],
      calendarRange: { status: "idle", requested: null, loaded: null },
    };
    return requested;
  }
}

function calendarTruthMayHaveChanged(error: unknown) {
  return (
    error instanceof DataPlaneError &&
    (error.reason === "conflict" || error.reason === "unavailable")
  );
}

function mutationFailure(error: unknown, kind: MutationKind): MutationState {
  if (error instanceof DataPlaneError) {
    if (error.reason === "conflict") {
      return {
        status: "conflict",
        kind,
        message:
          "This item changed or is unavailable. Reload before continuing.",
      };
    }
    if (error.reason === "unavailable") {
      return {
        status: "retry",
        kind,
        message: "Change not saved. Check your connection and retry.",
      };
    }
    if (error.reason === "auth") {
      return {
        status: "error",
        kind,
        message: "Subscription data could not be accessed. Sign in again.",
      };
    }
  }
  return {
    status: "error",
    kind,
    message: "That change could not be saved. Review the fields and try again.",
  };
}

function calendarRangeKey(range: CalendarRange) {
  return `${range.rangeStart}:${range.rangeEnd}:${range.filter ?? "all"}:${(
    range.query ?? ""
  ).trim()}`;
}

function mergeSubscriptionPage(
  current: readonly ManagedSubscription[],
  page: readonly PersistedSubscription[],
) {
  const merged = new Map(
    current.map((item) => [item.record.subscription.id, item] as const),
  );
  for (const record of page) {
    const existing = merged.get(record.subscription.id);
    if (existing?.syncStatus === "pending") continue;
    merged.set(record.subscription.id, { record, syncStatus: "synced" });
  }
  return [...merged.values()];
}

function mergeRenewalHistory(
  current: readonly PersistedRenewalEvent[],
  page: readonly PersistedRenewalEvent[],
) {
  const merged = new Map(
    current.map((item) => [item.event.idempotencyKey, item] as const),
  );
  for (const event of page) merged.set(event.event.idempotencyKey, event);
  return [...merged.values()].sort(
    (left, right) =>
      left.event.occurrenceDate.localeCompare(right.event.occurrenceDate) ||
      left.event.idempotencyKey.localeCompare(right.event.idempotencyKey),
  );
}

function safeSubscriptionId(write: SubscriptionWrite) {
  try {
    const id: unknown = write.subscription.id;
    return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(id)
      ? id
      : null;
  } catch {
    return null;
  }
}

function normalizeMetadata(
  metadata: SubscriptionWrite["metadata"],
): SubscriptionMetadata {
  return { ...metadata, category: metadata.category ?? null };
}

function persistedFromWrite(
  write: SubscriptionWrite,
  timestamp: string,
): PersistedSubscription {
  return {
    subscription: write.subscription,
    metadata: normalizeMetadata(write.metadata),
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function findItem(items: readonly ManagedSubscription[], id: string) {
  return items.find((item) => item.record.subscription.id === id);
}

function replaceItem(
  items: readonly ManagedSubscription[],
  id: string,
  record: PersistedSubscription,
  syncStatus: ManagedSubscription["syncStatus"] = "synced",
) {
  return items.map((item) =>
    item.record.subscription.id === id ? { record, syncStatus } : item,
  );
}

function selectionAfterRollback(
  items: readonly ManagedSubscription[],
  preferred: string | null,
) {
  if (preferred && findItem(items, preferred)) return preferred;
  return items[0]?.record.subscription.id ?? null;
}

function sortItems(items: readonly ManagedSubscription[]) {
  return [...items].sort((left, right) => {
    const leftDate =
      left.record.subscription.kind === "recurring"
        ? left.record.subscription.nextRenewalDate
        : (left.record.subscription.accessEndsOn ?? "9999-12-31");
    const rightDate =
      right.record.subscription.kind === "recurring"
        ? right.record.subscription.nextRenewalDate
        : (right.record.subscription.accessEndsOn ?? "9999-12-31");
    return (
      leftDate.localeCompare(rightDate) ||
      left.record.subscription.serviceName.localeCompare(
        right.record.subscription.serviceName,
      )
    );
  });
}

function invalidLifecycle(): never {
  throw new Error("invalid_lifecycle");
}

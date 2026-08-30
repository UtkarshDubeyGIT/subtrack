import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import {
  createRecurringSubscription,
  type FxRateInput,
  type LifecycleAction,
} from "@subtrack/domain";
import type { PersistedSubscription } from "@subtrack/data";
import { buildSpendView, type SpendView } from "./spend-view";
import {
  applyCuratedServiceDefaults,
  createSubscriptionDraft,
  CURATED_SERVICES,
  draftFromPersistedSubscription,
  validateSubscriptionDraft,
  type SubscriptionDraft,
  type SubscriptionDraftErrors,
} from "./subscription-draft";
import type {
  CalendarRange,
  ManagedSubscription,
  MutationState,
  SubscriptionsRuntime,
  SubscriptionsSnapshot,
} from "./subscriptions-runtime";
import { CalendarAgendaExperience } from "./CalendarAgendaExperience";
import {
  createBillingDateProposalRange,
  isBillingDateProposalValid,
} from "./calendar-agenda-model";

type EditorState = Readonly<{
  mode: "create" | "edit";
  id: string;
  draft: SubscriptionDraft;
  errors: SubscriptionDraftErrors;
  advanced: boolean;
}>;

type LifecycleDialogState = Readonly<{
  id: string;
  serviceName: string;
  action: LifecycleAction["type"];
  on: string;
  minimumOn: string;
  accessEndsOn: string;
}>;

export function SubscriptionExperience({
  runtime,
  homeCurrency,
  timezone,
  locale,
  today,
  createId = defaultSubscriptionId,
  fxRates = [],
}: Readonly<{
  runtime: SubscriptionsRuntime;
  homeCurrency: string;
  timezone: string;
  locale: string;
  today?: () => string;
  createId?: () => string;
  /**
   * Rates used to normalize spend into the home currency. Empty until FX
   * ingestion ships, which is correct rather than degraded: single-currency
   * portfolios need no rates, and foreign amounts are reported as
   * unconverted instead of being silently omitted from the totals.
   */
  fxRates?: readonly FxRateInput[];
}>) {
  const [snapshot, setSnapshot] = useState<SubscriptionsSnapshot>(
    runtime.snapshot(),
  );
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [lifecycleDialog, setLifecycleDialog] =
    useState<LifecycleDialogState | null>(null);
  const [deleteRecord, setDeleteRecord] =
    useState<PersistedSubscription | null>(null);
  const quickAddButton = useRef<HTMLButtonElement>(null);
  const serviceInput = useRef<HTMLInputElement>(null);
  const subscriptionDetail = useRef<HTMLElement>(null);
  const pendingAgendaDetailFocus = useRef<string | null>(null);
  const dialogReturnFocus = useRef<HTMLElement | null>(null);
  const editorId = editor?.id;
  const displayLocale = canonicalLocale(locale);
  const accountToday = () => today?.() ?? todayInTimezone(timezone);
  const loadCalendarRange = useCallback(
    (range: CalendarRange) => runtime.loadCalendarRange(range),
    [runtime],
  );
  const retryCalendarRange = useCallback(
    () => runtime.retryCalendarRange(),
    [runtime],
  );

  useEffect(() => {
    const unsubscribe = runtime.subscribe(setSnapshot);
    void runtime.boot();
    return unsubscribe;
  }, [runtime]);

  const openCreate = () => {
    dialogReturnFocus.current =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
        ? document.activeElement
        : quickAddButton.current;
    setLifecycleDialog(null);
    setDeleteRecord(null);
    setEditor({
      mode: "create",
      id: createId(),
      draft: createSubscriptionDraft({ homeCurrency, timezone }),
      errors: {},
      advanced: false,
    });
  };

  const closeEditor = () => {
    setEditor(null);
    restoreDialogFocus(dialogReturnFocus, quickAddButton);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "n" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey
      ) {
        event.preventDefault();
        if (!editor && !lifecycleDialog && !deleteRecord) openCreate();
        return;
      }
      if (event.key === "Escape") {
        if (editor) closeEditor();
        else if (lifecycleDialog) {
          setLifecycleDialog(null);
          restoreDialogFocus(dialogReturnFocus, quickAddButton);
        } else if (deleteRecord) {
          setDeleteRecord(null);
          restoreDialogFocus(dialogReturnFocus, quickAddButton);
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  });

  useEffect(() => {
    if (editorId && snapshot.status === "ready") serviceInput.current?.focus();
  }, [editorId, snapshot.status]);

  useEffect(() => {
    if (
      snapshot.status !== "ready" ||
      pendingAgendaDetailFocus.current === null ||
      pendingAgendaDetailFocus.current !== snapshot.selectedId
    ) {
      return;
    }
    pendingAgendaDetailFocus.current = null;
    subscriptionDetail.current?.focus();
  }, [snapshot]);

  if (snapshot.status === "loading") {
    return (
      <section className="subscription-state" aria-live="polite">
        <span className="ledger-loader" aria-hidden="true" />
        Loading private subscriptions…
      </section>
    );
  }

  if (snapshot.status === "error") {
    return (
      <section
        className="subscription-state"
        aria-labelledby="subscriptions-error"
      >
        <p className="eyebrow">PRIVATE LEDGER</p>
        <h2 id="subscriptions-error" tabIndex={-1}>
          Subscriptions need another try
        </h2>
        <p role="alert">{snapshot.message}</p>
        {snapshot.retryable ? (
          <button type="button" onClick={() => void runtime.reload()}>
            Reload subscriptions
          </button>
        ) : (
          <p>Update the data-sync build configuration, then rebuild the app.</p>
        )}
      </section>
    );
  }

  const currentItems = snapshot.items.filter(
    ({ record }) => record.subscription.lifecycle.status !== "expired",
  );
  const archivedItems = snapshot.items.filter(
    ({ record }) => record.subscription.lifecycle.status === "expired",
  );
  const selected = snapshot.items.find(
    ({ record }) => record.subscription.id === snapshot.selectedId,
  );
  const mutationPending = snapshot.mutation?.status === "pending";
  const spendView = buildSpendView({
    records: currentItems.map(({ record }) => record),
    rates: fxRates,
    homeCurrency,
    locale: displayLocale,
  });
  const selectFromCalendar = (id: string) => {
    pendingAgendaDetailFocus.current = id;
    if (snapshot.selectedId === id) {
      queueMicrotask(() => {
        pendingAgendaDetailFocus.current = null;
        subscriptionDetail.current?.focus();
      });
    }
    return runtime.select(id);
  };

  const openEdit = (record: PersistedSubscription) => {
    dialogReturnFocus.current = document.activeElement as HTMLElement | null;
    setEditor({
      mode: "edit",
      id: record.subscription.id,
      draft: draftFromPersistedSubscription(record),
      errors: {},
      advanced: true,
    });
  };

  const submitEditor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || mutationPending) return;
    const result = validateSubscriptionDraft(editor.draft, {
      id: editor.id,
      today: accountToday(),
    });
    if (!result.success) {
      setEditor({ ...editor, errors: result.errors });
      return;
    }
    let write = result.write;
    if (editor.mode === "edit") {
      const existing = snapshot.items.find(
        ({ record }) => record.subscription.id === editor.id,
      );
      if (!existing) return;
      write = {
        ...write,
        subscription: {
          ...write.subscription,
          lifecycle: existing.record.subscription.lifecycle,
        },
      };
    }
    const next =
      editor.mode === "create"
        ? await runtime.create(write)
        : await runtime.update(write);
    if (next.status === "ready") closeEditor();
  };

  const openLifecycle = (
    record: PersistedSubscription,
    action: LifecycleAction["type"],
  ) => {
    dialogReturnFocus.current = document.activeElement as HTMLElement | null;
    const requestedOn = accountToday();
    const minimumOn =
      action === "expire" && record.subscription.lifecycle.status === "canceled"
        ? record.subscription.lifecycle.accessEndsOn
        : record.subscription.lifecycle.since;
    setLifecycleDialog({
      id: record.subscription.id,
      serviceName: record.subscription.serviceName,
      action,
      on: requestedOn < minimumOn ? minimumOn : requestedOn,
      minimumOn,
      accessEndsOn: "",
    });
  };

  const submitLifecycle = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!lifecycleDialog || mutationPending) return;
    const action =
      lifecycleDialog.action === "cancel"
        ? {
            type: "cancel" as const,
            on: lifecycleDialog.on,
            accessEndsOn: lifecycleDialog.accessEndsOn,
          }
        : ({
            type: lifecycleDialog.action,
            on: lifecycleDialog.on,
          } as LifecycleAction);
    const next = await runtime.transition(lifecycleDialog.id, action);
    if (next.status === "ready") {
      setLifecycleDialog(null);
      restoreDialogFocus(dialogReturnFocus, quickAddButton);
    }
  };

  const confirmDelete = async () => {
    if (!deleteRecord || mutationPending) return;
    const next = await runtime.remove(deleteRecord.subscription.id);
    if (next.status === "ready") {
      setDeleteRecord(null);
      restoreDialogFocus(dialogReturnFocus, quickAddButton);
    }
  };

  const rescheduleSubscription = async (id: string, date: string) => {
    if (mutationPending) return snapshot;
    const managed = snapshot.items.find(
      ({ record }) => record.subscription.id === id,
    );
    if (!managed) return snapshot;
    const subscription = managed.record.subscription;
    if (
      subscription.kind !== "recurring" ||
      subscription.lifecycle.status !== "active" ||
      subscription.nextRenewalDate === date
    ) {
      return snapshot;
    }
    const proposalRange = createBillingDateProposalRange(
      subscription,
      accountToday(),
    );
    if (!proposalRange || !isBillingDateProposalValid(date, proposalRange)) {
      return snapshot;
    }
    const moved = createRecurringSubscription({
      ...subscription,
      startDate: date,
      nextRenewalDate: date,
    });
    return runtime.update({
      subscription: moved,
      metadata: managed.record.metadata,
    });
  };

  return (
    <section
      className="subscription-workspace"
      aria-labelledby="subscriptions-heading"
    >
      <header className="ledger-header">
        <div>
          <p className="eyebrow">PRIVATE RENEWAL LEDGER</p>
          <h2 id="subscriptions-heading">Subscriptions</h2>
          <p>
            Capture billing truth once, then keep every status and correction
            visible.
          </p>
        </div>
        <button
          ref={quickAddButton}
          type="button"
          className="quick-add-button"
          aria-label="Add subscription"
          aria-keyshortcuts="Meta+N Control+N"
          onClick={openCreate}
        >
          <span aria-hidden="true">＋</span>
          Add subscription
          <kbd>⌘/Ctrl N</kbd>
        </button>
      </header>

      <MutationBanner mutation={snapshot.mutation} runtime={runtime} />
      {snapshot.announcement ? (
        <output className="success-announcement" aria-live="polite">
          {snapshot.announcement}
        </output>
      ) : null}

      <SpendSummary view={spendView} />

      <CalendarAgendaExperience
        items={snapshot.items}
        events={snapshot.calendarEvents}
        selectedSubscriptionId={snapshot.selectedId}
        locale={displayLocale}
        timezone={timezone}
        today={accountToday()}
        mutationPending={mutationPending}
        onSelectSubscription={selectFromCalendar}
        calendarRangeState={snapshot.calendarRange}
        onCalendarRangeChange={loadCalendarRange}
        onRetryCalendarRange={retryCalendarRange}
        onRescheduleSubscription={(id, date) =>
          rescheduleSubscription(id, date)
        }
      />

      <div className="ledger-layout">
        <div className="ledger-column">
          <section
            className="ledger-section"
            aria-labelledby="active-ledger-heading"
          >
            <div className="section-heading-row">
              <h3 id="active-ledger-heading">Current ledger</h3>
              <span>{currentItems.length}</span>
            </div>
            {currentItems.length === 0 ? (
              <div className="empty-ledger">
                <strong>No subscriptions yet</strong>
                <p>Add the next charge you want to see coming.</p>
                <button type="button" onClick={openCreate}>
                  Add your first subscription
                </button>
              </div>
            ) : (
              <SubscriptionList
                items={currentItems}
                selectedId={snapshot.selectedId}
                locale={displayLocale}
                onSelect={(id) => void runtime.select(id)}
              />
            )}
          </section>

          <section
            className="ledger-section archive-section"
            aria-label="Archive and history"
          >
            <div className="section-heading-row">
              <h3>Archive &amp; history</h3>
              <span>{archivedItems.length}</span>
            </div>
            {archivedItems.length === 0 ? (
              <p className="archive-empty">
                Expired items stay here with their renewal history.
              </p>
            ) : (
              <SubscriptionList
                items={archivedItems}
                selectedId={snapshot.selectedId}
                locale={displayLocale}
                onSelect={(id) => void runtime.select(id)}
              />
            )}
          </section>

          <div
            className="ledger-pagination"
            role="group"
            aria-label="Ledger pages"
          >
            <p role="status" aria-live="polite">
              {`${snapshot.items.length} ${snapshot.items.length === 1 ? "subscription" : "subscriptions"} loaded`}
            </p>
            {snapshot.ledger.status === "error" ? (
              <p role="alert">{snapshot.ledger.message}</p>
            ) : null}
            <button
              type="button"
              className="secondary-button"
              aria-label="Load more subscriptions"
              aria-disabled={
                snapshot.ledger.complete ||
                snapshot.ledger.status === "loading_more"
              }
              onClick={() => {
                if (
                  snapshot.ledger.complete ||
                  snapshot.ledger.status === "loading_more"
                ) {
                  return;
                }
                void runtime.loadMoreSubscriptions();
              }}
            >
              {snapshot.ledger.status === "loading_more"
                ? "Loading more…"
                : snapshot.ledger.complete
                  ? "All subscriptions loaded"
                  : snapshot.ledger.status === "error"
                    ? "Retry loading more"
                    : "Load more"}
            </button>
          </div>
        </div>

        <aside
          ref={subscriptionDetail}
          id="subscription-detail"
          className="subscription-detail"
          tabIndex={-1}
          aria-label={
            selected
              ? `Billing details for ${selected.record.subscription.serviceName}`
              : "Subscription details"
          }
        >
          <output
            className="visually-hidden"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label="Subscription detail result"
          >
            {selected
              ? `Showing billing details for ${selected.record.subscription.serviceName}.`
              : "No subscription details selected."}
          </output>
          {selected ? (
            <SubscriptionDetail
              item={selected}
              history={snapshot.history}
              locale={displayLocale}
              onEdit={() => openEdit(selected.record)}
              onLifecycle={(action) => openLifecycle(selected.record, action)}
              onDelete={() => {
                dialogReturnFocus.current =
                  document.activeElement as HTMLElement | null;
                setDeleteRecord(selected.record);
              }}
              onLoadMoreHistory={() => void runtime.loadMoreHistory()}
            />
          ) : (
            <div className="detail-placeholder">
              <span aria-hidden="true">↗</span>
              <p>
                Select a subscription to view its billing truth and history.
              </p>
            </div>
          )}
        </aside>
      </div>

      {editor ? (
        <SubscriptionEditor
          state={editor}
          serviceInput={serviceInput}
          pending={mutationPending}
          onChange={setEditor}
          onClose={closeEditor}
          onSubmit={(event) => void submitEditor(event)}
        />
      ) : null}

      {lifecycleDialog ? (
        <LifecycleDialog
          state={lifecycleDialog}
          pending={mutationPending}
          onChange={setLifecycleDialog}
          onClose={() => {
            setLifecycleDialog(null);
            restoreDialogFocus(dialogReturnFocus, quickAddButton);
          }}
          onSubmit={(event) => void submitLifecycle(event)}
        />
      ) : null}

      {deleteRecord ? (
        <DeleteDialog
          record={deleteRecord}
          pending={mutationPending}
          onClose={() => {
            setDeleteRecord(null);
            restoreDialogFocus(dialogReturnFocus, quickAddButton);
          }}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </section>
  );
}

function SubscriptionList({
  items,
  selectedId,
  locale,
  onSelect,
}: Readonly<{
  items: readonly ManagedSubscription[];
  selectedId: string | null;
  locale: string;
  onSelect: (id: string) => void;
}>) {
  return (
    <div className="subscription-list">
      {items.map(({ record, syncStatus }) => {
        const subscription = record.subscription;
        const date =
          subscription.kind === "recurring"
            ? subscription.nextRenewalDate
            : (subscription.accessEndsOn ?? subscription.purchasedOn);
        const dateLabel =
          subscription.kind === "recurring"
            ? "Next renewal"
            : subscription.accessEndsOn
              ? "Access ends"
              : "Purchased";
        const billingSummary = [
          subscription.serviceName,
          `${dateLabel}: ${formatLongDate(date, locale)}`,
          formatMoney(record, locale),
          lifecycleLabel(subscription.lifecycle.status),
          ...(syncStatus === "pending" ? ["Pending sync"] : []),
        ].join(". ");
        return (
          <button
            key={subscription.id}
            type="button"
            className="subscription-row"
            data-selected={selectedId === subscription.id}
            aria-label={billingSummary}
            aria-pressed={selectedId === subscription.id}
            onClick={() => onSelect(subscription.id)}
          >
            <DateTab date={date} locale={locale} />
            <span className="subscription-row-copy">
              <strong>{subscription.serviceName}</strong>
              <small>
                {record.metadata.planName ??
                  record.metadata.category ??
                  "No plan label"}
              </small>
            </span>
            <span className="subscription-row-meta">
              <strong>{formatMoney(record, locale)}</strong>
              <small
                className={`status status-${subscription.lifecycle.status}`}
              >
                {syncStatus === "pending"
                  ? "Pending sync"
                  : lifecycleLabel(subscription.lifecycle.status)}
              </small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SubscriptionDetail({
  item,
  history,
  locale,
  onEdit,
  onLifecycle,
  onDelete,
  onLoadMoreHistory,
}: Readonly<{
  item: ManagedSubscription;
  history: Extract<SubscriptionsSnapshot, { status: "ready" }>["history"];
  locale: string;
  onEdit: () => void;
  onLifecycle: (action: LifecycleAction["type"]) => void;
  onDelete: () => void;
  onLoadMoreHistory: () => void;
}>) {
  const { record } = item;
  const { subscription, metadata } = record;
  const actions = lifecycleActions(record);
  const historyComplete = "complete" in history ? history.complete : false;
  return (
    <div>
      <p className="eyebrow">BILLING TRUTH</p>
      <div className="detail-title-row">
        <div>
          <h3>{subscription.serviceName}</h3>
          <p>{metadata.planName ?? "No plan label"}</p>
        </div>
        <span className={`status status-${subscription.lifecycle.status}`}>
          {lifecycleLabel(subscription.lifecycle.status)}
        </span>
      </div>
      <dl className="truth-grid">
        <div>
          <dt>Amount</dt>
          <dd>{formatMoney(record, locale)}</dd>
        </div>
        <div>
          <dt>
            {subscription.kind === "recurring" ? "Next renewal" : "Purchased"}
          </dt>
          <dd>
            {formatLongDate(
              subscription.kind === "recurring"
                ? subscription.nextRenewalDate
                : subscription.purchasedOn,
              locale,
            )}
          </dd>
        </div>
        <div>
          <dt>Cadence</dt>
          <dd>{recurrenceLabel(record)}</dd>
        </div>
        <div>
          <dt>Category</dt>
          <dd>{metadata.category ?? "Uncategorized"}</dd>
        </div>
        {metadata.paymentLabel ? (
          <div>
            <dt>Payment label</dt>
            <dd>{metadata.paymentLabel}</dd>
          </div>
        ) : null}
        {metadata.accountEmail ? (
          <div>
            <dt>Account email</dt>
            <dd>{metadata.accountEmail}</dd>
          </div>
        ) : null}
      </dl>
      <div className="detail-actions">
        <button type="button" onClick={onEdit}>
          Edit subscription
        </button>
        {actions.map(({ action, label }) => (
          <button
            key={action}
            type="button"
            onClick={() => onLifecycle(action)}
          >
            {label}
          </button>
        ))}
      </div>
      <button type="button" className="danger-link" onClick={onDelete}>
        Delete permanently
      </button>

      <section
        className="history-panel"
        aria-labelledby="renewal-history-heading"
      >
        <h4 id="renewal-history-heading">Renewal history</h4>
        {history.status === "idle" ? (
          <p>Select this item to load retained history.</p>
        ) : history.status === "loading" ? (
          <p>Loading renewal history…</p>
        ) : (
          <>
            {history.status === "error" ? (
              <p role="alert">{history.message}</p>
            ) : null}
            {history.events.length === 0 ? (
              <p>No recorded renewals yet.</p>
            ) : (
              <ol>
                {history.events.map(({ event }) => (
                  <li key={event.idempotencyKey}>
                    <span className="history-mark" aria-hidden="true" />
                    <span>
                      <strong>{`${capitalize(event.state)} renewal`}</strong>
                      <small>
                        {formatLongDate(event.occurrenceDate, locale)}
                      </small>
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <button
              type="button"
              className="secondary-button"
              aria-label="Load more renewal history"
              aria-disabled={
                historyComplete || history.status === "loading_more"
              }
              onClick={() => {
                if (historyComplete || history.status === "loading_more") {
                  return;
                }
                onLoadMoreHistory();
              }}
            >
              {history.status === "loading_more"
                ? "Loading more history…"
                : historyComplete
                  ? "All renewal history loaded"
                  : history.status === "error"
                    ? "Retry loading history"
                    : "Load more history"}
            </button>
          </>
        )}
      </section>
    </div>
  );
}

function SubscriptionEditor({
  state,
  serviceInput,
  pending,
  onChange,
  onClose,
  onSubmit,
}: Readonly<{
  state: EditorState;
  serviceInput: RefObject<HTMLInputElement | null>;
  pending: boolean;
  onChange: (state: EditorState) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}>) {
  const title =
    state.mode === "create"
      ? "Add a subscription"
      : `Edit ${state.draft.serviceName}`;
  const setDraft = (draft: SubscriptionDraft) =>
    onChange({ ...state, draft, errors: {} });
  const errorMessages = [...new Set(Object.values(state.errors))];
  return (
    <div className="dialog-backdrop">
      <section
        className="subscription-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="subscription-editor-title"
        onKeyDown={trapDialogFocus}
      >
        <header className="dialog-header">
          <div>
            <p className="eyebrow">
              {state.mode === "create" ? "QUICK CAPTURE" : "EDIT BILLING TRUTH"}
            </p>
            <h2 id="subscription-editor-title">{title}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <form onSubmit={onSubmit}>
          {errorMessages.length > 0 ? (
            <div className="form-error" role="alert">
              {errorMessages.map((message) => (
                <p key={message}>{message}</p>
              ))}
            </div>
          ) : null}
          <fieldset disabled={pending} className="quick-fields">
            <label>
              Service
              <input
                ref={serviceInput}
                name="serviceName"
                list="curated-services"
                value={state.draft.serviceName}
                maxLength={160}
                required
                autoComplete="off"
                onChange={(event) =>
                  setDraft(
                    applyCuratedServiceDefaults(
                      state.draft,
                      event.currentTarget.value,
                    ),
                  )
                }
              />
              <datalist id="curated-services">
                {CURATED_SERVICES.map((service) => (
                  <option key={service.name} value={service.name} />
                ))}
              </datalist>
            </label>
            <label>
              Item type
              <select
                value={state.draft.kind}
                disabled={state.mode === "edit" || pending}
                onChange={(event) =>
                  setDraft({
                    ...state.draft,
                    kind: event.currentTarget
                      .value as SubscriptionDraft["kind"],
                  })
                }
              >
                <option value="recurring">Recurring subscription</option>
                <option value="one_time">One-time access</option>
              </select>
            </label>
            <label>
              Amount
              <input
                name="amount"
                inputMode="decimal"
                value={state.draft.amount}
                required
                autoComplete="off"
                onChange={(event) =>
                  setDraft({
                    ...state.draft,
                    amount: event.currentTarget.value,
                  })
                }
              />
            </label>
            <label>
              Currency
              <input
                name="currency"
                value={state.draft.currency}
                minLength={3}
                maxLength={3}
                required
                autoComplete="off"
                onChange={(event) =>
                  setDraft({
                    ...state.draft,
                    currency: event.currentTarget.value.toUpperCase(),
                  })
                }
              />
            </label>
            {state.draft.kind === "recurring" ? (
              <>
                <label>
                  Next renewal
                  <input
                    type="date"
                    name="nextRenewalDate"
                    value={state.draft.nextRenewalDate}
                    required
                    onChange={(event) =>
                      setDraft({
                        ...state.draft,
                        nextRenewalDate: event.currentTarget.value,
                      })
                    }
                  />
                </label>
                <label>
                  Repeats
                  <select
                    name="recurrence"
                    value={state.draft.recurrence}
                    onChange={(event) =>
                      setDraft({
                        ...state.draft,
                        recurrence: event.currentTarget
                          .value as SubscriptionDraft["recurrence"],
                      })
                    }
                  >
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="quarterly">Every 3 months</option>
                    <option value="semiannual">Every 6 months</option>
                    <option value="annual">Annual</option>
                    <option value="custom">Custom interval</option>
                  </select>
                </label>
              </>
            ) : (
              <label>
                Purchase date
                <input
                  type="date"
                  name="purchasedOn"
                  value={state.draft.purchasedOn}
                  required
                  onChange={(event) =>
                    setDraft({
                      ...state.draft,
                      purchasedOn: event.currentTarget.value,
                    })
                  }
                />
              </label>
            )}
          </fieldset>

          <button
            type="button"
            className="details-toggle"
            aria-expanded={state.advanced}
            onClick={() => onChange({ ...state, advanced: !state.advanced })}
          >
            {state.advanced ? "Fewer details" : "More details"}
          </button>

          {state.advanced ? (
            <fieldset disabled={pending} className="optional-fields">
              <legend>Optional details</legend>
              <label>
                Plan
                <input
                  name="planName"
                  value={state.draft.planName}
                  maxLength={160}
                  onChange={(event) =>
                    setDraft({
                      ...state.draft,
                      planName: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <label>
                Category
                <input
                  name="category"
                  value={state.draft.category}
                  maxLength={80}
                  onChange={(event) =>
                    setDraft({
                      ...state.draft,
                      category: event.currentTarget.value,
                      curatedDefaults: {
                        ...state.draft.curatedDefaults,
                        category: null,
                        categoryCustomized: true,
                      },
                    })
                  }
                />
              </label>
              {state.draft.kind === "recurring" ? (
                <>
                  <label>
                    Billing anchor / start date
                    <input
                      type="date"
                      name="startDate"
                      value={state.draft.startDate}
                      onChange={(event) =>
                        setDraft({
                          ...state.draft,
                          startDate: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    Trial ends
                    <input
                      type="date"
                      name="trialEndsOn"
                      value={state.draft.trialEndsOn}
                      disabled={state.mode === "edit" || pending}
                      aria-describedby={
                        state.mode === "edit"
                          ? "persisted-trial-boundary-help"
                          : undefined
                      }
                      onChange={(event) =>
                        setDraft({
                          ...state.draft,
                          trialEndsOn: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  {state.mode === "edit" ? (
                    <small id="persisted-trial-boundary-help">
                      The persisted trial boundary cannot be edited here.
                    </small>
                  ) : null}
                </>
              ) : (
                <label>
                  Access ends
                  <input
                    type="date"
                    name="accessEndsOn"
                    value={state.draft.accessEndsOn}
                    onChange={(event) =>
                      setDraft({
                        ...state.draft,
                        accessEndsOn: event.currentTarget.value,
                      })
                    }
                  />
                </label>
              )}
              {state.draft.recurrence === "custom" &&
              state.draft.kind === "recurring" ? (
                <div className="custom-recurrence">
                  <label>
                    Every
                    <input
                      inputMode="numeric"
                      value={state.draft.customRecurrenceInterval}
                      onChange={(event) =>
                        setDraft({
                          ...state.draft,
                          customRecurrenceInterval: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    Interval unit
                    <select
                      value={state.draft.customRecurrenceUnit}
                      onChange={(event) =>
                        setDraft({
                          ...state.draft,
                          customRecurrenceUnit: event.currentTarget
                            .value as SubscriptionDraft["customRecurrenceUnit"],
                        })
                      }
                    >
                      <option value="day">Days</option>
                      <option value="week">Weeks</option>
                      <option value="month">Months</option>
                      <option value="year">Years</option>
                    </select>
                  </label>
                </div>
              ) : null}
              <label>
                Account email
                <input
                  type="email"
                  name="accountEmail"
                  value={state.draft.accountEmail}
                  maxLength={320}
                  onChange={(event) =>
                    setDraft({
                      ...state.draft,
                      accountEmail: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <label>
                Payment label or last four
                <input
                  name="paymentLabel"
                  value={state.draft.paymentLabel}
                  maxLength={80}
                  onChange={(event) =>
                    setDraft({
                      ...state.draft,
                      paymentLabel: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <label>
                Management link
                <input
                  type="url"
                  name="managementUrl"
                  value={state.draft.managementUrl}
                  maxLength={2048}
                  onChange={(event) =>
                    setDraft({
                      ...state.draft,
                      managementUrl: event.currentTarget.value,
                      curatedDefaults: {
                        ...state.draft.curatedDefaults,
                        managementUrl: null,
                        managementUrlCustomized: true,
                      },
                    })
                  }
                />
              </label>
              <label className="notes-field">
                Notes
                <textarea
                  name="notes"
                  value={state.draft.notes}
                  maxLength={4000}
                  rows={4}
                  onChange={(event) =>
                    setDraft({
                      ...state.draft,
                      notes: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <p className="privacy-boundary">
                <strong>Keep this non-secret.</strong> Never add passwords, full
                card numbers, or security codes. A payment nickname or last four
                digits is enough.
              </p>
            </fieldset>
          ) : null}

          <footer className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
            >
              Cancel
            </button>
            <button type="submit" disabled={pending} aria-busy={pending}>
              {pending
                ? state.mode === "create"
                  ? "Adding…"
                  : "Saving…"
                : state.mode === "create"
                  ? "Add subscription"
                  : "Save changes"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function LifecycleDialog({
  state,
  pending,
  onChange,
  onClose,
  onSubmit,
}: Readonly<{
  state: LifecycleDialogState;
  pending: boolean;
  onChange: (state: LifecycleDialogState) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}>) {
  const action = capitalize(state.action);
  return (
    <div className="dialog-backdrop">
      <section
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lifecycle-dialog-title"
        onKeyDown={trapDialogFocus}
      >
        <p className="eyebrow">STATUS CHANGE</p>
        <h2 id="lifecycle-dialog-title">{`${action} ${state.serviceName}`}</h2>
        <p>
          This updates billing truth through the retained lifecycle history. It
          does not erase earlier records.
        </p>
        <form onSubmit={onSubmit}>
          <fieldset disabled={pending}>
            <label>
              Change date
              <input
                autoFocus
                type="date"
                value={state.on}
                min={state.minimumOn}
                required
                onChange={(event) =>
                  onChange({ ...state, on: event.currentTarget.value })
                }
              />
            </label>
            {state.action === "cancel" ? (
              <label>
                Paid access ends
                <input
                  type="date"
                  value={state.accessEndsOn}
                  required
                  onChange={(event) =>
                    onChange({
                      ...state,
                      accessEndsOn: event.currentTarget.value,
                    })
                  }
                />
              </label>
            ) : null}
          </fieldset>
          <footer className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
            >
              Keep current status
            </button>
            <button type="submit" disabled={pending}>
              {`${action} subscription`}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function DeleteDialog({
  record,
  pending,
  onClose,
  onConfirm,
}: Readonly<{
  record: PersistedSubscription;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}>) {
  return (
    <div className="dialog-backdrop">
      <section
        className="confirm-dialog danger-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-dialog-title"
        onKeyDown={trapDialogFocus}
      >
        <p className="eyebrow">PERMANENT ACTION</p>
        <h2 id="delete-dialog-title">
          Permanently delete {record.subscription.serviceName}?
        </h2>
        <p>
          This also removes retained renewal and reminder history for this item.
          It cannot be undone.
        </p>
        <footer className="dialog-actions">
          <button
            autoFocus
            type="button"
            className="secondary-button"
            onClick={onClose}
          >
            Keep subscription
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={pending}
            onClick={onConfirm}
          >
            Permanently delete
          </button>
        </footer>
      </section>
    </div>
  );
}

function SpendSummary({ view }: Readonly<{ view: SpendView | null }>) {
  if (!view) return null;
  const missing = view.unconverted.length;
  const missingLabel =
    missing === 1 ? "1 subscription" : `${missing} subscriptions`;
  return (
    <section className="spend-summary" aria-labelledby="spend-summary-heading">
      <div className="section-heading-row">
        <h3 id="spend-summary-heading">Committed spend</h3>
        <span>{view.countedCount}</span>
      </div>
      <dl className="spend-figures">
        <div>
          <dt>Monthly</dt>
          <dd>{view.monthlyText}</dd>
        </div>
        <div>
          <dt>Annual</dt>
          <dd>{view.annualText}</dd>
        </div>
      </dl>
      <p className="field-help">
        Normalized to {view.homeCurrency} across every active and trial
        subscription. Paused, canceled, and one-time items are excluded.
      </p>
      {missing > 0 ? (
        <div className="spend-unconverted" role="status" aria-live="polite">
          <strong>
            Not included — no exchange rate available for {missingLabel}
          </strong>
          <ul>
            {view.unconverted.map((entry) => (
              <li key={entry.subscriptionId}>
                {entry.serviceName} <span>{entry.amountText}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function MutationBanner({
  mutation,
  runtime,
}: Readonly<{
  mutation: MutationState | null;
  runtime: SubscriptionsRuntime;
}>) {
  if (!mutation) return null;
  if (mutation.status === "pending") {
    return (
      <output className="mutation-banner mutation-pending" aria-live="polite">
        Saving securely…
      </output>
    );
  }
  return (
    <div className={`mutation-banner mutation-${mutation.status}`} role="alert">
      <span>{mutation.message}</span>
      {mutation.status === "retry" ? (
        <button type="button" onClick={() => void runtime.retry()}>
          Retry change
        </button>
      ) : mutation.status === "conflict" ? (
        <button type="button" onClick={() => void runtime.reload()}>
          Reload latest
        </button>
      ) : null}
    </div>
  );
}

function DateTab({ date, locale }: Readonly<{ date: string; locale: string }>) {
  const instant = calendarInstant(date);
  return (
    <span className="date-tab" aria-hidden="true">
      <strong>
        {new Intl.DateTimeFormat(locale, {
          day: "2-digit",
          timeZone: "UTC",
        }).format(instant)}
      </strong>
      <small>
        {new Intl.DateTimeFormat(locale, {
          month: "short",
          timeZone: "UTC",
        })
          .format(instant)
          .toUpperCase()}
      </small>
    </span>
  );
}

function lifecycleActions(record: PersistedSubscription) {
  const { subscription } = record;
  const status = subscription.lifecycle.status;
  if (status === "expired") {
    return subscription.kind === "recurring"
      ? [{ action: "restart" as const, label: "Restart" }]
      : [];
  }
  if (status === "canceled")
    return [{ action: "expire" as const, label: "Expire" }];
  if (status === "paused") {
    return [
      { action: "resume" as const, label: "Resume" },
      { action: "cancel" as const, label: "Cancel" },
    ];
  }
  if (status === "trial")
    return [{ action: "cancel" as const, label: "Cancel" }];
  return [
    ...(subscription.kind === "recurring"
      ? [{ action: "pause" as const, label: "Pause" }]
      : []),
    { action: "cancel" as const, label: "Cancel" },
    { action: "expire" as const, label: "Expire" },
  ];
}

function formatMoney(record: PersistedSubscription, locale: string) {
  const { amount } = record.subscription;
  const scale = 10n ** BigInt(amount.exponent);
  const minorUnits = BigInt(amount.minorUnits);
  const whole = minorUnits / scale;
  const fraction = minorUnits % scale;
  const wholeText = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
    useGrouping: true,
  }).format(whole);
  const currencyFormatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: amount.currency,
    minimumFractionDigits: amount.exponent,
    maximumFractionDigits: amount.exponent,
  });
  const template = currencyFormatter.formatToParts(0);
  const decimal =
    template.find((part) => part.type === "decimal")?.value ?? ".";
  const fractionText =
    amount.exponent === 0
      ? ""
      : new Intl.NumberFormat(locale, {
          minimumIntegerDigits: amount.exponent,
          maximumFractionDigits: 0,
          useGrouping: false,
        }).format(fraction);
  const exactNumber =
    amount.exponent === 0 ? wholeText : `${wholeText}${decimal}${fractionText}`;
  let inserted = false;
  return template
    .map((part) => {
      if (
        part.type !== "integer" &&
        part.type !== "group" &&
        part.type !== "decimal" &&
        part.type !== "fraction"
      ) {
        return part.value;
      }
      if (inserted) return "";
      inserted = true;
      return exactNumber;
    })
    .join("");
}

function recurrenceLabel(record: PersistedSubscription) {
  const subscription = record.subscription;
  if (subscription.kind === "one_time") return "One-time";
  const { interval, unit } = subscription.recurrence;
  if (interval === 1) return `Every ${unit}`;
  return `Every ${interval} ${unit}s`;
}

function formatLongDate(date: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(calendarInstant(date));
}

function calendarInstant(date: string) {
  return new Date(`${date}T00:00:00.000Z`);
}

function lifecycleLabel(
  status: PersistedSubscription["subscription"]["lifecycle"]["status"],
) {
  return capitalize(status);
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function restoreDialogFocus(
  preferred: RefObject<HTMLElement | null>,
  fallback: RefObject<HTMLButtonElement | null>,
) {
  queueMicrotask(() => {
    const target = preferred.current?.isConnected
      ? preferred.current
      : fallback.current?.isConnected
        ? fallback.current
        : null;
    target?.focus();
  });
}

function trapDialogFocus(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getAttribute("aria-hidden") !== "true");
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

function canonicalLocale(locale: string) {
  try {
    return Intl.getCanonicalLocales(locale.replaceAll("_", "-"))[0] ?? "en-US";
  } catch {
    return "en-US";
  }
}

function todayInTimezone(timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  }).formatToParts(new Date());
  const value = (type: "year" | "month" | "day") =>
    parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (!year || !month || !day) throw new Error("calendar_date_unavailable");
  return `${year}-${month}-${day}`;
}

function defaultSubscriptionId() {
  const value = crypto.randomUUID().replaceAll("-", "_");
  return `sub_${value}`;
}

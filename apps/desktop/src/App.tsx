import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  DesktopAuthRuntime,
  DesktopAuthSnapshot,
} from "./auth/desktop-auth";
import type {
  PreferenceInput,
  PreferencesRuntime,
  PreferencesSnapshot,
} from "./account/preferences-runtime";
import { SubscriptionExperience } from "./subscriptions/SubscriptionExperience";
import type { SubscriptionsRuntime } from "./subscriptions/subscriptions-runtime";
import { HelpPanel } from "./HelpPanel";
import type { RemindersRuntime } from "./reminders/reminders-runtime";

export function AuthApp({
  runtime,
  preferencesRuntime,
  subscriptionsRuntime,
  remindersRuntime,
}: Readonly<{
  runtime: DesktopAuthRuntime;
  preferencesRuntime?: PreferencesRuntime;
  subscriptionsRuntime?: SubscriptionsRuntime;
  remindersRuntime?: RemindersRuntime;
}>) {
  const [snapshot, setSnapshot] = useState<DesktopAuthSnapshot>(
    runtime.snapshot(),
  );

  useEffect(() => {
    const unsubscribe = runtime.subscribe(setSnapshot);
    void runtime.boot();
    return unsubscribe;
  }, [runtime]);

  useEffect(() => {
    if (snapshot.status !== "signed_in") {
      preferencesRuntime?.reset();
      subscriptionsRuntime?.reset();
      remindersRuntime?.reset();
    }
  }, [
    preferencesRuntime,
    remindersRuntime,
    snapshot.status,
    subscriptionsRuntime,
  ]);

  return (
    <main>
      <p className="eyebrow">SUBTRACK / RENEWAL CALENDAR</p>
      <h1>Know what renews next.</h1>
      <p>
        Private renewal planning with fast manual capture and no bank or inbox
        access.
      </p>
      <AuthStatus
        snapshot={snapshot}
        runtime={runtime}
        preferencesRuntime={preferencesRuntime}
        subscriptionsRuntime={subscriptionsRuntime}
        remindersRuntime={remindersRuntime}
      />
      <HelpPanel />
    </main>
  );
}

function AuthStatus({
  snapshot,
  runtime,
  preferencesRuntime,
  subscriptionsRuntime,
  remindersRuntime,
}: Readonly<{
  snapshot: DesktopAuthSnapshot;
  runtime: DesktopAuthRuntime;
  preferencesRuntime?: PreferencesRuntime;
  subscriptionsRuntime?: SubscriptionsRuntime;
  remindersRuntime?: RemindersRuntime;
}>) {
  switch (snapshot.status) {
    case "setup_required":
      return (
        <section aria-labelledby="setup-required-heading">
          <RouteHeading id="setup-required-heading" focusKey="setup_required">
            This installation needs an update
          </RouteHeading>
          <output role="alert" aria-live="assertive">
            Subtrack could not connect to its sign-in service.
          </output>
          <p>
            Install the latest official version. If this continues, report an
            installation issue from Help below.
          </p>
        </section>
      );
    case "error":
      return (
        <section aria-labelledby="auth-error-heading">
          <RouteHeading id="auth-error-heading" focusKey="auth_error">
            Authentication needs another try
          </RouteHeading>
          <output role="alert" aria-live="assertive">
            {snapshot.message}
          </output>
          <button type="button" onClick={() => void runtime.signOut()}>
            Return to sign in
          </button>
        </section>
      );
    case "starting":
      return <output aria-live="polite">Checking secure session…</output>;
    case "verification_pending":
      return (
        <section aria-labelledby="verification-heading">
          <RouteHeading
            id="verification-heading"
            focusKey="verification_pending"
          >
            Check your system browser
          </RouteHeading>
          <p>Complete the secure sign-in there, then return to Subtrack.</p>
          <button type="button" onClick={() => void runtime.signOut()}>
            Cancel and start over
          </button>
        </section>
      );
    case "signed_out":
      return (
        <section aria-labelledby="signed-out-heading">
          <RouteHeading
            id="signed-out-heading"
            focusKey={snapshot.reason ?? "signed_out"}
          >
            {snapshot.reason === "session_expired"
              ? "Session expired"
              : "Sign in to Subtrack"}
          </RouteHeading>
          <p role="status" aria-live="polite">
            {snapshot.reason === "session_expired"
              ? "Your secure session expired. Sign in again to return to your subscriptions."
              : "Authentication continues securely in your system browser."}
          </p>
          <button type="button" onClick={() => void runtime.beginSignIn()}>
            {snapshot.reason === "session_expired"
              ? "Sign in again"
              : "Continue in system browser"}
          </button>
        </section>
      );
    case "signed_in":
      if (preferencesRuntime) {
        const accountSnapshot = preferencesRuntime.activate(snapshot.subject);
        subscriptionsRuntime?.activate(snapshot.subject);
        remindersRuntime?.activate(snapshot.subject);
        return (
          <AccountExperience
            key={snapshot.subject}
            authRuntime={runtime}
            preferencesRuntime={preferencesRuntime}
            initialSnapshot={accountSnapshot}
            subscriptionsRuntime={subscriptionsRuntime}
            remindersRuntime={remindersRuntime}
          />
        );
      }
      return (
        <section>
          <output aria-live="polite">You’re signed in to Subtrack.</output>
          <button type="button" onClick={() => void runtime.signOut()}>
            Sign out
          </button>
        </section>
      );
  }
}

function AccountExperience({
  authRuntime,
  preferencesRuntime,
  initialSnapshot,
  subscriptionsRuntime,
  remindersRuntime,
}: Readonly<{
  authRuntime: DesktopAuthRuntime;
  preferencesRuntime: PreferencesRuntime;
  initialSnapshot: PreferencesSnapshot;
  subscriptionsRuntime?: SubscriptionsRuntime;
  remindersRuntime?: RemindersRuntime;
}>) {
  const [snapshot, setSnapshot] =
    useState<PreferencesSnapshot>(initialSnapshot);
  const [draft, setDraft] = useState<PreferenceInput>(() =>
    draftFromSnapshot(initialSnapshot),
  );
  const savedLocale = useRef(
    initialSnapshot.status === "ready"
      ? initialSnapshot.preferences.locale
      : "en-US",
  );
  const savedTimezone = useRef(
    initialSnapshot.status === "ready"
      ? initialSnapshot.preferences.timezone
      : "UTC",
  );
  // The subscription workspace derives spend totals and editor defaults from
  // the home currency, so it must see the last saved value, not the form
  // draft: a draft mid-edit transiently holds partial codes like "US", which
  // would blank the spend summary on every keystroke.
  const savedHomeCurrency = useRef(
    initialSnapshot.status === "ready"
      ? initialSnapshot.preferences.homeCurrency
      : "USD",
  );

  useEffect(() => {
    const unsubscribe = preferencesRuntime.subscribe((next) => {
      setSnapshot(next);
      if (next.status === "onboarding") setDraft(next.defaults);
      if (next.status === "ready") {
        savedLocale.current = next.preferences.locale;
        savedTimezone.current = next.preferences.timezone;
        savedHomeCurrency.current = next.preferences.homeCurrency;
        setDraft(editablePreferences(next.preferences));
      }
    });
    void preferencesRuntime.boot();
    return unsubscribe;
  }, [preferencesRuntime]);

  if (snapshot.status === "loading") {
    return <output aria-live="polite">Loading private preferences…</output>;
  }
  if (snapshot.status === "error") {
    return (
      <section className="account-state" aria-labelledby="settings-error">
        <RouteHeading
          id="settings-error"
          focusKey={`preferences_${snapshot.operation}_error`}
        >
          Settings need another try
        </RouteHeading>
        <output role="alert" aria-live="assertive">
          {snapshot.message}
        </output>
        {snapshot.retryable === false ? (
          <p>
            Install the latest official version. If your settings still cannot
            load, report an installation issue from Help below.
          </p>
        ) : (
          <button type="button" onClick={() => void preferencesRuntime.boot()}>
            Reload preferences
          </button>
        )}
        <button type="button" onClick={() => void authRuntime.signOut()}>
          Sign out
        </button>
      </section>
    );
  }

  const onboarding =
    snapshot.status === "onboarding" ||
    (snapshot.status === "saving" && snapshot.mode === "create");
  const saving = snapshot.status === "saving";
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void preferencesRuntime.save(draft);
  };
  const notificationPermission = snapshot.notificationPermission;

  return (
    <div className="account-shell">
      <header className="account-header">
        <div>
          <p className="eyebrow">PRIVATE ACCOUNT</p>
          <RouteHeading
            id="account-heading"
            focusKey={onboarding ? "onboarding" : "account"}
          >
            {onboarding ? "Welcome to Subtrack" : "Your renewal planner"}
          </RouteHeading>
          <p>
            {onboarding
              ? "Choose how dates and amounts appear. Then add your first subscription."
              : "A clear view of your subscriptions and upcoming renewals."}
          </p>
        </div>
        <button type="button" onClick={() => void authRuntime.signOut()}>
          Sign out
        </button>
      </header>

      {subscriptionsRuntime && !onboarding ? (
        <SubscriptionExperience
          runtime={subscriptionsRuntime}
          homeCurrency={savedHomeCurrency.current}
          timezone={savedTimezone.current}
          locale={savedLocale.current}
          remindersRuntime={remindersRuntime}
        />
      ) : null}

      <details
        className="settings-panel"
        open={onboarding || !subscriptionsRuntime}
      >
        <summary>
          {onboarding ? "Your preferences" : "Account settings"}
        </summary>
        <form className="preferences-form" onSubmit={submit}>
          <fieldset disabled={saving}>
            <legend>Calendar context</legend>
            <label>
              Time zone
              <input
                aria-label="Time zone"
                aria-describedby="timezone-help"
                name="timezone"
                value={draft.timezone}
                maxLength={128}
                required
                autoComplete="off"
                onChange={(event) =>
                  setDraft({ ...draft, timezone: event.currentTarget.value })
                }
              />
              <small id="timezone-help">
                Detected from your device, for example Asia/Kolkata or
                Europe/London.
              </small>
            </label>
            <label>
              Date and number format
              <input
                aria-label="Date and number format"
                aria-describedby="locale-help"
                name="locale"
                value={draft.locale}
                maxLength={16}
                required
                autoComplete="off"
                onChange={(event) =>
                  setDraft({ ...draft, locale: event.currentTarget.value })
                }
              />
              <small id="locale-help">
                Use a regional format such as en-IN, en-US, or fr-FR.
              </small>
            </label>
            <label>
              Home currency
              <input
                name="homeCurrency"
                list="common-currencies"
                value={draft.homeCurrency}
                minLength={3}
                maxLength={3}
                pattern="[A-Z]{3}"
                required
                autoComplete="off"
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    homeCurrency: event.currentTarget.value.toUpperCase(),
                  })
                }
              />
              <datalist id="common-currencies">
                {currencyChoices.map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </datalist>
            </label>
          </fieldset>

          <fieldset disabled={saving}>
            <legend>Reminder lead times</legend>
            <p className="field-help">
              Choose when a scheduled renewal should appear in your reminders.
              Keep Subtrack open and online to check for due reminders.
            </p>
            <div className="choice-grid">
              {leadDayChoices.map((days) => (
                <label key={days}>
                  <input
                    type="checkbox"
                    name="reminderLeadDays"
                    value={days}
                    checked={draft.reminderLeadDays.includes(days)}
                    onChange={() =>
                      setDraft({
                        ...draft,
                        reminderLeadDays: toggleLeadDay(
                          draft.reminderLeadDays,
                          days,
                        ),
                      })
                    }
                  />
                  {days === 0
                    ? "On renewal day"
                    : days === 1
                      ? "1 day before"
                      : `${days} days before`}
                </label>
              ))}
            </div>
            <label className="email-choice">
              <input
                type="checkbox"
                disabled
                name="emailRemindersEnabled"
                checked={draft.emailRemindersEnabled}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    emailRemindersEnabled: event.currentTarget.checked,
                  })
                }
              />
              <span>
                <strong>Email reminders · Coming later</strong>
                <small>Email delivery is not available in this version.</small>
              </span>
            </label>
          </fieldset>

          <NotificationCoverage status={notificationPermission} />

          <div className="form-actions">
            <button type="submit" disabled={saving} aria-busy={saving}>
              {saving
                ? "Saving…"
                : onboarding
                  ? "Save and continue"
                  : "Save changes"}
            </button>
            {snapshot.status === "ready" && snapshot.saved ? (
              <output aria-live="polite">Preferences saved.</output>
            ) : null}
          </div>
        </form>

        <section className="security-card" aria-labelledby="security-heading">
          <p className="eyebrow">YOUR DATA</p>
          <h3 id="security-heading">Privacy and account</h3>
          <p>
            Your subscriptions sync to your online account. Subtrack never
            connects to your bank or reads your inbox. Sign-in credentials are
            stored in your device’s secure credential store.
          </p>
          <p>
            Account export, account deletion, and changes to sign-in security
            methods are not available in this version. You can permanently
            delete individual subscriptions from their details.
          </p>
        </section>
      </details>
    </div>
  );
}

function NotificationCoverage({
  status,
}: Readonly<{
  status: "granted" | "denied" | "prompt" | "unsupported";
}>) {
  const copy = {
    granted:
      "Notifications are allowed on this device. Scheduled reminders are checked while Subtrack is open and online.",
    denied:
      "Notifications are blocked on this device. Scheduled reminders can still appear in the app while it is open and online.",
    prompt:
      "Device notifications are not enabled. Check your due reminders in the app while it is open and online.",
    unsupported:
      "Device notifications are unavailable here. Check your due reminders in the app while it is open and online.",
  }[status];
  return (
    <aside
      className={`permission-card permission-${status}`}
      aria-live="polite"
    >
      <strong>Reminder readiness</strong>
      <p>{copy}</p>
      <p>
        Reminders require the online scheduling service. Closing the app stops
        desktop checks; email and background delivery are not available.
      </p>
    </aside>
  );
}

function draftFromSnapshot(snapshot: PreferencesSnapshot): PreferenceInput {
  if (snapshot.status === "onboarding") return snapshot.defaults;
  if (snapshot.status === "ready")
    return editablePreferences(snapshot.preferences);
  return {
    timezone: "UTC",
    homeCurrency: "USD",
    reminderLeadDays: [7, 3, 1],
    emailRemindersEnabled: false,
    locale: "en-US",
  };
}

function editablePreferences(input: PreferenceInput): PreferenceInput {
  return {
    timezone: input.timezone,
    homeCurrency: input.homeCurrency,
    reminderLeadDays: [...input.reminderLeadDays],
    emailRemindersEnabled: input.emailRemindersEnabled,
    locale: input.locale,
  };
}

function toggleLeadDay(current: readonly number[], day: number) {
  if (current.includes(day)) {
    if (current.length === 1) return [...current];
    return current.filter((candidate) => candidate !== day);
  }
  return [...current, day].sort((left, right) => right - left);
}

function RouteHeading({
  children,
  focusKey,
  id,
}: Readonly<{ children: ReactNode; focusKey: string; id: string }>) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [focusKey]);
  return (
    <h2 id={id} ref={heading} tabIndex={-1}>
      {children}
    </h2>
  );
}

const leadDayChoices = [30, 14, 7, 3, 1, 0] as const;
const currencyChoices = ["USD", "EUR", "GBP", "INR", "JPY", "CAD", "AUD"];

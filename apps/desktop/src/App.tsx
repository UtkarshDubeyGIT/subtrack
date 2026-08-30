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

export function AuthApp({
  runtime,
  preferencesRuntime,
  subscriptionsRuntime,
}: Readonly<{
  runtime: DesktopAuthRuntime;
  preferencesRuntime?: PreferencesRuntime;
  subscriptionsRuntime?: SubscriptionsRuntime;
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
    }
  }, [preferencesRuntime, snapshot.status, subscriptionsRuntime]);

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
      />
    </main>
  );
}

function AuthStatus({
  snapshot,
  runtime,
  preferencesRuntime,
  subscriptionsRuntime,
}: Readonly<{
  snapshot: DesktopAuthSnapshot;
  runtime: DesktopAuthRuntime;
  preferencesRuntime?: PreferencesRuntime;
  subscriptionsRuntime?: SubscriptionsRuntime;
}>) {
  switch (snapshot.status) {
    case "setup_required":
      return (
        <section aria-labelledby="setup-required-heading">
          <RouteHeading id="setup-required-heading" focusKey="setup_required">
            Setup required
          </RouteHeading>
          <output role="alert" aria-live="assertive">
            {snapshot.message}
          </output>
          <p>
            Update the build configuration, then rebuild and reinstall Subtrack.
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
              ? "Your secure session expired. No prior account data remains in this view."
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
        return (
          <AccountExperience
            key={snapshot.subject}
            authRuntime={runtime}
            preferencesRuntime={preferencesRuntime}
            initialSnapshot={accountSnapshot}
            subscriptionsRuntime={subscriptionsRuntime}
          />
        );
      }
      return (
        <section>
          <output aria-live="polite">
            Signed in through the development broker.
          </output>
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
}: Readonly<{
  authRuntime: DesktopAuthRuntime;
  preferencesRuntime: PreferencesRuntime;
  initialSnapshot: PreferencesSnapshot;
  subscriptionsRuntime?: SubscriptionsRuntime;
}>) {
  const [snapshot, setSnapshot] =
    useState<PreferencesSnapshot>(initialSnapshot);
  const [draft, setDraft] = useState<PreferenceInput>(() =>
    draftFromSnapshot(initialSnapshot),
  );
  const savedTimezone = useRef(
    initialSnapshot.status === "ready"
      ? initialSnapshot.preferences.timezone
      : "UTC",
  );

  useEffect(() => {
    const unsubscribe = preferencesRuntime.subscribe((next) => {
      setSnapshot(next);
      if (next.status === "onboarding") setDraft(next.defaults);
      if (next.status === "ready") {
        savedTimezone.current = next.preferences.timezone;
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
            Update the data-sync configuration used at build time, then rebuild
            and reinstall Subtrack.
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
          <RouteHeading id="account-heading" focusKey="account">
            {onboarding ? "Welcome to Subtrack" : "Account settings"}
          </RouteHeading>
          <p>
            {onboarding
              ? "Set your calendar context and how early Subtrack should remind you."
              : "Keep renewal dates and reminder coverage aligned with your life."}
          </p>
        </div>
        <button type="button" onClick={() => void authRuntime.signOut()}>
          Sign out
        </button>
      </header>

      {subscriptionsRuntime && !onboarding ? (
        <SubscriptionExperience
          runtime={subscriptionsRuntime}
          homeCurrency={draft.homeCurrency}
          timezone={savedTimezone.current}
          locale={draft.locale}
        />
      ) : null}

      <form className="preferences-form" onSubmit={submit}>
        <fieldset disabled={saving}>
          <legend>Calendar context</legend>
          <label>
            Time zone
            <input
              name="timezone"
              value={draft.timezone}
              maxLength={128}
              required
              autoComplete="off"
              onChange={(event) =>
                setDraft({ ...draft, timezone: event.currentTarget.value })
              }
            />
          </label>
          <label>
            Locale
            <input
              name="locale"
              value={draft.locale}
              maxLength={16}
              required
              autoComplete="off"
              onChange={(event) =>
                setDraft({ ...draft, locale: event.currentTarget.value })
              }
            />
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
          <p className="field-help">Choose one or more standard reminders.</p>
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
              <strong>Email fallback</strong>
              <small>
                Save this preference for when email reminder delivery is
                enabled.
              </small>
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
        <p className="eyebrow">ACCOUNT SECURITY</p>
        <h3 id="security-heading">Security methods</h3>
        <p>
          Sign-in is protected by Clerk in your system browser. Passkey and MFA
          controls stay unavailable until the desktop broker validates a secure
          provider-managed settings path.
        </p>
        <p>
          Export, deletion, and security-method changes are not available in
          this build. They will require server-validated recent verification
          when added.
        </p>
      </section>
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
      "This webview currently allows notification prompts. Native reminder delivery is not enabled yet.",
    denied:
      "This webview blocks notification prompts. Your preference is saved; delivery begins when reminders ship.",
    prompt:
      "This webview has not decided notification permission. Reminder delivery is not enabled yet.",
    unsupported:
      "This webview cannot report notification permission. Reminder delivery is not enabled yet.",
  }[status];
  return (
    <aside
      className={`permission-card permission-${status}`}
      aria-live="polite"
    >
      <strong>Reminder readiness</strong>
      <p>{copy}</p>
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

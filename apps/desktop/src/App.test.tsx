import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AuthApp } from "./App";
import type {
  DesktopAuthRuntime,
  DesktopAuthSnapshot,
} from "./auth/desktop-auth";
import type {
  PreferencesRuntime,
  PreferencesSnapshot,
} from "./account/preferences-runtime";
import type {
  SubscriptionsRuntime,
  SubscriptionsSnapshot,
} from "./subscriptions/subscriptions-runtime";

function runtime(snapshot: DesktopAuthSnapshot): DesktopAuthRuntime {
  return {
    snapshot: () => snapshot,
    subscribe: vi.fn(() => () => undefined),
    boot: vi.fn(async () => snapshot),
    beginSignIn: vi.fn(async () => snapshot),
    handleCallback: vi.fn(async () => snapshot),
    signOut: vi.fn(async () => snapshot),
    accessToken: vi.fn(async () => null),
    accessTokenLease: vi.fn(async () => null),
  };
}

function preferencesRuntime(snapshot: PreferencesSnapshot): PreferencesRuntime {
  return {
    snapshot: () => snapshot,
    activate: vi.fn(() => snapshot),
    subscribe: vi.fn(() => () => undefined),
    boot: vi.fn(async () => snapshot),
    save: vi.fn(async () => snapshot),
    reset: vi.fn(() => snapshot),
  };
}

function subscriptionsRuntime(): SubscriptionsRuntime {
  const snapshot: SubscriptionsSnapshot = {
    status: "ready",
    items: [],
    ledger: { status: "ready", complete: true, nextCursor: null },
    calendarEvents: [],
    calendarRange: { status: "idle", requested: null, loaded: null },
    selectedId: null,
    history: { status: "idle", events: [] },
    mutation: null,
    announcement: null,
  };
  const resolved = vi.fn(async () => snapshot);
  return {
    snapshot: () => snapshot,
    activate: vi.fn(() => snapshot),
    subscribe: vi.fn(() => () => undefined),
    boot: resolved,
    reload: resolved,
    loadMoreSubscriptions: resolved,
    loadCalendarRange: resolved,
    retryCalendarRange: resolved,
    select: resolved,
    loadMoreHistory: resolved,
    create: resolved,
    update: resolved,
    transition: resolved,
    remove: resolved,
    retry: resolved,
    reset: vi.fn((): SubscriptionsSnapshot => ({ status: "loading" })),
  };
}

describe("AuthApp", () => {
  it("renders an honest setup blocker when the broker is unconfigured", () => {
    const html = renderToStaticMarkup(
      <AuthApp
        runtime={runtime({
          status: "setup_required",
          message: "Authentication broker is not configured.",
        })}
      />,
    );
    expect(html).toContain("Authentication broker is not configured.");
    expect(html).toContain("rebuild and reinstall Subtrack");
    expect(html).not.toContain("Check configuration again");
    expect(html).toContain("Private renewal planning");
    expect(html).not.toContain("risk gate has not passed");
    expect(html).not.toContain("Sign in");
  });

  it("offers only the system-browser flow when configured and signed out", () => {
    const html = renderToStaticMarkup(
      <AuthApp runtime={runtime({ status: "signed_out" })} />,
    );
    expect(html).toContain("Continue in system browser");
    expect(html).not.toMatch(/email|verification code/i);
  });

  it("shows an interruptible verification state without identity data", () => {
    const html = renderToStaticMarkup(
      <AuthApp runtime={runtime({ status: "verification_pending" })} />,
    );
    expect(html).toContain("Check your system browser");
    expect(html).toContain("Cancel and start over");
    expect(html).not.toMatch(/email address|verification code/i);
  });

  it("explains expired-session recovery without retaining prior user state", () => {
    const html = renderToStaticMarkup(
      <AuthApp
        runtime={runtime({
          status: "signed_out",
          reason: "session_expired",
        })}
      />,
    );
    expect(html).toContain("Your secure session expired");
    expect(html).toContain("Sign in again");
    expect(html).not.toMatch(/user_|person@|token/i);
  });

  it("offers safe sign-out without rendering identity or credentials", () => {
    const html = renderToStaticMarkup(
      <AuthApp
        runtime={runtime({ status: "signed_in", subject: "user_secret_123" })}
      />,
    );
    expect(html).toContain("Sign out");
    expect(html).not.toContain("user_secret_123");
  });

  it("renders an accessible onboarding form with degraded reminder coverage", () => {
    const html = renderToStaticMarkup(
      <AuthApp
        runtime={runtime({ status: "signed_in", subject: "user_secret_123" })}
        preferencesRuntime={preferencesRuntime({
          status: "onboarding",
          defaults: {
            timezone: "Asia/Kolkata",
            homeCurrency: "INR",
            reminderLeadDays: [7, 3, 1],
            emailRemindersEnabled: false,
            locale: "en-IN",
          },
          notificationPermission: "denied",
        })}
      />,
    );

    expect(html).toContain("Welcome to Subtrack");
    expect(html).toContain("Time zone");
    expect(html).toContain("Locale");
    expect(html).toContain("Home currency");
    expect(html).toContain("Reminder lead times");
    expect(html).toContain("Email fallback");
    expect(html).toContain("webview blocks notification prompts");
    expect(html).toContain("Due reminders still appear in the ledger");
    expect(html).toContain("Save and continue");
    expect(html).not.toContain("user_secret_123");
  });

  it("renders saved account preferences and honest security capabilities", () => {
    const html = renderToStaticMarkup(
      <AuthApp
        runtime={runtime({ status: "signed_in", subject: "user_secret_123" })}
        preferencesRuntime={preferencesRuntime({
          status: "ready",
          preferences: {
            timezone: "Europe/Paris",
            homeCurrency: "BRL",
            reminderLeadDays: [14, 1],
            emailRemindersEnabled: true,
            locale: "fr-FR",
            version: 3,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-06T00:00:00.000Z",
          },
          notificationPermission: "granted",
          saved: true,
        })}
      />,
    );

    expect(html).toContain("Account settings");
    expect(html).toContain("Europe/Paris");
    expect(html).toContain('value="BRL"');
    expect(html).toContain("Preferences saved.");
    expect(html).toContain("webview currently allows notification prompts");
    expect(html).toContain(
      "Due reminders notify here and also appear in the ledger",
    );
    expect(html).toContain("Passkey and MFA controls stay unavailable");
    expect(html).toContain("not available in this build");
    expect(html).toContain("server-validated recent verification");
    expect(html).toContain("1 day before");
    expect(html).not.toContain("1 days before");
    expect(html).toContain("Sign out");
    expect(html).not.toContain("user_secret_123");
  });

  it("mounts the private subscription ledger only after preferences are ready", () => {
    const subscriptions = subscriptionsRuntime();
    const html = renderToStaticMarkup(
      <AuthApp
        runtime={runtime({ status: "signed_in", subject: "user_secret_123" })}
        preferencesRuntime={preferencesRuntime({
          status: "ready",
          preferences: {
            timezone: "Asia/Kolkata",
            homeCurrency: "INR",
            reminderLeadDays: [7, 3, 1],
            emailRemindersEnabled: false,
            locale: "en-IN",
            version: 1,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-06T00:00:00.000Z",
          },
          notificationPermission: "prompt",
          saved: false,
        })}
        subscriptionsRuntime={subscriptions}
      />,
    );

    expect(subscriptions.activate).toHaveBeenCalledWith("user_secret_123");
    expect(html).toContain("PRIVATE RENEWAL LEDGER");
    expect(html).toContain("Add subscription");
    expect(html).toContain("Current ledger");
    expect(html).toContain("Archive &amp; history");
    expect(html).not.toContain("user_secret_123");
  });

  it("locks editable preference controls while a save is in flight", () => {
    const html = renderToStaticMarkup(
      <AuthApp
        runtime={runtime({ status: "signed_in", subject: "user_a" })}
        preferencesRuntime={preferencesRuntime({
          status: "saving",
          mode: "update",
          notificationPermission: "prompt",
        })}
      />,
    );

    expect(html.match(/<fieldset disabled=""/g)).toHaveLength(2);
    expect(html).toContain('disabled="" aria-busy="true"');
    expect(html).toContain("Saving…");
  });

  it("gives honest restart guidance for non-retryable data configuration", () => {
    const html = renderToStaticMarkup(
      <AuthApp
        runtime={runtime({ status: "signed_in", subject: "user_a" })}
        preferencesRuntime={preferencesRuntime({
          status: "error",
          message: "Private data sync is not configured.",
          operation: "load",
          retryable: false,
        })}
      />,
    );

    expect(html).toContain("Update the data-sync configuration");
    expect(html).toContain("rebuild and reinstall Subtrack");
    expect(html).not.toContain("Reload preferences");
  });
});

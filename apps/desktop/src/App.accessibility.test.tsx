// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthApp } from "./App";
import type {
  DesktopAuthRuntime,
  DesktopAuthSnapshot,
} from "./auth/desktop-auth";
import type { PreferencesRuntime } from "./account/preferences-runtime";
import { createPreferencesRuntime } from "./account/preferences-runtime";
import type {
  SubscriptionsRuntime,
  SubscriptionsSnapshot,
} from "./subscriptions/subscriptions-runtime";

afterEach(cleanup);

function authRuntime(initial: DesktopAuthSnapshot): DesktopAuthRuntime {
  let state = initial;
  const listeners = new Set<(snapshot: DesktopAuthSnapshot) => void>();
  const emit = () => {
    for (const listener of listeners) listener(state);
    return state;
  };
  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    boot: vi.fn(async () => state),
    beginSignIn: vi.fn(async () => {
      state = { status: "verification_pending" };
      return emit();
    }),
    handleCallback: vi.fn(async () => state),
    signOut: vi.fn(async () => {
      state = { status: "signed_out" };
      return emit();
    }),
    accessToken: vi.fn(async () => null),
    accessTokenLease: vi.fn(async () => null),
  };
}

function onboardingPreferences(): PreferencesRuntime {
  const state = {
    status: "onboarding",
    defaults: {
      timezone: "Asia/Kolkata",
      homeCurrency: "INR",
      reminderLeadDays: [7, 3, 1],
      emailRemindersEnabled: false,
      locale: "en-IN",
    },
    notificationPermission: "prompt",
  } as const;
  return {
    snapshot: () => state,
    activate: () => state,
    subscribe(listener) {
      listener(state);
      return () => undefined;
    },
    boot: vi.fn(async () => state),
    save: vi.fn(async () => state),
    reset: vi.fn(() => state),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function emptySubscriptionsRuntime(): SubscriptionsRuntime {
  let state: SubscriptionsSnapshot = { status: "loading" };
  const ready: SubscriptionsSnapshot = {
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
  return {
    snapshot: () => state,
    activate: vi.fn(() => {
      state = ready;
      return state;
    }),
    subscribe: vi.fn(() => () => undefined),
    boot: vi.fn(async () => state),
    reload: vi.fn(async () => state),
    loadMoreSubscriptions: vi.fn(async () => state),
    loadCalendarRange: vi.fn(async () => state),
    retryCalendarRange: vi.fn(async () => state),
    select: vi.fn(async () => state),
    loadMoreHistory: vi.fn(async () => state),
    create: vi.fn(async () => state),
    update: vi.fn(async () => state),
    transition: vi.fn(async () => state),
    remove: vi.fn(async () => state),
    retry: vi.fn(async () => state),
    reset: vi.fn(() => {
      state = { status: "loading" };
      return state;
    }),
  };
}

describe("AuthApp keyboard and screen-reader behavior", () => {
  it("clears subscription state whenever the auth route is signed out", async () => {
    const subscriptions = emptySubscriptionsRuntime();
    render(
      <AuthApp
        runtime={authRuntime({ status: "signed_out" })}
        subscriptionsRuntime={subscriptions}
      />,
    );

    await waitFor(() => expect(subscriptions.reset).toHaveBeenCalledOnce());
    expect(subscriptions.activate).not.toHaveBeenCalled();
  });

  it("starts the browser verification flow from the keyboard", async () => {
    const runtime = authRuntime({ status: "signed_out" });
    const user = userEvent.setup();
    render(<AuthApp runtime={runtime} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Know what renews next." }),
    ).toBeTruthy();

    await user.tab();
    const continueButton = screen.getByRole("button", {
      name: "Continue in system browser",
    });
    expect(document.activeElement).toBe(continueButton);
    await user.keyboard("{Enter}");

    expect(runtime.beginSignIn).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole("heading", { name: "Check your system browser" }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Check your system browser" }),
      );
    });
  });

  it("hands focus through cancellation back to the signed-out route", async () => {
    const runtime = authRuntime({ status: "verification_pending" });
    const user = userEvent.setup();
    render(<AuthApp runtime={runtime} />);
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Check your system browser" }),
      );
    });

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel and start over" }),
    );
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Sign in to Subtrack" }),
      );
    });
    expect(screen.getByRole("status").textContent).toContain(
      "Authentication continues securely",
    );
  });

  it("focuses and announces expired-session recovery", async () => {
    render(
      <AuthApp
        runtime={authRuntime({
          status: "signed_out",
          reason: "session_expired",
        })}
      />,
    );

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Session expired" }),
      );
    });
    expect(screen.getByRole("status").textContent).toContain(
      "Sign in again to return to your subscriptions",
    );
  });

  it("focuses an auth error and recovers to sign-in from the keyboard", async () => {
    const runtime = authRuntime({
      status: "error",
      message: "Authentication failed.",
    });
    const user = userEvent.setup();
    render(<AuthApp runtime={runtime} />);

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("heading", {
          name: "Authentication needs another try",
        }),
      );
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "Authentication failed.",
    );
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Return to sign in" }),
    );
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Sign in to Subtrack" }),
      );
    });
  });

  it("exposes preference groups and controls by accessible name", () => {
    render(
      <AuthApp
        runtime={authRuntime({ status: "signed_in", subject: "user_a" })}
        preferencesRuntime={onboardingPreferences()}
      />,
    );

    expect(
      screen.getByRole("group", { name: "Calendar context" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("group", { name: "Reminder lead times" }),
    ).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Time zone" })).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: /email reminders/i }),
    ).toBeTruthy();
  });

  it("removes the previous subject's values before the next account loads", async () => {
    let authState: DesktopAuthSnapshot = {
      status: "signed_in",
      subject: "user_a",
    };
    const authListeners = new Set<(snapshot: DesktopAuthSnapshot) => void>();
    const runtime: DesktopAuthRuntime = {
      snapshot: () => authState,
      subscribe(listener) {
        authListeners.add(listener);
        return () => authListeners.delete(listener);
      },
      boot: vi.fn(async () => authState),
      beginSignIn: vi.fn(async () => authState),
      handleCallback: vi.fn(async () => authState),
      signOut: vi.fn(async () => authState),
      accessToken: vi.fn(async () => null),
      accessTokenLease: vi.fn(async () => null),
    };
    const neverLoads = new Promise<never>(() => undefined);
    const preferences = createPreferencesRuntime({
      defaults: {
        timezone: "UTC",
        homeCurrency: "USD",
        reminderLeadDays: [7],
        emailRemindersEnabled: false,
        locale: "en-US",
      },
      notificationPermission: () => "prompt",
      repository: {
        get: vi
          .fn()
          .mockResolvedValueOnce({
            timezone: "America/Los_Angeles",
            homeCurrency: "USD",
            reminderLeadDays: [7],
            emailRemindersEnabled: false,
            locale: "en-US",
            version: 1,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          })
          .mockReturnValueOnce(neverLoads),
        create: vi.fn(),
        update: vi.fn(),
      },
    });
    render(<AuthApp runtime={runtime} preferencesRuntime={preferences} />);
    expect(await screen.findByDisplayValue("America/Los_Angeles")).toBeTruthy();

    await act(async () => {
      authState = { status: "signed_in", subject: "user_b" };
      for (const listener of authListeners) listener(authState);
    });

    await waitFor(() => {
      expect(screen.queryByDisplayValue("America/Los_Angeles")).toBeNull();
    });
    expect(screen.getByText("Loading private preferences…")).toBeTruthy();
  });

  it("operates preference saving by keyboard and announces completion", async () => {
    const creating = deferred<{
      timezone: string;
      homeCurrency: string;
      reminderLeadDays: number[];
      emailRemindersEnabled: boolean;
      locale: string;
      version: number;
      createdAt: string;
      updatedAt: string;
    }>();
    const preferences = createPreferencesRuntime({
      defaults: {
        timezone: "Asia/Kolkata",
        homeCurrency: "INR",
        reminderLeadDays: [7, 3, 1],
        emailRemindersEnabled: false,
        locale: "en-IN",
      },
      notificationPermission: () => "prompt",
      repository: {
        get: vi.fn(async () => null),
        create: vi.fn(() => creating.promise),
        update: vi.fn(),
      },
    });
    const user = userEvent.setup();
    render(
      <AuthApp
        runtime={authRuntime({ status: "signed_in", subject: "user_a" })}
        preferencesRuntime={preferences}
      />,
    );
    const save = await screen.findByRole("button", {
      name: "Save and continue",
    });
    save.focus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("button", { name: "Saving…" })).toHaveProperty(
      "disabled",
      true,
    );
    for (const group of screen
      .getAllByRole("group")
      .filter((element) => element.tagName === "FIELDSET")) {
      expect(group).toHaveProperty("disabled", true);
    }
    creating.resolve({
      timezone: "Asia/Kolkata",
      homeCurrency: "INR",
      reminderLeadDays: [7, 3, 1],
      emailRemindersEnabled: false,
      locale: "en-IN",
      version: 1,
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    });

    expect(await screen.findByText("Preferences saved.")).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Your renewal planner" }),
      ),
    );
  });

  it("keeps the saved timezone active while the preference draft is incomplete", async () => {
    const preferences = createPreferencesRuntime({
      defaults: {
        timezone: "UTC",
        homeCurrency: "USD",
        reminderLeadDays: [7],
        emailRemindersEnabled: false,
        locale: "en-US",
      },
      notificationPermission: () => "prompt",
      repository: {
        get: vi.fn(async () => ({
          timezone: "America/Los_Angeles",
          homeCurrency: "USD",
          reminderLeadDays: [7],
          emailRemindersEnabled: false,
          locale: "en-US",
          version: 1,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        })),
        create: vi.fn(),
        update: vi.fn(),
      },
    });
    const user = userEvent.setup();
    render(
      <AuthApp
        runtime={authRuntime({ status: "signed_in", subject: "user_a" })}
        preferencesRuntime={preferences}
        subscriptionsRuntime={emptySubscriptionsRuntime()}
      />,
    );

    await user.click(
      await screen.findByText("Account settings", { selector: "summary" }),
    );
    const timezone = await screen.findByRole("textbox", {
      name: "Time zone",
    });
    expect(
      screen.getByText(/saved dates in America\/Los_Angeles/u),
    ).toBeTruthy();

    await user.clear(timezone);
    await user.type(timezone, "America/Los_");

    expect(timezone).toHaveProperty("value", "America/Los_");
    await user.click(screen.getByRole("tab", { name: "Calendar" }));
    expect(
      screen.getByRole("region", { name: "Renewal calendar and agenda" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/saved dates in America\/Los_Angeles/u),
    ).toBeTruthy();
  });

  it("focuses a preference failure and supports keyboard reload", async () => {
    const preferences = createPreferencesRuntime({
      defaults: {
        timezone: "Asia/Kolkata",
        homeCurrency: "INR",
        reminderLeadDays: [7, 3, 1],
        emailRemindersEnabled: false,
        locale: "en-IN",
      },
      notificationPermission: () => "prompt",
      repository: {
        get: vi.fn(async () => null),
        create: vi.fn(async () => {
          throw new Error("secret-bearing save failure");
        }),
        update: vi.fn(),
      },
    });
    const user = userEvent.setup();
    render(
      <AuthApp
        runtime={authRuntime({ status: "signed_in", subject: "user_a" })}
        preferencesRuntime={preferences}
      />,
    );
    const save = await screen.findByRole("button", {
      name: "Save and continue",
    });
    save.focus();
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Settings need another try" }),
      );
    });
    expect(screen.getByRole("alert").textContent).not.toMatch(/secret/i);
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Reload preferences" }),
    );
    await user.keyboard("{Enter}");
    expect(
      await screen.findByRole("button", { name: "Save and continue" }),
    ).toBeTruthy();
  });
});

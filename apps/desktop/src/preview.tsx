// A separate review entry point. The desktop production build uses main.tsx.
// All data and sign-in behavior here are simulated and exist only in memory.
import { createRoot } from "react-dom/client";
import {
  createRecurringSubscription,
  createRecurrenceRule,
} from "@subtrack/domain";
import type { PersistedSubscription, SubscriptionWrite } from "@subtrack/data";
import { AuthApp } from "./App";
import type {
  DesktopAuthRuntime,
  DesktopAuthSnapshot,
} from "./auth/desktop-auth";
import {
  createPreferencesRuntime,
  type PersistedPreferences,
  type PreferenceInput,
} from "./account/preferences-runtime";
import { createSubscriptionsRuntime } from "./subscriptions/subscriptions-runtime";
import {
  addCalendarDays,
  buildCalendarAgenda,
} from "./subscriptions/calendar-agenda-model";
import "./styles.css";
import "./preview.css";

const now = new Date().toISOString();
const today = now.slice(0, 10);
const records = new Map<string, PersistedSubscription>();
const samples = [
  {
    name: "Figma",
    plan: "Professional",
    category: "Design",
    amount: 1500,
    days: 2,
  },
  {
    name: "Spotify",
    plan: "Individual",
    category: "Entertainment",
    amount: 1099,
    days: 4,
  },
  {
    name: "iCloud+",
    plan: "200 GB",
    category: "Storage",
    amount: 299,
    days: 7,
  },
  {
    name: "Linear",
    plan: "Basic",
    category: "Productivity",
    amount: 1000,
    days: 11,
  },
  {
    name: "Readwise",
    plan: "Full",
    category: "Reading",
    amount: 999,
    days: 16,
  },
  {
    name: "Notion",
    plan: "Plus",
    category: "Productivity",
    amount: 1200,
    days: 22,
    paused: true,
  },
];
for (const [index, sample] of samples.entries()) {
  const id = `preview_${index}`;
  records.set(id, {
    subscription: createRecurringSubscription({
      kind: "recurring",
      id,
      serviceName: sample.name,
      amount: { minorUnits: sample.amount, currency: "USD" },
      timezone: "UTC",
      startDate: addCalendarDays(today, sample.days),
      nextRenewalDate: addCalendarDays(today, sample.days),
      recurrence: createRecurrenceRule("monthly"),
      lifecycle: { status: sample.paused ? "paused" : "active", since: today },
    }),
    metadata: {
      planName: sample.plan,
      category: sample.category,
      accountEmail: null,
      paymentLabel: null,
      managementUrl: null,
      notes: null,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

const saveRecord = (write: SubscriptionWrite, version: number) => {
  const record: PersistedSubscription = {
    subscription: write.subscription,
    metadata: { ...write.metadata, category: write.metadata.category ?? null },
    version,
    createdAt: records.get(write.subscription.id)?.createdAt ?? now,
    updatedAt: new Date().toISOString(),
  };
  records.set(write.subscription.id, record);
  return Promise.resolve(record);
};
const subscriptions = createSubscriptionsRuntime({
  subscriptionRepository: {
    listPage: () =>
      Promise.resolve({
        items: [...records.values()],
        nextCursor: null,
        complete: true,
      }),
    get: (id) => Promise.resolve(records.get(id) ?? null),
    create: (write) => saveRecord(write, 1),
    update: (write, version) => saveRecord(write, version + 1),
    delete: (id) => {
      records.delete(id);
      return Promise.resolve();
    },
  },
  renewalRepository: {
    listPage: () =>
      Promise.resolve({ events: [], nextCursor: null, complete: true }),
  },
  calendarRepository: {
    listPage: (query) => {
      const result = buildCalendarAgenda({
        items: [...records.values()].map((record) => ({
          record,
          syncStatus: "synced" as const,
        })),
        renewalEvents: [],
        rangeStart: query.rangeStart,
        rangeEnd: query.rangeEnd,
        filter: query.filter,
        query: query.query,
        maxEvents: 256,
      });
      return Promise.resolve({
        events: result.events,
        nextCursor: null,
        complete: true,
        truncated: false,
      });
    },
  },
});

let preferences: PersistedPreferences = {
  timezone: "UTC",
  homeCurrency: "USD",
  reminderLeadDays: [7, 3, 1],
  emailRemindersEnabled: false,
  locale: "en-US",
  version: 1,
  createdAt: now,
  updatedAt: now,
};
const savePreferences = (input: PreferenceInput) => {
  preferences = { ...preferences, ...input, version: preferences.version + 1 };
  return Promise.resolve(preferences);
};
const account = createPreferencesRuntime({
  defaults: preferences,
  notificationPermission: () => "unsupported",
  repository: {
    get: () => Promise.resolve(preferences),
    create: savePreferences,
    update: savePreferences,
  },
});

let authState: DesktopAuthSnapshot = {
  status: "signed_in",
  subject: "preview_account",
};
const listeners = new Set<(state: DesktopAuthSnapshot) => void>();
const setAuth = (state: DesktopAuthSnapshot) => {
  authState = state;
  for (const listener of listeners) listener(state);
  return Promise.resolve(state);
};
const auth: DesktopAuthRuntime = {
  snapshot: () => authState,
  subscribe: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  boot: () => Promise.resolve(authState),
  beginSignIn: () =>
    setAuth({ status: "signed_in", subject: "preview_account" }),
  signOut: () => setAuth({ status: "signed_out" }),
  handleCallback: () => Promise.resolve(authState),
  accessToken: () => Promise.resolve(null),
  accessTokenLease: () => Promise.resolve(null),
};

async function showPreview() {
  subscriptions.activate("preview_account");
  await subscriptions.boot();
  await subscriptions.select("preview_0");
  const root = document.getElementById("root");
  if (!root) throw new Error("Preview root missing.");
  createRoot(root).render(
    <>
      <aside className="preview-toolbar" aria-label="Preview information">
        <span>
          <strong>Interactive preview</strong> · Sample data and simulated
          sign-in. Changes reset on reload.
        </span>
        <button type="button" onClick={() => void auth.signOut()}>
          View welcome screen
        </button>
      </aside>
      <AuthApp
        runtime={auth}
        preferencesRuntime={account}
        subscriptionsRuntime={subscriptions}
      />
    </>,
  );
}
void showPreview();

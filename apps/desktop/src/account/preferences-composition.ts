import {
  createDataPlaneRepositories,
  type DataPlaneAccessTokenLease,
} from "@subtrack/data";
import {
  createPreferencesRuntime,
  type NotificationPermissionStatus,
  type PreferenceInput,
  type PreferencesRuntime,
} from "./preferences-runtime";

type Environment = Readonly<Record<string, string | undefined>>;

type Dependencies = Readonly<{
  accessToken: () => Promise<DataPlaneAccessTokenLease | null>;
  defaults?: PreferenceInput;
  notificationPermission?: () => NotificationPermissionStatus;
}>;

export function createDesktopPreferencesRuntime(
  environment: Environment,
  dependencies: Dependencies,
): PreferencesRuntime {
  const supabaseUrl = environment.VITE_SUPABASE_URL;
  const publishableKey = environment.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) {
    return unavailableRuntime("Private data sync is not configured.");
  }

  try {
    const repository = createDataPlaneRepositories({
      accessToken: dependencies.accessToken,
      publishableKey,
      supabaseUrl,
    }).preferences;
    return createPreferencesRuntime({
      defaults: dependencies.defaults ?? detectedDefaults(),
      notificationPermission:
        dependencies.notificationPermission ?? readNotificationPermission,
      repository: {
        get: () => repository.get(),
        create: (input) =>
          repository.create({
            ...input,
            reminderLeadDays: [...input.reminderLeadDays],
          }),
        update: (input, expectedVersion) =>
          repository.update(
            { ...input, reminderLeadDays: [...input.reminderLeadDays] },
            expectedVersion,
          ),
      },
    });
  } catch {
    return unavailableRuntime("Private data sync configuration is invalid.");
  }
}

function unavailableRuntime(message: string): PreferencesRuntime {
  const snapshot = {
    status: "error",
    message,
    operation: "load",
    retryable: false,
  } as const;
  return {
    snapshot: () => snapshot,
    activate: () => snapshot,
    subscribe(listener) {
      listener(snapshot);
      return () => undefined;
    },
    boot: () => Promise.resolve(snapshot),
    save: () => Promise.resolve(snapshot),
    reset: () => snapshot,
  };
}

function detectedDefaults(): PreferenceInput {
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    homeCurrency: "USD",
    reminderLeadDays: [7, 3, 1],
    emailRemindersEnabled: false,
    locale:
      typeof navigator === "undefined" || !navigator.language
        ? "en-US"
        : navigator.language,
  };
}

function readNotificationPermission(): NotificationPermissionStatus {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "default") return "prompt";
  return Notification.permission;
}

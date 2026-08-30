import {
  createDataPlaneRepositories,
  type DataPlaneAccessTokenLease,
} from "@subtrack/data";
import {
  createRemindersRuntime,
  type NativeNotifier,
  type RemindersRuntime,
  type RemindersSnapshot,
} from "./reminders-runtime";

type Environment = Readonly<Record<string, string | undefined>>;

type Dependencies = Readonly<{
  accessToken: () => Promise<DataPlaneAccessTokenLease | null>;
  notify?: NativeNotifier;
  now?: () => string;
}>;

export function createDesktopRemindersRuntime(
  environment: Environment,
  dependencies: Dependencies,
): RemindersRuntime {
  const supabaseUrl = environment.VITE_SUPABASE_URL;
  const publishableKey = environment.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) {
    return unavailableRuntime();
  }
  try {
    const repository = createDataPlaneRepositories({
      accessToken: dependencies.accessToken,
      publishableKey,
      supabaseUrl,
    }).reminders;
    return createRemindersRuntime({
      repository: {
        listDeliveries: () => repository.listDeliveries(),
        acknowledgeDelivery: (input) => repository.acknowledgeDelivery(input),
      },
      notify: dependencies.notify ?? webviewNotifier,
      now: dependencies.now,
    });
  } catch {
    return unavailableRuntime();
  }
}

/**
 * Presents through the webview Notification API when the user has granted
 * permission. Reports "unavailable" rather than failing when permission is
 * absent, so those reminders fall back to the in-app due list silently —
 * a denied prompt is a preference, not an error.
 */
function webviewNotifier(
  input: Readonly<{ title: string; body: string }>,
): ReturnType<NativeNotifier> {
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  ) {
    return "unavailable";
  }
  try {
    new Notification(input.title, { body: input.body });
    return "shown";
  } catch {
    return "failed";
  }
}

/**
 * A reminders runtime for a build without data-sync configuration. It stays
 * idle forever: the due panel simply never appears, matching how the rest of
 * the app degrades when sync is not configured.
 */
function unavailableRuntime(): RemindersRuntime {
  const snapshot: RemindersSnapshot = { status: "idle" };
  return {
    snapshot: () => snapshot,
    subscribe(listener) {
      listener(snapshot);
      return () => undefined;
    },
    activate: () => snapshot,
    refresh: () => Promise.resolve(snapshot),
    markDone: () => Promise.resolve(snapshot),
    dismiss: () => Promise.resolve(snapshot),
    reset: () => snapshot,
  };
}

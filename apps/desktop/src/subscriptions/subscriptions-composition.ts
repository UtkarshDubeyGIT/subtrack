import {
  createDataPlaneRepositories,
  type DataPlaneAccessTokenLease,
} from "@subtrack/data";
import {
  createSubscriptionsRuntime,
  type SubscriptionsRuntime,
  type SubscriptionsSnapshot,
} from "./subscriptions-runtime";

type Environment = Readonly<Record<string, string | undefined>>;
type Dependencies = Readonly<{
  accessToken: () => Promise<DataPlaneAccessTokenLease | null>;
  now?: () => string;
}>;

export function createDesktopSubscriptionsRuntime(
  environment: Environment,
  dependencies: Dependencies,
): SubscriptionsRuntime {
  const supabaseUrl = environment.VITE_SUPABASE_URL;
  const publishableKey = environment.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) {
    return unavailableRuntime("Private subscription sync is not configured.");
  }
  try {
    const repositories = createDataPlaneRepositories({
      accessToken: dependencies.accessToken,
      publishableKey,
      supabaseUrl,
    });
    return createSubscriptionsRuntime({
      subscriptionRepository: repositories.subscriptions,
      renewalRepository: repositories.renewals,
      calendarRepository: repositories.calendar,
      now: dependencies.now,
    });
  } catch {
    return unavailableRuntime(
      "Private subscription sync configuration is invalid.",
    );
  }
}

function unavailableRuntime(message: string): SubscriptionsRuntime {
  const snapshot: SubscriptionsSnapshot = {
    status: "error",
    message,
    retryable: false,
  };
  const resolved = () => Promise.resolve(snapshot);
  return {
    snapshot: () => snapshot,
    activate: () => snapshot,
    subscribe(listener) {
      listener(snapshot);
      return () => undefined;
    },
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
    reset: () => snapshot,
  };
}

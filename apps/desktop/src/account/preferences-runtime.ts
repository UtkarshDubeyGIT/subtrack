export type NotificationPermissionStatus =
  | "granted"
  | "denied"
  | "prompt"
  | "unsupported";

export type PreferenceInput = Readonly<{
  timezone: string;
  homeCurrency: string;
  reminderLeadDays: readonly number[];
  emailRemindersEnabled: boolean;
  locale: string;
}>;

export type PersistedPreferences = PreferenceInput &
  Readonly<{
    version: number;
    createdAt: string;
    updatedAt: string;
  }>;

export type PreferencesSnapshot =
  | Readonly<{ status: "loading" }>
  | Readonly<{
      status: "onboarding";
      defaults: PreferenceInput;
      notificationPermission: NotificationPermissionStatus;
    }>
  | Readonly<{
      status: "ready";
      preferences: PersistedPreferences;
      notificationPermission: NotificationPermissionStatus;
      saved: boolean;
    }>
  | Readonly<{
      status: "saving";
      mode: "create" | "update";
      notificationPermission: NotificationPermissionStatus;
    }>
  | Readonly<{
      status: "error";
      message: string;
      operation: "load" | "save";
      retryable?: boolean;
    }>;

export type PreferencesRepository = Readonly<{
  get(): Promise<PersistedPreferences | null>;
  create(input: PreferenceInput): Promise<PersistedPreferences>;
  update(
    input: PreferenceInput,
    expectedVersion: number,
  ): Promise<PersistedPreferences>;
}>;

export interface PreferencesRuntime {
  snapshot(): PreferencesSnapshot;
  activate(subject: string): PreferencesSnapshot;
  subscribe(listener: (snapshot: PreferencesSnapshot) => void): () => void;
  boot(): Promise<PreferencesSnapshot>;
  save(preferences: PreferenceInput): Promise<PreferencesSnapshot>;
  reset(): PreferencesSnapshot;
}

export function createPreferencesRuntime(input: {
  defaults: PreferenceInput;
  notificationPermission: () => NotificationPermissionStatus;
  repository: PreferencesRepository;
}): PreferencesRuntime {
  let state: PreferencesSnapshot = { status: "loading" };
  let generation = 0;
  let activeSubject: string | null = null;
  let loadPromise: Promise<PreferencesSnapshot> | null = null;
  let saveTail: Promise<PreferencesSnapshot> = Promise.resolve(state);
  let saveRunning = false;
  let lastSave: Readonly<{
    input: PreferenceInput;
    promise: Promise<PreferencesSnapshot>;
  }> | null = null;
  const listeners = new Set<(snapshot: PreferencesSnapshot) => void>();
  const emit = () => {
    for (const listener of listeners) listener(state);
    return state;
  };
  return {
    snapshot: () => state,
    activate(subject) {
      if (activeSubject === subject) return state;
      generation += 1;
      activeSubject = subject;
      loadPromise = null;
      lastSave = null;
      saveRunning = false;
      state = { status: "loading" };
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    boot() {
      if (loadPromise !== null) return loadPromise;
      const operationGeneration = generation;
      state = { status: "loading" };
      emit();
      const operation = (async () => {
        try {
          const preferences = await input.repository.get();
          if (operationGeneration !== generation) return state;
          if (preferences === null) {
            state = {
              status: "onboarding",
              defaults: input.defaults,
              notificationPermission: input.notificationPermission(),
            };
          } else {
            state = {
              status: "ready",
              preferences,
              notificationPermission: input.notificationPermission(),
              saved: false,
            };
          }
        } catch {
          if (operationGeneration !== generation) return state;
          state = {
            status: "error",
            message: "Preferences could not be loaded.",
            operation: "load",
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
    save(preferences) {
      const request = copyPreferenceInput(preferences);
      if (lastSave && samePreferenceInput(lastSave.input, request)) {
        return lastSave.promise;
      }
      const operationGeneration = generation;
      const perform = async () => {
        if (operationGeneration !== generation) return state;
        const source = state;
        const mode = source.status === "onboarding" ? "create" : "update";
        state = {
          status: "saving",
          mode,
          notificationPermission: input.notificationPermission(),
        };
        emit();
        try {
          const persisted =
            source.status === "onboarding"
              ? await input.repository.create(request)
              : source.status === "ready"
                ? await input.repository.update(
                    request,
                    source.preferences.version,
                  )
                : null;
          if (operationGeneration !== generation) return state;
          if (persisted === null) throw new Error("invalid_state");
          state = {
            status: "ready",
            preferences: persisted,
            notificationPermission: input.notificationPermission(),
            saved: true,
          };
        } catch {
          if (operationGeneration !== generation) return state;
          state = {
            status: "error",
            message: "Preferences could not be saved. Reload and try again.",
            operation: "save",
          };
        }
        return emit();
      };
      const operation = saveRunning ? saveTail.then(perform) : perform();
      saveRunning = true;
      const tracked = operation.finally(() => {
        if (lastSave?.promise === tracked) {
          lastSave = null;
          saveRunning = false;
        }
      });
      saveTail = tracked;
      lastSave = { input: request, promise: tracked };
      return tracked;
    },
    reset() {
      generation += 1;
      activeSubject = null;
      loadPromise = null;
      lastSave = null;
      saveRunning = false;
      state = { status: "loading" };
      return emit();
    },
  };
}

function copyPreferenceInput(input: PreferenceInput): PreferenceInput {
  return {
    timezone: input.timezone,
    homeCurrency: input.homeCurrency,
    reminderLeadDays: [...input.reminderLeadDays],
    emailRemindersEnabled: input.emailRemindersEnabled,
    locale: input.locale,
  };
}

function samePreferenceInput(left: PreferenceInput, right: PreferenceInput) {
  return (
    left.timezone === right.timezone &&
    left.homeCurrency === right.homeCurrency &&
    left.emailRemindersEnabled === right.emailRemindersEnabled &&
    left.locale === right.locale &&
    left.reminderLeadDays.length === right.reminderLeadDays.length &&
    left.reminderLeadDays.every(
      (value, index) => value === right.reminderLeadDays[index],
    )
  );
}

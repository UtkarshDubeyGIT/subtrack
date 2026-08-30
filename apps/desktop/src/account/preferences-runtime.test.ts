import { describe, expect, it, vi } from "vitest";
import { createPreferencesRuntime } from "./preferences-runtime";

const defaults = {
  timezone: "Asia/Kolkata",
  homeCurrency: "INR",
  reminderLeadDays: [7, 3, 1],
  emailRemindersEnabled: false,
  locale: "en-IN",
} as const;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("preferences runtime", () => {
  it("clears an earlier subject before loading a directly switched account", async () => {
    const prior = {
      ...defaults,
      timezone: "America/Los_Angeles",
      version: 3,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    } as const;
    const runtime = createPreferencesRuntime({
      defaults,
      notificationPermission: () => "granted",
      repository: {
        get: vi.fn(async () => prior),
        create: vi.fn(),
        update: vi.fn(),
      },
    });
    runtime.activate("user_a");
    await runtime.boot();

    expect(runtime.activate("user_b")).toEqual({ status: "loading" });
    expect(JSON.stringify(runtime.snapshot())).not.toContain(
      "America/Los_Angeles",
    );
  });

  it("coalesces overlapping onboarding saves into one mutation", async () => {
    let resolveCreate!: (value: {
      timezone: string;
      homeCurrency: string;
      reminderLeadDays: readonly number[];
      emailRemindersEnabled: boolean;
      locale: string;
      version: number;
      createdAt: string;
      updatedAt: string;
    }) => void;
    const creating = new Promise<Parameters<typeof resolveCreate>[0]>(
      (resolve) => {
        resolveCreate = resolve;
      },
    );
    const repository = {
      get: vi.fn(async () => null),
      create: vi.fn(() => creating),
      update: vi.fn(),
    };
    const runtime = createPreferencesRuntime({
      defaults,
      notificationPermission: () => "prompt",
      repository,
    });
    await runtime.boot();

    const first = runtime.save(defaults);
    const second = runtime.save(defaults);
    expect(runtime.snapshot()).toMatchObject({
      status: "saving",
      mode: "create",
    });
    expect(repository.create).toHaveBeenCalledTimes(1);
    resolveCreate({
      ...defaults,
      version: 1,
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    });

    const results = await Promise.all([first, second]);
    expect(results).toEqual([runtime.snapshot(), runtime.snapshot()]);
    expect(repository.create).toHaveBeenCalledTimes(1);
  });

  it("serializes a newer differing save instead of silently dropping it", async () => {
    const firstPersisted = {
      ...defaults,
      version: 1,
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    } as const;
    const changed = { ...defaults, reminderLeadDays: [30] } as const;
    const secondPersisted = {
      ...changed,
      version: 2,
      createdAt: firstPersisted.createdAt,
      updatedAt: "2026-08-06T00:01:00.000Z",
    } as const;
    const pendingCreate = deferred<typeof firstPersisted>();
    const repository = {
      get: vi.fn(async () => null),
      create: vi.fn(() => pendingCreate.promise),
      update: vi.fn(async () => secondPersisted),
    };
    const runtime = createPreferencesRuntime({
      defaults,
      notificationPermission: () => "prompt",
      repository,
    });
    await runtime.boot();

    const first = runtime.save(defaults);
    const second = runtime.save(changed);
    pendingCreate.resolve(firstPersisted);

    await expect(first).resolves.toMatchObject({
      status: "ready",
      preferences: firstPersisted,
    });
    await expect(second).resolves.toMatchObject({
      status: "ready",
      preferences: secondPersisted,
    });
    expect(repository.create).toHaveBeenCalledOnce();
    expect(repository.update).toHaveBeenCalledWith(changed, 1);
  });

  it("coalesces overlapping preference reloads", async () => {
    const loading = deferred<null>();
    const repository = {
      get: vi.fn(() => loading.promise),
      create: vi.fn(),
      update: vi.fn(),
    };
    const runtime = createPreferencesRuntime({
      defaults,
      notificationPermission: () => "prompt",
      repository,
    });

    const first = runtime.boot();
    const second = runtime.boot();
    expect(runtime.snapshot()).toEqual({ status: "loading" });
    expect(repository.get).toHaveBeenCalledOnce();
    loading.resolve(null);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "onboarding" }),
      expect.objectContaining({ status: "onboarding" }),
    ]);
  });

  it("starts onboarding with safe local defaults when no preferences exist", async () => {
    const repository = {
      get: vi.fn(async () => null),
      create: vi.fn(),
      update: vi.fn(),
    };
    const runtime = createPreferencesRuntime({
      defaults,
      notificationPermission: () => "denied",
      repository,
    });

    await expect(runtime.boot()).resolves.toEqual({
      status: "onboarding",
      defaults,
      notificationPermission: "denied",
    });
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it("loads existing preferences into the signed-in account state", async () => {
    const preferences = {
      ...defaults,
      reminderLeadDays: [14, 2],
      emailRemindersEnabled: true,
      version: 4,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    } as const;
    const runtime = createPreferencesRuntime({
      defaults,
      notificationPermission: () => "granted",
      repository: {
        get: vi.fn(async () => preferences),
        create: vi.fn(),
        update: vi.fn(),
      },
    });

    await expect(runtime.boot()).resolves.toEqual({
      status: "ready",
      preferences,
      notificationPermission: "granted",
      saved: false,
    });
  });

  it("creates preferences once to complete onboarding", async () => {
    const persisted = {
      ...defaults,
      version: 1,
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    } as const;
    const repository = {
      get: vi.fn(async () => null),
      create: vi.fn(async () => persisted),
      update: vi.fn(),
    };
    const runtime = createPreferencesRuntime({
      defaults,
      notificationPermission: () => "prompt",
      repository,
    });
    await runtime.boot();

    await expect(runtime.save(defaults)).resolves.toEqual({
      status: "ready",
      preferences: persisted,
      notificationPermission: "prompt",
      saved: true,
    });
    expect(repository.create).toHaveBeenCalledWith(defaults);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it("updates existing preferences with optimistic concurrency", async () => {
    const existing = {
      ...defaults,
      version: 4,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    } as const;
    const changed = {
      ...defaults,
      reminderLeadDays: [30, 7],
      emailRemindersEnabled: true,
    } as const;
    const updated = {
      ...existing,
      ...changed,
      version: 5,
      updatedAt: "2026-08-06T00:00:00.000Z",
    } as const;
    const repository = {
      get: vi.fn(async () => existing),
      create: vi.fn(),
      update: vi.fn(async () => updated),
    };
    const runtime = createPreferencesRuntime({
      defaults,
      notificationPermission: () => "granted",
      repository,
    });
    await runtime.boot();

    await expect(runtime.save(changed)).resolves.toMatchObject({
      status: "ready",
      preferences: updated,
      saved: true,
    });
    expect(repository.update).toHaveBeenCalledWith(changed, 4);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("projects persisted metadata out of editable update input", async () => {
    const existing = {
      ...defaults,
      version: 4,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    } as const;
    const repository = {
      get: vi.fn(async () => existing),
      create: vi.fn(),
      update: vi.fn(async () => ({
        ...existing,
        timezone: "Europe/Paris",
        version: 5,
      })),
    };
    const runtime = createPreferencesRuntime({
      defaults,
      notificationPermission: () => "granted",
      repository,
    });
    await runtime.boot();

    await runtime.save({ ...existing, timezone: "Europe/Paris" });

    expect(repository.update).toHaveBeenCalledWith(
      {
        timezone: "Europe/Paris",
        homeCurrency: "INR",
        reminderLeadDays: [7, 3, 1],
        emailRemindersEnabled: false,
        locale: "en-IN",
      },
      4,
    );
  });

  it("redacts load failures and allows a clean retry", async () => {
    const repository = {
      get: vi
        .fn<() => Promise<null>>()
        .mockRejectedValueOnce(
          new Error("person@example.test bearer=secret-session"),
        )
        .mockResolvedValueOnce(null),
      create: vi.fn(),
      update: vi.fn(),
    };
    const runtime = createPreferencesRuntime({
      defaults,
      notificationPermission: () => "unsupported",
      repository,
    });

    await expect(runtime.boot()).resolves.toEqual({
      status: "error",
      message: "Preferences could not be loaded.",
      operation: "load",
    });
    expect(JSON.stringify(runtime.snapshot())).not.toMatch(
      /person@|bearer|secret/i,
    );

    await expect(runtime.boot()).resolves.toMatchObject({
      status: "onboarding",
      notificationPermission: "unsupported",
    });
  });

  it("redacts save failures without exposing the rejected preference data", async () => {
    const repository = {
      get: vi.fn(async () => null),
      create: vi.fn(async () => {
        throw new Error("email=person@example.test token=secret");
      }),
      update: vi.fn(),
    };
    const runtime = createPreferencesRuntime({
      defaults,
      notificationPermission: () => "denied",
      repository,
    });
    await runtime.boot();

    await expect(runtime.save(defaults)).resolves.toEqual({
      status: "error",
      message: "Preferences could not be saved. Reload and try again.",
      operation: "save",
    });
    expect(JSON.stringify(runtime.snapshot())).not.toMatch(
      /person@|token|secret/i,
    );
  });

  it("forgets prior account preferences before another auth route", async () => {
    const prior = {
      ...defaults,
      timezone: "America/Los_Angeles",
      version: 9,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    } as const;
    const runtime = createPreferencesRuntime({
      defaults,
      notificationPermission: () => "granted",
      repository: {
        get: vi.fn(async () => prior),
        create: vi.fn(),
        update: vi.fn(),
      },
    });
    await runtime.boot();

    expect(runtime.reset()).toEqual({ status: "loading" });
    expect(JSON.stringify(runtime.snapshot())).not.toContain(
      "America/Los_Angeles",
    );
  });

  it("ignores a stale preference load that resolves after account reset", async () => {
    let resolveLoad!: (value: {
      timezone: string;
      homeCurrency: string;
      reminderLeadDays: number[];
      emailRemindersEnabled: boolean;
      locale: string;
      version: number;
      createdAt: string;
      updatedAt: string;
    }) => void;
    const loading = new Promise<Parameters<typeof resolveLoad>[0]>(
      (resolve) => {
        resolveLoad = resolve;
      },
    );
    const runtime = createPreferencesRuntime({
      defaults,
      notificationPermission: () => "granted",
      repository: {
        get: vi.fn(() => loading),
        create: vi.fn(),
        update: vi.fn(),
      },
    });

    const booting = runtime.boot();
    runtime.reset();
    resolveLoad({
      ...defaults,
      reminderLeadDays: [7, 1],
      version: 2,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    });

    await expect(booting).resolves.toEqual({ status: "loading" });
    expect(runtime.snapshot()).toEqual({ status: "loading" });
  });

  it("ignores a stale preference save that resolves after account reset", async () => {
    let resolveSave!: (value: {
      timezone: string;
      homeCurrency: string;
      reminderLeadDays: number[];
      emailRemindersEnabled: boolean;
      locale: string;
      version: number;
      createdAt: string;
      updatedAt: string;
    }) => void;
    const saving = new Promise<Parameters<typeof resolveSave>[0]>((resolve) => {
      resolveSave = resolve;
    });
    const runtime = createPreferencesRuntime({
      defaults,
      notificationPermission: () => "granted",
      repository: {
        get: vi.fn(async () => null),
        create: vi.fn(() => saving),
        update: vi.fn(),
      },
    });
    await runtime.boot();

    const save = runtime.save(defaults);
    runtime.reset();
    resolveSave({
      ...defaults,
      reminderLeadDays: [30],
      version: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    });

    await expect(save).resolves.toEqual({ status: "loading" });
    expect(runtime.snapshot()).toEqual({ status: "loading" });
  });
});

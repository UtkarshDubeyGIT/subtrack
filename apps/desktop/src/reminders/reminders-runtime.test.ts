import { describe, expect, it, vi } from "vitest";
import type { ReminderDelivery } from "@subtrack/data";
import {
  createRemindersRuntime,
  type RemindersRepositoryBoundary,
} from "./reminders-runtime";

const NOW = "2026-08-30T12:00:00.000Z";

const delivery = (
  overrides: Partial<ReminderDelivery> & { idempotencyKey: string },
): ReminderDelivery => ({
  subscriptionId: "sub_a",
  occurrenceDate: "2026-09-06",
  channel: "in_app",
  state: "pending",
  attemptCount: 0,
  scheduledFor: "2026-08-30T09:00:00.000Z",
  deliveredAt: null,
  errorCode: null,
  ...overrides,
});

const repositoryWith = (
  deliveries: readonly ReminderDelivery[],
  acknowledgeDelivery = vi.fn(async (input: { idempotencyKey: string }) =>
    delivery({ idempotencyKey: input.idempotencyKey, state: "delivered" }),
  ),
): RemindersRepositoryBoundary & {
  acknowledgeDelivery: typeof acknowledgeDelivery;
} => ({
  listDeliveries: async () => deliveries,
  acknowledgeDelivery,
});

describe("due selection", () => {
  it("surfaces only pending or claimed non-email rows whose moment has come", async () => {
    const repository = repositoryWith([
      delivery({ idempotencyKey: "due_in_app" }),
      delivery({ idempotencyKey: "due_claimed", state: "claimed" }),
      delivery({
        idempotencyKey: "future",
        scheduledFor: "2026-09-15T09:00:00.000Z",
      }),
      delivery({ idempotencyKey: "email", channel: "email" }),
      delivery({ idempotencyKey: "settled", state: "delivered" }),
      delivery({ idempotencyKey: "gone", state: "canceled" }),
    ]);
    const runtime = createRemindersRuntime({ repository, now: () => NOW });
    runtime.activate("user_a");

    const snapshot = await runtime.refresh();

    expect(snapshot.status).toBe("ready");
    if (snapshot.status !== "ready") return;
    expect(snapshot.due.map((entry) => entry.idempotencyKey)).toEqual([
      "due_in_app",
      "due_claimed",
    ]);
    expect(snapshot.announcement).toBe("2 renewal reminders are due.");
  });

  it("does nothing before activation", async () => {
    const repository = repositoryWith([delivery({ idempotencyKey: "due" })]);
    const runtime = createRemindersRuntime({ repository, now: () => NOW });

    const snapshot = await runtime.refresh();

    expect(snapshot.status).toBe("idle");
  });

  it("reports a load failure without losing the runtime", async () => {
    const runtime = createRemindersRuntime({
      repository: {
        listDeliveries: async () => {
          throw new Error("offline");
        },
        acknowledgeDelivery: async () => {
          throw new Error("unused");
        },
      },
      now: () => NOW,
    });
    runtime.activate("user_a");

    const snapshot = await runtime.refresh();

    expect(snapshot).toEqual({
      status: "error",
      message: "Reminders could not be loaded.",
    });
  });
});

describe("native notification offering", () => {
  it("acknowledges a shown native notification as delivered", async () => {
    const acknowledge = vi.fn(async (input: { idempotencyKey: string }) =>
      delivery({ idempotencyKey: input.idempotencyKey, state: "delivered" }),
    );
    const repository = repositoryWith(
      [delivery({ idempotencyKey: "native_due", channel: "native" })],
      acknowledge,
    );
    const notify = vi.fn(() => "shown" as const);
    const runtime = createRemindersRuntime({
      repository,
      notify,
      now: () => NOW,
    });
    runtime.activate("user_a");

    const snapshot = await runtime.refresh();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith({
      idempotencyKey: "native_due",
      state: "delivered",
    });
    if (snapshot.status !== "ready") throw new Error(snapshot.status);
    expect(snapshot.due).toEqual([]);
  });

  it("keeps the row listed when the notifier is unavailable", async () => {
    const repository = repositoryWith([
      delivery({ idempotencyKey: "native_due", channel: "native" }),
    ]);
    const runtime = createRemindersRuntime({
      repository,
      notify: () => "unavailable",
      now: () => NOW,
    });
    runtime.activate("user_a");

    const snapshot = await runtime.refresh();

    if (snapshot.status !== "ready") throw new Error(snapshot.status);
    expect(snapshot.due.map((entry) => entry.idempotencyKey)).toEqual([
      "native_due",
    ]);
    expect(repository.acknowledgeDelivery).not.toHaveBeenCalled();
  });

  it("reports a notifier failure with an error code and settles the row", async () => {
    const acknowledge = vi.fn(async (input: { idempotencyKey: string }) =>
      delivery({
        idempotencyKey: input.idempotencyKey,
        state: "failed",
        errorCode: "NATIVE_NOTIFY_FAILED",
      }),
    );
    const repository = repositoryWith(
      [delivery({ idempotencyKey: "native_due", channel: "native" })],
      acknowledge,
    );
    const runtime = createRemindersRuntime({
      repository,
      notify: () => "failed",
      now: () => NOW,
    });
    runtime.activate("user_a");

    await runtime.refresh();

    expect(acknowledge).toHaveBeenCalledWith({
      idempotencyKey: "native_due",
      state: "failed",
      errorCode: "NATIVE_NOTIFY_FAILED",
    });
  });

  it("offers each native row to the notifier once per session", async () => {
    const acknowledge = vi.fn(async () => {
      throw new Error("acknowledgement offline");
    });
    const repository = repositoryWith(
      [delivery({ idempotencyKey: "native_due", channel: "native" })],
      acknowledge as never,
    );
    const notify = vi.fn(() => "shown" as const);
    const runtime = createRemindersRuntime({
      repository,
      notify,
      now: () => NOW,
    });
    runtime.activate("user_a");

    await runtime.refresh();
    await runtime.refresh();

    // Acknowledgement failed both times, so the row is still due — but the
    // notification must not have fired twice.
    expect(notify).toHaveBeenCalledTimes(1);
    const snapshot = runtime.snapshot();
    if (snapshot.status !== "ready") throw new Error(snapshot.status);
    expect(snapshot.due.map((entry) => entry.idempotencyKey)).toEqual([
      "native_due",
    ]);
  });
});

describe("explicit resolution", () => {
  it("marks a reminder done optimistically and keeps it gone on success", async () => {
    const repository = repositoryWith([
      delivery({ idempotencyKey: "due_a" }),
      delivery({
        idempotencyKey: "due_b",
        scheduledFor: "2026-08-30T10:00:00.000Z",
      }),
    ]);
    const runtime = createRemindersRuntime({ repository, now: () => NOW });
    runtime.activate("user_a");
    await runtime.refresh();

    const snapshot = await runtime.markDone("due_a");

    if (snapshot.status !== "ready") throw new Error(snapshot.status);
    expect(snapshot.due.map((entry) => entry.idempotencyKey)).toEqual([
      "due_b",
    ]);
    expect(repository.acknowledgeDelivery).toHaveBeenCalledWith({
      idempotencyKey: "due_a",
      state: "delivered",
    });
  });

  it("dismisses a reminder as canceled", async () => {
    const repository = repositoryWith([delivery({ idempotencyKey: "due_a" })]);
    const runtime = createRemindersRuntime({ repository, now: () => NOW });
    runtime.activate("user_a");
    await runtime.refresh();

    await runtime.dismiss("due_a");

    expect(repository.acknowledgeDelivery).toHaveBeenCalledWith({
      idempotencyKey: "due_a",
      state: "canceled",
    });
  });

  it("restores the row in scheduled order when the server rejects", async () => {
    const acknowledge = vi.fn(async () => {
      throw new Error("conflict");
    });
    const repository = repositoryWith(
      [
        delivery({
          idempotencyKey: "early",
          scheduledFor: "2026-08-30T08:00:00.000Z",
        }),
        delivery({ idempotencyKey: "late" }),
      ],
      acknowledge as never,
    );
    const runtime = createRemindersRuntime({ repository, now: () => NOW });
    runtime.activate("user_a");
    await runtime.refresh();

    const snapshot = await runtime.markDone("early");

    if (snapshot.status !== "ready") throw new Error(snapshot.status);
    expect(snapshot.due.map((entry) => entry.idempotencyKey)).toEqual([
      "early",
      "late",
    ]);
    expect(snapshot.announcement).toBe(
      "The reminder update did not reach the server.",
    );
  });
});

describe("session boundaries", () => {
  it("clears state on reset and refuses stale in-flight results", async () => {
    let release: (value: readonly ReminderDelivery[]) => void = () => {};
    const gate = new Promise<readonly ReminderDelivery[]>((resolve) => {
      release = resolve;
    });
    const runtime = createRemindersRuntime({
      repository: {
        listDeliveries: () => gate,
        acknowledgeDelivery: async () => {
          throw new Error("unused");
        },
      },
      now: () => NOW,
    });
    runtime.activate("user_a");
    const pending = runtime.refresh();

    runtime.reset();
    release([delivery({ idempotencyKey: "stale" })]);
    await pending;

    expect(runtime.snapshot()).toEqual({ status: "idle" });
  });

  it("re-offers notifications for a different account, not the same one", async () => {
    const acknowledge = vi.fn(async () => {
      throw new Error("offline");
    });
    const repository = repositoryWith(
      [delivery({ idempotencyKey: "native_due", channel: "native" })],
      acknowledge as never,
    );
    const notify = vi.fn(() => "shown" as const);
    const runtime = createRemindersRuntime({
      repository,
      notify,
      now: () => NOW,
    });

    runtime.activate("user_a");
    await runtime.refresh();
    runtime.activate("user_a");
    await runtime.refresh();
    expect(notify).toHaveBeenCalledTimes(1);

    runtime.reset();
    runtime.activate("user_b");
    await runtime.refresh();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

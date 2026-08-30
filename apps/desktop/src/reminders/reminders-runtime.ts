import type { ReminderDelivery } from "@subtrack/data";

/**
 * Client-side reminder delivery.
 *
 * The server materializes deliveries and owns every write except the
 * acknowledgement RPC, so this runtime's whole job is: find the rows that are
 * due right now, get them in front of the user, and report what happened.
 *
 * Channel semantics on this surface:
 * - `native` rows are offered to the OS notifier. If the notifier shows the
 *   notification, the delivery is acknowledged `delivered` automatically;
 *   otherwise the row stays visible in the due list so delivery still
 *   happens, just less loudly.
 * - `in_app` rows are only ever shown in the due list and are resolved by an
 *   explicit user action.
 * - `email` rows are never handled here; sending email is the server's job.
 */

export type DueReminder = Readonly<{
  idempotencyKey: string;
  subscriptionId: string;
  occurrenceDate: string;
  channel: "in_app" | "native";
  state: "pending" | "claimed";
  scheduledFor: string;
}>;

export type RemindersSnapshot =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{
      status: "ready";
      due: readonly DueReminder[];
      announcement: string | null;
    }>
  | Readonly<{ status: "error"; message: string }>;

export type RemindersRepositoryBoundary = Readonly<{
  listDeliveries(): Promise<readonly ReminderDelivery[]>;
  acknowledgeDelivery(
    input: Readonly<{
      idempotencyKey: string;
      state: "delivered" | "canceled" | "failed";
      errorCode?: string;
    }>,
  ): Promise<ReminderDelivery>;
}>;

/**
 * Presents one native notification. Returns what actually happened, because
 * the three outcomes demand different follow-ups: shown must acknowledge,
 * unavailable must fall back to the list silently, and failed must report.
 */
export type NativeNotifier = (
  input: Readonly<{ title: string; body: string }>,
) => "shown" | "unavailable" | "failed";

export interface RemindersRuntime {
  snapshot(): RemindersSnapshot;
  subscribe(listener: (snapshot: RemindersSnapshot) => void): () => void;
  activate(subject: string): RemindersSnapshot;
  refresh(): Promise<RemindersSnapshot>;
  markDone(idempotencyKey: string): Promise<RemindersSnapshot>;
  dismiss(idempotencyKey: string): Promise<RemindersSnapshot>;
  reset(): RemindersSnapshot;
}

export function createRemindersRuntime(input: {
  repository: RemindersRepositoryBoundary;
  notify?: NativeNotifier;
  now?: () => string;
  describe?: (reminder: DueReminder) => string;
}): RemindersRuntime {
  const notify: NativeNotifier = input.notify ?? (() => "unavailable");
  const now = input.now ?? (() => new Date().toISOString());
  const describe =
    input.describe ??
    ((reminder: DueReminder) =>
      `Renewal on ${reminder.occurrenceDate} is coming up.`);

  let state: RemindersSnapshot = { status: "idle" };
  let activeSubject: string | null = null;
  let generation = 0;
  // Keys already offered to the OS notifier this session. A notification
  // whose acknowledgement failed must not fire again on every refresh.
  const offered = new Set<string>();
  const listeners = new Set<(snapshot: RemindersSnapshot) => void>();

  const publish = (next: RemindersSnapshot) => {
    state = next;
    for (const listener of listeners) listener(state);
    return state;
  };

  const dueFromDeliveries = (deliveries: readonly ReminderDelivery[]) => {
    const cutoff = now();
    return deliveries
      .filter(
        (delivery): delivery is ReminderDelivery & DueReminder =>
          (delivery.state === "pending" || delivery.state === "claimed") &&
          delivery.channel !== "email" &&
          delivery.scheduledFor <= cutoff,
      )
      .map((delivery) => ({
        idempotencyKey: delivery.idempotencyKey,
        subscriptionId: delivery.subscriptionId,
        occurrenceDate: delivery.occurrenceDate,
        channel: delivery.channel,
        state: delivery.state,
        scheduledFor: delivery.scheduledFor,
      }));
  };

  const acknowledge = async (
    key: string,
    ack: "delivered" | "canceled" | "failed",
    errorCode?: string,
  ) => {
    if (state.status !== "ready") return state;
    const before = state.due;
    const target = before.find((entry) => entry.idempotencyKey === key);
    if (!target) return state;
    const remaining = before.filter((entry) => entry.idempotencyKey !== key);
    const startGeneration = generation;
    publish({
      status: "ready",
      due: remaining,
      announcement:
        ack === "delivered" ? "Reminder marked done." : "Reminder dismissed.",
    });
    try {
      await input.repository.acknowledgeDelivery(
        errorCode === undefined
          ? { idempotencyKey: key, state: ack }
          : { idempotencyKey: key, state: ack, errorCode },
      );
      return state;
    } catch {
      if (generation !== startGeneration) return state;
      if (state.status !== "ready") return state;
      // Restore the row so the reminder is not silently lost; scheduled
      // order is preserved by re-sorting the restored list.
      const restored = [...state.due, target].sort(
        (left, right) =>
          left.scheduledFor.localeCompare(right.scheduledFor) ||
          left.idempotencyKey.localeCompare(right.idempotencyKey),
      );
      return publish({
        status: "ready",
        due: restored,
        announcement: "The reminder update did not reach the server.",
      });
    }
  };

  return {
    snapshot: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    activate(subject) {
      if (activeSubject !== subject) {
        activeSubject = subject;
        generation += 1;
        offered.clear();
        state = { status: "loading" };
      }
      return state;
    },

    async refresh() {
      if (activeSubject === null) return state;
      const startGeneration = generation;
      if (state.status === "idle") publish({ status: "loading" });
      let deliveries: readonly ReminderDelivery[];
      try {
        deliveries = await input.repository.listDeliveries();
      } catch {
        if (generation !== startGeneration) return state;
        return publish({
          status: "error",
          message: "Reminders could not be loaded.",
        });
      }
      if (generation !== startGeneration) return state;

      const due = dueFromDeliveries(deliveries);

      // Offer native rows to the OS notifier once per session each.
      const settled: string[] = [];
      for (const reminder of due) {
        if (reminder.channel !== "native") continue;
        if (offered.has(reminder.idempotencyKey)) continue;
        offered.add(reminder.idempotencyKey);
        const outcome = notify({
          title: "Subtrack renewal reminder",
          body: describe(reminder),
        });
        if (outcome === "unavailable") continue;
        try {
          if (outcome === "shown") {
            await input.repository.acknowledgeDelivery({
              idempotencyKey: reminder.idempotencyKey,
              state: "delivered",
            });
            settled.push(reminder.idempotencyKey);
          } else {
            await input.repository.acknowledgeDelivery({
              idempotencyKey: reminder.idempotencyKey,
              state: "failed",
              errorCode: "NATIVE_NOTIFY_FAILED",
            });
            settled.push(reminder.idempotencyKey);
          }
        } catch {
          // The row stays in the due list; delivery falls back to it.
        }
        if (generation !== startGeneration) return state;
      }

      const remaining = due.filter(
        (reminder) => !settled.includes(reminder.idempotencyKey),
      );
      return publish({
        status: "ready",
        due: remaining,
        announcement:
          remaining.length === 0
            ? null
            : remaining.length === 1
              ? "1 renewal reminder is due."
              : `${remaining.length} renewal reminders are due.`,
      });
    },

    markDone: (key) => acknowledge(key, "delivered"),
    dismiss: (key) => acknowledge(key, "canceled"),

    reset() {
      activeSubject = null;
      generation += 1;
      offered.clear();
      return publish({ status: "idle" });
    },
  };
}

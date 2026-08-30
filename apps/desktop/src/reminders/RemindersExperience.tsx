import { useEffect, useState } from "react";
import type { RemindersRuntime, RemindersSnapshot } from "./reminders-runtime";

/**
 * The in-app half of reminder delivery: a due panel that appears only when
 * something actually needs attention. Native-channel reminders that the OS
 * notifier already presented never reach this panel; everything else lands
 * here so a reminder is never silently dropped.
 */
export function RemindersExperience({
  runtime,
  nameOf,
  locale,
  autoRefreshMs = 60_000,
}: Readonly<{
  runtime: RemindersRuntime;
  nameOf: (subscriptionId: string) => string | undefined;
  locale: string;
  autoRefreshMs?: number;
}>) {
  const [snapshot, setSnapshot] = useState<RemindersSnapshot>(
    runtime.snapshot(),
  );

  useEffect(() => {
    const unsubscribe = runtime.subscribe(setSnapshot);
    void runtime.refresh();
    if (autoRefreshMs <= 0) return unsubscribe;
    const timer = setInterval(() => void runtime.refresh(), autoRefreshMs);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [runtime, autoRefreshMs]);

  if (snapshot.status === "error") {
    return (
      <section className="due-reminders" aria-labelledby="due-reminders-error">
        <div className="section-heading-row">
          <h3 id="due-reminders-error">Renewal reminders</h3>
        </div>
        <output role="status" aria-live="polite">
          {snapshot.message}
        </output>
        <button type="button" onClick={() => void runtime.refresh()}>
          Try again
        </button>
      </section>
    );
  }

  if (snapshot.status !== "ready" || snapshot.due.length === 0) {
    return null;
  }

  const formatDate = (date: string) => {
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(
        new Date(`${date}T00:00:00`),
      );
    } catch {
      return date;
    }
  };

  return (
    <section className="due-reminders" aria-labelledby="due-reminders-heading">
      <div className="section-heading-row">
        <h3 id="due-reminders-heading">Due reminders</h3>
        <span>{snapshot.due.length}</span>
      </div>
      {snapshot.announcement ? (
        <output aria-live="polite">{snapshot.announcement}</output>
      ) : null}
      <ul>
        {snapshot.due.map((reminder) => {
          const serviceName =
            nameOf(reminder.subscriptionId) ?? reminder.subscriptionId;
          return (
            <li key={reminder.idempotencyKey}>
              <div className="due-reminder-copy">
                <strong>{serviceName}</strong>
                <span>renews {formatDate(reminder.occurrenceDate)}</span>
              </div>
              <div className="due-reminder-actions">
                <button
                  type="button"
                  onClick={() => void runtime.markDone(reminder.idempotencyKey)}
                >
                  Mark done
                </button>
                <button
                  type="button"
                  className="due-reminder-dismiss"
                  onClick={() => void runtime.dismiss(reminder.idempotencyKey)}
                >
                  Dismiss
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemindersExperience } from "./RemindersExperience";
import {
  createRemindersRuntime,
  type RemindersRepositoryBoundary,
} from "./reminders-runtime";
import type { ReminderDelivery } from "@subtrack/data";

afterEach(() => {
  cleanup();
});

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

const readyRuntime = (
  deliveries: readonly ReminderDelivery[],
  acknowledgeDelivery: RemindersRepositoryBoundary["acknowledgeDelivery"] = async (
    input,
  ) => delivery({ idempotencyKey: input.idempotencyKey, state: "delivered" }),
) => {
  const runtime = createRemindersRuntime({
    repository: { listDeliveries: async () => deliveries, acknowledgeDelivery },
    now: () => NOW,
  });
  runtime.activate("user_a");
  return runtime;
};

describe("RemindersExperience", () => {
  it("renders nothing at all while nothing is due", async () => {
    const runtime = readyRuntime([
      delivery({
        idempotencyKey: "future",
        scheduledFor: "2026-09-15T09:00:00.000Z",
      }),
    ]);
    const { container } = render(
      <RemindersExperience
        runtime={runtime}
        nameOf={() => "Streaming"}
        locale="en-US"
        autoRefreshMs={0}
      />,
    );

    await waitFor(() => expect(runtime.snapshot().status).toBe("ready"));
    expect(container.childElementCount).toBe(0);
  });

  it("lists due reminders with service names and renewal dates", async () => {
    const runtime = readyRuntime([
      delivery({ idempotencyKey: "due_a" }),
      delivery({
        idempotencyKey: "due_b",
        subscriptionId: "sub_b",
        occurrenceDate: "2026-09-02",
        scheduledFor: "2026-08-30T10:00:00.000Z",
      }),
    ]);
    render(
      <RemindersExperience
        runtime={runtime}
        nameOf={(id) => (id === "sub_a" ? "Streaming" : "News")}
        locale="en-US"
        autoRefreshMs={0}
      />,
    );

    const heading = await screen.findByRole("heading", {
      name: "Due reminders",
    });
    const section = heading.closest("section");
    expect(section).not.toBeNull();
    const items = within(section as HTMLElement).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("Streaming");
    expect(items[0]?.textContent).toContain("renews September 6, 2026");
    expect(items[1]?.textContent).toContain("News");
    expect(items[1]?.textContent).toContain("renews September 2, 2026");
  });

  it("marks a reminder done and collapses when the list empties", async () => {
    const acknowledge = vi.fn(async (input: { idempotencyKey: string }) =>
      delivery({ idempotencyKey: input.idempotencyKey, state: "delivered" }),
    );
    const runtime = readyRuntime(
      [delivery({ idempotencyKey: "due_a" })],
      acknowledge,
    );
    const { container } = render(
      <RemindersExperience
        runtime={runtime}
        nameOf={() => "Streaming"}
        locale="en-US"
        autoRefreshMs={0}
      />,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Mark done" }));

    expect(acknowledge).toHaveBeenCalledWith({
      idempotencyKey: "due_a",
      state: "delivered",
    });
    await waitFor(() => expect(container.childElementCount).toBe(0));
  });

  it("dismisses a reminder as canceled", async () => {
    const acknowledge = vi.fn(async (input: { idempotencyKey: string }) =>
      delivery({ idempotencyKey: input.idempotencyKey, state: "canceled" }),
    );
    const runtime = readyRuntime(
      [delivery({ idempotencyKey: "due_a" })],
      acknowledge,
    );
    render(
      <RemindersExperience
        runtime={runtime}
        nameOf={() => "Streaming"}
        locale="en-US"
        autoRefreshMs={0}
      />,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Dismiss" }));

    expect(acknowledge).toHaveBeenCalledWith({
      idempotencyKey: "due_a",
      state: "canceled",
    });
  });

  it("keeps the reminder visible and announces when the server rejects", async () => {
    const runtime = readyRuntime(
      [delivery({ idempotencyKey: "due_a" })],
      async () => {
        throw new Error("offline");
      },
    );
    render(
      <RemindersExperience
        runtime={runtime}
        nameOf={() => "Streaming"}
        locale="en-US"
        autoRefreshMs={0}
      />,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Mark done" }));

    expect(
      await screen.findByText("The reminder update did not reach the server."),
    ).toBeTruthy();
    expect(screen.getByText("Streaming")).toBeTruthy();
  });

  it("offers a retry when loading fails", async () => {
    let failures = 1;
    const runtime = createRemindersRuntime({
      repository: {
        listDeliveries: async () => {
          if (failures > 0) {
            failures -= 1;
            throw new Error("offline");
          }
          return [delivery({ idempotencyKey: "due_a" })];
        },
        acknowledgeDelivery: async () => {
          throw new Error("unused");
        },
      },
      now: () => NOW,
    });
    runtime.activate("user_a");
    render(
      <RemindersExperience
        runtime={runtime}
        nameOf={() => "Streaming"}
        locale="en-US"
        autoRefreshMs={0}
      />,
    );
    const user = userEvent.setup();

    expect(
      await screen.findByText("Reminders could not be loaded."),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("heading", { name: "Due reminders" }),
    ).toBeTruthy();
  });
});

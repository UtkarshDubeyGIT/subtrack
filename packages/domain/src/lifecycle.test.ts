import { describe, expect, it } from "vitest";
import { createLifecycleState, transitionLifecycle } from "./lifecycle";

describe("subscription lifecycle", () => {
  it("converts a trial to active", () => {
    const trial = createLifecycleState({
      status: "trial",
      since: "2026-01-01",
      trialEndsOn: "2026-01-14",
    });
    expect(
      transitionLifecycle(trial, { type: "activate", on: "2026-01-14" }),
    ).toEqual({
      status: "active",
      since: "2026-01-14",
    });
  });

  it("pauses and resumes an active subscription", () => {
    const active = createLifecycleState({
      status: "active",
      since: "2026-01-01",
    });
    const paused = transitionLifecycle(active, {
      type: "pause",
      on: "2026-02-01",
    });
    expect(paused).toEqual({ status: "paused", since: "2026-02-01" });
    expect(
      transitionLifecycle(paused, { type: "resume", on: "2026-02-15" }),
    ).toEqual({
      status: "active",
      since: "2026-02-15",
    });
  });

  it("cancels without immediately expiring paid access", () => {
    const active = createLifecycleState({
      status: "active",
      since: "2026-01-01",
    });
    expect(
      transitionLifecycle(active, {
        type: "cancel",
        on: "2026-03-10",
        accessEndsOn: "2026-03-31",
      }),
    ).toEqual({
      status: "canceled",
      since: "2026-03-10",
      accessEndsOn: "2026-03-31",
    });
  });

  it("expires canceled access only on or after its access-end date", () => {
    const canceled = createLifecycleState({
      status: "canceled",
      since: "2026-03-10",
      accessEndsOn: "2026-03-31",
    });
    expect(() =>
      transitionLifecycle(canceled, { type: "expire", on: "2026-03-30" }),
    ).toThrow("Cannot expire before access ends");
    expect(
      transitionLifecycle(canceled, { type: "expire", on: "2026-03-31" }),
    ).toEqual({
      status: "expired",
      since: "2026-03-31",
    });
  });

  it("requires an explicit restart to reactivate an expired subscription", () => {
    const expired = createLifecycleState({
      status: "expired",
      since: "2026-04-01",
    });
    expect(() =>
      transitionLifecycle(expired, { type: "activate", on: "2026-04-02" }),
    ).toThrow("Invalid lifecycle transition: expired -> activate");
    expect(
      transitionLifecycle(expired, { type: "restart", on: "2026-04-02" }),
    ).toEqual({
      status: "active",
      since: "2026-04-02",
    });
  });

  it.each([
    [
      { status: "trial", since: "2026-01-01", trialEndsOn: "2026-01-14" },
      "pause",
    ],
    [{ status: "active", since: "2026-01-01" }, "resume"],
    [{ status: "paused", since: "2026-01-01" }, "activate"],
    [
      { status: "canceled", since: "2026-01-01", accessEndsOn: "2026-02-01" },
      "pause",
    ],
  ] as const)(
    "rejects invalid transition from $0.status via %s",
    (state, type) => {
      expect(() =>
        transitionLifecycle(createLifecycleState(state), {
          type,
          on: "2026-01-20",
        } as never),
      ).toThrow("Invalid lifecycle transition");
    },
  );

  it("rejects transition dates before the current state began", () => {
    const active = createLifecycleState({
      status: "active",
      since: "2026-02-01",
    });
    expect(() =>
      transitionLifecycle(active, { type: "pause", on: "2026-01-31" }),
    ).toThrow("Lifecycle transition cannot move backward");
  });

  it("rejects invalid state date relationships", () => {
    expect(() =>
      createLifecycleState({
        status: "trial",
        since: "2026-02-01",
        trialEndsOn: "2026-01-31",
      }),
    ).toThrow("trialEndsOn cannot be before since");
  });

  it("rejects unknown lifecycle states at the runtime boundary", () => {
    expect(() =>
      createLifecycleState({ status: "unknown", since: "2026-01-01" } as never),
    ).toThrow("Invalid lifecycle state");
  });

  it("does not activate a trial before its configured end date", () => {
    const trial = createLifecycleState({
      status: "trial",
      since: "2026-01-01",
      trialEndsOn: "2026-01-14",
    });
    expect(() =>
      transitionLifecycle(trial, { type: "activate", on: "2026-01-13" }),
    ).toThrow("Cannot activate before trial ends");
  });
});

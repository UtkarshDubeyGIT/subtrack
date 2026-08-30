import { parseCalendarDate } from "./recurrence";

export type LifecycleState =
  | Readonly<{ status: "trial"; since: string; trialEndsOn: string }>
  | Readonly<{ status: "active"; since: string }>
  | Readonly<{ status: "paused"; since: string }>
  | Readonly<{ status: "canceled"; since: string; accessEndsOn: string }>
  | Readonly<{ status: "expired"; since: string }>;

export type LifecycleAction =
  | Readonly<{ type: "activate"; on: string }>
  | Readonly<{ type: "pause"; on: string }>
  | Readonly<{ type: "resume"; on: string }>
  | Readonly<{ type: "cancel"; on: string; accessEndsOn: string }>
  | Readonly<{ type: "expire"; on: string }>
  | Readonly<{ type: "restart"; on: string }>;

export function createLifecycleState(state: LifecycleState): LifecycleState {
  if (
    typeof state !== "object" ||
    state === null ||
    !Object.hasOwn(state, "status") ||
    !Object.hasOwn(state, "since") ||
    typeof state.status !== "string" ||
    typeof state.since !== "string"
  ) {
    throw new Error("Invalid lifecycle state");
  }
  parseCalendarDate(state.since);
  if (
    !(["trial", "active", "paused", "canceled", "expired"] as const).includes(
      state.status,
    )
  ) {
    throw new Error("Invalid lifecycle state");
  }
  if (state.status === "trial") {
    if (!Object.hasOwn(state, "trialEndsOn")) {
      throw new Error("Invalid lifecycle state");
    }
    parseCalendarDate(state.trialEndsOn);
    if (state.trialEndsOn < state.since)
      throw new Error("trialEndsOn cannot be before since");
  }
  if (state.status === "canceled") {
    if (!Object.hasOwn(state, "accessEndsOn")) {
      throw new Error("Invalid lifecycle state");
    }
    parseCalendarDate(state.accessEndsOn);
    if (state.accessEndsOn < state.since)
      throw new Error("accessEndsOn cannot be before since");
  }
  return { ...state };
}

export function transitionLifecycle(
  current: LifecycleState,
  action: LifecycleAction,
): LifecycleState {
  parseCalendarDate(action.on);
  if (action.on < current.since)
    throw new Error("Lifecycle transition cannot move backward");

  if (current.status === "trial" && action.type === "activate") {
    if (action.on < current.trialEndsOn)
      throw new Error("Cannot activate before trial ends");
    return { status: "active", since: action.on };
  }
  if (current.status === "active" && action.type === "pause") {
    return { status: "paused", since: action.on };
  }
  if (current.status === "paused" && action.type === "resume") {
    return { status: "active", since: action.on };
  }
  if (
    (current.status === "trial" ||
      current.status === "active" ||
      current.status === "paused") &&
    action.type === "cancel"
  ) {
    parseCalendarDate(action.accessEndsOn);
    if (action.accessEndsOn < action.on)
      throw new Error("accessEndsOn cannot be before cancel date");
    return {
      status: "canceled",
      since: action.on,
      accessEndsOn: action.accessEndsOn,
    };
  }
  if (
    (current.status === "active" || current.status === "canceled") &&
    action.type === "expire"
  ) {
    if (current.status === "canceled" && action.on < current.accessEndsOn) {
      throw new Error("Cannot expire before access ends");
    }
    return { status: "expired", since: action.on };
  }
  if (current.status === "expired" && action.type === "restart") {
    return { status: "active", since: action.on };
  }

  throw new Error(
    `Invalid lifecycle transition: ${current.status} -> ${action.type}`,
  );
}

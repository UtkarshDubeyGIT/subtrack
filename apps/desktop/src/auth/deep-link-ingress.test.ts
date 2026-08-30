import { describe, expect, it, vi } from "vitest";
import { deliverAuthCallbacks } from "./deep-link-ingress";
import type { DesktopAuthRuntime } from "./desktop-auth";

describe("desktop deep-link ingress", () => {
  it("delivers every cold-start or forwarded callback in order", async () => {
    const handled: string[] = [];
    const runtime = {
      handleCallback: vi.fn(async (candidate: string) => {
        handled.push(candidate);
        return { status: "verification_pending" } as const;
      }),
    } as unknown as DesktopAuthRuntime;

    await deliverAuthCallbacks(runtime, [
      "subtrack://auth/callback?code=stale&state=old",
      "subtrack://auth/callback?code=current&state=new",
    ]);

    expect(handled).toEqual([
      "subtrack://auth/callback?code=stale&state=old",
      "subtrack://auth/callback?code=current&state=new",
    ]);
  });
});

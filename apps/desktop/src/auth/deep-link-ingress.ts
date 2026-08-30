import type { DesktopAuthRuntime } from "./desktop-auth";

export async function deliverAuthCallbacks(
  runtime: DesktopAuthRuntime,
  candidates: readonly string[] | null,
) {
  for (const candidate of candidates ?? []) {
    await runtime.handleCallback(candidate);
  }
}

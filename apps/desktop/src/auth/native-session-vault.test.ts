import { describe, expect, it, vi } from "vitest";
import { NativeSessionVault } from "./native-session-vault";

describe("NativeSessionVault", () => {
  it("delegates persistence to native OS-keyring commands", async () => {
    const invoke = vi.fn(async (command: string) =>
      command === "read_session_secret"
        ? { refreshCredential: "refresh-secret", subject: "user_123" }
        : undefined,
    );
    const vault = new NativeSessionVault(invoke);

    await expect(vault.read()).resolves.toEqual({
      refreshCredential: "refresh-secret",
      subject: "user_123",
    });
    await vault.write({ refreshCredential: "rotated", subject: "user_123" });
    await vault.clear();

    expect(invoke.mock.calls).toEqual([
      ["read_session_secret"],
      [
        "write_session_secret",
        { session: { refreshCredential: "rotated", subject: "user_123" } },
      ],
      ["clear_session_secret"],
    ]);
  });

  it("rejects malformed native responses", async () => {
    const vault = new NativeSessionVault(
      vi.fn(async () => ({ refreshCredential: "" })),
    );
    await expect(vault.read()).rejects.toThrow(
      "Invalid native session response.",
    );
  });
});

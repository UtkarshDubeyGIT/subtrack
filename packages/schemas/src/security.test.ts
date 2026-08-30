import { describe, expect, it } from "vitest";
import { authCallbackSchema, redactError } from "./index";

describe("authentication callback validation", () => {
  it("accepts only the app callback with a bounded single-use code and state", () => {
    expect(
      authCallbackSchema.parse(
        "subtrack://auth/callback?code=code_123&state=state_456",
      ),
    ).toEqual({ code: "code_123", state: "state_456" });
  });

  it.each([
    "https://attacker.example/auth/callback?code=x&state=y",
    "subtrack://auth/other?code=x&state=y",
    "subtrack://auth/callback?code=x",
    "subtrack://auth/callback?code=x&state=y&extra=1",
    `subtrack://auth/callback?code=${"x".repeat(513)}&state=y`,
    "not a url",
  ])("rejects malformed or untrusted callback %s", (candidate) => {
    expect(() => authCallbackSchema.parse(candidate)).toThrow();
  });
});

describe("error redaction", () => {
  it("returns a stable safe error without leaking tokens, email, or request data", () => {
    const safe = redactError(
      new Error(
        "Bearer eyJhbGciOiJIUzI1NiJ9.secret.signature for person@example.com code=123456",
      ),
      "auth_callback_failed",
    );

    expect(safe).toEqual({
      code: "auth_callback_failed",
      message: "Authentication failed.",
    });
    expect(JSON.stringify(safe)).not.toMatch(/eyJ|person@|123456|Bearer/i);
  });
});

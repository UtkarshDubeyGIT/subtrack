// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function BrokenScreen(): never {
  throw new Error("private_subscription_detail");
}

describe("screen recovery", () => {
  it("replaces a broken screen with recovery instructions without exposing error data", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <BrokenScreen />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Unsaved edits");
    expect(screen.getByRole("button", { name: "Restart view" })).toBeTruthy();
    expect(screen.queryByText(/private_subscription_detail/)).toBeNull();
  });
});

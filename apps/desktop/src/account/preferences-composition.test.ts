import { describe, expect, it, vi } from "vitest";
import { createDesktopPreferencesRuntime } from "./preferences-composition";

const leased = (token: string) => ({ token, isCurrent: () => true });

describe("desktop preferences composition", () => {
  it("fails closed without Supabase public configuration or token work", async () => {
    const accessToken = vi.fn(async () => leased("must-not-be-read"));
    const runtime = createDesktopPreferencesRuntime(
      {},
      { accessToken, notificationPermission: () => "unsupported" },
    );

    await expect(runtime.boot()).resolves.toEqual({
      status: "error",
      message: "Private data sync is not configured.",
      operation: "load",
      retryable: false,
    });
    expect(accessToken).not.toHaveBeenCalled();
  });

  it("loads onboarding through the authenticated user-preferences repository", async () => {
    const accessToken = vi.fn(async () => leased("clerk-session-fixture"));
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      const runtime = createDesktopPreferencesRuntime(
        {
          VITE_SUPABASE_URL: "https://project.supabase.co",
          VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
        },
        {
          accessToken,
          defaults: {
            timezone: "Asia/Kolkata",
            homeCurrency: "INR",
            reminderLeadDays: [7, 1],
            emailRemindersEnabled: false,
            locale: "en-IN",
          },
          notificationPermission: () => "denied",
        },
      );

      await expect(runtime.boot()).resolves.toMatchObject({
        status: "onboarding",
        notificationPermission: "denied",
      });
      expect(accessToken).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledWith(
        expect.stringMatching(
          /^https:\/\/project\.supabase\.co\/rest\/v1\/user_preferences\?/,
        ),
        expect.objectContaining({
          cache: "no-store",
          credentials: "omit",
          method: "GET",
          redirect: "error",
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loads an existing row and patches only exact editable preference fields", async () => {
    const existing = {
      owner_user_id: "user_fixture",
      timezone: "Asia/Kolkata",
      home_currency: "INR",
      reminder_lead_days: [7, 3, 1],
      email_reminders_enabled: false,
      locale: "en-IN",
      version: 4,
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-05T00:00:00.000Z",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([existing]), { status: 200 }),
      )
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        if (typeof init?.body !== "string") throw new Error("missing_body");
        const body = JSON.parse(init.body) as Record<string, unknown>;
        return new Response(
          JSON.stringify([
            {
              ...existing,
              ...body,
              version: 5,
              updated_at: "2026-08-06T00:00:00.000Z",
            },
          ]),
          { status: 200 },
        );
      });
    vi.stubGlobal("fetch", fetcher);
    try {
      const runtime = createDesktopPreferencesRuntime(
        {
          VITE_SUPABASE_URL: "https://project.supabase.co",
          VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
        },
        {
          accessToken: vi.fn(async () => ({
            token: "clerk-session-fixture",
            isCurrent: () => true,
          })),
          notificationPermission: () => "granted",
        },
      );
      await runtime.boot();
      const loaded = runtime.snapshot();
      if (loaded.status !== "ready") throw new Error("expected_ready");

      await runtime.save({
        ...loaded.preferences,
        timezone: "Europe/Paris",
      });

      const patchCall = fetcher.mock.calls[1];
      expect(patchCall?.[1]).toMatchObject({ method: "PATCH" });
      const patchBody = patchCall?.[1]?.body;
      if (typeof patchBody !== "string") throw new Error("missing_patch_body");
      expect(JSON.parse(patchBody)).toEqual({
        timezone: "Europe/Paris",
        home_currency: "INR",
        reminder_lead_days: [7, 3, 1],
        email_reminders_enabled: false,
        locale: "en-IN",
      });
      await expect(Promise.resolve(runtime.snapshot())).resolves.toMatchObject({
        status: "ready",
        saved: true,
        preferences: { timezone: "Europe/Paris", version: 5 },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

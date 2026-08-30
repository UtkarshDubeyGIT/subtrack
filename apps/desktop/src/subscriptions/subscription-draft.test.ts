import { describe, expect, it } from "vitest";
import {
  applyCuratedServiceDefaults,
  createSubscriptionDraft,
  draftFromPersistedSubscription,
  validateSubscriptionDraft,
} from "./subscription-draft";

const context = {
  id: "sub_quick_add",
  today: "2026-08-06",
} as const;

describe("subscription draft validation", () => {
  it("starts a compact recurring draft without inventing price or billing date", () => {
    const draft = createSubscriptionDraft({
      homeCurrency: "INR",
      timezone: "Asia/Kolkata",
    });

    expect(draft).toMatchObject({
      kind: "recurring",
      amount: "",
      currency: "INR",
      nextRenewalDate: "",
      recurrence: "monthly",
      timezone: "Asia/Kolkata",
    });
  });

  it("applies curated service metadata without inventing price or dates", () => {
    const draft = applyCuratedServiceDefaults(
      createSubscriptionDraft({ homeCurrency: "USD", timezone: "UTC" }),
      "Netflix",
    );

    expect(draft).toMatchObject({
      serviceName: "Netflix",
      category: "Streaming",
      managementUrl: "https://www.netflix.com/account",
      amount: "",
      nextRenewalDate: "",
    });
  });

  it("replaces and clears only metadata that came from a curated service", () => {
    const netflix = applyCuratedServiceDefaults(
      createSubscriptionDraft({ homeCurrency: "USD", timezone: "UTC" }),
      "Netflix",
    );

    const spotify = applyCuratedServiceDefaults(netflix, "Spotify");
    expect(spotify).toMatchObject({
      serviceName: "Spotify",
      category: "Music",
      managementUrl: "https://www.spotify.com/account",
    });

    const independent = applyCuratedServiceDefaults(
      spotify,
      "Independent service",
    );
    expect(independent).toMatchObject({
      serviceName: "Independent service",
      category: "",
      managementUrl: "",
    });

    const custom = applyCuratedServiceDefaults(
      {
        ...spotify,
        category: "My listening",
        managementUrl: "https://billing.example.test/custom",
      },
      "Another service",
    );
    expect(custom).toMatchObject({
      serviceName: "Another service",
      category: "My listening",
      managementUrl: "https://billing.example.test/custom",
    });
  });

  it("builds exact minor-unit recurring writes from the minimal composer", () => {
    const result = validateSubscriptionDraft(
      {
        ...createSubscriptionDraft({ homeCurrency: "USD", timezone: "UTC" }),
        serviceName: "Nebula",
        amount: "12.99",
        nextRenewalDate: "2026-09-30",
        recurrence: "monthly",
      },
      context,
    );

    expect(result).toEqual({
      success: true,
      write: {
        subscription: {
          kind: "recurring",
          id: "sub_quick_add",
          serviceName: "Nebula",
          amount: { minorUnits: 1299, currency: "USD", exponent: 2 },
          timezone: "UTC",
          startDate: "2026-09-30",
          nextRenewalDate: "2026-09-30",
          recurrence: { unit: "month", interval: 1 },
          lifecycle: { status: "active", since: "2026-08-06" },
        },
        metadata: {
          planName: null,
          accountEmail: null,
          paymentLabel: null,
          managementUrl: null,
          category: null,
          notes: null,
        },
      },
    });
  });

  it.each([
    ["JPY", "1250", 1250],
    ["BHD", "1.275", 1275],
  ])(
    "parses %s using its ISO exponent without binary floating point",
    (currency, amount, minorUnits) => {
      const result = validateSubscriptionDraft(
        {
          ...createSubscriptionDraft({
            homeCurrency: currency,
            timezone: "UTC",
          }),
          serviceName: "Exact amount",
          amount,
          nextRenewalDate: "2026-09-01",
        },
        context,
      );

      expect(result).toMatchObject({
        success: true,
        write: { subscription: { amount: { minorUnits, currency } } },
      });
    },
  );

  it("builds one-time access with optional metadata and a trial lifecycle", () => {
    const result = validateSubscriptionDraft(
      {
        ...createSubscriptionDraft({
          homeCurrency: "EUR",
          timezone: "Europe/Paris",
        }),
        kind: "one_time",
        serviceName: "Design archive",
        planName: "Permanent library",
        amount: "49.00",
        purchasedOn: "2026-08-01",
        accessEndsOn: "2027-08-01",
        category: "Creative tools",
        accountEmail: "person@example.test",
        paymentLabel: "Visa •••• 4242",
        managementUrl: "https://example.test/manage",
        notes: "Invoice 12345. Password manager family plan.",
      },
      context,
    );

    expect(result).toMatchObject({
      success: true,
      write: {
        subscription: {
          kind: "one_time",
          purchasedOn: "2026-08-01",
          accessEndsOn: "2027-08-01",
          lifecycle: { status: "active", since: "2026-08-06" },
        },
        metadata: {
          planName: "Permanent library",
          category: "Creative tools",
          paymentLabel: "Visa •••• 4242",
        },
      },
    });
  });

  it("represents a recurring trial using explicit dates", () => {
    const result = validateSubscriptionDraft(
      {
        ...createSubscriptionDraft({ homeCurrency: "USD", timezone: "UTC" }),
        serviceName: "Trial service",
        amount: "20.00",
        startDate: "2026-08-10",
        nextRenewalDate: "2026-09-10",
        trialEndsOn: "2026-08-24",
      },
      context,
    );

    expect(result).toMatchObject({
      success: true,
      write: {
        subscription: {
          startDate: "2026-08-10",
          lifecycle: {
            status: "trial",
            since: "2026-08-10",
            trialEndsOn: "2026-08-24",
          },
        },
      },
    });
  });

  it.each([
    ["notes", "Keep CVV: 123 here"],
    ["notes", "Keep CVV #123 here"],
    ["notes", "password = correct-horse-battery-staple"],
    ["notes", "Recovery code: ABCD-EFGH-IJKL"],
    ["notes", "4111\u20111111\u20111111\u20111111"],
    ["paymentLabel", "Card 4111 1111 1111 1111"],
    ["paymentLabel", "Maestro 6759000000000000"],
    ["category", "MIR 2200000000000004"],
    ["accountEmail", "4111111111111111@example.test"],
    ["managementUrl", "https://example.test/card/4111-1111-1111-1111"],
    ["managementUrl", "https://example.test/manage?CVV=%23123"],
  ] as const)("rejects obvious sensitive content in %s", (field, value) => {
    const result = validateSubscriptionDraft(
      {
        ...createSubscriptionDraft({ homeCurrency: "USD", timezone: "UTC" }),
        serviceName: "Sensitive",
        amount: "1.00",
        nextRenewalDate: "2026-09-01",
        [field]: value,
      },
      context,
    );

    expect(result).toMatchObject({
      success: false,
      errors: {
        [field]:
          "Remove card numbers, security codes, passwords, or recovery codes.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("correct-horse");
  });

  it("rejects credential-bearing management links without echoing credentials", () => {
    const result = validateSubscriptionDraft(
      {
        ...createSubscriptionDraft({ homeCurrency: "USD", timezone: "UTC" }),
        serviceName: "Credentials",
        amount: "1.00",
        nextRenewalDate: "2026-09-01",
        managementUrl: "https://person:secret@example.test/manage",
      },
      context,
    );

    expect(result).toMatchObject({
      success: false,
      errors: {
        managementUrl: "Use an https link without embedded credentials.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("returns field-level errors for incomplete quick add instead of throwing", () => {
    const result = validateSubscriptionDraft(
      createSubscriptionDraft({ homeCurrency: "USD", timezone: "UTC" }),
      context,
    );

    expect(result).toEqual({
      success: false,
      errors: {
        serviceName: "Enter a service name.",
        amount: "Enter an amount.",
        nextRenewalDate: "Choose the next renewal date.",
      },
    });
  });

  it("round-trips persisted values into an editable in-memory draft", () => {
    const validated = validateSubscriptionDraft(
      {
        ...createSubscriptionDraft({ homeCurrency: "USD", timezone: "UTC" }),
        serviceName: "Round trip",
        planName: "Plus",
        amount: "9.50",
        nextRenewalDate: "2026-09-06",
        recurrence: "quarterly",
        category: "Learning",
      },
      context,
    );
    if (!validated.success) throw new Error("fixture_invalid");

    const draft = draftFromPersistedSubscription({
      subscription: validated.write.subscription,
      metadata: {
        ...validated.write.metadata,
        category: validated.write.metadata.category ?? null,
      },
      version: 4,
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    });

    expect(draft).toMatchObject({
      serviceName: "Round trip",
      planName: "Plus",
      amount: "9.50",
      recurrence: "quarterly",
      category: "Learning",
    });
  });
});

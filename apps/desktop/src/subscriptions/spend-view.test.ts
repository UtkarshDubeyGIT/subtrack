import { describe, expect, it } from "vitest";
import type { PersistedSubscription } from "@subtrack/data";
import {
  buildSpendView,
  exactDecimalString,
  formatExactMoney,
} from "./spend-view";

type Lifecycle = PersistedSubscription["subscription"]["lifecycle"];

const record = (input: {
  id: string;
  serviceName: string;
  minorUnits: number;
  currency: string;
  exponent: number;
  unit?: "day" | "week" | "month" | "year";
  interval?: number;
  kind?: "recurring" | "one_time";
  lifecycle?: Lifecycle;
}): PersistedSubscription => {
  const base = {
    id: input.id,
    serviceName: input.serviceName,
    amount: {
      minorUnits: input.minorUnits,
      currency: input.currency,
      exponent: input.exponent,
    },
    timezone: "UTC",
    lifecycle: input.lifecycle ?? { status: "active", since: "2026-01-01" },
  };
  const subscription =
    (input.kind ?? "recurring") === "recurring"
      ? {
          ...base,
          kind: "recurring",
          startDate: "2026-01-01",
          nextRenewalDate: "2026-02-01",
          recurrence: {
            unit: input.unit ?? "month",
            interval: input.interval ?? 1,
          },
        }
      : {
          ...base,
          kind: "one_time",
          purchasedOn: "2026-01-01",
          accessEndsOn: null,
        };
  return {
    subscription,
    metadata: {},
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as PersistedSubscription;
};

describe("exact decimal rendering", () => {
  it.each([
    [{ minorUnits: 1999, currency: "USD", exponent: 2 }, "19.99"],
    [{ minorUnits: 5, currency: "USD", exponent: 2 }, "0.05"],
    [{ minorUnits: 100, currency: "USD", exponent: 2 }, "1.00"],
    [{ minorUnits: 2999, currency: "JPY", exponent: 0 }, "2999"],
    [{ minorUnits: -1250, currency: "USD", exponent: 2 }, "-12.50"],
    [{ minorUnits: 1234567, currency: "KWD", exponent: 3 }, "1234.567"],
  ])("renders %o as %s", (amount, expected) => {
    expect(exactDecimalString(amount)).toBe(expected);
  });

  it("renders the largest representable amount exactly", () => {
    // createMoney rejects anything that is not a safe integer, so
    // MAX_SAFE_INTEGER is the real upper bound. Dividing it by the currency
    // scale must not drop or round the trailing digits.
    expect(
      exactDecimalString({
        minorUnits: Number.MAX_SAFE_INTEGER,
        currency: "USD",
        exponent: 2,
      }),
    ).toBe("90071992547409.91");
  });
});

describe("money formatting", () => {
  it("formats with the currency's own exponent", () => {
    expect(
      formatExactMoney(
        { minorUnits: 123456, currency: "USD", exponent: 2 },
        "en-US",
      ),
    ).toBe("$1,234.56");
  });

  it("formats a zero-exponent currency without a fraction", () => {
    expect(
      formatExactMoney(
        { minorUnits: 2999, currency: "JPY", exponent: 0 },
        "en-US",
      ),
    ).toBe("¥2,999");
  });

  it("falls back to an exact unlocalized string on a bad locale", () => {
    const text = formatExactMoney(
      { minorUnits: 1999, currency: "USD", exponent: 2 },
      "not a locale",
    );
    expect(text).toBe("19.99 USD");
  });
});

describe("spend view", () => {
  it("returns null when there is nothing to report", () => {
    expect(
      buildSpendView({
        records: [],
        rates: [],
        homeCurrency: "USD",
        locale: "en-US",
      }),
    ).toBeNull();
  });

  it("returns null when only non-contributing entries exist", () => {
    const view = buildSpendView({
      records: [
        record({
          id: "a",
          serviceName: "Paused",
          minorUnits: 1000,
          currency: "USD",
          exponent: 2,
          lifecycle: { status: "paused", since: "2026-01-01" },
        }),
      ],
      rates: [],
      homeCurrency: "USD",
      locale: "en-US",
    });
    expect(view).toBeNull();
  });

  it("totals single-currency spend with no rates available", () => {
    // The common case, and the one that must work before FX ingestion ships.
    const view = buildSpendView({
      records: [
        record({
          id: "a",
          serviceName: "Streaming",
          minorUnits: 1599,
          currency: "USD",
          exponent: 2,
        }),
        record({
          id: "b",
          serviceName: "Annual tool",
          minorUnits: 12000,
          currency: "USD",
          exponent: 2,
          unit: "year",
        }),
      ],
      rates: [],
      homeCurrency: "USD",
      locale: "en-US",
    });
    expect(view).not.toBeNull();
    // 15.99/mo = 191.88/yr, plus 120.00/yr = 311.88/yr, 25.99/mo
    expect(view!.annualText).toBe("$311.88");
    expect(view!.monthlyText).toBe("$25.99");
    expect(view!.countedCount).toBe(2);
    expect(view!.unconverted).toEqual([]);
  });

  it("names unconvertible entries instead of dropping them", () => {
    const view = buildSpendView({
      records: [
        record({
          id: "usd",
          serviceName: "Local",
          minorUnits: 1000,
          currency: "USD",
          exponent: 2,
        }),
        record({
          id: "jpy",
          serviceName: "Tokyo Service",
          minorUnits: 1500,
          currency: "JPY",
          exponent: 0,
        }),
      ],
      rates: [],
      homeCurrency: "USD",
      locale: "en-US",
    });
    expect(view!.annualText).toBe("$120.00");
    expect(view!.countedCount).toBe(1);
    expect(view!.unconverted).toEqual([
      {
        subscriptionId: "jpy",
        serviceName: "Tokyo Service",
        amountText: "¥1,500",
      },
    ]);
  });

  it("converts foreign amounts once a rate is available", () => {
    const view = buildSpendView({
      records: [
        record({
          id: "jpy",
          serviceName: "Tokyo Service",
          minorUnits: 1500,
          currency: "JPY",
          exponent: 0,
        }),
      ],
      rates: [{ baseCurrency: "USD", quoteCurrency: "JPY", rate: "150" }],
      homeCurrency: "USD",
      locale: "en-US",
    });
    expect(view!.unconverted).toEqual([]);
    expect(view!.annualText).toBe("$120.00");
    expect(view!.monthlyText).toBe("$10.00");
  });

  it("excludes one-time purchases from recurring totals", () => {
    const view = buildSpendView({
      records: [
        record({
          id: "sub",
          serviceName: "Recurring",
          minorUnits: 1000,
          currency: "USD",
          exponent: 2,
        }),
        record({
          id: "once",
          serviceName: "One-off",
          minorUnits: 50000,
          currency: "USD",
          exponent: 2,
          kind: "one_time",
        }),
      ],
      rates: [],
      homeCurrency: "USD",
      locale: "en-US",
    });
    expect(view!.annualText).toBe("$120.00");
    expect(view!.countedCount).toBe(1);
  });

  it("omits the section rather than throwing on an invalid home currency", () => {
    expect(
      buildSpendView({
        records: [
          record({
            id: "a",
            serviceName: "Any",
            minorUnits: 1000,
            currency: "USD",
            exponent: 2,
          }),
        ],
        rates: [],
        homeCurrency: "ZZZ",
        locale: "en-US",
      }),
    ).toBeNull();
  });
});

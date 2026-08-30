import { describe, expect, it } from "vitest";
import { createMoney } from "./money";
import {
  RATE_SCALE_EXPONENT,
  annualOccurrenceFactor,
  annualizeMoney,
  contributesToSpend,
  convertMoney,
  createRateTable,
  parseRate,
  summarizeSpend,
  type SpendSubscription,
} from "./spend";
import type { RecurrenceUnit } from "./recurrence";

const SCALE = 10n ** BigInt(RATE_SCALE_EXPONENT);

const money = (minorUnits: number, currency: string) =>
  createMoney({ minorUnits, currency });

const recurring = (
  id: string,
  minorUnits: number,
  currency: string,
  unit: RecurrenceUnit,
  interval: number,
  lifecycle: SpendSubscription["lifecycle"] = {
    status: "active",
    since: "2026-01-01",
  },
): SpendSubscription => ({
  id,
  kind: "recurring",
  amount: money(minorUnits, currency),
  recurrence: { unit, interval },
  lifecycle,
});

describe("exchange rate parsing", () => {
  it("parses integers, decimals, and the full retained scale", () => {
    expect(parseRate("150")).toBe(150n * SCALE);
    expect(parseRate("1.2345")).toBe(1234500000000n);
    expect(parseRate("0.000000000001")).toBe(1n);
    expect(parseRate("1")).toBe(SCALE);
  });

  it.each(["", "abc", "1e5", "1.2.3", " 1", "1 ", "+1"])(
    "rejects malformed rate %s",
    (rate) => {
      expect(() => parseRate(rate)).toThrow();
    },
  );

  it.each(["0", "0.0", "0.000000000000"])(
    "rejects non-positive rate %s",
    (rate) => {
      expect(() => parseRate(rate)).toThrow();
    },
  );

  it("rejects precision beyond the retained scale rather than truncating", () => {
    expect(() => parseRate("1.0000000000001")).toThrow();
  });
});

describe("currency conversion", () => {
  it("respects a decreasing ISO exponent (USD 2 -> JPY 0)", () => {
    // 19.99 USD at 150 JPY/USD = 2998.5 JPY, rounded half away from zero.
    const converted = convertMoney(money(1999, "USD"), "JPY", parseRate("150"));
    expect(converted).toEqual({
      minorUnits: 2999,
      currency: "JPY",
      exponent: 0,
    });
  });

  it("respects an increasing ISO exponent (JPY 0 -> USD 2)", () => {
    const converted = convertMoney(
      money(3000, "JPY"),
      "USD",
      parseRate("0.006666666667"),
    );
    expect(converted).toEqual({
      minorUnits: 2000,
      currency: "USD",
      exponent: 2,
    });
  });

  it("leaves an amount unchanged at unit rate", () => {
    expect(
      convertMoney(money(1234, "USD"), "USD", parseRate("1")).minorUnits,
    ).toBe(1234);
  });
});

describe("rate table resolution", () => {
  it("resolves the target currency to itself", () => {
    const table = createRateTable([], "EUR");
    expect(table.rateTo("EUR")).toBe(SCALE);
  });

  it("resolves a direct quote", () => {
    const table = createRateTable(
      [{ baseCurrency: "USD", quoteCurrency: "EUR", rate: "0.9" }],
      "EUR",
    );
    expect(table.rateTo("USD")).toBe(parseRate("0.9"));
  });

  it("resolves an inverted quote", () => {
    const table = createRateTable(
      [{ baseCurrency: "EUR", quoteCurrency: "USD", rate: "1.25" }],
      "EUR",
    );
    expect(table.rateTo("USD")).toBe(parseRate("0.8"));
  });

  it("pivots through a shared base currency", () => {
    // Reference feeds publish only BASE->X, so converting between two
    // non-base currencies must go through that base.
    const table = createRateTable(
      [
        { baseCurrency: "EUR", quoteCurrency: "USD", rate: "1.10" },
        { baseCurrency: "EUR", quoteCurrency: "INR", rate: "99.00" },
      ],
      "INR",
    );
    const rate = table.rateTo("USD");
    expect(rate).not.toBeNull();
    // Exactly 99/1.10 = 90. Composing two fixed-point rates rounds the
    // intermediate inverse, so allow drift far below one minor unit.
    const exact = 90n * SCALE;
    const drift = rate! > exact ? rate! - exact : exact - rate!;
    expect(drift < 1000n).toBe(true);
  });

  it("returns null when no conversion path exists", () => {
    const table = createRateTable(
      [{ baseCurrency: "EUR", quoteCurrency: "USD", rate: "1.10" }],
      "JPY",
    );
    expect(table.rateTo("USD")).toBeNull();
  });
});

describe("cadence normalization", () => {
  it("annualizes using the documented 365-day convention", () => {
    expect(annualOccurrenceFactor({ unit: "day", interval: 1 })).toEqual({
      numerator: 365n,
      denominator: 1n,
    });
    expect(annualOccurrenceFactor({ unit: "week", interval: 1 })).toEqual({
      numerator: 365n,
      denominator: 7n,
    });
    expect(annualOccurrenceFactor({ unit: "month", interval: 3 })).toEqual({
      numerator: 12n,
      denominator: 3n,
    });
    expect(annualOccurrenceFactor({ unit: "year", interval: 1 })).toEqual({
      numerator: 1n,
      denominator: 1n,
    });
  });

  it.each([
    ["month", 1, 1000, 12000],
    ["month", 3, 3000, 12000],
    ["month", 6, 6000, 12000],
    ["year", 1, 12000, 12000],
    ["day", 1, 100, 36500],
    // 365/7 * 100 = 5214.285…, rounded half away from zero.
    ["week", 1, 100, 5214],
  ] as const)(
    "annualizes %s interval %i",
    (unit, interval, minorUnits, expected) => {
      expect(
        annualizeMoney(money(minorUnits, "USD"), { unit, interval }).minorUnits,
      ).toBe(expected);
    },
  );
});

describe("spend contribution", () => {
  it.each([
    [{ status: "active", since: "2026-01-01" }, true],
    [{ status: "trial", since: "2026-01-01", trialEndsOn: "2026-02-01" }, true],
    [{ status: "paused", since: "2026-01-01" }, false],
    [
      { status: "canceled", since: "2026-01-01", accessEndsOn: "2026-02-01" },
      false,
    ],
    [{ status: "expired", since: "2026-01-01" }, false],
  ] as const)("treats %o as contributing=%s", (lifecycle, expected) => {
    expect(contributesToSpend(lifecycle)).toBe(expected);
  });
});

describe("spend summary", () => {
  it("totals mixed cadences in the home currency", () => {
    const summary = summarizeSpend({
      homeCurrency: "USD",
      rates: [],
      subscriptions: [
        recurring("a", 1000, "USD", "month", 1),
        recurring("b", 12000, "USD", "year", 1),
      ],
    });
    expect(summary.annual.minorUnits).toBe(24000);
    expect(summary.monthly.minorUnits).toBe(2000);
    expect(summary.countedSubscriptionIds).toEqual(["a", "b"]);
    expect(summary.unconverted).toEqual([]);
  });

  it("excludes non-contributing lifecycles and one-time purchases", () => {
    const summary = summarizeSpend({
      homeCurrency: "USD",
      rates: [],
      subscriptions: [
        recurring("active", 1000, "USD", "month", 1),
        recurring("paused", 9999, "USD", "month", 1, {
          status: "paused",
          since: "2026-01-01",
        }),
        {
          id: "onetime",
          kind: "one_time",
          amount: money(50000, "USD"),
          lifecycle: { status: "active", since: "2026-01-01" },
        },
      ],
    });
    expect(summary.annual.minorUnits).toBe(12000);
    expect(summary.countedSubscriptionIds).toEqual(["active"]);
  });

  it("reports unconvertible amounts instead of silently understating", () => {
    const summary = summarizeSpend({
      homeCurrency: "USD",
      rates: [],
      subscriptions: [
        recurring("usd", 1000, "USD", "month", 1),
        recurring("jpy", 500, "JPY", "month", 1),
      ],
    });
    expect(summary.annual.minorUnits).toBe(12000);
    expect(summary.countedSubscriptionIds).toEqual(["usd"]);
    expect(summary.unconverted).toEqual([
      {
        subscriptionId: "jpy",
        amount: money(500, "JPY"),
        reason: "rate_unavailable",
      },
    ]);
  });

  it("converts across currencies and differing exponents", () => {
    const summary = summarizeSpend({
      homeCurrency: "USD",
      rates: [{ baseCurrency: "USD", quoteCurrency: "JPY", rate: "150" }],
      subscriptions: [recurring("jpy", 1500, "JPY", "month", 1)],
    });
    expect(summary.annual).toEqual({
      minorUnits: 12000,
      currency: "USD",
      exponent: 2,
    });
    expect(summary.monthly.minorUnits).toBe(1000);
  });

  it("rejects an unsupported home currency", () => {
    expect(() =>
      summarizeSpend({ homeCurrency: "ZZ", rates: [], subscriptions: [] }),
    ).toThrow();
  });
});

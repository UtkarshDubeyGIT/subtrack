import { describe, expect, it } from "vitest";
import { createMoney, currencyExponent } from "./money";

describe("exact money", () => {
  it("preserves integer minor units without binary floating-point conversion", () => {
    expect(createMoney({ minorUnits: 1099, currency: "USD" })).toEqual({
      minorUnits: 1099,
      currency: "USD",
      exponent: 2,
    });
  });

  it.each([1.1, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    "rejects non-exact minor-unit value %s",
    (minorUnits) => {
      expect(() => createMoney({ minorUnits, currency: "USD" })).toThrow(
        "minorUnits must be a safe integer",
      );
    },
  );

  it("uses explicit ISO currency exponent metadata", () => {
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("KWD")).toBe(3);
  });

  it("covers active ISO currencies across all numeric minor-unit exponents", () => {
    expect(currencyExponent("BIF")).toBe(0);
    expect(currencyExponent("KES")).toBe(2);
    expect(currencyExponent("TND")).toBe(3);
    expect(currencyExponent("CLF")).toBe(4);
  });

  it.each(["usd", "ZZZ", "US", ""])(
    'rejects unsupported currency code "%s"',
    (currency) => {
      expect(() => createMoney({ minorUnits: 100, currency })).toThrow(
        "Unsupported ISO currency",
      );
    },
  );
});

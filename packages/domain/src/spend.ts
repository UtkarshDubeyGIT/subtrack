import {
  createMoney,
  currencyExponent,
  type CurrencyCode,
  type Money,
} from "./money";
import type { RecurrenceRule } from "./recurrence";
import type { LifecycleState } from "./lifecycle";

/**
 * Normalized spend reporting.
 *
 * Two conventions are fixed here and relied upon by callers:
 *
 * 1. All arithmetic is exact integer arithmetic on `bigint`. Foreign-exchange
 *    rates arrive from the data plane as strings (the column is
 *    `numeric(30, 12)`) precisely so they never pass through a binary float.
 *    Parsing a rate into `number` would silently lose precision at the twelfth
 *    decimal place, so it is never done.
 * 2. A year is exactly 365 days and a week is exactly 7 days. Annualizing a
 *    daily or weekly cost therefore uses 365 and 365/7 respectively, rather
 *    than a mean Gregorian year. This keeps every projection an exact rational
 *    and makes totals reproducible; it is a reporting convention, not a
 *    calendar claim, and it is never used to compute an actual renewal date.
 *
 * Rounding is half-away-from-zero, applied once at the end of each
 * calculation rather than at intermediate steps.
 */

/** Decimal places retained for a scaled exchange rate. Matches `numeric(30, 12)`. */
export const RATE_SCALE_EXPONENT = 12;

const RATE_SCALE = 10n ** BigInt(RATE_SCALE_EXPONENT);

/** A scaled exchange rate: the true rate multiplied by `10 ** RATE_SCALE_EXPONENT`. */
export type ScaledRate = bigint;

export type FxRateInput = Readonly<{
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
}>;

export type SpendSubscription = Readonly<{
  id: string;
  amount: Money;
  lifecycle: LifecycleState;
}> &
  (
    | Readonly<{ kind: "recurring"; recurrence: RecurrenceRule }>
    | Readonly<{ kind: "one_time" }>
  );

export type UnconvertedSpend = Readonly<{
  subscriptionId: string;
  amount: Money;
  reason: "rate_unavailable";
}>;

export type SpendSummary = Readonly<{
  homeCurrency: CurrencyCode;
  /** Recurring cost normalized to one month, in the home currency. */
  monthly: Money;
  /** Recurring cost normalized to one year, in the home currency. */
  annual: Money;
  /** Recurring subscriptions counted toward the totals. */
  countedSubscriptionIds: readonly string[];
  /**
   * Subscriptions excluded because no conversion path to the home currency
   * exists. Callers must surface these rather than presenting the totals as
   * complete.
   */
  unconverted: readonly UnconvertedSpend[];
}>;

/**
 * Divide with half-away-from-zero rounding.
 */
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new Error("denominator must be non-zero");
  }
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * Parse a fixed-point decimal rate string into a scaled `bigint`.
 *
 * Accepts an optional sign, digits, and up to `RATE_SCALE_EXPONENT` decimal
 * places. Rejects exponent notation and any other non-numeric form, because a
 * silently mis-parsed rate would corrupt every total derived from it.
 */
export function parseRate(rate: string): ScaledRate {
  if (typeof rate !== "string") {
    throw new Error("rate must be a string");
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(rate);
  if (!match) {
    throw new Error(`Unsupported rate format: ${rate}`);
  }
  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > RATE_SCALE_EXPONENT) {
    throw new Error(
      `rate exceeds ${RATE_SCALE_EXPONENT} decimal places: ${rate}`,
    );
  }
  const padded = fraction.padEnd(RATE_SCALE_EXPONENT, "0");
  const scaled = BigInt(whole) * RATE_SCALE + BigInt(padded);
  if (scaled <= 0n) {
    throw new Error(`rate must be positive: ${rate}`);
  }
  return sign === "-" ? -scaled : scaled;
}

/** Invert a scaled rate, preserving scale. */
function invertRate(rate: ScaledRate): ScaledRate {
  if (rate <= 0n) {
    throw new Error("rate must be positive");
  }
  return divideRounded(RATE_SCALE * RATE_SCALE, rate);
}

/** Compose two scaled rates (A→B and B→C) into A→C, preserving scale. */
function composeRates(first: ScaledRate, second: ScaledRate): ScaledRate {
  return divideRounded(first * second, RATE_SCALE);
}

/**
 * A resolved set of conversion rates into a single target currency.
 */
export interface RateTable {
  /** Scaled rate converting `from` into the target currency, or null. */
  rateTo(from: string): ScaledRate | null;
}

/**
 * Build a table of conversions into `target`.
 *
 * Resolution order, stopping at the first hit:
 *
 * 1. Identity — the source already is the target.
 * 2. A direct quote (`source → target`).
 * 3. An inverted quote (`target → source`).
 * 4. A single pivot hop (`source → pivot → target`).
 *
 * The pivot hop matters in practice: reference feeds such as the European
 * Central Bank publish every rate against one base currency, so converting
 * between two non-base currencies is only possible through that base.
 */
export function createRateTable(
  rates: readonly FxRateInput[],
  target: string,
): RateTable {
  const targetCurrency = normalizeCurrency(target);
  const direct = new Map<string, ScaledRate>();
  const byBase = new Map<string, Map<string, ScaledRate>>();

  for (const entry of rates) {
    const base = normalizeCurrency(entry.baseCurrency);
    const quote = normalizeCurrency(entry.quoteCurrency);
    if (base === quote) {
      continue;
    }
    const scaled = parseRate(entry.rate);
    if (scaled <= 0n) {
      continue;
    }
    register(byBase, base, quote, scaled);
    register(byBase, quote, base, invertRate(scaled));
    if (quote === targetCurrency) {
      direct.set(base, scaled);
    }
    if (base === targetCurrency) {
      direct.set(quote, invertRate(scaled));
    }
  }

  const resolved = new Map<string, ScaledRate | null>();

  return {
    rateTo(from: string): ScaledRate | null {
      const source = normalizeCurrency(from);
      if (source === targetCurrency) {
        return RATE_SCALE;
      }
      const cached = resolved.get(source);
      if (cached !== undefined) {
        return cached;
      }
      const directRate = direct.get(source) ?? null;
      if (directRate !== null) {
        resolved.set(source, directRate);
        return directRate;
      }
      const pivoted = pivot(byBase, source, targetCurrency);
      resolved.set(source, pivoted);
      return pivoted;
    },
  };
}

function register(
  byBase: Map<string, Map<string, ScaledRate>>,
  base: string,
  quote: string,
  rate: ScaledRate,
): void {
  const existing = byBase.get(base);
  if (existing) {
    if (!existing.has(quote)) {
      existing.set(quote, rate);
    }
    return;
  }
  byBase.set(base, new Map([[quote, rate]]));
}

function pivot(
  byBase: Map<string, Map<string, ScaledRate>>,
  source: string,
  target: string,
): ScaledRate | null {
  const fromSource = byBase.get(source);
  if (!fromSource) {
    return null;
  }
  for (const [intermediate, first] of fromSource) {
    if (intermediate === target) {
      return first;
    }
    const onward = byBase.get(intermediate)?.get(target);
    if (onward !== undefined) {
      return composeRates(first, onward);
    }
  }
  return null;
}

function normalizeCurrency(currency: string): string {
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) {
    throw new Error(`Unsupported ISO currency: ${String(currency)}`);
  }
  return currency.toUpperCase();
}

/**
 * Convert money into `target` using a scaled rate.
 *
 * Handles differing ISO minor-unit exponents, so converting a two-exponent
 * currency such as USD into a zero-exponent currency such as JPY yields whole
 * yen rather than a hundredfold overstatement.
 */
export function convertMoney(
  amount: Money,
  target: string,
  rate: ScaledRate,
): Money {
  const targetCurrency = normalizeCurrency(target);
  const targetExponent = currencyExponent(targetCurrency);
  const sourceExponent = currencyExponent(amount.currency);
  const exponentShift = targetExponent - sourceExponent;

  let numerator = BigInt(amount.minorUnits) * rate;
  let denominator = RATE_SCALE;
  if (exponentShift > 0) {
    numerator *= 10n ** BigInt(exponentShift);
  } else if (exponentShift < 0) {
    denominator *= 10n ** BigInt(-exponentShift);
  }

  const minorUnits = divideRounded(numerator, denominator);
  return createMoney({
    minorUnits: Number(minorUnits),
    currency: targetCurrency,
  });
}

/**
 * Occurrences per year for a recurrence rule, as an exact rational.
 */
export function annualOccurrenceFactor(rule: RecurrenceRule): Readonly<{
  numerator: bigint;
  denominator: bigint;
}> {
  const interval = BigInt(rule.interval);
  if (interval <= 0n) {
    throw new Error("interval must be positive");
  }
  switch (rule.unit) {
    case "day":
      return { numerator: 365n, denominator: interval };
    case "week":
      return { numerator: 365n, denominator: 7n * interval };
    case "month":
      return { numerator: 12n, denominator: interval };
    case "year":
      return { numerator: 1n, denominator: interval };
    default:
      throw new Error(`Unsupported recurrence unit: ${String(rule.unit)}`);
  }
}

/**
 * Annualized cost of a recurring amount, in the same currency.
 */
export function annualizeMoney(amount: Money, rule: RecurrenceRule): Money {
  const { numerator, denominator } = annualOccurrenceFactor(rule);
  const minorUnits = divideRounded(
    BigInt(amount.minorUnits) * numerator,
    denominator,
  );
  return createMoney({
    minorUnits: Number(minorUnits),
    currency: amount.currency,
  });
}

/**
 * Whether a lifecycle state represents cost the user is still committed to.
 *
 * `trial` counts because it renews into a charge, which is exactly what a
 * renewal tracker exists to warn about. `paused`, `canceled`, and `expired`
 * do not.
 */
export function contributesToSpend(lifecycle: LifecycleState): boolean {
  return lifecycle.status === "active" || lifecycle.status === "trial";
}

/**
 * Summarize recurring spend in a single home currency.
 *
 * One-time subscriptions are excluded: they are not recurring cost, and
 * folding them into a monthly figure would misstate it.
 *
 * Subscriptions with no conversion path are excluded from the totals and
 * reported in `unconverted`, so the caller can show which figures are missing
 * instead of presenting a silently understated total.
 */
export function summarizeSpend(input: {
  readonly subscriptions: readonly SpendSubscription[];
  readonly rates: readonly FxRateInput[];
  readonly homeCurrency: string;
}): SpendSummary {
  const homeCurrency = normalizeCurrency(input.homeCurrency);
  const exponent = currencyExponent(homeCurrency);
  const table = createRateTable(input.rates, homeCurrency);

  let annualMinor = 0n;
  const counted: string[] = [];
  const unconverted: UnconvertedSpend[] = [];

  for (const subscription of input.subscriptions) {
    if (subscription.kind !== "recurring") {
      continue;
    }
    if (!contributesToSpend(subscription.lifecycle)) {
      continue;
    }
    const rate = table.rateTo(subscription.amount.currency);
    if (rate === null) {
      unconverted.push({
        subscriptionId: subscription.id,
        amount: subscription.amount,
        reason: "rate_unavailable",
      });
      continue;
    }
    const annualized = annualizeMoney(
      subscription.amount,
      subscription.recurrence,
    );
    const converted = convertMoney(annualized, homeCurrency, rate);
    annualMinor += BigInt(converted.minorUnits);
    counted.push(subscription.id);
  }

  const monthlyMinor = divideRounded(annualMinor, 12n);

  return {
    homeCurrency,
    monthly: {
      minorUnits: Number(monthlyMinor),
      currency: homeCurrency,
      exponent,
    },
    annual: {
      minorUnits: Number(annualMinor),
      currency: homeCurrency,
      exponent,
    },
    countedSubscriptionIds: counted,
    unconverted,
  };
}

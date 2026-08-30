import { summarizeSpend, type FxRateInput } from "@subtrack/domain";
import type { PersistedSubscription } from "@subtrack/data";

/**
 * Presentation model for normalized subscription spend.
 *
 * Formatting keeps the exact-integer discipline used everywhere else: a
 * decimal string is built from the minor-unit integer and handed to
 * `Intl.NumberFormat`, which accepts arbitrary-precision string input. The
 * amount is never converted to a binary float, so a large annual total cannot
 * drift in its final digits.
 */

export type MoneyLike = Readonly<{
  minorUnits: number;
  currency: string;
  exponent: number;
}>;

export type UnconvertedSpendView = Readonly<{
  subscriptionId: string;
  serviceName: string;
  amountText: string;
}>;

export type SpendView = Readonly<{
  homeCurrency: string;
  monthlyText: string;
  annualText: string;
  countedCount: number;
  unconverted: readonly UnconvertedSpendView[];
}>;

/** Build an exact decimal string from an integer minor-unit amount. */
export function exactDecimalString(amount: MoneyLike): string {
  const exponent = amount.exponent;
  const negative = amount.minorUnits < 0;
  const magnitude = BigInt(negative ? -amount.minorUnits : amount.minorUnits);
  const scale = 10n ** BigInt(exponent);
  const whole = magnitude / scale;
  const fraction = magnitude % scale;
  const fractionText =
    exponent === 0 ? "" : `.${fraction.toString().padStart(exponent, "0")}`;
  return `${negative ? "-" : ""}${whole}${fractionText}`;
}

/**
 * Format money for display without passing through a float.
 *
 * Falls back to an unlocalized exact string if the runtime rejects the locale
 * or currency, so a bad preference degrades the presentation rather than
 * throwing inside a render.
 */
export function formatExactMoney(amount: MoneyLike, locale: string): string {
  const value = exactDecimalString(amount);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: amount.currency,
      minimumFractionDigits: amount.exponent,
      maximumFractionDigits: amount.exponent,
    }).format(value);
  } catch {
    return `${value} ${amount.currency}`;
  }
}

/**
 * Derive the spend summary card model.
 *
 * Returns null when there is nothing to report — no recurring commitment and
 * nothing that failed to convert — so the caller can omit the section
 * entirely rather than render an empty zero.
 *
 * Amounts that cannot be converted into the home currency are surfaced
 * individually. Presenting the totals without them would understate the real
 * commitment, which is the one thing a spend summary must not do.
 */
export function buildSpendView(input: {
  readonly records: readonly PersistedSubscription[];
  readonly rates: readonly FxRateInput[];
  readonly homeCurrency: string;
  readonly locale: string;
}): SpendView | null {
  let summary;
  try {
    summary = summarizeSpend({
      subscriptions: input.records.map((record) => record.subscription),
      rates: input.rates,
      homeCurrency: input.homeCurrency,
    });
  } catch {
    // An unsupported home currency is a preference problem, not a render
    // problem. Omit the section rather than breaking the ledger.
    return null;
  }

  if (
    summary.countedSubscriptionIds.length === 0 &&
    summary.unconverted.length === 0
  ) {
    return null;
  }

  const nameById = new Map(
    input.records.map((record) => [
      record.subscription.id,
      record.subscription.serviceName,
    ]),
  );

  return {
    homeCurrency: summary.homeCurrency,
    monthlyText: formatExactMoney(summary.monthly, input.locale),
    annualText: formatExactMoney(summary.annual, input.locale),
    countedCount: summary.countedSubscriptionIds.length,
    unconverted: summary.unconverted.map((entry) => ({
      subscriptionId: entry.subscriptionId,
      serviceName: nameById.get(entry.subscriptionId) ?? entry.subscriptionId,
      amountText: formatExactMoney(entry.amount, input.locale),
    })),
  };
}

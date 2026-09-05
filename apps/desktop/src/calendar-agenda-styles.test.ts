import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const calendarStyles =
  styles.match(
    /\/\* Ticket 06: calendar agenda \*\/[\s\S]*\/\* End Ticket 06 \*\//u,
  )?.[0] ?? "";

describe("calendar agenda styles", () => {
  it("uses the shared functional motion contract without layout animation", () => {
    expect(styles).toContain("--motion-quick: 130ms");
    expect(styles).toContain("--motion-standard: 180ms");
    expect(styles).toContain(
      "--motion-ease-standard: cubic-bezier(0.2, 0, 0, 1)",
    );
    expect(calendarStyles).toMatch(
      /transition:\s*transform var\(--motion-quick\) var\(--motion-ease-standard\),\s*opacity var\(--motion-quick\) var\(--motion-ease-standard\)/u,
    );
    expect(calendarStyles).not.toMatch(
      /transition[^;]*(?:width|height|top|right|bottom|left|grid|margin|padding)/u,
    );
    expect(calendarStyles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition:\s*none !important/u,
    );
  });

  it("carries the selected-day renewal spine from calendar into agenda", () => {
    expect(calendarStyles).toMatch(
      /\.calendar-day\[data-selected="true"\][\s\S]*border-inline-start:\s*0\.15rem solid var\(--cobalt\)/u,
    );
    expect(calendarStyles).toMatch(
      /\.calendar-agenda-panel[\s\S]*border-inline-start:\s*0\.15rem solid var\(--cobalt\)/u,
    );
  });

  it("keeps event distinctions, dense days, and narrow large-text layouts legible", () => {
    for (const kind of [
      "trial_deadline",
      "expected_charge",
      "one_time_purchase",
      "access_expiry",
      "paused",
      "canceled",
      "corrected_charge",
    ]) {
      expect(calendarStyles).toContain(`.event-${kind}`);
    }
    expect(calendarStyles).toContain(".calendar-event-notches small");
    expect(calendarStyles).toMatch(
      /@media \(max-width: 760px\)[\s\S]*\.calendar-month-frame\s*\{[\s\S]*min-width:\s*28rem/u,
    );
    expect(calendarStyles).toMatch(
      /@media \(max-width: 760px\)[\s\S]*\.calendar-range-state\s*\{[\s\S]*grid-template-columns:\s*auto minmax\(0, 1fr\)/u,
    );
    expect(calendarStyles).toMatch(
      /@media \(max-width: 760px\)[\s\S]*\.calendar-range-state button\s*\{[\s\S]*grid-column:\s*2/u,
    );
    expect(calendarStyles).toContain("overflow-wrap: anywhere");
    expect(calendarStyles).toContain(
      "grid-template-columns: minmax(0, 1.55fr) minmax(0, 0.72fr)",
    );
    expect(calendarStyles).toContain(
      "grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr)",
    );
    expect(calendarStyles).toContain("container-type: inline-size");
    expect(calendarStyles).toMatch(
      /@container \(max-width: 52rem\)[\s\S]*\.calendar-agenda-layout\s*\{[\s\S]*grid-template-columns:\s*1fr/u,
    );
  });

  it("gives calendar text and focus indicators at least AA contrast", () => {
    expect(contrastRatio("#20242e", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#626b7a", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#626b7a", "#f8f9fb")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#4262d8", "#ffffff")).toBeGreaterThanOrEqual(3);
    const outsideMonthRule =
      calendarStyles.match(
        /\.calendar-day\[data-outside-month="true"\]\s*\{(?<rule>[^}]*)\}/u,
      )?.groups?.rule ?? "";
    expect(outsideMonthRule).toContain("color: #626b7a");
    expect(outsideMonthRule).not.toContain("opacity:");
    expect(calendarStyles).toMatch(
      /\.calendar-agenda-experience :focus-visible\s*\{[\s\S]*outline-color:\s*var\(--cobalt\)/u,
    );
  });

  it("keeps full ledger names readable when text is enlarged", () => {
    const rowCopyRule =
      styles.match(/\.subscription-row-copy strong\s*\{(?<rule>[^}]*)\}/u)
        ?.groups?.rule ?? "";
    expect(rowCopyRule).toContain("white-space: normal");
    expect(rowCopyRule).toContain("overflow-wrap: anywhere");
    expect(rowCopyRule).not.toContain("text-overflow: ellipsis");
  });

  it("reflows ledger metadata before enlarged text starves service names", () => {
    expect(styles).toMatch(
      /\.ledger-column\s*\{[^}]*container-type:\s*inline-size/,
    );
    expect(styles).toMatch(
      /@container\s*\(max-width:\s*30rem\)[\s\S]*\.subscription-row\s*\{[^}]*grid-template-columns:\s*3\.35rem\s+minmax\(0,\s*1fr\)/u,
    );
  });
});

function contrastRatio(foreground: string, background: string) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort(
    (left, right) => right - left,
  );
  return (lighter! + 0.05) / (darker! + 0.05);
}

function luminance(hex: string) {
  const channels = hex
    .match(/[0-9a-f]{2}/giu)!
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

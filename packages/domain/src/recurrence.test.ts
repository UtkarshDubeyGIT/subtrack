import { describe, expect, it } from "vitest";
import { createRecurrenceRule, projectOccurrences } from "./recurrence";

describe("recurrence rules", () => {
  it.each([
    ["weekly", { unit: "week", interval: 1 }],
    ["monthly", { unit: "month", interval: 1 }],
    ["quarterly", { unit: "month", interval: 3 }],
    ["semiannual", { unit: "month", interval: 6 }],
    ["annual", { unit: "year", interval: 1 }],
  ] as const)(
    "maps %s to its deterministic calendar interval",
    (preset, expected) => {
      expect(createRecurrenceRule(preset)).toEqual(expected);
    },
  );

  it("supports validated every-N-unit rules", () => {
    expect(createRecurrenceRule({ unit: "week", interval: 2 })).toEqual({
      unit: "week",
      interval: 2,
    });
  });

  it("supports custom intervals longer than a preset period", () => {
    expect(createRecurrenceRule({ unit: "month", interval: 18 })).toEqual({
      unit: "month",
      interval: 18,
    });
  });

  it.each([
    { unit: "day", interval: 0 },
    { unit: "month", interval: 1201 },
    { unit: "hour", interval: 1 },
    { unit: "week", interval: 1.5 },
  ])("rejects invalid custom rule $unit/$interval", (rule) => {
    expect(() => createRecurrenceRule(rule as never)).toThrow(
      "Invalid recurrence rule",
    );
  });
});

describe("bounded calendar projections", () => {
  it.each([
    {
      label: "month end",
      anchorDate: "2024-01-31",
      fromDate: "2024-02-01",
      recurrence: createRecurrenceRule("monthly"),
      endDate: "2024-04-30",
      expected: ["2024-02-29", "2024-03-31", "2024-04-30"],
    },
    {
      label: "leap year",
      anchorDate: "2024-02-29",
      fromDate: "2025-01-01",
      recurrence: createRecurrenceRule("annual"),
      endDate: "2028-12-31",
      expected: ["2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"],
    },
    {
      label: "historical custom day",
      anchorDate: "1900-01-01",
      fromDate: "9990-01-01",
      recurrence: createRecurrenceRule({ unit: "day", interval: 1200 }),
      endDate: "9999-12-31",
      expected: ["9992-02-28", "9995-06-12", "9998-09-24"],
    },
    {
      label: "custom 18 month",
      anchorDate: "2024-02-29",
      fromDate: "2026-01-01",
      recurrence: createRecurrenceRule({ unit: "month", interval: 18 }),
      endDate: "2030-12-31",
      expected: ["2027-02-28", "2028-08-29", "2030-02-28"],
    },
    {
      label: "supported maximum boundary",
      anchorDate: "9999-12-31",
      fromDate: "9999-12-31",
      recurrence: createRecurrenceRule("annual"),
      endDate: "9999-12-31",
      expected: ["9999-12-31"],
    },
  ])(
    "matches the portable server recurrence corpus: $label",
    ({ anchorDate, fromDate, recurrence, endDate, expected }) => {
      expect(
        projectOccurrences({
          anchorDate,
          fromDate,
          recurrence,
          endDate,
          maxCount: 10,
          timezone: "UTC",
        }),
      ).toEqual(expected);
    },
  );

  it("preserves a month-end anchor instead of drifting after a short month", () => {
    expect(
      projectOccurrences({
        anchorDate: "2024-01-31",
        recurrence: createRecurrenceRule("monthly"),
        endDate: "2024-04-30",
        maxCount: 12,
        timezone: "America/New_York",
      }),
    ).toEqual(["2024-01-31", "2024-02-29", "2024-03-31", "2024-04-30"]);
  });

  it("clamps leap-day annual billing and returns to the leap-day anchor", () => {
    expect(
      projectOccurrences({
        anchorDate: "2024-02-29",
        recurrence: createRecurrenceRule("annual"),
        endDate: "2028-12-31",
        maxCount: 10,
        timezone: "UTC",
      }),
    ).toEqual([
      "2024-02-29",
      "2025-02-28",
      "2026-02-28",
      "2027-02-28",
      "2028-02-29",
    ]);
  });

  it("keeps weekly billing as calendar dates across a DST boundary", () => {
    expect(
      projectOccurrences({
        anchorDate: "2026-03-01",
        recurrence: createRecurrenceRule("weekly"),
        endDate: "2026-03-22",
        maxCount: 4,
        timezone: "America/New_York",
      }),
    ).toEqual(["2026-03-01", "2026-03-08", "2026-03-15", "2026-03-22"]);
  });

  it("does not rewrite billing dates when the display timezone changes", () => {
    const input = {
      anchorDate: "2026-10-25",
      recurrence: createRecurrenceRule({ unit: "week", interval: 2 }),
      endDate: "2026-12-31",
      maxCount: 4,
    } as const;
    expect(projectOccurrences({ ...input, timezone: "Europe/London" })).toEqual(
      projectOccurrences({ ...input, timezone: "Asia/Kolkata" }),
    );
  });

  it("filters before a requested calendar date while retaining the original anchor", () => {
    expect(
      projectOccurrences({
        anchorDate: "2024-01-31",
        fromDate: "2024-03-01",
        recurrence: createRecurrenceRule("monthly"),
        endDate: "2024-05-31",
        maxCount: 2,
        timezone: "UTC",
      }),
    ).toEqual(["2024-03-31", "2024-04-30"]);
  });

  it("seeks directly into a long-running daily schedule", () => {
    expect(
      projectOccurrences({
        anchorDate: "1990-01-01",
        fromDate: "2026-08-01",
        recurrence: createRecurrenceRule({ unit: "day", interval: 1 }),
        endDate: "2026-08-03",
        maxCount: 3,
        timezone: "UTC",
      }),
    ).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
  });

  it.each([0, 513, 1.5])("rejects unsafe projection bound %s", (maxCount) => {
    expect(() =>
      projectOccurrences({
        anchorDate: "2024-01-01",
        recurrence: createRecurrenceRule("monthly"),
        endDate: "2025-01-01",
        maxCount,
        timezone: "UTC",
      }),
    ).toThrow("maxCount must be an integer between 1 and 512");
  });

  it.each(["2024-02-30", "04/01/2024"])(
    "rejects invalid calendar date %s",
    (anchorDate) => {
      expect(() =>
        projectOccurrences({
          anchorDate,
          recurrence: createRecurrenceRule("monthly"),
          endDate: "2025-01-01",
          maxCount: 2,
          timezone: "UTC",
        }),
      ).toThrow("Invalid calendar date");
    },
  );

  it("rejects an invalid IANA timezone", () => {
    expect(() =>
      projectOccurrences({
        anchorDate: "2024-01-01",
        recurrence: createRecurrenceRule("monthly"),
        endDate: "2025-01-01",
        maxCount: 2,
        timezone: "Moon/Sea_of_Tranquility",
      }),
    ).toThrow("Invalid IANA timezone");
  });
});

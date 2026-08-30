import { recurrenceProjectionFixtures } from "@subtrack/test-fixtures";
import { describe, expect, it } from "vitest";
import { createRecurrenceRule, projectOccurrences } from "./recurrence";

describe("portable recurrence fixture corpus", () => {
  it.each(recurrenceProjectionFixtures)(
    "projects $name deterministically",
    (fixture) => {
      expect(
        projectOccurrences({
          anchorDate: fixture.anchorDate,
          recurrence: createRecurrenceRule(fixture.recurrence),
          endDate: fixture.endDate,
          maxCount: fixture.maxCount,
          timezone: fixture.timezone,
        }),
      ).toEqual(fixture.expected);
    },
  );

  it("contains JSON-only fixtures usable in browser and Edge runtimes", () => {
    expect(JSON.parse(JSON.stringify(recurrenceProjectionFixtures))).toEqual(
      recurrenceProjectionFixtures,
    );
  });
});

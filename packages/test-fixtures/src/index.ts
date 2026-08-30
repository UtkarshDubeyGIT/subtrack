/** JSON-compatible fixtures shared by browser, Node, and Edge-runtime tests. */
export const recurrenceProjectionFixtures = [
  {
    name: "quarterly month-end anchor",
    anchorDate: "2024-01-31",
    recurrence: "quarterly",
    endDate: "2024-10-31",
    maxCount: 4,
    timezone: "UTC",
    expected: ["2024-01-31", "2024-04-30", "2024-07-31", "2024-10-31"],
  },
  {
    name: "semiannual leap crossing",
    anchorDate: "2023-08-31",
    recurrence: "semiannual",
    endDate: "2025-03-01",
    maxCount: 4,
    timezone: "Asia/Kolkata",
    expected: ["2023-08-31", "2024-02-29", "2024-08-31", "2025-02-28"],
  },
  {
    name: "annual leap-day recovery",
    anchorDate: "2024-02-29",
    recurrence: "annual",
    endDate: "2028-12-31",
    maxCount: 5,
    timezone: "Europe/London",
    expected: [
      "2024-02-29",
      "2025-02-28",
      "2026-02-28",
      "2027-02-28",
      "2028-02-29",
    ],
  },
  {
    name: "custom fortnight across DST",
    anchorDate: "2026-03-01",
    recurrence: { unit: "week", interval: 2 },
    endDate: "2026-04-12",
    maxCount: 4,
    timezone: "America/New_York",
    expected: ["2026-03-01", "2026-03-15", "2026-03-29", "2026-04-12"],
  },
  {
    name: "custom every three days",
    anchorDate: "2026-12-28",
    recurrence: { unit: "day", interval: 3 },
    endDate: "2027-01-06",
    maxCount: 4,
    timezone: "Pacific/Auckland",
    expected: ["2026-12-28", "2026-12-31", "2027-01-03", "2027-01-06"],
  },
] as const;

/** Synthetic identities and records for local RLS/repository tests only. */
export const dataPlaneSecurityFixtures = {
  users: {
    a: "user_fixture_local_a",
    b: "user_fixture_local_b",
  },
  subscriptions: {
    a: "sub_fixture_local_a",
    b: "sub_fixture_local_b",
  },
} as const;

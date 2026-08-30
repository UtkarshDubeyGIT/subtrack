export type RecurrenceUnit = "day" | "week" | "month" | "year";
export type RecurrencePreset =
  | "weekly"
  | "monthly"
  | "quarterly"
  | "semiannual"
  | "annual";

export interface RecurrenceRule {
  readonly unit: RecurrenceUnit;
  readonly interval: number;
}

const presets: Readonly<Record<RecurrencePreset, RecurrenceRule>> = {
  weekly: { unit: "week", interval: 1 },
  monthly: { unit: "month", interval: 1 },
  quarterly: { unit: "month", interval: 3 },
  semiannual: { unit: "month", interval: 6 },
  annual: { unit: "year", interval: 1 },
};

const maximumInterval: Readonly<Record<RecurrenceUnit, number>> = {
  day: 1200,
  week: 1200,
  month: 1200,
  year: 1200,
};

export function createRecurrenceRule(
  input:
    | RecurrencePreset
    | { readonly unit: string; readonly interval: number },
): RecurrenceRule {
  if (typeof input === "string") {
    const preset = presets[input];
    if (preset === undefined) throw new Error("Invalid recurrence rule");
    return { ...preset };
  }

  if (
    typeof input !== "object" ||
    input === null ||
    !Object.hasOwn(input, "unit") ||
    !Object.hasOwn(input, "interval") ||
    typeof input.unit !== "string" ||
    typeof input.interval !== "number" ||
    !Object.hasOwn(maximumInterval, input.unit) ||
    !Number.isInteger(input.interval) ||
    input.interval < 1 ||
    input.interval > maximumInterval[input.unit as RecurrenceUnit]
  ) {
    throw new Error("Invalid recurrence rule");
  }
  return { unit: input.unit as RecurrenceUnit, interval: input.interval };
}

interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const calendarDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseCalendarDate(value: string): DateParts {
  if (typeof value !== "string") throw new Error("Invalid calendar date");
  const match = calendarDatePattern.exec(value);
  if (match === null) throw new Error(`Invalid calendar date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1900 ||
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== month - 1 ||
    instant.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return { year, month, day };
}

export function assertTimezone(timezone: string): void {
  if (typeof timezone !== "string" || timezone.length === 0) {
    throw new Error("Invalid IANA timezone");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
}

function formatDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function occurrenceAt(
  anchor: DateParts,
  rule: RecurrenceRule,
  index: number,
): string | null {
  const steps = rule.interval * index;
  if (rule.unit === "day" || rule.unit === "week") {
    const days = steps * (rule.unit === "week" ? 7 : 1);
    const instant = new Date(
      Date.UTC(anchor.year, anchor.month - 1, anchor.day + days),
    );
    if (instant.getUTCFullYear() > 9999) return null;
    return formatDate(instant);
  }

  const months = steps * (rule.unit === "year" ? 12 : 1);
  const absoluteMonth = anchor.year * 12 + anchor.month - 1 + months;
  const year = Math.floor(absoluteMonth / 12);
  if (year > 9999) return null;
  const month = (absoluteMonth % 12) + 1;
  const day = Math.min(anchor.day, daysInMonth(year, month));
  return formatDate(new Date(Date.UTC(year, month - 1, day)));
}

export interface ProjectionInput {
  readonly anchorDate: string;
  readonly recurrence: RecurrenceRule;
  readonly fromDate?: string;
  readonly endDate: string;
  readonly maxCount: number;
  readonly timezone: string;
}

const MAX_COUNT = 512;
const MAX_INITIAL_SEEK_CORRECTIONS = 1;

export type RecurrenceCursorWork = Readonly<{
  seekOperations: number;
  advanceOperations: number;
  datesExamined: number;
}>;

export type RecurrenceCursorStep = Readonly<{
  date: string | null;
  work: RecurrenceCursorWork;
}>;

export interface RecurrenceCursor {
  next(): RecurrenceCursorStep;
}

export function createRecurrenceCursor(
  input: Omit<ProjectionInput, "maxCount">,
): RecurrenceCursor {
  const anchor = parseCalendarDate(input.anchorDate);
  const fromDate = input.fromDate ?? input.anchorDate;
  const from = parseCalendarDate(fromDate);
  parseCalendarDate(input.endDate);
  assertTimezone(input.timezone);
  const recurrence = createRecurrenceRule(input.recurrence);
  let index = firstCandidateIndex(anchor, from, recurrence);
  let first = true;
  let exhausted = false;

  return {
    next() {
      if (exhausted) {
        return {
          date: null,
          work: {
            seekOperations: 0,
            advanceOperations: 0,
            datesExamined: 0,
          },
        };
      }
      let advanceOperations = first ? 0 : 1;
      const seekOperations = first ? 1 : 0;
      let datesExamined = 0;
      let seekCorrections = 0;
      if (!first) index += 1;
      first = false;
      while (true) {
        const occurrence = occurrenceAt(anchor, recurrence, index);
        datesExamined += 1;
        if (occurrence === null || occurrence > input.endDate) {
          exhausted = true;
          return {
            date: null,
            work: {
              seekOperations,
              advanceOperations,
              datesExamined,
            },
          };
        }
        if (occurrence >= fromDate) {
          return {
            date: occurrence,
            work: {
              seekOperations,
              advanceOperations,
              datesExamined,
            },
          };
        }
        seekCorrections += 1;
        if (seekCorrections > MAX_INITIAL_SEEK_CORRECTIONS) {
          throw new Error(
            "Recurrence cursor exceeded direct-seek correction bound",
          );
        }
        index += 1;
        advanceOperations += 1;
      }
    },
  };
}

export function projectOccurrences(input: ProjectionInput): string[] {
  if (
    !Number.isInteger(input.maxCount) ||
    input.maxCount < 1 ||
    input.maxCount > MAX_COUNT
  ) {
    throw new Error("maxCount must be an integer between 1 and 512");
  }
  const cursor = createRecurrenceCursor(input);
  const result: string[] = [];
  while (result.length < input.maxCount) {
    const step = cursor.next();
    if (step.date === null) break;
    result.push(step.date);
  }
  return result;
}

function firstCandidateIndex(
  anchor: DateParts,
  from: DateParts,
  recurrence: RecurrenceRule,
) {
  if (recurrence.unit === "day" || recurrence.unit === "week") {
    const anchorDay = Date.UTC(anchor.year, anchor.month - 1, anchor.day);
    const fromDay = Date.UTC(from.year, from.month - 1, from.day);
    const intervalDays =
      recurrence.interval * (recurrence.unit === "week" ? 7 : 1);
    return Math.max(
      0,
      Math.ceil((fromDay - anchorDay) / (intervalDays * 86_400_000)),
    );
  }
  const monthDifference =
    (from.year - anchor.year) * 12 + (from.month - anchor.month);
  const intervalMonths =
    recurrence.interval * (recurrence.unit === "year" ? 12 : 1);
  return Math.max(0, Math.floor(monthDifference / intervalMonths));
}

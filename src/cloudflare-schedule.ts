export const scheduleTimeZone = "America/New_York";
export const scheduledHours = Object.freeze([7, 9, 11, 13, 15, 17, 19]);
export const hourlyCron = "0 * * * *";

export interface ScheduledSlot {
  key: string;
  localLabel: string;
}

function parseHours(value: string): number[] {
  const hours = value.split(",").map((part) => Number.parseInt(part.trim(), 10));
  if (
    hours.length === 0 ||
    hours.some((hour) => !Number.isInteger(hour) || hour < 0 || hour > 23) ||
    new Set(hours).size !== hours.length
  ) {
    throw new Error("Invalid scheduled hour configuration.");
  }
  return hours;
}

export function scheduledSlot(
  scheduledTime: number,
  timeZone: string,
  configuredHours: string,
): ScheduledSlot | undefined {
  const date = new Date(scheduledTime);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid scheduled time.");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const hour = Number.parseInt(value("hour") ?? "", 10);
  if (!parseHours(configuredHours).includes(hour)) return undefined;

  return {
    key: date.toISOString(),
    localLabel: `${value("year")}-${value("month")}-${value("day")}T${String(hour).padStart(2, "0")}:00[${timeZone}]`,
  };
}

import { describe, expect, it } from "vitest";
import {
  scheduledHours,
  scheduledSlot,
  scheduleTimeZone,
} from "../src/cloudflare-schedule";

const hours = scheduledHours.join(",");

describe("Cloudflare collection schedule", () => {
  it("runs at the seven requested Eastern hours", () => {
    const date = "2026-08-30";
    const expected = new Set(scheduledHours);
    const actual = new Set<number>();
    for (let utcHour = 0; utcHour < 24; utcHour += 1) {
      const time = Date.parse(`${date}T${String(utcHour).padStart(2, "0")}:00:00Z`);
      const slot = scheduledSlot(time, scheduleTimeZone, hours);
      if (slot) {
        const match = slot.localLabel.match(/T(\d{2}):/);
        actual.add(Number(match?.[1]));
      }
    }
    expect(actual).toEqual(expected);
  });

  it("stays at 7 a.m. Eastern across daylight-saving time", () => {
    expect(
      scheduledSlot(Date.parse("2026-01-15T12:00:00Z"), scheduleTimeZone, hours)?.localLabel,
    ).toContain("T07:00");
    expect(
      scheduledSlot(Date.parse("2026-07-15T11:00:00Z"), scheduleTimeZone, hours)?.localLabel,
    ).toContain("T07:00");
  });

  it("skips unconfigured hours and creates deterministic lease keys", () => {
    const skipped = Date.parse("2026-08-30T12:00:00Z");
    expect(scheduledSlot(skipped, scheduleTimeZone, hours)).toBeUndefined();

    const scheduled = Date.parse("2026-08-30T13:00:00Z");
    expect(scheduledSlot(scheduled, scheduleTimeZone, hours)?.key).toBe(
      "2026-08-30T13:00:00.000Z",
    );
  });

  it("rejects invalid schedule configuration", () => {
    expect(() => scheduledSlot(Date.now(), scheduleTimeZone, "7,7")).toThrow(
      "Invalid scheduled hour configuration.",
    );
    expect(() => scheduledSlot(Date.now(), scheduleTimeZone, "25")).toThrow(
      "Invalid scheduled hour configuration.",
    );
  });
});

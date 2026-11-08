/** Number and time words of the stats page. */
import type { UsageStatsSlot, UsageStatsStep } from "../../shared/wire/usage-stats.ts";

export function formatValue(value: number): string {
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

/** The time of a slot start in the harness zone, `MM-DD HH:mm`, or `MM-DD` for a day slot. */
export function slotLabel(slot: UsageStatsSlot, step: UsageStatsStep, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(slot.from));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const day = `${get("month")}-${get("day")}`;
  return step === "day" ? day : `${day} ${get("hour")}:${get("minute")}`;
}

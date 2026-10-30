import type { BackupSchedule } from "./types.ts";
import { HttpError } from "./types.ts";

export function normalizeSchedule(input: Partial<BackupSchedule>): BackupSchedule {
  const frequency = input.frequency === "daily" || input.frequency === "monthly" ? input.frequency : "weekly";
  return {
    frequency,
    scheduleTime: "00:00",
    scheduleTimezone: "Asia/Hong_Kong",
    scheduleWeekday: integer(input.scheduleWeekday, 0, 6, 1),
    scheduleMonthday: integer(input.scheduleMonthday, 1, 31, 1)
  };
}

export function normalizeComplianceRetention(input: {
  complianceRetentionEnabled?: unknown;
  complianceRetentionYears?: unknown;
}) {
  return {
    complianceRetentionEnabled: input.complianceRetentionEnabled === true,
    complianceRetentionYears: integer(input.complianceRetentionYears, 1, 99, 7)
  };
}

export function nextRunAt(schedule: BackupSchedule, after = new Date()) {
  const [hour, minute] = schedule.scheduleTime.split(":").map(Number);
  const current = parts(after, schedule.scheduleTimezone);
  const start = new Date(Date.UTC(current.year, current.month - 1, current.day));
  for (let offset = 0; offset <= 370; offset += 1) {
    const localDate = new Date(start.getTime() + offset * 86_400_000);
    const monthlyTargetDay = Math.min(
      schedule.scheduleMonthday,
      daysInMonth(localDate.getUTCFullYear(), localDate.getUTCMonth() + 1)
    );
    const matches = schedule.frequency === "daily"
      || (schedule.frequency === "weekly" && localDate.getUTCDay() === schedule.scheduleWeekday)
      || (schedule.frequency === "monthly" && localDate.getUTCDate() === monthlyTargetDay);
    if (!matches) continue;
    const target = { year: localDate.getUTCFullYear(), month: localDate.getUTCMonth() + 1, day: localDate.getUTCDate(), hour, minute };
    let epoch = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
    const targetEpoch = epoch;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const actual = parts(new Date(epoch), schedule.scheduleTimezone);
      const delta = targetEpoch - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
      epoch += delta;
      if (!delta) break;
    }
    if (epoch > after.getTime() + 30_000) return new Date(epoch).toISOString();
  }
  throw new HttpError(400, "backup_schedule_out_of_range");
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parts(date: Date, timeZone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute) };
}

function integer(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

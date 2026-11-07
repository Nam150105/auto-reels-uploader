/**
 * Date and Time utilities for Vietnam Timezone (Asia/Ho_Chi_Minh - UTC+7)
 */

export function getVietnamNow(): Date {
  // Return current Date adjusted for calculations
  return new Date();
}

export function padZero(num: number): string {
  return num < 10 ? `0${num}` : `${num}`;
}

/**
 * Format Date object to "YYYY-MM-DD" in Vietnam timezone
 */
export function formatVnDate(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d);
  return parts; // en-CA yields YYYY-MM-DD
}

/**
 * Format Date object to "HH:mm" in Vietnam timezone
 */
export function formatVnTime(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(d);
  return parts; // en-GB yields HH:mm
}

/**
 * Convert YYYY-MM-DD and HH:mm (Asia/Ho_Chi_Minh) to UTC Unix timestamp (seconds)
 */
export function vnDateTimeToUtcSeconds(dateStr: string, timeStr: string): number {
  if (!dateStr || !timeStr) return 0;
  // Parse YYYY-MM-DDTHH:mm:00+07:00
  const isoStr = `${dateStr.trim()}T${timeStr.trim()}:00+07:00`;
  const ms = Date.parse(isoStr);
  if (isNaN(ms)) return 0;
  return Math.floor(ms / 1000);
}

/**
 * Convert UTC Unix timestamp (seconds) to readable VN string: "DD/MM/YYYY HH:mm"
 */
export function formatUtcToVnDisplay(utcSeconds: number | null | undefined): string {
  if (!utcSeconds || utcSeconds <= 0) return "--";
  const d = new Date(utcSeconds * 1000);
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(d);
}

/**
 * Get default next schedule time (+15 minutes from now rounded to next 5 min)
 */
export function getDefaultScheduleTime(): { date: string; time: string } {
  const now = new Date();
  // Add 15 minutes
  now.setMinutes(now.getMinutes() + 15);
  // Round up to nearest 5 minutes
  const mins = now.getMinutes();
  now.setMinutes(Math.ceil(mins / 5) * 5);
  now.setSeconds(0);
  now.setMilliseconds(0);

  return {
    date: formatVnDate(now),
    time: formatVnTime(now)
  };
}

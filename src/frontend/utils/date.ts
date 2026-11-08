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
    hourCycle: "h23"
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

/** Hẹn giờ đăng phải sau thời điểm hiện tại tối thiểu bao nhiêu phút */
export const MIN_SCHEDULE_LEAD_MINUTES = 5;

/**
 * Mốc sớm nhất được phép hẹn: hiện tại + 5 phút, làm tròn LÊN phút kế tiếp (giờ Việt Nam).
 */
export function getEarliestScheduleSlot(leadMinutes = MIN_SCHEDULE_LEAD_MINUTES): {
  date: string;
  time: string;
  utcSeconds: number;
} {
  const ms = Date.now() + leadMinutes * 60 * 1000;
  const roundedMs = Math.ceil(ms / 60000) * 60000;
  const d = new Date(roundedMs);
  return { date: formatVnDate(d), time: formatVnTime(d), utcSeconds: Math.floor(roundedMs / 1000) };
}

/**
 * Kiểm tra ngày giờ (giờ Việt Nam) có hợp lệ để hẹn đăng không (>= hiện tại + 5 phút).
 */
export function isScheduleSlotAllowed(
  dateStr: string,
  timeStr: string,
  leadMinutes = MIN_SCHEDULE_LEAD_MINUTES
): boolean {
  const sec = vnDateTimeToUtcSeconds(dateStr, timeStr);
  if (!sec) return false;
  return sec >= getEarliestScheduleSlot(leadMinutes).utcSeconds;
}

/**
 * Cộng thêm số phút vào một mốc giờ Việt Nam, trả về ngày giờ Việt Nam mới
 * (không phụ thuộc múi giờ của trình duyệt).
 */
export function addMinutesToVnSlot(
  dateStr: string,
  timeStr: string,
  minutes: number
): { date: string; time: string } {
  const sec = vnDateTimeToUtcSeconds(dateStr, timeStr);
  const d = new Date((sec + minutes * 60) * 1000);
  return { date: formatVnDate(d), time: formatVnTime(d) };
}

/**
 * Timezone & Schedule Utilities for Cloudflare Workers
 * Canonical Display Timezone: Asia/Ho_Chi_Minh (UTC+07:00)
 * Canonical Database Storage: UTC Unix Timestamp in seconds (scheduled_at)
 */

export const VN_TIMEZONE = "Asia/Ho_Chi_Minh";
export const VN_OFFSET_SECONDS = 7 * 3600; // +07:00 (25,200 seconds)

export function nowUtcSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Chuyển đổi schedule_date (YYYY-MM-DD) và schedule_time (HH:MM) theo giờ Việt Nam (Asia/Ho_Chi_Minh)
 * sang UTC Unix Timestamp (seconds) để lưu trong cột `scheduled_at` của D1.
 */
export function parseVnScheduleToUtc(
  scheduleDate?: string | null,
  scheduleTime?: string | null
): {
  scheduledAtUtc: number | null;
  isValid: boolean;
  error?: string;
} {
  const dStr = (scheduleDate || "").trim();
  const tStr = (scheduleTime || "").trim();

  if (!dStr && !tStr) {
    return { scheduledAtUtc: null, isValid: true };
  }
  if (!dStr || !tStr) {
    return {
      scheduledAtUtc: null,
      isValid: false,
      error: "Phải nhập đầy đủ cả Ngày đăng (YYYY-MM-DD) và Giờ đăng (HH:MM)."
    };
  }

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dStr);
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(tStr);
  if (!dateMatch || !timeMatch) {
    return {
      scheduledAtUtc: null,
      isValid: false,
      error: `Định dạng lịch hẹn không hợp lệ (${dStr} ${tStr}). Yêu cầu YYYY-MM-DD và HH:MM.`
    };
  }

  const year = parseInt(dateMatch[1], 10);
  const month = parseInt(dateMatch[2], 10);
  const day = parseInt(dateMatch[3], 10);
  const hour = parseInt(timeMatch[1], 10);
  const minute = parseInt(timeMatch[2], 10);
  const second = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return {
      scheduledAtUtc: null,
      isValid: false,
      error: `Giá trị ngày/giờ không hợp lệ (${dStr} ${tStr}).`
    };
  }

  // Kiểm tra ngày thực tế trong tháng (ví dụ 2026-02-30 là không hợp lệ)
  const checkUtcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    checkUtcDate.getUTCFullYear() !== year ||
    checkUtcDate.getUTCMonth() !== month - 1 ||
    checkUtcDate.getUTCDate() !== day
  ) {
    return {
      scheduledAtUtc: null,
      isValid: false,
      error: `Ngày không tồn tại trong lịch (${dStr}).`
    };
  }

  // Giờ người dùng nhập là Asia/Ho_Chi_Minh (UTC+7) -> Trừ 7 tiếng để ra UTC timestamp
  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second) - VN_OFFSET_SECONDS * 1000;
  const scheduledAtUtc = Math.floor(utcMillis / 1000);

  return { scheduledAtUtc, isValid: true };
}

/**
 * Chuyển đổi UTC Unix Timestamp (seconds) sang ngày/giờ hiển thị theo múi giờ Asia/Ho_Chi_Minh (+07:00)
 */
export function formatUtcToVn(utcSeconds: number): {
  schedule_date: string;
  schedule_time: string;
  iso_vn: string;
} {
  const vnMillis = (utcSeconds + VN_OFFSET_SECONDS) * 1000;
  const d = new Date(vnMillis);
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const min = d.getUTCMinutes().toString().padStart(2, "0");
  const ss = d.getUTCSeconds().toString().padStart(2, "0");

  return {
    schedule_date: `${yyyy}-${mm}-${dd}`,
    schedule_time: `${hh}:${min}`,
    iso_vn: `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}+07:00`
  };
}


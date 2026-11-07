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
 * Chuẩn hóa chuỗi giờ nhập vào (hỗ trợ 24h và 12h có SA/CH/AM/PM/sáng/chiều/tối, hoặc dạng 12h16)
 * về chuẩn 24 tiếng "HH:MM".
 * Đồng thời tự động nhận diện buổi Trưa/Chiều (12h-23h) nếu người dùng đặt lịch trong ngày hôm nay
 * nhưng trình duyệt gửi định dạng 12h SA (ví dụ 12:16 SA -> 00:16 khi hiện tại đã là buổi trưa 12:15).
 */
export function normalizeVnTime24h(
  rawTime?: string | null,
  options?: {
    scheduleDate?: string | null;
    referenceNowUtc?: number;
    allowSmartTodayPm?: boolean;
  }
): {
  isValid: boolean;
  normalizedTime: string;
  hour: number;
  minute: number;
  second: number;
  meridiemLabel: "SA" | "CH";
  autoPromotedToPm?: boolean;
} {
  const clean = (rawTime || "").trim();
  if (!clean) {
    return {
      isValid: false,
      normalizedTime: "",
      hour: 0,
      minute: 0,
      second: 0,
      meridiemLabel: "SA"
    };
  }

  // Hỗ trợ: "12:16", "12:16:00", "12:16 SA", "12:16 CH", "2:30 PM", "07:05 AM", "12h16", "2h30 chiều"
  const match =
    /^(\d{1,2})\s*(?::|h|g)\s*(\d{1,2})?(?:\s*:\s*(\d{1,2}))?\s*(sa|ch|am|pm|sáng|sang|trưa|trua|chiều|chieu|tối|toi)?$/i.exec(
      clean
    );
  if (!match) {
    return {
      isValid: false,
      normalizedTime: clean,
      hour: -1,
      minute: -1,
      second: 0,
      meridiemLabel: "SA"
    };
  }

  let hour = parseInt(match[1], 10);
  const minute = match[2] !== undefined && match[2] !== "" ? parseInt(match[2], 10) : 0;
  const second = match[3] !== undefined && match[3] !== "" ? parseInt(match[3], 10) : 0;
  const rawMeridiem = (match[4] || "").trim().toLowerCase();

  if (minute < 0 || minute > 59 || second < 0 || second > 59 || hour < 0 || hour > 23) {
    return {
      isValid: false,
      normalizedTime: clean,
      hour,
      minute,
      second,
      meridiemLabel: "SA"
    };
  }

  const isExplicitPm = /^(ch|pm|trưa|trua|chiều|chieu|tối|toi)$/i.test(rawMeridiem);
  const isExplicitAm = /^(sa|am|sáng|sang)$/i.test(rawMeridiem);

  if (isExplicitPm || isExplicitAm) {
    if (hour > 12) {
      // Người dùng vừa ghi giờ 24h (ví dụ 14:30) vừa kèm CH/PM -> giữ nguyên 14:30
    } else if (isExplicitPm) {
      if (hour >= 1 && hour <= 11) {
        hour += 12;
      }
      // 12:xx CH / PM giữ nguyên là 12:xx (12h trưa)
    } else if (isExplicitAm) {
      if (hour === 12) {
        hour = 0; // 12:xx SA / AM mặc định là 00:xx
      }
    }
  }

  let autoPromotedToPm = false;
  const allowSmartTodayPm = options?.allowSmartTodayPm ?? true;
  const rawDate = (options?.scheduleDate || "").trim();

  if (allowSmartTodayPm && rawDate && hour >= 0 && hour < 12 && !isExplicitPm) {
    let normalizedDate = rawDate;
    const dmyMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(rawDate);
    if (dmyMatch) {
      normalizedDate = `${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}`;
    }
    const ymdMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalizedDate);
    if (ymdMatch) {
      const y = parseInt(ymdMatch[1], 10);
      const m = parseInt(ymdMatch[2], 10);
      const d = parseInt(ymdMatch[3], 10);

      const currentNowUtc = options?.referenceNowUtc ?? nowUtcSeconds();
      const todayVn = formatUtcToVn(currentNowUtc);
      const currentVnHour = parseInt(todayVn.schedule_time.split(":")[0] || "0", 10);

      if (normalizedDate === todayVn.schedule_date) {
        const candidateUtc = Math.floor(
          (Date.UTC(y, m - 1, d, hour, minute, second) - VN_OFFSET_SECONDS * 1000) / 1000
        );
        const afternoonHour = hour + 12;
        const afternoonUtc = Math.floor(
          (Date.UTC(y, m - 1, d, afternoonHour, minute, second) - VN_OFFSET_SECONDS * 1000) / 1000
        );

        // Nếu giờ buổi sáng/đêm (00:xx - 11:xx) hôm nay đã trôi qua, nhưng giờ buổi trưa/chiều (12:xx - 23:xx)
        // vẫn ở tương lai, tự động chuyển sang khung giờ 24h buổi trưa/chiều (12:xx - 23:xx).
        const passedByMoreThanOneMinute = currentNowUtc - candidateUtc >= 60;
        if (
          candidateUtc <= currentNowUtc &&
          afternoonUtc > currentNowUtc &&
          (passedByMoreThanOneMinute || isExplicitAm || currentVnHour >= 12)
        ) {
          hour = afternoonHour;
          autoPromotedToPm = true;
        }
      }
    }
  }

  const hhStr = String(hour).padStart(2, "0");
  const mmStr = String(minute).padStart(2, "0");
  const normalizedTime = `${hhStr}:${mmStr}`;
  const meridiemLabel: "SA" | "CH" = hour >= 12 ? "CH" : "SA";

  return {
    isValid: true,
    normalizedTime,
    hour,
    minute,
    second,
    meridiemLabel,
    autoPromotedToPm
  };
}

/**
 * Chuyển đổi schedule_date (YYYY-MM-DD) và schedule_time (HH:MM 24h hoặc kèm SA/CH/AM/PM) theo giờ Việt Nam (Asia/Ho_Chi_Minh)
 * sang UTC Unix Timestamp (seconds) để lưu trong cột `scheduled_at` của D1.
 * Bắt buộc kiểm tra: Thời gian đặt lịch KHÔNG được nằm trong quá khứ hoặc trùng thời điểm hiện tại.
 */
export function parseVnScheduleToUtc(
  scheduleDate?: string | null,
  scheduleTime?: string | null,
  options?: {
    minLeadSeconds?: number;
    allowPast?: boolean;
    referenceNowUtc?: number;
    requireSchedule?: boolean;
  }
): {
  scheduledAtUtc: number | null;
  normalizedDate?: string;
  normalizedTime?: string;
  isValid: boolean;
  isPast?: boolean;
  missingDate?: boolean;
  missingTime?: boolean;
  fieldErrors?: { schedule_date?: string; schedule_time?: string };
  error?: string;
} {
  let dStr = (scheduleDate || "").trim();
  const tStr = (scheduleTime || "").trim();

  if (!dStr && !tStr) {
    if (options?.requireSchedule) {
      return {
        scheduledAtUtc: null,
        isValid: false,
        missingDate: true,
        missingTime: true,
        fieldErrors: {
          schedule_date: "Vui lòng nhập ngày đăng (YYYY-MM-DD hoặc DD/MM/YYYY).",
          schedule_time: "Vui lòng nhập giờ đăng (HH:MM 24h)."
        },
        error: "Bắt buộc nhập đầy đủ cả Ngày đăng và Giờ đăng (không được để trống)."
      };
    }
    return { scheduledAtUtc: null, normalizedDate: "", normalizedTime: "", isValid: true };
  }
  if (!dStr || !tStr) {
    return {
      scheduledAtUtc: null,
      isValid: false,
      missingDate: !dStr,
      missingTime: !tStr,
      fieldErrors: {
        schedule_date: !dStr ? "Vui lòng nhập ngày đăng (YYYY-MM-DD hoặc DD/MM/YYYY)." : undefined,
        schedule_time: !tStr ? "Vui lòng nhập giờ đăng (HH:MM 24h)." : undefined
      },
      error: "Phải nhập đầy đủ cả Ngày đăng (YYYY-MM-DD) và Giờ đăng (HH:MM 24h) theo giờ Việt Nam."
    };
  }

  // Hỗ trợ chuẩn hóa DD/MM/YYYY sang YYYY-MM-DD nếu người dùng nhập kiểu Việt Nam
  const dmyMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dStr);
  if (dmyMatch) {
    dStr = `${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}`;
  }

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dStr);
  const parsedTime = normalizeVnTime24h(tStr, {
    scheduleDate: dStr,
    referenceNowUtc: options?.referenceNowUtc,
    allowSmartTodayPm: !options?.allowPast
  });

  if (!dateMatch || !parsedTime.isValid) {
    return {
      scheduledAtUtc: null,
      isValid: false,
      error: `Định dạng lịch hẹn không hợp lệ (${dStr} ${tStr}). Yêu cầu YYYY-MM-DD và HH:MM (24 tiếng) theo giờ Việt Nam.`
    };
  }

  const year = parseInt(dateMatch[1], 10);
  const month = parseInt(dateMatch[2], 10);
  const day = parseInt(dateMatch[3], 10);
  const { hour, minute, second, normalizedTime } = parsedTime;

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

  // Giờ người dùng nhập là Asia/Ho_Chi_Minh (UTC+7) -> Trừ 7 tiếng để ra UTC timestamp chuẩn
  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second) - VN_OFFSET_SECONDS * 1000;
  const scheduledAtUtc = Math.floor(utcMillis / 1000);

  // Kiểm tra thời gian đặt lịch so với hiện tại
  if (!options?.allowPast) {
    const currentNowUtc = options?.referenceNowUtc ?? nowUtcSeconds();
    const minLead = options?.minLeadSeconds ?? 60; // tối thiểu 1 phút trong tương lai

    if (scheduledAtUtc <= currentNowUtc) {
      return {
        scheduledAtUtc,
        normalizedDate: dStr,
        normalizedTime,
        isValid: false,
        isPast: true,
        error: `Thời gian đặt lịch (${dStr} ${normalizedTime} giờ VN - 24h) đã qua hoặc trùng với thời điểm hiện tại. Vui lòng chọn thời gian trong tương lai.`
      };
    }

    if (scheduledAtUtc < currentNowUtc + minLead) {
      return {
        scheduledAtUtc,
        normalizedDate: dStr,
        normalizedTime,
        isValid: false,
        isPast: false,
        error: `Thời gian đặt lịch (${dStr} ${normalizedTime} giờ VN - 24h) phải cách thời điểm hiện tại tối thiểu 1 phút.`
      };
    }
  }

  return {
    scheduledAtUtc,
    normalizedDate: dStr,
    normalizedTime,
    isValid: true
  };
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


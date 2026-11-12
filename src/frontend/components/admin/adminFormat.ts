/** Display helpers for the admin screens */

export function timeAgo(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  const diff = Math.max(0, Date.now() - ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "vừa xong";
  if (min < 60) return `${min} phút trước`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} giờ trước`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} ngày trước`;
  return formatDateTime(ms);
}

export function formatDateTime(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

/** expires_at is stored in seconds */
export function formatUnixSeconds(sec: number | null | undefined): string {
  return sec ? formatDateTime(Number(sec) * 1000) : "—";
}

/** Short device label from a User-Agent string, e.g. "Chrome · Windows" */
export function describeDevice(ua: string | null | undefined): string {
  const s = String(ua || "");
  if (!s) return "Không rõ";
  const browser =
    /Edg\//.test(s) ? "Edge" :
    /OPR\/|Opera/.test(s) ? "Opera" :
    /CocCoc/.test(s) ? "Cốc Cốc" :
    /Firefox\//.test(s) ? "Firefox" :
    /Chrome\//.test(s) ? "Chrome" :
    /Safari\//.test(s) ? "Safari" : "Trình duyệt khác";
  const os =
    /Windows/.test(s) ? "Windows" :
    /iPhone|iPad/.test(s) ? "iOS" :
    /Android/.test(s) ? "Android" :
    /Mac OS X/.test(s) ? "macOS" :
    /Linux/.test(s) ? "Linux" : "";
  return os ? `${browser} · ${os}` : browser;
}

export const TASK_STATUS_LABELS: Record<string, string> = {
  pending: "Chờ xử lý",
  scheduled: "Đã hẹn lịch",
  needs_schedule: "Cần đặt lịch",
  queued: "Đang chờ đăng",
  running: "Đang đăng",
  processing: "Đang xử lý",
  success: "Đã đăng",
  published: "Đã đăng",
  failed: "Lỗi",
  canceled: "Đã huỷ"
};

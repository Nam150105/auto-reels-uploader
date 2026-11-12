/**
 * Antigravity API Client for Auto Reels & Page Uploader
 * Interacts directly with Cloudflare Workers backend
 */

import type {
  UserSession,
  FacebookPageRecord,
  FacebookAccount,
  TaskRecord,
  AnalyticsDashboard
} from "@shared/types";

class ApiError extends Error {
  status: number;
  data: any;
  constructor(message: string, status: number, data?: any) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

/** Internal technical terms that must never be shown to users */
const INTERNAL_TERMS = /\b(R2|D1|Cloudflare|Worker|bucket|object[_ ]?key|upload_id|media_id|r2:\/\/|SQL|SQLITE|stack|TypeError|undefined)\b/i;

export function toFriendlyError(message: unknown, status = 0): string {
  const text = String(message || "").trim();
  if (!text || INTERNAL_TERMS.test(text)) {
    if (status === 413) return "The file is too large. Please choose a smaller one.";
    if (status >= 500) return "The service is busy. Please try again in a few minutes.";
    return "Something went wrong. Please try again.";
  }
  return text;
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!headers.has("Content-Type") && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(url, {
    ...options,
    headers,
    credentials: "same-origin"
  });

  if (res.status === 401) {
    // If unauthorized, redirect to login page if not already there
    if (!window.location.pathname.includes("/login")) {
      window.location.href = "/login.html";
    }
  }

  let data: any = {};
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    data = await res.json().catch(() => ({}));
  } else {
    data = { text: await res.text() };
  }

  if (!res.ok) {
    const errorMsg = toFriendlyError(data.detail || data.message || data.error, res.status);
    throw new ApiError(errorMsg, res.status, data);
  }

  return data as T;
}

export const api = {
  // Auth
  async checkAuth(): Promise<UserSession> {
    return request<UserSession>("/api/auth/me");
  },

  async logout(): Promise<void> {
    await request("/api/auth/logout", { method: "POST" });
    window.location.href = "/login.html";
  },

  // Fanpages & Accounts
  async getPages(): Promise<FacebookPageRecord[]> {
    const res = await request<any>("/api/pages");
    return Array.isArray(res) ? res : (res?.pages || []);
  },

  async getAccounts(): Promise<FacebookAccount[]> {
    const res = await request<any>("/api/meta/accounts");
    return Array.isArray(res) ? res : (res?.accounts || []);
  },

  async connectDirectToken(token: string, accountId?: string | null): Promise<any> {
    return request("/api/meta/connect-token", {
      method: "POST",
      body: JSON.stringify({ token, account_id: accountId || undefined })
    });
  },

  async updateAccountToken(accountId: string, token: string): Promise<any> {
    return request(`/api/meta/accounts/${encodeURIComponent(accountId)}/update-token`, {
      method: "POST",
      body: JSON.stringify({ token })
    });
  },

  async deleteAccount(accountId: string): Promise<any> {
    return request(`/api/meta/accounts/${encodeURIComponent(accountId)}`, {
      method: "DELETE"
    });
  },

  async deletePage(facebookPageId: string): Promise<any> {
    return request(`/api/pages/${encodeURIComponent(facebookPageId)}`, { method: "DELETE" });
  },

  async syncPages(): Promise<any> {
    return request("/api/meta/sync-pages", { method: "POST" });
  },

  // Tasks
  async getTasks(params?: {
    status?: string;
    page_id?: string;
    exclude_published?: boolean;
    search?: string;
  }): Promise<{ tasks: TaskRecord[]; total: number }> {
    const q = new URLSearchParams();
    if (params?.status && params.status !== "all") q.set("status", params.status);
    if (params?.page_id) q.set("page_id", params.page_id);
    if (params?.exclude_published) q.set("exclude_published", "true");
    if (params?.search) q.set("search", params.search);

    const qs = q.toString();
    const res = await request<TaskRecord[] | { tasks?: TaskRecord[]; total?: number }>(
      `/api/tasks${qs ? `?${qs}` : ""}`
    );
    const list = Array.isArray(res) ? res : res?.tasks || [];
    return { tasks: list, total: list.length };
  },

  async createTask(payload: {
    facebook_page_ids: string[];
    caption: string;
    media_id?: string;
    video_path?: string;
    publish_mode: "now" | "schedule";
    schedule_date?: string;
    schedule_time?: string;
    comments?: CommentPayload[];
  }): Promise<{ success: boolean; task_ids: number[]; created_count: number; message: string }> {
    return request("/api/tasks", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async createBulkTasks(payload: {
    tasks: Array<{
      facebook_page_ids: string[];
      caption: string;
      media_id?: string;
      video_path?: string;
      schedule_date: string;
      schedule_time: string;
      comments?: CommentPayload[];
    }>;
  }): Promise<{ success: boolean; created_count: number; message: string }> {
    return request("/api/tasks/bulk", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async updateTask(
    taskId: number,
    payload: {
      caption?: string;
      schedule_date?: string;
      schedule_time?: string;
      comment_text?: string;
      comment_delay_minutes?: number;
    }
  ): Promise<any> {
    return request(`/api/tasks/${taskId}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
  },

  async deleteTask(taskId: number, deleteFb = false): Promise<any> {
    return request(`/api/tasks/${taskId}?delete_fb=${deleteFb}`, {
      method: "DELETE"
    });
  },

  async bulkDeleteTasks(taskIds: number[]): Promise<any> {
    return request("/api/tasks/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ task_ids: taskIds })
    });
  },

  async publishTaskNow(taskId: number): Promise<any> {
    return request(`/api/tasks/${taskId}/publish-now`, {
      method: "POST"
    });
  },

  async publishBulkNow(taskIds: number[]): Promise<any> {
    return request("/api/tasks/bulk-publish-now", {
      method: "POST",
      body: JSON.stringify({ task_ids: taskIds })
    });
  },

  async rescheduleBulk(payload: {
    task_ids: number[];
    schedule_date: string;
    schedule_time: string;
    interval_minutes?: number;
  }): Promise<any> {
    return request("/api/tasks/bulk-reschedule", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async retryTaskComment(taskId: number): Promise<any> {
    return request(`/api/tasks/${taskId}/retry-comment`, {
      method: "POST"
    });
  },

  // Video upload (in chunks)
  async uploadVideo(
    file: File,
    onProgress?: (percent: number) => void
  ): Promise<{ media_id: string; original_filename: string; size_bytes: number }> {
    const initRes = await request<{
      media_id: string;
      upload_id?: string | null;
      chunk_size_bytes?: number | null;
      upload_url?: string;
    }>("/api/media/upload-init", {
      method: "POST",
      body: JSON.stringify({
        filename: file.name,
        size_bytes: file.size,
        mime_type: file.type || "video/mp4",
        upload_mode: "multipart"
      })
    });

    const { media_id, upload_id, chunk_size_bytes, upload_url } = initRes;

    const readError = async (res: Response, fallback: string): Promise<string> => {
      const data = await res.json().catch(() => null);
      const raw = data && (data.detail || data.message || data.error);
      return raw ? toFriendlyError(raw, res.status) : fallback;
    };

    // No multipart session (e.g. local dev): upload the whole file in one request
    if (!upload_id) {
      const streamRes = await fetch(upload_url || `/api/media/upload-stream/${encodeURIComponent(media_id)}`, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
        credentials: "same-origin"
      });
      if (!streamRes.ok) {
        throw new Error(await readError(streamRes, "Video upload failed. Please try again."));
      }
      if (onProgress) onProgress(99);
    } else {
      const chunkSize = chunk_size_bytes || 8 * 1024 * 1024;
      const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
      const uploadedParts: Array<{ part_number: number; etag: string }> = [];

      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, file.size);
        const chunkBlob = file.slice(start, end);
        const qs = new URLSearchParams({
          media_id,
          upload_id,
          part_number: String(i + 1)
        });

        const partRes = await fetch(`/api/media/upload-part?${qs.toString()}`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: chunkBlob,
          credentials: "same-origin"
        });

        if (!partRes.ok) {
          throw new Error(await readError(partRes, "Video upload failed. Check your connection and try again."));
        }

        const partData = await partRes.json();
        uploadedParts.push({ part_number: i + 1, etag: partData.etag });

        if (onProgress) {
          const percent = Math.min(Math.round(((i + 1) / totalChunks) * 100), 99);
          onProgress(percent);
        }
      }

      const completeRes = await request<{
        media_id: string;
        original_filename: string;
        size_bytes: number;
      }>("/api/media/upload-complete", {
        method: "POST",
        body: JSON.stringify({
          media_id,
          upload_id,
          parts: uploadedParts
        })
      });

      if (onProgress) onProgress(100);
      return completeRes;
    }

    const completeRes = await request<{
      media_id: string;
      original_filename: string;
      size_bytes: number;
    }>("/api/media/upload-complete", {
      method: "POST",
      body: JSON.stringify({ media_id })
    });

    if (onProgress) onProgress(100);
    return completeRes;
  },

  // Comment image (one request, max 8 MB)
  async uploadCommentImage(file: File): Promise<{ media_id: string; filename: string }> {
    const res = await fetch("/api/media/upload-image", {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-File-Name": encodeURIComponent(file.name || "image")
      },
      body: file,
      credentials: "same-origin"
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.media_id) {
      const raw = data && (data.detail || data.message || data.error);
      throw new Error(raw ? toFriendlyError(raw, res.status) : "Image upload failed. Please try again.");
    }
    return { media_id: String(data.media_id), filename: String(data.filename || file.name) };
  },

  // Analytics: stored numbers (synced from Facebook every 3 hours)
  async getAnalytics(days = 28): Promise<AnalyticsDashboard> {
    return request<AnalyticsDashboard>(`/api/insights?days=${days}`);
  },

  // Sync from Facebook now; the next automatic sync is 3 hours later
  async syncAnalytics(days = 28): Promise<AnalyticsDashboard> {
    return request<AnalyticsDashboard>("/api/insights/refresh", {
      method: "POST",
      body: JSON.stringify({ days })
    });
  }
};

/** One auto-comment sent to the server */
export interface CommentPayload {
  text: string;
  image_media_id?: string;
  delay_minutes: number;
}

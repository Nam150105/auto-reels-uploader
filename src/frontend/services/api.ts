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
    const errorMsg =
      data.detail || data.message || data.error || `Yêu cầu thất bại (${res.status})`;
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
    return request<{ tasks: TaskRecord[]; total: number }>(`/api/tasks${qs ? `?${qs}` : ""}`);
  },

  async createTask(payload: {
    facebook_page_ids: string[];
    caption: string;
    media_id?: string;
    video_path?: string;
    publish_mode: "now" | "schedule";
    schedule_date?: string;
    schedule_time?: string;
    comment_text?: string;
    comment_delay_minutes?: number;
  }): Promise<{ success: boolean; created_tasks: TaskRecord[]; task_ids: number[]; message: string }> {
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
      comment_text?: string;
      comment_delay_minutes?: number;
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
    return request("/api/tasks/publish-now", {
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
    return request("/api/tasks/reschedule-bulk", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async retryTaskComment(taskId: number): Promise<any> {
    return request(`/api/tasks/${taskId}/retry-comment`, {
      method: "POST"
    });
  },

  // Media / R2 Streaming Upload
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
      return (data && (data.detail || data.message || data.error)) || fallback;
    };

    // Không có phiên multipart (ví dụ môi trường local chưa gắn R2): tải toàn bộ file trong 1 request
    if (!upload_id) {
      const streamRes = await fetch(upload_url || `/api/media/upload-stream/${encodeURIComponent(media_id)}`, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
        credentials: "same-origin"
      });
      if (!streamRes.ok) {
        throw new Error(await readError(streamRes, "Tải video lên thất bại."));
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
          const detail = await readError(partRes, `HTTP ${partRes.status}`);
          throw new Error(`Tải lên phân đoạn ${i + 1}/${totalChunks} thất bại: ${detail}`);
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

  // Analytics
  async getAnalytics(): Promise<AnalyticsDashboard> {
    return request<AnalyticsDashboard>("/api/analytics/reels");
  },

  async syncAnalytics(): Promise<any> {
    return request("/api/analytics/reels/sync", {
      method: "POST"
    });
  }
};

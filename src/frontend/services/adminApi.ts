import { request } from "./api";
import type { ApiEndpoint } from "@shared/apiCatalog";

export interface AdminUserRow {
  id: string;
  username: string;
  email: string | null;
  full_name: string | null;
  role: "admin" | "member";
  is_active: boolean;
  created_at: string;
  updated_at: string | null;
  last_seen_at: number | null;
  last_login_at: string | null;
  active_sessions: number;
  online_sessions: number;
  online: boolean;
  facebook_accounts: number;
  pages: number;
  tasks: number;
}

export interface AdminSession {
  id: string;
  user_id?: string;
  username?: string;
  full_name?: string;
  role?: string;
  ip_address: string | null;
  last_ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: number | null;
  expires_at: number;
  revoked_at: string | null;
  active: boolean;
  online: boolean;
  is_current: boolean;
}

export interface AdminFacebookAccount {
  id: string;
  facebook_user_id: string;
  facebook_user_name: string | null;
  facebook_user_email: string | null;
  status: string;
  token_status: string;
  token_expires_at: string | null;
  connected_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  scopes: string[];
  missing_scopes: string[];
  pages: number;
}

export interface AdminPage {
  facebook_page_id: string;
  page_name: string;
  category: string;
  avatar_url: string;
  status: string;
  token_status: string;
  can_post: boolean;
  is_selected: boolean;
  last_synced_at: string | null;
  tasks: number;
}

export interface AdminUserDetail {
  user: Omit<AdminUserRow, "last_seen_at" | "last_login_at" | "active_sessions" | "online_sessions" | "online" | "facebook_accounts" | "pages" | "tasks">;
  facebook_accounts: AdminFacebookAccount[];
  pages: AdminPage[];
  sessions: AdminSession[];
  tasks_by_status: Record<string, number>;
}

export interface AdminOverview {
  counts: {
    users: number;
    active_users: number;
    admins: number;
    online_users: number;
    active_sessions: number;
    facebook_accounts: number;
    pages: number;
    tasks: number;
  };
  tasks_by_status: Record<string, number>;
  online_sessions: Array<{
    session_id: string;
    user_id: string;
    username: string;
    full_name: string | null;
    role: string;
    last_seen_at: number;
    ip_address: string | null;
    user_agent: string | null;
  }>;
  online_window_minutes: number;
}

export interface UserInput {
  username?: string;
  password?: string;
  full_name?: string;
  email?: string;
  role?: "admin" | "member";
  is_active?: boolean;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body)
});

export const adminApi = {
  overview: () => request<AdminOverview>("/api/admin/overview"),
  users: () => request<{ users: AdminUserRow[] }>("/api/admin/users").then((r) => r.users),
  user: (id: string) => request<AdminUserDetail>(`/api/admin/users/${encodeURIComponent(id)}`),
  createUser: (input: UserInput) =>
    request<{ success: boolean; password?: string }>("/api/admin/users", json("POST", input)),
  updateUser: (id: string, input: UserInput) =>
    request<{ success: boolean }>(`/api/admin/users/${encodeURIComponent(id)}`, json("PUT", input)),
  deleteUser: (id: string) =>
    request<{ success: boolean }>(`/api/admin/users/${encodeURIComponent(id)}`, json("DELETE")),
  setPassword: (id: string, password?: string) =>
    request<{ success: boolean; password?: string; revoked_sessions: number }>(
      `/api/admin/users/${encodeURIComponent(id)}/password`,
      json("POST", { password: password || "" })
    ),
  revokeUserSessions: (id: string) =>
    request<{ revoked_sessions: number }>(`/api/admin/users/${encodeURIComponent(id)}/revoke-sessions`, json("POST", {})),
  sessions: (scope: "online" | "active" | "all") =>
    request<{ sessions: AdminSession[] }>(`/api/admin/sessions?scope=${scope}`).then((r) => r.sessions),
  revokeSession: (id: string) =>
    request<{ revoked: boolean }>(`/api/admin/sessions/${encodeURIComponent(id)}/revoke`, json("POST", {})),
  apiCatalog: () => request<{ endpoints: ApiEndpoint[] }>("/api/admin/api-catalog").then((r) => r.endpoints),
  changeOwnPassword: (currentPassword: string, newPassword: string) =>
    request<{ success: boolean }>(
      "/api/auth/change-password",
      json("POST", { current_password: currentPassword, new_password: newPassword })
    )
};

/**
 * Shared Type Definitions for Auto Reels & Page Uploader
 * Used across Frontend (Vue 3 + Vite) and Backend (Cloudflare Worker)
 */

export type TaskStatus =
  | "pending"
  | "scheduled"
  | "needs_schedule"
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "canceled";

export type PublishMode = "now" | "schedule";

export interface UserSession {
  id: string;
  username: string;
  display_name?: string;
  email?: string;
  role?: string;
  authenticated: boolean;
}

export interface FacebookAccount {
  id: string;
  facebook_user_id: string;
  facebook_user_name: string;
  token_status?: string;
  token_expires_at?: string | null;
  created_at?: string;
}

export interface FacebookPageRecord {
  id: string;
  facebook_page_id: string;
  page_name: string;
  name?: string;
  category?: string;
  avatar_url?: string;
  tasks?: string[];
  can_post: boolean;
  can_analyze?: boolean;
  is_published?: boolean;
  is_selected?: boolean;
  status: string;
  token_status: string;
  connected_account_id?: string | null;
  last_synced_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  pending_count?: number;
  running_count?: number;
  failed_count?: number;
  success_count?: number;
  admin_accounts?: Array<{
    account_id: string;
    facebook_user_id: string;
    facebook_user_name: string;
  }>;
  admin_names?: string[];
  followers_count?: number;
  fan_count?: number;
}

export interface TaskRecord {
  id: number;
  owner_user_id: string;
  facebook_page_id: string | null;
  page_name?: string;
  page_avatar?: string;
  title?: string;
  caption?: string;
  description?: string;
  video_path?: string;
  media_id?: string | null;
  schedule_date?: string;
  schedule_time?: string;
  scheduled_at?: number | null;
  status: TaskStatus;
  publish_status?: string;
  is_locked?: number;
  video_id?: string | null;
  post_id?: string | null;
  permalink_url?: string | null;
  comment_text?: string | null;
  comment_delay_minutes?: number | null;
  comment_status?: string | null;
  comment_id?: string | null;
  comment_log?: string | null;
  published_at?: string | null;
  error_message?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface BulkComposerRow {
  id: string;
  selectedPageIds: string[];
  caption: string;
  mediaFile: File | null;
  mediaFileName?: string;
  mediaPreviewUrl?: string;
  mediaId?: string;
  uploadProgress?: number;
  isUploading?: boolean;
  scheduleDate: string;
  scheduleTime: string;
  commentText: string;
  commentDelayMinutes: number;
  commentDelayOption: string;
  isSubmitting?: boolean;
  status?: "draft" | "queued" | "error";
  errorMessage?: string;
}

export interface SingleComposerState {
  selectedPageIds: string[];
  caption: string;
  mediaFile: File | null;
  mediaFileName: string;
  mediaPreviewUrl: string;
  mediaId: string;
  uploadProgress: number;
  isUploading: boolean;
  publishMode: PublishMode;
  scheduleDate: string;
  scheduleTime: string;
  enableComment: boolean;
  commentText: string;
  commentDelayOption: string;
  commentDelayMinutes: number;
  isSubmitting: boolean;
}

export interface PageAnalyticsComparison {
  page_id: string;
  page_name: string;
  avatar_url: string;
  followers_count: number;
  total_reels: number;
  total_views: number;
  total_reach: number;
  total_likes: number;
  total_comments: number;
  total_shares: number;
  token_status: string;
  can_analyze: boolean;
}

export interface AnalyticsTimeSeriesPoint {
  date: string;
  views: number;
  reach: number;
  interactions: number;
}

export interface AnalyticsDashboard {
  total_pages: number;
  total_followers: number;
  views_7d: number;
  views_30d: number;
  new_follows_30d: number;
  total_reels_published: number;
  total_views: number;
  total_reach: number;
  total_likes: number;
  total_comments: number;
  total_shares: number;
  pages: PageAnalyticsComparison[];
  time_series: AnalyticsTimeSeriesPoint[];
  has_read_insights_permission: boolean;
  last_synced_at?: string | null;
}

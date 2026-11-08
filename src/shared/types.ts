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
  comments?: TaskCommentSummary[];
  published_at?: string | null;
  error_message?: string | null;
  created_at?: string;
  updated_at?: string;
}

/** One auto-comment as returned with a task in the schedule list */
export interface TaskCommentSummary {
  position: number;
  text: string;
  has_image: boolean;
  delay_minutes: number;
  status: "pending" | "scheduled" | "processing" | "success" | "failed";
  error: string;
}

/** One auto-comment being written in the composer (text and/or one image, own delay) */
export interface ComposerComment {
  id: string;
  text: string;
  delayMinutes: number;
  imageMediaId: string;
  imageName: string;
  imagePreviewUrl: string;
  isUploading: boolean;
  uploadError: string;
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
  comments: ComposerComment[];
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

/** Analytics read live from the Meta Graph API. null = Facebook did not return this number. */
export interface LiveDailyPoint {
  date: string;
  views: number | null;
  engagement: number | null;
}

export interface LiveReelItem {
  video_id: string;
  description: string;
  created_time: string;
  permalink_url: string;
}

/** The five numbers shown per Page (and added up for the totals) */
export interface LiveTotals {
  followers: number | null;
  views: number | null;
  views_7d: number | null;
  engagement: number | null;
  reels_count: number | null;
}

export interface LivePageStats extends LiveTotals {
  page_id: string;
  page_name: string;
  avatar_url: string;
  status: "ok" | "partial" | "reconnect" | "error";
  status_message: string;
  views_metric: string | null;
  daily: LiveDailyPoint[];
  reels: LiveReelItem[];
}

export interface AnalyticsDashboard {
  source: "meta_graph_api";
  range_days: number;
  range_start: string;
  range_end: string;
  fetched_at: string;
  cached: boolean;
  total_pages: number;
  totals: LiveTotals;
  pages: LivePageStats[];
  time_series: LiveDailyPoint[];
  warnings: string[];
}

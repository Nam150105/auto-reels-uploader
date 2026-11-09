import type { ComposerComment } from "@shared/types";
import type { CommentPayload } from "../services/api";

export const MAX_COMMENTS = 10;

export const COMMENT_DELAY_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: "Đăng ngay khi xuất bản" },
  { value: 5, label: "Sau 5 phút" },
  { value: 10, label: "Sau 10 phút" },
  { value: 30, label: "Sau 30 phút" },
  { value: 60, label: "Sau 1 giờ" },
  { value: 120, label: "Sau 2 giờ" },
  { value: 360, label: "Sau 6 giờ" },
  { value: 720, label: "Sau 12 giờ" },
  { value: 1440, label: "Sau 24 giờ" },
  { value: 2880, label: "Sau 48 giờ" },
  { value: 4320, label: "Sau 72 giờ" }
];

export function delayLabel(minutes: number): string {
  return COMMENT_DELAY_OPTIONS.find((o) => o.value === minutes)?.label || `Sau ${minutes} phút`;
}

export function createEmptyComment(delayMinutes = 0): ComposerComment {
  return {
    id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    text: "",
    delayMinutes,
    imageMediaId: "",
    imageName: "",
    imagePreviewUrl: "",
    isUploading: false,
    uploadError: ""
  };
}

/** Comments with text or a ready image, in order. Empty rows are dropped. */
export function filledComments(list: ComposerComment[]): ComposerComment[] {
  return list.filter((c) => c.text.trim() || c.imageMediaId);
}

export function toCommentPayload(list: ComposerComment[]): CommentPayload[] {
  return filledComments(list).map((c) => ({
    text: c.text.trim(),
    image_media_id: c.imageMediaId || undefined,
    delay_minutes: c.delayMinutes
  }));
}

/** Returns an error message when comments are not ready to be submitted, otherwise "". */
export function validateComments(list: ComposerComment[]): string {
  if (list.some((c) => c.isUploading)) return "Please wait for comment images to finish uploading.";
  const broken = list.findIndex((c) => !c.imageMediaId && c.uploadError && !c.text.trim());
  if (broken >= 0) return `Comment #${broken + 1}: the image failed to upload. Attach it again or remove it.`;
  if (filledComments(list).length > MAX_COMMENTS) return `You can add up to ${MAX_COMMENTS} comments per post.`;
  return "";
}

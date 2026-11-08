/**
 * Cloudflare R2 Video Storage Service (auto-reels-media)
 * - Streaming upload trực tiếp vào R2 (bucket.put(objectKey, request.body)) không giữ toàn bộ video trong RAM
 * - Kiểm tra chặt chẽ MIME type, phần mở rộng file, giới hạn dung lượng và quyền sở hữu (owner_user_id)
 * - Không lưu video binary lớn trong D1 ở môi trường Production
 */

import type { D1Database, Env, MediaFileRecord, R2Bucket } from "../types.ts";
import {
  createMediaFileInit,
  getMediaFileById,
  completeMediaFileUpload,
  markMediaFileFailed,
  getUserMediaFiles,
  deleteMediaFileRecord,
  ensureTaskCommentsTable
} from "../db.ts";
import { randomHex, bytesToBase64Url, base64UrlToBytes, sha256Hex } from "../utils/crypto.ts";

export const ALLOWED_VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".webm"];
export const ALLOWED_VIDEO_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/x-m4v",
  "video/webm",
  "application/octet-stream"
];

export function getR2Bucket(env: Env): R2Bucket | null {
  return env.MEDIA_BUCKET || env.auto_reels_media || env.VIDEOS_BUCKET || null;
}

/** Kích thước mỗi phân đoạn multipart (R2 yêu cầu >= 5 MiB, các phần trừ phần cuối phải bằng nhau) */
export const MULTIPART_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
export const MULTIPART_MAX_PARTS = 10000;

export function getMaxVideoSizeBytes(env: Env): number {
  const mb = parseInt(env.MAX_VIDEO_SIZE_MB || "200", 10);
  const safeMb = !isNaN(mb) && mb > 0 ? mb : 200;
  return safeMb * 1024 * 1024;
}

export function validateVideoMetadata(
  filename: string,
  sizeBytes: number,
  mimeType: string,
  env: Env
): { valid: boolean; message?: string; normalizedMime: string; sanitizedName: string } {
  const cleanName = (filename || "reel.mp4").trim();
  const lower = cleanName.toLowerCase();
  const hasAllowedExt = ALLOWED_VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
  if (!hasAllowedExt) {
    return {
      valid: false,
      message: `File type '${cleanName}' is not supported. Allowed: ${ALLOWED_VIDEO_EXTENSIONS.join(", ")}.`,
      normalizedMime: "video/mp4",
      sanitizedName: cleanName
    };
  }

  const maxBytes = getMaxVideoSizeBytes(env);
  if (sizeBytes <= 0) {
    return {
      valid: false,
      message: "The video file is empty.",
      normalizedMime: "video/mp4",
      sanitizedName: cleanName
    };
  }
  if (sizeBytes > maxBytes) {
    return {
      valid: false,
      message: `The video (${(sizeBytes / 1048576).toFixed(1)} MB) exceeds the ${(maxBytes / 1048576).toFixed(0)} MB limit.`,
      normalizedMime: "video/mp4",
      sanitizedName: cleanName
    };
  }

  const rawMime = (mimeType || "video/mp4").toLowerCase().split(";")[0].trim();
  if (rawMime && !ALLOWED_VIDEO_MIME_TYPES.includes(rawMime) && !rawMime.startsWith("video/")) {
    return {
      valid: false,
      message: `File type '${rawMime}' is not valid for Reels.`,
      normalizedMime: "video/mp4",
      sanitizedName: cleanName
    };
  }

  const normalizedMime = rawMime.startsWith("video/") ? rawMime : "video/mp4";
  const sanitizedName = cleanName.replace(/[^a-zA-Z0-9._\-]/g, "_").slice(-80);

  return {
    valid: true,
    normalizedMime,
    sanitizedName
  };
}

export async function initiateVideoUpload(
  db: D1Database,
  env: Env,
  ownerUserId: string,
  params: {
    filename: string;
    sizeBytes: number;
    mimeType?: string;
    sha256Checksum?: string | null;
    /** true: tạo phiên R2 multipart để trình duyệt tải lên theo từng phân đoạn */
    multipart?: boolean;
  }
): Promise<{
  success: boolean;
  message?: string;
  media?: MediaFileRecord;
  upload_id?: string | null;
  chunk_size_bytes?: number;
  upload_url?: string;
  complete_url?: string;
  video_path?: string;
}> {
  const check = validateVideoMetadata(
    params.filename,
    params.sizeBytes,
    params.mimeType || "video/mp4",
    env
  );
  if (!check.valid) {
    return { success: false, message: check.message };
  }

  const mediaId = `med_${Date.now()}_${randomHex(6)}`;
  const objectKey = `users/${ownerUserId}/videos/${mediaId}_${check.sanitizedName}`;
  const bucket = getR2Bucket(env);
  const storageBackend = bucket ? "r2" : "d1_fallback";

  let r2UploadId: string | null = null;
  const wantsMultipart = params.multipart === true || params.sizeBytes > 50 * 1024 * 1024;
  if (bucket && bucket.createMultipartUpload && wantsMultipart) {
    try {
      const mp = await bucket.createMultipartUpload(objectKey, {
        httpMetadata: { contentType: check.normalizedMime },
        customMetadata: { ownerUserId, mediaId, originalFilename: check.sanitizedName }
      });
      r2UploadId = mp.uploadId;
    } catch {
      r2UploadId = null;
    }
  }

  const media = await createMediaFileInit(db, {
    id: mediaId,
    ownerUserId,
    objectKey,
    originalFilename: check.sanitizedName,
    mimeType: check.normalizedMime,
    sizeBytes: params.sizeBytes,
    sha256Checksum: params.sha256Checksum || null,
    r2UploadId,
    storageBackend,
    uploadStatus: "pending"
  });

  return {
    success: true,
    media,
    upload_id: r2UploadId,
    chunk_size_bytes: r2UploadId ? MULTIPART_CHUNK_SIZE_BYTES : undefined,
    upload_url: `/api/media/upload-stream/${mediaId}`,
    complete_url: `/api/media/upload-complete`,
    video_path: `r2://${mediaId}`
  };
}

/**
 * Nhận stream binary trực tiếp từ trình duyệt và đẩy thẳng vào R2 (Streaming)
 */
export async function streamVideoToStorage(
  request: Request,
  db: D1Database,
  env: Env,
  mediaId: string,
  ownerUserId: string
): Promise<{ success: boolean; status: number; message?: string; media?: MediaFileRecord }> {
  const media = await getMediaFileById(db, mediaId, ownerUserId);
  if (!media) {
    return {
      success: false,
      status: 404,
      message: "Upload session not found. Please upload the video again."
    };
  }

  const contentLength = parseInt(request.headers.get("Content-Length") || "0", 10);
  const maxBytes = getMaxVideoSizeBytes(env);
  if (contentLength > maxBytes) {
    return {
      success: false,
      status: 413,
      message: `The upload exceeds the ${(maxBytes / 1048576).toFixed(0)} MB limit.`
    };
  }

  const bucket = getR2Bucket(env);
  if (bucket) {
    if (!request.body) {
      await markMediaFileFailed(db, media.id, ownerUserId, "The upload was empty.");
      return { success: false, status: 400, message: "The upload was empty." };
    }
    const r2Obj = await bucket.put(media.object_key, request.body, {
      httpMetadata: { contentType: media.mime_type },
      customMetadata: {
        ownerUserId,
        mediaId: media.id,
        originalFilename: media.original_filename
      }
    });

    const headObj = await bucket.head(media.object_key);
    const finalSize = headObj?.size ?? r2Obj?.size ?? (contentLength || media.size_bytes);
    if ((!headObj && !r2Obj) || finalSize <= 0) {
      await markMediaFileFailed(
        db,
        media.id,
        ownerUserId,
        "The uploaded file could not be verified or is empty."
      );
      return {
        success: false,
        status: 500,
        message: "The video could not be verified after upload. Please upload it again."
      };
    }

    const updated = await completeMediaFileUpload(
      db,
      media.id,
      ownerUserId,
      finalSize,
      headObj?.etag || r2Obj?.etag || media.sha256_checksum,
      "r2",
      "auto-reels-media"
    );
    return { success: true, status: 200, media: updated || media };
  }

  // Fallback chỉ dùng cho môi trường test/local chưa gắn R2 bucket (giới hạn 15MB)
  const buf = await request.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.byteLength === 0) {
    return { success: false, status: 400, message: "The video data is empty." };
  }
  if (bytes.byteLength > 15 * 1024 * 1024) {
    return {
      success: false,
      status: 413,
      message: "Video storage is unavailable right now. Only files up to 15 MB can be uploaded."
    };
  }

  const checksum = await sha256Hex(bytes);
  const b64 = bytesToBase64Url(bytes);
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO media_blobs_fallback (media_id, owner_user_id, data_base64, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(media_id) DO UPDATE SET data_base64 = excluded.data_base64, created_at = excluded.created_at`
    )
    .bind(media.id, ownerUserId, b64, now)
    .run();

  const updated = await completeMediaFileUpload(
    db,
    media.id,
    ownerUserId,
    bytes.byteLength,
    checksum,
    "d1_fallback"
  );

  return { success: true, status: 200, media: updated || media };
}

export async function finalizeVideoUpload(
  db: D1Database,
  env: Env,
  mediaId: string,
  ownerUserId: string
): Promise<{
  success: boolean;
  status: number;
  message?: string;
  media?: MediaFileRecord;
  video_path?: string;
}> {
  const media = await getMediaFileById(db, mediaId, ownerUserId);
  if (!media) {
    return {
      success: false,
      status: 404,
      message: "Video not found."
    };
  }

  const bucket = getR2Bucket(env);
  if (bucket && media.storage_backend === "r2") {
    const headObj = await bucket.head(media.object_key);
    if (!headObj || headObj.size <= 0) {
      await markMediaFileFailed(
        db,
        media.id,
        ownerUserId,
        "The uploaded video file was not found or is empty."
      );
      return {
        success: false,
        status: 400,
        message: "The video file was not found. Please upload it before finishing."
      };
    }
    const updated = await completeMediaFileUpload(
      db,
      media.id,
      ownerUserId,
      headObj.size,
      headObj.etag || media.sha256_checksum,
      "r2",
      "auto-reels-media"
    );
    return {
      success: true,
      status: 200,
      media: updated || media,
      video_path: `r2://${media.id}`
    };
  }

  if (media.upload_status !== "ready") {
    const blobRow = await db
      .prepare("SELECT media_id FROM media_blobs_fallback WHERE media_id = ? AND owner_user_id = ?")
      .bind(media.id, ownerUserId)
      .first<{ media_id: string }>();
    if (!blobRow) {
      return {
        success: false,
        status: 400,
        message: "The video has not finished uploading."
      };
    }
    const updated = await completeMediaFileUpload(db, media.id, ownerUserId);
    return {
      success: true,
      status: 200,
      media: updated || media,
      video_path: `r2://${media.id}`
    };
  }

  return {
    success: true,
    status: 200,
    media,
    video_path: `r2://${media.id}`
  };
}

/**
 * Xác minh bắt buộc trước khi cho phép tạo Task hoặc chạy Publish:
 * - Tìm bản ghi media_files theo media_id, object_key hoặc original_filename
 * - Nếu upload_status !== 'ready', thử finalizeVideoUpload để xác minh
 * - Nếu storage_backend === 'r2' và có bucket, kiểm tra bucket.head(object_key) tồn tại & size > 0
 */
export async function verifyMediaOnR2BeforeTaskOrPublish(
  db: D1Database,
  env: Env,
  videoRefOrMediaId: string,
  ownerUserId: string
): Promise<{
  verified: boolean;
  media?: MediaFileRecord;
  videoPath?: string;
  mediaId?: string;
  objectKey?: string;
  sizeBytes?: number;
  error?: string;
}> {
  const cleanRef = (videoRefOrMediaId || "")
    .trim()
    .replace(/^r2:\/\//, "")
    .replace(/^d1:\/\/video\//, "");

  if (!cleanRef) {
    return {
      verified: false,
      error: "No video selected. Please choose and upload a video first."
    };
  }

  let media = await getMediaFileById(db, cleanRef, ownerUserId);
  if (!media) {
    return {
      verified: false,
      error: "The video has not been uploaded yet. Please wait for the upload to finish before saving or publishing."
    };
  }

  if (media.upload_status !== "ready") {
    const finalized = await finalizeVideoUpload(db, env, media.id, ownerUserId);
    if (!finalized.success || !finalized.media) {
      return {
        verified: false,
        error:
          finalized.message ||
          `Video '${media.original_filename}' has not finished uploading (status=${media.upload_status}). Please upload it again.`
      };
    }
    media = finalized.media;
  }

  const bucket = getR2Bucket(env);
  if (bucket && media.storage_backend === "r2") {
    const headObj = await bucket.head(media.object_key);
    if (!headObj || headObj.size <= 0) {
      return {
        verified: false,
        error: `The video file is no longer available. Please upload it again.`
      };
    }
    return {
      verified: true,
      media,
      videoPath: `r2://${media.id}`,
      mediaId: media.id,
      objectKey: media.object_key,
      sizeBytes: headObj.size || media.size_bytes
    };
  }

  return {
    verified: true,
    media,
    videoPath: `r2://${media.id}`,
    mediaId: media.id,
    objectKey: media.object_key,
    sizeBytes: media.size_bytes
  };
}

/**
 * Đọc dữ liệu video từ R2 (ưu tiên ReadableStream / chunks) gắn với kiểm tra quyền sở hữu ownerUserId
 */
export async function openVideoFromStorage(
  db: D1Database,
  env: Env,
  videoRef: string,
  ownerUserId: string
): Promise<{
  found: boolean;
  media?: MediaFileRecord;
  stream?: ReadableStream<Uint8Array>;
  sizeBytes?: number;
  mimeType?: string;
  getBytes?: () => Promise<Uint8Array>;
  error?: string;
}> {
  const cleanId = videoRef
    .replace(/^r2:\/\//, "")
    .replace(/^d1:\/\/video\//, "")
    .trim();

  let media = await getMediaFileById(db, cleanId, ownerUserId);
  if (!media) {
    return {
      found: false,
      error: "Video not found."
    };
  }

  if (media.upload_status !== "ready") {
    const finalized = await finalizeVideoUpload(db, env, media.id, ownerUserId);
    if (finalized.success && finalized.media) {
      media = finalized.media;
    } else {
      return {
        found: false,
        error: `Video '${media.original_filename}' has not finished uploading (status=${media.upload_status}).`
      };
    }
  }

  const bucket = getR2Bucket(env);
  if (bucket) {
    const obj = await bucket.get(media.object_key);
    if (obj) {
      if ((obj.size || media.size_bytes) <= 0) {
        return {
          found: false,
          error: `The video file is empty. Please upload it again.`
        };
      }
      return {
        found: true,
        media,
        stream: obj.body,
        sizeBytes: obj.size || media.size_bytes,
        mimeType: media.mime_type,
        getBytes: async () => new Uint8Array(await obj.arrayBuffer())
      };
    }
    if (media.storage_backend === "r2") {
      return {
        found: false,
        error: `The video file is no longer available. Please upload it again.`
      };
    }
  }

  const fallbackRow = await db
    .prepare(
      "SELECT data_base64 FROM media_blobs_fallback WHERE media_id = ? AND owner_user_id = ?"
    )
    .bind(media.id, ownerUserId)
    .first<{ data_base64: string }>();

  if (!fallbackRow) {
    return {
      found: false,
      error: "The video file is no longer available. Please upload it again."
    };
  }

  const bytes = base64UrlToBytes(fallbackRow.data_base64);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });

  return {
    found: true,
    media,
    stream,
    sizeBytes: bytes.byteLength,
    mimeType: media.mime_type,
    getBytes: async () => bytes
  };
}

export async function deleteUserVideo(
  db: D1Database,
  env: Env,
  mediaId: string,
  ownerUserId: string
): Promise<{ deleted: boolean; message?: string }> {
  const existing = await getMediaFileById(db, mediaId, ownerUserId);
  if (!existing) {
    return {
      deleted: false,
      message: "Video file not found."
    };
  }

  // Bảo vệ object R2 đang được sử dụng bởi task chờ lịch / đang xử lý
  const activeRef = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM tasks
       WHERE owner_user_id = ?
         AND (media_id = ? OR object_key = ? OR video_path = ?)
         AND status IN ('pending', 'queued', 'processing', 'running')`
    )
    .bind(ownerUserId, existing.id, existing.object_key, `r2://${existing.id}`)
    .first<{ cnt: number }>();

  if (activeRef && Number(activeRef.cnt) > 0) {
    return {
      deleted: false,
      message: `Cannot delete video '${existing.original_filename}' because ${Number(activeRef.cnt)} pending or in-progress post(s) use it.`
    };
  }

  const deletedRecord = await deleteMediaFileRecord(db, existing.id, ownerUserId);
  if (!deletedRecord) {
    return {
      deleted: false,
      message: "Video file not found."
    };
  }

  const bucket = getR2Bucket(env);
  if (bucket && deletedRecord.object_key) {
    try {
      await bucket.delete(deletedRecord.object_key);
    } catch {
      // Ignore R2 delete error if object was already deleted
    }
  }

  return { deleted: true };
}

export async function listUserVideos(
  db: D1Database,
  ownerUserId: string
): Promise<MediaFileRecord[]> {
  return getUserMediaFiles(db, ownerUserId);
}

/**
 * Tự động dọn dẹp các video lưu trữ trên R2 cũ hơn 30 ngày (1 tháng)
 * - Không bao giờ xóa video của các task đang pending / queued / processing / running
 * - Xóa object khỏi Cloudflare R2
 * - Xóa fallback blob nếu có
 * - Cập nhật trạng thái media_files thành 'expired'
 * - Ghi chú vào log của task liên kết để người dùng theo dõi
 */
export async function cleanupExpiredR2Media(
  db: D1Database,
  env: Env,
  maxAgeDays = 30,
  limit = 50
): Promise<{
  checked_at: string;
  expired_count: number;
  deleted_keys: string[];
}> {
  const cutoffTime = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  await ensureTaskCommentsTable(db);

  const { results: expiredMedia } = await db
    .prepare(
      `SELECT m.id, m.owner_user_id, m.object_key, m.original_filename, m.created_at
       FROM media_files m
       WHERE m.created_at < ?
         AND m.upload_status != 'expired'
         AND NOT EXISTS (
           SELECT 1 FROM tasks t
           WHERE t.owner_user_id = m.owner_user_id
             AND (t.media_id = m.id OR t.object_key = m.object_key OR t.video_path = ('r2://' || m.id))
             AND (
               t.status IN ('queued', 'processing', 'running')
               OR (t.status = 'pending' AND t.scheduled_at IS NOT NULL)
             )
         )
         AND NOT EXISTS (
           SELECT 1 FROM task_comments c
           WHERE c.image_media_id = m.id AND c.status IN ('pending', 'scheduled', 'processing')
         )
       ORDER BY m.created_at ASC
       LIMIT ?`
    )
    .bind(cutoffTime, limit)
    .all<{
      id: string;
      owner_user_id: string;
      object_key: string;
      original_filename: string;
      created_at: string;
    }>();

  if (!expiredMedia || expiredMedia.length === 0) {
    return {
      checked_at: new Date().toISOString(),
      expired_count: 0,
      deleted_keys: []
    };
  }

  const bucket = getR2Bucket(env);
  const deletedKeys: string[] = [];
  const nowIso = new Date().toISOString();

  for (const media of expiredMedia) {
    if (bucket && media.object_key) {
      try {
        await bucket.delete(media.object_key);
        deletedKeys.push(media.object_key);
      } catch (err) {
        console.warn(`[R2 Auto-Cleanup] Lỗi xóa key ${media.object_key}:`, err);
      }
    }

    await db
      .prepare(
        `UPDATE media_files
         SET upload_status = 'expired',
             updated_at = ?
         WHERE id = ?`
      )
      .bind(nowIso, media.id)
      .run();

    try {
      await db
        .prepare("DELETE FROM media_blobs_fallback WHERE media_id = ?")
        .bind(media.id)
        .run();
    } catch {}

    try {
      await db
        .prepare(
          `UPDATE tasks
           SET log = CASE
             WHEN log IS NULL OR log = '' THEN '[Video automatically deleted after 30 days]'
             ELSE log || '\n[Video automatically deleted after 30 days]'
           END,
           updated_at = ?
           WHERE media_id = ?`
        )
        .bind(nowIso, media.id)
        .run();
    } catch {}
  }

  return {
    checked_at: nowIso,
    expired_count: expiredMedia.length,
    deleted_keys: deletedKeys
  };
}

/**
 * Nhận 1 phân đoạn (part) của phiên R2 multipart upload và ghi vào R2.
 * Mỗi request chỉ chứa 1 phân đoạn nhỏ (~8 MiB) nên không vượt giới hạn body của Workers.
 */
export async function uploadVideoPart(
  request: Request,
  db: D1Database,
  env: Env,
  params: { mediaId: string; uploadId: string; partNumber: number; ownerUserId: string }
): Promise<{ success: boolean; status: number; message?: string; etag?: string; part_number?: number }> {
  const { mediaId, uploadId, partNumber, ownerUserId } = params;

  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MULTIPART_MAX_PARTS) {
    return { success: false, status: 400, message: "Invalid upload part number (1-10000)." };
  }

  const media = await getMediaFileById(db, mediaId, ownerUserId);
  if (!media || media.id !== mediaId) {
    return {
      success: false,
      status: 404,
      message: "Upload session not found. Please upload the video again."
    };
  }
  if (!media.r2_upload_id || media.r2_upload_id !== uploadId) {
    return { success: false, status: 400, message: "This upload session does not match the video. Please upload it again." };
  }
  if (media.upload_status === "ready") {
    return { success: false, status: 409, message: "This upload is already complete." };
  }

  const bucket = getR2Bucket(env);
  if (!bucket || !bucket.resumeMultipartUpload) {
    return { success: false, status: 500, message: "Large video uploads are not available right now." };
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) {
    return { success: false, status: 400, message: "A video part was empty. Please try again." };
  }
  if (bytes.byteLength > MULTIPART_CHUNK_SIZE_BYTES) {
    return {
      success: false,
      status: 413,
      message: `A video part exceeds the allowed size (${MULTIPART_CHUNK_SIZE_BYTES} bytes).`
    };
  }

  try {
    const mp = bucket.resumeMultipartUpload(media.object_key, uploadId);
    const part = await mp.uploadPart(partNumber, bytes);
    return { success: true, status: 200, etag: part.etag, part_number: part.partNumber };
  } catch (err) {
    return {
      success: false,
      status: 502,
      message: `Could not upload part ${partNumber}: ${(err as Error).message}`
    };
  }
}

/**
 * Ghép các phân đoạn đã tải lên thành object hoàn chỉnh trên R2, sau đó xác minh và đánh dấu 'ready'.
 */
export async function completeMultipartVideoUpload(
  db: D1Database,
  env: Env,
  params: {
    mediaId: string;
    uploadId: string;
    parts: Array<{ part_number?: number; partNumber?: number; etag?: string }>;
    ownerUserId: string;
  }
): Promise<{ success: boolean; status: number; message?: string; media?: MediaFileRecord }> {
  const { mediaId, uploadId, ownerUserId } = params;
  const media = await getMediaFileById(db, mediaId, ownerUserId);
  if (!media || media.id !== mediaId) {
    return {
      success: false,
      status: 404,
      message: "Video not found."
    };
  }
  if (media.upload_status === "ready") {
    return { success: true, status: 200, media };
  }
  if (!media.r2_upload_id || media.r2_upload_id !== uploadId) {
    return { success: false, status: 400, message: "This upload session does not match the video. Please upload it again." };
  }

  const parts = (params.parts || [])
    .map((p) => ({ partNumber: Number(p.part_number ?? p.partNumber), etag: String(p.etag || "") }))
    .filter((p) => Number.isInteger(p.partNumber) && p.partNumber > 0 && p.etag)
    .sort((a, b) => a.partNumber - b.partNumber);
  if (parts.length === 0) {
    return { success: false, status: 400, message: "The list of uploaded video parts is empty or invalid." };
  }

  const bucket = getR2Bucket(env);
  if (!bucket || !bucket.resumeMultipartUpload) {
    return { success: false, status: 500, message: "Large video uploads are not available right now." };
  }

  const mp = bucket.resumeMultipartUpload(media.object_key, uploadId);
  try {
    await mp.complete(parts);
  } catch (err) {
    await markMediaFileFailed(db, media.id, ownerUserId, `Could not combine the video parts: ${(err as Error).message}`);
    return {
      success: false,
      status: 502,
      message: `Could not combine the video parts: ${(err as Error).message}`
    };
  }

  const headObj = await bucket.head(media.object_key);
  const maxBytes = getMaxVideoSizeBytes(env);
  if (!headObj || headObj.size <= 0 || headObj.size > maxBytes) {
    const reason = !headObj || headObj.size <= 0
      ? "The video file was not found after combining its parts. Please upload it again."
      : `The video exceeds the ${(maxBytes / 1048576).toFixed(0)} MB limit.`;
    if (headObj) {
      try { await bucket.delete(media.object_key); } catch {}
    }
    await markMediaFileFailed(db, media.id, ownerUserId, reason);
    return { success: false, status: headObj ? 413 : 500, message: reason };
  }

  const updated = await completeMediaFileUpload(
    db,
    media.id,
    ownerUserId,
    headObj.size,
    headObj.etag || media.sha256_checksum,
    "r2",
    "auto-reels-media"
  );
  return { success: true, status: 200, media: updated || media };
}

// ============================================================================
// Comment images: small photos attached to auto-comments (JPG / PNG / GIF / WEBP)
// ============================================================================

export const MAX_COMMENT_IMAGE_BYTES = 8 * 1024 * 1024;
const COMMENT_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp"
};

function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** Receives the raw image body (one request) and stores it for later use in a comment. */
export async function uploadCommentImage(
  request: Request,
  db: D1Database,
  env: Env,
  ownerUserId: string
): Promise<{ success: boolean; status: number; message?: string; media?: MediaFileRecord }> {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_COMMENT_IMAGE_BYTES) {
    return { success: false, status: 413, message: "Image is too large. The maximum size is 8 MB." };
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) {
    return { success: false, status: 400, message: "The image file is empty." };
  }
  if (bytes.byteLength > MAX_COMMENT_IMAGE_BYTES) {
    return { success: false, status: 413, message: "Image is too large. The maximum size is 8 MB." };
  }

  const mime = sniffImageMime(bytes);
  if (!mime || !COMMENT_IMAGE_TYPES[mime]) {
    return { success: false, status: 400, message: "Unsupported image. Please use JPG, PNG, GIF or WEBP." };
  }
  const ext = COMMENT_IMAGE_TYPES[mime];

  let rawName = "";
  try {
    rawName = decodeURIComponent(request.headers.get("X-File-Name") || "");
  } catch {
    rawName = "";
  }
  const baseName =
    rawName
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "image";
  const filename = `${baseName}.${ext}`;

  const mediaId = `img_${Date.now()}_${randomHex(6)}`;
  const objectKey = `users/${ownerUserId}/comment-images/${mediaId}.${ext}`;
  const checksum = await sha256Hex(bytes);
  const bucket = getR2Bucket(env);

  if (bucket) {
    try {
      await bucket.put(objectKey, bytes, {
        httpMetadata: { contentType: mime },
        customMetadata: { ownerUserId, mediaId, kind: "comment_image" }
      });
    } catch {
      return { success: false, status: 500, message: "Could not save the image. Please try again." };
    }
  } else {
    await db
      .prepare(
        `INSERT INTO media_blobs_fallback (media_id, owner_user_id, data_base64, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(media_id) DO UPDATE SET data_base64 = excluded.data_base64, created_at = excluded.created_at`
      )
      .bind(mediaId, ownerUserId, bytesToBase64Url(bytes), new Date().toISOString())
      .run();
  }

  const media = await createMediaFileInit(db, {
    id: mediaId,
    ownerUserId,
    objectKey,
    originalFilename: filename,
    mimeType: mime,
    sizeBytes: bytes.byteLength,
    sha256Checksum: checksum,
    storageBackend: bucket ? "r2" : "d1_fallback",
    uploadStatus: "ready"
  });
  return { success: true, status: 200, media };
}

/** Loads a stored comment image. Returns null when it is missing or not an image. */
export async function loadCommentImage(
  db: D1Database,
  env: Env,
  mediaId: string,
  ownerUserId: string
): Promise<{ bytes: Uint8Array; mimeType: string; filename: string } | null> {
  const opened = await openVideoFromStorage(db, env, mediaId, ownerUserId);
  if (!opened.found || !opened.media || !opened.getBytes) return null;
  const mimeType = String(opened.media.mime_type || "");
  if (!mimeType.startsWith("image/")) return null;
  const bytes = await opened.getBytes();
  if (!bytes || bytes.byteLength === 0) return null;
  return { bytes, mimeType, filename: opened.media.original_filename || "image.jpg" };
}

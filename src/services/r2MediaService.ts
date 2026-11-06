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
  getUserMediaFiles,
  deleteMediaFileRecord
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
  return env.MEDIA_BUCKET || env.VIDEOS_BUCKET || null;
}

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
      message: `Định dạng file '${cleanName}' không được hỗ trợ. Chỉ chấp nhận: ${ALLOWED_VIDEO_EXTENSIONS.join(", ")}.`,
      normalizedMime: "video/mp4",
      sanitizedName: cleanName
    };
  }

  const maxBytes = getMaxVideoSizeBytes(env);
  if (sizeBytes <= 0) {
    return {
      valid: false,
      message: "File video rỗng (0 bytes).",
      normalizedMime: "video/mp4",
      sanitizedName: cleanName
    };
  }
  if (sizeBytes > maxBytes) {
    return {
      valid: false,
      message: `Dung lượng video (${(sizeBytes / 1048576).toFixed(1)} MB) vượt quá giới hạn cho phép (${(maxBytes / 1048576).toFixed(0)} MB).`,
      normalizedMime: "video/mp4",
      sanitizedName: cleanName
    };
  }

  const rawMime = (mimeType || "video/mp4").toLowerCase().split(";")[0].trim();
  if (rawMime && !ALLOWED_VIDEO_MIME_TYPES.includes(rawMime) && !rawMime.startsWith("video/")) {
    return {
      valid: false,
      message: `MIME type '${rawMime}' không hợp lệ cho video Reels.`,
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
  }
): Promise<{
  success: boolean;
  message?: string;
  media?: MediaFileRecord;
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
  if (bucket && bucket.createMultipartUpload && params.sizeBytes > 50 * 1024 * 1024) {
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
      message: "Không tìm thấy phiên upload media hoặc bạn không có quyền sở hữu."
    };
  }

  const contentLength = parseInt(request.headers.get("Content-Length") || "0", 10);
  const maxBytes = getMaxVideoSizeBytes(env);
  if (contentLength > maxBytes) {
    return {
      success: false,
      status: 413,
      message: `Dung lượng upload vượt quá giới hạn cho phép (${(maxBytes / 1048576).toFixed(0)} MB).`
    };
  }

  const bucket = getR2Bucket(env);
  if (bucket) {
    if (!request.body) {
      return { success: false, status: 400, message: "Request body rỗng." };
    }
    const r2Obj = await bucket.put(media.object_key, request.body, {
      httpMetadata: { contentType: media.mime_type },
      customMetadata: {
        ownerUserId,
        mediaId: media.id,
        originalFilename: media.original_filename
      }
    });

    const finalSize = r2Obj?.size ?? (contentLength || media.size_bytes);
    const updated = await completeMediaFileUpload(
      db,
      media.id,
      ownerUserId,
      finalSize,
      r2Obj?.etag || media.sha256_checksum,
      "r2"
    );
    return { success: true, status: 200, media: updated || media };
  }

  // Fallback chỉ dùng cho môi trường test/local chưa gắn R2 bucket (giới hạn 15MB)
  const buf = await request.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.byteLength === 0) {
    return { success: false, status: 400, message: "Dữ liệu video rỗng." };
  }
  if (bytes.byteLength > 15 * 1024 * 1024) {
    return {
      success: false,
      status: 413,
      message: "Chưa gắn R2 Bucket (MEDIA_BUCKET). Chế độ lưu tạm chỉ hỗ trợ tối đa 15MB."
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
      message: "Không tìm thấy media_id hoặc bạn không có quyền truy cập."
    };
  }

  const bucket = getR2Bucket(env);
  if (bucket && media.storage_backend === "r2") {
    const headObj = await bucket.head(media.object_key);
    if (!headObj) {
      return {
        success: false,
        status: 400,
        message: "Chưa tìm thấy file video trên Cloudflare R2. Vui lòng tải file lên trước khi hoàn tất."
      };
    }
    const updated = await completeMediaFileUpload(
      db,
      media.id,
      ownerUserId,
      headObj.size,
      headObj.etag || media.sha256_checksum,
      "r2"
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
        message: "File video chưa được tải lên thành công."
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

  const media = await getMediaFileById(db, cleanId, ownerUserId);
  if (!media) {
    return {
      found: false,
      error: "Không tìm thấy video trong kho lưu trữ R2 của bạn hoặc bạn không có quyền sở hữu file này."
    };
  }

  if (media.upload_status !== "ready") {
    return {
      found: false,
      error: `Video '${media.original_filename}' chưa hoàn tất quá trình tải lên (status=${media.upload_status}).`
    };
  }

  const bucket = getR2Bucket(env);
  if (bucket && media.storage_backend === "r2") {
    const obj = await bucket.get(media.object_key);
    if (!obj) {
      return {
        found: false,
        error: `Object '${media.object_key}' không còn tồn tại trong Cloudflare R2.`
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

  const fallbackRow = await db
    .prepare(
      "SELECT data_base64 FROM media_blobs_fallback WHERE media_id = ? AND owner_user_id = ?"
    )
    .bind(media.id, ownerUserId)
    .first<{ data_base64: string }>();

  if (!fallbackRow) {
    return {
      found: false,
      error: "Không tìm thấy nội dung binary của video trong bộ nhớ lưu trữ."
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
  const deletedRecord = await deleteMediaFileRecord(db, mediaId, ownerUserId);
  if (!deletedRecord) {
    return {
      deleted: false,
      message: "Không tìm thấy file video hoặc bạn không có quyền xóa file này."
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

  const { results: expiredMedia } = await db
    .prepare(
      `SELECT id, owner_user_id, object_key, original_filename, created_at
       FROM media_files
       WHERE created_at < ? AND upload_status != 'expired'
       ORDER BY created_at ASC
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
             WHEN log IS NULL OR log = '' THEN '[Video R2 đã tự động xóa sau 30 ngày]'
             ELSE log || '\n[Video R2 đã tự động xóa sau 30 ngày]'
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



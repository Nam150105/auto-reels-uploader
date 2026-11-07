/**
 * Cloudflare R2 Media Upload & Management Routes
 * - POST /api/media/upload-init
 * - PUT|POST /api/media/upload-stream/{media_id}
 * - PUT /api/media/upload-part?media_id=&upload_id=&part_number= (R2 multipart, theo phân đoạn)
 * - POST /api/media/upload-complete
 * - GET /api/media
 * - DELETE /api/media/{media_id}
 * - GET /api/media/{media_id}/stream
 * - POST /api/upload/video (Tương thích ngược cho luồng upload 1 bước)
 */

import type { D1Database, Env, UserRecord } from "../types.ts";
import {
  initiateVideoUpload,
  streamVideoToStorage,
  finalizeVideoUpload,
  uploadVideoPart,
  completeMultipartVideoUpload,
  listUserVideos,
  deleteUserVideo,
  openVideoFromStorage
} from "../services/r2MediaService.ts";
import { jsonResponse } from "./responseHelpers.ts";

export async function handleMediaRoutes(
  request: Request,
  url: URL,
  db: D1Database,
  env: Env,
  currentUser: UserRecord
): Promise<Response | null> {
  const pathname = url.pathname;
  const method = request.method.toUpperCase();

  // 1. Khởi tạo phiên upload video lên Cloudflare R2
  if (pathname === "/api/media/upload-init" && method === "POST") {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      const filename = String(body.filename || "reel.mp4").trim();
      const sizeBytes = Number(body.size_bytes || body.size || 0);
      const mimeType = String(body.mime_type || body.content_type || "video/mp4");
      const sha256Checksum = body.sha256_checksum ? String(body.sha256_checksum) : null;
      const multipart = body.upload_mode === "multipart" || body.multipart === true;

      const initRes = await initiateVideoUpload(db, env, currentUser.id, {
        filename,
        sizeBytes,
        mimeType,
        sha256Checksum,
        multipart
      });

      if (!initRes.success || !initRes.media) {
        return jsonResponse({ detail: initRes.message || "Không thể tạo phiên upload." }, 400);
      }

      return jsonResponse({
        success: true,
        media_id: initRes.media.id,
        object_key: initRes.media.object_key,
        upload_id: initRes.upload_id || null,
        chunk_size_bytes: initRes.chunk_size_bytes || null,
        upload_url: initRes.upload_url,
        complete_url: initRes.complete_url,
        video_path: initRes.video_path,
        storage_backend: initRes.media.storage_backend,
        media: initRes.media
      });
    } catch (err) {
      return jsonResponse(
        { detail: `Lỗi khởi tạo upload R2: ${(err as Error).message}` },
        400
      );
    }
  }

  // 2. Truyền trực tiếp luồng binary video vào R2 (Streaming Upload)
  const streamUploadMatch = /^\/api\/media\/upload-stream\/([^/]+)$/.exec(pathname);
  if (streamUploadMatch && (method === "PUT" || method === "POST")) {
    const mediaId = decodeURIComponent(streamUploadMatch[1]);
    const res = await streamVideoToStorage(request, db, env, mediaId, currentUser.id);
    if (!res.success) {
      return jsonResponse({ detail: res.message || "Lỗi tải dữ liệu lên R2." }, res.status);
    }
    return jsonResponse({
      success: true,
      media_id: mediaId,
      video_path: `r2://${mediaId}`,
      media: res.media
    });
  }

  // 2b. Nhận từng phân đoạn của phiên R2 multipart upload
  if (pathname === "/api/media/upload-part" && (method === "PUT" || method === "POST")) {
    const mediaId = (url.searchParams.get("media_id") || "").trim();
    const uploadId = (url.searchParams.get("upload_id") || "").trim();
    const partNumber = Number(url.searchParams.get("part_number"));
    if (!mediaId || !uploadId) {
      return jsonResponse({ detail: "Thiếu tham số media_id hoặc upload_id." }, 400);
    }
    const res = await uploadVideoPart(request, db, env, {
      mediaId,
      uploadId,
      partNumber,
      ownerUserId: currentUser.id
    });
    if (!res.success) {
      return jsonResponse({ detail: res.message || "Lỗi tải phân đoạn lên R2." }, res.status);
    }
    return jsonResponse({ success: true, media_id: mediaId, part_number: res.part_number, etag: res.etag });
  }

  // 3. Xác nhận hoàn tất upload video lên R2
  if (pathname === "/api/media/upload-complete" && method === "POST") {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      const mediaId = String(body.media_id || "").trim();
      if (!mediaId) {
        return jsonResponse({ detail: "Thiếu tham số media_id." }, 400);
      }

      const uploadId = body.upload_id ? String(body.upload_id).trim() : "";
      const finRes =
        uploadId && Array.isArray(body.parts)
          ? await completeMultipartVideoUpload(db, env, {
              mediaId,
              uploadId,
              parts: body.parts as Array<{ part_number?: number; etag?: string }>,
              ownerUserId: currentUser.id
            })
          : await finalizeVideoUpload(db, env, mediaId, currentUser.id);
      if (!finRes.success || !finRes.media) {
        return jsonResponse({ detail: finRes.message || "Chưa hoàn tất upload." }, finRes.status);
      }

      return jsonResponse({
        success: true,
        media_id: finRes.media.id,
        original_filename: finRes.media.original_filename,
        size_bytes: finRes.media.size_bytes,
        object_key: finRes.media.object_key,
        video_path: `r2://${finRes.media.id}`,
        stream_url: `/api/media/${finRes.media.id}/stream`,
        size_mb: Math.round((finRes.media.size_bytes / 1048576) * 100) / 100,
        media: finRes.media
      });
    } catch (err) {
      return jsonResponse({ detail: `Lỗi xác nhận upload: ${(err as Error).message}` }, 400);
    }
  }

  // 4. Danh sách file video trên R2 của người dùng hiện tại
  if (pathname === "/api/media" && method === "GET") {
    const files = await listUserVideos(db, currentUser.id);
    return jsonResponse({
      success: true,
      count: files.length,
      items: files.map((f) => ({
        ...f,
        video_path: `r2://${f.id}`,
        size_mb: Math.round((f.size_bytes / 1048576) * 100) / 100
      }))
    });
  }

  // 5. Xóa file video trên R2 (kiểm tra quyền sở hữu owner_user_id)
  const deleteMediaMatch = /^\/api\/media\/([^/]+)$/.exec(pathname);
  if (deleteMediaMatch && method === "DELETE") {
    const mediaId = decodeURIComponent(deleteMediaMatch[1]);
    const delRes = await deleteUserVideo(db, env, mediaId, currentUser.id);
    if (!delRes.deleted) {
      return jsonResponse({ detail: delRes.message || "Không tìm thấy file video." }, 404);
    }
    return jsonResponse({
      success: true,
      deleted_id: mediaId,
      message: "Đã xóa file video khỏi Cloudflare R2."
    });
  }

  // 6. Stream xem trước video của User hiện tại
  const streamReadMatch = /^\/api\/(?:media\/([^/]+)\/stream|videos\/([^/]+))$/.exec(pathname);
  if (streamReadMatch && method === "GET") {
    const mediaId = decodeURIComponent(streamReadMatch[1] || streamReadMatch[2]);
    const opened = await openVideoFromStorage(db, env, mediaId, currentUser.id);
    if (!opened.found || !opened.stream) {
      return jsonResponse({ detail: opened.error || "Không tìm thấy video." }, 404);
    }
    return new Response(opened.stream, {
      status: 200,
      headers: {
        "Content-Type": opened.mimeType || "video/mp4",
        "Content-Length": String(opened.sizeBytes || 0),
        "Cache-Control": "private, max-age=3600"
      }
    });
  }

  // 7. Endpoint tương thích ngược: POST /api/upload/video (Hỗ trợ multipart/form-data hoặc raw binary)
  if (pathname === "/api/upload/video" && method === "POST") {
    const contentType = request.headers.get("Content-Type") || "";
    let filename = request.headers.get("X-File-Name") || "reel.mp4";
    try {
      filename = decodeURIComponent(filename);
    } catch {
      // keep raw
    }

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const filePart = form.get("file") || form.get("video");
      if (!filePart || typeof filePart === "string") {
        return jsonResponse({ detail: "Vui lòng chọn file video hợp lệ." }, 400);
      }
      const blob = filePart as File;
      filename = blob.name || filename;

      const initRes = await initiateVideoUpload(db, env, currentUser.id, {
        filename,
        sizeBytes: blob.size || 1,
        mimeType: blob.type || "video/mp4"
      });
      if (!initRes.success || !initRes.media) {
        return jsonResponse({ detail: initRes.message || "File không hợp lệ." }, 400);
      }

      const synthReq = new Request(request.url, {
        method: "PUT",
        headers: {
          "Content-Type": blob.type || "video/mp4",
          "Content-Length": String(blob.size)
        },
        body: blob.stream()
      });

      const streamRes = await streamVideoToStorage(
        synthReq,
        db,
        env,
        initRes.media.id,
        currentUser.id
      );
      if (!streamRes.success || !streamRes.media) {
        return jsonResponse({ detail: streamRes.message || "Lỗi lưu video." }, streamRes.status);
      }

      return jsonResponse({
        success: true,
        video_id: streamRes.media.id,
        media_id: streamRes.media.id,
        object_key: streamRes.media.object_key,
        filename: streamRes.media.original_filename,
        size_mb: Math.round((streamRes.media.size_bytes / 1048576) * 100) / 100,
        video_path: `r2://${streamRes.media.id}`,
        stream_url: `/api/media/${streamRes.media.id}/stream`,
        message: `Đã tải lên Cloudflare R2 thành công: ${streamRes.media.original_filename}`
      });
    }

    // Raw binary body
    const contentLen = parseInt(request.headers.get("Content-Length") || "1", 10) || 1;
    const initRes = await initiateVideoUpload(db, env, currentUser.id, {
      filename,
      sizeBytes: contentLen,
      mimeType: contentType || "video/mp4"
    });
    if (!initRes.success || !initRes.media) {
      return jsonResponse({ detail: initRes.message || "File không hợp lệ." }, 400);
    }

    const streamRes = await streamVideoToStorage(
      request,
      db,
      env,
      initRes.media.id,
      currentUser.id
    );
    if (!streamRes.success || !streamRes.media) {
      return jsonResponse({ detail: streamRes.message || "Lỗi lưu video." }, streamRes.status);
    }

    return jsonResponse({
      success: true,
      video_id: streamRes.media.id,
      media_id: streamRes.media.id,
      object_key: streamRes.media.object_key,
      filename: streamRes.media.original_filename,
      size_mb: Math.round((streamRes.media.size_bytes / 1048576) * 100) / 100,
      video_path: `r2://${streamRes.media.id}`,
      stream_url: `/api/media/${streamRes.media.id}/stream`,
      message: `Đã tải lên Cloudflare R2 thành công: ${streamRes.media.original_filename}`
    });
  }

  return null;
}


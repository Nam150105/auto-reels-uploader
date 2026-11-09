<template>
  <div class="h-full flex flex-col lg:flex-row gap-4 p-4 lg:p-6 overflow-y-auto">
    <!-- COLUMN 1: Chọn Kênh đăng -->
    <div class="w-full lg:w-72 bg-white rounded-2xl border border-slate-200/80 p-4 flex flex-col flex-shrink-0 shadow-xs max-h-[85vh]">
      <div class="flex items-center justify-between pb-3 mb-3 border-b border-slate-100">
        <h3 class="font-bold text-sm text-slate-800 flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-blue-500"></span>
          <span>Chọn Kênh đăng</span>
        </h3>
        <span class="text-[11px] font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-lg border border-blue-100">
          {{ selectedPageIds.length }} đã chọn
        </span>
      </div>
      <PagePicker v-model="selectedPageIds" :pages="pages" class="flex-1 min-h-0" />
    </div>

    <!-- COLUMN 2: Soạn nội dung & Media -->
    <div class="flex-1 bg-white rounded-2xl border border-slate-200/80 p-4 lg:p-6 flex flex-col shadow-xs max-h-[85vh] overflow-y-auto">
      <div class="flex items-center justify-between pb-3 border-b border-slate-100 mb-4">
        <div class="flex items-center gap-2">
          <span class="w-2.5 h-2.5 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500"></span>
          <span class="font-bold text-sm text-slate-800">Soạn bài viết Reels</span>
        </div>
        <div class="text-[11px] font-medium text-slate-400">
          Facebook Reels Creator
        </div>
      </div>

      <!-- Caption Textarea -->
      <div class="border border-slate-200/90 rounded-2xl p-3.5 mb-4 bg-slate-50/30 focus-within:bg-white focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100/60 transition">
        <textarea
          v-model="caption"
          rows="4"
          placeholder="Nhập nội dung bài viết (caption)..."
          class="w-full resize-none text-xs sm:text-sm text-slate-800 bg-transparent focus:outline-none placeholder:text-slate-400 leading-relaxed"
        ></textarea>

        <div class="flex items-center justify-end pt-2 border-t border-slate-100 mt-2">
          <span class="text-[11px] text-slate-400 font-mono">{{ caption.length }} ký tự</span>
        </div>
      </div>

      <!-- Video Upload Dropzone -->
      <div class="mb-4">
        <div
          @dragover.prevent="isDragging = true"
          @dragleave.prevent="isDragging = false"
          @drop.prevent="handleFileDrop"
          class="border-2 border-dashed rounded-2xl p-6 text-center transition cursor-pointer relative"
          :class="isDragging ? 'border-blue-500 bg-blue-50/60' : 'border-blue-200/80 hover:border-blue-400 bg-gradient-to-b from-blue-50/20 via-slate-50/20 to-indigo-50/20 hover:from-blue-50/40 hover:to-indigo-50/40'"
          @click="triggerFileInput"
        >
          <input
            ref="fileInputRef"
            type="file"
            accept="video/mp4,video/quicktime,video/x-m4v,video/webm,.mp4,.mov,.m4v,.webm"
            class="hidden"
            @change="handleFileChange"
            @click.stop
          />

          <div v-if="!mediaFile && !mediaPreviewUrl" class="flex flex-col items-center gap-2">
            <div class="w-12 h-12 rounded-2xl bg-gradient-to-tr from-blue-100 to-indigo-100 text-blue-600 flex items-center justify-center shadow-2xs">
              <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <p class="text-xs font-bold text-slate-700">
              Kéo thả video vào đây hoặc <span class="text-blue-600 underline">chọn từ máy tính</span>
            </p>
            <p class="text-[11px] text-slate-400">Định dạng MP4, MOV, WEBM. Video tỷ lệ 9:16 tối ưu cho Reels.</p>
          </div>

          <!-- Video Selected & Upload Status -->
          <div v-else class="flex items-center justify-between p-2">
            <div class="flex items-center gap-3 text-left min-w-0">
              <div
                class="w-10 h-10 rounded-xl text-white flex items-center justify-center font-black text-[10px] flex-shrink-0 shadow-xs"
                :class="uploadError ? 'bg-rose-500' : 'bg-gradient-to-tr from-blue-600 to-indigo-600'"
              >
                {{ fileExtLabel }}
              </div>
              <div class="min-w-0">
                <p class="text-xs font-bold text-slate-800 truncate">{{ mediaFileName || 'video' }}</p>
                <p class="text-[11px] text-slate-500">
                  <span v-if="isUploading" class="text-blue-600 font-semibold">Đang tải lên... {{ uploadProgress }}%</span>
                  <span v-else-if="uploadError" class="text-rose-600 font-semibold">{{ uploadError }} Bấm để chọn lại.</span>
                  <span v-else-if="mediaId" class="text-emerald-600 font-semibold">✓ Video đã sẵn sàng</span>
                </p>
              </div>
            </div>

            <button
              type="button"
              @click.stop="clearMedia"
              class="text-slate-400 hover:text-rose-500 p-2 rounded-xl hover:bg-rose-50 transition"
              title="Xóa video"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>

          <!-- Progress Bar -->
          <div v-if="isUploading" class="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden mt-3">
            <div class="bg-gradient-to-r from-blue-500 to-indigo-600 h-full transition-all duration-200" :style="{ width: `${uploadProgress}%` }"></div>
          </div>
        </div>
      </div>

      <!-- Auto-comments -->
      <div class="border border-purple-100 bg-gradient-to-r from-purple-50/40 via-indigo-50/20 to-blue-50/20 rounded-2xl p-4 mb-4 space-y-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <svg class="w-4 h-4 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <span class="text-xs font-bold text-slate-800">Tự động bình luận sau khi đăng</span>
            <span v-if="filledComments(comments).length" class="text-[11px] font-bold text-purple-600 bg-purple-100/60 px-1.5 py-0.2 rounded-md">({{ filledComments(comments).length }})</span>
          </div>
          <label class="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="enableComment" class="sr-only peer" />
            <div class="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-purple-600"></div>
          </label>
        </div>
        <p v-if="!enableComment" class="text-[11px] text-slate-500">
          Trang sẽ tự động đăng bình luận dưới bài viết Reels theo thời gian hẹn trước.
        </p>
        <div v-else class="pt-2 border-t border-purple-100/60">
          <CommentListEditor v-model="comments" />
        </div>
      </div>

      <!-- Bottom Bar: Publish Mode & Schedule & Submit -->
      <div class="mt-auto pt-4 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-3">
        <!-- Publish mode: now vs schedule -->
        <div class="flex items-center gap-1.5 bg-slate-100/80 p-1 rounded-xl text-xs font-bold">
          <button
            type="button"
            @click="publishMode = 'now'"
            class="px-3 py-1.5 rounded-lg transition"
            :class="publishMode === 'now' ? 'bg-white text-blue-600 shadow-xs' : 'text-slate-600 hover:text-slate-900'"
          >
            Đăng ngay
          </button>
          <button
            type="button"
            @click="switchToSchedule"
            class="px-3 py-1.5 rounded-lg transition"
            :class="publishMode === 'schedule' ? 'bg-white text-blue-600 shadow-xs' : 'text-slate-600 hover:text-slate-900'"
          >
            Hẹn giờ
          </button>
        </div>

        <!-- Schedule Date/Time Trigger Button -->
        <button
          v-if="publishMode === 'schedule'"
          type="button"
          @click="isCalendarOpen = true"
          class="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-amber-200/80 bg-amber-50/80 text-amber-800 hover:bg-amber-100 text-xs font-bold transition shadow-2xs"
        >
          <svg class="w-4 h-4 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span>{{ scheduleDate }} {{ scheduleTime }} (GMT+7)</span>
          <svg class="w-3.5 h-3.5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        <!-- Submit Button -->
        <button
          type="button"
          :disabled="isSubmitting || isUploading || selectedPageIds.length === 0 || !mediaId"
          @click="handleSubmit"
          class="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-50 text-white font-bold text-xs sm:text-sm shadow-md shadow-blue-500/20 transition flex items-center justify-center gap-2"
        >
          <svg v-if="isSubmitting" class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
          </svg>
          <span>{{ isSubmitting ? 'Đang xử lý...' : publishMode === 'now' ? 'Đăng ngay' : 'Lên lịch đăng bài' }}</span>
        </button>
      </div>
    </div>

    <!-- COLUMN 3: Facebook preview -->
    <div class="w-full lg:w-80 flex-shrink-0">
      <FacebookPreview
        :selectedPage="firstSelectedPage"
        :caption="caption"
        :mediaPreviewUrl="mediaPreviewUrl"
        :comments="enableComment ? filledComments(comments) : []"
      />
    </div>

    <!-- Calendar Popover Modal -->
    <CalendarPickerModal
      :isOpen="isCalendarOpen"
      :initialDate="scheduleDate"
      :initialTime="scheduleTime"
      @close="isCalendarOpen = false"
      @confirm="onCalendarConfirm"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { usePages } from "../../composables/usePages";
import { useToast } from "../../composables/useToast";
import { api } from "../../services/api";
import { getDefaultScheduleTime, isScheduleSlotAllowed } from "../../utils/date";
import FacebookPreview from "./FacebookPreview.vue";
import CommentListEditor from "./CommentListEditor.vue";
import PagePicker from "./PagePicker.vue";
import { createEmptyComment, filledComments, toCommentPayload, validateComments } from "../../utils/comments";
import type { ComposerComment } from "@shared/types";
import CalendarPickerModal from "../dialogs/CalendarPickerModal.vue";

const emit = defineEmits<{
  (e: "task-created"): void;
}>();

const { pages } = usePages();
const toast = useToast();

const selectedPageIds = ref<string[]>([]);
const caption = ref<string>("");
const mediaFile = ref<File | null>(null);
const mediaFileName = ref<string>("");
const mediaPreviewUrl = ref<string>("");
const mediaId = ref<string>("");
const isUploading = ref<boolean>(false);
const uploadError = ref<string>("");
let uploadSeq = 0;
const uploadProgress = ref<number>(0);
const isDragging = ref<boolean>(false);
const fileInputRef = ref<HTMLInputElement | null>(null);

const enableComment = ref<boolean>(false);
const comments = ref<ComposerComment[]>([createEmptyComment()]);

const publishMode = ref<"now" | "schedule">("now");
const defTime = getDefaultScheduleTime();
const scheduleDate = ref<string>(defTime.date);
const scheduleTime = ref<string>(defTime.time);
const isCalendarOpen = ref<boolean>(false);
const isSubmitting = ref<boolean>(false);

const fileExtLabel = computed(() => {
  const ext = (mediaFileName.value.split(".").pop() || "").toUpperCase();
  return ext && ext.length <= 4 ? ext : "VIDEO";
});

const firstSelectedPage = computed(() => {
  if (selectedPageIds.value.length === 0) return pages.value[0];
  return pages.value.find((p) => p.facebook_page_id === selectedPageIds.value[0]);
});

const triggerFileInput = () => {
  fileInputRef.value?.click();
};

const handleFileChange = (e: Event) => {
  const target = e.target as HTMLInputElement;
  if (target.files && target.files[0]) {
    processSelectedFile(target.files[0]);
  }
  target.value = "";
};

const handleFileDrop = (e: DragEvent) => {
  isDragging.value = false;
  if (e.dataTransfer?.files && e.dataTransfer.files[0]) {
    processSelectedFile(e.dataTransfer.files[0]);
  }
};

const processSelectedFile = async (file: File) => {
  if (!file.type.startsWith("video/") && !/\.(mp4|mov|m4v|webm)$/i.test(file.name)) {
    toast.warning("Vui lòng chọn tệp video (MP4, MOV, WEBM).");
    return;
  }
  clearMedia();
  const seq = ++uploadSeq;
  mediaFile.value = file;
  mediaFileName.value = file.name;
  mediaPreviewUrl.value = URL.createObjectURL(file);

  isUploading.value = true;
  uploadProgress.value = 0;
  try {
    const res = await api.uploadVideo(file, (pct) => {
      if (seq === uploadSeq) uploadProgress.value = pct;
    });
    if (seq !== uploadSeq) return;
    mediaId.value = res.media_id;
  } catch (err: any) {
    if (seq !== uploadSeq) return;
    uploadError.value = err?.message || "Tải video lên thất bại.";
    toast.error(uploadError.value);
  } finally {
    if (seq === uploadSeq) isUploading.value = false;
  }
};

const clearMedia = () => {
  uploadSeq++;
  if (mediaPreviewUrl.value) URL.revokeObjectURL(mediaPreviewUrl.value);
  mediaFile.value = null;
  mediaFileName.value = "";
  mediaPreviewUrl.value = "";
  mediaId.value = "";
  uploadError.value = "";
  uploadProgress.value = 0;
  isUploading.value = false;
};

const switchToSchedule = () => {
  publishMode.value = "schedule";
  if (!isScheduleSlotAllowed(scheduleDate.value, scheduleTime.value)) {
    const def = getDefaultScheduleTime();
    scheduleDate.value = def.date;
    scheduleTime.value = def.time;
  }
};

const onCalendarConfirm = (val: { date: string; time: string }) => {
  scheduleDate.value = val.date;
  scheduleTime.value = val.time;
};

const handleSubmit = async () => {
  if (selectedPageIds.value.length === 0) {
    toast.warning("Vui lòng chọn ít nhất một Fanpage.");
    return;
  }
  if (isUploading.value) {
    toast.info("Vui lòng chờ video hoàn tất tải lên.");
    return;
  }
  if (!mediaId.value) {
    toast.warning("Vui lòng tải lên video bài đăng Reels.");
    return;
  }
  if (publishMode.value === "schedule" && !isScheduleSlotAllowed(scheduleDate.value, scheduleTime.value)) {
    toast.warning("Thời gian hẹn giờ phải cách thời điểm hiện tại ít nhất 5 phút.");
    isCalendarOpen.value = true;
    return;
  }

  if (enableComment.value) {
    const commentError = validateComments(comments.value);
    if (commentError) {
      toast.warning(commentError);
      return;
    }
  }

  isSubmitting.value = true;
  try {
    const res = await api.createTask({
      facebook_page_ids: selectedPageIds.value,
      caption: caption.value.trim(),
      media_id: mediaId.value || undefined,
      publish_mode: publishMode.value,
      schedule_date: publishMode.value === "schedule" ? scheduleDate.value : undefined,
      schedule_time: publishMode.value === "schedule" ? scheduleTime.value : undefined,
      comments: enableComment.value ? toCommentPayload(comments.value) : []
    });

    toast.success(res?.message || (publishMode.value === "now" ? "Đã gửi yêu cầu đăng Reels thành công!" : "Đã tạo lịch đăng Reels thành công!"));
    caption.value = "";
    clearMedia();
    enableComment.value = false;
    comments.value = [createEmptyComment()];
    emit("task-created");
  } catch (err: any) {
    toast.error(err?.message || "Không thể tạo bài đăng.");
  } finally {
    isSubmitting.value = false;
  }
};
</script>

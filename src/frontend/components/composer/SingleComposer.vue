<template>
  <div class="h-full flex flex-col lg:flex-row gap-4 p-4 lg:p-6 overflow-y-auto">
    <!-- COLUMN 1: Kênh đăng (Select Channels) -->
    <div class="w-full lg:w-72 bg-white rounded-2xl border border-slate-200 p-4 flex flex-col flex-shrink-0 shadow-xs max-h-[85vh]">
      <div class="flex items-center justify-between pb-3 border-b border-slate-100">
        <h3 class="font-bold text-sm text-slate-800">
          {{ t('select_channels') }}
          <span class="text-blue-600 font-normal">({{ selectedPageIds.length }}/{{ pages.length }})</span>
        </h3>
        <button
          type="button"
          @click="toggleSelectAll"
          class="text-xs font-semibold text-blue-600 hover:text-blue-700 transition"
        >
          {{ isAllSelected ? 'Bỏ chọn' : t('select_all') }}
        </button>
      </div>

      <!-- Search Box -->
      <div class="py-2.5">
        <div class="relative">
          <input
            v-model="searchQuery"
            type="text"
            :placeholder="t('search_channel')"
            class="w-full pl-8 pr-3 py-1.5 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition"
          />
          <svg class="w-4 h-4 text-slate-400 absolute left-2.5 top-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
      </div>

      <!-- Pages List -->
      <div class="flex-1 overflow-y-auto space-y-1.5 pr-1 scrollbar-thin">
        <div
          v-for="page in filteredPages"
          :key="page.facebook_page_id"
          @click="togglePage(page.facebook_page_id)"
          class="flex items-center justify-between p-2 rounded-xl border cursor-pointer transition select-none"
          :class="selectedPageIds.includes(page.facebook_page_id) ? 'border-blue-500 bg-blue-50/50' : 'border-slate-100 hover:bg-slate-50'"
        >
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="w-8 h-8 rounded-full bg-slate-200 overflow-hidden flex-shrink-0 border border-slate-200 relative">
              <img
                v-if="page.avatar_url"
                :src="page.avatar_url"
                :alt="page.page_name"
                class="w-full h-full object-cover"
              />
              <span v-else class="w-full h-full flex items-center justify-center font-bold text-slate-500 text-[10px]">FB</span>
              <span class="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-blue-600 rounded-full flex items-center justify-center text-[8px] text-white">f</span>
            </div>
            <div class="min-w-0">
              <p class="text-xs font-semibold text-slate-800 truncate">{{ page.page_name }}</p>
              <p class="text-[10px] text-slate-400 truncate">{{ page.category || t('fanpage') }}</p>
            </div>
          </div>

          <input
            type="checkbox"
            :checked="selectedPageIds.includes(page.facebook_page_id)"
            @click.stop="togglePage(page.facebook_page_id)"
            class="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 border-slate-300"
          />
        </div>

        <div v-if="filteredPages.length === 0" class="text-center py-6 text-slate-400 text-xs">
          {{ t('no_data') }}
        </div>
      </div>
    </div>

    <!-- COLUMN 2: Soạn bài viết (Composer Content & Media) -->
    <div class="flex-1 bg-white rounded-2xl border border-slate-200 p-4 lg:p-6 flex flex-col shadow-xs max-h-[85vh] overflow-y-auto">
      <div class="flex items-center justify-between pb-3 border-b border-slate-100 mb-4">
        <div class="flex items-center gap-2">
          <span class="font-bold text-sm text-slate-800">Đăng bài</span>
        </div>
        <div class="flex items-center gap-2 text-xs text-slate-500">
          <span class="cursor-pointer hover:text-blue-600">Tiêu chuẩn đăng</span>
        </div>
      </div>

      <!-- Caption Textarea -->
      <div class="border border-slate-200 rounded-2xl p-3 mb-4 focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500/20 transition">
        <textarea
          v-model="caption"
          rows="4"
          :placeholder="t('content_placeholder')"
          class="w-full resize-none text-xs sm:text-sm text-slate-800 focus:outline-none placeholder:text-slate-400"
        ></textarea>

        <!-- Editor Toolbar -->
        <div class="flex items-center justify-between pt-2 border-t border-slate-100 mt-2 text-xs text-slate-500">
          <div class="flex items-center gap-3">
            <button type="button" @click="insertAiSuggestion" class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-50 text-amber-700 hover:bg-amber-100 font-semibold transition text-xs">
              <span>✨ Viết với AI</span>
            </button>
            <button type="button" class="text-slate-400 hover:text-slate-600">
              🏷️ Thẻ gắn
            </button>
            <button type="button" class="text-slate-400 hover:text-slate-600">
              # Hashtag
            </button>
          </div>
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
          :class="isDragging ? 'border-blue-500 bg-blue-50/50' : 'border-slate-200 hover:border-slate-300 bg-slate-50/50'"
          @click="triggerFileInput"
        >
          <input
            ref="fileInputRef"
            type="file"
            accept="video/mp4,video/quicktime,video/x-msvideo"
            class="hidden"
            @change="handleFileChange"
          />

          <div v-if="!mediaFile && !mediaPreviewUrl" class="flex flex-col items-center gap-2">
            <div class="w-12 h-12 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center">
              <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <p class="text-xs font-semibold text-slate-700">
              Dán, thả hoặc <span class="text-blue-600 underline">Tải từ máy của bạn</span>
            </p>
            <p class="text-[11px] text-slate-400">Hỗ trợ MP4, MOV. Video Reels định dạng 9:16 tối ưu nhất.</p>
          </div>

          <!-- Video Selected & Upload Status -->
          <div v-else class="flex items-center justify-between p-2">
            <div class="flex items-center gap-3 text-left min-w-0">
              <div class="w-10 h-10 rounded-lg bg-blue-600 text-white flex items-center justify-center font-bold text-xs flex-shrink-0">
                MP4
              </div>
              <div class="min-w-0">
                <p class="text-xs font-bold text-slate-800 truncate">{{ mediaFileName || 'video.mp4' }}</p>
                <p class="text-[11px] text-slate-500">
                  <span v-if="isUploading">Đang tải lên R2... {{ uploadProgress }}%</span>
                  <span v-else class="text-emerald-600 font-semibold">✓ Đã sẵn sàng trên Cloudflare R2</span>
                </p>
              </div>
            </div>

            <button
              type="button"
              @click.stop="clearMedia"
              class="text-slate-400 hover:text-rose-500 p-2 rounded-lg transition"
              title="Xóa video"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>

          <!-- Progress Bar -->
          <div v-if="isUploading" class="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden mt-3">
            <div class="bg-blue-600 h-full transition-all duration-200" :style="{ width: `${uploadProgress}%` }"></div>
          </div>
        </div>
      </div>

      <!-- Advanced Options: Auto-Comment Toggle -->
      <div class="border border-slate-200 rounded-2xl p-4 mb-4 space-y-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <svg class="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <span class="text-xs font-bold text-slate-800">Tự động đăng bình luận đầu tiên</span>
          </div>
          <label class="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="enableComment" class="sr-only peer" />
            <div class="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
          </label>
        </div>

        <!-- Comment Text Input & Delay -->
        <div v-if="enableComment" class="space-y-2 pt-2 border-t border-slate-100">
          <input
            v-model="commentText"
            type="text"
            placeholder="Nội dung bình luận tự động (vd: Link sản phẩm, hashtag, liên hệ)..."
            class="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <div class="flex items-center gap-2 text-xs text-slate-500">
            <span>Thời điểm gửi bình luận:</span>
            <select
              v-model="commentDelayOption"
              class="px-2.5 py-1 text-xs rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 font-medium text-slate-700"
            >
              <option value="now">Đăng ngay khi video xuất bản</option>
              <option value="10m">Sau 10 phút</option>
              <option value="30m">Sau 30 phút</option>
              <option value="1h">Sau 1 giờ</option>
              <option value="2h">Sau 2 giờ</option>
            </select>
          </div>
        </div>
      </div>

      <!-- Bottom Bar: Publish Mode & Schedule & Submit -->
      <div class="mt-auto pt-4 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3">
        <!-- Publish Mode: Đăng ngay vs Hẹn giờ -->
        <div class="flex items-center gap-2 bg-slate-100 p-1 rounded-xl text-xs font-semibold">
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
            @click="publishMode = 'schedule'"
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
          class="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 text-xs font-medium transition"
        >
          <svg class="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span>{{ scheduleDate }} {{ scheduleTime }} (GMT+7)</span>
          <svg class="w-3.5 h-3.5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        <!-- Submit Button -->
        <button
          type="button"
          :disabled="isSubmitting || selectedPageIds.length === 0 || (!caption && !mediaFile && !mediaId)"
          @click="handleSubmit"
          class="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold text-xs sm:text-sm shadow-md shadow-blue-500/20 transition flex items-center justify-center gap-2"
        >
          <svg v-if="isSubmitting" class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
          </svg>
          <span>{{ isSubmitting ? 'Đang tạo bài đăng...' : 'Lưu & Xuất bản' }}</span>
        </button>
      </div>
    </div>

    <!-- COLUMN 3: Xem trước Facebook Preview -->
    <div class="w-full lg:w-80 flex-shrink-0">
      <FacebookPreview
        :selectedPage="firstSelectedPage"
        :caption="caption"
        :mediaPreviewUrl="mediaPreviewUrl"
        :enableComment="enableComment"
        :commentText="commentText"
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
import { useI18n } from "../../utils/i18n";
import { usePages } from "../../composables/usePages";
import { useToast } from "../../composables/useToast";
import { api } from "../../services/api";
import { getDefaultScheduleTime } from "../../utils/date";
import FacebookPreview from "./FacebookPreview.vue";
import CalendarPickerModal from "../dialogs/CalendarPickerModal.vue";

const emit = defineEmits<{
  (e: "task-created"): void;
}>();

const { t } = useI18n();
const { pages, filteredPages, searchQuery } = usePages();
const toast = useToast();

const selectedPageIds = ref<string[]>([]);
const caption = ref<string>("");
const mediaFile = ref<File | null>(null);
const mediaFileName = ref<string>("");
const mediaPreviewUrl = ref<string>("");
const mediaId = ref<string>("");
const isUploading = ref<boolean>(false);
const uploadProgress = ref<number>(0);
const isDragging = ref<boolean>(false);
const fileInputRef = ref<HTMLInputElement | null>(null);

const enableComment = ref<boolean>(false);
const commentText = ref<string>("");
const commentDelayOption = ref<string>("now");

const publishMode = ref<"now" | "schedule">("now");
const defTime = getDefaultScheduleTime();
const scheduleDate = ref<string>(defTime.date);
const scheduleTime = ref<string>(defTime.time);
const isCalendarOpen = ref<boolean>(false);
const isSubmitting = ref<boolean>(false);

const firstSelectedPage = computed(() => {
  if (selectedPageIds.value.length === 0) return pages.value[0];
  return pages.value.find((p) => p.facebook_page_id === selectedPageIds.value[0]);
});

const isAllSelected = computed(
  () => pages.value.length > 0 && selectedPageIds.value.length === pages.value.length
);

const togglePage = (id: string) => {
  if (selectedPageIds.value.includes(id)) {
    selectedPageIds.value = selectedPageIds.value.filter((i) => i !== id);
  } else {
    selectedPageIds.value.push(id);
  }
};

const toggleSelectAll = () => {
  if (isAllSelected.value) {
    selectedPageIds.value = [];
  } else {
    selectedPageIds.value = pages.value.map((p) => p.facebook_page_id);
  }
};

const triggerFileInput = () => {
  fileInputRef.value?.click();
};

const handleFileChange = (e: Event) => {
  const target = e.target as HTMLInputElement;
  if (target.files && target.files[0]) {
    processSelectedFile(target.files[0]);
  }
};

const handleFileDrop = (e: DragEvent) => {
  isDragging.value = false;
  if (e.dataTransfer?.files && e.dataTransfer.files[0]) {
    processSelectedFile(e.dataTransfer.files[0]);
  }
};

const processSelectedFile = async (file: File) => {
  mediaFile.value = file;
  mediaFileName.value = file.name;
  mediaPreviewUrl.value = URL.createObjectURL(file);

  // Upload immediately to R2 via streaming chunks
  isUploading.value = true;
  uploadProgress.value = 0;
  try {
    const res = await api.uploadVideo(file, (pct) => {
      uploadProgress.value = pct;
    });
    mediaId.value = res.media_id;
    toast.success("Video đã được tải lên Cloudflare R2 an toàn!");
  } catch (err: any) {
    toast.error(err?.message || "Tải video lên R2 thất bại.");
  } finally {
    isUploading.value = false;
  }
};

const clearMedia = () => {
  mediaFile.value = null;
  mediaFileName.value = "";
  mediaPreviewUrl.value = "";
  mediaId.value = "";
  uploadProgress.value = 0;
};

const insertAiSuggestion = () => {
  caption.value = "🔥 Khám phá những khoảnh khắc tuyệt vời nhất hôm nay! Đừng quên theo dõi và chia sẻ nếu bạn thấy hữu ích nhé! #reels #trending #viral";
};

const onCalendarConfirm = (val: { date: string; time: string }) => {
  scheduleDate.value = val.date;
  scheduleTime.value = val.time;
};

const handleSubmit = async () => {
  if (selectedPageIds.value.length === 0) {
    toast.warning("Vui lòng chọn ít nhất một Fanpage để đăng bài.");
    return;
  }
  if (!caption.value.trim() && !mediaId.value) {
    toast.warning("Vui lòng nhập nội dung hoặc chọn video để đăng.");
    return;
  }
  if (isUploading.value) {
    toast.info("Vui lòng đợi video tải lên hoàn tất.");
    return;
  }

  isSubmitting.value = true;
  try {
    const delayMinutes = commentDelayOption.value === "10m" ? 10 :
      commentDelayOption.value === "30m" ? 30 :
      commentDelayOption.value === "1h" ? 60 :
      commentDelayOption.value === "2h" ? 120 : 0;

    const res = await api.createTask({
      facebook_page_ids: selectedPageIds.value,
      caption: caption.value.trim(),
      media_id: mediaId.value || undefined,
      publish_mode: publishMode.value,
      schedule_date: publishMode.value === "schedule" ? scheduleDate.value : undefined,
      schedule_time: publishMode.value === "schedule" ? scheduleTime.value : undefined,
      comment_text: enableComment.value ? commentText.value.trim() : undefined,
      comment_delay_minutes: enableComment.value ? delayMinutes : undefined
    });

    toast.success(res?.message || "Đã tạo bài đăng thành công!");
    // Reset form
    caption.value = "";
    clearMedia();
    enableComment.value = false;
    commentText.value = "";
    emit("task-created");
  } catch (err: any) {
    toast.error(err?.message || "Tạo bài đăng thất bại.");
  } finally {
    isSubmitting.value = false;
  }
};
</script>

<template>
  <div class="h-full flex flex-col p-4 lg:p-6 overflow-y-auto select-none">
    <!-- Top Action Toolbar -->
    <div class="flex flex-wrap items-center justify-between gap-3 mb-4 bg-white p-3 rounded-2xl border border-slate-200 shadow-xs">
      <!-- Quick Batch Setting Buttons -->
      <div class="flex flex-wrap items-center gap-2">
        <!-- Tải lên media (Purple) -->
        <button
          type="button"
          @click="triggerBulkMediaUpload"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-semibold text-xs transition shadow-xs"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span>Tải lên media</span>
        </button>
        <input
          ref="bulkMediaInputRef"
          type="file"
          multiple
          accept="video/mp4,video/quicktime"
          class="hidden"
          @change="handleBulkMediaSelected"
        />

        <!-- Chọn kênh đăng (Orange) -->
        <button
          type="button"
          @click="applyChannelsToAll"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-semibold text-xs transition shadow-xs"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          <span>Chọn kênh đăng</span>
        </button>

        <!-- Cài đặt thời gian đăng (Blue) -->
        <button
          type="button"
          @click="openGlobalCalendar"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs transition shadow-xs"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span>Cài đặt thời gian đăng</span>
        </button>

        <!-- Bình luận hàng loạt (Green) -->
        <button
          type="button"
          @click="openGlobalCommentModal"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs transition shadow-xs"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <span>Bình luận hàng loạt</span>
        </button>
      </div>

      <!-- Right: Post Count & Submit Button -->
      <div class="flex items-center gap-3">
        <span class="text-xs text-slate-500 font-medium">
          Tổng số bài đăng: <strong class="text-slate-800">{{ rows.length }}</strong>
        </span>

        <button
          type="button"
          :disabled="isSubmitting || rows.length === 0"
          @click="handleSubmitAll"
          class="flex items-center gap-2 px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold text-xs shadow-md shadow-blue-500/20 transition"
        >
          <svg v-if="isSubmitting" class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
          </svg>
          <span>{{ isSubmitting ? 'Đang tạo bài...' : 'Đăng bài' }}</span>
        </button>
      </div>
    </div>

    <!-- Bulk Posts Table -->
    <div class="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs flex-1 flex flex-col min-h-[350px]">
      <div class="overflow-x-auto flex-1 scrollbar-thin">
        <table class="w-full text-xs text-left">
          <thead class="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
            <tr>
              <th class="py-3 px-4 w-10 text-center">
                <input
                  type="checkbox"
                  :checked="isAllSelected"
                  @change="toggleSelectAllRows"
                  class="rounded text-blue-600 focus:ring-blue-500 border-slate-300 w-4 h-4"
                />
              </th>
              <th class="py-3 px-4 w-64">Kênh</th>
              <th class="py-3 px-4 min-w-[240px]">Nội dung ({{ rows.length }})</th>
              <th class="py-3 px-4 w-28 text-center">Media</th>
              <th class="py-3 px-4 w-48">Thời gian</th>
              <th class="py-3 px-4 w-20 text-center">Hành động</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr
              v-for="(row, idx) in rows"
              :key="row.id"
              class="hover:bg-slate-50/60 transition group"
            >
              <!-- Row Checkbox -->
              <td class="py-3 px-4 text-center">
                <input
                  type="checkbox"
                  v-model="selectedRowIds"
                  :value="row.id"
                  class="rounded text-blue-600 focus:ring-blue-500 border-slate-300 w-4 h-4"
                />
              </td>

              <!-- Kênh Selection Cell -->
              <td class="py-3 px-4">
                <div class="space-y-1.5 relative">
                  <div class="flex items-center gap-1 text-[11px] font-semibold text-slate-600">
                    <span class="px-2 py-0.5 rounded bg-blue-50 text-blue-700">Các kênh</span>
                    <span class="text-slate-400">({{ row.selectedPageIds.length }})</span>
                  </div>

                  <!-- Select Channel Trigger -->
                  <div
                    @click="activeChannelPopoverRowId = activeChannelPopoverRowId === row.id ? null : row.id"
                    class="px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:border-blue-400 text-xs cursor-pointer flex items-center justify-between transition"
                  >
                    <span v-if="row.selectedPageIds.length === 0" class="text-slate-400">Chọn các kênh</span>
                    <span v-else class="text-slate-800 font-medium truncate">
                      {{ getSelectedPagesSummary(row.selectedPageIds) }}
                    </span>
                    <svg class="w-3.5 h-3.5 text-slate-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>

                  <!-- Channel Popover -->
                  <div
                    v-if="activeChannelPopoverRowId === row.id"
                    class="absolute left-0 top-full mt-1 w-64 bg-white rounded-xl shadow-xl border border-slate-200 p-2 z-40 space-y-1 max-h-48 overflow-y-auto"
                  >
                    <div
                      v-for="page in pages"
                      :key="page.facebook_page_id"
                      @click="toggleRowChannel(row, page.facebook_page_id)"
                      class="flex items-center gap-2 p-1.5 rounded-lg hover:bg-slate-50 cursor-pointer text-xs"
                    >
                      <input
                        type="checkbox"
                        :checked="row.selectedPageIds.includes(page.facebook_page_id)"
                        class="rounded text-blue-600 border-slate-300 w-3.5 h-3.5"
                      />
                      <span class="truncate">{{ page.page_name }}</span>
                    </div>
                  </div>
                </div>
              </td>

              <!-- Nội dung mô tả -->
              <td class="py-3 px-4">
                <textarea
                  v-model="row.caption"
                  rows="2"
                  placeholder="Nội dung mô tả..."
                  class="w-full px-3 py-1.5 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 resize-none transition"
                ></textarea>
              </td>

              <!-- Media Cell -->
              <td class="py-3 px-4 text-center">
                <div class="flex items-center justify-center">
                  <label class="cursor-pointer p-1.5 rounded-lg border border-dashed border-slate-300 hover:border-blue-500 hover:bg-blue-50 transition relative" :title="row.mediaFileName || 'Tải video'">
                    <input
                      type="file"
                      accept="video/mp4,video/quicktime"
                      class="hidden"
                      @change="(e) => handleRowFileChange(row, e)"
                    />
                    <svg v-if="!row.mediaFile && !row.mediaId" class="w-5 h-5 text-slate-400 hover:text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    <div v-else class="text-[10px] font-bold text-emerald-600 flex items-center gap-1">
                      <span>✓</span>
                      <span class="max-w-[60px] truncate">{{ row.mediaFileName || 'Video' }}</span>
                    </div>
                  </label>
                </div>
                <div v-if="row.isUploading" class="text-[9px] text-blue-600 mt-1">
                  {{ row.uploadProgress }}%
                </div>
              </td>

              <!-- Thời gian Cell -->
              <td class="py-3 px-4">
                <button
                  type="button"
                  @click="openRowCalendar(row)"
                  class="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:border-blue-400 text-xs flex items-center justify-between text-slate-700 transition"
                >
                  <span class="flex items-center gap-1.5 truncate">
                    <svg class="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    <span>{{ row.scheduleDate }} {{ row.scheduleTime }}</span>
                  </span>
                  <svg class="w-3.5 h-3.5 text-slate-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              </td>

              <!-- Hành động Cell -->
              <td class="py-3 px-4 text-center">
                <div class="flex items-center justify-center gap-1.5">
                  <!-- Comment Icon -->
                  <button
                    type="button"
                    @click="openRowCommentModal(row)"
                    class="p-1 text-slate-400 hover:text-blue-600 rounded transition"
                    :title="row.commentText ? `Bình luận: ${row.commentText}` : 'Cài đặt bình luận'"
                  >
                    <svg class="w-4 h-4" :class="row.commentText ? 'text-blue-600' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                  </button>

                  <!-- Delete Row Icon -->
                  <button
                    type="button"
                    @click="deleteRow(idx)"
                    class="p-1 text-slate-400 hover:text-rose-500 rounded transition"
                    title="Xóa dòng này"
                  >
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Add New Row Button (Matching user image "+ Tạo một bài đăng mới") -->
      <div class="p-3 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between">
        <button
          type="button"
          @click="addNewRow"
          class="flex items-center gap-1.5 text-xs font-bold text-blue-600 hover:text-blue-700 transition px-2 py-1"
        >
          <span class="text-base font-normal">+</span>
          <span>Tạo một bài đăng mới</span>
        </button>
      </div>
    </div>

    <!-- Calendar Popover Modal -->
    <CalendarPickerModal
      :isOpen="isCalendarOpen"
      :initialDate="calendarInitialDate"
      :initialTime="calendarInitialTime"
      @close="isCalendarOpen = false"
      @confirm="onCalendarConfirm"
    />

    <!-- Bulk Comment Modal -->
    <BulkCommentModal
      :isOpen="isCommentModalOpen"
      :initialText="commentInitialText"
      :initialDelayOption="commentInitialDelayOption"
      @close="isCommentModalOpen = false"
      @save="onCommentSave"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { usePages } from "../../composables/usePages";
import { useToast } from "../../composables/useToast";
import { api } from "../../services/api";
import { getDefaultScheduleTime, formatVnDate, formatVnTime } from "../../utils/date";
import type { BulkComposerRow } from "@shared/types";
import CalendarPickerModal from "../dialogs/CalendarPickerModal.vue";
import BulkCommentModal from "../dialogs/BulkCommentModal.vue";

const emit = defineEmits<{
  (e: "tasks-created"): void;
}>();

const { pages } = usePages();
const toast = useToast();

const def = getDefaultScheduleTime();

const createEmptyRow = (): BulkComposerRow => ({
  id: `row_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
  selectedPageIds: pages.value.length > 0 ? [pages.value[0].facebook_page_id] : [],
  caption: "",
  mediaFile: null,
  mediaFileName: "",
  mediaPreviewUrl: "",
  mediaId: "",
  uploadProgress: 0,
  isUploading: false,
  scheduleDate: def.date,
  scheduleTime: def.time,
  commentText: "",
  commentDelayMinutes: 0,
  commentDelayOption: "now"
});

const rows = ref<BulkComposerRow[]>([createEmptyRow()]);
const selectedRowIds = ref<string[]>([]);
const activeChannelPopoverRowId = ref<string | null>(null);
const bulkMediaInputRef = ref<HTMLInputElement | null>(null);

// Modal states
const isCalendarOpen = ref(false);
const calendarTargetRowId = ref<string | null>(null);
const calendarInitialDate = ref(def.date);
const calendarInitialTime = ref(def.time);

const isCommentModalOpen = ref(false);
const commentTargetRowId = ref<string | null>(null);
const commentInitialText = ref("");
const commentInitialDelayOption = ref("now");

const isSubmitting = ref(false);

const isAllSelected = computed(
  () => rows.value.length > 0 && selectedRowIds.value.length === rows.value.length
);

const toggleSelectAllRows = () => {
  if (isAllSelected.value) {
    selectedRowIds.value = [];
  } else {
    selectedRowIds.value = rows.value.map((r) => r.id);
  }
};

const addNewRow = () => {
  rows.value.push(createEmptyRow());
};

const deleteRow = (idx: number) => {
  if (rows.value.length === 1) {
    rows.value[0] = createEmptyRow();
    return;
  }
  rows.value.splice(idx, 1);
};

const getSelectedPagesSummary = (ids: string[]) => {
  if (ids.length === 0) return "Chưa chọn kênh";
  if (ids.length === 1) {
    const p = pages.value.find((x) => x.facebook_page_id === ids[0]);
    return p?.page_name || ids[0];
  }
  return `${ids.length} Fanpage đã chọn`;
};

const toggleRowChannel = (row: BulkComposerRow, pageId: string) => {
  if (row.selectedPageIds.includes(pageId)) {
    row.selectedPageIds = row.selectedPageIds.filter((id) => id !== pageId);
  } else {
    row.selectedPageIds.push(pageId);
  }
};

const applyChannelsToAll = () => {
  if (pages.value.length === 0) {
    toast.warning("Chưa có Fanpage nào được kết nối.");
    return;
  }
  const allIds = pages.value.map((p) => p.facebook_page_id);
  rows.value.forEach((r) => {
    r.selectedPageIds = [...allIds];
  });
  toast.success(`Đã áp dụng chọn tất cả ${allIds.length} Fanpage cho toàn bộ bài đăng!`);
};

// Bulk Media Upload: each file becomes a row or fills existing rows!
const triggerBulkMediaUpload = () => {
  bulkMediaInputRef.value?.click();
};

const handleBulkMediaSelected = async (e: Event) => {
  const target = e.target as HTMLInputElement;
  if (!target.files || target.files.length === 0) return;

  const files = Array.from(target.files);
  toast.info(`Bắt đầu tải lên ${files.length} video lên Cloudflare R2...`);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let row: BulkComposerRow;
    if (i === 0 && rows.value.length === 1 && !rows.value[0].mediaId && !rows.value[0].caption) {
      row = rows.value[0];
    } else {
      row = createEmptyRow();
      rows.value.push(row);
    }

    row.mediaFile = file;
    row.mediaFileName = file.name;
    row.isUploading = true;

    // Stagger schedule time by 30 mins each
    const scheduleTimeObj = new Date();
    scheduleTimeObj.setMinutes(scheduleTimeObj.getMinutes() + 15 + i * 30);
    row.scheduleDate = formatVnDate(scheduleTimeObj);
    row.scheduleTime = formatVnTime(scheduleTimeObj);

    try {
      const res = await api.uploadVideo(file, (pct) => {
        row.uploadProgress = pct;
      });
      row.mediaId = res.media_id;
    } catch (err: any) {
      row.errorMessage = err?.message || "Tải video lỗi";
    } finally {
      row.isUploading = false;
    }
  }

  toast.success(`Đã chuẩn bị xong ${files.length} bài đăng từ các video tải lên!`);
};

const handleRowFileChange = async (row: BulkComposerRow, e: Event) => {
  const target = e.target as HTMLInputElement;
  if (!target.files || !target.files[0]) return;
  const file = target.files[0];
  row.mediaFile = file;
  row.mediaFileName = file.name;
  row.isUploading = true;
  row.uploadProgress = 0;
  try {
    const res = await api.uploadVideo(file, (pct) => {
      row.uploadProgress = pct;
    });
    row.mediaId = res.media_id;
    toast.success(`Đã tải lên '${file.name}'`);
  } catch (err: any) {
    toast.error(err?.message || "Tải video lỗi");
  } finally {
    row.isUploading = false;
  }
};

// Calendar
const openRowCalendar = (row: BulkComposerRow) => {
  calendarTargetRowId.value = row.id;
  calendarInitialDate.value = row.scheduleDate;
  calendarInitialTime.value = row.scheduleTime;
  isCalendarOpen.value = true;
};

const openGlobalCalendar = () => {
  calendarTargetRowId.value = "GLOBAL";
  calendarInitialDate.value = def.date;
  calendarInitialTime.value = def.time;
  isCalendarOpen.value = true;
};

const onCalendarConfirm = (val: { date: string; time: string }) => {
  if (calendarTargetRowId.value === "GLOBAL") {
    rows.value.forEach((r, idx) => {
      // Stagger by 30 minutes
      const [y, m, d] = val.date.split("-").map(Number);
      const [hr, min] = val.time.split(":").map(Number);
      const dt = new Date(y, m - 1, d, hr, min + idx * 30);
      r.scheduleDate = formatVnDate(dt);
      r.scheduleTime = formatVnTime(dt);
    });
    toast.success(`Đã cài đặt lịch cách nhau 30 phút cho ${rows.value.length} bài đăng!`);
  } else if (calendarTargetRowId.value) {
    const target = rows.value.find((r) => r.id === calendarTargetRowId.value);
    if (target) {
      target.scheduleDate = val.date;
      target.scheduleTime = val.time;
    }
  }
  isCalendarOpen.value = false;
};

// Comments
const openRowCommentModal = (row: BulkComposerRow) => {
  commentTargetRowId.value = row.id;
  commentInitialText.value = row.commentText;
  commentInitialDelayOption.value = row.commentDelayOption;
  isCommentModalOpen.value = true;
};

const openGlobalCommentModal = () => {
  commentTargetRowId.value = "GLOBAL";
  commentInitialText.value = "";
  commentInitialDelayOption.value = "now";
  isCommentModalOpen.value = true;
};

const onCommentSave = (val: { text: string; delayOption: string; delayMinutes: number }) => {
  if (commentTargetRowId.value === "GLOBAL") {
    rows.value.forEach((r) => {
      r.commentText = val.text;
      r.commentDelayOption = val.delayOption;
      r.commentDelayMinutes = val.delayMinutes;
    });
    toast.success(`Đã áp dụng bình luận hàng loạt cho ${rows.value.length} bài!`);
  } else if (commentTargetRowId.value) {
    const target = rows.value.find((r) => r.id === commentTargetRowId.value);
    if (target) {
      target.commentText = val.text;
      target.commentDelayOption = val.delayOption;
      target.commentDelayMinutes = val.delayMinutes;
    }
  }
  isCommentModalOpen.value = false;
};

// Submit All
const handleSubmitAll = async () => {
  const validRows = rows.value.filter(
    (r) => r.selectedPageIds.length > 0 && (r.caption.trim() || r.mediaId)
  );

  if (validRows.length === 0) {
    toast.warning("Vui lòng chọn Fanpage và nhập nội dung/video cho ít nhất một bài đăng.");
    return;
  }

  isSubmitting.value = true;
  try {
    const payload = {
      tasks: validRows.map((r) => ({
        facebook_page_ids: r.selectedPageIds,
        caption: r.caption.trim(),
        media_id: r.mediaId || undefined,
        schedule_date: r.scheduleDate,
        schedule_time: r.scheduleTime,
        comment_text: r.commentText.trim() || undefined,
        comment_delay_minutes: r.commentDelayMinutes
      }))
    };

    const res = await api.createBulkTasks(payload);
    toast.success(res?.message || `Đã tạo ${res?.created_count || validRows.length} bài đăng thành công!`);
    rows.value = [createEmptyRow()];
    emit("tasks-created");
  } catch (err: any) {
    toast.error(err?.message || "Tạo bài đăng hàng loạt thất bại.");
  } finally {
    isSubmitting.value = false;
  }
};
</script>

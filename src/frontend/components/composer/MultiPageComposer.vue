<template>
  <div class="h-full flex flex-col lg:flex-row gap-4 p-4 lg:p-6 overflow-y-auto select-none">
    <!-- LEFT: Step 1 (shared time) + Step 2 (pages) -->
    <div class="w-full lg:w-72 flex flex-col gap-4 flex-shrink-0 lg:max-h-[85vh]">
      <!-- Step 1: shared publish time -->
      <div class="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-xs">
        <h3 class="font-bold text-sm text-slate-800 flex items-center gap-2 mb-3">
          <span class="w-5 h-5 rounded-full bg-blue-600 text-white text-[11px] font-extrabold flex items-center justify-center">1</span>
          <span>Thời gian đăng chung</span>
        </h3>
        <button
          type="button"
          @click="isCalendarOpen = true"
          class="w-full px-3 py-2 rounded-xl border bg-white hover:border-blue-400 text-xs flex items-center justify-between transition shadow-2xs"
          :class="slotAllowed ? 'border-slate-200/90 text-slate-700' : 'border-rose-300 text-rose-600'"
        >
          <span class="flex items-center gap-1.5 font-semibold">
            <svg class="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <span>{{ formatSlot(scheduleDate, scheduleTime) }}</span>
          </span>
          <svg class="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        <p class="mt-2 text-[11px]" :class="slotAllowed ? 'text-slate-400' : 'text-rose-600 font-medium'">
          {{ slotAllowed ? "Áp dụng cho tất cả Fanpage bên dưới (GMT+7)." : "Thời gian này đã qua. Vui lòng chọn giờ mới." }}
        </p>
      </div>

      <!-- Step 2: pages -->
      <div class="bg-white rounded-2xl border border-slate-200/80 p-4 flex flex-col shadow-xs flex-1 min-h-[320px] lg:min-h-0">
        <div class="flex items-center justify-between pb-3 mb-3 border-b border-slate-100">
          <h3 class="font-bold text-sm text-slate-800 flex items-center gap-2">
            <span class="w-5 h-5 rounded-full bg-blue-600 text-white text-[11px] font-extrabold flex items-center justify-center">2</span>
            <span>Chọn Fanpage</span>
          </h3>
          <span class="text-[11px] font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-lg border border-blue-100">
            {{ selectedPageIds.length }} đã chọn
          </span>
        </div>
        <PagePicker v-model="selectedPageIds" :pages="pages" class="flex-1 min-h-0" />
      </div>
    </div>

    <!-- RIGHT: Step 3, one row per selected page -->
    <div class="flex-1 min-w-0 bg-white rounded-2xl border border-slate-200/80 shadow-xs flex flex-col min-h-[350px] lg:max-h-[85vh]">
      <div class="flex flex-wrap items-center justify-between gap-3 p-3.5 border-b border-slate-100">
        <h3 class="font-bold text-sm text-slate-800 flex items-center gap-2">
          <span class="w-5 h-5 rounded-full bg-blue-600 text-white text-[11px] font-extrabold flex items-center justify-center">3</span>
          <span>Nội dung cho từng Fanpage</span>
          <span class="text-xs font-semibold text-slate-400">({{ rows.length }} bài)</span>
        </h3>
        <button
          type="button"
          :disabled="isSubmitting || rows.length === 0"
          @click="handleSubmitAll"
          class="flex items-center gap-2 px-5 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-50 text-white font-bold text-xs shadow-md shadow-blue-500/20 transition"
        >
          <svg v-if="isSubmitting" class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
          </svg>
          <span>{{ isSubmitting ? "Đang lên lịch..." : "Lên lịch tất cả bài viết" }}</span>
        </button>
      </div>

      <div v-if="rows.length === 0" class="flex-1 flex flex-col items-center justify-center text-center p-8 text-slate-400">
        <svg class="w-10 h-10 mb-2 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
        </svg>
        <p class="text-xs font-semibold">Chọn Fanpage ở bước 2 để bắt đầu nhập nội dung.</p>
      </div>

      <div v-else class="overflow-auto flex-1 scrollbar-thin">
        <table class="w-full text-xs text-left">
          <thead class="bg-slate-50/80 text-slate-600 font-bold border-b border-slate-200/80 sticky top-0 z-10">
            <tr>
              <th class="py-3 px-4 w-10 text-center">#</th>
              <th class="py-3 px-4 w-52">Fanpage</th>
              <th class="py-3 px-4 min-w-[240px]">Nội dung (Caption)</th>
              <th class="py-3 px-4 w-28 text-center">Video Reels</th>
              <th class="py-3 px-4 w-28 text-center">Bình luận</th>
              <th class="py-3 px-4 w-12 text-center"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="(row, idx) in rows" :key="row.pageId" class="hover:bg-blue-50/20 transition align-top">
              <td class="py-3.5 px-4 text-center text-slate-400 font-bold">{{ idx + 1 }}</td>

              <!-- Page (fixed) -->
              <td class="py-3.5 px-4">
                <div class="flex items-center gap-2 min-w-0">
                  <img
                    v-if="pageById(row.pageId)?.avatar_url"
                    :src="pageById(row.pageId)?.avatar_url"
                    class="w-7 h-7 rounded-full object-cover flex-shrink-0 border border-slate-200"
                    alt=""
                  />
                  <div v-else class="w-7 h-7 rounded-full bg-slate-100 flex-shrink-0"></div>
                  <span class="font-semibold text-slate-800 truncate" :title="pageName(row.pageId)">{{ pageName(row.pageId) }}</span>
                </div>
              </td>

              <!-- Caption -->
              <td class="py-3.5 px-4">
                <textarea
                  v-model="row.caption"
                  rows="2"
                  placeholder="Nhập caption..."
                  class="w-full px-3 py-1.5 text-xs rounded-xl border border-slate-200/90 bg-slate-50/30 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400 resize-none transition"
                ></textarea>
                <p v-if="row.errorMessage" class="mt-1 text-[11px] text-rose-600 font-medium">{{ row.errorMessage }}</p>
              </td>

              <!-- Video -->
              <td class="py-3.5 px-4 text-center">
                <div class="flex items-center justify-center">
                  <label
                    class="cursor-pointer p-2 rounded-xl border border-dashed border-blue-200 hover:border-blue-500 hover:bg-blue-50/40 transition relative shadow-2xs bg-white"
                    :title="row.mediaFileName || 'Bấm để chọn video'"
                  >
                    <input
                      type="file"
                      accept="video/mp4,video/quicktime,video/x-m4v,video/webm,.mp4,.mov,.m4v,.webm"
                      class="hidden"
                      @change="(e) => handleRowFileChange(row, e)"
                    />
                    <svg v-if="!row.mediaFile && !row.mediaId" class="w-5 h-5 text-slate-400 hover:text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    <div v-else-if="row.isUploading" class="text-[10px] font-bold text-blue-600">{{ row.uploadProgress || 0 }}%</div>
                    <div v-else-if="!row.mediaId" class="text-[10px] font-bold text-rose-600 flex items-center gap-1">
                      <span>✕</span>
                      <span class="max-w-[60px] truncate">Thử lại</span>
                    </div>
                    <div v-else class="text-[10px] font-bold text-emerald-600 flex items-center gap-1">
                      <span>✓</span>
                      <span class="max-w-[60px] truncate">{{ row.mediaFileName || "Video" }}</span>
                    </div>
                  </label>
                </div>
                <div v-if="row.isUploading" class="w-16 mx-auto bg-slate-200 h-1 rounded-full overflow-hidden mt-1">
                  <div class="bg-blue-600 h-full transition-all" :style="{ width: `${row.uploadProgress || 0}%` }"></div>
                </div>
              </td>

              <!-- Comments -->
              <td class="py-3.5 px-4 text-center">
                <button
                  type="button"
                  @click="openRowCommentModal(row)"
                  class="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl border text-[11px] font-bold transition shadow-2xs"
                  :class="filledComments(row.comments).length ? 'border-purple-200 bg-purple-50 text-purple-700' : 'border-slate-200 text-slate-500 hover:border-blue-400 hover:text-blue-600 bg-white'"
                  :title="commentSummary(row)"
                >
                  <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                  <span>{{ filledComments(row.comments).length ? filledComments(row.comments).length : "+ Thêm" }}</span>
                </button>
              </td>

              <!-- Remove page -->
              <td class="py-3.5 px-4 text-center">
                <button
                  type="button"
                  @click="removePage(row.pageId)"
                  class="p-1 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition"
                  title="Bỏ Fanpage này"
                >
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <CalendarPickerModal
      :isOpen="isCalendarOpen"
      :initialDate="scheduleDate"
      :initialTime="scheduleTime"
      @close="isCalendarOpen = false"
      @confirm="onCalendarConfirm"
    />

    <BulkCommentModal
      :isOpen="isCommentModalOpen"
      :initialComments="commentModalInitial"
      @close="isCommentModalOpen = false"
      @save="onCommentSave"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { usePages } from "../../composables/usePages";
import { useToast } from "../../composables/useToast";
import { api } from "../../services/api";
import { getDefaultScheduleTime, isScheduleSlotAllowed } from "../../utils/date";
import { filledComments, toCommentPayload, validateComments, delayLabel } from "../../utils/comments";
import type { ComposerComment } from "@shared/types";
import CalendarPickerModal from "../dialogs/CalendarPickerModal.vue";
import BulkCommentModal from "../dialogs/BulkCommentModal.vue";
import PagePicker from "./PagePicker.vue";

interface PageRow {
  pageId: string;
  caption: string;
  mediaFile: File | null;
  mediaFileName: string;
  mediaId: string;
  uploadProgress: number;
  isUploading: boolean;
  comments: ComposerComment[];
  errorMessage: string;
}

const emit = defineEmits<{ (e: "tasks-created"): void }>();

const { pages } = usePages();
const toast = useToast();

// Step 1: one publish time shared by every row
const def = getDefaultScheduleTime();
const scheduleDate = ref(def.date);
const scheduleTime = ref(def.time);
const isCalendarOpen = ref(false);
const slotAllowed = computed(() => isScheduleSlotAllowed(scheduleDate.value, scheduleTime.value));

const formatSlot = (date: string, time: string) => {
  const [y, m, d] = (date || "").split("-");
  return y && m && d ? `${time} ${d}/${m}/${y}` : `${date} ${time}`;
};

const onCalendarConfirm = (val: { date: string; time: string }) => {
  scheduleDate.value = val.date;
  scheduleTime.value = val.time;
  isCalendarOpen.value = false;
};

// Step 2 → Step 3: one row per selected page, kept in sync with the selection
const selectedPageIds = ref<string[]>([]);
const rows = ref<PageRow[]>([]);

const createRow = (pageId: string): PageRow => ({
  pageId,
  caption: "",
  mediaFile: null,
  mediaFileName: "",
  mediaId: "",
  uploadProgress: 0,
  isUploading: false,
  comments: [],
  errorMessage: ""
});

watch(
  selectedPageIds,
  (ids) => {
    // Keep whatever was already typed for pages that stay selected
    const existing = new Map(rows.value.map((r) => [r.pageId, r]));
    rows.value = ids.map((id) => existing.get(id) || createRow(id));
  },
  { deep: true }
);

const pageById = (id: string) => pages.value.find((p) => p.facebook_page_id === id);
const pageName = (id: string) => pageById(id)?.page_name || id;

const removePage = (pageId: string) => {
  selectedPageIds.value = selectedPageIds.value.filter((id) => id !== pageId);
};

// Video upload (per row)
const handleRowFileChange = async (row: PageRow, e: Event) => {
  const target = e.target as HTMLInputElement;
  if (!target.files || !target.files[0]) return;
  const file = target.files[0];
  target.value = "";
  row.mediaFile = file;
  row.mediaFileName = file.name;
  row.mediaId = "";
  row.errorMessage = "";
  row.isUploading = true;
  row.uploadProgress = 0;
  try {
    const res = await api.uploadVideo(file, (pct) => {
      row.uploadProgress = pct;
    });
    row.mediaId = res.media_id;
  } catch (err: any) {
    const msg: string = err?.message || "Video upload failed. Please choose it again.";
    row.errorMessage = msg;
    toast.error(msg);
  } finally {
    row.isUploading = false;
  }
};

// Comments (per row)
const isCommentModalOpen = ref(false);
const commentTargetPageId = ref<string | null>(null);
const commentModalInitial = ref<ComposerComment[]>([]);

const openRowCommentModal = (row: PageRow) => {
  commentTargetPageId.value = row.pageId;
  commentModalInitial.value = row.comments;
  isCommentModalOpen.value = true;
};

const onCommentSave = (list: ComposerComment[]) => {
  const target = rows.value.find((r) => r.pageId === commentTargetPageId.value);
  if (target) target.comments = list;
  isCommentModalOpen.value = false;
};

const commentSummary = (row: PageRow) => {
  const list = filledComments(row.comments);
  if (list.length === 0) return "Add auto-comments";
  return list
    .map((c, i) => `${i + 1}. ${c.text.trim() || "(photo)"}${c.imageMediaId && c.text.trim() ? " + photo" : ""} — ${delayLabel(c.delayMinutes)}`)
    .join("\n");
};

// Submit
const isSubmitting = ref(false);

const handleSubmitAll = async () => {
  if (rows.value.length === 0) {
    toast.warning("Select at least one Page.");
    return;
  }
  if (rows.value.some((r) => r.isUploading)) {
    toast.info("Please wait for the videos to finish uploading.");
    return;
  }
  if (!slotAllowed.value) {
    toast.warning("The publish time must be at least 5 minutes from now.");
    return;
  }

  let firstError = "";
  rows.value.forEach((r) => {
    const keepUploadError = r.mediaFile && !r.mediaId ? r.errorMessage : "";
    let err = "";
    if (!r.mediaId) err = keepUploadError || "No video yet.";
    else err = validateComments(r.comments);
    r.errorMessage = err;
    if (err && !firstError) firstError = `${pageName(r.pageId)}: ${err}`;
  });
  if (firstError) {
    toast.warning(firstError);
    return;
  }

  isSubmitting.value = true;
  try {
    const res = await api.createBulkTasks({
      tasks: rows.value.map((r) => ({
        facebook_page_ids: [r.pageId],
        caption: r.caption.trim(),
        media_id: r.mediaId,
        schedule_date: scheduleDate.value,
        schedule_time: scheduleTime.value,
        comments: toCommentPayload(r.comments)
      }))
    });
    toast.success(res?.message || `Scheduled ${res?.created_count || rows.value.length} post(s).`);
    selectedPageIds.value = [];
    rows.value = [];
    emit("tasks-created");
  } catch (err: any) {
    toast.error(err?.message || "Could not schedule the posts.");
  } finally {
    isSubmitting.value = false;
  }
};
</script>

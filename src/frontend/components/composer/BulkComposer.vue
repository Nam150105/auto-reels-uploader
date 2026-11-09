<template>
  <div class="h-full flex flex-col p-4 lg:p-6 overflow-y-auto select-none">
    <!-- Top bar: post count & submit -->
    <div class="flex flex-wrap items-center justify-between gap-3 mb-4 bg-white p-3.5 rounded-2xl border border-slate-200/80 shadow-xs">
      <div class="flex items-center gap-2">
        <span class="w-2.5 h-2.5 rounded-full bg-indigo-500"></span>
        <span class="text-xs font-bold text-slate-800">
          Tổng số bài đăng hàng loạt: <strong class="text-indigo-600 font-extrabold">{{ rows.length }}</strong> bài
        </span>
      </div>

      <div class="flex items-center gap-2.5">
        <button
          type="button"
          @click="addNewRow"
          class="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 font-bold text-xs border border-blue-200/80 shadow-2xs transition"
        >
          <span class="text-base font-normal leading-none">+</span>
          <span>Tạo 1 bài đăng mới</span>
        </button>

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
    </div>

    <!-- Bulk posts table -->
    <div class="bg-white rounded-2xl border border-slate-200/80 overflow-hidden shadow-xs flex-1 flex flex-col min-h-[350px]">
      <div class="overflow-x-auto flex-1 scrollbar-thin">
        <table class="w-full text-xs text-left">
          <thead class="bg-slate-50/80 text-slate-600 font-bold border-b border-slate-200/80">
            <tr>
              <th class="py-3 px-4 w-10 text-center">#</th>
              <th class="py-3 px-4 w-64">Kênh đăng</th>
              <th class="py-3 px-4 min-w-[240px]">Nội dung (Caption)</th>
              <th class="py-3 px-4 w-28 text-center">Video Reels</th>
              <th class="py-3 px-4 w-48">Thời gian đăng (GMT+7)</th>
              <th class="py-3 px-4 w-28 text-center">Bình luận</th>
              <th class="py-3 px-4 w-12 text-center"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="(row, idx) in rows" :key="row.id" class="hover:bg-blue-50/20 transition group align-top">
              <td class="py-3.5 px-4 text-center text-slate-400 font-bold">{{ idx + 1 }}</td>

              <!-- Pages -->
              <td class="py-3.5 px-4">
                <div class="relative">
                  <div
                    @click="togglePagePicker(row, $event)"
                    class="px-2.5 py-1.5 rounded-xl border border-slate-200/90 bg-white hover:border-blue-400 text-xs cursor-pointer flex items-center justify-between transition shadow-2xs"
                  >
                    <span v-if="row.selectedPageIds.length === 0" class="text-slate-400 font-medium">Chọn Fanpage...</span>
                    <span v-else class="text-slate-800 font-semibold truncate">
                      {{ getSelectedPagesSummary(row.selectedPageIds) }}
                    </span>
                    <svg class="w-3.5 h-3.5 text-slate-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>

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
                    <div v-else-if="row.isUploading" class="text-[10px] font-bold text-blue-600">
                      {{ row.uploadProgress || 0 }}%
                    </div>
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

              <!-- Publish time -->
              <td class="py-3.5 px-4">
                <button
                  type="button"
                  @click="openRowCalendar(row)"
                  class="w-full px-2.5 py-1.5 rounded-xl border bg-white hover:border-blue-400 text-xs flex items-center justify-between transition shadow-2xs"
                  :class="isScheduleSlotAllowed(row.scheduleDate, row.scheduleTime) ? 'border-slate-200/90 text-slate-700' : 'border-rose-300 text-rose-600'"
                  :title="isScheduleSlotAllowed(row.scheduleDate, row.scheduleTime) ? '' : 'Thời gian này đã qua. Vui lòng chọn giờ mới.'"
                >
                  <span class="flex items-center gap-1.5 truncate font-medium">
                    <svg class="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    <span>{{ formatSlot(row.scheduleDate, row.scheduleTime) }}</span>
                  </span>
                  <svg class="w-3.5 h-3.5 text-slate-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
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

              <!-- Delete row -->
              <td class="py-3.5 px-4 text-center">
                <button
                  type="button"
                  @click="deleteRow(idx)"
                  class="p-1 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition"
                  title="Xóa bài đăng này"
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

      <div class="p-3 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between">
        <button
          type="button"
          @click="addNewRow"
          class="flex items-center gap-1.5 text-xs font-bold text-blue-600 hover:text-blue-700 transition px-2.5 py-1.5 rounded-lg hover:bg-blue-50/60"
        >
          <span class="text-base font-bold leading-none">+</span>
          <span>Tạo 1 bài đăng mới</span>
        </button>
      </div>
    </div>

    <Teleport to="body">
      <template v-if="pickerRow">
        <!-- click outside closes the picker -->
        <div class="fixed inset-0 z-[60]" @click="closePagePicker"></div>
        <div
          ref="pickerPanelRef"
          class="fixed w-80 bg-white rounded-2xl shadow-xl border border-slate-200 p-3 z-[61]"
          :style="{ top: `${pickerPos.top}px`, left: `${pickerPos.left}px` }"
        >
          <PagePicker v-model="pickerRow.selectedPageIds" :pages="pages" list-class="max-h-64" />
          <div class="flex items-center justify-between gap-2 pt-2 mt-2 border-t border-slate-100">
            <button
              v-if="rows.length > 1"
              type="button"
              @click="applyPagesToAllRows(pickerRow)"
              class="text-[11px] font-bold text-blue-600 hover:text-blue-700"
            >
              Áp dụng cho tất cả bài viết
            </button>
            <span v-else></span>
            <button
              type="button"
              @click="closePagePicker"
              class="px-3.5 py-1 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-[11px] font-bold shadow-2xs"
            >
              Xong
            </button>
          </div>
        </div>
      </template>
    </Teleport>

    <CalendarPickerModal
      :isOpen="isCalendarOpen"
      :initialDate="calendarInitialDate"
      :initialTime="calendarInitialTime"
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
import { computed, onBeforeUnmount, ref } from "vue";
import { usePages } from "../../composables/usePages";
import { useToast } from "../../composables/useToast";
import { api } from "../../services/api";
import { getDefaultScheduleTime, isScheduleSlotAllowed } from "../../utils/date";
import { filledComments, toCommentPayload, validateComments, delayLabel } from "../../utils/comments";
import type { BulkComposerRow, ComposerComment } from "@shared/types";
import CalendarPickerModal from "../dialogs/CalendarPickerModal.vue";
import BulkCommentModal from "../dialogs/BulkCommentModal.vue";
import PagePicker from "./PagePicker.vue";

const emit = defineEmits<{
  (e: "tasks-created"): void;
}>();

const { pages } = usePages();
const toast = useToast();

const def = getDefaultScheduleTime();

const formatSlot = (date: string, time: string) => {
  const [y, m, d] = (date || "").split("-");
  return y && m && d ? `${time} ${d}/${m}/${y}` : `${date} ${time}`;
};

const createEmptyRow = (initialPages?: string[]): BulkComposerRow => {
  const slot = getDefaultScheduleTime();
  return {
    id: `row_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    selectedPageIds: initialPages && initialPages.length ? [...initialPages] : pages.value.length > 0 ? [pages.value[0].facebook_page_id] : [],
    caption: "",
    mediaFile: null,
    mediaFileName: "",
    mediaPreviewUrl: "",
    mediaId: "",
    uploadProgress: 0,
    isUploading: false,
    scheduleDate: slot.date,
    scheduleTime: slot.time,
    comments: []
  };
};

const rows = ref<BulkComposerRow[]>([createEmptyRow()]);
const activeChannelPopoverRowId = ref<string | null>(null);
const pickerRow = computed(() => rows.value.find((r) => r.id === activeChannelPopoverRowId.value) || null);
const pickerPos = ref({ top: 0, left: 0 });
const pickerPanelRef = ref<HTMLElement | null>(null);
const PICKER_WIDTH = 320;
const PICKER_HEIGHT = 460;

/** Close when the page scrolls or resizes (but not when scrolling inside the picker itself) */
const onViewportChange = (e: Event) => {
  const target = e.target as Node | null;
  if (target && pickerPanelRef.value && pickerPanelRef.value.contains(target)) return;
  closePagePicker();
};

const closePagePicker = () => {
  activeChannelPopoverRowId.value = null;
  window.removeEventListener("scroll", onViewportChange, true);
  window.removeEventListener("resize", onViewportChange);
};

const togglePagePicker = (row: BulkComposerRow, e: MouseEvent) => {
  if (activeChannelPopoverRowId.value === row.id) {
    closePagePicker();
    return;
  }
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const fitsBelow = rect.bottom + 4 + PICKER_HEIGHT <= window.innerHeight;
  pickerPos.value = {
    top: fitsBelow ? rect.bottom + 4 : Math.max(8, rect.top - 4 - PICKER_HEIGHT),
    left: Math.max(8, Math.min(rect.left, window.innerWidth - PICKER_WIDTH - 8))
  };
  activeChannelPopoverRowId.value = row.id;
  window.addEventListener("scroll", onViewportChange, true);
  window.addEventListener("resize", onViewportChange);
};

onBeforeUnmount(closePagePicker);

const isCalendarOpen = ref(false);
const calendarTargetRowId = ref<string | null>(null);
const calendarInitialDate = ref(def.date);
const calendarInitialTime = ref(def.time);

const isCommentModalOpen = ref(false);
const commentTargetRowId = ref<string | null>(null);
const commentModalInitial = ref<ComposerComment[]>([]);

const isSubmitting = ref(false);

/** A new post starts with the same Pages as the post above it */
const addNewRow = () => {
  const last = rows.value[rows.value.length - 1];
  rows.value.push(createEmptyRow(last?.selectedPageIds));
};

const deleteRow = (idx: number) => {
  if (rows.value.length === 1) {
    rows.value[0] = createEmptyRow();
    return;
  }
  rows.value.splice(idx, 1);
};

const getSelectedPagesSummary = (ids: string[]) => {
  if (ids.length === 0) return "No Page selected";
  if (ids.length === 1) {
    const p = pages.value.find((x) => x.facebook_page_id === ids[0]);
    return p?.page_name || ids[0];
  }
  return `${ids.length} Pages selected`;
};

const applyPagesToAllRows = (source: BulkComposerRow) => {
  rows.value.forEach((r) => {
    r.selectedPageIds = [...source.selectedPageIds];
  });
  toast.success(`Applied ${source.selectedPageIds.length} Page(s) to all ${rows.value.length} posts.`);
  closePagePicker();
};

const commentSummary = (row: BulkComposerRow) => {
  const list = filledComments(row.comments);
  if (list.length === 0) return "Add auto-comments";
  return list
    .map((c, i) => `${i + 1}. ${c.text.trim() || "(photo)"}${c.imageMediaId && c.text.trim() ? " + photo" : ""} — ${delayLabel(c.delayMinutes)}`)
    .join("\n");
};

const handleRowFileChange = async (row: BulkComposerRow, e: Event) => {
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

// Calendar
const openRowCalendar = (row: BulkComposerRow) => {
  calendarTargetRowId.value = row.id;
  calendarInitialDate.value = row.scheduleDate;
  calendarInitialTime.value = row.scheduleTime;
  isCalendarOpen.value = true;
};

const onCalendarConfirm = (val: { date: string; time: string }) => {
  const target = rows.value.find((r) => r.id === calendarTargetRowId.value);
  if (target) {
    target.scheduleDate = val.date;
    target.scheduleTime = val.time;
  }
  isCalendarOpen.value = false;
};

// Comments
const openRowCommentModal = (row: BulkComposerRow) => {
  commentTargetRowId.value = row.id;
  commentModalInitial.value = row.comments;
  isCommentModalOpen.value = true;
};

const onCommentSave = (list: ComposerComment[]) => {
  const target = rows.value.find((r) => r.id === commentTargetRowId.value);
  if (target) target.comments = list;
  isCommentModalOpen.value = false;
};

// Submit all
const handleSubmitAll = async () => {
  if (rows.value.some((r) => r.isUploading)) {
    toast.info("Please wait for the videos to finish uploading.");
    return;
  }

  // Fully empty rows are skipped; the rest must be complete
  const candidateRows = rows.value.filter((r) => r.mediaFile || r.mediaId || r.caption.trim());
  rows.value.forEach((r) => (r.errorMessage = r.mediaFile && !r.mediaId ? r.errorMessage : ""));
  let firstError = "";
  candidateRows.forEach((r) => {
    const idx = rows.value.indexOf(r) + 1;
    let err = "";
    if (r.selectedPageIds.length === 0) err = "No Page selected.";
    else if (!r.mediaId) err = r.errorMessage || "No video yet.";
    else if (!isScheduleSlotAllowed(r.scheduleDate, r.scheduleTime)) {
      err = "The publish time must be at least 5 minutes from now.";
    } else {
      err = validateComments(r.comments);
    }
    if (err) {
      r.errorMessage = err;
      if (!firstError) firstError = `Post #${idx}: ${err}`;
    }
  });

  if (candidateRows.length === 0) {
    toast.warning("Choose a video and at least one Page for at least one post.");
    return;
  }
  if (firstError) {
    toast.warning(firstError);
    return;
  }

  isSubmitting.value = true;
  try {
    const res = await api.createBulkTasks({
      tasks: candidateRows.map((r) => ({
        facebook_page_ids: r.selectedPageIds,
        caption: r.caption.trim(),
        media_id: r.mediaId || undefined,
        schedule_date: r.scheduleDate,
        schedule_time: r.scheduleTime,
        comments: toCommentPayload(r.comments)
      }))
    });
    toast.success(res?.message || `Scheduled ${res?.created_count || candidateRows.length} post(s).`);
    rows.value = [createEmptyRow()];
    emit("tasks-created");
  } catch (err: any) {
    toast.error(err?.message || "Could not schedule the posts.");
  } finally {
    isSubmitting.value = false;
  }
};
</script>

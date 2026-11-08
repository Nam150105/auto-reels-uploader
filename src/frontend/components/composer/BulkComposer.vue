<template>
  <div class="h-full flex flex-col p-4 lg:p-6 overflow-y-auto select-none">
    <!-- Top bar: post count & submit -->
    <div class="flex flex-wrap items-center justify-end gap-3 mb-4 bg-white p-3 rounded-2xl border border-slate-200 shadow-xs">
      <span class="text-xs text-slate-500 font-medium">
        Posts: <strong class="text-slate-800">{{ rows.length }}</strong>
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
        <span>{{ isSubmitting ? "Scheduling..." : "Schedule posts" }}</span>
      </button>
    </div>

    <!-- Bulk posts table -->
    <div class="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs flex-1 flex flex-col min-h-[350px]">
      <div class="overflow-x-auto flex-1 scrollbar-thin">
        <table class="w-full text-xs text-left">
          <thead class="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
            <tr>
              <th class="py-3 px-4 w-10 text-center">#</th>
              <th class="py-3 px-4 w-64">Pages</th>
              <th class="py-3 px-4 min-w-[240px]">Caption</th>
              <th class="py-3 px-4 w-28 text-center">Video</th>
              <th class="py-3 px-4 w-48">Publish time (GMT+7)</th>
              <th class="py-3 px-4 w-28 text-center">Comments</th>
              <th class="py-3 px-4 w-12 text-center"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="(row, idx) in rows" :key="row.id" class="hover:bg-slate-50/60 transition group align-top">
              <td class="py-3 px-4 text-center text-slate-400 font-semibold">{{ idx + 1 }}</td>

              <!-- Pages -->
              <td class="py-3 px-4">
                <div class="relative">
                  <div
                    @click="activeChannelPopoverRowId = activeChannelPopoverRowId === row.id ? null : row.id"
                    class="px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:border-blue-400 text-xs cursor-pointer flex items-center justify-between transition"
                  >
                    <span v-if="row.selectedPageIds.length === 0" class="text-slate-400">Select Pages</span>
                    <span v-else class="text-slate-800 font-medium truncate">
                      {{ getSelectedPagesSummary(row.selectedPageIds) }}
                    </span>
                    <svg class="w-3.5 h-3.5 text-slate-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>

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
                    <p v-if="pages.length === 0" class="p-2 text-slate-400">No Pages connected yet.</p>
                  </div>
                </div>
              </td>

              <!-- Caption -->
              <td class="py-3 px-4">
                <textarea
                  v-model="row.caption"
                  rows="2"
                  placeholder="Write a caption..."
                  class="w-full px-3 py-1.5 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 resize-none transition"
                ></textarea>
                <p v-if="row.errorMessage" class="mt-1 text-[11px] text-rose-600 font-medium">{{ row.errorMessage }}</p>
              </td>

              <!-- Video -->
              <td class="py-3 px-4 text-center">
                <div class="flex items-center justify-center">
                  <label
                    class="cursor-pointer p-1.5 rounded-lg border border-dashed border-slate-300 hover:border-blue-500 hover:bg-blue-50 transition relative"
                    :title="row.mediaFileName || 'Choose a video'"
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
                      <span class="max-w-[60px] truncate">Retry</span>
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
              <td class="py-3 px-4">
                <button
                  type="button"
                  @click="openRowCalendar(row)"
                  class="w-full px-2.5 py-1.5 rounded-lg border bg-white hover:border-blue-400 text-xs flex items-center justify-between transition"
                  :class="isScheduleSlotAllowed(row.scheduleDate, row.scheduleTime) ? 'border-slate-200 text-slate-700' : 'border-rose-300 text-rose-600'"
                  :title="isScheduleSlotAllowed(row.scheduleDate, row.scheduleTime) ? '' : 'This time has passed. Please pick a new one.'"
                >
                  <span class="flex items-center gap-1.5 truncate">
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
              <td class="py-3 px-4 text-center">
                <button
                  type="button"
                  @click="openRowCommentModal(row)"
                  class="inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-semibold transition"
                  :class="filledComments(row.comments).length ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-500 hover:border-blue-400 hover:text-blue-600'"
                  :title="commentSummary(row)"
                >
                  <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                  <span>{{ filledComments(row.comments).length ? filledComments(row.comments).length : "Add" }}</span>
                </button>
              </td>

              <!-- Delete row -->
              <td class="py-3 px-4 text-center">
                <button
                  type="button"
                  @click="deleteRow(idx)"
                  class="p-1 text-slate-400 hover:text-rose-500 rounded transition"
                  title="Remove this post"
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
          class="flex items-center gap-1.5 text-xs font-bold text-blue-600 hover:text-blue-700 transition px-2 py-1"
        >
          <span class="text-base font-normal">+</span>
          <span>Add a post</span>
        </button>
      </div>
    </div>

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
import { ref } from "vue";
import { usePages } from "../../composables/usePages";
import { useToast } from "../../composables/useToast";
import { api } from "../../services/api";
import { getDefaultScheduleTime, isScheduleSlotAllowed } from "../../utils/date";
import { filledComments, toCommentPayload, validateComments, delayLabel } from "../../utils/comments";
import type { BulkComposerRow, ComposerComment } from "@shared/types";
import CalendarPickerModal from "../dialogs/CalendarPickerModal.vue";
import BulkCommentModal from "../dialogs/BulkCommentModal.vue";

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

const createEmptyRow = (): BulkComposerRow => {
  const slot = getDefaultScheduleTime();
  return {
    id: `row_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    selectedPageIds: pages.value.length > 0 ? [pages.value[0].facebook_page_id] : [],
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

const isCalendarOpen = ref(false);
const calendarTargetRowId = ref<string | null>(null);
const calendarInitialDate = ref(def.date);
const calendarInitialTime = ref(def.time);

const isCommentModalOpen = ref(false);
const commentTargetRowId = ref<string | null>(null);
const commentModalInitial = ref<ComposerComment[]>([]);

const isSubmitting = ref(false);

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
  if (ids.length === 0) return "No Page selected";
  if (ids.length === 1) {
    const p = pages.value.find((x) => x.facebook_page_id === ids[0]);
    return p?.page_name || ids[0];
  }
  return `${ids.length} Pages selected`;
};

const toggleRowChannel = (row: BulkComposerRow, pageId: string) => {
  if (row.selectedPageIds.includes(pageId)) {
    row.selectedPageIds = row.selectedPageIds.filter((id) => id !== pageId);
  } else {
    row.selectedPageIds.push(pageId);
  }
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

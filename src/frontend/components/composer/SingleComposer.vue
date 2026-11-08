<template>
  <div class="h-full flex flex-col lg:flex-row gap-4 p-4 lg:p-6 overflow-y-auto">
    <!-- COLUMN 1: Select Pages -->
    <div class="w-full lg:w-72 bg-white rounded-2xl border border-slate-200 p-4 flex flex-col flex-shrink-0 shadow-xs max-h-[85vh]">
      <h3 class="font-bold text-sm text-slate-800 pb-3 mb-3 border-b border-slate-100">Pages</h3>
      <PagePicker v-model="selectedPageIds" :pages="pages" class="flex-1 min-h-0" />
    </div>

    <!-- COLUMN 2: Caption & media -->
    <div class="flex-1 bg-white rounded-2xl border border-slate-200 p-4 lg:p-6 flex flex-col shadow-xs max-h-[85vh] overflow-y-auto">
      <div class="flex items-center justify-between pb-3 border-b border-slate-100 mb-4">
        <div class="flex items-center gap-2">
          <span class="font-bold text-sm text-slate-800">New Reel</span>
        </div>
      </div>

      <!-- Caption Textarea -->
      <div class="border border-slate-200 rounded-2xl p-3 mb-4 focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500/20 transition">
        <textarea
          v-model="caption"
          rows="4"
          placeholder="Write a caption..."
          class="w-full resize-none text-xs sm:text-sm text-slate-800 focus:outline-none placeholder:text-slate-400"
        ></textarea>

        <div class="flex items-center justify-end pt-2 border-t border-slate-100 mt-2">
          <span class="text-[11px] text-slate-400 font-mono">{{ caption.length }} characters</span>
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
            accept="video/mp4,video/quicktime,video/x-m4v,video/webm,.mp4,.mov,.m4v,.webm"
            class="hidden"
            @change="handleFileChange"
            @click.stop
          />

          <div v-if="!mediaFile && !mediaPreviewUrl" class="flex flex-col items-center gap-2">
            <div class="w-12 h-12 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center">
              <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <p class="text-xs font-semibold text-slate-700">
              Drop a video here or <span class="text-blue-600 underline">browse your computer</span>
            </p>
            <p class="text-[11px] text-slate-400">MP4, MOV or WEBM. Vertical 9:16 videos look best as Reels.</p>
          </div>

          <!-- Video Selected & Upload Status -->
          <div v-else class="flex items-center justify-between p-2">
            <div class="flex items-center gap-3 text-left min-w-0">
              <div
                class="w-10 h-10 rounded-lg text-white flex items-center justify-center font-bold text-[10px] flex-shrink-0"
                :class="uploadError ? 'bg-rose-500' : 'bg-blue-600'"
              >
                {{ fileExtLabel }}
              </div>
              <div class="min-w-0">
                <p class="text-xs font-bold text-slate-800 truncate">{{ mediaFileName || 'video' }}</p>
                <p class="text-[11px] text-slate-500">
                  <span v-if="isUploading">Uploading... {{ uploadProgress }}%</span>
                  <span v-else-if="uploadError" class="text-rose-600 font-semibold">{{ uploadError }} Click to choose again.</span>
                  <span v-else-if="mediaId" class="text-emerald-600 font-semibold">✓ Video is ready</span>
                </p>
              </div>
            </div>

            <button
              type="button"
              @click.stop="clearMedia"
              class="text-slate-400 hover:text-rose-500 p-2 rounded-lg transition"
              title="Remove video"
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

      <!-- Auto-comments -->
      <div class="border border-slate-200 rounded-2xl p-4 mb-4 space-y-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <svg class="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <span class="text-xs font-bold text-slate-800">Auto-comments</span>
            <span v-if="filledComments(comments).length" class="text-[11px] text-slate-400">({{ filledComments(comments).length }})</span>
          </div>
          <label class="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="enableComment" class="sr-only peer" />
            <div class="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
          </label>
        </div>
        <p v-if="!enableComment" class="text-[11px] text-slate-400">
          The Page can post one or more comments under the Reel, each at its own time.
        </p>
        <div v-else class="pt-2 border-t border-slate-100">
          <CommentListEditor v-model="comments" />
        </div>
      </div>

      <!-- Bottom Bar: Publish Mode & Schedule & Submit -->
      <div class="mt-auto pt-4 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3">
        <!-- Publish mode: now vs schedule -->
        <div class="flex items-center gap-2 bg-slate-100 p-1 rounded-xl text-xs font-semibold">
          <button
            type="button"
            @click="publishMode = 'now'"
            class="px-3 py-1.5 rounded-lg transition"
            :class="publishMode === 'now' ? 'bg-white text-blue-600 shadow-xs' : 'text-slate-600 hover:text-slate-900'"
          >
            Publish now
          </button>
          <button
            type="button"
            @click="switchToSchedule"
            class="px-3 py-1.5 rounded-lg transition"
            :class="publishMode === 'schedule' ? 'bg-white text-blue-600 shadow-xs' : 'text-slate-600 hover:text-slate-900'"
          >
            Schedule
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
          :disabled="isSubmitting || isUploading || selectedPageIds.length === 0 || !mediaId"
          @click="handleSubmit"
          class="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold text-xs sm:text-sm shadow-md shadow-blue-500/20 transition flex items-center justify-center gap-2"
        >
          <svg v-if="isSubmitting" class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
          </svg>
          <span>{{ isSubmitting ? 'Working...' : publishMode === 'now' ? 'Publish now' : 'Schedule post' }}</span>
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
    toast.warning("Please choose a video file (MP4, MOV, WEBM).");
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
    if (seq !== uploadSeq) return; // the user picked another video
    mediaId.value = res.media_id;
  } catch (err: any) {
    if (seq !== uploadSeq) return;
    uploadError.value = err?.message || "Video upload failed.";
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
    toast.warning("Please select at least one Page.");
    return;
  }
  if (isUploading.value) {
    toast.info("Please wait for the video to finish uploading.");
    return;
  }
  if (!mediaId.value) {
    toast.warning("Please choose a video to publish.");
    return;
  }
  if (publishMode.value === "schedule" && !isScheduleSlotAllowed(scheduleDate.value, scheduleTime.value)) {
    toast.warning("The scheduled time must be at least 5 minutes from now. Please pick a new time.");
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

    toast.success(res?.message || (publishMode.value === "now" ? "Publishing to Facebook." : "Post scheduled."));
    // Reset form
    caption.value = "";
    clearMedia();
    enableComment.value = false;
    comments.value = [createEmptyComment()];
    emit("task-created");
  } catch (err: any) {
    toast.error(err?.message || "Could not create the post.");
  } finally {
    isSubmitting.value = false;
  }
};
</script>

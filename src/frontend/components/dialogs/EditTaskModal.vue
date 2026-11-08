<template>
  <div v-if="isOpen && task" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" @click.self="$emit('close')">
    <div class="bg-white rounded-2xl shadow-2xl border border-slate-100 max-w-lg w-full p-6 animate-in fade-in zoom-in duration-150 select-none">
      <div class="flex items-center justify-between pb-3 border-b border-slate-100 mb-4">
        <h3 class="text-base font-bold text-slate-800">
          Edit post #{{ task.id }}
        </h3>
        <button type="button" @click="$emit('close')" class="text-slate-400 hover:text-slate-600 p-1 rounded-lg transition">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="space-y-4 text-xs">
        <!-- Page Info -->
        <div class="flex items-center gap-2.5 p-2 rounded-xl bg-slate-50 border border-slate-200">
          <div class="w-8 h-8 rounded-full bg-slate-200 overflow-hidden flex-shrink-0">
            <img v-if="task.page_avatar" :src="task.page_avatar" class="w-full h-full object-cover" />
            <span v-else class="w-full h-full flex items-center justify-center font-bold text-slate-500 text-[10px]">FB</span>
          </div>
          <div>
            <span class="font-bold text-slate-800 block">{{ task.page_name || task.facebook_page_id }}</span>
            <span class="text-[10px] text-slate-500">Page ID: {{ task.facebook_page_id }}</span>
          </div>
        </div>

        <!-- Caption -->
        <div>
          <label class="block font-semibold text-slate-700 mb-1">Caption:</label>
          <textarea
            v-model="caption"
            rows="3"
            class="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
          ></textarea>
        </div>

        <!-- Schedule Date & Time -->
        <div>
          <label class="block font-semibold text-slate-700 mb-1">Publish time (Vietnam time, GMT+7):</label>
          <button
            type="button"
            @click="isCalendarOpen = true"
            class="w-full px-3 py-2 text-xs rounded-xl border bg-white flex items-center justify-between transition hover:border-blue-400"
            :class="isScheduleSlotAllowed(scheduleDate, scheduleTime) ? 'border-slate-200 text-slate-800' : 'border-rose-300 text-rose-600'"
          >
            <span>{{ scheduleDisplay }}</span>
            <svg class="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </button>
          <p v-if="!isScheduleSlotAllowed(scheduleDate, scheduleTime)" class="mt-1 text-[11px] text-rose-600">
            This time has passed. Please pick a time at least 5 minutes from now.
          </p>
        </div>

        <!-- First Comment -->
        <div>
          <label class="block font-semibold text-slate-700 mb-1">First comment:</label>
          <input
            v-model="commentText"
            type="text"
            placeholder="Auto-comment text..."
            class="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      </div>

      <div class="flex items-center justify-end gap-2 pt-4 mt-4 border-t border-slate-100">
        <button
          type="button"
          @click="$emit('close')"
          class="px-4 py-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50 font-medium text-xs transition"
        >
          Cancel
        </button>
        <button
          type="button"
          :disabled="isSubmitting"
          @click="submitUpdate"
          class="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold text-xs shadow-sm transition flex items-center gap-1.5"
        >
          <svg v-if="isSubmitting" class="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
          </svg>
          <span>{{ isSubmitting ? 'Saving...' : 'Save changes' }}</span>
        </button>
      </div>
    </div>

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
import { ref, watch, computed } from "vue";
import CalendarPickerModal from "./CalendarPickerModal.vue";
import { isScheduleSlotAllowed } from "../../utils/date";
import type { TaskRecord } from "@shared/types";
import { api } from "../../services/api";
import { useToast } from "../../composables/useToast";

const props = defineProps<{
  isOpen: boolean;
  task: TaskRecord | null;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "updated"): void;
}>();

const toast = useToast();
const caption = ref("");
const scheduleDate = ref("");
const scheduleTime = ref("");
const commentText = ref("");
const isSubmitting = ref(false);
const isCalendarOpen = ref(false);

const scheduleDisplay = computed(() => {
  const [y, m, d] = (scheduleDate.value || "").split("-");
  return y && m && d ? `${scheduleTime.value} on ${d}/${m}/${y}` : "Select publish time";
});

const onCalendarConfirm = (val: { date: string; time: string }) => {
  scheduleDate.value = val.date;
  scheduleTime.value = val.time;
};

watch(
  () => props.task,
  (t) => {
    if (t) {
      caption.value = t.caption || "";
      scheduleDate.value = t.schedule_date || "";
      scheduleTime.value = t.schedule_time || "";
      commentText.value = t.comment_text || "";
    }
  },
  { immediate: true }
);

const submitUpdate = async () => {
  if (!props.task) return;
  if (!isScheduleSlotAllowed(scheduleDate.value, scheduleTime.value)) {
    toast.warning("Publish time must be at least 5 minutes from now. Please pick another time.");
    isCalendarOpen.value = true;
    return;
  }
  isSubmitting.value = true;
  try {
    await api.updateTask(props.task.id, {
      caption: caption.value.trim(),
      schedule_date: scheduleDate.value.trim(),
      schedule_time: scheduleTime.value.trim(),
      comment_text: commentText.value.trim() || undefined
    });
    toast.success("Post updated.");
    emit("updated");
    emit("close");
  } catch (err: any) {
    toast.error(err?.message || "Failed to update post.");
  } finally {
    isSubmitting.value = false;
  }
};
</script>

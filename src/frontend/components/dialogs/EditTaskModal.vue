<template>
  <div v-if="isOpen && task" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" @click.self="$emit('close')">
    <div class="bg-white rounded-2xl shadow-2xl border border-slate-100 max-w-lg w-full p-6 animate-in fade-in zoom-in duration-150 select-none">
      <div class="flex items-center justify-between pb-3 border-b border-slate-100 mb-4">
        <h3 class="text-base font-bold text-slate-800">
          Chỉnh sửa bài đăng #{{ task.id }}
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
          <label class="block font-semibold text-slate-700 mb-1">Nội dung (Caption):</label>
          <textarea
            v-model="caption"
            rows="3"
            class="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400 resize-none"
          ></textarea>
        </div>

        <!-- Schedule Date & Time -->
        <div>
          <label class="block font-semibold text-slate-700 mb-1">Thời gian đăng (Giờ Việt Nam GMT+7):</label>
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
            Thời gian này đã qua. Vui lòng chọn thời gian cách hiện tại ít nhất 5 phút.
          </p>
        </div>

        <!-- First Comment -->
        <div>
          <label class="block font-semibold text-slate-700 mb-1">Bình luận đầu tiên:</label>
          <input
            v-model="commentText"
            type="text"
            placeholder="Nội dung tự động bình luận..."
            class="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
          />
        </div>
      </div>

      <div class="flex items-center justify-end gap-2 pt-4 mt-4 border-t border-slate-100">
        <button
          type="button"
          @click="$emit('close')"
          class="px-4 py-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50 font-bold text-xs transition"
        >
          Hủy
        </button>
        <button
          type="button"
          :disabled="isSubmitting"
          @click="submitUpdate"
          class="px-5 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold text-xs shadow-xs transition disabled:opacity-50 flex items-center gap-1.5"
        >
          <svg v-if="isSubmitting" class="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
          </svg>
          <span>Lưu thay đổi</span>
        </button>
      </div>
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
import { ref, computed, watch } from "vue";
import { api } from "../../services/api";
import { useToast } from "../../composables/useToast";
import { isScheduleSlotAllowed, getDefaultScheduleTime } from "../../utils/date";
import type { TaskRecord } from "@shared/types";
import CalendarPickerModal from "./CalendarPickerModal.vue";

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
const isCalendarOpen = ref(false);
const isSubmitting = ref(false);

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

const scheduleDisplay = computed(() => {
  if (!scheduleDate.value || !scheduleTime.value) return "Chọn ngày & giờ đăng...";
  return `${scheduleDate.value} lúc ${scheduleTime.value}`;
});

const onCalendarConfirm = (val: { date: string; time: string }) => {
  scheduleDate.value = val.date;
  scheduleTime.value = val.time;
};

const submitUpdate = async () => {
  if (!props.task) return;

  if (!scheduleDate.value || !scheduleTime.value) {
    toast.warning("Vui lòng chọn ngày và giờ đăng.");
    return;
  }

  if (!isScheduleSlotAllowed(scheduleDate.value, scheduleTime.value)) {
    toast.warning("Thời gian hẹn giờ phải cách thời điểm hiện tại ít nhất 5 phút.");
    isCalendarOpen.value = true;
    return;
  }

  isSubmitting.value = true;
  try {
    await api.updateTask(props.task.id, {
      caption: caption.value.trim(),
      schedule_date: scheduleDate.value,
      schedule_time: scheduleTime.value,
      comment_text: commentText.value.trim()
    });

    toast.success("Cập nhật bài viết thành công!");
    emit("updated");
    emit("close");
  } catch (err: any) {
    toast.error(err?.message || "Cập nhật bài viết thất bại.");
  } finally {
    isSubmitting.value = false;
  }
};
</script>

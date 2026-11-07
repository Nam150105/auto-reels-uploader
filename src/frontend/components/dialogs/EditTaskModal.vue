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
        <!-- Fanpage Info -->
        <div class="flex items-center gap-2.5 p-2 rounded-xl bg-slate-50 border border-slate-200">
          <div class="w-8 h-8 rounded-full bg-slate-200 overflow-hidden flex-shrink-0">
            <img v-if="task.page_avatar" :src="task.page_avatar" class="w-full h-full object-cover" />
            <span v-else class="w-full h-full flex items-center justify-center font-bold text-slate-500 text-[10px]">FB</span>
          </div>
          <div>
            <span class="font-bold text-slate-800 block">{{ task.page_name || task.facebook_page_id }}</span>
            <span class="text-[10px] text-slate-500">ID Fanpage: {{ task.facebook_page_id }}</span>
          </div>
        </div>

        <!-- Caption -->
        <div>
          <label class="block font-semibold text-slate-700 mb-1">Nội dung bài viết:</label>
          <textarea
            v-model="caption"
            rows="3"
            class="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
          ></textarea>
        </div>

        <!-- Schedule Date & Time -->
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block font-semibold text-slate-700 mb-1">Ngày đăng (YYYY-MM-DD):</label>
            <input
              v-model="scheduleDate"
              type="date"
              class="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label class="block font-semibold text-slate-700 mb-1">Giờ đăng (HH:mm):</label>
            <input
              v-model="scheduleTime"
              type="time"
              class="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>

        <!-- First Comment -->
        <div>
          <label class="block font-semibold text-slate-700 mb-1">Bình luận đầu tiên:</label>
          <input
            v-model="commentText"
            type="text"
            placeholder="Nội dung bình luận tự động..."
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
          Hủy bỏ
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
          <span>{{ isSubmitting ? 'Đang lưu...' : 'Lưu thay đổi' }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
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
  isSubmitting.value = true;
  try {
    await api.updateTask(props.task.id, {
      caption: caption.value.trim(),
      schedule_date: scheduleDate.value.trim(),
      schedule_time: scheduleTime.value.trim(),
      comment_text: commentText.value.trim() || undefined
    });
    toast.success("Đã cập nhật thông tin bài đăng!");
    emit("updated");
    emit("close");
  } catch (err: any) {
    toast.error(err?.message || "Cập nhật bài đăng thất bại.");
  } finally {
    isSubmitting.value = false;
  }
};
</script>

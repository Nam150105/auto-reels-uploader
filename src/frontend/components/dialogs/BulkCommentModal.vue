<template>
  <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" @click.self="$emit('close')">
    <div class="bg-white rounded-2xl shadow-2xl border border-slate-100 max-w-2xl w-full p-6 animate-in fade-in zoom-in duration-150 select-none">
      <!-- Header -->
      <div class="flex items-center justify-between pb-4 border-b border-slate-100">
        <div class="flex items-center gap-2">
          <svg class="w-5 h-5 text-slate-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <h3 class="text-base font-bold text-slate-800">Bình luận hàng loạt</h3>
        </div>
        <button type="button" @click="$emit('close')" class="text-slate-400 hover:text-slate-600 p-1 rounded-lg transition">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Description Note -->
      <p class="text-xs text-slate-500 py-3 leading-relaxed">
        Sau khi bài đăng được đăng lên nền tảng (Facebook, Instagram, Tiktok, Youtube, Threads, X), hệ thống sẽ đẩy thêm bình luận vào dưới bài đăng đó theo cài đặt của bạn.
      </p>

      <!-- Comments Table -->
      <div class="border border-slate-200 rounded-xl overflow-hidden mb-4">
        <table class="w-full text-xs text-left">
          <thead class="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
            <tr>
              <th class="py-2.5 px-3 w-1/2">Bình luận</th>
              <th class="py-2.5 px-3 text-center w-16">Media</th>
              <th class="py-2.5 px-3 w-36">
                <span class="flex items-center gap-1">
                  Thời gian
                  <svg class="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </span>
              </th>
              <th class="py-2.5 px-3 text-center w-16">Hành động</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="(item, idx) in commentItems" :key="idx" class="hover:bg-slate-50/50">
              <!-- Comment Input -->
              <td class="py-2 px-3">
                <input
                  v-model="item.text"
                  type="text"
                  placeholder="Nhập nội dung bình luận..."
                  class="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                />
              </td>

              <!-- Media Icon Placeholder -->
              <td class="py-2 px-3 text-center">
                <button type="button" class="text-slate-400 hover:text-slate-600 p-1" title="Đính kèm ảnh (Tùy chọn)">
                  <svg class="w-4 h-4 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </button>
              </td>

              <!-- Timing Dropdown -->
              <td class="py-2 px-3">
                <select
                  v-model="item.delayOption"
                  class="w-full px-2 py-1.5 text-xs rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="now">Đăng ngay</option>
                  <option value="10m">10 phút</option>
                  <option value="30m">30 phút</option>
                  <option value="45m">45 phút</option>
                  <option value="1h">1 giờ</option>
                  <option value="2h">2 giờ</option>
                  <option value="6h">6 giờ</option>
                  <option value="12h">12 giờ</option>
                  <option value="24h">24 giờ</option>
                  <option value="36h">36 giờ</option>
                  <option value="72h">72 giờ</option>
                </select>
              </td>

              <!-- Trash Action -->
              <td class="py-2 px-3 text-center">
                <button
                  type="button"
                  @click="removeComment(idx)"
                  class="text-slate-400 hover:text-rose-500 p-1 rounded transition"
                  title="Xóa bình luận"
                >
                  <svg class="w-4 h-4 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- Add New Comment Row Button -->
        <div class="p-2.5 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
          <button
            type="button"
            @click="addComment"
            class="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700 transition px-2 py-1"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3m0 0v3m0-3h3m-3-3H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>Tạo bình luận mới</span>
          </button>
        </div>
      </div>

      <!-- Footer: Spin Tip & Actions -->
      <div class="flex items-center justify-between pt-3 border-t border-slate-100 text-xs">
        <span class="text-slate-500">
          Mẹo: Đa dạng hóa nội dung của bạn với <span class="text-blue-600 font-medium cursor-pointer">Chức năng Spin</span>.
        </span>

        <div class="flex items-center gap-2">
          <button
            type="button"
            @click="$emit('close')"
            class="px-4 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 font-medium transition"
          >
            Đóng
          </button>
          <button
            type="button"
            @click="saveComments"
            class="px-5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-sm transition"
          >
            Lưu
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";

interface CommentItem {
  text: string;
  delayOption: string;
}

const props = defineProps<{
  isOpen: boolean;
  initialText?: string;
  initialDelayOption?: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "save", val: { text: string; delayOption: string; delayMinutes: number }): void;
}>();

const commentItems = ref<CommentItem[]>([
  { text: props.initialText || "", delayOption: props.initialDelayOption || "now" }
]);

watch(
  () => props.isOpen,
  (open) => {
    if (open) {
      commentItems.value = [
        { text: props.initialText || "", delayOption: props.initialDelayOption || "now" }
      ];
    }
  }
);

const delayOptionToMinutes = (opt: string): number => {
  switch (opt) {
    case "now": return 0;
    case "10m": return 10;
    case "30m": return 30;
    case "45m": return 45;
    case "1h": return 60;
    case "2h": return 120;
    case "6h": return 360;
    case "12h": return 720;
    case "24h": return 1440;
    case "36h": return 2160;
    case "72h": return 4320;
    default: return 0;
  }
};

const addComment = () => {
  commentItems.value.push({ text: "", delayOption: "now" });
};

const removeComment = (idx: number) => {
  if (commentItems.value.length === 1) {
    commentItems.value[0].text = "";
    return;
  }
  commentItems.value.splice(idx, 1);
};

const saveComments = () => {
  // Join non-empty comments or take primary
  const first = commentItems.value[0] || { text: "", delayOption: "now" };
  emit("save", {
    text: first.text,
    delayOption: first.delayOption,
    delayMinutes: delayOptionToMinutes(first.delayOption)
  });
  emit("close");
};
</script>

<template>
  <div class="flex flex-col px-4 lg:px-6 pb-6 select-none">
    <!-- Thanh lọc cố định khi cuộn: tìm kiếm, khung giờ, thao tác hàng loạt -->
    <div class="sticky top-0 z-10 -mx-4 lg:-mx-6 px-4 lg:px-6 pt-4 pb-3 bg-[#f8fafc]/95 backdrop-blur-sm space-y-2">
      <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 bg-white p-2.5 rounded-2xl border border-slate-200/80 shadow-xs">
        <div class="relative flex-1 sm:max-w-xs">
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Tìm nội dung, tên Page hoặc ID..."
            class="w-full pl-8 pr-3 py-1.5 text-xs rounded-xl border border-slate-200/90 bg-slate-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400 transition"
          />
          <svg class="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>

        <!-- Lọc theo khung giờ đăng -->
        <div class="flex items-center gap-1 overflow-x-auto scrollbar-none">
          <span class="text-[11px] font-bold text-slate-400 shrink-0 mr-0.5">Khung giờ:</span>
          <button
            v-for="slot in slotOptions"
            :key="slot.key"
            type="button"
            class="px-2.5 py-1 rounded-lg text-[11px] font-bold transition shrink-0 border"
            :class="slotFilter === slot.key ? 'bg-violet-600 text-white border-violet-600' : 'bg-slate-50 text-slate-600 border-slate-200/70 hover:bg-slate-100'"
            @click="slotFilter = slot.key"
          >
            {{ slot.label }} <span class="opacity-70">{{ slot.count }}</span>
          </button>
        </div>

        <span class="sm:ml-auto text-[11px] text-slate-400 shrink-0">
          {{ visibleTasks.length }} bài<span v-if="lastRefreshedAt"> · cập nhật {{ formatClock(lastRefreshedAt) }}</span>
        </span>
      </div>

      <!-- Thanh thao tác khi đã chọn bài (cũng cố định) -->
      <div
        v-if="selectedTaskIds.length > 0"
        class="bg-blue-50 border border-blue-200 rounded-2xl p-2.5 flex flex-wrap items-center justify-between gap-2 shadow-xs"
      >
        <div class="flex items-center gap-2 text-xs font-bold text-blue-900">
          <span class="w-2 h-2 rounded-full bg-blue-600 animate-pulse"></span>
          <span>Đã chọn {{ selectedTaskIds.length }} bài viết</span>
          <button type="button" class="text-[11px] text-slate-500 hover:text-slate-700 font-semibold" @click="selectedTaskIds = []">Bỏ chọn</button>
        </div>

        <div class="flex items-center gap-2">
          <button
            type="button"
            @click="publishBulkNow"
            class="px-3 py-1.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-xs font-bold shadow-xs transition flex items-center gap-1.5"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span>Đăng ngay</span>
          </button>

          <button
            type="button"
            @click="bulkDelete"
            class="px-3 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200/80 text-xs font-bold shadow-2xs transition flex items-center gap-1.5"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            <span>Xóa</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Tasks Table -->
    <div class="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs shrink-0">
      <div class="overflow-x-auto scrollbar-thin">
        <table class="w-full text-xs text-left">
          <thead class="sticky top-0 z-10 bg-slate-50/95 backdrop-blur-md text-slate-600 font-bold border-b border-slate-200/80 shadow-2xs">
            <tr>
              <th class="py-2.5 px-2.5 w-10 text-center">
                <input
                  type="checkbox"
                  :checked="allVisibleSelected"
                  @change="toggleSelectAllVisible"
                  class="rounded text-blue-600 focus:ring-blue-500 border-slate-300 w-4 h-4"
                />
              </th>
              <th class="py-2.5 px-2.5 w-16 text-center hidden 2xl:table-cell">ID</th>
              <th class="py-2.5 px-2.5 w-56">Fanpage</th>
              <th class="py-2.5 px-2.5 min-w-[200px]">Nội dung & Media</th>
              <th class="py-2.5 px-2.5 w-40">Lịch đăng (GMT+7)</th>
              <th class="py-2.5 px-2.5 w-32 text-center">Trạng thái</th>
              <th class="py-2.5 px-2.5 w-44">Kết quả đăng</th>
              <th class="py-2.5 px-2.5 w-32 text-center">Thao tác</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr
              v-for="(task, taskIdx) in visibleTasks"
              :key="task.id"
              class="hover:bg-slate-50/70 transition"
              :class="{ 'bg-blue-50/20': selectedTaskIds.includes(task.id) }"
            >
              <!-- Checkbox: the whole cell is clickable, Shift + click selects a range -->
              <td
                class="py-2.5 px-2.5 text-center cursor-pointer"
                title="Giữ Shift + bấm để chọn nhiều bài liên tiếp"
                @mousedown.shift.prevent
                @click="onSelectCellClick(task.id, taskIdx, $event)"
              >
                <input
                  type="checkbox"
                  :checked="selectedTaskIds.includes(task.id)"
                  tabindex="-1"
                  class="rounded text-blue-600 focus:ring-blue-500 border-slate-300 w-4 h-4 pointer-events-none"
                />
              </td>

              <!-- ID -->
              <td class="py-2.5 px-2.5 text-center font-mono text-slate-400 text-[11px] hidden 2xl:table-cell">
                #{{ task.id }}
              </td>

              <!-- Page -->
              <td class="py-2.5 px-2.5">
                <div class="flex items-center gap-2 min-w-0">
                  <div class="w-7 h-7 rounded-full bg-slate-200 overflow-hidden flex-shrink-0 border border-slate-200">
                    <img v-if="task.page_avatar" :src="task.page_avatar" class="w-full h-full object-cover" />
                    <span v-else class="w-full h-full flex items-center justify-center font-bold text-slate-500 text-[9px]">FB</span>
                  </div>
                  <div class="min-w-0">
                    <p class="font-bold text-slate-800 truncate text-xs">{{ task.page_name || task.facebook_page_id }}</p>
                    <p class="text-[10px] text-slate-400 font-mono truncate">{{ task.facebook_page_id }}</p>
                  </div>
                </div>
              </td>

              <!-- Caption & Media -->
              <td class="py-2.5 px-2.5">
                <p class="text-slate-800 line-clamp-2 leading-relaxed">
                  {{ task.caption || '(Không có caption)' }}
                </p>
                <div class="flex items-center gap-2 mt-1">
                  <span v-if="task.media_id || task.video_path" class="inline-flex items-center gap-1 text-[10px] font-semibold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
                    🎬 Video
                  </span>
                  <span v-if="task.comment_text" class="inline-flex items-center gap-1 text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded truncate max-w-[150px]">
                    💬 {{ task.comment_text }}
                  </span>
                  <span
                    v-else-if="task.comments && task.comments.length"
                    class="inline-flex items-center gap-1 text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded truncate max-w-[180px]"
                    :title="commentsTooltip(task)"
                  >
                    💬 {{ task.comments.length }} bình luận
                  </span>
                </div>
              </td>

              <!-- Schedule Time -->
              <td class="py-2.5 px-2.5">
                <div class="text-xs font-medium text-slate-700">
                  <span>{{ task.schedule_date || '--' }}</span>
                  <span class="text-slate-400 mx-1">|</span>
                  <span class="font-bold text-slate-900">{{ task.schedule_time || '--' }}</span>
                </div>
                <span class="text-[10px] text-slate-400 block mt-0.5">Asia/Ho_Chi_Minh</span>
              </td>

              <!-- Status Badge -->
              <td class="py-2.5 px-2.5 text-center">
                <span
                  class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold"
                  :class="{
                    'bg-amber-50 text-amber-700 border border-amber-200': task.status === 'pending' || task.status === 'scheduled',
                    'bg-blue-50 text-blue-700 border border-blue-200 animate-pulse': task.status === 'running' || task.status === 'queued',
                    'bg-emerald-50 text-emerald-700 border border-emerald-200': task.status === 'success',
                    'bg-rose-50 text-rose-700 border border-rose-200': task.status === 'failed' || task.status === 'canceled'
                  }"
                >
                  <span class="w-1.5 h-1.5 rounded-full" :class="{
                    'bg-amber-500': task.status === 'pending' || task.status === 'scheduled',
                    'bg-blue-500': task.status === 'running' || task.status === 'queued',
                    'bg-emerald-500': task.status === 'success',
                    'bg-rose-500': task.status === 'failed' || task.status === 'canceled'
                  }"></span>
                  <span>{{ formatStatus(task.status) }}</span>
                </span>
              </td>

              <!-- Publish Result / Facebook Link -->
              <td class="py-2.5 px-2.5 text-xs">
                <!-- Success: Link to Facebook Post -->
                <div v-if="task.status === 'success'" class="space-y-1">
                  <a
                    :href="getFacebookUrl(task)"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-1 font-bold text-blue-600 hover:text-blue-800 hover:underline"
                  >
                    <span>Xem trên Facebook</span>
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>

                  <!-- Comment State -->
                  <div v-if="task.comment_text || (task.comments && task.comments.length)" class="text-[10px]">
                    <span v-if="task.comment_status === 'success'" class="text-emerald-600 font-semibold">
                      ✓ {{ task.comments && task.comments.length ? task.comment_log || "Đã bình luận" : "Đã bình luận" }}
                    </span>
                    <span v-else-if="task.comment_status === 'scheduled' || task.comment_status === 'processing'" class="text-slate-500 font-semibold">
                      {{ task.comment_log || "Bình luận đang chờ" }}
                    </span>
                    <div v-else-if="task.comment_status === 'failed'" class="flex items-center gap-1.5 text-rose-600 font-semibold">
                      <span>{{ task.comments && task.comments.length ? task.comment_log || "Bình luận lỗi" : "Bình luận lỗi" }}</span>
                      <button
                        type="button"
                        @click="retryComment(task.id)"
                        class="text-blue-600 hover:underline font-bold"
                      >
                        Thử lại
                      </button>
                    </div>
                  </div>
                </div>

                <!-- Failed: Error Message -->
                <div v-else-if="task.status === 'failed'" class="text-rose-600 text-[11px] line-clamp-2" :title="task.error_message || ''">
                  {{ task.error_message || 'Đăng thất bại' }}
                </div>

                <div v-else class="text-slate-400 text-[11px] italic">
                  Chưa đăng
                </div>
              </td>

              <!-- Action Buttons -->
              <td class="py-2.5 px-2.5 text-center">
                <div class="flex items-center justify-center gap-1">
                  <!-- Publish Now Button (for pending or failed) -->
                  <button
                    v-if="task.status !== 'success' && task.status !== 'running'"
                    type="button"
                    @click="publishNow(task.id)"
                    class="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg transition"
                    title="Đăng ngay"
                  >
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                  </button>

                  <!-- Edit Button (for pending or failed) -->
                  <button
                    v-if="task.status !== 'success' && task.status !== 'running'"
                    type="button"
                    @click="openEditModal(task)"
                    class="p-1.5 text-slate-500 hover:text-blue-600 hover:bg-slate-100 rounded-lg transition"
                    title="Sửa lịch hoặc nội dung"
                  >
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>

                  <!-- Delete Button -->
                  <button
                    type="button"
                    @click="deleteTask(task.id)"
                    class="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition"
                    title="Xóa bài"
                  >
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </td>
            </tr>

            <!-- Empty Row -->
            <tr v-if="visibleTasks.length === 0">
              <td colspan="8" class="text-center py-12 text-slate-400 text-xs">
                Không có bài viết nào phù hợp với bộ lọc hiện tại.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Edit Task Modal -->
    <EditTaskModal
      :isOpen="isEditModalOpen"
      :task="editingTask"
      @close="isEditModalOpen = false"
      @updated="() => loadTasks(true)"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useTasks } from "../../composables/useTasks";
import type { TaskRecord, TaskStatus } from "@shared/types";
import EditTaskModal from "../dialogs/EditTaskModal.vue";

const {
  activeFilter,
  searchQuery,
  selectedTaskIds,
  filteredTasks,
  loadTasks,
  startAutoRefresh,
  lastRefreshedAt,
  toggleSelectTask,
  publishNow,
  publishBulkNow,
  deleteTask,
  bulkDelete,
  retryComment
} = useTasks();

const isEditModalOpen = ref(false);
const editingTask = ref<TaskRecord | null>(null);
let stopAutoRefresh: (() => void) | null = null;

// Lọc theo khung giờ đăng (giờ VN). 3 khung cố định + "Khác" cho giờ lẻ.
const FIXED_SLOTS = ["00:00", "07:00", "12:00"];
const slotFilter = ref<string>("all");
const slotOf = (t: TaskRecord) => {
  const hm = String(t.schedule_time || "").slice(0, 5);
  return FIXED_SLOTS.includes(hm) ? hm : "other";
};
const slotOptions = computed(() => {
  const list = filteredTasks.value;
  const count = (key: string) => list.filter((t) => slotOf(t) === key).length;
  return [
    { key: "all", label: "Tất cả", count: list.length },
    ...FIXED_SLOTS.map((slot) => ({ key: slot, label: slot, count: count(slot) })),
    { key: "other", label: "Khác", count: count("other") }
  ];
});
const visibleTasks = computed(() =>
  slotFilter.value === "all" ? filteredTasks.value : filteredTasks.value.filter((t) => slotOf(t) === slotFilter.value)
);
const allVisibleSelected = computed(
  () => visibleTasks.value.length > 0 && visibleTasks.value.every((t) => selectedTaskIds.value.includes(t.id))
);
const toggleSelectAllVisible = () => {
  selectedTaskIds.value = allVisibleSelected.value ? [] : visibleTasks.value.map((t) => t.id);
};

const formatClock = (ms: number) =>
  new Date(ms).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false });

onMounted(() => {
  loadTasks();
  stopAutoRefresh = startAutoRefresh();
});

onUnmounted(() => {
  stopAutoRefresh?.();
});

// Đổi bộ lọc (trạng thái ở thanh trên cùng, hoặc khung giờ) thì bỏ chọn để tránh thao tác nhầm bài đang ẩn
watch([activeFilter, slotFilter], () => {
  selectedTaskIds.value = [];
});

const formatStatus = (s: TaskStatus): string => {
  switch (s) {
    case "pending":
    case "scheduled":
      return "Chờ đăng";
    case "queued":
    case "running":
      return "Đang đăng...";
    case "success":
      return "Đã đăng";
    case "failed":
    case "canceled":
      return "Thất bại";
    default:
      return s;
  }
};

const getFacebookUrl = (task: TaskRecord): string => {
  if (task.permalink_url) return task.permalink_url;
  if (task.post_id) {
    if (task.post_id.includes("_")) {
      const [pid, postOnly] = task.post_id.split("_");
      return `https://www.facebook.com/${pid}/posts/${postOnly}`;
    }
    return `https://www.facebook.com/${task.facebook_page_id}/posts/${task.post_id}`;
  }
  if (task.video_id) {
    return `https://www.facebook.com/reel/${task.video_id}`;
  }
  return `https://www.facebook.com/${task.facebook_page_id}`;
};

const openEditModal = (task: TaskRecord) => {
  editingTask.value = task;
  isEditModalOpen.value = true;
};

const commentsTooltip = (task: { comments?: Array<{ text: string; has_image: boolean; status: string; error: string }> }) =>
  (task.comments || [])
    .map((c, i) => {
      const body = c.text || "(photo)";
      const photo = c.has_image && c.text ? " + photo" : "";
      const err = c.status === "failed" && c.error ? " — " + c.error : "";
      return `${i + 1}. ${body}${photo}${err}`;
    })
    .join("\n");

let lastSelectIndex = -1;
/** Click toggles one post; Shift + click gives every post between the last click and this one the same state */
const onSelectCellClick = (taskId: number, idx: number, e: MouseEvent) => {
  const list = visibleTasks.value;
  if (e.shiftKey && lastSelectIndex >= 0 && lastSelectIndex < list.length) {
    const makeSelected = !selectedTaskIds.value.includes(taskId);
    const [a, b] = lastSelectIndex < idx ? [lastSelectIndex, idx] : [idx, lastSelectIndex];
    const next = new Set(selectedTaskIds.value);
    for (const t of list.slice(a, b + 1)) {
      if (makeSelected) next.add(t.id);
      else next.delete(t.id);
    }
    selectedTaskIds.value = Array.from(next);
  } else {
    toggleSelectTask(taskId);
  }
  lastSelectIndex = idx;
};
</script>

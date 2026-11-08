<template>
  <div class="h-full flex flex-col p-4 lg:p-6 overflow-y-auto select-none">
    <!-- Top Filter & Action Bar -->
    <div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 mb-4 bg-white p-3 rounded-2xl border border-slate-200 shadow-xs">
      <!-- Status Filter Tabs -->
      <div class="flex items-center gap-1 overflow-x-auto scrollbar-none pb-1 sm:pb-0">
        <button
          type="button"
          @click="setFilter('all')"
          class="px-3 py-1.5 rounded-xl text-xs font-semibold transition flex items-center gap-1.5 flex-shrink-0"
          :class="activeFilter === 'all' ? 'bg-blue-600 text-white shadow-xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'"
        >
          <span>All</span>
          <span class="text-[10px] px-1.5 py-0.2 rounded-full" :class="activeFilter === 'all' ? 'bg-blue-700 text-white' : 'bg-slate-200 text-slate-700'">{{ taskStats.total }}</span>
        </button>

        <button
          type="button"
          @click="setFilter('pending')"
          class="px-3 py-1.5 rounded-xl text-xs font-semibold transition flex items-center gap-1.5 flex-shrink-0"
          :class="activeFilter === 'pending' ? 'bg-amber-500 text-white shadow-xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'"
        >
          <span>Scheduled</span>
          <span class="text-[10px] px-1.5 py-0.2 rounded-full" :class="activeFilter === 'pending' ? 'bg-amber-600 text-white' : 'bg-slate-200 text-slate-700'">{{ taskStats.pending }}</span>
        </button>

        <button
          type="button"
          @click="setFilter('running')"
          class="px-3 py-1.5 rounded-xl text-xs font-semibold transition flex items-center gap-1.5 flex-shrink-0"
          :class="activeFilter === 'running' ? 'bg-blue-500 text-white shadow-xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'"
        >
          <span>Publishing</span>
          <span class="text-[10px] px-1.5 py-0.2 rounded-full" :class="activeFilter === 'running' ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-700'">{{ taskStats.running }}</span>
        </button>

        <button
          type="button"
          @click="setFilter('success')"
          class="px-3 py-1.5 rounded-xl text-xs font-semibold transition flex items-center gap-1.5 flex-shrink-0"
          :class="activeFilter === 'success' ? 'bg-emerald-600 text-white shadow-xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'"
        >
          <span>Published</span>
          <span class="text-[10px] px-1.5 py-0.2 rounded-full" :class="activeFilter === 'success' ? 'bg-emerald-700 text-white' : 'bg-slate-200 text-slate-700'">{{ taskStats.success }}</span>
        </button>

        <button
          type="button"
          @click="setFilter('failed')"
          class="px-3 py-1.5 rounded-xl text-xs font-semibold transition flex items-center gap-1.5 flex-shrink-0"
          :class="activeFilter === 'failed' ? 'bg-rose-600 text-white shadow-xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'"
        >
          <span>Failed</span>
          <span class="text-[10px] px-1.5 py-0.2 rounded-full" :class="activeFilter === 'failed' ? 'bg-rose-700 text-white' : 'bg-slate-200 text-slate-700'">{{ taskStats.failed }}</span>
        </button>
      </div>

      <!-- Search & Refresh -->
      <div class="flex items-center gap-2">
        <div class="relative flex-1 sm:w-60">
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search scheduled posts..."
            class="w-full pl-8 pr-3 py-1.5 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <svg class="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>

        <button
          type="button"
          @click="() => loadTasks()"
          class="p-2 text-slate-500 hover:text-blue-600 rounded-xl border border-slate-200 hover:bg-slate-50 transition"
          title="Refresh"
        >
          <svg class="w-4 h-4" :class="{ 'animate-spin': isLoading }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Batch Selection Bar (When rows selected) -->
    <div
      v-if="selectedTaskIds.length > 0"
      class="mb-4 bg-blue-50 border border-blue-200 rounded-2xl p-3 flex items-center justify-between animate-in fade-in duration-150"
    >
      <div class="flex items-center gap-2 text-xs font-semibold text-blue-900">
        <span class="w-2 h-2 rounded-full bg-blue-600"></span>
        <span>{{ selectedTaskIds.length }} selected</span>
      </div>

      <div class="flex items-center gap-2">
        <button
          type="button"
          @click="publishBulkNow"
          class="px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-xs transition flex items-center gap-1.5"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          <span>Publish now</span>
        </button>

        <button
          type="button"
          @click="bulkDelete"
          class="px-3 py-1.5 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold shadow-xs transition flex items-center gap-1.5"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          <span>Delete</span>
        </button>
      </div>
    </div>

    <!-- Tasks Table -->
    <div class="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs flex-1 flex flex-col min-h-[350px]">
      <div class="overflow-x-auto flex-1 scrollbar-thin">
        <table class="w-full text-xs text-left">
          <thead class="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
            <tr>
              <th class="py-3 px-4 w-10 text-center">
                <input
                  type="checkbox"
                  :checked="isAllSelected"
                  @change="toggleSelectAll"
                  class="rounded text-blue-600 focus:ring-blue-500 border-slate-300 w-4 h-4"
                />
              </th>
              <th class="py-3 px-4 w-16 text-center">ID</th>
              <th class="py-3 px-4 w-56">Page</th>
              <th class="py-3 px-4 min-w-[200px]">Content</th>
              <th class="py-3 px-4 w-40">Scheduled time</th>
              <th class="py-3 px-4 w-32 text-center">Status</th>
              <th class="py-3 px-4 w-44">Result</th>
              <th class="py-3 px-4 w-32 text-center">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr
              v-for="(task, taskIdx) in filteredTasks"
              :key="task.id"
              class="hover:bg-slate-50/70 transition"
              :class="{ 'bg-blue-50/20': selectedTaskIds.includes(task.id) }"
            >
              <!-- Checkbox: the whole cell is clickable, Shift + click selects a range -->
              <td
                class="py-3 px-4 text-center cursor-pointer"
                title="Shift + click to select a range"
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
              <td class="py-3 px-4 text-center font-mono text-slate-400 text-[11px]">
                #{{ task.id }}
              </td>

              <!-- Page -->
              <td class="py-3 px-4">
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
              <td class="py-3 px-4">
                <p class="text-slate-800 line-clamp-2 leading-relaxed">
                  {{ task.caption || '(No content)' }}
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
                    💬 {{ task.comments.length }} comment{{ task.comments.length > 1 ? "s" : "" }}
                  </span>
                </div>
              </td>

              <!-- Schedule Time -->
              <td class="py-3 px-4">
                <div class="text-xs font-medium text-slate-700">
                  <span>{{ task.schedule_date || '--' }}</span>
                  <span class="text-slate-400 mx-1">|</span>
                  <span class="font-bold text-slate-900">{{ task.schedule_time || '--' }}</span>
                </div>
                <span class="text-[10px] text-slate-400 block mt-0.5">Asia/Ho_Chi_Minh</span>
              </td>

              <!-- Status Badge -->
              <td class="py-3 px-4 text-center">
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
              <td class="py-3 px-4 text-xs">
                <!-- Success: Link to Facebook Post -->
                <div v-if="task.status === 'success'" class="space-y-1">
                  <a
                    :href="getFacebookUrl(task)"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-1 font-bold text-blue-600 hover:text-blue-800 hover:underline"
                  >
                    <span>View on Facebook</span>
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>

                  <!-- Comment State -->
                  <div v-if="task.comment_text || (task.comments && task.comments.length)" class="text-[10px]">
                    <span v-if="task.comment_status === 'success'" class="text-emerald-600 font-semibold">
                      ✓ {{ task.comments && task.comments.length ? task.comment_log || "Commented" : "Commented" }}
                    </span>
                    <span v-else-if="task.comment_status === 'scheduled' || task.comment_status === 'processing'" class="text-slate-500 font-semibold">
                      {{ task.comment_log || "Comments waiting" }}
                    </span>
                    <div v-else-if="task.comment_status === 'failed'" class="flex items-center gap-1.5 text-rose-600 font-semibold">
                      <span>{{ task.comments && task.comments.length ? task.comment_log || "Comment failed" : "Comment failed" }}</span>
                      <button
                        type="button"
                        @click="retryComment(task.id)"
                        class="text-blue-600 hover:underline font-bold"
                      >
                        Retry
                      </button>
                    </div>
                  </div>
                </div>

                <!-- Failed: Error Message -->
                <div v-else-if="task.status === 'failed'" class="text-rose-600 text-[11px] line-clamp-2" :title="task.error_message || ''">
                  {{ task.error_message || 'Publishing failed' }}
                </div>

                <div v-else class="text-slate-400 text-[11px] italic">
                  Not published yet
                </div>
              </td>

              <!-- Action Buttons -->
              <td class="py-3 px-4 text-center">
                <div class="flex items-center justify-center gap-1">
                  <!-- Publish Now Button (for pending or failed) -->
                  <button
                    v-if="task.status !== 'success' && task.status !== 'running'"
                    type="button"
                    @click="publishNow(task.id)"
                    class="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg transition"
                    title="Publish now"
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
                    title="Edit schedule or content"
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
                    title="Delete post"
                  >
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </td>
            </tr>

            <!-- Empty Row -->
            <tr v-if="filteredTasks.length === 0">
              <td colspan="8" class="text-center py-12 text-slate-400 text-xs">
                No posts match the current filter.
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
import { ref, onMounted, onUnmounted } from "vue";
import { useTasks } from "../../composables/useTasks";
import type { TaskRecord, TaskStatus } from "@shared/types";
import EditTaskModal from "../dialogs/EditTaskModal.vue";

const {
  isLoading,
  activeFilter,
  searchQuery,
  selectedTaskIds,
  filteredTasks,
  taskStats,
  isAllSelected,
  loadTasks,
  toggleSelectTask,
  toggleSelectAll,
  publishNow,
  publishBulkNow,
  deleteTask,
  bulkDelete,
  retryComment
} = useTasks();

const isEditModalOpen = ref(false);
const editingTask = ref<TaskRecord | null>(null);
let pollInterval: any = null;

onMounted(() => {
  loadTasks();
  // Poll periodically if there are tasks running
  pollInterval = setInterval(() => {
    if (taskStats.value.running > 0) {
      loadTasks(true);
    }
  }, 5000);
});

onUnmounted(() => {
  if (pollInterval) clearInterval(pollInterval);
});

const setFilter = (f: string) => {
  activeFilter.value = f;
  selectedTaskIds.value = [];
};

const formatStatus = (s: TaskStatus): string => {
  switch (s) {
    case "pending":
    case "scheduled":
      return "Scheduled";
    case "queued":
    case "running":
      return "Publishing...";
    case "success":
      return "Published";
    case "failed":
    case "canceled":
      return "Failed";
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
  const list = filteredTasks.value;
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

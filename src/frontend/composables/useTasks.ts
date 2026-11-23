import { ref, computed } from "vue";
import { api } from "../services/api";
import type { TaskRecord } from "@shared/types";
import { useToast } from "./useToast";

const tasks = ref<TaskRecord[]>([]);
const isLoading = ref<boolean>(false);
const activeFilter = ref<string>("all"); // 'all' | 'pending' | 'running' | 'success' | 'failed'
const searchQuery = ref<string>("");
const selectedTaskIds = ref<number[]>([]);
const isActionLoading = ref<boolean>(false);
const lastRefreshedAt = ref<number>(0);

// Tự làm mới: chỉ hỏi số phiên bản (rẻ, 1 dòng từ index), chỉ tải lại cả danh sách khi dữ liệu thật sự đổi
const FAST_POLL_MS = 30000; // 30 giây khi có bài đang xử lý hoặc sắp đăng
const IDLE_POLL_MS = 60000; // 60 giây khi bình thường
/** Lịch đăng hiện bài chưa xong + bài đã xong trong N ngày gần đây (không đọc lại toàn bộ bài cũ) */
export const BOARD_RECENT_DAYS = 3;
let knownVersion = -1;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let autoRefreshUsers = 0;

export function useTasks() {
  const toast = useToast();

  // Luôn tải toàn bộ (bộ lọc & tìm kiếm làm ở giao diện) để số đếm từng trạng thái luôn đúng
  const loadTasks = async (silent = false) => {
    if (!silent) isLoading.value = true;
    try {
      const [res, version] = await Promise.all([
        api.getTasks({ recent_days: BOARD_RECENT_DAYS }),
        api.getTaskVersion().catch(() => -1)
      ]);
      tasks.value = res.tasks || [];
      if (version >= 0) knownVersion = version;
      lastRefreshedAt.value = Date.now();
    } catch (err: any) {
      if (!silent) {
        toast.error(err?.message || "Không thể tải danh sách bài viết.");
      }
    } finally {
      if (!silent) isLoading.value = false;
    }
  };

  const checkForChanges = async () => {
    if (document.visibilityState !== "visible") return;
    try {
      const version = await api.getTaskVersion();
      if (version !== knownVersion) {
        await loadTasks(true);
      }
    } catch {}
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") checkForChanges();
  };

  /** Gọi khi màn hình hiển thị danh sách bài được mở; trả về hàm dừng */
  const startAutoRefresh = () => {
    autoRefreshUsers++;
    if (autoRefreshUsers === 1) {
      // Có bài đang chạy/chờ đăng thì 30s hỏi 1 lần, ngược lại 60s hỏi 1 lần
      const hasActive = tasks.value.some((t) => t.status === "running" || t.status === "queued" || t.status === "pending");
      const interval = hasActive ? FAST_POLL_MS : IDLE_POLL_MS;
      pollTimer = setInterval(checkForChanges, interval);
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    return () => {
      autoRefreshUsers = Math.max(0, autoRefreshUsers - 1);
      if (autoRefreshUsers === 0) {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  };

  const filteredTasks = computed(() => {
    let list = tasks.value;
    if (activeFilter.value !== "all") {
      if (activeFilter.value === "pending") {
        list = list.filter((t) => t.status === "pending" || t.status === "scheduled");
      } else if (activeFilter.value === "running") {
        list = list.filter((t) => t.status === "running" || t.status === "queued");
      } else if (activeFilter.value === "success") {
        list = list.filter((t) => t.status === "success");
      } else if (activeFilter.value === "failed") {
        list = list.filter((t) => t.status === "failed" || t.status === "canceled");
      }
    }
    const q = searchQuery.value.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (t) =>
        (t.caption || "").toLowerCase().includes(q) ||
        (t.page_name || "").toLowerCase().includes(q) ||
        (t.facebook_page_id || "").includes(q) ||
        String(t.id).includes(q)
    );
  });

  const taskStats = computed(() => {
    const all = tasks.value;
    return {
      total: all.length,
      pending: all.filter((t) => t.status === "pending" || t.status === "scheduled").length,
      running: all.filter((t) => t.status === "running" || t.status === "queued").length,
      success: all.filter((t) => t.status === "success").length,
      failed: all.filter((t) => t.status === "failed" || t.status === "canceled").length
    };
  });

  const toggleSelectTask = (id: number) => {
    if (selectedTaskIds.value.includes(id)) {
      selectedTaskIds.value = selectedTaskIds.value.filter((i) => i !== id);
    } else {
      selectedTaskIds.value.push(id);
    }
  };

  const toggleSelectAll = () => {
    if (selectedTaskIds.value.length === filteredTasks.value.length) {
      selectedTaskIds.value = [];
    } else {
      selectedTaskIds.value = filteredTasks.value.map((t) => t.id);
    }
  };

  const isAllSelected = computed(
    () =>
      filteredTasks.value.length > 0 &&
      selectedTaskIds.value.length === filteredTasks.value.length
  );

  const publishNow = async (taskId: number) => {
    isActionLoading.value = true;
    try {
      const res = await api.publishTaskNow(taskId);
      toast.success(res?.message || "Publish request sent.");
      await loadTasks(true);
    } catch (err: any) {
      toast.error(err?.message || "Failed to publish now.");
    } finally {
      isActionLoading.value = false;
    }
  };

  const publishBulkNow = async () => {
    if (selectedTaskIds.value.length === 0) return;
    isActionLoading.value = true;
    try {
      const res = await api.publishBulkNow(selectedTaskIds.value);
      toast.success(res?.message || `Queued ${selectedTaskIds.value.length} post(s) to publish now.`);
      selectedTaskIds.value = [];
      await loadTasks(true);
    } catch (err: any) {
      toast.error(err?.message || "Failed to publish selected posts.");
    } finally {
      isActionLoading.value = false;
    }
  };

  const deleteTask = async (taskId: number, deleteFb = false) => {
    isActionLoading.value = true;
    try {
      await api.deleteTask(taskId, deleteFb);
      toast.success("Post deleted.");
      selectedTaskIds.value = selectedTaskIds.value.filter((i) => i !== taskId);
      await loadTasks(true);
    } catch (err: any) {
      toast.error(err?.message || "Failed to delete post.");
    } finally {
      isActionLoading.value = false;
    }
  };

  const bulkDelete = async () => {
    if (selectedTaskIds.value.length === 0) return;
    if (!confirm(`Delete ${selectedTaskIds.value.length} selected post(s)?`)) {
      return;
    }
    isActionLoading.value = true;
    try {
      await api.bulkDeleteTasks(selectedTaskIds.value);
      toast.success(`Deleted ${selectedTaskIds.value.length} post(s).`);
      selectedTaskIds.value = [];
      await loadTasks(true);
    } catch (err: any) {
      toast.error(err?.message || "Failed to delete selected posts.");
    } finally {
      isActionLoading.value = false;
    }
  };

  const retryComment = async (taskId: number) => {
    isActionLoading.value = true;
    try {
      const res = await api.retryTaskComment(taskId);
      toast.success(res?.message || "Comment posted.");
      await loadTasks(true);
    } catch (err: any) {
      toast.error(err?.message || "Failed to retry comment.");
    } finally {
      isActionLoading.value = false;
    }
  };

  return {
    tasks,
    isLoading,
    isActionLoading,
    activeFilter,
    searchQuery,
    selectedTaskIds,
    filteredTasks,
    taskStats,
    isAllSelected,
    loadTasks,
    startAutoRefresh,
    lastRefreshedAt,
    toggleSelectTask,
    toggleSelectAll,
    publishNow,
    publishBulkNow,
    deleteTask,
    bulkDelete,
    retryComment
  };
}

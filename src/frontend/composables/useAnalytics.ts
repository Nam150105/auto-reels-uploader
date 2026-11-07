import { ref } from "vue";
import { api } from "../services/api";
import type { AnalyticsDashboard } from "@shared/types";
import { useToast } from "./useToast";

const dashboard = ref<AnalyticsDashboard | null>(null);
const isLoading = ref<boolean>(false);
const isSyncing = ref<boolean>(false);
let lastFetchedTime = 0;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes cache

export function useAnalytics() {
  const toast = useToast();

  const loadAnalytics = async (force = false) => {
    const now = Date.now();
    if (!force && dashboard.value && now - lastFetchedTime < CACHE_TTL_MS) {
      // Use cached dashboard
      return dashboard.value;
    }

    isLoading.value = true;
    try {
      const data = await api.getAnalytics();
      dashboard.value = data;
      lastFetchedTime = Date.now();
      return data;
    } catch (err: any) {
      toast.error(err?.message || "Không thể tải dữ liệu thống kê.");
      return null;
    } finally {
      isLoading.value = false;
    }
  };

  const syncInsights = async () => {
    isSyncing.value = true;
    try {
      const res = await api.syncAnalytics();
      toast.success(res?.message || "Đã đồng bộ dữ liệu mới nhất từ Facebook Insights!");
      await loadAnalytics(true);
    } catch (err: any) {
      toast.error(err?.message || "Đồng bộ thống kê Facebook thất bại.");
    } finally {
      isSyncing.value = false;
    }
  };

  return {
    dashboard,
    isLoading,
    isSyncing,
    loadAnalytics,
    syncInsights
  };
}

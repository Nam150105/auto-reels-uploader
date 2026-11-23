import { ref } from "vue";
import { api, type AnalyticsRange } from "../services/api";
import type { AnalyticsDashboard } from "@shared/types";
import { useToast } from "./useToast";

const dashboard = ref<AnalyticsDashboard | null>(null);
const isLoading = ref<boolean>(false);
const isSyncing = ref<boolean>(false);
/** "30" = 30 ngày gần nhất, "all" = tất cả */
const range = ref<AnalyticsRange>("30");
let loadedRange: AnalyticsRange | null = null;
let lastFetchedTime = 0;
const CACHE_TTL_MS = 60 * 1000; // numbers come from the database (synced every 6 hours), so a short reuse is enough

export function useAnalytics() {
  const toast = useToast();

  const loadAnalytics = async (force = false) => {
    const now = Date.now();
    if (!force && dashboard.value && loadedRange === range.value && now - lastFetchedTime < CACHE_TTL_MS) {
      // Use cached dashboard
      return dashboard.value;
    }

    isLoading.value = true;
    try {
      const data = await api.getAnalytics(range.value);
      dashboard.value = data;
      loadedRange = range.value;
      lastFetchedTime = Date.now();
      return data;
    } catch (err: any) {
      toast.error(err?.message || "Couldn't load analytics.");
      return null;
    } finally {
      isLoading.value = false;
    }
  };

  const syncInsights = async () => {
    isSyncing.value = true;
    try {
      const data = await api.syncAnalytics(range.value);
      dashboard.value = data;
      loadedRange = range.value;
      lastFetchedTime = Date.now();
      toast.success("Loaded the latest numbers from Facebook.");
    } catch (err: any) {
      toast.error(err?.message || "Failed to sync Facebook analytics.");
    } finally {
      isSyncing.value = false;
    }
  };

  return {
    dashboard,
    isLoading,
    isSyncing,
    range,
    loadAnalytics,
    syncInsights
  };
}

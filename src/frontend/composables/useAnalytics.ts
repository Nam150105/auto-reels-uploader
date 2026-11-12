import { ref } from "vue";
import { api } from "../services/api";
import type { AnalyticsDashboard } from "@shared/types";
import { useToast } from "./useToast";

const dashboard = ref<AnalyticsDashboard | null>(null);
const isLoading = ref<boolean>(false);
const isSyncing = ref<boolean>(false);
const rangeDays = ref<number>(28);
let lastFetchedTime = 0;
const CACHE_TTL_MS = 60 * 1000; // numbers come from the database (synced every 3 hours), so a short reuse is enough

export function useAnalytics() {
  const toast = useToast();

  const loadAnalytics = async (force = false) => {
    const now = Date.now();
    if (!force && dashboard.value && dashboard.value.range_days === rangeDays.value && now - lastFetchedTime < CACHE_TTL_MS) {
      // Use cached dashboard
      return dashboard.value;
    }

    isLoading.value = true;
    try {
      const data = await api.getAnalytics(rangeDays.value);
      dashboard.value = data;
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
      const data = await api.syncAnalytics(rangeDays.value);
      dashboard.value = data;
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
    rangeDays,
    loadAnalytics,
    syncInsights
  };
}

<template>
  <div class="h-full flex flex-col p-4 lg:p-6 overflow-y-auto select-none">
    <!-- Top bar -->
    <div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 mb-6 bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
      <div>
        <h2 class="text-base font-bold text-slate-800">Analytics</h2>
        <p class="text-xs text-slate-500 mt-0.5">
          Live from Facebook for your connected Pages.
          <span v-if="dashboard?.fetched_at" class="text-slate-400 ml-1">Updated {{ formatTime(dashboard.fetched_at) }}</span>
        </p>
      </div>

      <div class="flex items-center gap-2">
        <select
          v-model.number="rangeDays"
          @change="loadAnalytics()"
          class="px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white font-semibold text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option :value="7">Last 7 days</option>
          <option :value="30">Last 30 days</option>
          <option :value="90">Last 90 days</option>
        </select>
        <button
          type="button"
          :disabled="isSyncing || isLoading"
          @click="syncInsights"
          class="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold text-xs shadow-sm transition"
        >
          <svg class="w-4 h-4" :class="{ 'animate-spin': isSyncing || isLoading }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          <span>{{ isSyncing ? "Refreshing..." : "Refresh" }}</span>
        </button>
      </div>
    </div>

    <div v-if="isLoading && !dashboard" class="flex-1 flex items-center justify-center text-xs text-slate-400 py-20">
      Loading numbers from Facebook...
    </div>

    <template v-else>
      <div
        v-if="dashboard?.warnings?.length"
        class="mb-4 p-3 rounded-2xl border border-amber-200 bg-amber-50 text-amber-800 text-xs space-y-1"
      >
        <p v-for="(w, i) in dashboard.warnings" :key="i">{{ w }}</p>
      </div>

      <!-- Overview cards -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div v-for="card in cards" :key="card.label" class="bg-white rounded-2xl border border-slate-200 p-4 shadow-xs">
          <span class="text-[11px] font-bold tracking-wider uppercase text-slate-500">{{ card.label }}</span>
          <p class="text-2xl font-black text-slate-900 tracking-tight mt-2">{{ formatNumber(card.value) }}</p>
          <span class="text-[10px] font-semibold mt-1 block" :class="card.tone">{{ card.hint }}</span>
        </div>
      </div>

      <!-- Daily chart -->
      <div class="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 mb-6 shadow-xs">
        <div class="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-slate-100 mb-4">
          <h3 class="font-bold text-sm text-slate-800">Daily Page activity</h3>
          <div class="flex items-center gap-4 text-xs font-semibold">
            <span class="flex items-center gap-1.5 text-blue-600">
              <span class="w-2.5 h-2.5 rounded-full bg-blue-600"></span>
              Views
            </span>
            <span class="flex items-center gap-1.5 text-emerald-600">
              <span class="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
              Engagement
            </span>
          </div>
        </div>

        <div v-if="chartPoints.length === 0" class="h-40 flex items-center justify-center text-xs text-slate-400 text-center px-6">
          Facebook did not return daily Page insights for this period.
        </div>
        <div v-else class="w-full h-56 relative">
          <svg class="w-full h-full overflow-visible" viewBox="0 0 800 200" preserveAspectRatio="none">
            <line x1="0" y1="30" x2="800" y2="30" stroke="#f1f5f9" stroke-width="1" />
            <line x1="0" y1="100" x2="800" y2="100" stroke="#f1f5f9" stroke-width="1" />
            <line x1="0" y1="170" x2="800" y2="170" stroke="#f1f5f9" stroke-width="1" />
            <path :d="viewsArea" fill="url(#viewsGradient)" opacity="0.2" />
            <path :d="viewsLine" fill="none" stroke="#2563eb" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
            <path :d="engagementLine" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
            <defs>
              <linearGradient id="viewsGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#2563eb" />
                <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
              </linearGradient>
            </defs>
          </svg>
          <div class="flex items-center justify-between text-[11px] text-slate-400 pt-2 font-mono">
            <span v-for="label in xLabels" :key="label">{{ label }}</span>
          </div>
        </div>
      </div>

      <!-- Pages table -->
      <div class="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs mb-6">
        <div class="p-4 border-b border-slate-100 flex items-center justify-between">
          <h3 class="font-bold text-sm text-slate-800">Pages</h3>
          <span class="text-xs text-slate-500 font-medium">"—" means Facebook did not return this number</span>
        </div>
        <div class="overflow-x-auto scrollbar-thin">
          <table class="w-full text-xs text-left">
            <thead class="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
              <tr>
                <th class="py-3 px-4">Page</th>
                <th class="py-3 px-4 text-right">Followers</th>
                <th class="py-3 px-4 text-right">New followers</th>
                <th class="py-3 px-4 text-right">Views</th>
                <th class="py-3 px-4 text-right">Engagement</th>
                <th class="py-3 px-4 text-right">Reels</th>
                <th class="py-3 px-4 text-right">Reel plays</th>
                <th class="py-3 px-4 text-right">Likes</th>
                <th class="py-3 px-4 text-right">Comments</th>
                <th class="py-3 px-4 text-right">Shares</th>
                <th class="py-3 px-4 text-center">Status</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="page in dashboard?.pages || []" :key="page.page_id" class="hover:bg-slate-50/70 transition">
                <td class="py-3 px-4">
                  <div class="flex items-center gap-2.5 min-w-0">
                    <div class="w-8 h-8 rounded-full bg-slate-200 overflow-hidden flex-shrink-0 border border-slate-200">
                      <img v-if="page.avatar_url" :src="page.avatar_url" class="w-full h-full object-cover" />
                      <span v-else class="w-full h-full flex items-center justify-center font-bold text-slate-500 text-[10px]">FB</span>
                    </div>
                    <p class="font-bold text-slate-800 truncate text-xs max-w-[180px]">{{ page.page_name }}</p>
                  </div>
                </td>
                <td class="py-3 px-4 text-right font-bold text-slate-900">{{ formatNumber(page.followers) }}</td>
                <td class="py-3 px-4 text-right text-emerald-600 font-semibold">{{ formatNumber(page.new_follows) }}</td>
                <td class="py-3 px-4 text-right font-bold text-blue-600">{{ formatNumber(page.views) }}</td>
                <td class="py-3 px-4 text-right text-slate-700">{{ formatNumber(page.engagement) }}</td>
                <td class="py-3 px-4 text-right text-slate-700">{{ formatNumber(page.reels_count) }}</td>
                <td class="py-3 px-4 text-right text-slate-700">{{ formatNumber(page.reel_plays) }}</td>
                <td class="py-3 px-4 text-right text-slate-700">{{ formatNumber(page.likes) }}</td>
                <td class="py-3 px-4 text-right text-slate-700">{{ formatNumber(page.comments) }}</td>
                <td class="py-3 px-4 text-right text-slate-700">{{ formatNumber(page.shares) }}</td>
                <td class="py-3 px-4 text-center">
                  <span
                    class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold"
                    :class="statusClass(page.status)"
                    :title="page.status_message"
                  >
                    {{ statusLabel(page.status) }}
                  </span>
                </td>
              </tr>
              <tr v-if="!dashboard?.pages?.length">
                <td colspan="11" class="text-center py-10 text-slate-400 text-xs">
                  No Pages yet. Connect a Facebook Page to see its numbers.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Top Reels -->
      <div class="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
        <div class="p-4 border-b border-slate-100 flex items-center justify-between">
          <h3 class="font-bold text-sm text-slate-800">Top Reels</h3>
          <span class="text-xs text-slate-500 font-medium">All Reels on your Pages in this period</span>
        </div>
        <div class="overflow-x-auto scrollbar-thin">
          <table class="w-full text-xs text-left">
            <thead class="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
              <tr>
                <th class="py-3 px-4">Reel</th>
                <th class="py-3 px-4 text-right">Plays</th>
                <th class="py-3 px-4 text-right">Reach</th>
                <th class="py-3 px-4 text-right">Likes</th>
                <th class="py-3 px-4 text-right">Comments</th>
                <th class="py-3 px-4 text-right">Shares</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="reel in dashboard?.top_reels || []" :key="reel.video_id" class="hover:bg-slate-50/70 transition">
                <td class="py-3 px-4 max-w-[320px]">
                  <a :href="reel.permalink_url" target="_blank" rel="noopener noreferrer" class="font-semibold text-slate-800 hover:text-blue-600 line-clamp-2 break-words">
                    {{ reel.description || "(no caption)" }}
                  </a>
                  <p class="text-[10px] text-slate-400 mt-0.5">{{ reel.page_name }} · {{ formatDate(reel.created_time) }}</p>
                </td>
                <td class="py-3 px-4 text-right font-bold text-blue-600">{{ formatNumber(reel.plays) }}</td>
                <td class="py-3 px-4 text-right text-slate-700">{{ formatNumber(reel.reach) }}</td>
                <td class="py-3 px-4 text-right text-slate-700">{{ formatNumber(reel.likes) }}</td>
                <td class="py-3 px-4 text-right text-slate-700">{{ formatNumber(reel.comments) }}</td>
                <td class="py-3 px-4 text-right text-slate-700">{{ formatNumber(reel.shares) }}</td>
              </tr>
              <tr v-if="!dashboard?.top_reels?.length">
                <td colspan="6" class="text-center py-10 text-slate-400 text-xs">No Reels were posted in this period.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useAnalytics } from "../../composables/useAnalytics";

const { dashboard, isLoading, isSyncing, rangeDays, loadAnalytics, syncInsights } = useAnalytics();

onMounted(() => {
  loadAnalytics();
});

const formatNumber = (num: number | null | undefined): string => {
  if (num === null || num === undefined || !Number.isFinite(num)) return "—";
  return new Intl.NumberFormat("en-US").format(num);
};

const VN_TZ = "Asia/Ho_Chi_Minh";
const formatTime = (iso: string) => {
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: VN_TZ }).format(new Date(iso));
  } catch {
    return iso;
  }
};
const formatDate = (iso: string) => {
  try {
    return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: VN_TZ }).format(new Date(iso));
  } catch {
    return iso;
  }
};

const cards = computed(() => {
  const d = dashboard.value;
  const days = d?.range_days || rangeDays.value;
  return [
    {
      label: "Followers",
      value: d?.total_followers ?? null,
      hint: `Across ${d?.total_pages || 0} Page(s)`,
      tone: "text-blue-600"
    },
    {
      label: `New followers (${days}d)`,
      value: d?.new_follows ?? null,
      hint: d?.new_follows == null ? "Not provided by Facebook" : "People who started following",
      tone: "text-emerald-600"
    },
    {
      label: `Page views (${days}d)`,
      value: d?.views ?? null,
      hint: d?.views_7d != null ? `${formatNumber(d.views_7d)} in the last 7 days` : "Content views on your Pages",
      tone: "text-indigo-600"
    },
    {
      label: `Reels posted (${days}d)`,
      value: d ? d.reels_count : null,
      hint: d?.reel_plays != null ? `${formatNumber(d.reel_plays)} plays in total` : `${d?.reels_count_7d || 0} in the last 7 days`,
      tone: "text-purple-600"
    }
  ];
});

const statusLabel = (s: string) =>
  s === "ok" ? "✓ OK" : s === "partial" ? "Partial data" : s === "reconnect" ? "Reconnect" : "Unavailable";
const statusClass = (s: string) =>
  s === "ok"
    ? "bg-emerald-50 text-emerald-700"
    : s === "partial"
      ? "bg-amber-50 text-amber-700"
      : "bg-rose-50 text-rose-700";

// Chart
const chartPoints = computed(() => {
  const ts = (dashboard.value?.time_series || []).filter((p) => p.views !== null || p.engagement !== null);
  if (ts.length === 0) return [];
  const maxVal = Math.max(1, ...ts.map((p) => Math.max(p.views ?? 0, p.engagement ?? 0)));
  const stepX = ts.length > 1 ? 760 / (ts.length - 1) : 0;
  return ts.map((pt, idx) => ({
    date: `${pt.date.substring(8, 10)}/${pt.date.substring(5, 7)}`,
    x: 20 + idx * stepX,
    yViews: 170 - ((pt.views ?? 0) / maxVal) * 140,
    yEng: 170 - ((pt.engagement ?? 0) / maxVal) * 140
  }));
});

const linePath = (key: "yViews" | "yEng") =>
  chartPoints.value.reduce((acc, pt, i) => `${acc} ${i === 0 ? "M" : "L"} ${pt.x} ${pt[key]}`, "");

const viewsLine = computed(() => linePath("yViews"));
const engagementLine = computed(() => linePath("yEng"));
const viewsArea = computed(() => {
  const pts = chartPoints.value;
  if (pts.length === 0) return "";
  return `${viewsLine.value} L ${pts[pts.length - 1].x} 180 L ${pts[0].x} 180 Z`;
});

/** At most 7 evenly spaced date labels */
const xLabels = computed(() => {
  const pts = chartPoints.value;
  if (pts.length <= 7) return pts.map((p) => p.date);
  const step = (pts.length - 1) / 6;
  return Array.from({ length: 7 }, (_, i) => pts[Math.round(i * step)].date);
});
</script>

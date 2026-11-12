<template>
  <div class="h-full p-4 lg:p-6 overflow-y-auto select-none">
    <!-- Top bar -->
    <div class="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3 mb-6 bg-white p-4 rounded-2xl border border-slate-200/80 shadow-xs">
      <div>
        <h2 class="text-base font-bold text-slate-800 flex items-center gap-2">
          <span class="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
          <span>Thống kê hiệu quả Fanpage & Reels</span>
        </h2>
        <p class="text-xs text-slate-500 mt-0.5">
          Tự động đồng bộ từ Facebook 3 tiếng/lần.
          <span v-if="dashboard" class="font-medium text-slate-700 ml-1">{{ formatDay(dashboard.range_start) }} – {{ formatDay(dashboard.range_end) }}</span>
          <span v-if="dashboard?.synced_at || dashboard?.fetched_at" class="text-slate-400 ml-1">· Cập nhật {{ formatTime(dashboard.synced_at || dashboard.fetched_at) }}</span>
          <span v-if="dashboard?.next_sync_at" class="text-slate-400 ml-1">· Lần tới {{ formatTime(dashboard.next_sync_at) }}</span>
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <select
          v-model="selectedPageId"
          class="px-3 py-2 text-xs rounded-xl border border-slate-200/90 bg-white font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400 max-w-[220px] shadow-2xs"
        >
          <option value="">Tất cả Fanpage</option>
          <option v-for="(p, i) in dashboard?.pages || []" :key="p.page_id" :value="p.page_id">{{ pageNumber(p.page_id, i) }}. {{ p.page_name }}</option>
        </select>
        <select
          v-model.number="rangeDays"
          @change="loadAnalytics()"
          class="px-3 py-2 text-xs rounded-xl border border-slate-200/90 bg-white font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400 shadow-2xs"
        >
          <option :value="7">7 ngày gần nhất</option>
          <option :value="28">28 ngày gần nhất</option>
          <option :value="30">30 ngày gần nhất</option>
          <option :value="90">90 ngày gần nhất</option>
        </select>
        <button
          type="button"
          :disabled="isSyncing || isLoading"
          @click="syncInsights"
          class="flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-50 text-white font-bold text-xs shadow-xs shadow-blue-500/20 transition"
        >
          <svg class="w-4 h-4" :class="{ 'animate-spin': isSyncing || isLoading }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          <span>{{ isSyncing ? "Đang đồng bộ..." : "Làm mới dữ liệu" }}</span>
        </button>
      </div>
    </div>

    <div v-if="isLoading && !dashboard" class="flex items-center justify-center text-xs text-slate-400 py-20">
      Loading numbers from Facebook...
    </div>

    <template v-else-if="dashboard">
      <div
        v-if="dashboard.warnings.length"
        class="mb-4 p-3 rounded-2xl border border-amber-200 bg-amber-50 text-amber-800 text-xs space-y-1"
      >
        <p v-for="(w, i) in dashboard.warnings" :key="i">{{ w }}</p>
      </div>

      <!-- Selected Page header -->
      <div v-if="selectedPage" class="mb-4 flex items-center justify-between gap-3 bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-11 h-11 rounded-full bg-slate-200 overflow-hidden flex-shrink-0 border border-slate-200">
            <img v-if="selectedPage.avatar_url" :src="selectedPage.avatar_url" class="w-full h-full object-cover" />
          </div>
          <div class="min-w-0">
            <a
              :href="`https://www.facebook.com/${selectedPage.page_id}`"
              target="_blank"
              rel="noopener noreferrer"
              class="font-bold text-sm text-slate-800 hover:text-blue-600 truncate block"
            >
              {{ selectedPage.page_name }}
            </a>
            <p class="text-[11px]" :class="selectedPage.status === 'ok' ? 'text-emerald-600' : 'text-amber-700'">
              {{ selectedPage.status === "ok" ? "All numbers loaded" : selectedPage.status_message }}
            </p>
          </div>
        </div>
        <button type="button" @click="selectedPageId = ''" class="text-xs font-semibold text-blue-600 hover:text-blue-700">
          ← All Pages
        </button>
      </div>

      <!-- The five numbers -->
      <div class="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <div
          v-for="(card, cIdx) in cards"
          :key="card.label"
          class="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-xs transition hover:shadow-sm"
          :class="[
            cIdx === 0 ? 'border-t-[3px] border-t-blue-500 bg-gradient-to-b from-blue-50/20 to-white' :
            cIdx === 1 ? 'border-t-[3px] border-t-indigo-500 bg-gradient-to-b from-indigo-50/20 to-white' :
            cIdx === 2 ? 'border-t-[3px] border-t-purple-500 bg-gradient-to-b from-purple-50/20 to-white' :
            cIdx === 3 ? 'border-t-[3px] border-t-emerald-500 bg-gradient-to-b from-emerald-50/20 to-white' :
            'border-t-[3px] border-t-rose-500 bg-gradient-to-b from-rose-50/20 to-white'
          ]"
          :title="card.help"
        >
          <span class="text-[11px] font-bold tracking-wider uppercase text-slate-500">{{ card.label }}</span>
          <p class="text-2xl font-black text-slate-900 tracking-tight mt-2">{{ formatNumber(card.value) }}</p>
          <span class="text-[10px] font-bold mt-1 block" :class="card.tone">{{ card.hint }}</span>
        </div>
      </div>

      <!-- Daily chart -->
      <div class="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 mb-6 shadow-xs">
        <div class="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-slate-100 mb-4">
          <h3 class="font-bold text-sm text-slate-800">Daily activity{{ selectedPage ? ` · ${selectedPage.page_name}` : "" }}</h3>
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

      <!-- ALL PAGES: per-Page numbers + total row -->
      <div v-if="!selectedPage" class="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
        <div class="p-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2">
          <h3 class="font-bold text-sm text-slate-800">Pages</h3>
          <span class="text-xs text-slate-500 font-medium">Click a Page for day-by-day details · "—" = not returned by Facebook</span>
        </div>
        <div class="overflow-x-auto scrollbar-thin">
          <table class="w-full text-xs text-left">
            <thead class="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
              <tr>
                <th class="py-3 pl-4 pr-1 w-10 text-center">#</th>
                <th class="py-3 px-4">Page</th>
                <th class="py-3 px-4 text-right">Followers</th>
                <th class="py-3 px-4 text-right">Views</th>
                <th class="py-3 px-4 text-right">Views (7 days)</th>
                <th class="py-3 px-4 text-right">Engagement</th>
                <th class="py-3 px-4 text-right">Reels</th>
                <th class="py-3 px-4 text-center">Status</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr
                v-for="(page, idx) in dashboard.pages"
                :key="page.page_id"
                @click="selectedPageId = page.page_id"
                class="hover:bg-blue-50/50 cursor-pointer transition"
              >
                <td class="py-3 pl-4 pr-1 text-center text-slate-400 font-bold">{{ pageNumber(page.page_id, idx) }}</td>
                <td class="py-3 px-4">
                  <div class="flex items-center gap-2.5 min-w-0">
                    <div class="w-8 h-8 rounded-full bg-slate-200 overflow-hidden flex-shrink-0 border border-slate-200">
                      <img v-if="page.avatar_url" :src="page.avatar_url" class="w-full h-full object-cover" />
                      <span v-else class="w-full h-full flex items-center justify-center font-bold text-slate-500 text-[10px]">FB</span>
                    </div>
                    <p class="font-bold text-slate-800 truncate text-xs max-w-[200px]">{{ page.page_name }}</p>
                  </div>
                </td>
                <td class="py-3 px-4 text-right font-semibold text-slate-900">{{ formatNumber(page.followers) }}</td>
                <td class="py-3 px-4 text-right font-semibold text-blue-600">{{ formatNumber(page.views) }}</td>
                <td class="py-3 px-4 text-right text-indigo-600">{{ formatNumber(page.views_7d) }}</td>
                <td class="py-3 px-4 text-right text-emerald-600">{{ formatNumber(page.engagement) }}</td>
                <td class="py-3 px-4 text-right text-purple-600">{{ formatNumber(page.reels_count) }}</td>
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
              <tr v-if="!dashboard.pages.length">
                <td colspan="8" class="text-center py-10 text-slate-400 text-xs">
                  No Pages yet. Connect a Facebook Page to see its numbers.
                </td>
              </tr>
            </tbody>
            <tfoot v-if="dashboard.pages.length > 1" class="bg-slate-50 border-t-2 border-slate-200 font-bold text-slate-900">
              <tr>
                <td></td>
                <td class="py-3 px-4">Total ({{ dashboard.pages.length }} Pages)</td>
                <td class="py-3 px-4 text-right">{{ formatNumber(dashboard.totals.followers) }}</td>
                <td class="py-3 px-4 text-right">{{ formatNumber(dashboard.totals.views) }}</td>
                <td class="py-3 px-4 text-right">{{ formatNumber(dashboard.totals.views_7d) }}</td>
                <td class="py-3 px-4 text-right">{{ formatNumber(dashboard.totals.engagement) }}</td>
                <td class="py-3 px-4 text-right">{{ formatNumber(dashboard.totals.reels_count) }}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <!-- ONE PAGE: day by day + Reels list -->
      <div v-if="selectedPage" class="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div class="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
          <div class="p-4 border-b border-slate-100 flex items-center justify-between">
            <h3 class="font-bold text-sm text-slate-800">Day by day</h3>
            <span class="text-xs text-slate-500 font-medium">{{ selectedPage.daily.length }} days</span>
          </div>
          <div class="overflow-x-auto max-h-96 overflow-y-auto scrollbar-thin">
            <table class="w-full text-xs text-left">
              <thead class="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200 sticky top-0">
                <tr>
                  <th class="py-2.5 px-4">Date</th>
                  <th class="py-2.5 px-4 text-right">Views</th>
                  <th class="py-2.5 px-4 text-right">Engagement</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                <tr v-for="d in [...selectedPage.daily].reverse()" :key="d.date">
                  <td class="py-2 px-4 font-mono text-slate-600">{{ formatDay(d.date) }}</td>
                  <td class="py-2 px-4 text-right font-semibold text-blue-600">{{ formatNumber(d.views) }}</td>
                  <td class="py-2 px-4 text-right text-emerald-600">{{ formatNumber(d.engagement) }}</td>
                </tr>
                <tr v-if="!selectedPage.daily.length">
                  <td colspan="3" class="text-center py-8 text-slate-400">Facebook did not return daily insights for this Page.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
          <div class="p-4 border-b border-slate-100 flex items-center justify-between">
            <h3 class="font-bold text-sm text-slate-800">Reels ({{ formatNumber(selectedPage.reels_count) }})</h3>
            <span class="text-xs text-slate-500 font-medium">Posted in this period</span>
          </div>
          <div class="max-h-96 overflow-y-auto divide-y divide-slate-100 scrollbar-thin">
            <a
              v-for="reel in selectedPage.reels"
              :key="reel.video_id"
              :href="reel.permalink_url"
              target="_blank"
              rel="noopener noreferrer"
              class="block px-4 py-3 hover:bg-slate-50 transition"
            >
              <p class="text-xs font-semibold text-slate-800 line-clamp-2 break-words">{{ reel.description || "(no caption)" }}</p>
              <p class="text-[10px] text-slate-400 mt-0.5">{{ formatDateTime(reel.created_time) }}</p>
            </a>
            <p v-if="!selectedPage.reels.length" class="text-center py-8 text-slate-400 text-xs">No Reels were posted in this period.</p>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useAnalytics } from "../../composables/useAnalytics";
import { usePages } from "../../composables/usePages";

const { dashboard, isLoading, isSyncing, rangeDays, loadAnalytics, syncInsights } = useAnalytics();
const selectedPageId = ref("");

/** Same number for a Page on every screen: its position in the full Page list */
const { pages: allPages } = usePages();
const pageNumbers = computed(() => new Map(allPages.value.map((p, i) => [p.facebook_page_id, i + 1])));
const pageNumber = (id: string, fallbackIdx: number) => pageNumbers.value.get(id) ?? fallbackIdx + 1;

onMounted(() => {
  loadAnalytics();
});

watch(dashboard, (d) => {
  if (selectedPageId.value && !d?.pages.some((p) => p.page_id === selectedPageId.value)) selectedPageId.value = "";
});

const selectedPage = computed(() => dashboard.value?.pages.find((p) => p.page_id === selectedPageId.value) || null);

const formatNumber = (num: number | null | undefined): string => {
  if (num === null || num === undefined || !Number.isFinite(num)) return "—";
  return new Intl.NumberFormat("en-US").format(num);
};

const VN_TZ = "Asia/Ho_Chi_Minh";
const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: VN_TZ, ...opts }).format(new Date(iso));
  } catch {
    return iso;
  }
};
const formatTime = (iso: string) => fmt(iso, { hour: "2-digit", minute: "2-digit", hour12: false });
const formatDateTime = (iso: string) =>
  fmt(iso, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
/** YYYY-MM-DD -> "07 Nov" (plain date, no timezone shift) */
const formatDay = (date: string) => {
  const [y, m, d] = (date || "").split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }).format(Date.UTC(y, m - 1, d));
};

/** Same five numbers for one Page or for the total of all Pages */
const cards = computed(() => {
  const days = dashboard.value?.range_days || rangeDays.value;
  const src = selectedPage.value || dashboard.value?.totals;
  const scope = selectedPage.value ? "Fanpage này" : `Tổng ${dashboard.value?.pages.length || 0} Fanpage`;
  return [
    { label: "Người theo dõi", value: src?.followers ?? null, hint: scope, tone: "text-slate-500", help: "Tổng số người theo dõi hiện tại." },
    {
      label: "Lượt xem video",
      value: src?.views ?? null,
      hint: `${days} ngày qua`,
      tone: "text-blue-600",
      help: "Tổng lượt xem video/media trên Fanpage."
    },
    {
      label: "Lượt xem 7 ngày",
      value: src?.views_7d ?? null,
      hint: "7 ngày gần nhất",
      tone: "text-indigo-600",
      help: "Lượt xem trong 7 ngày gần nhất."
    },
    {
      label: "Lượt tương tác",
      value: src?.engagement ?? null,
      hint: `${days} ngày qua`,
      tone: "text-emerald-600",
      help: "Tổng lượt cảm xúc, bình luận, chia sẻ và tương tác trên Fanpage."
    },
    {
      label: "Số bài Reels",
      value: src?.reels_count ?? null,
      hint: `Đã xuất bản (${days} ngày)`,
      tone: "text-purple-600",
      help: "Tổng số bài Reels đã đăng thành công."
    }
  ];
});

const statusLabel = (s: string) =>
  s === "ok" ? "✓ OK" : s === "partial" ? "Partial data" : s === "reconnect" ? "Reconnect" : "Unavailable";
const statusClass = (s: string) =>
  s === "ok" ? "bg-emerald-50 text-emerald-700" : s === "partial" ? "bg-amber-50 text-amber-700" : "bg-rose-50 text-rose-700";

// Chart
const chartPoints = computed(() => {
  const source = selectedPage.value ? selectedPage.value.daily : dashboard.value?.time_series || [];
  const ts = source.filter((p) => p.views !== null || p.engagement !== null);
  if (ts.length === 0) return [];
  const maxVal = Math.max(1, ...ts.map((p) => Math.max(p.views ?? 0, p.engagement ?? 0)));
  const stepX = ts.length > 1 ? 760 / (ts.length - 1) : 0;
  return ts.map((pt, idx) => ({
    date: formatDay(pt.date),
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

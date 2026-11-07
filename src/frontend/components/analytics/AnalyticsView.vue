<template>
  <div class="h-full flex flex-col p-4 lg:p-6 overflow-y-auto select-none">
    <!-- Top Bar: Header & Sync Now Button -->
    <div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 mb-6 bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
      <div>
        <h2 class="text-base font-bold text-slate-800">
          {{ t('analytics_overview') }}
        </h2>
        <p class="text-xs text-slate-500 mt-0.5">
          Dữ liệu thống kê Reels & Fanpage được tổng hợp trực tiếp từ Meta Graph API chính thức.
          <span v-if="dashboard?.last_synced_at" class="text-slate-400 ml-1">
            (Đồng bộ lần cuối: {{ formatLastSync(dashboard.last_synced_at) }})
          </span>
        </p>
      </div>

      <div class="flex items-center gap-2">
        <button
          type="button"
          :disabled="isSyncing"
          @click="syncInsights"
          class="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold text-xs shadow-sm transition"
        >
          <svg class="w-4 h-4" :class="{ 'animate-spin': isSyncing }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          <span>{{ isSyncing ? t('syncing') : t('sync_now') }}</span>
        </button>
      </div>
    </div>

    <!-- 4 Overview Metric Cards -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      <!-- 1. FOLLOWERS -->
      <div class="bg-white rounded-2xl border border-slate-200 p-4 shadow-xs relative overflow-hidden group">
        <div class="flex items-center justify-between pb-2 text-slate-400">
          <span class="text-[11px] font-bold tracking-wider uppercase text-slate-500">{{ t('card_followers') }}</span>
          <div class="w-8 h-8 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
            </svg>
          </div>
        </div>
        <p class="text-2xl font-black text-slate-900 tracking-tight">
          {{ formatNumber(dashboard?.total_followers || 0) }}
        </p>
        <span class="text-[10px] text-emerald-600 font-semibold mt-1 block">
          Tổng lượt theo dõi thực tế trên các Fanpage
        </span>
      </div>

      <!-- 2. VIEWS 7D -->
      <div class="bg-white rounded-2xl border border-slate-200 p-4 shadow-xs relative overflow-hidden group">
        <div class="flex items-center justify-between pb-2 text-slate-400">
          <span class="text-[11px] font-bold tracking-wider uppercase text-slate-500">{{ t('card_views_7d') }}</span>
          <div class="w-8 h-8 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </div>
        </div>
        <p class="text-2xl font-black text-slate-900 tracking-tight">
          {{ formatNumber(dashboard?.views_7d || 0) }}
        </p>
        <span class="text-[10px] text-indigo-600 font-semibold mt-1 block">
          Lượt xem Video Reels trong 7 ngày qua
        </span>
      </div>

      <!-- 3. VIEWS 30D -->
      <div class="bg-white rounded-2xl border border-slate-200 p-4 shadow-xs relative overflow-hidden group">
        <div class="flex items-center justify-between pb-2 text-slate-400">
          <span class="text-[11px] font-bold tracking-wider uppercase text-slate-500">{{ t('card_views_30d') }}</span>
          <div class="w-8 h-8 rounded-xl bg-purple-50 text-purple-600 flex items-center justify-center">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          </div>
        </div>
        <p class="text-2xl font-black text-slate-900 tracking-tight">
          {{ formatNumber(dashboard?.views_30d || 0) }}
        </p>
        <span class="text-[10px] text-purple-600 font-semibold mt-1 block">
          Tổng lượt xem Video Reels trong tháng
        </span>
      </div>

      <!-- 4. NEW FOLLOWS 30D -->
      <div class="bg-white rounded-2xl border border-slate-200 p-4 shadow-xs relative overflow-hidden group">
        <div class="flex items-center justify-between pb-2 text-slate-400">
          <span class="text-[11px] font-bold tracking-wider uppercase text-slate-500">{{ t('card_new_follows_30d') }}</span>
          <div class="w-8 h-8 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 9v3m0 0v3m0-3h3m-3-3h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
            </svg>
          </div>
        </div>
        <p class="text-2xl font-black text-slate-900 tracking-tight">
          +{{ formatNumber(dashboard?.new_follows_30d || 0) }}
        </p>
        <span class="text-[10px] text-emerald-600 font-semibold mt-1 block">
          Lượt theo dõi mới tăng thêm 30 ngày
        </span>
      </div>
    </div>

    <!-- Reels View Trends SVG Chart -->
    <div class="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 mb-6 shadow-xs">
      <div class="flex items-center justify-between pb-4 border-b border-slate-100 mb-4">
        <h3 class="font-bold text-sm text-slate-800">
          {{ t('reels_performance_chart') }}
        </h3>
        <div class="flex items-center gap-4 text-xs font-semibold">
          <span class="flex items-center gap-1.5 text-blue-600">
            <span class="w-2.5 h-2.5 rounded-full bg-blue-600"></span>
            Lượt xem (Views)
          </span>
          <span class="flex items-center gap-1.5 text-indigo-500">
            <span class="w-2.5 h-2.5 rounded-full bg-indigo-500"></span>
            Tiếp cận (Reach)
          </span>
        </div>
      </div>

      <!-- Custom Pure SVG Chart -->
      <div class="w-full h-56 relative">
        <svg class="w-full h-full overflow-visible" viewBox="0 0 800 200" preserveAspectRatio="none">
          <!-- Horizontal Grid Lines -->
          <line x1="0" y1="40" x2="800" y2="40" stroke="#f1f5f9" stroke-width="1" />
          <line x1="0" y1="100" x2="800" y2="100" stroke="#f1f5f9" stroke-width="1" />
          <line x1="0" y1="160" x2="800" y2="160" stroke="#f1f5f9" stroke-width="1" />

          <!-- Views Path (Blue Area & Line) -->
          <path
            :d="chartViewsAreaPath"
            fill="url(#blueGradient)"
            opacity="0.2"
          />
          <path
            :d="chartViewsLinePath"
            fill="none"
            stroke="#2563eb"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />

          <!-- Reach Line (Indigo) -->
          <path
            :d="chartReachLinePath"
            fill="none"
            stroke="#6366f1"
            stroke-width="2.5"
            stroke-dasharray="4 4"
            stroke-linecap="round"
          />

          <!-- Points -->
          <circle
            v-for="(pt, idx) in chartPoints"
            :key="idx"
            :cx="pt.x"
            :cy="pt.yViews"
            r="4"
            fill="#2563eb"
            stroke="#ffffff"
            stroke-width="2"
          />

          <defs>
            <linearGradient id="blueGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#2563eb" />
              <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
            </linearGradient>
          </defs>
        </svg>

        <!-- X-Axis Labels -->
        <div class="flex items-center justify-between text-[11px] text-slate-400 pt-2 font-mono">
          <span v-for="pt in chartPoints" :key="pt.date">{{ pt.date }}</span>
        </div>
      </div>
    </div>

    <!-- Page Performance Comparison Table -->
    <div class="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs flex-1">
      <div class="p-4 border-b border-slate-100 flex items-center justify-between">
        <h3 class="font-bold text-sm text-slate-800">
          {{ t('page_comparison_title') }}
        </h3>
        <span class="text-xs text-slate-500 font-medium">
          {{ (dashboard?.pages || []).length }} Fanpage đã kết nối
        </span>
      </div>

      <div class="overflow-x-auto scrollbar-thin">
        <table class="w-full text-xs text-left">
          <thead class="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
            <tr>
              <th class="py-3 px-4">{{ t('col_page') }}</th>
              <th class="py-3 px-4 text-right">{{ t('col_followers') }}</th>
              <th class="py-3 px-4 text-right">{{ t('col_posts') }}</th>
              <th class="py-3 px-4 text-right">{{ t('col_views') }}</th>
              <th class="py-3 px-4 text-right">{{ t('col_reach') }}</th>
              <th class="py-3 px-4 text-right">{{ t('col_likes') }}</th>
              <th class="py-3 px-4 text-right">{{ t('col_comments') }}</th>
              <th class="py-3 px-4 text-right">{{ t('col_shares') }}</th>
              <th class="py-3 px-4 text-center">Trạng thái Token</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr
              v-for="page in (dashboard?.pages || [])"
              :key="page.page_id"
              class="hover:bg-slate-50/70 transition"
            >
              <!-- Page Name & Avatar -->
              <td class="py-3 px-4">
                <div class="flex items-center gap-2.5 min-w-0">
                  <div class="w-8 h-8 rounded-full bg-slate-200 overflow-hidden flex-shrink-0 border border-slate-200">
                    <img v-if="page.avatar_url" :src="page.avatar_url" class="w-full h-full object-cover" />
                    <span v-else class="w-full h-full flex items-center justify-center font-bold text-slate-500 text-[10px]">FB</span>
                  </div>
                  <div class="min-w-0">
                    <p class="font-bold text-slate-800 truncate text-xs">{{ page.page_name }}</p>
                    <p class="text-[10px] text-slate-400 font-mono truncate">{{ page.page_id }}</p>
                  </div>
                </div>
              </td>

              <!-- Followers -->
              <td class="py-3 px-4 text-right font-bold text-slate-900">
                {{ formatNumber(page.followers_count || 0) }}
              </td>

              <!-- Total Reels -->
              <td class="py-3 px-4 text-right text-slate-700">
                {{ formatNumber(page.total_reels || 0) }}
              </td>

              <!-- Total Views -->
              <td class="py-3 px-4 text-right font-bold text-blue-600">
                {{ formatNumber(page.total_views || 0) }}
              </td>

              <!-- Total Reach -->
              <td class="py-3 px-4 text-right text-slate-700">
                {{ formatNumber(page.total_reach || 0) }}
              </td>

              <!-- Likes -->
              <td class="py-3 px-4 text-right text-slate-700">
                {{ formatNumber(page.total_likes || 0) }}
              </td>

              <!-- Comments -->
              <td class="py-3 px-4 text-right text-slate-700">
                {{ formatNumber(page.total_comments || 0) }}
              </td>

              <!-- Shares -->
              <td class="py-3 px-4 text-right text-slate-700">
                {{ formatNumber(page.total_shares || 0) }}
              </td>

              <!-- Token Status -->
              <td class="py-3 px-4 text-center">
                <span
                  class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold"
                  :class="page.token_status === 'valid' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'"
                >
                  <span>{{ page.token_status === 'valid' ? '✓ Hợp lệ' : '! Hết hạn' }}</span>
                </span>
              </td>
            </tr>

            <tr v-if="!dashboard?.pages || dashboard.pages.length === 0">
              <td colspan="9" class="text-center py-10 text-slate-400 text-xs">
                Chưa có dữ liệu thống kê từ Facebook. Hãy nhấn "Đồng bộ ngay" để cập nhật số liệu.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useI18n } from "../../utils/i18n";
import { useAnalytics } from "../../composables/useAnalytics";

const { t } = useI18n();
const { dashboard, isSyncing, loadAnalytics, syncInsights } = useAnalytics();

onMounted(() => {
  loadAnalytics();
});

const formatNumber = (num: number): string => {
  return new Intl.NumberFormat("vi-VN").format(num);
};

const formatLastSync = (isoStr: string): string => {
  try {
    const d = new Date(isoStr);
    return new Intl.DateTimeFormat("vi-VN", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit"
    }).format(d);
  } catch {
    return isoStr;
  }
};

// SVG Chart Calculations
const chartPoints = computed(() => {
  const ts = dashboard.value?.time_series || [];
  if (ts.length === 0) {
    // Generate placeholder 7 days
    const mock = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(now.getDate() - i);
      const ds = `${d.getDate()}/${d.getMonth() + 1}`;
      mock.push({ date: ds, views: 0, reach: 0 });
    }
    return mock.map((pt, idx) => ({
      date: pt.date,
      x: 50 + idx * 115,
      yViews: 170,
      yReach: 170
    }));
  }

  const maxVal = Math.max(...ts.map((p) => Math.max(p.views, p.reach, 100)));
  const stepX = 700 / Math.max(ts.length - 1, 1);

  return ts.map((pt, idx) => ({
    date: pt.date.substring(5), // MM-DD
    x: 50 + idx * stepX,
    yViews: 170 - (pt.views / maxVal) * 140,
    yReach: 170 - (pt.reach / maxVal) * 140
  }));
});

const chartViewsLinePath = computed(() => {
  const pts = chartPoints.value;
  if (pts.length === 0) return "";
  return pts.reduce((acc, pt, i) => `${acc} ${i === 0 ? "M" : "L"} ${pt.x} ${pt.yViews}`, "");
});

const chartViewsAreaPath = computed(() => {
  const pts = chartPoints.value;
  if (pts.length === 0) return "";
  const line = chartViewsLinePath.value;
  const last = pts[pts.length - 1];
  const first = pts[0];
  return `${line} L ${last.x} 180 L ${first.x} 180 Z`;
});

const chartReachLinePath = computed(() => {
  const pts = chartPoints.value;
  if (pts.length === 0) return "";
  return pts.reduce((acc, pt, i) => `${acc} ${i === 0 ? "M" : "L"} ${pt.x} ${pt.yReach}`, "");
});
</script>

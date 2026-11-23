<template>
  <div class="h-full p-3 lg:p-4 overflow-y-auto select-none">
    <!-- Thanh cố định: khoảng thời gian + menu con chọn Fanpage + nút về Tất cả Fanpage -->
    <div class="sticky top-0 z-20 mb-3 bg-white/95 backdrop-blur-md px-3 py-2.5 rounded-2xl border border-slate-200/80 shadow-xs">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-sm font-extrabold text-slate-800 mr-1">📊 Thống kê</h2>

        <!-- 30 ngày | Tất cả -->
        <div class="flex items-center bg-slate-100 p-0.5 rounded-xl">
          <button
            v-for="opt in rangeOptions"
            :key="opt.key"
            type="button"
            class="px-3 py-1 rounded-lg text-xs font-bold transition"
            :class="range === opt.key ? 'bg-white text-blue-700 shadow-xs' : 'text-slate-500 hover:text-slate-800'"
            @click="setRange(opt.key)"
          >
            {{ opt.label }}
          </button>
        </div>

        <!-- Menu con: xem chi tiết 1 Fanpage -->
        <div ref="pageMenuRef" class="relative ml-auto">
          <button
            type="button"
            class="flex items-center gap-1.5 px-2.5 py-1 rounded-xl border text-xs font-bold transition max-w-[200px]"
            :class="selectedPage ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'"
            @click="pageMenuOpen = !pageMenuOpen"
          >
            <span class="truncate">{{ selectedPage ? selectedPage.page_name : "Chi tiết Fanpage" }}</span>
            <svg class="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <div
            v-if="pageMenuOpen"
            class="absolute right-0 mt-1.5 w-64 bg-white rounded-2xl shadow-xl border border-slate-200/80 z-30 text-xs overflow-hidden"
          >
            <div class="p-2 border-b border-slate-100">
              <input
                v-model="pageQuery"
                type="text"
                placeholder="Tìm Fanpage..."
                class="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:border-blue-400"
              />
            </div>
            <div class="max-h-72 overflow-y-auto py-1">
              <button type="button" class="page-item" :class="{ 'text-blue-700 bg-blue-50/60': !selectedPage }" @click="pickPage('')">
                <span class="font-bold">Tất cả Fanpage</span>
              </button>
              <button
                v-for="p in filteredMenuPages"
                :key="p.page_id"
                type="button"
                class="page-item"
                :class="{ 'text-blue-700 bg-blue-50/60': p.page_id === selectedPageId }"
                @click="pickPage(p.page_id)"
              >
                <img v-if="p.avatar_url" :src="p.avatar_url" class="w-5 h-5 rounded-full object-cover shrink-0" alt="" />
                <span v-else class="w-5 h-5 rounded-full bg-slate-200 shrink-0"></span>
                <span class="truncate">{{ p.page_name }}</span>
              </button>
              <p v-if="!filteredMenuPages.length" class="px-3 py-2 text-slate-400">Không có Fanpage phù hợp.</p>
            </div>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-[11px] text-slate-500">
        <button
          v-if="selectedPage"
          type="button"
          class="font-bold text-blue-600 hover:text-blue-800"
          @click="pickPage('')"
        >
          ← Tất cả Fanpage
        </button>
        <span v-if="dashboard">{{ rangeText }}</span>
        <span v-if="dashboard?.synced_at || dashboard?.fetched_at" class="text-slate-400">
          · Cập nhật {{ formatTime(dashboard.synced_at || dashboard.fetched_at) }} (tự đồng bộ 6 tiếng/lần)
        </span>
      </div>
    </div>

    <div v-if="isLoading && !dashboard" class="flex items-center justify-center text-xs text-slate-400 py-20">
      Đang tải số liệu...
    </div>

    <template v-else-if="dashboard">
      <!-- Cảnh báo: thu gọn 1 dòng, bấm để xem -->
      <button
        v-if="dashboard.warnings.length"
        type="button"
        class="w-full mb-3 px-3 py-2 rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-[11px] text-left"
        @click="showWarnings = !showWarnings"
      >
        <span class="font-bold">⚠️ {{ dashboard.warnings.length }} lưu ý về dữ liệu</span>
        <span class="text-amber-600 ml-1">{{ showWarnings ? "▴ Ẩn" : "▾ Xem" }}</span>
        <span v-if="showWarnings" class="block mt-1 space-y-1 font-normal">
          <span v-for="(w, i) in dashboard.warnings" :key="i" class="block">{{ w }}</span>
        </span>
      </button>

      <!-- Fanpage đang xem -->
      <div v-if="selectedPage" class="mb-3 flex items-center gap-3 bg-white px-3 py-2.5 rounded-2xl border border-slate-200 shadow-xs">
        <img v-if="selectedPage.avatar_url" :src="selectedPage.avatar_url" class="w-9 h-9 rounded-full object-cover border border-slate-200" alt="" />
        <div class="min-w-0">
          <a
            :href="`https://www.facebook.com/${selectedPage.page_id}`"
            target="_blank"
            rel="noopener noreferrer"
            class="font-bold text-sm text-slate-800 hover:text-blue-600 truncate block"
          >
            {{ selectedPage.page_name }} ↗
          </a>
          <p class="text-[11px]" :class="selectedPage.status === 'ok' ? 'text-emerald-600' : 'text-amber-700'">
            {{ selectedPage.status === "ok" ? "Đủ số liệu" : selectedPage.status_message }}
          </p>
        </div>
      </div>

      <!-- 5 số chính -->
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-2.5 mb-3">
        <div
          v-for="card in cards"
          :key="card.label"
          class="bg-white rounded-2xl border border-slate-200/80 border-t-[3px] p-3 shadow-xs"
          :class="card.border"
          :title="card.help"
        >
          <span class="text-[10px] font-bold tracking-wider uppercase text-slate-500">{{ card.label }}</span>
          <p class="text-xl font-black text-slate-900 tracking-tight mt-1">{{ formatNumber(card.value) }}</p>
          <span class="text-[10px] font-bold mt-0.5 block" :class="card.tone">{{ card.hint }}</span>
        </div>
      </div>

      <!-- Biểu đồ theo ngày -->
      <div class="bg-white rounded-2xl border border-slate-200 p-3 mb-3 shadow-xs">
        <div class="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-100 mb-3">
          <h3 class="font-bold text-sm text-slate-800">Hoạt động theo ngày</h3>
          <div class="flex items-center gap-3 text-[11px] font-semibold">
            <span class="flex items-center gap-1.5 text-blue-600"><span class="w-2 h-2 rounded-full bg-blue-600"></span>Lượt xem</span>
            <span class="flex items-center gap-1.5 text-emerald-600"><span class="w-2 h-2 rounded-full bg-emerald-500"></span>Tương tác</span>
          </div>
        </div>
        <div v-if="chartPoints.length === 0" class="h-32 flex items-center justify-center text-xs text-slate-400 text-center px-6">
          Facebook chưa trả số liệu theo ngày cho khoảng này.
        </div>
        <div v-else class="w-full h-40 relative">
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
          <div class="flex items-center justify-between text-[10px] text-slate-400 pt-1 font-mono">
            <span v-for="label in xLabels" :key="label">{{ label }}</span>
          </div>
        </div>
      </div>

      <!-- TẤT CẢ FANPAGE: bảng từng Page, bấm 1 dòng để xem chi tiết -->
      <div v-if="!selectedPage" class="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs mb-4">
        <div class="px-3 py-2.5 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2">
          <h3 class="font-bold text-sm text-slate-800">Theo Fanpage</h3>
          <span class="text-[11px] text-slate-400">Bấm 1 Fanpage để xem chi tiết · "—" = Facebook chưa trả số liệu</span>
        </div>
        <div class="overflow-x-auto scrollbar-thin">
          <table class="w-full text-xs text-left">
            <thead class="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
              <tr>
                <th class="py-2 px-3">Fanpage</th>
                <th class="py-2 px-2 text-right">Theo dõi</th>
                <th class="py-2 px-2 text-right">Lượt xem</th>
                <th class="py-2 px-2 text-right">Tương tác</th>
                <th class="py-2 px-2 text-right">Reels</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr
                v-for="page in dashboard.pages"
                :key="page.page_id"
                class="hover:bg-blue-50/50 cursor-pointer transition"
                @click="pickPage(page.page_id)"
              >
                <td class="py-2 px-3">
                  <div class="flex items-center gap-2 min-w-0">
                    <span
                      class="w-1.5 h-1.5 rounded-full shrink-0"
                      :class="page.status === 'ok' ? 'bg-emerald-500' : page.status === 'partial' ? 'bg-amber-500' : 'bg-rose-500'"
                      :title="page.status === 'ok' ? 'Đủ số liệu' : page.status_message"
                    ></span>
                    <img v-if="page.avatar_url" :src="page.avatar_url" class="w-6 h-6 rounded-full object-cover shrink-0" alt="" />
                    <span class="font-bold text-slate-800 truncate max-w-[160px]">{{ page.page_name }}</span>
                  </div>
                </td>
                <td class="py-2 px-2 text-right font-semibold text-slate-900">{{ formatNumber(page.followers) }}</td>
                <td class="py-2 px-2 text-right font-semibold text-blue-600">{{ formatNumber(page.views) }}</td>
                <td class="py-2 px-2 text-right text-emerald-600">{{ formatNumber(page.engagement) }}</td>
                <td class="py-2 px-2 text-right text-purple-600">{{ formatNumber(page.reels_count) }}</td>
              </tr>
              <tr v-if="!dashboard.pages.length">
                <td colspan="5" class="text-center py-8 text-slate-400">Chưa có Fanpage. Thêm Token ở menu ⋯ để kết nối.</td>
              </tr>
            </tbody>
            <tfoot v-if="dashboard.pages.length > 1" class="bg-slate-50 border-t-2 border-slate-200 font-bold text-slate-900">
              <tr>
                <td class="py-2 px-3">Tổng ({{ dashboard.pages.length }} Fanpage)</td>
                <td class="py-2 px-2 text-right">{{ formatNumber(dashboard.totals.followers) }}</td>
                <td class="py-2 px-2 text-right">{{ formatNumber(dashboard.totals.views) }}</td>
                <td class="py-2 px-2 text-right">{{ formatNumber(dashboard.totals.engagement) }}</td>
                <td class="py-2 px-2 text-right">{{ formatNumber(dashboard.totals.reels_count) }}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <!-- 1 FANPAGE: theo ngày + danh sách Reels -->
      <div v-if="selectedPage" class="space-y-3 mb-4">
        <div class="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
          <div class="px-3 py-2.5 border-b border-slate-100 flex items-center justify-between">
            <h3 class="font-bold text-sm text-slate-800">Theo ngày</h3>
            <span class="text-[11px] text-slate-400">{{ selectedPage.daily.length }} ngày</span>
          </div>
          <div class="max-h-80 overflow-y-auto scrollbar-thin">
            <table class="w-full text-xs text-left">
              <thead class="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200 sticky top-0">
                <tr>
                  <th class="py-2 px-3">Ngày</th>
                  <th class="py-2 px-3 text-right">Lượt xem</th>
                  <th class="py-2 px-3 text-right">Tương tác</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                <tr v-for="d in [...selectedPage.daily].reverse()" :key="d.date">
                  <td class="py-1.5 px-3 font-mono text-slate-600">{{ formatDay(d.date) }}</td>
                  <td class="py-1.5 px-3 text-right font-semibold text-blue-600">{{ formatNumber(d.views) }}</td>
                  <td class="py-1.5 px-3 text-right text-emerald-600">{{ formatNumber(d.engagement) }}</td>
                </tr>
                <tr v-if="!selectedPage.daily.length">
                  <td colspan="3" class="text-center py-6 text-slate-400">Facebook chưa trả số liệu theo ngày cho Fanpage này.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
          <div class="px-3 py-2.5 border-b border-slate-100 flex items-center justify-between">
            <h3 class="font-bold text-sm text-slate-800">Reels gần đây ({{ selectedPage.reels.length }})</h3>
            <span class="text-[11px] text-slate-400">30 ngày gần nhất</span>
          </div>
          <div class="max-h-80 overflow-y-auto divide-y divide-slate-100 scrollbar-thin">
            <a
              v-for="reel in selectedPage.reels"
              :key="reel.video_id"
              :href="reel.permalink_url"
              target="_blank"
              rel="noopener noreferrer"
              class="block px-3 py-2 hover:bg-slate-50 transition"
            >
              <p class="text-xs font-semibold text-slate-800 line-clamp-2 break-words">{{ reel.description || "(không có caption)" }}</p>
              <p class="text-[10px] text-slate-400 mt-0.5">{{ formatDateTime(reel.created_time) }}</p>
            </a>
            <p v-if="!selectedPage.reels.length" class="text-center py-6 text-slate-400 text-xs">Chưa có Reels trong 30 ngày gần nhất.</p>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useAnalytics } from "../../composables/useAnalytics";
import type { AnalyticsRange } from "../../services/api";

const { dashboard, isLoading, range, loadAnalytics } = useAnalytics();

const rangeOptions: Array<{ key: AnalyticsRange; label: string }> = [
  { key: "30", label: "30 ngày" },
  { key: "all", label: "Tất cả" }
];
const isAllTime = computed(() => range.value === "all");
const setRange = (r: AnalyticsRange) => {
  if (range.value === r) return;
  range.value = r;
  loadAnalytics();
};

onMounted(() => {
  loadAnalytics();
  document.addEventListener("click", onDocClick);
});
onUnmounted(() => document.removeEventListener("click", onDocClick));

// ---- Menu con chọn Fanpage ----
const selectedPageId = ref("");
const pageMenuOpen = ref(false);
const pageQuery = ref("");
const pageMenuRef = ref<HTMLElement | null>(null);
const onDocClick = (e: MouseEvent) => {
  if (!pageMenuRef.value?.contains(e.target as Node)) pageMenuOpen.value = false;
};
const filteredMenuPages = computed(() => {
  const q = pageQuery.value.trim().toLowerCase();
  const list = dashboard.value?.pages || [];
  return q ? list.filter((p) => p.page_name.toLowerCase().includes(q)) : list;
});
const pickPage = (id: string) => {
  selectedPageId.value = id;
  pageMenuOpen.value = false;
  pageQuery.value = "";
};

watch(dashboard, (d) => {
  if (selectedPageId.value && !d?.pages.some((p) => p.page_id === selectedPageId.value)) selectedPageId.value = "";
});

const selectedPage = computed(() => dashboard.value?.pages.find((p) => p.page_id === selectedPageId.value) || null);
const showWarnings = ref(false);

// ---- Định dạng ----
const formatNumber = (num: number | null | undefined): string => {
  if (num === null || num === undefined || !Number.isFinite(num)) return "—";
  return new Intl.NumberFormat("vi-VN").format(num);
};
const VN_TZ = "Asia/Ho_Chi_Minh";
const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => {
  try {
    return new Intl.DateTimeFormat("vi-VN", { timeZone: VN_TZ, ...opts }).format(new Date(iso));
  } catch {
    return iso;
  }
};
const formatTime = (iso: string) => fmt(iso, { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", hour12: false });
const formatDateTime = (iso: string) =>
  fmt(iso, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
/** YYYY-MM-DD -> dd/mm (ngày thuần, không đổi múi giờ) */
const formatDay = (date: string) => {
  const [y, m, d] = (date || "").split("-");
  return y && m && d ? `${d}/${m}` : date;
};
const formatFullDay = (date: string) => {
  const [y, m, d] = (date || "").split("-");
  return y && m && d ? `${d}/${m}/${y}` : date;
};

const rangeText = computed(() => {
  const d = dashboard.value;
  if (!d) return "";
  return isAllTime.value
    ? `Tất cả từ ${formatFullDay(d.range_start)} (cộng dồn dữ liệu đã lưu)`
    : `${formatFullDay(d.range_start)} – ${formatFullDay(d.range_end)}`;
});

/** 5 số chính, cho 1 Fanpage hoặc tổng các Fanpage */
const cards = computed(() => {
  const src = selectedPage.value || dashboard.value?.totals;
  const period = isAllTime.value ? "Tất cả" : "30 ngày qua";
  return [
    { label: "Người theo dõi", value: src?.followers ?? null, hint: "Hiện tại", tone: "text-slate-500", border: "border-t-blue-500", help: "Số người theo dõi hiện tại." },
    { label: "Lượt xem", value: src?.views ?? null, hint: period, tone: "text-blue-600", border: "border-t-indigo-500", help: "Tổng lượt xem video/media trên Fanpage." },
    { label: "Lượt xem 7 ngày", value: src?.views_7d ?? null, hint: "7 ngày gần nhất", tone: "text-indigo-600", border: "border-t-purple-500", help: "Lượt xem trong 7 ngày gần nhất." },
    { label: "Tương tác", value: src?.engagement ?? null, hint: period, tone: "text-emerald-600", border: "border-t-emerald-500", help: "Cảm xúc, bình luận, chia sẻ và tương tác khác." },
    {
      label: "Số Reels",
      value: src?.reels_count ?? null,
      hint: isAllTime.value ? "Đã đăng qua công cụ" : "Đăng trong 30 ngày",
      tone: "text-purple-600",
      border: "border-t-rose-500",
      help: isAllTime.value ? "Số Reels đăng thành công qua công cụ này." : "Số Reels đăng trên Fanpage trong 30 ngày."
    }
  ];
});

// ---- Biểu đồ ----
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
/** Tối đa 6 nhãn ngày, cách đều */
const xLabels = computed(() => {
  const pts = chartPoints.value;
  if (pts.length <= 6) return pts.map((p) => p.date);
  const step = (pts.length - 1) / 5;
  return Array.from({ length: 6 }, (_, i) => pts[Math.round(i * step)].date);
});
</script>

<style scoped>
.page-item {
  @apply w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-slate-50 text-slate-700 font-semibold transition;
}
</style>

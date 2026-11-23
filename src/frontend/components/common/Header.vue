<template>
  <!-- Thanh trên cùng: luôn cố định, chứa mọi thứ cần bấm nhanh dù đang cuộn tới đâu -->
  <header class="bg-white/95 backdrop-blur-md border-b border-slate-200/80 px-3 sm:px-5 select-none z-30 flex-shrink-0 relative">
    <div class="absolute top-0 left-0 right-0 h-[2.5px] bg-gradient-to-r from-blue-500 via-indigo-500 to-pink-500"></div>

    <div class="h-14 flex items-center gap-2 sm:gap-3">
      <!-- Logo: về Lịch đăng -->
      <button type="button" class="flex items-center gap-2 shrink-0" title="Về Lịch đăng" @click="$emit('go-home')">
        <div class="w-8 h-8 rounded-lg bg-gradient-to-tr from-blue-500 via-indigo-500 to-pink-500 text-white flex items-center justify-center font-black text-xs shadow-xs">
          NNN
        </div>
        <span class="hidden xl:inline font-extrabold tracking-tight text-slate-900 text-sm">NNN REELS FB</span>
      </button>

      <!-- Số đếm trạng thái: bấm để lọc danh sách -->
      <div class="flex items-center gap-1 overflow-x-auto scrollbar-none min-w-0">
        <button
          v-for="chip in statusChips"
          :key="chip.key"
          type="button"
          class="px-2.5 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 shrink-0 border"
          :class="activeFilter === chip.key ? chip.active : 'bg-slate-50 text-slate-600 border-slate-200/70 hover:bg-slate-100'"
          :title="`Lọc: ${chip.label}`"
          @click="pickFilter(chip.key)"
        >
          <span class="w-1.5 h-1.5 rounded-full" :class="chip.dot"></span>
          <span class="hidden sm:inline">{{ chip.label }}</span>
          <span class="font-black">{{ chip.count }}</span>
        </button>
      </div>

      <!-- Biểu đồ mini thống kê: bấm để mở thống kê chi tiết -->
      <button
        type="button"
        class="hidden md:flex items-center gap-2 px-2.5 py-1 rounded-xl border border-slate-200/80 hover:border-emerald-300 hover:bg-emerald-50/40 transition shrink-0"
        title="Xem thống kê chi tiết"
        @click="$emit('open-panel', 'analytics')"
      >
        <svg class="w-24 h-8" viewBox="0 0 96 32" preserveAspectRatio="none">
          <path v-if="spark.views" :d="spark.views" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          <path v-if="spark.engagement" :d="spark.engagement" fill="none" stroke="#10b981" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          <line v-if="!spark.views" x1="0" y1="24" x2="96" y2="24" stroke="#e2e8f0" stroke-width="2" stroke-dasharray="4 3" />
        </svg>
        <div class="text-left leading-tight">
          <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Xem 7 ngày</p>
          <p class="text-xs font-black text-blue-600">{{ formatCompact(dashboard?.totals?.views_7d) }}</p>
        </div>
        <div class="text-left leading-tight hidden lg:block">
          <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Tương tác</p>
          <p class="text-xs font-black text-emerald-600">{{ formatCompact(dashboard?.totals?.engagement) }}</p>
        </div>
      </button>

      <div class="flex-1"></div>

      <!-- Làm mới -->
      <button
        type="button"
        class="p-2 sm:px-3 sm:py-1.5 rounded-xl border border-slate-200/90 bg-white hover:bg-blue-50/60 text-slate-600 hover:text-blue-700 text-xs font-bold transition shadow-2xs flex items-center gap-1.5 shrink-0"
        title="Làm mới danh sách bài và số liệu"
        :disabled="isRefreshing"
        @click="refreshAll"
      >
        <svg class="w-4 h-4" :class="{ 'animate-spin': isRefreshing }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        <span class="hidden lg:inline">Làm mới</span>
      </button>

      <!-- Menu ⋯: các phần ít dùng -->
      <div ref="moreMenuRef" class="relative shrink-0">
        <button
          type="button"
          class="p-2 rounded-xl border border-slate-200/90 bg-white hover:bg-slate-100 text-slate-600 transition shadow-2xs relative"
          title="Thêm"
          @click="toggleMenu('more')"
        >
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
          </svg>
          <span v-if="expiredAccounts.length" class="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-amber-500 border-2 border-white"></span>
        </button>
        <div v-if="openMenu === 'more'" class="absolute right-0 mt-1.5 w-64 bg-white rounded-2xl shadow-xl border border-slate-200/80 py-1.5 z-50 text-xs">
          <div class="px-3 py-2 border-b border-slate-100 mb-1 flex items-center gap-2">
            <div class="w-7 h-7 rounded-full bg-gradient-to-tr from-blue-100 to-indigo-100 text-indigo-700 flex items-center justify-center text-[11px] font-black border border-indigo-200">
              {{ initials }}
            </div>
            <div class="min-w-0">
              <p class="font-bold text-slate-800 truncate">{{ user?.display_name || user?.username || "Tài khoản" }}</p>
              <p class="text-[11px] text-slate-500">{{ pages.length }} Fanpage · {{ accounts.length }} tài khoản FB</p>
            </div>
          </div>
          <button type="button" class="menu-item" @click="pickPanel('analytics')">📊 <span>Thống kê chi tiết</span></button>
          <button type="button" class="menu-item" @click="pickPanel('pages')">📄 <span>Quản lý Fanpage</span></button>
          <button type="button" class="menu-item" @click="pickPanel('accounts')">
            👤 <span>Tài khoản Facebook Admin</span>
            <span v-if="expiredAccounts.length" class="ml-auto text-[10px] font-bold text-amber-700 bg-amber-50 px-1.5 rounded">hết hạn</span>
          </button>
          <button type="button" class="menu-item" @click="pickConnect">🔑 <span>Thêm Token / Page</span></button>
          <button v-if="isAdmin" type="button" class="menu-item" @click="pickPanel('admin')">🛡️ <span>Quản trị hệ thống</span></button>
          <div class="border-t border-slate-100 my-1"></div>
          <button type="button" class="menu-item text-rose-600" @click="handleLogout">↩ <span>Đăng xuất</span></button>
        </div>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { usePages } from "../../composables/usePages";
import { useAuth } from "../../composables/useAuth";
import { useTasks } from "../../composables/useTasks";
import { useAnalytics } from "../../composables/useAnalytics";

import type { PanelKey } from "../../router";

const emit = defineEmits<{
  (e: "go-home"): void;
  (e: "open-panel", panel: PanelKey): void;
  (e: "open-connect"): void;
}>();

const { pages, accounts, expiredAccounts } = usePages();
const { user, logout } = useAuth();
const { activeFilter, taskStats, loadTasks, isLoading } = useTasks();
const { dashboard, loadAnalytics, isLoading: analyticsLoading } = useAnalytics();

const isAdmin = computed(() => (user.value as any)?.role === "admin");
const initials = computed(() => (user.value?.display_name || user.value?.username || "U").substring(0, 2).toUpperCase());
const isRefreshing = computed(() => isLoading.value || analyticsLoading.value);

const statusChips = computed(() => [
  { key: "all", label: "Tất cả", count: taskStats.value.total, dot: "bg-slate-400", active: "bg-slate-800 text-white border-slate-800" },
  { key: "pending", label: "Chờ đăng", count: taskStats.value.pending, dot: "bg-amber-500", active: "bg-amber-50 text-amber-800 border-amber-300" },
  { key: "running", label: "Đang đăng", count: taskStats.value.running, dot: "bg-sky-500 animate-pulse", active: "bg-sky-50 text-sky-800 border-sky-300" },
  { key: "success", label: "Đã đăng", count: taskStats.value.success, dot: "bg-emerald-500", active: "bg-emerald-50 text-emerald-800 border-emerald-300" },
  { key: "failed", label: "Thất bại", count: taskStats.value.failed, dot: "bg-rose-500", active: "bg-rose-50 text-rose-800 border-rose-300" }
]);

// Đường biểu đồ mini từ chuỗi số liệu theo ngày (lấy tối đa 14 ngày gần nhất)
const spark = computed(() => {
  const ts = (dashboard.value?.time_series || []).slice(-14);
  if (ts.length < 2) return { views: "", engagement: "" };
  const max = Math.max(1, ...ts.map((p) => Math.max(p.views ?? 0, p.engagement ?? 0)));
  const step = 92 / (ts.length - 1);
  const path = (key: "views" | "engagement") =>
    ts.map((p, i) => `${i === 0 ? "M" : "L"} ${(2 + i * step).toFixed(1)} ${(29 - ((p[key] ?? 0) / max) * 26).toFixed(1)}`).join(" ");
  return { views: path("views"), engagement: path("engagement") };
});

const formatCompact = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : new Intl.NumberFormat("vi-VN", { notation: "compact", maximumFractionDigits: 1 }).format(n);

// Menu con: chỉ mở một cái, bấm ra ngoài thì đóng
const openMenu = ref<"more" | null>(null);
const moreMenuRef = ref<HTMLElement | null>(null);
const toggleMenu = (m: "more") => {
  openMenu.value = openMenu.value === m ? null : m;
};
const onDocClick = (e: MouseEvent) => {
  const t = e.target as Node;
  if (moreMenuRef.value?.contains(t)) return;
  openMenu.value = null;
};
onMounted(() => document.addEventListener("click", onDocClick));
onUnmounted(() => document.removeEventListener("click", onDocClick));

const pickFilter = (key: string) => {
  activeFilter.value = key;
  emit("go-home");
};
const pickPanel = (panel: PanelKey) => {
  openMenu.value = null;
  emit("open-panel", panel);
};
const pickConnect = () => {
  openMenu.value = null;
  emit("open-connect");
};

const refreshAll = async () => {
  await Promise.all([loadTasks(), loadAnalytics(true)]);
};

const handleLogout = async () => {
  openMenu.value = null;
  if (confirm("Bạn có chắc chắn muốn đăng xuất?")) {
    await logout();
  }
};
</script>

<style scoped>
.menu-item {
  @apply w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-slate-50 text-slate-700 font-semibold transition;
}
</style>

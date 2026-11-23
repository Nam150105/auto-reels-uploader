<template>
  <!-- Thanh trên cùng (cố định): số đếm trạng thái, Làm mới, menu ⋯ -->
  <header class="bg-white/95 backdrop-blur-md border-b border-slate-200/80 px-3 sm:px-5 select-none z-30 flex-shrink-0 relative">
    <div class="absolute top-0 left-0 right-0 h-[2.5px] bg-gradient-to-r from-blue-500 via-indigo-500 to-pink-500"></div>

    <div class="h-12 flex items-center gap-2 sm:gap-3">
      <div class="flex items-center gap-2 shrink-0">
        <div class="w-8 h-8 rounded-lg bg-gradient-to-tr from-blue-500 via-indigo-500 to-pink-500 text-white flex items-center justify-center font-black text-xs shadow-xs">
          NNN
        </div>
        <span class="hidden xl:inline font-extrabold tracking-tight text-slate-900 text-sm">NNN REELS FB</span>
      </div>

      <!-- Số đếm trạng thái: bấm để lọc lịch đăng -->
      <div class="flex items-center gap-1 overflow-x-auto scrollbar-none min-w-0">
        <button
          v-for="chip in statusChips"
          :key="chip.key"
          type="button"
          class="px-2.5 py-1 rounded-xl text-xs font-bold transition flex items-center gap-1.5 shrink-0 border"
          :class="activeFilter === chip.key ? chip.active : 'bg-slate-50 text-slate-600 border-slate-200/70 hover:bg-slate-100'"
          :title="`Lọc lịch đăng: ${chip.label}`"
          @click="activeFilter = chip.key"
        >
          <span class="w-1.5 h-1.5 rounded-full" :class="chip.dot"></span>
          <span class="hidden sm:inline">{{ chip.label }}</span>
          <span class="font-black">{{ chip.count }}</span>
        </button>
      </div>

      <div class="flex-1"></div>

      <button
        type="button"
        class="p-2 sm:px-3 sm:py-1.5 rounded-xl border border-slate-200/90 bg-white hover:bg-blue-50/60 text-slate-600 hover:text-blue-700 text-xs font-bold transition shadow-2xs flex items-center gap-1.5 shrink-0"
        title="Làm mới lịch đăng và số liệu"
        :disabled="isRefreshing"
        @click="refreshAll"
      >
        <svg class="w-4 h-4" :class="{ 'animate-spin': isRefreshing }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        <span class="hidden lg:inline">Làm mới</span>
      </button>

      <div ref="menuRef" class="relative shrink-0">
        <button
          type="button"
          class="p-2 rounded-xl border border-slate-200/90 bg-white hover:bg-slate-100 text-slate-600 transition shadow-2xs relative"
          title="Tài khoản"
          @click="menuOpen = !menuOpen"
        >
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
          </svg>
          <span v-if="expiredAccounts.length" class="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-amber-500 border-2 border-white"></span>
        </button>
        <div v-if="menuOpen" class="absolute right-0 mt-1.5 w-60 bg-white rounded-2xl shadow-xl border border-slate-200/80 py-1.5 z-50 text-xs">
          <div class="px-3 py-2 border-b border-slate-100 mb-1">
            <p class="font-bold text-slate-800 truncate">{{ user?.display_name || user?.username || "Tài khoản" }}</p>
            <p class="text-[11px] text-slate-500">{{ pages.length }} Fanpage · {{ accounts.length }} tài khoản FB</p>
          </div>
          <button type="button" class="menu-item" @click="pickConnect">
            🔑 <span>Thêm / cập nhật Token</span>
            <span v-if="expiredAccounts.length" class="ml-auto text-[10px] font-bold text-amber-700 bg-amber-50 px-1.5 rounded">hết hạn</span>
          </button>
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

const emit = defineEmits<{ (e: "open-connect"): void }>();

const { pages, accounts, expiredAccounts } = usePages();
const { user, logout } = useAuth();
const { activeFilter, taskStats, loadTasks, isLoading } = useTasks();
const { loadAnalytics, isLoading: analyticsLoading } = useAnalytics();

const isRefreshing = computed(() => isLoading.value || analyticsLoading.value);

const statusChips = computed(() => [
  { key: "all", label: "Tất cả", count: taskStats.value.total, dot: "bg-slate-400", active: "bg-slate-800 text-white border-slate-800" },
  { key: "pending", label: "Chờ đăng", count: taskStats.value.pending, dot: "bg-amber-500", active: "bg-amber-50 text-amber-800 border-amber-300" },
  { key: "running", label: "Đang đăng", count: taskStats.value.running, dot: "bg-sky-500 animate-pulse", active: "bg-sky-50 text-sky-800 border-sky-300" },
  { key: "success", label: "Đã đăng", count: taskStats.value.success, dot: "bg-emerald-500", active: "bg-emerald-50 text-emerald-800 border-emerald-300" },
  { key: "failed", label: "Thất bại", count: taskStats.value.failed, dot: "bg-rose-500", active: "bg-rose-50 text-rose-800 border-rose-300" }
]);

// Menu ⋯: bấm ra ngoài thì đóng
const menuOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);
const onDocClick = (e: MouseEvent) => {
  if (!menuRef.value?.contains(e.target as Node)) menuOpen.value = false;
};
onMounted(() => document.addEventListener("click", onDocClick));
onUnmounted(() => document.removeEventListener("click", onDocClick));

const pickConnect = () => {
  menuOpen.value = false;
  emit("open-connect");
};

const refreshAll = async () => {
  await Promise.all([loadTasks(), loadAnalytics(true)]);
};

const handleLogout = async () => {
  menuOpen.value = false;
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

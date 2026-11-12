<template>
  <aside class="w-16 sm:w-20 bg-white/95 text-slate-600 flex flex-col items-center py-4 select-none border-r border-slate-200/90 z-30 flex-shrink-0 shadow-[1px_0_8px_rgba(0,0,0,0.02)]">
    <!-- Brand / Logo (NNN REELS FB) -->
    <div class="mb-6 flex flex-col items-center cursor-pointer group" @click="$emit('switch-tab', 'compose')">
      <div class="w-10 h-10 rounded-2xl bg-gradient-to-tr from-blue-500 via-indigo-500 to-pink-500 flex items-center justify-center text-white shadow-md shadow-indigo-500/20 font-black text-sm tracking-tight transition-transform duration-200 group-hover:scale-105">
        NNN
      </div>
      <span class="text-[9px] font-black tracking-wider text-slate-700 mt-1 uppercase">REELS FB</span>
    </div>

    <!-- Navigation Items (EXACTLY 3 MAIN MENUS) -->
    <nav class="flex-1 flex flex-col gap-3 w-full px-2">
      <!-- 1. Viết bài (Compose) -->
      <button
        type="button"
        @click="$emit('switch-tab', 'compose')"
        class="w-full aspect-square rounded-2xl flex flex-col items-center justify-center gap-1.5 transition-all relative group"
        :class="activeTab === 'compose' ? 'bg-gradient-to-b from-blue-50 to-indigo-50/70 text-blue-600 border border-blue-200/90 shadow-xs' : 'hover:bg-slate-100/70 text-slate-500 hover:text-slate-800 border border-transparent'"
        title="Viết bài"
      >
        <svg class="w-5 h-5 transition-transform group-hover:scale-110" :class="activeTab === 'compose' ? 'text-blue-600' : 'text-slate-400 group-hover:text-blue-600'" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
        </svg>
        <span class="text-[10px] font-bold leading-none">Viết bài</span>
      </button>

      <!-- 2. Lịch đăng (Schedule) -->
      <button
        type="button"
        @click="$emit('switch-tab', 'schedule')"
        class="w-full aspect-square rounded-2xl flex flex-col items-center justify-center gap-1.5 transition-all relative group"
        :class="activeTab === 'schedule' ? 'bg-gradient-to-b from-violet-50 to-purple-50/70 text-violet-600 border border-violet-200/90 shadow-xs' : 'hover:bg-slate-100/70 text-slate-500 hover:text-slate-800 border border-transparent'"
        title="Lịch đăng"
      >
        <svg class="w-5 h-5 transition-transform group-hover:scale-110" :class="activeTab === 'schedule' ? 'text-violet-600' : 'text-slate-400 group-hover:text-violet-600'" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <span class="text-[10px] font-bold leading-none">Lịch đăng</span>
      </button>

      <!-- 3. Thống kê (Analytics) -->
      <button
        type="button"
        @click="$emit('switch-tab', 'analytics')"
        class="w-full aspect-square rounded-2xl flex flex-col items-center justify-center gap-1.5 transition-all relative group"
        :class="activeTab === 'analytics' ? 'bg-gradient-to-b from-emerald-50 to-teal-50/70 text-emerald-600 border border-emerald-200/90 shadow-xs' : 'hover:bg-slate-100/70 text-slate-500 hover:text-slate-800 border border-transparent'"
        title="Thống kê"
      >
        <svg class="w-5 h-5 transition-transform group-hover:scale-110" :class="activeTab === 'analytics' ? 'text-emerald-600' : 'text-slate-400 group-hover:text-emerald-600'" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
        <span class="text-[10px] font-bold leading-none">Thống kê</span>
      </button>

      <!-- 4. Fanpage & Admin accounts -->
      <button
        type="button"
        @click="$emit('switch-tab', 'pages')"
        class="w-full aspect-square rounded-2xl flex flex-col items-center justify-center gap-1.5 transition-all relative group"
        :class="activeTab === 'pages' ? 'bg-gradient-to-b from-sky-50 to-cyan-50/70 text-sky-600 border border-sky-200/90 shadow-xs' : 'hover:bg-slate-100/70 text-slate-500 hover:text-slate-800 border border-transparent'"
        title="Quản lý Fanpage & tài khoản Admin"
      >
        <svg class="w-5 h-5 transition-transform group-hover:scale-110" :class="activeTab === 'pages' ? 'text-sky-600' : 'text-slate-400 group-hover:text-sky-600'" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
        </svg>
        <span class="text-[10px] font-bold leading-none">Fanpage</span>
      </button>

      <!-- 5. Quản trị (admin only) -->
      <button
        v-if="isAdmin"
        type="button"
        @click="$emit('switch-tab', 'admin')"
        class="w-full aspect-square rounded-2xl flex flex-col items-center justify-center gap-1.5 transition-all relative group"
        :class="activeTab === 'admin' ? 'bg-gradient-to-b from-rose-50 to-pink-50/70 text-rose-600 border border-rose-200/90 shadow-xs' : 'hover:bg-slate-100/70 text-slate-500 hover:text-slate-800 border border-transparent'"
        title="Quản trị hệ thống"
      >
        <svg class="w-5 h-5 transition-transform group-hover:scale-110" :class="activeTab === 'admin' ? 'text-rose-600' : 'text-slate-400 group-hover:text-rose-600'" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
        <span class="text-[10px] font-bold leading-none">Quản trị</span>
      </button>
    </nav>

    <!-- Bottom Actions -->
    <div class="flex flex-col items-center gap-2.5 w-full px-2 pt-4 border-t border-slate-100">
      <!-- Manage Facebook Accounts -->
      <button
        type="button"
        @click="$emit('open-accounts')"
        class="w-8 h-8 rounded-xl bg-indigo-50/80 text-indigo-600 hover:bg-indigo-100 hover:text-indigo-700 border border-indigo-200/60 transition flex items-center justify-center shadow-2xs"
        title="Quản lý tài khoản Facebook Admin"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      </button>

      <!-- Connect Facebook Token -->
      <button
        type="button"
        @click="$emit('open-connect')"
        class="w-8 h-8 rounded-xl bg-sky-50/80 text-sky-600 hover:bg-sky-100 hover:text-sky-700 border border-sky-200/60 transition flex items-center justify-center shadow-2xs"
        title="Thêm Page hoặc Token mới"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
        </svg>
      </button>

      <!-- Logout -->
      <button
        type="button"
        @click="handleLogout"
        class="w-8 h-8 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 border border-transparent hover:border-rose-100 transition flex items-center justify-center"
        title="Đăng xuất"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
        </svg>
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { AppTab } from "@shared/types";
import { useAuth } from "../../composables/useAuth";

defineProps<{
  activeTab: AppTab;
}>();

defineEmits<{
  (e: "switch-tab", tab: AppTab): void;
  (e: "open-connect"): void;
  (e: "open-accounts"): void;
}>();

const { logout, user } = useAuth();
const isAdmin = computed(() => user.value?.role === "admin");

const handleLogout = async () => {
  if (confirm("Bạn có chắc chắn muốn đăng xuất?")) {
    await logout();
  }
};
</script>

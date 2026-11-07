<template>
  <aside class="w-16 sm:w-20 bg-[#0f172a] text-slate-400 flex flex-col items-center py-4 select-none border-r border-slate-800 z-30 flex-shrink-0">
    <!-- Brand / Logo (NNN) -->
    <div class="mb-6 flex flex-col items-center cursor-pointer" @click="$emit('switch-tab', 'compose')">
      <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 via-indigo-600 to-purple-600 flex items-center justify-center text-white shadow-lg shadow-blue-500/30 font-black text-sm tracking-wider">
        NNN
      </div>
      <span class="text-[10px] font-bold tracking-tight text-white mt-1">NNN</span>
    </div>

    <!-- Navigation Items (EXACTLY 3 MAIN MENUS) -->
    <nav class="flex-1 flex flex-col gap-3 w-full px-2">
      <!-- 1. Viết bài -->
      <button
        type="button"
        @click="$emit('switch-tab', 'compose')"
        class="w-full aspect-square rounded-xl flex flex-col items-center justify-center gap-1 transition-all relative group"
        :class="activeTab === 'compose' ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30' : 'hover:bg-slate-800/80 hover:text-slate-200 text-slate-400'"
        :title="t('compose')"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
        </svg>
        <span class="text-[10px] font-medium leading-none">{{ t('compose') }}</span>
      </button>

      <!-- 2. Lịch đăng -->
      <button
        type="button"
        @click="$emit('switch-tab', 'schedule')"
        class="w-full aspect-square rounded-xl flex flex-col items-center justify-center gap-1 transition-all relative group"
        :class="activeTab === 'schedule' ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30' : 'hover:bg-slate-800/80 hover:text-slate-200 text-slate-400'"
        :title="t('schedule')"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <span class="text-[10px] font-medium leading-none">{{ t('schedule') }}</span>
      </button>

      <!-- 3. Thống kê -->
      <button
        type="button"
        @click="$emit('switch-tab', 'analytics')"
        class="w-full aspect-square rounded-xl flex flex-col items-center justify-center gap-1 transition-all relative group"
        :class="activeTab === 'analytics' ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30' : 'hover:bg-slate-800/80 hover:text-slate-200 text-slate-400'"
        :title="t('analytics')"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
        <span class="text-[10px] font-medium leading-none">{{ t('analytics') }}</span>
      </button>
    </nav>

    <!-- Bottom Actions -->
    <div class="flex flex-col items-center gap-3 w-full px-2 pt-4 border-t border-slate-800">
      <!-- Language Switcher -->
      <button
        type="button"
        @click="toggleLang"
        class="w-8 h-8 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 text-xs font-bold transition flex items-center justify-center"
        :title="locale === 'vi' ? 'Chuyển sang English' : 'Switch to Tiếng Việt'"
      >
        {{ locale === 'vi' ? 'VI' : 'EN' }}
      </button>

      <!-- Manage Facebook Accounts -->
      <button
        type="button"
        @click="$emit('open-accounts')"
        class="w-8 h-8 rounded-lg bg-indigo-500/20 text-indigo-400 hover:bg-indigo-500/30 hover:text-indigo-300 transition flex items-center justify-center"
        title="Quản lý Tài khoản Facebook Admin"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      </button>

      <!-- Connect Facebook Token -->
      <button
        type="button"
        @click="$emit('open-connect')"
        class="w-8 h-8 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 hover:text-blue-300 transition flex items-center justify-center"
        title="Thêm Fanpage bằng Direct Token"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
        </svg>
      </button>

      <!-- Logout -->
      <button
        type="button"
        @click="handleLogout"
        class="w-8 h-8 rounded-lg hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition flex items-center justify-center"
        :title="t('logout')"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
        </svg>
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { useI18n } from "../../utils/i18n";
import { useAuth } from "../../composables/useAuth";

defineProps<{
  activeTab: "compose" | "schedule" | "analytics";
}>();

defineEmits<{
  (e: "switch-tab", tab: "compose" | "schedule" | "analytics"): void;
  (e: "open-connect"): void;
  (e: "open-accounts"): void;
}>();

const { t, locale, setLocale } = useI18n();
const { logout } = useAuth();

const toggleLang = () => {
  setLocale(locale.value === "vi" ? "en" : "vi");
};

const handleLogout = async () => {
  if (confirm("Bạn có chắc chắn muốn đăng xuất?")) {
    await logout();
  }
};
</script>

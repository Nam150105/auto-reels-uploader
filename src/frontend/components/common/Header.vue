<template>
  <header class="h-14 bg-white/95 backdrop-blur-md border-b border-slate-200/80 px-4 sm:px-6 flex items-center justify-between select-none z-20 flex-shrink-0 relative">
    <!-- Top accent line for subtle premium touch -->
    <div class="absolute top-0 left-0 right-0 h-[2.5px] bg-gradient-to-r from-blue-500 via-indigo-500 to-pink-500"></div>

    <!-- Left: Workspace & Breadcrumb -->
    <div class="flex items-center gap-3">
      <!-- Workspace Brand (NNN REELS FB) -->
      <div class="flex items-center gap-2 font-bold text-slate-800 text-sm select-none cursor-pointer" @click="$emit('update:composeMode', 'single')">
        <div class="w-7 h-7 rounded-lg bg-gradient-to-tr from-blue-500 via-indigo-500 to-pink-500 text-white flex items-center justify-center font-black text-xs shadow-xs">
          NNN
        </div>
        <span class="font-extrabold tracking-tight text-slate-900 text-sm">NNN REELS FB</span>
      </div>

      <span class="text-slate-300">/</span>

      <!-- Breadcrumbs & Mode Switcher for Viết bài -->
      <div v-if="activeTab === 'compose'" class="flex items-center gap-2">
        <span class="text-slate-500 text-xs sm:text-sm font-medium">Viết bài</span>
        <span class="text-slate-300">/</span>
        
        <!-- Mode Switcher Dropdown (Đăng thường vs Đăng hàng loạt) -->
        <div class="relative">
          <button
            type="button"
            @click="isModeDropdownOpen = !isModeDropdownOpen"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs sm:text-sm font-bold text-blue-600 bg-blue-50 hover:bg-blue-100/80 border border-blue-200/60 shadow-2xs transition"
          >
            <span>{{ composeMode === 'bulk' ? 'Đăng hàng loạt' : composeMode === 'multipage' ? 'Đăng theo Fanpage' : 'Đăng thường' }}</span>
            <svg class="w-3.5 h-3.5 transition-transform" :class="{ 'rotate-180': isModeDropdownOpen }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          <!-- Dropdown Menu -->
          <div
            v-if="isModeDropdownOpen"
            class="absolute left-0 mt-1.5 w-52 bg-white rounded-2xl shadow-xl border border-slate-200/80 py-1.5 z-50 text-xs"
          >
            <div class="px-3 py-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
              Chọn chế độ viết
            </div>
            <button
              type="button"
              @click="setComposeMode('single')"
              class="w-full px-3 py-2 text-left flex items-center justify-between hover:bg-blue-50/50 transition"
              :class="composeMode === 'single' ? 'text-blue-600 font-bold bg-blue-50/30' : 'text-slate-700'"
            >
              <div class="flex items-center gap-2">
                <svg class="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                <span>Đăng thường</span>
              </div>
              <svg v-if="composeMode === 'single'" class="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </button>
            <button
              type="button"
              @click="setComposeMode('bulk')"
              class="w-full px-3 py-2 text-left flex items-center justify-between hover:bg-blue-50/50 transition"
              :class="composeMode === 'bulk' ? 'text-blue-600 font-bold bg-blue-50/30' : 'text-slate-700'"
            >
              <div class="flex items-center gap-2">
                <svg class="w-4 h-4 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                </svg>
                <span>Đăng hàng loạt</span>
              </div>
              <svg v-if="composeMode === 'bulk'" class="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </button>
            <button
              type="button"
              @click="setComposeMode('multipage')"
              class="w-full px-3 py-2 text-left flex items-center justify-between hover:bg-blue-50/50 transition"
              :class="composeMode === 'multipage' ? 'text-blue-600 font-bold bg-blue-50/30' : 'text-slate-700'"
            >
              <div class="flex items-center gap-2">
                <svg class="w-4 h-4 text-pink-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
                </svg>
                <span>Đăng theo Fanpage</span>
              </div>
              <svg v-if="composeMode === 'multipage'" class="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div v-else-if="activeTab === 'schedule'" class="flex items-center gap-2">
        <span class="text-violet-700 bg-violet-50 px-2.5 py-1 rounded-xl border border-violet-200/60 text-xs sm:text-sm font-bold">Lịch đăng</span>
      </div>

      <div v-else-if="activeTab === 'analytics'" class="flex items-center gap-2">
        <span class="text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-xl border border-emerald-200/60 text-xs sm:text-sm font-bold">Thống kê</span>
      </div>

      <div v-else-if="activeTab === 'admin'" class="flex items-center gap-2">
        <span class="text-rose-700 bg-rose-50 px-2.5 py-1 rounded-xl border border-rose-200/60 text-xs sm:text-sm font-bold">Quản trị</span>
      </div>

      <div v-else-if="activeTab === 'pages'" class="flex items-center gap-2">
        <span class="text-sky-700 bg-sky-50 px-2.5 py-1 rounded-xl border border-sky-200/60 text-xs sm:text-sm font-bold">Fanpage</span>
      </div>
    </div>

    <!-- Right: Page Count & Connect & Profile -->
    <div class="flex items-center gap-2.5">
      <!-- Facebook Accounts Button -->
      <button
        type="button"
        @click="$emit('open-accounts')"
        class="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-50/80 hover:bg-blue-100/80 border border-blue-200/70 text-xs text-blue-700 font-bold transition shadow-2xs"
        title="Quản lý tài khoản Facebook Admin"
      >
        <svg class="w-3.5 h-3.5 text-blue-600" fill="currentColor" viewBox="0 0 24 24">
          <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
        </svg>
        <span>{{ accounts.length }} Tài khoản FB</span>
      </button>

      <!-- Page Stats Pill -->
      <div class="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-50/80 border border-indigo-200/70 text-xs text-indigo-700 font-bold shadow-2xs">
        <svg class="w-3.5 h-3.5 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
        <span>{{ pages.length }} Fanpage</span>
      </div>

      <!-- Connect Page Button -->
      <button
        type="button"
        @click="$emit('open-connect')"
        class="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-xs font-bold shadow-xs shadow-blue-500/20 transition"
      >
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
        </svg>
        <span class="hidden sm:inline">Thêm Token / Page</span>
      </button>

      <!-- User Avatar / Info -->
      <div class="flex items-center gap-2 pl-2 border-l border-slate-200">
        <div class="w-7 h-7 rounded-full bg-gradient-to-tr from-blue-100 to-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-black overflow-hidden border border-indigo-200 shadow-2xs">
          {{ ((user?.display_name || user?.username || 'U').substring(0, 2)).toUpperCase() }}
        </div>
        <span class="text-xs font-bold text-slate-700 hidden md:inline">{{ user?.display_name || user?.username || 'Tài khoản' }}</span>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import type { AppTab } from "@shared/types";
import { ref } from "vue";
import { usePages } from "../../composables/usePages";
import { useAuth } from "../../composables/useAuth";

defineProps<{
  activeTab: AppTab;
  composeMode: "single" | "bulk" | "multipage";
}>();

const emit = defineEmits<{
  (e: "update:composeMode", mode: "single" | "bulk" | "multipage"): void;
  (e: "open-connect"): void;
  (e: "open-accounts"): void;
}>();

const { pages, accounts } = usePages();
const { user } = useAuth();

const isModeDropdownOpen = ref(false);

const setComposeMode = (mode: "single" | "bulk" | "multipage") => {
  emit("update:composeMode", mode);
  isModeDropdownOpen.value = false;
};
</script>

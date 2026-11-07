<template>
  <header class="h-14 bg-white border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between select-none z-20 flex-shrink-0">
    <!-- Left: Workspace & Breadcrumb -->
    <div class="flex items-center gap-3">
      <!-- Workspace Brand Dropdown (NNN) -->
      <div class="flex items-center gap-2 font-bold text-slate-800 text-sm select-none">
        <div class="w-7 h-7 rounded-lg bg-gradient-to-tr from-blue-600 via-indigo-600 to-purple-600 text-white flex items-center justify-center font-black text-xs shadow-xs">
          NNN
        </div>
        <span class="font-extrabold tracking-tight text-slate-900">NNN Auto Reels</span>
      </div>

      <span class="text-slate-300">/</span>

      <!-- Breadcrumbs & Mode Switcher for Viết bài -->
      <div v-if="activeTab === 'compose'" class="flex items-center gap-2">
        <span class="text-slate-500 text-xs sm:text-sm font-medium">{{ t('compose') }}</span>
        <span class="text-slate-300">/</span>
        
        <!-- Mode Switcher Dropdown (Đăng thường vs Đăng hàng loạt) -->
        <div class="relative">
          <button
            type="button"
            @click="isModeDropdownOpen = !isModeDropdownOpen"
            class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs sm:text-sm font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 transition"
          >
            <span>{{ composeMode === 'bulk' ? t('compose_bulk') : t('compose_single') }}</span>
            <svg class="w-3.5 h-3.5 transition-transform" :class="{ 'rotate-180': isModeDropdownOpen }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          <!-- Dropdown Menu -->
          <div
            v-if="isModeDropdownOpen"
            class="absolute left-0 mt-1 w-48 bg-white rounded-xl shadow-xl border border-slate-100 py-1 z-50 text-xs"
          >
            <div class="px-3 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
              Chọn chế độ viết
            </div>
            <button
              type="button"
              @click="setComposeMode('single')"
              class="w-full px-3 py-2 text-left flex items-center justify-between hover:bg-slate-50 transition"
              :class="composeMode === 'single' ? 'text-blue-600 font-semibold' : 'text-slate-700'"
            >
              <div class="flex items-center gap-2">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                <span>{{ t('compose_single') }}</span>
              </div>
              <svg v-if="composeMode === 'single'" class="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </button>
            <button
              type="button"
              @click="setComposeMode('bulk')"
              class="w-full px-3 py-2 text-left flex items-center justify-between hover:bg-slate-50 transition"
              :class="composeMode === 'bulk' ? 'text-blue-600 font-semibold' : 'text-slate-700'"
            >
              <div class="flex items-center gap-2">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                </svg>
                <span>{{ t('compose_bulk') }}</span>
              </div>
              <svg v-if="composeMode === 'bulk'" class="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div v-else-if="activeTab === 'schedule'" class="flex items-center gap-2">
        <span class="text-slate-700 text-xs sm:text-sm font-semibold">{{ t('schedule') }}</span>
      </div>

      <div v-else-if="activeTab === 'analytics'" class="flex items-center gap-2">
        <span class="text-slate-700 text-xs sm:text-sm font-semibold">{{ t('analytics') }}</span>
      </div>
    </div>

    <!-- Right: Page Count & Connect & Profile -->
    <div class="flex items-center gap-2.5">
      <!-- Facebook Accounts Button -->
      <button
        type="button"
        @click="$emit('open-accounts')"
        class="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-xs text-slate-700 font-semibold transition"
        title="Quản lý tài khoản Facebook Admin"
      >
        <svg class="w-3.5 h-3.5 text-blue-600" fill="currentColor" viewBox="0 0 24 24">
          <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
        </svg>
        <span>{{ accounts.length }} Tài khoản FB</span>
      </button>

      <!-- Fanpage Stats Pill -->
      <div class="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-600 font-medium">
        <span>{{ pages.length }} {{ t('fanpage') }}</span>
      </div>

      <!-- Connect Page Button -->
      <button
        type="button"
        @click="$emit('open-connect')"
        class="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-xs transition"
      >
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
        </svg>
        <span class="hidden sm:inline">Thêm Token / Page</span>
      </button>

      <!-- User Avatar / Info -->
      <div class="flex items-center gap-2 pl-2 border-l border-slate-200">
        <div class="w-7 h-7 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold overflow-hidden border border-blue-200">
          {{ ((user?.display_name || user?.username || 'U').substring(0, 2)).toUpperCase() }}
        </div>
        <span class="text-xs font-bold text-slate-800 hidden md:inline">{{ user?.display_name || user?.username || 'Tài khoản' }}</span>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "../../utils/i18n";
import { usePages } from "../../composables/usePages";
import { useAuth } from "../../composables/useAuth";

const props = defineProps<{
  activeTab: "compose" | "schedule" | "analytics";
  composeMode: "single" | "bulk";
}>();

const emit = defineEmits<{
  (e: "update:composeMode", mode: "single" | "bulk"): void;
  (e: "open-connect"): void;
  (e: "open-accounts"): void;
}>();

const { t } = useI18n();
const { pages, accounts } = usePages();
const { user } = useAuth();

const isModeDropdownOpen = ref(false);

const setComposeMode = (mode: "single" | "bulk") => {
  emit("update:composeMode", mode);
  isModeDropdownOpen.value = false;
};
</script>

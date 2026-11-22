<template>
  <div class="h-screen w-screen flex overflow-hidden bg-[#f8fafc] font-sans text-slate-800">
    <!-- Main Content Area: bỏ menu trái, toàn bộ điều hướng nằm trên thanh đầu trang -->
    <div class="flex-1 flex flex-col min-w-0 overflow-hidden bg-[#f8fafc]">
      <!-- Top Header with Breadcrumbs & Mode Dropdown -->
      <Header
        :activeTab="activeTab"
        :composeMode="composeModeComputed"
        @switch-tab="switchTab"
        @update:composeMode="setComposeMode"
        @open-connect="() => openConnectModal(null)"
        @open-accounts="openAccountsTab"
      />

      <!-- Expired Token Warning Banner -->
      <div
        v-if="expiredAccounts.length > 0"
        class="mx-4 sm:mx-6 mt-3 px-4 py-2.5 rounded-2xl bg-amber-50/80 border border-amber-200/80 flex items-center justify-between gap-3 shrink-0 animate-in fade-in shadow-2xs"
      >
        <div class="flex items-center gap-2 text-xs text-amber-800 font-semibold">
          <span class="text-amber-600">⚠️</span>
          <span>Access Token đã hết hạn ({{ expiredAccountNames }}). Vui lòng cập nhật lại token từ Graph API Explorer.</span>
        </div>
        <button
          type="button"
          @click="openConnectModal(expiredAccounts[0]?.id)"
          class="px-3 py-1 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold transition shrink-0 shadow-xs"
        >
          🔑 Cập nhật Token
        </button>
      </div>

      <!-- Một màn hình duy nhất: dùng sub-tab để chuyển 3 khu vực, không điều hướng sang trang riêng -->
      <main class="flex-1 overflow-hidden relative">
        <ComposeView v-if="activeTab === 'compose'" :initial-mode="composeMode" @task-created="activeTab = 'schedule'" />
        <ScheduleView v-else-if="activeTab === 'schedule'" />
        <AnalyticsView v-else-if="activeTab === 'analytics'" />
        <FanpageView v-else-if="activeTab === 'pages'" />
        <AdminView v-else-if="activeTab === 'admin'" />
      </main>
    </div>

    <!-- Connect Direct Token Modal -->
    <ConnectFacebookModal
      :isOpen="isConnectModalOpen"
      :targetAccountId="connectTargetAccountId"
      @close="isConnectModalOpen = false"
    />


    <!-- Global Toast Notifications -->
    <Toast />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { AppTab } from "@shared/types";
import { useAuth } from "./composables/useAuth";
import { usePages } from "./composables/usePages";
import type { ComposeMode } from "./router";
import Header from "./components/common/Header.vue";
import Toast from "./components/common/Toast.vue";
import ConnectFacebookModal from "./components/dialogs/ConnectFacebookModal.vue";
import ComposeView from "./components/composer/ComposeView.vue";
import ScheduleView from "./components/schedule/ScheduleView.vue";
import AnalyticsView from "./components/analytics/AnalyticsView.vue";
import FanpageView from "./components/pages/FanpageView.vue";
import AdminView from "./components/admin/AdminView.vue";

const { checkAuth } = useAuth();
const {
  loadPages,
  isConnectModalOpen,
  pagesViewTab,
  connectTargetAccountId,
  expiredAccounts,
  expiredAccountNames,
  openConnectModal,
  handleOAuthResult
} = usePages();

const route = useRoute();
const router = useRouter();

// Tất cả khu vực chính chạy trong một màn hình; chỉ dùng route để giữ tương thích URL cũ.
const activeTab = ref<AppTab>(
  route.path.startsWith("/schedule") ? "schedule"
    : route.path.startsWith("/analytics") || route.path.startsWith("/insights") ? "analytics"
    : route.path.startsWith("/pages") ? "pages"
    : route.path.startsWith("/admin") ? "admin"
    : "compose"
);
const composeMode = ref<ComposeMode>(
  route.params.mode === "bulk" ? "bulk"
    : route.params.mode === "multipage" ? "multipage"
    : "single"
);
const composeModeComputed = computed<ComposeMode>(() => composeMode.value);

onMounted(async () => {
  await checkAuth();
  await loadPages();

  // Back from a full-page Facebook login (used when the popup was blocked)
  const oauthStatus = typeof route.query.oauth_status === "string" ? route.query.oauth_status : "";
  if (oauthStatus) {
    const oauthMsg = typeof route.query.oauth_msg === "string" ? route.query.oauth_msg : "";
    const { oauth_status: _s, oauth_msg: _m, ...rest } = route.query;
    await router.replace({ query: rest });
    await handleOAuthResult(oauthStatus, oauthMsg);
  }
});

// Fanpage screen: /pages = Page list, /pages/accounts = admin accounts
watch(
  () => [route.name, route.params.section] as const,
  ([name, section]) => {
    if (name === "pages") pagesViewTab.value = section === "accounts" ? "accounts" : "pages";
  },
  { immediate: true }
);
watch(pagesViewTab, (tab) => {
  if (route.name !== "pages") return;
  const target = tab === "accounts" ? "/pages/accounts" : "/pages";
  if (route.path !== target) router.replace(target);
});

const switchTab = (tab: AppTab) => {
  activeTab.value = tab;
};

const setComposeMode = (mode: ComposeMode) => {
  composeMode.value = mode;
};

/** Admin accounts now live on the Fanpage screen */
const openAccountsTab = () => {
  router.push("/pages/accounts");
};
</script>

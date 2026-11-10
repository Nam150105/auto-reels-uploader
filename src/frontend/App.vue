<template>
  <div class="h-screen w-screen flex overflow-hidden bg-[#f8fafc] font-sans text-slate-800">
    <!-- Modern Soft Sidebar: Exactly 3 Main Menus (Viết bài, Lịch đăng, Thống kê) -->
    <Sidebar
      :activeTab="activeTab"
      @switch-tab="switchTab"
      @open-connect="() => openConnectModal(null)"
      @open-accounts="openAccountsTab"
    />

    <!-- Main Content Area -->
    <div class="flex-1 flex flex-col min-w-0 overflow-hidden bg-[#f8fafc]">
      <!-- Top Header with Breadcrumbs & Mode Dropdown -->
      <Header
        :activeTab="activeTab"
        v-model:composeMode="composeMode"
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

      <!-- Main Dynamic View Area -->
      <main class="flex-1 overflow-hidden relative">
        <!-- Tab 1: Viết bài (Compose) -->
        <template v-if="activeTab === 'compose'">
          <SingleComposer
            v-if="composeMode === 'single'"
            @task-created="handleTaskCreated"
          />
          <BulkComposer
            v-else-if="composeMode === 'bulk'"
            @tasks-created="handleTaskCreated"
          />
          <MultiPageComposer
            v-else
            @tasks-created="handleTaskCreated"
          />
        </template>

        <!-- Tab 2: Lịch đăng (Schedule) -->
        <ScheduleView v-else-if="activeTab === 'schedule'" />

        <!-- Tab 3: Thống kê (Analytics) -->
        <AnalyticsView v-else-if="activeTab === 'analytics'" />

        <!-- Tab 4: Fanpage & Admin accounts -->
        <FanpageView v-else-if="activeTab === 'pages'" @open-connect="(accId) => openConnectModal(accId)" />
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
import { ref, onMounted } from "vue";
import type { AppTab } from "@shared/types";
import { useAuth } from "./composables/useAuth";
import { usePages } from "./composables/usePages";
import Sidebar from "./components/common/Sidebar.vue";
import Header from "./components/common/Header.vue";
import Toast from "./components/common/Toast.vue";
import SingleComposer from "./components/composer/SingleComposer.vue";
import BulkComposer from "./components/composer/BulkComposer.vue";
import MultiPageComposer from "./components/composer/MultiPageComposer.vue";
import ScheduleView from "./components/schedule/ScheduleView.vue";
import AnalyticsView from "./components/analytics/AnalyticsView.vue";
import ConnectFacebookModal from "./components/dialogs/ConnectFacebookModal.vue";
import FanpageView from "./components/pages/FanpageView.vue";

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

const activeTab = ref<AppTab>("compose");
const composeMode = ref<"single" | "bulk" | "multipage">("single");

onMounted(async () => {
  await checkAuth();
  await loadPages();

  // Back from a full-page Facebook login (used when the popup was blocked)
  const params = new URLSearchParams(window.location.search);
  const oauthStatus = params.get("oauth_status");
  if (oauthStatus) {
    const oauthMsg = params.get("oauth_msg") || "";
    params.delete("oauth_status");
    params.delete("oauth_msg");
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
    await handleOAuthResult(oauthStatus, oauthMsg);
  }
});

const switchTab = (tab: AppTab) => {
  activeTab.value = tab;
};

/** Admin accounts now live on the Fanpage screen */
const openAccountsTab = () => {
  pagesViewTab.value = "accounts";
  activeTab.value = "pages";
};

// When user creates a single or bulk task, automatically switch to the Schedule tab!
const handleTaskCreated = () => {
  activeTab.value = "schedule";
};
</script>

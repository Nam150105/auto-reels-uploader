<template>
  <div class="h-screen w-screen flex overflow-hidden bg-slate-50 font-sans text-slate-900">
    <!-- Dark Sidebar: Exactly 3 Main Menus (Compose, Schedule, Analytics) -->
    <Sidebar
      :activeTab="activeTab"
      @switch-tab="switchTab"
      @open-connect="() => openConnectModal(null)"
      @open-accounts="isAccountsModalOpen = true"
    />

    <!-- Main Content Area -->
    <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
      <!-- Top Header with Breadcrumbs & Mode Dropdown -->
      <Header
        :activeTab="activeTab"
        v-model:composeMode="composeMode"
        @open-connect="() => openConnectModal(null)"
        @open-accounts="isAccountsModalOpen = true"
      />

      <!-- Expired Token Warning Banner -->
      <div
        v-if="expiredAccounts.length > 0"
        class="mx-4 sm:mx-6 mt-3 px-4 py-2.5 rounded-xl bg-amber-500/15 border border-amber-500/40 flex items-center justify-between gap-3 shrink-0 animate-in fade-in"
      >
        <div class="flex items-center gap-2 text-xs text-amber-900 font-medium">
          <span>⚠️</span>
          <span>Access token expired ({{ expiredAccountNames }}). Please update the token in Graph API Explorer.</span>
        </div>
        <button
          type="button"
          @click="openConnectModal(expiredAccounts[0]?.id)"
          class="px-3 py-1 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold transition shrink-0 shadow-xs"
        >
          🔑 Update token
        </button>
      </div>

      <!-- Main Dynamic View Area -->
      <main class="flex-1 overflow-hidden relative">
        <!-- Tab 1: Compose -->
        <template v-if="activeTab === 'compose'">
          <SingleComposer
            v-if="composeMode === 'single'"
            @task-created="handleTaskCreated"
          />
          <BulkComposer
            v-else
            @tasks-created="handleTaskCreated"
          />
        </template>

        <!-- Tab 2: Schedule -->
        <ScheduleView v-else-if="activeTab === 'schedule'" />

        <!-- Tab 3: Analytics -->
        <AnalyticsView v-else-if="activeTab === 'analytics'" />
      </main>
    </div>

    <!-- Connect Direct Token Modal -->
    <ConnectFacebookModal
      :isOpen="isConnectModalOpen"
      :targetAccountId="connectTargetAccountId"
      @close="isConnectModalOpen = false"
    />

    <!-- Manage Facebook Accounts Modal -->
    <ManageAccountsModal
      :isOpen="isAccountsModalOpen"
      @close="isAccountsModalOpen = false"
      @open-connect="(accId) => openConnectModal(accId)"
    />

    <!-- Global Toast Notifications -->
    <Toast />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useAuth } from "./composables/useAuth";
import { usePages } from "./composables/usePages";
import Sidebar from "./components/common/Sidebar.vue";
import Header from "./components/common/Header.vue";
import Toast from "./components/common/Toast.vue";
import SingleComposer from "./components/composer/SingleComposer.vue";
import BulkComposer from "./components/composer/BulkComposer.vue";
import ScheduleView from "./components/schedule/ScheduleView.vue";
import AnalyticsView from "./components/analytics/AnalyticsView.vue";
import ConnectFacebookModal from "./components/dialogs/ConnectFacebookModal.vue";
import ManageAccountsModal from "./components/dialogs/ManageAccountsModal.vue";

const { checkAuth } = useAuth();
const {
  loadPages,
  isConnectModalOpen,
  isAccountsModalOpen,
  connectTargetAccountId,
  expiredAccounts,
  expiredAccountNames,
  openConnectModal,
  handleOAuthResult
} = usePages();

const activeTab = ref<"compose" | "schedule" | "analytics">("compose");
const composeMode = ref<"single" | "bulk">("single");

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

const switchTab = (tab: "compose" | "schedule" | "analytics") => {
  activeTab.value = tab;
};

// When user creates a single or bulk task, automatically switch to the Schedule tab!
const handleTaskCreated = () => {
  activeTab.value = "schedule";
};
</script>

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
        :composeMode="composeMode"
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

      <!-- Main Dynamic View Area -->
      <!-- Screens come from the web router (src/frontend/router.ts) -->
      <main class="flex-1 overflow-hidden relative">
        <RouterView v-slot="{ Component }">
          <component :is="Component" @open-connect="(accId?: string | null) => openConnectModal(accId ?? null)" />
        </RouterView>
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
import { computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { AppTab } from "@shared/types";
import { useAuth } from "./composables/useAuth";
import { usePages } from "./composables/usePages";
import { TAB_PATHS, type ComposeMode } from "./router";
import Sidebar from "./components/common/Sidebar.vue";
import Header from "./components/common/Header.vue";
import Toast from "./components/common/Toast.vue";
import ConnectFacebookModal from "./components/dialogs/ConnectFacebookModal.vue";

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

// The URL is the source of truth for the current screen
const activeTab = computed<AppTab>(() => (route.meta.tab as AppTab) || "compose");
const composeMode = computed<ComposeMode>(() =>
  activeTab.value === "compose" ? ((route.params.mode as ComposeMode) || "single") : "single"
);

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
  router.push(TAB_PATHS[tab]);
};

const setComposeMode = (mode: ComposeMode) => {
  router.push(`/compose/${mode}`);
};

/** Admin accounts now live on the Fanpage screen */
const openAccountsTab = () => {
  router.push("/pages/accounts");
};
</script>

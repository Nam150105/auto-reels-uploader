<template>
  <div class="h-screen w-screen flex flex-col overflow-hidden bg-[#f8fafc] font-sans text-slate-800">
    <!-- Thanh trên cùng (cố định): số đếm, biểu đồ mini, Làm mới, Tạo bài, menu ⋯ -->
    <Header
      :composeMode="composeMode"
      @go-home="goHome"
      @open-compose="openCompose"
      @open-panel="openPanel"
      @open-connect="() => openConnectModal(null)"
    />

    <!-- Token hết hạn -->
    <div
      v-if="expiredAccounts.length > 0"
      class="mx-4 sm:mx-6 mt-3 px-4 py-2.5 rounded-2xl bg-amber-50/80 border border-amber-200/80 flex items-center justify-between gap-3 shrink-0 shadow-2xs"
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

    <!-- Một màn hình duy nhất: Lịch đăng luôn ở dưới, các phần khác mở đè lên -->
    <main class="flex-1 min-h-0 relative">
      <ScheduleView />

      <!-- Khung đè: Thống kê / Fanpage / Tài khoản / Quản trị -->
      <section v-if="panel" class="absolute inset-0 z-20 bg-[#f8fafc] flex flex-col">
        <div class="shrink-0 flex items-center gap-3 px-4 lg:px-6 py-2.5 bg-white border-b border-slate-200/80 shadow-2xs">
          <button
            type="button"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition"
            title="Quay lại Lịch đăng (Esc)"
            @click="goHome"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
            <span>Quay lại Lịch đăng</span>
          </button>
          <h2 class="text-sm font-bold text-slate-800">{{ panelTitle }}</h2>
          <!-- Chuyển nhanh giữa các khung -->
          <nav class="ml-auto hidden md:flex items-center gap-1">
            <button
              v-for="p in panelTabs"
              :key="p.key"
              type="button"
              class="px-3 py-1.5 rounded-xl text-xs font-bold transition"
              :class="panel === p.key ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100'"
              @click="openPanel(p.key)"
            >
              {{ p.label }}
            </button>
          </nav>
        </div>
        <div class="flex-1 min-h-0">
          <AnalyticsView v-if="panel === 'analytics'" />
          <FanpageView v-else-if="panel === 'pages' || panel === 'accounts'" @open-connect="(id: string | null) => openConnectModal(id)" />
          <AdminView v-else-if="panel === 'admin'" />
        </div>
      </section>
    </main>

    <!-- Ngăn Viết bài trượt từ bên phải (giữ nguyên bản nháp khi đóng) -->
    <Transition name="fade">
      <div v-if="composeOpen" class="fixed inset-0 z-40 bg-slate-900/30" @click="goHome"></div>
    </Transition>
    <aside
      v-if="composeMounted"
      v-show="composeOpen"
      class="fixed inset-y-0 right-0 z-50 w-full lg:w-[min(1180px,92vw)] bg-[#f8fafc] shadow-2xl flex flex-col"
    >
      <div class="shrink-0 flex items-center gap-2 px-4 lg:px-6 py-2.5 bg-white border-b border-slate-200/80">
        <h2 class="text-sm font-bold text-slate-800 mr-2">Tạo bài</h2>
        <div class="flex items-center gap-1 bg-slate-100 p-1 rounded-xl overflow-x-auto scrollbar-none">
          <button
            v-for="m in composeTabs"
            :key="m.key"
            type="button"
            class="px-3 py-1.5 rounded-lg text-xs font-bold transition shrink-0"
            :class="composeMode === m.key ? 'bg-white text-blue-600 shadow-xs' : 'text-slate-600 hover:text-slate-900'"
            @click="openCompose(m.key)"
          >
            {{ m.label }}
          </button>
        </div>
        <button
          type="button"
          class="ml-auto p-2 rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition"
          title="Đóng (Esc)"
          @click="goHome"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto">
        <ComposeView :initial-mode="composeMode" @task-created="onTasksCreated" />
      </div>
    </aside>

    <ConnectFacebookModal
      :isOpen="isConnectModalOpen"
      :targetAccountId="connectTargetAccountId"
      @close="isConnectModalOpen = false"
    />

    <Toast />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuth } from "./composables/useAuth";
import { usePages } from "./composables/usePages";
import { useTasks } from "./composables/useTasks";
import { useAnalytics } from "./composables/useAnalytics";
import type { ComposeMode, PanelKey } from "./router";
import Header from "./components/common/Header.vue";
import Toast from "./components/common/Toast.vue";
import ConnectFacebookModal from "./components/dialogs/ConnectFacebookModal.vue";
import ComposeView from "./components/composer/ComposeView.vue";
import ScheduleView from "./components/schedule/ScheduleView.vue";
import AnalyticsView from "./components/analytics/AnalyticsView.vue";
import FanpageView from "./components/pages/FanpageView.vue";
import AdminView from "./components/admin/AdminView.vue";

const { checkAuth, user } = useAuth();
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
const { loadTasks } = useTasks();
const { loadAnalytics } = useAnalytics();

const route = useRoute();
const router = useRouter();

// URL là nguồn chính: /page = Lịch đăng, /compose/:mode = ngăn Viết bài, /analytics|/pages|/admin = khung đè.
// Nhờ vậy nút Back của trình duyệt cũng đưa về Lịch đăng.
const HOME = "/page";
const panel = computed<PanelKey | null>(() => {
  if (route.name === "analytics") return "analytics";
  if (route.name === "pages") return route.params.section === "accounts" ? "accounts" : "pages";
  if (route.name === "admin") return "admin";
  return null;
});
const composeOpen = computed(() => route.name === "compose");
const composeMode = ref<ComposeMode>("single");
const composeMounted = ref(false);
watch(
  () => [route.name, route.params.mode] as const,
  ([name, mode]) => {
    if (name !== "compose") return;
    composeMode.value = mode === "bulk" || mode === "multipage" ? mode : "single";
    composeMounted.value = true;
  },
  { immediate: true }
);

const isAdmin = computed(() => (user.value as any)?.role === "admin");
const panelTabs = computed(() => {
  const tabs: Array<{ key: PanelKey; label: string }> = [
    { key: "analytics", label: "Thống kê" },
    { key: "pages", label: "Fanpage" },
    { key: "accounts", label: "Tài khoản FB" }
  ];
  if (isAdmin.value) tabs.push({ key: "admin", label: "Quản trị" });
  return tabs;
});
const panelTitle = computed(() => panelTabs.value.find((p) => p.key === panel.value)?.label || "Quản trị");

const composeTabs: Array<{ key: ComposeMode; label: string }> = [
  { key: "single", label: "Đăng thường" },
  { key: "bulk", label: "Đăng hàng loạt" },
  { key: "multipage", label: "Đăng theo Fanpage" }
];

const PANEL_PATHS: Record<PanelKey, string> = {
  analytics: "/analytics",
  pages: "/pages",
  accounts: "/pages/accounts",
  admin: "/admin"
};

const goHome = () => {
  if (route.path !== HOME) router.push(HOME);
};
const openPanel = (p: PanelKey) => {
  router.push(PANEL_PATHS[p]);
};
const openCompose = (mode: ComposeMode) => {
  router.push(`/compose/${mode}`);
};
const onTasksCreated = async () => {
  goHome();
  await loadTasks(true);
};

// Esc đóng ngăn/khung đang mở (trừ khi đang có hộp thoại khác bật)
const onKeydown = (e: KeyboardEvent) => {
  if (e.key !== "Escape" || isConnectModalOpen.value) return;
  if (document.querySelector("[role='dialog'], .modal-open")) return;
  if (composeOpen.value || panel.value) goHome();
};

onMounted(async () => {
  document.addEventListener("keydown", onKeydown);
  await checkAuth();
  await loadPages();
  // Số liệu cho biểu đồ mini trên thanh trên cùng (đọc từ dữ liệu đã đồng bộ, có cache 1 phút)
  loadAnalytics();

  // Back from a full-page Facebook login (used when the popup was blocked)
  const oauthStatus = typeof route.query.oauth_status === "string" ? route.query.oauth_status : "";
  if (oauthStatus) {
    const oauthMsg = typeof route.query.oauth_msg === "string" ? route.query.oauth_msg : "";
    const { oauth_status: _s, oauth_msg: _m, ...rest } = route.query;
    await router.replace({ query: rest });
    await handleOAuthResult(oauthStatus, oauthMsg);
  }
});
onUnmounted(() => document.removeEventListener("keydown", onKeydown));

// Fanpage: /pages = danh sách Page, /pages/accounts = tài khoản Admin
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
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>

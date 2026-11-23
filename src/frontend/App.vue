<template>
  <div class="h-screen w-screen flex flex-col overflow-hidden bg-[#f8fafc] font-sans text-slate-800">
    <!-- Thanh trên cùng (cố định): số đếm, thống kê mini, Làm mới, menu ⋯ -->
    <Header
      @go-home="closePanel"
      @open-panel="openPanel"
      @open-connect="() => openConnectModal(null)"
    />

    <!-- Token hết hạn -->
    <div
      v-if="expiredAccounts.length > 0"
      class="mx-3 sm:mx-5 mt-2 px-4 py-2 rounded-2xl bg-amber-50/80 border border-amber-200/80 flex items-center justify-between gap-3 shrink-0 shadow-2xs"
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

    <!--
      MỘT MÀN HÌNH DUY NHẤT (máy tính): nửa trên Đăng theo Fanpage, nửa dưới Lịch đăng.
      Mỗi nửa tự cuộn bên trong, trang không cuộn. Điện thoại: xếp dọc, cuộn cả trang.
    -->
    <main class="flex-1 min-h-0 relative flex flex-col overflow-y-auto lg:overflow-hidden">
      <!-- ĐĂNG THEO FANPAGE -->
      <section
        class="shrink-0 flex flex-col border-b border-slate-200/80"
        :class="composeCollapsed ? '' : 'lg:h-[60%] lg:min-h-[320px]'"
      >
        <div class="shrink-0 flex items-center gap-2 px-3 lg:px-4 pt-2">
          <h2 class="text-sm font-extrabold text-slate-800">✍️ Đăng theo Fanpage</h2>
          <span class="hidden sm:inline text-[11px] text-slate-400">Chọn giờ đăng chung → chọn Fanpage → nhập nội dung từng Page</span>
          <button
            type="button"
            class="ml-auto text-[11px] font-bold text-slate-500 hover:text-slate-800 px-2 py-1 rounded-lg hover:bg-slate-100"
            :title="composeCollapsed ? 'Mở khung đăng bài' : 'Thu gọn để xem lịch đăng rộng hơn'"
            @click="composeCollapsed = !composeCollapsed"
          >
            {{ composeCollapsed ? "▾ Mở khung đăng bài" : "▴ Thu gọn" }}
          </button>
        </div>
        <div v-show="!composeCollapsed" class="flex-1 min-h-0">
          <MultiPageComposer @tasks-created="onTasksCreated" />
        </div>
      </section>

      <!-- LỊCH ĐĂNG -->
      <section ref="scheduleRef" class="flex-1 min-h-0 lg:overflow-y-auto relative" @scroll.passive="onScheduleScroll">
        <div class="flex items-center gap-2 px-4 lg:px-6 pt-3">
          <h2 class="text-sm font-extrabold text-slate-800">📅 Lịch đăng</h2>
          <span class="text-[11px] text-slate-400">Bài chưa đăng + bài đã xong trong {{ BOARD_RECENT_DAYS }} ngày gần nhất</span>
        </div>
        <ScheduleView />
      </section>

      <!-- Nút lên đầu danh sách -->
      <button
        v-if="showBackToTop"
        type="button"
        class="absolute bottom-5 right-5 z-10 w-11 h-11 rounded-full bg-slate-900/85 hover:bg-slate-900 text-white shadow-lg flex items-center justify-center transition"
        title="Lên đầu danh sách"
        @click="scheduleRef?.scrollTo({ top: 0, behavior: 'smooth' })"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 15l7-7 7 7" />
        </svg>
      </button>

      <!-- Phần không hiện hết trên màn hình chính (mở từ menu ⋯ / biểu đồ mini): khung đè có nút Quay lại -->
      <section v-if="panel" class="absolute inset-0 z-30 bg-[#f8fafc] flex flex-col">
        <div class="shrink-0 flex items-center gap-3 px-4 lg:px-6 py-2.5 bg-white border-b border-slate-200/80 shadow-2xs">
          <button
            type="button"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition"
            title="Quay lại (Esc)"
            @click="closePanel"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
            <span>Quay lại</span>
          </button>
          <h2 class="text-sm font-bold text-slate-800">{{ panelTitle }}</h2>
        </div>
        <div class="flex-1 min-h-0">
          <AnalyticsView v-if="panel === 'analytics'" />
          <FanpageView v-else-if="panel === 'pages' || panel === 'accounts'" @open-connect="(id: string | null) => openConnectModal(id)" />
          <AdminView v-else-if="panel === 'admin'" />
        </div>
      </section>
    </main>

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
import { useTasks, BOARD_RECENT_DAYS } from "./composables/useTasks";
import { useAnalytics } from "./composables/useAnalytics";
import type { PanelKey } from "./router";
import Header from "./components/common/Header.vue";
import Toast from "./components/common/Toast.vue";
import ConnectFacebookModal from "./components/dialogs/ConnectFacebookModal.vue";
import MultiPageComposer from "./components/composer/MultiPageComposer.vue";
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
const { loadTasks } = useTasks();
const { loadAnalytics } = useAnalytics();

const route = useRoute();
const router = useRouter();
const HOME = "/page";

const composeCollapsed = ref(false);

// Nút lên đầu danh sách lịch đăng
const scheduleRef = ref<HTMLElement | null>(null);
const showBackToTop = ref(false);
const onScheduleScroll = () => {
  showBackToTop.value = (scheduleRef.value?.scrollTop || 0) > 400;
};

// Khung đè theo URL: /analytics, /pages, /pages/accounts, /admin
const panel = computed<PanelKey | null>(() => {
  if (route.name === "analytics") return "analytics";
  if (route.name === "pages") return route.params.section === "accounts" ? "accounts" : "pages";
  if (route.name === "admin") return "admin";
  return null;
});
const PANEL_TITLES: Record<PanelKey, string> = {
  analytics: "Thống kê chi tiết",
  pages: "Quản lý Fanpage",
  accounts: "Tài khoản Facebook Admin",
  admin: "Quản trị hệ thống"
};
const panelTitle = computed(() => (panel.value ? PANEL_TITLES[panel.value] : ""));
const PANEL_PATHS: Record<PanelKey, string> = {
  analytics: "/analytics",
  pages: "/pages",
  accounts: "/pages/accounts",
  admin: "/admin"
};

const openPanel = (p: PanelKey) => {
  if (route.path !== PANEL_PATHS[p]) router.push(PANEL_PATHS[p]);
};
const closePanel = () => {
  if (!panel.value) return;
  if (window.history.state?.back) router.back();
  else router.replace(HOME);
};

const onTasksCreated = async () => {
  await loadTasks(true);
  scheduleRef.value?.scrollTo({ top: 0, behavior: "smooth" });
};

// Esc đóng khung đè (trừ khi đang có hộp thoại khác bật)
const onKeydown = (e: KeyboardEvent) => {
  if (e.key !== "Escape" || isConnectModalOpen.value || !panel.value) return;
  if (document.querySelector("[role='dialog'], .modal-open")) return;
  closePanel();
};

onMounted(async () => {
  document.addEventListener("keydown", onKeydown);
  await checkAuth();
  await loadPages();
  // Số liệu cho thống kê mini trên thanh trên cùng (đọc từ dữ liệu đã đồng bộ, có cache 1 phút)
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

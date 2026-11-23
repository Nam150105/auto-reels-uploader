<template>
  <div class="h-screen w-screen flex flex-col overflow-hidden bg-[#f8fafc] font-sans text-slate-800">
    <!-- Thanh trên cùng (cố định): số đếm, biểu đồ mini, Làm mới, Tạo bài, menu ⋯ -->
    <Header
      :composeMode="composeMode"
      @go-home="scrollToSection('schedule')"
      @open-compose="openCompose"
      @open-panel="openPanel"
      @open-connect="() => openConnectModal(null)"
    />

    <!-- Nhảy nhanh tới từng phần của trang (cố định) -->
    <nav class="shrink-0 bg-white/90 backdrop-blur-sm border-b border-slate-200/70 px-3 sm:px-5 flex items-center gap-1 overflow-x-auto scrollbar-none z-20">
      <button
        v-for="s in sections"
        :key="s.key"
        type="button"
        class="px-3 py-2 text-xs font-bold border-b-2 transition shrink-0"
        :class="visibleSection === s.key ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'"
        @click="goSection(s.key)"
      >
        {{ s.label }}
      </button>
    </nav>

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

    <!-- MỘT TRANG DUY NHẤT: Viết bài → Lịch đăng → Thống kê, cuộn liên tục -->
    <main class="flex-1 min-h-0 relative">
      <div ref="scrollerRef" class="h-full overflow-y-auto" @scroll.passive="onScroll">
        <!-- 1. VIẾT BÀI -->
        <section ref="composeRef" data-section="compose" class="scroll-mt-2">
          <div class="flex flex-wrap items-center gap-2 px-4 lg:px-6 pt-5">
            <h2 class="section-title">✍️ Viết bài</h2>
            <div class="flex items-center gap-1 bg-white border border-slate-200/80 p-1 rounded-xl overflow-x-auto scrollbar-none shadow-2xs">
              <button
                v-for="m in composeModes"
                :key="m.key"
                type="button"
                class="px-3 py-1.5 rounded-lg text-xs font-bold transition shrink-0"
                :class="composeMode === m.key ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'"
                @click="openCompose(m.key)"
              >
                {{ m.label }}
              </button>
            </div>
            <button
              type="button"
              class="ml-auto text-xs font-bold text-slate-500 hover:text-slate-800 px-2 py-1 rounded-lg hover:bg-slate-100"
              @click="composeCollapsed = !composeCollapsed"
            >
              {{ composeCollapsed ? "▾ Mở khung viết bài" : "▴ Thu gọn" }}
            </button>
          </div>
          <div v-show="!composeCollapsed" class="embed-view">
            <ComposeView :initial-mode="composeMode" @task-created="onTasksCreated" />
          </div>
        </section>

        <!-- 2. LỊCH ĐĂNG -->
        <section ref="scheduleRef" data-section="schedule" class="scroll-mt-2 border-t border-slate-200/70 mt-2">
          <div class="px-4 lg:px-6 pt-5">
            <h2 class="section-title">📅 Lịch đăng</h2>
          </div>
          <ScheduleView />
        </section>

        <!-- 3. THỐNG KÊ -->
        <section ref="analyticsRef" data-section="analytics" class="scroll-mt-2 border-t border-slate-200/70">
          <div class="px-4 lg:px-6 pt-5">
            <h2 class="section-title">📊 Thống kê</h2>
          </div>
          <div class="embed-view">
            <AnalyticsView />
          </div>
        </section>
      </div>

      <!-- Nút lên đầu trang -->
      <button
        v-if="showBackToTop"
        type="button"
        class="absolute bottom-6 right-6 z-10 w-11 h-11 rounded-full bg-slate-900/85 hover:bg-slate-900 text-white shadow-lg flex items-center justify-center transition"
        title="Lên đầu trang"
        @click="scrollerRef?.scrollTo({ top: 0, behavior: 'smooth' })"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 15l7-7 7 7" />
        </svg>
      </button>

      <!-- Phần quản lý ít dùng (mở từ menu ⋯): Fanpage / Tài khoản FB / Quản trị -->
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
          <FanpageView v-if="panel === 'pages' || panel === 'accounts'" @open-connect="(id: string | null) => openConnectModal(id)" />
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
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
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

type SectionKey = "compose" | "schedule" | "analytics";

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

const sections: Array<{ key: SectionKey; label: string }> = [
  { key: "compose", label: "✍️ Viết bài" },
  { key: "schedule", label: "📅 Lịch đăng" },
  { key: "analytics", label: "📊 Thống kê" }
];
const composeModes: Array<{ key: ComposeMode; label: string }> = [
  { key: "single", label: "Đăng thường" },
  { key: "bulk", label: "Đăng hàng loạt" },
  { key: "multipage", label: "Đăng theo Fanpage" }
];

// ---- Cuộn tới từng phần ----
const scrollerRef = ref<HTMLElement | null>(null);
const composeRef = ref<HTMLElement | null>(null);
const scheduleRef = ref<HTMLElement | null>(null);
const analyticsRef = ref<HTMLElement | null>(null);
const sectionEl = (k: SectionKey) => (k === "compose" ? composeRef : k === "schedule" ? scheduleRef : analyticsRef).value;

const scrollToSection = async (k: SectionKey) => {
  await nextTick();
  const scroller = scrollerRef.value;
  const el = sectionEl(k);
  if (!scroller || !el) return;
  scroller.scrollTo({ top: el.offsetTop - 4, behavior: "smooth" });
};

// Đánh dấu phần đang xem trên thanh nhảy nhanh + hiện nút lên đầu trang
const visibleSection = ref<SectionKey>("compose");
const showBackToTop = ref(false);
const onScroll = () => {
  const scroller = scrollerRef.value;
  if (!scroller) return;
  showBackToTop.value = scroller.scrollTop > 400;
  const probe = scroller.scrollTop + 120;
  let current: SectionKey = "compose";
  for (const s of sections) {
    const el = sectionEl(s.key);
    if (el && el.offsetTop <= probe) current = s.key;
  }
  visibleSection.value = current;
};

// ---- URL: /compose/:mode, /schedule, /analytics cuộn tới phần tương ứng; /pages, /admin mở khung quản lý ----
const SECTION_PATHS: Record<SectionKey, string> = { compose: "/compose/single", schedule: HOME, analytics: "/analytics" };
const composeMode = ref<ComposeMode>("single");
const composeCollapsed = ref(false);

const panel = computed<Exclude<PanelKey, "analytics"> | null>(() => {
  if (route.name === "pages") return route.params.section === "accounts" ? "accounts" : "pages";
  if (route.name === "admin") return "admin";
  return null;
});
const panelTitle = computed(() =>
  panel.value === "accounts" ? "Tài khoản Facebook Admin" : panel.value === "admin" ? "Quản trị hệ thống" : "Quản lý Fanpage"
);

watch(
  () => [route.name, route.params.mode] as const,
  ([name, mode]) => {
    if (name === "compose") {
      composeMode.value = mode === "bulk" || mode === "multipage" ? mode : "single";
      composeCollapsed.value = false;
      scrollToSection("compose");
    } else if (name === "analytics") {
      scrollToSection("analytics");
    } else if (name === "schedule") {
      scrollToSection("schedule");
    }
  },
  { immediate: true }
);

const goSection = (k: SectionKey) => {
  if (k === "compose") composeCollapsed.value = false;
  if (route.path !== SECTION_PATHS[k]) router.replace(k === "compose" ? `/compose/${composeMode.value}` : SECTION_PATHS[k]);
  scrollToSection(k);
};
const openCompose = (mode: ComposeMode) => {
  composeMode.value = mode;
  composeCollapsed.value = false;
  router.replace(`/compose/${mode}`);
  scrollToSection("compose");
};
const PANEL_PATHS: Record<Exclude<PanelKey, "analytics">, string> = {
  pages: "/pages",
  accounts: "/pages/accounts",
  admin: "/admin"
};
const openPanel = (p: PanelKey) => {
  if (p === "analytics") return goSection("analytics");
  router.push(PANEL_PATHS[p]);
};
const closePanel = () => {
  if (window.history.state?.back) router.back();
  else router.replace(HOME);
};
const onTasksCreated = async () => {
  await loadTasks(true);
  goSection("schedule");
};

// Esc đóng khung quản lý (trừ khi đang có hộp thoại khác bật)
const onKeydown = (e: KeyboardEvent) => {
  if (e.key !== "Escape" || isConnectModalOpen.value || !panel.value) return;
  if (document.querySelector("[role='dialog'], .modal-open")) return;
  closePanel();
};

onMounted(async () => {
  document.addEventListener("keydown", onKeydown);
  await checkAuth();
  await loadPages();
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
.section-title {
  @apply text-base font-extrabold text-slate-800 mr-2;
}
/* Các khu vực vốn là màn hình riêng (tự cuộn, cao 100%) -> giãn theo nội dung trong trang chung,
   để thanh cố định bên trong chúng bám theo thanh cuộn của cả trang */
.embed-view > :deep(div:first-child) {
  height: auto;
  overflow: visible;
}
</style>

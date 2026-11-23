<template>
  <div class="h-screen w-screen flex flex-col overflow-hidden bg-[#f8fafc] font-sans text-slate-800">
    <Header @open-connect="() => openConnectModal(null)" />

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
      MỘT MÀN HÌNH (máy tính, trang không cuộn, mỗi khu tự cuộn bên trong):
        cột trái  ~60%: Đăng theo Fanpage (trên, thu gọn được) + Lịch đăng (dưới)
        cột phải ~40%: Thống kê
      Điện thoại: xếp dọc, cuộn cả trang.
    -->
    <main class="flex-1 min-h-0 overflow-y-auto lg:overflow-hidden lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(380px,2fr)]">
      <!-- CỘT TRÁI -->
      <div class="flex flex-col min-h-0 lg:border-r border-slate-200/80">
        <!-- ĐĂNG THEO FANPAGE -->
        <section class="shrink-0 flex flex-col border-b border-slate-200/80" :class="composeCollapsed ? '' : 'lg:h-[58%] lg:min-h-[300px]'">
          <div class="shrink-0 flex items-center gap-2 px-3 lg:px-4 pt-2">
            <h2 class="text-sm font-extrabold text-slate-800">✍️ Lên lịch đăng bài</h2>
            <span class="hidden 2xl:inline text-[11px] text-slate-400">Chọn giờ → chọn Fanpage → nhập caption, bình luận, video</span>
            <button
              type="button"
              class="ml-auto text-[11px] font-bold text-slate-500 hover:text-slate-800 px-2 py-1 rounded-lg hover:bg-slate-100"
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
          <div class="flex items-center gap-2 px-4 lg:px-5 pt-3">
            <h2 class="text-sm font-extrabold text-slate-800">📅 Lịch đăng</h2>
            <span class="text-[11px] text-slate-400">Bài chưa đăng + bài đã xong trong {{ BOARD_RECENT_DAYS }} ngày</span>
          </div>
          <ScheduleView />
          <button
            v-if="showBackToTop"
            type="button"
            class="sticky bottom-4 float-right mr-4 z-10 w-10 h-10 rounded-full bg-slate-900/85 hover:bg-slate-900 text-white shadow-lg flex items-center justify-center transition"
            title="Lên đầu danh sách"
            @click="scheduleRef?.scrollTo({ top: 0, behavior: 'smooth' })"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 15l7-7 7 7" />
            </svg>
          </button>
        </section>
      </div>

      <!-- CỘT PHẢI: THỐNG KÊ -->
      <section class="min-h-0 border-t lg:border-t-0 border-slate-200/80 bg-white/40">
        <AnalyticsView />
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
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuth } from "./composables/useAuth";
import { usePages } from "./composables/usePages";
import { useTasks, BOARD_RECENT_DAYS } from "./composables/useTasks";
import Header from "./components/common/Header.vue";
import Toast from "./components/common/Toast.vue";
import ConnectFacebookModal from "./components/dialogs/ConnectFacebookModal.vue";
import MultiPageComposer from "./components/composer/MultiPageComposer.vue";
import ScheduleView from "./components/schedule/ScheduleView.vue";
import AnalyticsView from "./components/analytics/AnalyticsView.vue";

const { checkAuth } = useAuth();
const {
  loadPages,
  isConnectModalOpen,
  connectTargetAccountId,
  expiredAccounts,
  expiredAccountNames,
  openConnectModal,
  handleOAuthResult
} = usePages();
const { loadTasks } = useTasks();

const route = useRoute();
const router = useRouter();

const composeCollapsed = ref(false);

// Nút lên đầu danh sách lịch đăng
const scheduleRef = ref<HTMLElement | null>(null);
const showBackToTop = ref(false);
const onScheduleScroll = () => {
  showBackToTop.value = (scheduleRef.value?.scrollTop || 0) > 400;
};

const onTasksCreated = async () => {
  await loadTasks(true);
  scheduleRef.value?.scrollTo({ top: 0, behavior: "smooth" });
};

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
</script>

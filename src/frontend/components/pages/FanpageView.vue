<template>
  <div class="h-full flex flex-col p-4 lg:p-6 overflow-y-auto">
    <!-- Tabs -->
    <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
      <div class="inline-flex p-1 rounded-2xl bg-white border border-slate-200/80 shadow-2xs">
        <button
          v-for="t in tabs"
          :key="t.key"
          type="button"
          @click="pagesViewTab = t.key"
          class="px-4 py-1.5 rounded-xl text-xs font-bold transition"
          :class="pagesViewTab === t.key ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'"
        >
          {{ t.label }} <span class="opacity-75">({{ t.count }})</span>
        </button>
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          @click="syncPages"
          :disabled="isLoading || accounts.length === 0"
          class="flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-xl text-xs font-bold transition shadow-2xs disabled:opacity-50"
        >
          <svg class="w-3.5 h-3.5" :class="{ 'animate-spin': isLoading }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          <span>Đồng bộ lại</span>
        </button>
        <button
          type="button"
          @click="$emit('open-connect', null)"
          class="px-3 py-1.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-xl text-xs font-bold transition shadow-xs"
        >
          + Thêm Admin / Token
        </button>
      </div>
    </div>

    <!-- Pages dropped by the last token update -->
    <div
      v-if="missingPagesNotice"
      class="mb-4 px-4 py-3 rounded-2xl bg-amber-50/80 border border-amber-200/80 text-xs text-amber-900 flex items-start justify-between gap-3"
    >
      <div class="space-y-1">
        <p class="font-bold">
          ⚠️ {{ missingPagesNotice.pageNames.length }} Fanpage không có trong token vừa cập nhật{{ missingPagesNotice.accountName ? ` (${missingPagesNotice.accountName})` : "" }}:
          {{ missingPagesNotice.pageNames.join(", ") }}
        </p>
        <p class="text-amber-800">
          Lý do thường gặp: không tick Fanpage này khi tạo token trong Graph API Explorer, hoặc tài khoản không còn quyền admin.
          Tạo lại token có chọn các Fanpage này rồi cập nhật lại, hoặc xóa chúng khỏi hệ thống nếu không dùng nữa.
        </p>
      </div>
      <button type="button" @click="missingPagesNotice = null" class="text-amber-500 hover:text-amber-700 text-lg font-bold leading-none">&times;</button>
    </div>

    <!-- ============ TAB: PAGES ============ -->
    <template v-if="pagesViewTab === 'pages'">
      <!-- Filters -->
      <div class="flex flex-wrap items-center gap-2 mb-3 bg-white p-3 rounded-2xl border border-slate-200/80 shadow-2xs">
        <div class="relative flex-1 min-w-[200px]">
          <input
            v-model="query"
            type="text"
            placeholder="Tìm theo tên, ID hoặc danh mục..."
            class="w-full pl-8 pr-3 py-1.5 text-xs rounded-xl border border-slate-200 bg-slate-50/60 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400 transition"
          />
          <svg class="w-4 h-4 text-slate-400 absolute left-2.5 top-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <select v-model="statusFilter" class="px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 bg-white focus:outline-none focus:border-blue-400">
          <option value="all">Tất cả trạng thái</option>
          <option value="ok">Hoạt động ({{ statusCounts.ok }})</option>
          <option value="warn">Thiếu quyền ({{ statusCounts.warn }})</option>
          <option value="disconnected">Mất kết nối ({{ statusCounts.disconnected }})</option>
        </select>
        <select v-model="adminFilter" class="px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 bg-white focus:outline-none focus:border-blue-400 max-w-[220px]">
          <option value="all">Tất cả Admin</option>
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.facebook_user_name || a.facebook_user_id }}</option>
          <option value="none">Không có Admin</option>
        </select>

        <div v-if="selectedIds.length" class="flex items-center gap-2 ml-auto">
          <span class="text-xs text-slate-600"><b class="text-blue-700">{{ selectedIds.length }}</b> đã chọn</span>
          <button type="button" @click="selectedIds = []" class="text-[11px] font-bold text-slate-400 hover:text-slate-600">Bỏ chọn</button>
          <button
            type="button"
            @click="askDelete(selectedIds)"
            class="px-3 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 text-xs font-bold transition shadow-2xs"
          >
            Xóa {{ selectedIds.length }} Fanpage
          </button>
        </div>
      </div>

      <!-- Table -->
      <div class="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-hidden flex-1 flex flex-col min-h-[300px]">
        <div class="overflow-auto flex-1 scrollbar-thin">
          <table class="w-full text-xs text-left">
            <thead class="bg-slate-50/80 text-slate-600 font-bold border-b border-slate-200/80 sticky top-0 z-10">
              <tr>
                <th class="py-3 px-3 w-8">
                  <input
                    type="checkbox"
                    class="rounded border-slate-300 text-blue-600 focus:ring-blue-200"
                    :checked="allVisibleSelected"
                    :indeterminate.prop="someVisibleSelected && !allVisibleSelected"
                    @change="toggleAllVisible"
                    :disabled="visiblePages.length === 0"
                  />
                </th>
                <th class="py-3 px-2 w-10 text-center">#</th>
                <th class="py-3 px-3 min-w-[220px]">Fanpage</th>
                <th class="py-3 px-3 min-w-[150px]">Admin quản lý</th>
                <th class="py-3 px-3 min-w-[200px]">Trạng thái</th>
                <th class="py-3 px-3 w-28">Quyền</th>
                <th class="py-3 px-3 w-24 text-right">Theo dõi</th>
                <th class="py-3 px-3 w-32 text-center">Bài chờ / ✓ / ✕</th>
                <th class="py-3 px-3 w-24 text-center"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr
                v-for="(p, idx) in visiblePages"
                :key="p.facebook_page_id"
                class="align-top transition"
                :class="isSelected(p.facebook_page_id) ? 'bg-blue-50/40' : 'hover:bg-slate-50/60'"
              >
                <td class="py-3 px-3">
                  <input
                    type="checkbox"
                    class="rounded border-slate-300 text-blue-600 focus:ring-blue-200"
                    :checked="isSelected(p.facebook_page_id)"
                    @change="toggleSelect(p.facebook_page_id)"
                  />
                </td>
                <td class="py-3 px-2 text-center text-slate-400 font-bold">{{ pageNumber(p.facebook_page_id, idx) }}</td>
                <td class="py-3 px-3">
                  <div class="flex items-center gap-2.5 min-w-0">
                    <img v-if="p.avatar_url" :src="p.avatar_url" class="w-8 h-8 rounded-full object-cover border border-slate-200 flex-shrink-0" alt="" />
                    <div v-else class="w-8 h-8 rounded-full bg-slate-100 flex-shrink-0"></div>
                    <div class="min-w-0">
                      <div class="font-bold text-slate-800 truncate" :title="p.page_name">{{ p.page_name }}</div>
                      <div class="text-[10px] text-slate-400 font-mono truncate">
                        {{ p.facebook_page_id }}<span v-if="p.category"> · {{ p.category }}</span>
                      </div>
                    </div>
                  </div>
                </td>
                <td class="py-3 px-3">
                  <div v-if="adminNames(p).length" class="flex flex-wrap gap-1">
                    <span
                      v-for="n in adminNames(p)"
                      :key="n"
                      class="px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-700 text-[10px] font-semibold"
                    >{{ n }}</span>
                  </div>
                  <span v-else class="text-slate-400 italic">Không có</span>
                </td>
                <td class="py-3 px-3">
                  <span
                    class="inline-block px-2 py-0.5 rounded-md text-[10px] font-bold border"
                    :class="statusClass(pageStatus(p).level)"
                  >{{ pageStatus(p).label }}</span>
                  <p v-if="pageStatus(p).reason" class="mt-1 text-[11px] text-slate-500 leading-snug">{{ pageStatus(p).reason }}</p>
                </td>
                <td class="py-3 px-3">
                  <div class="flex flex-col gap-0.5 text-[11px]">
                    <span :class="p.can_post ? 'text-emerald-700' : 'text-rose-500'">{{ p.can_post ? "✓" : "✕" }} Đăng bài</span>
                    <span :class="p.can_analyze ? 'text-emerald-700' : 'text-slate-400'">{{ p.can_analyze ? "✓" : "✕" }} Thống kê</span>
                  </div>
                </td>
                <td class="py-3 px-3 text-right font-semibold text-slate-700">
                  {{ followerText(p) }}
                </td>
                <td class="py-3 px-3 text-center font-semibold">
                  <span class="text-amber-600">{{ (p.pending_count || 0) + (p.running_count || 0) }}</span>
                  <span class="text-slate-300 mx-1">/</span>
                  <span class="text-emerald-600">{{ p.success_count || 0 }}</span>
                  <span class="text-slate-300 mx-1">/</span>
                  <span class="text-rose-500">{{ p.failed_count || 0 }}</span>
                </td>
                <td class="py-3 px-3">
                  <div class="flex items-center justify-center gap-1">
                    <a
                      :href="`https://www.facebook.com/${p.facebook_page_id}`"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="p-1.5 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition"
                      title="Mở trên Facebook"
                    >
                      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    </a>
                    <button
                      type="button"
                      @click="askDelete([p.facebook_page_id])"
                      class="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 transition"
                      title="Xóa khỏi hệ thống"
                    >
                      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </td>
              </tr>
              <tr v-if="visiblePages.length === 0">
                <td colspan="9" class="py-12 text-center text-slate-400">
                  {{ pages.length === 0 ? "Chưa có Fanpage nào. Thêm tài khoản Admin để đồng bộ." : "Không có Fanpage nào khớp bộ lọc." }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ============ TAB: ADMIN ACCOUNTS ============ -->
    <template v-else>
      <div class="space-y-3">
        <div
          v-for="(acc, idx) in accounts"
          :key="acc.id"
          class="p-4 rounded-2xl border transition shadow-2xs"
          :class="isExpired(acc) ? 'bg-amber-50/50 border-amber-200' : 'bg-white border-slate-200/90 hover:border-blue-200'"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-3 min-w-0">
              <span class="w-6 text-center text-slate-400 font-bold text-xs">{{ idx + 1 }}</span>
              <div class="w-10 h-10 rounded-2xl bg-gradient-to-tr from-blue-100 to-indigo-100 text-indigo-700 font-black flex items-center justify-center text-sm border border-indigo-200 flex-shrink-0">
                {{ (acc.facebook_user_name || "FB").charAt(0).toUpperCase() }}
              </div>
              <div class="min-w-0">
                <div class="font-bold text-slate-800 text-xs truncate">{{ acc.facebook_user_name || "Tài khoản Facebook" }}</div>
                <div class="text-[11px] text-slate-400 font-mono truncate">ID: {{ acc.facebook_user_id }}</div>
                <div class="text-[10px] mt-0.5 flex items-center gap-2">
                  <span
                    class="font-bold px-1.5 py-0.5 rounded-md"
                    :class="isExpired(acc) ? 'bg-amber-100 text-amber-800' : 'bg-emerald-50 text-emerald-700 border border-emerald-200/60'"
                  >
                    {{ isExpired(acc) ? "⚠️ Token hết hạn" : "✓ Token hợp lệ" }}
                  </span>
                  <button
                    type="button"
                    class="text-blue-600 hover:underline font-semibold"
                    @click="showAccountPages(acc.id)"
                  >
                    {{ accountPageCount(acc.id) }} Fanpage
                  </button>
                </div>
              </div>
            </div>

            <div class="flex items-center gap-2 flex-shrink-0">
              <button
                type="button"
                @click="$emit('open-connect', acc.id)"
                class="px-3 py-1.5 rounded-xl border border-blue-200/80 bg-blue-50/70 hover:bg-blue-100 text-blue-700 text-xs font-bold transition shadow-2xs"
              >
                Cập nhật Token
              </button>
              <button
                type="button"
                @click="accountToDelete = acc"
                class="px-3 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 text-xs font-bold transition shadow-2xs"
              >
                Xóa
              </button>
            </div>
          </div>
        </div>

        <div v-if="accounts.length === 0" class="text-center py-10 text-slate-400 text-xs bg-white rounded-2xl border border-slate-200/80">
          Chưa có tài khoản Facebook Admin nào được liên kết.
        </div>
      </div>
    </template>

    <!-- Confirm: remove Pages -->
    <div
      v-if="pagesToDelete.length"
      class="fixed inset-0 z-60 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
      @click.self="pagesToDelete = []"
    >
      <div class="bg-white rounded-2xl border border-slate-200 p-6 max-w-md w-full shadow-2xl space-y-4">
        <h4 class="font-bold text-base text-slate-800">Xóa {{ pagesToDelete.length }} Fanpage khỏi hệ thống?</h4>
        <p class="text-xs text-slate-700 font-semibold leading-relaxed max-h-24 overflow-y-auto">
          {{ pagesToDelete.map(pageNameOf).join(", ") }}
        </p>
        <ul class="text-xs text-slate-600 leading-relaxed list-disc pl-4 space-y-1">
          <li>Các bài đã lên lịch và lịch sử đăng của Fanpage này <b>trong tool</b> sẽ bị xóa.</li>
          <li>Không thay đổi gì trên Facebook (bài đã đăng vẫn còn).</li>
          <li>Nếu token của một Admin vẫn quản lý Fanpage này, lần đồng bộ sau nó sẽ xuất hiện lại.</li>
        </ul>
        <div class="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            @click="pagesToDelete = []"
            class="px-3.5 py-1.5 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 text-xs font-bold"
          >
            Hủy
          </button>
          <button
            type="button"
            :disabled="isLoading"
            @click="confirmDeletePages"
            class="px-4 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-xs font-bold shadow-xs"
          >
            {{ isLoading ? "Đang xóa..." : "Xác nhận xóa" }}
          </button>
        </div>
      </div>
    </div>

    <!-- Confirm: remove admin account -->
    <div
      v-if="accountToDelete"
      class="fixed inset-0 z-60 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
      @click.self="accountToDelete = null"
    >
      <div class="bg-white rounded-2xl border border-slate-200 p-6 max-w-sm w-full shadow-2xl space-y-4">
        <h4 class="font-bold text-base text-slate-800">Xóa tài khoản Facebook?</h4>
        <p class="text-xs text-slate-600 leading-relaxed">
          Bạn có chắc chắn muốn ngắt kết nối tài khoản
          <strong class="text-slate-900">{{ accountToDelete.facebook_user_name }}</strong>?
          Các Fanpage chỉ do tài khoản này quản lý sẽ được xóa khỏi danh sách.
        </p>
        <div class="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            @click="accountToDelete = null"
            class="px-3.5 py-1.5 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 text-xs font-bold"
          >
            Hủy
          </button>
          <button
            type="button"
            @click="confirmDeleteAccount"
            class="px-4 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow-xs"
          >
            Xác nhận xóa
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { usePages } from "../../composables/usePages";
import type { FacebookAccount, FacebookPageRecord } from "@shared/types";

defineEmits<{ (e: "open-connect", accountId: string | null): void }>();

const { pages, accounts, isLoading, syncPages, deleteAccount, deletePages, pagesViewTab, missingPagesNotice } = usePages();

const tabs = computed(() => [
  { key: "pages" as const, label: "Fanpage", count: pages.value.length },
  { key: "accounts" as const, label: "Tài khoản Admin", count: accounts.value.length }
]);

// ---------- Status ----------
type Level = "ok" | "warn" | "disconnected";
const BAD_TOKEN = new Set(["expired", "revoked", "invalid"]);

const pageStatus = (p: FacebookPageRecord): { level: Level; label: string; reason: string } => {
  if (p.has_token === false || !(p.admin_accounts || []).length) {
    return {
      level: "disconnected",
      label: "⚠ Mất kết nối",
      reason: "Không có trong token của Admin nào: chưa tick Fanpage này khi tạo token, hoặc tài khoản đã mất quyền admin."
    };
  }
  if (BAD_TOKEN.has(p.token_status) || BAD_TOKEN.has(p.status)) {
    return { level: "disconnected", label: "⚠ Token hết hạn", reason: "Cập nhật token của Admin quản lý Fanpage này." };
  }
  if (!p.can_post) {
    return { level: "warn", label: "Thiếu quyền đăng bài", reason: "Tài khoản Admin không có quyền tạo nội dung (CREATE_CONTENT) trên Fanpage này." };
  }
  if (!p.can_analyze) {
    return { level: "warn", label: "Thiếu quyền thống kê", reason: "Không đọc được số liệu (cần quyền ANALYZE)." };
  }
  return { level: "ok", label: "✓ Hoạt động", reason: "" };
};

const statusClass = (level: Level) =>
  level === "ok"
    ? "bg-emerald-50 text-emerald-700 border-emerald-200/70"
    : level === "warn"
      ? "bg-amber-50 text-amber-700 border-amber-200/70"
      : "bg-rose-50 text-rose-700 border-rose-200/70";

const statusCounts = computed(() => {
  const c = { ok: 0, warn: 0, disconnected: 0 };
  for (const p of pages.value) c[pageStatus(p).level]++;
  return c;
});

const adminNames = (p: FacebookPageRecord) =>
  Array.from(new Set((p.admin_accounts || []).map((a) => a.facebook_user_name || a.facebook_user_id).filter(Boolean)));

const followerText = (p: FacebookPageRecord) => {
  const n = p.followers_count || p.fan_count;
  return n ? n.toLocaleString("en-US") : "–";
};

/** Same number for a Page on every screen: its position in the full Page list */
const pageNumbers = computed(() => new Map(pages.value.map((p, i) => [p.facebook_page_id, i + 1])));
const pageNumber = (id: string, fallbackIdx: number) => pageNumbers.value.get(id) ?? fallbackIdx + 1;

// ---------- Filters ----------
const query = ref("");
const statusFilter = ref<"all" | Level>("all");
const adminFilter = ref<string>("all");

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d");

const visiblePages = computed(() => {
  const q = normalize(query.value.trim());
  return pages.value.filter((p) => {
    if (statusFilter.value !== "all" && pageStatus(p).level !== statusFilter.value) return false;
    if (adminFilter.value === "none" && (p.admin_accounts || []).length > 0) return false;
    if (
      adminFilter.value !== "all" &&
      adminFilter.value !== "none" &&
      !(p.admin_accounts || []).some((a) => a.account_id === adminFilter.value)
    ) {
      return false;
    }
    if (!q) return true;
    return (
      normalize(p.page_name || "").includes(q) ||
      normalize(p.category || "").includes(q) ||
      p.facebook_page_id.includes(q)
    );
  });
});

// ---------- Selection (local to this screen only) ----------
const selectedIds = ref<string[]>([]);
const selectedSet = computed(() => new Set(selectedIds.value));
const isSelected = (id: string) => selectedSet.value.has(id);
const toggleSelect = (id: string) => {
  selectedIds.value = isSelected(id) ? selectedIds.value.filter((x) => x !== id) : [...selectedIds.value, id];
};
const allVisibleSelected = computed(
  () => visiblePages.value.length > 0 && visiblePages.value.every((p) => selectedSet.value.has(p.facebook_page_id))
);
const someVisibleSelected = computed(() => visiblePages.value.some((p) => selectedSet.value.has(p.facebook_page_id)));
const toggleAllVisible = () => {
  const visibleIds = visiblePages.value.map((p) => p.facebook_page_id);
  if (allVisibleSelected.value) {
    const drop = new Set(visibleIds);
    selectedIds.value = selectedIds.value.filter((id) => !drop.has(id));
  } else {
    selectedIds.value = Array.from(new Set([...selectedIds.value, ...visibleIds]));
  }
};
// Forget Pages that no longer exist (after a delete or sync)
watch(pages, (list) => {
  const exists = new Set(list.map((p) => p.facebook_page_id));
  selectedIds.value = selectedIds.value.filter((id) => exists.has(id));
});

// ---------- Delete Pages ----------
const pagesToDelete = ref<string[]>([]);
const pageNameOf = (id: string) => pages.value.find((p) => p.facebook_page_id === id)?.page_name || id;
const askDelete = (ids: string[]) => {
  pagesToDelete.value = [...ids];
};
const confirmDeletePages = async () => {
  const ids = pagesToDelete.value;
  await deletePages(ids);
  pagesToDelete.value = [];
  const removed = new Set(ids);
  selectedIds.value = selectedIds.value.filter((id) => !removed.has(id));
};

// ---------- Admin accounts ----------
const accountToDelete = ref<FacebookAccount | null>(null);
const isExpired = (acc: FacebookAccount) => BAD_TOKEN.has(acc.token_status || "");
const accountPageCount = (accountId: string) =>
  pages.value.filter((p) => (p.admin_accounts || []).some((a) => a.account_id === accountId)).length;
const showAccountPages = (accountId: string) => {
  adminFilter.value = accountId;
  statusFilter.value = "all";
  pagesViewTab.value = "pages";
};
const confirmDeleteAccount = async () => {
  if (!accountToDelete.value) return;
  const ok = await deleteAccount(accountToDelete.value.id);
  if (ok) accountToDelete.value = null;
};
</script>

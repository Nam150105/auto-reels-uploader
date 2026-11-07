<template>
  <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" @click.self="$emit('close')">
    <div class="bg-white rounded-2xl shadow-2xl border border-slate-100 max-w-2xl w-full p-6 animate-in fade-in zoom-in duration-150 select-none max-h-[92vh] flex flex-col">
      <!-- Header -->
      <div class="flex items-center justify-between pb-3.5 border-b border-slate-100 mb-4 shrink-0">
        <div class="flex items-center gap-2.5">
          <div class="w-9 h-9 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center text-lg">
            👥
          </div>
          <div>
            <h3 class="text-base font-bold text-slate-800">Quản Lý Tài Khoản Facebook</h3>
            <p class="text-[11px] text-slate-400">Danh sách các tài khoản Facebook và Fanpage đang được quản lý</p>
          </div>
        </div>
        <button type="button" @click="$emit('close')" class="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg transition text-lg font-bold">
          &times;
        </button>
      </div>

      <!-- Action Sub-header -->
      <div class="flex items-center justify-between bg-slate-50 p-3 rounded-xl border border-slate-200 mb-4 shrink-0 flex-wrap gap-2">
        <div class="text-xs">
          <span class="text-slate-500">Tổng tài khoản:</span>
          <b class="text-slate-800 ml-1 font-bold">{{ accounts.length }}</b>
          <span class="text-slate-300 mx-2">•</span>
          <span class="text-emerald-600 font-semibold">{{ validAccountsCount }} Đang hoạt động</span>
        </div>

        <div class="flex items-center gap-2">
          <button
            type="button"
            @click="syncPages"
            :disabled="isLoading || accounts.length === 0"
            class="flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 rounded-xl text-xs font-semibold transition disabled:opacity-50"
          >
            <svg class="w-3.5 h-3.5" :class="{ 'animate-spin': isLoading }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span>Đồng Bộ Tất Cả</span>
          </button>

          <button
            type="button"
            @click="openAddAdmin"
            class="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition shadow-xs"
          >
            <span>+ Thêm Admin Mới</span>
          </button>
        </div>
      </div>

      <!-- Account List -->
      <div class="flex-1 overflow-y-auto space-y-3 pr-1 scrollbar-thin">
        <div
          v-for="acc in accounts"
          :key="acc.id"
          class="p-4 rounded-xl border transition"
          :class="isExpired(acc) ? 'bg-amber-50/50 border-amber-200' : 'bg-white border-slate-200'"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-10 h-10 rounded-xl bg-blue-100 text-blue-700 font-bold flex items-center justify-center text-sm border border-blue-200 flex-shrink-0">
                {{ (acc.facebook_user_name || 'FB').charAt(0).toUpperCase() }}
              </div>
              <div class="min-w-0">
                <div class="font-bold text-slate-800 text-xs truncate">
                  {{ acc.facebook_user_name || 'Tài khoản Facebook' }}
                </div>
                <div class="text-[11px] text-slate-400 font-mono truncate">
                  ID: {{ acc.facebook_user_id }}
                </div>
                <div class="text-[10px] mt-0.5">
                  <span
                    class="font-semibold"
                    :class="isExpired(acc) ? 'text-amber-700' : 'text-emerald-600'"
                  >
                    {{ isExpired(acc) ? '⚠️ Token hết hạn' : '✓ Token hợp lệ' }}
                  </span>
                </div>
              </div>
            </div>

            <div class="flex items-center gap-2 flex-shrink-0">
              <button
                type="button"
                @click="openUpdateToken(acc.id)"
                class="px-2.5 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-semibold transition"
              >
                Cập nhật Token
              </button>
              <button
                type="button"
                @click="promptDelete(acc)"
                class="px-2.5 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 text-xs font-bold transition"
              >
                Xóa
              </button>
            </div>
          </div>
        </div>

        <div v-if="accounts.length === 0" class="text-center py-10 text-slate-400 text-xs">
          Chưa có tài khoản Facebook Admin nào được liên kết.
        </div>
      </div>

      <!-- Footer -->
      <div class="pt-4 border-t border-slate-100 flex justify-end shrink-0 mt-4">
        <button
          type="button"
          @click="$emit('close')"
          class="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold transition"
        >
          Đóng
        </button>
      </div>
    </div>

    <!-- Modal Xác Nhận Xóa Tài Khoản Facebook -->
    <div
      v-if="accountToDelete"
      class="fixed inset-0 z-60 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4"
      @click.self="accountToDelete = null"
    >
      <div class="bg-white rounded-2xl border border-slate-200 p-6 max-w-sm w-full shadow-2xl space-y-4">
        <h4 class="font-bold text-base text-slate-800">Xóa tài khoản Facebook?</h4>
        <p class="text-xs text-slate-600 leading-relaxed">
          Bạn có chắc chắn muốn ngắt kết nối tài khoản
          <strong class="text-slate-900">{{ accountToDelete.facebook_user_name }}</strong>?
          Các Fanpage độc quyền của tài khoản này sẽ được gỡ khỏi danh sách quản lý.
        </p>
        <div class="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            @click="accountToDelete = null"
            class="px-3.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 text-xs font-medium"
          >
            Hủy
          </button>
          <button
            type="button"
            @click="confirmDelete"
            class="px-4 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow-xs"
          >
            Xác nhận xóa
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { usePages } from "../../composables/usePages";
import type { FacebookAccount } from "@shared/types";

defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "open-connect", accountId?: string | null): void;
}>();

const { accounts, isLoading, syncPages, deleteAccount } = usePages();

const accountToDelete = ref<FacebookAccount | null>(null);

const validAccountsCount = computed(() => {
  return accounts.value.filter(
    (a) => a.token_status !== "expired" && a.token_status !== "revoked" && a.token_status !== "invalid"
  ).length;
});

const isExpired = (acc: FacebookAccount): boolean => {
  return acc.token_status === "expired" || acc.token_status === "revoked" || acc.token_status === "invalid";
};

const openAddAdmin = () => {
  emit("open-connect", null);
};

const openUpdateToken = (accountId: string) => {
  emit("open-connect", accountId);
};

const promptDelete = (acc: FacebookAccount) => {
  accountToDelete.value = acc;
};

const confirmDelete = async () => {
  if (!accountToDelete.value) return;
  const id = accountToDelete.value.id;
  accountToDelete.value = null;
  await deleteAccount(id);
};
</script>

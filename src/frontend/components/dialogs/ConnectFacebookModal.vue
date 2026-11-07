<template>
  <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" @click.self="$emit('close')">
    <div class="bg-white rounded-2xl shadow-2xl border border-slate-100 max-w-xl w-full p-6 animate-in fade-in zoom-in duration-150 select-none max-h-[92vh] overflow-y-auto">
      <!-- Header -->
      <div class="flex items-center justify-between pb-3.5 border-b border-slate-100 mb-4">
        <div class="flex items-center gap-2.5">
          <div class="w-9 h-9 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold text-lg">
            🔑
          </div>
          <div>
            <h3 class="text-base font-bold text-slate-800">
              {{ targetAccountId ? 'Cập Nhật Token Facebook Admin' : 'Liên kết Facebook Admin (Graph API Explorer)' }}
            </h3>
            <p class="text-[11px] text-slate-400">Kết nối tài khoản để tự động đồng bộ toàn bộ Fanpage</p>
          </div>
        </div>
        <button type="button" @click="$emit('close')" class="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg transition text-lg font-bold">
          &times;
        </button>
      </div>

      <div class="space-y-4 text-xs">
        <!-- HƯỚNG DẪN 6 BƯỚC GRAPH API EXPLORER CHUẨN XÁC & META APP ID 1469615908436980 -->
        <div class="p-4 rounded-xl bg-blue-50/80 border border-blue-200/80 space-y-2 text-slate-700">
          <div class="font-bold text-blue-900 flex items-center gap-1.5 text-xs">
            <span>📋</span>
            <span>Hướng dẫn lấy Token từ Graph API Explorer:</span>
          </div>
          <ol class="list-decimal pl-4 space-y-1.5 text-[11px] text-slate-600 leading-relaxed">
            <li>
              Mở công cụ
              <a
                href="https://developers.facebook.com/tools/explorer/"
                target="_blank"
                rel="noopener noreferrer"
                class="text-blue-600 underline font-bold hover:text-blue-800"
              >
                Graph API Explorer
              </a>
              trên Facebook Developers.
            </li>
            <li>
              Chọn đúng Meta App:
              <b class="text-blue-900 font-mono bg-blue-100/70 px-1.5 py-0.5 rounded">1469615908436980</b>.
            </li>
            <li>
              Chọn các quyền bắt buộc:
              <span class="font-mono text-blue-800 bg-white px-1.5 py-0.5 rounded border border-blue-200">
                pages_show_list, pages_read_engagement, pages_manage_posts, pages_manage_engagement, read_insights
              </span>.
            </li>
            <li>
              Nhấn nút <b>Generate Access Token</b> để nhận User Token.
            </li>
            <li>
              Dán mã Access Token vừa tạo vào ô bên dưới.
            </li>
            <li>
              Bấm nút <b>{{ targetAccountId ? 'Cập nhật Token' : 'Liên kết Facebook' }}</b> để hệ thống tự động đồng bộ Fanpage!
            </li>
          </ol>
        </div>

        <!-- Ô nhập Access Token -->
        <div>
          <label class="block font-bold text-slate-700 mb-1.5">
            Access Token của bạn (directAccessToken):
          </label>
          <textarea
            v-model="tokenInput"
            name="directAccessToken"
            id="directAccessToken"
            rows="4"
            placeholder="Dán token EAAU... hoặc EAAB... vào đây"
            class="w-full px-3 py-2 text-xs font-mono rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition select-all"
          ></textarea>
        </div>

        <!-- Lựa chọn OAuth trực tiếp -->
        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <svg class="w-4 h-4 text-blue-600" fill="currentColor" viewBox="0 0 24 24">
              <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
            </svg>
            <span class="text-[11px] text-slate-600 font-medium">Hoặc đăng nhập Facebook trực tiếp:</span>
          </div>
          <a
            href="/api/meta/oauth"
            class="px-3 py-1 bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 rounded-lg text-xs font-semibold shadow-xs transition"
          >
            Đăng nhập OAuth
          </a>
        </div>
      </div>

      <!-- Footer Buttons -->
      <div class="flex items-center justify-end gap-2.5 pt-4 mt-4 border-t border-slate-100">
        <button
          type="button"
          @click="$emit('close')"
          class="px-4 py-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50 font-medium text-xs transition"
        >
          Hủy bỏ
        </button>
        <button
          type="button"
          :disabled="!tokenInput.trim() || isSubmitting"
          @click="submitToken"
          class="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold text-xs shadow-sm transition flex items-center gap-2"
        >
          <svg v-if="isSubmitting" class="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
          </svg>
          <span>{{ isSubmitting ? 'Đang đồng bộ...' : (targetAccountId ? 'Cập nhật Token' : 'Liên kết Facebook') }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { usePages } from "../../composables/usePages";

const props = defineProps<{
  isOpen: boolean;
  targetAccountId?: string | null;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

const { connectWithToken } = usePages();

const tokenInput = ref("");
const isSubmitting = ref(false);

const submitToken = async () => {
  if (!tokenInput.value.trim()) return;
  isSubmitting.value = true;
  try {
    const ok = await connectWithToken(tokenInput.value.trim(), props.targetAccountId || null);
    if (ok) {
      tokenInput.value = "";
      emit("close");
    }
  } finally {
    isSubmitting.value = false;
  }
};
</script>

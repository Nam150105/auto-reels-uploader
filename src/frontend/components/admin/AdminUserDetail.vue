<template>
  <div class="fixed inset-0 z-40 bg-slate-900/30 flex justify-end" @click.self="$emit('close')">
    <aside class="w-full max-w-2xl h-full bg-[#f8fafc] shadow-2xl overflow-y-auto">
      <div class="sticky top-0 bg-white border-b border-slate-200 px-5 py-3 flex items-center justify-between z-10">
        <h3 class="text-sm font-bold text-slate-800">Chi tiết người dùng</h3>
        <button type="button" class="admin-btn-ghost" @click="$emit('close')">Đóng</button>
      </div>

      <div v-if="isLoading && !detail" class="p-10 text-center text-xs text-slate-400">Đang tải...</div>

      <div v-else-if="detail" class="p-5 space-y-4">
        <!-- Account -->
        <div class="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-xs">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-base font-black text-slate-800">
                {{ detail.user.full_name || detail.user.username }}
                <span v-if="detail.user.role === 'admin'" class="ml-1 text-[10px] font-bold text-rose-600 bg-rose-50 px-1.5 py-0.5 rounded align-middle">ADMIN</span>
                <span v-if="!detail.user.is_active" class="ml-1 text-[10px] font-bold text-slate-600 bg-slate-200 px-1.5 py-0.5 rounded align-middle">ĐÃ KHOÁ</span>
              </p>
              <p class="text-xs text-slate-500">ID: {{ detail.user.id }}</p>
            </div>
            <div class="flex gap-2 shrink-0">
              <button type="button" class="admin-btn-ghost" @click="$emit('edit', detail.user)">Sửa</button>
              <button type="button" class="admin-btn-primary" @click="$emit('password', detail.user)">Đặt mật khẩu</button>
            </div>
          </div>
          <dl class="grid grid-cols-2 gap-x-4 gap-y-2 mt-3 text-xs">
            <div><dt class="text-slate-400">Tên đăng nhập</dt><dd class="font-bold text-slate-700">{{ detail.user.username }}</dd></div>
            <div><dt class="text-slate-400">Mật khẩu</dt><dd class="text-slate-500">•••••••• <span class="text-[11px]">(đã mã hoá, không xem được)</span></dd></div>
            <div><dt class="text-slate-400">Email</dt><dd class="text-slate-700">{{ detail.user.email || "—" }}</dd></div>
            <div><dt class="text-slate-400">Quyền</dt><dd class="text-slate-700">{{ detail.user.role === "admin" ? "Admin" : "Thành viên" }}</dd></div>
            <div><dt class="text-slate-400">Ngày tạo</dt><dd class="text-slate-700">{{ formatDateTime(detail.user.created_at) }}</dd></div>
            <div><dt class="text-slate-400">Cập nhật</dt><dd class="text-slate-700">{{ formatDateTime(detail.user.updated_at) }}</dd></div>
          </dl>
          <div v-if="Object.keys(detail.tasks_by_status).length" class="flex flex-wrap gap-1.5 mt-3">
            <span v-for="(n, s) in detail.tasks_by_status" :key="s" class="text-[11px] px-2 py-0.5 rounded-lg bg-slate-100 text-slate-600">
              {{ TASK_STATUS_LABELS[s] || s }}: <b>{{ n }}</b>
            </span>
          </div>
        </div>

        <!-- Facebook accounts -->
        <div class="bg-white rounded-2xl border border-slate-200/80 shadow-xs">
          <h4 class="px-4 py-3 border-b border-slate-100 text-sm font-bold text-slate-800">Tài khoản Facebook đã kết nối ({{ detail.facebook_accounts.length }})</h4>
          <p v-if="!detail.facebook_accounts.length" class="p-4 text-xs text-slate-400">Chưa kết nối tài khoản Facebook nào.</p>
          <ul v-else class="divide-y divide-slate-100">
            <li v-for="a in detail.facebook_accounts" :key="a.id" class="px-4 py-3 text-xs">
              <div class="flex items-center justify-between gap-2">
                <a :href="`https://www.facebook.com/${a.facebook_user_id}`" target="_blank" rel="noopener noreferrer" class="font-bold text-slate-800 hover:text-blue-600">
                  {{ a.facebook_user_name || a.facebook_user_id }}
                </a>
                <span class="text-[11px] font-bold px-2 py-0.5 rounded-lg" :class="tokenBadge(a.token_status, a.status)">
                  {{ tokenLabel(a.token_status, a.status) }}
                </span>
              </div>
              <p class="text-slate-500 mt-0.5">
                FB ID {{ a.facebook_user_id }}<template v-if="a.facebook_user_email"> · {{ a.facebook_user_email }}</template> · {{ a.pages }} Fanpage
              </p>
              <p class="text-slate-400">
                Kết nối: {{ formatDateTime(a.connected_at) }} · Token hết hạn: {{ a.token_expires_at ? formatDateTime(a.token_expires_at) : "không hết hạn" }} · Đồng bộ: {{ timeAgo(a.last_synced_at) }}
              </p>
              <p v-if="a.missing_scopes.length" class="text-amber-700 mt-0.5">Thiếu quyền: {{ a.missing_scopes.join(", ") }}</p>
              <p v-if="a.last_error" class="text-red-600 mt-0.5">Lỗi gần nhất: {{ a.last_error }}</p>
            </li>
          </ul>
        </div>

        <!-- Pages -->
        <div class="bg-white rounded-2xl border border-slate-200/80 shadow-xs">
          <h4 class="px-4 py-3 border-b border-slate-100 text-sm font-bold text-slate-800">Fanpage đang quản lý ({{ detail.pages.length }})</h4>
          <p v-if="!detail.pages.length" class="p-4 text-xs text-slate-400">Chưa có Fanpage.</p>
          <ul v-else class="divide-y divide-slate-100 max-h-80 overflow-y-auto">
            <li v-for="p in detail.pages" :key="p.facebook_page_id" class="px-4 py-2 flex items-center gap-3 text-xs">
              <img v-if="p.avatar_url" :src="p.avatar_url" class="w-7 h-7 rounded-full object-cover bg-slate-200" />
              <span v-else class="w-7 h-7 rounded-full bg-slate-200"></span>
              <div class="min-w-0 flex-1">
                <a :href="`https://www.facebook.com/${p.facebook_page_id}`" target="_blank" rel="noopener noreferrer" class="font-bold text-slate-800 hover:text-blue-600 truncate block">{{ p.page_name }}</a>
                <p class="text-slate-400 truncate">{{ p.category || "—" }} · {{ p.tasks }} bài đăng</p>
              </div>
              <span class="text-[11px] font-bold px-2 py-0.5 rounded-lg shrink-0" :class="tokenBadge(p.token_status, p.status)">{{ tokenLabel(p.token_status, p.status) }}</span>
            </li>
          </ul>
        </div>

        <!-- Sessions -->
        <div class="bg-white rounded-2xl border border-slate-200/80 shadow-xs">
          <div class="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <h4 class="text-sm font-bold text-slate-800">Phiên đăng nhập</h4>
            <button v-if="activeSessions > 0" type="button" class="admin-link" @click="revokeAll">Đăng xuất mọi thiết bị</button>
          </div>
          <p v-if="!detail.sessions.length" class="p-4 text-xs text-slate-400">Chưa đăng nhập lần nào.</p>
          <ul v-else class="divide-y divide-slate-100">
            <li v-for="s in detail.sessions" :key="s.id" class="px-4 py-2 flex items-center justify-between gap-3 text-xs" :class="{ 'opacity-50': !s.active }">
              <div class="min-w-0">
                <p class="font-bold text-slate-700">
                  {{ describeDevice(s.user_agent) }}
                  <span v-if="s.is_current" class="text-[10px] text-blue-600">(phiên của bạn)</span>
                </p>
                <p class="text-slate-400">
                  IP {{ s.last_ip || s.ip_address || "—" }} · Đăng nhập {{ formatDateTime(s.created_at) }} · Hoạt động {{ timeAgo(s.last_seen_at) }}
                </p>
              </div>
              <span v-if="s.online" class="text-emerald-600 font-bold shrink-0">Online</span>
              <span v-else-if="!s.active" class="text-slate-400 shrink-0">{{ s.revoked_at ? "Đã đăng xuất" : "Hết hạn" }}</span>
              <button v-else-if="!s.is_current" type="button" class="admin-link shrink-0" @click="revoke(s.id)">Đăng xuất</button>
            </li>
          </ul>
        </div>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useToast } from "../../composables/useToast";
import { adminApi, type AdminUserDetail } from "../../services/adminApi";
import { describeDevice, formatDateTime, timeAgo, TASK_STATUS_LABELS } from "./adminFormat";

const props = defineProps<{ userId: string }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "edit", user: AdminUserDetail["user"]): void;
  (e: "password", user: AdminUserDetail["user"]): void;
  (e: "changed"): void;
}>();

const toast = useToast();
const detail = ref<AdminUserDetail | null>(null);
const isLoading = ref(false);

const load = async () => {
  isLoading.value = true;
  try {
    detail.value = await adminApi.user(props.userId);
  } catch (err: any) {
    toast.error(err?.message || "Couldn't load this user.");
    emit("close");
  } finally {
    isLoading.value = false;
  }
};
watch(() => props.userId, load, { immediate: true });

const activeSessions = computed(() => detail.value?.sessions.filter((s) => s.active && !s.is_current).length || 0);

const tokenLabel = (tokenStatus: string, status: string) => {
  if (status === "disconnected") return "Đã ngắt kết nối";
  if (tokenStatus === "valid") return "Hoạt động";
  if (tokenStatus === "expired") return "Token hết hạn";
  if (tokenStatus === "missing") return "Mất token";
  return tokenStatus || status || "—";
};
const tokenBadge = (tokenStatus: string, status: string) =>
  status !== "disconnected" && tokenStatus === "valid"
    ? "bg-emerald-50 text-emerald-700"
    : "bg-amber-50 text-amber-700";

const revoke = async (sessionId: string) => {
  try {
    await adminApi.revokeSession(sessionId);
    toast.success("Session signed out.");
    await load();
    emit("changed");
  } catch (err: any) {
    toast.error(err?.message || "Couldn't sign the session out.");
  }
};
const revokeAll = async () => {
  if (!detail.value || !confirm(`Đăng xuất @${detail.value.user.username} khỏi mọi thiết bị?`)) return;
  try {
    const res = await adminApi.revokeUserSessions(detail.value.user.id);
    toast.success(`Signed out ${res.revoked_sessions} session(s).`);
    await load();
    emit("changed");
  } catch (err: any) {
    toast.error(err?.message || "Couldn't sign the user out.");
  }
};

defineExpose({ reload: load });
</script>

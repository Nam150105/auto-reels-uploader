<template>
  <div class="h-full overflow-y-auto p-4 lg:p-6">
    <div v-if="!user" class="p-10 text-center text-xs text-slate-400">Đang tải...</div>
    <div v-else-if="!isAdmin" class="max-w-md mx-auto mt-20 bg-white border border-slate-200 rounded-2xl p-6 text-center shadow-xs">
      <p class="text-sm font-bold text-slate-800">Bạn không có quyền vào trang quản trị</p>
      <p class="text-xs text-slate-500 mt-1">Chỉ tài khoản admin mới xem được trang này.</p>
    </div>

    <template v-else>
      <!-- Tabs -->
      <div class="flex flex-wrap items-center justify-between gap-3 mb-5">
        <nav class="flex flex-wrap gap-1 bg-white p-1 rounded-2xl border border-slate-200/80 shadow-xs">
          <RouterLink
            v-for="t in tabs"
            :key="t.key"
            :to="t.to"
            class="px-3.5 py-1.5 rounded-xl text-xs font-bold transition"
            :class="section === t.key ? 'bg-rose-600 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'"
          >
            {{ t.label }}
          </RouterLink>
        </nav>
        <button
          type="button"
          class="px-3 py-1.5 rounded-xl text-xs font-bold border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 shadow-2xs"
          @click="showOwnPassword = true"
        >
          Đổi mật khẩu của tôi
        </button>
      </div>

      <!-- Overview -->
      <section v-if="section === 'overview'">
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <div v-for="tile in tiles" :key="tile.label" class="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-xs">
            <p class="text-[11px] font-bold text-slate-500 uppercase tracking-wide">{{ tile.label }}</p>
            <p class="text-2xl font-black mt-1" :class="tile.color">{{ tile.value }}</p>
            <p v-if="tile.hint" class="text-[11px] text-slate-400 mt-0.5">{{ tile.hint }}</p>
          </div>
        </div>

        <div class="grid lg:grid-cols-3 gap-4">
          <div class="lg:col-span-2 bg-white rounded-2xl border border-slate-200/80 shadow-xs">
            <div class="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <h3 class="text-sm font-bold text-slate-800 flex items-center gap-2">
                <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                Đang online
              </h3>
              <span class="text-[11px] text-slate-400">Hoạt động trong {{ overview?.online_window_minutes ?? 5 }} phút gần nhất · tự cập nhật 30 giây/lần</span>
            </div>
            <div v-if="!overview?.online_sessions.length" class="p-6 text-center text-xs text-slate-400">Không có ai đang online.</div>
            <ul v-else class="divide-y divide-slate-100">
              <li v-for="s in overview.online_sessions" :key="s.session_id" class="px-4 py-2.5 flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <RouterLink :to="`/admin/users?user=${s.user_id}`" class="text-sm font-bold text-slate-800 hover:text-rose-600">
                    {{ s.full_name || s.username }}
                  </RouterLink>
                  <span class="text-xs text-slate-400 ml-1">@{{ s.username }}</span>
                  <span v-if="s.role === 'admin'" class="ml-1 text-[10px] font-bold text-rose-600 bg-rose-50 px-1.5 py-0.5 rounded">ADMIN</span>
                  <p class="text-[11px] text-slate-500">{{ describeDevice(s.user_agent) }} · IP {{ s.ip_address || "—" }}</p>
                </div>
                <span class="text-[11px] text-emerald-600 font-bold shrink-0">{{ timeAgo(s.last_seen_at) }}</span>
              </li>
            </ul>
          </div>

          <div class="bg-white rounded-2xl border border-slate-200/80 shadow-xs">
            <div class="px-4 py-3 border-b border-slate-100">
              <h3 class="text-sm font-bold text-slate-800">Bài đăng theo trạng thái</h3>
            </div>
            <ul class="p-4 space-y-2">
              <li v-for="(n, status) in overview?.tasks_by_status || {}" :key="status" class="flex justify-between text-xs">
                <span class="text-slate-600">{{ TASK_STATUS_LABELS[status] || status }}</span>
                <span class="font-bold text-slate-800">{{ n }}</span>
              </li>
              <li v-if="!Object.keys(overview?.tasks_by_status || {}).length" class="text-xs text-slate-400">Chưa có bài đăng.</li>
            </ul>
          </div>
        </div>
      </section>

      <AdminUsers v-else-if="section === 'users'" />
      <AdminSessions v-else-if="section === 'sessions'" />
      <AdminApiCatalog v-else-if="section === 'api'" />
    </template>

    <!-- Change own password -->
    <div v-if="showOwnPassword" class="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" @click.self="showOwnPassword = false">
      <form class="bg-white rounded-2xl p-5 w-full max-w-sm shadow-xl space-y-3" @submit.prevent="changeOwnPassword">
        <h3 class="text-sm font-bold text-slate-800">Đổi mật khẩu của tôi</h3>
        <input v-model="ownForm.current" type="password" autocomplete="current-password" placeholder="Mật khẩu hiện tại" class="admin-input" required />
        <input v-model="ownForm.next" type="password" autocomplete="new-password" placeholder="Mật khẩu mới (ít nhất 6 ký tự)" class="admin-input" minlength="6" required />
        <p class="text-[11px] text-slate-500">Các thiết bị khác đang đăng nhập tài khoản này sẽ bị đăng xuất.</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="admin-btn-ghost" @click="showOwnPassword = false">Huỷ</button>
          <button type="submit" class="admin-btn-primary" :disabled="isSaving">Lưu</button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useAuth } from "../../composables/useAuth";
import { useToast } from "../../composables/useToast";
import { adminApi, type AdminOverview } from "../../services/adminApi";
import { describeDevice, timeAgo, TASK_STATUS_LABELS } from "./adminFormat";
import AdminUsers from "./AdminUsers.vue";
import AdminSessions from "./AdminSessions.vue";
import AdminApiCatalog from "./AdminApiCatalog.vue";

const route = useRoute();
const toast = useToast();
const { user } = useAuth();

const isAdmin = computed(() => user.value?.role === "admin");
const section = computed(() => String(route.params.section || "overview"));

const tabs = [
  { key: "overview", label: "Tổng quan", to: "/admin" },
  { key: "users", label: "Người dùng", to: "/admin/users" },
  { key: "sessions", label: "Phiên đăng nhập", to: "/admin/sessions" },
  { key: "api", label: "Danh sách API", to: "/admin/api" }
];

const overview = ref<AdminOverview | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

const loadOverview = async () => {
  try {
    overview.value = await adminApi.overview();
  } catch (err: any) {
    toast.error(err?.message || "Couldn't load the overview.");
  }
};

const tiles = computed(() => {
  const c = overview.value?.counts;
  return [
    { label: "Đang online", value: c?.online_users ?? "—", color: "text-emerald-600", hint: "người dùng" },
    { label: "Người dùng", value: c?.users ?? "—", color: "text-slate-800", hint: c ? `${c.active_users} đang hoạt động · ${c.admins} admin` : "" },
    { label: "Tài khoản Facebook", value: c?.facebook_accounts ?? "—", color: "text-blue-600", hint: "đã kết nối" },
    { label: "Fanpage", value: c?.pages ?? "—", color: "text-indigo-600", hint: c ? `${c.tasks} bài đăng · ${c.active_sessions} phiên` : "" }
  ];
});

watch(
  [section, isAdmin],
  ([s, admin]) => {
    if (timer) clearInterval(timer);
    timer = null;
    if (admin && s === "overview") {
      loadOverview();
      timer = setInterval(loadOverview, 30000);
    }
  },
  { immediate: true }
);
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

const showOwnPassword = ref(false);
const isSaving = ref(false);
const ownForm = reactive({ current: "", next: "" });
const changeOwnPassword = async () => {
  isSaving.value = true;
  try {
    await adminApi.changeOwnPassword(ownForm.current, ownForm.next);
    toast.success("Password changed.");
    showOwnPassword.value = false;
    ownForm.current = "";
    ownForm.next = "";
  } catch (err: any) {
    toast.error(err?.message || "Couldn't change the password.");
  } finally {
    isSaving.value = false;
  }
};
</script>

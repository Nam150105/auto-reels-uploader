<template>
  <section>
    <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
      <div class="flex gap-1 bg-white p-1 rounded-xl border border-slate-200/80">
        <button
          v-for="s in scopes"
          :key="s.key"
          type="button"
          class="px-3 py-1 rounded-lg text-xs font-bold"
          :class="scope === s.key ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100'"
          @click="scope = s.key"
        >
          {{ s.label }}
        </button>
      </div>
      <button type="button" class="admin-btn-ghost" :disabled="isLoading" @click="load">Tải lại</button>
    </div>

    <div class="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-x-auto">
      <table class="w-full text-xs">
        <thead class="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wide">
          <tr>
            <th class="text-left px-4 py-2.5">Người dùng</th>
            <th class="text-left px-3 py-2.5">Thiết bị</th>
            <th class="text-left px-3 py-2.5">IP</th>
            <th class="text-left px-3 py-2.5">Đăng nhập</th>
            <th class="text-left px-3 py-2.5">Hoạt động gần nhất</th>
            <th class="text-left px-3 py-2.5">Hết hạn</th>
            <th class="text-right px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          <tr v-if="isLoading && !sessions.length"><td colspan="7" class="px-4 py-8 text-center text-slate-400">Đang tải...</td></tr>
          <tr v-else-if="!sessions.length"><td colspan="7" class="px-4 py-8 text-center text-slate-400">Không có phiên nào.</td></tr>
          <tr v-for="s in sessions" :key="s.id" :class="{ 'opacity-50': !s.active }">
            <td class="px-4 py-2.5">
              <RouterLink :to="`/admin/users?user=${s.user_id}`" class="font-bold text-slate-800 hover:text-rose-600">{{ s.full_name || s.username }}</RouterLink>
              <span class="block text-[11px] text-slate-400">@{{ s.username }}</span>
            </td>
            <td class="px-3 py-2.5 text-slate-600" :title="s.user_agent || ''">{{ describeDevice(s.user_agent) }}</td>
            <td class="px-3 py-2.5 text-slate-600 font-mono">{{ s.last_ip || s.ip_address || "—" }}</td>
            <td class="px-3 py-2.5 text-slate-600 whitespace-nowrap">{{ formatDateTime(s.created_at) }}</td>
            <td class="px-3 py-2.5 whitespace-nowrap">
              <span v-if="s.online" class="text-emerald-600 font-bold">Online · {{ timeAgo(s.last_seen_at) }}</span>
              <span v-else class="text-slate-500">{{ timeAgo(s.last_seen_at) }}</span>
            </td>
            <td class="px-3 py-2.5 text-slate-500 whitespace-nowrap">
              {{ s.revoked_at ? "Đã đăng xuất" : formatUnixSeconds(s.expires_at) }}
            </td>
            <td class="px-4 py-2.5 text-right">
              <span v-if="s.is_current" class="text-[11px] text-blue-600 font-bold">Phiên của bạn</span>
              <button v-else-if="s.active" type="button" class="admin-link" @click="revoke(s.id)">Đăng xuất</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useToast } from "../../composables/useToast";
import { adminApi, type AdminSession } from "../../services/adminApi";
import { describeDevice, formatDateTime, formatUnixSeconds, timeAgo } from "./adminFormat";

type Scope = "online" | "active" | "all";
const scopes: Array<{ key: Scope; label: string }> = [
  { key: "online", label: "Đang online" },
  { key: "active", label: "Còn hiệu lực" },
  { key: "all", label: "Tất cả" }
];

const toast = useToast();
const scope = ref<Scope>("active");
const sessions = ref<AdminSession[]>([]);
const isLoading = ref(false);

const load = async () => {
  isLoading.value = true;
  try {
    sessions.value = await adminApi.sessions(scope.value);
  } catch (err: any) {
    toast.error(err?.message || "Couldn't load sessions.");
  } finally {
    isLoading.value = false;
  }
};
watch(scope, load, { immediate: true });

const revoke = async (id: string) => {
  if (!confirm("Đăng xuất phiên này?")) return;
  try {
    await adminApi.revokeSession(id);
    toast.success("Session signed out.");
    await load();
  } catch (err: any) {
    toast.error(err?.message || "Couldn't sign the session out.");
  }
};
</script>

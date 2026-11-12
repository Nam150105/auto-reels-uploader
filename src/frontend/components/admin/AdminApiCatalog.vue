<template>
  <section>
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <input v-model="search" type="search" placeholder="Tìm theo đường dẫn hoặc mô tả..." class="admin-input max-w-xs" />
      <select v-model="access" class="admin-input w-auto">
        <option value="">Mọi quyền truy cập</option>
        <option value="public">Công khai</option>
        <option value="user">Cần đăng nhập</option>
        <option value="admin">Chỉ admin</option>
      </select>
      <span class="text-xs text-slate-500 ml-auto">{{ filtered.length }} / {{ endpoints.length }} API</span>
    </div>

    <div v-if="isLoading" class="p-10 text-center text-xs text-slate-400">Đang tải...</div>

    <div v-for="group in groups" :key="group.name" class="bg-white rounded-2xl border border-slate-200/80 shadow-xs mb-3 overflow-hidden">
      <h3 class="px-4 py-2.5 bg-slate-50 border-b border-slate-100 text-xs font-bold text-slate-700">{{ group.name }} <span class="text-slate-400 font-normal">({{ group.items.length }})</span></h3>
      <ul class="divide-y divide-slate-100">
        <li v-for="e in group.items" :key="e.method + e.path" class="px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span class="flex gap-1 w-28 shrink-0">
            <span v-for="m in e.method.split(', ')" :key="m" class="px-1.5 py-0.5 rounded font-mono font-bold text-[10px]" :class="methodClass(m)">{{ m }}</span>
          </span>
          <code class="font-mono text-slate-800 font-bold select-all">{{ e.path }}</code>
          <span class="text-slate-500 flex-1 min-w-[12rem]">{{ e.description }}</span>
          <span class="text-[10px] font-bold px-1.5 py-0.5 rounded" :class="accessClass(e.access)">{{ accessLabel(e.access) }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { ApiAccess, ApiEndpoint } from "@shared/apiCatalog";
import { useToast } from "../../composables/useToast";
import { adminApi } from "../../services/adminApi";

const toast = useToast();
const endpoints = ref<ApiEndpoint[]>([]);
const isLoading = ref(false);
const search = ref("");
const access = ref<"" | ApiAccess>("");

onMounted(async () => {
  isLoading.value = true;
  try {
    endpoints.value = await adminApi.apiCatalog();
  } catch (err: any) {
    toast.error(err?.message || "Couldn't load the API list.");
  } finally {
    isLoading.value = false;
  }
});

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return endpoints.value.filter(
    (e) =>
      (!access.value || e.access === access.value) &&
      (!q || e.path.toLowerCase().includes(q) || e.description.toLowerCase().includes(q) || e.group.toLowerCase().includes(q))
  );
});

const groups = computed(() => {
  const map = new Map<string, ApiEndpoint[]>();
  for (const e of filtered.value) {
    if (!map.has(e.group)) map.set(e.group, []);
    map.get(e.group)!.push(e);
  }
  return Array.from(map, ([name, items]) => ({ name, items }));
});

const methodClass = (m: string) =>
  ({
    GET: "bg-emerald-50 text-emerald-700",
    POST: "bg-blue-50 text-blue-700",
    PUT: "bg-amber-50 text-amber-700",
    DELETE: "bg-red-50 text-red-700"
  })[m] || "bg-slate-100 text-slate-600";

const accessLabel = (a: ApiAccess) => ({ public: "Công khai", user: "Đăng nhập", admin: "Admin" })[a];
const accessClass = (a: ApiAccess) =>
  ({ public: "bg-slate-100 text-slate-600", user: "bg-indigo-50 text-indigo-700", admin: "bg-rose-50 text-rose-700" })[a];
</script>

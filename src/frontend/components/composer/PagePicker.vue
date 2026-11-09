<template>
  <div class="flex flex-col min-h-0">
    <!-- Search -->
    <div class="relative">
      <input
        ref="searchRef"
        v-model="query"
        type="text"
        placeholder="Tìm Fanpage... (Enter = chọn tất cả)"
        @keydown.enter.prevent="selectAllVisible"
        @keydown.esc="query = ''"
        class="w-full pl-8 pr-3 py-1.5 text-xs rounded-xl border border-slate-200 bg-slate-50/60 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400 transition"
      />
      <svg class="w-4 h-4 text-slate-400 absolute left-2.5 top-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
    </div>

    <!-- Quick actions -->
    <div class="flex items-center justify-between gap-2 py-2 text-[11px]">
      <span class="text-slate-500">
        <strong class="text-blue-700 font-bold">{{ modelValue.length }}</strong> / {{ pages.length }} trang
      </span>
      <div class="flex items-center gap-1.5 font-bold">
        <button type="button" @click="selectAllVisible" class="text-blue-600 hover:text-blue-700 hover:underline">
          {{ query ? `Chọn ${visiblePages.length} kết quả` : "Chọn tất cả" }}
        </button>
        <span class="text-slate-200">|</span>
        <button type="button" @click="clearSelection" :disabled="!modelValue.length" class="text-slate-400 hover:text-rose-600 disabled:opacity-40">
          Bỏ chọn
        </button>
        <span class="text-slate-200">|</span>
        <button
          type="button"
          @click="selectedOnly = !selectedOnly"
          class="px-1.5 py-0.5 rounded-md transition"
          :class="selectedOnly ? 'bg-blue-50 text-blue-700 font-bold border border-blue-200/80' : 'text-slate-500 hover:text-slate-700'"
        >
          Đã chọn
        </button>
      </div>
    </div>

    <!-- Saved groups -->
    <div class="flex flex-wrap items-center gap-1.5 pb-2">
      <span
        v-for="g in groups"
        :key="g.id"
        class="group inline-flex items-center gap-1 pl-2.5 pr-1.5 py-0.5 rounded-full border text-[11px] font-bold cursor-pointer transition shadow-2xs"
        :class="isGroupActive(g) ? 'bg-blue-600 border-blue-600 text-white' : 'bg-slate-50 border-slate-200 text-slate-600 hover:border-blue-400 hover:bg-blue-50/50 hover:text-blue-700'"
        :title="`${g.name}: ${g.pageIds.length} Fanpage. Bấm để chọn.`"
        @click="applyGroup(g)"
      >
        {{ g.name }} <span class="opacity-70 text-[10px]">({{ g.pageIds.length }})</span>
        <button
          type="button"
          @click.stop="deleteGroup(g.id)"
          class="w-3.5 h-3.5 rounded-full flex items-center justify-center opacity-60 hover:opacity-100 text-[12px]"
          title="Xóa nhóm này"
        >
          ×
        </button>
      </span>

      <template v-if="isNamingGroup">
        <input
          ref="groupNameRef"
          v-model="newGroupName"
          type="text"
          maxlength="30"
          placeholder="Tên nhóm..."
          @keydown.enter.prevent="saveGroup"
          @keydown.esc="isNamingGroup = false"
          class="w-28 px-2 py-0.5 text-[11px] rounded-full border border-blue-400 focus:outline-none"
        />
        <button type="button" @click="saveGroup" class="text-[11px] font-bold text-blue-600 hover:underline">Lưu</button>
        <button type="button" @click="isNamingGroup = false" class="text-[11px] text-slate-400">Hủy</button>
      </template>
      <button
        v-else-if="modelValue.length > 0"
        type="button"
        @click="startNamingGroup"
        class="inline-flex items-center px-2 py-0.5 rounded-full border border-dashed border-slate-300 text-[11px] text-slate-500 hover:border-blue-400 hover:text-blue-600 bg-white"
      >
        + Lưu nhóm
      </button>
    </div>

    <!-- Page list: click a row to toggle, Shift+click to select a range -->
    <div class="flex-1 overflow-y-auto space-y-1.5 pr-1 scrollbar-thin" :class="listClass">
      <div
        v-for="(page, idx) in visiblePages"
        :key="page.facebook_page_id"
        @click="onRowClick(page.facebook_page_id, idx, $event)"
        @mousedown.shift.prevent
        class="flex items-center justify-between gap-2.5 p-2 rounded-xl border cursor-pointer transition select-none"
        :class="isSelected(page.facebook_page_id) ? 'border-blue-300 bg-gradient-to-r from-blue-50/90 to-indigo-50/40 text-blue-900 shadow-2xs' : 'border-slate-100 bg-white hover:border-blue-200 hover:bg-blue-50/20'"
      >
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-8 h-8 rounded-full bg-slate-100 overflow-hidden flex-shrink-0 border border-slate-200 relative">
            <img v-if="page.avatar_url" :src="page.avatar_url" :alt="page.page_name" class="w-full h-full object-cover" />
            <span v-else class="w-full h-full flex items-center justify-center font-bold text-slate-500 text-[10px]">FB</span>
            <span class="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-blue-600 rounded-full flex items-center justify-center text-[8px] text-white font-bold">f</span>
          </div>
          <div class="min-w-0">
            <p class="text-xs font-bold text-slate-800 truncate" :class="{ 'text-blue-800': isSelected(page.facebook_page_id) }">{{ page.page_name }}</p>
            <p class="text-[10px] text-slate-400 truncate">{{ page.category || "Fanpage" }}</p>
          </div>
        </div>
        <span
          class="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 transition"
          :class="isSelected(page.facebook_page_id) ? 'bg-blue-600 text-white shadow-2xs' : 'border border-slate-300 text-transparent'"
        >
          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </span>
      </div>

      <p v-if="visiblePages.length === 0" class="text-center py-6 text-slate-400 text-xs">
        {{ pages.length === 0 ? "Chưa có Fanpage nào được liên kết." : selectedOnly ? "Chưa chọn Fanpage nào." : "Không tìm thấy Fanpage phù hợp." }}
      </p>
    </div>
    <p v-if="visiblePages.length > 1" class="pt-1.5 text-[10px] text-slate-400">Mẹo: Giữ phím Shift + click để chọn nhanh một dải Fanpage.</p>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { FacebookPageRecord } from "@shared/types";

interface PageGroup {
  id: string;
  name: string;
  pageIds: string[];
}

const props = defineProps<{
  modelValue: string[];
  pages: FacebookPageRecord[];
  /** Extra classes for the scrollable list (e.g. a max height inside a popover) */
  listClass?: string;
}>();
const emit = defineEmits<{ (e: "update:modelValue", value: string[]): void }>();

const query = ref("");
const selectedOnly = ref(false);
const searchRef = ref<HTMLInputElement | null>(null);
let lastClickedIndex = -1;

/** Lowercase, no Vietnamese accents: "Làm Đẹp" matches "lam dep" */
const normalize = (s: string) =>
  (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();

const selectedSet = computed(() => new Set(props.modelValue));
const isSelected = (id: string) => selectedSet.value.has(id);

const visiblePages = computed(() => {
  const q = normalize(query.value.trim());
  return props.pages.filter((p) => {
    if (selectedOnly.value && !selectedSet.value.has(p.facebook_page_id)) return false;
    if (!q) return true;
    return (
      normalize(p.page_name).includes(q) || normalize(p.category || "").includes(q) || p.facebook_page_id.includes(q)
    );
  });
});

watch([query, selectedOnly], () => {
  lastClickedIndex = -1;
});

/** Keeps the Page order of the list, so selections look the same everywhere */
const emitSelection = (ids: Set<string>) => {
  emit(
    "update:modelValue",
    props.pages.map((p) => p.facebook_page_id).filter((id) => ids.has(id))
  );
};

const togglePage = (id: string) => {
  const next = new Set(selectedSet.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  emitSelection(next);
};

const onRowClick = (id: string, index: number, event: MouseEvent) => {
  if (event.shiftKey && lastClickedIndex >= 0 && lastClickedIndex < visiblePages.value.length) {
    const start = Math.min(lastClickedIndex, index);
    const end = Math.max(lastClickedIndex, index);
    const next = new Set(selectedSet.value);
    for (let i = start; i <= end; i++) {
      const pageId = visiblePages.value[i]?.facebook_page_id;
      if (pageId) next.add(pageId);
    }
    emitSelection(next);
  } else {
    togglePage(id);
  }
  lastClickedIndex = index;
};

const selectAllVisible = () => {
  const next = new Set(selectedSet.value);
  for (const p of visiblePages.value) next.add(p.facebook_page_id);
  emitSelection(next);
};

const clearSelection = () => {
  emit("update:modelValue", []);
};

// Saved Page groups in localStorage
const STORAGE_KEY = "nnn_reels_saved_page_groups_v1";
const groups = ref<PageGroup[]>([]);
const isNamingGroup = ref(false);
const newGroupName = ref("");
const groupNameRef = ref<HTMLInputElement | null>(null);

const loadGroups = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) groups.value = JSON.parse(raw);
  } catch {}
};
loadGroups();

const saveGroupsToStorage = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(groups.value));
  } catch {}
};

const isGroupActive = (g: PageGroup) =>
  g.pageIds.length > 0 &&
  g.pageIds.length === selectedSet.value.size &&
  g.pageIds.every((id) => selectedSet.value.has(id));

const applyGroup = (g: PageGroup) => {
  const next = new Set(g.pageIds.filter((id) => props.pages.some((p) => p.facebook_page_id === id)));
  emitSelection(next);
};

const startNamingGroup = () => {
  if (props.modelValue.length === 0) return;
  newGroupName.value = `Nhóm ${groups.value.length + 1}`;
  isNamingGroup.value = true;
  nextTick(() => {
    groupNameRef.value?.focus();
    groupNameRef.value?.select();
  });
};

const saveGroup = () => {
  const name = newGroupName.value.trim();
  if (!name || props.modelValue.length === 0) {
    isNamingGroup.value = false;
    return;
  }
  groups.value.push({
    id: `grp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    pageIds: [...props.modelValue]
  });
  saveGroupsToStorage();
  isNamingGroup.value = false;
  newGroupName.value = "";
};

const deleteGroup = (id: string) => {
  groups.value = groups.value.filter((g) => g.id !== id);
  saveGroupsToStorage();
};
</script>

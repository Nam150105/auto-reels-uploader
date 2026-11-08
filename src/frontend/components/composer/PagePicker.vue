<template>
  <div class="flex flex-col min-h-0">
    <!-- Search -->
    <div class="relative">
      <input
        ref="searchRef"
        v-model="query"
        type="text"
        placeholder="Search Pages... (Enter = select all results)"
        @keydown.enter.prevent="selectAllVisible"
        @keydown.esc="query = ''"
        class="w-full pl-8 pr-3 py-1.5 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition"
      />
      <svg class="w-4 h-4 text-slate-400 absolute left-2.5 top-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
    </div>

    <!-- Quick actions -->
    <div class="flex items-center justify-between gap-2 py-2 text-[11px]">
      <span class="text-slate-500">
        <strong class="text-slate-800">{{ modelValue.length }}</strong> / {{ pages.length }} selected
      </span>
      <div class="flex items-center gap-2 font-semibold">
        <button type="button" @click="selectAllVisible" class="text-blue-600 hover:text-blue-700">
          {{ query ? `Select ${visiblePages.length} found` : "Select all" }}
        </button>
        <span class="text-slate-300">|</span>
        <button type="button" @click="clearSelection" :disabled="!modelValue.length" class="text-slate-500 hover:text-rose-600 disabled:opacity-40">
          Clear
        </button>
        <span class="text-slate-300">|</span>
        <button
          type="button"
          @click="selectedOnly = !selectedOnly"
          :class="selectedOnly ? 'text-blue-700 underline' : 'text-slate-500 hover:text-slate-700'"
        >
          Selected only
        </button>
      </div>
    </div>

    <!-- Saved groups -->
    <div class="flex flex-wrap items-center gap-1.5 pb-2">
      <span
        v-for="g in groups"
        :key="g.id"
        class="group inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full border text-[11px] font-semibold cursor-pointer transition"
        :class="isGroupActive(g) ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-200 text-slate-600 hover:border-blue-400'"
        :title="`${g.name}: ${g.pageIds.length} Pages. Click to select them.`"
        @click="applyGroup(g)"
      >
        {{ g.name }} <span class="opacity-70">({{ g.pageIds.length }})</span>
        <button
          type="button"
          @click.stop="deleteGroup(g.id)"
          class="w-4 h-4 rounded-full flex items-center justify-center opacity-60 hover:opacity-100"
          title="Delete group"
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
          placeholder="Group name"
          @keydown.enter.prevent="saveGroup"
          @keydown.esc="isNamingGroup = false"
          class="w-28 px-2 py-0.5 text-[11px] rounded-full border border-blue-400 focus:outline-none"
        />
        <button type="button" @click="saveGroup" class="text-[11px] font-semibold text-blue-600">Save</button>
        <button type="button" @click="isNamingGroup = false" class="text-[11px] text-slate-400">Cancel</button>
      </template>
      <button
        v-else-if="modelValue.length > 0"
        type="button"
        @click="startNamingGroup"
        class="inline-flex items-center px-2 py-0.5 rounded-full border border-dashed border-slate-300 text-[11px] text-slate-500 hover:border-blue-400 hover:text-blue-600"
      >
        + Save selection as group
      </button>
    </div>

    <!-- Page list: click a row to toggle, Shift+click to select a range -->
    <div class="flex-1 overflow-y-auto space-y-1 pr-1 scrollbar-thin" :class="listClass">
      <div
        v-for="(page, idx) in visiblePages"
        :key="page.facebook_page_id"
        @click="onRowClick(page.facebook_page_id, idx, $event)"
        @mousedown.shift.prevent
        class="flex items-center justify-between gap-2 p-2 rounded-xl border cursor-pointer transition select-none"
        :class="isSelected(page.facebook_page_id) ? 'border-blue-500 bg-blue-50/70' : 'border-transparent hover:bg-slate-50'"
      >
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-8 h-8 rounded-full bg-slate-200 overflow-hidden flex-shrink-0 border border-slate-200">
            <img v-if="page.avatar_url" :src="page.avatar_url" :alt="page.page_name" class="w-full h-full object-cover" />
            <span v-else class="w-full h-full flex items-center justify-center font-bold text-slate-500 text-[10px]">FB</span>
          </div>
          <div class="min-w-0">
            <p class="text-xs font-semibold text-slate-800 truncate">{{ page.page_name }}</p>
            <p class="text-[10px] text-slate-400 truncate">{{ page.category || "Facebook Page" }}</p>
          </div>
        </div>
        <span
          class="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 transition"
          :class="isSelected(page.facebook_page_id) ? 'bg-blue-600 text-white' : 'border border-slate-300 text-transparent'"
        >
          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </span>
      </div>

      <p v-if="visiblePages.length === 0" class="text-center py-6 text-slate-400 text-xs">
        {{ pages.length === 0 ? "No Pages connected yet." : selectedOnly ? "No Page selected yet." : "No Page matches your search." }}
      </p>
    </div>
    <p v-if="visiblePages.length > 1" class="pt-1.5 text-[10px] text-slate-400">Tip: Shift + click selects every Page in between.</p>
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
    .replace(/[̀-ͯ]/g, "")
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

const onRowClick = (id: string, idx: number, e: MouseEvent) => {
  const next = new Set(props.modelValue);
  if (e.shiftKey && lastClickedIndex >= 0 && lastClickedIndex < visiblePages.value.length) {
    // Range: every Page between the last click and this one takes the new state of this Page
    const makeSelected = !next.has(id);
    const [a, b] = lastClickedIndex < idx ? [lastClickedIndex, idx] : [idx, lastClickedIndex];
    for (const p of visiblePages.value.slice(a, b + 1)) {
      if (makeSelected) next.add(p.facebook_page_id);
      else next.delete(p.facebook_page_id);
    }
  } else if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  lastClickedIndex = idx;
  emitSelection(next);
};

const selectAllVisible = () => {
  const next = new Set(props.modelValue);
  for (const p of visiblePages.value) next.add(p.facebook_page_id);
  emitSelection(next);
};

const clearSelection = () => {
  emitSelection(new Set());
  selectedOnly.value = false;
};

// ---- Saved groups (kept in this browser) ----
const GROUPS_KEY = "nnn_page_groups_v1";
const loadGroups = (): PageGroup[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(GROUPS_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((g) => g && g.name && Array.isArray(g.pageIds)) : [];
  } catch {
    return [];
  }
};
const groups = ref<PageGroup[]>(loadGroups());
const persistGroups = () => {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(groups.value));
  } catch {
    // Storage blocked: groups stay for this session only
  }
};

const isNamingGroup = ref(false);
const newGroupName = ref("");
const groupNameRef = ref<HTMLInputElement | null>(null);

const startNamingGroup = async () => {
  newGroupName.value = "";
  isNamingGroup.value = true;
  await nextTick();
  groupNameRef.value?.focus();
};

const saveGroup = () => {
  const name = newGroupName.value.trim();
  if (!name || props.modelValue.length === 0) return;
  const existing = groups.value.find((g) => g.name.toLowerCase() === name.toLowerCase());
  if (existing) existing.pageIds = [...props.modelValue];
  else groups.value.push({ id: `g_${Date.now()}`, name, pageIds: [...props.modelValue] });
  persistGroups();
  isNamingGroup.value = false;
};

const deleteGroup = (id: string) => {
  groups.value = groups.value.filter((g) => g.id !== id);
  persistGroups();
};

/** Only Pages that are still connected are applied */
const groupIds = (g: PageGroup) => {
  const known = new Set(props.pages.map((p) => p.facebook_page_id));
  return g.pageIds.filter((id) => known.has(id));
};

const applyGroup = (g: PageGroup) => {
  emitSelection(new Set(groupIds(g)));
};

const isGroupActive = (g: PageGroup) => {
  const ids = groupIds(g);
  return ids.length > 0 && ids.length === props.modelValue.length && ids.every((id) => selectedSet.value.has(id));
};

defineExpose({ focusSearch: () => searchRef.value?.focus() });
</script>

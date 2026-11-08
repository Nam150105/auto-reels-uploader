<template>
  <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" @click.self="close">
    <div class="bg-white rounded-2xl shadow-2xl border border-slate-100 max-w-xl w-full p-6 max-h-[90vh] flex flex-col select-none">
      <!-- Header -->
      <div class="flex items-center justify-between pb-3 border-b border-slate-100">
        <div class="flex items-center gap-2">
          <svg class="w-5 h-5 text-slate-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <h3 class="text-base font-bold text-slate-800">Auto-comments</h3>
        </div>
        <button type="button" @click="close" class="text-slate-400 hover:text-slate-600 p-1 rounded-lg transition">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <p class="text-xs text-slate-500 py-3 leading-relaxed">
        After the Reel is published, each comment below is posted by the Page at its own time.
      </p>

      <div class="flex-1 overflow-y-auto pr-1 scrollbar-thin">
        <CommentListEditor v-model="items" />
      </div>

      <div class="flex items-center justify-end gap-2 pt-3 mt-3 border-t border-slate-100 text-xs">
        <button
          type="button"
          @click="close"
          class="px-4 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 font-medium transition"
        >
          Cancel
        </button>
        <button
          type="button"
          :disabled="isBusy"
          @click="save"
          class="px-5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold shadow-sm transition"
        >
          {{ isBusy ? "Uploading..." : "Save" }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ComposerComment } from "@shared/types";
import CommentListEditor from "../composer/CommentListEditor.vue";
import { createEmptyComment, validateComments } from "../../utils/comments";
import { useToast } from "../../composables/useToast";

const props = defineProps<{
  isOpen: boolean;
  initialComments: ComposerComment[];
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "save", value: ComposerComment[]): void;
}>();

const toast = useToast();
const items = ref<ComposerComment[]>([]);
const isBusy = computed(() => items.value.some((c) => c.isUploading));

watch(
  () => props.isOpen,
  (open) => {
    if (open) {
      // Edit a copy so "Cancel" keeps the row unchanged
      items.value = props.initialComments.length
        ? props.initialComments.map((c) => ({ ...c }))
        : [createEmptyComment()];
    }
  }
);

const close = () => emit("close");

const save = () => {
  const err = validateComments(items.value);
  if (err) {
    toast.warning(err);
    return;
  }
  emit(
    "save",
    items.value.filter((c) => c.text.trim() || c.imageMediaId)
  );
  emit("close");
};
</script>

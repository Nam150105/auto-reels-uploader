<template>
  <div class="space-y-2">
    <div
      v-for="(item, idx) in modelValue"
      :key="item.id"
      class="rounded-xl border border-slate-200 bg-white p-2.5 space-y-2"
    >
      <div class="flex items-start gap-2">
        <span class="mt-1.5 w-5 h-5 rounded-full bg-blue-50 text-blue-600 text-[10px] font-bold flex items-center justify-center flex-shrink-0">
          {{ idx + 1 }}
        </span>
        <textarea
          v-model="item.text"
          rows="2"
          :placeholder="idx === 0 ? 'Write a comment (e.g. a product link or contact info)...' : 'Write another comment...'"
          class="flex-1 px-3 py-1.5 text-xs rounded-lg border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 resize-none"
        ></textarea>
        <button
          type="button"
          @click="removeAt(idx)"
          class="mt-1 p-1 text-slate-400 hover:text-rose-500 rounded transition"
          title="Remove comment"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>

      <div class="flex flex-wrap items-center gap-2 pl-7">
        <!-- Image attachment -->
        <div v-if="item.imagePreviewUrl || item.isUploading || item.imageMediaId" class="relative">
          <img
            v-if="item.imagePreviewUrl"
            :src="item.imagePreviewUrl"
            alt="Comment image"
            class="w-12 h-12 rounded-lg object-cover border border-slate-200"
            :class="{ 'opacity-50': item.isUploading }"
          />
          <span v-if="item.isUploading" class="absolute inset-0 flex items-center justify-center">
            <svg class="animate-spin w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
            </svg>
          </span>
          <button
            v-if="!item.isUploading"
            type="button"
            @click="clearImage(item)"
            class="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-slate-700 text-white text-[10px] leading-none flex items-center justify-center"
            title="Remove image"
          >
            ×
          </button>
        </div>
        <label
          v-else
          class="flex items-center gap-1 px-2 py-1 rounded-lg border border-dashed border-slate-300 text-[11px] text-slate-500 hover:border-blue-500 hover:text-blue-600 cursor-pointer transition"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span>Add photo</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            class="hidden"
            @change="(e) => onImagePicked(item, e)"
          />
        </label>

        <!-- Timing -->
        <select
          v-model.number="item.delayMinutes"
          class="px-2 py-1 text-[11px] rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 text-slate-700"
        >
          <option v-for="opt in COMMENT_DELAY_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>

        <span v-if="item.uploadError" class="text-[11px] text-rose-600">{{ item.uploadError }}</span>
      </div>
    </div>

    <button
      v-if="modelValue.length < MAX_COMMENTS"
      type="button"
      @click="addComment"
      class="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700 transition px-1 py-1"
    >
      <span class="text-base leading-none">+</span>
      <span>{{ modelValue.length === 0 ? "Add a comment" : "Add another comment" }}</span>
    </button>
    <p v-else class="text-[11px] text-slate-400">Maximum {{ MAX_COMMENTS }} comments per post.</p>
    <p class="text-[11px] text-slate-400">
      Photos: JPG, PNG, GIF or WEBP up to 8 MB. Facebook does not allow videos in comments.
    </p>
  </div>
</template>

<script setup lang="ts">
import type { ComposerComment } from "@shared/types";
import { api } from "../../services/api";
import { COMMENT_DELAY_OPTIONS, MAX_COMMENTS, createEmptyComment } from "../../utils/comments";

const props = defineProps<{ modelValue: ComposerComment[] }>();
const emit = defineEmits<{ (e: "update:modelValue", value: ComposerComment[]): void }>();

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const uploadTokens = new WeakMap<ComposerComment, number>();

const addComment = () => {
  if (props.modelValue.length >= MAX_COMMENTS) return;
  const last = props.modelValue[props.modelValue.length - 1];
  emit("update:modelValue", [...props.modelValue, createEmptyComment(last ? last.delayMinutes : 0)]);
};

const removeAt = (idx: number) => {
  const item = props.modelValue[idx];
  if (item) clearImage(item);
  emit(
    "update:modelValue",
    props.modelValue.filter((_, i) => i !== idx)
  );
};

const clearImage = (item: ComposerComment) => {
  uploadTokens.set(item, (uploadTokens.get(item) || 0) + 1);
  // The preview URL is not revoked here: a copy of this comment (e.g. in the comments dialog) may still show it
  item.imagePreviewUrl = "";
  item.imageMediaId = "";
  item.imageName = "";
  item.isUploading = false;
  item.uploadError = "";
};

const onImagePicked = async (item: ComposerComment, e: Event) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;

  if (!/^image\/(jpeg|png|gif|webp)$/.test(file.type)) {
    item.uploadError = "Please choose a JPG, PNG, GIF or WEBP image.";
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    item.uploadError = "Image is too large. The maximum size is 8 MB.";
    return;
  }

  clearImage(item);
  const token = (uploadTokens.get(item) || 0) + 1;
  uploadTokens.set(item, token);
  item.imagePreviewUrl = URL.createObjectURL(file);
  item.imageName = file.name;
  item.isUploading = true;
  try {
    const res = await api.uploadCommentImage(file);
    if (uploadTokens.get(item) !== token) return;
    item.imageMediaId = res.media_id;
  } catch (err: any) {
    if (uploadTokens.get(item) !== token) return;
    item.uploadError = err?.message || "Image upload failed. Please try again.";
    if (item.imagePreviewUrl) URL.revokeObjectURL(item.imagePreviewUrl);
    item.imagePreviewUrl = "";
  } finally {
    if (uploadTokens.get(item) === token) item.isUploading = false;
  }
};
</script>

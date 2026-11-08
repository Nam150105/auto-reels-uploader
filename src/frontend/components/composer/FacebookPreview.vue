<template>
  <div class="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm select-none">
    <div class="flex items-center justify-between pb-3 mb-3 border-b border-slate-100">
      <span class="text-xs font-semibold text-slate-500">Facebook preview</span>
      <span class="inline-flex items-center gap-1 text-[10px] font-bold bg-slate-900 text-white px-2 py-0.5 rounded-full">
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        Reels
      </span>
    </div>

    <!-- Reel frame 9:16 -->
    <div class="relative mx-auto w-full max-w-[270px] aspect-[9/16] rounded-[22px] overflow-hidden bg-black shadow-lg ring-1 ring-black/10">
      <video
        v-if="mediaPreviewUrl"
        ref="videoRef"
        :src="mediaPreviewUrl"
        class="absolute inset-0 w-full h-full object-cover"
        autoplay
        loop
        playsinline
        :muted="isMuted"
        @click="togglePlay"
        @play="isPlaying = true"
        @pause="isPlaying = false"
        @timeupdate="onTimeUpdate"
      ></video>
      <div
        v-else
        class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-b from-slate-800 to-slate-950 text-slate-400"
      >
        <svg class="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
        <span class="text-[11px]">Choose a video to preview</span>
      </div>

      <!-- Top bar -->
      <div class="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/60 to-transparent pointer-events-none"></div>
      <div class="absolute top-2.5 inset-x-3 flex items-center justify-between text-white">
        <span class="text-[15px] font-bold tracking-tight drop-shadow">Reels</span>
        <div class="flex items-center gap-2.5">
          <button
            v-if="mediaPreviewUrl"
            type="button"
            @click.stop="isMuted = !isMuted"
            class="w-6 h-6 rounded-full bg-black/30 flex items-center justify-center"
            :title="isMuted ? 'Unmute' : 'Mute'"
          >
            <svg v-if="isMuted" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
            </svg>
            <svg v-else class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
            </svg>
          </button>
          <svg class="w-5 h-5 drop-shadow" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
            <circle cx="12" cy="13" r="3" stroke-width="2" />
          </svg>
        </div>
      </div>

      <!-- Paused indicator -->
      <div
        v-if="mediaPreviewUrl && !isPlaying"
        class="absolute inset-0 flex items-center justify-center pointer-events-none"
      >
        <div class="w-14 h-14 rounded-full bg-black/40 flex items-center justify-center">
          <svg class="w-7 h-7 text-white ml-1" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        </div>
      </div>

      <!-- Bottom gradient -->
      <div class="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/80 via-black/30 to-transparent pointer-events-none"></div>

      <!-- Right action rail -->
      <div class="absolute right-2 bottom-14 flex flex-col items-center gap-3.5 text-white">
        <div class="flex flex-col items-center gap-0.5">
          <svg class="w-6 h-6 drop-shadow" viewBox="0 0 24 24" fill="currentColor">
            <path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z" />
          </svg>
          <span class="text-[10px] font-semibold drop-shadow">Like</span>
        </div>
        <div class="flex flex-col items-center gap-0.5">
          <svg class="w-6 h-6 drop-shadow" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.03 2 11c0 2.62 1.25 4.97 3.24 6.6L4.5 22l4.3-2.33c1 .27 2.07.42 3.2.42 5.52 0 10-4.03 10-9S17.52 2 12 2z" />
          </svg>
          <span class="text-[10px] font-semibold drop-shadow">{{ visibleComments.length }}</span>
        </div>
        <div class="flex flex-col items-center gap-0.5">
          <svg class="w-6 h-6 drop-shadow" viewBox="0 0 24 24" fill="currentColor">
            <path d="M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z" />
          </svg>
          <span class="text-[10px] font-semibold drop-shadow">Share</span>
        </div>
        <svg class="w-5 h-5 drop-shadow" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
        </svg>
        <div class="w-7 h-7 rounded-md overflow-hidden border-2 border-white/80 bg-slate-600">
          <img v-if="pageAvatar" :src="pageAvatar" alt="" class="w-full h-full object-cover" />
        </div>
      </div>

      <!-- Bottom-left: page, caption, audio -->
      <div class="absolute left-3 right-12 bottom-4 text-white space-y-1.5">
        <div class="flex items-center gap-2 min-w-0">
          <div class="w-8 h-8 rounded-full overflow-hidden flex-shrink-0 ring-1 ring-white/70 bg-slate-500">
            <img v-if="pageAvatar" :src="pageAvatar" :alt="pageName" class="w-full h-full object-cover" />
            <span v-else class="w-full h-full flex items-center justify-center text-[10px] font-bold">{{ pageInitial }}</span>
          </div>
          <span class="text-[13px] font-semibold truncate drop-shadow">{{ pageName }}</span>
          <span class="text-[11px] text-white/80">·</span>
          <span class="text-[11px] font-semibold border border-white/80 rounded-md px-1.5 py-px flex-shrink-0">Follow</span>
        </div>

        <p
          v-if="caption && caption.trim()"
          class="text-[12px] leading-snug drop-shadow whitespace-pre-line break-words"
          :class="captionExpanded ? 'max-h-32 overflow-y-auto pr-1' : 'line-clamp-2'"
        >
          <template v-for="(part, i) in captionParts" :key="i">
            <span :class="part.tag ? 'font-semibold' : ''">{{ part.text }}</span>
          </template>
        </p>
        <button
          v-if="caption && caption.length > 80"
          type="button"
          @click="captionExpanded = !captionExpanded"
          class="text-[11px] font-semibold text-white/80"
        >
          {{ captionExpanded ? 'See less' : 'See more' }}
        </button>

        <div class="flex items-center gap-1.5 text-[11px] text-white/90 min-w-0">
          <svg class="w-3 h-3 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z" />
          </svg>
          <span class="truncate">{{ pageName }} · Original audio</span>
        </div>
      </div>

      <!-- Progress -->
      <div v-if="mediaPreviewUrl" class="absolute inset-x-0 bottom-0 h-[3px] bg-white/25">
        <div class="h-full bg-white" :style="{ width: `${progress}%` }"></div>
      </div>
    </div>

    <!-- Auto-comments -->
    <div v-if="visibleComments.length" class="mt-3 max-w-[270px] mx-auto space-y-2">
      <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400">Comments</p>
      <div v-for="(c, i) in visibleComments" :key="c.id" class="flex items-start gap-2">
        <div class="w-7 h-7 rounded-full overflow-hidden flex-shrink-0 bg-slate-200">
          <img v-if="pageAvatar" :src="pageAvatar" alt="" class="w-full h-full object-cover" />
        </div>
        <div class="min-w-0">
          <div class="bg-slate-100 rounded-2xl px-3 py-2">
            <div class="flex items-center gap-1.5">
              <span class="text-[12px] font-semibold text-slate-900 truncate">{{ pageName }}</span>
              <span class="text-[9px] font-semibold text-blue-700 bg-blue-50 px-1.5 rounded">Author</span>
            </div>
            <p v-if="c.text.trim()" class="text-[12px] text-slate-800 whitespace-pre-line break-words">{{ c.text }}</p>
          </div>
          <img
            v-if="c.imagePreviewUrl"
            :src="c.imagePreviewUrl"
            alt="Comment photo"
            class="mt-1 max-h-32 rounded-xl border border-slate-200 object-cover"
          />
          <p class="text-[10px] text-slate-400 mt-0.5 pl-1">{{ delayLabel(c.delayMinutes) }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ComposerComment, FacebookPageRecord } from "@shared/types";
import { delayLabel } from "../../utils/comments";

const props = defineProps<{
  selectedPage?: FacebookPageRecord;
  caption: string;
  mediaPreviewUrl?: string;
  comments?: ComposerComment[];
}>();

const videoRef = ref<HTMLVideoElement | null>(null);
const isPlaying = ref(false);
const isMuted = ref(true);
const progress = ref(0);
const captionExpanded = ref(false);

const pageName = computed(() => props.selectedPage?.page_name || "Your Page");
const pageAvatar = computed(() => props.selectedPage?.avatar_url || "");
const pageInitial = computed(() => (pageName.value.trim()[0] || "F").toUpperCase());
const visibleComments = computed(() => props.comments || []);

// Bold hashtags like Facebook does (no v-html)
const captionParts = computed(() =>
  (props.caption || "")
    .split(/(#[\p{L}\p{N}_]+)/u)
    .filter((t) => t.length > 0)
    .map((text) => ({ text, tag: text.startsWith("#") }))
);

watch(
  () => props.mediaPreviewUrl,
  () => {
    progress.value = 0;
    isPlaying.value = false;
  }
);

const togglePlay = () => {
  const v = videoRef.value;
  if (!v) return;
  if (v.paused) v.play().catch(() => {});
  else v.pause();
};

const onTimeUpdate = () => {
  const v = videoRef.value;
  if (!v || !v.duration) return;
  progress.value = (v.currentTime / v.duration) * 100;
};
</script>

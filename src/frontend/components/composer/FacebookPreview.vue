<template>
  <div class="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm select-none">
    <div class="flex items-center justify-between pb-3 border-b border-slate-100 mb-3 text-xs text-slate-500 font-semibold">
      <span>Xem trước bài đăng Facebook</span>
      <span class="text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">Reels / Video</span>
    </div>

    <!-- Facebook Post Card Container -->
    <div class="border border-slate-200 rounded-xl overflow-hidden bg-white shadow-xs max-w-sm mx-auto">
      <!-- Post Header: Avatar, Name, Timestamp, Public Icon -->
      <div class="p-3 flex items-center gap-2.5">
        <div class="w-10 h-10 rounded-full bg-slate-200 overflow-hidden flex-shrink-0 border border-slate-100">
          <img
            v-if="selectedPage?.avatar_url"
            :src="selectedPage.avatar_url"
            :alt="selectedPage.page_name"
            class="w-full h-full object-cover"
          />
          <div v-else class="w-full h-full flex items-center justify-center font-bold text-slate-500 text-xs">
            FB
          </div>
        </div>

        <div class="flex-1 min-w-0">
          <h4 class="font-bold text-xs text-slate-900 truncate">
            {{ selectedPage?.page_name || 'Tên Fanpage của bạn' }}
          </h4>
          <div class="flex items-center gap-1 text-[11px] text-slate-500">
            <span>Vừa xong</span>
            <span>&bull;</span>
            <svg class="w-3 h-3 text-slate-400" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
            </svg>
          </div>
        </div>

        <button type="button" class="text-slate-400 hover:text-slate-600 p-1">
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
          </svg>
        </button>
      </div>

      <!-- Caption Text -->
      <div class="px-3 pb-2 text-xs text-slate-800 whitespace-pre-line leading-relaxed">
        <p v-if="caption && caption.trim()">{{ caption }}</p>
        <p v-else class="text-slate-400 italic">Nội dung bài viết sẽ xuất hiện ở đây...</p>
      </div>

      <!-- Video / Media Container -->
      <div class="bg-black aspect-[9/16] max-h-[360px] flex items-center justify-center relative overflow-hidden group">
        <video
          v-if="mediaPreviewUrl"
          :src="mediaPreviewUrl"
          controls
          class="w-full h-full object-contain"
        ></video>
        <div v-else class="text-center p-6 text-slate-500 flex flex-col items-center gap-2">
          <svg class="w-12 h-12 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span class="text-xs">Chưa có video được chọn</span>
        </div>
      </div>

      <!-- Social Interactions Bar -->
      <div class="p-2 border-t border-slate-100 flex items-center justify-around text-slate-600 text-xs font-semibold">
        <div class="flex items-center gap-1.5 hover:text-blue-600 transition cursor-pointer py-1">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5" />
          </svg>
          <span>Thích</span>
        </div>
        <div class="flex items-center gap-1.5 hover:text-blue-600 transition cursor-pointer py-1">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <span>Bình luận</span>
        </div>
        <div class="flex items-center gap-1.5 hover:text-blue-600 transition cursor-pointer py-1">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
          </svg>
          <span>Chia sẻ</span>
        </div>
      </div>

      <!-- First Comment Preview (If enabled) -->
      <div v-if="enableComment && commentText && commentText.trim()" class="p-3 bg-slate-50 border-t border-slate-100 flex items-start gap-2">
        <div class="w-6 h-6 rounded-full bg-slate-200 overflow-hidden flex-shrink-0">
          <img
            v-if="selectedPage?.avatar_url"
            :src="selectedPage.avatar_url"
            :alt="selectedPage.page_name"
            class="w-full h-full object-cover"
          />
        </div>
        <div class="flex-1 bg-white p-2 rounded-xl border border-slate-200 text-[11px]">
          <span class="font-bold text-slate-900 block">{{ selectedPage?.page_name || 'Fanpage' }}</span>
          <p class="text-slate-700 whitespace-pre-line mt-0.5">{{ commentText }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { FacebookPageRecord } from "@shared/types";

defineProps<{
  selectedPage?: FacebookPageRecord;
  caption: string;
  mediaPreviewUrl?: string;
  enableComment?: boolean;
  commentText?: string;
}>();
</script>

<template>
  <div class="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
    <transition-group name="modal">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="pointer-events-auto p-4 rounded-xl shadow-lg border text-sm flex items-start gap-3 backdrop-blur-md bg-white/95 transition-all"
        :class="{
          'border-emerald-200 text-emerald-900 bg-emerald-50/95': toast.type === 'success',
          'border-rose-200 text-rose-900 bg-rose-50/95': toast.type === 'error',
          'border-amber-200 text-amber-900 bg-amber-50/95': toast.type === 'warning',
          'border-blue-200 text-blue-900 bg-blue-50/95': toast.type === 'info'
        }"
      >
        <!-- Icon -->
        <div class="flex-shrink-0 mt-0.5">
          <svg v-if="toast.type === 'success'" class="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
          <svg v-else-if="toast.type === 'error'" class="w-5 h-5 text-rose-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
          <svg v-else-if="toast.type === 'warning'" class="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <svg v-else class="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>

        <!-- Content -->
        <div class="flex-1 min-w-0">
          <p v-if="toast.title" class="font-semibold text-xs mb-0.5">{{ toast.title }}</p>
          <p class="leading-relaxed">{{ toast.message }}</p>
        </div>

        <!-- Close button -->
        <button
          @click="remove(toast.id)"
          class="flex-shrink-0 text-slate-400 hover:text-slate-600 p-0.5 rounded transition"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </transition-group>
  </div>
</template>

<script setup lang="ts">
import { useToast } from "../../composables/useToast";

const { toasts, remove } = useToast();
</script>

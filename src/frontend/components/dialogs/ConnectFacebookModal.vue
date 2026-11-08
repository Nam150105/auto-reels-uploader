<template>
  <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" @click.self="$emit('close')">
    <div class="bg-white rounded-2xl shadow-2xl border border-slate-100 max-w-lg w-full p-6 animate-in fade-in zoom-in duration-150 select-none max-h-[92vh] overflow-y-auto">
      <!-- Header -->
      <div class="flex items-center justify-between pb-3.5 border-b border-slate-100 mb-5">
        <div>
          <h3 class="text-base font-bold text-slate-800">
            {{ targetAccountId ? "Reconnect Facebook account" : "Connect a Facebook account" }}
          </h3>
          <p class="text-[11px] text-slate-400">All Pages managed by the account are synced automatically.</p>
        </div>
        <button type="button" @click="$emit('close')" class="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg transition text-lg font-bold">
          &times;
        </button>
      </div>

      <!-- First time: get invited as a tester -->
      <div v-if="!targetAccountId" class="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-200 text-[11px] text-amber-900">
        <p class="font-bold mb-1.5">First time connecting? Do this first:</p>
        <div class="flex items-start gap-3">
          <ol class="flex-1 list-decimal pl-4 space-y-1.5 leading-relaxed">
            <li>
              Contact the admin on Telegram
              <a :href="ADMIN_TELEGRAM_URL" target="_blank" rel="noopener noreferrer" class="font-semibold underline">@NAM_NANG_NO</a>
              and send your Facebook profile link to be invited as a tester.
            </li>
            <li>
              Accept the invitation in
              <a :href="ACCEPT_INVITE_URL" target="_blank" rel="noopener noreferrer" class="font-semibold underline">Facebook Settings → Apps and websites</a>.
            </li>
            <li>Come back here and click <b>Continue with Facebook</b>.</li>
          </ol>
          <a :href="ADMIN_TELEGRAM_URL" target="_blank" rel="noopener noreferrer" class="flex-shrink-0" title="Scan to open Telegram">
            <img :src="telegramQr" alt="Telegram QR code for @NAM_NANG_NO" class="w-20 h-20 rounded-lg border border-amber-200 bg-white object-contain" />
          </a>
        </div>
      </div>

      <!-- Main option: Facebook login -->
      <div class="space-y-3 text-xs">
        <button
          type="button"
          :disabled="isOAuthRunning"
          @click="startFacebookLogin"
          class="w-full flex items-center justify-center gap-2.5 px-4 py-3 rounded-xl bg-[#1877F2] hover:bg-[#166FE5] disabled:opacity-60 text-white font-bold text-sm shadow-md transition"
        >
          <svg v-if="!isOAuthRunning" class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
          </svg>
          <svg v-else class="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
          </svg>
          <span>{{ isOAuthRunning ? "Waiting for Facebook..." : "Continue with Facebook" }}</span>
        </button>

        <ol class="list-decimal pl-5 space-y-1 text-[11px] text-slate-600 leading-relaxed">
          <li>A Facebook window opens. Log in with the account that manages your Pages.</li>
          <li>Choose <b>all Pages</b> (and Businesses) you want to use, then keep every permission switched on.</li>
          <li>Confirm. The window closes and your Pages appear here automatically.</li>
        </ol>

        <p class="text-[11px] text-slate-500">
          Facebook shows an error or no Page? Make sure you accepted the tester invitation
          (<a :href="ACCEPT_INVITE_URL" target="_blank" rel="noopener noreferrer" class="underline">Apps and websites</a>),
          or contact <a :href="ADMIN_TELEGRAM_URL" target="_blank" rel="noopener noreferrer" class="underline">@NAM_NANG_NO</a>.
        </p>
      </div>

      <!-- Advanced: manual token -->
      <details class="mt-5 group text-xs" :open="showManual">
        <summary class="cursor-pointer select-none text-[11px] font-semibold text-slate-500 hover:text-slate-700 list-none flex items-center gap-1">
          <span class="transition group-open:rotate-90">›</span>
          Advanced: paste an access token instead
        </summary>

        <div class="mt-3 space-y-3">
          <ol class="list-decimal pl-5 space-y-1 text-[11px] text-slate-600 leading-relaxed">
            <li>
              Open
              <a href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noopener noreferrer" class="text-blue-600 underline font-semibold">Graph API Explorer</a>
              and select the app <b class="font-mono">1469615908436980</b>.
            </li>
            <li>
              Add the permissions
              <span class="font-mono text-blue-800">pages_show_list, pages_read_engagement, pages_manage_posts, pages_manage_engagement, read_insights, business_management</span>.
            </li>
            <li>Click <b>Generate Access Token</b> and paste it below.</li>
          </ol>
          <textarea
            v-model="tokenInput"
            name="directAccessToken"
            id="directAccessToken"
            rows="3"
            placeholder="Paste your EAA... token here"
            class="w-full px-3 py-2 text-xs font-mono rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition select-all"
          ></textarea>
          <div class="flex justify-end">
            <button
              type="button"
              :disabled="!tokenInput.trim() || isSubmitting"
              @click="submitToken"
              class="px-4 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-700 font-semibold text-xs transition flex items-center gap-2"
            >
              <svg v-if="isSubmitting" class="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
              </svg>
              <span>{{ isSubmitting ? "Syncing..." : targetAccountId ? "Update token" : "Connect with token" }}</span>
            </button>
          </div>
        </div>
      </details>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { usePages } from "../../composables/usePages";
import telegramQr from "../../assets/telegram-admin-qr.png";

const ADMIN_TELEGRAM_URL = "https://t.me/NAM_NANG_NO";
/** Where a Facebook user accepts the tester invitation of the app */
const ACCEPT_INVITE_URL = "https://www.facebook.com/settings/?tab=applications";

const props = defineProps<{
  isOpen: boolean;
  targetAccountId?: string | null;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

const { connectWithToken, connectWithFacebook } = usePages();

const tokenInput = ref("");
const isSubmitting = ref(false);
const isOAuthRunning = ref(false);
const showManual = ref(false);

watch(
  () => props.isOpen,
  (open) => {
    if (open) {
      isOAuthRunning.value = false;
      showManual.value = false;
    }
  }
);

const startFacebookLogin = async () => {
  isOAuthRunning.value = true;
  try {
    const ok = await connectWithFacebook(props.targetAccountId || null);
    if (ok) emit("close");
  } finally {
    isOAuthRunning.value = false;
  }
};

const submitToken = async () => {
  if (!tokenInput.value.trim()) return;
  isSubmitting.value = true;
  try {
    const ok = await connectWithToken(tokenInput.value.trim(), props.targetAccountId || null);
    if (ok) {
      tokenInput.value = "";
      emit("close");
    }
  } finally {
    isSubmitting.value = false;
  }
};
</script>

import { ref, computed } from "vue";
import { api } from "../services/api";
import type { FacebookPageRecord, FacebookAccount } from "@shared/types";
import { useToast } from "./useToast";

const pages = ref<FacebookPageRecord[]>([]);
const accounts = ref<FacebookAccount[]>([]);
const isLoading = ref<boolean>(false);
const searchQuery = ref<string>("");
const isConnectModalOpen = ref<boolean>(false);
const isAccountsModalOpen = ref<boolean>(false);
const connectTargetAccountId = ref<string | null>(null);

export function usePages() {
  const toast = useToast();

  const loadPages = async () => {
    isLoading.value = true;
    try {
      const [pagesRes, accountsRes] = await Promise.all([
        api.getPages().catch((err) => {
          console.warn("getPages fallback to empty array:", err);
          return [];
        }),
        api.getAccounts().catch((err) => {
          console.warn("getAccounts fallback to empty array:", err);
          return [];
        })
      ]);
      pages.value = Array.isArray(pagesRes) ? pagesRes : ((pagesRes as any)?.pages || []);
      accounts.value = Array.isArray(accountsRes) ? accountsRes : ((accountsRes as any)?.accounts || []);
    } catch (err: any) {
      toast.error(err?.message || "Couldn't load Pages.");
    } finally {
      isLoading.value = false;
    }
  };

  const expiredAccounts = computed(() => {
    return accounts.value.filter(
      (a) => a.token_status === "expired" || a.token_status === "revoked" || a.token_status === "invalid"
    );
  });

  const expiredAccountNames = computed(() => {
    return expiredAccounts.value.map((a) => a.facebook_user_name || a.facebook_user_id).join(", ");
  });

  const filteredPages = computed(() => {
    const q = searchQuery.value.trim().toLowerCase();
    if (!q) return pages.value;
    return pages.value.filter(
      (p) =>
        (p.page_name || "").toLowerCase().includes(q) ||
        (p.facebook_page_id || "").includes(q) ||
        (p.category || "").toLowerCase().includes(q)
    );
  });

  const syncPages = async () => {
    isLoading.value = true;
    try {
      await api.syncPages();
      await loadPages();
      toast.success("Pages re-synced from Facebook.");
    } catch (err: any) {
      toast.error(err?.message || "Failed to sync Pages.");
    } finally {
      isLoading.value = false;
    }
  };

  const openConnectModal = (accountId: string | null = null) => {
    connectTargetAccountId.value = accountId;
    isConnectModalOpen.value = true;
  };

  /**
   * Facebook login: opens the Facebook dialog in a popup. The user approves, the server exchanges the code
   * for a long-lived token, syncs the Pages, and the callback page reports back here (postMessage).
   * If popups are blocked, the whole page goes to Facebook and comes back with ?oauth_status=...
   */
  const connectWithFacebook = (targetAccountId: string | null = null): Promise<boolean> => {
    const url = `/api/meta/login${targetAccountId ? `?reconnect_account_id=${encodeURIComponent(targetAccountId)}` : ""}`;
    const w = 600;
    const h = 720;
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - w) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - h) / 2));
    const popup = window.open(url, "fb_oauth", `width=${w},height=${h},left=${left},top=${top}`);
    if (!popup) {
      window.location.href = url;
      return Promise.resolve(false);
    }
    popup.focus();

    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        window.removeEventListener("message", onMessage);
        window.clearInterval(closedTimer);
        resolve(ok);
      };
      const onMessage = async (e: MessageEvent) => {
        if (e.origin !== window.location.origin) return;
        const data = e.data as { type?: string; success?: boolean; status?: string; message?: string; synced_count?: number };
        if (!data || data.type !== "META_OAUTH_RESULT") return;
        await handleOAuthResult(data.status || (data.success ? "success" : "error"), data.message || "", data.synced_count);
        finish(Boolean(data.success));
      };
      window.addEventListener("message", onMessage);
      // The user closed the window without finishing
      const closedTimer = window.setInterval(() => {
        if (popup.closed) window.setTimeout(() => finish(false), 500);
      }, 700);
    });
  };

  /** Shows the result of a Facebook login and refreshes Pages (used by the popup and the full-page fallback) */
  const handleOAuthResult = async (status: string, message: string, syncedCount?: number) => {
    if (status === "success") {
      await loadPages();
      toast.success(syncedCount ? `Facebook connected. ${syncedCount} Page(s) synced.` : message || "Facebook connected.");
      isConnectModalOpen.value = false;
      connectTargetAccountId.value = null;
    } else if (status === "denied") {
      toast.warning("Facebook connection was cancelled.");
    } else if (status === "no_pages") {
      toast.warning("This Facebook account does not manage any Pages, or no Page was selected in the Facebook window.");
    } else {
      toast.error(message || "Could not connect Facebook. Please try again.");
    }
  };

  const connectWithToken = async (token: string, targetAccountId: string | null = null) => {
    isLoading.value = true;
    try {
      let res: any;
      if (targetAccountId) {
        res = await api.updateAccountToken(targetAccountId, token);
      } else {
        res = await api.connectDirectToken(token);
      }
      if (res?.pages && Array.isArray(res.pages)) {
        pages.value = res.pages;
      }
      if (res?.accounts && Array.isArray(res.accounts)) {
        accounts.value = res.accounts;
      }
      await loadPages();
      toast.success(res?.message || "Account and Pages updated.");
      isConnectModalOpen.value = false;
      connectTargetAccountId.value = null;
      return true;
    } catch (err: any) {
      toast.error(err?.message || "Connection failed. Please check your access token.");
      return false;
    } finally {
      isLoading.value = false;
    }
  };

  const deleteAccount = async (accountId: string) => {
    isLoading.value = true;
    try {
      await api.deleteAccount(accountId);
      await loadPages();
      toast.success("Facebook account removed.");
      return true;
    } catch (err: any) {
      toast.error(err?.message || "Failed to remove Facebook account.");
      return false;
    } finally {
      isLoading.value = false;
    }
  };

  return {
    pages,
    accounts,
    expiredAccounts,
    expiredAccountNames,
    isLoading,
    searchQuery,
    filteredPages,
    isConnectModalOpen,
    isAccountsModalOpen,
    connectTargetAccountId,
    loadPages,
    syncPages,
    openConnectModal,
    connectWithFacebook,
    handleOAuthResult,
    connectWithToken,
    deleteAccount
  };
}

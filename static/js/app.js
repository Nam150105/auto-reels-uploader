/**
 * FB Reels Scheduler - Vue 3 Dashboard Logic (Meta Graph API)
 * UI/UX: Quản lý Fanpage, OAuth 2.0 Admin Connection, Đồng bộ /me/accounts,
 * Chế độ Chạy Thử (Run Test) vs Đăng Reels (Run Task), Phân bổ Bulk Task, Smart Date/Time Presets.
 */

(function () {
  let attempts = 0;
  function initMainDashboard() {
    if (typeof Vue === 'undefined') {
      attempts++;
      if (attempts < 60) {
        setTimeout(initMainDashboard, 50);
        return;
      }
      console.error("Vue 3 runtime chưa sẵn sàng sau 3 giây.");
      const hint = document.getElementById('app-timeout-hint');
      if (hint) hint.classList.remove('hidden');
      return;
    }

    const { createApp, ref, computed, watch, onMounted, onUnmounted } = Vue;

    const app = createApp({
      setup() {
    // ==========================================
    // 1. STATE DỮ LIỆU CHÍNH & TRẠNG THÁI XÁC THỰC
    // ==========================================
    const authState = ref('checking'); // 'checking' | 'authenticated' | 'unauthenticated' | 'error'
    const csrfToken = ref('');
    const isPageLoading = ref(true);
    const pageLoadError = ref('');
    const currentUser = ref(null);
    const currentTab = ref('pages'); // 'pages' | 'schedules'
    const pages = ref([]);
    const tasks = ref([]);
    const accounts = ref([]); // Danh sách các Facebook Admin Accounts
    const selectedAdminFilterIds = ref([]); // Lọc Fanpage theo các Admin Accounts được chọn
    const searchPage = ref('');
    const filterPageStatus = ref(''); // '' | 'can_post'
    const filterPage = ref('');
    const filterStatus = ref('');
    const searchTask = ref('');

    // Meta Connection State
    const metaStatus = ref({
      is_connected: false,
      user_id: null,
      user_name: null,
      token_expires_at: null,
      days_remaining: null,
      scopes: [],
      missing_scopes: []
    });

    const isSyncingPages = ref(false);
    const isRunningTest = ref(false);
    const isRunning = ref(false);

    // Cấu hình Runner (Threads)
    const config = ref({
      threads: 3
    });

    const savedConfig = localStorage.getItem('fb_reels_scheduler_meta_config');
    if (savedConfig) {
      try {
        const parsed = JSON.parse(savedConfig);
        config.value = { ...config.value, ...parsed };
      } catch (e) {
        console.error("Lỗi đọc config từ localStorage:", e);
      }
    }

    watch(config, (newVal) => {
      try {
        localStorage.setItem('fb_reels_scheduler_meta_config', JSON.stringify(newVal));
      } catch (e) {
        console.error("Lỗi lưu config vào localStorage:", e);
      }
    }, { deep: true });

    // Resizable Splitter
    const sidebarWidth = ref(430);
    const savedSidebarWidth = localStorage.getItem('fb_reels_meta_sidebar_width');
    if (savedSidebarWidth) {
      const parsed = parseInt(savedSidebarWidth);
      if (!isNaN(parsed) && parsed >= 320 && parsed <= 750) {
        sidebarWidth.value = parsed;
      }
    }
    const isResizingSplitter = ref(false);

    // Thống kê tổng hợp
    const systemStats = ref({
      total_pages: 0,
      selected_pages: 0,
      total_tasks: 0,
      pending_tasks: 0,
      success_tasks: 0,
      failed_tasks: 0,
      running_tasks: 0
    });

    // ==========================================
    // 2. MODALS STATE
    // ==========================================
    const showRunTestModal = ref(false);
    const showAccountsModal = ref(false); // Modal Quản lý Nhiều Facebook Admin Accounts
    const testResult = ref({
      status: 'pending',
      message: '',
      oauth_check: {},
      page_checks: [],
      valid_pages_count: 0,
      video_checks: [],
      valid_videos_count: 0,
      invalid_schedules_count: 0,
      schedule_warnings: []
    });

    const showConnectModal = ref(false);
    const directAccessToken = ref('');
    const showToken = ref(false);
    const isConnectingToken = ref(false);
    const connectStatus = ref('idle'); // 'idle' | 'processing' | 'success' | 'error'
    const connectMessage = ref('');
    const connectAccountInfo = ref(null);
    const oauthFlowState = ref('idle'); // 'idle' | 'opening' | 'processing' | 'success' | 'denied' | 'no_pages' | 'missing_permissions' | 'invalid_token' | 'error'
    const oauthFlowMessage = ref('');
    const isConnectingOAuth = ref(false);
    const reconnectTargetAccountId = ref(null);
    const showDeleteAccountModal = ref(false);
    const accountToDelete = ref(null);
    const isDeletingAccount = ref(false);
    const showSingleTaskModal = ref(false);
    const showBulkTaskModal = ref(false);
    const showEditTaskModal = ref(false);
    const showLogModal = ref(false);

    // Single Task Form
    const singleTaskForm = ref({
      facebook_page_id: '',
      video_path: '',
      caption: '',
      comment_text: '',
      schedule_date: '',
      schedule_time: ''
    });

    // Edit Task Form
    const editTaskForm = ref({
      id: null,
      facebook_page_id: '',
      video_path: '',
      caption: '',
      comment_text: '',
      schedule_date: '',
      schedule_time: ''
    });

    // Bulk Task Form
    const bulkDataRaw = ref('');
    const bulkAssignMethod = ref('round_robin'); // 'round_robin' | 'specific'
    const bulkSpecificPageId = ref('');
    const bulkParsedList = ref([]);
    const bulkFilesStatus = ref({});

    // Log Task Modal Form
    const currentLogTask = ref({ id: null, title: '', log: '', video_url: '' });

    // Toast Notifications
    const toasts = ref([]);
    function showToast(message, type = 'info') {
      const id = Date.now() + Math.random();
      toasts.value.push({ id, message, type });
      setTimeout(() => {
        toasts.value = toasts.value.filter(t => t.id !== id);
      }, 4000);
    }

    // ==========================================
    // 3. COMPUTED PROPERTIES
    // ==========================================
    const connectedAdminCount = computed(() => {
      return accounts.value.filter(a => a.status === 'connected').length;
    });

    const selectedPageCount = computed(() => {
      return pages.value.filter(p => p.is_selected).length;
    });

    const isAllPagesSelected = computed(() => {
      return pages.value.length > 0 && pages.value.every(p => p.is_selected);
    });

    // ==========================================
    // 4. API FETCH HELPER, TIMEOUT, ABORT & DATA LOADERS
    // ==========================================
    const activeAbortControllers = new Map();
    let isRedirectingToLogin = false;
    let pagesReqSeq = 0;
    let accountsReqSeq = 0;
    let tasksReqSeq = 0;

    function handleUnauthorizedSession() {
      authState.value = 'unauthenticated';
      currentUser.value = null;
      csrfToken.value = '';
      isPageLoading.value = false;
      try {
        sessionStorage.removeItem('fb_reels_auth_bootstrap');
      } catch (e) {}
      if (!isRedirectingToLogin && window.location.pathname !== '/login') {
        isRedirectingToLogin = true;
        window.location.replace('/login');
      }
    }

    async function apiFetch(url, options = {}) {
      const {
        timeoutMs = 12000,
        abortKey = null,
        skipUnauthorizedRedirect = false,
        headers: customHeaders = {},
        ...restOptions
      } = options;

      if (abortKey) {
        const prev = activeAbortControllers.get(abortKey);
        if (prev) {
          try { prev.abort(); } catch (e) {}
        }
      }

      const controller = new AbortController();
      if (abortKey) {
        activeAbortControllers.set(abortKey, controller);
      }

      const timer = setTimeout(() => {
        try { controller.abort(); } catch (e) {}
      }, timeoutMs);

      const mergedHeaders = { ...customHeaders };
      if (csrfToken.value && !mergedHeaders['X-CSRF-Token']) {
        mergedHeaders['X-CSRF-Token'] = csrfToken.value;
      }

      try {
        const res = await fetch(url, {
          ...restOptions,
          credentials: 'same-origin',
          cache: 'no-store',
          headers: mergedHeaders,
          signal: controller.signal
        });

        if (res.status === 401 && !skipUnauthorizedRedirect) {
          handleUnauthorizedSession();
        }
        return res;
      } finally {
        clearTimeout(timer);
        if (abortKey && activeAbortControllers.get(abortKey) === controller) {
          activeAbortControllers.delete(abortKey);
        }
      }
    }

    async function loadMetaStatus() {
      if (authState.value !== 'authenticated') return false;
      try {
        const res = await apiFetch('/api/meta/status', {
          abortKey: 'loadMetaStatus',
          timeoutMs: 10000
        });
        if (res.ok) {
          metaStatus.value = await res.json();
          return true;
        }
      } catch (err) {
        if (!err || err.name !== 'AbortError') {
          console.error("Lỗi tải Meta Status:", err);
        }
      }
      return false;
    }

    async function loadAccounts() {
      if (authState.value !== 'authenticated') return false;
      const seq = ++accountsReqSeq;
      try {
        const res = await apiFetch('/api/meta/accounts', {
          abortKey: 'loadAccounts',
          timeoutMs: 10000
        });
        if (res.ok) {
          const data = await res.json();
          if (seq === accountsReqSeq && Array.isArray(data)) {
            accounts.value = data;
            const validIds = new Set(accounts.value.map(a => a.id));
            selectedAdminFilterIds.value = selectedAdminFilterIds.value.filter(id => validIds.has(id));
          }
          return true;
        }
      } catch (err) {
        if (!err || err.name !== 'AbortError') {
          console.error("Lỗi tải danh sách Facebook Accounts:", err);
        }
      }
      return false;
    }

    async function loadPages() {
      if (authState.value !== 'authenticated') return false;
      const seq = ++pagesReqSeq;
      try {
        const params = new URLSearchParams();
        if (selectedAdminFilterIds.value.length > 0) {
          params.append('account_ids', selectedAdminFilterIds.value.join(','));
        }
        if (searchPage.value.trim()) params.append('search', searchPage.value.trim());
        if (filterPageStatus.value) params.append('status', filterPageStatus.value);

        const queryStr = params.toString();
        const res = await apiFetch(queryStr ? `/api/pages?${queryStr}` : '/api/pages', {
          abortKey: 'loadPages',
          timeoutMs: 12000
        });
        if (res.ok) {
          const data = await res.json();
          if (seq === pagesReqSeq && Array.isArray(data)) {
            pages.value = data;
            systemStats.value.total_pages = data.length;
            systemStats.value.selected_pages = data.filter(p => p.is_selected).length;
          }
          pageLoadError.value = '';
          return true;
        }
        if (res.status >= 500) {
          pageLoadError.value = 'Máy chủ đang bận khi tải danh sách Fanpage. Vui lòng nhấn Thử lại.';
        }
      } catch (err) {
        if (!err || err.name !== 'AbortError') {
          console.error("Lỗi tải danh sách Pages:", err);
          pageLoadError.value = 'Không thể tải danh sách Fanpage do kết nối mạng chậm. Vui lòng thử lại.';
        }
      }
      return false;
    }

    async function loadTasks() {
      if (authState.value !== 'authenticated') return false;
      const seq = ++tasksReqSeq;
      try {
        const params = new URLSearchParams();
        if (filterPage.value) params.append('facebook_page_id', filterPage.value);
        if (filterStatus.value) params.append('status', filterStatus.value);
        if (searchTask.value.trim()) params.append('search', searchTask.value.trim());

        const queryStr = params.toString();
        const res = await apiFetch(queryStr ? `/api/tasks?${queryStr}` : '/api/tasks', {
          abortKey: 'loadTasks',
          timeoutMs: 12000
        });
        if (res.ok) {
          const data = await res.json();
          if (seq === tasksReqSeq && Array.isArray(data)) {
            tasks.value = data;
          }
          return true;
        }
      } catch (err) {
        if (!err || err.name !== 'AbortError') {
          console.error("Lỗi tải danh sách Tasks:", err);
        }
      }
      return false;
    }

    async function loadStats() {
      if (authState.value !== 'authenticated') return false;
      try {
        const res = await apiFetch('/api/status', {
          abortKey: 'loadStats',
          timeoutMs: 10000
        });
        if (res.ok) {
          const data = await res.json();
          isRunning.value = data.is_running || false;
          systemStats.value = {
            total_pages: data.total_pages ?? pages.value.length,
            selected_pages: data.selected_pages ?? pages.value.filter(p => p.is_selected).length,
            total_tasks: data.total_tasks || 0,
            pending_tasks: data.pending_tasks || 0,
            success_tasks: data.success_tasks || 0,
            failed_tasks: data.failed_tasks || 0,
            running_tasks: data.running_tasks || 0
          };
          return true;
        }
      } catch (err) {
        if (!err || err.name !== 'AbortError') {
          console.error("Lỗi tải System Stats:", err);
        }
      }
      return false;
    }

    async function loadAll() {
      if (authState.value !== 'authenticated') return;
      isPageLoading.value = true;
      pageLoadError.value = '';
      try {
        // 1. Tải dữ liệu thiết yếu của trang /page trước để hiển thị ngay lập tức
        await Promise.allSettled([loadPages(), loadAccounts()]);
      } finally {
        isPageLoading.value = false;
      }
      // 2. Tải dữ liệu phụ bất đồng bộ, không chặn hiển thị trang /page
      Promise.allSettled([loadTasks(), loadStats(), loadMetaStatus()]);
    }

    // ==========================================
    // 5. AUTH & NAVIGATION ACTIONS
    // ==========================================
    async function checkAuth() {
      authState.value = 'checking';
      try {
        const cachedRaw = sessionStorage.getItem('fb_reels_auth_bootstrap');
        if (cachedRaw) {
          const parsed = JSON.parse(cachedRaw);
          if (parsed && parsed.user && Date.now() - (parsed.ts || 0) < 60000) {
            currentUser.value = parsed.user;
            if (parsed.csrf_token) csrfToken.value = parsed.csrf_token;
          }
        }
      } catch (e) {}

      try {
        const res = await apiFetch('/api/auth/me', {
          abortKey: 'checkAuth',
          timeoutMs: 10000,
          skipUnauthorizedRedirect: true
        });
        if (res.status === 401) {
          handleUnauthorizedSession();
          return false;
        }
        if (res.ok) {
          const data = await res.json();
          if (data && data.authenticated && data.user) {
            currentUser.value = data.user;
            csrfToken.value = data.csrf_token || '';
            authState.value = 'authenticated';
            try {
              sessionStorage.setItem(
                'fb_reels_auth_bootstrap',
                JSON.stringify({
                  user: data.user,
                  csrf_token: data.csrf_token || null,
                  ts: Date.now()
                })
              );
            } catch (e) {}
            return true;
          }
          handleUnauthorizedSession();
          return false;
        }
        // Lỗi server 5xx tạm thời: không tự động đăng xuất người dùng
        authState.value = 'error';
        isPageLoading.value = false;
        pageLoadError.value = 'Máy chủ đang bận khi xác minh phiên đăng nhập. Vui lòng nhấn Thử lại.';
        return false;
      } catch (e) {
        console.error("Auth check failed:", e);
        authState.value = 'error';
        isPageLoading.value = false;
        pageLoadError.value = 'Không thể kết nối máy chủ để xác minh phiên đăng nhập. Vui lòng kiểm tra mạng và thử lại.';
        return false;
      }
    }

    async function retryInitializePage() {
      pageLoadError.value = '';
      if (authState.value !== 'authenticated') {
        const ok = await checkAuth();
        if (!ok) return;
      }
      await loadAll();
    }

    async function handleLogout() {
      try {
        await apiFetch('/api/auth/logout', {
          method: 'POST',
          timeoutMs: 6000,
          skipUnauthorizedRedirect: true
        });
      } catch (e) {
        console.error("Lỗi đăng xuất:", e);
      }
      try {
        sessionStorage.removeItem('fb_reels_auth_bootstrap');
        localStorage.setItem(
          'fb_reels_auth_event',
          JSON.stringify({ event: 'logout', ts: Date.now() })
        );
      } catch (e) {}
      handleUnauthorizedSession();
    }

    function setTab(tab) {
      currentTab.value = tab;
      const targetPath = tab === 'pages' ? '/page' : '/schedules';
      if (window.location.pathname !== targetPath) {
        history.pushState(null, '', targetPath);
      }
    }

    // ==========================================
    // 6. META OAUTH & PAGE MANAGEMENT ACTIONS
    // ==========================================
    let oauthPopupRef = null;
    let oauthPopupWatcher = null;

    function clearOAuthPopupWatcher() {
      if (oauthPopupWatcher) {
        clearInterval(oauthPopupWatcher);
        oauthPopupWatcher = null;
      }
    }

    function openConnectModal(accountId = null) {
      reconnectTargetAccountId.value = accountId && typeof accountId === 'string' ? accountId : null;
      directAccessToken.value = '';
      showToken.value = false;
      isConnectingToken.value = false;
      connectStatus.value = 'idle';
      connectMessage.value = '';
      connectAccountInfo.value = null;
      oauthFlowState.value = 'idle';
      oauthFlowMessage.value = '';
      showConnectModal.value = true;
    }

    async function handleConnectToken() {
      const raw = (directAccessToken.value || '').trim();
      if (!raw) {
        connectStatus.value = 'error';
        connectMessage.value = 'Vui lòng dán Access Token từ Graph API Explorer vào ô nhập.';
        showToast('Vui lòng dán Access Token vào ô nhập.', 'warning');
        return;
      }
      isConnectingToken.value = true;
      connectStatus.value = 'processing';
      connectMessage.value = 'Đang kiểm tra token và kết nối Facebook...';

      try {
        const res = await apiFetch('/api/meta/connect-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: raw }),
          timeoutMs: 30000
        });
        const data = await res.json();
        if (res.ok && data.success) {
          connectStatus.value = 'success';
          connectAccountInfo.value = {
            user_name: data.user_name || 'Facebook User',
            synced_count: data.synced_count || 0
          };
          connectMessage.value = data.message || `Đã liên kết tài khoản "${data.user_name}" và đồng bộ ${data.synced_count || 0} Fanpage!`;
          directAccessToken.value = '';
          showToast(connectMessage.value, 'success');
          await loadAll();
        } else {
          connectStatus.value = 'error';
          connectMessage.value = data.detail || 'Không thể kết nối Facebook. Vui lòng kiểm tra lại token và các quyền được cấp.';
          showToast(connectMessage.value, 'error');
        }
      } catch (err) {
        connectStatus.value = 'error';
        connectMessage.value = 'Lỗi kết nối khi gửi token: ' + (err.message || 'Mạng không ổn định');
        showToast(connectMessage.value, 'error');
      } finally {
        isConnectingToken.value = false;
      }
    }

    function openAccountsModal() {
      showAccountsModal.value = true;
      loadAccounts();
    }

    async function handleOAuthResultPayload(payload) {
      clearOAuthPopupWatcher();
      isConnectingOAuth.value = false;
      const status = payload.status || (payload.success ? 'success' : 'error');
      const msg = payload.message || (payload.success
        ? 'Đã kết nối tài khoản Facebook thành công'
        : 'Không thể kết nối Facebook lúc này, vui lòng thử lại');

      oauthFlowState.value = status;
      oauthFlowMessage.value = msg;

      await loadAll();

      if (status === 'success') {
        showToast(msg, 'success');
        setTimeout(() => {
          if (oauthFlowState.value === 'success') {
            showConnectModal.value = false;
            oauthFlowState.value = 'idle';
            oauthFlowMessage.value = '';
          }
        }, 1200);
      } else if (status === 'denied' || status === 'no_pages') {
        showToast(msg, 'warning');
      } else {
        showToast(msg, 'error');
      }
    }

    function onWindowMessage(event) {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.type !== 'META_OAUTH_RESULT') return;
      handleOAuthResultPayload(data);
    }

    async function startMetaOAuthFlow(accountId = null) {
      if (isConnectingOAuth.value) return;
      const targetId = (accountId && typeof accountId === 'string') ? accountId : reconnectTargetAccountId.value;

      isConnectingOAuth.value = true;
      oauthFlowState.value = 'opening';
      oauthFlowMessage.value = 'Đang mở Facebook...';

      try {
        const params = new URLSearchParams();
        if (targetId) {
          params.set('account_id', targetId);
        }
        const queryStr = params.toString();
        const res = await apiFetch(`/api/meta/oauth-url${queryStr ? '?' + queryStr : ''}`, {
          timeoutMs: 12000
        });
        const data = await res.json();

        if (!res.ok || !data.success || !data.oauth_url) {
          isConnectingOAuth.value = false;
          oauthFlowState.value = 'error';
          oauthFlowMessage.value = data.detail || data.message || 'Không thể kết nối Facebook lúc này, vui lòng thử lại';
          showToast(oauthFlowMessage.value, 'error');
          return;
        }

        // Mở cửa sổ Facebook Login (Popup) ở chính giữa màn hình
        const width = 620;
        const height = 720;
        const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
        const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
        const features = `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no,location=yes,status=no,scrollbars=yes,resizable=yes`;

        oauthPopupRef = window.open(data.oauth_url, 'fb_oauth_popup', features);

        // Nếu trình duyệt chặn popup -> tự động chuyển hướng toàn trang trên cùng một luồng OAuth
        if (!oauthPopupRef || oauthPopupRef.closed || typeof oauthPopupRef.closed === 'undefined') {
          oauthFlowState.value = 'processing';
          oauthFlowMessage.value = 'Đang chuyển hướng đến Facebook...';
          window.location.href = data.oauth_url;
          return;
        }

        oauthFlowState.value = 'processing';
        oauthFlowMessage.value = 'Đang chờ xác nhận quyền truy cập từ Facebook...';

        clearOAuthPopupWatcher();
        oauthPopupWatcher = setInterval(() => {
          if (!oauthPopupRef || oauthPopupRef.closed) {
            clearOAuthPopupWatcher();
            if (isConnectingOAuth.value) {
              isConnectingOAuth.value = false;
              if (oauthFlowState.value === 'opening' || oauthFlowState.value === 'processing') {
                oauthFlowState.value = 'idle';
                oauthFlowMessage.value = '';
              }
            }
          }
        }, 600);
      } catch {
        isConnectingOAuth.value = false;
        oauthFlowState.value = 'error';
        oauthFlowMessage.value = 'Không thể kết nối Facebook lúc này, vui lòng thử lại';
        showToast(oauthFlowMessage.value, 'error');
      }
    }

    async function handleDisconnectMeta() {
      try {
        const res = await apiFetch('/api/meta/disconnect', { method: 'POST' });
        const data = await res.json();
        showToast(data.message || "Đã ngắt kết nối.", "success");
        await loadAll();
      } catch {
        showToast("Không thể thực hiện lúc này, vui lòng thử lại.", "error");
      }
    }

    async function handleSyncPages() {
      isSyncingPages.value = true;
      try {
        const res = await apiFetch('/api/meta/sync-pages', { method: 'POST', timeoutMs: 25000 });
        const data = await res.json();
        if (res.ok) {
          showToast(data.message || "Đồng bộ Fanpage thành công!", "success");
          await loadAll();
        } else {
          showToast(data.detail || data.message || "Không thể kết nối Facebook lúc này, vui lòng thử lại", "error");
        }
      } catch {
        showToast("Không thể kết nối Facebook lúc này, vui lòng thử lại", "error");
      } finally {
        isSyncingPages.value = false;
      }
    }

    async function handleSyncAccountPages(accountId) {
      isSyncingPages.value = true;
      try {
        const res = await apiFetch(`/api/meta/accounts/${accountId}/sync`, { method: 'POST', timeoutMs: 25000 });
        const data = await res.json();
        if (res.ok) {
          showToast(data.message || "Đồng bộ Fanpage thành công!", data.no_pages ? "warning" : "success");
          await loadAll();
        } else {
          showToast(data.detail || data.message || "Không thể kết nối Facebook lúc này, vui lòng thử lại", "error");
        }
      } catch {
        showToast("Không thể kết nối Facebook lúc này, vui lòng thử lại", "error");
      } finally {
        isSyncingPages.value = false;
      }
    }

    async function handleReconnectAccount(accountId) {
      reconnectTargetAccountId.value = accountId;
      showConnectModal.value = true;
      await startMetaOAuthFlow(accountId);
    }

    async function handleDisconnectAccount(accountId) {
      const acc = accounts.value.find(a => a.id === accountId) || { id: accountId };
      promptDeleteAccount(acc);
    }

    function promptDeleteAccount(accountOrId) {
      const acc = typeof accountOrId === 'object' && accountOrId !== null
        ? accountOrId
        : (accounts.value.find(a => a.id === accountOrId) || { id: accountOrId, user_name: 'Facebook' });
      accountToDelete.value = acc;
      showDeleteAccountModal.value = true;
    }

    function cancelDeleteAccount() {
      if (isDeletingAccount.value) return;
      showDeleteAccountModal.value = false;
      accountToDelete.value = null;
    }

    async function confirmDeleteAccount() {
      if (!accountToDelete.value || isDeletingAccount.value) return;
      const accountId = accountToDelete.value.id;
      isDeletingAccount.value = true;
      try {
        const res = await apiFetch(`/api/meta/accounts/${accountId}`, { method: 'DELETE' });
        const data = await res.json();
        if (res.ok && data.success) {
          showDeleteAccountModal.value = false;
          accountToDelete.value = null;
          if (Array.isArray(data.accounts)) {
            accounts.value = data.accounts;
          }
          if (Array.isArray(data.pages)) {
            pages.value = data.pages;
          }
          selectedAdminFilterIds.value = selectedAdminFilterIds.value.filter(id => id !== accountId);
          showToast(data.message || "Đã xóa tài khoản Facebook và các Fanpage liên quan.", "success");
          await loadAll();
        } else {
          showToast(data.detail || "Không thể xóa tài khoản, vui lòng thử lại.", "error");
        }
      } catch {
        showToast("Không thể xóa tài khoản, vui lòng thử lại.", "error");
      } finally {
        isDeletingAccount.value = false;
      }
    }

    function handleDeleteAccount(accountOrId) {
      promptDeleteAccount(accountOrId);
    }

    function toggleAdminFilter(accountId) {
      const idx = selectedAdminFilterIds.value.indexOf(accountId);
      if (idx > -1) {
        selectedAdminFilterIds.value.splice(idx, 1);
      } else {
        selectedAdminFilterIds.value.push(accountId);
      }
      loadPages();
    }

    function clearAdminFilter() {
      selectedAdminFilterIds.value = [];
      loadPages();
    }

    function selectAllConnectedAdminFilters() {
      selectedAdminFilterIds.value = accounts.value.filter(a => a.status === 'connected').map(a => a.id);
      loadPages();
    }

    async function handleTogglePageSelect(page) {
      const targetState = !page.is_selected;
      page.is_selected = targetState; // Optimistic update
      try {
        const res = await fetch(`/api/pages/${page.facebook_page_id}/select`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_selected: targetState })
        });
        if (!res.ok) {
          page.is_selected = !targetState; // Revert
          showToast("Lỗi cập nhật lựa chọn Fanpage.", "error");
        } else {
          await loadStats();
        }
      } catch (err) {
        page.is_selected = !targetState;
        showToast("Lỗi kết nối mạng: " + err.message, "error");
      }
    }

    async function handleToggleSelectAll(isSelected) {
      try {
        const payload = { is_selected: isSelected };
        if (selectedAdminFilterIds.value.length > 0) {
          payload.account_ids = selectedAdminFilterIds.value;
        }
        const res = await fetch('/api/pages/bulk-select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
          showToast(data.message, "success");
          await loadPages();
          await loadStats();
        } else {
          showToast(data.detail || "Không thể chọn hàng loạt.", "error");
        }
      } catch (err) {
        showToast("Lỗi kết nối: " + err.message, "error");
      }
    }

    async function handleCheckPagePermission(page) {
      showToast(`Đang kiểm tra quyền Fanpage "${page.name}"...`, "info");
      try {
        const res = await fetch(`/api/pages/${page.facebook_page_id}/check-permission`, { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          if (data.can_post) {
            showToast(`✓ Fanpage "${page.name}" ĐỦ QUYỀN đăng Reels!`, "success");
          } else {
            showToast(`⚠ Fanpage "${page.name}" THIẾU QUYỀN: ${data.message}`, "warning");
          }
          await loadPages();
        } else {
          showToast(`Lỗi kiểm tra quyền: ${data.detail || data.message}`, "error");
        }
      } catch (err) {
        showToast("Lỗi mạng khi kiểm tra quyền: " + err.message, "error");
      }
    }

    async function handleDeletePage(page) {
      if (!confirm(`Bạn có chắc chắn muốn xóa Fanpage "${page.name}" (${page.facebook_page_id}) khỏi danh sách quản lý của tool không? (Không ảnh hưởng đến Fanpage trên Facebook)`)) {
        return;
      }
      try {
        const res = await fetch(`/api/pages/${page.facebook_page_id}`, { method: 'DELETE' });
        const data = await res.json();
        if (res.ok) {
          showToast(data.message, "success");
          await loadAll();
        } else {
          showToast(data.detail || "Không thể xóa Fanpage.", "error");
        }
      } catch (err) {
        showToast("Lỗi xóa Fanpage: " + err.message, "error");
      }
    }

    function filterByPage(pageId) {
      if (filterPage.value === pageId) {
        filterPage.value = '';
      } else {
        filterPage.value = pageId;
      }
      loadTasks();
    }

    // ==========================================
    // 6. RUNNER CONTROLS (RUN TEST & RUN TASK)
    // ==========================================
    async function handleRunTest() {
      isRunningTest.value = true;
      try {
        const res = await fetch('/api/runner/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        const data = await res.json();
        testResult.value = data;
        showRunTestModal.value = true;
      } catch (err) {
        showToast("Lỗi chạy kiểm tra chẩn đoán: " + err.message, "error");
      } finally {
        isRunningTest.value = false;
      }
    }

    async function handleRunBatch() {
      if (selectedPageCount.value === 0) {
        showToast("Vui lòng tích chọn ít nhất 1 Fanpage có quyền đăng bài!", "warning");
        return;
      }
      try {
        const res = await fetch('/api/runner/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threads: config.value.threads })
        });
        const data = await res.json();
        if (res.ok) {
          showToast(data.message || "Đã bắt đầu tiến trình đăng Reels!", "success");
          isRunning.value = true;
          await loadAll();
        } else {
          showToast(data.detail || data.message || "Không thể bắt đầu tiến trình.", "error");
        }
      } catch (err) {
        showToast("Lỗi kết nối runner: " + err.message, "error");
      }
    }

    async function handleStopBatch() {
      try {
        const res = await fetch('/api/runner/stop', { method: 'POST' });
        const data = await res.json();
        showToast(data.message || "Đã gửi tín hiệu dừng khẩn cấp.", "info");
        isRunning.value = false;
        await loadAll();
      } catch (err) {
        showToast("Lỗi dừng runner: " + err.message, "error");
      }
    }

    // ==========================================
    // 7. TASK CREATION & EDITING
    // ==========================================
    function openSingleTaskModal(pageId = '') {
      singleTaskForm.value = {
        facebook_page_id: pageId || (pages.value.length > 0 ? pages.value[0].facebook_page_id : ''),
        video_path: '',
        caption: '',
        comment_text: '',
        schedule_date: '',
        schedule_time: ''
      };
      showSingleTaskModal.value = true;
    }

    async function uploadVideoFileToCloud(file) {
      if (!file) return;
      showToast(`Đang tải video "${file.name}" trực tiếp lên Cloudflare R2...`, "info");
      try {
        // Bước 1: Khởi tạo phiên upload R2 (/api/media/upload-init)
        const initRes = await fetch('/api/media/upload-init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: file.name,
            size_bytes: file.size,
            mime_type: file.type || 'video/mp4'
          })
        });
        const initData = await initRes.json();
        if (!initRes.ok || !initData.media_id) {
          showToast(initData.detail || "Không thể khởi tạo phiên upload R2.", "error");
          return;
        }

        // Bước 2: Stream trực tiếp binary file lên R2 (/api/media/upload-stream/{media_id})
        const streamRes = await fetch(initData.upload_url, {
          method: 'PUT',
          headers: {
            'Content-Type': file.type || 'video/mp4'
          },
          body: file
        });
        const streamData = await streamRes.json();
        if (!streamRes.ok) {
          showToast(streamData.detail || "Lỗi truyền dữ liệu video lên R2.", "error");
          return;
        }

        // Bước 3: Xác nhận hoàn tất upload (/api/media/upload-complete)
        const compRes = await fetch('/api/media/upload-complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ media_id: initData.media_id })
        });
        const compData = await compRes.json();
        if (compRes.ok && compData.video_path) {
          singleTaskForm.value.video_path = compData.video_path;
          showToast(`Đã tải video "${file.name}" (${compData.size_mb || 0} MB) lên Cloudflare R2!`, "success");
        } else {
          showToast(compData.detail || "Không thể xác nhận hoàn tất upload R2.", "error");
        }
      } catch (err) {
        showToast("Lỗi tải video lên Cloudflare R2: " + err.message, "error");
      }
    }

    async function handleBrowseFileSingleTask() {
      const fileInput = document.getElementById('cloud-video-file-input');
      if (fileInput) {
        fileInput.value = '';
        fileInput.click();
      }
    }

    async function handleCloudVideoFileSelected(event) {
      const files = event.target && event.target.files;
      if (files && files.length > 0) {
        await uploadVideoFileToCloud(files[0]);
      }
    }

    async function handleFileDropSingleTask(event) {
      if (event.dataTransfer && event.dataTransfer.files.length > 0) {
        const file = event.dataTransfer.files[0];
        await uploadVideoFileToCloud(file);
      }
    }

    function getVnDateString(offsetDays = 0) {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      const now = new Date();
      if (offsetDays !== 0) {
        now.setDate(now.getDate() + offsetDays);
      }
      return formatter.format(now);
    }

    function setDatePreset(offsetDays) {
      singleTaskForm.value.schedule_date = getVnDateString(offsetDays);
    }

    function setTimePreset(timeStr) {
      singleTaskForm.value.schedule_time = timeStr;
    }

    function validateVnScheduleClient(scheduleDate, scheduleTime) {
      const dStr = (scheduleDate || '').trim();
      const tStr = (scheduleTime || '').trim();
      if (!dStr && !tStr) return { valid: true };
      if (!dStr || !tStr) {
        return {
          valid: false,
          error: 'Phải nhập đầy đủ cả Ngày đăng (YYYY-MM-DD) và Giờ đăng (HH:MM) theo giờ Việt Nam.'
        };
      }
      const dMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dStr);
      const tMatch = /^(\d{1,2}):(\d{2})$/.exec(tStr);
      if (!dMatch || !tMatch) {
        return {
          valid: false,
          error: 'Định dạng ngày giờ không hợp lệ. Ngày phải có dạng YYYY-MM-DD và giờ HH:MM.'
        };
      }
      const y = parseInt(dMatch[1], 10);
      const m = parseInt(dMatch[2], 10);
      const d = parseInt(dMatch[3], 10);
      const h = parseInt(tMatch[1], 10);
      const min = parseInt(tMatch[2], 10);
      const schedUtcMillis = Date.UTC(y, m - 1, d, h, min, 0) - (7 * 3600 * 1000);
      const nowUtcMillis = Date.now();
      if (schedUtcMillis <= nowUtcMillis) {
        return {
          valid: false,
          error: `Thời gian đặt lịch (${dStr} ${tStr} giờ VN) đã qua hoặc trùng với thời điểm hiện tại. Vui lòng chọn thời gian trong tương lai!`
        };
      }
      if (schedUtcMillis < nowUtcMillis + 60000) {
        return {
          valid: false,
          error: `Thời gian đặt lịch (${dStr} ${tStr} giờ VN) phải cách thời điểm hiện tại tối thiểu 1 phút!`
        };
      }
      return { valid: true };
    }

    async function handleCreateSingleTaskSubmit() {
      if (!singleTaskForm.value.video_path.trim()) {
        showToast("Đường dẫn video không được để trống!", "warning");
        return;
      }
      if (singleTaskForm.value.schedule_date || singleTaskForm.value.schedule_time) {
        const val = validateVnScheduleClient(
          singleTaskForm.value.schedule_date,
          singleTaskForm.value.schedule_time
        );
        if (!val.valid) {
          showToast(val.error, "error");
          return;
        }
      }
      try {
        const payload = {
          facebook_page_id: singleTaskForm.value.facebook_page_id,
          video_path: singleTaskForm.value.video_path.trim(),
          caption: singleTaskForm.value.caption || "",
          comment_text: singleTaskForm.value.comment_text || "",
          schedule_date: singleTaskForm.value.schedule_date || "",
          schedule_time: singleTaskForm.value.schedule_time || "",
          publish_mode: (singleTaskForm.value.schedule_date || singleTaskForm.value.schedule_time) ? "scheduled" : "now"
        };
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
          showToast("Đã tạo task thành công!", "success");
          showSingleTaskModal.value = false;
          await loadAll();
        } else {
          showToast(data.detail || "Tạo task thất bại.", "error");
        }
      } catch (err) {
        showToast("Lỗi kết nối khi tạo task: " + err.message, "error");
      }
    }

    // ==========================================
    // 8. BULK TASK EXCEL IMPORT & LIVE PREVIEW
    // ==========================================
    function openBulkTaskModal() {
      bulkDataRaw.value = '';
      bulkParsedList.value = [];
      bulkFilesStatus.value = {};
      bulkAssignMethod.value = 'round_robin';
      bulkSpecificPageId.value = pages.value.length > 0 ? pages.value[0].facebook_page_id : '';
      showBulkTaskModal.value = true;
    }

    function parseBulkData(rawText) {
      if (!rawText || !rawText.trim()) return [];
      const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
      const parsed = [];

      for (const line of lines) {
        // Tách theo tab (\t) hoặc pipe (|)
        const parts = line.includes('\t') ? line.split('\t') : line.split('|');
        const videoPath = (parts[0] || '').trim().replace(/^["']|["']$/g, '');
        if (!videoPath) continue;

        const caption = (parts[1] || '').trim();
        const comment = (parts[2] || '').trim();
        const scheduleDate = (parts[3] || '').trim();
        const scheduleTime = (parts[4] || '').trim();

        parsed.push({
          video_path: videoPath,
          caption: caption,
          comment_text: comment,
          schedule_date: scheduleDate,
          schedule_time: scheduleTime
        });
      }
      return parsed;
    }

    let bulkDebounceTimer = null;
    function handleBulkInputChanged() {
      bulkParsedList.value = parseBulkData(bulkDataRaw.value);
      clearTimeout(bulkDebounceTimer);
      bulkDebounceTimer = setTimeout(checkBulkFilesExistence, 600);
    }

    async function checkBulkFilesExistence() {
      const paths = bulkParsedList.value.map(i => i.video_path).filter(p => !!p);
      if (paths.length === 0) return;
      try {
        const res = await fetch('/api/system/check-files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths })
        });
        const data = await res.json();
        if (data.results) {
          bulkFilesStatus.value = data.results;
        }
      } catch (err) {
        console.error("Lỗi kiểm tra file bulk:", err);
      }
    }

    async function handleBulkSubmit() {
      if (bulkParsedList.value.length === 0) {
        showToast("Không có dòng dữ liệu hợp lệ nào để nhập!", "warning");
        return;
      }

      // Kiểm tra hợp lệ lịch hẹn của từng dòng (nếu có)
      for (let i = 0; i < bulkParsedList.value.length; i++) {
        const item = bulkParsedList.value[i];
        if (item.schedule_date || item.schedule_time) {
          const val = validateVnScheduleClient(item.schedule_date, item.schedule_time);
          if (!val.valid) {
            showToast(`Dòng ${i + 1}: ${val.error}`, "error");
            return;
          }
        }
      }

      // Xác định danh sách Page được gán
      let assignPageIds = [];
      if (bulkAssignMethod.value === 'specific') {
        if (!bulkSpecificPageId.value) {
          showToast("Vui lòng chọn 1 Fanpage cụ thể!", "warning");
          return;
        }
        assignPageIds = [bulkSpecificPageId.value];
      } else {
        // Round-robin qua các page đã chọn (hoặc tất cả page nếu chưa chọn)
        const selected = pages.value.filter(p => p.is_selected);
        if (selected.length > 0) {
          assignPageIds = selected.map(p => p.facebook_page_id);
        } else {
          assignPageIds = pages.value.map(p => p.facebook_page_id);
        }
      }

      if (assignPageIds.length === 0) {
        showToast("Chưa có Fanpage nào được đồng bộ để gán task!", "warning");
        return;
      }

      try {
        const payload = {
          tasks: bulkParsedList.value,
          assign_page_ids: assignPageIds
        };
        const res = await fetch('/api/tasks/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
          showToast(data.message || `Đã nhập thành công ${data.inserted_count} tasks!`, "success");
          showBulkTaskModal.value = false;
          await loadAll();
        } else {
          showToast(data.detail || "Lỗi nhập hàng loạt.", "error");
        }
      } catch (err) {
        showToast("Lỗi nhập hàng loạt: " + err.message, "error");
      }
    }

    // ==========================================
    // 9. TASK ACTIONS (EDIT, RESET, DELETE, LOG)
    // ==========================================
    function openEditTaskModal(t) {
      editTaskForm.value = {
        id: t.id,
        facebook_page_id: t.facebook_page_id || '',
        video_path: t.video_path || '',
        caption: t.caption || '',
        comment_text: t.comment_text || '',
        schedule_date: t.schedule_date || '',
        schedule_time: t.schedule_time || ''
      };
      showEditTaskModal.value = true;
    }

    async function handleUpdateTaskSubmit() {
      if (editTaskForm.value.schedule_date || editTaskForm.value.schedule_time) {
        const val = validateVnScheduleClient(
          editTaskForm.value.schedule_date,
          editTaskForm.value.schedule_time
        );
        if (!val.valid) {
          showToast(val.error, "error");
          return;
        }
      }
      try {
        const payload = {
          facebook_page_id: editTaskForm.value.facebook_page_id,
          video_path: editTaskForm.value.video_path.trim(),
          caption: editTaskForm.value.caption || "",
          comment_text: editTaskForm.value.comment_text || "",
          schedule_date: editTaskForm.value.schedule_date || "",
          schedule_time: editTaskForm.value.schedule_time || "",
          publish_mode: (editTaskForm.value.schedule_date || editTaskForm.value.schedule_time) ? "scheduled" : "now"
        };
        const res = await fetch(`/api/tasks/${editTaskForm.value.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
          showToast("Đã cập nhật task thành công!", "success");
          showEditTaskModal.value = false;
          await loadAll();
        } else {
          showToast(data.detail || "Cập nhật task thất bại.", "error");
        }
      } catch (err) {
        showToast("Lỗi cập nhật task: " + err.message, "error");
      }
    }

    async function handleResetTask(taskId) {
      try {
        const res = await fetch(`/api/tasks/${taskId}/reset`, { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          showToast("Đã đặt lại task về trạng thái Chờ xử lý.", "success");
          await loadAll();
        } else {
          showToast(data.detail || "Không thể đặt lại task.", "error");
        }
      } catch (err) {
        showToast("Lỗi reset task: " + err.message, "error");
      }
    }

    async function handleDeleteTask(taskId) {
      if (!confirm(`Bạn có chắc chắn muốn xóa Task #${taskId} không?`)) return;
      try {
        const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
        const data = await res.json();
        if (res.ok) {
          showToast("Đã xóa task.", "success");
          await loadAll();
        } else {
          showToast(data.detail || "Không thể xóa task.", "error");
        }
      } catch (err) {
        showToast("Lỗi xóa task: " + err.message, "error");
      }
    }

    async function openLogModal(t) {
      currentLogTask.value = {
        id: t.id,
        title: `Chi tiết Task #${t.id} - ${t.page_name || 'Fanpage'}`,
        log: t.log || t.error_message || '(Chưa có thông điệp log)',
        video_url: t.video_url || ''
      };
      showLogModal.value = true;
      try {
        const res = await fetch(`/api/tasks/${t.id}/logs`);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.logs) && data.logs.length > 0) {
            const historyLines = data.logs.map(
              l => `[${l.created_at}] [${l.level}] (${l.stage}) ${l.message}`
            );
            currentLogTask.value.log =
              `${t.log || ''}\n\n--- LỊCH SỬ GIAI ĐOẠN (QUEUE & GRAPH API) ---\n` +
              historyLines.join('\n');
          }
        }
      } catch (e) {
        // Giữ nguyên log tóm tắt nếu không lấy được chi tiết
      }
    }

    // ==========================================
    // 10. HELPERS & SPLITTER RESIZE
    // ==========================================
    function copyToClipboard(text) {
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        showToast("Đã sao chép vào bộ nhớ tạm: " + text, "info");
      }).catch(err => {
        console.error("Lỗi clipboard:", err);
      });
    }

    function getFileName(pathStr) {
      if (!pathStr) return '';
      return pathStr.split('\\').pop().split('/').pop();
    }

    function startResizeSplitter(e) {
      isResizingSplitter.value = true;
      const startX = e.clientX;
      const startWidth = sidebarWidth.value;

      function onMouseMove(moveEvent) {
        const delta = moveEvent.clientX - startX;
        let newWidth = startWidth + delta;
        if (newWidth < 320) newWidth = 320;
        if (newWidth > 750) newWidth = 750;
        sidebarWidth.value = newWidth;
      }

      function onMouseUp() {
        isResizingSplitter.value = false;
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        try {
          localStorage.setItem('fb_reels_meta_sidebar_width', sidebarWidth.value.toString());
        } catch (e) {
          console.error(e);
        }
      }

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    }

    // ==========================================
    // 11. LIFECYCLE, MULTI-TAB SYNC & POLLING
    // ==========================================
    let pollInterval = null;

    function onPopState() {
      const p = window.location.pathname;
      if (p === '/schedules' || p === '/reels') {
        currentTab.value = 'schedules';
      } else {
        currentTab.value = 'pages';
      }
    }

    async function onPageShow(event) {
      if (event && event.persisted) {
        const authed = await checkAuth();
        if (authed) {
          await loadAll();
        }
      }
    }

    async function onStorageEvent(event) {
      if (!event || event.key !== 'fb_reels_auth_event' || !event.newValue) return;
      try {
        const parsed = JSON.parse(event.newValue);
        if (!parsed) return;
        if (parsed.event === 'logout') {
          handleUnauthorizedSession();
        } else if (
          parsed.event === 'login' &&
          parsed.userId &&
          currentUser.value &&
          parsed.userId !== currentUser.value.id
        ) {
          const authed = await checkAuth();
          if (authed) {
            await loadAll();
          }
        }
      } catch (e) {}
    }

    onMounted(async () => {
      // Chuẩn hóa đường dẫn mặc định về /page
      const path = window.location.pathname;
      if (path === '/schedules' || path === '/reels') {
        currentTab.value = 'schedules';
      } else {
        currentTab.value = 'pages';
        if (path === '/' || path === '/pages') {
          history.replaceState(null, '', '/page' + window.location.search);
        }
      }

      window.addEventListener('popstate', onPopState);
      window.addEventListener('pageshow', onPageShow);
      window.addEventListener('storage', onStorageEvent);
      window.addEventListener('message', onWindowMessage);

      // 1. Kiểm tra xác thực người dùng trước khi gọi bất kỳ API nội bộ nào
      const authed = await checkAuth();
      if (!authed) return;

      // 2. Tải dữ liệu thiết yếu của trang /page (Pages & Accounts), dữ liệu phụ chạy ngầm không chặn UI
      await loadAll();

      // 3. Xử lý kết quả OAuth nếu quay lại từ chế độ redirect toàn trang
      const urlParams = new URLSearchParams(window.location.search);
      const oauthStatus = urlParams.get('oauth_status');
      const oauthMsg = urlParams.get('oauth_msg');
      if (oauthStatus) {
        history.replaceState(null, '', window.location.pathname);
        if (oauthStatus !== 'success') {
          showConnectModal.value = true;
        }
        await handleOAuthResultPayload({
          success: oauthStatus === 'success',
          status: oauthStatus,
          message: oauthMsg || ''
        });
      }

      // 4. Smart Polling tối ưu cho Cloudflare Workers Free Plan:
      // - Chỉ poll nhanh (5 giây) khi có tác vụ đang chạy/queued
      // - Giãn cách 30 giây khi hệ thống rảnh và tạm dừng khi ẩn tab trình duyệt
      let lastIdlePollTime = Date.now();
      pollInterval = setInterval(async () => {
        if (document.hidden || authState.value !== 'authenticated') return;
        const hasActiveWork = isRunning.value || systemStats.value.running_tasks > 0;
        const now = Date.now();
        if (!hasActiveWork && now - lastIdlePollTime < 30000) {
          return;
        }
        lastIdlePollTime = now;
        await loadStats();
        if (isRunning.value || systemStats.value.running_tasks > 0) {
          await Promise.allSettled([loadTasks(), loadPages()]);
        }
      }, 5000);
    });

    onUnmounted(() => {
      if (pollInterval) clearInterval(pollInterval);
      clearOAuthPopupWatcher();
      for (const ctrl of activeAbortControllers.values()) {
        try { ctrl.abort(); } catch (e) {}
      }
      activeAbortControllers.clear();
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('storage', onStorageEvent);
      window.removeEventListener('message', onWindowMessage);
    });

    return {
      authState,
      isPageLoading,
      pageLoadError,
      retryInitializePage,
      currentUser,
      currentTab,
      setTab,
      checkAuth,
      handleLogout,
      pages,
      tasks,
      accounts,
      selectedAdminFilterIds,
      searchPage,
      filterPageStatus,
      filterPage,
      filterStatus,
      searchTask,
      metaStatus,
      isSyncingPages,
      isRunningTest,
      isRunning,
      config,
      sidebarWidth,
      isResizingSplitter,
      systemStats,
      selectedPageCount,
      isAllPagesSelected,
      connectedAdminCount,
      showRunTestModal,
      testResult,
      showConnectModal,
      directAccessToken,
      showToken,
      isConnectingToken,
      connectStatus,
      connectMessage,
      connectAccountInfo,
      handleConnectToken,
      getVnDateString,
      validateVnScheduleClient,
      oauthFlowState,
      oauthFlowMessage,
      isConnectingOAuth,
      reconnectTargetAccountId,
      showDeleteAccountModal,
      accountToDelete,
      isDeletingAccount,
      showAccountsModal,
      showSingleTaskModal,
      showBulkTaskModal,
      showEditTaskModal,
      showLogModal,
      singleTaskForm,
      editTaskForm,
      bulkDataRaw,
      bulkAssignMethod,
      bulkSpecificPageId,
      bulkParsedList,
      bulkFilesStatus,
      currentLogTask,
      toasts,
      loadAll,
      loadAccounts,
      loadPages,
      loadTasks,
      openConnectModal,
      openAccountsModal,
      startMetaOAuthFlow,
      handleDisconnectMeta,
      handleSyncPages,
      handleSyncAccountPages,
      handleReconnectAccount,
      handleDisconnectAccount,
      promptDeleteAccount,
      cancelDeleteAccount,
      confirmDeleteAccount,
      handleDeleteAccount,
      toggleAdminFilter,
      clearAdminFilter,
      selectAllConnectedAdminFilters,
      handleTogglePageSelect,
      handleToggleSelectAll,
      handleCheckPagePermission,
      handleDeletePage,
      filterByPage,
      handleRunTest,
      handleRunBatch,
      handleStopBatch,
      openSingleTaskModal,
      handleBrowseFileSingleTask,
      handleCloudVideoFileSelected,
      handleFileDropSingleTask,
      setDatePreset,
      setTimePreset,
      handleCreateSingleTaskSubmit,
      openBulkTaskModal,
      handleBulkInputChanged,
      handleBulkSubmit,
      openEditTaskModal,
      handleUpdateTaskSubmit,
      handleResetTask,
      handleDeleteTask,
      openLogModal,
      copyToClipboard,
      getFileName,
      startResizeSplitter
    };
  }
});

    app.mount('#app');
    clearTimeout(timeoutHintTimer);

    // Ẩn màn hình loading fallback ngay khi ứng dụng mount xong
    const loader = document.getElementById('app-loading-screen');
    if (loader) {
      loader.style.opacity = '0';
      setTimeout(() => loader.remove(), 180);
    }
  }

  // Cảnh báo timeout sau 6 giây chỉ khi script CDN chưa thể mount Vue
  const timeoutHintTimer = setTimeout(() => {
    const hint = document.getElementById('app-timeout-hint');
    if (hint) hint.classList.remove('hidden');
  }, 6000);

  // Khởi chạy khi DOM đã sẵn sàng
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMainDashboard);
  } else {
    initMainDashboard();
  }
})();

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
    const mainView = ref('schedule'); // 'schedule' | 'analytics' | 'pages'
    const currentTab = ref('schedules'); // 'pages' | 'schedules'
    const pages = ref([]);
    const tasks = ref([]);
    const selectedTaskIds = ref([]);
    const isBulkDeletingTasks = ref(false);
    const accounts = ref([]); // Danh sách các Facebook Admin Accounts
    const selectedAdminFilterIds = ref([]); // Lọc Fanpage theo các Admin Accounts được chọn
    const searchPage = ref('');
    const filterPageStatus = ref(''); // '' | 'can_post'
    const filterPage = ref('');
    const filterStatus = ref('');
    const filterStartDate = ref('');
    const filterEndDate = ref('');
    const searchTask = ref('');
    const publishingNowTaskId = ref(null);
    const isBulkPublishingTasks = ref(false);
    const isBulkReschedulingTasks = ref(false);
    const isBulkCancellingTasks = ref(false);
    const showBulkPublishModal = ref(false);
    const showBulkRescheduleModal = ref(false);
    const bulkRescheduleForm = ref({
      schedule_date: '',
      schedule_time: '',
      interval_minutes: 10
    });
    const singleScheduleErrors = ref({
      schedule_date: '',
      schedule_time: '',
      general: ''
    });

    // ==========================================
    // FACEBOOK POSTS & COMMENTS MANAGER STATE
    // ==========================================
    const posts = ref([]);
    const totalPosts = ref(0);
    const postsPage = ref(1);
    const postsLimit = ref(12);
    const postsTotalPages = ref(1);
    const postsFilter = ref({
      page_id: '',
      post_type: 'all',
      source: 'all',
      search: '',
      start_date: '',
      end_date: ''
    });
    const postsViewMode = ref('grid'); // 'grid' | 'list'
    const isLoadingPosts = ref(false);
    const pageSyncStates = ref({});

    // Post Detail & Modals
    const selectedPost = ref(null);
    const isPostDetailOpen = ref(false);
    const isLoadingPostDetail = ref(false);
    const postComments = ref([]);
    const postAuditLogs = ref([]);
    const postNewComment = ref('');
    const isSendingPostComment = ref(false);
    const postReplyTargetId = ref(null);
    const postReplyText = ref('');
    const isSendingPostReply = ref(false);

    // Edit Post
    const isEditPostModalOpen = ref(false);
    const editPostCaptionText = ref('');
    const isSavingPostEdit = ref(false);

    // Delete Post
    const isDeletePostModalOpen = ref(false);
    const isDeletingPost = ref(false);
    const deletePostOnFacebook = ref(true);

    // Comments View State
    const commentsFilterPageId = ref('');
    const commentsList = ref([]);
    const isLoadingComments = ref(false);

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
    const connectWarnings = ref([]);
    const oauthFlowState = ref('idle'); // 'idle' | 'opening' | 'processing' | 'success' | 'denied' | 'no_pages' | 'missing_permissions' | 'invalid_token' | 'error'
    const oauthFlowMessage = ref('');
    const isConnectingOAuth = ref(false);
    const reconnectTargetAccountId = ref(null);
    const showDeleteAccountModal = ref(false);
    const accountToDelete = ref(null);
    const isDeletingAccount = ref(false);
    const showSingleTaskModal = ref(false);
    const showBulkTaskModal = ref(false);
    const showPageTasksModal = ref(false);
    const pageTaskTargetPage = ref(null);
    const pageScheduleConfig = ref({
      start_date: '',
      start_time: '08:00',
      interval_hours: 4
    });
    const pageSlots = ref([]);
    const isSubmittingPageTasks = ref(false);
    const isUploadingPageSlotVideo = ref(null);
    const pageSlotUploadError = ref('');
    const showEditTaskModal = ref(false);
    const showLogModal = ref(false);
    const retryingCommentTaskId = ref(null);

    // Reels Insights State
    const insightsFilter = ref({
      facebook_page_id: '',
      range: '30d',
      start_date: '',
      end_date: '',
      search: '',
      sort_by: 'published_at',
      sort_dir: 'desc'
    });
    const insightsData = ref({
      overview: {
        total_reels_count: 0,
        total_views: null,
        total_reach: null,
        total_interactions: null,
        total_likes: null,
        total_comments: null,
        total_shares: null,
        total_watch_time_ms: null,
        avg_watch_time_ms: null
      },
      charts: {
        views_over_time: [],
        reel_performance: [],
        interactions_breakdown: [],
        watch_time: [],
        page_comparison: []
      },
      reels: [],
      permission_warnings: [],
      last_synced_at: null
    });
    const isLoadingInsights = ref(false);
    const isSyncingInsights = ref(false);
    const syncingTaskInsightId = ref(null);
    const showReelInsightModal = ref(false);
    const isLoadingReelDetail = ref(false);
    const reelInsightDetail = ref({
      task: null,
      latest_snapshot: null,
      metric_items: [],
      history: []
    });

    function isTaskLocked(t) {
      if (!t) return false;
      return Boolean(
        t.status === 'success' ||
        t.publish_status === 'success' ||
        Number(t.is_locked || 0) === 1 ||
        (t.video_id && t.post_id)
      );
    }

    function isTaskInFlight(t) {
      if (!t) return false;
      return Boolean(
        t.status === 'running' ||
        t.status === 'processing' ||
        t.status === 'queued'
      );
    }

    // Single Task Form
    const singleTaskForm = ref({
      facebook_page_id: '',
      video_path: '',
      media_id: '',
      object_key: '',
      caption: '',
      comment_text: '',
      schedule_date: '',
      schedule_time: ''
    });
    const isUploadingVideo = ref(false);
    const uploadError = ref('');
    const lastUploadFile = ref(null);
    const uploadedMediaInfo = ref(null);
    const userMediaFiles = ref([]);

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

    // Bulk Task Form (Excel Import & Staggered Scheduling)
    const bulkDataRaw = ref('');
    const bulkAssignMethod = ref('round_robin'); // 'round_robin' | 'specific'
    const bulkSpecificPageId = ref('');
    const bulkParsedList = ref([]);
    const bulkFilesStatus = ref({});
    const bulkScheduleForm = ref({
      schedule_date: '',
      schedule_time: '',
      interval_minutes: 15,
      custom_interval: 15
    });
    const isUploadingBulkExcelVideos = ref(false);
    const bulkExcelUploadProgress = ref({ current: 0, total: 0, filename: '' });
    const isSubmittingBulkTasks = ref(false);

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

    const expiredAccounts = computed(() => {
      return accounts.value.filter(a =>
        a.status === 'expired' || a.status === 'invalid_token' || a.status === 'revoked'
      );
    });

    const expiredAccountNames = computed(() => {
      return expiredAccounts.value.map(a => a.user_name || a.user_id).join(', ');
    });

    const missingInsightsAccounts = computed(() => {
      return accounts.value.filter(a => a.status === 'connected' && !a.has_read_insights);
    });

        const selectedPages = computed(() => {
      return pages.value.filter(p => p.is_selected);
    });

const selectedPageCount = computed(() => {
      return pages.value.filter(p => p.is_selected).length;
    });

    const isAllPagesSelected = computed(() => {
      return pages.value.length > 0 && pages.value.every(p => p.is_selected);
    });

    const selectableTasksCount = computed(() => {
      return tasks.value.filter(t => !isTaskLocked(t) && !isTaskInFlight(t)).length;
    });

    const isAllTasksSelected = computed(() => {
      const mutableTasks = tasks.value.filter(t => !isTaskLocked(t) && !isTaskInFlight(t));
      return mutableTasks.length > 0 && mutableTasks.every(t => selectedTaskIds.value.includes(t.id));
    });

    const bulkPublishPreview = computed(() => {
      const eligible = [];
      const ineligible = [];
      for (const id of selectedTaskIds.value) {
        const t = tasks.value.find(x => x.id === id);
        if (!t) continue;
        if (isTaskLocked(t)) {
          ineligible.push({ id: t.id, page_name: t.page_name, reason: 'Đã đăng thành công (Đã khóa)' });
        } else if (isTaskInFlight(t)) {
          ineligible.push({ id: t.id, page_name: t.page_name, reason: 'Đang trong tiến trình đăng' });
        } else if (!t.facebook_page_id) {
          ineligible.push({ id: t.id, page_name: t.page_name, reason: 'Chưa gán Fanpage đích' });
        } else if (!t.video_path && !t.media_id && !t.object_key) {
          ineligible.push({ id: t.id, page_name: t.page_name, reason: 'Thiếu nguồn video trên R2' });
        } else {
          eligible.push(t);
        }
      }
      return {
        total: selectedTaskIds.value.length,
        eligible,
        ineligible
      };
    });

    const bulkReschedulePreviewList = computed(() => {
      const dStr = (bulkRescheduleForm.value.schedule_date || '').trim();
      const tStr = (bulkRescheduleForm.value.schedule_time || '').trim();
      const interval = Math.max(0, Number(bulkRescheduleForm.value.interval_minutes) || 0);
      const parsedT = normalizeTime24hClient(tStr, dStr);
      const dMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dStr);
      const baseMillis = (dMatch && parsedT.valid)
        ? Date.UTC(parseInt(dMatch[1], 10), parseInt(dMatch[2], 10) - 1, parseInt(dMatch[3], 10), parsedT.hour, parsedT.minute, 0)
        : null;

      const list = [];
      let idx = 0;
      for (const id of selectedTaskIds.value) {
        const t = tasks.value.find(x => x.id === id);
        if (!t || isTaskLocked(t) || isTaskInFlight(t)) continue;
        let newDate = dStr || '—';
        let newTime = parsedT.valid ? parsedT.normalizedTime : (tStr || '—');
        if (baseMillis !== null) {
          const itemD = new Date(baseMillis + idx * interval * 60000);
          newDate = `${String(itemD.getUTCFullYear()).padStart(4, '0')}-${String(itemD.getUTCMonth() + 1).padStart(2, '0')}-${String(itemD.getUTCDate()).padStart(2, '0')}`;
          newTime = `${String(itemD.getUTCHours()).padStart(2, '0')}:${String(itemD.getUTCMinutes()).padStart(2, '0')}`;
        }
        list.push({
          id: t.id,
          page_name: t.page_name || t.facebook_page_id || 'Chưa gán Page',
          new_date: newDate,
          new_time: newTime
        });
        idx++;
      }
      return list;
    });

    const maxTimeSeriesViews = computed(() => {
      const list = (insightsData.value.charts && insightsData.value.charts.views_over_time) || [];
      let max = 1;
      for (const item of list) {
        if ((item.views || 0) > max) max = item.views;
      }
      return max;
    });

    const maxReelPerformanceViews = computed(() => {
      const list = (insightsData.value.charts && insightsData.value.charts.reel_performance) || [];
      let max = 1;
      for (const item of list) {
        if ((item.views || 0) > max) max = item.views;
      }
      return max;
    });

    const maxReelInteractions = computed(() => {
      const list = (insightsData.value.charts && insightsData.value.charts.interactions_breakdown) || [];
      let max = 1;
      for (const item of list) {
        const sum = (item.likes || 0) + (item.comments || 0) + (item.shares || 0);
        if (sum > max) max = sum;
      }
      return max;
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
        params.append('exclude_published', 'true');
        if (filterPage.value) params.append('facebook_page_id', filterPage.value);
        if (filterStatus.value) params.append('status', filterStatus.value);
        if (filterStartDate.value) params.append('start_date', filterStartDate.value);
        if (filterEndDate.value) params.append('end_date', filterEndDate.value);
        if (searchTask.value.trim()) params.append('search', searchTask.value.trim());

        const queryStr = params.toString();
        const res = await apiFetch(`/api/tasks?${queryStr}`, {
          abortKey: 'loadTasks',
          timeoutMs: 12000
        });
        if (res.ok) {
          const data = await res.json();
          if (seq === tasksReqSeq && Array.isArray(data)) {
            // Danh sách task đang hoạt động CHỈ hiển thị bài chưa đăng thành công
            tasks.value = data.filter(t => t.status !== 'published');
            if (selectedTaskIds.value.length > 0) {
              const currentIds = new Set(tasks.value.map(t => t.id));
              selectedTaskIds.value = selectedTaskIds.value.filter(id => currentIds.has(id));
            }
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
      if (tab === 'pages') {
        setMainView('pages');
      } else {
        setMainView('schedule');
      }
    }

    async function loadAnalyticsDashboard() {
      if (authState.value !== 'authenticated') return;
      await Promise.allSettled([
        loadReelsInsights(),
        loadFacebookPosts()
      ]);
    }

    function setMainView(view) {
      if (view === 'analytics' || view === 'insights' || view === 'posts' || view === 'comments') {
        mainView.value = 'analytics';
        const targetPath = '/analytics';
        if (window.location.pathname !== targetPath) history.pushState(null, '', targetPath);
        loadAnalyticsDashboard();
      } else if (view === 'pages' || view === 'page') {
        mainView.value = 'pages';
        currentTab.value = 'pages';
        const targetPath = '/pages';
        if (window.location.pathname !== targetPath) history.pushState(null, '', targetPath);
        loadPages();
      } else {
        mainView.value = 'schedule';
        currentTab.value = 'schedules';
        const targetPath = '/schedule';
        if (window.location.pathname !== targetPath) history.pushState(null, '', targetPath);
        loadTasks();
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
      connectWarnings.value = [];
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
      connectWarnings.value = [];

      try {
        const res = await apiFetch('/api/meta/connect-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            access_token: raw,
            account_id: reconnectTargetAccountId.value || null
          }),
          timeoutMs: 30000
        });
        const data = await res.json();
        if (res.ok && data.success) {
          connectStatus.value = 'success';
          connectAccountInfo.value = {
            user_name: data.user_name || 'Facebook User',
            synced_count: data.synced_count || 0
          };
          connectWarnings.value = [
            data.insights_warning,
            data.analyze_warning,
            data.missing_pages_warning
          ].filter(Boolean);
          connectMessage.value = data.message || `Đã liên kết tài khoản "${data.user_name}" và đồng bộ ${data.synced_count || 0} Fanpage!`;
          directAccessToken.value = '';
          showToast(connectMessage.value, 'success');
          await loadAll();
          if (mainView.value === 'insights') {
            await loadReelsInsights();
          }
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
          body: JSON.stringify({})
        });
        const data = await res.json();
        if (res.ok) {
          showToast(data.message || "Đã bắt đầu tiến trình đăng Reels!", "success");
          isRunning.value = true;
          await loadAll();
          scheduleNextPoll();
        } else {
          const msg = data.detail || data.message || "Không thể bắt đầu tiến trình.";
          if (msg.includes("hẹn lịch")) {
            showToast(msg, "info");
          } else {
            showToast(msg, "warning");
          }
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
        scheduleNextPoll();
      } catch (err) {
        showToast("Lỗi dừng runner: " + err.message, "error");
      }
    }

    // ==========================================
    // 7. TASK CREATION & EDITING
    // ==========================================
    async function loadUserMediaFiles() {
      try {
        const res = await fetch('/api/media');
        if (res.ok) {
          const data = await res.json();
          userMediaFiles.value = Array.isArray(data.items) ? data.items : [];
        }
      } catch (e) {}
    }

    function selectExistingR2Video(mediaItem) {
      if (!mediaItem || !mediaItem.id) return;
      singleTaskForm.value.video_path = `r2://${mediaItem.id}`;
      singleTaskForm.value.media_id = mediaItem.id;
      singleTaskForm.value.object_key = mediaItem.object_key || '';
      uploadError.value = '';
      uploadedMediaInfo.value = {
        media_id: mediaItem.id,
        object_key: mediaItem.object_key || '',
        filename: mediaItem.original_filename || mediaItem.id,
        size_mb: Math.round(((mediaItem.size_bytes || 0) / 1048576) * 100) / 100
      };
    }

    function clearSingleScheduleErrors() {
      singleScheduleErrors.value = {
        schedule_date: '',
        schedule_time: '',
        general: ''
      };
    }

    function openSingleTaskModal(pageId = '') {
      const defSched = getVnNowParts(15);
      clearSingleScheduleErrors();
      singleTaskForm.value = {
        facebook_page_id: pageId || (pages.value.length > 0 ? pages.value[0].facebook_page_id : ''),
        video_path: '',
        media_id: '',
        object_key: '',
        caption: '',
        comment_text: '',
        schedule_date: defSched.date,
        schedule_time: defSched.time
      };
      isUploadingVideo.value = false;
      uploadError.value = '';
      lastUploadFile.value = null;
      uploadedMediaInfo.value = null;
      loadUserMediaFiles();
      showSingleTaskModal.value = true;
    }

    async function uploadVideoFileToCloud(file) {
      if (!file) return;
      isUploadingVideo.value = true;
      uploadError.value = '';
      lastUploadFile.value = file;
      uploadedMediaInfo.value = null;
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
          const msg = initData.detail || "Không thể khởi tạo phiên upload R2.";
          uploadError.value = msg;
          isUploadingVideo.value = false;
          showToast(msg, "error");
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
          const msg = streamData.detail || "Lỗi truyền dữ liệu video lên R2.";
          uploadError.value = msg;
          isUploadingVideo.value = false;
          showToast(msg, "error");
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
          singleTaskForm.value.media_id = compData.media_id || initData.media_id;
          singleTaskForm.value.object_key = compData.object_key || initData.object_key || '';
          uploadedMediaInfo.value = {
            media_id: compData.media_id || initData.media_id,
            object_key: compData.object_key || initData.object_key || '',
            filename: file.name,
            size_mb: compData.size_mb || Math.round((file.size / 1048576) * 100) / 100
          };
          isUploadingVideo.value = false;
          uploadError.value = '';
          loadUserMediaFiles();
          showToast(`Đã tải & xác minh video "${file.name}" (${uploadedMediaInfo.value.size_mb} MB) trên Cloudflare R2!`, "success");
        } else {
          const msg = compData.detail || "Không thể xác nhận hoàn tất upload R2.";
          uploadError.value = msg;
          isUploadingVideo.value = false;
          showToast(msg, "error");
        }
      } catch (err) {
        const msg = "Lỗi tải video lên Cloudflare R2: " + err.message;
        uploadError.value = msg;
        isUploadingVideo.value = false;
        showToast(msg, "error");
      }
    }

    async function retryUploadToR2() {
      if (lastUploadFile.value) {
        await uploadVideoFileToCloud(lastUploadFile.value);
      } else {
        handleBrowseFileSingleTask();
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

    const hours24List = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
    const minutes60List = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

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

    function getVnNowParts(offsetMinutes = 0) {
      const targetMillis = Date.now() + offsetMinutes * 60000 + 7 * 3600 * 1000;
      const d = new Date(targetMillis);
      const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const min = String(d.getUTCMinutes()).padStart(2, '0');
      return {
        date: `${yyyy}-${mm}-${dd}`,
        time: `${hh}:${min}`,
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes()
      };
    }

    function normalizeTime24hClient(rawTime, scheduleDate = '') {
      const clean = (rawTime || '').trim();
      if (!clean) {
        return { valid: false, normalizedTime: '', hour: -1, minute: -1, autoPromotedToPm: false };
      }
      const match = /^(\d{1,2})\s*(?::|h|g)\s*(\d{1,2})?(?:\s*:\s*(\d{1,2}))?\s*(sa|ch|am|pm|sáng|sang|trưa|trua|chiều|chieu|tối|toi)?$/i.exec(clean);
      if (!match) {
        return { valid: false, normalizedTime: clean, hour: -1, minute: -1, autoPromotedToPm: false };
      }
      let hour = parseInt(match[1], 10);
      const minute = (match[2] !== undefined && match[2] !== '') ? parseInt(match[2], 10) : 0;
      const rawMeridiem = (match[4] || '').trim().toLowerCase();

      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return { valid: false, normalizedTime: clean, hour, minute, autoPromotedToPm: false };
      }

      const isExplicitPm = /^(ch|pm|trưa|trua|chiều|chieu|tối|toi)$/i.test(rawMeridiem);
      const isExplicitAm = /^(sa|am|sáng|sang)$/i.test(rawMeridiem);

      if (isExplicitPm || isExplicitAm) {
        if (hour <= 12) {
          if (isExplicitPm && hour >= 1 && hour <= 11) {
            hour += 12;
          } else if (isExplicitAm && hour === 12) {
            hour = 0;
          }
        }
      }

      let autoPromotedToPm = false;
      let dStr = (scheduleDate || '').trim();
      const dmyMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dStr);
      if (dmyMatch) {
        dStr = `${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}`;
      }

      if (dStr && hour >= 0 && hour < 12 && !isExplicitPm) {
        const ymdMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dStr);
        if (ymdMatch) {
          const todayVn = getVnNowParts(0);
          if (dStr === todayVn.date) {
            const y = parseInt(ymdMatch[1], 10);
            const m = parseInt(ymdMatch[2], 10);
            const d = parseInt(ymdMatch[3], 10);
            const nowUtcMillis = Date.now();
            const candidateMillis = Date.UTC(y, m - 1, d, hour, minute, 0) - 7 * 3600 * 1000;
            const afternoonHour = hour + 12;
            const afternoonMillis = Date.UTC(y, m - 1, d, afternoonHour, minute, 0) - 7 * 3600 * 1000;

            if (
              candidateMillis <= nowUtcMillis &&
              afternoonMillis > nowUtcMillis &&
              (nowUtcMillis - candidateMillis >= 60000 || isExplicitAm || todayVn.hour >= 12)
            ) {
              hour = afternoonHour;
              autoPromotedToPm = true;
            }
          }
        }
      }

      const normalizedTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      return {
        valid: true,
        normalizedTime,
        hour,
        minute,
        autoPromotedToPm
      };
    }

    function getScheduleHour24(timeStr) {
      const parsed = normalizeTime24hClient(timeStr, '');
      if (!parsed.valid) return '';
      return String(parsed.hour).padStart(2, '0');
    }

    function getScheduleMinute24(timeStr) {
      const parsed = normalizeTime24hClient(timeStr, '');
      if (!parsed.valid) return '';
      return String(parsed.minute).padStart(2, '0');
    }

    function onScheduleHour24Change(target, hourVal) {
      const formObj = target === 'edit' ? editTaskForm.value : singleTaskForm.value;
      if (!hourVal) {
        formObj.schedule_time = '';
        return;
      }
      const curMin = getScheduleMinute24(formObj.schedule_time) || '00';
      formObj.schedule_time = `${hourVal}:${curMin}`;
      normalizeScheduleTimeField(target);
    }

    function onScheduleMinute24Change(target, minVal) {
      const formObj = target === 'edit' ? editTaskForm.value : singleTaskForm.value;
      if (!minVal) return;
      const curHour = getScheduleHour24(formObj.schedule_time) || String(getVnNowParts(5).hour).padStart(2, '0');
      formObj.schedule_time = `${curHour}:${minVal}`;
      normalizeScheduleTimeField(target);
    }

    function normalizeScheduleTimeField(target = 'single') {
      const formObj = target === 'edit' ? editTaskForm.value : singleTaskForm.value;
      const raw = (formObj.schedule_time || '').trim();
      if (!raw) return;
      const parsed = normalizeTime24hClient(raw, formObj.schedule_date);
      if (parsed.valid) {
        formObj.schedule_time = parsed.normalizedTime;
      }
    }

    function setRelativeTimePreset(offsetMinutes = 5, target = 'single') {
      const future = getVnNowParts(offsetMinutes);
      const formObj = target === 'edit' ? editTaskForm.value : singleTaskForm.value;
      formObj.schedule_date = future.date;
      formObj.schedule_time = future.time;
    }

    function describeTime24h(timeStr, scheduleDate = '') {
      const parsed = normalizeTime24hClient(timeStr, scheduleDate);
      if (!parsed.valid) {
        return 'Chưa đúng định dạng 24h (VD: 12:16, 14:30 hoặc 2:30 CH)';
      }
      const h = parsed.hour;
      const mStr = String(parsed.minute).padStart(2, '0');
      const h12 = h % 12 === 0 ? 12 : h % 12;
      const meridiem = h >= 12 ? 'CH / PM' : 'SA / AM';
      let periodName = 'Ban đêm';
      if (h >= 5 && h < 11) periodName = 'Buổi sáng';
      else if (h >= 11 && h < 14) periodName = 'Buổi trưa';
      else if (h >= 14 && h < 18) periodName = 'Buổi chiều';
      else if (h >= 18 && h <= 23) periodName = 'Buổi tối';

      const autoNote = parsed.autoPromotedToPm ? ' [Đã tự nhận biết CH/PM]' : '';
      return `${parsed.normalizedTime} (24 tiếng • tương đương ${String(h12).padStart(2, '0')}:${mStr} ${meridiem} - ${periodName})${autoNote}`;
    }

        function setQuickTomorrow0001(target = 'single') {
      const tomorrowStr = getVnDateString(1);
      if (target === 'bulk') {
        bulkScheduleForm.value.schedule_date = tomorrowStr;
        bulkScheduleForm.value.schedule_time = '00:01';
        recalculateBulkExcelSchedules();
      } else if (target === 'page') {
        pageScheduleConfig.value.start_date = tomorrowStr;
        pageScheduleConfig.value.start_time = '00:01';
        recalculatePageSlotTimes();
      } else {
        const formObj = target === 'edit' ? editTaskForm.value : singleTaskForm.value;
        formObj.schedule_date = tomorrowStr;
        formObj.schedule_time = '00:01';
        clearSingleScheduleErrors();
      }
    }

    function setEarliestSchedule(target = 'single') {
      const parts = getVnNowParts(25);
      if (target === 'bulk') {
        bulkScheduleForm.value.schedule_date = parts.date;
        bulkScheduleForm.value.schedule_time = parts.time;
        recalculateBulkExcelSchedules();
      } else if (target === 'page') {
        pageScheduleConfig.value.start_date = parts.date;
        pageScheduleConfig.value.start_time = parts.time;
        recalculatePageSlotTimes();
      } else {
        const formObj = target === 'edit' ? editTaskForm.value : singleTaskForm.value;
        formObj.schedule_date = parts.date;
        formObj.schedule_time = parts.time;
        clearSingleScheduleErrors();
      }
    }

    function shiftToTomorrow(target = 'single') {
      const tomorrowStr = getVnDateString(1);
      if (target === 'bulk') {
        bulkScheduleForm.value.schedule_date = tomorrowStr;
        recalculateBulkExcelSchedules();
      } else if (target === 'page') {
        pageScheduleConfig.value.start_date = tomorrowStr;
        recalculatePageSlotTimes();
      } else {
        const formObj = target === 'edit' ? editTaskForm.value : singleTaskForm.value;
        formObj.schedule_date = tomorrowStr;
        clearSingleScheduleErrors();
      }
    }

    function isTimeInPastToday(timeStr, dateStr) {
      if (!timeStr || !dateStr) return false;
      const todayVn = getVnNowParts(0);
      let d = dateStr.trim();
      const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d);
      if (dmy) d = `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
      if (d !== todayVn.date) return false;

      const parsed = normalizeTime24hClient(timeStr, d);
      if (!parsed.valid) return false;
      const nowMin = todayVn.hour * 60 + todayVn.minute;
      const targetMin = parsed.hour * 60 + parsed.minute;
      return targetMin <= nowMin;
    }

function setDatePreset(offsetDays) {
      singleTaskForm.value.schedule_date = getVnDateString(offsetDays);
      if (singleTaskForm.value.schedule_time) {
        normalizeScheduleTimeField('single');
      }
    }

    function setTimePreset(timeStr) {
      singleTaskForm.value.schedule_time = timeStr;
      if (!singleTaskForm.value.schedule_date) {
        singleTaskForm.value.schedule_date = getVnDateString(0);
      }
      normalizeScheduleTimeField('single');
    }

    function validateVnScheduleClient(scheduleDate, scheduleTime, requireSchedule = true) {
      let dStr = (scheduleDate || '').trim();
      const tStr = (scheduleTime || '').trim();
      if (!dStr && !tStr) {
        if (!requireSchedule) {
          return { valid: true, normalizedDate: '', normalizedTime: '' };
        }
        return {
          valid: false,
          missingDate: true,
          missingTime: true,
          fieldErrors: {
            schedule_date: 'Vui lòng chọn ngày đăng (YYYY-MM-DD).',
            schedule_time: 'Vui lòng nhập giờ đăng (HH:MM 24h).'
          },
          error: 'Vui lòng chọn đầy đủ Ngày đăng và Giờ đăng (24 tiếng) trước khi lưu Task.'
        };
      }
      if (!dStr || !tStr) {
        return {
          valid: false,
          missingDate: !dStr,
          missingTime: !tStr,
          fieldErrors: {
            schedule_date: !dStr ? 'Vui lòng chọn ngày đăng (YYYY-MM-DD).' : undefined,
            schedule_time: !tStr ? 'Vui lòng nhập giờ đăng (HH:MM 24h).' : undefined
          },
          error: !dStr
            ? 'Vui lòng chọn ngày đăng (YYYY-MM-DD).'
            : 'Vui lòng nhập giờ đăng (HH:MM 24h).'
        };
      }
      const dmyMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dStr);
      if (dmyMatch) {
        dStr = `${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}`;
      }
      const dMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dStr);
      const parsedTime = normalizeTime24hClient(tStr, dStr);
      if (!dMatch || !parsedTime.valid) {
        return {
          valid: false,
          fieldErrors: {
            schedule_date: !dMatch ? 'Ngày đăng không đúng định dạng YYYY-MM-DD.' : undefined,
            schedule_time: !parsedTime.valid ? 'Giờ đăng không đúng định dạng 24h HH:MM.' : undefined
          },
          error: 'Định dạng ngày giờ không hợp lệ. Ngày phải có dạng YYYY-MM-DD và giờ 24h HH:MM (hoặc kèm SA/CH/AM/PM).'
        };
      }
      const y = parseInt(dMatch[1], 10);
      const m = parseInt(dMatch[2], 10);
      const d = parseInt(dMatch[3], 10);
      const h = parsedTime.hour;
      const min = parsedTime.minute;
      const normTime = parsedTime.normalizedTime;
      const schedUtcMillis = Date.UTC(y, m - 1, d, h, min, 0) - (7 * 3600 * 1000);
      const nowUtcMillis = Date.now();
      if (schedUtcMillis <= nowUtcMillis) {
        return {
          valid: false,
          isPast: true,
          fieldErrors: {
            schedule_time: `Thời gian đã chọn (${dStr} ${normTime}) nằm trong quá khứ.`
          },
          error: `Thời gian đặt lịch (${dStr} ${normTime} giờ VN - 24h) đã qua hoặc trùng với thời điểm hiện tại. Vui lòng chọn thời gian trong tương lai!`
        };
      }
      if (schedUtcMillis < nowUtcMillis + 60000) {
        return {
          valid: false,
          isPast: true,
          fieldErrors: {
            schedule_time: 'Thời gian đặt lịch phải cách hiện tại tối thiểu 1 phút.'
          },
          error: `Thời gian đặt lịch (${dStr} ${normTime} giờ VN - 24h) phải cách thời điểm hiện tại tối thiểu 1 phút!`
        };
      }
      return {
        valid: true,
        normalizedDate: dStr,
        normalizedTime: normTime,
        autoPromotedToPm: parsedTime.autoPromotedToPm
      };
    }

    async function handleCreateSingleTaskSubmit() {
      clearSingleScheduleErrors();
      if (isUploadingVideo.value) {
        showToast("Video đang được tải lên Cloudflare R2. Vui lòng chờ hoàn tất trước khi lưu Task!", "warning");
        return;
      }
      const cleanPath = (singleTaskForm.value.video_path || '').trim();
      if (!cleanPath) {
        showToast("Vui lòng chọn và tải video lên Cloudflare R2 trước khi lưu Task!", "warning");
        return;
      }
      if (uploadError.value && !cleanPath.startsWith('r2://') && !cleanPath.startsWith('http')) {
        showToast("Video chưa tải lên R2 thành công. Vui lòng nhấn 'Thử tải lại lên R2'!", "error");
        return;
      }
      const val = validateVnScheduleClient(
        singleTaskForm.value.schedule_date,
        singleTaskForm.value.schedule_time,
        true
      );
      if (!val.valid) {
        singleScheduleErrors.value = {
          schedule_date: (val.fieldErrors && val.fieldErrors.schedule_date) || '',
          schedule_time: (val.fieldErrors && val.fieldErrors.schedule_time) || '',
          general: val.isPast ? val.error : ''
        };
        showToast(val.error, "error");
        return;
      }
      singleTaskForm.value.schedule_date = val.normalizedDate;
      singleTaskForm.value.schedule_time = val.normalizedTime;

      try {
        const payload = {
          facebook_page_id: singleTaskForm.value.facebook_page_id,
          video_path: cleanPath,
          media_id: singleTaskForm.value.media_id || undefined,
          object_key: singleTaskForm.value.object_key || undefined,
          caption: singleTaskForm.value.caption || "",
          comment_text: singleTaskForm.value.comment_text || "",
          schedule_date: singleTaskForm.value.schedule_date,
          schedule_time: singleTaskForm.value.schedule_time
        };
        const res = await apiFetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
          showToast("Đã tạo task hẹn lịch thành công!", "success");
          showSingleTaskModal.value = false;
          await loadAll();
        } else {
          if (data.field_errors) {
            singleScheduleErrors.value = {
              schedule_date: data.field_errors.schedule_date || '',
              schedule_time: data.field_errors.schedule_time || '',
              general: data.is_past ? (data.detail || '') : ''
            };
          }
          showToast(data.detail || "Tạo task thất bại.", "error");
        }
      } catch (err) {
        showToast("Lỗi kết nối khi tạo task: " + err.message, "error");
      }
    }

    // ==========================================
    // 8. BULK TASK EXCEL IMPORT & STAGGERED SCHEDULING
    // ==========================================
    const bulkSchedulePastWarning = computed(() => {
      const d = (bulkScheduleForm.value.schedule_date || '').trim();
      const t = (bulkScheduleForm.value.schedule_time || '').trim();
      if (!d || !t) return '';
      const check = validateVnScheduleClient(d, t, true);
      if (!check.valid && check.isPast) {
        return check.error || 'Thời gian bắt đầu đặt lịch đã qua hoặc trùng hiện tại!';
      }
      return '';
    });

    const validBulkRowCount = computed(() => {
      return bulkParsedList.value.filter(
        item => item.is_valid && (item.video_status === 'ready' || item.video_status === 'remote_url')
      ).length;
    });

    const errorBulkRowCount = computed(() => {
      return bulkParsedList.value.length - validBulkRowCount.value;
    });

    const bulkFirstScheduleDisplay = computed(() => {
      const firstValid = bulkParsedList.value.find(item => item.is_valid);
      return firstValid?.schedule_display || '—';
    });

    const bulkLastScheduleDisplay = computed(() => {
      for (let i = bulkParsedList.value.length - 1; i >= 0; i--) {
        if (bulkParsedList.value[i].is_valid) {
          return bulkParsedList.value[i].schedule_display || '—';
        }
      }
      return '—';
    });

    function setBulkScheduleDatePreset(offsetDays) {
      const slot = getVnNowParts(15 + offsetDays * 1440);
      bulkScheduleForm.value.schedule_date = slot.date;
      recalculateBulkExcelSchedules();
    }

    function setBulkScheduleTimePreset(hhmm) {
      bulkScheduleForm.value.schedule_time = hhmm;
      recalculateBulkExcelSchedules();
    }

    function setBulkScheduleInterval(minutes) {
      bulkScheduleForm.value.interval_minutes = Math.max(0, Number(minutes) || 0);
      recalculateBulkExcelSchedules();
    }

    function setBulkSchedulePastQuickFix() {
      const slot = getVnNowParts(5);
      bulkScheduleForm.value.schedule_date = slot.date;
      bulkScheduleForm.value.schedule_time = slot.time;
      recalculateBulkExcelSchedules();
    }

    function calculateStaggeredSchedule(startDateStr, startTimeStr, index, intervalMinutes) {
      if (!startDateStr || !startTimeStr) return { date: '', time: '', display: 'Chưa cài lịch' };
      let y, m, d;
      if (startDateStr.includes('-')) {
        const parts = startDateStr.split('-').map(Number);
        y = parts[0]; m = parts[1] - 1; d = parts[2];
      } else if (startDateStr.includes('/')) {
        const parts = startDateStr.split('/').map(Number);
        d = parts[0]; m = parts[1] - 1; y = parts[2];
      } else {
        return { date: '', time: '', display: 'Lịch không hợp lệ' };
      }
      const [hh, mm] = startTimeStr.split(':').map(Number);
      const dt = new Date(Date.UTC(y, m, d, hh, mm, 0));
      dt.setUTCMinutes(dt.getUTCMinutes() + (index * intervalMinutes));

      const resYear = dt.getUTCFullYear();
      const resMonth = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const resDay = String(dt.getUTCDate()).padStart(2, '0');
      const resHour = String(dt.getUTCHours()).padStart(2, '0');
      const resMin = String(dt.getUTCMinutes()).padStart(2, '0');

      return {
        date: `${resYear}-${resMonth}-${resDay}`,
        time: `${resHour}:${resMin}`,
        display: `${resDay}/${resMonth}/${resYear} ${resHour}:${resMin}`
      };
    }

    function openBulkTaskModal() {
      bulkDataRaw.value = '';
      bulkParsedList.value = [];
      bulkFilesStatus.value = {};
      bulkAssignMethod.value = 'round_robin';
      bulkSpecificPageId.value = pages.value.length > 0 ? pages.value[0].facebook_page_id : '';
      isUploadingBulkExcelVideos.value = false;
      bulkExcelUploadProgress.value = { current: 0, total: 0, filename: '' };
      isSubmittingBulkTasks.value = false;

      // Mặc định hẹn 15 phút từ thời điểm hiện tại
      const defSlot = getVnNowParts(15);
      bulkScheduleForm.value.schedule_date = defSlot.date;
      bulkScheduleForm.value.schedule_time = defSlot.time;
      bulkScheduleForm.value.interval_minutes = 15;
      bulkScheduleForm.value.custom_interval = 15;

      loadUserMediaFiles();
      showBulkTaskModal.value = true;
    }

    function parseBulkExcelData(rawText) {
      if (!rawText || !rawText.trim()) return [];
      const lines = rawText.split(/\r?\n/);
      const parsed = [];
      let validRowIndex = 0;

      for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        if (!rawLine.trim()) continue;

        // Tách theo Tab (\t) hoặc Pipe (|)
        const sep = rawLine.includes('\t') ? '\t' : (rawLine.includes('|') ? '|' : '\t');
        const parts = rawLine.split(sep);

        // Bỏ quote đôi bao ngoài do Excel copy nếu có
        const cleanParts = parts.map(p => {
          let s = (p || '').trim();
          if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
            s = s.slice(1, -1).replace(/""/g, '"').trim();
          }
          return s;
        });

        const vPath = cleanParts[0] || '';
        const cap = cleanParts[1] !== undefined ? cleanParts[1] : '';
        const comment = cleanParts[2] !== undefined ? cleanParts[2] : '';

        let isValid = true;
        let errorReason = '';

        if (parts.length < 3) {
          isValid = false;
          errorReason = `Thiếu cột: Chỉ có ${parts.length} cột (Yêu cầu đúng 3 cột: Video, Caption, Bình luận)`;
        } else if (parts.length > 3) {
          isValid = false;
          errorReason = `Thừa cột: Dòng có ${parts.length} cột (Yêu cầu đúng 3 cột: Video, Caption, Bình luận)`;
        } else if (!vPath) {
          isValid = false;
          errorReason = 'Đường dẫn video không được để trống';
        } else if (!cap) {
          isValid = false;
          errorReason = 'Caption không được để trống';
        }

        const filename = vPath.split(/[\\/]/).pop().trim();

        let videoStatus = 'checking';
        let statusMessage = '';
        let resolvedMediaId = null;
        let resolvedObjectKey = null;

        if (vPath.startsWith('https://') || vPath.startsWith('http://')) {
          videoStatus = 'remote_url';
          statusMessage = '✓ URL video trực tuyến hợp lệ';
        } else if (vPath.startsWith('r2://') || vPath.startsWith('d1://video/') || vPath.startsWith('med_')) {
          const cleanId = vPath.replace(/^r2:\/\//, '').replace(/^d1:\/\/video\//, '');
          const m = userMediaFiles.value.find(item => item.id === cleanId && item.upload_status === 'ready');
          if (m) {
            videoStatus = 'ready';
            statusMessage = `✓ Đã lưu trên R2 (${m.original_filename})`;
            resolvedMediaId = m.id;
            resolvedObjectKey = m.object_key;
          } else {
            videoStatus = 'missing';
            statusMessage = `⚠️ Chưa xác minh được video trên R2`;
          }
        } else {
          const m = userMediaFiles.value.find(item =>
            item.original_filename &&
            item.original_filename.toLowerCase() === filename.toLowerCase() &&
            item.upload_status === 'ready'
          );
          if (m) {
            videoStatus = 'ready';
            statusMessage = `✓ Đã lưu trên R2 (${m.original_filename})`;
            resolvedMediaId = m.id;
            resolvedObjectKey = m.object_key;
          } else {
            videoStatus = 'missing';
            statusMessage = `⚠️ Chưa có trên R2 (Cần file: ${filename})`;
          }
        }

        // MỖI LẦN THÊM HÀNG LOẠT DÙNG CHUNG 1 MỐC THỜI GIAN ĐĂNG CÙNG NHAU. KHÔNG CÓ MỐC THỨ 2.
        const sDate = bulkScheduleForm.value.schedule_date;
        const sTime = bulkScheduleForm.value.schedule_time;
        const selectedPages = pages.value.filter(p => p.is_selected);
        let assignedPage = null;
        if (selectedPages.length > 0) {
          assignedPage = selectedPages[validRowIndex % selectedPages.length];
        }
        validRowIndex++;

        parsed.push({
          row_index: i + 1,
          raw_line: rawLine,
          video_path: vPath,
          filename: filename,
          caption: cap,
          comment_text: comment,
          is_valid: isValid,
          error_reason: errorReason,
          video_status: videoStatus,
          status_message: statusMessage,
          resolved_media_id: resolvedMediaId,
          resolved_object_key: resolvedObjectKey,
          schedule_date: sDate,
          schedule_time: sTime,
          schedule_display: `${sDate} ${sTime}`,
          assigned_page_id: assignedPage ? assignedPage.facebook_page_id : null,
          assigned_page_name: assignedPage ? assignedPage.name : 'Chưa chọn Fanpage'
        });
      }

      return parsed;
    }

    const maxBulkTasksAllowed = computed(() => {
      const selected = pages.value.filter(p => p.is_selected);
      return Math.max(1, selected.length) * 10;
    });

    const isBulkOverLimit = computed(() => {
      return bulkParsedList.value.length > maxBulkTasksAllowed.value;
    });

    const bulkSharedScheduleDisplay = computed(() => {
      if (!bulkScheduleForm.value.schedule_date || !bulkScheduleForm.value.schedule_time) return '—';
      return `${bulkScheduleForm.value.schedule_date} ${bulkScheduleForm.value.schedule_time}`;
    });

    function handleBulkInputChanged() {
      bulkParsedList.value = parseBulkExcelData(bulkDataRaw.value);
    }

    function recalculateBulkExcelSchedules() {
      checkBulkSchedulePastWarning();
      const sDate = bulkScheduleForm.value.schedule_date;
      const sTime = bulkScheduleForm.value.schedule_time;
      const selectedPages = pages.value.filter(p => p.is_selected);
      let idx = 0;
      for (const item of bulkParsedList.value) {
        item.schedule_date = sDate;
        item.schedule_time = sTime;
        item.schedule_display = `${sDate} ${sTime}`;
        if (selectedPages.length > 0) {
          const assignedPage = selectedPages[idx % selectedPages.length];
          item.assigned_page_id = assignedPage.facebook_page_id;
          item.assigned_page_name = assignedPage.name;
        } else {
          item.assigned_page_id = null;
          item.assigned_page_name = 'Chưa chọn Fanpage';
        }
        idx++;
      }
    }

    function recheckBulkExcelVideoStatus() {
      for (const item of bulkParsedList.value) {
        const vPath = item.video_path || '';
        const filename = item.filename || '';
        if (vPath.startsWith('https://') || vPath.startsWith('http://')) {
          item.video_status = 'remote_url';
          item.status_message = '✓ URL video trực tuyến hợp lệ';
        } else {
          const cleanId = vPath.replace(/^r2:\/\//, '').replace(/^d1:\/\/video\//, '');
          const m = userMediaFiles.value.find(media =>
            (media.id === cleanId || (media.original_filename && media.original_filename.toLowerCase() === filename.toLowerCase())) &&
            media.upload_status === 'ready'
          );
          if (m) {
            item.video_status = 'ready';
            item.status_message = `✓ Đã lưu trên R2 (${m.original_filename})`;
            item.resolved_media_id = m.id;
            item.resolved_object_key = m.object_key;
          } else {
            item.video_status = 'missing';
            item.status_message = `⚠️ Chưa có trên R2 (Cần file: ${filename})`;
          }
        }
      }
    }

    function triggerBulkExcelFilePicker() {
      const fileInput = document.getElementById('bulk-excel-files-input');
      if (fileInput) {
        fileInput.value = '';
        fileInput.click();
      }
    }

    async function handleBulkExcelFilesSelected(event) {
      const files = event.target && event.target.files;
      if (!files || files.length === 0) return;

      isUploadingBulkExcelVideos.value = true;
      bulkExcelUploadProgress.value = { current: 0, total: files.length, filename: '' };

      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        bulkExcelUploadProgress.value.current = i + 1;
        bulkExcelUploadProgress.value.filename = file.name;

        try {
          // 1. Upload init
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
            failCount++;
            continue;
          }

          // 2. Stream
          const streamRes = await fetch(initData.upload_url, {
            method: 'PUT',
            headers: { 'Content-Type': file.type || 'video/mp4' },
            body: file
          });
          if (!streamRes.ok) {
            failCount++;
            continue;
          }

          // 3. Upload complete
          const compRes = await fetch('/api/media/upload-complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ media_id: initData.media_id })
          });
          if (compRes.ok) {
            successCount++;
          } else {
            failCount++;
          }
        } catch (err) {
          console.error("Lỗi upload video bulk:", err);
          failCount++;
        }
      }

      isUploadingBulkExcelVideos.value = false;
      await loadUserMediaFiles();
      recheckBulkExcelVideoStatus();

      if (successCount > 0) {
        showToast(`Đã tải lên và xác minh thành công ${successCount}/${files.length} file video trên Cloudflare R2!`, 'success');
      }
      if (failCount > 0) {
        showToast(`Có ${failCount} file video tải lên thất bại. Bạn có thể chọn lại file để tải lại.`, 'warning');
      }
    }

    async function handleBulkSubmit() {
      if (isSubmittingBulkTasks.value) return;

      if (bulkParsedList.value.length === 0) {
        showToast("Vui lòng dán dữ liệu các dòng từ Excel vào ô bên trên!", "warning");
        return;
      }

      const selected = pages.value.filter(p => p.is_selected);
      if (selected.length === 0) {
        showToast("Vui lòng tick chọn ít nhất 1 Fanpage ở danh sách bên trái trước khi thêm hàng loạt!", "warning");
        return;
      }

      const maxLimit = selected.length * 10;
      if (bulkParsedList.value.length > maxLimit) {
        showToast(`Bạn đang chọn ${selected.length} Fanpage, chỉ được dán tối đa ${maxLimit} task (10 task/page). Danh sách hiện có ${bulkParsedList.value.length} dòng. Vui lòng giảm bớt!`, "error");
        return;
      }

      if (bulkSchedulePastWarning.value) {
        showToast("Thời gian bắt đầu đặt lịch đã qua hoặc trùng hiện tại. Vui lòng chọn giờ trong tương lai!", "error");
        return;
      }

      const validRows = bulkParsedList.value.filter(item =>
        item.is_valid && item.video_path
      );

      if (validRows.length === 0) {
        showToast("Vui lòng kiểm tra lại dữ liệu, mỗi dòng cần có đường dẫn video!", "warning");
        return;
      }

      const assignPageIds = selected.map(p => p.facebook_page_id);

      isSubmittingBulkTasks.value = true;
      try {
        const payloadTasks = validRows.map((r, i) => ({
          video_path: r.resolved_media_id ? `r2://${r.resolved_media_id}` : r.video_path,
          media_id: r.resolved_media_id || undefined,
          object_key: r.resolved_object_key || undefined,
          caption: r.caption,
          comment_text: r.comment_text,
          schedule_date: bulkScheduleForm.value.schedule_date,
          schedule_time: bulkScheduleForm.value.schedule_time,
          facebook_page_id: r.assigned_page_id || selected[i % selected.length].facebook_page_id
        }));

        const res = await apiFetch('/api/tasks/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tasks: payloadTasks,
            assign_page_ids: assignPageIds,
            schedule_date: bulkScheduleForm.value.schedule_date,
            schedule_time: bulkScheduleForm.value.schedule_time,
            interval_minutes: 0
          })
        });

        const data = await res.json();
        if (res.ok) {
          const createdCount = data.inserted_count || payloadTasks.length;
          showToast(`Đã tạo thành công ${createdCount} task từ Excel!`, "success");

          if (validRows.length === bulkParsedList.value.length) {
            bulkDataRaw.value = '';
            bulkParsedList.value = [];
            showBulkTaskModal.value = false;
          } else {
            const remainingLines = bulkParsedList.value
              .filter(item => !item.is_valid || !item.video_path)
              .map(item => item.raw_line);
            bulkDataRaw.value = remainingLines.join('\n');
            handleBulkInputChanged();
            showToast(`Đã tạo ${createdCount} task hợp lệ. Giữ lại ${remainingLines.length} dòng lỗi để bạn kiểm tra.`, "info");
          }
          await loadAll();
        } else {
          showToast(data.detail || data.message || "Lỗi tạo task hàng loạt.", "error");
        }
      } catch (err) {
        showToast("Lỗi kết nối khi tạo task hàng loạt: " + err.message, "error");
      } finally {
        isSubmittingBulkTasks.value = false;
      }
    }

    // ==========================================
    // 8B. THÊM TASK CHO TỪNG FANPAGE (TỐI ĐA 4 TASK, CHIA ĐỀU SAU X TIẾNG)
    // ==========================================
    function openPageTasksModal(page) {
      if (!page) {
        if (pages.value.length === 0) {
          showToast("Chưa có Fanpage nào được kết nối để thêm task!", "warning");
          return;
        }
        page = pages.value[0];
      }
      pageTaskTargetPage.value = page;
      const defSlot = getVnNowParts(15);
      pageScheduleConfig.value = {
        start_date: defSlot.date,
        start_time: defSlot.time || '08:00',
        interval_hours: 4
      };
      pageSlots.value = [
        {
          id: 1,
          video_path: '',
          media_id: '',
          object_key: '',
          clean_filename: '',
          caption: '',
          comment_text: '',
          isUploading: false,
          schedule_date: defSlot.date,
          schedule_time: defSlot.time,
          schedule_display: `${defSlot.date} ${defSlot.time}`
        }
      ];
      recalculatePageSlotTimes();
      loadUserMediaFiles();
      showPageTasksModal.value = true;
    }

    function addPageSlot() {
      if (pageSlots.value.length >= 4) {
        showToast("Tối đa mỗi Fanpage được thêm 4 task trong một lần lên lịch!", "warning");
        return;
      }
      const nextId = pageSlots.value.length + 1;
      pageSlots.value.push({
        id: nextId,
        video_path: '',
        media_id: '',
        object_key: '',
        clean_filename: '',
        caption: '',
        comment_text: '',
        isUploading: false,
        schedule_date: '',
        schedule_time: '',
        schedule_display: ''
      });
      recalculatePageSlotTimes();
    }

    function removePageSlot(idx) {
      if (pageSlots.value.length <= 1) return;
      pageSlots.value.splice(idx, 1);
      recalculatePageSlotTimes();
    }

    function recalculatePageSlotTimes() {
      const sDate = (pageScheduleConfig.value.start_date || '').trim();
      const sTime = (pageScheduleConfig.value.start_time || '').trim();
      const intHours = Math.max(1, Number(pageScheduleConfig.value.interval_hours) || 4);
      if (!sDate || !sTime) return;

      const baseParsed = parseVnScheduleToUtc(sDate, sTime, { allowPast: true });
      if (!baseParsed.isValid || !baseParsed.scheduledAtUtc) return;

      const baseUtc = baseParsed.scheduledAtUtc;
      pageSlots.value.forEach((slot, idx) => {
        const slotUtc = baseUtc + idx * intHours * 3600;
        const vnSlot = formatUtcToVn(slotUtc);
        slot.schedule_date = vnSlot.schedule_date;
        slot.schedule_time = vnSlot.schedule_time;
        slot.schedule_display = `${vnSlot.schedule_date} ${vnSlot.schedule_time}`;
      });
    }

    function setPageScheduleDatePreset(offsetDays) {
      const targetUtc = Date.now() + offsetDays * 86400 * 1000;
      const vnTarget = formatUtcToVn(Math.floor(targetUtc / 1000));
      pageScheduleConfig.value.start_date = vnTarget.schedule_date;
      recalculatePageSlotTimes();
    }

    function setPageScheduleTimePreset(timeStr) {
      pageScheduleConfig.value.start_time = timeStr;
      recalculatePageSlotTimes();
    }

    function setPageScheduleIntervalHours(hours) {
      pageScheduleConfig.value.interval_hours = hours;
      recalculatePageSlotTimes();
    }

    function triggerPageSlotFilePicker(slotId) {
      isUploadingPageSlotVideo.value = slotId;
      const input = document.getElementById('page-slot-file-input');
      if (input) {
        input.value = '';
        input.click();
      }
    }

    async function handlePageSlotFileSelected(e) {
      const file = e.target.files && e.target.files[0];
      if (!file || !isUploadingPageSlotVideo.value) return;
      const slotId = isUploadingPageSlotVideo.value;
      const targetSlot = pageSlots.value.find(s => s.id === slotId);
      if (!targetSlot) return;

      targetSlot.isUploading = true;
      try {
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
        if (!initRes.ok) throw new Error(initData.detail || "Không thể khởi tạo upload R2");

        const chunkRes = await fetch(`/api/media/upload-chunk?media_id=${encodeURIComponent(initData.media_id)}&chunk_index=0&total_chunks=1`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file
        });
        if (!chunkRes.ok) throw new Error("Lỗi tải dữ liệu video lên R2");

        const compRes = await fetch('/api/media/upload-complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ media_id: initData.media_id })
        });
        if (!compRes.ok) throw new Error("Không thể xác minh video trên R2");

        targetSlot.media_id = initData.media_id;
        targetSlot.object_key = initData.object_key;
        targetSlot.video_path = `r2://${initData.media_id}`;
        targetSlot.clean_filename = file.name;
        showToast(`Đã tải lên R2 thành công: ${file.name}`, 'success');
        await loadUserMediaFiles();
      } catch (err) {
        showToast(err.message || "Lỗi tải video lên R2", "error");
      } finally {
        targetSlot.isUploading = false;
        isUploadingPageSlotVideo.value = null;
      }
    }

    function selectExistingR2ForPageSlot(slot, mediaItem) {
      if (!slot || !mediaItem) return;
      slot.media_id = mediaItem.id;
      slot.object_key = mediaItem.object_key;
      slot.video_path = `r2://${mediaItem.id}`;
      slot.clean_filename = mediaItem.original_filename || mediaItem.object_key;
    }

    async function handlePageTasksSubmit() {
      if (isSubmittingPageTasks.value) return;
      if (!pageTaskTargetPage.value) {
        showToast("Chưa chọn Fanpage để thêm task!", "warning");
        return;
      }

      for (let i = 0; i < pageSlots.value.length; i++) {
        const slot = pageSlots.value[i];
        if (!slot.video_path || !slot.video_path.trim()) {
          showToast(`Bài #${i + 1}: Vui lòng chọn hoặc tải video lên R2!`, "warning");
          return;
        }
        if (!slot.caption || !slot.caption.trim()) {
          showToast(`Bài #${i + 1}: Caption không được để trống!`, "warning");
          return;
        }
      }

      isSubmittingPageTasks.value = true;
      try {
        const payloadTasks = pageSlots.value.map(slot => ({
          video_path: slot.media_id ? `r2://${slot.media_id}` : slot.video_path,
          media_id: slot.media_id || undefined,
          object_key: slot.object_key || undefined,
          caption: slot.caption,
          comment_text: slot.comment_text,
          facebook_page_id: pageTaskTargetPage.value.facebook_page_id,
          schedule_date: slot.schedule_date,
          schedule_time: slot.schedule_time
        }));

        const res = await apiFetch('/api/tasks/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tasks: payloadTasks,
            assign_page_ids: [pageTaskTargetPage.value.facebook_page_id]
          })
        });

        const data = await res.json();
        if (res.ok) {
          showToast(`Đã tạo thành công ${payloadTasks.length} task cho Fanpage "${pageTaskTargetPage.value.name}"!`, "success");
          showPageTasksModal.value = false;
          await loadTasks();
          await loadSystemStats();
        } else {
          showToast(data.detail || data.message || "Lỗi khi lên lịch cho Fanpage.", "error");
        }
      } catch (err) {
        showToast(err.message || "Lỗi mạng khi lên lịch.", "error");
      } finally {
        isSubmittingPageTasks.value = false;
      }
    }

    // ==========================================
    // 9. TASK ACTIONS (EDIT, RESET, DELETE, LOG) & LOCK GUARDS
    // ==========================================
    function openEditTaskModal(t) {
      if (isTaskLocked(t)) {
        showToast(
          "Task này đã đăng Reels thành công. Dữ liệu đăng đã được khóa để bảo toàn lịch sử. Bạn vẫn có thể xem thông tin và thống kê bài đăng.",
          "warning"
        );
        return;
      }
      if (isTaskInFlight(t)) {
        showToast("Task đang trong tiến trình đăng Reels, không thể chỉnh sửa lúc này.", "warning");
        return;
      }
      const defSched = getVnNowParts(15);
      editTaskForm.value = {
        id: t.id,
        facebook_page_id: t.facebook_page_id || '',
        video_path: t.video_path || '',
        caption: t.caption || '',
        comment_text: t.comment_text || '',
        schedule_date: t.schedule_date || defSched.date,
        schedule_time: t.schedule_time || defSched.time
      };
      showEditTaskModal.value = true;
    }

    async function handleUpdateTaskSubmit() {
      const targetTask = tasks.value.find(x => x.id === editTaskForm.value.id);
      if (targetTask && isTaskLocked(targetTask)) {
        showToast("Task này đã đăng Reels thành công. Dữ liệu đăng đã được khóa để bảo toàn lịch sử.", "error");
        showEditTaskModal.value = false;
        return;
      }
      const val = validateVnScheduleClient(
        editTaskForm.value.schedule_date,
        editTaskForm.value.schedule_time,
        true
      );
      if (!val.valid) {
        showToast(val.error, "error");
        return;
      }
      editTaskForm.value.schedule_date = val.normalizedDate;
      editTaskForm.value.schedule_time = val.normalizedTime;

      try {
        const payload = {
          facebook_page_id: editTaskForm.value.facebook_page_id,
          video_path: editTaskForm.value.video_path.trim(),
          caption: editTaskForm.value.caption || "",
          comment_text: editTaskForm.value.comment_text || "",
          schedule_date: editTaskForm.value.schedule_date,
          schedule_time: editTaskForm.value.schedule_time
        };
        const res = await apiFetch(`/api/tasks/${editTaskForm.value.id}`, {
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

    async function handlePublishSingleTaskNow(t) {
      if (!t || !t.id || publishingNowTaskId.value) return;
      if (isTaskLocked(t)) {
        showToast("Task này đã đăng thành công và đã được khóa, không thể đăng lại.", "warning");
        return;
      }
      if (isTaskInFlight(t)) {
        showToast("Task đang trong tiến trình đăng Reels.", "warning");
        return;
      }
      publishingNowTaskId.value = t.id;
      try {
        const res = await apiFetch(`/api/tasks/${t.id}/publish-now`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast(data.message || `Đã cập nhật lịch về hiện tại và đưa Task #${t.id} vào hàng đợi xuất bản ngay!`, "success");
          await Promise.allSettled([loadTasks(), loadStats()]);
        } else {
          showToast(data.detail || data.message || "Không thể đăng ngay task này.", "error");
          await loadTasks();
        }
      } catch (err) {
        showToast("Lỗi khi gửi lệnh Đăng ngay: " + err.message, "error");
      } finally {
        publishingNowTaskId.value = null;
      }
    }

    function selectAllFilteredTasks() {
      selectedTaskIds.value = tasks.value
        .filter(t => !isTaskLocked(t) && !isTaskInFlight(t))
        .map(t => t.id);
    }

    function openBulkPublishConfirmModal() {
      if (selectedTaskIds.value.length === 0) {
        showToast("Vui lòng chọn ít nhất một task để đăng ngay.", "warning");
        return;
      }
      showBulkPublishModal.value = true;
    }

    async function confirmBulkPublishNow() {
      if (isBulkPublishingTasks.value) return;
      const eligibleIds = bulkPublishPreview.value.eligible.map(t => t.id);
      if (eligibleIds.length === 0) {
        showToast("Không có task nào hợp lệ để đăng ngay.", "warning");
        showBulkPublishModal.value = false;
        return;
      }
      isBulkPublishingTasks.value = true;
      try {
        const res = await apiFetch('/api/tasks/bulk-publish-now', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task_ids: selectedTaskIds.value })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast(data.message || `Đã đưa ${data.eligible_count} task vào hàng đợi Đăng ngay!`, "success");
          showBulkPublishModal.value = false;
          selectedTaskIds.value = [];
          await Promise.allSettled([loadTasks(), loadStats()]);
        } else {
          showToast(data.detail || data.message || "Không thể đăng ngay các task đã chọn.", "error");
          await loadTasks();
        }
      } catch (err) {
        showToast("Lỗi khi đăng ngay hàng loạt: " + err.message, "error");
      } finally {
        isBulkPublishingTasks.value = false;
      }
    }

    function openBulkRescheduleModal() {
      if (selectedTaskIds.value.length === 0) {
        showToast("Vui lòng chọn ít nhất một task để đổi lịch đăng.", "warning");
        return;
      }
      const nextSlot = getVnNowParts(15);
      bulkRescheduleForm.value = {
        schedule_date: nextSlot.date,
        schedule_time: nextSlot.time,
        interval_minutes: selectedTaskIds.value.length > 1 ? 10 : 0
      };
      showBulkRescheduleModal.value = true;
    }

    function setBulkRescheduleRelativePreset(offsetMinutes = 5) {
      const slot = getVnNowParts(offsetMinutes);
      bulkRescheduleForm.value.schedule_date = slot.date;
      bulkRescheduleForm.value.schedule_time = slot.time;
    }

    async function handleBulkRescheduleSubmit() {
      if (isBulkReschedulingTasks.value) return;
      const val = validateVnScheduleClient(
        bulkRescheduleForm.value.schedule_date,
        bulkRescheduleForm.value.schedule_time,
        true
      );
      if (!val.valid) {
        showToast(val.error, "error");
        return;
      }
      isBulkReschedulingTasks.value = true;
      try {
        const res = await apiFetch('/api/tasks/bulk-reschedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task_ids: selectedTaskIds.value,
            schedule_date: val.normalizedDate,
            schedule_time: val.normalizedTime,
            interval_minutes: Number(bulkRescheduleForm.value.interval_minutes) || 0
          })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast(data.message || `Đã cập nhật lịch đăng mới cho ${data.updated_count} task!`, "success");
          showBulkRescheduleModal.value = false;
          selectedTaskIds.value = [];
          await Promise.allSettled([loadTasks(), loadStats()]);
        } else {
          showToast(data.detail || data.message || "Không thể đổi lịch các task đã chọn.", "error");
        }
      } catch (err) {
        showToast("Lỗi khi đổi lịch hàng loạt: " + err.message, "error");
      } finally {
        isBulkReschedulingTasks.value = false;
      }
    }

    async function handleBulkCancelSelectedTasks() {
      if (isBulkCancellingTasks.value || selectedTaskIds.value.length === 0) return;
      if (!confirm(`Bạn có chắc chắn muốn hủy lịch chờ đăng của ${selectedTaskIds.value.length} task đã chọn không?`)) {
        return;
      }
      isBulkCancellingTasks.value = true;
      try {
        const res = await apiFetch('/api/tasks/bulk-cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task_ids: selectedTaskIds.value })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast(data.message || `Đã hủy lịch ${data.cancelled_count} task.`, "success");
          selectedTaskIds.value = [];
          await Promise.allSettled([loadTasks(), loadStats()]);
        } else {
          showToast(data.detail || data.message || "Không thể hủy lịch các task đã chọn.", "error");
        }
      } catch (err) {
        showToast("Lỗi khi hủy lịch hàng loạt: " + err.message, "error");
      } finally {
        isBulkCancellingTasks.value = false;
      }
    }

    async function handleResetTask(taskId) {
      const targetTask = tasks.value.find(x => x.id === taskId);
      if (targetTask && isTaskLocked(targetTask)) {
        showToast("Task đã đăng Reels thành công và không thể đặt lại trạng thái chờ.", "warning");
        return;
      }
      try {
        const res = await apiFetch(`/api/tasks/${taskId}/reset`, { method: 'POST' });
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

        const isSyncingPagePosts = ref(false);
    const newCommentInput = ref('');
    const isSendingNewComment = ref(false);

    async function syncPagePosts(page) {
      if (!page || !page.facebook_page_id) return;
      if (isSyncingPagePosts.value) return;
      isSyncingPagePosts.value = true;
      try {
        const res = await apiFetch(`/api/pages/${encodeURIComponent(page.facebook_page_id)}/sync-posts`, {
          method: 'POST'
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          showToast(data.message || `Đã đồng bộ thành công ${data.synced_count || 0} bài viết từ Fanpage ${page.name}!`, 'success');
          await loadTasks();
          await loadFacebookPosts();
        } else {
          showToast(data.detail || data.message || 'Không thể đồng bộ bài viết từ Fanpage.', 'error');
        }
      } catch (err) {
        showToast('Lỗi kết nối khi đồng bộ bài viết.', 'error');
      } finally {
        isSyncingPagePosts.value = false;
      }
    }

    async function handleSendNewComment(task) {
      if (!task || !task.id) return;
      const msg = (newCommentInput.value || '').trim();
      if (!msg) {
        showToast('Vui lòng nhập nội dung bình luận!', 'warning');
        return;
      }
      isSendingNewComment.value = true;
      try {
        const res = await apiFetch(`/api/tasks/${task.id}/comment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          showToast('Đã đăng bình luận thành công lên bài viết Facebook!', 'success');
          task.comment_text = msg;
          task.comment_status = 'success';
          task.comment_id = data.comment_id;
          newCommentInput.value = '';
          await loadTasks();
        } else {
          showToast(data.detail || 'Không thể gửi bình luận lên Facebook.', 'error');
        }
      } catch (err) {
        showToast('Lỗi kết nối khi gửi bình luận.', 'error');
      } finally {
        isSendingNewComment.value = false;
      }
    }

async function handleDeleteTask(taskId) {
      const targetTask = tasks.value.find(x => x.id === taskId);
      if (targetTask && isTaskInFlight(targetTask)) {
        showToast("Bài viết đang được đăng lên Facebook. Vui lòng chờ hoàn tất!", "warning");
        return;
      }

      let deleteFb = false;
      if (targetTask && targetTask.status === 'success' && (targetTask.video_id || targetTask.post_id)) {
        const ok = confirm("Bài viết này đã được đăng lên Facebook.\n\n• Bấm OK: Xóa bài viết trên Facebook VÀ xóa khỏi hệ thống.\n• Bấm Cancel (Hủy): Không xóa.");
        if (!ok) return;
        deleteFb = true;
      } else {
        if (!confirm("Bạn có chắc chắn muốn xóa bài viết này không?")) return;
      }

      try {
        const delUrl = deleteFb ? `/api/tasks/${taskId}?delete_facebook=true` : `/api/tasks/${taskId}?force=true`;
        const res = await apiFetch(delUrl, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          const msg = deleteFb ? "Đã xóa bài viết trên Facebook và khỏi hệ thống!" : "Đã xóa bài viết thành công!";
          showToast(msg, "success");
          selectedTaskIds.value = selectedTaskIds.value.filter(id => id !== taskId);
          if (showLogModal.value && currentLogTask.value && currentLogTask.value.id === taskId) {
            showLogModal.value = false;
          }
          await loadTasks();
          await loadStats();
        } else {
          showToast(data.detail || "Không thể xóa bài viết.", "error");
        }
      } catch (err) {
        showToast("Lỗi xóa bài viết: " + (err.message || err), "error");
      }
    }

    function toggleSelectAllTasks() {
      if (isAllTasksSelected.value) {
        selectedTaskIds.value = [];
      } else {
        selectedTaskIds.value = tasks.value
          .filter(t => !isTaskLocked(t) && !isTaskInFlight(t))
          .map(t => t.id);
      }
    }

    function toggleTaskSelection(taskId) {
      const targetTask = tasks.value.find(x => x.id === taskId);
      if (targetTask && (isTaskLocked(targetTask) || isTaskInFlight(targetTask))) {
        showToast("Task đã đăng thành công hoặc đang chạy không thể chọn để xóa.", "warning");
        return;
      }
      const idx = selectedTaskIds.value.indexOf(taskId);
      if (idx > -1) {
        selectedTaskIds.value.splice(idx, 1);
      } else {
        selectedTaskIds.value.push(taskId);
      }
    }

    function clearSelectedTasks() {
      selectedTaskIds.value = [];
    }

    async function handleBulkDeleteSelectedTasks() {
      const mutableIds = selectedTaskIds.value.filter(id => {
        const t = tasks.value.find(x => x.id === id);
        return t && !isTaskLocked(t) && !isTaskInFlight(t);
      });
      if (mutableIds.length === 0) {
        showToast("Các task đã đăng thành công đã được khóa và không thể xóa.", "warning");
        selectedTaskIds.value = [];
        return;
      }
      const count = mutableIds.length;
      if (!confirm(`Bạn có chắc chắn muốn xóa ${count} task đã chọn không?\n(Task đã đăng thành công sẽ được bảo vệ không bị xóa)`)) {
        return;
      }
      isBulkDeletingTasks.value = true;
      try {
        const res = await apiFetch('/api/tasks/bulk-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task_ids: mutableIds })
        });
        const data = await res.json();
        if (res.ok) {
          showToast(`Đã xóa thành công ${data.deleted_count || count} task.`, 'success');
          const deletedSet = new Set(mutableIds);
          tasks.value = tasks.value.filter(t => !deletedSet.has(t.id));
          selectedTaskIds.value = [];
          await loadStats();
          await loadTasks();
        } else {
          showToast(data.detail || 'Không thể xóa các task đã chọn.', 'error');
        }
      } catch (err) {
        showToast('Lỗi khi xóa hàng loạt: ' + err.message, 'error');
      } finally {
        isBulkDeletingTasks.value = false;
      }
    }

    function formatFriendlyLog(t) {
      if (!t) return '';
      const raw = (t.log || t.error_message || '').trim();
      const st = t.status || '';

      if (st === 'success') {
        if (t.comment_status === 'failed') {
          return 'Đã đăng Reels (Bình luận lỗi)';
        }
        if (t.comment_status === 'success') {
          return 'Đã đăng Reels (Đã bình luận)';
        }
        return 'Đã đăng Reels thành công!';
      }

      if (st === 'running' || st === 'processing') {
        if (raw.includes('chuẩn bị')) return 'Đang chuẩn bị video...';
        if (raw.includes('tải') || raw.includes('rupload')) return 'Đang tải video lên Facebook...';
        if (raw.includes('xuất bản') || raw.includes('finish')) return 'Đang xuất bản thước phim...';
        return raw || 'Đang đăng Reels lên Facebook...';
      }

      if (st === 'queued') {
        return 'Đang trong hàng đợi đăng...';
      }

      if (st === 'scheduled' || st === 'pending') {
        if (raw.startsWith('Đang chờ đến giờ hẹn') || raw.startsWith('Chưa đến thời gian')) {
          return raw;
        }
        if (t.schedule_date || t.schedule_time) {
          return `Hẹn giờ đăng: ${t.schedule_date || ''} ${t.schedule_time || ''}`;
        }
        return 'Chờ bấm Đăng Reels';
      }

      if (st === 'cancelled') {
        return 'Đã hủy đăng';
      }

      if (st === 'failed') {
        if (raw.includes('Session has expired') || raw.includes('Error validating access token') || raw.includes('190')) {
          return 'Phiên Facebook hết hạn, vui lòng kết nối lại tài khoản';
        }
        if (raw.includes('CREATE_CONTENT') || raw.includes('không có quyền')) {
          return 'Fanpage thiếu quyền tạo Reels';
        }
        if (raw.includes('E_FILE_NOT_FOUND') || raw.includes('không tìm thấy')) {
          return 'Không tìm thấy file video';
        }
        return raw.replace(/https?:\/\/[^\s]+/g, '').replace(/video_id=[^\s,)]+/g, '').trim() || 'Lỗi đăng Reels';
      }

      return raw;
    }

    async function openLogModal(t) {
      if (!t) return;
      const friendly = formatFriendlyLog(t);
      currentLogTask.value = {
        id: t.id,
        status: t.status,
        title: `Chi tiết Task #${t.id} – ${t.page_name || 'Fanpage'}`,
        page_name: t.page_name || t.profile_name || 'Chưa gán Page',
        facebook_page_id: t.facebook_page_id || '',
        video_path: t.video_path || '',
        clean_filename: getCleanFileName(t),
        caption: t.caption || '',
        comment_text: t.comment_text || '',
        schedule_date: t.schedule_date || '',
        schedule_time: t.schedule_time || '',
        done_time: t.done_time || '',
        friendlyLog: friendly,
        log: t.log || t.error_message || '(Chưa có thông điệp log)',
        video_id: t.video_id || '',
        post_id: t.post_id || '',
        video_url: t.video_url || '',
        comment_status: t.comment_status || 'none',
        comment_id: t.comment_id || '',
        comment_log: t.comment_log || '',
        audit_logs: []
      };
      showLogModal.value = true;
      try {
        const [logsRes, auditRes] = await Promise.allSettled([
          apiFetch(`/api/tasks/${t.id}/logs`),
          apiFetch(`/api/tasks/${t.id}/audit-logs`)
        ]);
        if (logsRes.status === 'fulfilled' && logsRes.value.ok) {
          const data = await logsRes.value.json();
          if (Array.isArray(data.logs) && data.logs.length > 0) {
            const historyLines = data.logs.map(
              l => `[${l.created_at}] [${l.level}] (${l.stage}) ${l.message}`
            );
            currentLogTask.value.log =
              `${t.log || ''}\n\n--- LỊCH SỬ GIAI ĐOẠN (QUEUE & GRAPH API) ---\n` +
              historyLines.join('\n');
          }
        }
        if (auditRes.status === 'fulfilled' && auditRes.value.ok) {
          const aData = await auditRes.value.json();
          if (Array.isArray(aData.audit_logs)) {
            currentLogTask.value.audit_logs = aData.audit_logs;
          }
        }
      } catch (e) {
        // Giữ nguyên log tóm tắt nếu không lấy được chi tiết
      }
    }

    const openTaskDetailModal = openLogModal;

    async function handleRetryComment(taskId) {
      if (!taskId || retryingCommentTaskId.value) return;
      retryingCommentTaskId.value = taskId;
      try {
        const res = await apiFetch(`/api/tasks/${taskId}/retry-comment`, {
          method: 'POST'
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast(data.message || "Đã đăng bình luận thành công!", "success");
          await loadTasks();
          if (showLogModal.value && currentLogTask.value.id === taskId) {
            const updated = tasks.value.find(t => t.id === taskId);
            if (updated) {
              currentLogTask.value = {
                ...currentLogTask.value,
                comment_status: updated.comment_status,
                comment_id: updated.comment_id,
                comment_log: updated.comment_log,
                log: updated.log
              };
            }
          }
        } else {
          showToast(data.detail || data.message || "Lỗi khi thử đăng lại bình luận.", "error");
          await loadTasks();
          if (showLogModal.value && currentLogTask.value.id === taskId) {
            const updated = tasks.value.find(t => t.id === taskId);
            if (updated) {
              currentLogTask.value = {
                ...currentLogTask.value,
                comment_status: updated.comment_status,
                comment_log: updated.comment_log
              };
            }
          }
        }
      } catch (err) {
        showToast("Lỗi kết nối khi thử đăng lại bình luận: " + err.message, "error");
      } finally {
        retryingCommentTaskId.value = null;
      }
    }

    // ==========================================
    // 9B. THỐNG KÊ REELS (META INSIGHTS v27.0)
    // ==========================================
    function formatMetricValue(val) {
      if (val === null || val === undefined || Number.isNaN(Number(val))) {
        return 'Không có dữ liệu';
      }
      return Number(val).toLocaleString('vi-VN');
    }

    function formatMetricNumber(val) {
      if (val === null || val === undefined || Number.isNaN(Number(val))) {
        return '—';
      }
      return Number(val).toLocaleString('vi-VN');
    }

    function formatDurationMs(ms) {
      if (ms === null || ms === undefined || Number.isNaN(Number(ms))) {
        return 'Không có dữ liệu';
      }
      const totalSeconds = Math.round(Number(ms) / 1000);
      if (totalSeconds <= 0) return '0s';
      const hours = Math.floor(totalSeconds / 3600);
      const mins = Math.floor((totalSeconds % 3600) / 60);
      const secs = totalSeconds % 60;
      if (hours > 0) {
        return `${hours}h ${mins}p ${secs}s`;
      }
      if (mins > 0) {
        return `${mins}p ${secs}s`;
      }
      return `${secs}s`;
    }

    function formatVnDateTime(isoStr) {
      if (!isoStr) return '—';
      try {
        const d = new Date(isoStr);
        if (isNaN(d.getTime())) return String(isoStr);
        return d.toLocaleString('vi-VN', {
          timeZone: 'Asia/Ho_Chi_Minh',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        });
      } catch {
        return String(isoStr);
      }
    }

    function calcChartBarWidth(val, maxVal) {
      const n = Number(val || 0);
      const m = Number(maxVal || 1);
      if (n <= 0 || m <= 0) return 0;
      return Math.min(100, Math.max(4, Math.round((n / m) * 100)));
    }

    async function loadReelsInsights() {
      if (authState.value !== 'authenticated') return false;
      isLoadingInsights.value = true;
      try {
        const params = new URLSearchParams();
        if (insightsFilter.value.facebook_page_id) {
          params.append('facebook_page_id', insightsFilter.value.facebook_page_id);
        }
        if (insightsFilter.value.range) {
          params.append('range', insightsFilter.value.range);
        }
        if (insightsFilter.value.range === 'custom') {
          if (insightsFilter.value.start_date) params.append('start_date', insightsFilter.value.start_date);
          if (insightsFilter.value.end_date) params.append('end_date', insightsFilter.value.end_date);
        }
        if ((insightsFilter.value.search || '').trim()) {
          params.append('search', insightsFilter.value.search.trim());
        }
        if (insightsFilter.value.sort_by) {
          params.append('sort_by', insightsFilter.value.sort_by);
        }
        if (insightsFilter.value.sort_dir) {
          params.append('sort_dir', insightsFilter.value.sort_dir);
        }

        const res = await apiFetch(`/api/insights/reels?${params.toString()}`, {
          abortKey: 'loadReelsInsights',
          timeoutMs: 15000
        });
        if (res.ok) {
          const data = await res.json();
          insightsData.value = {
            overview: data.overview || insightsData.value.overview,
            charts: data.charts || insightsData.value.charts,
            reels: Array.isArray(data.reels) ? data.reels : [],
            permission_warnings: Array.isArray(data.permission_warnings) ? data.permission_warnings : [],
            last_synced_at: data.last_synced_at || null
          };
          return true;
        }
      } catch (err) {
        if (!err || err.name !== 'AbortError') {
          console.error("Lỗi tải thống kê Reels:", err);
        }
      } finally {
        isLoadingInsights.value = false;
      }
      return false;
    }

    async function handleSyncAllInsights() {
      if (isSyncingInsights.value) return;
      isSyncingInsights.value = true;
      try {
        const res = await apiFetch('/api/insights/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            facebook_page_id: insightsFilter.value.facebook_page_id || null,
            limit: 20
          }),
          timeoutMs: 30000
        });
        const data = await res.json();
        if (res.ok) {
          showToast(data.message || 'Đã đồng bộ số liệu thống kê từ Meta!', data.success ? 'success' : 'warning');
          await Promise.allSettled([loadReelsInsights(), loadAccounts(), loadPages()]);
        } else {
          showToast(data.detail || data.message || 'Không thể đồng bộ thống kê.', 'error');
        }
      } catch (err) {
        showToast('Lỗi đồng bộ thống kê: ' + (err.message || 'Mạng không ổn định'), 'error');
      } finally {
        isSyncingInsights.value = false;
      }
    }

    async function handleSyncSingleReelInsight(taskId) {
      if (!taskId || syncingTaskInsightId.value) return;
      syncingTaskInsightId.value = taskId;
      try {
        const res = await apiFetch(`/api/tasks/${taskId}/sync-insights`, {
          method: 'POST',
          timeoutMs: 20000
        });
        const data = await res.json();
        if (res.ok) {
          showToast(data.message || 'Đã cập nhật chỉ số Reels!', data.success ? 'success' : 'warning');
          await loadReelsInsights();
          if (showReelInsightModal.value && reelInsightDetail.value.task && reelInsightDetail.value.task.id === taskId) {
            await openReelInsightModal(taskId);
          }
        } else {
          showToast(data.detail || data.message || 'Không thể làm mới chỉ số Reels.', 'error');
        }
      } catch (err) {
        showToast('Lỗi làm mới chỉ số: ' + err.message, 'error');
      } finally {
        syncingTaskInsightId.value = null;
      }
    }

    async function openReelInsightModal(taskId) {
      if (!taskId) return;
      showReelInsightModal.value = true;
      isLoadingReelDetail.value = true;
      try {
        const res = await apiFetch(`/api/insights/reels/${taskId}`, {
          timeoutMs: 15000
        });
        if (res.ok) {
          const data = await res.json();
          reelInsightDetail.value = {
            task: data.task || null,
            latest_snapshot: data.latest_snapshot || null,
            metric_items: Array.isArray(data.metric_items) ? data.metric_items : [],
            history: Array.isArray(data.history) ? data.history : []
          };
        } else {
          const errData = await res.json().catch(() => ({}));
          showToast(errData.detail || 'Không thể tải chi tiết thống kê bài đăng.', 'error');
        }
      } catch (err) {
        showToast('Lỗi tải chi tiết thống kê: ' + err.message, 'error');
      } finally {
        isLoadingReelDetail.value = false;
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

    function getFirstLine(str) {
      if (!str) return '';
      const lines = String(str).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      return lines.length > 0 ? lines[0] : '';
    }

    function getCleanFileName(t) {
      if (!t) return '—';
      const pathStr = typeof t === 'string' ? t : (t.video_path || '');
      const mediaId = typeof t === 'object' ? t.media_id : null;
      if (userMediaFiles.value && userMediaFiles.value.length > 0) {
        const found = userMediaFiles.value.find(m => (mediaId && m.id === mediaId) || (pathStr && (m.object_key === pathStr || pathStr.includes(m.object_key))));
        if (found && found.original_filename) return found.original_filename;
      }
      if (!pathStr) return '—';
      const raw = pathStr.split('\\').pop().split('/').pop();
      if (raw.startsWith('med_') && raw.length > 25) {
        return '🎬 Video R2';
      }
      return raw;
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
    // 10B. QUẢN LÝ BÀI VIẾT FACEBOOK & BÌNH LUẬN (POSTS & COMMENTS MANAGER)
    // ==========================================
    async function loadFacebookPosts() {
      isLoadingPosts.value = true;
      try {
        const params = new URLSearchParams();
        if (postsFilter.value.page_id) params.append('page_id', postsFilter.value.page_id);
        if (postsFilter.value.post_type && postsFilter.value.post_type !== 'all') params.append('post_type', postsFilter.value.post_type);
        if (postsFilter.value.source && postsFilter.value.source !== 'all') params.append('source', postsFilter.value.source);
        if ((postsFilter.value.search || '').trim()) params.append('search', postsFilter.value.search.trim());
        if (postsFilter.value.start_date) params.append('start_date', postsFilter.value.start_date);
        if (postsFilter.value.end_date) params.append('end_date', postsFilter.value.end_date);
        params.append('page', String(postsPage.value));
        params.append('limit', String(postsLimit.value));

        const res = await apiFetch(`/api/posts?${params.toString()}`);
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          posts.value = data.posts || [];
          totalPosts.value = data.total || 0;
          postsTotalPages.value = data.total_pages || 1;
          pageSyncStates.value = data.sync_states || {};
        }
      } catch (err) {
        console.error("Lỗi tải bài viết:", err);
      } finally {
        isLoadingPosts.value = false;
      }
    }

    async function handleSyncPagePosts(targetPageId = null) {
      const pageId = targetPageId || postsFilter.value.page_id || (pages.value[0] && pages.value[0].facebook_page_id);
      if (!pageId) {
        showToast("Vui lòng chọn Fanpage cần đồng bộ bài viết.", "warning");
        return;
      }
      isSyncingPagePosts.value = true;
      showToast("Đang đồng bộ bài viết từ Fanpage qua Meta Graph API...", "info");
      try {
        const res = await apiFetch(`/api/pages/${encodeURIComponent(pageId)}/sync-posts`, {
          method: 'POST',
          body: JSON.stringify({ limit: 30 })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          showToast(data.message || `Đồng bộ thành công ${data.synced_count || 0} bài viết!`, "success");
          await loadFacebookPosts();
        } else {
          showToast(data.detail || data.message || "Không thể đồng bộ bài viết từ Fanpage.", "error");
        }
      } catch (err) {
        showToast(err?.message || "Lỗi đồng bộ bài viết.", "error");
      } finally {
        isSyncingPagePosts.value = false;
      }
    }

    async function handleLoadMoreOldPosts(targetPageId = null) {
      const pageId = targetPageId || postsFilter.value.page_id || (pages.value[0] && pages.value[0].facebook_page_id);
      if (!pageId) return;
      const st = pageSyncStates.value[pageId];
      if (!st || !st.next_cursor) {
        showToast("Đã lấy hết toàn bộ bài viết trên Facebook của Fanpage này.", "info");
        return;
      }
      isSyncingPagePosts.value = true;
      showToast("Đang tải thêm trang bài viết cũ tiếp theo...", "info");
      try {
        const res = await apiFetch(`/api/pages/${encodeURIComponent(pageId)}/sync-posts`, {
          method: 'POST',
          body: JSON.stringify({ cursor: st.next_cursor, limit: 30 })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          showToast(data.message || `Đã lấy thêm ${data.synced_count || 0} bài viết cũ!`, "success");
          await loadFacebookPosts();
        } else {
          showToast(data.detail || data.message || "Lỗi tải bài viết cũ.", "error");
        }
      } catch (e) {
        showToast(e?.message || "Lỗi tải bài viết cũ.", "error");
      } finally {
        isSyncingPagePosts.value = false;
      }
    }

    async function openPostDetail(post) {
      selectedPost.value = post;
      isPostDetailOpen.value = true;
      isLoadingPostDetail.value = true;
      postComments.value = [];
      postAuditLogs.value = [];
      try {
        const res = await apiFetch(`/api/posts/${encodeURIComponent(post.post_id)}`);
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          selectedPost.value = data.post || post;
          postComments.value = data.comments || [];
          postAuditLogs.value = data.audit_logs || [];
        }
      } catch (e) {
        console.error("Lỗi lấy chi tiết bài viết:", e);
      } finally {
        isLoadingPostDetail.value = false;
      }
    }

    function closePostDetail() {
      isPostDetailOpen.value = false;
      selectedPost.value = null;
      postComments.value = [];
      postAuditLogs.value = [];
    }

    function openEditPostModal(post) {
      selectedPost.value = post;
      editPostCaptionText.value = post.message || '';
      isEditPostModalOpen.value = true;
    }

    async function handleSavePostEdit() {
      if (!selectedPost.value) return;
      isSavingPostEdit.value = true;
      try {
        const res = await apiFetch(`/api/posts/${encodeURIComponent(selectedPost.value.post_id)}`, {
          method: 'PUT',
          body: JSON.stringify({ message: editPostCaptionText.value })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          showToast("Đã cập nhật bài viết thành công!", "success");
          isEditPostModalOpen.value = false;
          await loadFacebookPosts();
          if (isPostDetailOpen.value) {
            await openPostDetail(selectedPost.value);
          }
        } else {
          showToast(data.detail || data.message || "Không thể cập nhật bài viết.", "error");
        }
      } catch (e) {
        showToast(e?.message || "Lỗi cập nhật bài viết.", "error");
      } finally {
        isSavingPostEdit.value = false;
      }
    }

    function openDeletePostModal(post) {
      selectedPost.value = post;
      deletePostOnFacebook.value = true;
      isDeletePostModalOpen.value = true;
    }

    async function handleConfirmDeletePost() {
      if (!selectedPost.value) return;
      isDeletingPost.value = true;
      try {
        const res = await apiFetch(`/api/posts/${encodeURIComponent(selectedPost.value.post_id)}?delete_facebook=${deletePostOnFacebook.value}`, {
          method: 'DELETE'
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          showToast(data.message || "Đã xóa bài viết thành công!", "success");
          isDeletePostModalOpen.value = false;
          isPostDetailOpen.value = false;
          await loadFacebookPosts();
        } else {
          showToast(data.detail || data.message || "Không thể xóa bài viết.", "error");
        }
      } catch (e) {
        showToast(e?.message || "Lỗi xóa bài viết.", "error");
      } finally {
        isDeletingPost.value = false;
      }
    }

    async function handleSendPostComment() {
      if (!selectedPost.value || !postNewComment.value.trim()) return;
      isSendingPostComment.value = true;
      try {
        const res = await apiFetch(`/api/posts/${encodeURIComponent(selectedPost.value.post_id)}/comments`, {
          method: 'POST',
          body: JSON.stringify({ message: postNewComment.value.trim() })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          showToast("Đã gửi bình luận thành công!", "success");
          postNewComment.value = '';
          const cRes = await apiFetch(`/api/posts/${encodeURIComponent(selectedPost.value.post_id)}/comments`);
          const cData = await cRes.json().catch(() => ({}));
          if (cRes.ok && cData.success) {
            postComments.value = cData.comments || [];
          }
        } else {
          showToast(data.detail || data.message || "Không thể gửi bình luận.", "error");
        }
      } catch (e) {
        showToast(e?.message || "Lỗi gửi bình luận.", "error");
      } finally {
        isSendingPostComment.value = false;
      }
    }

    async function handleSendPostReply(parentCommentId) {
      if (!selectedPost.value || !postReplyText.value.trim() || !parentCommentId) return;
      isSendingPostReply.value = true;
      try {
        const res = await apiFetch(`/api/comments/${encodeURIComponent(parentCommentId)}/reply`, {
          method: 'POST',
          body: JSON.stringify({ message: postReplyText.value.trim(), post_id: selectedPost.value.post_id })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          showToast("Đã trả lời bình luận thành công!", "success");
          postReplyText.value = '';
          postReplyTargetId.value = null;
          const cRes = await apiFetch(`/api/posts/${encodeURIComponent(selectedPost.value.post_id)}/comments`);
          const cData = await cRes.json().catch(() => ({}));
          if (cRes.ok && cData.success) {
            postComments.value = cData.comments || [];
          }
        } else {
          showToast(data.detail || data.message || "Không thể gửi câu trả lời.", "error");
        }
      } catch (e) {
        showToast(e?.message || "Lỗi gửi trả lời.", "error");
      } finally {
        isSendingPostReply.value = false;
      }
    }

    async function handleDeleteComment(commentId) {
      if (!confirm("Bạn có chắc chắn muốn xóa bình luận này trên Facebook?")) return;
      try {
        const res = await apiFetch(`/api/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          showToast("Đã xóa bình luận thành công!", "success");
          if (selectedPost.value) {
            const cRes = await apiFetch(`/api/posts/${encodeURIComponent(selectedPost.value.post_id)}/comments`);
            const cData = await cRes.json().catch(() => ({}));
            if (cRes.ok && cData.success) {
              postComments.value = cData.comments || [];
            }
          }
        } else {
          showToast(data.detail || data.message || "Không thể xóa bình luận.", "error");
        }
      } catch (e) {
        showToast(e?.message || "Lỗi xóa bình luận.", "error");
      }
    }

    async function handleHideComment(commentId, hide) {
      try {
        const res = await apiFetch(`/api/comments/${encodeURIComponent(commentId)}/hide`, {
          method: 'POST',
          body: JSON.stringify({ hide })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          showToast(data.message || (hide ? "Đã ẩn bình luận!" : "Đã hiện lại bình luận!"), "success");
          if (selectedPost.value) {
            const cRes = await apiFetch(`/api/posts/${encodeURIComponent(selectedPost.value.post_id)}/comments`);
            const cData = await cRes.json().catch(() => ({}));
            if (cRes.ok && cData.success) {
              postComments.value = cData.comments || [];
            }
          }
        } else {
          showToast(data.detail || data.message || "Không thể đổi trạng thái ẩn.", "error");
        }
      } catch (e) {
        showToast(e?.message || "Lỗi thao tác bình luận.", "error");
      }
    }

    async function loadCommentsView() {
      isLoadingComments.value = true;
      try {
        // Tải danh sách bài viết gần đây để lấy bình luận
        await loadFacebookPosts();
      } finally {
        isLoadingComments.value = false;
      }
    }

    // ==========================================
    // 11. LIFECYCLE, MULTI-TAB SYNC & POLLING
    // ==========================================
    let pollTimer = null;
    let isPollingTick = false;

    async function triggerPoll() {
      if (document.hidden || authState.value !== 'authenticated' || isPollingTick) return;
      isPollingTick = true;
      try {
        await Promise.allSettled([loadStats(), loadTasks()]);
        const hasActive = isRunning.value ||
          systemStats.value.running_tasks > 0 ||
          tasks.value.some(t => t.status === 'running' || t.status === 'queued');
        if (!hasActive && isRunning.value) {
          isRunning.value = false;
        }
      } finally {
        isPollingTick = false;
      }
    }

    function scheduleNextPoll() {
      if (pollTimer) clearTimeout(pollTimer);
      const hasActive = isRunning.value ||
        systemStats.value.running_tasks > 0 ||
        tasks.value.some(t => t.status === 'running' || t.status === 'queued');
      const delay = hasActive ? 1500 : 3000;
      pollTimer = setTimeout(async () => {
        await triggerPoll();
        scheduleNextPoll();
      }, delay);
    }

    function onVisibilityChange() {
      if (!document.hidden && authState.value === 'authenticated') {
        triggerPoll();
        scheduleNextPoll();
      }
    }

    function onPopState() {
      const p = window.location.pathname;
      if (p === '/analytics' || p === '/insights' || p === '/posts' || p === '/comments') {
        mainView.value = 'analytics';
        loadAnalyticsDashboard();
      } else if (p === '/pages' || p === '/page') {
        mainView.value = 'pages';
        loadPages();
      } else {
        mainView.value = 'schedule';
        loadTasks();
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
      // Chuẩn hóa đường dẫn mặc định theo 3 Tab chính: /schedule, /analytics, /pages
      const path = window.location.pathname;
      if (path === '/analytics' || path === '/insights' || path === '/posts' || path === '/comments') {
        mainView.value = 'analytics';
      } else if (path === '/pages' || path === '/page') {
        mainView.value = 'pages';
      } else {
        mainView.value = 'schedule';
      }

      window.addEventListener('popstate', onPopState);
      window.addEventListener('pageshow', onPageShow);
      window.addEventListener('storage', onStorageEvent);
      window.addEventListener('message', onWindowMessage);

      // 1. Kiểm tra xác thực người dùng trước khi gọi bất kỳ API nội bộ nào
      const authed = await checkAuth();
      if (!authed) return;

      // 2. Tải dữ liệu thiết yếu của hệ thống (Pages & Accounts), dữ liệu phụ chạy ngầm không chặn UI
      await loadAll();
      if (mainView.value === 'analytics') {
        await loadAnalyticsDashboard();
      } else if (mainView.value === 'pages') {
        // Danh sách Fanpage đã được load trong loadAll()
      } else {
        await loadTasks();
      }

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

      // 4. Realtime Polling không cần tải lại trang
      scheduleNextPoll();
      document.addEventListener('visibilitychange', onVisibilityChange);
    });

    onUnmounted(() => {
      if (pollTimer) clearTimeout(pollTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
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
      posts,
      totalPosts,
      postsPage,
      postsLimit,
      postsTotalPages,
      postsFilter,
      postsViewMode,
      isLoadingPosts,
      pageSyncStates,
      selectedPost,
      isPostDetailOpen,
      isLoadingPostDetail,
      postComments,
      postAuditLogs,
      postNewComment,
      isSendingPostComment,
      postReplyTargetId,
      postReplyText,
      isSendingPostReply,
      isEditPostModalOpen,
      editPostCaptionText,
      isSavingPostEdit,
      isDeletePostModalOpen,
      isDeletingPost,
      deletePostOnFacebook,
      commentsFilterPageId,
      commentsList,
      isLoadingComments,
      loadFacebookPosts,
      handleSyncPagePosts,
      handleLoadMoreOldPosts,
      openPostDetail,
      closePostDetail,
      openEditPostModal,
      handleSavePostEdit,
      openDeletePostModal,
      handleConfirmDeletePost,
      handleSendPostComment,
      handleSendPostReply,
      handleDeleteComment,
      handleHideComment,
      loadCommentsView,

      syncPagePosts,
      isSyncingPagePosts,
      newCommentInput,
      isSendingNewComment,
      handleSendNewComment,

      selectedPages,
      setQuickTomorrow0001,
      setEarliestSchedule,
      shiftToTomorrow,
      isTimeInPastToday,

      authState,
      isPageLoading,
      pageLoadError,
      retryInitializePage,
      currentUser,
      mainView,
      setMainView,
      loadAnalyticsDashboard,
      currentTab,
      setTab,
      checkAuth,
      handleLogout,
      pages,
      tasks,
      accounts,
      expiredAccounts,
      expiredAccountNames,
      missingInsightsAccounts,
      selectedAdminFilterIds,
      searchPage,
      filterPageStatus,
      filterPage,
      filterStatus,
      filterStartDate,
      filterEndDate,
      searchTask,
      publishingNowTaskId,
      isBulkPublishingTasks,
      isBulkReschedulingTasks,
      isBulkCancellingTasks,
      showBulkPublishModal,
      showBulkRescheduleModal,
      bulkRescheduleForm,
      bulkPublishPreview,
      bulkReschedulePreviewList,
      selectableTasksCount,
      singleScheduleErrors,
      clearSingleScheduleErrors,
      handlePublishSingleTaskNow,
      selectAllFilteredTasks,
      openBulkPublishConfirmModal,
      confirmBulkPublishNow,
      openBulkRescheduleModal,
      setBulkRescheduleRelativePreset,
      handleBulkRescheduleSubmit,
      handleBulkCancelSelectedTasks,
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
      connectWarnings,
      handleConnectToken,
      hours24List,
      minutes60List,
      getVnDateString,
      normalizeTime24hClient,
      getScheduleHour24,
      getScheduleMinute24,
      onScheduleHour24Change,
      onScheduleMinute24Change,
      normalizeScheduleTimeField,
      setRelativeTimePreset,
      describeTime24h,
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
      isUploadingVideo,
      uploadError,
      uploadedMediaInfo,
      userMediaFiles,
      selectExistingR2Video,
      retryUploadToR2,
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
      openCreateTaskModal: openSingleTaskModal,
      handleBrowseFileSingleTask,
      handleCloudVideoFileSelected,
      handleFileDropSingleTask,
      setDatePreset,
      setTimePreset,
      handleCreateSingleTaskSubmit,
      openBulkTaskModal,
      handleBulkInputChanged,
      handleBulkSubmit,
      bulkScheduleForm,
      bulkSchedulePastWarning,
      validBulkRowCount,
      errorBulkRowCount,
      bulkFirstScheduleDisplay,
      bulkLastScheduleDisplay,
      bulkSharedScheduleDisplay,
      maxBulkTasksAllowed,
      isBulkOverLimit,
      setBulkScheduleDatePreset,
      setBulkScheduleTimePreset,
      setBulkScheduleInterval,
      setBulkSchedulePastQuickFix,
      recalculateBulkExcelSchedules,
      isUploadingBulkExcelVideos,
      bulkExcelUploadProgress,
      isSubmittingBulkTasks,
      triggerBulkExcelFilePicker,
      handleBulkExcelFilesSelected,
      getFirstLine,
      getCleanFileName,
      openTaskDetailModal,
      showPageTasksModal,
      pageTaskTargetPage,
      pageScheduleConfig,
      pageSlots,
      isSubmittingPageTasks,
      isUploadingPageSlotVideo,
      pageSlotUploadError,
      openPageTasksModal,
      addPageSlot,
      removePageSlot,
      recalculatePageSlotTimes,
      setPageScheduleDatePreset,
      setPageScheduleTimePreset,
      setPageScheduleIntervalHours,
      triggerPageSlotFilePicker,
      handlePageSlotFileSelected,
      selectExistingR2ForPageSlot,
      handlePageTasksSubmit,
      isTaskLocked,
      isTaskInFlight,
      openEditTaskModal,
      handleUpdateTaskSubmit,
      handleResetTask,
      handleDeleteTask,
      selectedTaskIds,
      isBulkDeletingTasks,
      isAllTasksSelected,
      toggleSelectAllTasks,
      toggleTaskSelection,
      clearSelectedTasks,
      handleBulkDeleteSelectedTasks,
      openLogModal,
      formatFriendlyLog,
      retryingCommentTaskId,
      handleRetryComment,
      insightsFilter,
      insightsData,
      isLoadingInsights,
      isSyncingInsights,
      syncingTaskInsightId,
      showReelInsightModal,
      isLoadingReelDetail,
      reelInsightDetail,
      maxTimeSeriesViews,
      maxReelPerformanceViews,
      maxReelInteractions,
      formatMetricValue,
      formatMetricNumber,
      formatDurationMs,
      formatVnDateTime,
      calcChartBarWidth,
      loadReelsInsights,
      handleSyncAllInsights,
      handleSyncSingleReelInsight,
      openReelInsightModal,
      copyToClipboard,
      getFileName,
      startResizeSplitter
    };
  }
});

    app.config.errorHandler = function (err, _instance, info) {
      console.error("[Vue Render/Runtime Guard]", info, err);
      const appRoot = document.getElementById('app');
      if (appRoot) appRoot.removeAttribute('v-cloak');
    };

    try {
      app.mount('#app');
      clearTimeout(timeoutHintTimer);

      const appRoot = document.getElementById('app');
      if (appRoot) appRoot.removeAttribute('v-cloak');

      // Ẩn màn hình loading fallback ngay khi ứng dụng mount xong
      const loader = document.getElementById('app-loading-screen');
      if (loader) {
        loader.style.opacity = '0';
        setTimeout(() => loader.remove(), 180);
      }
    } catch (mountErr) {
      console.error("[Vue Mount Fatal Error]", mountErr);
      const appRoot = document.getElementById('app');
      if (appRoot) appRoot.removeAttribute('v-cloak');
      const hint = document.getElementById('app-timeout-hint');
      if (hint) {
        hint.classList.remove('hidden');
        hint.innerHTML = `
          <div class="p-3 bg-rose-950/80 border border-rose-800 rounded-xl text-rose-200 text-xs">
            <p class="font-bold mb-1">Khởi tạo ứng dụng gặp lỗi:</p>
            <p class="font-mono text-[11px] text-rose-300 break-all">${mountErr && mountErr.message ? mountErr.message : mountErr}</p>
            <button onclick="window.location.reload()" class="mt-3 px-3 py-1 bg-rose-700 hover:bg-rose-600 text-white rounded font-bold transition">Tải Lại Trang</button>
          </div>
        `;
      }
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

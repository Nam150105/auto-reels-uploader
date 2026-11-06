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
    // 1. STATE DỮ LIỆU CHÍNH
    // ==========================================
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
    // 4. API CALLS & DATA LOADERS
    // ==========================================
    async function loadMetaStatus() {
      try {
        const res = await fetch('/api/meta/status');
        if (res.ok) {
          metaStatus.value = await res.json();
        }
      } catch (err) {
        console.error("Lỗi tải Meta Status:", err);
      }
    }

    async function loadAccounts() {
      try {
        const res = await fetch('/api/meta/accounts');
        if (res.ok) {
          accounts.value = await res.json();
          // Lọc bỏ những account ID không còn tồn tại khỏi bộ lọc
          const validIds = new Set(accounts.value.map(a => a.id));
          selectedAdminFilterIds.value = selectedAdminFilterIds.value.filter(id => validIds.has(id));
        }
      } catch (err) {
        console.error("Lỗi tải danh sách Facebook Accounts:", err);
      }
    }

    async function loadPages() {
      try {
        const params = new URLSearchParams();
        if (selectedAdminFilterIds.value.length > 0) {
          params.append('account_ids', selectedAdminFilterIds.value.join(','));
        }
        if (searchPage.value.trim()) params.append('search', searchPage.value.trim());
        if (filterPageStatus.value) params.append('status', filterPageStatus.value);

        const res = await fetch(`/api/pages?${params.toString()}`);
        if (res.ok) {
          pages.value = await res.json();
        }
      } catch (err) {
        console.error("Lỗi tải danh sách Pages:", err);
      }
    }

    async function loadTasks() {
      try {
        const params = new URLSearchParams();
        if (filterPage.value) params.append('facebook_page_id', filterPage.value);
        if (filterStatus.value) params.append('status', filterStatus.value);
        if (searchTask.value.trim()) params.append('search', searchTask.value.trim());

        const res = await fetch(`/api/tasks?${params.toString()}`);
        if (res.ok) {
          tasks.value = await res.json();
        }
      } catch (err) {
        console.error("Lỗi tải danh sách Tasks:", err);
      }
    }

    async function loadStats() {
      try {
        const res = await fetch('/api/status');
        if (res.ok) {
          const data = await res.json();
          isRunning.value = data.is_running || false;
          systemStats.value = {
            total_pages: data.total_pages || 0,
            selected_pages: data.selected_pages || 0,
            total_tasks: data.total_tasks || 0,
            pending_tasks: data.pending_tasks || 0,
            success_tasks: data.success_tasks || 0,
            failed_tasks: data.failed_tasks || 0,
            running_tasks: data.running_tasks || 0
          };
          if (data.meta) {
            metaStatus.value = data.meta;
          }
          if (data.accounts) {
            accounts.value = data.accounts;
          }
        }
      } catch (err) {
        console.error("Lỗi tải System Stats:", err);
      }
    }

    async function loadAll() {
      await Promise.all([loadMetaStatus(), loadAccounts(), loadPages(), loadTasks(), loadStats()]);
    }

    // ==========================================
    // 5. AUTH & NAVIGATION ACTIONS
    // ==========================================
    async function checkAuth() {
      try {
        const res = await fetch('/api/auth/me');
        if (res.status === 401) {
          window.location.href = '/login';
          return false;
        }
        if (res.ok) {
          const data = await res.json();
          currentUser.value = data.user;
          return true;
        }
      } catch (e) {
        console.error("Auth check failed:", e);
      }
      window.location.href = '/login';
      return false;
    }

    async function handleLogout() {
      try {
        await fetch('/api/auth/logout', { method: 'POST' });
      } catch (e) {
        console.error("Lỗi đăng xuất:", e);
      }
      window.location.href = '/login';
    }

    function setTab(tab) {
      currentTab.value = tab;
      const targetPath = tab === 'pages' ? '/pages' : '/schedules';
      if (window.location.pathname !== targetPath) {
        history.pushState(null, '', targetPath);
      }
    }

    // ==========================================
    // 6. META OAUTH & PAGE MANAGEMENT ACTIONS
    // ==========================================
    function openConnectModal() {
      showConnectModal.value = true;
    }

    function openAccountsModal() {
      showAccountsModal.value = true;
      loadAccounts();
    }

    function startMetaOAuthFlow(accountId = null) {
      let url = '/api/meta/login?auth_type=rerequest';
      if (accountId) {
        url += `&account_id=${encodeURIComponent(accountId)}`;
      }
      window.location.href = url;
    }

    async function handleDisconnectMeta() {
      if (!confirm("Bạn có chắc chắn muốn ngắt kết nối Facebook Admin hiện tại không?")) return;
      try {
        const res = await fetch('/api/meta/disconnect', { method: 'POST' });
        const data = await res.json();
        showToast(data.message || "Đã ngắt kết nối.", "success");
        await loadAll();
      } catch (err) {
        showToast("Lỗi ngắt kết nối: " + err.message, "error");
      }
    }

    async function handleSyncPages() {
      isSyncingPages.value = true;
      try {
        const res = await fetch('/api/meta/sync-pages', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          showToast(data.message || "Đồng bộ Fanpage thành công!", "success");
          await loadAll();
        } else {
          showToast(data.detail || data.message || "Đồng bộ Fanpage thất bại.", "error");
        }
      } catch (err) {
        showToast("Lỗi gọi API đồng bộ: " + err.message, "error");
      } finally {
        isSyncingPages.value = false;
      }
    }

    async function handleSyncAccountPages(accountId) {
      isSyncingPages.value = true;
      try {
        const res = await fetch(`/api/meta/accounts/${accountId}/sync`, { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          showToast(data.message || "Đồng bộ Fanpage của tài khoản thành công!", "success");
          await loadAll();
        } else {
          showToast(data.detail || data.message || "Đồng bộ Fanpage thất bại.", "error");
        }
      } catch (err) {
        showToast("Lỗi gọi API đồng bộ: " + err.message, "error");
      } finally {
        isSyncingPages.value = false;
      }
    }

    async function handleReconnectAccount(accountId) {
      try {
        const res = await fetch(`/api/meta/accounts/${accountId}/reconnect-url`);
        const data = await res.json();
        if (res.ok && data.oauth_url) {
          window.location.href = data.oauth_url;
        } else {
          showToast(data.detail || "Không thể tạo liên kết kết nối lại.", "error");
        }
      } catch (err) {
        showToast("Lỗi kết nối: " + err.message, "error");
      }
    }

    async function handleDisconnectAccount(accountId) {
      if (!confirm("Bạn có chắc chắn muốn ngắt kết nối tài khoản Facebook Admin này không? Các Fanpage vẫn được giữ nếu còn Admin khác cùng quản lý.")) return;
      try {
        const res = await fetch(`/api/meta/accounts/${accountId}/disconnect`, { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          showToast(data.message || "Đã ngắt kết nối tài khoản.", "success");
          await loadAll();
        } else {
          showToast(data.detail || "Lỗi ngắt kết nối.", "error");
        }
      } catch (err) {
        showToast("Lỗi ngắt kết nối: " + err.message, "error");
      }
    }

    async function handleDeleteAccount(accountId) {
      if (!confirm("Bạn có chắc chắn muốn XÓA vĩnh viễn tài khoản Facebook Admin này khỏi hệ thống?")) return;
      try {
        const res = await fetch(`/api/meta/accounts/${accountId}`, { method: 'DELETE' });
        const data = await res.json();
        if (res.ok) {
          showToast(data.message || "Đã xóa tài khoản.", "success");
          await loadAll();
        } else {
          showToast(data.detail || "Lỗi xóa tài khoản.", "error");
        }
      } catch (err) {
        showToast("Lỗi xóa tài khoản: " + err.message, "error");
      }
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

    async function handleBrowseFileSingleTask() {
      try {
        const res = await fetch('/api/system/browse-file', { method: 'POST' });
        const data = await res.json();
        if (data.path) {
          singleTaskForm.value.video_path = data.path;
        }
      } catch (err) {
        showToast("Lỗi mở hộp thoại chọn file: " + err.message, "error");
      }
    }

    function handleFileDropSingleTask(event) {
      if (event.dataTransfer && event.dataTransfer.files.length > 0) {
        const file = event.dataTransfer.files[0];
        if (file.path) {
          singleTaskForm.value.video_path = file.path;
        } else {
          singleTaskForm.value.video_path = file.name;
        }
      }
    }

    function setDatePreset(offsetDays) {
      const d = new Date();
      d.setDate(d.getDate() + offsetDays);
      singleTaskForm.value.schedule_date = d.toISOString().split('T')[0];
    }

    function setTimePreset(timeStr) {
      singleTaskForm.value.schedule_time = timeStr;
    }

    async function handleCreateSingleTaskSubmit() {
      if (!singleTaskForm.value.video_path.trim()) {
        showToast("Đường dẫn video không được để trống!", "warning");
        return;
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

    function openLogModal(t) {
      currentLogTask.value = {
        id: t.id,
        title: `Chi tiết Task #${t.id} - ${t.page_name || 'Fanpage'}`,
        log: t.log || t.error_message || '(Chưa có thông điệp log)',
        video_url: t.video_url || ''
      };
      showLogModal.value = true;
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
    // 11. LIFECYCLE & POLLING
    // ==========================================
    let pollInterval = null;

    onMounted(async () => {
      // Xác định Tab theo đường dẫn URL
      const path = window.location.pathname;
      if (path === '/schedules' || path === '/reels') {
        currentTab.value = 'schedules';
      } else {
        currentTab.value = 'pages';
      }

      window.addEventListener('popstate', () => {
        const p = window.location.pathname;
        if (p === '/schedules' || p === '/reels') {
          currentTab.value = 'schedules';
        } else {
          currentTab.value = 'pages';
        }
      });

      // Kiểm tra xác thực người dùng
      const authed = await checkAuth();
      if (!authed) return;

      await loadAll();

      // Polling định kỳ mỗi 3 giây để cập nhật trạng thái các task đang đăng
      pollInterval = setInterval(async () => {
        await loadStats();
        if (isRunning.value || systemStats.value.running_tasks > 0) {
          await loadTasks();
          await loadPages();
        }
      }, 3000);
    });

    onUnmounted(() => {
      if (pollInterval) clearInterval(pollInterval);
    });

    return {
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

    // Ẩn màn hình loading fallback
    const loader = document.getElementById('app-loading-screen');
    if (loader) {
      loader.style.opacity = '0';
      setTimeout(() => loader.remove(), 250);
    }
  }

  // Khởi chạy khi DOM đã sẵn sàng
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMainDashboard);
  } else {
    initMainDashboard();
  }

  // Cảnh báo timeout sau 6 giây nếu gặp sự cố mạng hoặc CDN
  setTimeout(() => {
    const hint = document.getElementById('app-timeout-hint');
    if (hint) hint.classList.remove('hidden');
  }, 6000);
})();

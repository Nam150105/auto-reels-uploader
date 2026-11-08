import { ref, computed } from "vue";

export type Locale = "vi" | "en";

const currentLocale = ref<Locale>((localStorage.getItem("app_lang") as Locale) || "vi");

export const translations = {
  vi: {
    // Navigation
    compose: "Viết bài",
    schedule: "Lịch đăng",
    analytics: "Thống kê",
    compose_single: "Đăng thường",
    compose_bulk: "Đăng hàng loạt",
    
    // Header
    workspace: "NNN Auto Reels",
    all_pages: "Tất cả Fanpage",
    connect_page: "Kết nối Fanpage",
    refresh: "Làm mới",
    logout: "Đăng xuất",
    
    // Single Composer
    select_channels: "Chọn Kênh",
    search_channel: "Tìm kiếm kênh",
    select_all: "Chọn tất cả",
    fanpage: "Fanpage",
    content_placeholder: "Nhập nội dung bài viết...",
    create_image: "Tạo hình ảnh",
    publish_standards: "Tiêu chuẩn đăng",
    drag_drop_media: "Dán, thả hoặc Tải từ máy của bạn",
    carousel_mode: "Carousel",
    auto_comment: "Đăng bình luận",
    threads_mode: "Multi Meta Threads",
    publish_mode_now: "Đăng ngay",
    publish_mode_schedule: "Hẹn giờ",
    schedule_time: "Thời gian đăng",
    preview: "Xem trước",
    submit_approval: "Gửi phê duyệt",
    save_draft: "Lưu bài",
    publish_btn: "Lưu & Xuất bản",
    publishing: "Đang đăng...",
    
    // Bulk Composer
    upload_media_bulk: "Tải lên media",
    select_channels_bulk: "Chọn kênh đăng",
    set_title_bulk: "Cài đặt tiêu đề",
    edit_content_bulk: "Chỉnh sửa nội dung",
    set_schedule_bulk: "Cài đặt thời gian đăng",
    bulk_comment_btn: "Bình luận hàng loạt",
    select_topic: "Chọn chủ đề",
    total_posts: "Tổng số bài đăng",
    add_new_post: "Tạo một bài đăng mới",
    channel_col: "Kênh",
    content_col: "Nội dung",
    media_col: "Media",
    time_col: "Thời gian",
    actions_col: "Hành động",
    channels_tab: "Các kênh",
    channel_groups_tab: "Nhóm kênh",
    select_channels_input: "Chọn các kênh",
    description_placeholder: "Nội dung mô tả",
    
    // Bulk Comment Modal
    bulk_comment_title: "Bình luận hàng loạt",
    bulk_comment_desc: "Sau khi bài đăng được đăng lên nền tảng, hệ thống sẽ đẩy thêm bình luận vào dưới bài đăng đó theo cài đặt của bạn.",
    comment_col: "Bình luận",
    comment_time_col: "Thời gian",
    create_new_comment: "+ Tạo bình luận mới",
    spin_tip: "Mẹo: Đa dạng hóa nội dung của bạn với Chức năng Spin.",
    close: "Đóng",
    save: "Lưu",
    
    // Schedule View
    filter_all: "Tất cả",
    filter_pending: "Chờ đăng",
    filter_running: "Đang đăng",
    filter_success: "Thành công",
    filter_failed: "Thất bại",
    search_tasks: "Tìm kiếm bài đăng...",
    batch_actions: "Thao tác đã chọn",
    publish_now_selected: "Đăng ngay",
    reschedule_selected: "Đổi lịch",
    delete_selected: "Xóa",
    view_fb_post: "Xem trên Facebook",
    edit_task: "Sửa",
    cancel_task: "Hủy",
    retry_task: "Thử lại",
    
    // Analytics
    analytics_overview: "Thống kê tổng quan",
    sync_now: "Đồng bộ ngay",
    syncing: "Đang đồng bộ...",
    card_followers: "NGƯỜI THEO DÕI",
    card_views_7d: "LƯỢT XEM 7 NGÀY",
    card_views_30d: "LƯỢT XEM 30 NGÀY",
    card_new_follows_30d: "REELS ĐÃ ĐĂNG 30 NGÀY",
    page_comparison_title: "So sánh hiệu quả từng Fanpage",
    reels_performance_chart: "Lượt xem Reels theo ngày đăng",
    col_page: "Fanpage",
    col_followers: "Người theo dõi",
    col_posts: "Reels (30 ngày)",
    col_views: "Lượt xem",
    col_reach: "Tiếp cận",
    col_likes: "Lượt thích",
    col_comments: "Bình luận",
    col_shares: "Chia sẻ",
    
    // Common
    success: "Thành công",
    error: "Lỗi",
    warning: "Cảnh báo",
    confirm: "Xác nhận",
    cancel: "Hủy bỏ",
    delete: "Xóa",
    loading: "Đang tải dữ liệu...",
    no_data: "Không có dữ liệu",
    now: "Hiện tại"
  },
  en: {
    // Navigation
    compose: "Compose",
    schedule: "Schedule",
    analytics: "Analytics",
    compose_single: "Single Post",
    compose_bulk: "Bulk Posts",
    
    // Header
    workspace: "NNN Auto Reels",
    all_pages: "All Fanpages",
    connect_page: "Connect Page",
    refresh: "Refresh",
    logout: "Log out",
    
    // Single Composer
    select_channels: "Select Channels",
    search_channel: "Search channels",
    select_all: "Select all",
    fanpage: "Fanpage",
    content_placeholder: "What's on your mind?...",
    create_image: "Generate Image",
    publish_standards: "Publishing Rules",
    drag_drop_media: "Paste, drop or Upload from your device",
    carousel_mode: "Carousel",
    auto_comment: "Post Comment",
    threads_mode: "Multi Meta Threads",
    publish_mode_now: "Publish Now",
    publish_mode_schedule: "Schedule",
    schedule_time: "Scheduled Time",
    preview: "Preview",
    submit_approval: "Send for review",
    save_draft: "Save Draft",
    publish_btn: "Save & Publish",
    publishing: "Publishing...",
    
    // Bulk Composer
    upload_media_bulk: "Upload Media",
    select_channels_bulk: "Select Channels",
    set_title_bulk: "Set Title",
    edit_content_bulk: "Edit Content",
    set_schedule_bulk: "Set Schedule",
    bulk_comment_btn: "Bulk Comment",
    select_topic: "Select Topic",
    total_posts: "Total Posts",
    add_new_post: "Create a new post",
    channel_col: "Channel",
    content_col: "Content",
    media_col: "Media",
    time_col: "Time",
    actions_col: "Actions",
    channels_tab: "Channels",
    channel_groups_tab: "Groups",
    select_channels_input: "Select channels",
    description_placeholder: "Post description",
    
    // Bulk Comment Modal
    bulk_comment_title: "Bulk Comments",
    bulk_comment_desc: "After the post is published, comments will be automatically posted under the post according to your configuration.",
    comment_col: "Comment",
    comment_time_col: "Timing",
    create_new_comment: "+ Add comment",
    spin_tip: "Tip: Diversify your text with Spin syntax.",
    close: "Close",
    save: "Save",
    
    // Schedule View
    filter_all: "All",
    filter_pending: "Scheduled",
    filter_running: "Publishing",
    filter_success: "Published",
    filter_failed: "Failed",
    search_tasks: "Search scheduled posts...",
    batch_actions: "Selected Actions",
    publish_now_selected: "Publish Now",
    reschedule_selected: "Reschedule",
    delete_selected: "Delete",
    view_fb_post: "View on Facebook",
    edit_task: "Edit",
    cancel_task: "Cancel",
    retry_task: "Retry",
    
    // Analytics
    analytics_overview: "Analytics Overview",
    sync_now: "Sync Now",
    syncing: "Syncing...",
    card_followers: "FOLLOWERS",
    card_views_7d: "VIEWS 7D",
    card_views_30d: "VIEWS 30D",
    card_new_follows_30d: "REELS POSTED 30D",
    page_comparison_title: "Page Performance Comparison",
    reels_performance_chart: "Reels Views by Publish Date",
    col_page: "Fanpage",
    col_followers: "Followers",
    col_posts: "Reels (30d)",
    col_views: "Views",
    col_reach: "Reach",
    col_likes: "Likes",
    col_comments: "Comments",
    col_shares: "Shares",
    
    // Common
    success: "Success",
    error: "Error",
    warning: "Warning",
    confirm: "Confirm",
    cancel: "Cancel",
    delete: "Delete",
    loading: "Loading data...",
    no_data: "No data available",
    now: "Now"
  }
};

export function useI18n() {
  const t = (key: keyof typeof translations.vi): string => {
    return translations[currentLocale.value][key] || key;
  };

  const setLocale = (locale: Locale) => {
    currentLocale.value = locale;
    localStorage.setItem("app_lang", locale);
  };

  const locale = computed(() => currentLocale.value);

  return { t, locale, setLocale };
}

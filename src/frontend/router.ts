import { createRouter, createWebHistory, type LocationQuery } from "vue-router";

/**
 * Toàn bộ ứng dụng là MỘT màn hình (App.vue): Đăng theo Fanpage + Lịch đăng.
 * URL chỉ dùng để mở các khung quản lý ít dùng đè lên màn hình chính:
 *   /analytics          Thống kê chi tiết
 *   /pages, /pages/accounts  Quản lý Fanpage / Tài khoản Facebook Admin
 *   /admin/...          Quản trị hệ thống
 * Mọi đường dẫn cũ khác (/compose/..., /schedule, ...) đưa về màn hình chính /page.
 * The Worker returns index.html for these paths (SPA_ROUTE_ROOTS in src/index.ts).
 */
export type PanelKey = "analytics" | "pages" | "accounts" | "admin";

// Keeps ?oauth_status=... when an old URL redirects to a new one
const keepQuery = (path: string) => (to: { query: LocationQuery; hash: string }) => ({ path, query: to.query, hash: to.hash });

// App.vue tự hiển thị theo route (không dùng <RouterView>), mỗi route chỉ cần một component rỗng
const Empty = { render: () => null };

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: keepQuery("/page") },
    { path: "/page", name: "workspace", component: Empty },
    { path: "/compose/:mode?", redirect: keepQuery("/page") },
    { path: "/:old(schedule|schedules|reels|posts|comments)", redirect: keepQuery("/page") },
    { path: "/analytics", name: "analytics", component: Empty, alias: ["/insights"] },
    { path: "/pages/:section(accounts)?", name: "pages", component: Empty },
    { path: "/admin/:section(users|sessions|api)?", name: "admin", component: Empty },
    { path: "/:pathMatch(.*)*", redirect: "/page" }
  ]
});

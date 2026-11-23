import { createRouter, createWebHistory, type LocationQuery } from "vue-router";

/**
 * Toàn bộ ứng dụng là MỘT màn hình (App.vue): Đăng theo Fanpage + Lịch đăng + Thống kê.
 * Mọi đường dẫn cũ (/compose/..., /schedule, /analytics, /pages, /admin, ...) đưa về /page.
 * The Worker returns index.html for these paths (SPA_ROUTE_ROOTS in src/index.ts).
 */

// Keeps ?oauth_status=... when an old URL redirects to /page
const keepQuery = (path: string) => (to: { query: LocationQuery; hash: string }) => ({ path, query: to.query, hash: to.hash });

// App.vue không dùng <RouterView>; route chỉ để giữ URL và tham số trả về sau khi đăng nhập Facebook
const Empty = { render: () => null };

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/page", name: "workspace", component: Empty },
    { path: "/:pathMatch(.*)*", redirect: keepQuery("/page") }
  ]
});

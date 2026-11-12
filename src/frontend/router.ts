import { createRouter, createWebHistory, type LocationQuery } from "vue-router";
import type { AppTab } from "@shared/types";
import ComposeView from "./components/composer/ComposeView.vue";
import ScheduleView from "./components/schedule/ScheduleView.vue";
import AnalyticsView from "./components/analytics/AnalyticsView.vue";
import FanpageView from "./components/pages/FanpageView.vue";

export type ComposeMode = "single" | "bulk" | "multipage";
export const COMPOSE_MODES: ComposeMode[] = ["single", "bulk", "multipage"];

// Keeps ?oauth_status=... when an old URL redirects to a new one
const keepQuery = (path: string) => (to: { query: LocationQuery; hash: string }) => ({ path, query: to.query, hash: to.hash });

/**
 * Web router (HTML5 history): each screen has its own URL.
 * The Worker returns index.html for these paths (SPA_ROUTE_ROOTS in src/index.ts).
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: keepQuery("/compose") },
    { path: "/page", redirect: keepQuery("/compose") },
    { path: "/compose", redirect: keepQuery("/compose/single") },
    {
      path: "/compose/:mode(single|bulk|multipage)",
      name: "compose",
      component: ComposeView,
      meta: { tab: "compose" }
    },
    {
      path: "/schedule",
      name: "schedule",
      component: ScheduleView,
      meta: { tab: "schedule" },
      alias: ["/schedules", "/reels", "/posts", "/comments"]
    },
    {
      path: "/analytics",
      name: "analytics",
      component: AnalyticsView,
      meta: { tab: "analytics" },
      alias: ["/insights"]
    },
    {
      path: "/pages/:section(accounts)?",
      name: "pages",
      component: FanpageView,
      meta: { tab: "pages" }
    },
    { path: "/:pathMatch(.*)*", redirect: "/compose/single" }
  ]
});

export const TAB_PATHS: Record<AppTab, string> = {
  compose: "/compose/single",
  schedule: "/schedule",
  analytics: "/analytics",
  pages: "/pages"
};

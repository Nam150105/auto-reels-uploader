import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import "./assets/main.css";

const app = createApp(App);
app.use(router);
// Wait for the first route so App sees the real URL (and its query) on mount
router.isReady().then(() => app.mount("#app"));

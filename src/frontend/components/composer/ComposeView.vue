<template>
  <SingleComposer v-if="mode === 'single'" @task-created="goToSchedule" />
  <BulkComposer v-else-if="mode === 'bulk'" @tasks-created="goToSchedule" />
  <MultiPageComposer v-else @tasks-created="goToSchedule" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import SingleComposer from "./SingleComposer.vue";
import BulkComposer from "./BulkComposer.vue";
import MultiPageComposer from "./MultiPageComposer.vue";

const route = useRoute();
const router = useRouter();
const emit = defineEmits<{ (e: "task-created"): void }>();

const props = withDefaults(defineProps<{ initialMode?: "single" | "bulk" | "multipage" }>(), {
  initialMode: "single"
});

const mode = computed(() => props.initialMode || String(route.params.mode || "single"));

// After creating posts, open the schedule screen
const goToSchedule = () => {
  emit("task-created");
  if (route.path !== "/page") router.replace("/page");
};
</script>

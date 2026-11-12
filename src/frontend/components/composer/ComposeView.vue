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

const mode = computed(() => String(route.params.mode || "single"));

// After creating posts, open the schedule screen
const goToSchedule = () => {
  router.push("/schedule");
};
</script>

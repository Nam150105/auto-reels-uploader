<template>
  <SingleComposer v-if="initialMode === 'single'" @task-created="emit('task-created')" />
  <BulkComposer v-else-if="initialMode === 'bulk'" @tasks-created="emit('task-created')" />
  <MultiPageComposer v-else @tasks-created="emit('task-created')" />
</template>

<script setup lang="ts">
import SingleComposer from "./SingleComposer.vue";
import BulkComposer from "./BulkComposer.vue";
import MultiPageComposer from "./MultiPageComposer.vue";

// Nằm trong ngăn "Tạo bài" của màn hình chính; App đóng ngăn và tải lại lịch đăng khi tạo xong
withDefaults(defineProps<{ initialMode?: "single" | "bulk" | "multipage" }>(), { initialMode: "single" });
const emit = defineEmits<{ (e: "task-created"): void }>();
</script>

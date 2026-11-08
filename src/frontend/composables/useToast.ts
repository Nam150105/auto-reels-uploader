import { ref } from "vue";

export interface ToastMessage {
  id: string;
  type: "success" | "error" | "info" | "warning";
  title?: string;
  message: string;
  duration?: number;
}

const toasts = ref<ToastMessage[]>([]);

export function useToast() {
  const show = (message: string, type: ToastMessage["type"] = "info", title?: string, duration = 4000) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const toast: ToastMessage = { id, type, title, message, duration };
    toasts.value.push(toast);

    if (duration > 0) {
      setTimeout(() => {
        remove(id);
      }, duration);
    }
    return id;
  };

  const success = (message: string, title = "Success") => show(message, "success", title);
  const error = (message: string, title = "Error") => show(message, "error", title, 6000);
  const info = (message: string, title = "Info") => show(message, "info", title);
  const warning = (message: string, title = "Warning") => show(message, "warning", title);

  const remove = (id: string) => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  };

  return {
    toasts,
    show,
    success,
    error,
    info,
    warning,
    remove
  };
}

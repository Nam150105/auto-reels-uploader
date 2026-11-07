import { ref } from "vue";
import { api } from "../services/api";
import type { UserSession } from "@shared/types";

const user = ref<UserSession | null>(null);
const isLoading = ref<boolean>(true);
const isAuthenticated = ref<boolean>(false);

export function useAuth() {
  const checkAuth = async () => {
    isLoading.value = true;
    try {
      const u: any = await api.checkAuth();
      user.value = u?.user || u || null;
      isAuthenticated.value = Boolean(u && u.authenticated);
      return user.value;
    } catch {
      user.value = null;
      isAuthenticated.value = false;
      return null;
    } finally {
      isLoading.value = false;
    }
  };

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      user.value = null;
      isAuthenticated.value = false;
    }
  };

  return {
    user,
    isLoading,
    isAuthenticated,
    checkAuth,
    logout
  };
}

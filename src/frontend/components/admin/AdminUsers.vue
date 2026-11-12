<template>
  <section>
    <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
      <input v-model="search" type="search" placeholder="Tìm theo tên, tên đăng nhập, email..." class="admin-input max-w-xs" />
      <div class="flex gap-2">
        <button type="button" class="admin-btn-ghost" :disabled="isLoading" @click="load">Tải lại</button>
        <button type="button" class="admin-btn-primary" @click="openCreate">+ Thêm người dùng</button>
      </div>
    </div>

    <div class="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-x-auto">
      <table class="w-full text-xs">
        <thead class="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wide">
          <tr>
            <th class="text-left px-4 py-2.5">Người dùng</th>
            <th class="text-left px-3 py-2.5">Hoạt động</th>
            <th class="text-right px-3 py-2.5">TK Facebook</th>
            <th class="text-right px-3 py-2.5">Fanpage</th>
            <th class="text-right px-3 py-2.5">Bài đăng</th>
            <th class="text-right px-3 py-2.5">Phiên</th>
            <th class="text-right px-4 py-2.5">Thao tác</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          <tr v-if="isLoading && !users.length"><td colspan="7" class="px-4 py-8 text-center text-slate-400">Đang tải...</td></tr>
          <tr v-else-if="!filtered.length"><td colspan="7" class="px-4 py-8 text-center text-slate-400">Không có người dùng.</td></tr>
          <tr v-for="u in filtered" :key="u.id" class="hover:bg-slate-50/60">
            <td class="px-4 py-2.5">
              <button type="button" class="text-left" @click="openDetail(u.id)">
                <span class="font-bold text-slate-800 hover:text-rose-600">{{ u.full_name || u.username }}</span>
                <span v-if="u.role === 'admin'" class="ml-1 text-[10px] font-bold text-rose-600 bg-rose-50 px-1.5 py-0.5 rounded">ADMIN</span>
                <span v-if="!u.is_active" class="ml-1 text-[10px] font-bold text-slate-600 bg-slate-200 px-1.5 py-0.5 rounded">ĐÃ KHOÁ</span>
                <span class="block text-[11px] text-slate-400">@{{ u.username }}<template v-if="u.email"> · {{ u.email }}</template></span>
              </button>
            </td>
            <td class="px-3 py-2.5 whitespace-nowrap">
              <span v-if="u.online" class="inline-flex items-center gap-1 text-emerald-600 font-bold">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>Đang online
              </span>
              <span v-else class="text-slate-500">{{ u.last_seen_at ? timeAgo(u.last_seen_at) : "Chưa ghi nhận" }}</span>
              <span class="block text-[11px] text-slate-400">Đăng nhập: {{ timeAgo(u.last_login_at) }}</span>
            </td>
            <td class="px-3 py-2.5 text-right font-bold text-slate-700">{{ u.facebook_accounts }}</td>
            <td class="px-3 py-2.5 text-right font-bold text-slate-700">{{ u.pages }}</td>
            <td class="px-3 py-2.5 text-right text-slate-600">{{ u.tasks }}</td>
            <td class="px-3 py-2.5 text-right text-slate-600">{{ u.active_sessions }}</td>
            <td class="px-4 py-2.5 text-right whitespace-nowrap space-x-2">
              <button type="button" class="admin-link" @click="openDetail(u.id)">Chi tiết</button>
              <button type="button" class="admin-link" @click="openEdit(u)">Sửa</button>
              <button type="button" class="admin-link" @click="openPassword(u)">Mật khẩu</button>
              <button type="button" class="admin-link" :disabled="!u.active_sessions" @click="revokeAll(u)">Đăng xuất</button>
              <button type="button" class="admin-link hover:!text-red-600" :disabled="u.id === me?.id" @click="remove(u)">Xoá</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="text-[11px] text-slate-400 mt-2">
      Mật khẩu được mã hoá một chiều nên không ai (kể cả admin) xem lại được. Dùng "Mật khẩu" để đặt mật khẩu mới rồi gửi cho người dùng.
    </p>

    <!-- Create / edit -->
    <div v-if="form.open" class="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" @click.self="form.open = false">
      <form class="bg-white rounded-2xl p-5 w-full max-w-md shadow-xl space-y-3" @submit.prevent="saveForm">
        <h3 class="text-sm font-bold text-slate-800">{{ form.id ? "Sửa người dùng" : "Thêm người dùng" }}</h3>
        <label class="block text-[11px] font-bold text-slate-500">Tên đăng nhập
          <input v-model="form.username" class="admin-input mt-1" required minlength="3" autocomplete="off" />
        </label>
        <label class="block text-[11px] font-bold text-slate-500">Họ tên
          <input v-model="form.full_name" class="admin-input mt-1" />
        </label>
        <label class="block text-[11px] font-bold text-slate-500">Email
          <input v-model="form.email" type="email" class="admin-input mt-1" />
        </label>
        <label v-if="!form.id" class="block text-[11px] font-bold text-slate-500">Mật khẩu
          <input v-model="form.password" type="text" class="admin-input mt-1" minlength="6" placeholder="Để trống để tạo ngẫu nhiên" autocomplete="new-password" />
        </label>
        <div class="flex gap-4">
          <label class="block text-[11px] font-bold text-slate-500 flex-1">Quyền
            <select v-model="form.role" class="admin-input mt-1">
              <option value="member">Thành viên</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <label v-if="form.id" class="flex items-center gap-2 text-xs font-bold text-slate-600 pt-5">
            <input v-model="form.is_active" type="checkbox" class="rounded" />
            Cho phép đăng nhập
          </label>
        </div>
        <div class="flex justify-end gap-2 pt-1">
          <button type="button" class="admin-btn-ghost" @click="form.open = false">Huỷ</button>
          <button type="submit" class="admin-btn-primary" :disabled="isSaving">Lưu</button>
        </div>
      </form>
    </div>

    <!-- Set password -->
    <div v-if="pwd.user" class="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" @click.self="closePassword">
      <div class="bg-white rounded-2xl p-5 w-full max-w-sm shadow-xl space-y-3">
        <h3 class="text-sm font-bold text-slate-800">Mật khẩu của @{{ pwd.user.username }}</h3>
        <template v-if="!pwd.result">
          <input v-model="pwd.value" type="text" class="admin-input" minlength="6" placeholder="Mật khẩu mới (để trống để tạo ngẫu nhiên)" autocomplete="new-password" />
          <p class="text-[11px] text-slate-500">Người dùng sẽ bị đăng xuất khỏi mọi thiết bị và phải đăng nhập lại bằng mật khẩu mới.</p>
          <div class="flex justify-end gap-2">
            <button type="button" class="admin-btn-ghost" @click="closePassword">Huỷ</button>
            <button type="button" class="admin-btn-primary" :disabled="isSaving" @click="savePassword">Đặt mật khẩu</button>
          </div>
        </template>
        <template v-else>
          <p class="text-xs text-slate-600">Mật khẩu mới (chỉ hiện một lần, hãy gửi cho người dùng):</p>
          <div class="flex items-center gap-2">
            <code class="flex-1 px-3 py-2 rounded-xl bg-slate-100 font-mono text-sm text-slate-800 select-all">{{ pwd.result }}</code>
            <button type="button" class="admin-btn-ghost" @click="copy(pwd.result)">Sao chép</button>
          </div>
          <div class="flex justify-end">
            <button type="button" class="admin-btn-primary" @click="closePassword">Xong</button>
          </div>
        </template>
      </div>
    </div>

    <AdminUserDetail
      v-if="detailId"
      ref="detailRef"
      :user-id="detailId"
      @close="closeDetail"
      @edit="(u) => openEdit(u)"
      @password="(u) => openPassword(u)"
      @changed="load"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuth } from "../../composables/useAuth";
import { useToast } from "../../composables/useToast";
import { adminApi, type AdminUserRow } from "../../services/adminApi";
import { timeAgo } from "./adminFormat";
import AdminUserDetail from "./AdminUserDetail.vue";

type EditableUser = Pick<AdminUserRow, "id" | "username" | "full_name" | "email" | "role" | "is_active">;

const route = useRoute();
const router = useRouter();
const toast = useToast();
const { user: me } = useAuth();

const users = ref<AdminUserRow[]>([]);
const isLoading = ref(false);
const isSaving = ref(false);
const search = ref("");

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return users.value;
  return users.value.filter((u) =>
    [u.username, u.full_name, u.email].some((v) => String(v || "").toLowerCase().includes(q))
  );
});

const detailRef = ref<{ reload: () => Promise<void> } | null>(null);

const load = async () => {
  isLoading.value = true;
  detailRef.value?.reload();
  try {
    users.value = await adminApi.users();
  } catch (err: any) {
    toast.error(err?.message || "Couldn't load users.");
  } finally {
    isLoading.value = false;
  }
};
onMounted(load);

// ---- Detail (?user=<id> keeps it in the URL) ----
const detailId = computed(() => (typeof route.query.user === "string" ? route.query.user : ""));
const openDetail = (id: string) => router.push({ query: { ...route.query, user: id } });
const closeDetail = () => {
  const { user: _u, ...rest } = route.query;
  router.push({ query: rest });
};

// ---- Create / edit ----
const form = reactive({
  open: false,
  id: "",
  username: "",
  full_name: "",
  email: "",
  password: "",
  role: "member" as "admin" | "member",
  is_active: true
});
const openCreate = () => {
  Object.assign(form, { open: true, id: "", username: "", full_name: "", email: "", password: "", role: "member", is_active: true });
};
const openEdit = (u: EditableUser) => {
  Object.assign(form, {
    open: true,
    id: u.id,
    username: u.username,
    full_name: u.full_name || "",
    email: u.email || "",
    password: "",
    role: u.role,
    is_active: !!u.is_active
  });
};
const saveForm = async () => {
  isSaving.value = true;
  try {
    if (form.id) {
      await adminApi.updateUser(form.id, {
        username: form.username,
        full_name: form.full_name,
        email: form.email,
        role: form.role,
        is_active: form.is_active
      });
      toast.success("User updated.");
      form.open = false;
    } else {
      const res = await adminApi.createUser({
        username: form.username,
        full_name: form.full_name,
        email: form.email,
        role: form.role,
        password: form.password || undefined
      });
      toast.success("User created.");
      form.open = false;
      if (res.password) {
        pwd.user = { id: "", username: form.username.trim().toLowerCase() };
        pwd.result = res.password;
      }
    }
    await load();
  } catch (err: any) {
    toast.error(err?.message || "Couldn't save the user.");
  } finally {
    isSaving.value = false;
  }
};

// ---- Password ----
const pwd = reactive<{ user: { id: string; username: string } | null; value: string; result: string }>({
  user: null,
  value: "",
  result: ""
});
const openPassword = (u: { id: string; username: string }) => {
  pwd.user = { id: u.id, username: u.username };
  pwd.value = "";
  pwd.result = "";
};
const closePassword = () => {
  pwd.user = null;
  pwd.value = "";
  pwd.result = "";
};
const savePassword = async () => {
  if (!pwd.user) return;
  if (pwd.value && pwd.value.length < 6) {
    toast.error("Password must be at least 6 characters.");
    return;
  }
  isSaving.value = true;
  try {
    const res = await adminApi.setPassword(pwd.user.id, pwd.value);
    toast.success("Password updated.");
    pwd.result = res.password || pwd.value;
    await load();
  } catch (err: any) {
    toast.error(err?.message || "Couldn't update the password.");
  } finally {
    isSaving.value = false;
  }
};
const copy = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied.");
  } catch {
    toast.error("Couldn't copy. Select the text and copy it manually.");
  }
};

// ---- Sessions / delete ----
const revokeAll = async (u: AdminUserRow) => {
  if (!confirm(`Đăng xuất @${u.username} khỏi mọi thiết bị?`)) return;
  try {
    const res = await adminApi.revokeUserSessions(u.id);
    toast.success(`Signed out ${res.revoked_sessions} session(s).`);
    await load();
  } catch (err: any) {
    toast.error(err?.message || "Couldn't sign the user out.");
  }
};
const remove = async (u: AdminUserRow) => {
  const ok = confirm(
    `Xoá vĩnh viễn @${u.username}?\n\nToàn bộ dữ liệu của người này (${u.facebook_accounts} tài khoản Facebook, ${u.pages} Fanpage, ${u.tasks} bài đăng) sẽ bị xoá và không khôi phục được.`
  );
  if (!ok) return;
  try {
    await adminApi.deleteUser(u.id);
    toast.success("User deleted.");
    if (detailId.value === u.id) closeDetail();
    await load();
  } catch (err: any) {
    toast.error(err?.message || "Couldn't delete the user.");
  }
};
</script>

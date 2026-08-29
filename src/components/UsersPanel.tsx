import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, Role } from "../api";
import { useCurrentUser } from "../auth";

const ROLES: Role[] = ["admin", "manager", "cashier"];

export default function UsersPanel() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useCurrentUser();
  const users = useQuery({ queryKey: ["users"], queryFn: api.listUsers });

  const [form, setForm] = useState({ username: "", display_name: "", password: "", role: "cashier" as Role });
  const [createError, setCreateError] = useState("");
  const [resetTarget, setResetTarget] = useState<number | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetError, setResetError] = useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["users"] });

  const create = useMutation({
    mutationFn: () => api.createUser(form),
    onSuccess: () => {
      setForm({ username: "", display_name: "", password: "", role: "cashier" });
      setCreateError("");
      invalidate();
    },
    onError: (e) => setCreateError(e instanceof Error ? e.message : String(e)),
  });

  const setRole = useMutation({
    mutationFn: (v: { id: number; role: Role }) => api.setUserRole(v.id, v.role),
    onSuccess: invalidate,
  });
  const setActive = useMutation({
    mutationFn: (v: { id: number; active: boolean }) => api.setUserActive(v.id, v.active),
    onSuccess: invalidate,
  });
  const resetPw = useMutation({
    mutationFn: (v: { id: number; password: string }) => api.resetUserPassword(v.id, v.password),
    onSuccess: () => {
      setResetTarget(null);
      setResetPassword("");
      setResetError("");
    },
    onError: (e) => setResetError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="space-y-5">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-medium text-slate-500 border-b border-slate-200">
              <th className="px-2 py-2.5">{t("settings.usersPanel.name")}</th>
              <th className="px-2 py-2.5">{t("settings.usersPanel.username")}</th>
              <th className="px-2 py-2.5">{t("settings.usersPanel.role")}</th>
              <th className="px-2 py-2.5">{t("settings.usersPanel.active")}</th>
              <th className="px-2 py-2.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {users.data?.map((u) => (
              <tr key={u.id}>
                <td className="px-2 py-2.5 text-slate-800">{u.display_name}</td>
                <td className="px-2 py-2.5 text-slate-500">{u.username}</td>
                <td className="px-2 py-2.5">
                  <select
                    className="select !py-1 !text-xs"
                    value={u.role}
                    disabled={u.id === me?.id}
                    onChange={(e) => setRole.mutate({ id: u.id, role: e.target.value as Role })}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{t(`auth.roles.${r}`)}</option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-2.5">
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-brand-600"
                      checked={u.active}
                      disabled={u.id === me?.id}
                      onChange={(e) => setActive.mutate({ id: u.id, active: e.target.checked })}
                    />
                  </label>
                </td>
                <td className="px-2 py-2.5 text-right">
                  {resetTarget === u.id ? (
                    <div className="flex items-center gap-1.5 justify-end">
                      <input
                        className="field !py-1 !text-xs w-32"
                        type="password"
                        placeholder={t("settings.usersPanel.newPassword")}
                        value={resetPassword}
                        onChange={(e) => setResetPassword(e.target.value)}
                        autoFocus
                      />
                      <button
                        type="button"
                        className="btn-primary !py-1 !px-2.5 !text-xs"
                        disabled={resetPw.isPending}
                        onClick={() => resetPw.mutate({ id: u.id, password: resetPassword })}
                      >
                        {t("common.save")}
                      </button>
                      <button
                        type="button"
                        className="text-xs text-slate-400 hover:text-slate-600"
                        onClick={() => {
                          setResetTarget(null);
                          setResetPassword("");
                          setResetError("");
                        }}
                      >
                        {t("common.cancel")}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="text-xs text-brand-600 hover:underline"
                      onClick={() => setResetTarget(u.id)}
                    >
                      {t("settings.usersPanel.resetPassword")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {users.data?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-2 py-8 text-center text-slate-400">{t("settings.usersPanel.none")}</td>
              </tr>
            )}
          </tbody>
        </table>
        {resetError && <p className="mt-2 text-xs text-amber-600">{resetError}</p>}
      </div>

      <form
        className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-slate-100 pt-5"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <h3 className="sm:col-span-2 text-sm font-semibold text-brand-700">{t("settings.usersPanel.addUser")}</h3>
        <label className="block">
          <span className="label mb-1 block">{t("settings.usersPanel.name")}</span>
          <input
            className="field"
            value={form.display_name}
            onChange={(e) => setForm({ ...form, display_name: e.target.value })}
            required
          />
        </label>
        <label className="block">
          <span className="label mb-1 block">{t("settings.usersPanel.username")}</span>
          <input
            className="field"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            required
          />
        </label>
        <label className="block">
          <span className="label mb-1 block">{t("auth.password")}</span>
          <input
            className="field"
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            minLength={6}
            required
          />
        </label>
        <label className="block">
          <span className="label mb-1 block">{t("settings.usersPanel.role")}</span>
          <select
            className="select"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>{t(`auth.roles.${r}`)}</option>
            ))}
          </select>
        </label>
        {createError && <p className="sm:col-span-2 text-sm text-amber-600">{createError}</p>}
        <button type="submit" className="btn-primary sm:col-span-2 w-fit" disabled={create.isPending}>
          {create.isPending ? t("common.saving") : t("settings.usersPanel.addUser")}
        </button>
      </form>
    </div>
  );
}

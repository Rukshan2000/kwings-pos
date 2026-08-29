import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { useAuth } from "../auth";

export default function ForcePasswordChange() {
  const { t } = useTranslation();
  const { clearMustChangePassword, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (newPassword !== confirm) {
      setError(t("auth.passwordsDontMatch"));
      return;
    }
    setSaving(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      clearMustChangePassword();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-50 dark:bg-slate-800 px-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-7 space-y-4">
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">{t("auth.mustChangePassword")}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t("auth.mustChangePasswordHint")}</p>
        <label className="block">
          <span className="label mb-1 block">{t("auth.currentPassword")}</span>
          <input
            className="field"
            type="password"
            autoFocus
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="label mb-1 block">{t("auth.newPassword")}</span>
          <input
            className="field"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={6}
          />
        </label>
        <label className="block">
          <span className="label mb-1 block">{t("auth.confirmPassword")}</span>
          <input
            className="field"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={6}
          />
        </label>
        {error && <p className="text-sm text-amber-600">{error}</p>}
        <div className="flex gap-2">
          <button type="submit" className="btn-primary flex-1" disabled={saving}>
            {saving ? t("common.saving") : t("auth.setPassword")}
          </button>
          <button type="button" className="btn-secondary" onClick={() => logout()}>
            {t("auth.signOut")}
          </button>
        </div>
      </form>
    </div>
  );
}

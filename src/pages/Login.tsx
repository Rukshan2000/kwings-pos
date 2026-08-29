import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth";

export default function Login() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [signingIn, setSigningIn] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSigningIn(true);
    setError("");
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-50 px-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-7 space-y-4">
        <div className="flex flex-col items-center gap-2 mb-2">
          <img src="/pos-logo-black.png" alt="" className="h-14 w-14 object-contain" />
          <h1 className="text-lg font-semibold text-slate-800">{t("auth.signIn")}</h1>
        </div>
        <label className="block">
          <span className="label mb-1 block">{t("auth.username")}</span>
          <input
            className="field"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="label mb-1 block">{t("auth.password")}</span>
          <input
            className="field"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <p className="text-sm text-amber-600">{error}</p>}
        <button type="submit" className="btn-primary w-full" disabled={signingIn}>
          {signingIn ? t("common.saving") : t("auth.signIn")}
        </button>
      </form>
    </div>
  );
}

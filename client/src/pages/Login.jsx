import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getAuthStatus, loginWithPassword } from '../services/api';

// Constrain the `?next=` redirect target to a same-origin in-app path.
// Reject absolute URLs (`https://attacker.example`), protocol-relative
// (`//attacker.example`), and non-http schemes (`javascript:alert(1)`).
// Anything else falls back to `/` — a crafted login link can't bounce the
// user off-origin after sign-in, and can't execute script via the
// auth-disabled auto-redirect branch in the effect below. Exported for
// unit tests.
export const sanitizeNext = (raw) => {
  if (typeof raw !== 'string' || raw.length === 0) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//')) return '/';        // protocol-relative URL
  if (raw.startsWith('/\\')) return '/';       // some browsers normalize `\\` → `//`
  return raw;
};

// Single-password sign-in. Shown when settings.secrets.auth.enabled is true
// and the request has no valid session token. When auth is off, the page
// auto-redirects to "next" (or `/`) so a stale bookmark to /login doesn't
// become a dead end.
export default function Login() {
  const [search] = useSearchParams();
  const next = useMemo(() => sanitizeNext(search.get('next')), [search]);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [authEnabled, setAuthEnabled] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getAuthStatus({ silent: true }).then((s) => {
      if (cancelled) return;
      if (!s?.enabled) {
        window.location.replace(next);
        return;
      }
      setAuthEnabled(true);
    }).catch(() => {
      // If even /api/auth/status fails, the server is unreachable — let the
      // user retry by leaving the form rendered.
      if (!cancelled) setAuthEnabled(true);
    });
    return () => { cancelled = true; };
  }, [next]);

  const submit = async (event) => {
    event.preventDefault();
    if (submitting || !password) return;
    setError(null);
    setSubmitting(true);
    const result = await loginWithPassword(password).catch((err) => err);
    setSubmitting(false);
    if (result instanceof Error) {
      setError(result.code === 'AUTH_BAD_PASSWORD' ? 'Incorrect password' : result.message);
      return;
    }
    // Full reload so the bootstrapping useTimezoneBootstrap + socket reconnect
    // pick up the freshly-set cookie. navigate() alone would leave the socket
    // in its connect_error state.
    window.location.replace(next);
  };

  if (authEnabled === null) {
    return <div className="min-h-dvh-cap bg-port-bg" />;
  }

  return (
    <div className="min-h-dvh-cap bg-port-bg flex items-center justify-center p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm bg-port-card border border-port-border rounded-lg p-6 space-y-4"
      >
        <div>
          <h1 className="text-2xl font-bold text-white">PortOS</h1>
          <p className="text-sm text-gray-400 mt-1">Sign in to continue</p>
        </div>
        <div>
          <label htmlFor="login-password" className="block text-sm text-gray-300 mb-1">Password</label>
          <input
            id="login-password"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white focus:border-port-accent focus:outline-none"
          />
        </div>
        {error && (
          <div className="text-sm text-port-error">{error}</div>
        )}
        <button
          type="submit"
          disabled={submitting || !password}
          className="w-full bg-port-accent text-white py-2 rounded font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

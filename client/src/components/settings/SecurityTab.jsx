import { useEffect, useState } from 'react';
import { Lock, ShieldCheck, ShieldOff } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import { getAuthStatus, setAuthPassword, clearAuthPassword } from '../../services/api';

// PortOS is single-user and normally trusted because it's tailnet-only — auth
// here is opt-in defense against an attacker on the same network (a sidecar
// on the same tailnet, an unattended workstation). When off, every request
// is accepted as it always was. When on, every /api request needs a valid
// session cookie obtained by /api/auth/login.
export function SecurityTab() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [showDisable, setShowDisable] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [disabling, setDisabling] = useState(false);

  useEffect(() => {
    getAuthStatus({ silent: true })
      .then((s) => setEnabled(!!s?.enabled))
      .catch(() => null)
      .finally(() => setLoading(false));
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (saving) return;
    if (newPassword.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    if (enabled && !currentPassword) {
      toast.error('Enter your current password to change it');
      return;
    }
    setSaving(true);
    const result = await setAuthPassword({
      newPassword,
      currentPassword: enabled ? currentPassword : undefined,
    }).catch((err) => err);
    setSaving(false);
    if (result instanceof Error) {
      toast.error(result.code === 'AUTH_BAD_CURRENT' ? 'Current password is incorrect' : (result.message || 'Save failed'));
      return;
    }
    setEnabled(true);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    toast.success(enabled ? 'Password updated' : 'Login password enabled');
  };

  const handleDisable = async () => {
    if (!disablePassword) {
      toast.error('Enter your current password to disable auth');
      return;
    }
    setDisabling(true);
    const result = await clearAuthPassword({ currentPassword: disablePassword }).catch((err) => err);
    setDisabling(false);
    if (result instanceof Error) {
      toast.error(result.code === 'AUTH_BAD_CURRENT' ? 'Current password is incorrect' : (result.message || 'Disable failed'));
      return;
    }
    setEnabled(false);
    setShowDisable(false);
    setDisablePassword('');
    toast.success('Login password disabled');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <BrailleSpinner text="Loading" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <div className="flex items-start gap-3">
          {enabled
            ? <ShieldCheck className="w-6 h-6 text-port-success shrink-0" />
            : <ShieldOff className="w-6 h-6 text-port-warning shrink-0" />}
          <div>
            <h2 className="text-lg font-semibold text-white">
              Login password {enabled ? 'enabled' : 'disabled'}
            </h2>
            <p className="text-sm text-gray-400 mt-1">
              PortOS is normally reachable to anything on your tailnet. Setting a
              password gates the UI and API behind a single shared secret —
              useful when other devices or sidecars share the network.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
      <form onSubmit={handleSubmit} className="bg-port-card border border-port-border rounded-lg p-4 space-y-4">
        <h3 className="text-md font-semibold text-white flex items-center gap-2">
          <Lock className="w-4 h-4" /> {enabled ? 'Change password' : 'Set a password'}
        </h3>
        {enabled && (
          <div>
            <label htmlFor="security-current" className="block text-sm text-gray-300 mb-1">Current password</label>
            <input
              id="security-current"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white focus:border-port-accent focus:outline-none"
            />
          </div>
        )}
        <div>
          <label htmlFor="security-new" className="block text-sm text-gray-300 mb-1">New password</label>
          <input
            id="security-new"
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white focus:border-port-accent focus:outline-none"
          />
          <p className="text-xs text-gray-500 mt-1">Minimum 8 characters.</p>
        </div>
        <div>
          <label htmlFor="security-confirm" className="block text-sm text-gray-300 mb-1">Confirm new password</label>
          <input
            id="security-confirm"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white focus:border-port-accent focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={saving || !newPassword || !confirmPassword || (enabled && !currentPassword)}
          className="bg-port-accent text-white px-4 py-2 rounded font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
        >
          {saving ? 'Saving…' : (enabled ? 'Update password' : 'Enable login')}
        </button>
      </form>

      {enabled && (
        <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
          <h3 className="text-md font-semibold text-white">Disable login password</h3>
          <p className="text-sm text-gray-400">
            Turn auth back off. PortOS will be reachable without a password again.
          </p>
          {!showDisable ? (
            <button
              type="button"
              onClick={() => setShowDisable(true)}
              className="bg-port-bg border border-port-border text-port-error px-3 py-2 rounded hover:border-port-error"
            >
              Disable login
            </button>
          ) : (
            <div className="space-y-3">
              <div>
                <label htmlFor="security-disable" className="block text-sm text-gray-300 mb-1">Enter current password to confirm</label>
                <input
                  id="security-disable"
                  type="password"
                  autoComplete="current-password"
                  value={disablePassword}
                  onChange={(e) => setDisablePassword(e.target.value)}
                  className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white focus:border-port-accent focus:outline-none"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleDisable}
                  disabled={disabling || !disablePassword}
                  className="bg-port-error text-white px-3 py-2 rounded disabled:opacity-50 hover:opacity-90"
                >
                  {disabling ? 'Disabling…' : 'Confirm disable'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowDisable(false); setDisablePassword(''); }}
                  className="bg-port-bg border border-port-border text-gray-300 px-3 py-2 rounded"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

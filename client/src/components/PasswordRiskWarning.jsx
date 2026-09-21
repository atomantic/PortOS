import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { getPasswordRiskStatus, acknowledgePasswordRisk } from '../services/apiAuth.js';
import Modal from './ui/Modal.jsx';

export default function PasswordRiskWarning() {
  const { pathname } = useLocation();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const load = useCallback(() => {
    const current = ++generation.current;
    getPasswordRiskStatus({ silent: true }).then((value) => {
      if (current !== generation.current) return;
      if (typeof value?.enabled !== 'boolean' || typeof value?.acknowledgementRequired !== 'boolean') {
        setError('PortOS could not confirm password protection. Check Security settings or retry.');
        return;
      }
      setStatus(value);
      setError('');
    }).catch(() => {
      if (current === generation.current) setError('PortOS could not confirm password protection. Check Security settings or retry.');
    });
  }, []);

  useEffect(() => {
    load();
    window.addEventListener('focus', load);
    window.addEventListener('portos:auth-changed', load);
    return () => {
      generation.current += 1;
      window.removeEventListener('focus', load);
      window.removeEventListener('portos:auth-changed', load);
    };
  }, [load, pathname]);

  const acknowledge = async () => {
    if (!accepted || saving) return;
    setSaving(true);
    const result = await acknowledgePasswordRisk({ silent: true }).catch(() => null);
    setSaving(false);
    if (result?.acknowledgementRequired !== false || typeof result?.enabled !== 'boolean') {
      setError('Risk acceptance could not be saved. Try again or set a password.');
      return;
    }
    generation.current += 1;
    setStatus(result);
    setError('');
    setAccepted(false);
  };

  // Leave the password form usable without silently acknowledging the risk.
  // Leaving this route rechecks server state; a failed/cancelled setup warns again.
  if (pathname === '/settings/security') return null;
  const required = status?.acknowledgementRequired === true;
  if (!required && !error) return null;
  return (
    <Modal open closeOnEsc={false} closeOnBackdrop={false} usePortal ariaLabelledBy="password-risk-title"
      panelClassName="bg-port-card border border-port-warning rounded-lg p-5 space-y-4">
      <h2 id="password-risk-title" className="text-xl font-semibold text-port-warning">
        {required ? 'Protect this PortOS host with a password' : 'Check PortOS password protection'}
      </h2>
      <p>PortOS can run commands and read or change files on this computer. Without a password, any device that can reach its APIs may gain that access, including a compromised machine on your LAN or Tailscale network.</p>
      <p>Set a strong, unique PortOS password to reduce this risk. Keep PortOS on your private network: a password does not make public internet exposure through Cloudflare tunnels, gateways, or port forwarding safe.</p>
      {error && <p role="alert" className="text-port-error">{error}</p>}
      {required && <label htmlFor="password-risk-accept" className="flex items-start gap-3">
        <input id="password-risk-accept" type="checkbox" checked={accepted} disabled={saving}
          onChange={(event) => setAccepted(event.target.checked)} className="mt-1" />
        <span>I understand and accept the risk of other reachable devices accessing this host without a PortOS password.</span>
      </label>}
      <div className="flex flex-col sm:flex-row gap-3">
        <Link to="/settings/security" className="min-h-11 px-4 py-2 bg-port-accent text-white rounded text-center">Set a PortOS password</Link>
        {required && <button type="button" disabled={!accepted || saving} onClick={acknowledge}
          className="min-h-11 px-4 py-2 border border-port-border rounded disabled:opacity-50">
          {saving ? 'Saving…' : 'Accept risk and dismiss'}
        </button>}
        {error && <button type="button" onClick={load} disabled={saving} className="min-h-11 px-4 py-2 border border-port-border rounded">Retry</button>}
      </div>
    </Modal>
  );
}

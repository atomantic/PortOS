import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { getPasswordRiskStatus } from '../services/apiAuth.js';
import { safeReadStorage, safeWriteStorage, safeRemoveStorage } from '../lib/safeStorage.js';
import Modal from './ui/Modal.jsx';

const ACKNOWLEDGEMENT_KEY = 'portos-password-risk-v1';

export default function PasswordRiskWarning() {
  const { pathname } = useLocation();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [acknowledgedRevision, setAcknowledgedRevision] = useState(null);
  const generation = useRef(0);
  const load = useCallback(() => {
    const current = ++generation.current;
    getPasswordRiskStatus({ silent: true }).then((value) => {
      if (current !== generation.current) return;
      if (typeof value?.enabled !== 'boolean' || typeof value?.revision !== 'string' || !value.revision) {
        setStatus(null);
        setError('PortOS could not confirm password protection. Check Security settings or retry.');
        return;
      }
      if (value.enabled) safeRemoveStorage(ACKNOWLEDGEMENT_KEY);
      setAcknowledgedRevision(value.enabled ? null : safeReadStorage(ACKNOWLEDGEMENT_KEY));
      setAccepted(false);
      setStatus(value);
      setError('');
    }).catch(() => {
      if (current !== generation.current) return;
      setStatus(null);
      setError('PortOS could not confirm password protection. Check Security settings or retry.');
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

  const acknowledge = () => {
    if (!accepted || status?.enabled !== false) return;
    safeWriteStorage(ACKNOWLEDGEMENT_KEY, status.revision);
    if (safeReadStorage(ACKNOWLEDGEMENT_KEY) !== status.revision) {
      setError('Risk acceptance could not be saved in this browser. Try again or set a password.');
      return;
    }
    setAcknowledgedRevision(status.revision);
    setError('');
    setAccepted(false);
  };

  // Leave the password form usable without silently acknowledging the risk.
  // Leaving this route rechecks server state; a failed/cancelled setup warns again.
  if (pathname === '/settings/security') return null;
  const required = status?.enabled === false && acknowledgedRevision !== status.revision;
  if (!required && !error) return null;
  return (
    <Modal open closeOnEsc={false} closeOnBackdrop={false} usePortal ariaLabelledBy="password-risk-title"
      panelClassName="bg-port-card border border-port-warning rounded-lg p-5 space-y-4">
      <h2 id="password-risk-title" className="text-xl font-semibold text-port-warning">
        {required ? 'Protect this PortOS host with a password' : 'Check PortOS password protection'}
      </h2>
      <p>PortOS can run commands and read or change files on this computer. Without a password, any device that can reach its APIs may gain that access, including a compromised machine on your LAN or Tailscale network.</p>
      <p>Set a strong, unique PortOS password to reduce this risk. Keep PortOS on your private network: a password does not make public internet exposure through Cloudflare tunnels, gateways, or port forwarding safe.</p>
      <p>Risk acceptance applies only to this browser. Other browsers will ask separately.</p>
      {error && <p role="alert" className="text-port-error">{error}</p>}
      {required && <label htmlFor="password-risk-accept" className="flex items-start gap-3">
        <input id="password-risk-accept" type="checkbox" checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)} className="mt-1" />
        <span>I understand and accept the risk of other reachable devices accessing this host without a PortOS password.</span>
      </label>}
      <div className="flex flex-col sm:flex-row gap-3">
        <Link to="/settings/security" className="min-h-11 px-4 py-2 bg-port-accent text-white rounded text-center">Set a PortOS password</Link>
        {required && <button type="button" disabled={!accepted} onClick={acknowledge}
          className="min-h-11 px-4 py-2 border border-port-border rounded disabled:opacity-50">
          Accept risk and dismiss
        </button>}
        {error && <button type="button" onClick={load} className="min-h-11 px-4 py-2 border border-port-border rounded">Retry</button>}
      </div>
    </Modal>
  );
}

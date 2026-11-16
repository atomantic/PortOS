/**
 * Password-free access warning shown until the operator accepts the risk or sets a password.
 *
 * Browser storage: acceptance is a per-origin `localStorage` preference under the
 * versioned `portos-password-risk-v1` key, bound to the server's revision — not an
 * app record, never federated or backed up, and no API can acknowledge it for
 * another browser. Missing or unreadable storage asks for consent again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { getAuthStatus, getPasswordRiskStatus } from '../services/apiAuth.js';
import { isServerUnreachable } from '../services/apiCore.js';
import { CircleAlert } from 'lucide-react';
import { safeReadSession, safeReadStorage, safeWriteSession, safeWriteStorage, safeRemoveStorage } from '../lib/safeStorage.js';
import socket from '../services/socket.js';
import Banner from './ui/Banner.jsx';
import Modal from './ui/Modal.jsx';

const ACKNOWLEDGEMENT_KEY = 'portos-password-risk-v1';
const CHECK_DISMISSED_KEY = 'portos-password-check-dismissed-v1';

export default function PasswordRiskWarning() {
  const { pathname } = useLocation();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [checkDismissed, setCheckDismissed] = useState(() => safeReadSession(CHECK_DISMISSED_KEY) === 'true');
  const [accepted, setAccepted] = useState(false);
  const [acknowledgedRevision, setAcknowledgedRevision] = useState(null);
  const generation = useRef(0);
  const load = useCallback(() => {
    const current = ++generation.current;
    const showCheckError = async (initialErr) => {
      // Older servers and transient failures may make the risk endpoint unavailable.
      // The login gate's public endpoint can still confirm password protection.
      try {
        const auth = await getAuthStatus({ silent: true });
        if (current !== generation.current) return;
        if (auth?.enabled === true) {
          setStatus({ enabled: true });
          setError('');
          return;
        }
        setStatus(null);
        setError('PortOS could not confirm whether this host is password protected. Do not assume it is protected: retry or check Security settings.');
      } catch (authErr) {
        if (current !== generation.current) return;
        if (isServerUnreachable(authErr) || isServerUnreachable(initialErr)) {
          // If the server is unreachable (restarting, updating, offline),
          // do not clear known status or show a confusing warning about setting a password.
          setError('');
          return;
        }
        setStatus(null);
        setError('PortOS could not confirm whether this host is password protected. Do not assume it is protected: retry or check Security settings.');
      }
    };
    getPasswordRiskStatus({ silent: true }).then((value) => {
      if (current !== generation.current) return;
      if (typeof value?.enabled !== 'boolean' || (value.enabled === false && (typeof value?.revision !== 'string' || !value.revision))) {
        return showCheckError();
      }
      if (value.enabled) safeRemoveStorage(ACKNOWLEDGEMENT_KEY);
      setAcknowledgedRevision(value.enabled ? null : safeReadStorage(ACKNOWLEDGEMENT_KEY));
      setAccepted(false);
      setStatus(value);
      setError('');
    }).catch((err) => {
      if (current !== generation.current) return;
      if (isServerUnreachable(err)) {
        setError('');
        return;
      }
      return showCheckError(err);
    });
  }, []);

  useEffect(() => {
    load();
    window.addEventListener('focus', load);
    window.addEventListener('online', load);
    window.addEventListener('portos:auth-changed', load);
    socket.on('connect', load);
    return () => {
      generation.current += 1;
      window.removeEventListener('focus', load);
      window.removeEventListener('online', load);
      window.removeEventListener('portos:auth-changed', load);
      socket.off('connect', load);
    };
  }, [load, pathname]);

  const dismissCheck = () => {
    safeWriteSession(CHECK_DISMISSED_KEY, 'true');
    setCheckDismissed(true);
  };

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
  if (!required && (!error || checkDismissed)) return null;
  // A failed status check is a diagnostic the user cannot resolve here, so it
  // must not block the app; only a confirmed password-free install does.
  if (!required) {
    const bannerButton = 'min-h-[44px] rounded px-3 py-2 text-xs pointer-fine:lg:min-h-0 lg:py-1';
    return (
      <div className="shrink-0 px-3 pt-2 print:hidden">
        <Banner tone="warning" icon={CircleAlert} align="center" role="alert"
          actions={(
            <div className="flex flex-col gap-1 sm:flex-row sm:gap-2">
              <button type="button" onClick={load}
                className={`${bannerButton} bg-port-warning font-medium text-black hover:bg-port-warning/80`}>Retry</button>
              <Link to="/settings/security"
                className={`${bannerButton} bg-gray-600 text-center text-white hover:bg-gray-500`}>Open Security settings</Link>
              <button type="button" onClick={dismissCheck}
                className={`${bannerButton} bg-gray-600 text-white hover:bg-gray-500`}>Dismiss</button>
            </div>
          )}>
          {error}
        </Banner>
      </div>
    );
  }
  return (
    <Modal open closeOnEsc={false} closeOnBackdrop={false} usePortal ariaLabelledBy="password-risk-title"
      panelClassName="bg-port-card border border-port-warning rounded-lg p-5 space-y-4">
      <h2 id="password-risk-title" className="text-xl font-semibold text-port-warning">
        Protect this PortOS host with a password
      </h2>
      <p>PortOS can run commands and read or change files on this computer. Without a password, any device that can reach its APIs may gain that access, including a compromised machine on your LAN or Tailscale network.</p>
      <p>Set a strong, unique PortOS password to reduce this risk. Keep PortOS on your private network: a password does not make public internet exposure through Cloudflare tunnels, gateways, or port forwarding safe.</p>
      <p>Risk acceptance applies only to this browser. Other browsers will ask separately.</p>
      {error && <p role="alert" className="text-port-error">{error}</p>}
      <label htmlFor="password-risk-accept" className="flex items-start gap-3">
        <input id="password-risk-accept" type="checkbox" checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)} className="mt-1" />
        <span>I understand and accept the risk of other reachable devices accessing this host without a PortOS password.</span>
      </label>
      <div className="flex flex-col sm:flex-row gap-3">
        <Link to="/settings/security" className="min-h-11 px-4 py-2 bg-port-accent text-white rounded text-center">Set a PortOS password</Link>
        <button type="button" disabled={!accepted} onClick={acknowledge}
          className="min-h-11 px-4 py-2 border border-port-border rounded disabled:opacity-50">
          Accept risk and dismiss
        </button>
      </div>
    </Modal>
  );
}

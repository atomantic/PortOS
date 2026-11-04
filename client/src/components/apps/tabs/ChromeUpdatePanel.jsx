import { Link } from 'react-router';
import { Globe } from 'lucide-react';
import * as api from '../../../services/api';
import { useSocketResource } from '../../../hooks/useSocketResource';

const EVENTS = ['review:queue:changed'];
const readStatus = () => api.getBrowserUpdateStatus({ silent: true });

export default function ChromeUpdatePanel() {
  const { data: status, error } = useSocketResource(readStatus, { events: EVENTS });
  const state = error ? 'unverified' : status?.state || 'checking';
  const observed = ['current', 'restart-required', 'downgrade-risk'].includes(state);
  const releases = [['Apple silicon', status?.publishedVersions?.mac_arm64], ['Intel', status?.publishedVersions?.mac]]
    .filter(([, version]) => version).map(([platform, version]) => `${platform} ${version}`).join('; ');
  return (
    <div className="p-4 rounded-lg border border-port-border bg-port-card space-y-2">
      <div className="text-sm text-white font-medium flex items-center gap-2"><Globe size={15} className="text-port-accent" /> CDP browser updates</div>
      {state === 'checking' && <p className="text-sm text-gray-400">Checking Chrome…</p>}
      {state === 'stopped' && <p className="text-sm text-gray-400">The browser supervisor is stopped.</p>}
      {state === 'unsupported' && <p className="text-sm text-gray-400">Update comparison is available for Google Chrome on macOS.</p>}
      {state === 'unverified' && <p className="text-sm text-gray-400">Chrome update status could not be verified. Checks continue automatically.</p>}
      {state === 'configuration-mismatch' && <p className="text-sm text-port-warning">The connected browser differs from the configured app. Review the browser settings.</p>}
      {['older', 'channel-changed'].includes(status?.restartVerification?.state) && <p className="text-sm text-port-warning">After the restart, Chrome differs from the reviewed version {status.restartVerification.expectedVersion}. Review the installed app and browser configuration.</p>}
      {status?.restartVerification?.state === 'newer' && <p className="text-xs text-gray-400">The browser started with a newer version than the one reviewed.</p>}
      {observed && <>
        <p className="text-sm text-gray-300">Running {status.runningVersion}; installed {status.installedVersion}.</p>
        {releases && <p className="text-xs text-gray-400">Google’s published {status.channel} feed for macOS: {releases}. Rollout availability can differ.</p>}
        <p className="text-xs text-gray-400">Chrome’s effective update channel and automatic-update status have not been verified.</p>
      </>}
      {state === 'restart-required' && <p className="text-sm text-port-warning">An installed update needs a browser restart. Save open work first.</p>}
      {state === 'downgrade-risk' && <p className="text-sm text-port-warning">The installed Chrome is older than the running browser. Update the installed app before restarting.</p>}
      {(state === 'downgrade-risk' || status?.restartVerification?.state === 'older') && <a href="https://support.google.com/chrome/answer/95414" target="_blank" rel="noreferrer"
        className="inline-flex rounded-lg border border-port-border px-3 py-1.5 text-sm text-port-accent hover:border-port-accent">Chrome update instructions</a>}
      {(state === 'restart-required' || state === 'configuration-mismatch' || status?.restartVerification?.state === 'channel-changed') &&
        <Link to="/browser" className="inline-flex rounded-lg border border-port-border px-3 py-1.5 text-sm text-port-accent hover:border-port-accent">Open browser controls</Link>}
    </div>
  );
}

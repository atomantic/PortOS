import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, Cpu, Loader2, ShieldAlert } from 'lucide-react';
import * as api from '../../../services/api';
import { useSocketResource } from '../../../hooks/useSocketResource';
import { copyToClipboard } from '../../../lib/clipboard';
import { formatDateNumeric } from '../../../utils/formatters';

const STATUS_EVENTS = ['portos:node-runtime:changed'];

const SOURCE_LABELS = { nvm: 'nvm', homebrew: 'Homebrew', other: 'system' };

/**
 * The Node.js runtime PortOS runs on, with in-place updates of Node (via nvm)
 * and pm2. Both actions restart PortOS through the ordinary update lifecycle,
 * so they launch through the Update tab's `onLaunch` — that is what arms the
 * restart watch and renders the step list below the buttons.
 */
export default function NodeRuntimePanel({ onLaunch, busy = false }) {
  const { data: status, loading, refetch } = useSocketResource(
    () => api.getNodeRuntimeStatus({ silent: true }), { events: STATUS_EVENTS }
  );
  const offers = status?.releases?.offers || [];
  const [selected, setSelected] = useState(null);
  const [pending, setPending] = useState(null);

  useEffect(() => {
    if (!offers.length) setSelected(null);
    else if (!offers.some((offer) => offer.version === selected)) setSelected(offers[0].version);
  }, [offers, selected]);

  if (loading && !status) {
    return (
      <div className="p-4 rounded-lg border border-port-border bg-port-card text-sm text-gray-400 flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Reading Node.js runtime…
      </div>
    );
  }
  if (!status) return null;

  const { node, nvm, releases, pm2, startup } = status;
  const jobRunning = Boolean(status.job);
  const disabled = busy || jobRunning || pending !== null;
  const pm2Behind = pm2.daemonStale || pm2.cliBehind;

  const launch = async (kind, call) => {
    setPending(kind);
    await onLaunch(call);
    setPending(null);
  };

  // No restart, so it does not go through the Update tab's launch.
  const fixStartup = async () => {
    setPending('startup');
    const result = await api.repairNodeStartup().catch(() => null);
    setPending(null);
    if (result?.fixed) refetch();
  };

  return (
    <div className="p-4 rounded-lg border border-port-border bg-port-card space-y-4">
      <div>
        <div className="text-sm text-white font-medium flex items-center gap-2">
          <Cpu size={15} className="text-port-accent" /> Node.js runtime
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-lg font-mono text-white">{node.version}</span>
          <span className="px-2 py-0.5 rounded-full bg-port-border text-xs text-gray-300">{SOURCE_LABELS[node.source] || node.source}</span>
          {releases?.securityUpdate && (
            <span className="px-2 py-0.5 rounded-full bg-port-error/20 text-port-error text-xs flex items-center gap-1">
              <ShieldAlert size={12} /> Security update
            </span>
          )}
        </div>
        <div className="mt-1 text-xs text-gray-500 font-mono break-all">{node.execPath}</div>
        {!node.inSupportedRange && (
          <div className="mt-2 text-xs text-port-warning flex items-start gap-1">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" /> Outside PortOS’s supported range ({node.supportedRange}).
          </div>
        )}
      </div>

      {status.releasesError && <div role="status" className="text-xs text-gray-400">{status.releasesError}</div>}

      {releases && offers.length === 0 && (
        <div className="text-sm text-port-success flex items-center gap-2">
          <Check size={14} /> Latest stable Node for this line
        </div>
      )}

      {offers.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-xs text-gray-500 uppercase tracking-wide mb-2">Update to</legend>
          {offers.map((offer) => (
            <label
              key={offer.version}
              htmlFor={`node-offer-${offer.version}`}
              className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer ${selected === offer.version ? 'border-port-accent bg-port-accent/10' : 'border-port-border'}`}
            >
              <input
                id={`node-offer-${offer.version}`}
                type="radio"
                name="node-offer"
                className="accent-port-accent"
                checked={selected === offer.version}
                onChange={() => setSelected(offer.version)}
                disabled={disabled}
              />
              <span className="font-mono text-white">{offer.version}</span>
              <span className="text-xs text-gray-400 flex-1">
                {offer.label}{offer.lts ? ` · ${offer.lts}` : ''}
              </span>
              {offer.date && <span className="text-xs text-gray-500">{formatDateNumeric(offer.date)}</span>}
            </label>
          ))}
          {status.canUpdate ? (
            <button
              type="button"
              onClick={() => launch('node', () => api.updateNodeRuntime(selected))}
              disabled={disabled || !selected}
              className="w-full sm:w-auto px-4 py-2 bg-port-accent text-white rounded-lg text-sm flex items-center justify-center gap-2 hover:bg-port-accent/80 disabled:opacity-50"
            >
              {pending === 'node' || status.job?.kind === 'node-update' ? <Loader2 size={14} className="animate-spin" /> : null}
              Update Node to {selected} and restart
            </button>
          ) : (
            <div className="text-xs text-port-warning">{status.blockedReason}</div>
          )}
          <div className="text-xs text-gray-500">Waits for renders, agents and jobs to finish. Also pulls the latest PortOS.</div>
        </fieldset>
      )}

      {nvm && (
        <div className="text-xs text-gray-400">
          nvm default <span className="font-mono text-gray-300">{nvm.defaultVersion || '—'}</span> · {nvm.installed.length} installed
          {node.pinned ? null : <> · PortOS uses the first <span className="font-mono">node</span> on pm2’s PATH</>}
        </div>
      )}

      <div className="pt-3 border-t border-port-border">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">pm2</div>
        <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-gray-400">PortOS</dt>
          <dd className="font-mono text-white">
            {pm2.shipped || '—'}
            {pm2.latest && pm2.shipped && pm2.latest !== pm2.shipped && (
              <span className="ml-2 text-xs text-gray-500 font-sans">npm has {pm2.latest}</span>
            )}
          </dd>
          <dt className="text-gray-400">Daemon</dt>
          <dd className={`font-mono ${pm2.daemonStale ? 'text-port-warning' : 'text-white'}`}>
            {pm2.daemon ? `${pm2.daemon.pm2Version || '?'} on Node ${pm2.daemon.nodeVersion || '?'}` : 'unreachable'}
          </dd>
          <dt className="text-gray-400">Terminal</dt>
          <dd className={`font-mono ${pm2.cliBehind ? 'text-port-warning' : 'text-white'}`}>{pm2.cli || 'not installed'}</dd>
        </dl>
        {pm2Behind && (
          <button
            type="button"
            onClick={() => launch('pm2', () => api.updatePm2Runtime())}
            disabled={disabled}
            className="mt-3 w-full sm:w-auto px-4 py-2 bg-port-border text-white rounded-lg text-sm flex items-center justify-center gap-2 hover:bg-port-border/80 disabled:opacity-50"
          >
            {pending === 'pm2' || status.job?.kind === 'pm2-update' ? <Loader2 size={14} className="animate-spin" /> : null}
            Update pm2 to {pm2.shipped}{pm2.daemonStale ? ' and restart' : ''}
          </button>
        )}
      </div>

      {startup && startup.current !== true && (
        <div className="pt-3 border-t border-port-border">
          <div className="text-sm text-port-warning flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            {startup.configured ? 'Start-on-boot still uses another Node.' : 'PortOS doesn’t start on boot.'}
          </div>
          {startup.fixable ? (
            <button
              type="button"
              onClick={fixStartup}
              disabled={pending !== null}
              className="mt-2 w-full sm:w-auto px-4 py-2 bg-port-border text-white rounded-lg text-sm flex items-center justify-center gap-2 hover:bg-port-border/80 disabled:opacity-50"
            >
              {pending === 'startup' ? <Loader2 size={14} className="animate-spin" /> : null}
              Use {node.pinned ? 'PortOS’s Node' : 'this Node'} at boot
            </button>
          ) : (<>
          <div className="text-xs text-gray-400 mt-1">Needs your password, so run it once in Terminal:</div>
          <div className="mt-2 flex items-start gap-2">
            <code className="flex-1 p-2 rounded bg-port-bg border border-port-border text-xs text-gray-300 font-mono break-all">{startup.command}</code>
            <button
              type="button"
              onClick={() => copyToClipboard(startup.command, 'Command copied')}
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 rounded-lg bg-port-border text-gray-300 hover:text-white shrink-0"
              aria-label="Copy start-on-boot command"
            >
              <Copy size={14} />
            </button>
          </div>
          </>)}
        </div>
      )}
    </div>
  );
}

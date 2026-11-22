import { useEffect, useState } from 'react';
import { ArrowUpCircle, Lock, RefreshCw, Unlock, Wrench } from 'lucide-react';
import toast from '../ui/Toast';
import Pill from '../ui/Pill';
import BrailleSpinner from '../BrailleSpinner';
import {
  getHomebrewStatus,
  holdHomebrewPackages,
  repairHomebrewFallout,
  upgradeHomebrewPackages,
} from '../../services/apiSystem.js';
import socket from '../../services/socket';
import { useSocketResource } from '../../hooks/useSocketResource';
import { formatCount, formatDateTime } from '../../utils/formatters';

const EVENTS = ['software:changed'];
const PROGRESS_EVENT = 'software:homebrew';
const readStatus = () => getHomebrewStatus({ silent: true });
const LOG_LINES = 6;

const RISKS = {
  breaking: { label: 'Breaks PortOS', tone: 'error' },
  caution: { label: 'Check after', tone: 'warning' },
  safe: { label: 'Safe', tone: 'success' },
  pinned: { label: 'Held', tone: 'note' },
};
// Breaking upgrades start unticked; everything else is repaired after if needed.
const preselected = (packages) => new Set(packages.filter((pkg) => pkg.risk === 'safe' || pkg.risk === 'caution').map((pkg) => pkg.name));

const buttonClass = 'inline-flex min-h-[36px] items-center gap-1.5 rounded border px-3 text-xs disabled:opacity-50';
const secondaryButton = `${buttonClass} border-port-border text-gray-300 hover:border-port-accent hover:text-white`;
const primaryButton = `${buttonClass} border-port-accent/40 bg-port-accent/10 text-port-accent hover:bg-port-accent/20`;

function PackageRow({ pkg, checked, disabled, onToggle, onHold }) {
  const risk = RISKS[pkg.risk] || RISKS.safe;
  const holdable = pkg.kind === 'formula' && pkg.risk !== 'safe';
  const id = `brew-${pkg.kind}-${pkg.name}`;
  return (
    <li className="flex gap-3 px-3 py-3">
      <input
        id={id}
        type="checkbox"
        className="mt-1 h-4 w-4 shrink-0 accent-port-accent"
        checked={checked}
        disabled={disabled || pkg.risk === 'pinned'}
        onChange={() => onToggle(pkg.name)}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={id} className="text-sm font-medium text-white break-all">{pkg.name}</label>
          {pkg.kind === 'cask' && <span className="text-xs text-gray-500">app</span>}
          <Pill tone={risk.tone} size="xs">{risk.label}</Pill>
          <span className="font-mono text-xs text-gray-300">
            {pkg.installed || '—'} <span className="text-gray-500">→</span> <span className="text-port-accent">{pkg.current}</span>
          </span>
        </div>
        {pkg.reasons.map((reason) => <p key={reason} className="text-xs text-gray-400 break-words">{reason}</p>)}
      </div>
      {holdable && (
        <button type="button" onClick={() => onHold(pkg)} disabled={disabled} className={`${secondaryButton} h-fit shrink-0`}
          title={pkg.risk === 'pinned' ? 'brew unpin: allow upgrades again' : 'brew pin: Homebrew skips it, also in a terminal'}>
          {pkg.risk === 'pinned' ? <Unlock size={13} /> : <Lock size={13} />}
          {pkg.risk === 'pinned' ? 'Release' : 'Hold'}
        </button>
      )}
    </li>
  );
}

/**
 * Settings › Software › Homebrew (macOS): outdated packages with what each upgrade
 * risks for PortOS, upgrades with live progress, Hold (`brew pin`) for packages
 * PortOS depends on, and the post-upgrade check-and-repair. Renders nothing where
 * Homebrew is not supported.
 */
export default function HomebrewUpgrades() {
  const { data, refetch, updateData } = useSocketResource(readStatus, { events: EVENTS });
  const [selected, setSelected] = useState(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [log, setLog] = useState([]);
  // A 409 warning the owner can go ahead past: { message, retry }.
  const [prompt, setPrompt] = useState(null);
  const running = Boolean(data?.job) || starting;

  useEffect(() => {
    const onProgress = (frame = {}) => {
      if (!frame.message) return;
      setLog((lines) => [...lines, frame].slice(-LOG_LINES));
      if (frame.step === 'complete') toast.success(frame.message);
      else if (frame.step === 'error') toast.error(frame.message);
    };
    socket.on(PROGRESS_EVENT, onProgress);
    return () => socket.off(PROGRESS_EVENT, onProgress);
  }, []);

  const packages = data?.packages || [];
  // The selection follows the list until the owner changes it.
  const chosen = selected ?? preselected(packages);
  const chosenNames = packages.filter((pkg) => chosen.has(pkg.name) && pkg.risk !== 'pinned').map((pkg) => pkg.name);

  if (!data?.supported) return null;

  const start = async (launch, acknowledgements = {}) => {
    setPrompt(null);
    setStarting(true);
    setLog([]);
    const result = await launch({ silent: true, ...acknowledgements }).catch((err) => {
      if (err?.code === 'HOMEBREW_UPGRADE_RISK' || err?.code === 'SYSTEM_BUSY') {
        const key = err.code === 'SYSTEM_BUSY' ? 'acknowledgeBusy' : 'acknowledgeRisk';
        setPrompt({ message: err.message, retry: () => start(launch, { ...acknowledgements, [key]: true }) });
      } else {
        toast.error(err?.message || 'Homebrew job failed to start');
      }
      return null;
    });
    if (result?.started) updateData((current) => ({ ...current, job: { kind: result.kind, names: result.names } }));
    setStarting(false);
  };
  const upgrade = () => start((opts) => upgradeHomebrewPackages(chosenNames, opts));
  const repair = () => start((opts) => repairHomebrewFallout(opts));

  const checkNow = async () => {
    setChecking(true);
    const fresh = await getHomebrewStatus({ fresh: true }).catch(() => null);
    if (fresh) { updateData(fresh); setSelected(null); }
    setChecking(false);
  };

  const toggle = (name) => setSelected(() => {
    const next = new Set(chosen);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  const hold = async (pkg) => {
    const holding = pkg.risk !== 'pinned';
    const result = await holdHomebrewPackages([pkg.name], holding).catch(() => null);
    if (!result) return;
    toast.success(`${pkg.name} ${holding ? 'held' : 'released'}`);
    refetch();
  };

  const counts = Object.keys(RISKS)
    .map((risk) => [risk, packages.filter((pkg) => pkg.risk === risk).length])
    .filter(([, count]) => count > 0);
  const failedChecks = (data.lastRun?.results || []).filter((result) => !result.ok);

  return (
    <section className="overflow-hidden rounded-lg border border-port-border bg-port-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-port-border px-3 py-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-gray-400">Homebrew</h3>
        {counts.map(([risk, count]) => <Pill key={risk} tone={RISKS[risk].tone} size="xs">{formatCount(count)} {RISKS[risk].label.toLowerCase()}</Pill>)}
        <div className="ml-auto flex flex-wrap gap-2">
          <button type="button" onClick={repair} disabled={running} className={secondaryButton}>
            <Wrench size={13} /> Check &amp; repair
          </button>
          <button type="button" onClick={checkNow} disabled={checking || running} className={secondaryButton}>
            <RefreshCw size={13} className={checking ? 'animate-spin' : undefined} /> Check Homebrew
          </button>
        </div>
      </div>

      {data.problems?.length > 0 && (
        <div className="space-y-2 border-b border-port-border bg-port-error/10 px-3 py-2">
          {data.problems.map((problem) => (
            <div key={problem.id} className="text-xs">
              <p className="font-medium text-port-error break-words">{problem.label}</p>
              {problem.detail && <p className="font-mono text-gray-400 break-words">{problem.detail}</p>}
              <p className="text-gray-300">{problem.repair}</p>
            </div>
          ))}
          <button type="button" onClick={repair} disabled={running} className={primaryButton}>
            {running ? <BrailleSpinner /> : <Wrench size={13} />} Repair
          </button>
        </div>
      )}

      {prompt && (
        <div className="flex flex-wrap items-center gap-2 border-b border-port-border bg-port-warning/10 px-3 py-2 text-xs text-port-warning">
          <span className="min-w-0 flex-1 break-words">{prompt.message}</span>
          <button type="button" onClick={prompt.retry} className="min-h-[32px] rounded border border-port-warning/50 px-2 hover:bg-port-warning/20">Go ahead anyway</button>
          <button type="button" onClick={() => setPrompt(null)} className="min-h-[32px] px-2 text-gray-400 hover:text-white">Cancel</button>
        </div>
      )}

      {(running || log.length > 0) && (
        <div className="space-y-0.5 border-b border-port-border px-3 py-2 font-mono text-xs">
          {running && <p className="flex items-center gap-2 text-port-accent"><BrailleSpinner /> {data.job?.kind === 'repair' ? 'Checking and repairing…' : `Upgrading${data.job?.current ? ` ${data.job.current}` : ''}…`}</p>}
          {log.map((frame, index) => (
            <p key={index} className={`break-words ${frame.status === 'error' ? 'text-port-error' : 'text-gray-400'}`}>{frame.message}</p>
          ))}
        </div>
      )}

      {!running && failedChecks.length > 0 && (
        <div className="border-b border-port-border px-3 py-2 text-xs">
          {failedChecks.map((result) => <p key={result.id} className="text-port-error break-words">{result.label}: {result.detail}</p>)}
        </div>
      )}

      {packages.length === 0
        ? <p className="px-3 py-3 text-xs text-gray-400">Everything Homebrew manages is up to date.</p>
        : (
          <>
            <ul className="divide-y divide-port-border/60">
              {packages.map((pkg) => (
                <PackageRow key={`${pkg.kind}:${pkg.name}`} pkg={pkg} checked={chosen.has(pkg.name) && pkg.risk !== 'pinned'}
                  disabled={running} onToggle={toggle} onHold={hold} />
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2 border-t border-port-border px-3 py-2">
              <button type="button" onClick={upgrade} disabled={running || chosenNames.length === 0} className={primaryButton}>
                {running ? <BrailleSpinner /> : <ArrowUpCircle size={13} />} Upgrade {formatCount(chosenNames.length)}
              </button>
              <span className="text-xs text-gray-500">PortOS checks and repairs its database, ffmpeg and Python after.</span>
            </div>
          </>
        )}
      {data.checkedAt && <p className="px-3 pb-2 text-right text-xs text-gray-500">Checked {formatDateTime(data.checkedAt)}</p>}
    </section>
  );
}

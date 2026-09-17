import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { CheckCircle2, Download, ExternalLink, Gauge, PowerOff, TerminalSquare } from 'lucide-react';
import toast from '../ui/Toast';
import Pill from '../ui/Pill';
import Banner from '../ui/Banner';
import * as api from '../../services/api';
import useProviderCatalog, { invalidateProviderCatalog } from '../../hooks/useProviderCatalog';
import { formatCount } from '../../utils/formatters';
import ProviderCredentialBootstraps from './ProviderCredentialBootstraps';

/**
 * AI Providers → Harnesses (#7567, epic #7561): one card per registry harness
 * — the program that drives a model — with the switch that decides whether
 * compose offers it, what the machine knows about its binary, the methods it
 * runs, and how many switched-on services it can be pointed at. `direct`
 * (PortOS's own HTTP runner) is always on and says so.
 *
 * Read from the shared composition catalog (`useProviderCatalog`), so a toggle
 * here is one write plus one cache invalidation, and every open picker's
 * compose flow reflects it without a reload. Install/update/remove of the
 * binary itself stays on Models → Harnesses; this card offers the install a
 * missing binary needs and links there for the rest.
 */

/** How the enablement verdict reads under the switch. */
const SOURCE_COPY = {
  always: 'Always on — PortOS runs this itself',
  setting: 'Set by you',
  detected: 'Following the binary: on while it is installed',
  default: 'On by default until the binary is probed',
};

const METHOD_LABEL = { cli: 'CLI', tui: 'TUI', api: 'API' };

/** Every harness whose vendor bills a subscription quota the Quota Burn page tracks. */
const QUOTA_TRACKED = new Set(['claude', 'codex', 'grok', 'antigravity']);

/** How a ChatGPT / Codex sign-in state reads on the harness card. */
const CODEX_STATUS_COPY = {
  ready: 'ChatGPT subscription signed in',
  'signed-out': 'ChatGPT subscription signed out',
  'login-pending': 'ChatGPT sign-in in progress',
  'quota-exhausted': 'ChatGPT usage limit reached',
  'runtime-missing': 'Codex CLI not installed',
};

function HarnessCard({
  harness, runtime, compatibleCount, presetCount, selected, busy,
  codexAccount, onToggle, onInstallRuntime,
}) {
  const ref = useRef(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  const isDirect = harness.id === 'direct';
  const switchId = `harness-enabled-${harness.id}`;
  const codexStatus = harness.id === 'codex' && codexAccount ? codexAccount.status : null;

  return (
    <article
      ref={ref}
      aria-labelledby={`harness-${harness.id}-title`}
      className={`bg-port-card border rounded-xl p-4 space-y-3 ${selected ? 'border-port-accent ring-1 ring-port-accent/40' : 'border-port-border'}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={`harness-${harness.id}-title`} className="text-base font-semibold text-white flex items-center gap-2">
            <TerminalSquare className="w-4 h-4 text-port-accent shrink-0" aria-hidden="true" />
            <Link to={`/ai/harnesses/${encodeURIComponent(harness.id)}`} className="hover:underline">{harness.label}</Link>
            <code className="text-xs font-mono text-gray-500">{harness.id}</code>
          </h3>
          <p className="mt-1 text-xs text-gray-500">{SOURCE_COPY[harness.source] || ''}</p>
        </div>
        {isDirect ? (
          <Pill tone="success" size="xs" icon={CheckCircle2}>Always on</Pill>
        ) : (
          <label htmlFor={switchId} className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
            <input
              id={switchId}
              type="checkbox"
              role="switch"
              aria-checked={harness.enabled}
              checked={harness.enabled}
              disabled={busy}
              onChange={(e) => onToggle(harness, e.target.checked)}
              className="h-4 w-4 accent-port-accent"
            />
            {harness.enabled ? 'Enabled' : 'Disabled'}
          </label>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        {harness.modes.map((mode) => (
          <Pill key={mode} tone="muted" size="xs" mono>{METHOD_LABEL[mode] || mode}</Pill>
        ))}
        <span className="text-gray-400">
          {formatCount(compatibleCount, { fallback: '0' })} compatible service{compatibleCount === 1 ? '' : 's'}
        </span>
        <span className="text-gray-500">·</span>
        <span className="text-gray-400">
          {formatCount(presetCount, { fallback: '0' })} preset{presetCount === 1 ? '' : 's'}
        </span>
      </div>

      {!isDirect && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {harness.detected === true && (
            <Pill tone="success" size="xs" icon={CheckCircle2}>
              Installed{harness.version ? ` · ${harness.version}` : ''}
            </Pill>
          )}
          {harness.detected === false && <Pill tone="warning" size="xs" icon={PowerOff}>Binary not found</Pill>}
          {harness.detected === null && <Pill tone="muted" size="xs">Binary not probed yet</Pill>}
          {harness.detected === false && runtime?.installable && (
            <button
              type="button"
              onClick={() => onInstallRuntime(runtime)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" /> Install {runtime.label}
            </button>
          )}
          {harness.detected === false && runtime && !runtime.installable && runtime.blockedReason && (
            <span className="text-gray-500">{runtime.blockedReason}</span>
          )}
          <Link to="/models/harnesses" className="text-port-accent hover:underline inline-flex items-center gap-1">
            Versions &amp; updates <ExternalLink className="w-3 h-3" aria-hidden="true" />
          </Link>
          {QUOTA_TRACKED.has(harness.id) && (
            <Link to="/devtools/quota-burn" className="text-port-accent hover:underline inline-flex items-center gap-1">
              <Gauge className="w-3 h-3" aria-hidden="true" /> Quota
            </Link>
          )}
        </div>
      )}

      {codexStatus && (
        <p className="text-xs text-gray-400">
          {CODEX_STATUS_COPY[codexStatus] || `ChatGPT subscription: ${codexStatus}`}
          {codexAccount.planType ? ` (${codexAccount.planType})` : ''}
          {' — '}
          <Link to="/ai/presets" className="text-port-accent hover:underline">sign in from the Codex preset card</Link>
        </p>
      )}
    </article>
  );
}

/**
 * @param {object} props
 * @param {string|null} props.selectedHarnessId - from `/ai/harnesses/:harnessId`; highlighted and scrolled to.
 * @param {object} props.runtimes - the `GET /providers/runtimes` map (by binary id).
 * @param {function} props.onInstallRuntime - opens the page's install modal for one runtime row.
 * @param {object} [props.codexAccount] - the ChatGPT account readiness the page already polls.
 */
export default function ProviderHarnessesTab({ selectedHarnessId = null, runtimes = {}, onInstallRuntime, codexAccount }) {
  const navigate = useNavigate();
  const catalog = useProviderCatalog(true);
  const [pending, setPending] = useState({});

  // A runtime row is keyed by binary; the harness names it by vendor.
  const runtimeByHarness = useMemo(() => Object.fromEntries(
    Object.values(runtimes).filter((row) => row?.vendor).map((row) => [row.vendor, row]),
  ), [runtimes]);

  const presetCountByHarness = useMemo(() => {
    const counts = {};
    for (const preset of catalog.presets || []) {
      const id = preset.harnessId || (preset.type === 'api' ? 'direct' : null);
      if (id) counts[id] = (counts[id] || 0) + 1;
    }
    return counts;
  }, [catalog.presets]);

  const known = catalog.harnesses.some((harness) => harness.id === selectedHarnessId);
  useEffect(() => {
    if (catalog.loading || !selectedHarnessId || known) return;
    toast.error(`No harness with id "${selectedHarnessId}"`);
    navigate('/ai/harnesses', { replace: true });
  }, [catalog.loading, selectedHarnessId, known, navigate]);

  const handleToggle = async (harness, enabled) => {
    setPending((prev) => ({ ...prev, [harness.id]: true }));
    const result = await api.setProviderHarnessEnabled(harness.id, enabled, { silent: true }).catch(() => null);
    setPending((prev) => ({ ...prev, [harness.id]: false }));
    if (!result) {
      toast.error(`Could not ${enabled ? 'enable' : 'disable'} ${harness.label}`);
      return;
    }
    // The verdict is server-computed; every mounted picker re-reads it.
    invalidateProviderCatalog();
    toast.success(`${harness.label} ${enabled ? 'enabled' : 'disabled'} — compose offers it ${enabled ? 'now' : 'no longer'}`);
  };

  if (catalog.loading && catalog.harnesses.length === 0) {
    return <p className="text-sm text-gray-400">Loading harnesses…</p>;
  }

  return (
    <div className="space-y-6">
      <Banner tone="info" size="sm">
        A harness is the program that drives a model. Switch one off and no picker composes a run on it;
        presets that already name it stay stored but stop being offered.
      </Banner>
      <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))]">
        {catalog.harnesses.map((harness) => (
          <HarnessCard
            key={harness.id}
            harness={harness}
            runtime={runtimeByHarness[harness.id] || null}
            compatibleCount={catalog.compatiblePairs(harness.id).length}
            presetCount={presetCountByHarness[harness.id] || 0}
            selected={harness.id === selectedHarnessId}
            busy={Boolean(pending[harness.id])}
            codexAccount={codexAccount}
            onToggle={handleToggle}
            onInstallRuntime={onInstallRuntime}
          />
        ))}
      </div>
      <ProviderCredentialBootstraps harnesses={catalog.harnesses} presets={catalog.presets} />
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  Gauge,
  Loader2,
  PowerOff,
  RefreshCw,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import toast from '../ui/Toast';
import Pill from '../ui/Pill';
import Banner from '../ui/Banner';
import ToggleSwitch from '../ToggleSwitch';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import RuntimeInstallModal from '../install/RuntimeInstallModal';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import * as api from '../../services/api';
import useProviderCatalog, { invalidateProviderCatalog } from '../../hooks/useProviderCatalog';
import { pluralize } from '../../lib/textUtils';
import { serviceReadinessCopy } from '../../lib/providerManagement';
import { providerHarnessId } from '../../utils/providerHarnesses';
import ProviderCredentialBootstraps from './ProviderCredentialBootstraps';

/**
 * AI Providers → Harnesses: one card per registry harness — the program that
 * drives a model — with the switch that decides whether compose offers it,
 * what the machine knows about its binary, version/update/removal lifecycle,
 * model list refresh, the methods it runs, and how many switched-on services it
 * can be pointed at. `direct` (PortOS's own HTTP runner) is always on and says so.
 *
 * Read from the shared composition catalog (`useProviderCatalog`), so a toggle
 * here is one write plus one cache invalidation, and every open picker's
 * compose flow reflects it without a reload.
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

const ACTION_COPY = {
  install: {
    title: 'Install harness',
    description: "Installing the CLI and putting it on PortOS's PATH…",
    done: 'Installed.',
  },
  update: {
    title: 'Update harness',
    description: 'Updating the CLI in place. Providers using it keep their settings.',
    done: 'Update finished.',
  },
  uninstall: {
    title: 'Remove harness',
    description: 'Removing the CLI. Providers that use it will show as needing setup.',
    done: 'Removed.',
  },
};

function HarnessCard({
  harness,
  detail,
  runtime,
  compatibleCount,
  presetCount,
  subscription,
  selected,
  busy,
  onToggle,
  onAction,
  onRefreshModels,
  refreshing,
  refreshResult,
}) {
  const ref = useRef(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  const alwaysOn = harness.source === 'always';
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  const isInstalled = detail ? Boolean(detail.installed) : harness.detected === true;
  const isNotProbed = !detail && harness.detected === null;
  const version = detail?.version || harness.version || null;
  const latestVersion = detail?.latestVersion || null;
  const updateAvailable = Boolean(detail?.updateAvailable);
  const updatable = Boolean(detail?.updatable);
  const installable = Boolean(detail?.installable ?? runtime?.installable);
  const blockedReason = detail?.blockedReason || runtime?.blockedReason || null;
  const removable = Boolean(detail?.removable);
  const canRefreshModels = Boolean(detail?.listsModels && isInstalled);
  const effectiveLabel = detail?.label || runtime?.label || harness.label;
  const effectiveCommand = detail?.command || harness.id;

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
        {alwaysOn ? (
          <Pill tone="success" size="xs" icon={CheckCircle2}>Always on</Pill>
        ) : (
          <span className="flex items-center gap-2 text-sm text-gray-300">
            <ToggleSwitch
              size="sm"
              enabled={harness.enabled}
              disabled={busy}
              ariaLabel={`${harness.enabled ? 'Disable' : 'Enable'} ${harness.label}`}
              onChange={() => onToggle(harness, !harness.enabled)}
            />
            {harness.enabled ? 'Enabled' : 'Disabled'}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        {harness.modes.map((mode) => (
          <Pill key={mode} tone="muted" size="xs" mono>{METHOD_LABEL[mode] || mode}</Pill>
        ))}
        <span className="text-gray-400">{pluralize(compatibleCount, 'compatible service')}</span>
        <span className="text-gray-500">·</span>
        <span className="text-gray-400">{pluralize(presetCount, 'preset')}</span>
      </div>

      {!alwaysOn && (
        <div className="space-y-2 text-xs">
          {isInstalled && (
            <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-gray-500">
              <span>Installed {version || 'version unknown'}</span>
              {latestVersion && <span>· Latest {latestVersion}</span>}
              {detail?.package && <span className="font-mono">· {detail.package}</span>}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {isInstalled ? (
              updateAvailable ? (
                <Pill tone="warning" size="xs" icon={ArrowUpCircle}>Update available</Pill>
              ) : (
                <Pill tone="success" size="xs" icon={CheckCircle2}>
                  Installed{version ? ` · ${version}` : ''}
                </Pill>
              )
            ) : isNotProbed ? (
              <Pill tone="muted" size="xs">Binary not probed yet</Pill>
            ) : (
              <Pill tone="warning" size="xs" icon={PowerOff}>Binary not found</Pill>
            )}

            {!isInstalled && installable && (
              <button
                type="button"
                onClick={() => onAction(detail || runtime || harness, 'install')}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors"
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" /> Install {effectiveLabel}
              </button>
            )}

            {!isInstalled && !installable && blockedReason && (
              <span className="text-gray-500">{blockedReason}</span>
            )}

            {isInstalled && (updateAvailable || updatable) && (
              <button
                type="button"
                onClick={() => onAction(detail || harness, 'update')}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded transition-colors ${
                  updateAvailable
                    ? 'bg-port-accent text-white hover:bg-port-accent/80'
                    : 'border border-port-border text-gray-300 hover:border-port-accent hover:text-white'
                }`}
              >
                <ArrowUpCircle className="w-3.5 h-3.5" aria-hidden="true" /> Update
              </button>
            )}

            {canRefreshModels && (
              <button
                type="button"
                disabled={refreshing}
                onClick={() => onRefreshModels(detail || harness)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-port-border text-gray-300 hover:border-port-accent hover:text-white transition-colors disabled:opacity-50"
              >
                {refreshing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                Refresh models
              </button>
            )}

            {isInstalled && removable && (
              <button
                type="button"
                onClick={() => requestDelete(harness.id)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-port-border text-gray-400 hover:border-port-error hover:text-port-error transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> Remove
              </button>
            )}

            {detail?.docsUrl && (
              <a
                href={detail.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="text-port-accent hover:underline inline-flex items-center gap-1"
              >
                Vendor docs <ExternalLink className="w-3 h-3" aria-hidden="true" />
              </a>
            )}

            {QUOTA_TRACKED.has(harness.id) && (
              <Link to="/devtools/quota-burn" className="text-port-accent hover:underline inline-flex items-center gap-1">
                <Gauge className="w-3 h-3" aria-hidden="true" /> Quota
              </Link>
            )}
          </div>

          {isConfirming(harness.id) && (
            <InlineConfirmRow
              className="mt-2"
              autoFocus
              aria-label={`Remove ${effectiveLabel}`}
              question={`Remove ${effectiveLabel}? ${pluralize(detail?.providers?.length || 0, 'provider')} use \`${effectiveCommand}\` and will show as needing setup until it is reinstalled — their settings are kept.`}
              confirmText="Remove"
              onConfirm={() => confirmDelete(() => onAction(detail || harness, 'uninstall'))}
              onCancel={cancelDelete}
            />
          )}

          {refreshResult && (
            <Banner tone={refreshResult.ok ? 'success' : 'warning'} size="sm" className="mt-2">
              {refreshResult.message}
            </Banner>
          )}
        </div>
      )}

      {subscription && (
        <p className="text-xs text-gray-400">
          Subscription:{' '}
          <Link to={`/ai/services/${encodeURIComponent(subscription.slug)}`} className="text-port-accent hover:underline">
            {subscription.label}
          </Link>
          {' — '}{serviceReadinessCopy(subscription.readiness).reason}
        </p>
      )}
    </article>
  );
}

/**
 * @param {object} props
 * @param {string|null} props.selectedHarnessId - from `/ai/harnesses/:harnessId`; highlighted and scrolled to.
 * @param {object} props.runtimes - the `GET /providers/runtimes` map (by binary id).
 * @param {function} [props.onInstallRuntime] - optional external install handler.
 */
export default function ProviderHarnessesTab({ selectedHarnessId = null, runtimes = {}, onInstallRuntime }) {
  const navigate = useNavigate();
  const catalog = useProviderCatalog(true);
  const [pending, setPending] = useState({});
  const [harnessDetails, setHarnessDetails] = useState([]);
  const [detailsError, setDetailsError] = useState(null);
  const [pendingAction, setPendingAction] = useState(null);
  const [refreshingIds, setRefreshingIds] = useState(() => new Set());
  const [refreshResults, setRefreshResults] = useState({});

  const loadHarnessDetails = useCallback(async ({ fresh = false } = {}) => {
    if (typeof api.getHarnesses !== 'function') return;
    setDetailsError(null);
    const data = await api.getHarnesses({ fresh, silent: true }).catch((err) => {
      setDetailsError(err?.message || 'Could not load harnesses.');
      return null;
    });
    if (data?.harnesses) {
      setHarnessDetails(Array.isArray(data.harnesses) ? data.harnesses : []);
    }
  }, []);

  useEffect(() => {
    loadHarnessDetails();
  }, [loadHarnessDetails]);

  const detailsByHarness = useMemo(() => {
    const map = {};
    for (const item of harnessDetails) {
      if (item.vendor) map[item.vendor] = item;
      if (item.id) map[item.id] = map[item.id] || item;
    }
    return map;
  }, [harnessDetails]);

  // A runtime row is keyed by binary; the harness names it by vendor.
  const runtimeByHarness = useMemo(() => Object.fromEntries(
    Object.values(runtimes).filter((row) => row?.vendor).map((row) => [row.vendor, row]),
  ), [runtimes]);

  const presetCountByHarness = useMemo(() => {
    const counts = {};
    for (const preset of catalog.presets || []) {
      const id = providerHarnessId(preset);
      if (id) counts[id] = (counts[id] || 0) + 1;
    }
    return counts;
  }, [catalog.presets]);

  const subscriptionByHarness = useMemo(() => Object.fromEntries(
    (catalog.services || []).filter((service) => service.definition?.harnessOnly).map((service) => [service.definition.harnessOnly, service]),
  ), [catalog.services]);

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
    invalidateProviderCatalog();
    toast.success(`${harness.label} ${enabled ? 'enabled' : 'disabled'} — compose offers it ${enabled ? 'now' : 'no longer'}`);
  };

  const handleAction = (target, action) => {
    const runtime = runtimeByHarness[target?.vendor || target?.id];
    if (action === 'install' && onInstallRuntime && runtime) {
      onInstallRuntime(runtime);
      return;
    }
    setPendingAction({ harness: target, action });
  };

  const handleRefreshModels = async (target) => {
    const runtimeId = target.id || target.vendor;
    setRefreshingIds((prev) => new Set(prev).add(runtimeId));
    setRefreshResults((prev) => {
      const { [runtimeId]: _dropped, ...rest } = prev;
      return rest;
    });
    const result = await api.refreshHarnessModels(runtimeId, { silent: true })
      .then((data) => ({
        ok: !data.reason,
        message: [
          `${data.models?.length || 0} models from ${target.command || runtimeId} → ${pluralize(data.updated?.length || 0, 'provider')} updated.`,
          data.reason,
        ].filter(Boolean).join(' '),
      }))
      .catch((err) => ({ ok: false, message: err?.message || 'Could not read the model list.' }));
    setRefreshResults((prev) => ({ ...prev, [runtimeId]: result }));
    setRefreshingIds((prev) => {
      const next = new Set(prev);
      next.delete(runtimeId);
      return next;
    });
  };

  const handleRecheck = () => {
    loadHarnessDetails({ fresh: true });
    invalidateProviderCatalog();
  };

  if (catalog.loading && catalog.harnesses.length === 0) {
    return <p className="text-sm text-gray-400">Loading harnesses…</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Banner tone="info" size="sm" className="flex-1 min-w-[280px]">
          A harness is the program that drives a model. Switch one off and no picker composes a run on it;
          presets that already name it stay stored but stop being offered.
        </Banner>
        <button
          type="button"
          onClick={handleRecheck}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-port-border px-3 py-1.5 text-xs font-medium text-gray-200 hover:border-port-accent hover:text-white transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Re-check
        </button>
      </div>

      {detailsError && (
        <Banner tone="error" icon={AlertTriangle}>
          <div className="flex items-center justify-between gap-3">
            <span>{detailsError}</span>
            <button
              type="button"
              onClick={handleRecheck}
              className="shrink-0 rounded-md border border-port-error/50 px-3 py-1 text-xs hover:bg-port-error/20"
            >
              Retry
            </button>
          </div>
        </Banner>
      )}

      <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))]">
        {catalog.harnesses.map((harness) => {
          const detail = detailsByHarness[harness.id] || null;
          const targetId = detail?.id || harness.id;
          return (
            <HarnessCard
              key={harness.id}
              harness={harness}
              detail={detail}
              runtime={runtimeByHarness[harness.id] || null}
              compatibleCount={catalog.compatiblePairs(harness.id).length}
              presetCount={presetCountByHarness[harness.id] || 0}
              subscription={subscriptionByHarness[harness.id] || null}
              selected={harness.id === selectedHarnessId}
              busy={Boolean(pending[harness.id])}
              onToggle={handleToggle}
              onAction={handleAction}
              onRefreshModels={handleRefreshModels}
              refreshing={refreshingIds.has(targetId)}
              refreshResult={refreshResults[targetId]}
            />
          );
        })}
      </div>

      <ProviderCredentialBootstraps harnesses={catalog.harnesses} presets={catalog.presets} />

      <RuntimeInstallModal
        open={Boolean(pendingAction)}
        runtime={pendingAction?.harness?.id}
        label={pendingAction?.harness?.label}
        title={pendingAction ? ACTION_COPY[pendingAction.action]?.title : undefined}
        description={pendingAction ? ACTION_COPY[pendingAction.action]?.description : undefined}
        doneText={pendingAction ? ACTION_COPY[pendingAction.action]?.done : undefined}
        installUrlBase="/api/harnesses/action"
        params={pendingAction ? { action: pendingAction.action } : undefined}
        streamMethod="POST"
        onClose={() => setPendingAction(null)}
        onComplete={() => {
          loadHarnessDetails({ fresh: true });
          invalidateProviderCatalog();
        }}
      />
    </div>
  );
}

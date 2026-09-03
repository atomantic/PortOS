import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { getHarnesses, refreshHarnessModels } from '../../services/api';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import Banner from '../ui/Banner.jsx';
import Pill from '../ui/Pill';
import RuntimeInstallModal from '../install/RuntimeInstallModal';
import InlineConfirmRow from '../ui/InlineConfirmRow';

/**
 * Models → Harnesses: the coding-agent CLIs/TUIs this install drives.
 *
 * A harness is one binary — `opencode`, `claude`, `codex`, `agy`, `grok`,
 * `kimi`, `cursor-agent` — that several provider records share. The Providers
 * page could already install a MISSING one from its card, but nothing showed
 * which version was installed, whether it was stale, how to update it, or which
 * models this install of it actually knows about. So an OpenCode months behind
 * upstream looked identical to a current one, and the only fix was a terminal.
 *
 * This page owns that lifecycle end to end. Every action is a click here — none
 * of it runs on boot, and the model refresh reads the vendor's own catalog
 * rather than calling an AI provider (root AGENTS.md, AI Provider Usage Policy).
 */

// One row per action rather than two key-aligned tables, so a fourth action is
// one entry instead of two edits that must stay in step.
const ACTION_COPY = {
  install: {
    title: 'Install harness',
    description: 'Installing the CLI and putting it on PortOS\'s PATH…',
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
    // The modal's default footer says "is ready", which would sit directly under
    // a log line saying the CLI was just deleted.
    done: 'Removed.',
  },
};

/** `1 provider` / `2 providers` — said three times on this page. */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The one-line availability verdict. `Pill` rather than hand-rolled tone
 * classes, so this reads identically to the same fact on a provider card
 * (`ProviderRuntimeStatus`).
 */
function StatusBadge({ harness }) {
  if (!harness.installed) return <Pill tone="muted" size="xs" icon={AlertTriangle}>Not installed</Pill>;
  if (harness.updateAvailable) return <Pill tone="warning" size="xs" icon={ArrowUpCircle}>Update available</Pill>;
  return <Pill tone="success" size="xs" icon={CheckCircle2}>Installed</Pill>;
}

/**
 * The version line. `null` on either side means NOT KNOWN, never zero — an
 * offline install shows the version it has and simply says nothing about the
 * latest, rather than implying it is current or stale.
 */
function VersionLine({ harness }) {
  if (!harness.installed) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-gray-500">
      <span>Installed {harness.version || 'version unknown'}</span>
      {harness.latestVersion && <span>Latest {harness.latestVersion}</span>}
      {harness.package && <span className="font-mono">{harness.package}</span>}
    </div>
  );
}

/** Which provider records ride on this harness, and how many are switched on. */
function ProviderSummary({ providers }) {
  if (providers.length === 0) {
    return <p className="mt-2 text-[11px] text-gray-500">No providers use this harness.</p>;
  }
  const enabled = providers.filter((provider) => provider.enabled);
  return (
    <p className="mt-2 text-[11px] text-gray-500">
      {plural(providers.length, 'provider')}
      {enabled.length > 0 && <> · {enabled.length} enabled: {enabled.map((provider) => provider.name).join(', ')}</>}
    </p>
  );
}

function HarnessCard({ harness, onAction, onRefreshModels, refreshing, refreshResult }) {
  const canRefreshModels = harness.listsModels && harness.installed;
  // Removal takes providers offline, so the row asks first — inline, per the
  // no-`window.confirm` convention. `useConfirmDelete` is the shared
  // single-row-armed state this page would otherwise hand-roll.
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  return (
    <div className="rounded-lg border border-port-border bg-port-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-white">{harness.label}</h2>
            <span className="rounded bg-port-bg px-1.5 py-0.5 font-mono text-[11px] text-gray-400">{harness.command}</span>
          </div>
          <VersionLine harness={harness} />
          <ProviderSummary providers={harness.providers} />
          {harness.docsUrl && (
            <a
              href={harness.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-port-accent"
            >
              <ExternalLink className="h-3 w-3" /> Vendor docs
            </a>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <StatusBadge harness={harness} />
          <div className="flex flex-wrap justify-end gap-2">
            {!harness.installed && (
              <button
                type="button"
                disabled={!harness.installable}
                title={harness.installable ? undefined : harness.blockedReason}
                onClick={() => onAction(harness, 'install')}
                className="inline-flex items-center gap-1.5 rounded-md bg-port-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download className="h-3.5 w-3.5" /> Install
              </button>
            )}
            {harness.installed && harness.updatable && (
              <button
                type="button"
                onClick={() => onAction(harness, 'update')}
                className="inline-flex items-center gap-1.5 rounded-md border border-port-border px-3 py-1.5 text-xs font-medium text-gray-200 hover:border-port-accent hover:text-white"
              >
                <ArrowUpCircle className="h-3.5 w-3.5" /> Update
              </button>
            )}
            {canRefreshModels && (
              <button
                type="button"
                disabled={refreshing}
                onClick={() => onRefreshModels(harness)}
                className="inline-flex items-center gap-1.5 rounded-md border border-port-border px-3 py-1.5 text-xs font-medium text-gray-200 hover:border-port-accent hover:text-white disabled:opacity-50"
              >
                {refreshing
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <RefreshCw className="h-3.5 w-3.5" />}
                Refresh models
              </button>
            )}
            {harness.installed && harness.removable && (
              <button
                type="button"
                onClick={() => requestDelete(harness.id)}
                className="inline-flex items-center gap-1.5 rounded-md border border-port-border px-3 py-1.5 text-xs font-medium text-gray-400 hover:border-port-error hover:text-port-error"
              >
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </button>
            )}
          </div>
        </div>
      </div>

      {!harness.installable && harness.blockedReason && !harness.installed && (
        <Banner tone="warning" className="mt-3">{harness.blockedReason}</Banner>
      )}

      {isConfirming(harness.id) && (
        <InlineConfirmRow
          className="mt-3"
          autoFocus
          aria-label={`Remove ${harness.label}`}
          question={`Remove ${harness.label}? ${plural(harness.providers.length, 'provider')} use \`${harness.command}\` and will show as needing setup until it is reinstalled — their settings are kept.`}
          confirmText="Remove"
          onConfirm={() => confirmDelete(() => onAction(harness, 'uninstall'))}
          onCancel={cancelDelete}
        />
      )}

      {refreshResult && (
        <Banner tone={refreshResult.ok ? 'success' : 'warning'} className="mt-3">
          {refreshResult.message}
        </Banner>
      )}
    </div>
  );
}

export default function HarnessesTab() {
  const [harnesses, setHarnesses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // `{ harness, action }` while the SSE modal is open; null = closed.
  const [pendingAction, setPendingAction] = useState(null);
  // A SET, not one slot: two rows can refresh at once, and a single slot lets
  // the first completion re-enable the second row's button mid-flight.
  const [refreshingIds, setRefreshingIds] = useState(() => new Set());
  // Keyed by harness id so one row's outcome cannot overwrite another's.
  const [refreshResults, setRefreshResults] = useState({});

  const load = useCallback(async ({ fresh = false } = {}) => {
    setError(null);
    // The server owns its own error toast suppression; this page renders the
    // failure inline with a Retry, so a thrown request must not blank the list.
    const data = await getHarnesses({ fresh, silent: true }).catch((err) => {
      setError(err?.message || 'Could not load harnesses.');
      return null;
    });
    if (data) setHarnesses(Array.isArray(data.harnesses) ? data.harnesses : []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRefreshModels = async (harness) => {
    setRefreshingIds((prev) => new Set(prev).add(harness.id));
    // Drop any banner from this row's previous refresh, so a stale outcome
    // cannot sit under the row while a new probe is running.
    setRefreshResults((prev) => {
      const { [harness.id]: _dropped, ...rest } = prev;
      return rest;
    });
    const result = await refreshHarnessModels(harness.id, { silent: true })
      .then((data) => ({
        ok: true,
        message: `${data.models.length} models from ${harness.command} → ${plural(data.updated.length, 'provider')} updated.`,
      }))
      .catch((err) => ({ ok: false, message: err?.message || 'Could not read the model list.' }));
    setRefreshResults((prev) => ({ ...prev, [harness.id]: result }));
    setRefreshingIds((prev) => {
      const next = new Set(prev);
      next.delete(harness.id);
      return next;
    });
    // Deliberately no reload: the refresh writes `models` and `defaultModel`,
    // and this page shows neither — the banner above already reports what
    // changed. Re-reading would cost a probe sweep to render the same rows.
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-gray-400">
          The coding-agent CLIs and TUIs this install drives. Install, update, or remove one here,
          and refresh the model list a harness reports so the providers that use it offer the right models.
        </p>
        <button
          type="button"
          onClick={() => load({ fresh: true })}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-port-border px-3 py-1.5 text-xs font-medium text-gray-200 hover:border-port-accent hover:text-white"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Re-check
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading harnesses…
        </div>
      )}

      {error && !loading && (
        <Banner tone="error" icon={AlertTriangle}>
          <div className="flex items-center justify-between gap-3">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => load({ fresh: true })}
              className="shrink-0 rounded-md border border-port-error/50 px-3 py-1 text-xs hover:bg-port-error/20"
            >
              Retry
            </button>
          </div>
        </Banner>
      )}

      {!loading && !error && (
        <div className="space-y-3">
          {harnesses.length === 0 && <p className="text-sm text-gray-500">No harnesses are registered.</p>}
          {harnesses.map((harness) => (
            <HarnessCard
              key={harness.id}
              harness={harness}
              onAction={(target, action) => setPendingAction({ harness: target, action })}
              onRefreshModels={handleRefreshModels}
              refreshing={refreshingIds.has(harness.id)}
              refreshResult={refreshResults[harness.id]}
            />
          ))}
        </div>
      )}

      {/* Install, update and remove all stream through the shared modal — one
          child, one single-flight guard, and closing the modal cancels the run. */}
      <RuntimeInstallModal
        open={!!pendingAction}
        runtime={pendingAction?.harness?.id}
        label={pendingAction?.harness?.label}
        title={pendingAction ? ACTION_COPY[pendingAction.action].title : undefined}
        description={pendingAction ? ACTION_COPY[pendingAction.action].description : undefined}
        doneText={pendingAction ? ACTION_COPY[pendingAction.action].done : undefined}
        installUrlBase="/api/harnesses/action"
        params={pendingAction ? { action: pendingAction.action } : undefined}
        streamMethod="POST"
        onClose={() => setPendingAction(null)}
        // Re-read the list, but LEAVE THE MODAL OPEN — its terminal frame is the
        // result ("…is up to date (1.19.0)", "…has been removed"), and clearing
        // `pendingAction` here unmounts it the instant that frame arrives, so a
        // removal and a no-op update look identical: a modal that blinks shut.
        // The user closes it, matching every other caller of this modal.
        //
        // `load()`, not `load({ fresh: true })`: the stream already re-probed the
        // acted-on harness with `fresh` on the server and wrote that into the
        // status cache, and clicking Install cannot have changed what npm has
        // published — a fresh read here would spend five registry round trips to
        // render identical numbers.
        onComplete={() => load()}
      />
    </div>
  );
}

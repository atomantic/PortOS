import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  CircleDashed,
  HelpCircle,
  Play,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import Banner from '../ui/Banner.jsx';
import { formatDateShort } from '../../utils/formatters.js';

const statusStyle = {
  current: {
    icon: CheckCircle2,
    label: 'Verified',
    className: 'border-port-success/30 bg-port-success/10 text-port-success',
  },
  stale: {
    icon: RefreshCw,
    label: 'Needs rebuild',
    className: 'border-port-warning/30 bg-port-warning/10 text-port-warning',
  },
  corrupt: {
    icon: AlertTriangle,
    label: 'Integrity failed',
    className: 'border-port-error/30 bg-port-error/10 text-port-error',
  },
  missing: {
    icon: CircleDashed,
    label: 'Not built',
    className: 'border-port-border bg-port-bg/60 text-gray-400',
  },
  // "The preflight could not be read" is NOT "nothing is built" — collapsing
  // the two would show "Not built" above a details block describing the bundle
  // that exists, and would leave Build enabled on an unverified tree.
  unavailable: {
    icon: HelpCircle,
    label: 'Unverified',
    className: 'border-port-warning/30 bg-port-warning/10 text-port-warning',
  },
};

export default function GameCompilePanel({
  game,
  integrity,
  loadingIntegrity,
  compiling,
  launching,
  compileError,
  onCompile,
  onLaunch,
  onRetryIntegrity,
}) {
  const current = game.compiledManifest;
  // Three distinct states, deliberately not collapsed: still fetching, fetched
  // and reporting, and fetch failed. Only the middle one can unblock a build.
  const unavailable = !loadingIntegrity && !integrity;
  const bundleStatus = unavailable
    ? statusStyle.unavailable
    : statusStyle[integrity?.bundle?.status] || statusStyle.missing;
  const StatusIcon = bundleStatus.icon;
  const blocked = !integrity || !integrity.readyToCompile;
  const issues = integrity?.issues || [];
  return (
    <section className="rounded-xl border border-port-border bg-port-card p-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <div className="flex items-center gap-2">
            <Boxes className="h-5 w-5 text-port-accent" aria-hidden="true" />
            <h2 className="font-semibold text-white">Game asset bundle</h2>
          </div>
          <p className="mt-1 text-sm text-gray-400">
            Build a deterministic manifest and verify every bound source file by SHA-256.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={onCompile}
            disabled={compiling || loadingIntegrity || blocked}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            title={unavailable
              ? 'Asset verification is unavailable — retry it first'
              : blocked ? 'Resolve the asset integrity blockers first' : undefined}
          >
            <RefreshCw className={`h-4 w-4 ${compiling ? 'animate-spin' : ''}`} aria-hidden="true" />
            {compiling ? 'Verifying…' : current ? 'Rebuild & verify' : 'Build & verify'}
          </button>
          <button
            type="button"
            onClick={onLaunch}
            disabled={launching || !integrity?.canLaunch}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            title={!integrity?.canLaunch ? 'Build a current, verified bundle before starting the game' : undefined}
          >
            <Play className="h-4 w-4" aria-hidden="true" />
            {launching ? 'Starting…' : 'Start game'}
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${bundleStatus.className}`}>
          <StatusIcon className={`h-4 w-4 shrink-0 ${loadingIntegrity ? 'animate-spin' : ''}`} aria-hidden="true" />
          <div>
            <div className="text-xs opacity-70">Bundle</div>
            <div className="font-medium">{loadingIntegrity ? 'Checking…' : bundleStatus.label}</div>
          </div>
        </div>
        <div className="rounded-lg border border-port-border bg-port-bg/50 px-3 py-2 text-sm">
          <div className="text-xs text-gray-500">Sprite readiness</div>
          <div className="font-medium text-white">
            {integrity ? `${integrity.counts.spriteReady} / ${integrity.counts.spriteTotal}` : '—'}
          </div>
        </div>
        <div className="rounded-lg border border-port-border bg-port-bg/50 px-3 py-2 text-sm">
          <div className="text-xs text-gray-500">Verified files</div>
          <div className="font-medium text-white">{integrity?.counts?.verifiedFiles ?? '—'}</div>
        </div>
      </div>

      {unavailable && (
        <Banner
          tone="warning"
          size="md"
          icon={AlertTriangle}
          title="Asset verification is unavailable"
          className="mt-4"
          actions={onRetryIntegrity ? (
            <button
              type="button"
              onClick={onRetryIntegrity}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-port-warning/40 px-3 py-2 text-sm font-medium"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Retry
            </button>
          ) : undefined}
        >
          The preflight could not be read, so nothing below reflects the current state of this
          game&apos;s assets. Building and starting stay disabled until it succeeds.
        </Banner>
      )}

      {issues.length > 0 && (
        <Banner
          tone="warning"
          size="md"
          icon={AlertTriangle}
          title={`${issues.length} ${issues.length === 1 ? 'asset needs' : 'assets need'} attention`}
          className="mt-4"
        >
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {issues.map((item) => (
              <li key={`${item.assetType}-${item.assetId}`} className="truncate" title={item.message}>
                <span className="font-medium">{item.name}</span>: {item.message}
              </li>
            ))}
          </ul>
        </Banner>
      )}

      {compileError && (
        <Banner tone="error" size="md" role="alert" className="mt-4">{compileError}</Banner>
      )}

      {current ? (
        <dl className="mt-4 grid gap-3 rounded-lg border border-port-border bg-port-bg/50 p-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-xs text-gray-500">Version</dt><dd className="text-white">v{current.version}</dd></div>
          <div><dt className="text-xs text-gray-500">Sprites</dt><dd className="text-white">{current.spriteCount}</dd></div>
          <div><dt className="text-xs text-gray-500">Music</dt><dd className="text-white">{current.musicCount}</dd></div>
          <div><dt className="text-xs text-gray-500">Built</dt><dd className="text-white">{formatDateShort(current.builtAt)}</dd></div>
          <div><dt className="text-xs text-gray-500">Verified files</dt><dd className="text-white">{current.verifiedFileCount ?? '—'}</dd></div>
          <div className="min-w-0 sm:col-span-2 lg:col-span-4">
            <dt className="text-xs text-gray-500">Manifest</dt>
            <dd className="truncate font-mono text-xs text-gray-300" title={current.manifestPath}>{current.manifestPath}</dd>
          </div>
        </dl>
      ) : blocked ? null : (
        <p className="mt-4 flex items-center gap-2 rounded-lg border border-dashed border-port-border p-4 text-sm text-gray-500">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          Ready to build a hash-verified bundle.
        </p>
      )}
    </section>
  );
}

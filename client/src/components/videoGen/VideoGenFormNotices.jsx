import { RefreshCw, Sparkles } from 'lucide-react';
import ModelRepairBanner from './ModelRepairBanner';

/**
 * Banners at the top of the VideoGen form: the cross-page Remix restore state,
 * the missing BYOV runtime installer, and one repair banner per damaged weight.
 * `remixHandoff` is `useVideoGenRemixHandoff()`'s state, `byov` is
 * `useVideoGenByovRuntime()`, and `weights` is `useVideoGenWeightAssets()`.
 */
export default function VideoGenFormNotices({ remixHandoff, byov, showByov, weights, generating }) {
  const { remixHandoffPending, remixHandoffProblem, retryRemixHandoff, dismissRemixHandoff } = remixHandoff;
  const { byovStatus, byovRuntimeMissing, setInstallModalOpen } = byov;
  const { assets, modelDownload } = weights;
  return (
    <>
      {/* A cross-page Remix that could not be restored (#6290). Silence
          would be the worst outcome here: the user pressed Remix, landed on
          a form holding whatever it held before, and would start a render
          with the wrong settings believing they were the clip's. */}
      {remixHandoffPending && (
        <p role="status" className="rounded-lg border border-port-border bg-port-bg px-3 py-2 text-xs text-gray-400">
          Restoring this render's settings — the form below is about to be replaced with them.
        </p>
      )}
      {remixHandoffProblem && (
        <div
          role="status"
          className="rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-3 text-xs text-port-warning flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
        >
          <div>
            {remixHandoffProblem === 'error'
              ? "Couldn't load your render history, so this clip's settings weren't restored."
              : 'That render is no longer in your history, so its settings could not be restored.'}
            {' '}The form still holds its previous values.
          </div>
          <div className="flex items-center gap-2 self-start sm:self-auto">
            {remixHandoffProblem === 'error' && (
              <button
                type="button"
                onClick={retryRemixHandoff}
                className="whitespace-nowrap inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white text-xs font-medium hover:bg-port-accent/80"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Retry
              </button>
            )}
            <button
              type="button"
              onClick={dismissRemixHandoff}
              className="text-gray-400 hover:text-gray-200 text-xs"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {showByov && byovRuntimeMissing && (
        <div className="rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-3 text-xs text-port-warning flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <strong className="font-semibold">{byovStatus.label}</strong> {byovStatus.upgradeAvailable ? 'has an update available.' : "isn't installed yet."}
            {' '}PortOS can {byovStatus.upgradeAvailable ? 'upgrade' : 'fetch and install'} it from {byovStatus.installSourceLabel || byovStatus.repoUrl?.replace('https://', '')} on demand.
          </div>
          <button
            type="button"
            onClick={() => setInstallModalOpen(true)}
            disabled={generating}
            className="self-start sm:self-auto whitespace-nowrap inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white text-xs font-medium hover:bg-port-accent/80 disabled:opacity-50"
          >
            <Sparkles size={14} />
            {byovStatus.upgradeAvailable ? 'Upgrade' : 'Install'} {byovStatus.label}
          </button>
        </div>
      )}
      {assets.filter(asset => asset.showBanner).map(asset => (
        <ModelRepairBanner
          key={asset.key}
          message={<>
            <strong className="font-semibold">{asset.name}</strong> has {asset.integrityBadCount || 'corrupt'} damaged weight file{asset.integrityBadCount === 1 ? '' : 's'} — renders may come out garbled.
            Repair deletes the bad file{asset.integrityBadCount === 1 ? '' : 's'} and re-downloads clean copies.
          </>}
          repairLabel={asset.repairLabel}
          onRepair={() => { asset.dismiss(); modelDownload.repair(asset.id); }}
          onDismiss={asset.dismiss}
          disabled={modelDownload.repairing || modelDownload.downloading}
          repairing={modelDownload.repairing}
        />
      ))}
    </>
  );
}

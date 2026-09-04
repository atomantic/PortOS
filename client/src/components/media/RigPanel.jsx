import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Bone, Loader2 } from 'lucide-react';
import { getRiggingReadiness, rigImageTo3dModel, listRiggingClips, retargetImageTo3dModel } from '../../services/api';
import { riggingReasonLabel } from '../../lib/riggingReasons.js';
import useMounted from '../../hooks/useMounted';
import { useInstanceFeatures } from '../../hooks/useInstanceFeatures';
import { formatBytes } from '../../utils/formatters';
import toast from '../ui/Toast';

/**
 * "Rig this character" plus the rig-status panel on `/3d/:id`.
 *
 * Gated on BOTH the `rigging` instance feature and the Phase 1 runtime readiness
 * probe — the feature flag is the user's choice, readiness is the machine's answer, and
 * a host with no Blender must say so by name rather than offering a button that spawns
 * a mysterious failure. The readiness fetch is deliberately made HERE and only when the
 * feature is on, so a 3D page on an install without rigging pays nothing for it.
 *
 * A refused rig renders the SERVER's sentence, which names the measured number and the
 * threshold it missed ("automatic weighting left 4.2% of vertices unweighted, ceiling
 * is 0.5%"). That is the whole point of the gate; collapsing it to "Rigging failed"
 * would throw away the only thing the user can act on.
 */
export default function RigPanel({ record, onRecordChange }) {
  const mountedRef = useMounted();
  const { isFeatureEnabled } = useInstanceFeatures();
  const enabled = isFeatureEnabled('rigging');
  const [readiness, setReadiness] = useState(null);
  const [busy, setBusy] = useState(false);
  // Retarget lane (#6065). `clips === null` means "not fetched yet", distinct from
  // an empty roster — the empty state gets an explaining line, not a dead picker.
  const [clips, setClips] = useState(null);
  const [selectedClip, setSelectedClip] = useState('');
  const [retargeting, setRetargeting] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    // Silent: this panel renders on every 3D detail visit, so an unreadable probe
    // belongs inline rather than as an unprompted toast.
    getRiggingReadiness({ silent: true })
      .then((value) => { if (active) setReadiness(value); })
      .catch(() => { if (active) setReadiness({ ready: false, reason: 'runtime-probe-failed' }); });
    return () => { active = false; };
  }, [enabled]);

  // The clip library is only relevant once a rig exists to animate. Fetched from
  // `record.rig` directly (not the `rig` const below, which is declared after the
  // early return) so this hook stays unconditional per the Rules of Hooks.
  useEffect(() => {
    if (!enabled || record.rig?.status !== 'ready') return;
    let active = true;
    listRiggingClips({ silent: true })
      .then((value) => { if (active) setClips(value?.clips || []); })
      .catch(() => { if (active) setClips([]); });
    return () => { active = false; };
  }, [enabled, record.rig?.status]);

  const handleRig = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const next = await rigImageTo3dModel(record.id, {}, { silent: true }).catch((err) => {
      // The gate's sentence IS the error message — surface it verbatim.
      toast.error(err?.message || 'Rigging failed.');
      return null;
    });
    if (mountedRef.current) setBusy(false);
    if (next && mountedRef.current) {
      onRecordChange(next);
      toast.success('Character rigged.');
    }
  }, [busy, record.id, onRecordChange, mountedRef]);

  const runRetarget = useCallback(async (mode, clip) => {
    if (retargeting) return;
    setRetargeting(true);
    const next = await retargetImageTo3dModel(record.id, { clip, mode }, { silent: true }).catch((err) => {
      // The gate's sentence IS the error message — surface it verbatim, same
      // contract as the rig gate above.
      toast.error(err?.message || 'Retarget failed.');
      return null;
    });
    if (mountedRef.current) setRetargeting(false);
    if (next && mountedRef.current) {
      onRecordChange(next);
      toast.success(mode === 'write' ? 'Animation applied.' : 'Retarget preview ready.');
    }
  }, [retargeting, record.id, onRecordChange, mountedRef]);

  const handlePreviewRetarget = useCallback(() => {
    if (!selectedClip) return;
    runRetarget('diagnostic', selectedClip);
  }, [selectedClip, runRetarget]);

  const handleApplyCleanup = useCallback(() => {
    const clip = record.retarget?.clipFile;
    if (!clip) return;
    runRetarget('write', clip);
  }, [record.retarget?.clipFile, runRetarget]);

  if (!enabled) return null;

  const rig = record.rig || null;
  const rigging = busy || rig?.status === 'rigging';
  const canRig = record.status === 'ready' && Boolean(record.assetPath) && readiness?.ready === true;
  const blockedReason = readiness && !readiness.ready ? riggingReasonLabel(readiness.reason) : null;

  const retarget = record.retarget || null;
  const canRetarget = rig?.status === 'ready';
  const clipsLoaded = clips !== null;
  const hasClips = clipsLoaded && clips.length > 0;
  const retargetBusy = retargeting || retarget?.status === 'retargeting';
  const diagnosticReady = retarget?.status === 'ready' && retarget.mode === 'diagnostic';
  const writeReady = retarget?.status === 'ready' && retarget.mode === 'write';
  const overCap = diagnosticReady && Boolean(retarget.summary?.cleanupOverCap);

  return (
    <>
    <section className="mt-4 rounded-lg border border-port-border bg-port-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Bone className="h-4 w-4 text-port-accent" />
          <h2 className="text-sm font-semibold text-white">Character rig</h2>
        </div>
        <button
          type="button"
          onClick={handleRig}
          disabled={!canRig || rigging}
          title={blockedReason || (record.status === 'ready' ? undefined : 'Render this model first')}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-port-border px-3 py-1.5 text-xs text-gray-300 hover:border-port-accent hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {rigging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bone className="h-3.5 w-3.5" />}
          {rigging ? 'Rigging…' : 'Rig this character'}
        </button>
      </div>

      {!readiness && <p className="mt-2 text-xs text-gray-500">Checking the rigging runtime…</p>}
      {blockedReason && (
        <p className="mt-2 text-xs text-port-warning">
          {blockedReason}. Provision it from Settings &gt; Features.
        </p>
      )}

      {rig?.status === 'failed' && rig.error && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md border border-port-error/30 bg-port-error/10 px-3 py-2 text-xs text-port-error">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{rig.error}</span>
        </div>
      )}

      {rig?.status === 'ready' && rig.assetPath && (
        <div className="mt-2 space-y-1 text-xs text-gray-400">
          <p className="text-port-success">
            Rigged against {rig.summary?.bones ?? 0} bones
            {rig.summary?.vertices ? ` · ${rig.summary.vertices.toLocaleString()} vertices` : ''}
            {rig.bytes ? ` · ${formatBytes(rig.bytes)}` : ''}
          </p>
          <p>
            Automatic weighting left{' '}
            {`${((rig.summary?.unweightedFractionAfterHeat ?? 0) * 100).toFixed(1)}%`} unweighted
            {' '}(ceiling {`${((rig.summary?.unweightedCeiling ?? 0) * 100).toFixed(1)}%`}); the nearest-bone pass
            completed {rig.summary?.nearestBoneCompleted ?? 0}.
          </p>
          <a
            href={rig.assetPath}
            className="inline-block underline decoration-dotted hover:text-gray-200"
          >
            Download rigged .glb
          </a>
        </div>
      )}

      {!rig && canRig && (
        <p className="mt-2 text-xs text-gray-500">
          Not rigged yet. Rigging welds the decoded mesh, applies bone-heat weighting, and
          publishes only if the unweighted fraction clears the measured gate.
        </p>
      )}
    </section>

    {canRetarget && (
      <section className="mt-4 rounded-lg border border-port-border bg-port-card p-3">
        <div className="flex items-center gap-2">
          <Bone className="h-4 w-4 text-port-accent" />
          <h2 className="text-sm font-semibold text-white">Animate with a clip</h2>
        </div>

        {!clipsLoaded && <p className="mt-2 text-xs text-gray-500">Checking the clip library…</p>}
        {clipsLoaded && !hasClips && (
          <p className="mt-2 text-xs text-gray-500">
            No animation clips yet. Drop a GLB clip into the clip library to animate this character.
          </p>
        )}

        {hasClips && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              aria-label="Animation clip"
              value={selectedClip}
              onChange={(e) => setSelectedClip(e.target.value)}
              disabled={retargetBusy}
              className="min-h-[44px] flex-1 rounded-md border border-port-border bg-port-bg px-2 py-1 text-xs text-white disabled:opacity-40"
            >
              <option value="">Select a clip…</option>
              {clips.map((clip) => (
                <option key={clip.filename} value={clip.filename}>{clip.label}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={handlePreviewRetarget}
              disabled={!selectedClip || retargetBusy}
              title={!selectedClip ? 'Pick a clip first' : undefined}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-port-border px-3 py-1.5 text-xs text-gray-300 hover:border-port-accent hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {retargetBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bone className="h-3.5 w-3.5" />}
              {retargetBusy ? 'Retargeting…' : 'Preview retarget'}
            </button>
          </div>
        )}

        {retarget?.status === 'failed' && retarget.error && (
          <div className="mt-2 flex items-start gap-1.5 rounded-md border border-port-error/30 bg-port-error/10 px-3 py-2 text-xs text-port-error">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{retarget.error}</span>
          </div>
        )}

        {diagnosticReady && retarget.summary && (
          <div className="mt-2 space-y-1 text-xs text-gray-400">
            <p>
              Clip "{retarget.summary.clip}" ({(retarget.summary.clipDuration ?? 0).toFixed(2)}s) — proposed
              cleanup {retarget.summary.proposedCleanupVertices ?? 0} of{' '}
              {retarget.summary.cleanupCapVertices ?? 0} vertex cap.
            </p>
            <p>
              Motion check: {retarget.summary.sampledFrames ?? 0} sampled frames, max joint move{' '}
              {(retarget.summary.maxJointTranslation ?? 0).toExponential(2)} units.
            </p>
            {overCap ? (
              <p className="text-port-warning">
                This cleanup is over cap and cannot be applied — try a different clip.
              </p>
            ) : (
              <button
                type="button"
                onClick={handleApplyCleanup}
                disabled={retargetBusy}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-port-accent px-3 py-1.5 text-xs text-port-accent hover:bg-port-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {retargetBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bone className="h-3.5 w-3.5" />}
                {retargetBusy ? 'Applying…' : 'Apply cleanup'}
              </button>
            )}
          </div>
        )}

        {writeReady && retarget.assetPath && (
          <div className="mt-2 space-y-1 text-xs text-gray-400">
            <p className="text-port-success">Animated with "{retarget.summary?.clip}".</p>
            <a
              href={retarget.assetPath}
              className="inline-block underline decoration-dotted hover:text-gray-200"
            >
              Download animated .glb
            </a>
          </div>
        )}
      </section>
    )}
    </>
  );
}

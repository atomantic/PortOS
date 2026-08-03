import { formatDurationSec } from '../../utils/formatters.js';

/**
 * Beat-grid readout for the analyzed track, the "cuts are too long" nudge, and
 * the manual-tempo fallback shown when the auto-detector found no BPM.
 * `tempo` is the useMusicVideoManualTempo slot.
 */
export default function AnalysisPanel({ audioAnalysis, scenes, tempo }) {
  const authoredCutDurations = scenes
    .filter((scene) => typeof scene.startSec === 'number' && typeof scene.endSec === 'number' && scene.endSec > scene.startSec)
    .map((scene) => scene.endSec - scene.startSec);
  const averageCutSec = authoredCutDurations.length > 0
    ? authoredCutDurations.reduce((sum, duration) => sum + duration, 0) / authoredCutDurations.length
    : null;
  const longCutCount = authoredCutDurations.filter((duration) => duration > 10).length;
  return (
    <>
      {audioAnalysis && (
        <div className="text-xs text-port-text-muted mt-2 flex flex-wrap gap-x-4 gap-y-1">
          <span>Tempo: {audioAnalysis.bpm ? `${audioAnalysis.bpm} BPM` : '—'}</span>
          <span>Duration: {formatDurationSec(audioAnalysis.durationSec)}</span>
          <span>Beats: {audioAnalysis.beats?.length || 0}</span>
          <span>Sections: {audioAnalysis.sections?.length || 0}</span>
          {averageCutSec != null && <span>Average cut: {averageCutSec.toFixed(1)}s</span>}
        </div>
      )}
      {longCutCount > 0 && (
        <p className="mt-2 rounded border border-port-warning/40 bg-port-warning/10 px-2 py-1.5 text-xs text-port-warning">
          {longCutCount} authored cut{longCutCount === 1 ? ' is' : 's are'} longer than 10s.
          Add more shots, then Auto-arrange: higher-energy sections receive shorter cuts and every boundary stays music-led.
        </p>
      )}
      {audioAnalysis && !audioAnalysis.bpm && (
        <div className="mt-2 flex flex-wrap items-end gap-2 text-xs bg-port-bg border border-port-border rounded-lg p-2">
          <span className="text-port-text-muted w-full">No tempo detected — set it by ear to unlock the beat grid:</span>
          <div>
            <label htmlFor="mv-manual-bpm" className="block text-port-text-muted mb-1">BPM</label>
            <input id="mv-manual-bpm" type="number" min={20} max={300} step={1} value={tempo.bpm}
              onChange={(e) => tempo.setBpm(e.target.value)} placeholder="120"
              className="w-16 bg-port-card border border-port-border rounded px-1.5 py-1" />
          </div>
          <button onClick={tempo.tap} type="button"
            className="bg-port-card border border-port-border rounded px-2 py-1.5 min-h-[32px] hover:bg-port-border/40">
            Tap tempo
          </button>
          <div>
            <label htmlFor="mv-manual-offset" className="block text-port-text-muted mb-1">First downbeat (s)</label>
            <input id="mv-manual-offset" type="number" min={0} max={600} step={0.1} value={tempo.offset}
              onChange={(e) => tempo.setOffset(e.target.value)}
              className="w-20 bg-port-card border border-port-border rounded px-1.5 py-1" />
          </div>
          <button onClick={tempo.submit} disabled={tempo.saving || !tempo.bpm}
            className="bg-port-accent text-white rounded px-2 py-1.5 min-h-[32px] disabled:opacity-50">
            {tempo.saving ? 'Setting…' : 'Set tempo'}
          </button>
        </div>
      )}
    </>
  );
}

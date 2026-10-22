import { useEffect, useMemo, useState } from 'react';
import { getMusicVideoDependencyImpact } from '../../services/apiMusicVideo.js';
import { openRevisionOf } from '../../lib/musicVideoAttention.js';
import { formatCount } from '../../utils/formatters.js';

const REVISION_HINT_ID = 'mv-repair-blocked-hint';
// The preview decodes the song with ffmpeg, so the server gates it like other
// host work (#13097); a remote password-free viewer still gets the page.
const UNAVAILABLE = 'unavailable';
const UNAVAILABLE_NOTE = 'Asset dependency check needs an operator session, or a local connection when no password is set.';

/** Preview first; only the director's Repair action starts any work. */
export default function DependencyImpactPanel({ project, busy, onRepair }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  // Refetch only when an approval basis moves, not on every project object change.
  const basis = project.productionReadiness?.basis;
  const basisKey = useMemo(() => basis ? `${basis.art}|${basis.storyboard}|${basis.proof}` : '', [basis]);
  useEffect(() => {
    let active = true;
    setResult(null);
    setError(null);
    getMusicVideoDependencyImpact(project.id, { silent: true, hostControlOptional: true }).then((impact) => {
      if (active) setResult(impact);
    }).catch((err) => {
      if (!active) return;
      if (err.code === 'HOST_CONTROL_FORBIDDEN') setResult(UNAVAILABLE);
      else setError(err.message || 'Could not check asset dependencies');
    });
    return () => { active = false; };
  }, [project.id, basisKey, retry]);
  const revisionActive = !!openRevisionOf(project);
  if (error) return <div role="alert" className="text-xs text-port-error">{error} <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry dependency check</button></div>;
  if (result === UNAVAILABLE) return <p className="text-xs text-port-text-muted">{UNAVAILABLE_NOTE}</p>;
  if (!result || (!result.shots.length && !result.evidence.length)) return null;
  return (
    <section aria-label="Stale asset impact" className="rounded border border-port-warning/40 bg-port-warning/5 p-3 space-y-2 text-xs">
      <h3 className="font-medium">Asset changes need fresh evidence</h3>
      <ul className="space-y-1">
        {result.shots.map((shot) => {
          const scene = project.scenes.find((entry) => entry.sceneId === shot.sceneId);
          return <li key={shot.sceneId}>{scene?.label || shot.sceneId}: {shot.reasons.join('; ')} → derived clip, composition and review evidence</li>;
        })}
      </ul>
      <p>{result.estimate.maxGenerations > 0
        ? `Up to ${formatCount(result.estimate.maxGenerations)} clip submissions (${formatCount(result.estimate.outputSeconds)} seconds of footage)`
        : 'No new clips needed'}; {formatCount(result.estimate.evidenceRebuilds)} evidence records need rebuilding or review. Historical assets are retained.</p>
      {!result.shots.length && <p>Selected takes can be kept. Rebuild the draft and review it again; historical passing reviews cannot approve changed dependencies.</p>}
      <button type="button" disabled={busy || revisionActive} onClick={() => onRepair(result.basis)}
        aria-describedby={revisionActive ? REVISION_HINT_ID : undefined}
        className="min-h-[44px] rounded border border-port-border px-3 text-port-accent disabled:opacity-50">
        Repair affected dependencies
      </button>
      {revisionActive && (
        <p id={REVISION_HINT_ID} className="text-port-warning">
          A revision is already open — resume or cancel it (under "Needs attention" above) before repairing.
        </p>
      )}
    </section>
  );
}

import { useEffect, useState } from 'react';
import { getMusicVideoDependencyImpact } from '../../services/apiMusicVideo.js';
import { formatCount } from '../../utils/formatters.js';

/** Preview first; only the director's Repair action starts any work. */
export default function DependencyImpactPanel({ project, busy, onRepair }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setResult(null);
    setError(null);
    getMusicVideoDependencyImpact(project.id, { silent: true }).then((impact) => {
      if (active) setResult(impact);
    }).catch((err) => {
      if (active) setError(err.message || 'Could not check asset dependencies');
    });
    return () => { active = false; };
  }, [project, retry]);
  const revisionActive = (project.revisions || []).some((revision) => ['open', 'rendering'].includes(revision.status));
  if (error) return <div role="alert" className="text-xs text-port-error">{error} <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry dependency check</button></div>;
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
      <p>Up to {formatCount(result.estimate.maxGenerations)} clip submissions ({formatCount(result.estimate.outputSeconds)} seconds of footage); {formatCount(result.estimate.evidenceRebuilds)} evidence records need rebuilding or review. Historical assets are retained.</p>
      {!result.shots.length && <p>Selected takes can be kept. Rebuild the draft and review it again; historical passing reviews cannot approve changed dependencies.</p>}
      <button type="button" disabled={busy || revisionActive} onClick={() => onRepair(result.basis)}
        className="min-h-[44px] rounded border border-port-border px-3 text-port-accent disabled:opacity-50">
        Repair affected dependencies
      </button>
    </section>
  );
}

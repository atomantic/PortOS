import { useState } from 'react';
import { colorMatchGroups } from '../../../../server/lib/shotColorMatch.js';
import { measureMusicVideoColorMatch, setMusicVideoColorMatchReference } from '../../services/apiMusicVideo.js';

const BUTTON = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border bg-port-bg px-2 py-1 text-xs hover:bg-port-border/40 disabled:opacity-50 pointer-fine:sm:min-h-0';
const SELECT = 'min-h-[44px] rounded border border-port-border bg-port-bg px-2 py-1 text-xs pointer-fine:sm:min-h-0';

const fmt = (n) => (Number.isFinite(n) ? n.toFixed(3) : '—');

/**
 * Groups on the shot sheet: spread before and after matching, and shots past
 * the clamp. `onProject` receives a patch (or a function of the open project)
 * and updates local state; the routes already saved.
 */
export default function ColorMatchBoard({ project, disabled, onProject }) {
  const groups = colorMatchGroups(project);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const applyResult = (result) => {
    onProject?.((current) => ({
      colorMatch: result?.colorMatch || null,
      scenes: (current.scenes || []).map((scene) => {
        const next = (result?.scenes || []).find((entry) => entry.sceneId === scene.sceneId);
        return next?.takes ? { ...scene, takes: next.takes } : scene;
      }),
    }));
  };

  const run = (work) => {
    if (!project?.id) return;
    setBusy(true);
    setError('');
    work()
      .then(applyResult)
      .catch((err) => setError(err.message || 'Could not update color match'))
      .finally(() => setBusy(false));
  };

  return (
    <section aria-label="Color match" className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-medium">Color match</h3>
        {groups.length > 0 && (
          <button type="button" className={BUTTON} disabled={disabled || busy} onClick={() => run(() => measureMusicVideoColorMatch(project.id, {}, { silent: true }))}>
            Measure shots
          </button>
        )}
      </div>
      {groups.length === 0 ? (
        <p className="text-[11px] text-port-text-muted">Shots group by camera, location and time of day. Flash stills and cameras marked Do not match are left out.</p>
      ) : (
        <ul className="min-w-0 space-y-2">
          {groups.map((group) => (
            <li key={group.key} className="min-w-0 space-y-1 rounded border border-port-border p-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium">{group.cameraName}</span>
                <span className="text-port-text-muted">{group.location} · {group.timeOfDay}</span>
                <label className="inline-flex min-h-[44px] items-center gap-1 pointer-fine:sm:min-h-0">
                  Reference
                  <select aria-label={`${group.cameraName} ${group.location} reference`} className={SELECT} disabled={disabled || busy}
                    value={group.referenceSceneId || ''}
                    onChange={(event) => {
                      const sceneId = event.target.value;
                      if (!sceneId) {
                        const anchor = group.shots[0]?.sceneId;
                        if (anchor && group.referenceSceneId) run(() => setMusicVideoColorMatchReference(project.id, { sceneId: anchor, clear: true }, { silent: true }));
                        return;
                      }
                      run(() => setMusicVideoColorMatchReference(project.id, { sceneId }, { silent: true }));
                    }}>
                    <option value="">Median</option>
                    {group.shots.map((shot) => <option key={shot.sceneId} value={shot.sceneId}>{shot.label}</option>)}
                  </select>
                </label>
              </div>
              <p className="text-[11px] text-port-text-muted">
                Level spread {fmt(group.lumaSpreadBefore)} → {fmt(group.lumaSpreadAfter)}
                {' · '}
                Color spread {fmt(group.chromaSpreadBefore)} → {fmt(group.chromaSpreadAfter)}
              </p>
              <ul className="flex flex-wrap gap-1">
                {group.shots.map((shot) => (
                  <li key={shot.sceneId} className={`rounded px-1.5 text-[11px] ${shot.outlier ? 'bg-port-warning/15 text-port-warning' : 'bg-port-border/50 text-port-text-muted'}`}>
                    {shot.label}{shot.outlier ? ' · re-roll' : ''}{shot.measured ? '' : ' · not measured'}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="break-words text-[11px] text-port-error">{error}</p>}
    </section>
  );
}

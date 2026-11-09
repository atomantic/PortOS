import { useState } from 'react';
import { COLOR_MATCH_LIMITS, colorMatchGroupOf, selectedColorMatchTake, shotSkipsColorMatch } from '../../../../server/lib/shotColorMatch.js';
import { measureMusicVideoColorMatch, updateMusicVideoTakeColorMatch } from '../../services/apiMusicVideo.js';

const BUTTON = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border bg-port-bg px-2 py-1.5 text-xs hover:bg-port-border/40 disabled:opacity-50 pointer-fine:sm:min-h-0';
const FIELD = 'min-h-[44px] w-full rounded border border-port-border bg-port-bg px-2 py-1 text-xs pointer-fine:sm:min-h-0';

const FIELDS = [
  ['black', 'Black'],
  ['white', 'White'],
  ['gamma', 'Gamma'],
  ['balanceR', 'Red balance'],
  ['balanceB', 'Blue balance'],
  ['saturation', 'Saturation'],
];

/**
 * One shot's color match. The numbers live on the selected take and are not
 * baked into the still or clip. `onApplied` updates local state only; the
 * dedicated route already saved.
 */
export default function ShotColorMatch({ project, scene, onApplied, fieldId }) {
  const id = (name) => (fieldId ? fieldId(name) : `mv-scene-${scene.sceneId}-${name}`);
  const camera = (project?.cameras || []).find((entry) => entry.id === scene?.shotSheet?.cameraId) || null;
  const take = selectedColorMatchTake(scene);
  const stored = take?.colorMatch || null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState({});
  const [amount, setAmount] = useState(null);

  const applyLocal = (resultScene) => {
    setDrafts({});
    setAmount(null);
    if (resultScene?.takes) onApplied?.({ takes: resultScene.takes });
  };

  const save = (patch) => {
    if (!project?.id || !take?.takeId) return;
    setBusy(true);
    setError('');
    updateMusicVideoTakeColorMatch(project.id, scene.sceneId, take.takeId, patch, { silent: true })
      .then((result) => applyLocal(result?.scene))
      .catch((err) => setError(err.message || 'Could not save the color match'))
      .finally(() => setBusy(false));
  };

  const measure = () => {
    if (!project?.id) return;
    setBusy(true);
    setError('');
    measureMusicVideoColorMatch(project.id, { sceneId: scene.sceneId }, { silent: true })
      .then((result) => applyLocal((result?.scenes || []).find((entry) => entry.sceneId === scene.sceneId)))
      .catch((err) => setError(err.message || 'Could not measure this shot'))
      .finally(() => setBusy(false));
  };

  if (shotSkipsColorMatch(scene, camera)) {
    return <p className="text-[11px] text-port-text-muted">This shot is left out of color matching.</p>;
  }
  if (!colorMatchGroupOf(scene, project?.cameras || [])) {
    return <p className="text-[11px] text-port-text-muted">Set a camera, location and time of day to match this shot.</p>;
  }

  const commitField = (key, label) => {
    const raw = drafts[key];
    if (raw == null || !stored?.correction) return;
    const value = Number(raw);
    const [lo, hi] = COLOR_MATCH_LIMITS[key];
    if (!Number.isFinite(value) || value < lo || value > hi) {
      setError(`${label} must be between ${lo} and ${hi}`);
      return;
    }
    setError('');
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    if (value === stored.correction[key]) return;
    save({ correction: { ...stored.correction, [key]: value } });
  };

  const shownAmount = amount ?? (Number.isFinite(stored?.strength) ? stored.strength : 1);
  const commitAmount = () => {
    if (amount == null) return;
    const next = amount;
    setAmount(null);
    if (next !== (Number.isFinite(stored?.strength) ? stored.strength : 1)) save({ strength: next });
  };

  return (
    <div className="space-y-2" aria-label="Color match">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-xs font-medium">Color match</h4>
        {stored && (
          <label htmlFor={id('color-match-on')} className="inline-flex min-h-[44px] items-center gap-1 text-[11px] pointer-fine:sm:min-h-0">
            <input id={id('color-match-on')} type="checkbox" checked={stored.enabled !== false} disabled={busy}
              onChange={(event) => save({ enabled: event.target.checked })} />
            On
          </label>
        )}
        <button type="button" className={BUTTON} onClick={measure} disabled={busy}>Measure this shot</button>
      </div>
      {stored?.outlier && <p role="status" className="text-[11px] text-port-warning">Past the match range — a re-roll candidate.</p>}
      {stored?.correction && (
        <>
          <p className="text-[11px] text-port-text-muted">Measuring again replaces these numbers. Numbers you edit stay.</p>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={id('color-match-amount')} className="text-[11px] text-port-text-muted">Amount</label>
            <input id={id('color-match-amount')} type="range" min="0" max="1" step="0.05" aria-label="Color match amount"
              className="min-h-[44px] min-w-[8rem] flex-1 pointer-fine:sm:min-h-0"
              value={shownAmount} disabled={busy}
              onChange={(event) => setAmount(Number(event.target.value))}
              onPointerUp={commitAmount} onKeyUp={commitAmount} onBlur={commitAmount} />
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {FIELDS.map(([key, label]) => (
              <label key={key} htmlFor={id(`color-match-${key}`)} className="block text-[11px] text-port-text-muted">
                {label}
                <input id={id(`color-match-${key}`)} type="number" inputMode="decimal" step="0.001" className={FIELD}
                  min={COLOR_MATCH_LIMITS[key][0]} max={COLOR_MATCH_LIMITS[key][1]} disabled={busy}
                  value={drafts[key] ?? stored.correction[key]}
                  onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
                  onBlur={() => commitField(key, label)} />
              </label>
            ))}
          </div>
        </>
      )}
      {error && <p role="alert" className="break-words text-[11px] text-port-error">{error}</p>}
    </div>
  );
}

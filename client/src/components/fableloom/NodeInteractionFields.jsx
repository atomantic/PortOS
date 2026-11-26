import { Link } from 'react-router';
import { FormField } from '../ui/FormField.jsx';
import { fieldClass, labelClass } from './fieldStyles';
import { FABLELOOM_HOLD_ROTATION_MODES, FABLELOOM_PROTAGONIST_PRESENCE, inspectNodeProductionReadiness } from '../../../../server/lib/fableLoomPlayback.js';
import characterReferenceInfo from './characterReferenceInfo';

export default function NodeInteractionFields({
  loom, node, universe, form, setForm, patchNode, universeCharacters, canonicalProtagonistId,
  protagonistId, protagonist, protagonistAppearance, linkedUniverseId, scenePresence,
  setScenePresence,
}) {
  const protagonistReference = protagonist ? characterReferenceInfo(protagonist) : null;
  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-port-text-muted">Live interaction & voice</span>
      <div className="border border-port-border rounded-lg p-3 bg-port-bg/40 space-y-3">
        <label className="flex items-center gap-2 text-xs font-medium" htmlFor="loom-interaction-enabled">
          <input
            id="loom-interaction-enabled"
            type="checkbox"
            checked={form.interactionWindow?.enabled || false}
            onChange={(e) => {
              const nextInteraction = {
                ...(form.interactionWindow || {}),
                enabled: e.target.checked,
                protagonistCharacterId: form.interactionWindow?.protagonistCharacterId
                  || canonicalProtagonistId
                  || null,
                protagonistPresence: form.interactionWindow?.protagonistPresence
                  || scenePresence
                  || 'offscreen',
              };
              setForm((p) => ({ ...p, interactionWindow: nextInteraction }));
              patchNode({ interactionWindow: nextInteraction });
            }}
          />
          Live conversation window (off-screen voice)
        </label>

        {form.interactionWindow?.enabled && (
          <div className="space-y-3 pl-5 pt-1 border-l-2 border-port-accent/30 text-xs">
            <FormField label="Protagonist from Universe Bible" labelClassName={labelClass}>
              <select
                className={fieldClass}
                id="loom-protagonist-character"
                aria-label="Protagonist character"
                value={protagonistId}
                onChange={(e) => {
                  const next = {
                    ...form.interactionWindow,
                    protagonistCharacterId: e.target.value || null,
                  };
                  setForm((p) => ({ ...p, interactionWindow: next }));
                  patchNode({ interactionWindow: next });
                }}
              >
                <option value="">Choose a Universe character</option>
                {protagonistId && !protagonist && (
                  <option value={protagonistId}>Missing Universe character ({protagonistId})</option>
                )}
                {universeCharacters.map((character) => (
                  <option key={character.id} value={character.id}>{character.name || character.id}</option>
                ))}
              </select>
            </FormField>

            {protagonist ? (
              <div className="rounded border border-port-border/70 bg-port-bg/40 p-2 space-y-1.5" role="status">
                <div className="font-medium text-port-text">{protagonist.name || protagonist.id}</div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                  <span className={protagonistReference.hasVisualReference ? 'text-port-success' : 'text-port-warning'}>
                    {protagonistReference.hasVisualReference ? 'Visual reference ready' : 'Needs visual reference'}
                  </span>
                  <span className={protagonistReference.sheetCount ? 'text-port-success' : 'text-port-warning'}>
                    {protagonistReference.sheetCount
                      ? `${protagonistReference.sheetCount} character sheet${protagonistReference.sheetCount === 1 ? '' : 's'}`
                      : 'Needs character sheet'}
                  </span>
                  <span className={protagonistReference.identityPackReady ? 'text-port-success' : 'text-port-warning'}>
                    {protagonistReference.identityPackReady
                      ? 'Identity pack ready'
                      : `Identity pack missing ${protagonistReference.missingIdentityRoles.join(', ')}`}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {linkedUniverseId && (
                    <Link
                      to={`/universes/${encodeURIComponent(linkedUniverseId)}?tab=cast`}
                      className="text-[11px] text-port-accent hover:underline"
                    >
                      Open Universe character sheets
                    </Link>
                  )}
                </div>
                {scenePresence === 'offscreen' && form.visualCanon && protagonistAppearance && (
                  <p className="text-[11px] text-port-accent">
                    Protagonist binding is omitted from this off-screen storyboard; it will return when this scene is marked on-screen.
                  </p>
                )}
                {scenePresence !== 'offscreen' && !protagonistAppearance && form.visualCanon && (
                  <p className="text-[11px] text-port-warning">
                    This scene&apos;s locked image/video cast does not include the protagonist yet.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-[11px] text-port-warning">
                Select the protagonist from the linked Universe before enabling canon-locked voice or visual production.
              </p>
            )}

            <div className="grid grid-cols-2 gap-2">
              <FormField label="Protagonist presence" labelClassName={labelClass}>
                <select
                  className={fieldClass}
                  value={form.interactionWindow.protagonistPresence || scenePresence || 'offscreen'}
                  onChange={(e) => setScenePresence(e.target.value)}
                >
                  {FABLELOOM_PROTAGONIST_PRESENCE.map((p) => (
                    <option key={p} value={p}>{p === 'offscreen' ? 'Off-screen' : 'On-screen'}</option>
                  ))}
                </select>
              </FormField>

              <FormField label="Hold rotation" labelClassName={labelClass}>
                <select
                  className={fieldClass}
                  value={form.interactionWindow.holdLoopRotation || 'deterministic'}
                  onChange={(e) => {
                    const next = { ...form.interactionWindow, holdLoopRotation: e.target.value };
                    setForm((p) => ({ ...p, interactionWindow: next }));
                    patchNode({ interactionWindow: next });
                  }}
                >
                  {FABLELOOM_HOLD_ROTATION_MODES.map((mode) => (
                    <option key={mode} value={mode}>{mode[0].toUpperCase() + mode.slice(1)}</option>
                  ))}
                </select>
              </FormField>
            </div>

            <FormField label={`Ambience ducking: ${form.interactionWindow.ambientDuckDb ?? -8} dB`} labelClassName={labelClass}>
              <input
                type="range"
                min="-60"
                max="0"
                step="1"
                className="w-full cursor-pointer accent-port-accent"
                value={form.interactionWindow.ambientDuckDb ?? -8}
                onChange={(e) => {
                  const next = { ...form.interactionWindow, ambientDuckDb: parseInt(e.target.value, 10) };
                  setForm((p) => ({ ...p, interactionWindow: next }));
                }}
                onMouseUp={() => patchNode({ interactionWindow: form.interactionWindow })}
                onTouchEnd={() => patchNode({ interactionWindow: form.interactionWindow })}
              />
            </FormField>
          </div>
        )}

        {(() => {
          const readiness = inspectNodeProductionReadiness(node, { loom, universe });
          if (!readiness.findings.length) return null;
          return (
            <div className="mt-2 space-y-1.5 pt-2 border-t border-port-border/60">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-port-text-muted">
                Readiness checks ({readiness.errorCount} error{readiness.errorCount === 1 ? '' : 's'})
              </span>
              {readiness.findings.map((f, i) => (
                <div
                  key={i}
                  className={`text-xs p-2 rounded border ${
                    f.severity === 'error' ? 'bg-port-error/10 border-port-error/30 text-port-error' :
                    f.severity === 'warning' ? 'bg-port-warning/10 border-port-warning/30 text-port-warning' :
                    'bg-port-bg border-port-border text-port-text-muted'
                  }`}
                >
                  <p className="font-medium">{f.message}</p>
                  {f.remediation && <p className="text-[11px] opacity-80 mt-0.5">Tip: {f.remediation}</p>}
                </div>
              ))}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

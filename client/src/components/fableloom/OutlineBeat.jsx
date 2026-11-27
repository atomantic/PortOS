import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { FormField } from '../ui/FormField.jsx';
import { fieldClass, labelClass } from './fieldStyles';
import { FABLELOOM_CHALLENGE_PHASES, fableLoomPlotPointKind } from '../../../../server/lib/fableLoomOutline.js';
import { asArray } from '../../../../server/lib/arrayUtils.js';

export default function OutlineBeat({
  scene, index, scenes, plotPoints, onChange, onRemovePath, onAddPath, expanded, onToggle,
}) {
  const possibleTargets = scenes.filter((candidate) => candidate.key !== scene.key);
  const selectedPlotPoint = plotPoints.find((item) => item.id === scene.plotPointId) || null;
  return (
    <article className="rounded-lg border border-port-border bg-port-bg/40" data-testid={`outline-beat-${scene.key}`}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start justify-between gap-3 p-3 text-left hover:bg-port-bg/60"
        aria-expanded={expanded}
      >
        <span className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-port-accent/15 text-[10px] font-semibold text-port-accent">{index + 1}</span>
          <span className="min-w-0">
            <span className="block break-words text-sm font-semibold">{scene.title || 'Untitled beat'}</span>
            <span className="mt-1 block break-words text-xs text-port-text-muted">{scene.summary || 'No log-line yet.'}</span>
            {scene.challengePhase ? (
              <span className="mt-1 inline-flex rounded bg-port-accent/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-port-accent">
                {scene.challengePhase}
              </span>
            ) : null}
          </span>
        </span>
        {expanded ? <ChevronUp size={15} className="shrink-0 text-port-text-muted" /> : <ChevronDown size={15} className="shrink-0 text-port-text-muted" />}
      </button>
      {expanded ? (
        <div className="space-y-3 border-t border-port-border p-3">
          <FormField label="Beat title" labelClassName={labelClass}>
            <input
              className={fieldClass}
              value={scene.title || ''}
              onChange={(event) => onChange({ title: event.target.value })}
            />
          </FormField>
          <FormField label="Log-line / summary" labelClassName={labelClass} hint="What changes in this camera-cut beat, and why does it matter?">
            <textarea
              rows={3}
              className={fieldClass}
              value={scene.summary || ''}
              onChange={(event) => onChange({ summary: event.target.value })}
            />
          </FormField>
          {plotPoints.length ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <FormField label="Mapped plot point" labelClassName={labelClass} hint="Connect this beat to the durable series-plan item it realizes.">
                <select
                  className={fieldClass}
                  value={scene.plotPointId || ''}
                  onChange={(event) => {
                    const plotPointId = event.target.value || null;
                    const selected = plotPoints.find((item) => item.id === plotPointId);
                    onChange({
                      plotPointId,
                      challengePhase: fableLoomPlotPointKind(selected) === 'challenge'
                        ? scene.challengePhase || 'setup'
                        : null,
                    });
                  }}
                >
                  <option value="">Not mapped</option>
                  {plotPoints.map((item) => (
                    <option key={item.id} value={item.id}>
                      {fableLoomPlotPointKind(item) === 'challenge' ? 'Challenge: ' : ''}{item.title || 'Untitled plot point'}
                    </option>
                  ))}
                </select>
              </FormField>
              {fableLoomPlotPointKind(selectedPlotPoint) === 'challenge' ? (
                <FormField label="Challenge phase" labelClassName={labelClass} hint="Every challenge needs all five phases before validation passes.">
                  <select
                    className={fieldClass}
                    value={scene.challengePhase || 'setup'}
                    onChange={(event) => onChange({ challengePhase: event.target.value })}
                  >
                    {FABLELOOM_CHALLENGE_PHASES.map((phase) => (
                      <option key={phase} value={phase}>{phase[0].toUpperCase() + phase.slice(1)}</option>
                    ))}
                  </select>
                </FormField>
              ) : null}
            </div>
          ) : null}
          <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            <FormField label="Playback" labelClassName={labelClass}>
              <select className={fieldClass} value={scene.playbackMode || 'decision'} onChange={(event) => onChange({ playbackMode: event.target.value })}>
                <option value="cut">Automatic cut</option>
                <option value="decision">Viewer choice</option>
              </select>
            </FormField>
            <FormField label="Audience channel" labelClassName={labelClass}>
              <select className={fieldClass} value={scene.audienceConnection || 'disconnected'} onChange={(event) => onChange({ audienceConnection: event.target.value })}>
                <option value="disconnected">Disconnected</option>
                <option value="connected">Connected</option>
              </select>
            </FormField>
          </div>
          <label className="flex items-center gap-2 text-xs text-port-text-muted">
            <input type="checkbox" checked={scene.isEnding === true} onChange={(event) => onChange({ isEnding: event.target.checked })} />
            Ending beat
          </label>
          {scene.isEnding ? (
            <FormField label="Ending label" labelClassName={labelClass}>
              <input className={fieldClass} value={scene.endingLabel || ''} onChange={(event) => onChange({ endingLabel: event.target.value })} />
            </FormField>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-port-text-muted">Paths to the next beat</h4>
                <button type="button" onClick={onAddPath} className="rounded border border-port-accent px-3 py-2 text-xs text-port-accent hover:bg-port-accent/10 focus-visible:outline-2 focus-visible:outline-port-accent pointer-coarse:min-h-11">+ Add path</button>
              </div>
              {asArray(scene.transitions).map((transition, transitionIndex) => (
                <div key={`${scene.key}-path-${transitionIndex}`} className="flex items-start gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <input
                      className={fieldClass}
                      aria-label={`Path ${transitionIndex + 1} choice label for ${scene.title || scene.key}`}
                      placeholder="choice label"
                      value={transition.intent || ''}
                      onChange={(event) => onChange({ transitions: asArray(scene.transitions).map((item, index) => index === transitionIndex ? { ...item, intent: event.target.value } : item) })}
                    />
                    <select
                      className={fieldClass}
                      aria-label={`Path ${transitionIndex + 1} destination for ${scene.title || scene.key}`}
                      value={transition.targetKey || ''}
                      onChange={(event) => onChange({ transitions: asArray(scene.transitions).map((item, index) => index === transitionIndex ? { ...item, targetKey: event.target.value } : item) })}
                    >
                      <option value="">Choose destination…</option>
                      {possibleTargets.map((target) => <option key={target.key} value={target.key}>{target.title || target.key}</option>)}
                    </select>
                  </div>
                  <button type="button" onClick={() => onRemovePath(transitionIndex)} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center mt-2 p-1 text-port-text-muted hover:text-port-error" aria-label={`Remove path ${transitionIndex + 1} from ${scene.title || scene.key}`}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </article>
  );
}

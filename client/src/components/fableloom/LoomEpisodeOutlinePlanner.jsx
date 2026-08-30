import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Loader2, Save, Sparkles, Trash2 } from 'lucide-react';
import ProviderModelSelector from '../ProviderModelSelector';
import { FormField } from '../ui/FormField.jsx';
import toast from '../ui/Toast';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import useFableLoomAiRun from '../../hooks/useFableLoomAiRun';
import useProviderModels from '../../hooks/useProviderModels';
import {
  generateLoomEpisodeOutline,
  reviewLoomEpisodeOutline,
  updateLoomEpisode,
  validateLoomEpisodeOutline,
} from '../../services/api';
import { effectiveModelFor, effortAwareModelOptions } from '../../utils/providers';
import { fieldClass, labelClass } from './fieldStyles';
import LoomAiRunStatus from './LoomAiRunStatus';

const asArray = (value) => (Array.isArray(value) ? value : []);

const cloneOutline = (outline) => (outline ? {
  ...outline,
  scenes: asArray(outline.scenes).map((scene) => ({
    ...scene,
    transitions: asArray(scene.transitions).map((transition) => ({ ...transition })),
  })),
  validation: outline.validation ? { ...outline.validation, issues: asArray(outline.validation.issues).map((issue) => ({ ...issue })) } : {
    status: 'draft', issues: [],
  },
} : null);

const draftValidation = { status: 'draft', issues: [] };

function ValidationResult({ validation }) {
  if (!validation) return null;
  const issues = asArray(validation.issues);
  const hasErrors = issues.some((issue) => issue.severity !== 'warning');
  const status = validation.stats
    ? (validation.stats.errorCount ? 'invalid' : 'valid')
    : validation.status || 'draft';
  const label = status === 'valid' ? 'Outline is structurally valid' : status === 'invalid' ? 'Outline needs edits' : 'Outline is a draft';
  return (
    <div className={`rounded border p-3 space-y-2 ${status === 'valid' ? 'border-port-success/40 bg-port-success/5' : hasErrors ? 'border-port-error/40 bg-port-error/5' : 'border-port-warning/40 bg-port-warning/5'}`} aria-live="polite">
      <div className="flex items-center gap-2 text-sm font-semibold">
        {status === 'valid' ? <CheckCircle2 size={15} className="text-port-success" /> : hasErrors ? <CircleAlert size={15} className="text-port-error" /> : <AlertTriangle size={15} className="text-port-warning" />}
        {label}
        {validation.stats ? <span className="ml-auto text-xs font-normal text-port-text-muted">
          {validation.stats.sceneCount} beats · {validation.stats.decisionCount} choices · {validation.stats.endingCount} endings
        </span> : null}
      </div>
      {issues.length ? (
        <ul className="space-y-1 text-xs text-port-text-muted">
          {issues.map((issue, index) => <li key={`${issue.code || 'issue'}-${issue.sceneKey || 'outline'}-${index}`} className="flex items-start gap-1.5">
            {issue.severity === 'warning' ? <AlertTriangle size={12} className="mt-0.5 shrink-0 text-port-warning" /> : <CircleAlert size={12} className="mt-0.5 shrink-0 text-port-error" />}
            <span>{issue.message}</span>
          </li>)}
        </ul>
      ) : status === 'valid' ? (
        <p className="text-xs text-port-success">Every beat is reachable, choices are distinct, and each path reaches an ending.</p>
      ) : null}
    </div>
  );
}

function OutlineBeat({ scene, index, scenes, onChange, onRemovePath, onAddPath, expanded, onToggle }) {
  const possibleTargets = scenes.filter((candidate) => candidate.key !== scene.key);
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
          <div className="grid grid-cols-2 gap-2">
            <label className={labelClass}>
              Playback
              <select className={`${fieldClass} mt-1`} value={scene.playbackMode || 'decision'} onChange={(event) => onChange({ playbackMode: event.target.value })}>
                <option value="cut">Automatic cut</option>
                <option value="decision">Viewer choice</option>
              </select>
            </label>
            <label className={labelClass}>
              Audience channel
              <select className={`${fieldClass} mt-1`} value={scene.audienceConnection || 'disconnected'} onChange={(event) => onChange({ audienceConnection: event.target.value })}>
                <option value="disconnected">Disconnected</option>
                <option value="connected">Connected</option>
              </select>
            </label>
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
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-port-text-muted">Paths to the next beat</h4>
                <button type="button" onClick={onAddPath} className="text-xs text-port-accent hover:underline">+ Add path</button>
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
                  <button type="button" onClick={() => onRemovePath(transitionIndex)} className="mt-2 p-1 text-port-text-muted hover:text-port-error" aria-label={`Remove path ${transitionIndex + 1} from ${scene.title || scene.key}`}>
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

export default function LoomEpisodeOutlinePlanner({
  open,
  loom,
  episode,
  guidance = '',
  disabled = false,
  onLoomUpdate,
  onExpand,
  expanding = false,
}) {
  const [outline, setOutline] = useState(() => cloneOutline(episode.storyOutline));
  const [dirty, setDirty] = useState(false);
  const [validation, setValidation] = useState(null);
  const [review, setReview] = useState(null);
  const [expandedKey, setExpandedKey] = useState(null);
  const [route, setRoute] = useState({ providerId: '', model: '', effort: '' });
  const generateRun = useFableLoomAiRun();
  const reviewRun = useFableLoomAiRun();
  const { providers, loading: providersLoading } = useProviderModels({
    allowDefault: true, silent: true, withEffort: true, enabled: open,
  });
  const selectedProvider = providers.find((provider) => provider.id === route.providerId);
  const routeBody = useMemo(() => ({
    ...(route.providerId ? { providerId: route.providerId } : {}),
    ...(route.model ? { model: route.model } : {}),
    ...(route.effort ? { effort: route.effort } : {}),
  }), [route]);

  useEffect(() => {
    setOutline(cloneOutline(episode.storyOutline));
    setDirty(false);
    setValidation(null);
    setReview(null);
    setExpandedKey(null);
  }, [episode.id]);

  const scenes = asArray(outline?.scenes);
  const outlineStatus = validation?.stats
    ? (validation.stats.errorCount ? 'invalid' : 'valid')
    : outline?.validation?.status || 'draft';
  const busy = disabled || providersLoading || generateRun.run?.phase === 'running' || reviewRun.run?.phase === 'running';
  const hasScenes = episode.nodes.length > 0;

  const updateOutline = (updater) => {
    setOutline((current) => {
      if (!current) return current;
      const next = typeof updater === 'function' ? updater(current) : updater;
      return { ...next, validation: { ...draftValidation } };
    });
    setDirty(true);
    setValidation(null);
    setReview(null);
  };

  const updateBeat = (key, patch) => updateOutline((current) => ({
    ...current,
    scenes: current.scenes.map((scene) => scene.key === key ? { ...scene, ...patch } : scene),
  }));

  const [generateOutline, generating] = useAsyncAction(async () => {
    const operationId = generateRun.begin();
    const result = await generateLoomEpisodeOutline(loom.id, episode.id, {
      ...routeBody,
      ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
      operationId,
    }, { silent: true }).catch((error) => {
      generateRun.fail(error.message);
      throw error;
    });
    const next = cloneOutline(result.outline || result.loom?.episodes?.find((item) => item.id === episode.id)?.storyOutline);
    setOutline(next);
    setValidation(result.validation || null);
    setReview(null);
    setDirty(false);
    onLoomUpdate(result.loom);
    toast.success(hasScenes ? 'Beat outline refreshed from the episode' : 'Episode beat outline drafted');
  }, { errorMessage: 'Episode outline drafting failed' });

  const [saveOutline, saving] = useAsyncAction(async () => {
    if (!outline) return;
    const updated = await updateLoomEpisode(loom.id, episode.id, {
      storyOutline: { ...outline, validation: { ...draftValidation } },
    }, { silent: true });
    onLoomUpdate(updated);
    const saved = updated.episodes.find((item) => item.id === episode.id)?.storyOutline;
    setOutline(cloneOutline(saved));
    setDirty(false);
    setValidation(null);
    setReview(null);
    toast.success('Beat outline saved');
    return updated;
  }, { errorMessage: 'Could not save episode outline' });

  const [validateOutline, validating] = useAsyncAction(async () => {
    if (dirty) {
      const saved = await saveOutline();
      if (!saved) return;
    }
    const result = await validateLoomEpisodeOutline(loom.id, episode.id, { silent: true });
    setOutline(cloneOutline(result.outline));
    setValidation(result.validation);
    setDirty(false);
    onLoomUpdate(result.loom);
    toast.success(result.validation.stats.errorCount ? 'Outline needs edits' : 'Outline validated — ready for expansion');
  }, { errorMessage: 'Outline validation failed' });

  const [reviewOutline, reviewing] = useAsyncAction(async () => {
    if (dirty) return;
    const operationId = reviewRun.begin();
    const result = await reviewLoomEpisodeOutline(loom.id, episode.id, { ...routeBody, operationId }, { silent: true })
      .catch((error) => { reviewRun.fail(error.message); throw error; });
    setReview(result.analysis);
    if (result.structural) setValidation(result.structural);
  }, { errorMessage: 'Episode outline review failed' });

  return (
    <section className="space-y-3 border-t border-port-border pt-4" aria-label="Episode story outline planner">
      <div>
        <h4 className="flex items-center gap-1.5 text-sm font-semibold"><Sparkles size={14} className="text-port-accent" /> Story beats → teleplay</h4>
        <p className="mt-1 text-xs text-port-text-muted">
          Plan the complete episode as log-lines first. Review and validate the arc before expanding it into full scene text, choices, and media prompts.
        </p>
      </div>
      <ProviderModelSelector
        providers={providers}
        selectedProviderId={route.providerId}
        selectedModel={route.model}
        availableModels={effortAwareModelOptions(selectedProvider, route.model)}
        onProviderChange={(providerId) => setRoute({ providerId, model: '', effort: '' })}
        onModelChange={(model) => setRoute((current) => ({ ...current, model }))}
        effort={route.effort}
        onEffortChange={(effort) => setRoute((current) => ({ ...current, effort }))}
        label="Outline AI route"
        layout="stacked"
        disabled={busy || generating || saving || validating || reviewing || expanding}
        modelDisabled={busy || generating || saving || validating || reviewing || expanding}
        emptyProviderOption="Default (outline stage or active provider)"
        emptyModelOption="Default model"
        alwaysShowModel={!!route.providerId}
      />
      {selectedProvider ? <p className="text-xs text-port-text-muted">Uses {selectedProvider.name}{effectiveModelFor(selectedProvider, route.model) ? ` (${effectiveModelFor(selectedProvider, route.model)})` : ''} for outline actions.</p> : null}

      {!outline ? (
        <button
          type="button"
          onClick={generateOutline}
          disabled={busy || generating || saving || validating || reviewing || expanding}
          className="flex w-full items-center justify-center gap-2 rounded bg-port-accent px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {generating ? 'Drafting beat outline…' : hasScenes ? 'Draft outline from current teleplay' : 'Draft story beat outline'}
        </button>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 text-xs text-port-text-muted">
            <span>{scenes.length} beat{scenes.length === 1 ? '' : 's'} · {scenes.filter((scene) => scene.isEnding).length} ending{scenes.filter((scene) => scene.isEnding).length === 1 ? '' : 's'} · {outlineStatus}</span>
            <button type="button" onClick={generateOutline} disabled={busy || generating || saving || validating || reviewing || expanding} className="text-port-accent hover:underline disabled:opacity-50">
              {generating ? 'Refreshing…' : 'Refresh with AI'}
            </button>
          </div>
          <div className="max-h-[42vh] space-y-2 overflow-y-auto pr-1">
            {scenes.map((scene, index) => (
              <OutlineBeat
                key={scene.key}
                scene={scene}
                index={index}
                scenes={scenes}
                expanded={expandedKey === scene.key}
                onToggle={() => setExpandedKey((current) => current === scene.key ? null : scene.key)}
                onChange={(patch) => updateBeat(scene.key, patch)}
                onRemovePath={(transitionIndex) => updateBeat(scene.key, {
                  transitions: asArray(scene.transitions).filter((_, pathIndex) => pathIndex !== transitionIndex),
                })}
                onAddPath={() => updateBeat(scene.key, {
                  transitions: [...asArray(scene.transitions), { targetKey: '', intent: '' }],
                })}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={saveOutline} disabled={!dirty || busy || saving || generating || validating || reviewing || expanding} className="flex items-center gap-1.5 rounded border border-port-border px-3 py-2 text-xs hover:border-port-accent disabled:opacity-50">
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              {saving ? 'Saving…' : 'Save outline'}
            </button>
            <button type="button" onClick={validateOutline} disabled={busy || saving || generating || validating || reviewing || expanding} className="flex items-center gap-1.5 rounded border border-port-accent px-3 py-2 text-xs text-port-accent hover:bg-port-accent/10 disabled:opacity-50">
              {validating ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
              {validating ? 'Validating…' : dirty ? 'Save & validate' : 'Validate outline'}
            </button>
            <button type="button" onClick={reviewOutline} disabled={busy || dirty || saving || generating || validating || reviewing || expanding} className="flex items-center gap-1.5 rounded border border-port-border px-3 py-2 text-xs hover:border-port-accent disabled:opacity-50">
              {reviewing ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              {reviewing ? 'Reviewing…' : 'Review arc with AI'}
            </button>
          </div>
          {dirty ? <p className="text-xs text-port-warning">Save the edited log-lines before asking the AI to review them.</p> : null}
          <ValidationResult validation={validation || outline.validation} />
          {onExpand ? (
            <button
              type="button"
              onClick={onExpand}
              disabled={busy || dirty || outlineStatus !== 'valid' || saving || generating || validating || reviewing || expanding}
              className="flex w-full items-center justify-center gap-2 rounded bg-port-accent px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              {expanding ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {expanding ? 'Expanding validated outline…' : 'Expand validated outline to teleplay'}
            </button>
          ) : null}
          {review ? (
            <div className="space-y-2 rounded border border-port-accent/30 bg-port-bg p-3" aria-live="polite">
              <h5 className="text-sm font-semibold">Editorial outline review</h5>
              {review.summary ? <p className="text-xs text-port-text-muted">{review.summary}</p> : null}
              {[
                ['Strengths', review.strengths],
                ['Story risks', review.risks],
                ['Recommended edits', review.recommendations],
              ].map(([heading, items]) => items?.length ? <div key={heading}>
                <h6 className="text-[11px] font-semibold uppercase tracking-wide text-port-text-muted">{heading}</h6>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">{items.map((item) => <li key={item}>{item}</li>)}</ul>
              </div> : null)}
            </div>
          ) : null}
        </>
      )}
      <LoomAiRunStatus run={generateRun.run} />
      <LoomAiRunStatus run={reviewRun.run} />
    </section>
  );
}

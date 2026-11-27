import LoomShotPlanner from './LoomShotPlanner';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Loader2, Save, Sparkles } from 'lucide-react';
import ProviderModelSelector from '../ProviderModelSelector';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import toast from '../ui/Toast';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import useFableLoomAiRun from '../../hooks/useFableLoomAiRun';
import useProviderModels from '../../hooks/useProviderModels';
import {
  generateLoomEpisodeOutline,
  reviewLoomEpisodeOutline,
  updateLoomEpisode,
  validateLoomEpisodeOutline,
} from '../../services/apiFableLoom.js';
import { effectiveModelFor, effortAwareModelOptions } from '../../utils/providers';
import LoomAiRunStatus from './LoomAiRunStatus';
import OutlineBeat from './OutlineBeat';
import OutlineValidationResult from './OutlineValidationResult';
import { asArray } from '../../../../server/lib/arrayUtils.js';
const TELEPLAY_SYNC_ISSUE_CODES = new Set([
  'TELEPLAY_SCENE_MEMBERSHIP_MISMATCH',
  'TELEPLAY_START_MISMATCH',
  'TELEPLAY_SCENE_CONTRACT_MISMATCH',
]);
const isTeleplaySyncIssue = (issue) => TELEPLAY_SYNC_ISSUE_CODES.has(issue?.code);

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
  const lastServerOutline = useRef({ episodeId: episode.id, outline: episode.storyOutline });
  const publishedOutline = useRef(null);
  const [dirty, setDirty] = useState(false);
  const [confirmRefresh, setConfirmRefresh] = useState(false);
  const [validation, setValidation] = useState(null);
  const [review, setReview] = useState(null);
  const [shotPlanning, setShotPlanning] = useState(false);
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
    const previous = lastServerOutline.current;
    const switchedEpisode = previous.episodeId !== episode.id;
    if (!switchedEpisode && previous.outline === episode.storyOutline) return;
    lastServerOutline.current = { episodeId: episode.id, outline: episode.storyOutline };
    const cameFromPlanner = publishedOutline.current?.outline === episode.storyOutline
      && publishedOutline.current?.episodeId === episode.id;
    publishedOutline.current = null;
    if (!switchedEpisode && (dirty || cameFromPlanner)) return;
    setConfirmRefresh(false);
    setOutline(cloneOutline(episode.storyOutline));
    setValidation(null);
    setReview(null);
    if (switchedEpisode) {
      setDirty(false);
      setExpandedKey(null);
    }
  }, [episode.id, episode.storyOutline, dirty]);

  const publishOutlineUpdate = (nextLoom) => {
    const savedOutline = nextLoom?.episodes?.find((item) => item.id === episode.id)?.storyOutline;
    // Keep the richer local result when this mutation's response returns as a prop.
    publishedOutline.current = { episodeId: episode.id, outline: savedOutline };
    onLoomUpdate(nextLoom);
    return savedOutline;
  };

  const scenes = asArray(outline?.scenes);
  const plotPoints = asArray(loom.seriesPlan?.plotPoints)
    .filter((item) => item.episodeId === episode.id);
  const outlineStatus = validation?.stats
    ? (validation.stats.errorCount ? 'invalid' : 'valid')
    : outline?.validation?.status || 'draft';
  const busy = shotPlanning || disabled || providersLoading || generateRun.run?.phase === 'running' || reviewRun.run?.phase === 'running';
  const hasScenes = episode.nodes.length > 0;
  const activeValidation = validation || outline?.validation;
  const activeValidationIssues = asArray(activeValidation?.issues);
  const replacementBlockingIssues = activeValidationIssues
    .filter((issue) => issue.severity !== 'warning');
  const teleplayReplacementReady = hasScenes
    && outlineStatus === 'invalid'
    && replacementBlockingIssues.length > 0
    && replacementBlockingIssues.every(isTeleplaySyncIssue);
  const canExpand = outlineStatus === 'valid' || teleplayReplacementReady;

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
    publishOutlineUpdate(result.loom);
    toast.success(hasScenes ? 'Beat outline refreshed from the episode' : 'Episode beat outline drafted');
  }, { errorMessage: 'Episode outline drafting failed' });

  const [saveOutline, saving] = useAsyncAction(async () => {
    if (!outline) return;
    const updated = await updateLoomEpisode(loom.id, episode.id, {
      storyOutline: { ...outline, validation: { ...draftValidation } },
    }, { silent: true });
    const saved = publishOutlineUpdate(updated);
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
    publishOutlineUpdate(result.loom);
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

  const actionsBusy = busy || generating || saving || validating || reviewing || expanding;

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
        disabled={actionsBusy}
        modelDisabled={actionsBusy}
        loading={providersLoading}
        emptyProviderOption="Default (outline stage or active provider)"
        emptyModelOption="Default model"
        alwaysShowModel={!!route.providerId}
      />
      {selectedProvider ? <p className="text-xs text-port-text-muted">Uses {selectedProvider.name}{effectiveModelFor(selectedProvider, route.model) ? ` (${effectiveModelFor(selectedProvider, route.model)})` : ''}{route.effort ? ` at ${route.effort} effort` : ''} for outline and expansion actions.</p> : null}

      {!outline ? (
        <button
          type="button"
          onClick={generateOutline}
          disabled={actionsBusy}
          className="flex w-full items-center justify-center gap-2 rounded bg-port-accent px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {generating ? 'Drafting beat outline…' : hasScenes ? 'Draft outline from current teleplay' : 'Draft story beat outline'}
        </button>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-port-text-muted">
            <span>{scenes.length} beat{scenes.length === 1 ? '' : 's'} · {scenes.filter((scene) => scene.isEnding).length} ending{scenes.filter((scene) => scene.isEnding).length === 1 ? '' : 's'} · {outlineStatus}</span>
            {confirmRefresh ? (
              <ConfirmButtonPair
                tone="warning"
                prompt={dirty
                  ? 'Replace the saved outline and discard your unsaved edits?'
                  : 'Replace the saved outline with a new AI draft?'}
                confirmText="Replace outline"
                busy={actionsBusy}
                busyText={generating ? 'Refreshing…' : undefined}
                onConfirm={async () => {
                  await generateOutline();
                  setConfirmRefresh(false);
                }}
                onCancel={() => setConfirmRefresh(false)}
                className="flex-wrap"
              />
            ) : (
              <button
                type="button"
                onClick={() => setConfirmRefresh(true)}
                disabled={actionsBusy}
                className="rounded border border-port-accent px-3 py-2 text-xs text-port-accent hover:bg-port-accent/10 focus-visible:outline-2 focus-visible:outline-port-accent disabled:opacity-50 pointer-coarse:min-h-11"
              >
                Refresh with AI
              </button>
            )}
          </div>
          <fieldset disabled={generating} aria-label="Outline beats" className="max-h-[42vh] min-w-0 space-y-2 overflow-y-auto pr-1">
            {scenes.map((scene, index) => (
              <OutlineBeat
                key={scene.key}
                scene={scene}
                index={index}
                scenes={scenes}
                plotPoints={plotPoints}
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
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={saveOutline} disabled={!dirty || actionsBusy} className="flex items-center gap-1.5 rounded border border-port-border px-3 py-2 text-xs hover:border-port-accent disabled:opacity-50">
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              {saving ? 'Saving…' : 'Save outline'}
            </button>
            <button type="button" onClick={validateOutline} disabled={actionsBusy} className="flex items-center gap-1.5 rounded border border-port-accent px-3 py-2 text-xs text-port-accent hover:bg-port-accent/10 disabled:opacity-50">
              {validating ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
              {validating ? 'Validating…' : dirty ? 'Save & validate' : 'Validate outline'}
            </button>
            <button type="button" onClick={reviewOutline} disabled={dirty || actionsBusy} className="flex items-center gap-1.5 rounded border border-port-border px-3 py-2 text-xs hover:border-port-accent disabled:opacity-50">
              {reviewing ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              {reviewing ? 'Reviewing…' : 'Review arc with AI'}
            </button>
          </div>
          {dirty ? <p className="text-xs text-port-warning">Save the edited log-lines before asking the AI to review them.</p> : null}
          <OutlineValidationResult
            validation={activeValidation}
            teleplayReplacementReady={teleplayReplacementReady}
          />
          {onExpand ? (
            <button
              type="button"
              onClick={() => onExpand(routeBody)}
              disabled={dirty || !canExpand || actionsBusy}
              className="flex w-full items-center justify-center gap-2 rounded bg-port-accent px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              {expanding ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {expanding
                ? 'Expanding validated outline…'
                : teleplayReplacementReady
                  ? 'Replace old teleplay from this outline'
                  : 'Expand validated outline to teleplay'}
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
      <LoomShotPlanner onRunningChange={setShotPlanning} key={episode.id} loom={loom} episode={episode} route={routeBody} guidance={guidance} disabled={dirty || actionsBusy} onLoomUpdate={(next) => { setOutline(cloneOutline(publishOutlineUpdate(next))); setValidation(null); }} />
      <LoomAiRunStatus run={generateRun.run} />
      <LoomAiRunStatus run={reviewRun.run} />
    </section>
  );
}

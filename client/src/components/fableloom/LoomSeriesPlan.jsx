/**
 * Series-level FableLoom planning, intentionally separate from episode scene
 * graphs. One explicit save persists the whole ordered plan so moving a beat
 * and editing its copy cannot race as independent PATCH requests.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { BrainCircuit, CheckCircle2, ChevronDown, ChevronUp, Loader2, Plus, Save, Sparkles, Trash2 } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import toast from '../ui/Toast';
import { FormField } from '../ui/FormField.jsx';
import UnsavedChangesConfirm from '../ui/UnsavedChangesConfirm.jsx';
import ProviderModelSelector from '../ProviderModelSelector';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import useFableLoomAiRun from '../../hooks/useFableLoomAiRun';
import useProviderModels from '../../hooks/useProviderModels';
import useUnsavedChangesGuard from '../../hooks/useUnsavedChangesGuard';
import {
  feedbackLoomSeriesPlan, generateLoomSeriesPlan, reviewLoomSeriesPlan, reviewLoomTeleplay,
  updateLoom, validateLoomSeriesOutlines,
} from '../../services/api';
import { uuidv4 } from '../../lib/uuid.js';
import { effectiveModelFor, effortAwareModelOptions } from '../../utils/providers';
import { fieldClass, labelClass } from './fieldStyles';
import LoomAiRunStatus from './LoomAiRunStatus';
import LoomEditorialAutomation from './LoomEditorialAutomation';
import { fableLoomPlotPointKind } from '../../../../server/lib/fableLoomOutline.js';

const newItemId = (prefix) => `${prefix}-${uuidv4()}`;
const CHALLENGE_DESCRIPTION_TEMPLATE = 'SETUP: Establish the blockade and plant the clue. VIEWER DECISION LOOP: Offer 2–4 actionable options with escalating feedback. SUCCESS: Advance with an earned advantage. FAILURE: Continue with a visible cost. RECOVERY / PAYOFF: Converge without erasing the choice.';

const normalizeDeliveryOptions = (options) => ({
  overnightVoicemails: options?.overnightVoicemails === true,
  nextSeasonTeaser: options?.nextSeasonTeaser === true,
});

const normalizePlan = (plan) => ({
  storyArc: plan?.storyArc || '',
  plotPoints: Array.isArray(plan?.plotPoints)
    ? plan.plotPoints.map((item) => ({ ...item, kind: fableLoomPlotPointKind(item) }))
    : [],
  sideQuests: Array.isArray(plan?.sideQuests) ? plan.sideQuests : [],
  deliveryOptions: normalizeDeliveryOptions(plan?.deliveryOptions),
  interEpisodeVoicemails: Array.isArray(plan?.interEpisodeVoicemails)
    ? plan.interEpisodeVoicemails : [],
  nextSeasonTeaser: plan?.nextSeasonTeaser || null,
});

const episodeBoundaryKey = (fromEpisodeId, toEpisodeId) => `${fromEpisodeId}::${toEpisodeId}`;

const withVoicemailDrafts = (plan, episodes) => {
  const current = new Map((plan.interEpisodeVoicemails || [])
    .filter((item) => item?.fromEpisodeId && item?.toEpisodeId)
    .map((item) => [episodeBoundaryKey(item.fromEpisodeId, item.toEpisodeId), item]));
  return episodes.slice(0, -1).map((fromEpisode, index) => {
    const toEpisode = episodes[index + 1];
    return current.get(episodeBoundaryKey(fromEpisode.id, toEpisode.id)) || {
      id: newItemId('voicemail'),
      fromEpisodeId: fromEpisode.id,
      toEpisodeId: toEpisode.id,
      title: `Overnight voicemail: Episode ${fromEpisode.number || index + 1} → ${toEpisode.number || index + 2}`,
      transcript: '',
    };
  });
};

export default function LoomSeriesPlan({ loom, onLoomUpdate }) {
  const [searchParams] = useSearchParams();
  const requestedSection = searchParams.get('section');
  const [plan, setPlan] = useState(() => normalizePlan(loom.seriesPlan));
  const [dirty, setDirty] = useState(false);
  const revisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const loomIdRef = useRef(loom.id);
  const routeGuard = useUnsavedChangesGuard(dirty);

  useEffect(() => {
    const targetId = {
      arc: 'fableloom-plan-arc',
      challenges: 'fableloom-plan-challenges',
      editorial: 'fableloom-plan-editorial',
      handoffs: 'fableloom-plan-handoffs',
    }[requestedSection];
    if (!targetId) return undefined;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      target?.focus?.({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [loom.id, requestedSection]);

  useEffect(() => {
    if (loomIdRef.current !== loom.id) {
      loomIdRef.current = loom.id;
      revisionRef.current = 0;
      savedRevisionRef.current = 0;
      setPlan(normalizePlan(loom.seriesPlan));
      setDirty(false);
      return;
    }
    // A save response may arrive after the author has continued typing. Keep
    // that newer draft instead of replacing it with the just-saved snapshot.
    if (revisionRef.current > savedRevisionRef.current) {
      setDirty(true);
      return;
    }
    setPlan(normalizePlan(loom.seriesPlan));
    setDirty(false);
  }, [loom.id, loom.seriesPlan]);

  const changePlan = (updater) => {
    setPlan((current) => (typeof updater === 'function' ? updater(current) : updater));
    revisionRef.current += 1;
    setDirty(true);
  };

  const updateItem = (collection, id, patch) => changePlan((current) => ({
    ...current,
    [collection]: current[collection].map((item) => (item.id === id ? { ...item, ...patch } : item)),
  }));

  const removeItem = (collection, id) => changePlan((current) => ({
    ...current,
    [collection]: current[collection].filter((item) => item.id !== id),
  }));

  const moveItem = (collection, index, direction) => changePlan((current) => {
    const next = [...current[collection]];
    const target = index + direction;
    if (target < 0 || target >= next.length) return current;
    [next[index], next[target]] = [next[target], next[index]];
    return { ...current, [collection]: next };
  });

  const [save, saving] = useAsyncAction(async () => {
    const submittedRevision = revisionRef.current;
    const updated = await updateLoom(loom.id, { seriesPlan: plan }, { silent: true });
    savedRevisionRef.current = submittedRevision;
    onLoomUpdate(updated);
    setDirty(revisionRef.current > submittedRevision);
    toast.success('Series plan saved');
  }, { errorMessage: 'Could not save series plan' });

  // AI generation/feedback replaces the saved series plan as one server-owned
  // result. Make that response authoritative over any typing that happened
  // while the provider call was in flight; otherwise the revision guard would
  // keep the stale local plan on screen and a later Save would undo the AI run.
  const adoptServerPlan = useCallback((updated) => {
    revisionRef.current = 0;
    savedRevisionRef.current = 0;
    onLoomUpdate(updated);
  }, [onLoomUpdate]);

  const episodeOptions = loom.episodes.map((episode) => ({
    id: episode.id,
    label: `${episode.number}. ${episode.title || 'Untitled'}`,
  }));

  const discardAndExit = () => {
    setPlan(normalizePlan(loom.seriesPlan));
    setDirty(false);
    routeGuard.proceed();
  };

  return (
    <section className="flex-1 overflow-y-auto p-4 md:p-6" aria-label="Series plan">
      <UnsavedChangesConfirm
        guard={routeGuard}
        when={!saving}
        question="Discard your unsaved series-plan changes?"
        label={`Discard unsaved changes to ${loom.name}`}
        onDiscard={discardAndExit}
      />
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col lg:flex-row items-start gap-6">
          <div className="flex-1 min-w-0 w-full space-y-6">
            <div>
              <h2 className="text-lg font-semibold">Series plan</h2>
              <p className="text-sm text-port-text-muted mt-1">
                Shape the full narrative before working inside individual episode graphs.
              </p>
            </div>

            <div id="fableloom-plan-arc" tabIndex={-1} className="rounded-lg border border-port-border bg-port-card p-4 focus:outline-none">
              <FormField
                label="Story arc"
                hint="The beginning-to-end dramatic movement, central conflict, and intended resolution."
                labelClassName={labelClass}
              >
                <textarea
                  rows={7}
                  className={fieldClass}
                  value={plan.storyArc}
                  placeholder="What changes across the series, why it matters, and where the story lands…"
                  onChange={(event) => changePlan((current) => ({ ...current, storyArc: event.target.value }))}
                />
              </FormField>
            </div>

            <div id="fableloom-plan-challenges" tabIndex={-1} className="focus:outline-none">
              <PlanCollection
                title="Plot points"
                description="Order tentpoles and playable challenges, then assign each one to the episode where it must appear."
                items={plan.plotPoints}
                episodes={episodeOptions}
                onAdd={() => changePlan((current) => ({ ...current, plotPoints: [...current.plotPoints, {
                  id: newItemId('plot'), kind: 'beat', title: '', description: '', episodeId: null,
                }] }))}
                onUpdate={(id, patch) => updateItem('plotPoints', id, patch)}
                onAddChallenge={() => changePlan((current) => ({ ...current, plotPoints: [...current.plotPoints, {
                  id: newItemId('plot'), kind: 'challenge', title: '', description: CHALLENGE_DESCRIPTION_TEMPLATE, episodeId: null,
                }] }))}
                onRemove={(id) => removeItem('plotPoints', id)}
                onMove={(index, direction) => moveItem('plotPoints', index, direction)}
              />
            </div>

            <PlanCollection
              title="Side quests"
              description="Track supporting threads without letting them disappear inside a single episode."
              items={plan.sideQuests}
              episodes={episodeOptions}
              sideQuests
              onAdd={() => changePlan((current) => ({ ...current, sideQuests: [...current.sideQuests, {
                id: newItemId('quest'), title: '', description: '', status: 'idea', startEpisodeId: null, endEpisodeId: null,
              }] }))}
              onUpdate={(id, patch) => updateItem('sideQuests', id, patch)}
              onRemove={(id) => removeItem('sideQuests', id)}
              onMove={(index, direction) => moveItem('sideQuests', index, direction)}
            />

            <EpisodeBeatReadiness loom={loom} />

            <div id="fableloom-plan-editorial" tabIndex={-1} className="focus:outline-none">
              <LoomEditorialAutomation loom={loom} dirty={dirty} onLoomUpdate={adoptServerPlan} />
            </div>

            <div id="fableloom-plan-handoffs" tabIndex={-1} className="focus:outline-none">
              <SeriesDeliveryPlan
                plan={plan}
                episodes={loom.episodes}
                onChange={changePlan}
              />
            </div>
          </div>

          <aside className="w-full lg:w-[380px] xl:w-[420px] shrink-0 space-y-6 lg:sticky lg:top-0 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto" aria-label="AI tools and actions">
            <div className="rounded-lg border border-port-border bg-port-card p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-sm">Series plan actions</h3>
                  <p className="text-xs flex items-center gap-1.5 mt-0.5">
                    <span className={`inline-block w-2 h-2 rounded-full ${dirty ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                    <span className="text-port-text-muted">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={save}
                  disabled={!dirty || saving}
                  className="shrink-0 flex items-center gap-2 px-3 py-2 rounded bg-port-accent text-white text-sm disabled:opacity-50 font-medium"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  {saving ? 'Saving…' : 'Save plan'}
                </button>
              </div>
            </div>

            <SeriesAiEditor loom={loom} dirty={dirty} onLoomUpdate={adoptServerPlan} />
          </aside>
        </div>
      </div>
    </section>
  );
}

function EpisodeBeatReadiness({ loom }) {
  const episodes = loom.episodes || [];
  const readyCount = episodes.filter((episode) => episode.storyOutline?.validation?.status === 'valid').length;
  const [validation, setValidation] = useState(null);

  useEffect(() => {
    setValidation(null);
  }, [loom.id, loom.updatedAt]);

  const [validateArc, validating] = useAsyncAction(async () => {
    const result = await validateLoomSeriesOutlines(loom.id, { silent: true });
    setValidation(result);
  }, { errorMessage: 'Full beat-arc validation failed' });

  const validationIssues = validation?.issues || [];
  const validationReady = validation?.stats?.ready === true;
  return (
    <section className="rounded-lg border border-port-accent/30 bg-port-accent/5 p-4 space-y-3" aria-label="Episode beat outlines">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">Episode beat outlines</h3>
          <p className="mt-1 text-xs text-port-text-muted">
            Draft the full series as scene log-lines first. Open episodes in order, review each arc, and validate every outline before expanding any teleplay.
          </p>
        </div>
        <span className={`shrink-0 text-xs ${readyCount === episodes.length && episodes.length ? 'text-port-success' : 'text-port-warning'}`}>
          {readyCount}/{episodes.length} ready
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={validateArc}
          disabled={validating || !episodes.length}
          className="flex items-center gap-1.5 rounded border border-port-accent px-3 py-2 text-xs text-port-accent hover:bg-port-accent/10 disabled:opacity-50"
        >
          {validating ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
          {validating ? 'Validating full beat arc…' : 'Validate full beat arc'}
        </button>
        {validation ? (
          <span className={`text-xs ${validationReady ? 'text-port-success' : 'text-port-error'}`} role="status">
            {validationReady ? 'Series beat arc is structurally ready' : `${validation.stats?.errorCount || validationIssues.length} blocking issue${(validation.stats?.errorCount || validationIssues.length) === 1 ? '' : 's'}`}
          </span>
        ) : null}
      </div>
      {episodes.length ? (
        <ol className="space-y-1.5">
          {episodes.map((episode) => {
            const status = episode.storyOutline?.validation?.status || 'missing';
            const statusClass = status === 'valid' ? 'text-port-success' : 'text-port-warning';
            return (
              <li key={episode.id} className="flex items-center justify-between gap-3 text-sm">
                <Link to={`/fableloom/${encodeURIComponent(loom.id)}/${encodeURIComponent(episode.id)}`} className="min-w-0 truncate text-port-accent hover:underline">
                  Episode {episode.number}: {episode.title || 'Untitled'}
                </Link>
                <span className={`shrink-0 text-xs ${statusClass}`}>{status}</span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-xs text-port-warning">Add episodes before drafting the beat arc.</p>
      )}
      {validation && validationIssues.length ? (
        <div className="space-y-1.5 rounded border border-port-error/30 bg-port-error/5 p-3" aria-label="Full beat arc validation results">
          <p className="text-xs font-semibold text-port-error">Resolve these before expanding any teleplay:</p>
          <ul className="space-y-1 text-xs text-port-text-muted">
            {validationIssues.slice(0, 12).map((issue, index) => {
              const episode = episodes.find((candidate) => candidate.id === issue.episodeId);
              return (
                <li key={`${issue.code || 'issue'}-${issue.episodeId || 'series'}-${index}`}>
                  {episode ? (
                    <Link className="text-port-accent hover:underline" to={`/fableloom/${encodeURIComponent(loom.id)}/${encodeURIComponent(episode.id)}`}>
                      Episode {episode.number}
                    </Link>
                  ) : <span>Series</span>}
                  {': '}{issue.message}
                </li>
              );
            })}
          </ul>
          {validationIssues.length > 12 ? <p className="text-[11px] text-port-text-muted">Showing the first 12 issues.</p> : null}
        </div>
      ) : validation ? (
        <p className="text-xs text-port-success" role="status">Every episode outline and configured delivery handoff passes deterministic checks.</p>
      ) : null}
      {readyCount === episodes.length && episodes.length ? (
        <p className="text-xs text-port-success">The complete episode beat arc is ready for ordered teleplay expansion.</p>
      ) : (
        <p className="text-xs text-port-text-muted">The expansion gate also checks any configured overnight voicemail and finale teaser handoffs.</p>
      )}
    </section>
  );
}

function SeriesAiEditor({ loom, dirty, onLoomUpdate }) {
  const [feedback, setFeedback] = useState('');
  const [analysis, setAnalysis] = useState(null);
  const [route, setRoute] = useState({ providerId: '', model: '', effort: '' });
  const regenerateConfirm = useConfirmDelete();
  const reviewRun = useFableLoomAiRun();
  const teleplayReviewRun = useFableLoomAiRun();
  const generateRun = useFableLoomAiRun();
  const feedbackRun = useFableLoomAiRun();
  const { providers, loading } = useProviderModels({ allowDefault: true, silent: true, withEffort: true });
  const selectedProvider = providers.find((provider) => provider.id === route.providerId);
  const routeBody = {
    ...(route.providerId ? { providerId: route.providerId } : {}),
    ...(route.model ? { model: route.model } : {}),
    ...(route.effort ? { effort: route.effort } : {}),
  };

  const [runReview, reviewing] = useAsyncAction(async () => {
    const operationId = reviewRun.begin();
    const result = await reviewLoomSeriesPlan(loom.id, { ...routeBody, operationId }, { silent: true })
      .catch((error) => { reviewRun.fail(error.message); throw error; });
    setAnalysis(result.analysis);
  }, { errorMessage: 'Series analysis failed' });

  const [generatePlan, generating] = useAsyncAction(async () => {
    const operationId = generateRun.begin();
    const result = await generateLoomSeriesPlan(loom.id, { ...routeBody, operationId }, { silent: true })
      .catch((error) => { generateRun.fail(error.message); throw error; });
    onLoomUpdate(result.loom);
    setAnalysis(null);
    toast.success('Full series plan drafted');
  }, { errorMessage: 'Series-plan drafting failed' });

  const [applyFeedback, applying] = useAsyncAction(async () => {
    const operationId = feedbackRun.begin();
    const result = await feedbackLoomSeriesPlan(loom.id, {
      feedback: feedback.trim(), ...routeBody, operationId,
    }, { silent: true }).catch((error) => { feedbackRun.fail(error.message); throw error; });
    onLoomUpdate(result.loom);
    setFeedback('');
    setAnalysis(null);
    toast.success(result.changes?.[0] || 'Series plan updated');
  }, { errorMessage: 'Series-plan feedback failed' });

  const [reviewTeleplay, reviewingTeleplay] = useAsyncAction(async () => {
    const operationId = teleplayReviewRun.begin();
    const result = await reviewLoomTeleplay(loom.id, { ...routeBody, operationId }, { silent: true })
      .catch((error) => { teleplayReviewRun.fail(error.message); throw error; });
    setTeleplayAnalysis(result.analysis);
  }, { errorMessage: 'Full teleplay review failed' });

  const [teleplayAnalysis, setTeleplayAnalysis] = useState(null);
  const fullTeleplayReady = loom.episodes.length > 0 && loom.episodes.every((episode) => episode.nodes?.length > 0);
  const busy = generating || reviewing || applying || reviewingTeleplay;
  const hasPlan = !!loom.seriesPlan?.storyArc?.trim()
    || !!loom.seriesPlan?.plotPoints?.length
    || !!loom.seriesPlan?.sideQuests?.length;
  const confirmRegeneration = () => {
    regenerateConfirm.cancelDelete();
    if (!dirty && !busy) generatePlan();
  };
  return (
    <div className="rounded-lg border border-port-border bg-port-card p-4 space-y-4">
      <div>
        <h3 className="font-semibold flex items-center gap-2"><BrainCircuit size={16} className="text-port-accent" /> AI outline editor</h3>
        <p className="text-xs text-port-text-muted mt-1">
          Draft, analyze, and edit the story arc, plot points, and side quests across the entire series.
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
        label="AI route"
        layout="stacked"
        disabled={busy || loading}
        modelDisabled={busy || loading}
        loading={loading}
        emptyProviderOption="Default (series-plan stage or active provider)"
        emptyModelOption="Default model"
        alwaysShowModel={!!route.providerId}
      />
      {selectedProvider ? (
        <p className="text-xs text-port-text-muted">
          These actions will use {selectedProvider.name}{effectiveModelFor(selectedProvider, route.model) ? ` (${effectiveModelFor(selectedProvider, route.model)})` : ''}.
        </p>
      ) : null}
      {hasPlan && regenerateConfirm.isConfirming('series-plan') ? (
        <ConfirmButtonPair
          prompt="Replace the saved plan?"
          confirmText="Regenerate"
          confirmIcon={Sparkles}
          onConfirm={confirmRegeneration}
          onCancel={regenerateConfirm.cancelDelete}
          tone="warning"
          className="justify-end"
          largeTouchTargets
        />
      ) : (
        <button
          type="button"
          onClick={() => (hasPlan ? regenerateConfirm.requestDelete('series-plan') : generatePlan())}
          disabled={busy || dirty}
          className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded bg-port-accent text-white text-sm disabled:opacity-50"
        >
          {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {generating ? 'Drafting full plan…' : hasPlan ? 'Regenerate full plan' : 'Draft full plan'}
        </button>
      )}
      <LoomAiRunStatus run={generateRun.run} />
      {hasPlan ? (
        <p className="text-xs text-port-text-muted">
          Regenerating replaces the saved arc, plot points, and side quests. Episode titles,
          synopses, scenes, and paths stay untouched.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={runReview}
          disabled={busy || dirty}
          className="flex items-center gap-2 px-3 py-2 rounded border border-port-border text-sm hover:border-port-accent disabled:opacity-50"
        >
          {reviewing ? <Loader2 size={14} className="animate-spin" /> : <BrainCircuit size={14} />}
          {reviewing ? 'Analyzing…' : 'Analyze series'}
        </button>
        <button
          type="button"
          onClick={reviewTeleplay}
          disabled={busy || dirty || !fullTeleplayReady}
          className="flex items-center gap-2 px-3 py-2 rounded border border-port-border text-sm hover:border-port-accent disabled:opacity-50"
        >
          {reviewingTeleplay ? <Loader2 size={14} className="animate-spin" /> : <BrainCircuit size={14} />}
          {reviewingTeleplay ? 'Reviewing teleplay…' : 'Review full teleplay'}
        </button>
      </div>
      <LoomAiRunStatus run={reviewRun.run} />
      <LoomAiRunStatus run={teleplayReviewRun.run} />
      {!fullTeleplayReady ? <p className="text-xs text-port-text-muted">Expand every episode before reviewing the complete teleplay series.</p> : null}
      <FormField
        label="Edit outline & plot points"
        hint="Ask the AI to refine or restructure plot points, story beats, or side quests across the entire series."
        labelClassName={labelClass}
      >
        <textarea
          rows={4}
          className={fieldClass}
          value={feedback}
          placeholder="Describe how to revise the arc, plot points, or side quests across the series…"
          onChange={(event) => setFeedback(event.target.value)}
          disabled={busy}
        />
      </FormField>
      <button
        type="button"
        onClick={applyFeedback}
        disabled={busy || dirty || !feedback.trim()}
        className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded bg-port-accent text-white text-sm disabled:opacity-50"
      >
        {applying ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
        {applying ? 'Updating series plan…' : 'Apply guidance to plan'}
      </button>
      <LoomAiRunStatus run={feedbackRun.run} />
      {dirty ? <p className="text-xs text-port-warning">Save the plan before running AI so it reads the edits on screen.</p> : null}
      {analysis ? <SeriesAnalysis analysis={analysis} /> : null}
      {teleplayAnalysis ? <SeriesAnalysis title="Full teleplay review" analysis={teleplayAnalysis} /> : null}
    </div>
  );
}

function SeriesAnalysis({ analysis, title = 'Series analysis' }) {
  const groups = [
    ['Strengths', analysis.strengths],
    ['Story risks', analysis.risks],
    ['Recommended edits', analysis.recommendations],
  ];
  return (
    <div className="rounded border border-port-accent/30 bg-port-bg p-3 space-y-3" aria-live="polite">
      <h4 className="text-sm font-semibold">{title}</h4>
      {analysis.summary ? <p className="text-sm text-port-text-muted">{analysis.summary}</p> : null}
      {groups.map(([label, items]) => items?.length ? (
        <div key={label}>
          <h5 className="text-xs font-semibold uppercase tracking-wide text-port-text-muted">{label}</h5>
          <ul className="mt-1 space-y-1 text-sm list-disc pl-5">
            {items.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      ) : null)}
    </div>
  );
}

function SeriesDeliveryPlan({ plan, episodes, onChange }) {
  const options = normalizeDeliveryOptions(plan.deliveryOptions);
  const boundaries = episodes.slice(0, -1).map((fromEpisode, index) => ({
    fromEpisode,
    toEpisode: episodes[index + 1],
  }));
  const voicemails = plan.interEpisodeVoicemails || [];
  const voicemailFor = (fromEpisodeId, toEpisodeId) => voicemails.find((item) => (
    item.fromEpisodeId === fromEpisodeId && item.toEpisodeId === toEpisodeId
  )) || null;
  const missingVoicemails = boundaries.filter(({ fromEpisode, toEpisode }) => {
    const item = voicemailFor(fromEpisode.id, toEpisode.id);
    return !item?.transcript?.trim();
  }).length;

  const toggle = (key, enabled) => onChange((current) => {
    const next = {
      ...current,
      deliveryOptions: { ...normalizeDeliveryOptions(current.deliveryOptions), [key]: enabled },
    };
    if (key === 'overnightVoicemails' && enabled) {
      next.interEpisodeVoicemails = withVoicemailDrafts(current, episodes);
    }
    if (key === 'nextSeasonTeaser' && enabled && !next.nextSeasonTeaser) {
      next.nextSeasonTeaser = { title: 'A signal beyond the corridor', transcript: '' };
    }
    return next;
  });

  const updateVoicemail = (fromEpisodeId, toEpisodeId, patch) => onChange((current) => ({
    ...current,
    interEpisodeVoicemails: (current.interEpisodeVoicemails || []).map((item) => (
      item.fromEpisodeId === fromEpisodeId && item.toEpisodeId === toEpisodeId
        ? { ...item, ...patch } : item
    )),
  }));

  return (
    <section className="rounded-lg border border-port-border bg-port-card p-4 space-y-4" aria-label="Series delivery">
      <div>
        <h3 className="font-semibold">Viewer handoffs</h3>
        <p className="text-xs text-port-text-muted mt-1">
          Optional authored beats that carry the viewer from one episode to the next and leave the season looking forward.
        </p>
      </div>

      <label className="flex items-start gap-2 text-sm" htmlFor="series-delivery-overnight-voicemails">
        <input
          id="series-delivery-overnight-voicemails"
          type="checkbox"
          checked={options.overnightVoicemails}
          onChange={(event) => toggle('overnightVoicemails', event.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium block">Overnight voicemail between episodes</span>
          <span className="text-xs text-port-text-muted">The protagonist leaves a personal handoff after each episode to motivate the next watch.</span>
        </span>
      </label>

      {options.overnightVoicemails && (
        <div className="space-y-3 pl-5 border-l-2 border-port-accent/30">
          {!boundaries.length ? (
            <p className="text-xs text-port-warning">Add a second episode to author the first overnight voicemail.</p>
          ) : boundaries.map(({ fromEpisode, toEpisode }) => {
            const item = voicemailFor(fromEpisode.id, toEpisode.id);
            return (
              <div key={episodeBoundaryKey(fromEpisode.id, toEpisode.id)} className="rounded border border-port-border p-3 space-y-3">
                <div className="text-xs font-medium text-port-text-muted">
                  Episode {fromEpisode.number} → Episode {toEpisode.number}
                </div>
                <FormField label="Voicemail title" labelClassName={labelClass}>
                  <input
                    className={fieldClass}
                    value={item?.title || ''}
                    onChange={(event) => updateVoicemail(fromEpisode.id, toEpisode.id, { title: event.target.value })}
                  />
                </FormField>
                <FormField
                  label="Voicemail transcript"
                  hint="Write what the protagonist says overnight. Voice rendering can be attached later without losing this authored text."
                  labelClassName={labelClass}
                >
                  <textarea
                    rows={4}
                    className={`${fieldClass} ${item?.transcript?.trim() ? '' : 'border-port-warning/60'}`}
                    value={item?.transcript || ''}
                    onChange={(event) => updateVoicemail(fromEpisode.id, toEpisode.id, { transcript: event.target.value })}
                    placeholder="I kept the receiver warm through the night…"
                  />
                </FormField>
              </div>
            );
          })}
          <p className={`text-xs ${missingVoicemails ? 'text-port-warning' : 'text-port-success'}`} role="status">
            {missingVoicemails
              ? `${missingVoicemails} voicemail${missingVoicemails === 1 ? '' : 's'} still needs a transcript.`
              : 'Every episode boundary has an authored voicemail.'}
          </p>
        </div>
      )}

      <label className="flex items-start gap-2 text-sm" htmlFor="series-delivery-next-season-teaser">
        <input
          id="series-delivery-next-season-teaser"
          type="checkbox"
          checked={options.nextSeasonTeaser}
          onChange={(event) => toggle('nextSeasonTeaser', event.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium block">Next-season teaser after the finale</span>
          <span className="text-xs text-port-text-muted">Leave a final image-preview/player beat that opens the next season’s question.</span>
        </span>
      </label>

      {options.nextSeasonTeaser && (
        <div className="pl-5 border-l-2 border-port-accent/30 space-y-3">
          <FormField label="Teaser title" labelClassName={labelClass}>
            <input
              className={fieldClass}
              value={plan.nextSeasonTeaser?.title || ''}
              onChange={(event) => onChange((current) => ({
                ...current,
                nextSeasonTeaser: { ...(current.nextSeasonTeaser || {}), title: event.target.value },
              }))}
            />
          </FormField>
          <FormField
            label="Teaser / cliffhanger"
            hint="This plays after the final episode ending in the one-device walkthrough."
            labelClassName={labelClass}
          >
            <textarea
              rows={4}
              className={`${fieldClass} ${plan.nextSeasonTeaser?.transcript?.trim() ? '' : 'border-port-warning/60'}`}
              value={plan.nextSeasonTeaser?.transcript || ''}
              onChange={(event) => onChange((current) => ({
                ...current,
                nextSeasonTeaser: { ...(current.nextSeasonTeaser || {}), transcript: event.target.value },
              }))}
              placeholder="Beyond the frozen relay, something answers in the protagonist’s own voice…"
            />
          </FormField>
          <p className={`text-xs ${plan.nextSeasonTeaser?.transcript?.trim() ? 'text-port-success' : 'text-port-warning'}`} role="status">
            {plan.nextSeasonTeaser?.transcript?.trim() ? 'Next-season teaser authored.' : 'Teaser transcript still needs to be authored.'}
          </p>
        </div>
      )}
    </section>
  );
}

function PlanCollection({
  title, description, items, episodes, sideQuests = false,
  onAdd, onAddChallenge, onUpdate, onRemove, onMove,
}) {
  const challenges = sideQuests ? [] : items.filter((item) => fableLoomPlotPointKind(item) === 'challenge');
  const assignedChallenges = challenges.filter((item) => item.episodeId);
  return (
    <div className="rounded-lg border border-port-border bg-port-card p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{title}</h3>
          <p className="text-xs text-port-text-muted mt-1">{description}</p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {onAddChallenge ? (
            <button type="button" onClick={onAddChallenge} className="flex items-center gap-1 rounded border border-port-accent px-2.5 py-1.5 text-xs text-port-accent hover:bg-port-accent/10">
              <Plus size={13} /> Challenge
            </button>
          ) : null}
          <button type="button" onClick={onAdd} className="flex items-center gap-1 rounded border border-port-border px-2.5 py-1.5 text-xs hover:border-port-accent">
            <Plus size={13} /> Add
          </button>
        </div>
      </div>

      {onAddChallenge && challenges.length ? (
        <p className={`text-xs ${assignedChallenges.length === challenges.length ? 'text-port-success' : 'text-port-warning'}`} role="status">
          {assignedChallenges.length}/{challenges.length} playable challenges mapped to episodes
        </p>
      ) : null}

      {!items.length ? (
        <button type="button" onClick={onAdd} className="w-full rounded border border-dashed border-port-border p-5 text-sm text-port-text-muted hover:border-port-accent hover:text-port-accent">
          Add the first {sideQuests ? 'side quest' : 'plot point'}
        </button>
      ) : items.map((item, index) => (
        <div key={item.id} className="rounded border border-port-border p-3 space-y-3">
          {!sideQuests && fableLoomPlotPointKind(item) === 'challenge' ? (
            <span className="inline-flex rounded bg-port-accent/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-port-accent">
              Playable challenge
            </span>
          ) : null}
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-port-text-muted w-6">{index + 1}.</span>
            <input
              aria-label={`${title} ${index + 1} title`}
              className={fieldClass}
              value={item.title}
              placeholder={sideQuests ? 'Side quest title' : 'Plot point title'}
              onChange={(event) => onUpdate(item.id, { title: event.target.value })}
            />
            <button type="button" aria-label={`Move ${title.toLowerCase()} ${index + 1} up`} disabled={index === 0} onClick={() => onMove(index, -1)} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-port-text-muted hover:text-port-text disabled:opacity-30"><ChevronUp size={15} /></button>
            <button type="button" aria-label={`Move ${title.toLowerCase()} ${index + 1} down`} disabled={index === items.length - 1} onClick={() => onMove(index, 1)} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-port-text-muted hover:text-port-text disabled:opacity-30"><ChevronDown size={15} /></button>
            <button type="button" aria-label={`Remove ${title.toLowerCase()} ${index + 1}`} onClick={() => onRemove(item.id)} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-port-text-muted hover:text-port-error"><Trash2 size={15} /></button>
          </div>
          <textarea
            aria-label={`${title} ${index + 1} description`}
            rows={3}
            className={fieldClass}
            value={item.description}
            placeholder="What happens, why it matters, and what it changes…"
            onChange={(event) => onUpdate(item.id, { description: event.target.value })}
          />
          {sideQuests ? (
            <div className="grid sm:grid-cols-3 gap-3">
              <PlanSelect label="Status" value={item.status} onChange={(status) => onUpdate(item.id, { status })} options={[
                { id: 'idea', label: 'Idea' }, { id: 'planned', label: 'Planned' },
                { id: 'active', label: 'Active' }, { id: 'resolved', label: 'Resolved' },
              ]} />
              <PlanSelect label="Starts" value={item.startEpisodeId || ''} onChange={(value) => onUpdate(item.id, { startEpisodeId: value || null })} options={episodes} emptyLabel="Unassigned" />
              <PlanSelect label="Ends" value={item.endEpisodeId || ''} onChange={(value) => onUpdate(item.id, { endEpisodeId: value || null })} options={episodes} emptyLabel="Unassigned" />
            </div>
          ) : (
            <PlanSelect label="Episode" value={item.episodeId || ''} onChange={(value) => onUpdate(item.id, { episodeId: value || null })} options={episodes} emptyLabel="Unassigned" />
          )}
        </div>
      ))}
    </div>
  );
}

function PlanSelect({ label, value, options, emptyLabel, onChange }) {
  return (
    <FormField label={label} labelClassName={labelClass}>
      <select className={fieldClass} value={value} onChange={(event) => onChange(event.target.value)}>
        {emptyLabel ? <option value="">{emptyLabel}</option> : null}
        {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </FormField>
  );
}

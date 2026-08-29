/**
 * Series-level FableLoom planning, intentionally separate from episode scene
 * graphs. One explicit save persists the whole ordered plan so moving a beat
 * and editing its copy cannot race as independent PATCH requests.
 */

import { useEffect, useRef, useState } from 'react';
import { BrainCircuit, ChevronDown, ChevronUp, Loader2, MessageSquareText, Plus, Save, Sparkles, Trash2 } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import toast from '../ui/Toast';
import { FormField } from '../ui/FormField.jsx';
import UnsavedChangesConfirm from '../ui/UnsavedChangesConfirm.jsx';
import ProviderModelSelector from '../ProviderModelSelector';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import useProviderModels from '../../hooks/useProviderModels';
import useUnsavedChangesGuard from '../../hooks/useUnsavedChangesGuard';
import {
  feedbackLoomSeriesPlan, generateLoomSeriesPlan, reviewLoomSeriesPlan, updateLoom,
} from '../../services/api';
import { uuidv4 } from '../../lib/uuid.js';
import { effectiveModelFor, effortAwareModelOptions } from '../../utils/providers';
import LoomEpisodeFeedback from './LoomEpisodeFeedback';
import { fieldClass, labelClass } from './fieldStyles';

const newItemId = (prefix) => `${prefix}-${uuidv4()}`;

const normalizePlan = (plan) => ({
  storyArc: plan?.storyArc || '',
  plotPoints: Array.isArray(plan?.plotPoints) ? plan.plotPoints : [],
  sideQuests: Array.isArray(plan?.sideQuests) ? plan.sideQuests : [],
});

export default function LoomSeriesPlan({ loom, onLoomUpdate }) {
  const [plan, setPlan] = useState(() => normalizePlan(loom.seriesPlan));
  const [dirty, setDirty] = useState(false);
  const revisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const loomIdRef = useRef(loom.id);
  const routeGuard = useUnsavedChangesGuard(dirty);

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
  const adoptServerPlan = (updated) => {
    revisionRef.current = 0;
    savedRevisionRef.current = 0;
    onLoomUpdate(updated);
  };

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
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Series plan</h2>
            <p className="text-sm text-port-text-muted mt-1">
              Shape the full narrative before working inside individual episode graphs.
            </p>
          </div>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="shrink-0 flex items-center gap-2 px-3 py-2 rounded bg-port-accent text-white text-sm disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {saving ? 'Saving…' : 'Save plan'}
          </button>
        </div>

        <div className="rounded-lg border border-port-border bg-port-card p-4">
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

        <PlanCollection
          title="Plot points"
          description="Order the tentpole beats and connect each one to the episode where it should land."
          items={plan.plotPoints}
          episodes={episodeOptions}
          onAdd={() => changePlan((current) => ({ ...current, plotPoints: [...current.plotPoints, {
            id: newItemId('plot'), title: '', description: '', episodeId: null,
          }] }))}
          onUpdate={(id, patch) => updateItem('plotPoints', id, patch)}
          onRemove={(id) => removeItem('plotPoints', id)}
          onMove={(index, direction) => moveItem('plotPoints', index, direction)}
        />

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

        <SeriesAiEditor loom={loom} dirty={dirty} onLoomUpdate={adoptServerPlan} />

        <WholeEpisodeEditor loom={loom} dirty={dirty} onLoomUpdate={onLoomUpdate} />
      </div>
    </section>
  );
}

function SeriesAiEditor({ loom, dirty, onLoomUpdate }) {
  const [feedback, setFeedback] = useState('');
  const [analysis, setAnalysis] = useState(null);
  const [route, setRoute] = useState({ providerId: '', model: '', effort: '' });
  const regenerateConfirm = useConfirmDelete();
  const { providers, loading } = useProviderModels({ allowDefault: true, silent: true, withEffort: true });
  const selectedProvider = providers.find((provider) => provider.id === route.providerId);
  const routeBody = {
    ...(route.providerId ? { providerId: route.providerId } : {}),
    ...(route.model ? { model: route.model } : {}),
    ...(route.effort ? { effort: route.effort } : {}),
  };

  const [runReview, reviewing] = useAsyncAction(async () => {
    const result = await reviewLoomSeriesPlan(loom.id, routeBody, { silent: true });
    setAnalysis(result.analysis);
  }, { errorMessage: 'Series analysis failed' });

  const [generatePlan, generating] = useAsyncAction(async () => {
    const result = await generateLoomSeriesPlan(loom.id, routeBody, { silent: true });
    onLoomUpdate(result.loom);
    setAnalysis(null);
    toast.success('Full series plan drafted');
  }, { errorMessage: 'Series-plan drafting failed' });

  const [applyFeedback, applying] = useAsyncAction(async () => {
    const result = await feedbackLoomSeriesPlan(loom.id, { feedback: feedback.trim(), ...routeBody }, { silent: true });
    onLoomUpdate(result.loom);
    setFeedback('');
    setAnalysis(null);
    toast.success(result.changes?.[0] || 'Series plan updated');
  }, { errorMessage: 'Series-plan feedback failed' });

  const busy = generating || reviewing || applying;
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
        <h3 className="font-semibold flex items-center gap-2"><BrainCircuit size={16} className="text-port-accent" /> AI story editor</h3>
        <p className="text-xs text-port-text-muted mt-1">
          Analyze the complete arc or describe an edit to apply across the series plan.
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
      </div>
      <FormField
        label="Editing guidance"
        hint="For example: Move the betrayal earlier, make the midpoint irreversible, and resolve the courier side quest in episode 6."
        labelClassName={labelClass}
      >
        <textarea
          rows={4}
          className={fieldClass}
          value={feedback}
          placeholder="Describe the arc, plot-point, or side-quest changes you want…"
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
      {dirty ? <p className="text-xs text-port-warning">Save the plan before running AI so it reads the edits on screen.</p> : null}
      {analysis ? <SeriesAnalysis analysis={analysis} /> : null}
    </div>
  );
}

function SeriesAnalysis({ analysis }) {
  const groups = [
    ['Strengths', analysis.strengths],
    ['Story risks', analysis.risks],
    ['Recommended edits', analysis.recommendations],
  ];
  return (
    <div className="rounded border border-port-accent/30 bg-port-bg p-3 space-y-3" aria-live="polite">
      <h4 className="text-sm font-semibold">Series analysis</h4>
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

function WholeEpisodeEditor({ loom, dirty, onLoomUpdate }) {
  const [episodeId, setEpisodeId] = useState(loom.episodes[0]?.id || '');
  useEffect(() => {
    if (!loom.episodes.some((episode) => episode.id === episodeId)) setEpisodeId(loom.episodes[0]?.id || '');
  }, [episodeId, loom.episodes]);
  const episode = loom.episodes.find((candidate) => candidate.id === episodeId);
  return (
    <div className="rounded-lg border border-port-border bg-port-card p-4 space-y-3">
      <div>
        <h3 className="font-semibold flex items-center gap-2"><MessageSquareText size={16} className="text-port-accent" /> Edit a whole episode</h3>
        <p className="text-xs text-port-text-muted mt-1">
          Apply one instruction across an episode's title, synopsis, existing scenes, and path language.
        </p>
      </div>
      {episode ? (
        <>
          <PlanSelect
            label="Episode"
            value={episodeId}
            onChange={setEpisodeId}
            options={loom.episodes.map((item) => ({ id: item.id, label: `${item.number}. ${item.title || 'Untitled'}` }))}
          />
          <LoomEpisodeFeedback
            key={episode.id}
            open
            loom={loom}
            episode={episode}
            onLoomUpdate={onLoomUpdate}
            disabled={dirty}
          />
          {dirty ? <p className="text-xs text-port-warning">Save the series plan before editing an episode with AI.</p> : null}
        </>
      ) : <p className="text-sm text-port-text-muted">Add an episode to use whole-episode AI editing.</p>}
    </div>
  );
}

function PlanCollection({ title, description, items, episodes, sideQuests = false, onAdd, onUpdate, onRemove, onMove }) {
  return (
    <div className="rounded-lg border border-port-border bg-port-card p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{title}</h3>
          <p className="text-xs text-port-text-muted mt-1">{description}</p>
        </div>
        <button type="button" onClick={onAdd} className="flex items-center gap-1 px-2.5 py-1.5 rounded border border-port-border text-xs hover:border-port-accent">
          <Plus size={13} /> Add
        </button>
      </div>

      {!items.length ? (
        <button type="button" onClick={onAdd} className="w-full rounded border border-dashed border-port-border p-5 text-sm text-port-text-muted hover:border-port-accent hover:text-port-accent">
          Add the first {sideQuests ? 'side quest' : 'plot point'}
        </button>
      ) : items.map((item, index) => (
        <div key={item.id} className="rounded border border-port-border p-3 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-port-text-muted w-6">{index + 1}.</span>
            <input
              aria-label={`${title} ${index + 1} title`}
              className={fieldClass}
              value={item.title}
              placeholder={sideQuests ? 'Side quest title' : 'Plot point title'}
              onChange={(event) => onUpdate(item.id, { title: event.target.value })}
            />
            <button type="button" aria-label={`Move ${title.toLowerCase()} ${index + 1} up`} disabled={index === 0} onClick={() => onMove(index, -1)} className="p-1 text-port-text-muted hover:text-port-text disabled:opacity-30"><ChevronUp size={15} /></button>
            <button type="button" aria-label={`Move ${title.toLowerCase()} ${index + 1} down`} disabled={index === items.length - 1} onClick={() => onMove(index, 1)} className="p-1 text-port-text-muted hover:text-port-text disabled:opacity-30"><ChevronDown size={15} /></button>
            <button type="button" aria-label={`Remove ${title.toLowerCase()} ${index + 1}`} onClick={() => onRemove(item.id)} className="p-1 text-port-text-muted hover:text-port-error"><Trash2 size={15} /></button>
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

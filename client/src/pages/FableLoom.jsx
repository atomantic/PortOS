/**
 * FableLoom index — branching narratives.
 *
 * Lists every loom (a branching-narrative story: episodes of scene graphs a
 * reader plays through by chatting intents) and creates new ones. The list
 * endpoint returns summaries (counts, not the episode graphs); the heavy
 * visual editor lives at /fableloom/:loomId/:episodeId.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Plus, Sparkles, Trash2, Waypoints } from 'lucide-react';
import ProviderModelSelector from '../components/ProviderModelSelector';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import SyncToPeerButton from '../components/sharing/SyncToPeerButton';
import { FormField } from '../components/ui/FormField.jsx';
import PageSkeleton from '../components/ui/PageSkeleton';
import Pill from '../components/ui/Pill';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import useProviderModels from '../hooks/useProviderModels';
import toast from '../components/ui/Toast';
import { timeAgo } from '../utils/formatters';
import { effectiveModelFor, effortAwareModelOptions } from '../utils/providers';
import { fieldClass, labelClass } from '../components/fableloom/fieldStyles';
import { LOOM_FORMATS, isTeleplayFormat, loomFormatLabel } from '../components/fableloom/loomFormats';
import {
  createLoom, deleteLoom, generateLoomSeriesPlan, listLooms, listPipelineSeries, listUniverses,
} from '../services/api';
import { FABLELOOM_PARTICIPATION_MODES } from '../../../server/lib/fableLoomParticipation.js';

const emptyForm = () => ({
  name: '', logline: '', premise: '', styleNotes: '', format: 'prose',
  participationMode: 'helper', audienceCommunicationMedium: '', universeId: '', seriesId: '',
});

export default function FableLoom() {
  const navigate = useNavigate();
  const [looms, setLooms] = useState(null);
  const [universes, setUniverses] = useState([]);
  const [series, setSeries] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [planRoute, setPlanRoute] = useState({ providerId: '', model: '', effort: '' });
  const { providers, loading: providersLoading } = useProviderModels({
    allowDefault: true, enabled: showForm, silent: true, withEffort: true,
  });
  const del = useConfirmDelete();

  useEffect(() => {
    listLooms().then(setLooms).catch(() => setLooms([]));
    listUniverses({ silent: true }).then(setUniverses).catch(() => {});
    listPipelineSeries({ silent: true }).then(setSeries).catch(() => {});
  }, []);

  const universeNames = useMemo(() => new Map(universes.map((u) => [u.id, u.name])), [universes]);
  const seriesNames = useMemo(() => new Map(series.map((s) => [s.id, s.name])), [series]);

  const planProvider = providers.find((provider) => provider.id === planRoute.providerId);
  const planRouteBody = {
    ...(planRoute.providerId ? { providerId: planRoute.providerId } : {}),
    ...(planRoute.model ? { model: planRoute.model } : {}),
    ...(planRoute.effort ? { effort: planRoute.effort } : {}),
  };

  const [runCreate, creating] = useAsyncAction(async (draftPlan = false) => {
    const loom = await createLoom({
      name: form.name.trim(),
      logline: form.logline,
      premise: form.premise,
      styleNotes: form.styleNotes,
      format: form.format,
      participationMode: form.participationMode,
      audienceCommunicationMedium: form.participationMode === 'helper' ? form.audienceCommunicationMedium.trim() : '',
      universeId: form.universeId || null,
      seriesId: form.seriesId || null,
    }, { silent: true });
    if (draftPlan) {
      const generated = await generateLoomSeriesPlan(loom.id, planRouteBody, { silent: true })
        .catch((error) => {
          toast.error(`Loom created, but plan drafting failed: ${error.message}`);
          return null;
        });
      if (generated) toast.success('Loom created with a full series-plan draft');
    }
    navigate(`/fableloom/${loom.id}/plan`);
  }, { errorMessage: 'Could not create the loom' });

  const handleCreate = (event) => {
    event.preventDefault();
    if (!form.name.trim() || creating) return;
    runCreate(event.nativeEvent.submitter?.value === 'draft');
  };

  const handleDelete = async (id) => {
    const ok = await deleteLoom(id).then(() => true).catch(() => false);
    if (ok) setLooms((prev) => prev.filter((l) => l.id !== id));
    del.cancelDelete();
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Waypoints size={20} className="text-port-accent" /> FableLoom
          </h1>
          <p className="text-sm text-port-text-muted mt-1">
            Branching narratives readers play through by chatting their intents — every episode is a
            graph of scenes with multiple endings.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1.5 px-3 py-2 rounded bg-port-accent text-white text-sm"
        >
          <Plus size={15} /> New loom
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <FormField label="Name" labelClassName={labelClass}>
              <input
                className={fieldClass}
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="e.g. The Hollow Crown"
                required
              />
            </FormField>
            <FormField label="Logline" labelClassName={labelClass}>
              <input
                className={fieldClass}
                value={form.logline}
                onChange={(e) => setForm((p) => ({ ...p, logline: e.target.value }))}
                placeholder="One sentence of premise"
              />
            </FormField>
            <FormField label="Scene format" labelClassName={labelClass}>
              <select
                className={fieldClass}
                value={form.format}
                onChange={(e) => setForm((p) => ({ ...p, format: e.target.value }))}
              >
                {LOOM_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </FormField>
            <FormField label="Audience role" labelClassName={labelClass}>
              <select
                className={fieldClass}
                value={form.participationMode}
                onChange={(e) => setForm((p) => ({ ...p, participationMode: e.target.value }))}
              >
                {FABLELOOM_PARTICIPATION_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode === 'helper' ? 'Audience helps the protagonist' : 'Audience acts as the protagonist'}
                  </option>
                ))}
              </select>
            </FormField>
            {form.participationMode === 'helper' && (
              <FormField label="Audience communication medium" labelClassName={labelClass}>
                <textarea
                  rows={2}
                  className={fieldClass}
                  value={form.audienceCommunicationMedium}
                  onChange={(e) => setForm((p) => ({ ...p, audienceCommunicationMedium: e.target.value }))}
                  placeholder="e.g. a cracked field radio the protagonist activates in the opening"
                  required
                />
              </FormField>
            )}
            <FormField label="Universe (canon + style for AI)" labelClassName={labelClass}>
              <select
                className={fieldClass}
                value={form.universeId}
                onChange={(e) => setForm((p) => ({ ...p, universeId: e.target.value }))}
              >
                <option value="">No universe</option>
                {universes.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </FormField>
            <FormField label="Part of series (optional)" labelClassName={labelClass}>
              <select
                className={fieldClass}
                value={form.seriesId}
                onChange={(e) => setForm((p) => ({ ...p, seriesId: e.target.value }))}
              >
                <option value="">Standalone</option>
                {series.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </FormField>
          </div>
          <FormField label="Premise" labelClassName={labelClass}>
            <textarea
              rows={3}
              className={fieldClass}
              value={form.premise}
              onChange={(e) => setForm((p) => ({ ...p, premise: e.target.value }))}
              placeholder="The setup, stakes, and tone the AI should weave from"
            />
          </FormField>
          <FormField label="Image style notes (appended to every scene render prompt)" labelClassName={labelClass}>
            <textarea
              rows={2}
              className={fieldClass}
              value={form.styleNotes}
              onChange={(e) => setForm((p) => ({ ...p, styleNotes: e.target.value }))}
              placeholder="e.g. painterly, muted palette, storybook illustration"
            />
          </FormField>
          <section className="border-t border-port-border pt-3 space-y-2">
            <div>
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                <Sparkles size={14} className="text-port-accent" /> AI series-plan draft
              </h3>
              <p className="text-xs text-port-text-muted mt-1">
                Optionally draft the complete arc, ordered plot points, and side quests from
                these story details and the linked universe canon.
              </p>
            </div>
            <ProviderModelSelector
              providers={providers}
              selectedProviderId={planRoute.providerId}
              selectedModel={planRoute.model}
              availableModels={effortAwareModelOptions(planProvider, planRoute.model)}
              onProviderChange={(providerId) => setPlanRoute({ providerId, model: '', effort: '' })}
              onModelChange={(model) => setPlanRoute((current) => ({ ...current, model }))}
              effort={planRoute.effort}
              onEffortChange={(effort) => setPlanRoute((current) => ({ ...current, effort }))}
              label="Plan AI provider"
              disabled={creating || providersLoading}
              modelDisabled={creating || providersLoading}
              loading={providersLoading}
              emptyProviderOption="Default (series-plan stage or active provider)"
              emptyModelOption="Default model"
              alwaysShowModel={!!planRoute.providerId}
            />
            {planProvider ? (
              <p className="text-xs text-port-text-muted">
                The draft will use {planProvider.name}{effectiveModelFor(planProvider, planRoute.model) ? ` (${effectiveModelFor(planProvider, planRoute.model)})` : ''}.
              </p>
            ) : null}
          </section>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button
              type="submit"
              value="empty"
              disabled={creating || !form.name.trim() || (form.participationMode === 'helper' && !form.audienceCommunicationMedium.trim())}
              className="px-4 py-2 rounded border border-port-border text-sm hover:border-port-accent disabled:opacity-50"
            >
              {creating ? 'Creating…' : 'Create loom'}
            </button>
            <button
              type="submit"
              value="draft"
              disabled={creating || providersLoading || !form.name.trim() || (form.participationMode === 'helper' && !form.audienceCommunicationMedium.trim())}
              className="flex items-center justify-center gap-1.5 px-4 py-2 rounded bg-port-accent text-white text-sm disabled:opacity-50"
            >
              <Sparkles size={14} /> {creating ? 'Creating…' : 'Create & draft plan'}
            </button>
          </div>
        </form>
      )}

      {looms === null ? (
        <PageSkeleton header="none" label="Loading branching narratives" cards={4} sidebar={false} layout="grid" />
      ) : looms.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-port-border rounded-lg">
          <Waypoints size={32} className="mx-auto text-port-text-muted mb-3" />
          <p className="text-sm text-port-text-muted">
            No branching narratives yet. Create a loom, shape its series plan, then weave its episodes.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {looms.map((loom) => (
            <div
              key={loom.id}
              className="bg-port-card border border-port-border rounded-lg p-4 hover:border-port-accent transition-colors cursor-pointer"
              role="link"
              tabIndex={0}
              onClick={() => navigate(`/fableloom/${loom.id}`)}
              onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/fableloom/${loom.id}`); }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="font-medium truncate">{loom.name}</h2>
                  {loom.logline && <p className="text-xs text-port-text-muted mt-0.5 line-clamp-2">{loom.logline}</p>}
                </div>
                <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="none">
                  <div className="flex items-center gap-1">
                    <SyncToPeerButton recordKind="fableLoom" recordId={loom.id} compact />
                    {del.isConfirming(loom.id) ? (
                      <ConfirmButtonPair
                        prompt="Delete?"
                        onConfirm={() => handleDelete(loom.id)}
                        onCancel={del.cancelDelete}
                      />
                    ) : (
                      <button
                        type="button"
                        aria-label={`Delete ${loom.name}`}
                        onClick={() => del.requestDelete(loom.id)}
                        className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-port-text-muted hover:text-port-error p-1"
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3 mt-3 text-xs text-port-text-muted flex-wrap">
                <span>{loom.episodeCount} episode{loom.episodeCount === 1 ? '' : 's'}</span>
                <span>{loom.sceneCount} scene{loom.sceneCount === 1 ? '' : 's'}</span>
                <span>{loom.endingCount} ending{loom.endingCount === 1 ? '' : 's'}</span>
                {universeNames.has(loom.universeId) && (
                  <Pill tone="accent" bordered={false}>{universeNames.get(loom.universeId)}</Pill>
                )}
                {seriesNames.has(loom.seriesId) && (
                  <Pill tone="muted">{seriesNames.get(loom.seriesId)}</Pill>
                )}
                {loom.participationMode === 'helper' && <Pill tone="accent" bordered={false}>Audience helper</Pill>}
                {isTeleplayFormat(loom.format) && <Pill tone="muted">{loomFormatLabel(loom.format)}</Pill>}
                <span className="ml-auto">{timeAgo(loom.updatedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

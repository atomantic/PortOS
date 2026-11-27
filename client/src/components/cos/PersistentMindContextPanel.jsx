import { useState } from 'react';
import { Brain, Eye, RefreshCw, Save } from 'lucide-react';
import {
  updateCosConfig,
  getPersistentMindReflection,
} from '../../services/apiAgents.js';
import BrailleSpinner from '../BrailleSpinner';
import Banner from '../ui/Banner';
import PersistentMindMaintainerControls from './PersistentMindMaintainerControls';
import PersistentMindContextBreakdown from './PersistentMindContextBreakdown';
import { Link } from 'react-router';
import { useSocketResource } from '../../hooks/useSocketResource';
import { formatCount, formatDateTime } from '../../utils/formatters';

const promptDraft = (data) => ({
  schemaVersion: data?.prompt?.schemaVersion || 1,
  identity: data?.prompt?.identity || '',
  instructions: data?.prompt?.instructions || '',
});

const playbookDraft = (data) => ({
  schemaVersion: data?.playbook?.schemaVersion || 1,
  mode: data?.playbook?.mode || 'default',
  customInstructions: data?.playbook?.customInstructions || '',
});

const harnessTone = (recommendation) => recommendation === 'recommended'
  ? 'success'
  : recommendation === 'unavailable' ? 'error' : 'info';

export default function PersistentMindContextPanel({ context }) {
  const { data, loading, error, refetch, updateData } = context;
  const [promptEdit, setPromptEdit] = useState(null);
  const [playbookEdit, setPlaybookEdit] = useState(null);
  const [savingPlaybook, setSavingPlaybook] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const draft = promptEdit ?? promptDraft(data);
  const playbook = playbookEdit ?? playbookDraft(data);

  const savePlaybook = async () => {
    if (savingPlaybook) return;
    setSavingPlaybook(true);
    setSaveError(null);
    await updateCosConfig({ persistentMindPlaybook: playbook }, { silent: true })
      .then(async (saved) => {
        if (saved?.persistentMindPlaybook) {
          updateData((current) => current && { ...current, playbook: saved.persistentMindPlaybook });
        }
        await refetch();
        setPlaybookEdit((current) => current === playbookEdit ? null : current);
      })
      .catch((nextError) => setSaveError(nextError?.message || 'Could not save the playbook'))
      .finally(() => setSavingPlaybook(false));
  };

  const savePrompt = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    await updateCosConfig({ persistentMindPrompt: draft }, { silent: true })
      .then(async (saved) => {
        if (saved?.persistentMindPrompt) {
          updateData((current) => current && { ...current, prompt: saved.persistentMindPrompt });
        }
        await refetch();
        setPromptEdit((current) => current === promptEdit ? null : current);
      })
      .catch((nextError) => setSaveError(nextError?.message || 'Could not save the prompt'))
      .finally(() => setSaving(false));
  };

  if (loading && !data) return <div className="flex justify-center p-10"><BrailleSpinner text="Loading mind context" /></div>;

  return (
    <div className="space-y-4">
      {error && <Banner tone="error" title="Context unavailable">{error.message}</Banner>}
      {saveError && <Banner tone="error" title="Context changes could not be saved">{saveError}</Banner>}

      <PersistentMindMaintainerControls />

      <MemoryReflection />

      <section className="rounded border border-port-border bg-port-card p-4" aria-labelledby="mind-architecture-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 id="mind-architecture-heading" className="flex items-center gap-2 text-sm font-semibold text-port-text">
              <Brain size={17} aria-hidden="true" /> How one wake works
            </h3>
            <p className="mt-1 text-xs text-port-text-muted">Every visible result is appended to the machine-local trajectory; the next wake receives a bounded projection of that same record.</p>
          </div>
          <button type="button" onClick={refetch} disabled={loading} className="flex items-center gap-2 rounded border border-port-border px-3 py-1.5 text-xs text-port-text disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" /> Refresh
          </button>
        </div>
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-4">
          {[
            ['1 · Observe', 'Messages, annotations, and scheduled self-wakes enter one FIFO stream.'],
            ['2 · Assemble', 'Identity, instructions, curated memories, rollups, and recent events fill a bounded context.'],
            ['3 · Think', 'The exact pinned provider returns a visible working note, reply, durable memories, and optional follow-up.'],
            ['4 · Persist', 'The append-only trajectory becomes the source for chat, inspection, replay, and later context.'],
          ].map(([title, body]) => (
            <div key={title} className="rounded border border-port-border bg-port-bg/40 p-3">
              <p className="font-semibold text-port-text">{title}</p>
              <p className="mt-1 text-port-text-muted">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {data?.harness && (
        <Banner tone={harnessTone(data.harness.recommendation)} title={`${data.harness.label} · ${data.harness.recommendation}`}>
          {data.harness.detail}
        </Banner>
      )}


      <section className="rounded border border-port-border bg-port-card p-4" aria-labelledby="mind-playbook-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 id="mind-playbook-heading" className="text-sm font-semibold text-port-text">Operating playbook</h3>
            <p className="mt-1 text-xs text-port-text-muted">First-class mind modes. Continuous play licenses explore → interact → reflect → invent each wake. Saving never starts inference.</p>
          </div>
          <button type="button" onClick={savePlaybook} disabled={savingPlaybook || !data} className="flex items-center gap-2 rounded bg-port-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
            <Save size={14} aria-hidden="true" /> {savingPlaybook ? 'Saving…' : 'Save playbook'}
          </button>
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <label className="text-xs font-medium text-port-text" htmlFor="persistent-mind-playbook-mode">
            Mode
            <select
              id="persistent-mind-playbook-mode"
              value={playbook.mode}
              onChange={(event) => setPlaybookEdit({ ...playbook, mode: event.target.value })}
              className="mt-1 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm font-normal text-port-text"
            >
              {(data?.playbookCatalog || [
                { id: 'default', label: 'Default' },
                { id: 'continuous-play', label: 'Continuous play / explore & invent' },
              ]).map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.label}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-port-text" htmlFor="persistent-mind-playbook-custom">
            Extra playbook notes
            <textarea
              id="persistent-mind-playbook-custom"
              rows={4}
              maxLength={6000}
              value={playbook.customInstructions}
              onChange={(event) => setPlaybookEdit({ ...playbook, customInstructions: event.target.value })}
              className="mt-1 w-full resize-y rounded border border-port-border bg-port-bg px-3 py-2 text-sm font-normal text-port-text"
            />
          </label>
        </div>
      </section>

      <section className="rounded border border-port-border bg-port-card p-4" aria-labelledby="mind-prompt-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 id="mind-prompt-heading" className="text-sm font-semibold text-port-text">Identity and operating prompt</h3>
            <p className="mt-1 text-xs text-port-text-muted">These are injected verbatim on every wake. Saving changes context only; it never starts inference.</p>
          </div>
          <button type="button" onClick={savePrompt} disabled={saving || !data} className="flex items-center gap-2 rounded bg-port-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
            <Save size={14} aria-hidden="true" /> {saving ? 'Saving…' : 'Save prompt'}
          </button>
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <label className="text-xs font-medium text-port-text" htmlFor="persistent-mind-identity">
            Identity
            <textarea id="persistent-mind-identity" rows={7} maxLength={4000} value={draft.identity} onChange={(event) => setPromptEdit({ ...draft, identity: event.target.value })} className="mt-1 w-full resize-y rounded border border-port-border bg-port-bg px-3 py-2 text-sm font-normal text-port-text" />
          </label>
          <label className="text-xs font-medium text-port-text" htmlFor="persistent-mind-instructions">
            Operating instructions
            <textarea id="persistent-mind-instructions" rows={7} maxLength={12000} value={draft.instructions} onChange={(event) => setPromptEdit({ ...draft, instructions: event.target.value })} className="mt-1 w-full resize-y rounded border border-port-border bg-port-bg px-3 py-2 text-sm font-normal text-port-text" />
          </label>
        </div>
      </section>

      <PersistentMindContextBreakdown breakdown={data?.breakdown} />

      {data?.preview && <ContinuationNote note={data.preview.continuationNote} />}

      <section className="rounded border border-port-border bg-port-card p-4" aria-labelledby="mind-preview-heading">
        <h3 id="mind-preview-heading" className="flex items-center gap-2 text-sm font-semibold text-port-text"><Eye size={16} aria-hidden="true" /> Effective context preview</h3>
        <p className="mt-1 text-xs text-port-text-muted">
          This is the actual bounded text projection used on the next wake: {formatCount(data?.preview?.chars)} characters, about {formatCount(data?.preview?.approximateTokens)} tokens, summary cache {data?.preview?.summaryState || 'unknown'}.
        </p>
        <pre className="mt-3 max-h-[34rem] overflow-auto whitespace-pre-wrap break-words rounded border border-port-border bg-port-bg p-3 text-xs text-port-text">{data?.preview?.text || 'No context available.'}</pre>
        <details className="mt-3 rounded border border-port-border p-3">
          <summary className="cursor-pointer text-xs font-semibold text-port-text">Derived rollups ({data?.rollups?.length || 0})</summary>
          <p className="mt-2 text-xs text-port-text-muted">Rollups are read-only cached projections with provider/model provenance. Edit the source conversation or curated memories, not derived history.</p>
          <div className="mt-2 space-y-2">
            {(data?.rollups || []).map((rollup) => (
              <div key={rollup.id} className="rounded bg-port-bg/50 p-2 text-xs">
                <p className="font-mono text-port-text-muted">events {rollup.source.fromSequence}–{rollup.source.toSequence} · {rollup.provenance.providerId || 'unknown'}/{rollup.provenance.model || 'default'} · prompt v{rollup.provenance.promptVersion}</p>
                <p className="mt-1 whitespace-pre-wrap text-port-text">{rollup.summary || rollup.error || rollup.status}</p>
              </div>
            ))}
          </div>
        </details>
      </section>
    </div>
  );
}

function ContinuationNote({ note }) {
  const provenance = note?.provenance;
  const hasNote = typeof note?.content === 'string';
  return (
    <section className="rounded border border-port-border bg-port-card p-4" aria-labelledby="mind-continuation-heading">
      <h3 id="mind-continuation-heading" className="text-sm font-semibold text-port-text">Continuation note</h3>
      <p className="mt-1 text-xs text-port-text-muted">The mind's own note to its next wake, kept word for word across compaction and provider changes. Only the mind can change it; earlier wording stays in the memory's history.</p>
      {!hasNote && <p className="mt-2 text-xs text-port-text-muted">The mind has not left a continuation note.</p>}
      {hasNote && <div className="mt-3 space-y-2 text-xs text-port-text">
        <p className="text-port-text-muted">
          {provenance
            ? `Written by the mind · ${provenance.providerId || 'unknown'} / ${provenance.model || 'default'} · ${formatDateTime(provenance.at)} · turn ${provenance.turnId || 'unknown'}`
            : `Author unknown: no retained runtime event attests this wording · last changed ${note.updatedAt ? formatDateTime(note.updatedAt) : 'at an unknown time'}`}
          {` · version ${note.version}`}
        </p>
        {note.state === 'omitted-budget' && <Banner tone="warning" title="Omitted from this context">The note does not fit this context budget, so the wake is told it was omitted instead of receiving part of it. The stored note is unchanged.</Banner>}
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-port-border p-3">{note.content}</pre>
        <Link className="inline-block text-port-accent underline" to={`/cos/memory/${encodeURIComponent(note.memoryId)}`}>Memory and version history</Link>
      </div>}
    </section>
  );
}

const REFLECTION_EVENTS = ['cos:memory:created', 'cos:memory:updated', 'cos:memory:deleted', 'cos:config:changed', 'cos:mind:event'];

function MemoryReflection() {
  const { data, loading, error, refetch } = useSocketResource(async ({ signal }) => {
    return getPersistentMindReflection({ signal, silent: true });
  }, {
    namespace: 'cos',
    events: REFLECTION_EVENTS,
    matchesEvent: (payload, event) => event !== 'cos:mind:event' || Boolean(payload?.data?.memoryReview?.memoryId),
  });
  const sources = [data?.source, data?.inspected].filter((source, index, all) => source && all.findIndex(item => item?.id === source.id) === index);
  return (
    <section className="rounded border border-port-border bg-port-card p-4" aria-labelledby="mind-reflection-heading">
      <h3 id="mind-reflection-heading" className="text-sm font-semibold text-port-text">Memory reflection</h3>
      <p className="mt-1 text-xs text-port-text-muted">An optional invitation during an authorized wake. Only the mind can review or retire this source here; ignoring it changes nothing.</p>
      {loading && !data ? <BrailleSpinner text="Loading reflection" /> : null}
      {(error || data?.state === 'unavailable') && <Banner tone="error" title="Reflection unavailable">The memory store could not be inspected. <button type="button" onClick={refetch} className="rounded border border-port-border px-3 py-1.5">Retry</button></Banner>}
      {data?.state === 'disabled' && <p className="mt-2 text-xs text-port-text-muted">Memory management is not granted.</p>}
      {data?.state === 'empty' && sources.length === 0 && <p className="mt-2 text-xs text-port-text-muted">No eligible memory awaiting reflection.</p>}
      {sources.map(source => {
        const review = source.lastReview?.outcomes?.[source.lastReview.latestVerdict];
        const currentReview = review?.expectedVersion === (source.version ?? 1);
        return <div key={source.id} className="mt-3 space-y-2 text-xs text-port-text">
        <p>{currentReview ? `Settled · ${review.verdict}` : source.status === 'active' && source.protection === 'standard' ? 'Pending · optional' : 'Source changed · no longer eligible'} · version {source.version ?? 1}</p>
        <Link className="text-port-accent underline" to={`/cos/memory/${encodeURIComponent(source.id)}`}>Source memory</Link>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-port-border p-3">{source.content}</pre>
        {review && <div className="space-y-2">
          <p className="text-port-text-muted">{review.providerId} / {review.model} · {formatDateTime(review.reviewedAt)} · turn {review.turnId || 'unknown'}{!currentReview ? ' · previous source version' : ''}</p>
          {review.rationale && <p className="whitespace-pre-wrap break-words">{review.rationale}</p>}
          {review.lessonId && <Link className="inline-block text-port-accent underline" to={`/cos/memory/${encodeURIComponent(review.lessonId)}`}>Linked lesson</Link>}
          {review.lesson && <p className="whitespace-pre-wrap break-words">{review.lesson}</p>}
        </div>}
      </div>;
      })}
    </section>
  );
}

import { useCallback, useEffect, useId, useState } from 'react';
import { Brain, Database, Eye, Plus, RefreshCw, Save } from 'lucide-react';
import * as api from '../../services/api';
import BrailleSpinner from '../BrailleSpinner';
import Banner from '../ui/Banner';

const EMPTY_MEMORY = {
  content: '', summary: '', type: 'observation', category: 'other', tags: [], importance: 0.5,
};

const promptDraft = (data) => ({
  schemaVersion: data?.prompt?.schemaVersion || 1,
  identity: data?.prompt?.identity || '',
  instructions: data?.prompt?.instructions || '',
});

const harnessTone = (recommendation) => recommendation === 'recommended'
  ? 'success'
  : recommendation === 'not-recommended' ? 'warning' : 'info';

export default function PersistentMindContextPanel() {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(() => promptDraft(null));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    return api.getPersistentMindContext({ silent: true })
      .then((next) => {
        setData(next);
        setDraft(promptDraft(next));
      })
      .catch((nextError) => setError(nextError?.message || 'Could not load the mind context'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { void load(); }, [load]);

  const savePrompt = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    await api.updateCosConfig({ persistentMindPrompt: draft }, { silent: true })
      .then(() => load())
      .catch((nextError) => setError(nextError?.message || 'Could not save the prompt'))
      .finally(() => setSaving(false));
  };

  if (loading && !data) return <div className="flex justify-center p-10"><BrailleSpinner text="Loading mind context" /></div>;

  return (
    <div className="space-y-4">
      {error && <Banner tone="error" title="Context unavailable">{error}</Banner>}

      <section className="rounded border border-port-border bg-port-card p-4" aria-labelledby="mind-architecture-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 id="mind-architecture-heading" className="flex items-center gap-2 text-sm font-semibold text-port-text">
              <Brain size={17} aria-hidden="true" /> How one wake works
            </h3>
            <p className="mt-1 text-xs text-port-text-muted">Every visible result is appended to the machine-local trajectory; the next wake receives a bounded projection of that same record.</p>
          </div>
          <button type="button" onClick={() => load()} disabled={loading} className="flex items-center gap-2 rounded border border-port-border px-3 py-1.5 text-xs text-port-text disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" /> Refresh
          </button>
        </div>
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-4">
          {[
            ['1 · Observe', 'Messages, annotations, and scheduled self-wakes enter one FIFO stream.'],
            ['2 · Assemble', 'Identity, instructions, curated memories, rollups, and recent events fill a bounded context.'],
            ['3 · Think', 'The exact pinned provider returns a visible working note, reply, memory proposals, and optional follow-up.'],
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
            <textarea id="persistent-mind-identity" rows={7} maxLength={4000} value={draft.identity} onChange={(event) => setDraft((current) => ({ ...current, identity: event.target.value }))} className="mt-1 w-full resize-y rounded border border-port-border bg-port-bg px-3 py-2 text-sm font-normal text-port-text" />
          </label>
          <label className="text-xs font-medium text-port-text" htmlFor="persistent-mind-instructions">
            Operating instructions
            <textarea id="persistent-mind-instructions" rows={7} maxLength={12000} value={draft.instructions} onChange={(event) => setDraft((current) => ({ ...current, instructions: event.target.value }))} className="mt-1 w-full resize-y rounded border border-port-border bg-port-bg px-3 py-2 text-sm font-normal text-port-text" />
          </label>
        </div>
      </section>

      <section className="rounded border border-port-border bg-port-card p-4" aria-labelledby="mind-memory-heading">
        <div>
          <h3 id="mind-memory-heading" className="flex items-center gap-2 text-sm font-semibold text-port-text"><Database size={16} aria-hidden="true" /> Curated memories</h3>
          <p className="mt-1 text-xs text-port-text-muted">Only memories explicitly promoted or added here enter the mind context. Model proposals stay in the conversation until you promote them.</p>
        </div>
        <MemoryCreator onCreated={load} />
        <div className="mt-3 space-y-2">
          {(data?.memories || []).length === 0 ? (
            <p className="rounded border border-dashed border-port-border p-4 text-center text-xs text-port-text-muted">No curated memories yet.</p>
          ) : (data.memories || []).map((memory) => <MemoryEditor key={memory.id} memory={memory} onSaved={load} />)}
        </div>
      </section>

      <section className="rounded border border-port-border bg-port-card p-4" aria-labelledby="mind-preview-heading">
        <h3 id="mind-preview-heading" className="flex items-center gap-2 text-sm font-semibold text-port-text"><Eye size={16} aria-hidden="true" /> Effective context preview</h3>
        <p className="mt-1 text-xs text-port-text-muted">
          This is the actual bounded text projection used on the next wake: {data?.preview?.chars || 0} characters, about {data?.preview?.approximateTokens || 0} tokens, summary cache {data?.preview?.summaryState || 'unknown'}.
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

function MemoryCreator({ onCreated }) {
  const id = useId();
  const [draft, setDraft] = useState(EMPTY_MEMORY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const create = async (event) => {
    event.preventDefault();
    if (!draft.content.trim() || saving) return;
    setSaving(true);
    setError(null);
    await api.createPersistentMindMemory({
      ...draft,
      content: draft.content.trim(),
      summary: draft.summary.trim() || undefined,
    }, { silent: true })
      .then(() => {
        setDraft({ ...EMPTY_MEMORY });
        return onCreated();
      })
      .catch((nextError) => setError(nextError?.message || 'Could not add the memory'))
      .finally(() => setSaving(false));
  };
  return (
    <form onSubmit={create} className="mt-3 rounded border border-port-border bg-port-bg/30 p-3">
      <label htmlFor={`${id}-content`} className="text-xs font-medium text-port-text">Add a durable memory</label>
      <div className="mt-1 flex flex-col gap-2 sm:flex-row">
        <input id={`${id}-content`} value={draft.content} maxLength={10240} onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} placeholder="A stable fact, preference, decision, or context…" className="min-w-0 flex-1 rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-port-text" />
        <button type="submit" disabled={saving || !draft.content.trim()} className="flex items-center justify-center gap-2 rounded border border-port-accent px-3 py-2 text-xs font-medium text-port-accent disabled:opacity-50"><Plus size={14} aria-hidden="true" /> {saving ? 'Adding…' : 'Add memory'}</button>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-port-error">{error}</p>}
    </form>
  );
}

function MemoryEditor({ memory, onSaved }) {
  const id = useId();
  const [draft, setDraft] = useState({
    content: memory.content || '',
    summary: memory.summary || '',
    type: memory.type || 'observation',
    category: memory.category || 'other',
    tags: (memory.tags || []).join(', '),
    importance: memory.importance ?? 0.5,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    await api.updatePersistentMindMemory(memory.id, {
      ...draft,
      summary: draft.summary.trim(),
      tags: draft.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      importance: Number(draft.importance),
    }, { silent: true })
      .then(() => onSaved())
      .catch((nextError) => setError(nextError?.message || 'Could not save the memory'))
      .finally(() => setSaving(false));
  };
  return (
    <details className="rounded border border-port-border p-3">
      <summary className="cursor-pointer text-sm text-port-text"><span className="font-medium">{memory.summary || memory.content}</span> <span className="text-xs text-port-text-muted">· {memory.type}/{memory.category}</span></summary>
      <form onSubmit={save} className="mt-3 grid gap-3">
        <label htmlFor={`${id}-content`} className="text-xs font-medium text-port-text">Content<textarea id={`${id}-content`} rows={4} required maxLength={10240} value={draft.content} onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} className="mt-1 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm font-normal text-port-text" /></label>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label htmlFor={`${id}-summary`} className="text-xs font-medium text-port-text">Summary<input id={`${id}-summary`} maxLength={500} value={draft.summary} onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))} className="mt-1 w-full rounded border border-port-border bg-port-bg px-2 py-1.5 font-normal" /></label>
          <label htmlFor={`${id}-type`} className="text-xs font-medium text-port-text">Type<select id={`${id}-type`} value={draft.type} onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value }))} className="mt-1 w-full rounded border border-port-border bg-port-bg px-2 py-1.5 font-normal">{['fact', 'learning', 'observation', 'decision', 'preference', 'context'].map((type) => <option key={type}>{type}</option>)}</select></label>
          <label htmlFor={`${id}-category`} className="text-xs font-medium text-port-text">Category<input id={`${id}-category`} maxLength={100} value={draft.category} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))} className="mt-1 w-full rounded border border-port-border bg-port-bg px-2 py-1.5 font-normal" /></label>
          <label htmlFor={`${id}-importance`} className="text-xs font-medium text-port-text">Importance<input id={`${id}-importance`} type="number" min="0" max="1" step="0.1" value={draft.importance} onChange={(event) => setDraft((current) => ({ ...current, importance: event.target.value }))} className="mt-1 w-full rounded border border-port-border bg-port-bg px-2 py-1.5 font-normal" /></label>
        </div>
        <label htmlFor={`${id}-tags`} className="text-xs font-medium text-port-text">Tags, comma-separated<input id={`${id}-tags`} value={draft.tags} onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))} className="mt-1 w-full rounded border border-port-border bg-port-bg px-2 py-1.5 font-normal" /></label>
        {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
        <div className="flex justify-end"><button type="submit" disabled={saving || !draft.content.trim()} className="flex items-center gap-2 rounded bg-port-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"><Save size={14} aria-hidden="true" /> {saving ? 'Saving…' : 'Save memory'}</button></div>
      </form>
    </details>
  );
}

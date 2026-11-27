import { useId, useState } from 'react';
import { Database, Plus, Save } from 'lucide-react';
import { normalizeMemoryType } from '../../lib/legacyMemoryType';
import { createPersistentMindMemory, updatePersistentMindMemory } from '../../services/apiAgents.js';
import BrailleSpinner from '../BrailleSpinner';
import Banner from '../ui/Banner';

const EMPTY_MEMORY = {
  content: '', summary: '', type: 'observation', category: 'other', tags: [], importance: 0.5, protection: 'standard',
};

export default function PersistentMindCuratedMemories({ context }) {
  const { data, loading, error, refetch, updateData } = context;
  const memories = data?.memories ?? [];
  const saveMemory = async (memory) => {
    if (memory) {
      updateData((current) => current && {
        ...current,
        memories: current.memories.map((entry) => {
          const newer = entry.version > memory.version || entry.updatedAt > memory.updatedAt;
          return entry.id === memory.id && !newer ? memory : entry;
        }),
      });
    }
    await refetch();
  };
  if (loading && !data) return <div className="flex justify-center p-10"><BrailleSpinner text="Loading curated memories" /></div>;
  return (
    <div className="space-y-4">
      {error && <Banner tone="error" title="Curated memories unavailable">
        {error.message} <button type="button" onClick={refetch} className="rounded border border-port-border px-3 py-1.5">Retry</button>
      </Banner>}
      {data && (
        <section className="rounded border border-port-border bg-port-card p-4" aria-labelledby="mind-memory-heading">
          <div>
            <h3 id="mind-memory-heading" className="flex items-center gap-2 text-sm font-semibold text-port-text"><Database size={16} aria-hidden="true" /> Curated memories</h3>
            <p className="mt-1 text-xs text-port-text-muted">Memories created by the persistent mind and memories added here enter its bounded context automatically. Core identity and important memories survive cleanup and receive priority in bounded context. Existing memories are standard until explicitly protected; an importance score alone does not protect them.</p>
          </div>
          <MemoryCreator onCreated={refetch} />
          <div className="mt-3 space-y-2">
            {memories.length === 0 ? (
              <p className="rounded border border-dashed border-port-border p-4 text-center text-xs text-port-text-muted">No curated memories yet.</p>
            ) : memories.map((memory) => <MemoryEditor key={memory.id} memory={memory} onSaved={saveMemory} />)}
          </div>
        </section>
      )}
    </div>
  );
}

function MemoryProtectionSelect({ id, value, onChange, disabled }) {
  return (
    <label htmlFor={id} className="text-xs font-medium text-port-text">
      Cleanup protection
      <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className="mt-1 block w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm font-normal text-port-text disabled:opacity-50">
        <option value="standard">Standard · eligible for cleanup</option>
        <option value="important">Important · kept during cleanup</option>
        <option value="core-identity">Core identity · kept during cleanup</option>
      </select>
    </label>
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
    await createPersistentMindMemory({
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
      <div className="mt-3"><MemoryProtectionSelect id={`${id}-protection`} value={draft.protection} disabled={saving} onChange={(protection) => setDraft((current) => ({ ...current, protection }))} /></div>
      {error && <p role="alert" className="mt-2 text-xs text-port-error">{error}</p>}
    </form>
  );
}

function MemoryEditor({ memory, onSaved }) {
  // Keep the row open while its form resets to the latest saved revision.
  const chosenName = (memory.tags || []).includes('mind:chosen-name');
  // Some stores do not version importance-only changes.
  const revision = `${memory.version || memory.updatedAt}:${memory.importance}`;
  return (
    <details className="rounded border border-port-border p-3">
      <summary className="cursor-pointer text-sm text-port-text"><span className="font-medium">{memory.summary || memory.content}</span> <span className="text-xs text-port-text-muted">· {memory.type}/{memory.category}</span>{memory.protection && memory.protection !== 'standard' && <span className="ml-2 rounded border border-port-success/40 px-2 py-0.5 text-xs text-port-success">{memory.protection === 'core-identity' ? 'Core identity' : 'Important'} · Protected</span>}</summary>
      {chosenName
        ? <p className="mt-3 text-xs text-port-text-muted">The chosen name is read-only here. The mind changes it by choosing a new name.</p>
        : <MemoryEditorForm key={revision} memory={memory} onSaved={onSaved} />}
    </details>
  );
}

function MemoryEditorForm({ memory, onSaved }) {
  const id = useId();
  const [draft, setDraft] = useState({
    content: memory.content || '',
    summary: memory.summary || '',
    type: normalizeMemoryType(memory.type),
    category: memory.category || 'other',
    tags: (memory.tags || []).filter((tag) => !tag.startsWith('mind:')).join(', '),
    importance: memory.importance ?? 0.5,
  });
  // Omit protection from ordinary edits so a newer protection applied by the
  // mind survives even when this editor still has an older context snapshot.
  const [protectionOverride, setProtectionOverride] = useState(null);
  const protection = protectionOverride ?? memory.protection ?? 'standard';
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const save = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    await updatePersistentMindMemory(memory.id, {
      ...draft,
      ...(protectionOverride !== null ? { protection: protectionOverride } : {}),
      summary: draft.summary.trim(),
      tags: draft.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      importance: Number(draft.importance),
    }, { silent: true })
      .then(({ memory: savedMemory }) => {
        setProtectionOverride(null);
        return onSaved(savedMemory);
      })
      .catch((nextError) => setError(nextError?.message || 'Could not save the memory'))
      .finally(() => setSaving(false));
  };
  return (
    <form onSubmit={save} className="mt-3 grid gap-3">
      <label htmlFor={`${id}-content`} className="text-xs font-medium text-port-text">Content<textarea id={`${id}-content`} rows={4} required maxLength={10240} value={draft.content} onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} className="mt-1 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm font-normal text-port-text" /></label>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label htmlFor={`${id}-summary`} className="text-xs font-medium text-port-text">Summary<input id={`${id}-summary`} maxLength={500} value={draft.summary} onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))} className="mt-1 w-full rounded border border-port-border bg-port-bg px-2 py-1.5 font-normal" /></label>
        <label htmlFor={`${id}-type`} className="text-xs font-medium text-port-text">Type<select id={`${id}-type`} value={draft.type} onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value }))} className="mt-1 w-full rounded border border-port-border bg-port-bg px-2 py-1.5 font-normal">{['fact', 'learning', 'observation', 'decision', 'preference', 'context'].map((type) => <option key={type}>{type}</option>)}</select></label>
        <label htmlFor={`${id}-category`} className="text-xs font-medium text-port-text">Category<input id={`${id}-category`} maxLength={100} value={draft.category} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))} className="mt-1 w-full rounded border border-port-border bg-port-bg px-2 py-1.5 font-normal" /></label>
        <label htmlFor={`${id}-importance`} className="text-xs font-medium text-port-text">Importance<input id={`${id}-importance`} type="number" min="0" max="1" step="0.1" value={draft.importance} onChange={(event) => setDraft((current) => ({ ...current, importance: event.target.value }))} className="mt-1 w-full rounded border border-port-border bg-port-bg px-2 py-1.5 font-normal" /></label>
      </div>
      <MemoryProtectionSelect id={`${id}-protection`} value={protection} disabled={saving} onChange={setProtectionOverride} />
      {memory.protection && memory.protection !== 'standard' && protection === 'standard' && <p className="text-xs text-port-warning">Saving as Standard removes protection. Future cleanup may archive this memory.</p>}
      <label htmlFor={`${id}-tags`} className="text-xs font-medium text-port-text">Tags, comma-separated<input id={`${id}-tags`} value={draft.tags} onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))} className="mt-1 w-full rounded border border-port-border bg-port-bg px-2 py-1.5 font-normal" /></label>
      {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
      <div className="flex justify-end"><button type="submit" disabled={saving || !draft.content.trim()} className="flex items-center gap-2 rounded bg-port-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"><Save size={14} aria-hidden="true" /> {saving ? 'Saving…' : 'Save memory'}</button></div>
    </form>
  );
}

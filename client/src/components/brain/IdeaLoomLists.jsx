import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, CheckCircle2, Download, Plus, RotateCcw, Save, Trash2, Upload, X } from 'lucide-react';
import * as api from '../../services/api';
import toast from '../ui/Toast';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import useUrlParams from '../../hooks/useUrlParams';

const emptyList = () => ({ title: '', prompt: '', category: '', help: '', status: 'draft', ideas: [] });

// Every outcome the server can report. Anything that is not a clean
// imported/exported/skipped result needs the user's attention, so the summary
// names all of them rather than collapsing them into a single failure count.
const PROBLEM_KEYS = ['conflicted', 'missing', 'malformed', 'unavailable', 'failed'];
const RESULT_KEYS = ['imported', 'exported', 'skipped', ...PROBLEM_KEYS];

// The list API is strict: it accepts exactly these keys and rejects record
// metadata (id, schemaVersion, timestamps, importer-owned sync state). Project
// the draft rather than spreading it, or every edit round-trips as a 400.
const toPayload = (draft) => ({
  title: (draft.title || '').trim(),
  prompt: (draft.prompt || '').trim(),
  category: (draft.category || '').trim(),
  status: draft.status === 'completed' ? 'completed' : 'draft',
  help: (draft.help || '').trim(),
  ideas: (draft.ideas || []).map((idea) => idea.trim()).filter(Boolean),
});

// Integration state never gates local editing — these are notices, not blockers.
// A null `settings` is "the fetch failed", NOT "the integration is off": reporting
// an unread configuration as disabled asserts a fact we never read.
const integrationNotice = (settings) => {
  if (!settings) return 'Could not load IdeaLoom settings. Local lists remain available.';
  if (!settings.enabled) return 'Vault sync is disabled. Local lists remain available.';
  if (!settings.obsidianVaultId) return 'No Obsidian vault is selected. Local lists remain available.';
  return null;
};

// Save gating mirrors the server schema so a missing value is named up front
// instead of surfacing as a generic validation failure.
const missingField = (draft) => {
  if (!draft?.title?.trim()) return 'A list title is required';
  if (!draft?.prompt?.trim()) return 'A list prompt is required';
  if (!draft?.category?.trim()) return 'A list category is required';
  return null;
};

// The dedicated Ideas page owns both models, but this panel intentionally only
// speaks the machine-local IdeaLoom list API. Native Brain ideas stay separate.
export default function IdeaLoomLists() {
  const [searchParams, updateParams] = useUrlParams();
  const selectedId = searchParams.get('list');
  const [lists, setLists] = useState([]);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState(null);
  const [ideaText, setIdeaText] = useState('');
  const [exchangeBusy, setExchangeBusy] = useState(false);
  const [exchangeResult, setExchangeResult] = useState(null);
  const [vaults, setVaults] = useState([]);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  const select = useCallback((id) => updateParams({ list: id }), [updateParams]);

  const load = useCallback(async () => {
    setLoading(true);
    const [nextLists, nextSettings] = await Promise.all([
      api.getIdeaLoomLists({ silent: true }),
      api.getIdeaLoomSettings({ silent: true }),
    ]).catch((error) => {
      toast.error(error.message || 'Failed to load IdeaLoom lists');
      return [[], null];
    });
    // The vault list only names existing vaults to choose between; a failure
    // here leaves the picker empty rather than blocking local list editing.
    const vaultData = await api.getNotesVaults().catch(() => ({ vaults: [] }));
    setVaults(vaultData?.vaults || []);
    setLists(Array.isArray(nextLists?.lists) ? nextLists.lists : (Array.isArray(nextLists) ? nextLists : []));
    setSettings(nextSettings?.settings || nextSettings);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const notice = integrationNotice(settings);
  const selected = useMemo(() => lists.find((list) => list.id === selectedId) || null, [lists, selectedId]);
  useEffect(() => {
    if (selected) setDraft({ ...selected, ideas: [...(selected.ideas || [])] });
  }, [selected]);

  // `overrides` lets a one-click action (completing a list) persist through the
  // same validated path instead of a second endpoint, so it can never drop the
  // edits already sitting in the draft.
  const save = async (overrides = {}) => {
    const next = { ...draft, ...overrides };
    const problem = missingField(next);
    if (problem) {
      toast.error(problem);
      return;
    }
    const body = toPayload(next);
    const result = await (next.id
      ? api.updateIdeaLoomList(next.id, body, { silent: true })
      : api.createIdeaLoomList(body, { silent: true })
    ).catch((error) => { toast.error(error.message || 'Failed to save IdeaLoom list'); return null; });
    if (!result) return;
    const saved = result.list || result;
    setLists((current) => next.id
      ? current.map((list) => list.id === saved.id ? saved : list)
      : [...current, saved]);
    setDraft({ ...saved, ideas: [...(saved.ideas || [])] });
    select(saved.id);
    toast.success(next.id ? 'List saved' : 'List created');
  };

  const remove = async (id) => {
    const result = await api.deleteIdeaLoomList(id, { silent: true }).catch((error) => {
      toast.error(error.message || 'Failed to delete IdeaLoom list');
      return false;
    });
    if (result === false) return;
    setLists((current) => current.filter((list) => list.id !== id));
    setDraft(null);
    if (selectedId === id) select(null);
    toast.success('List deleted');
  };

  const updateDraft = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const moveIdea = (index, offset) => setDraft((current) => {
    const ideas = [...current.ideas];
    const target = index + offset;
    if (target < 0 || target >= ideas.length) return current;
    [ideas[index], ideas[target]] = [ideas[target], ideas[index]];
    return { ...current, ideas };
  });
  const addIdea = () => {
    if (!ideaText.trim()) return;
    updateDraft('ideas', [...(draft?.ideas || []), ideaText.trim()]);
    setIdeaText('');
  };

  const patchSettings = async (updates) => {
    const result = await api.updateIdeaLoomSettings(updates, { silent: true }).catch((error) => {
      toast.error(error.message || 'Failed to update IdeaLoom settings');
      return null;
    });
    if (!result) return;
    setSettings(result.settings || result);
  };

  const runExchange = async (action, successMessage) => {
    setExchangeBusy(true);
    const result = await action().catch((error) => {
      toast.error(error.message || 'IdeaLoom exchange failed');
      return null;
    });
    setExchangeBusy(false);
    if (!result) return;
    const counts = result.counts || result;
    setExchangeResult(counts);
    const problems = PROBLEM_KEYS.reduce((total, key) => total + (counts[key] || 0), 0);
    if (problems) toast.error(`${successMessage} with ${problems} issue${problems === 1 ? '' : 's'}`);
    else toast.success(successMessage);
    await load();
  };

  if (loading) return <p className="py-8 text-center text-gray-500">Loading IdeaLoom lists…</p>;

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(14rem,20rem)_1fr]" aria-label="IdeaLoom lists">
      <aside className="rounded-lg border border-port-border bg-port-card p-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div><h2 className="font-medium text-white">IdeaLoom lists</h2><p className="text-xs text-gray-500">Separate from native Brain ideas</p></div>
          <button type="button" onClick={() => { setDraft(emptyList()); select(null); }} className="min-h-[44px] rounded px-3 text-sm text-port-accent hover:bg-port-accent/10" aria-label="Create IdeaLoom list"><Plus size={16} /></button>
        </div>
        {settings && <div className="mb-3 space-y-2 rounded border border-port-border p-2">
          <label className="flex items-center gap-2 text-xs text-gray-300" htmlFor="idealoom-enabled">
            <input id="idealoom-enabled" type="checkbox" checked={Boolean(settings.enabled)} onChange={(event) => patchSettings({ enabled: event.target.checked })} />
            Sync with an Obsidian vault
          </label>
          {settings.enabled && <label className="block text-xs text-gray-300" htmlFor="idealoom-vault">Vault
            <select id="idealoom-vault" value={settings.obsidianVaultId || ''} onChange={(event) => patchSettings({ obsidianVaultId: event.target.value || null })} className="mt-1 block min-h-[44px] w-full rounded border border-port-border bg-port-bg px-3 text-sm text-white">
              <option value="">Choose a vault…</option>
              {vaults.map((vault) => <option key={vault.id} value={vault.id}>{vault.name}</option>)}
            </select>
          </label>}
          {settings.enabled && settings.obsidianVaultId && <label className="flex items-start gap-2 text-xs text-gray-300" htmlFor="idealoom-autosync">
            <input id="idealoom-autosync" type="checkbox" checked={Boolean(settings.autoSync)} onChange={(event) => patchSettings({ autoSync: event.target.checked })} />
            <span>Export automatically after an edit<span className="block text-gray-500">Never deletes or recreates a note. A note you deleted in Obsidian is reported, not restored.</span></span>
          </label>}
        </div>}
        {notice && <p role="status" className="mb-3 rounded bg-port-warning/10 p-2 text-xs text-port-warning">{notice}</p>}
        {!notice && <div className="mb-3 flex flex-wrap gap-2">
          <button type="button" disabled={exchangeBusy} onClick={() => runExchange(() => api.importIdeaLoomFromObsidian({ silent: true }), 'IdeaLoom import complete')} className="flex min-h-[44px] items-center gap-2 rounded border border-port-border px-3 text-xs text-gray-300 hover:bg-port-border/50 disabled:opacity-50"><Download size={14} />Import from Obsidian</button>
          <button type="button" disabled={exchangeBusy} onClick={() => runExchange(() => api.syncIdeaLoomToObsidian(null, { silent: true }), 'IdeaLoom export complete')} className="flex min-h-[44px] items-center gap-2 rounded border border-port-border px-3 text-xs text-gray-300 hover:bg-port-border/50 disabled:opacity-50"><Upload size={14} />Export to Obsidian</button>
          {Boolean(exchangeResult?.missing) && <button type="button" disabled={exchangeBusy} onClick={() => runExchange(() => api.syncIdeaLoomToObsidian(null, { silent: true, recreateMissing: true }), 'Deleted notes recreated')} className="flex min-h-[44px] items-center gap-2 rounded border border-port-warning px-3 text-xs text-port-warning hover:bg-port-warning/10 disabled:opacity-50"><RotateCcw size={14} />Recreate {exchangeResult.missing} deleted note{exchangeResult.missing === 1 ? '' : 's'}</button>}
        </div>}
        {exchangeResult && <p role="status" className="mb-3 text-xs text-gray-400">Last exchange: {RESULT_KEYS.map((key) => `${exchangeResult[key] || 0} ${key}`).join(' · ')}</p>}
        <div className="space-y-1">
          {lists.map((list) => <button key={list.id} type="button" onClick={() => select(list.id)} className={`w-full rounded p-3 text-left ${selected?.id === list.id ? 'bg-port-accent/20 text-white' : 'text-gray-300 hover:bg-port-border/50'}`}>
            <span className="block truncate text-sm font-medium">{list.title}</span><span className="text-xs text-gray-500">{list.status === 'completed' ? 'Completed' : 'Draft'} · {(list.ideas || []).length} ideas</span>
          </button>)}
          {!lists.length && <p className="py-5 text-center text-sm text-gray-500">No IdeaLoom lists yet.</p>}
        </div>
      </aside>

      <div className="rounded-lg border border-port-border bg-port-card p-4">
        {!draft ? <p className="py-10 text-center text-gray-500">Choose a list or create one to edit its ordered ideas.</p> : <>
          <div className="mb-4 flex items-center justify-between gap-2"><h2 className="font-medium text-white">{draft.id ? 'Edit list' : 'New list'}</h2>{draft.id && <button type="button" onClick={() => requestDelete(draft.id)} className="min-h-[44px] px-2 text-port-error" aria-label="Delete list"><Trash2 size={16} /></button>}</div>
          {draft.id && isConfirming(draft.id) && <InlineConfirmRow question="Delete this list and its ideas?" confirmTitle="Delete list" cancelTitle="Cancel" onConfirm={() => confirmDelete(() => remove(draft.id))} onCancel={cancelDelete} />}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Title" value={draft.title} onChange={(value) => updateDraft('title', value)} required />
            <Field label="Category" value={draft.category || ''} onChange={(value) => updateDraft('category', value)} required />
            <Field label="Prompt" value={draft.prompt || ''} onChange={(value) => updateDraft('prompt', value)} className="sm:col-span-2" required />
            <Field label="Help" value={draft.help || ''} onChange={(value) => updateDraft('help', value)} className="sm:col-span-2" />
            <label className="text-sm text-gray-300" htmlFor="idealoom-status">Status<select id="idealoom-status" value={draft.status || 'draft'} onChange={(event) => updateDraft('status', event.target.value)} className="mt-1 block min-h-[44px] w-full rounded border border-port-border bg-port-bg px-3 text-white"><option value="draft">Draft</option><option value="completed">Completed</option></select></label>
          </div>
          <div className="mt-5"><h3 className="mb-2 text-sm font-medium text-white">Ordered ideas</h3><div className="space-y-2">{(draft.ideas || []).map((idea, index) => <div className="flex items-center gap-1" key={`${index}-${idea}`}><span className="w-6 text-right text-xs text-gray-500">{index + 1}.</span><input value={idea} onChange={(event) => { const ideas = [...draft.ideas]; ideas[index] = event.target.value; updateDraft('ideas', ideas); }} aria-label={`Idea ${index + 1}`} className="min-h-[44px] min-w-0 flex-1 rounded border border-port-border bg-port-bg px-3 text-sm text-white" /><button type="button" onClick={() => moveIdea(index, -1)} disabled={index === 0} className="min-h-[44px] min-w-[44px] text-gray-400 disabled:opacity-30" aria-label={`Move idea ${index + 1} up`}><ArrowUp size={16} /></button><button type="button" onClick={() => moveIdea(index, 1)} disabled={index === draft.ideas.length - 1} className="min-h-[44px] min-w-[44px] text-gray-400 disabled:opacity-30" aria-label={`Move idea ${index + 1} down`}><ArrowDown size={16} /></button><button type="button" onClick={() => updateDraft('ideas', draft.ideas.filter((_, itemIndex) => itemIndex !== index))} className="min-h-[44px] min-w-[44px] text-gray-400 hover:text-port-error" aria-label={`Remove idea ${index + 1}`}><X size={16} /></button></div>)}</div>
            <div className="mt-2 flex gap-2"><input value={ideaText} onChange={(event) => setIdeaText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addIdea(); } }} aria-label="New idea" placeholder="Add an idea" className="min-h-[44px] min-w-0 flex-1 rounded border border-port-border bg-port-bg px-3 text-sm text-white" /><button type="button" onClick={addIdea} aria-label="Add idea" className="min-h-[44px] rounded px-3 text-port-accent hover:bg-port-accent/10"><Plus size={16} /></button></div>
          </div>
          <div className="mt-5 flex flex-wrap gap-2"><button type="button" onClick={() => save()} className="flex min-h-[44px] items-center gap-2 rounded bg-port-accent/20 px-3 text-sm text-port-accent hover:bg-port-accent/30"><Save size={16} />Save list</button>{draft.id && <button type="button" onClick={() => save({ status: draft.status === 'completed' ? 'draft' : 'completed' })} aria-label={draft.status === 'completed' ? 'Mark list draft' : 'Mark list completed'} className="flex min-h-[44px] items-center gap-2 rounded px-3 text-sm text-gray-300 hover:bg-port-border/50"><CheckCircle2 size={16} />Mark {draft.status === 'completed' ? 'draft' : 'completed'}</button>}</div>
        </>}
      </div>
    </section>
  );
}

function Field({ label, value, onChange, required, className = '' }) {
  const id = `idealoom-${label.toLowerCase().replaceAll(' ', '-')}`;
  return <label className={`text-sm text-gray-300 ${className}`} htmlFor={id}>{label}{required && <span className="text-port-error"> *</span>}<input id={id} value={value} onChange={(event) => onChange(event.target.value)} required={required} className="mt-1 block min-h-[44px] w-full rounded border border-port-border bg-port-bg px-3 text-white" /></label>;
}

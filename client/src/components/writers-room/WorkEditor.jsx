import { useEffect, useMemo, useRef, useState } from 'react';
import { Save, GitCommit, Clock, FileText, Sparkles, ListTree } from 'lucide-react';
import toast from '../ui/Toast';
import {
  saveWritersRoomDraft,
  snapshotWritersRoomDraft,
  setWritersRoomActiveDraft,
  updateWritersRoomWork,
} from '../../services/apiWritersRoom';
import { KIND_LABELS, STATUS_LABELS } from './labels';
import { countWords } from '../../utils/formatters';
import AiPanel from './AiPanel';

const SIDEBAR_TABS = [
  { id: 'ai', label: 'AI', Icon: Sparkles },
  { id: 'outline', label: 'Outline', Icon: ListTree },
  { id: 'versions', label: 'Versions', Icon: Clock },
];

export default function WorkEditor({ work, onChange }) {
  const [body, setBody] = useState(work.activeDraftBody || '');
  const [title, setTitle] = useState(work.title);
  const [sidebarTab, setSidebarTab] = useState('ai');
  // Optimistic mirror of work.status — the dropdown reads this so a status
  // change shows immediately, even before the PATCH round-trip resolves and
  // the parent re-renders with the new prop. Synced from the prop whenever
  // the prop changes (both work-id swap AND any time the parent updates).
  const [status, setStatus] = useState(work.status);
  const [savedBody, setSavedBody] = useState(work.activeDraftBody || '');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);

  // Rehydrate body/title when the parent swaps the active work OR switches to
  // a different draft version of the same work. Both can change without the
  // work id changing (version-switch keeps work.id, swaps activeDraftVersionId).
  const prevKey = useRef({ id: work.id, draftId: work.activeDraftVersionId });
  useEffect(() => {
    const key = { id: work.id, draftId: work.activeDraftVersionId };
    if (prevKey.current.id === key.id && prevKey.current.draftId === key.draftId) return;
    prevKey.current = key;
    setBody(work.activeDraftBody || '');
    setSavedBody(work.activeDraftBody || '');
    setTitle(work.title);
  }, [work.id, work.activeDraftVersionId, work.activeDraftBody, work.title]);

  // Keep the optimistic status + title in sync with the source of truth —
  // separate from the rehydration effect so a PATCH that comes back via the
  // parent's onChange still updates the input even if no other field moved.
  // The "is the user actively editing" guard isn't needed for status (single
  // click) but title commits on blur, so the user can never be mid-edit when
  // a title prop change arrives.
  useEffect(() => { setStatus(work.status); }, [work.status]);
  useEffect(() => { setTitle(work.title); }, [work.title]);

  const dirty = body !== savedBody;
  const wordCount = useMemo(() => countWords(body), [body]);

  // Skip post-await setState if the editor unmounted (rapid work-switch or
  // page nav while a save / snapshot / status PATCH is in flight).
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Refs let the once-bound keydown listener read the freshest body/saving
  // values without re-registering on every keystroke. The savingRef gate is
  // synchronous (unlike the `saving` state which only updates after React
  // re-renders), so rapid Cmd+S key-repeats can't slip past the guard and
  // queue overlapping save requests.
  const savingRef = useRef(false);
  const handleSaveRef = useRef(null);
  handleSaveRef.current = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const updated = await saveWritersRoomDraft(work.id, body).catch((err) => {
      if (mountedRef.current) toast.error(`Save failed: ${err.message}`);
      return null;
    });
    savingRef.current = false;
    if (!mountedRef.current) return;
    setSaving(false);
    if (!updated) return;
    setSavedBody(body);
    onChange?.(updated);
    toast.success('Saved');
  };
  const handleSave = () => handleSaveRef.current?.();

  useEffect(() => {
    const onKey = (e) => {
      const isSave = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's';
      if (!isSave) return;
      e.preventDefault();
      handleSaveRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleSnapshot = async () => {
    if (dirty) {
      toast('Save before snapshotting', { icon: '⚠️' });
      return;
    }
    const updated = await snapshotWritersRoomDraft(work.id).catch((err) => {
      if (mountedRef.current) toast.error(`Snapshot failed: ${err.message}`);
      return null;
    });
    if (!updated || !mountedRef.current) return;
    onChange?.({ ...updated, activeDraftBody: body });
    toast.success(`Created ${updated.drafts[updated.drafts.length - 1].label}`);
  };

  const commitTitle = async () => {
    if (title === work.title) return;
    const updated = await updateWritersRoomWork(work.id, { title }).catch((err) => {
      if (mountedRef.current) toast.error(`Title save failed: ${err.message}`);
      return null;
    });
    if (!updated || !mountedRef.current) return;
    // Adopt the server-normalized title (e.g. trim() applied by the Zod
    // schema) — otherwise `title !== work.title` stays true on every blur
    // and the next focus-out re-PATCHes with the same un-normalized value.
    if (updated.title !== title) setTitle(updated.title);
    onChange?.({ ...updated, activeDraftBody: body });
  };

  const commitStatus = async (next) => {
    if (next === status) return;
    setStatus(next); // optimistic — survives a re-render before the PATCH resolves
    const updated = await updateWritersRoomWork(work.id, { status: next }).catch((err) => {
      if (mountedRef.current) {
        toast.error(`Status save failed: ${err.message}`);
        setStatus(work.status); // roll back on failure
      }
      return null;
    });
    if (updated && mountedRef.current) onChange?.({ ...updated, activeDraftBody: body });
  };

  const switchToDraft = async (draftId) => {
    if (draftId === work.activeDraftVersionId) return;
    if (dirty) {
      // Switching versions while the editor has unsaved edits would discard
      // them when the rehydration effect replaces `body` with the server
      // version. Block the switch and ask the user to settle the buffer.
      toast('Save or snapshot before switching versions', { icon: '⚠️' });
      return;
    }
    const updated = await setWritersRoomActiveDraft(work.id, draftId).catch((err) => {
      if (mountedRef.current) toast.error(`Switch failed: ${err.message}`);
      return null;
    });
    if (!updated || !mountedRef.current) return;
    // PATCH /works/:id/versions/:draftId now returns manifest + activeDraftBody
    // in one round-trip, so no separate reload is needed.
    onChange?.(updated);
  };

  const activeDraft = useMemo(
    () => work.drafts?.find((d) => d.id === work.activeDraftVersionId),
    [work.drafts, work.activeDraftVersionId]
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-port-border bg-port-card">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
          className="bg-transparent text-lg font-bold text-white border-none focus:outline-none focus:bg-port-bg/50 px-1 rounded flex-1 min-w-[200px]"
          aria-label="Work title"
        />
        <select
          value={status}
          onChange={(e) => commitStatus(e.target.value)}
          className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-gray-300"
          aria-label="Status"
        >
          {Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <span className="text-xs text-gray-500 px-2 py-1 bg-port-bg/50 rounded">{KIND_LABELS[work.kind]}</span>
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          className={`flex items-center gap-1 px-3 py-1 text-xs rounded ${
            dirty && !saving ? 'bg-port-accent text-white hover:bg-port-accent/80' : 'bg-port-bg text-gray-500'
          }`}
          title={dirty ? 'Save (Ctrl/Cmd+S)' : 'Up to date'}
        >
          <Save size={12} /> {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
        <button
          onClick={handleSnapshot}
          disabled={dirty}
          className="flex items-center gap-1 px-3 py-1 text-xs rounded bg-port-bg border border-port-border text-gray-300 hover:text-white disabled:text-gray-600 disabled:cursor-not-allowed"
          title="Snapshot the active draft as a new version"
        >
          <GitCommit size={12} /> Snapshot
        </button>
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_240px] min-h-0">
        <div className="relative min-h-0">
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Start writing… Use # Chapter, ## Scene, ### Beat headings to outline."
            className="w-full h-full resize-none bg-port-bg text-gray-100 px-6 py-6 font-serif text-base leading-relaxed focus:outline-none"
            spellCheck
          />
          <div className="absolute bottom-2 right-3 flex items-center gap-3 text-[11px] text-gray-500 bg-port-bg/80 px-2 py-1 rounded">
            <span>{wordCount.toLocaleString()} words</span>
            {dirty && <span className="text-port-warning">● unsaved</span>}
          </div>
        </div>

        <aside className="border-t lg:border-t-0 lg:border-l border-port-border bg-port-card/60 flex flex-col text-xs min-h-0">
          <div className="flex border-b border-port-border bg-port-bg/40">
            {SIDEBAR_TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setSidebarTab(id)}
                className={`flex-1 flex items-center justify-center gap-1 px-2 py-2 text-[11px] border-b-2 ${
                  sidebarTab === id
                    ? 'border-port-accent text-white'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
                aria-pressed={sidebarTab === id}
              >
                <Icon size={11} /> {label}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-3">
            {sidebarTab === 'ai' && (
              <AiPanel
                work={work}
                onApplyFormat={(text) => {
                  // Don't autosave — keeps a bad format pass from overwriting
                  // the on-disk draft without an explicit Save.
                  setBody(text);
                  toast('Applied to editor — save to persist', { icon: '💾' });
                }}
              />
            )}
            {sidebarTab === 'outline' && (
              <ul className="space-y-0.5">
                {(activeDraft?.segmentIndex || []).map((seg) => (
                  <li key={seg.id} className="flex items-center gap-1 text-gray-400 truncate">
                    <FileText size={10} className="shrink-0" />
                    <span className={`truncate ${seg.kind === 'chapter' ? 'text-white' : seg.kind === 'scene' ? 'text-gray-300' : 'pl-3'}`}>
                      {seg.heading}
                    </span>
                    <span className="ml-auto text-[10px] text-gray-600">{seg.wordCount}</span>
                  </li>
                ))}
                {(!activeDraft?.segmentIndex || activeDraft.segmentIndex.length === 0) && (
                  <li className="text-gray-600 italic">No segments yet — use # Chapter / ## Scene headings to outline.</li>
                )}
              </ul>
            )}
            {sidebarTab === 'versions' && (
              <ul className="space-y-1">
                {(work.drafts || []).slice().reverse().map((draft) => {
                  const isActive = draft.id === work.activeDraftVersionId;
                  return (
                    <li key={draft.id}>
                      <button
                        onClick={() => switchToDraft(draft.id)}
                        className={`w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-left ${
                          isActive ? 'bg-port-accent/20 text-port-accent' : 'text-gray-400 hover:bg-port-bg hover:text-white'
                        }`}
                      >
                        <span className="flex items-center gap-1 truncate">
                          <Clock size={10} />
                          {draft.label}
                        </span>
                        <span className="text-[10px] text-gray-500">{draft.wordCount}w</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

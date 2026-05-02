import { useEffect, useMemo, useRef, useState } from 'react';
import { Save, GitCommit, Clock, FileText } from 'lucide-react';
import toast from '../ui/Toast';
import {
  saveWritersRoomDraft,
  snapshotWritersRoomDraft,
  setWritersRoomActiveDraft,
  updateWritersRoomWork,
} from '../../services/apiWritersRoom';
import { KIND_LABELS, STATUS_LABELS } from './labels';
import { countWords } from '../../utils/formatters';

export default function WorkEditor({ work, onChange }) {
  const [body, setBody] = useState(work.activeDraftBody || '');
  const [title, setTitle] = useState(work.title);
  const [savedBody, setSavedBody] = useState(work.activeDraftBody || '');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);

  // When the parent swaps the active work, rehydrate.
  const prevWorkId = useRef(work.id);
  useEffect(() => {
    if (prevWorkId.current === work.id) return;
    prevWorkId.current = work.id;
    setBody(work.activeDraftBody || '');
    setSavedBody(work.activeDraftBody || '');
    setTitle(work.title);
  }, [work.id, work.activeDraftBody, work.title]);

  const dirty = body !== savedBody;
  const wordCount = useMemo(() => countWords(body), [body]);

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
      toast.error(`Save failed: ${err.message}`);
      return null;
    });
    savingRef.current = false;
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
      toast.error(`Snapshot failed: ${err.message}`);
      return null;
    });
    if (!updated) return;
    onChange?.({ ...updated, activeDraftBody: body });
    toast.success(`Created ${updated.drafts[updated.drafts.length - 1].label}`);
  };

  const commitTitle = async () => {
    if (title === work.title) return;
    const updated = await updateWritersRoomWork(work.id, { title }).catch((err) => {
      toast.error(`Title save failed: ${err.message}`);
      return null;
    });
    if (updated) onChange?.({ ...updated, activeDraftBody: body });
  };

  const commitStatus = async (next) => {
    if (next === work.status) return;
    const updated = await updateWritersRoomWork(work.id, { status: next }).catch((err) => {
      toast.error(`Status save failed: ${err.message}`);
      return null;
    });
    if (updated) onChange?.({ ...updated, activeDraftBody: body });
  };

  const switchToDraft = async (draftId) => {
    const updated = await setWritersRoomActiveDraft(work.id, draftId).catch((err) => {
      toast.error(`Switch failed: ${err.message}`);
      return null;
    });
    if (!updated) return;
    // Reload via parent so body comes from the server's active version
    onChange?.(updated, { reload: true });
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
          value={work.status}
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

        <aside className="border-t lg:border-t-0 lg:border-l border-port-border bg-port-card/60 px-3 py-3 overflow-y-auto text-xs space-y-4">
          <div>
            <h3 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Outline</h3>
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
                <li className="text-gray-600 italic">No segments yet</li>
              )}
            </ul>
          </div>

          <div>
            <h3 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Versions</h3>
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
          </div>
        </aside>
      </div>
    </div>
  );
}

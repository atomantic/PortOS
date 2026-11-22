import { useEffect, useState } from 'react';
import { Edit3, Plus, Trash2 } from 'lucide-react';
import { getCosJobNotepad, setCosJobNote, deleteCosJobNote, clearCosJobNotepad } from '../../services/apiAgents.js';
import { formatCount } from '../../utils/formatters';
import InlineConfirmRow from '../ui/InlineConfirmRow';

// Mirrors the server caps in server/lib/autonomousJobNotepad.js; the server is authoritative.
const KEY_PATTERN = /^[a-zA-Z0-9._:-]+$/;
const ICON_BUTTON_CLASS = 'inline-flex items-center justify-center min-h-[44px] min-w-[44px] text-gray-400 hover:text-white transition-colors';

// The notepad is fetched once when the section opens; each mutation
// replaces local state with the server's full-notepad response (no refetch).
function NotepadBody({ jobId }) {
  const [pad, setPad] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draftKey, setDraftKey] = useState('');
  const [draftValue, setDraftValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);

  useEffect(() => {
    let active = true;
    setPad(null);
    setLoadFailed(false);
    getCosJobNotepad(jobId, { silent: true })
      .then((result) => { if (active) setPad(result); })
      .catch(() => { if (active) setLoadFailed(true); });
    return () => { active = false; };
  }, [jobId]);

  const apply = (call) => call.then((result) => { setPad(result); return true; }).catch(() => false);

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    const ok = await apply(setCosJobNote(jobId, draftKey.trim(), draftValue));
    setSaving(false);
    if (ok) { setDraftKey(''); setDraftValue(''); }
  };

  const keyValid = KEY_PATTERN.test(draftKey.trim()) && draftKey.trim().length <= 128;
  const idBase = `job-notepad-${jobId}`;

  return (
    <div className="space-y-2 text-xs" data-testid="job-notepad">
      <div className="flex items-center justify-between gap-2">
        <span className="text-gray-500">
          {pad ? `${formatCount(pad.usedBytes)} / ${formatCount(pad.maxBytes)} bytes used` : loadFailed ? 'Notepad unavailable' : 'Loading…'}
        </span>
        {pad?.notes.length > 0 && !confirmingClear && (
          <button type="button" onClick={() => setConfirmingClear(true)} className="px-2 py-1 border border-port-border rounded text-gray-400 hover:text-white">
            Clear all
          </button>
        )}
      </div>
      {confirmingClear && (
        <InlineConfirmRow
          question="Clear every notepad entry for this job?"
          confirmText="Clear all"
          onConfirm={() => { setConfirmingClear(false); apply(clearCosJobNotepad(jobId)); }}
          onCancel={() => setConfirmingClear(false)}
        />
      )}
      {pad?.notes.length === 0 && <p className="text-gray-500">No entries. Agents can write cursors here with <code>portos-api notepad set</code>.</p>}
      <ul className="space-y-1">
        {pad?.notes.map((note) => (
          <li key={note.key} className="flex items-start gap-2 p-2 bg-port-bg border border-port-border rounded">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-gray-300 break-all">{note.key}</div>
              <pre className="mt-1 text-gray-400 font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto">{note.value}</pre>
            </div>
            <button type="button" className={ICON_BUTTON_CLASS} aria-label={`Edit ${note.key}`} title="Edit" onClick={() => { setDraftKey(note.key); setDraftValue(note.value); }}>
              <Edit3 size={14} />
            </button>
            <button type="button" className={ICON_BUTTON_CLASS} aria-label={`Delete ${note.key}`} title="Delete" onClick={() => apply(deleteCosJobNote(jobId, note.key))}>
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>
      {pad && (
        <form onSubmit={save} className="space-y-2">
          <label htmlFor={`${idBase}-key`} className="block text-gray-500">Key</label>
          <input
            id={`${idBase}-key`}
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            maxLength={128}
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded font-mono text-gray-200"
            placeholder="last-processed-pr"
          />
          <label htmlFor={`${idBase}-value`} className="block text-gray-500">Value</label>
          <textarea
            id={`${idBase}-value`}
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            rows={2}
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded font-mono text-gray-200"
          />
          <button
            type="submit"
            disabled={!keyValid || saving}
            className="inline-flex items-center gap-1.5 min-h-[44px] px-3 py-1.5 border border-port-border rounded text-gray-200 hover:bg-port-border/50 disabled:opacity-50"
          >
            <Plus size={14} /> Save entry
          </button>
        </form>
      )}
    </div>
  );
}

// Collapsible section; the notepad is fetched only once the user opens it.
export default function JobNotepad({ jobId }) {
  const [opened, setOpened] = useState(false);
  return (
    <details className="group" onToggle={(e) => { if (e.currentTarget.open) setOpened(true); }}>
      <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300 transition-colors">Notepad</summary>
      <div className="mt-2">{opened && <NotepadBody jobId={jobId} />}</div>
    </details>
  );
}

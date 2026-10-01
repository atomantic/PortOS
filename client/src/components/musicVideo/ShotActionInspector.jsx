import { useId, useRef, useState } from 'react';
import { SHOT_ACTION_TEXT_LIMITS, SHOT_ACTION_LIST_FIELDS, shotActionContractProblem } from '../../../../server/lib/musicVideoActionContract.js';
import { formatTimecode } from '../../utils/formatters.js';

const TEXT_LABELS = { purpose: 'Purpose', startEmotion: 'Starting emotion', endEmotion: 'Ending emotion', activeSpeaker: 'Active speaker' };
const LIST_LABELS = { cameraConstraints: 'Camera constraints', continuityRequirements: 'Must preserve', acceptanceCriteria: 'Acceptance criteria' };
const inputClass = 'w-full min-w-0 rounded border border-port-border bg-port-bg px-2 py-1 text-xs';
const blank = () => ({ version: 1, purpose: '', startEmotion: '', endEmotion: '', activeSpeaker: '', actions: [], reactions: [], cameraConstraints: [], continuityRequirements: [], acceptanceCriteria: [] });

function ShotActionEditor({ contract, scene, onSave, onClose }) {
  const id = useId();
  const [draft, setDraft] = useState(() => structuredClone(contract || blank()));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const change = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const editEvent = (kind, index, key, value) => setDraft((current) => ({ ...current,
    [kind]: current[kind].map((event, i) => i === index ? { ...event, [key]: value } : event),
  }));
  const commit = (value) => {
    if (busy.current) return;
    const problem = shotActionContractProblem(value, scene);
    if (problem) { setError(problem); return; }
    busy.current = true;
    setSaving(true);
    setError('');
    Promise.resolve().then(() => onSave(value)).then((result) => {
      if (result !== null) onClose();
      else setError('Shot intent was not saved. Review the error and try again.');
    }).catch((err) => setError(err.message || 'Shot intent was not saved'))
      .finally(() => { busy.current = false; setSaving(false); });
  };
  return (
    <div className="space-y-2 mt-2">
      <p className="text-[11px] text-port-text-muted">Action and reaction times are seconds from this shot’s start. Save, then apply the treatment before generation.</p>
      <fieldset disabled={saving} className="space-y-2">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {Object.entries(SHOT_ACTION_TEXT_LIMITS).map(([key, maxLength]) => (
            <div key={key} className="min-w-0">
              <label htmlFor={`${id}-${key}`} className="block text-[11px]">{TEXT_LABELS[key]}</label>
              <input id={`${id}-${key}`} value={draft[key] || ''} maxLength={maxLength} onChange={(e) => change(key, e.target.value)} className={inputClass} />
            </div>
          ))}
        </div>
        {['actions', 'reactions'].map((kind) => (
          <div key={kind} className="space-y-1">
            <p className="text-xs font-medium">{kind === 'actions' ? 'Actions' : 'Reactions'}</p>
            {(draft[kind] || []).map((event, index) => (
              <div key={index} className="grid grid-cols-2 gap-1 rounded border border-port-border p-1.5">
                {['startSec', 'endSec', 'subject', 'description'].map((key) => {
                  const timed = key.endsWith('Sec');
                  const fieldId = `${id}-${kind}-${index}-${key}`;
                  return (
                    <div key={key} className={key === 'description' ? 'col-span-2 min-w-0' : 'min-w-0'}>
                      <label htmlFor={fieldId} className="block text-[10px]">{key === 'startSec' ? 'Start (s)' : key === 'endSec' ? 'End (s)' : key === 'subject' ? 'Subject' : 'Description'}</label>
                      <input id={fieldId} type={timed ? 'number' : 'text'} min={timed ? 0 : undefined} step={timed ? 0.01 : undefined}
                        value={Number.isNaN(event[key]) ? '' : event[key]} maxLength={timed ? undefined : key === 'subject' ? 120 : 1000}
                        onChange={(e) => editEvent(kind, index, key, timed ? (e.target.value === '' ? NaN : Number(e.target.value)) : e.target.value)} className={inputClass} />
                    </div>
                  );
                })}
                <button type="button" className="text-xs text-port-text-muted text-left" onClick={() => change(kind, draft[kind].filter((_, i) => i !== index))}>Remove {kind === 'actions' ? 'action' : 'reaction'}</button>
              </div>
            ))}
            <button type="button" className="text-xs text-port-accent" disabled={(draft[kind]?.length || 0) >= 24}
              onClick={() => change(kind, [...(draft[kind] || []), { startSec: 0, endSec: 1, subject: '', description: '' }])}>Add {kind === 'actions' ? 'action' : 'reaction'}</button>
          </div>
        ))}
        {SHOT_ACTION_LIST_FIELDS.map((key) => (
          <div key={key}>
            <label htmlFor={`${id}-${key}`} className="block text-[11px]">{LIST_LABELS[key]} (one per line)</label>
            <textarea id={`${id}-${key}`} rows={2} value={(draft[key] || []).join('\n')} onChange={(e) => change(key, e.target.value.split('\n'))} className={inputClass} />
          </div>
        ))}
      </fieldset>
      {error && <p role="alert" className="text-xs text-port-warning">{error}</p>}
      <div className="flex flex-wrap gap-3 text-xs">
        <button type="button" disabled={saving} onClick={() => commit({ ...draft, ...Object.fromEntries(SHOT_ACTION_LIST_FIELDS.map((key) => [key, (draft[key] || []).map((line) => line.trim()).filter(Boolean)])) })} className="text-port-accent">{saving ? 'Saving…' : 'Save shot intent'}</button>
        {contract && <button type="button" disabled={saving} onClick={() => commit(null)} className="text-port-text-muted">Clear shot intent</button>}
        <button type="button" disabled={saving} onClick={onClose} className="text-port-text-muted">Cancel</button>
      </div>
    </div>
  );
}

/** Same compact authored/applied intent beside treatment direction and the scene preview. */
export default function ShotActionInspector({ contract, scene, onSave }) {
  const [editing, setEditing] = useState(false);
  if (!contract && !onSave) return null;
  return (
    <details className="rounded border border-port-border/60 p-2 text-xs">
      <summary className="cursor-pointer break-words">Shot intent{contract?.purpose ? ` · ${contract.purpose}` : ' · not authored'}</summary>
      {contract && <div className="mt-2 space-y-1 break-words">
        <p><strong>Purpose:</strong> {contract.purpose}</p>
        {(contract.startEmotion || contract.endEmotion) && <p>Emotion: {contract.startEmotion || '—'} → {contract.endEmotion || '—'}</p>}
        {contract.activeSpeaker && <p>Active speaker: {contract.activeSpeaker}</p>}
        {['actions', 'reactions'].map((kind) => (contract[kind] || []).map((event, i) => <p key={`${kind}-${i}`}><strong>{kind === 'actions' ? 'Action' : 'Reaction'}:</strong> {formatTimecode(event.startSec)}–{formatTimecode(event.endSec)} · {event.subject}: {event.description}</p>))}
        {SHOT_ACTION_LIST_FIELDS.map((key) => (contract[key] || []).length > 0 && <p key={key}><strong>{LIST_LABELS[key]}:</strong> {contract[key].join('; ')}</p>)}
        {shotActionContractProblem(contract, scene) && <p role="alert" className="text-port-warning">{shotActionContractProblem(contract, scene)}</p>}
      </div>}
      {onSave && (editing ? <ShotActionEditor key={JSON.stringify(contract)} contract={contract} scene={scene} onSave={onSave} onClose={() => setEditing(false)} />
        : <button type="button" className="mt-2 text-port-accent" onClick={() => setEditing(true)}>{contract ? 'Edit shot intent' : 'Add shot intent'}</button>)}
    </details>
  );
}

import { useEffect, useState } from 'react';
import { musicVideoToolPolicyConflict } from '../../../../server/lib/musicVideoMediumPlan.js';
import { formatCount } from '../../utils/formatters.js';
import { Link } from 'react-router';
import { listUniverseNames, getUniverse } from '../../services/apiUniverseBuilder.js';
import { uuidv4 } from '../../lib/uuid.js';
import { pullUniverseCanonReferences } from '../../lib/musicVideoUniverseRefs.js';
import CharacterStylePicker from './CharacterStylePicker.jsx';

const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';
const kinds = [['character', 'Cast'], ['place', 'Places'], ['object', 'Objects']];
const fields = { character: 'characters', place: 'places', object: 'objects' };

/** Project-owned snapshots: changing source canon never silently recasts a video. */
export default function CreativeSetupPanel({ project, onSave, onPendingChange }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [lists, setLists] = useState({ universes: [] });
  const [universe, setUniverse] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [replanning, setReplanning] = useState(false);
  const [error, setError] = useState('');
  const [newKind, setNewKind] = useState('character');
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [selectedCanon, setSelectedCanon] = useState([]);
  const universeId = draft?.universeId ?? project.concept?.universeId ?? '';
  const universeReady = !universeId || (!loading && universe?.id === universeId);
  const subjects = editing ? (draft?.subjects || []) : (project.concept?.subjects || []);
  const idFor = (name) => `mv-creative-${project.id}-${name}`;
  // The saved tools and policy disagree (no video tool, yet generated footage is still planned).
  // Shown, never auto-fixed: approved plans and sheets stay as saved until the director replans.
  const conflict = musicVideoToolPolicyConflict(project);

  useEffect(() => {
    onPendingChange(editing);
    return () => onPendingChange(false);
  }, [editing, onPendingChange]);

  useEffect(() => {
    if (!editing) return undefined;
    let active = true;
    listUniverseNames({ silent: true })
      .then((universes) => { if (active) setLists({ universes }); })
      .catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [editing]);

  useEffect(() => {
    if (!editing || !universeId) { setUniverse(null); setLoading(false); return undefined; }
    let active = true;
    setLoading(true);
    setUniverse(null);
    getUniverse(universeId, { silent: true })
      .then((value) => { if (active) setUniverse(value); })
      .catch((err) => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [editing, universeId]);

  const begin = () => {
    setDraft({ universeId: project.concept?.universeId || '', characterStyleId: project.concept?.characterStyleId || '', subjects: project.concept?.subjects || [] });
    setSelectedCanon([]);
    setNewName('');
    setNewDescription('');
    setError('');
    setEditing(true);
  };
  const add = (kind, name, description, canon) => {
    if (!name.trim() || subjects.length >= 24) return;
    const subject = { id: `mvc-${uuidv4()}`, kind, name: name.trim().slice(0, 120), description: (description || '').slice(0, 1000), ...(kind === 'character' ? { role: subjects.some((s) => s.kind === 'character') ? 'supporting' : 'protagonist' } : {}), ...(canon?.id ? { canonId: canon.id } : {}) };
    setDraft((d) => ({ ...d, subjects: [...d.subjects, subject] }));
    if (canon) setSelectedCanon((items) => [...items, { subjectId: subject.id, kind, entry: canon }]);
  };
  const replan = () => {
    setReplanning(true);
    setError('');
    return onSave({ productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 } })
      .catch((err) => setError(err.message || 'Could not replan the production policy'))
      .finally(() => setReplanning(false));
  };
  const save = async () => {
    if (!universeReady) { setError('Wait for the selected universe to load before saving.'); return; }
    setSaving(true);
    setError('');
    const concept = { subjects: draft.subjects, universeId: draft.universeId || null, characterStyleId: draft.characterStyleId || null };
    const canon = { characters: [], places: [], objects: [] };
    for (const item of selectedCanon) {
      if (draft.subjects.some((s) => s.id === item.subjectId)) canon[fields[item.kind]].push(item.entry);
    }
    const pulled = pullUniverseCanonReferences(canon, project.visualSpec?.references || []);
    return onSave({ concept, ...(pulled.added ? { visualSpec: { references: pulled.next } } : {}) }).then(() => setEditing(false)).catch((err) => setError(err.message || 'Could not save creative setup')).finally(() => setSaving(false));
  };

  return <section className="bg-port-card border border-port-border rounded-lg p-3 space-y-3 min-w-0 break-words" aria-label="Creative setup">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-medium">Character style, universe, cast, places &amp; objects</h3>
      {!editing && <button type="button" onClick={begin} className="text-sm text-port-accent min-h-[44px]">Set up creative direction</button>}
    </div>
    {!editing && project.concept?.characterStyleId && <p className="text-xs">Character style: {project.concept.characterStyle?.split(':')[0] || project.concept.characterStyleId}</p>}
    {!editing ? <p className="text-xs text-port-text-muted">{subjects.length ? subjects.map((s) => `${s.name}${s.role === 'protagonist' ? ' (protagonist)' : s.role === 'band' ? ' (band)' : ''}`).join(' · ') : 'Create the band or protagonist, choose a universe, and select the places and objects that anchor the story.'}</p> : <fieldset disabled={saving} className="space-y-3 min-w-0">
      <p className="text-xs text-port-text-muted">Save this setup before planning or generating. Canon and style are copied into this project; source records stay independent.</p>
      <div className="grid grid-cols-1 gap-3">
        <CharacterStylePicker project={project} idFor={idFor} value={draft.characterStyleId} onChange={(characterStyleId) => setDraft((d) => ({ ...d, characterStyleId }))} />
        <div><label htmlFor={idFor('universe')} className="text-xs">Universe</label>
          <select id={idFor('universe')} className={inputClass} value={universeId} onChange={(e) => {
            const nextId = e.target.value;
            if (nextId === universeId) return;
            setUniverse(null);
            setLoading(!!nextId);
            setDraft((d) => ({ ...d, universeId: nextId }));
            setError('');
          }}>
            <option value="">No universe</option>
            {universeId && !lists.universes.some((u) => u.id === universeId) && <option value={universeId}>Selected universe</option>}
            {lists.universes.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          {universeId && <Link className="text-xs text-port-accent" target="_blank" to={`/universes/${encodeURIComponent(universeId)}`}>Edit universe canon</Link>}
        </div>
      </div>
      {loading && <p className="text-xs">Loading canon…</p>}
      {universeReady && universe && <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">{kinds.map(([kind, label]) => <div key={kind}>
        <label htmlFor={idFor(`pick-${kind}`)} className="text-xs">Select {label.toLowerCase()}</label>
        <select id={idFor(`pick-${kind}`)} value="" className={inputClass} disabled={subjects.length >= 24} onChange={(e) => {
          const entry = (universe[fields[kind]] || []).find((item) => item.id === e.target.value);
          if (entry) add(kind, entry.name, entry.physicalDescription || entry.description, entry);
        }}><option value="">Add from universe…</option>{(universe[fields[kind]] || []).filter((entry) => !subjects.some((s) => s.canonId === entry.id && s.kind === kind)).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select>
      </div>)}</div>}
      <p className="text-xs text-port-text-muted">Up to 24 subjects. Selected canon images are added as look references when space is available; enable “Condition frames” in Look references to use their pixels.</p>
      <ul className="space-y-2">{subjects.map((subject) => <li key={subject.id} className="border border-port-border rounded p-2 space-y-1">
        <div className="flex flex-wrap items-center gap-2"><span className="text-sm min-w-0 flex-1 break-words">{subject.name} · {subject.kind}</span>
          {subject.kind === 'character' && <><label htmlFor={idFor(subject.id)} className="sr-only">Role for {subject.name}</label><select id={idFor(subject.id)} className="bg-port-bg border border-port-border rounded text-xs" value={subject.role || 'supporting'} onChange={(e) => setDraft((d) => ({ ...d, subjects: d.subjects.map((s) => s.id === subject.id ? { ...s, role: e.target.value } : s) }))}><option value="protagonist">Protagonist</option><option value="band">Band</option><option value="supporting">Supporting</option></select></>}
          <button type="button" aria-label={`Remove ${subject.name}`} className="ml-auto text-xs text-port-error min-h-[44px]" onClick={() => setDraft((d) => ({ ...d, subjects: d.subjects.filter((s) => s.id !== subject.id) }))}>Remove</button>
        </div>
        <label htmlFor={idFor(`description-${subject.id}`)} className="sr-only">Description for {subject.name}</label>
        <textarea id={idFor(`description-${subject.id}`)} rows={2} maxLength={1000} className={inputClass} value={subject.description || ''} onChange={(e) => setDraft((d) => ({ ...d, subjects: d.subjects.map((s) => s.id === subject.id ? { ...s, description: e.target.value } : s) }))} />
      </li>)}</ul>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div><label htmlFor={idFor('kind')} className="text-xs">Create for this video</label><select id={idFor('kind')} className={inputClass} value={newKind} onChange={(e) => setNewKind(e.target.value)}>{kinds.map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></div>
        <div><label htmlFor={idFor('name')} className="text-xs">Name</label><input id={idFor('name')} maxLength={120} className={inputClass} value={newName} onChange={(e) => setNewName(e.target.value)} /></div>
      </div>
      <label htmlFor={idFor('description')} className="block text-xs">Appearance / description</label><textarea id={idFor('description')} rows={2} maxLength={1000} className={inputClass} value={newDescription} onChange={(e) => setNewDescription(e.target.value)} />
      <button type="button" className="text-port-accent text-sm min-h-[44px]" disabled={!newName.trim() || subjects.length >= 24} onClick={() => { add(newKind, newName, newDescription); setNewName(''); setNewDescription(''); }}>Add to production</button>
      {(newName.trim() || newDescription.trim()) && <p className="text-xs text-port-text-muted">Add the new subject to the production before saving.</p>}
      <div className="flex flex-wrap gap-3"><button type="button" onClick={save} disabled={!universeReady || !!newName.trim() || !!newDescription.trim()} className="bg-port-accent text-white rounded px-3 py-2 text-sm disabled:opacity-50">{saving ? 'Saving…' : 'Save creative setup'}</button><button type="button" onClick={() => setEditing(false)} className="text-sm">Cancel</button></div>
    </fieldset>}
    {!editing && project.productionPolicy?.strategy === 'code-first' && <p className="text-xs text-port-text-muted">Code-first plan · generated video allowance {formatCount(project.productionPolicy.maxGeneratedVideoPercent, { maximumFractionDigits: 3 })}% of final song time</p>}
    {!editing && conflict && <div role="status" className="rounded border border-port-warning/60 p-2 space-y-1">
      <p className="text-xs text-port-warning">{conflict.message}</p>
      <p className="text-xs text-port-text-muted">Generated video is not dispatched without a video tool. Existing approved plans and check-in sheets stay as saved until you replan.</p>
      <button type="button" onClick={replan} disabled={replanning} className="text-sm text-port-accent min-h-[44px] disabled:opacity-50">{replanning ? 'Replanning…' : 'Replan as code-first, no generated video'}</button>
    </div>}
    {error && <p role="alert" className="text-sm text-port-error">{error}</p>}
  </section>;
}

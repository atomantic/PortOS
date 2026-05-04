import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import toast from '../ui/Toast';
import {
  listWritersRoomCharacters,
  createWritersRoomCharacter,
  updateWritersRoomCharacter,
  deleteWritersRoomCharacter,
} from '../../services/apiWritersRoom';
import useMounted from '../../hooks/useMounted';

const CHARACTER_FIELDS = [
  { key: 'aliases',             label: 'Aliases',              placeholder: 'nicknames, titles (comma-separated)',                                                                  kind: 'csv' },
  { key: 'role',                label: 'Role',                 placeholder: 'protagonist, mentor, antagonist…',                                                                     kind: 'text' },
  { key: 'physicalDescription', label: 'Physical description', placeholder: 'Age, build, hair, eyes, distinctive features, signature wardrobe. Used directly in image-gen prompts.', kind: 'multiline' },
  { key: 'personality',         label: 'Personality',          placeholder: 'Temperament, voice, quirks',                                                                           kind: 'multiline' },
  { key: 'background',          label: 'Background',           placeholder: 'Who they are, where they come from',                                                                   kind: 'multiline' },
  { key: 'notes',               label: 'Notes',                placeholder: 'Anything else worth tracking',                                                                         kind: 'multiline' },
];

// Editable character bible — persistent across analysis runs and consumed by
// image gen to inject physicalDescription into per-scene prompts.
//
// Controlled vs. uncontrolled: caller may pass `characters` to keep multiple
// mounts in sync (e.g. drawer + storyboard chip count). When omitted we fetch
// and own the list so this can stand alone.
export default function CharactersBible({ workId, characters: charactersProp, onCharactersChange, readingTheme = 'dark' }) {
  const [internalCharacters, setInternalCharacters] = useState(charactersProp || []);
  const characters = charactersProp ?? internalCharacters;
  const [editingId, setEditingId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const mountedRef = useMounted();

  useEffect(() => {
    if (charactersProp) return;
    if (!workId) return;
    setLoading(true);
    listWritersRoomCharacters(workId)
      .then((list) => { if (mountedRef.current) setInternalCharacters(list); })
      .catch(() => { if (mountedRef.current) setInternalCharacters([]); })
      .finally(() => { if (mountedRef.current) setLoading(false); });
  }, [workId, charactersProp, mountedRef]);

  const upsert = (next) => {
    const update = (prev) => {
      const idx = prev.findIndex((c) => c.id === next.id);
      const sorted = (arr) => arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      if (idx < 0) return sorted([...prev, next]);
      const copy = [...prev];
      copy[idx] = next;
      return sorted(copy);
    };
    setInternalCharacters(update);
    onCharactersChange?.(update(characters));
  };

  const removeOne = (id) => {
    const next = characters.filter((c) => c.id !== id);
    setInternalCharacters(next);
    onCharactersChange?.(next);
  };

  return (
    <div className="text-xs">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] text-gray-500">
          {characters.length} character{characters.length === 1 ? '' : 's'} · Edits persist across re-runs and feed image gen.
        </div>
        <button
          onClick={() => { setCreating(true); setEditingId(null); }}
          className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-port-accent"
        >
          <Plus size={12} /> Add
        </button>
      </div>

      {loading && characters.length === 0 && (
        <div className="text-gray-500 italic">Loading…</div>
      )}

      {!loading && characters.length === 0 && !creating && (
        <div className="text-gray-500 italic px-1 mb-2">
          No profiles yet. Click "Refresh from prose" above to extract them, or add one manually.
        </div>
      )}

      {creating && (
        <CharacterEditor
          workId={workId}
          character={null}
          onSaved={(c) => { upsert(c); setCreating(false); }}
          onCancel={() => setCreating(false)}
        />
      )}

      <ul className="space-y-1.5">
        {characters.map((c) => {
          const isEditing = editingId === c.id;
          if (isEditing) {
            return (
              <li key={c.id}>
                <CharacterEditor
                  workId={workId}
                  character={c}
                  onSaved={(updated) => { upsert(updated); setEditingId(null); }}
                  onDeleted={() => { removeOne(c.id); setEditingId(null); }}
                  onCancel={() => setEditingId(null)}
                />
              </li>
            );
          }
          return (
            <li key={c.id} className="border border-port-border rounded">
              <CharacterRow character={c} onEdit={() => setEditingId(c.id)} readingTheme={readingTheme} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CharacterRow({ character, onEdit, readingTheme }) {
  const light = readingTheme === 'light';
  const blanks = CHARACTER_FIELDS.filter((f) => {
    if (f.key === 'notes' || f.key === 'aliases') return false;
    return !String(character[f.key] || '').trim();
  });
  return (
    <div className="px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`font-semibold ${light ? 'text-gray-900' : 'text-white'}`}>{character.name}</span>
            {character.role && (
              <span className="text-[9px] uppercase tracking-wider text-port-accent">{character.role}</span>
            )}
            {character.source === 'ai' && (
              <span className="text-[9px] text-gray-500" title="Created by AI extraction — edit to mark as user-curated">ai</span>
            )}
            {character.aliases?.length > 0 && (
              <span className="text-[10px] text-gray-500 truncate">aka {character.aliases.join(', ')}</span>
            )}
          </div>
          {character.physicalDescription ? (
            <div className={`text-[11px] mt-0.5 ${light ? 'text-gray-700' : 'text-gray-400'}`}>
              {character.physicalDescription}
            </div>
          ) : (
            <div className="text-[11px] mt-0.5 text-port-warning italic">No physical description — image gen will use scene context only</div>
          )}
          {blanks.length > 0 && (
            <div className="text-[10px] text-port-warning mt-1 flex items-center gap-1">
              <AlertTriangle size={9} /> Missing: {blanks.map((f) => f.label.toLowerCase()).join(', ')}
            </div>
          )}
          {character.missingFromProse?.length > 0 && (
            <div className="text-[10px] text-gray-500 mt-1">
              <span className="uppercase tracking-wider text-[9px]">Prose gaps:</span> {character.missingFromProse.join(', ')}
            </div>
          )}
        </div>
        <button
          onClick={onEdit}
          className="text-gray-500 hover:text-port-accent shrink-0"
          title="Edit profile"
          aria-label={`Edit ${character.name}`}
        >
          <Pencil size={11} />
        </button>
      </div>
    </div>
  );
}

function CharacterEditor({ workId, character, onSaved, onDeleted, onCancel }) {
  const isCreate = !character;
  const [draft, setDraft] = useState(() => {
    const seed = { name: character?.name || '' };
    for (const f of CHARACTER_FIELDS) {
      seed[f.key] = f.kind === 'csv' ? (character?.[f.key] || []).join(', ') : (character?.[f.key] || '');
    }
    return seed;
  });
  const [saving, setSaving] = useState(false);

  const set = (field) => (e) => setDraft((d) => ({ ...d, [field]: e.target.value }));

  const save = async () => {
    if (!draft.name.trim()) {
      toast.error('Name is required');
      return;
    }
    setSaving(true);
    const payload = { name: draft.name.trim() };
    for (const f of CHARACTER_FIELDS) {
      payload[f.key] = f.kind === 'csv'
        ? draft[f.key].split(',').map((s) => s.trim()).filter(Boolean)
        : draft[f.key];
    }
    const result = await (isCreate
      ? createWritersRoomCharacter(workId, payload)
      : updateWritersRoomCharacter(workId, character.id, payload)
    ).catch((err) => {
      toast.error(`Save failed: ${err.message}`);
      return null;
    });
    setSaving(false);
    if (!result) return;
    toast.success(`${result.name} saved`);
    onSaved?.(result);
  };

  const remove = async () => {
    if (!character) return;
    setSaving(true);
    const ok = await deleteWritersRoomCharacter(workId, character.id).then(() => true).catch((err) => {
      toast.error(`Delete failed: ${err.message}`);
      return false;
    });
    setSaving(false);
    if (ok) {
      toast.success(`${character.name} removed`);
      onDeleted?.();
    }
  };

  const inputCls = 'w-full bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200 focus:border-port-accent outline-none';

  return (
    <div className="border border-port-accent/40 rounded p-2 bg-port-card/40 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <input
          value={draft.name}
          onChange={set('name')}
          placeholder="Character name"
          className={`${inputCls} font-semibold`}
        />
        <button
          onClick={onCancel}
          className="text-gray-500 hover:text-white shrink-0"
          aria-label="Cancel edit"
          title="Cancel"
        >
          <X size={12} />
        </button>
      </div>
      {CHARACTER_FIELDS.map((f) => (
        <label key={f.key} className="block">
          <span className="text-[9px] uppercase tracking-wider text-gray-500">{f.label}</span>
          {f.kind === 'multiline' ? (
            <textarea value={draft[f.key]} onChange={set(f.key)} placeholder={f.placeholder} rows={f.key === 'physicalDescription' ? 3 : 2} className={`${inputCls} font-sans resize-y`} />
          ) : (
            <input value={draft[f.key]} onChange={set(f.key)} placeholder={f.placeholder} className={inputCls} />
          )}
        </label>
      ))}
      <div className="flex items-center justify-between pt-1">
        {!isCreate ? (
          <button
            onClick={remove}
            disabled={saving}
            className="flex items-center gap-1 text-[10px] text-port-error hover:underline disabled:opacity-50"
          >
            <Trash2 size={10} /> Delete
          </button>
        ) : <span />}
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1 px-2 py-1 bg-port-accent text-white rounded text-[10px] hover:bg-port-accent/80 disabled:opacity-50"
        >
          {saving ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />} Save
        </button>
      </div>
    </div>
  );
}

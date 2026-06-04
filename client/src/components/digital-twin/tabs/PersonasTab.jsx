import { useState, useEffect } from 'react';
import { Drama, Plus, Pencil, Trash2, Check, X, CheckCircle2, SlidersHorizontal } from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import * as api from '../../../services/api';
import toast from '../../ui/Toast';
import {
  describeTraitAdjustments,
  BIG_FIVE_LEAN,
  COMM_DELTA_MIN,
  COMM_DELTA_MAX,
  BIG_FIVE_DELTA_MIN,
  BIG_FIVE_DELTA_MAX,
  EMOJI_USAGE_VALUES
} from '../../../lib/personaTraitBlend.js';

const BIG_FIVE_KEYS = ['O', 'C', 'E', 'A', 'N'];
const BIG_FIVE_LABELS = { O: 'Openness', C: 'Conscientiousness', E: 'Extraversion', A: 'Agreeableness', N: 'Neuroticism' };

// The editor's working shape. '' / 0 mean "no override" for that field; the
// payload builder strips them so an untouched editor sends no traitAdjustments.
// Factories (not shared constants) so each form/reset gets its own nested
// objects — a shared reference would let one form's edits leak into another.
const makeEmptyAdjustments = () => ({ formality: 0, verbosity: 0, emojiUsage: '', tone: '', bigFive: { O: 0, C: 0, E: 0, A: 0, N: 0 } });
const makeEmptyForm = () => ({ name: '', description: '', instructions: '', adjustments: makeEmptyAdjustments() });

// Hydrate the editor shape from a stored persona's traitAdjustments.
function adjustmentsToForm(traitAdjustments) {
  const a = traitAdjustments || {};
  return {
    formality: a.formality ?? 0,
    verbosity: a.verbosity ?? 0,
    emojiUsage: a.emojiUsage ?? '',
    tone: a.tone ?? '',
    bigFive: BIG_FIVE_KEYS.reduce((acc, k) => ({ ...acc, [k]: a.bigFive?.[k] ?? 0 }), {})
  };
}

// Build the API payload from the editor shape, dropping no-op fields. Returns
// null when nothing is set so callers can clear adjustments to instructions-only.
function buildAdjustmentsPayload(adj) {
  const out = {};
  if (adj.formality) out.formality = adj.formality;
  if (adj.verbosity) out.verbosity = adj.verbosity;
  if (adj.emojiUsage) out.emojiUsage = adj.emojiUsage;
  if (adj.tone?.trim()) out.tone = adj.tone.trim();
  const bigFive = BIG_FIVE_KEYS.reduce((acc, k) => {
    if (adj.bigFive?.[k]) acc[k] = adj.bigFive[k];
    return acc;
  }, {});
  if (Object.keys(bigFive).length > 0) out.bigFive = bigFive;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Twin Personas (M34 P7). Named context variants whose instructions are
 * prepended to the embodied-twin context. The active persona flavors the
 * context that CoS agents see; identity-building flows stay persona-free.
 */
export default function PersonasTab({ onRefresh }) {
  const [personas, setPersonas] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState(makeEmptyForm());

  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(makeEmptyForm());

  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    const [personaData, active] = await Promise.all([
      api.getDigitalTwinPersonas({ silent: true }).catch(() => []),
      api.getActiveDigitalTwinPersona({ silent: true }).catch(() => null)
    ]);
    setPersonas(personaData);
    setActiveId(active?.id ?? null);
    setLoading(false);
  };

  const createPersona = async () => {
    if (!createForm.name.trim() || !createForm.instructions.trim()) {
      toast.error('Name and instructions are required');
      return;
    }
    setBusy(true);
    const traitAdjustments = buildAdjustmentsPayload(createForm.adjustments);
    const persona = await api.createDigitalTwinPersona({
      name: createForm.name.trim(),
      description: createForm.description.trim() || undefined,
      instructions: createForm.instructions.trim(),
      ...(traitAdjustments ? { traitAdjustments } : {})
    }).catch(() => null);
    setBusy(false);
    if (!persona) return;
    setPersonas(prev => [...prev, persona]);
    setCreateForm(makeEmptyForm());
    setShowCreate(false);
    toast.success('Persona created');
    onRefresh?.();
  };

  const startEdit = (persona) => {
    setEditingId(persona.id);
    setEditForm({
      name: persona.name,
      description: persona.description || '',
      instructions: persona.instructions,
      adjustments: adjustmentsToForm(persona.traitAdjustments)
    });
  };

  const saveEdit = async (id) => {
    if (!editForm.name.trim() || !editForm.instructions.trim()) {
      toast.error('Name and instructions are required');
      return;
    }
    setBusy(true);
    // null clears adjustments back to an instructions-only persona; an object replaces them.
    const traitAdjustments = buildAdjustmentsPayload(editForm.adjustments);
    const updated = await api.updateDigitalTwinPersona(id, {
      name: editForm.name.trim(),
      description: editForm.description.trim(),
      instructions: editForm.instructions.trim(),
      traitAdjustments
    }).catch(() => null);
    setBusy(false);
    if (!updated) return;
    setPersonas(prev => prev.map(p => (p.id === id ? updated : p)));
    setEditingId(null);
    toast.success('Persona updated');
    onRefresh?.();
  };

  const removePersona = async (id) => {
    setBusy(true);
    const ok = await api.deleteDigitalTwinPersona(id).then(() => true).catch(() => false);
    setBusy(false);
    setConfirmDeleteId(null);
    if (!ok) return;
    setPersonas(prev => prev.filter(p => p.id !== id));
    if (activeId === id) setActiveId(null); // server clears the active pointer too
    toast.success('Persona deleted');
    onRefresh?.();
  };

  const toggleActive = async (id) => {
    const next = activeId === id ? null : id;
    setBusy(true);
    const ok = await api.setActiveDigitalTwinPersona(next).then(() => true).catch(() => false);
    setBusy(false);
    if (!ok) return;
    setActiveId(next);
    toast.success(next ? 'Persona activated' : 'Persona deactivated');
    onRefresh?.();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading personas" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Drama className="w-5 h-5 text-port-accent" />
            Personas
          </h2>
          <p className="text-sm text-gray-500 mt-1 max-w-2xl">
            A persona is a named context (Professional, Casual, Family…) whose instructions are prepended to your twin.
            The <span className="text-gray-300">active</span> persona flavors the context your CoS agents act with — building your base identity stays unaffected.
          </p>
        </div>
        {!showCreate && (
          <button
            onClick={() => { setShowCreate(true); setCreateForm(makeEmptyForm()); }}
            className="flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] bg-port-accent text-white rounded-lg font-medium hover:bg-port-accent/80 shrink-0"
          >
            <Plus className="w-4 h-4" />
            New Persona
          </button>
        )}
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="bg-port-card rounded-lg border border-port-accent/30 p-4 space-y-3">
          <h3 className="font-semibold text-white">New Persona</h3>
          <PersonaForm form={createForm} setForm={setCreateForm} idPrefix="persona-create" />
          <div className="flex gap-2">
            <button
              onClick={createPersona}
              disabled={busy}
              className="flex items-center gap-2 px-4 py-2 min-h-[40px] bg-port-accent text-white rounded-lg hover:bg-port-accent/80 disabled:opacity-50"
            >
              <Check className="w-4 h-4" /> Create
            </button>
            <button
              onClick={() => { setShowCreate(false); setCreateForm(makeEmptyForm()); }}
              className="flex items-center gap-2 px-4 py-2 min-h-[40px] border border-port-border text-gray-400 rounded-lg hover:text-white"
            >
              <X className="w-4 h-4" /> Cancel
            </button>
          </div>
        </div>
      )}

      {/* Persona list */}
      {personas.length === 0 && !showCreate ? (
        <div className="flex flex-col items-center justify-center h-48 text-center text-gray-400">
          <Drama className="w-10 h-10 mb-3 text-gray-600" />
          <p className="max-w-md">No personas yet. Create one to give your twin a context — like a focused "Professional" voice or a relaxed "Family" tone — and activate it to shape how your agents speak and decide.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {personas.map(persona => {
            const isActive = activeId === persona.id;
            const isEditing = editingId === persona.id;
            const voiceTags = describeTraitAdjustments(persona.traitAdjustments);
            return (
              <div
                key={persona.id}
                className={`bg-port-card rounded-lg border p-4 ${isActive ? 'border-port-accent' : 'border-port-border'}`}
              >
                {isEditing ? (
                  <div className="space-y-3">
                    <PersonaForm form={editForm} setForm={setEditForm} idPrefix={`persona-edit-${persona.id}`} />
                    <div className="flex gap-2">
                      <button
                        onClick={() => saveEdit(persona.id)}
                        disabled={busy}
                        className="flex items-center gap-2 px-4 py-2 min-h-[40px] bg-port-accent text-white rounded-lg hover:bg-port-accent/80 disabled:opacity-50"
                      >
                        <Check className="w-4 h-4" /> Save
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="flex items-center gap-2 px-4 py-2 min-h-[40px] border border-port-border text-gray-400 rounded-lg hover:text-white"
                      >
                        <X className="w-4 h-4" /> Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-white">{persona.name}</span>
                          {isActive && (
                            <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-port-accent/20 text-port-accent">
                              <CheckCircle2 className="w-3 h-3" /> Active
                            </span>
                          )}
                        </div>
                        {persona.description && (
                          <p className="text-sm text-gray-400 mt-1">{persona.description}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => toggleActive(persona.id)}
                          disabled={busy}
                          className={`px-3 py-1.5 min-h-[36px] text-xs rounded-lg border transition-colors disabled:opacity-50 ${
                            isActive
                              ? 'border-port-accent text-port-accent hover:bg-port-accent/10'
                              : 'border-port-border text-gray-400 hover:text-white hover:border-gray-500'
                          }`}
                        >
                          {isActive ? 'Deactivate' : 'Set active'}
                        </button>
                        <button
                          onClick={() => startEdit(persona)}
                          aria-label="Edit persona"
                          className="p-2 min-h-[36px] text-gray-400 hover:text-white rounded-lg"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(persona.id)}
                          aria-label="Delete persona"
                          className="p-2 min-h-[36px] text-gray-400 hover:text-port-error rounded-lg"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    <p className="text-sm text-gray-300 mt-3 whitespace-pre-wrap bg-port-bg p-3 rounded">{persona.instructions}</p>

                    {voiceTags.length > 0 && (
                      <div className="mt-3 flex items-center gap-2 flex-wrap">
                        <span className="flex items-center gap-1 text-xs text-gray-500">
                          <SlidersHorizontal className="w-3.5 h-3.5" /> Voice:
                        </span>
                        {voiceTags.map((d, i) => (
                          <span key={i} className="text-xs px-2 py-0.5 rounded bg-port-bg border border-port-border text-gray-300">{d}</span>
                        ))}
                      </div>
                    )}

                    {confirmDeleteId === persona.id && (
                      <div className="flex items-center justify-between gap-3 mt-3 p-3 rounded bg-port-error/10 border border-port-error/30">
                        <span className="text-sm text-port-error">Delete "{persona.name}"?</span>
                        <div className="flex gap-2">
                          <button
                            onClick={() => removePersona(persona.id)}
                            disabled={busy}
                            className="px-3 py-1.5 min-h-[36px] text-xs bg-port-error/20 text-port-error rounded-lg hover:bg-port-error/30 disabled:opacity-50"
                          >
                            Delete
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="px-3 py-1.5 min-h-[36px] text-xs border border-port-border text-gray-400 rounded-lg hover:text-white"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PersonaForm({ form, setForm, idPrefix }) {
  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={`${idPrefix}-name`} className="block text-sm text-gray-400 mb-1">Name</label>
        <input
          id={`${idPrefix}-name`}
          type="text"
          value={form.name}
          onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
          placeholder="e.g. Professional"
          maxLength={100}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-description`} className="block text-sm text-gray-400 mb-1">Description <span className="text-gray-600">(optional)</span></label>
        <input
          id={`${idPrefix}-description`}
          type="text"
          value={form.description}
          onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))}
          placeholder="When to use this persona"
          maxLength={500}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-instructions`} className="block text-sm text-gray-400 mb-1">Instructions</label>
        <textarea
          id={`${idPrefix}-instructions`}
          value={form.instructions}
          onChange={(e) => setForm(f => ({ ...f, instructions: e.target.value }))}
          placeholder="How the twin should modulate voice and behavior in this context — e.g. 'Be concise and formal; avoid personal anecdotes; lead with the recommendation.'"
          rows={4}
          maxLength={5000}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none resize-y"
        />
      </div>
      <TraitAdjustmentsEditor
        idPrefix={idPrefix}
        adjustments={form.adjustments}
        setAdjustments={(updater) => setForm(f => ({ ...f, adjustments: updater(f.adjustments) }))}
      />
    </div>
  );
}

/**
 * Trait-blending editor (M34 P7). Lets a persona modulate the base twin's
 * quantitative voice for its context: relative formality/verbosity sliders,
 * an emoji override, a tone phrase, and directional Big-Five leans. A live
 * preview renders the same wording the embodied twin will see, via the shared
 * `describeTraitAdjustments` helper. Collapsed by default for instructions-only
 * personas; opens automatically when any adjustment is already set.
 */
function TraitAdjustmentsEditor({ idPrefix, adjustments, setAdjustments }) {
  const preview = describeTraitAdjustments(buildAdjustmentsPayload(adjustments) || {});
  const [open, setOpen] = useState(preview.length > 0);

  const setField = (key, value) => setAdjustments(a => ({ ...a, [key]: value }));
  const setBigFive = (key, value) => setAdjustments(a => ({ ...a, bigFive: { ...a.bigFive, [key]: value } }));
  const reset = () => setAdjustments(makeEmptyAdjustments);

  return (
    <div className="border border-port-border rounded-lg">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 min-h-[44px] text-left text-sm text-gray-300 hover:text-white"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4 text-port-accent" />
          Voice calibration <span className="text-gray-600">(optional)</span>
        </span>
        <span className="text-xs text-gray-500">{open ? 'Hide' : preview.length > 0 ? `${preview.length} set` : 'Add'}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-4 border-t border-port-border pt-3">
          <p className="text-xs text-gray-500">
            Nudge how your twin communicates in this context, relative to your base profile. Leave a slider at center for no change.
          </p>

          <SliderRow
            id={`${idPrefix}-formality`}
            label="Formality"
            hint={adjustments.formality > 0 ? 'more formal' : adjustments.formality < 0 ? 'more casual' : 'no change'}
            value={adjustments.formality}
            onChange={(v) => setField('formality', v)}
          />
          <SliderRow
            id={`${idPrefix}-verbosity`}
            label="Verbosity"
            hint={adjustments.verbosity > 0 ? 'more elaborate' : adjustments.verbosity < 0 ? 'more concise' : 'no change'}
            value={adjustments.verbosity}
            onChange={(v) => setField('verbosity', v)}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${idPrefix}-emoji`} className="block text-sm text-gray-400 mb-1">Emoji usage</label>
              <select
                id={`${idPrefix}-emoji`}
                value={adjustments.emojiUsage}
                onChange={(e) => setField('emojiUsage', e.target.value)}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
              >
                <option value="">No override</option>
                {EMOJI_USAGE_VALUES.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={`${idPrefix}-tone`} className="block text-sm text-gray-400 mb-1">Tone</label>
              <input
                id={`${idPrefix}-tone`}
                type="text"
                value={adjustments.tone}
                onChange={(e) => setField('tone', e.target.value)}
                placeholder="e.g. warm, crisp, playful"
                maxLength={100}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
              />
            </div>
          </div>

          <div>
            <span className="block text-sm text-gray-400 mb-1">Personality lean</span>
            <div className="space-y-2">
              {BIG_FIVE_KEYS.map(k => (
                <BigFiveRow
                  key={k}
                  id={`${idPrefix}-bigfive-${k}`}
                  label={BIG_FIVE_LABELS[k]}
                  more={BIG_FIVE_LEAN[k].more}
                  less={BIG_FIVE_LEAN[k].less}
                  value={adjustments.bigFive[k]}
                  onChange={(v) => setBigFive(k, v)}
                />
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 pt-1">
            <div className="text-xs text-gray-400 min-w-0">
              {preview.length > 0 ? (
                <span><span className="text-gray-500">Preview:</span> {preview.join(' · ')}</span>
              ) : (
                <span className="text-gray-600">No calibration set — this persona uses instructions only.</span>
              )}
            </div>
            {preview.length > 0 && (
              <button type="button" onClick={reset} className="text-xs text-gray-500 hover:text-port-error shrink-0">Clear</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// A -9..+9 relative slider centered on 0 (no change).
function SliderRow({ id, label, hint, value, onChange }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label htmlFor={id} className="text-sm text-gray-400">{label}</label>
        <span className="text-xs text-gray-500">{hint}</span>
      </div>
      <input
        id={id}
        type="range"
        min={COMM_DELTA_MIN}
        max={COMM_DELTA_MAX}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-port-accent"
      />
    </div>
  );
}

// Round a 0.1-step slider value to one decimal so float noise (0.1*3 = 0.30000…4)
// never reaches the persisted payload.
const roundTenth = (n) => Math.round(n * 10) / 10;

// A -1..+1 Big-Five lean slider (step 0.1), labeled with its directional poles.
function BigFiveRow({ id, label, more, less, value, onChange }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1 gap-2">
        <label htmlFor={id} className="text-sm text-gray-400 shrink-0">{label}</label>
        <span className="text-xs text-gray-500 truncate">
          {value > 0 ? more : value < 0 ? less : 'no change'}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={BIG_FIVE_DELTA_MIN}
        max={BIG_FIVE_DELTA_MAX}
        step={0.1}
        value={value}
        onChange={(e) => onChange(roundTenth(Number(e.target.value)))}
        className="w-full accent-port-accent"
      />
    </div>
  );
}

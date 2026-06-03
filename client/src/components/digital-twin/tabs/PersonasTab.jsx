import { useState, useEffect } from 'react';
import { Drama, Plus, Pencil, Trash2, Check, X, CheckCircle2 } from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import * as api from '../../../services/api';
import toast from '../../ui/Toast';

const EMPTY_FORM = { name: '', description: '', instructions: '' };

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
  const [createForm, setCreateForm] = useState(EMPTY_FORM);

  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);

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
    const persona = await api.createDigitalTwinPersona({
      name: createForm.name.trim(),
      description: createForm.description.trim() || undefined,
      instructions: createForm.instructions.trim()
    }).catch(() => null);
    setBusy(false);
    if (!persona) return;
    setPersonas(prev => [...prev, persona]);
    setCreateForm(EMPTY_FORM);
    setShowCreate(false);
    toast.success('Persona created');
    onRefresh?.();
  };

  const startEdit = (persona) => {
    setEditingId(persona.id);
    setEditForm({
      name: persona.name,
      description: persona.description || '',
      instructions: persona.instructions
    });
  };

  const saveEdit = async (id) => {
    if (!editForm.name.trim() || !editForm.instructions.trim()) {
      toast.error('Name and instructions are required');
      return;
    }
    setBusy(true);
    const updated = await api.updateDigitalTwinPersona(id, {
      name: editForm.name.trim(),
      description: editForm.description.trim(),
      instructions: editForm.instructions.trim()
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
            onClick={() => { setShowCreate(true); setCreateForm(EMPTY_FORM); }}
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
              onClick={() => { setShowCreate(false); setCreateForm(EMPTY_FORM); }}
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
    </div>
  );
}

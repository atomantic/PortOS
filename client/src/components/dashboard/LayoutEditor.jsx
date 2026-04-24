import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, ArrowUp, ArrowDown, Trash2, Plus, Save } from 'lucide-react';
import { useScrollLock } from '../../hooks/useScrollLock';
import { WIDGETS, WIDGETS_BY_ID } from './widgetRegistry.jsx';
import toast from '../ui/Toast';

// Keyboard-first editor. No drag-and-drop dep — reorder uses up/down buttons
// (keyboard + touch friendly). Delete and "save as new" use inline state
// instead of window.confirm/prompt per project convention.
// Fallback if the server didn't return limits (shouldn't happen, but keeps
// the editor functional in degraded states). Kept in sync with the server's
// ID_MAX_LENGTH by convention — the server value is authoritative.
const FALLBACK_ID_MAX = 60;

export default function LayoutEditor({ layouts, activeLayoutId, limits, onClose, onSave, onDelete, onDuplicate }) {
  const idMax = limits?.idMaxLength || FALLBACK_ID_MAX;
  const [editingId, setEditingId] = useState(activeLayoutId);
  const editing = layouts.find((l) => l.id === editingId);
  const [widgets, setWidgets] = useState(editing?.widgets ?? []);
  const [name, setName] = useState(editing?.name ?? '');
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState('idle'); // 'idle' | 'duplicate' | 'delete' | 'switch'
  const [dupName, setDupName] = useState('');
  const [pendingSwitchId, setPendingSwitchId] = useState(null);
  const closeRef = useRef(null);

  useScrollLock(true);

  useEffect(() => {
    requestAnimationFrame(() => closeRef.current?.focus());
  }, []);

  // Rehydrate draft state ONLY when the user switches layouts. Keyed on
  // `layouts` too would clobber in-flight edits every time the parent
  // refreshes the list after save — surprised the user on save-as-new.
  useEffect(() => {
    const cur = layouts.find((l) => l.id === editingId);
    if (!cur) return;
    setWidgets(cur.widgets);
    setName(cur.name);
    setDirty(false);
    setMode('idle');
    setDupName('');
    setPendingSwitchId(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  // Guard layout switches when there are unsaved edits: instead of silently
  // discarding the draft, surface an inline confirm in the footer.
  const requestSwitch = (id) => {
    if (id === editingId) return;
    if (dirty) {
      setPendingSwitchId(id);
      setMode('switch');
      return;
    }
    setEditingId(id);
  };

  const confirmSwitch = () => {
    if (!pendingSwitchId) { setMode('idle'); return; }
    setEditingId(pendingSwitchId); // rehydrate effect clears dirty/mode
  };

  const cancelSwitch = () => {
    setPendingSwitchId(null);
    setMode('idle');
  };

  const close = useCallback(() => { onClose(); }, [onClose]);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') close();
  };

  const move = (index, delta) => {
    setWidgets((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setDirty(true);
  };

  const remove = (id) => {
    setWidgets((prev) => prev.filter((w) => w !== id));
    setDirty(true);
  };

  const add = (id) => {
    setWidgets((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setDirty(true);
  };

  // Each async handler awaits an API write through onSave/onDuplicate/
  // onDelete. request() toasts failures centrally; swallow here so a
  // rejection from a sync click handler doesn't surface as unhandled.
  // On failure we keep dirty/mode state so the user can retry.
  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) { toast.error('Name required'); return; }
    const ok = await onSave({ id: editingId, name: trimmed, widgets }).then(() => true, () => false);
    if (!ok) return;
    setDirty(false);
    toast.success('Layout saved');
  };

  const commitDuplicate = async () => {
    const trimmed = dupName.trim();
    if (!trimmed) { toast.error('Name required'); return; }
    // Final id must fit the server's idMax. Suffix grows with collisions
    // (-2, -10, -100) so the base is trimmed per iteration.
    const baseSlug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!baseSlug) { toast.error('Use letters/numbers in the name'); return; }
    const fitId = (n) => {
      if (n <= 1) return baseSlug.slice(0, idMax);
      const suffix = `-${n}`;
      return `${baseSlug.slice(0, idMax - suffix.length)}${suffix}`;
    };
    const existingIds = new Set(layouts.map((l) => l.id));
    let n = 1;
    let id = fitId(n);
    while (existingIds.has(id)) { n += 1; id = fitId(n); }
    const ok = await onDuplicate({ id, name: trimmed, widgets }).then(() => true, () => false);
    if (!ok) return;
    setEditingId(id);
    setMode('idle');
    toast.success('New layout created');
  };

  const commitDelete = async () => {
    const ok = await onDelete(editingId).then(() => true, () => false);
    if (!ok) return;
    const remaining = layouts.filter((l) => l.id !== editingId);
    setMode('idle');
    if (remaining.length > 0) setEditingId(remaining[0].id);
    else close();
  };

  const available = WIDGETS.filter((w) => !widgets.includes(w.id));

  const overlay = (
    <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-[10vh]" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-black/60" onClick={close} aria-hidden="true" />

      <div role="dialog" aria-modal="true" aria-labelledby="layout-editor-title" className="relative w-full max-w-3xl mx-4 bg-port-card rounded-xl border border-port-border shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-port-border">
          <h2 id="layout-editor-title" className="text-sm font-semibold text-white">Edit Layouts</h2>
          <button ref={closeRef} onClick={close} className="p-1 text-gray-500 hover:text-white transition-colors rounded" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-0 max-h-[70vh] overflow-hidden">
          <div className="border-r border-port-border overflow-y-auto">
            {layouts.map((l) => (
              <button
                key={l.id}
                onClick={() => requestSwitch(l.id)}
                className={`w-full text-left px-4 py-2 text-sm border-l-2 ${
                  l.id === editingId ? 'border-port-accent bg-white/5 text-white' : 'border-transparent text-gray-400 hover:bg-white/5 hover:text-white'
                }`}
              >
                <div className="truncate">{l.name}</div>
                {l.builtIn && <div className="text-[10px] text-gray-500 uppercase">Built-in</div>}
              </button>
            ))}
          </div>

          <div className="sm:col-span-2 p-4 overflow-y-auto space-y-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); setDirty(true); }}
                className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:border-port-accent outline-hidden"
              />
            </div>

            <div>
              <h3 className="text-xs text-gray-400 uppercase tracking-wide mb-2">Widgets ({widgets.length})</h3>
              <ul className="space-y-1">
                {widgets.map((id, idx) => {
                  const meta = WIDGETS_BY_ID[id];
                  return (
                    <li key={id} className="flex items-center gap-2 bg-port-bg border border-port-border rounded-lg px-3 py-2">
                      <span className="flex-1 text-sm text-white truncate">
                        {meta?.label ?? id}
                        {!meta && <span className="ml-2 text-xs text-port-warning">(unknown — skipped)</span>}
                      </span>
                      <button onClick={() => move(idx, -1)} disabled={idx === 0} className="p-1 rounded text-gray-400 hover:text-white disabled:opacity-30 disabled:hover:text-gray-400" aria-label="Move up"><ArrowUp size={14} /></button>
                      <button onClick={() => move(idx, 1)} disabled={idx === widgets.length - 1} className="p-1 rounded text-gray-400 hover:text-white disabled:opacity-30 disabled:hover:text-gray-400" aria-label="Move down"><ArrowDown size={14} /></button>
                      <button onClick={() => remove(id)} className="p-1 rounded text-gray-400 hover:text-port-error" aria-label="Remove widget"><Trash2 size={14} /></button>
                    </li>
                  );
                })}
                {widgets.length === 0 && (
                  <li className="text-sm text-gray-500 py-4 text-center">No widgets — add some below</li>
                )}
              </ul>
            </div>

            {available.length > 0 && (
              <div>
                <h3 className="text-xs text-gray-400 uppercase tracking-wide mb-2">Add widget</h3>
                <div className="flex flex-wrap gap-2">
                  {available.map((w) => (
                    <button
                      key={w.id}
                      onClick={() => add(w.id)}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-port-bg border border-port-border text-xs text-gray-300 hover:border-port-accent hover:text-white transition-colors"
                    >
                      <Plus size={12} />
                      <span>{w.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2 px-5 py-3 border-t border-port-border">
          {mode === 'duplicate' && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={dupName}
                autoFocus
                onChange={(e) => setDupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitDuplicate(); }
                  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMode('idle'); }
                }}
                placeholder="Name for new layout"
                className="flex-1 bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:border-port-accent outline-hidden"
              />
              <button onClick={commitDuplicate} className="px-3 py-1.5 text-sm rounded-lg bg-port-accent text-white hover:bg-port-accent/80">Create</button>
              <button onClick={() => setMode('idle')} className="px-3 py-1.5 text-sm text-gray-300 hover:text-white rounded-lg border border-port-border">Cancel</button>
            </div>
          )}
          {mode === 'delete' && (
            <div className="flex items-center gap-2">
              <span className="flex-1 text-sm text-port-error">Delete &ldquo;{editing?.name}&rdquo;? This can&apos;t be undone.</span>
              <button onClick={commitDelete} className="px-3 py-1.5 text-sm rounded-lg bg-port-error text-white hover:bg-port-error/80">Delete</button>
              <button onClick={() => setMode('idle')} className="px-3 py-1.5 text-sm text-gray-300 hover:text-white rounded-lg border border-port-border">Cancel</button>
            </div>
          )}
          {mode === 'switch' && (
            <div className="flex items-center gap-2">
              <span className="flex-1 text-sm text-port-warning">Discard unsaved changes to &ldquo;{editing?.name}&rdquo;?</span>
              <button onClick={confirmSwitch} className="px-3 py-1.5 text-sm rounded-lg bg-port-warning text-black hover:bg-port-warning/80">Discard</button>
              <button onClick={cancelSwitch} className="px-3 py-1.5 text-sm text-gray-300 hover:text-white rounded-lg border border-port-border">Cancel</button>
            </div>
          )}
          {mode === 'idle' && (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setDupName(`${name} (copy)`); setMode('duplicate'); }}
                  className="px-3 py-1.5 text-sm text-gray-300 hover:text-white rounded-lg border border-port-border hover:border-gray-600"
                >
                  Save as new…
                </button>
                {editing && !editing.builtIn && (
                  <button
                    onClick={() => setMode('delete')}
                    className="px-3 py-1.5 text-sm text-port-error hover:bg-port-error/10 rounded-lg border border-port-border"
                  >
                    Delete
                  </button>
                )}
              </div>
              <button
                onClick={save}
                disabled={!dirty}
                className="flex items-center gap-1.5 px-4 py-1.5 text-sm rounded-lg bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-40"
              >
                <Save size={14} />
                <span>Save</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}

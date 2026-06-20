import { useState, useEffect, useRef, useCallback } from 'react';
import { X, ArrowUp, ArrowDown, Trash2, Plus, Save, Clock } from 'lucide-react';
import { useScrollLock } from '../../hooks/useScrollLock';
import { WIDGETS, WIDGETS_BY_ID } from './widgetRegistry.jsx';
import { isValidTimeString, MORNING_DEFAULT_WINDOW } from '../../utils/timeWindow.js';
import toast from '../ui/Toast';
import Modal from '../ui/Modal';

// Keyboard-first editor. No drag-and-drop dep — reorder uses up/down buttons
// (keyboard + touch friendly). Delete and "save as new" use inline state
// instead of window.confirm/prompt per project convention.
// Fallback if the server didn't return limits (shouldn't happen, but keeps
// the editor functional in degraded states). Kept in sync with the server's
// ID_MAX_LENGTH by convention — the server value is authoritative.
const FALLBACK_ID_MAX = 60;
const FALLBACK_NAME_MAX = 80;
const FALLBACK_WIDGETS_MAX = 50;

export default function LayoutEditor({ layouts, activeLayoutId, limits, onClose, onSave, onDelete, onDuplicate }) {
  const idMax = limits?.idMaxLength || FALLBACK_ID_MAX;
  const nameMax = limits?.nameMaxLength || FALLBACK_NAME_MAX;
  const widgetsMax = limits?.widgetsMax || FALLBACK_WIDGETS_MAX;
  const [editingId, setEditingId] = useState(activeLayoutId);
  const editing = layouts.find((l) => l.id === editingId);
  const [widgets, setWidgets] = useState(editing?.widgets ?? []);
  const [name, setName] = useState(editing?.name ?? '');
  const [activateWindow, setActivateWindow] = useState(editing?.activateWindow ?? null);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState('idle'); // 'idle' | 'duplicate' | 'delete' | 'switch'
  const [dupName, setDupName] = useState('');
  const [pendingSwitchId, setPendingSwitchId] = useState(null);
  const closeRef = useRef(null);

  useScrollLock(true);

  useEffect(() => {
    requestAnimationFrame(() => closeRef.current?.focus());
  }, []);

  // Rehydrate draft state when the user switches layouts OR when the
  // `layouts` prop changes (e.g. "Save as new…" calls setEditingId(newId)
  // before the parent's setLayouts has propagated; this effect re-runs
  // once the new entry lands so the editor shows its name/widgets).
  // The `dirty` guard preserves in-flight edits across unrelated parent
  // refreshes (palette-triggered layout switches, socket events, etc.).
  useEffect(() => {
    const cur = layouts.find((l) => l.id === editingId);
    if (!cur) return;
    if (dirty) return;
    setWidgets(cur.widgets);
    setName(cur.name);
    setActivateWindow(cur.activateWindow ?? null);
    setMode('idle');
    setDupName('');
    setPendingSwitchId(null);
  }, [editingId, layouts]);

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
    setDirty(false); // user chose to discard; lets the rehydrate effect run
    setEditingId(pendingSwitchId);
  };

  const cancelSwitch = () => {
    setPendingSwitchId(null);
    setMode('idle');
  };

  const close = useCallback(() => { onClose(); }, [onClose]);

  // Inline modes (duplicate-name input, delete confirm, switch confirm) need
  // Esc to cancel just the inline state, not close the whole editor. The
  // inputs' own onKeyDown handlers DO see Esc first (Modal's window listener
  // is bubble-phase) and call preventDefault() — and our Modal honours
  // `defaultPrevented` by skipping the close. But relying on every inline
  // handler to remember preventDefault is fragile. Cleaner: hand Modal a
  // single `onEsc` that maps Esc to `setMode('idle')` while a mode is
  // active, falling back to close() at the top level. This works regardless
  // of whether the focused element has its own onKeyDown.
  const handleEsc = useCallback(() => {
    if (mode !== 'idle') { setMode('idle'); return; }
    close();
  }, [mode, close]);

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
    if (widgets.includes(id)) return;
    // Match server's Zod cap so users don't hit a 400 on Save after
    // silently accumulating past the limit.
    if (widgets.length >= widgetsMax) {
      toast.error(`Layouts are capped at ${widgetsMax} widgets`);
      return;
    }
    setWidgets([...widgets, id]);
    setDirty(true);
  };

  // Each async handler awaits an API write through onSave/onDuplicate/
  // onDelete. request() toasts failures centrally; swallow here so a
  // rejection from a sync click handler doesn't surface as unhandled.
  // On failure we keep dirty/mode state so the user can retry.
  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) { toast.error('Name required'); return; }
    if (activateWindow && !(isValidTimeString(activateWindow.start) && isValidTimeString(activateWindow.end) && activateWindow.start !== activateWindow.end)) {
      toast.error('Time window: start and end must be HH:MM and differ');
      return;
    }
    const ok = await onSave({ id: editingId, name: trimmed, widgets, activateWindow }).then(() => true, () => false);
    if (!ok) return;
    setDirty(false);
    toast.success('Layout saved');
  };

  const updateWindowField = (field, value) => {
    setActivateWindow((prev) => {
      const next = { ...(prev ?? { start: '', end: '' }), [field]: value };
      if (!next.start && !next.end) return null;
      return next;
    });
    setDirty(true);
  };
  const clearWindow = () => { setActivateWindow(null); setDirty(true); };
  const setMorningDefault = () => { setActivateWindow({ ...MORNING_DEFAULT_WINDOW }); setDirty(true); };

  const commitDuplicate = async () => {
    const trimmed = dupName.trim();
    if (!trimmed) { toast.error('Name required'); return; }
    // Final id must fit the server's idMax. Suffix grows with collisions
    // (-2, -10, -100) so the base is trimmed per iteration. Strip trailing
    // dashes after slicing so a boundary mid-dash doesn't produce a
    // trailing dash (`foo-`) or, combined with the suffix, a double-dash
    // (`foo--2`) — both violate the server's ID_PATTERN.
    const baseSlug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!baseSlug) { toast.error('Use letters/numbers in the name'); return; }
    const fitId = (n) => {
      const suffix = n <= 1 ? '' : `-${n}`;
      const body = baseSlug.slice(0, idMax - suffix.length).replace(/-+$/g, '');
      return `${body}${suffix}`;
    };
    const existingIds = new Set(layouts.map((l) => l.id));
    let n = 1;
    let id = fitId(n);
    while (existingIds.has(id)) { n += 1; id = fitId(n); }
    // Duplicate inherits the source's activateWindow — easier to clear post-duplicate than to re-enter.
    const ok = await onDuplicate({ id, name: trimmed, widgets, activateWindow }).then(() => true, () => false);
    if (!ok) return;
    // The duplicate IS saved — clear dirty so the rehydrate effect runs
    // when the new layout lands in `layouts` props; otherwise the editor
    // could show stale name/widgets for the new id.
    setDirty(false);
    setEditingId(id);
    setMode('idle');
    toast.success('New layout created');
  };

  const commitDelete = async () => {
    const ok = await onDelete(editingId).then(() => true, () => false);
    if (!ok) return;
    const remaining = layouts.filter((l) => l.id !== editingId);
    // The layout we were editing is gone — any in-flight edits on it are
    // meaningless. Clear dirty so the rehydrate effect can sync to the
    // next selected layout (otherwise the guard would leave stale state).
    setDirty(false);
    setMode('idle');
    if (remaining.length > 0) setEditingId(remaining[0].id);
    else close();
  };

  const available = WIDGETS.filter((w) => !widgets.includes(w.id));

  return (
    <Modal
      open
      onClose={close}
      onEsc={handleEsc}
      size="xl"
      align="top"
      usePortal
      zIndexClassName="z-[9999]"
      backdropClassName="bg-black/60"
      ariaLabelledBy="layout-editor-title"
      panelClassName="bg-port-card rounded-xl border border-port-border shadow-2xl overflow-hidden"
    >
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
              <label htmlFor="layout-editor-name" className="block text-xs text-gray-400 mb-1">Name</label>
              <input
                id="layout-editor-name"
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); setDirty(true); }}
                maxLength={nameMax}
                className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:border-port-accent outline-hidden"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="layout-editor-window-start" className="text-xs text-gray-400 flex items-center gap-1.5">
                  <Clock size={12} aria-hidden="true" />
                  Auto-activate window
                </label>
                {!activateWindow && (
                  <button
                    type="button"
                    onClick={setMorningDefault}
                    className="text-xs text-port-accent hover:text-port-accent/80"
                  >
                    Set as morning default
                  </button>
                )}
                {activateWindow && (
                  <button
                    type="button"
                    onClick={clearWindow}
                    className="text-xs text-gray-500 hover:text-port-error"
                  >
                    Clear
                  </button>
                )}
              </div>
              {activateWindow ? (
                <div className="flex items-center gap-2 text-sm">
                  <input
                    id="layout-editor-window-start"
                    type="time"
                    value={activateWindow.start}
                    onChange={(e) => updateWindowField('start', e.target.value)}
                    className="bg-port-bg border border-port-border rounded-lg px-2 py-1.5 text-white focus:border-port-accent outline-hidden"
                  />
                  <span className="text-gray-500">to</span>
                  <input
                    id="layout-editor-window-end"
                    type="time"
                    value={activateWindow.end}
                    onChange={(e) => updateWindowField('end', e.target.value)}
                    className="bg-port-bg border border-port-border rounded-lg px-2 py-1.5 text-white focus:border-port-accent outline-hidden"
                  />
                  <span className="text-xs text-gray-500 ml-2">Activates on dashboard load if now is in this window.</span>
                </div>
              ) : (
                <p className="text-xs text-gray-500">No auto-activation. Set a window to make this layout the default during specific hours.</p>
              )}
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
                maxLength={nameMax}
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
    </Modal>
  );
}

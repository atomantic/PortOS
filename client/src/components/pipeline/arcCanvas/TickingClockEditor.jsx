import { Plus, Trash2, Clock } from 'lucide-react';

// Mirror of TICKING_CLOCK_KINDS in server/lib/storyArc.js. The server is the
// validation authority (unknown kinds fall back to 'custom'); this list only
// drives the picker options.
const TICKING_CLOCK_KINDS = ['deadline', 'event', 'countdown', 'prophecy', 'bomb', 'custom'];

// Inline editor for the arc's singular ticking clock / countdown. Edits merge
// into a single `tickingClock` object the parent stores under `draft`; the
// reminder beats themselves are authored via the reader map, so this editor
// shows their count but doesn't manage the list.
export default function TickingClockEditor({ clock, disabled, onChange }) {
  const c = clock || {};
  const enabled = c.enabled === true;
  const patch = (p) => onChange({ ...c, ...p });
  const numOrNull = (v) => (v === '' ? null : Math.max(0, Math.min(9999, Math.floor(Number(v) || 0))));
  const reminders = Array.isArray(c.reminders) ? c.reminders : [];
  // Mint an `rm-`-prefixed id the server sanitizer accepts verbatim (its
  // ensureRmId regex is /^rm-[a-zA-Z0-9-]+$/). Avoid crypto.randomUUID — the app
  // is reachable over plain HTTP via Tailscale, where it's unavailable.
  const newReminderId = () => `rm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const addReminder = () => patch({ reminders: [...reminders, { id: newReminderId(), note: '', atIssue: null }] });
  const updateReminder = (idx, field, value) => patch({ reminders: reminders.map((r, i) => (i === idx ? { ...r, [field]: value } : r)) });
  const removeReminder = (idx) => patch({ reminders: reminders.filter((_, i) => i !== idx) });
  return (
    <fieldset className="rounded border border-port-border bg-port-bg/50 p-2 space-y-2">
      <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
        <span className="inline-flex items-center gap-1.5"><Clock size={12} /> Ticking clock / countdown</span>
      </label>
      {enabled ? (
        <div className="space-y-2 pl-1">
          <input
            id="ticking-clock-label"
            type="text"
            value={c.label || ''}
            onChange={(e) => patch({ label: e.target.value })}
            placeholder="What the reader counts down to (e.g. “The storm makes landfall”)"
            maxLength={200}
            disabled={disabled}
            className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
          />
          <div className="flex flex-wrap gap-x-3 gap-y-2">
            <div className="flex items-center gap-1.5">
              <label htmlFor="ticking-clock-kind" className="text-[10px] uppercase tracking-wider text-gray-500">Kind</label>
              <select
                id="ticking-clock-kind"
                value={c.kind || 'custom'}
                onChange={(e) => patch({ kind: e.target.value })}
                disabled={disabled}
                className="px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
              >
                {TICKING_CLOCK_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <label htmlFor="ticking-clock-planted" className="text-[10px] uppercase tracking-wider text-gray-500">Planted at</label>
              <input
                id="ticking-clock-planted"
                type="number"
                min={0}
                max={9999}
                value={c.plantedAtArcPosition ?? ''}
                onChange={(e) => patch({ plantedAtArcPosition: numOrNull(e.target.value) })}
                disabled={disabled}
                className="w-20 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label htmlFor="ticking-clock-due" className="text-[10px] uppercase tracking-wider text-gray-500">Due at</label>
              <input
                id="ticking-clock-due"
                type="number"
                min={0}
                max={9999}
                value={c.dueAtArcPosition ?? ''}
                onChange={(e) => patch({ dueAtArcPosition: numOrNull(e.target.value) })}
                disabled={disabled}
                className="w-20 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
              />
            </div>
          </div>
          <textarea
            id="ticking-clock-stakes"
            value={c.stakes || ''}
            onChange={(e) => patch({ stakes: e.target.value })}
            placeholder="Stakes — what happens if the clock runs out"
            rows={2}
            maxLength={1000}
            disabled={disabled}
            className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
          />
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">Reminder beats</span>
              <button
                type="button"
                onClick={addReminder}
                disabled={disabled}
                className="inline-flex items-center gap-1 text-[11px] text-port-accent hover:underline disabled:opacity-50"
              >
                <Plus size={11} /> Add reminder
              </button>
            </div>
            {reminders.length === 0 ? (
              <p className="text-[10px] text-gray-500 italic">No reminders yet — add beats that keep the countdown in the reader’s mind through the middle.</p>
            ) : (
              reminders.map((r, idx) => (
                <div key={r.id || idx} className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={r.note || ''}
                    onChange={(e) => updateReminder(idx, 'note', e.target.value)}
                    placeholder="Reminder beat (e.g. “the barometer drops”)"
                    maxLength={500}
                    disabled={disabled}
                    aria-label={`Reminder ${idx + 1} note`}
                    className="flex-1 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
                  />
                  <input
                    type="number"
                    min={0}
                    max={9999}
                    value={r.atIssue ?? ''}
                    onChange={(e) => updateReminder(idx, 'atIssue', numOrNull(e.target.value))}
                    placeholder="Issue #"
                    disabled={disabled}
                    aria-label={`Reminder ${idx + 1} issue number`}
                    className="w-20 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => removeReminder(idx)}
                    disabled={disabled}
                    aria-label={`Remove reminder ${idx + 1}`}
                    className="p-1 text-gray-500 hover:text-port-error disabled:opacity-50"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </fieldset>
  );
}

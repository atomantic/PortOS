/**
 * Object↔character attachment editor (#1288) — the object-side analog of the
 * Relationships section in CharacterDetailEditor.jsx. Each attachment ties this
 * object to ONE character and captures the emotion / significance / origin of
 * that bond plus a `role` archetype.
 *
 * Self-contained collapsible section (mirrors CanonCard's WardrobeSection
 * toggle) so it can mount inside the object's CanonCard body. Needs the cast
 * (`characters`) to populate the target picker; the whole `attachments` array
 * is patched on every mutation (mirrors the relationship-link onPatch contract),
 * and text fields buffer via useFieldDraft and commit on blur.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2, Heart } from 'lucide-react';
import { BIBLE_LIMITS as L } from '../../lib/bibleLimits';
import useFieldDraft from '../../hooks/useFieldDraft';

// Mirrors `ATTACHMENT_ROLES` in server/lib/storyBible.js (#1288). The server
// sanitizer coerces an unrecognized value to 'custom', so adding a token here
// without the server side just means the UI offers a value the server folds
// back to custom.
const ATTACHMENT_ROLES = Object.freeze([
  'talisman', 'macguffin', 'memento', 'tool', 'symbol', 'custom',
]);

const SELECT_CLASS = 'flex-1 min-w-0 px-1.5 py-0.5 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50';
const INPUT_CLASS = 'w-full px-1.5 py-0.5 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50';

// One attachment row — character + role selects, an emotion input, and
// significance + origin prose. The character whose id this points at may have
// been deleted; show an explicit "(missing)" option so the dangling state is
// visible and repointable rather than silently snapping to the first character.
function AttachmentRow({ attachment, idx, characters, onUpdate, onRemove, disabled }) {
  const emotion = useFieldDraft(attachment.emotion || '', (v) => onUpdate({ emotion: v }));
  const significance = useFieldDraft(attachment.significance || '', (v) => onUpdate({ significance: v }));
  const origin = useFieldDraft(attachment.origin || '', (v) => onUpdate({ origin: v }));
  const targetMissing = !!attachment.characterId
    && !characters.some((c) => c.id === attachment.characterId);
  return (
    <div className="rounded border border-port-border bg-port-bg/40 p-2 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <select
          value={attachment.characterId || ''}
          onChange={(e) => onUpdate({ characterId: e.target.value })}
          disabled={disabled}
          aria-label={`attachment ${idx + 1} character`}
          className={SELECT_CLASS}
        >
          {targetMissing ? (
            <option value={attachment.characterId}>(missing: {attachment.characterId})</option>
          ) : null}
          {characters.map((c) => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
        </select>
        <select
          value={ATTACHMENT_ROLES.includes(attachment.role) ? attachment.role : 'custom'}
          onChange={(e) => onUpdate({ role: e.target.value })}
          disabled={disabled}
          aria-label={`attachment ${idx + 1} role`}
          className="w-28 shrink-0 px-1.5 py-0.5 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50"
        >
          {ATTACHMENT_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <button
          type="button" onClick={onRemove} disabled={disabled}
          title="Remove attachment" aria-label={`remove attachment ${idx + 1}`}
          className="shrink-0 text-gray-500 hover:text-port-error disabled:opacity-30"
        >
          <Trash2 size={12} />
        </button>
      </div>
      <input
        type="text" value={emotion.value} onChange={emotion.onChange} onBlur={emotion.onBlur}
        placeholder="emotion (e.g. grief, pride, guilt, longing)"
        maxLength={L.ATTACHMENT_EMOTION_MAX} disabled={disabled}
        aria-label={`attachment ${idx + 1} emotion`}
        className={INPUT_CLASS}
      />
      <textarea
        value={significance.value} onChange={significance.onChange} onBlur={significance.onBlur}
        placeholder="why it matters to THIS character"
        rows={2} maxLength={L.ATTACHMENT_SIGNIFICANCE_MAX} disabled={disabled}
        aria-label={`attachment ${idx + 1} significance`}
        className={INPUT_CLASS}
      />
      <textarea
        value={origin.value} onChange={origin.onChange} onBlur={origin.onBlur}
        placeholder="how they came to have it (backstory link)"
        rows={2} maxLength={L.ATTACHMENT_ORIGIN_MAX} disabled={disabled}
        aria-label={`attachment ${idx + 1} origin`}
        className={INPUT_CLASS}
      />
    </div>
  );
}

export default function ObjectAttachmentsEditor({ entry, characters = [], onPatch, disabled = false }) {
  const [open, setOpen] = useState(false);
  const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
  const cast = (Array.isArray(characters) ? characters : []).filter((c) => c?.id);
  const commit = (next) => onPatch?.({ attachments: next });
  const addAttachment = () => {
    if (!cast.length) return;
    setOpen(true);
    commit([...attachments, { characterId: cast[0].id, emotion: '', significance: '', origin: '', role: 'custom' }]);
  };
  const updateAttachment = (idx, patch) =>
    commit(attachments.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  const removeAttachment = (idx) => commit(attachments.filter((_, i) => i !== idx));

  // Hide entirely when there's nothing to show and no way to add (read-only +
  // empty). Otherwise the toggle is always available.
  if (disabled && attachments.length === 0) return null;

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-gray-500 hover:text-white"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <Heart size={10} />
        Attachments ({attachments.length})
      </button>
      {open ? (
        <div className="mt-1.5 pl-3 border-l border-port-border space-y-2">
          {attachments.length > 0 ? (
            attachments.map((attachment, idx) => (
              <AttachmentRow
                key={attachment.id || `att-${idx}`}
                attachment={attachment}
                idx={idx}
                characters={cast}
                onUpdate={(patch) => updateAttachment(idx, patch)}
                onRemove={() => removeAttachment(idx)}
                disabled={disabled}
              />
            ))
          ) : (
            <p className="text-[11px] text-gray-500 italic">No attachments yet.</p>
          )}
          {!disabled && (cast.length === 0 ? (
            <p className="text-[11px] text-gray-500 italic">
              Add a character to this universe to {attachments.length ? 're-point these attachments' : 'attach a character'}.
            </p>
          ) : (
            <button
              type="button" onClick={addAttachment}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border border-port-border text-gray-400 hover:text-white hover:border-gray-500"
            >
              <Plus size={10} /> Add attachment
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

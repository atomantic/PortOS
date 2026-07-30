/**
 * Shared sprite correction note (#2964, extended to every regeneration surface
 * by #3134).
 *
 * Every surface that can re-roll a render — the turnaround sheet, the main
 * reference, the 7 directional anchors, and each animation track's clips
 * (`walk` plus whatever the user's registry holds) — renders the SAME control
 * writing the SAME page-owned
 * `corrections` map (lifted to `Sprites.jsx`), so the placeholder, aria-label,
 * and updater shape live in one place and can't drift between surfaces.
 * `className` lets each host keep its own chrome (full grid tile vs. compact
 * toggle-revealed card).
 *
 * `onChange` receives a setState-style updater so it composes with the
 * page-owned `setCorrections` while preserving sibling notes.
 *
 * The map's KEY vocabulary and the request fragment live in
 * `client/src/lib/spriteCorrections.js` (pure, so the action-gating layer can
 * share them) and are re-exported here for the surfaces that already import
 * from this module.
 */

import { useState } from 'react';
import { NotebookPen } from 'lucide-react';

export {
  anchorCorrectionKey, walkCorrectionKey, trackCorrectionKey,
  MAIN_CORRECTION_KEY, AMBIENT_REFERENCE_CORRECTION_KEY,
  correctionPromptPayload,
} from '../../lib/spriteCorrections.js';

export default function CorrectionNote({
  noteKey, direction, value, onChange, onValueChange, placeholder, ariaLabel, className = '',
}) {
  // `direction` is the pre-#3134 spelling of the map key, kept so the anchor
  // grid's existing call sites read naturally.
  const key = noteKey ?? direction;
  return (
    <textarea
      value={value || ''}
      onChange={(e) => onValueChange
        ? onValueChange(e.target.value)
        : onChange((prev) => ({ ...prev, [key]: e.target.value }))}
      rows={2}
      aria-label={ariaLabel || `Correction guidance for the ${key} pose`}
      placeholder={placeholder || 'Correction (optional), e.g. no pocket on the right sleeve'}
      className={`w-full px-1.5 py-1 bg-port-bg border border-port-border rounded text-gray-300 placeholder-gray-600 resize-y focus:border-port-accent focus:outline-none ${className}`}
    />
  );
}

/**
 * The compact pill that reveals a note. Split out so a host whose layout puts
 * the toggle in an action ROW and the note BELOW it (the asset card) shares the
 * exact same button as the hosts that stack the two (`CorrectionNoteToggle`).
 */
export function CorrectionToggleButton({ open, onToggle, hasValue, label, text = null, className = '' }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${open ? 'Hide' : 'Show'} correction note for ${label}`}
      title={hasValue ? 'A correction is set — it will be applied on the next regenerate' : `Add a correction for the ${label} re-roll`}
      className={`flex items-center justify-center gap-1 px-1.5 py-0.5 text-[10px] bg-port-card border rounded hover:border-port-accent ${hasValue ? 'border-port-accent text-port-accent' : 'border-port-border text-gray-300'} ${className}`}
    >
      <NotebookPen className="w-3 h-3" />{text}
    </button>
  );
}

/**
 * Toggle + revealed note, stacked — the affordance every animation-track card
 * uses. Opens by default when a note already exists so a set correction is
 * never invisible. Keeps the note out of the way on the (common) blind-re-roll
 * path, which matters on cards that are already dense on mobile.
 */
export function CorrectionNoteToggle({
  noteKey, label, corrections, onChange, placeholder, toggleText = 'Correction', className = '',
}) {
  const value = corrections?.[noteKey] || '';
  const [open, setOpen] = useState(Boolean(value));
  return (
    <div className={`space-y-1 ${className}`}>
      <CorrectionToggleButton
        open={open}
        onToggle={() => setOpen((o) => !o)}
        hasValue={Boolean(value.trim())}
        label={label}
        text={toggleText}
        className="w-full"
      />
      {open && (
        <CorrectionNote
          noteKey={noteKey}
          value={value}
          onChange={onChange}
          ariaLabel={`Correction guidance for the ${label} re-roll`}
          placeholder={placeholder}
          className="text-[10px]"
        />
      )}
    </div>
  );
}

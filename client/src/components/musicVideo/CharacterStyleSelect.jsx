import { useEffect, useState } from 'react';
import { listMusicVideoCharacterStyles } from '../../services/apiMusicVideo.js';

const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';

/**
 * Character style choice for a project that does not exist yet (New music
 * video, Autonomous music video). The server casts the style's character as
 * protagonist and attaches this install's character sheet on create; the
 * sheet itself is chosen later on the Look step (CharacterStylePicker).
 */
export default function CharacterStyleSelect({ id, value, onChange }) {
  // null = not loaded yet; a failed fetch shows just "No character style".
  const [styles, setStyles] = useState(null);
  const style = (styles || []).find((s) => s.id === value) || null;

  useEffect(() => {
    let active = true;
    listMusicVideoCharacterStyles({ silent: true })
      .then((list) => { if (active) setStyles(list); })
      .catch(() => { if (active) setStyles([]); });
    return () => { active = false; };
  }, []);

  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-xs text-port-text-muted mb-1">Character style</label>
      <select id={id} value={value || ''} onChange={(e) => onChange(e.target.value)} className={inputClass}>
        <option value="">{styles === null ? 'Loading…' : 'No character style'}</option>
        {(styles || []).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      {style && (
        <p className="mt-1 text-xs text-port-text-muted">
          {style.characterName} is cast as protagonist.{' '}
          {style.referenceImageId
            ? 'Their character sheet is added as the character reference.'
            : 'No character sheet on this install yet; add one on the Look step.'}
        </p>
      )}
    </div>
  );
}

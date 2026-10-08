import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listMusicVideoCharacterStyles, setMusicVideoCharacterStyleReference } from '../../services/apiMusicVideo.js';

const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';

/**
 * Loads a built-in character style (a fixed-identity performer) as the
 * project's base concept. Saving the creative setup casts the style's
 * character as protagonist and adds this install's character sheet as a
 * character reference. The sheet is rendered through Image Gen and chosen
 * from the project's look references.
 */
export default function CharacterStylePicker({ project, value, onChange, idFor }) {
  const [styles, setStyles] = useState(null);
  const [error, setError] = useState('');
  const [savingSheet, setSavingSheet] = useState(false);
  const style = (styles || []).find((s) => s.id === value) || null;
  const images = [...new Set((project.visualSpec?.references || []).map((r) => r.imageId))];

  useEffect(() => {
    let active = true;
    listMusicVideoCharacterStyles({ silent: true })
      .then((list) => { if (active) setStyles(list); })
      .catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);

  const chooseSheet = (imageId) => {
    if (!style || !imageId) return;
    setSavingSheet(true);
    setError('');
    setMusicVideoCharacterStyleReference(style.id, imageId, { silent: true })
      .then((saved) => setStyles((list) => list.map((s) => (s.id === saved.id ? { ...s, referenceImageId: saved.referenceImageId } : s))))
      .catch((err) => setError(err.message || 'Could not set the character sheet'))
      .finally(() => setSavingSheet(false));
  };

  return <div className="space-y-2 min-w-0">
    <label htmlFor={idFor('character-style')} className="text-xs">Character style</label>
    <select id={idFor('character-style')} className={inputClass} value={value || ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">No character style</option>
      {value && !style && <option value={value}>Selected style</option>}
      {(styles || []).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
    </select>
    {style && <div className="border border-port-border rounded p-2 space-y-2 min-w-0">
      <p className="text-xs">{style.summary}</p>
      <p className="text-xs text-port-text-muted">{style.credit} · <a className="text-port-accent" href={style.sourceUrl} target="_blank" rel="noreferrer">character spec</a></p>
      {value !== (project.concept?.characterStyleId || '') && <p className="text-xs text-port-text-muted">{style.characterName} joins the cast as protagonist when you save.</p>}
      <div className="flex flex-wrap items-start gap-2">
        {style.referenceImageId
          ? <img src={`/data/images/${encodeURIComponent(style.referenceImageId)}`} alt={`${style.characterName} character sheet`} className="w-24 h-24 object-cover rounded bg-black shrink-0" />
          : <p className="text-xs text-port-text-muted flex-1 min-w-0">No character sheet on this install yet. Render one, add it under Look references, then choose it here.</p>}
        <div className="flex flex-col gap-1 min-w-0">
          <Link className="text-sm text-port-accent min-h-[44px] inline-flex items-center" to={`/media/image?${new URLSearchParams({ prompt: style.sheetPrompt })}`}>Render a character sheet</Link>
          {images.length > 0 && <>
            <label htmlFor={idFor('character-sheet')} className="text-xs">Use a look reference as the sheet</label>
            <select id={idFor('character-sheet')} className={inputClass} value="" disabled={savingSheet} onChange={(e) => chooseSheet(e.target.value)}>
              <option value="">Choose an image…</option>
              {images.map((imageId) => <option key={imageId} value={imageId}>{imageId}</option>)}
            </select>
          </>}
        </div>
      </div>
    </div>}
    {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
  </div>;
}

import { listMusicVideoCharacterStyles } from '../../services/apiMusicVideo.js';
import useListResource from '../../hooks/useListResource.js';
import ListLoadError from '../ui/ListLoadError.jsx';

const fetchStyles = () => listMusicVideoCharacterStyles({ silent: true });

const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';

/**
 * Character style choice for a project that does not exist yet (New music
 * video, Autonomous music video). The server casts the style's character as
 * protagonist and attaches this install's character sheet on create; the
 * sheet itself is chosen later on the Look step (CharacterStylePicker).
 */
export default function CharacterStyleSelect({ id, value, onChange }) {
  const { items: styles, state, error, retry } = useListResource(fetchStyles);
  const style = styles.find((s) => s.id === value) || null;

  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-xs text-port-text-muted mb-1">Character style</label>
      <select id={id} value={value || ''} onChange={(e) => onChange(e.target.value)} className={inputClass}>
        <option value="">{state === 'loading' ? 'Loading…' : 'No character style'}</option>
        {styles.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      {state === 'error' && <ListLoadError what="character styles" error={error} onRetry={retry} className="mt-1" />}
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

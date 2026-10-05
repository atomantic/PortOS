import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { getFilmStyle, listFilmStyles } from '../../services/api';

/**
 * "Film style" select for the Code Animation form (#10253). The catalog loads
 * once on mount; the full record of the chosen grammar loads on selection so
 * its native moves can be judged before an agent run is spent. A failed load
 * leaves the form usable with "None".
 */
export default function FilmStylePicker({ id, value, onChange, labelClass, inputClass }) {
  const [styles, setStyles] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    let live = true;
    listFilmStyles({ silent: true })
      .then((rows) => { if (live) setStyles(Array.isArray(rows) ? rows : []); })
      .catch((error) => { if (live) setLoadError(error?.message || 'Could not load film styles'); });
    return () => { live = false; };
  }, []);

  // A stored choice the catalog no longer carries must not reach the server.
  useEffect(() => {
    if (styles && value && !styles.some((style) => style.id === value)) onChange('');
  }, [styles, value, onChange]);

  const selected = styles?.find((style) => style.id === value) || null;

  useEffect(() => {
    if (!selected) return undefined;
    let live = true;
    getFilmStyle(selected.id, { silent: true })
      .then((record) => { if (live) setDetail(record); })
      .catch(() => { if (live) setDetail(null); });
    return () => { live = false; };
  }, [selected]);

  const moves = detail && detail.id === selected?.id ? detail.nativeMoves : null;

  return (
    <div>
      <label htmlFor={id} className={labelClass}>Film style <span className="text-gray-600">(optional medium recipe: rendering, camera and sound)</span></label>
      <select id={id} value={selected ? value : ''} onChange={(event) => onChange(event.target.value)} className={inputClass}>
        <option value="">None (derive from universe / notes)</option>
        {(styles || []).map((style) => <option key={style.id} value={style.id}>{style.label}</option>)}
      </select>
      {loadError && (
        <p role="alert" className="mt-1 flex items-center gap-1 text-xs text-port-error">
          <AlertTriangle className="h-3 w-3 shrink-0" /> Film styles unavailable: {loadError}. The form still works with None.
        </p>
      )}
      {selected && (
        <div className="mt-2 space-y-1 text-xs text-gray-400">
          <p>{selected.summary}</p>
          <details>
            <summary className="cursor-pointer text-gray-300">Native moves ({selected.nativeMoves.length})</summary>
            <ul className="mt-1 space-y-1">
              {(moves || selected.nativeMoves).map((move) => (
                <li key={move.name}>
                  <span className="text-gray-200">{move.name}</span>
                  {move.fitsContentLike && <span> — fits content like {move.fitsContentLike.join(', ')}</span>}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </div>
  );
}

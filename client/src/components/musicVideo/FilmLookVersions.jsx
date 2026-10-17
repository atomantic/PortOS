import { useEffect, useRef, useState } from 'react';
import { Check, Trash2 } from 'lucide-react';
import { deleteMusicVideoFilmLook, getMusicVideoFilmLooks } from '../../services/apiMusicVideo.js';
import { FILM_LOOK_PRESETS, describeFilmLook } from '../../lib/filmLook.js';
import { formatBytes } from '../../utils/formatters.js';

const BUTTON = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border bg-port-bg px-2 py-1.5 text-xs hover:bg-port-border/40 disabled:opacity-50 sm:min-h-0';
const presetLabel = (look) => FILM_LOOK_PRESETS.find((p) => p.id === look?.preset)?.label || 'Custom';

/**
 * The film looks rendered over the current takes, kept side by side: Use puts
 * one back on the video (the final render then only stitches its cached
 * shots), Delete frees its files. Shots with their own look are not counted.
 */
export default function FilmLookVersions({ project, onUse }) {
  const projectId = project?.id;
  const composed = project?.composition?.mode === 'composed';
  const lookKey = JSON.stringify(project?.filmLook ?? null);
  const [state, setState] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const ticket = useRef(0);

  useEffect(() => {
    if (!projectId || !composed) { setState(null); return undefined; }
    const mine = ++ticket.current;
    const timer = setTimeout(() => {
      getMusicVideoFilmLooks(projectId, { silent: true })
        .then((next) => { if (mine === ticket.current) setState(next); })
        .catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [projectId, composed, lookKey, project?.renderHistoryId]);

  const remove = (id) => {
    setBusyId(id);
    setError(null);
    ticket.current += 1;
    deleteMusicVideoFilmLook(projectId, id, { silent: true })
      .then(setState)
      .catch((err) => setError(err?.message || 'Could not delete that look'))
      .finally(() => setBusyId(null));
  };

  const looks = state?.looks || [];
  if (!state?.available || !looks.length) return null;
  return (
    <section aria-label="Film looks rendered" className="min-w-0 space-y-2 rounded border border-port-border p-2">
      <h4 className="text-xs font-medium">Film looks rendered</h4>
      {error && <p role="alert" className="break-words text-[11px] text-port-error">{error}</p>}
      <ul className="space-y-1.5">
        {looks.map((entry) => (
          <li key={entry.id} data-testid="film-look-version" className="flex flex-wrap items-center gap-2 text-xs">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{presetLabel(entry.look)}</span>
              {entry.current && <span className="ml-1.5 rounded bg-port-success/10 px-1.5 text-[11px] text-port-success">In use</span>}
              <span className="block truncate text-[11px] text-port-text-muted" title={describeFilmLook(entry.look)}>
                {entry.rendered} of {state.total} shots · {formatBytes(entry.bytes)}
              </span>
            </span>
            {!entry.current && (
              <button type="button" className={BUTTON} onClick={() => onUse(entry.look)} disabled={busyId != null}>
                <Check size={12} aria-hidden="true" /> Use
              </button>
            )}
            <button type="button" className={BUTTON} onClick={() => remove(entry.id)} disabled={busyId != null} aria-label={`Delete ${presetLabel(entry.look)} renders`}>
              <Trash2 size={12} aria-hidden="true" /> Delete
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

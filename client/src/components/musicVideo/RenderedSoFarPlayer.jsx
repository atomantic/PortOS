import { useEffect, useRef, useState } from 'react';
import { Activity, Play, RefreshCw, X } from 'lucide-react';
import { buildMusicVideoRenderPreview, musicVideoShotRenderUrl } from '../../services/apiMusicVideo.js';
import { useLocalStorageBool } from '../../hooks/useLocalStorageBool.js';
import { formatDurationSec } from '../../utils/formatters.js';

const BUTTON = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border bg-port-bg px-2 py-1.5 text-xs hover:bg-port-border/40 disabled:opacity-50 sm:min-h-0';

/**
 * The composed final render's shots finished so far, stitched in order up to
 * the first one still missing, with the song under them: a seam check while
 * the rest renders. Phone copy plays a lighter encode (film grain makes the
 * master heavy for a phone); off, it plays the exact shots.
 */
export default function RenderedSoFarPlayer({ project }) {
  const projectId = project?.id;
  const [light, setLight] = useLocalStorageBool('portos.musicVideo.renderedSoFar.light', false);
  const [preview, setPreview] = useState(null);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState(null);
  const generation = useRef(0);

  useEffect(() => { generation.current += 1; setPreview(null); setError(null); setBuilding(false); }, [projectId]);

  const build = (asLight = light) => {
    const ticket = ++generation.current;
    setBuilding(true);
    setError(null);
    buildMusicVideoRenderPreview(projectId, { light: asLight }, { silent: true })
      .then((next) => { if (ticket === generation.current) setPreview(next); })
      .catch((err) => { if (ticket === generation.current) setError(err?.message || 'Could not stitch the rendered shots'); })
      .finally(() => { if (ticket === generation.current) setBuilding(false); });
  };
  const pickLight = (next) => {
    setLight(next);
    if (preview) build(next);
  };

  if (project?.composition?.mode !== 'composed') return null;
  return (
    <section aria-label="Rendered so far" className="min-w-0 space-y-2 rounded border border-port-border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-xs font-medium">Rendered so far</h4>
        {preview && (
          <span data-testid="rendered-so-far-state" className="text-[11px] text-port-text-muted">
            {preview.complete ? 'Whole video' : `${preview.shots} of ${preview.totalShots} shots`} · {formatDurationSec(preview.durationSec)}
          </span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <label htmlFor={`rendered-so-far-light-${projectId}`} className="inline-flex min-h-[44px] items-center gap-1 text-[11px] text-port-text-muted sm:min-h-0">
            <input id={`rendered-so-far-light-${projectId}`} type="checkbox" checked={light} onChange={(e) => pickLight(e.target.checked)} disabled={building} /> Phone copy
          </label>
          {preview ? (
            <>
              {!preview.complete && (
                <button type="button" className={BUTTON} onClick={() => build()} disabled={building}>
                  {building ? <Activity size={12} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={12} aria-hidden="true" />} Update
                </button>
              )}
              <button type="button" className={BUTTON} onClick={() => setPreview(null)}>
                <X size={12} aria-hidden="true" /> Close
              </button>
            </>
          ) : (
            <button type="button" className={BUTTON} onClick={() => build()} disabled={building}>
              {building ? <Activity size={12} className="animate-spin" aria-hidden="true" /> : <Play size={12} aria-hidden="true" />} Play
            </button>
          )}
        </span>
      </div>
      {error && <p role="alert" className="break-words text-[11px] text-port-error">{error}</p>}
      {preview && (
        <video key={preview.name} src={musicVideoShotRenderUrl(projectId, preview.name)} controls autoPlay playsInline className="w-full rounded bg-black" />
      )}
    </section>
  );
}

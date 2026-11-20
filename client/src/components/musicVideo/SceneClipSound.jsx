import { useEffect, useState } from 'react';
import { CLIP_SOUND_DEFAULTS, CLIP_SOUND_FADE_RANGE, CLIP_SOUND_MUSIC_RANGE, CLIP_SOUND_VOLUME_RANGE, songClipSound } from '../../../../server/lib/musicVideo/musicVideoClipSound.js';
import { LevelSlider } from './ScenePreMusic.jsx';

/** Seconds a clip sound fades in or out over, saved when the field is left (0 or empty: no fade). */
function FadeField({ id, label, value, disabled, onCommit }) {
  const [text, setText] = useState(value ? String(value) : '');
  useEffect(() => { setText(value ? String(value) : ''); }, [value]);
  const commit = () => {
    const next = text.trim() === '' ? 0 : Number(text);
    if (!Number.isFinite(next) || next < CLIP_SOUND_FADE_RANGE.min || next > CLIP_SOUND_FADE_RANGE.max) { setText(value ? String(value) : ''); return; }
    const rounded = Math.round(next * 100) / 100;
    if (rounded !== (value || 0)) onCommit(rounded);
  };
  return (
    <span className="flex items-center gap-1">
      <label htmlFor={id} className="shrink-0 text-port-text-muted">{label}</label>
      <input id={id} type="number" inputMode="decimal" min={CLIP_SOUND_FADE_RANGE.min} max={CLIP_SOUND_FADE_RANGE.max} step={0.1}
        placeholder="0" value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        className="w-16 rounded border border-port-border bg-port-bg px-1.5 tabular-nums min-h-[44px] pointer-fine:sm:min-h-[28px] disabled:opacity-50" />
      <span className="text-port-text-muted">s</span>
    </span>
  );
}

/**
 * A song shot's own clip sound over the music (lib/musicVideo/musicVideoClipSound.js),
 * such as a spoken line or an imported clip's own audio: its level, how far the
 * song dips under it, and how long it fades in and out (the dip follows the
 * fades). While it is on, a new render of the shot asks its video model for sound.
 */
export default function SceneClipSound({ fieldId, scene, onChange, disabled = false, documentComposition = false, hasSelectedTake = false }) {
  const sound = songClipSound(scene);
  const save = (patch) => onChange({ clipSound: { ...sound, ...patch } });
  return (
    <div className="space-y-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" role="switch" aria-checked={!!sound} disabled={disabled}
          onClick={() => onChange({ clipSound: sound ? null : { ...CLIP_SOUND_DEFAULTS } })}
          title="Play this clip's own sound (a spoken line, an effect) over the song. While it is on, a new render of this shot asks its video model for sound."
          className={`inline-flex min-h-[44px] items-center rounded border px-2 pointer-fine:sm:min-h-[28px] disabled:opacity-50 ${sound ? 'border-port-accent text-port-accent' : 'border-port-border text-port-text-muted'}`}>
          Clip sound over the music
        </button>
        {sound && (
          <>
            <LevelSlider id={fieldId('clip-sound-volume')} label="clip" value={sound.volume} min={CLIP_SOUND_VOLUME_RANGE.min} max={CLIP_SOUND_VOLUME_RANGE.max}
              disabled={disabled} onCommit={(volume) => save({ volume })} />
            <LevelSlider id={fieldId('clip-sound-music')} label="music" value={sound.musicLevel} min={CLIP_SOUND_MUSIC_RANGE.min} max={CLIP_SOUND_MUSIC_RANGE.max}
              disabled={disabled} onCommit={(musicLevel) => save({ musicLevel })} />
            <FadeField id={fieldId('clip-sound-fade-in')} label="fade in" value={sound.fadeInSec} disabled={disabled} onCommit={(fadeInSec) => save({ fadeInSec })} />
            <FadeField id={fieldId('clip-sound-fade-out')} label="fade out" value={sound.fadeOutSec} disabled={disabled} onCommit={(fadeOutSec) => save({ fadeOutSec })} />
          </>
        )}
        {!sound && <span className="text-port-text-muted">Silent under the song</span>}
      </div>
      {sound && <p className="text-port-text-muted">
        {documentComposition
          ? hasSelectedTake
            ? 'Document finals and excerpts need audio in the selected take when this is on. If the take is silent, select a take with audio or render the shot again.'
            : 'Select or render a video take with audio before rendering a document final or an excerpt that includes this shot.'
          : 'An imported clip plays its own audio. A clip generated while this was off has no sound, so render the shot again to hear it.'}
      </p>}
    </div>
  );
}

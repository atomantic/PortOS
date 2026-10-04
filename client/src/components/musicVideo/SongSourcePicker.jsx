import { useEffect, useState } from 'react';
import ToggleChip from '../ui/ToggleChip.jsx';
import {
  AUTONOMOUS_SONG_SOURCES,
  AUTONOMOUS_SONG_SOURCE_LABELS,
  LOCAL_MUSIC_CODE_LANGUAGES,
  LOCAL_MUSIC_CODE_LANGUAGE_LABELS,
  LOCAL_MUSIC_TYPES,
  LOCAL_MUSIC_TYPE_LABELS,
} from '../../lib/musicVideoAutonomous.js';
import { listMusicEngines } from '../../services/apiMusic.js';

const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';

/**
 * Where an autonomous run's song comes from — Suno through the PortOS Browser or
 * a local Music Studio engine — plus the Suno-only opt-in to render locally when
 * Suno cannot take the request, and local Music Studio options (audio model or code).
 * Shared by the start drawer and the autopilot Schedule form; `onChange` receives
 * a partial draft patch.
 */
export default function SongSourcePicker({ idPrefix, songSource, localFallback, localMusic, engines: propEngines, onChange }) {
  const [engines, setEngines] = useState(propEngines || []);
  const showLocalOptions = songSource === 'local' || localFallback === true;

  useEffect(() => {
    if (propEngines || !showLocalOptions) return;
    let active = true;
    listMusicEngines({ silent: true })
      .then((data) => {
        if (!active) return;
        const list = Array.isArray(data?.engines) ? data.engines : (Array.isArray(data) ? data : []);
        setEngines(list);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [propEngines, showLocalOptions]);

  const type = localMusic?.type === 'code' ? 'code' : 'model';
  const engine = localMusic?.engine || '';
  const language = localMusic?.language || 'strudel';

  const patchLocal = (patch) => onChange({ localMusic: { ...(localMusic || {}), ...patch } });

  return (
    <div>
      <label htmlFor={`${idPrefix}-song-source`} className="block text-xs text-port-text-muted mb-1">Song source</label>
      <select
        id={`${idPrefix}-song-source`}
        value={songSource}
        onChange={(e) => onChange({ songSource: e.target.value })}
        className={inputClass}
      >
        {AUTONOMOUS_SONG_SOURCES.map((source) => (
          <option key={source} value={source}>{AUTONOMOUS_SONG_SOURCE_LABELS[source]}</option>
        ))}
      </select>
      <p className="text-[11px] text-port-text-muted mt-1">
        {songSource === 'suno'
          ? 'Suno is driven through the PortOS Browser — sign in to Suno there first. It spends Suno credits.'
          : 'Rendered on this machine by a ready Music Studio engine (a lyric-capable one such as ACE-Step for vocals). Free, but it queues behind other GPU work.'}
      </p>
      {songSource === 'suno' && (
        <div className="mt-2">
          <ToggleChip
            id={`${idPrefix}-local-fallback`}
            label="Render locally if Suno is unavailable"
            checked={localFallback}
            onToggle={() => onChange({ localFallback: !localFallback })}
          />
        </div>
      )}

      {showLocalOptions && (
        <div className="mt-3 p-3 bg-port-card/40 border border-port-border/60 rounded space-y-3">
          <div className="text-xs font-medium text-port-text">
            {songSource === 'local' ? 'Local Music Studio options' : 'Local fallback options'}
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),16rem))] gap-3">
            <div>
              <label htmlFor={`${idPrefix}-local-music-type`} className="block text-xs text-port-text-muted mb-1">Type</label>
              <select
                id={`${idPrefix}-local-music-type`}
                value={type}
                onChange={(e) => patchLocal({ type: e.target.value })}
                className={inputClass}
              >
                {LOCAL_MUSIC_TYPES.map((t) => (
                  <option key={t} value={t}>{LOCAL_MUSIC_TYPE_LABELS[t] || t}</option>
                ))}
              </select>
            </div>
            {type === 'model' ? (
              <div>
                <label htmlFor={`${idPrefix}-local-music-engine`} className="block text-xs text-port-text-muted mb-1">Audio engine</label>
                <select
                  id={`${idPrefix}-local-music-engine`}
                  value={engine}
                  onChange={(e) => patchLocal({ engine: e.target.value || null })}
                  className={inputClass}
                >
                  <option value="">Auto (best ready engine)</option>
                  {engines.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name || e.id}{e.lyrics ? ' (lyrics)' : ' (instrumental)'}{e.ready === false ? ' (not ready)' : ''}
                    </option>
                  ))}
                  {engine && !engines.some((e) => e.id === engine) && (
                    <option value={engine}>{engine} (configured)</option>
                  )}
                </select>
              </div>
            ) : (
              <div>
                <label htmlFor={`${idPrefix}-local-music-language`} className="block text-xs text-port-text-muted mb-1">Code language</label>
                <select
                  id={`${idPrefix}-local-music-language`}
                  value={language}
                  onChange={(e) => patchLocal({ language: e.target.value })}
                  className={inputClass}
                >
                  {LOCAL_MUSIC_CODE_LANGUAGES.map((lang) => (
                    <option key={lang} value={lang}>{LOCAL_MUSIC_CODE_LANGUAGE_LABELS[lang] || lang}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <p className="text-[11px] text-port-text-muted">
            {type === 'model'
              ? 'Rendered on this machine by an audio model (e.g. ACE-Step or MiniMax for vocals, MusicGen for instrumental).'
              : 'The music is written as code. SuperCollider renders offline in a container; Strudel and Tone.js are live-coding Web Audio environments.'}
          </p>
        </div>
      )}
    </div>
  );
}

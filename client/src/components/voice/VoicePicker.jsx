/**
 * VoicePicker — reusable namespaced-voiceId dropdown + audition button.
 *
 * Pulls the flat voice list from `/api/pipeline/tts/voices` (Kokoro + Piper
 * today; future engines slot in upstream) and renders an engine-grouped
 * <optgroup> picker. The audition button POSTs to `/api/pipeline/tts/preview`
 * and plays the returned WAV through the shared `playWav` queue so it
 * composes with voice-mode echo gating.
 *
 * Used by:
 *   - Universe character editor (`CharacterDetailEditor`) — binds the picked
 *     voice to `character.voiceId` (canon-level default for every line spoken
 *     by that character).
 *   - Audio stage per-line row (`AudioStage`) — per-line override that wins
 *     over the canon character voice for one specific dialogue line.
 *
 * The list is fetched lazily on first mount of any VoicePicker and cached
 * module-locally so opening N pickers across one page doesn't hammer the
 * voices endpoint N times.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { listPipelineTtsVoices, previewPipelineTtsVoice } from '../../services/apiPipeline';
import { playWav } from '../../services/voiceClient';
import { formatVoiceLabel } from '../../lib/voiceLabel';
import toast from '../ui/Toast';

// TTL on the module cache. The cache de-dupes the mount fan-out when
// AudioStage opens with N dialogue-line pickers (all mount within ~ms), so
// a generous TTL is fine for that — but Piper's `downloaded` flag is
// mutable: a user can navigate to settings → Voice, download a Piper
// voice, and come back, and the picker must NOT keep showing the voice
// as disabled. 15 seconds straddles both: way longer than the AudioStage
// mount burst, way shorter than any plausible navigate-download-return
// cycle.
const VOICE_LIST_CACHE_TTL_MS = 15_000;
let voiceListCache = null;
let voiceListCacheAt = 0;
let voiceListPromise = null;

const cacheIsFresh = () =>
  voiceListCache !== null && (Date.now() - voiceListCacheAt) < VOICE_LIST_CACHE_TTL_MS;

const loadVoiceList = () => {
  if (cacheIsFresh()) return Promise.resolve(voiceListCache);
  if (voiceListPromise) return voiceListPromise;
  voiceListPromise = listPipelineTtsVoices()
    .then((res) => {
      voiceListCache = Array.isArray(res?.voices) ? res.voices : [];
      voiceListCacheAt = Date.now();
      return voiceListCache;
    })
    .catch((err) => {
      voiceListPromise = null;
      throw err;
    })
    .finally(() => {
      voiceListPromise = null;
    });
  return voiceListPromise;
};

// Exposed for tests so they can reset module-local state between cases.
export const __resetVoicePickerCache = () => {
  voiceListCache = null;
  voiceListCacheAt = 0;
  voiceListPromise = null;
};

export default function VoicePicker({
  value,
  onChange,
  disabled = false,
  label = 'Voice',
  // Placeholder for the "inherit / no override" select option. Use this
  // to make the empty state self-explanatory in different contexts —
  // "Inherit (default)" on the canon character editor vs "Inherit from
  // character" on the audio-stage per-line row.
  placeholder = 'Default voice',
  previewText,
  // `compact` hides the inline label and squeezes vertical padding for
  // dense rows (AudioStage per-line). When false the picker stacks
  // label-above-control like the rest of CharacterDetailEditor.
  compact = false,
  // Hide the entire field rendering when no voices load. Used in the
  // audio-stage per-line row so a broken TTS install doesn't print an
  // empty picker on every line.
  hideWhenEmpty = false,
}) {
  const id = useId();
  const [voices, setVoices] = useState(() => cacheIsFresh() ? voiceListCache : []);
  const [loading, setLoading] = useState(() => !cacheIsFresh());
  const [loadError, setLoadError] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  // Synchronous guard against double-click during the async pre-disable
  // window — `setPreviewing(true)` doesn't commit to the disabled attr
  // until React renders, so two rapid-fire clicks can both pass the
  // `previewing` check and fire two TTS requests.
  const previewingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadVoiceList()
      .then((list) => {
        if (cancelled) return;
        setVoices(list);
        setLoadError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err?.message || 'Failed to load voices');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const byEngine = useMemo(() => voices.reduce((acc, v) => {
    const e = v.engine || 'other';
    if (!acc[e]) acc[e] = [];
    acc[e].push(v);
    return acc;
  }, {}), [voices]);
  const engineKeys = useMemo(() => Object.keys(byEngine).sort(), [byEngine]);

  const handleAudition = async () => {
    if (!value || previewingRef.current) return;
    previewingRef.current = true;
    setPreviewing(true);
    const buf = await previewPipelineTtsVoice(value, previewText).catch((err) => {
      toast.error(`Voice preview failed: ${err.message}`);
      return null;
    });
    previewingRef.current = false;
    setPreviewing(false);
    if (buf) playWav(buf);
  };

  if (hideWhenEmpty && !loading && voices.length === 0 && !loadError) return null;

  const select = (
    <div className="flex items-center gap-1.5 min-w-0">
      <select
        id={id}
        value={value || ''}
        onChange={(e) => onChange?.(e.target.value || null)}
        disabled={disabled || loading}
        className="flex-1 min-w-0 px-1.5 py-0.5 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50"
      >
        <option value="">{loading ? 'Loading voices…' : placeholder}</option>
        {/* Preserve a previously-saved voiceId that no longer appears in the
            catalog (engine uninstalled, voice renamed) so the user can see
            what they had bound before — losing it silently to a dropdown
            reset would mask the underlying drift. */}
        {value && !voices.some((v) => v.id === value) ? (
          <option value={value}>{value} (unavailable)</option>
        ) : null}
        {engineKeys.map((engine) => (
          <optgroup key={engine} label={engine.charAt(0).toUpperCase() + engine.slice(1)}>
            {byEngine[engine].map((v) => {
              // Piper voices with `downloaded: false` are catalog stubs —
              // selecting one would persist a `piper:<name>` voiceId that
              // `synthesizePiper` rejects at preview/render time. Keep them
              // visible (so the user sees what the catalog offers) but
              // unbindable from this picker — the user downloads them via
              // settings → Voice (`fetchPiperVoice`) before binding here.
              const undownloaded = v.engine === 'piper' && v.downloaded === false;
              return (
                <option key={v.id} value={v.id} disabled={undownloaded}>
                  {formatVoiceLabel(v)}
                </option>
              );
            })}
          </optgroup>
        ))}
      </select>
      <button
        type="button"
        onClick={handleAudition}
        disabled={!value || previewing || disabled}
        title={value ? `Audition ${value}` : 'Pick a voice to audition'}
        aria-label={value ? `Audition ${value}` : 'Audition voice'}
        className="shrink-0 p-1 rounded text-gray-400 hover:text-port-accent disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {previewing ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
      </button>
    </div>
  );

  if (loadError) {
    return (
      <div className="space-y-0.5">
        {!compact ? (
          <label htmlFor={id} className="block text-[10px] uppercase tracking-wider text-gray-500">
            {label}
          </label>
        ) : null}
        <p className="text-[10px] text-port-error">{loadError}</p>
      </div>
    );
  }

  if (compact) return select;

  return (
    <div className="space-y-0.5">
      <label htmlFor={id} className="block text-[10px] uppercase tracking-wider text-gray-500">
        {label}
      </label>
      {select}
    </div>
  );
}

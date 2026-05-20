// Display-formatter for TTS voice entries. Engine-specific shapes plug in
// via the ENGINE_FORMATTERS table — adding a new engine here is the single
// surface every voice-picker UI (settings VoiceTab + character VoicePicker
// + future per-line picker) reads through, so a new label format propagates
// to every consumer without per-component edits.

const LANGUAGE_LABELS = Object.freeze({
  'en-US': 'American',
  'en-GB': 'British',
});

const ENGINE_FORMATTERS = Object.freeze({
  kokoro: (v) => {
    const accent = LANGUAGE_LABELS[v.language] || v.language || '';
    const display = (v.name || '').split('_').slice(1).join(' ') || v.name || v.voice || '';
    const cleaned = display.charAt(0).toUpperCase() + display.slice(1);
    const who = [accent, v.gender].filter(Boolean).join(' ');
    const traits = v.traits ? `${v.traits} ` : '';
    const grade = v.grade ? ` (${v.grade})` : '';
    return `${traits}${who ? `${who} — ${cleaned}` : cleaned}${grade}`;
  },
  piper: (v) => {
    const id = v.name || v.voice || '';
    const meta = [v.accent, v.gender].filter(Boolean).join(' — ');
    const note = v.note ? ` · ${v.note}` : '';
    const dl = v.downloaded === false ? ' ⬇' : '';
    return meta ? `${id} — ${meta}${note}${dl}` : `${id}${note}${dl}`;
  },
});

const fallbackLabel = (v) => v.label || v.voice || v.name || v.id || '';

// `engineOverride` lets callers that don't carry `engine` on the voice
// record (the legacy `/voice/voices?engine=...` shape used by VoiceTab)
// pass it positionally. New callers attach `engine` to each item (per the
// `/pipeline/tts/voices` flat-list shape) and omit the override.
export const formatVoiceLabel = (v, engineOverride) => {
  const engine = engineOverride || v.engine;
  return (ENGINE_FORMATTERS[engine] || fallbackLabel)(v);
};

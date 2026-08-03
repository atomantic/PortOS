import { Loader2, Save } from 'lucide-react';
import VoiceExemplarEditor, { VOICE_EXEMPLARS_MAX } from '../VoiceExemplarEditor';

// WorkEditorVoicePanel — the Voice exemplars drawer body for WorkEditor (#2179).
// Extracted from WorkEditor (#3387).
//
// State stays hoisted in WorkEditor (the Drawer body can remount freely, and
// switching works must re-seed it) — this component is presentational and takes
// the entries + the save handler as props.
export default function WorkEditorVoicePanel({
  exemplars,
  antiExemplars,
  onExemplarsChange,
  onAntiExemplarsChange,
  saving,
  onSave,
}) {
  return (
    <div className="p-3">
      <p className="text-[11px] text-gray-500 mb-2">
        Concrete prose passages anchor this work&rsquo;s voice far better than adjectives. Exemplars are injected into live continuation suggestions and the Polish revision brief as &ldquo;MATCH this voice&rdquo;; anti-exemplars as &ldquo;NEVER drift toward this.&rdquo; Up to {VOICE_EXEMPLARS_MAX} of each.
      </p>
      <VoiceExemplarEditor
        idPrefix="wr-voice-exemplar"
        title="Voice exemplars (the tuning fork)"
        hint="1–3 short passages (~150–300 words) that nail this work's voice. Injected as “MATCH this voice.”"
        notePlaceholder="what this demonstrates (e.g. spare, close-psychic)"
        entries={exemplars}
        onChange={onExemplarsChange}
      />
      <VoiceExemplarEditor
        idPrefix="wr-voice-anti"
        title="Anti-exemplars (never drift toward this)"
        hint="Passages in the wrong register, kept as negative examples. Injected as “NEVER drift toward this.”"
        notePlaceholder="what's wrong (e.g. too ornate, wrong temperature)"
        entries={antiExemplars}
        onChange={onAntiExemplarsChange}
      />
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {saving ? 'Saving…' : 'Save voice'}
        </button>
      </div>
    </div>
  );
}

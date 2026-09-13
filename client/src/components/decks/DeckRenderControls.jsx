import { Loader2, Play, Sparkles, WandSparkles } from 'lucide-react';
import RecordRenderPinRow from '../imageGen/RecordRenderPinRow';
import DeckLlmPinPicker from './DeckLlmPinPicker';
import useImageRenderSettings from '../../hooks/useImageRenderSettings';
import { RENDER_TARGET, modeLabel } from '../../lib/imageGenBackends';

/**
 * The action bar above the card grid: which image backend this deck renders
 * on (its own pin over the Settings "Deck card renders" default), the LLM pin
 * for casting + prompt writing, and the three batch buttons — generate
 * prompts for empty cards, render every card still missing an image, render
 * the whole deck again.
 */
export default function DeckRenderControls({
  deck, completion, onPatch, onGeneratePrompts, onRenderMissing, onRenderAll, generating = false, rendering = false,
}) {
  const { imageCfg, backends } = useImageRenderSettings({ record: deck, target: RENDER_TARGET.DECK });
  const missing = Math.max(0, (completion?.total || 0) - (completion?.rendered || 0) - (completion?.inFlight || 0));
  const unprompted = Math.max(0, (completion?.total || 0) - (completion?.prompted || 0));
  const busy = generating || rendering;

  return (
    <div className="bg-port-card border border-port-border rounded-md p-3 space-y-3">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 lg:items-start">
        <div className="space-y-1">
          <RecordRenderPinRow
            idPrefix="deck-render"
            label="Image backend"
            imageMode={deck.imageMode}
            imageModelId={deck.imageModelId}
            onChange={(pin) => onPatch(pin)}
            options={backends.length ? backends.map((b) => ({ id: b.id, label: b.label })) : null}
            autoLabel="Auto (Settings default)"
          />
          {backends.length ? (
            <p className="text-[11px] text-gray-500">
              Renders on <span className="text-gray-300">{modeLabel(imageCfg.mode)}</span>
              {imageCfg.cloudModel || imageCfg.modelId ? <> · <span className="text-gray-300">{imageCfg.cloudModel || imageCfg.modelId}</span></> : null}
              {' '}at {deck.cardSize?.width}×{deck.cardSize?.height}
            </p>
          ) : null}
        </div>
        <DeckLlmPinPicker
          label="Prompt model"
          pin={deck.promptLlm}
          onChange={(pin) => onPatch({ promptLlm: pin })}
          disabled={busy}
        />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => onGeneratePrompts({ overwrite: false })}
          disabled={busy || unprompted === 0}
          title={unprompted === 0 ? 'Every card already has a prompt' : `Write prompts for ${unprompted} card(s) without one`}
          className="inline-flex min-h-[38px] items-center gap-1.5 rounded bg-port-accent px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          {generating ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <WandSparkles size={14} aria-hidden="true" />}
          {generating ? 'Writing prompts…' : `Generate prompts${unprompted ? ` (${unprompted})` : ''}`}
        </button>
        <button
          type="button"
          onClick={() => onGeneratePrompts({ overwrite: true })}
          disabled={busy}
          title="Rewrite every card's prompt (keeps the universe casting)"
          className="min-h-[38px] rounded border border-port-border px-3 py-2 text-sm text-gray-200 hover:bg-white/5 disabled:opacity-50"
        >
          Rewrite all prompts
        </button>
        <span className="hidden sm:block h-6 w-px bg-port-border" aria-hidden="true" />
        <button
          type="button"
          onClick={onRenderMissing}
          disabled={busy || missing === 0 || !completion?.prompted}
          title={missing === 0 ? 'Every card is rendered' : `Render the ${missing} card(s) without an image`}
          className="inline-flex min-h-[38px] items-center gap-1.5 rounded border border-port-accent/40 px-3 py-2 text-sm text-port-accent hover:bg-port-accent/10 disabled:opacity-50"
        >
          {rendering ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          Render missing{missing ? ` (${missing})` : ''}
        </button>
        <button
          type="button"
          onClick={onRenderAll}
          disabled={busy || !completion?.prompted}
          title="Queue a fresh render for every card with a prompt"
          className="inline-flex min-h-[38px] items-center gap-1.5 rounded border border-port-border px-3 py-2 text-sm text-gray-200 hover:bg-white/5 disabled:opacity-50"
        >
          <Sparkles size={14} aria-hidden="true" />
          Render whole deck
        </button>
      </div>
    </div>
  );
}

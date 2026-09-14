import { useEffect, useState } from 'react';
import { Copy, Link2, Loader2, Sparkles, Star, Trash2 } from 'lucide-react';
import Drawer from '../Drawer';
import { composeCardRenderPrompt } from '../../lib/decks';
import { copyToClipboard } from '../../lib/clipboard';

const INPUT_CLASS = 'w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent';

/**
 * Per-card editor: the subject prompt and negative (saved explicitly), the
 * composed prompt the renderer will actually send, the canon link, the render
 * history (pick a primary, drop a stale render), and a re-render button.
 */
export default function DeckCardDrawer({ deck, card, open, inFlight, onClose, onSave, onRender, onPreview, saving = false }) {
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  useEffect(() => {
    setPrompt(card?.prompt || '');
    setNegative(card?.negativePrompt || '');
  }, [card?.id, card?.prompt, card?.negativePrompt]);

  if (!card) return null;
  const dirty = prompt !== (card.prompt || '') || negative !== (card.negativePrompt || '');
  const composed = composeCardRenderPrompt(deck, { ...card, prompt, negativePrompt: negative });
  const refs = Array.isArray(card.imageRefs) ? card.imageRefs : [];

  return (
    <Drawer open={open} onClose={onClose} title={card.name} subtitle={card.groupLabel} size="md" closeLabel="Close card">
      <div className="p-4 space-y-4">
        {card.canonRef?.name ? (
          <p className="inline-flex items-center gap-1.5 text-xs text-gray-300 rounded border border-port-border px-2 py-1">
            <Link2 size={12} aria-hidden="true" /> Depicts <span className="text-white">{card.canonRef.name}</span> <span className="text-gray-500">({card.canonRef.kind})</span>
          </p>
        ) : null}
        {card.motif ? <p className="text-xs text-gray-500">Traditional motif: {card.motif}</p> : null}

        <div>
          <label htmlFor="deck-card-prompt" className="block text-xs text-gray-400 mb-1">Subject prompt</label>
          <textarea id="deck-card-prompt" rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Figures, pose, setting, symbols, the suit emblem count…" className={INPUT_CLASS} />
        </div>
        <div>
          <label htmlFor="deck-card-negative" className="block text-xs text-gray-400 mb-1">Extra negative (this card only)</label>
          <input id="deck-card-negative" value={negative} onChange={(e) => setNegative(e.target.value)} className={INPUT_CLASS} />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => onSave({ prompt, negativePrompt: negative })}
            disabled={!dirty || saving}
            className="min-h-[38px] rounded bg-port-accent px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save prompt'}
          </button>
          <button
            type="button"
            onClick={onRender}
            disabled={!prompt.trim() || dirty || !!inFlight || saving}
            title={dirty ? 'Save the prompt first' : 'Queue a render for this card'}
            className="inline-flex min-h-[38px] items-center gap-1.5 rounded border border-port-accent/40 px-3 py-2 text-sm text-port-accent hover:bg-port-accent/10 disabled:opacity-50"
          >
            {inFlight ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
            {inFlight ? 'Rendering…' : refs.length ? 'Re-render' : 'Render'}
          </button>
        </div>

        <section className="rounded border border-port-border bg-port-bg/40 p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs text-gray-400">What the renderer receives</h3>
            <button
              type="button"
              onClick={() => copyToClipboard(composed.prompt, 'Render prompt')}
              className="inline-flex min-h-[32px] items-center gap-1 rounded px-2 text-xs text-gray-400 hover:text-white"
              title="Copy the whole composed prompt"
            >
              <Copy size={12} aria-hidden="true" /> Copy
            </button>
          </div>
          <PromptPart label="Deck style" hint="from the style guide" value={composed.parts.style} />
          <PromptPart label="Layout" hint="shared by every card" value={composed.parts.layout} />
          <PromptPart label="Subject" hint="this card" value={composed.parts.subject} />
          <PromptPart label="Negative" value={composed.negativePrompt} tone="error" />
          <details>
            <summary className="text-xs text-gray-400 cursor-pointer">Full composed prompt</summary>
            <p className="mt-2 text-xs text-gray-300 whitespace-pre-wrap">{composed.prompt}</p>
          </details>
        </section>

        <section>
          <h3 className="text-xs text-gray-400 mb-2">Renders ({refs.length})</h3>
          {refs.length ? (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {[...refs].reverse().map((filename) => {
                const isPrimary = filename === card.primaryImageRef;
                return (
                  <li key={filename} className="space-y-1">
                    <button type="button" onClick={() => onPreview(filename)} className="block w-full" title="Open">
                      <img src={`/data/images/${encodeURIComponent(filename)}`} alt={`${card.name} render`} className={`aspect-[2/3] w-full rounded object-cover border ${isPrimary ? 'border-port-accent' : 'border-port-border'}`} />
                    </button>
                    <div className="flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => onSave({ primaryImageRef: filename })}
                        disabled={isPrimary || saving}
                        className={`min-h-[32px] min-w-[32px] inline-flex items-center justify-center rounded ${isPrimary ? 'text-port-accent' : 'text-gray-500 hover:text-white'}`}
                        aria-label={isPrimary ? 'Primary render' : 'Make primary'}
                        title={isPrimary ? 'Primary render' : 'Make primary'}
                      >
                        <Star size={13} fill={isPrimary ? 'currentColor' : 'none'} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onSave({ imageRefs: refs.filter((f) => f !== filename) })}
                        disabled={saving}
                        className="min-h-[32px] min-w-[32px] inline-flex items-center justify-center rounded text-gray-500 hover:text-port-error"
                        aria-label="Remove this render from the card"
                        title="Remove from card (the gallery keeps the image)"
                      >
                        <Trash2 size={13} aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-gray-600">Nothing rendered yet.</p>
          )}
        </section>
        {card.render?.status === 'failed' && card.render.error ? (
          <p className="text-xs text-port-error">Last render failed: {card.render.error}</p>
        ) : null}
      </div>
    </Drawer>
  );
}

/**
 * One read-only clause of the composed render prompt. Empty clauses still
 * render their label — "Deck style: —" is the answer to "why does my card
 * look nothing like the deck?", and hiding the row hides the answer.
 */
function PromptPart({ label, hint, value, tone }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-gray-500">
        {label}{hint ? <span className="normal-case tracking-normal text-gray-600"> · {hint}</span> : null}
      </p>
      <p className={`text-xs whitespace-pre-wrap ${value ? (tone === 'error' ? 'text-port-error/80' : 'text-gray-300') : 'text-gray-600'}`}>
        {value || '—'}
      </p>
    </div>
  );
}

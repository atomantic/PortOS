import { useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import InfluenceChipsInput from '../universeBuilder/InfluenceChipsInput';
import DeckSampleModal from './DeckSampleModal';
import DeckStyleSources from './DeckStyleSources';
import useFieldDraft from '../../hooks/useFieldDraft';
import {
  DECK_CARD_ORIENTATION, DECK_CARD_ORIENTATION_LABELS, DECK_CARD_ORIENTATIONS, DECK_KIND_LABELS,
  DEFAULT_DECK_CARD_ORIENTATION, deckCardAspectStyle, defaultDeckCardOrientationPrompt,
} from '../../lib/decks';

const INPUT_CLASS = 'w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent';

/**
 * Style tab: the deck's style guide (notes + embrace/avoid influences + the
 * shared card layout clause), its sample designs, and the universe link.
 * Text fields buffer locally and PATCH on blur; chips PATCH on change.
 */
export default function DeckStylePanel({ deck, universes, onPatch, onDeckReplaced, onRemoveSample }) {
  const [sampleOpen, setSampleOpen] = useState(false);
  const description = useFieldDraft(deck.description, (v) => onPatch({ description: v }));
  const styleNotes = useFieldDraft(deck.styleNotes, (v) => onPatch({ styleNotes: v }));
  const layoutPrompt = useFieldDraft(deck.layoutPrompt, (v) => onPatch({ layoutPrompt: v }));
  const orientation = deck.cardOrientation || DEFAULT_DECK_CARD_ORIENTATION[deck.kind] || DECK_CARD_ORIENTATIONS[0];
  const builtInOrientationPrompt = defaultDeckCardOrientationPrompt({ ...deck, cardOrientation: orientation, cardOrientationPrompt: null });
  const orientationPrompt = useFieldDraft(
    deck.cardOrientationPrompt || builtInOrientationPrompt,
    (value) => onPatch({ cardOrientationPrompt: value.trim() === builtInOrientationPrompt ? null : (value.trim() || null) }),
  );
  const influences = deck.influences || { embrace: [], avoid: [] };
  const samples = Array.isArray(deck.samples) ? deck.samples : [];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <section className="space-y-3 bg-port-card border border-port-border rounded-md p-3">
        <h2 className="text-sm font-medium text-white">Style guide</h2>
        <DeckStyleSources key={`${deck.id}:${deck.universeId || ''}`} deck={deck} onPatch={onPatch} />
        <div>
          <label htmlFor="deck-description" className="block text-xs text-gray-400 mb-1">Concept</label>
          <textarea id="deck-description" rows={2} value={description.value} onChange={description.onChange} onBlur={description.onBlur} placeholder="What this deck is about — its world, its mood, who it is for." className={INPUT_CLASS} />
        </div>
        <div>
          <label htmlFor="deck-style-notes" className="block text-xs text-gray-400 mb-1">Art direction</label>
          <textarea id="deck-style-notes" rows={4} value={styleNotes.value} onChange={styleNotes.onChange} onBlur={styleNotes.onBlur} placeholder="Medium, palette, ornament, era, mood — prose the prompt writer reads." className={INPUT_CLASS} />
        </div>
        <div>
          <div className="text-xs text-gray-400 mb-1">Style prompt (prepended to every card render)</div>
          <InfluenceChipsInput
            tokens={influences.embrace}
            onChange={(next) => onPatch({ influences: { ...influences, embrace: next } })}
            placeholder="copperplate engraving, aged cream paper, teal and gold…"
            ariaLabel="Add style prompt token"
            tone="success"
          />
        </div>
        <div>
          <div className="text-xs text-gray-400 mb-1">Negative prompt</div>
          <InfluenceChipsInput
            tokens={influences.avoid}
            onChange={(next) => onPatch({ influences: { ...influences, avoid: next } })}
            placeholder="blurry, photographic, neon, watermark…"
            ariaLabel="Add negative prompt token"
            tone="error"
          />
        </div>
        <div>
          <label htmlFor="deck-layout-prompt" className="block text-xs text-gray-400 mb-1">Shared card layout ({DECK_KIND_LABELS[deck.kind] || deck.kind})</label>
          <textarea id="deck-layout-prompt" rows={3} value={layoutPrompt.value} onChange={layoutPrompt.onChange} onBlur={layoutPrompt.onBlur} className={INPUT_CLASS} />
          <p className="text-[11px] text-gray-500 mt-1">Sits between the style prompt and each card's subject so every card shares one border, index and title treatment.</p>
        </div>
        <div>
          <label htmlFor="deck-card-orientation" className="block text-xs text-gray-400 mb-1">Card face orientation</label>
          <select
            id="deck-card-orientation"
            value={orientation}
            onChange={(e) => onPatch({ cardOrientation: e.target.value })}
            className={INPUT_CLASS}
          >
            {DECK_CARD_ORIENTATIONS.map((value) => <option key={value} value={value}>{DECK_CARD_ORIENTATION_LABELS[value]}</option>)}
          </select>
          <p className="text-[11px] text-gray-500 mt-1">
            {orientation === DECK_CARD_ORIENTATION.STANDARD
              ? 'The top-left index is upright and the matching bottom-right index is rotated 180°, so a 6 stays a 6 when the card is turned over.'
              : 'All indices and titles face one direction; the bottom-right copy is not rotated.'}
          </p>
        </div>
        <div>
          <div className="flex items-start justify-between gap-2 mb-1 flex-wrap">
            <label htmlFor="deck-card-orientation-prompt" className="block text-xs text-gray-400">Face-orientation prompt (built-in, overridable)</label>
            {deck.cardOrientationPrompt ? (
              <button
                type="button"
                onClick={() => { orientationPrompt.reset(); onPatch({ cardOrientationPrompt: null }); }}
                className="min-h-[32px] shrink-0 rounded px-2 text-[11px] text-gray-400 hover:bg-white/5 hover:text-white"
              >
                Use built-in
              </button>
            ) : null}
          </div>
          <textarea
            id="deck-card-orientation-prompt"
            rows={4}
            value={orientationPrompt.value}
            onChange={orientationPrompt.onChange}
            onBlur={orientationPrompt.onBlur}
            className={INPUT_CLASS}
          />
          <p className="text-[11px] text-gray-500 mt-1">This guard is added to every card render after the shared layout. Leave the built-in wording in place unless this deck needs a different physical reading convention.</p>
        </div>
        <div>
          <label htmlFor="deck-universe" className="block text-xs text-gray-400 mb-1">Universe</label>
          <select id="deck-universe" value={deck.universeId || ''} onChange={(e) => onPatch({ universeId: e.target.value || null })} className={INPUT_CLASS}>
            <option value="">— none —</option>
            {universes.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <p className="text-[11px] text-gray-500 mt-1">With a universe linked, "Generate prompts" first casts its characters, places and objects onto the cards.</p>
        </div>
      </section>

      <section className="space-y-3 bg-port-card border border-port-border rounded-md p-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-medium text-white">Sample designs</h2>
            <p className="text-xs text-gray-500">Analyzed by a vision model into the style guide above.</p>
          </div>
          <button
            type="button"
            onClick={() => setSampleOpen(true)}
            className="inline-flex min-h-[38px] items-center gap-1.5 rounded border border-port-accent/40 px-2.5 py-1.5 text-xs text-port-accent hover:bg-port-accent/10"
          >
            <ImagePlus size={14} aria-hidden="true" />
            Add sample
          </button>
        </div>
        {samples.length ? (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {samples.map((sample) => (
              <li key={sample.id} className="flex gap-3 rounded-lg border border-port-border bg-port-bg/40 p-2">
                <img
                  src={`/data/images/${encodeURIComponent(sample.imageRef || '')}`}
                  alt={sample.title}
                  style={deckCardAspectStyle(deck)}
                  className="w-16 shrink-0 rounded object-contain bg-port-bg"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm font-medium text-white">{sample.title}</h3>
                    <button
                      type="button"
                      onClick={() => onRemoveSample(sample.id)}
                      className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center shrink-0 rounded p-1 text-gray-500 hover:bg-white/5 hover:text-port-error"
                      aria-label={`Remove ${sample.title}`}
                      title="Remove sample"
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </div>
                  <p className="mt-1 line-clamp-4 text-xs text-gray-400">{sample.prompt}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-gray-600">No samples yet. Add a poster, a card from another deck, or any image whose look this deck should share.</p>
        )}
      </section>

      <DeckSampleModal deck={deck} open={sampleOpen} onClose={() => setSampleOpen(false)} onSaved={onDeckReplaced} />
    </div>
  );
}

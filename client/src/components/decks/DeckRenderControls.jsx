import { useId } from 'react';
import { Loader2, Play, RefreshCw, Sliders, Sparkles, WandSparkles } from 'lucide-react';
import RecordRenderPinRow from '../imageGen/RecordRenderPinRow';
import CollapsibleSection from '../ui/CollapsibleSection';
import FormField from '../ui/FormField';
import DeckLlmPinPicker from './DeckLlmPinPicker';
import useFieldDraft from '../../hooks/useFieldDraft';
import useImageRenderSettings from '../../hooks/useImageRenderSettings';
import {
  DECK_CARD_SIZE, DECK_CARD_SIZE_BY_KIND, DECK_CARD_SIZE_MAX, DECK_CARD_SIZE_MIN,
} from '../../lib/decks';
import { RENDER_TARGET, modeLabel } from '../../lib/imageGenBackends';
import { clampImageEdge } from '../../lib/imageGenResolutions';
import { pluralize } from '../../lib/textUtils';

const PRIMARY_BTN = 'inline-flex min-h-[38px] items-center gap-1.5 rounded bg-port-accent px-3 py-2 text-sm text-white hover:bg-port-accent/90 disabled:opacity-40 disabled:cursor-not-allowed';
const SECONDARY_BTN = 'inline-flex min-h-[38px] items-center gap-1.5 rounded border border-port-border px-3 py-2 text-sm text-gray-200 hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed';
const NUM_FIELD = 'w-24 bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent';
const SIZE_BOUNDS = { min: DECK_CARD_SIZE_MIN, max: DECK_CARD_SIZE_MAX, step: 8 };

/**
 * The action bar above the card grid: which image backend this deck renders on
 * (its own pin over the Settings "Deck card renders" default), the LLM pin for
 * casting + prompt writing, and the batch actions — split into the two ordered
 * steps a deck actually goes through, write prompts then render them.
 *
 * Each step carries a plain-language note that says what its buttons will do,
 * or why they are greyed out — a disabled "Generate prompts" is the normal
 * resting state of a fully-prompted deck, which is exactly the state that
 * looked broken. The accent button is whichever step is the next one to take,
 * so the deck always points at its own next action.
 */
export default function DeckRenderControls({
  deck, completion, onPatch, onGeneratePrompts, onRenderMissing, onRenderAll, generating = false, rendering = false,
}) {
  const { imageCfg, backends } = useImageRenderSettings({ record: deck, target: RENDER_TARGET.DECK });
  const total = completion?.total || 0;
  const prompted = completion?.prompted || 0;
  const rendered = completion?.rendered || 0;
  const inFlight = completion?.inFlight || 0;
  const missing = Math.max(0, total - rendered - inFlight);
  const unprompted = Math.max(0, total - prompted);
  const busy = generating || rendering;
  const promptsAreTheNextStep = unprompted > 0;
  const size = deck.cardSize || DECK_CARD_SIZE;
  // What this deck will actually render on, in the order a sentence wants it.
  // Formatted once: the collapsed header and the expanded note say the same
  // three facts, and a fourth would otherwise have to be added to both.
  const model = imageCfg.cloudModel || imageCfg.modelId;
  const renderFacts = backends.length
    ? [modeLabel(imageCfg.mode), model, `${size.width}×${size.height}`].filter(Boolean)
    : [];

  return (
    <div className="bg-port-card border border-port-border rounded-md p-3 space-y-3">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 lg:items-start">
        {/* The collapsed summary is the whole render config in one line, so the
            common case — glance, confirm, render — costs no click, and the
            uncommon one (change the model, resize the card) is one. */}
        <CollapsibleSection
          size="md"
          icon={Sliders}
          id="deck-render-options"
          label="Render options"
          summary={renderFacts.join(' · ')}
          buttonClassName="min-h-[38px]"
          bodyClassName="space-y-3 pt-2"
        >
          <RecordRenderPinRow
            idPrefix="deck-render"
            label="Image backend"
            imageMode={deck.imageMode}
            imageModelId={deck.imageModelId}
            onChange={(pin) => onPatch(pin)}
            options={backends.length ? backends.map((b) => ({ id: b.id, label: b.label })) : null}
            autoLabel="Auto (Settings default)"
          />
          <CardSize kind={deck.kind} size={size} onPatch={onPatch} />
          {/* What an "Auto" pin and a blank model actually resolve to — the
              controls above name the PIN, this names the outcome. */}
          {renderFacts.length ? (
            <p className="text-[11px] text-gray-500">
              Renders on <span className="text-gray-300">{renderFacts.join(' · ')}</span>
            </p>
          ) : null}
        </CollapsibleSection>
        <DeckLlmPinPicker
          label="Prompt model"
          pin={deck.promptLlm}
          onChange={(pin) => onPatch({ promptLlm: pin })}
          disabled={busy}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Step step="1" title="Prompts" note={promptNote({ generating, unprompted, total })}>
          {(noteId) => (<>
            <button
              type="button"
              onClick={() => onGeneratePrompts({ overwrite: false })}
              disabled={busy || unprompted === 0}
              aria-describedby={noteId}
              className={promptsAreTheNextStep ? PRIMARY_BTN : SECONDARY_BTN}
            >
              {generating ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <WandSparkles size={14} aria-hidden="true" />}
              {generating ? 'Writing prompts…' : `Generate prompts${unprompted ? ` (${unprompted})` : ''}`}
            </button>
            <button
              type="button"
              onClick={() => onGeneratePrompts({ overwrite: true })}
              disabled={busy || total === 0}
              aria-describedby={noteId}
              title="Replaces every card's prompt (the universe casting is kept)"
              className={SECONDARY_BTN}
            >
              <RefreshCw size={14} aria-hidden="true" />
              Rewrite all{total ? ` (${total})` : ''}
            </button>
          </>)}
        </Step>

        <Step step="2" title="Render" note={renderNote({ prompted, rendering, missing, inFlight })}>
          {(noteId) => (<>
            <button
              type="button"
              onClick={onRenderMissing}
              disabled={busy || missing === 0 || !prompted}
              aria-describedby={noteId}
              className={promptsAreTheNextStep ? SECONDARY_BTN : PRIMARY_BTN}
            >
              {rendering ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
              Render missing{missing ? ` (${missing})` : ''}
            </button>
            <button
              type="button"
              onClick={onRenderAll}
              disabled={busy || !prompted}
              aria-describedby={noteId}
              title="Queues a fresh render for every card that has a prompt"
              className={SECONDARY_BTN}
            >
              <Sparkles size={14} aria-hidden="true" />
              Render all{prompted ? ` (${prompted})` : ''}
            </button>
          </>)}
        </Step>
      </div>
    </div>
  );
}

// Card render size. Persisted on the deck (`cardSize`), so it is a deck
// property rather than a per-render one — every card of a deck has to share a
// trim or the set stops reading as one physical object. Commits on blur so a
// three-keystroke width doesn't fire three PATCHes, and snaps through
// `clampImageEdge` to the bounds the deck schema itself is built from, rather
// than letting an out-of-range entry come back as a 400.
function CardSize({ kind, size, onPatch }) {
  const kindDefault = DECK_CARD_SIZE_BY_KIND[kind] || DECK_CARD_SIZE;
  const commit = (axis) => (raw) => {
    // A cleared field is a mid-edit state, not a request for the 256px floor
    // `clampImageEdge` would snap an empty string to. `useFieldDraft` drops the
    // draft either way, so the input snaps back to the stored size.
    if (String(raw).trim() === '') return;
    const clamped = clampImageEdge(raw, SIZE_BOUNDS);
    if (clamped !== size[axis]) onPatch({ cardSize: { ...size, [axis]: clamped } });
  };
  const width = useFieldDraft(size.width, commit('width'));
  const height = useFieldDraft(size.height, commit('height'));
  const isKindDefault = size.width === kindDefault.width && size.height === kindDefault.height;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <FormField label="Card width" compact>
        <input
          type="number" min={SIZE_BOUNDS.min} max={SIZE_BOUNDS.max} step={SIZE_BOUNDS.step}
          className={NUM_FIELD} value={width.value} onChange={width.onChange} onBlur={width.onBlur}
        />
      </FormField>
      <span className="pb-2 text-xs text-gray-500" aria-hidden="true">×</span>
      <FormField label="Card height" compact>
        <input
          type="number" min={SIZE_BOUNDS.min} max={SIZE_BOUNDS.max} step={SIZE_BOUNDS.step}
          className={NUM_FIELD} value={height.value} onChange={height.onChange} onBlur={height.onBlur}
        />
      </FormField>
      <button
        type="button"
        onClick={() => onPatch({ cardSize: { ...kindDefault } })}
        disabled={isKindDefault}
        className="min-h-[38px] rounded border border-port-border px-2 py-2 text-[11px] text-gray-400 hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Reset to {kindDefault.width}×{kindDefault.height}
      </button>
    </div>
  );
}

// What step 1's buttons will do, or why they can't.
const promptNote = ({ generating, unprompted, total }) => {
  if (generating) return 'Writing prompts…';
  if (unprompted) return `${unprompted} of ${pluralize(total, 'card')} still need a prompt.`;
  return `All ${pluralize(total, 'card')} have a prompt — rewrite to replace them.`;
};

// The same for step 2. The two counts compose into one sentence rather than
// each owning a phrasing, so "some missing, some in flight" reads like the two
// states it is instead of a third variant.
const renderNote = ({ prompted, rendering, missing, inFlight }) => {
  if (!prompted) return 'A card renders from its prompt. Write prompts first.';
  if (rendering) return 'Queueing renders…';
  const parts = [];
  if (missing) parts.push(`${pluralize(missing, 'prompted card')} not rendered yet`);
  if (inFlight) parts.push(`${pluralize(inFlight, 'card')} rendering now`);
  return parts.length ? `${parts.join(' · ')}.` : 'Every card is rendered — re-render to replace them.';
};

// One numbered step: heading, its buttons, then the note explaining what they
// will do or why they can't. `children` is a function of the note's id because
// `aria-describedby` does not inherit from a wrapper, so each button has to
// carry it. The note is real page text rather than a `title`: a disabled button
// is neither focusable nor hoverable on touch, so a tooltip on it reaches
// nobody.
function Step({ step, title, note, children }) {
  const noteId = useId();
  return (
    <section className="rounded border border-port-border/60 bg-port-bg/30 p-2.5 space-y-2" aria-label={`Step ${step}: ${title}`}>
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
        <span className="text-port-accent">{step}</span> · {title}
      </h3>
      <div className="flex items-center gap-2 flex-wrap">{children(noteId)}</div>
      <p id={noteId} className="text-[11px] leading-snug text-gray-400">{note}</p>
    </section>
  );
}

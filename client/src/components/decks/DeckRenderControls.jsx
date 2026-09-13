import { useId } from 'react';
import { Loader2, Play, RefreshCw, Sparkles, WandSparkles } from 'lucide-react';
import RecordRenderPinRow from '../imageGen/RecordRenderPinRow';
import DeckLlmPinPicker from './DeckLlmPinPicker';
import useImageRenderSettings from '../../hooks/useImageRenderSettings';
import { RENDER_TARGET, modeLabel } from '../../lib/imageGenBackends';
import { pluralize } from '../../lib/textUtils';

const PRIMARY_BTN = 'inline-flex min-h-[38px] items-center gap-1.5 rounded bg-port-accent px-3 py-2 text-sm text-white hover:bg-port-accent/90 disabled:opacity-40 disabled:cursor-not-allowed';
const SECONDARY_BTN = 'inline-flex min-h-[38px] items-center gap-1.5 rounded border border-port-border px-3 py-2 text-sm text-gray-200 hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed';

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

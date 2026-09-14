import { useMemo } from 'react';
import { AlertTriangle, Check, Hourglass, Link2, PencilLine, Play } from 'lucide-react';
import EntryThumbSlot from '../universe/EntryThumbSlot';
import Pill from '../ui/Pill';
import { CARD_STATUS, cardInFlightJobId, cardStatus, deckCompletion } from '../../lib/decks';

// One badge per card state, named for what the user can DO next rather than for
// the internal status word: "ready" alone did not answer "does this card have a
// prompt yet?", which is the question the grid exists to answer at a glance.
const STATUS_META = {
  [CARD_STATUS.EMPTY]: { tone: 'warning', icon: PencilLine, label: 'Needs prompt' },
  [CARD_STATUS.PROMPTED]: { tone: 'accent', icon: Play, label: 'Ready to render' },
  // The queue never stamps 'running' on the card; the slot's live thumb shows
  // progress, so both in-flight states read the same.
  [CARD_STATUS.QUEUED]: { tone: 'muted', icon: Hourglass, label: 'Rendering…' },
  [CARD_STATUS.RUNNING]: { tone: 'muted', icon: Hourglass, label: 'Rendering…' },
  [CARD_STATUS.RENDERED]: { tone: 'success', icon: Check, label: 'Rendered' },
  [CARD_STATUS.FAILED]: { tone: 'error', icon: AlertTriangle, label: 'Failed' },
};

/**
 * The deck laid out by group (suit / arcana / jokers / back), one three-state
 * thumbnail slot per card: pending render → live progress, rendered → the
 * primary image, empty → a one-click render (or, with no prompt written yet, a
 * shortcut into the card editor). Status and in-flight job derive from the
 * card's persisted `render` record, so a slot settling locally and a reload
 * after the server filed the render read the same way. Clicking a card's name
 * opens its drawer; the slot's image opens the lightbox.
 *
 * Every card wears a labelled badge for its state and every group header spells
 * its counts out in words, so "which cards still need a prompt, and which are
 * ready to render" is answerable without opening a single card.
 */
export default function DeckCardGrid({ deck, onOpenCard, onRenderCard, onPreview, onRenderComplete, onRenderTerminal }) {
  const groups = useMemo(() => {
    const byGroup = Map.groupBy(deck.cards, (card) => card.group);
    return [...byGroup].map(([key, cards]) => {
      const counts = deckCompletion(cards);
      return { key, label: cards[0].groupLabel || key, cards, counts, needPrompt: counts.total - counts.prompted };
    });
  }, [deck.cards]);

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label}>
          <h2 className="text-sm font-medium text-white mb-2 flex items-center gap-2 flex-wrap">
            {group.label}
            <span className="text-xs font-normal text-gray-400">
              {group.counts.rendered}/{group.counts.total} rendered
            </span>
            {group.needPrompt ? (
              <Pill tone="warning" size="xs" icon={PencilLine}>{group.needPrompt} need a prompt</Pill>
            ) : null}
          </h2>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
            {group.cards.map((card) => {
              const inFlight = cardInFlightJobId(card);
              const status = cardStatus(card);
              const meta = STATUS_META[status];
              const needsPrompt = !card.prompt;
              return (
                <li key={card.id} className="flex h-full flex-col items-center gap-1.5 rounded-lg border border-port-border bg-port-card p-2">
                  <EntryThumbSlot
                    size="xl"
                    inFlightJobId={inFlight}
                    imageRefs={card.imageRefs}
                    primaryImageRef={card.primaryImageRef}
                    // A card with no prompt has nothing to render, so its
                    // empty slot opens the editor rather than sitting there
                    // greyed out — the one thing that unblocks it.
                    onRender={() => (needsPrompt ? onOpenCard(card) : onRenderCard(card))}
                    onPreview={() => onPreview(card)}
                    onComplete={(filename) => onRenderComplete(card.id, filename)}
                    onTerminalStatus={(s, error) => onRenderTerminal(card.id, s, error)}
                    emptyIcon={needsPrompt ? PencilLine : undefined}
                    emptyHint={needsPrompt ? `Write a prompt for ${card.name}` : `Render ${card.name}`}
                    alt={card.name}
                  />
                  <button
                    type="button"
                    onClick={() => onOpenCard(card)}
                    className="w-full min-h-[44px] text-center text-xs text-gray-200 hover:text-white leading-tight"
                    title="Edit this card"
                  >
                    <span className="block truncate font-medium">{card.name}</span>
                    {card.canonRef?.name ? (
                      <span className="mt-0.5 inline-flex max-w-full items-center gap-1 text-[11px] text-gray-400">
                        <Link2 size={10} aria-hidden="true" /><span className="truncate">{card.canonRef.name}</span>
                      </span>
                    ) : null}
                  </button>
                  <Pill tone={meta.tone} size="xs" icon={meta.icon} className="mt-auto">{meta.label}</Pill>
                  {/* Why it failed. The slot clears itself on a terminal
                      failure (so the card stays re-renderable), taking the
                      shared thumbnail's own message with it — this is the only
                      place a deck can show it. The fix button for a broken
                      runtime lives in the render bar above. */}
                  {status === CARD_STATUS.FAILED && card.render?.error ? (
                    <p className="w-full text-center text-[10px] leading-snug text-port-error line-clamp-3" title={card.render.error}>
                      {card.render.error}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

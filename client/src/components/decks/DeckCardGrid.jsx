import { useMemo } from 'react';
import { Link2 } from 'lucide-react';
import EntryThumbSlot from '../universe/EntryThumbSlot';
import Pill from '../ui/Pill';
import { CARD_STATUS, cardInFlightJobId, cardStatus } from '../../lib/decks';

const STATUS_TONE = {
  [CARD_STATUS.EMPTY]: 'context',
  [CARD_STATUS.PROMPTED]: 'muted',
  [CARD_STATUS.QUEUED]: 'accent',
  [CARD_STATUS.RUNNING]: 'accent',
  [CARD_STATUS.RENDERED]: 'success',
  [CARD_STATUS.FAILED]: 'error',
};
const STATUS_LABEL = {
  [CARD_STATUS.EMPTY]: 'needs prompt',
  [CARD_STATUS.PROMPTED]: 'ready',
  // The queue never stamps 'running' on the card; the slot's live thumb shows
  // progress, so both in-flight states read as one word.
  [CARD_STATUS.QUEUED]: 'rendering',
  [CARD_STATUS.RUNNING]: 'rendering',
  [CARD_STATUS.RENDERED]: 'rendered',
  [CARD_STATUS.FAILED]: 'failed',
};

/**
 * The deck laid out by group (suit / arcana / jokers / back), one three-state
 * thumbnail slot per card: pending render → live progress, rendered → the
 * primary image, empty → a one-click render affordance. Status and in-flight
 * job derive from the card's persisted `render` record, so a slot settling
 * locally and a reload after the server filed the render read the same way.
 * Clicking a card's name opens its drawer; the slot's image opens the lightbox.
 */
export default function DeckCardGrid({ deck, onOpenCard, onRenderCard, onPreview, onRenderComplete, onRenderTerminal }) {
  const groups = useMemo(() => {
    const byGroup = Map.groupBy(deck.cards, (card) => card.group);
    return [...byGroup].map(([key, cards]) => ({ key, label: cards[0].groupLabel || key, cards }));
  }, [deck.cards]);

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label}>
          <h2 className="text-sm font-medium text-white mb-2 flex items-center gap-2">
            {group.label}
            <span className="text-xs text-gray-500">{group.cards.filter((c) => c.imageRefs?.length).length}/{group.cards.length}</span>
          </h2>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
            {group.cards.map((card) => {
              const inFlight = cardInFlightJobId(card);
              const status = cardStatus(card);
              return (
                <li key={card.id} className="flex flex-col items-center gap-1.5 rounded-lg border border-port-border bg-port-card p-2">
                  <EntryThumbSlot
                    size="xl"
                    inFlightJobId={inFlight}
                    imageRefs={card.imageRefs}
                    primaryImageRef={card.primaryImageRef}
                    onRender={() => onRenderCard(card)}
                    onPreview={() => onPreview(card)}
                    onComplete={(filename) => onRenderComplete(card.id, filename)}
                    onTerminalStatus={(s) => onRenderTerminal(card.id, s)}
                    canRender={!!card.prompt && !inFlight}
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
                  <Pill tone={STATUS_TONE[status]} size="xs">{STATUS_LABEL[status]}</Pill>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

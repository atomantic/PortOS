import { useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Hourglass, Link2, PencilLine, Play, RefreshCw, Star } from 'lucide-react';
import EntryThumbSlot from '../universe/EntryThumbSlot';
import Pill from '../ui/Pill';
import { CARD_STATUS, cardInFlightJobId, cardStatus, deckCardSize, deckCompletion } from '../../lib/decks';

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
 *
 * Each card also carries its own re-render button, because once a card HAS an
 * image its slot is a lightbox opener — re-rendering the one card you dislike
 * otherwise meant opening its drawer or re-rendering the whole deck. It queues
 * through the same `onRenderCard` the empty slot uses, so the server resolves
 * the deck's own pinned backend, model and card trim; `renderTarget` is the
 * page's resolved `useDeckRenderTarget(deck)`, and is used only to NAME those
 * options on the button and to stand it down for the same unavailable local
 * runtime that stops the batch actions above.
 */
export default function DeckCardGrid({
  deck, renderTarget, onOpenCard, onRenderCard, onPreview, onSetActiveVersion, onRenderComplete, onRenderTerminal,
}) {
  const { summary: renderSummary, blocked: runtimeBlocked } = renderTarget;
  const [viewedVersions, setViewedVersions] = useState({});

  const handleRenderComplete = (cardId, filename) => {
    if (filename) {
      setViewedVersions((prev) => ({ ...prev, [cardId]: filename }));
    }
    onRenderComplete?.(cardId, filename);
  };

  const groups = useMemo(() => {
    const byGroup = Map.groupBy(deck.cards, (card) => card.group);
    return [...byGroup].map(([key, cards]) => {
      const counts = deckCompletion(cards);
      return { key, label: cards[0].groupLabel || key, cards, counts, needPrompt: counts.total - counts.prompted };
    });
  }, [deck.cards]);
  const cardSize = deckCardSize(deck);

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
              const reRenderHint = renderHint({ card, needsPrompt, inFlight, runtimeBlocked, renderSummary });
              const refs = Array.isArray(card.imageRefs) ? card.imageRefs : [];
              const activeFilename = (card.primaryImageRef && refs.includes(card.primaryImageRef))
                ? card.primaryImageRef
                : (refs.at(-1) || null);
              const viewedFilename = (viewedVersions[card.id] && refs.includes(viewedVersions[card.id]))
                ? viewedVersions[card.id]
                : activeFilename;
              const viewedIndex = refs.indexOf(viewedFilename);
              const currentVersionNum = viewedIndex >= 0 ? viewedIndex + 1 : refs.length;
              const isCurrentActive = Boolean(viewedFilename && viewedFilename === activeFilename);
              return (
                <li key={card.id} className="flex h-full flex-col items-center gap-1.5 rounded-lg border border-port-border bg-port-card p-2">
                  <EntryThumbSlot
                    size="xl"
                    fluid
                    aspectRatio={cardSize}
                    rounded={false}
                    inFlightJobId={inFlight}
                    imageRefs={card.imageRefs}
                    primaryImageRef={card.primaryImageRef}
                    displayedImageRef={viewedFilename}
                    // A card with no prompt has nothing to render, so its
                    // empty slot opens the editor rather than sitting there
                    // greyed out — the one thing that unblocks it.
                    onRender={() => (needsPrompt ? onOpenCard(card) : onRenderCard(card))}
                    onPreview={() => onPreview(card, viewedFilename)}
                    onComplete={(filename) => handleRenderComplete(card.id, filename)}
                    onTerminalStatus={(s, error) => onRenderTerminal(card.id, s, error)}
                    // The slot is the bigger of the card's two render
                    // affordances, so a dead runtime has to stand it down too
                    // or the button below stands down alone and reads broken.
                    // A promptless slot is exempt: it opens the editor, which
                    // works whatever the runtime is doing.
                    canRender={needsPrompt || !runtimeBlocked}
                    disabledHint={reRenderHint}
                    emptyIcon={needsPrompt ? PencilLine : undefined}
                    emptyHint={needsPrompt ? `Write a prompt for ${card.name}` : `Render ${card.name}`}
                    alt={card.name}
                  />
                  {refs.length > 1 ? (
                    <div className="flex w-full items-center justify-between px-0.5 text-xs">
                      <button
                        type="button"
                        onClick={() => {
                          if (viewedIndex > 0) {
                            setViewedVersions((prev) => ({ ...prev, [card.id]: refs[viewedIndex - 1] }));
                          }
                        }}
                        disabled={viewedIndex <= 0}
                        className="min-h-[28px] min-w-[28px] inline-flex items-center justify-center rounded text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                        title="Previous render version"
                        aria-label={`Previous render version for ${card.name}`}
                      >
                        <ChevronLeft size={14} aria-hidden="true" />
                      </button>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] font-mono text-gray-300">
                          v{currentVersionNum}/{refs.length}
                        </span>
                        {isCurrentActive ? (
                          <span
                            className="inline-flex items-center gap-0.5 rounded bg-port-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-port-accent"
                            title="Active version for this card"
                          >
                            <Star size={10} fill="currentColor" aria-hidden="true" /> Active
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onSetActiveVersion?.(card.id, viewedFilename)}
                            className="inline-flex items-center gap-0.5 rounded border border-port-border bg-port-bg/60 px-1.5 py-0.5 text-[10px] text-gray-300 hover:border-port-accent hover:text-port-accent transition-colors"
                            title={`Set v${currentVersionNum} as active version for ${card.name}`}
                            aria-label={`Set v${currentVersionNum} as active version for ${card.name}`}
                          >
                            <Star size={10} aria-hidden="true" /> Set active
                          </button>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          if (viewedIndex < refs.length - 1) {
                            setViewedVersions((prev) => ({ ...prev, [card.id]: refs[viewedIndex + 1] }));
                          }
                        }}
                        disabled={viewedIndex >= refs.length - 1}
                        className="min-h-[28px] min-w-[28px] inline-flex items-center justify-center rounded text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                        title="Next render version"
                        aria-label={`Next render version for ${card.name}`}
                      >
                        <ChevronRight size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ) : refs.length === 1 ? (
                    <div className="flex w-full items-center justify-center gap-1 text-[11px] text-gray-400 font-mono py-0.5">
                      <span>v1</span>
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-port-accent" title="Active version">
                        <Star size={9} fill="currentColor" aria-hidden="true" /> Active
                      </span>
                    </div>
                  ) : null}
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
                  <div className="mt-auto flex w-full flex-wrap items-center justify-center gap-1">
                    <Pill tone={meta.tone} size="xs" icon={meta.icon}>{meta.label}</Pill>
                    <button
                      type="button"
                      onClick={() => onRenderCard(card)}
                      disabled={needsPrompt || !!inFlight || runtimeBlocked}
                      title={reRenderHint}
                      aria-label={reRenderHint}
                      className="min-h-[32px] min-w-[32px] inline-flex shrink-0 items-center justify-center rounded text-gray-500 hover:text-port-accent hover:bg-port-accent/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-500"
                    >
                      <RefreshCw size={13} aria-hidden="true" />
                    </button>
                  </div>
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

// Why this card's render button will or won't do anything, in one sentence.
// Real text on the button's accessible name rather than a bare icon label,
// because the two reasons it is inert (no prompt yet, a dead local runtime) are
// both fixable elsewhere on the page — and a disabled button is neither
// focusable nor hoverable on touch, so a `title` alone reaches nobody.
function renderHint({ card, needsPrompt, inFlight, runtimeBlocked, renderSummary }) {
  if (needsPrompt) return `Write a prompt for ${card.name} before rendering it`;
  if (inFlight) return `${card.name} is rendering`;
  if (runtimeBlocked) return `Cannot render ${card.name} — the local image runtime is unavailable`;
  const verb = card.imageRefs?.length ? 'Re-render' : 'Render';
  return renderSummary ? `${verb} ${card.name} on ${renderSummary}` : `${verb} ${card.name}`;
}

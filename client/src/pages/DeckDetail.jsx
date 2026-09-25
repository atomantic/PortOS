/**
 * Deck editor — `/decks/:id`.
 *
 * Header (name, kind, universe, completion) → action bar (backend + LLM pins,
 * generate prompts, render missing / all) → tabs: the card grid (one
 * three-state slot per card, drawer per card) and the style guide + samples.
 * Every card render rides the shared media queue; the server files a finished
 * image onto the card, and the grid's live slots settle through
 * `MediaJobThumb`. In-flight state lives on each card's `render` record —
 * stamped optimistically when a render is queued, flipped when the slot
 * settles — so a render started here or on a previous visit reads the same.
 *
 * The deck's render target (backend pin, card trim, local-runtime verdict)
 * resolves once here and is handed to both the action bar and the grid, so the
 * options the bar advertises are exactly the ones a single card re-renders on.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Globe, Trash2 } from 'lucide-react';
import PageSkeleton from '../components/ui/PageSkeleton';
import ProgressBar from '../components/ui/ProgressBar';
import TabPills from '../components/ui/TabPills';
import Pill from '../components/ui/Pill';
import InlineConfirmRow from '../components/ui/InlineConfirmRow';
import EmptyState from '../components/EmptyState';
import toast from '../components/ui/Toast';
import MediaPreview from '../components/media/MediaPreview';
import { normalizeImage } from '../components/media/normalize';
import DeckCardGrid from '../components/decks/DeckCardGrid';
import DeckCardDrawer from '../components/decks/DeckCardDrawer';
import DeckStylePanel from '../components/decks/DeckStylePanel';
import DeckRenderControls from '../components/decks/DeckRenderControls';
import useDeckRenderTarget from '../hooks/useDeckRenderTarget';
import useMounted from '../hooks/useMounted';
import useUrlParams from '../hooks/useUrlParams';
import useHydratedPreviewRoute from '../hooks/useHydratedPreviewRoute';
import useFieldDraft from '../hooks/useFieldDraft';
import { useSseProgress } from '../hooks/useSseProgress';
import { DECK_KIND_LABELS, cardInFlightJobId, composeCardRenderPrompt, deckCompletion } from '../lib/decks';
import {
  deleteDeck, generateDeckPrompts, getDeck, listUniverseSummaries, removeDeckSample,
  renderDeckCard, renderDeckCards, updateDeck, updateDeckCard, deckPromptsProgressUrl,
} from '../services/api';

const TABS = [{ id: 'cards', label: 'Cards' }, { id: 'style', label: 'Style & samples' }];

export default function DeckDetail() {
  const { id } = useParams();
  // Route changes replace the editor so every draft, drawer and pending-render
  // map belongs to one deck.
  return <DeckEditor key={id} id={id} />;
}

function DeckEditor({ id }) {
  const navigate = useNavigate();
  const mountedRef = useMounted();
  const [params, updateParams] = useUrlParams();
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'cards';
  const cardParam = params.get('card');

  const [deck, setDeck] = useState(null);
  const [universes, setUniverses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [savingCard, setSavingCard] = useState(false);
  const [promptProgressUrl, setPromptProgressUrl] = useState(null);
  const lastChunkSeen = useRef(0);
  // Live prompt-writing progress. The URL is set for the duration of one
  // generate call. The server reserves the channel on POST arrival and retains
  // each frame until attach, so starting the POST before React's EventSource
  // effect runs cannot drop progress.
  const { frames: promptFrames } = useSseProgress(promptProgressUrl, { enabled: !!promptProgressUrl });
  const loadSeqRef = useRef(0);
  // Resolved once for the page: the render bar names these options, the grid's
  // per-card re-render button renders on them, and both stand down together on
  // an unavailable local runtime. Two consumers, one settings fetch.
  const renderTarget = useDeckRenderTarget(deck);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    const [data, worlds] = await Promise.all([
      getDeck(id, { silent: true }).catch(() => null),
      listUniverseSummaries({ silent: true }).catch(() => []),
    ]);
    if (!mountedRef.current || seq !== loadSeqRef.current) return;
    setDeck(data);
    setUniverses(Array.isArray(worlds) ? worlds : []);
    if (!data) toast.error('Deck not found');
    setLoading(false);
  }, [id, mountedRef]);

  useEffect(() => { load(); }, [load]);

  // Merge a patch into one card of the local deck.
  const patchLocalCard = useCallback((cardId, patch) => {
    setDeck((prev) => (prev ? {
      ...prev,
      cards: prev.cards.map((c) => (c.id === cardId ? { ...c, ...(typeof patch === 'function' ? patch(c) : patch) } : c)),
    } : prev));
  }, []);

  const patchDeck = useCallback(async (patch) => {
    const next = await updateDeck(id, patch, { silent: true }).catch((err) => {
      toast.error(`Save failed: ${err.message}`);
      return null;
    });
    if (next && mountedRef.current) setDeck(next);
    return !!next;
  }, [id, mountedRef]);

  const nameDraft = useFieldDraft(deck?.name, (v) => { if (v.trim()) patchDeck({ name: v.trim() }); });

  const completion = useMemo(() => (deck ? deckCompletion(deck.cards) : null), [deck]);
  const selectedCard = useMemo(
    () => (deck && cardParam ? deck.cards.find((c) => c.id === cardParam) || null : null),
    [deck, cardParam],
  );
  // The card's own `prompt` is only its subject line; the renderer was sent the
  // composed prompt (deck style clause, layout, titled subject, merged
  // negatives), which `useHydratedPreviewRoute` reads back from the sidecar of
  // whichever card the user opens. Compose it locally as the stand-in — a
  // legacy or peer-synced render has no sidecar at all, and falling back to the
  // subject line would re-show the wording that was never sent.
  const previewItems = useMemo(() => (deck
    ? deck.cards.flatMap((c) => {
      if (!c.imageRefs.length) return [];
      const composed = composeCardRenderPrompt(deck, c);
      return c.imageRefs.map((filename) => normalizeImage({
        filename,
        prompt: composed.prompt,
        negativePrompt: composed.negativePrompt || null,
      }));
    })
    : []), [deck]);
  const [preview, setPreview] = useHydratedPreviewRoute(previewItems);
  const previewFilename = (filename) => {
    const item = previewItems.find((i) => i.filename === filename);
    if (item) setPreview(item);
  };

  const openCard = (card) => updateParams({ card: card.id });
  const closeCard = () => updateParams({ card: null });

  // Stamp the queued jobs onto their cards, mirroring what the server wrote.
  const queueJobs = (result) => {
    const byCard = new Map(result.jobs.map((j) => [j.cardId, j.jobId]));
    setDeck((prev) => (prev ? {
      ...prev,
      cards: prev.cards.map((c) => (byCard.has(c.id) ? { ...c, render: { jobId: byCard.get(c.id), status: 'queued', mode: result.mode } } : c)),
    } : prev));
  };

  const renderCard = async (card) => {
    const result = await renderDeckCard(id, card.id, {}, { silent: true }).catch((err) => {
      toast.error(`Render failed to queue: ${err.message}`);
      return null;
    });
    if (result && mountedRef.current) queueJobs(result);
  };

  const renderBatch = async (body, label) => {
    setRendering(true);
    const result = await renderDeckCards(id, body, { silent: true }).catch((err) => {
      toast.error(`${label} failed: ${err.message}`);
      return null;
    });
    if (!mountedRef.current) return;
    setRendering(false);
    if (!result) return;
    queueJobs(result);
    toast.success(`${result.jobs.length} card render${result.jobs.length === 1 ? '' : 's'} queued`);
  };

  const generatePrompts = async ({ overwrite }) => {
    setGenerating(true);
    lastChunkSeen.current = 0;
    // Start the advisory progress stream alongside the POST. The server
    // reserves the channel at POST arrival and replays late frames.
    setPromptProgressUrl(null);
    if (typeof EventSource !== 'undefined') setPromptProgressUrl(deckPromptsProgressUrl(id));
    const result = await generateDeckPrompts(id, { overwrite }, { silent: true }).catch((err) => {
      toast.error(`Prompt generation failed: ${err.message}`);
      return null;
    });
    if (!mountedRef.current) return;
    // Close the stream once the POST has settled — frames stay rendered until
    // the next run, when the chunk counter is reset above.
    setPromptProgressUrl(null);
    setGenerating(false);
    if (!result) return;
    setDeck(result.deck);
    toast.success(`${result.written} prompt${result.written === 1 ? '' : 's'} written${result.cast ? `, ${result.cast} cards cast from the universe` : ''}`);
  };

  // Each persisted chunk refetches the deck so freshly written prompts land
  // in the grid while the run is still going — not just when the POST
  // settles. The server persists every chunk before emitting its frame, so a
  // refetch on that frame always has something new to show.
  useEffect(() => {
    if (!generating || !promptFrames.length) return undefined;
    const latest = promptFrames[promptFrames.length - 1];
    if (latest?.type !== 'chunk' || promptFrames.length <= lastChunkSeen.current) return undefined;
    lastChunkSeen.current = promptFrames.length;
    let active = true;
    getDeck(id, { silent: true }).then((data) => {
      if (active && mountedRef.current && data) setDeck(data);
    }).catch(() => {});
    return () => { active = false; };
  }, [promptFrames, generating, id, mountedRef]);

  // One live line for step 1 while a run is in flight: which phase, how many
  // prompts are written of how many requested, and which batch just landed.
  // Null when idle — the step note then falls back to the deck counts.
  const generatingStatus = useMemo(() => {
    if (!generating) return null;
    let phaseLabel = null;
    let written = null;
    let requested = null;
    let chunk = null;
    let chunks = null;
    for (const f of promptFrames) {
      if (f?.type === 'phase' && f.label) phaseLabel = f.label;
      else if (f?.type === 'start') {
        if (Number.isFinite(f.requested)) requested = f.requested;
        if (Number.isFinite(f.chunks)) chunks = f.chunks;
      } else if (f?.type === 'chunk') {
        if (Number.isFinite(f.written)) written = f.written;
        if (Number.isFinite(f.requested)) requested = f.requested;
        if (Number.isFinite(f.chunk)) chunk = f.chunk;
        if (Number.isFinite(f.chunks)) chunks = f.chunks;
      }
    }
    // Casting runs before the first prompt chunk — name the phase, not a 0/N.
    if (written === null && phaseLabel) return phaseLabel;
    if (written === null || requested === null) return 'Writing prompts…';
    const batch = chunk !== null && chunks !== null ? ` · batch ${chunk} of ${chunks}` : '';
    return `Writing prompts… ${written} of ${requested}${batch}`;
  }, [generating, promptFrames]);

  const saveCard = async (patch) => {
    if (!selectedCard) return;
    setSavingCard(true);
    const card = await updateDeckCard(id, selectedCard.id, patch, { silent: true }).catch((err) => {
      toast.error(`Card save failed: ${err.message}`);
      return null;
    });
    if (!mountedRef.current) return;
    setSavingCard(false);
    if (card) patchLocalCard(card.id, card);
  };

  const handleSetActiveVersion = async (cardId, filename) => {
    const prev = deck?.cards?.find((c) => c.id === cardId)?.primaryImageRef;
    patchLocalCard(cardId, { primaryImageRef: filename });
    const card = await updateDeckCard(id, cardId, { primaryImageRef: filename }, { silent: true }).catch((err) => {
      toast.error(`Card save failed: ${err.message}`);
      return null;
    });
    if (!mountedRef.current) return;
    if (card) {
      patchLocalCard(cardId, card);
      toast.success('Active version updated');
    } else if (prev !== undefined) {
      // The save failed: roll back the optimistic patch so the grid never
      // displays a version the server doesn't have as active.
      patchLocalCard(cardId, { primaryImageRef: prev });
    }
  };

  // The slot settled with a file — the same merge the server hook performs.
  const onRenderComplete = useCallback((cardId, filename) => {
    if (!filename) return;
    patchLocalCard(cardId, (c) => ({
      imageRefs: [...c.imageRefs.filter((f) => f !== filename), filename],
      primaryImageRef: filename,
      render: { ...(c.render || {}), status: 'completed', filename },
    }));
  }, [patchLocalCard]);

  // Mirror what the server's own completion hook writes (`markCardRenderTerminal`)
  // so the grid can explain a failure immediately instead of only after a reload.
  const onRenderTerminal = useCallback((cardId, status, error = null) => {
    patchLocalCard(cardId, (c) => ({ render: { ...(c.render || {}), status, error: error || null } }));
  }, [patchLocalCard]);

  const handleDelete = async () => {
    setConfirmingDelete(false);
    const ok = await deleteDeck(id, { silent: true }).then(() => true).catch(() => false);
    if (!ok) { toast.error('Failed to delete deck'); return; }
    toast.success('Deck deleted');
    navigate('/decks');
  };

  const handleRemoveSample = async (sampleId) => {
    const next = await removeDeckSample(id, sampleId, { silent: true }).catch(() => null);
    if (next && mountedRef.current) setDeck(next);
    else if (mountedRef.current) toast.error('Failed to remove sample');
  };

  if (loading) return <PageSkeleton header="none" label="Loading deck" cards={4} sidebar={false} />;
  if (!deck) {
    return (
      <EmptyState title="Deck not found" message="This deck may have been deleted." actionTo="/decks" actionLabel="Back to decks" />
    );
  }

  const universe = universes.find((u) => u.id === deck.universeId) || null;

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <div className="flex items-start gap-3 flex-wrap">
        <Link to="/decks" className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-gray-400 hover:text-white" aria-label="Back to decks">
          <ArrowLeft className="w-5 h-5" aria-hidden="true" />
        </Link>
        <div className="flex-1 min-w-[240px] space-y-1">
          <h1 className="sr-only">{deck.name}</h1>
          <label htmlFor="deck-name" className="sr-only">Deck name</label>
          <input
            id="deck-name"
            value={nameDraft.value}
            onChange={nameDraft.onChange}
            onBlur={nameDraft.onBlur}
            maxLength={120}
            className="w-full bg-transparent text-xl font-semibold text-white border-b border-transparent hover:border-port-border focus:border-port-accent focus:outline-none"
          />
          <div className="flex items-center gap-3 text-xs text-gray-400 flex-wrap">
            <Pill tone="context" size="xs">{DECK_KIND_LABELS[deck.kind] || deck.kind}</Pill>
            {universe ? (
              <Link to={`/universes/${universe.id}`} className="inline-flex items-center gap-1 hover:text-white"><Globe className="w-3 h-3" aria-hidden="true" />{universe.name}</Link>
            ) : null}
            {/* Both counters read as fractions of the deck: a bare "79 prompted"
                beside "0/79 rendered" looks like a different denominator. */}
            <span>{completion.rendered}/{completion.total} rendered · {completion.prompted}/{completion.total} prompted{completion.inFlight ? ` · ${completion.inFlight} rendering` : ''}{completion.failed ? ` · ${completion.failed} failed` : ''}</span>
          </div>
          <div className="max-w-md">
            <ProgressBar percent={completion.percent} label="Deck render progress" tone={completion.percent === 100 ? 'success' : 'accent'} />
          </div>
        </div>
        <button
          type="button"
          onClick={() => setConfirmingDelete(true)}
          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-gray-500 hover:text-port-error"
          aria-label={`Delete ${deck.name}`}
          title="Delete deck"
        >
          <Trash2 className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
      {confirmingDelete ? (
        <InlineConfirmRow
          question={`Delete "${deck.name}"? Its cards and prompts are removed; rendered images stay in the gallery.`}
          onConfirm={handleDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      ) : null}

      <DeckRenderControls
        deck={deck}
        completion={completion}
        renderTarget={renderTarget}
        onPatch={patchDeck}
        onGeneratePrompts={generatePrompts}
        onRenderMissing={() => renderBatch({ onlyMissing: true }, 'Render missing')}
        onRenderAll={() => renderBatch({}, 'Render whole deck')}
        generating={generating}
        generatingStatus={generatingStatus}
        rendering={rendering}
      />

      <TabPills tabs={TABS} activeTab={tab} onChange={(next) => updateParams({ tab: next === 'cards' ? null : next })} ariaLabel="Deck sections" />

      {tab === 'style' ? (
        <DeckStylePanel
          deck={deck}
          universes={universes}
          onPatch={patchDeck}
          onDeckReplaced={setDeck}
          onRemoveSample={handleRemoveSample}
        />
      ) : (
        <DeckCardGrid
          deck={deck}
          renderTarget={renderTarget}
          onOpenCard={openCard}
          onRenderCard={renderCard}
          onPreview={(card, filename) => previewFilename(filename || card.primaryImageRef || card.imageRefs.at(-1))}
          onSetActiveVersion={handleSetActiveVersion}
          onRenderComplete={onRenderComplete}
          onRenderTerminal={onRenderTerminal}
        />
      )}

      <DeckCardDrawer
        deck={deck}
        card={selectedCard}
        open={!!selectedCard}
        inFlight={selectedCard ? cardInFlightJobId(selectedCard) : null}
        saving={savingCard}
        onClose={closeCard}
        onSave={saveCard}
        onRender={() => selectedCard && renderCard(selectedCard)}
        onPreview={previewFilename}
      />

      <MediaPreview preview={preview} setPreview={setPreview} items={previewItems} />
    </div>
  );
}

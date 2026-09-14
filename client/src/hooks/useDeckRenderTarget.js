import useImageRenderSettings from './useImageRenderSettings';
import useLocalImageRuntime from './useLocalImageRuntime';
import { deckCardSize } from '../lib/decks';
import { IMAGE_GEN_MODE, IMAGE_RUNTIME_READINESS, RENDER_TARGET, modeLabel } from '../lib/imageGenBackends';

/**
 * "What will this deck's next card render actually run on, and can it run at
 * all" — the backend pin ladder resolved for `RENDER_TARGET.DECK`, the card
 * trim, the local runtime's verdict, and a one-line `summary` naming the
 * options, in one object.
 *
 * A hook rather than state inside the render bar, because the deck page has two
 * consumers of the same answer: the render bar (which shows the options and
 * queues batches) and the card grid (whose per-card re-render button must queue
 * against those same options, name them, and stand down for the same reason).
 * Resolving it once also means one settings fetch and one runtime probe per
 * page rather than one per consumer.
 */
export default function useDeckRenderTarget(deck) {
  const { imageCfg, backends } = useImageRenderSettings({ record: deck, target: RENDER_TARGET.DECK });
  const size = deckCardSize(deck);
  // `backends` is empty until the settings fetch lands, and until then imageCfg
  // is the UNRESOLVED placeholder (local + the install default) — probing on
  // that asks about the wrong model, and about a local runtime a cloud-pinned
  // deck never touches. Wait for the real answer.
  const resolved = backends.length > 0;
  const rendersLocally = resolved && imageCfg.mode === IMAGE_GEN_MODE.LOCAL;
  const localRuntime = useLocalImageRuntime(rendersLocally ? (imageCfg.modelId || null) : null);
  // Queueing against a runtime the server will refuse is the reported complaint
  // one step earlier than the error message, so every render affordance stands
  // down while it is unavailable. An unknown verdict does NOT block — a probe
  // that could not answer must not be able to lock the deck out of rendering.
  const blocked = localRuntime.runtime?.readiness === IMAGE_RUNTIME_READINESS.UNAVAILABLE;

  // What this deck will actually render on, in the order a sentence wants it.
  // Written once: the render bar's collapsed header, its expanded note and the
  // grid's per-card button all say the same three facts, and a fourth would
  // otherwise have to be added to each. Empty until the fetch lands, which is
  // also how a caller knows not to claim anything about the render yet.
  const summary = resolved
    ? [modeLabel(imageCfg.mode), imageCfg.cloudModel || imageCfg.modelId, `${size.width}×${size.height}`].filter(Boolean).join(' · ')
    : '';

  return { backends, size, summary, localRuntime, blocked };
}

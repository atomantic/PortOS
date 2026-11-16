/**
 * Hook `useDeckRenderTarget` resolving a deck's next card render backend, size, summary, local runtime
 * state and blocked status in one call.
 *
 * What a deck's next card render runs on (`{ backends, size, summary, localRuntime, blocked }`): the `RENDER_TARGET.DECK` pin ladder, the card trim and the local runtime's verdict in one call. Resolve it once on the page and pass it down (render bar, per-card re-render) rather than probing per consumer.
 */

import useImageRenderSettings from './useImageRenderSettings';
import useLocalImageRuntime from './useLocalImageRuntime';
import { deckCardSize } from '../lib/decks';
import { IMAGE_GEN_MODE, IMAGE_RUNTIME_READINESS, RENDER_TARGET, modeLabel } from '../lib/imageGenBackends';

/**
 * "What will this deck's next card render run on, and can it run at all": the pin ladder for `RENDER_TARGET.DECK`, the card trim, the local runtime's verdict and a one-line `summary`. A hook because the render bar and the card grid's per-card
 * re-render button must queue against the same options, name them and stand down for the same reason; resolving once also means one settings fetch and one runtime probe per page.
 */
export default function useDeckRenderTarget(deck) {
  const { imageCfg, backends } = useImageRenderSettings({ record: deck, target: RENDER_TARGET.DECK });
  const size = deckCardSize(deck);
  // `backends` is empty until the settings fetch lands, and imageCfg is then the UNRESOLVED placeholder, so probing would ask about the wrong model/runtime (a cloud-pinned deck never touches local). Wait for the real answer.
  const resolved = backends.length > 0;
  const rendersLocally = resolved && imageCfg.mode === IMAGE_GEN_MODE.LOCAL;
  const localRuntime = useLocalImageRuntime(rendersLocally ? (imageCfg.modelId || null) : null);
  // Every render affordance stands down while the runtime is unavailable (queueing against one the server refuses is the reported complaint, one step earlier). An unknown verdict does NOT block: a probe that couldn't answer must not lock the deck out.
  const blocked = localRuntime.runtime?.readiness === IMAGE_RUNTIME_READINESS.UNAVAILABLE;

  // What this deck renders on, in sentence order. Written once because the render bar's header, its expanded note and the grid's per-card button all say the same facts; empty until the fetch lands, which tells a caller not to claim anything yet.
  const summary = resolved
    ? [modeLabel(imageCfg.mode), imageCfg.mode === IMAGE_GEN_MODE.LOCAL && imageCfg.inheritedBackend
      ? 'Inherited local model' : imageCfg.cloudModel || imageCfg.modelId, `${size.width}×${size.height}`].filter(Boolean).join(' · ')
    : '';

  return { backends, size, summary, localRuntime, blocked };
}

/**
 * "Drag to rotate" hint shown once when a graph canvas first receives a touch
 * gesture (see `useFirstTouchHint`, wired through `useGraphCanvasInteraction`'s
 * `touchHintVisible`). Identical chrome on both graph pages — BrainGraph and
 * MemoryGraph — so it lives here instead of being copy-pasted per page.
 */
export default function TouchDragHint({ visible }) {
  if (!visible) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute top-3 inset-x-3 z-20 flex justify-center pointer-events-none"
    >
      <span className="port-media-overlay rounded-lg px-3 py-2 text-xs">Drag to rotate</span>
    </div>
  );
}

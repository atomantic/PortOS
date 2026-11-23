/**
 * `useEscapeKey(active, handler)` — call `handler` on Escape while `active`.
 *
 * Use when: Non-modal dismissables (in-context popovers/cards); Modal owns Esc for true modals.
 */

import { useEscLayer } from '../components/ui/Modal.jsx';

/**
 * Call `handler` when Escape is pressed, but only while `active` is truthy.
 * The layer is registered/removed with `active`, so a closed popover/card
 * holds no Esc claim. Use for non-modal dismissables (the
 * Modal component already owns Esc for true modals). A child control can
 * consume Escape with preventDefault() to dismiss its own layer first.
 *
 * `handler` is read through a ref, so an inline arrow recreated every parent
 * render (the common call-site shape) doesn't tear down + re-add the global
 * keydown listener on each render — only `active` flips the subscription.
 */
export default function useEscapeKey(active, handler) {
  // Join Modal's shared innermost-first Esc stack: Modal's listeners are
  // installed at module load and swallow Escape, so a runtime window listener
  // here would always lose to an enclosing Modal/Drawer.
  useEscLayer(Boolean(active), handler);
}

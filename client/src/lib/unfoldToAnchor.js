/**
 * Reveal an anchor that sits inside folded sections, so a deep link (a stage's
 * "Next: post to X", a checklist's "Post here") lands on it. Opens every
 * `<details>` around it, and presses the toggle of every `[data-fold]` element
 * around it (the element itself included) whose `[data-fold-toggle]` reads
 * aria-expanded="false". Returns true when a React-state fold was pressed, so
 * the caller can wait a frame for it to render before scrolling.
 */
export function unfoldToAnchor(el) {
  if (!el) return false;
  for (let fold = el.closest('details'); fold; fold = fold.parentElement?.closest('details')) fold.open = true;
  let pressed = false;
  for (let fold = el.closest('[data-fold]'); fold; fold = fold.parentElement?.closest('[data-fold]')) {
    // a fold's own header toggle comes before anything nested in its body
    const toggle = fold.querySelector('[data-fold-toggle]');
    if (toggle?.getAttribute('aria-expanded') === 'false') { toggle.click(); pressed = true; }
  }
  return pressed;
}

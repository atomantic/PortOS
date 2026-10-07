import { describe, it, expect, vi } from 'vitest';
import { unfoldToAnchor } from './unfoldToAnchor.js';

describe('unfoldToAnchor', () => {
  it('opens details around the anchor and presses each folded toggle, outermost too', () => {
    document.body.innerHTML = `
      <details id="outer"><summary>s</summary>
        <section data-fold><h3><button data-fold-toggle aria-expanded="false">Card</button></h3>
          <div hidden>
            <li id="row" data-fold><h4><button data-fold-toggle aria-expanded="false">Row</button></h4></li>
          </div>
        </section>
      </details>`;
    const clicks = [];
    for (const b of document.querySelectorAll('[data-fold-toggle]')) b.addEventListener('click', () => clicks.push(b.textContent));
    expect(unfoldToAnchor(document.getElementById('row'))).toBe(true);
    expect(document.getElementById('outer').open).toBe(true);
    expect(clicks.sort()).toEqual(['Card', 'Row']);
  });

  it('leaves open folds alone and says nothing was pressed', () => {
    document.body.innerHTML = '<section data-fold><button data-fold-toggle aria-expanded="true">Card</button><p id="a">x</p></section>';
    const click = vi.fn();
    document.querySelector('button').addEventListener('click', click);
    expect(unfoldToAnchor(document.getElementById('a'))).toBe(false);
    expect(click).not.toHaveBeenCalled();
    expect(unfoldToAnchor(null)).toBe(false);
  });
});

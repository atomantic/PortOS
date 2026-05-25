import { describe, it, expect, beforeEach } from 'vitest';
import { buildIndex, extractVisibleText } from './domIndex.js';

// jsdom doesn't do layout, so isVisible()'s offsetParent / getBoundingClientRect
// checks would drop every element. Stub the geometry so elements register as
// visible for these structural tests.
const makeVisible = () => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return this.parentNode; },
  });
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0 };
  };
};

describe('domIndex buildIndex — lazy vs eager text', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <h1>Tasks</h1>
        <p>Three tasks pending.</p>
        <button>Add task</button>
      </main>
    `;
    makeVisible();
  });

  it('omits the visible-text blob and sets textOnDemand by default (lazy)', () => {
    const idx = buildIndex();
    expect(idx.text).toBeUndefined();
    expect(idx.textOnDemand).toBe(true);
    // Lightweight structure still ships.
    expect(idx.title).toBe('Tasks');
    expect(Array.isArray(idx.elements)).toBe(true);
    expect(idx.elements.some((e) => e.label === 'Add task')).toBe(true);
  });

  it('embeds the text eagerly when includeText:true (fallback path)', () => {
    const idx = buildIndex({ includeText: true });
    expect(typeof idx.text).toBe('string');
    expect(idx.text).toMatch(/Three tasks pending/);
    // Capability flag NOT set on the eager path — the two are mutually exclusive.
    expect(idx.textOnDemand).toBeUndefined();
  });

  it('extractVisibleText is independently callable and returns the main text', () => {
    const text = extractVisibleText();
    expect(text).toMatch(/Tasks/);
    expect(text).toMatch(/Three tasks pending/);
  });
});

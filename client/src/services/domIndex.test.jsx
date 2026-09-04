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

// #5907 — data-voice-guard is the one way to keep a control out of the voice
// index entirely ("exclude"), or to require confirmation on it regardless of
// its label ("confirm"), carried onto the index entry for the server-side
// confirmGate to read.
describe('domIndex buildIndex — data-voice-guard', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <button data-voice-guard="exclude">Secret internal control</button>
        <button data-voice-guard="confirm">Send</button>
        <button>Save</button>
      </main>
    `;
    makeVisible();
  });

  it('never indexes an exclude-guarded control', () => {
    const idx = buildIndex();
    expect(idx.elements.some((e) => e.label === 'Secret internal control')).toBe(false);
  });

  it('does not assign a data-voice-ref to an excluded control', () => {
    buildIndex();
    const excluded = document.querySelector('button[data-voice-guard="exclude"]');
    expect(excluded.hasAttribute('data-voice-ref')).toBe(false);
  });

  it('carries guard: "confirm" onto the indexed entry', () => {
    const idx = buildIndex();
    const send = idx.elements.find((e) => e.label === 'Send');
    expect(send.guard).toBe('confirm');
  });

  it('leaves an unannotated control with no guard field', () => {
    const idx = buildIndex();
    const save = idx.elements.find((e) => e.label === 'Save');
    expect(save.guard).toBeUndefined();
  });
});

// The annotation resolves from the nearest annotated ancestor so a container
// covers everything inside it — annotating each descendant by hand would miss
// whichever control gets added next.
describe('domIndex buildIndex — data-voice-guard on a container', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <div data-voice-guard="exclude">
          <button>Widget stop</button>
        </div>
        <div data-voice-guard="confirm">
          <button>Publish</button>
          <div data-voice-guard="exclude"><button>Nested opt-out</button></div>
        </div>
        <button>Save</button>
      </main>
    `;
    makeVisible();
  });

  it('excludes every control inside an exclude-marked container', () => {
    const idx = buildIndex();
    expect(idx.elements.some((e) => e.label === 'Widget stop')).toBe(false);
  });

  it('carries guard: "confirm" onto a control inside a confirm-marked container', () => {
    const idx = buildIndex();
    expect(idx.elements.find((e) => e.label === 'Publish').guard).toBe('confirm');
  });

  it('lets a nested annotation win over its ancestor', () => {
    const idx = buildIndex();
    expect(idx.elements.some((e) => e.label === 'Nested opt-out')).toBe(false);
  });

  it('leaves a control outside every annotated container unguarded', () => {
    const idx = buildIndex();
    expect(idx.elements.find((e) => e.label === 'Save').guard).toBeUndefined();
  });
});

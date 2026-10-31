import { describe, expect, it } from 'vitest';
import { suppressIosFocusZoom } from './iosFocusZoom.js';

const VIEWPORT = 'width=device-width, initial-scale=1.0';

function fakeWindow({ touchPoints, touchCallout }) {
  const doc = document.implementation.createHTMLDocument('t');
  doc.head.innerHTML = `<meta name="viewport" content="${VIEWPORT}">`;
  return {
    document: doc,
    navigator: { maxTouchPoints: touchPoints },
    CSS: { supports: (prop) => prop === '-webkit-touch-callout' && touchCallout },
    viewport: () => doc.querySelector('meta[name="viewport"]').getAttribute('content'),
  };
}

describe('suppressIosFocusZoom', () => {
  it('caps the viewport scale once on iOS WebKit, where pinch-zoom still works', () => {
    const win = fakeWindow({ touchPoints: 5, touchCallout: true });
    expect(suppressIosFocusZoom(win)).toBe(true);
    expect(suppressIosFocusZoom(win)).toBe(false);
    expect(win.viewport()).toBe(`${VIEWPORT}, maximum-scale=1`);
  });

  // maximum-scale locks pinch-zoom on Android Chrome and desktop engines.
  it.each([
    ['an Android touch browser', { touchPoints: 5, touchCallout: false }],
    ['a desktop browser', { touchPoints: 0, touchCallout: false }],
  ])('leaves the viewport untouched on %s', (_name, env) => {
    const win = fakeWindow(env);
    expect(suppressIosFocusZoom(win)).toBe(false);
    expect(win.viewport()).toBe(VIEWPORT);
  });
});

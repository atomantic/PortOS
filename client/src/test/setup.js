import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { installTestStorage } from './storagePolyfill.js';
import { installFormValidityFix } from './formValidityPolyfill.js';
import { ASYNC_UTIL_TIMEOUT_MS } from './timeouts.js';

// testing-library defaults asyncUtilTimeout to 1000ms, which is far too tight for
// this suite: several views debounce at 500ms and a couple wait on a debounce plus
// a retry, so under parallel-worker CPU contention that budget produces phantom
// failures unrelated to the component under test (#3474). The value and its
// relationship to the per-test budget in vitest.config.js live in timeouts.js —
// they are derived from one another on purpose, so read that before changing it.
configure({ asyncUtilTimeout: ASYNC_UTIL_TIMEOUT_MS });

// Guarantee a working localStorage/sessionStorage before any test runs, regardless
// of how the environment exposes Storage. See storagePolyfill.js / #1438.
installTestStorage();

// Make constraint validation match a browser so implicit form submission isn't
// swallowed by a float-modulo step check. See formValidityPolyfill.js / #6144.
installFormValidityFix();

// The test DOM doesn't implement Element.prototype.scrollIntoView; components call it
// (often from a requestAnimationFrame callback that can fire AFTER a test unmounts),
// and the resulting unhandled error fails the whole run despite passing assertions
// (#2958). Stub it once, guarded so it never clobbers a real implementation — on real
// DOM elements scrollIntoView is always present, so production is unaffected.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// Stub the media/canvas methods the test DOM omits, to eliminate stderr noise in test runs
if (typeof HTMLMediaElement !== 'undefined') {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
}

if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = () => ({
    fillRect: () => {},
    clearRect: () => {},
    getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {},
    createImageData: () => ({ data: new Uint8ClampedArray(0) }),
    setTransform: () => {},
    drawImage: () => {},
    save: () => {},
    fillText: () => {},
    restore: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    stroke: () => {},
    translate: () => {},
    scale: () => {},
    rotate: () => {},
    arc: () => {},
    fill: () => {},
    measureText: (text) => ({ width: String(text ?? '').length * 6 }),
    transform: () => {},
    rect: () => {},
    clip: () => {},
    // Path/text/gradient members the graph + poster canvases use. A gradient
    // has to be an object with addColorStop, because callers assign it to
    // fillStyle and keep drawing.
    roundRect: () => {},
    quadraticCurveTo: () => {},
    strokeText: () => {},
    setLineDash: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
  });
}

// Fail any test that triggers React's "not wrapped in act(...)" warning (#2406).
// These mark unsettled async state updates — usually a mount-effect fetch whose
// mocked promise resolves after the sync test body — which vitest hides locally
// for passing tests but which flood CI logs and are the mechanism behind
// timing-dependent CI flakes. Fix by settling inside act after render:
//   await act(async () => {});
// (see renderConfig in src/components/meatspace/post/PostDrillConfig.test.jsx).
// Tests that assert an in-flight pending state should settle at the END instead.
const actWarnings = [];
const originalConsoleError = console.error;
console.error = (...args) => {
  originalConsoleError(...args);
  if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) {
    actWarnings.push(String(args[1] ?? 'unknown component'));
  }
};

afterEach(() => {
  cleanup();
  // Reset storage between tests so a file that forgets its own `clear()` can't leak
  // state into the next — reinforces the isolation the polyfill restores.
  globalThis.localStorage?.clear();
  globalThis.sessionStorage?.clear();
  if (actWarnings.length > 0) {
    const components = [...new Set(actWarnings)].join(', ');
    actWarnings.length = 0;
    throw new Error(
      `React state updated outside act(...) in: ${components}. ` +
      'Settle pending mount/interaction promises inside the test — e.g. ' +
      '`await act(async () => {})` after render — see src/test/setup.js for the idiom.'
    );
  }
});

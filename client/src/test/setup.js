import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { installTestStorage } from './storagePolyfill.js';

// Guarantee a working localStorage/sessionStorage before any test runs, regardless
// of how jsdom exposes Storage in this environment. See storagePolyfill.js / #1438.
installTestStorage();

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

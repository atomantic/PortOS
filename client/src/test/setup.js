import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { installTestStorage } from './storagePolyfill.js';

// Guarantee a working localStorage/sessionStorage before any test runs, regardless
// of how jsdom exposes Storage in this environment. See storagePolyfill.js / #1438.
installTestStorage();

afterEach(() => {
  cleanup();
  // Reset storage between tests so a file that forgets its own `clear()` can't leak
  // state into the next — reinforces the isolation the polyfill restores.
  globalThis.localStorage?.clear();
  globalThis.sessionStorage?.clear();
});

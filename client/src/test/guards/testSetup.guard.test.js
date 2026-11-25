// @vitest-environment happy-dom
import { getConfig } from '@testing-library/dom';
import { expect, it } from 'vitest';
import { ASYNC_UTIL_TIMEOUT_MS } from '../timeouts.js';

it('applies the shared Testing Library timeout in DOM tests', () => {
  expect(getConfig().asyncUtilTimeout).toBe(ASYNC_UTIL_TIMEOUT_MS);
});

/**
 * Smoke test for universeBuilderRender.js
 *
 * Verifies the module imports correctly and exports the expected function.
 * Full integration tests for the render flow live in universeBuilder.test.js.
 */

import { describe, it, expect } from 'vitest';

describe('universeBuilderRender', () => {
  it('exports renderUniverseJobs as a function', async () => {
    const mod = await import('./universeBuilderRender.js');
    expect(typeof mod.renderUniverseJobs).toBe('function');
  });
});

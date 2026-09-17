import { describe, expect, it } from 'vitest';
import { catalogSummary } from './providerManagement.js';

describe('catalogSummary', () => {
  it('keeps never-asked distinct from asked-and-empty', () => {
    expect(catalogSummary({ state: 'unknown', models: [] }).text).toBe('Not refreshed yet');
    expect(catalogSummary({ state: 'known', models: [] }).text).toBe('No models installed on this backend');
  });

  it('reports a failed refresh as retained models, never as an empty backend', () => {
    const summary = catalogSummary({ state: 'failed', models: ['a'], error: 'timed out' });
    expect(summary.text).toContain('1 previously known model');
    expect(summary.detail).toBe('timed out');
  });
});

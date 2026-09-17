import { describe, expect, it } from 'vitest';
import { catalogSummary, draftFromTransports, serviceReadinessCopy, transportsFromDraft } from './providerManagement.js';

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

describe('serviceReadinessCopy', () => {
  it('names a readiness this build does not know rather than calling it "no definition"', () => {
    expect(serviceReadinessCopy('needs-credential').label).toBe('Needs a credential');
    expect(serviceReadinessCopy('quota-exhausted')).toEqual({ tone: 'muted', label: 'quota-exhausted', reason: 'is quota-exhausted' });
  });
});

describe('transport drafts', () => {
  it('round-trips the wire shape and drops a blank endpoint rather than sending an empty one', () => {
    const wire = { openai: { baseUrl: 'http://localhost:11434/v1' }, anthropic: { baseUrl: 'http://localhost:11434' } };
    expect(transportsFromDraft(draftFromTransports(wire))).toEqual(wire);
    expect(transportsFromDraft({ openai: '  ', anthropic: ' http://h/ ' })).toEqual({ anthropic: { baseUrl: 'http://h/' } });
  });
});

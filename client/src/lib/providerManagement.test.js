import { describe, expect, it } from 'vitest';
import {
  catalogSummary, classifyServiceCategory, draftFromTransports, serviceMatchesQuery, servicePresetAction,
  serviceReadinessCopy, sortServices, transportsFromDraft,
} from './providerManagement.js';

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

describe('classifyServiceCategory', () => {
  const row = (plan, definition) => ({ plan, definition });

  it('classifies from the definition, not the plan this instance selected', () => {
    const mixed = { family: 'api-key', plans: ['free', 'paid'] };
    expect(classifyServiceCategory(row('free', mixed))).toBe('free-and-paid');
    expect(classifyServiceCategory(row('paid', mixed))).toBe('free-and-paid');
    expect(classifyServiceCategory(row('paid', { family: 'local', plans: ['local'] }))).toBe('local');
    expect(classifyServiceCategory(row('free', { family: 'local', plans: ['free', 'paid'] }))).toBe('local');
    expect(classifyServiceCategory(row('free', { family: 'subscription', plans: ['subscription'] }))).toBe('subscriptions');
    expect(classifyServiceCategory(row('subscription', { family: 'subscription', plans: ['free'] }))).toBe('subscriptions');
  });

  it('keeps single-plan, fleet, subscription-plan, and unclassifiable rows distinct', () => {
    expect(classifyServiceCategory(row('free', { family: 'api-key', plans: ['free'] }))).toBe('free-only');
    expect(classifyServiceCategory(row('free', { family: 'fleet', plans: ['free'] }))).toBe('free-only');
    expect(classifyServiceCategory(row('paid', { family: 'api-key', plans: ['paid'] }))).toBe('paid-only');
    expect(classifyServiceCategory(row('subscription', { family: 'api-key', plans: ['subscription'] }))).toBe('subscriptions');
    expect(classifyServiceCategory(row('paid', null))).toBe('other');
    expect(classifyServiceCategory(row('paid', { family: 'api-key' }))).toBe('other');
    expect(classifyServiceCategory(row('paid', { family: 'api-key', plans: ['enterprise'] }))).toBe('other');
  });
});

describe('service search and sort', () => {
  const alpha = { id: 'b', label: 'Alpha', slug: 'alpha', readiness: 'ready', definition: { label: 'Alpha Runtime', id: 'alpha-rt', family: 'local' } };
  const zed = { id: 'a', label: 'Alpha', slug: 'zed', readiness: 'ready', definition: { label: 'Zed', id: 'zed', family: 'local' } };
  const blocked = { id: 'c', label: 'Blocked', slug: 'blocked', readiness: 'needs-credential', definition: { label: 'Blocked', id: 'blocked', family: 'api-key' } };

  it('matches label, slug, and definition, and ignores a blank query', () => {
    expect(serviceMatchesQuery(alpha, '  ')).toBe(true);
    expect(serviceMatchesQuery(alpha, 'ALPHA-RT')).toBe(true);
    expect(serviceMatchesQuery(alpha, 'zed')).toBe(false);
  });

  it('breaks readiness and preset-count ties by name, then slug', () => {
    expect(sortServices([zed, blocked, alpha], 'readiness').map((service) => service.slug)).toEqual(['alpha', 'zed', 'blocked']);
    const count = (service) => (service.slug === 'blocked' ? 2 : 0);
    expect(sortServices([alpha, zed, blocked], 'presets', count).map((service) => service.slug)).toEqual(['blocked', 'alpha', 'zed']);
    expect(sortServices([zed, alpha], 'name').map((service) => service.slug)).toEqual(['alpha', 'zed']);
  });
});

describe('servicePresetAction', () => {
  const base = { label: 'NVIDIA NIM', slug: 'nvidia-nim', enabled: true, readiness: 'ready', definition: { id: 'nvidia-nim' } };

  it('names a ready service and refuses one that cannot be composed', () => {
    expect(servicePresetAction(base)).toEqual({ enabled: true, label: 'Create preset from NVIDIA NIM' });
    expect(servicePresetAction({ ...base, definition: null, readiness: 'unknown-definition' }).label).toMatch(/no definition to compose from/);
    expect(servicePresetAction({ ...base, enabled: false, readiness: 'disabled' }).label).toMatch(/switched off/);
    expect(servicePresetAction({ ...base, readiness: 'needs-credential' }).label).toMatch(/needs a credential/);
    expect(servicePresetAction({ ...base, readiness: 'needs-endpoint' }).enabled).toBe(false);
  });
});

describe('transport drafts', () => {
  it('round-trips the wire shape and drops a blank endpoint rather than sending an empty one', () => {
    const wire = { openai: { baseUrl: 'http://localhost:11434/v1' }, anthropic: { baseUrl: 'http://localhost:11434' } };
    expect(transportsFromDraft(draftFromTransports(wire))).toEqual(wire);
    expect(transportsFromDraft({ openai: '  ', anthropic: ' http://h/ ' })).toEqual({ anthropic: { baseUrl: 'http://h/' } });
  });
});

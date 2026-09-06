/**
 * The two sentinel rules in the connection-graph reader that a rendered test
 * cannot pin cheaply, and whose failure is silent rather than loud:
 *
 *   - an EMPTY `selectedModels` means "the whole shared catalog", not "none".
 *     Reading it as none blanks every model menu on the install the moment the
 *     graph turns on, with no error anywhere.
 *   - `unknown` / `known`-and-empty / `failed` are three different answers.
 *     Collapsing any two into "0 models" is exactly what the catalog state
 *     field exists to prevent.
 *
 * The joining itself is exercised through the rendered management panel
 * (`components/providers/ProviderConnections.test.jsx`).
 */
import { describe, expect, it } from 'vitest';
import { bindingModelOffer, catalogSummary, groupGraphByConnection, staleSelectedModels } from './providerManagement.js';

const connection = (models, state = 'known') => ({
  id: 'conn-1', catalog: { state, models },
});

describe('bindingModelOffer', () => {
  it('offers the whole catalog when a binding has never been narrowed', () => {
    expect(bindingModelOffer(connection(['a', 'b']), { selectedModels: [] }))
      .toEqual([{ model: 'a', selected: true }, { model: 'b', selected: true }]);
  });

  it('offers only the chosen subset once one exists', () => {
    expect(bindingModelOffer(connection(['a', 'b']), { selectedModels: ['b'] }))
      .toEqual([{ model: 'a', selected: false }, { model: 'b', selected: true }]);
  });

  it('keeps catalog order rather than floating the selected ones', () => {
    expect(bindingModelOffer(connection(['a', 'b', 'c']), { selectedModels: ['c'] }).map((e) => e.model))
      .toEqual(['a', 'b', 'c']);
  });
});

describe('staleSelectedModels', () => {
  it('reports a selection the catalog no longer carries', () => {
    expect(staleSelectedModels(connection(['a']), { selectedModels: ['a', 'gone'] })).toEqual(['gone']);
  });

  it('reports nothing for a never-narrowed binding', () => {
    expect(staleSelectedModels(connection(['a']), { selectedModels: [] })).toEqual([]);
  });
});

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

describe('groupGraphByConnection', () => {
  it('keeps a connection with no bindings, so it stays cleanable', () => {
    const groups = groupGraphByConnection({ connections: [connection(['a'])], bindings: [], routes: [] });
    expect(groups).toHaveLength(1);
    expect(groups[0].bindings).toEqual([]);
  });

  it('orders a binding’s routes cli → tui → api however the server listed them', () => {
    const groups = groupGraphByConnection({
      connections: [connection(['a'])],
      bindings: [{ id: 'b1', connectionId: 'conn-1', harnessId: 'claude', label: '' }],
      routes: [
        { providerId: 'p-api', bindingId: 'b1', mode: 'api' },
        { providerId: 'p-tui', bindingId: 'b1', mode: 'tui' },
        { providerId: 'p-cli', bindingId: 'b1', mode: 'cli' },
      ],
    });
    expect(groups[0].bindings[0].routes.map((route) => route.mode)).toEqual(['cli', 'tui', 'api']);
    // An unlabeled binding falls back to its harness's display name.
    expect(groups[0].bindings[0].label).toBe('Claude Code');
  });
});

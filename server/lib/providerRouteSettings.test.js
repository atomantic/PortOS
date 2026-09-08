/**
 * The two contracts the route-override boundary tests cannot pin (#6369).
 *
 * Everything about APPLYING an override is covered end to end in
 * `routes/providers.connectionManagement.test.js`. What a request never
 * exercises is the pair of couplings that would fail SILENTLY:
 *
 *   - the HTTP schema and the published field table drifting apart, which makes
 *     a field either uneditable or unpublished with no error anywhere;
 *   - the stale-edit fingerprint depending on something other than the values,
 *     which turns every save into a spurious 409 (or, worse, stops catching a
 *     real concurrent edit).
 */

import { describe, expect, it } from 'vitest';
import {
  ROUTE_SETTING_KEYS,
  routeSettingKeys,
  routeSettingsFor,
  routeSettingsRevision,
} from './providerRouteSettings.js';
import { providerRouteSettingsUpdateSchema } from './validation.js';

/** One legal value per published key, so the schema can be probed key by key. */
const SAMPLE = {
  args: ['--verbose'],
  timeout: 60000,
  effort: 'high',
  defaultModel: 'example-model',
  lightModel: 'example-model',
  mediumModel: 'example-model',
  heavyModel: 'example-model',
  ultraModel: 'example-model',
};

describe('the accepted keys and the published keys', () => {
  it('lets the HTTP schema through for every field a route publishes', () => {
    // A field added to the table but not to the schema would be published on the
    // graph, rendered as an input, and 400 on save with no other test noticing.
    expect(Object.keys(SAMPLE).sort()).toEqual([...ROUTE_SETTING_KEYS].sort());
    for (const key of ROUTE_SETTING_KEYS) {
      const parsed = providerRouteSettingsUpdateSchema
        .safeParse({ expectedRevision: 'example-fingerprint', settings: { [key]: SAMPLE[key] } });
      expect(parsed.success, key).toBe(true);
    }
  });

  it('refuses a patch that names nothing, rather than rewriting the provider file', () => {
    expect(providerRouteSettingsUpdateSchema
      .safeParse({ expectedRevision: 'example-fingerprint', settings: {} }).success).toBe(false);
  });

  it('keeps spawn arguments off a direct API route', () => {
    expect(routeSettingKeys('cli')).toContain('args');
    expect(routeSettingKeys('api')).not.toContain('args');
    // An unrecognized mode is not a route, so it offers nothing rather than
    // defaulting to the full set.
    expect(routeSettingKeys('process')).toEqual([]);
  });
});

describe('the stale-edit fingerprint', () => {
  const provider = {
    id: 'example-cli',
    type: 'cli',
    command: 'claude',
    args: ['--verbose'],
    timeout: 60000,
    effort: 'high',
    defaultModel: 'example-model',
  };

  it('ignores the order the record happens to store its keys in', () => {
    const shuffled = { command: provider.command, effort: 'high', type: 'cli', args: ['--verbose'], id: provider.id, timeout: 60000, defaultModel: 'example-model' };
    expect(routeSettingsRevision(routeSettingsFor(shuffled)))
      .toBe(routeSettingsRevision(routeSettingsFor(provider)));
  });

  it('changes when any published value changes', () => {
    const before = routeSettingsRevision(routeSettingsFor(provider));
    for (const change of [{ args: [] }, { timeout: 61000 }, { effort: 'low' }, { heavyModel: 'other-model' }]) {
      expect(routeSettingsRevision(routeSettingsFor({ ...provider, ...change }))).not.toBe(before);
    }
  });

  it('reads an absent pin and a cleared pin as the same state', () => {
    // Otherwise a record that never had a `lightModel` and one whose pin was
    // removed would fingerprint differently, and one of them would 409 forever.
    expect(routeSettingsFor(provider).lightModel).toBeNull();
    expect(routeSettingsRevision(routeSettingsFor({ ...provider, lightModel: '' })))
      .toBe(routeSettingsRevision(routeSettingsFor(provider)));
  });
});

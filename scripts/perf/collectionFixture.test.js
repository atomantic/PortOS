import { describe, expect, it } from 'vitest';
import { startCollectionFixture, validateFixtureEnvironment } from './collectionFixture.js';

describe('collection fixture isolation gate', () => {
  it('refuses unsafe destinations before creating resources or importing server modules', async () => {
    for (const env of [
      { PGDATABASE: 'portos' }, { PGDATABASE: 'other_test', TEST_DB_OK: '1' },
      { PORTOS_DATA_ROOT: '/example/live-install' }, { PGHOST: 'example.com' },
      { DATABASE_URL: 'postgres://example.com/portos_test' }, { PGSERVICE: 'production' },
    ]) {
      await expect(startCollectionFixture({ env, clientDist: '/does-not-exist' })).rejects.toThrow(/Fixture|Unset|Remove/);
    }
    expect(() => validateFixtureEnvironment({}, '0.0.0.0')).toThrow('127.0.0.1');
    expect(() => validateFixtureEnvironment({ PGDATABASE: 'portos_test', PGHOST: 'localhost' })).not.toThrow();
  });
});

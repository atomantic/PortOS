/**
 * The real tables behind the native usage store: BIGINT file facts survive as exact
 * strings, a re-read replaces only its own row, and a rebuild request keeps every row.
 *
 * `*.db.test.js` runs ONLY via `npm run test:db` against `portos_test`. That database is
 * shared across worktrees, so rows use a per-run nonce and are removed by it afterwards.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { checkHealth, close, ensureSchema, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';

vi.mock('../lib/pgFileFacade.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, isFileBackend: () => false,
    createPgFileFacade: options => actual.createPgFileFacade({ ...options, isFile: () => false }) };
});
const store = await import('./nativeUsageStore.js');

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch(error => ({ connected: false, error: error?.message }));
  if (!health.connected) skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  else {
    await ensureSchema();
    dbReady = true;
  }
}
const runDb = requireDbOrSkip('services/nativeUsageStore.db.test', dbReady, skipReason);

const nonce = randomUUID();
const CLAUDE = `test-claude-${nonce}`;
const GROK = `test-grok-${nonce}`;
const KIND = `test-kind-${nonce}`;
const projection = { coverage: { files: 1 }, records: [{ recordKey: 'a'.repeat(64), values: [1, 2, 3, 4] }] };
const row = (sourceKey, extra = {}) => ({ family: CLAUDE, sourceKey, sizeBytes: '12', mtimeNs: '1772323200123456789', validator: 'claude-retained-messages/1', projection, ...extra });

describe.skipIf(!runDb)('native usage store tables', () => {
  afterAll(async () => {
    await query('DELETE FROM native_usage_sources WHERE family = ANY($1)', [[CLAUDE, GROK]]);
    await query('DELETE FROM native_usage_snapshots WHERE kind = $1', [KIND]);
    await close();
  });

  it('keeps nanosecond facts exact and replaces only the re-read source', async () => {
    await store.saveNativeUsageSource(row('a'));
    await store.saveNativeUsageSource(row('a', { family: GROK }));
    await store.saveNativeUsageSource(row('a', { sizeBytes: '13', mtimeNs: '1772323200123456790', projection: { coverage: {}, records: [] } }));
    expect(await store.listNativeUsageSourceFacts(CLAUDE)).toEqual([{ sourceKey: 'a', sizeBytes: '13', mtimeNs: '1772323200123456790',
      validator: 'claude-retained-messages/1', rereadRequested: false }]);
    expect(await store.loadNativeUsageSourceProjections(CLAUDE)).toEqual([{ sourceKey: 'a', validator: 'claude-retained-messages/1', projection: { coverage: {}, records: [] } }]);
    expect(await store.loadNativeUsageSourceProjections(GROK)).toEqual([{ sourceKey: 'a', validator: 'claude-retained-messages/1', projection }]);
  });

  it('marks sources for a re-read without touching their projections, until each is saved again', async () => {
    await store.saveNativeUsageSource(row('b'));
    await store.requestNativeUsageSourceReread();
    const fact = async () => (await store.listNativeUsageSourceFacts(CLAUDE)).find(({ sourceKey }) => sourceKey === 'b');
    expect((await fact()).rereadRequested).toBe(true);
    expect((await store.loadNativeUsageSourceProjections(CLAUDE)).find(({ sourceKey }) => sourceKey === 'b').projection).toEqual(projection);
    await store.saveNativeUsageSource(row('b'));
    expect((await fact()).rereadRequested).toBe(false);
  });

  it('round-trips a snapshot exactly and repairs text jsonb would refuse', async () => {
    expect(await store.getNativeUsageSnapshot(KIND, 'a')).toBeNull();
    await store.saveNativeUsageSnapshot(KIND, 'a', { z: 1, a: { n: Number.MAX_SAFE_INTEGER } });
    await store.saveNativeUsageSnapshot(KIND, 'a', { z: 2, a: { n: Number.MAX_SAFE_INTEGER }, broken: 'bad\u0000unit' });
    expect(await store.getNativeUsageSnapshot(KIND, 'a')).toEqual({ z: 2, a: { n: Number.MAX_SAFE_INTEGER }, broken: 'bad\uFFFDunit' });
  });
});

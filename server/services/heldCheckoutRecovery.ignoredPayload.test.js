import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'fs/promises';
import { realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { assertNoUniqueIgnoredCheckoutPayload } from './heldCheckoutRecovery.js';
import { getShippedMediaRegistry } from '../lib/mediaModels.js';

// The retirement boundary may delete a merged checkout without archiving it
// only when every ignored file is a recognized regenerable byproduct.
describe('assertNoUniqueIgnoredCheckoutPayload runtime byproducts', () => {
  let dir;
  const diagnostics = '.cache/test-process-diagnostics/b97ad973-9254-482f-9831-644ed080801c.json';
  const put = async (rel, body = 'x') => {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await writeFile(join(dir, rel), body);
  };

  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(join(tmpdir(), 'portos-ignored-payload-')));
    await execGit(['init', '-q'], dir);
    await writeFile(join(dir, '.gitignore'), '__pycache__/\n.cache/\nscratch/\ndata/\n');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('accepts interpreter-tagged .pyc files and the test-diagnostics receipt', async () => {
    await put('scripts/__pycache__/tool.cpython-313.pyc');
    await put('scripts/lib/__pycache__/other.cpython-315.pyc');
    await put(diagnostics, '{}');
    await expect(assertNoUniqueIgnoredCheckoutPayload(dir)).resolves.toBeUndefined();
  });

  it('accepts an unedited lazily-seeded media registry but keeps an edited one', async () => {
    const seeded = { ...getShippedMediaRegistry(), _shippedDefaults: { video: { mlx: [] } } };
    await put('data/media-models.json', JSON.stringify(seeded, null, 2));
    await expect(assertNoUniqueIgnoredCheckoutPayload(dir)).resolves.toBeUndefined();
    seeded.textEncoders = [...(seeded.textEncoders || []), { id: 'user-added' }];
    await put('data/media-models.json', JSON.stringify(seeded, null, 2));
    await expect(assertNoUniqueIgnoredCheckoutPayload(dir)).rejects.toThrow('checkout-ignored-payload-unverified');
  });

  it('accepts empty lazily-written digital-twin defaults but keeps a populated one', async () => {
    await put('data/digital-twin/meta.json', JSON.stringify({ documents: [], testHistory: [], enrichment: { completedCategories: [] } }));
    await put('data/digital-twin/chronotype.json', JSON.stringify({ confidence: 0, geneticMarkers: {}, caffeineMarkers: {}, behavioralData: null }));
    await put('data/digital-twin/longevity.json', JSON.stringify({ confidence: 0, longevityScore: 0, longevityMarkers: {}, cardiovascularMarkers: {}, timeHorizons: null }));
    await expect(assertNoUniqueIgnoredCheckoutPayload(dir)).resolves.toBeUndefined();
    await put('data/digital-twin/meta.json', JSON.stringify({ documents: [{ id: 'soul' }] }));
    await expect(assertNoUniqueIgnoredCheckoutPayload(dir)).rejects.toMatchObject({ path: 'data/digital-twin/meta.json' });
  });

  it('accepts the quality-snapshot publisher retention receipt', async () => {
    await put('.cache/quality-snapshot-merge.json', '{}');
    await expect(assertNoUniqueIgnoredCheckoutPayload(dir)).resolves.toBeUndefined();
  });

  it.each([
    ['a non-.pyc file inside __pycache__', 'scripts/__pycache__/notes.txt'],
    ['an untagged .pyc', 'scripts/__pycache__/tool.pyc'],
    ['an unrelated file under .cache', '.cache/issue-1-progress.md'],
    ['a non-UUID name under test-process-diagnostics', '.cache/test-process-diagnostics/notes.json'],
    ['an ignored file in an arbitrary directory', 'scratch/data.bin'],
  ])('keeps the checkout when it holds %s and names the path', async (_label, rel) => {
    await put('scripts/__pycache__/ok.cpython-313.pyc');
    await put(rel);
    await expect(assertNoUniqueIgnoredCheckoutPayload(dir)).rejects.toMatchObject({
      message: 'checkout-ignored-payload-unverified', path: rel,
    });
  });
});

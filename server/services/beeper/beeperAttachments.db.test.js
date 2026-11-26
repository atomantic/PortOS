import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { attachmentRelativePath, BEEPER_ATTACHMENT_MAX_BYTES } from '../../lib/beeperAttachmentPaths.js';
import { checkHealth, close, ensureSchema, query, withTransaction } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { createTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { attachmentsRoot, ensureAttachmentBytes, evictToBudget, setAttachmentKeep } from './beeperAttachments.js';
import { fetchAssetStream, headAsset } from './beeperClient.js';

const tempRoot = createTempDataRoot('portos-beeper-attachment-races-');
vi.mock('../../lib/fileUtils.js', async (original) =>
  makePathsProxy(await original(), { dataRoot: () => tempRoot }));
vi.mock('../../lib/db.js', async (original) => ({ ...await original(), query: vi.fn() }));
vi.mock('../../lib/backupSnapshotBoundary.js', async (original) => {
  const actual = await original();
  return { ...actual, withBackupAssetPublication: vi.fn(actual.withBackupAssetPublication) };
});
vi.mock('../settings.js', () => ({
  getSettings: async () => ({ beeper: { attachmentBudgetGb: 1 / (1024 ** 3) } }),
}));
vi.mock('./beeperClient.js', () => ({
  resolveBeeperConfig: async () => ({ baseUrl: 'https://example.invalid', token: null }),
  fetchAssetStream: vi.fn(),
  headAsset: vi.fn(),
}));

const health = await checkHealth().catch(error => ({ connected: false, error: error.message }));
const ready = requireDbOrSkip('services/beeper/beeperAttachments.db.test', health.connected, health.error);
if (ready) await ensureSchema();

const messageId = 'msg-example-1';
const source = 'mxc://example.invalid/original';
const replacement = 'mxc://example.invalid/replacement';
const bytes = new Uint8Array([1, 2, 3, 4]);
const storedPath = attachmentRelativePath(createHash('sha256').update(bytes).digest('hex'), 'png');
const oldPath = `aa/${'a'.repeat(64)}.png`;

async function withAttachment(localPath, test) {
  await withTransaction(async client => {
    // Keep eviction scoped to this fixture while exercising its production SQL
    // against a real copy of the attachment schema.
    await client.query('CREATE TEMP TABLE beeper_attachments (LIKE public.beeper_attachments INCLUDING DEFAULTS) ON COMMIT DROP');
    vi.mocked(query).mockImplementation((...args) => client.query(...args));
    await query(
      `INSERT INTO beeper_attachments (conversation_id, message_id, idx, mxc_id, mime_type, byte_length, local_path)
       VALUES ('11111111-1111-4111-8111-111111111111', $1, 0, $2, 'image/png', $3, $4)`,
      [messageId, source, bytes.length, localPath],
    );
    await test();
  });
}

const currentRow = async () => (await query('SELECT * FROM beeper_attachments')).rows[0];

afterAll(async () => {
  await rm(tempRoot, { force: true, recursive: true });
  if (ready) await close();
});

describe.skipIf(!ready)('Beeper attachment writes racing newer metadata', () => {
  beforeEach(async () => {
    await rm(attachmentsRoot(), { force: true, recursive: true });
    const actual = await vi.importActual('../../lib/backupSnapshotBoundary.js');
    vi.mocked(withBackupAssetPublication).mockReset().mockImplementation(actual.withBackupAssetPublication);
    vi.mocked(headAsset).mockReset().mockResolvedValue({ bytes: bytes.length });
    vi.mocked(fetchAssetStream).mockReset().mockImplementation(async () => new Response(bytes));
  });

  it.each(['pin', 'unavailable', 'replacement'])('keeps the file when the candidate changes during HEAD (%s)', change =>
    withAttachment(oldPath, async () => {
      const filePath = join(attachmentsRoot(), oldPath);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, bytes);
      vi.mocked(headAsset).mockImplementationOnce(async () => {
        if (change === 'pin') await setAttachmentKeep(messageId, 0, true);
        if (change === 'unavailable') await query('UPDATE beeper_attachments SET unavailable_at = NOW()');
        if (change === 'replacement') {
          await query('UPDATE beeper_attachments SET mxc_id = $1', [replacement]);
          vi.mocked(headAsset).mockRejectedValueOnce(new Error('Replacement source could not be reached'));
        }
        return { bytes: bytes.length };
      });

      expect(await evictToBudget()).toMatchObject({ evicted: 0, reclaimedBytes: 0, overBudget: true });
      expect((await currentRow()).local_path).toBe(oldPath);
      expect(await readFile(filePath)).toEqual(Buffer.from(bytes));
    }));

  it('rejects bytes fetched for a replaced source', () =>
    withAttachment(null, async () => {
      vi.mocked(fetchAssetStream).mockImplementationOnce(async () => {
        await query('UPDATE beeper_attachments SET mxc_id = $1, byte_length = 99', [replacement]);
        return new Response(bytes);
      });

      await expect(ensureAttachmentBytes(messageId, 0)).rejects.toMatchObject({
        status: 409, code: 'ATTACHMENT_CHANGED',
      });
      expect(await currentRow()).toMatchObject({ mxc_id: replacement, local_path: null, byte_length: '99' });
    }));

  it.each(['ASSET_UNAVAILABLE', 'ATTACHMENT_TOO_LARGE'])('keeps replacement metadata after an obsolete HEAD result (%s)', code =>
    withAttachment(null, async () => {
      vi.mocked(headAsset).mockImplementationOnce(async () => {
        await query('UPDATE beeper_attachments SET mxc_id = $1, byte_length = 99', [replacement]);
        if (code === 'ASSET_UNAVAILABLE') throw Object.assign(new Error('Original source aged out'), { code });
        return { bytes: BEEPER_ATTACHMENT_MAX_BYTES + 1 };
      });

      await expect(ensureAttachmentBytes(messageId, 0)).rejects.toMatchObject({ code });
      expect(await currentRow()).toMatchObject({ mxc_id: replacement, unavailable_at: null, byte_length: '99' });
      expect(vi.mocked(fetchAssetStream)).not.toHaveBeenCalled();
    }));

  it.each([['different', oldPath], ['identical', storedPath]])(
    'keeps a concurrent download when healing a stale path (%s content)',
    (_scenario, missingPath) => withAttachment(missingPath, async () => {
      const arrived = Promise.withResolvers();
      const resume = Promise.withResolvers();
      const actual = await vi.importActual('../../lib/backupSnapshotBoundary.js');
      vi.mocked(withBackupAssetPublication).mockImplementationOnce(async work => {
        arrived.resolve();
        await resume.promise;
        return actual.withBackupAssetPublication(work);
      });

      const stale = ensureAttachmentBytes(messageId, 0).catch(error => error);
      try {
        await Promise.race([arrived.promise, stale]);
        const fresh = await ensureAttachmentBytes(messageId, 0);
        expect(fresh).toMatchObject({ cached: false, filePath: join(attachmentsRoot(), storedPath) });
      } finally {
        resume.resolve();
      }
      expect(await stale).toMatchObject({ status: 409, code: 'ATTACHMENT_CHANGED' });
      expect((await currentRow()).local_path).toBe(storedPath);
      expect(vi.mocked(fetchAssetStream)).toHaveBeenCalledTimes(1);
    }),
  );
});

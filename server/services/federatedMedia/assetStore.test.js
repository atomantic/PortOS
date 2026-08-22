import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PATHS } from '../../lib/fileUtils.js';
import { FEDERATED_MEDIA_ASSET_TTL_MS } from '../../lib/federatedMediaWire.js';
import {
  callerAssetPrefix,
  describeFederatedMediaAsset,
  findFederatedMediaAsset,
  storeFederatedMediaAsset,
  sweepFederatedMediaAssets,
} from './assetStore.js';

// Minimal real PNG: the store sniffs magic bytes rather than trusting the
// declared Content-Type, so a placeholder buffer would be refused.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('portos-test-conditioning-image'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('jpeg-body')]);

let tempRoot;
let originalInbox;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'portos-federated-inbox-'));
  originalInbox = PATHS.federatedMediaInbox;
  PATHS.federatedMediaInbox = tempRoot;
});

afterEach(() => {
  PATHS.federatedMediaInbox = originalInbox;
  rmSync(tempRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const sha256 = async (buf) => (await import('node:crypto'))
  .createHash('sha256').update(buf).digest('hex');

const upload = async (callerId, body = PNG, mimeType = 'image/png', digest) => storeFederatedMediaAsset({
  callerId,
  mimeType,
  declaredSha256: digest ?? await sha256(body),
  body,
});

describe('federated media asset store', () => {
  it('accepts a verified image and answers with a content-addressed, caller-scoped id', async () => {
    const stored = await upload('peer-a');
    expect(stored).toMatchObject({
      wireVersion: 1,
      sha256: await sha256(PNG),
      sizeBytes: PNG.length,
      mimeType: 'image/png',
    });
    expect(stored.assetId).toBe(`${callerAssetPrefix('peer-a')}-${await sha256(PNG)}`);
    await expect(findFederatedMediaAsset('peer-a', stored.assetId)).resolves.toMatchObject({
      mimeType: 'image/png',
      sizeBytes: PNG.length,
    });
  });

  // Content-addressing is what makes a reconcile after a restart cheap: the
  // consumer re-sends the same bytes and gets the same slot back rather than a
  // second staged copy.
  it('is idempotent for identical bytes from the same caller', async () => {
    const first = await upload('peer-a');
    const second = await upload('peer-a');
    expect(second.assetId).toBe(first.assetId);
  });

  // The caller half of the id is derived from the AUTHENTICATED caller, not
  // parsed from the request — so it is an authorization check, not a namespace.
  it('refuses to resolve another caller’s asset even given its exact id', async () => {
    const stored = await upload('peer-a');
    await expect(findFederatedMediaAsset('peer-b', stored.assetId)).resolves.toBeNull();
    await expect(describeFederatedMediaAsset('peer-b', stored.assetId))
      .rejects.toMatchObject({ status: 404, code: 'MEDIA_PROVIDER_ASSET_NOT_FOUND' });
    // Identical bytes from a different caller are a different asset, not a
    // shared one — otherwise one peer could observe another peer's uploads by
    // guessing content.
    const other = await upload('peer-b');
    expect(other.assetId).not.toBe(stored.assetId);
  });

  it('rejects a digest that does not match the bytes rather than staging them', async () => {
    await expect(upload('peer-a', PNG, 'image/png', 'f'.repeat(64)))
      .rejects.toMatchObject({ code: 'MEDIA_PROVIDER_ASSET_INTEGRITY' });
    await expect(sweepFederatedMediaAssets()).resolves.toBe(0);
  });

  // The declared Content-Type is the caller's word for what this is; the magic
  // bytes are what the generator will actually open.
  it('rejects bytes whose magic number contradicts the declared type', async () => {
    await expect(upload('peer-a', JPEG, 'image/png'))
      .rejects.toMatchObject({ code: 'MEDIA_PROVIDER_ASSET_TYPE_MISMATCH' });
  });

  it('rejects a media type outside the conditioning allowlist', async () => {
    await expect(upload('peer-a', PNG, 'image/gif'))
      .rejects.toMatchObject({ status: 415, code: 'MEDIA_PROVIDER_ASSET_TYPE_UNSUPPORTED' });
  });

  it('rejects an empty body instead of staging a zero-byte conditioning image', async () => {
    await expect(upload('peer-a', Buffer.alloc(0)))
      .rejects.toMatchObject({ code: 'MEDIA_PROVIDER_ASSET_EMPTY' });
  });

  // Staged bytes are another machine's, held to run one job. They expire rather
  // than accumulating — and an expired asset must read as absent BEFORE the
  // sweep runs, or a job admitted between sweeps would render from bytes the
  // TTL had already disowned.
  it('treats an expired asset as absent and sweeps it', async () => {
    const stored = await upload('peer-a');
    const staged = (await findFederatedMediaAsset('peer-a', stored.assetId)).path;
    const stale = (Date.now() - FEDERATED_MEDIA_ASSET_TTL_MS - 60_000) / 1000;
    utimesSync(staged, stale, stale);

    await expect(findFederatedMediaAsset('peer-a', stored.assetId)).resolves.toBeNull();
    await expect(sweepFederatedMediaAssets()).resolves.toBe(1);
    expect(existsSync(staged)).toBe(false);
  });

  it('leaves a live asset alone when sweeping', async () => {
    const stored = await upload('peer-a');
    await expect(sweepFederatedMediaAssets()).resolves.toBe(0);
    await expect(findFederatedMediaAsset('peer-a', stored.assetId)).resolves.not.toBeNull();
  });

  // The id shape is the containment check: anything that is not
  // <16-hex>-<64-hex> cannot address a file, so a traversal attempt never
  // reaches the resolver.
  it.each([
    ['a traversal attempt', '../../../etc/passwd'],
    ['an absolute path', '/etc/passwd'],
    ['a bare filename', 'photo.png'],
    ['a malformed pair', `${'0'.repeat(15)}-${'a'.repeat(64)}`],
  ])('refuses %s as an asset id', async (_name, assetId) => {
    await expect(findFederatedMediaAsset('peer-a', assetId)).resolves.toBeNull();
  });

  // A file dropped into the inbox by hand — the sweep and the resolver both key
  // on the id shape, so an unparseable name is unreachable rather than a path
  // the generator could be pointed at.
  it('ignores a hand-written file whose name is not a valid asset id', async () => {
    writeFileSync(join(tempRoot, 'not-an-asset.png'), PNG);
    await expect(findFederatedMediaAsset('peer-a', 'not-an-asset')).resolves.toBeNull();
  });

  it('answers a missing inbox directory with zero swept rather than throwing', async () => {
    rmSync(tempRoot, { recursive: true, force: true });
    await expect(sweepFederatedMediaAssets()).resolves.toBe(0);
  });
});

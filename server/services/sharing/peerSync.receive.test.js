import {
  endlessChunkedRes,
  pairedPeer,
  pushFromPairedPeer,
  tmp,
  CURRENT_PORTOS_META,
  enableMusicVideoPeer,
  sampleOutline,
  installPeerSyncHooks,
} from './peerSync.test.fixture.js';
import { describe, it, expect, vi } from 'vitest';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { PORTOS_SCHEMA_VERSIONS } from '../../lib/schemaVersions.js';
import {
  listPeerSubscriptions,
  assetIntegrityForRecord,
  getRecordPayloadForPeer,
  pullRecordFromPeer,
  syncNowForPeer,
  peerSyncEvents,
} from './peerSync.js';
import { findPeerSubscription } from './peerSubscriptions.js';
import { diffAssetManifestAgainstLocal, buildAssetManifest, collectCollectionAssetReferences } from './peerSyncAssets.js';
import { getPeers } from '../instances.js';
import { getUniverse, mergeUniversesFromSync, listUniverses } from '../universeBuilder.js';
import { getSeries, mergeSeriesFromSync } from '../pipeline/series.js';
import { listIssues, listIssuesForSeries, mergeIssuesFromSync } from '../pipeline/issues.js';
import { mergeReviewFromSync } from '../pipeline/manuscriptReview.js';
import { mergeOutlineFromSync } from '../pipeline/reverseOutline.js';
import { getCollection, listCollections, mergeMediaCollectionsFromSync } from '../mediaCollections.js';
import { mergeArtistsFromSync } from '../artists/index.js';
import { mergeAlbumsFromSync } from '../albums/index.js';
import { getTrack, mergeTracksFromSync } from '../tracks/index.js';
import { getProject as getMusicVideoProject, mergeProjectsFromSync as mergeMusicVideoProjectsFromSync } from '../musicVideo/projects.js';
import { mergeLoomsFromSync } from '../fableLoom/records.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { RESPONSE_TOO_LARGE } from '../../lib/httpClient.js';
import { getBackendName } from '../memoryBackend.js';
import { getCatalogBundleForRef } from '../catalog/catalogDB.js';
import { applyRemoteChanges as applyCatalogRemoteChanges } from '../catalog/catalogSync.js';
import { listCursors } from './peerTombstoneCursors.js';

installPeerSyncHooks();

describe('peerSync', () => {
  describe('pullRecordFromPeer', () => {
    it('peer-not-found when the peer is unknown', async () => {
      vi.mocked(getPeers).mockResolvedValue([]);
      expect(await pullRecordFromPeer('nope', 'universe', 'u1')).toEqual({ pulled: false, reason: 'peer-not-found' });
    });

    it('peer-unreachable when the fetch fails', async () => {
      vi.mocked(peerFetch).mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await pullRecordFromPeer('peer-a', 'universe', 'u1')).toEqual({ pulled: false, reason: 'peer-unreachable' });
    });

    it('not-on-peer on a 404 from the peer', async () => {
      vi.mocked(peerFetch).mockResolvedValue({ ok: false, status: 404 });
      expect(await pullRecordFromPeer('peer-a', 'universe', 'u1')).toEqual({ pulled: false, reason: 'not-on-peer' });
    });

    it('invalid-payload when the peer returns a malformed body', async () => {
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ junk: true }) });
      expect(await pullRecordFromPeer('peer-a', 'universe', 'u1')).toEqual({ pulled: false, reason: 'invalid-payload' });
    });

    it('applies a valid payload and reports missingAssets count', async () => {
      vi.mocked(peerFetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ kind: 'universe', record: { id: 'u-pull' }, assetManifest: [], sourceInstanceId: 'peer-a' }),
      });
      const result = await pullRecordFromPeer('peer-a', 'universe', 'u-pull');
      expect(result.pulled).toBe(true);
      expect(typeof result.missingAssets).toBe('number');
    });

    it.each([2001, 5000])('pulls a collection with %i manifest entries and admits only its referenced assets', async (count) => {
      vi.mocked(getPeers).mockResolvedValue([pairedPeer({ address: '192.0.2.1', mediaSyncMode: 'host' })]);
      const assetManifest = Array.from({ length: count }, (_, i) => ({
        kind: 'image', filename: `collection-${i}.png`, sha256: 'a'.repeat(64),
      }));
      const items = assetManifest.map(({ filename }) => ({ kind: 'image', ref: filename }));
      const record = { id: 'col-pull', name: 'Full collection', items, updatedAt: '2026-01-01T00:00:00Z' };
      const unrelated = { kind: 'image', filename: 'unrelated.png', sha256: 'b'.repeat(64) };
      vi.mocked(peerFetch).mockResolvedValueOnce(new Response(JSON.stringify({
        kind: 'mediaCollection', record, sourceInstanceId: 'peer-a',
        assetManifest: [...assetManifest.slice(0, -1), unrelated],
      })));

      expect(await pullRecordFromPeer('peer-a', 'mediaCollection', record.id)).toEqual({ pulled: true, missingAssets: 0 });
      expect(mergeMediaCollectionsFromSync).toHaveBeenCalledWith([record], expect.anything());
      const { listHostedEntries } = await import('../peerHostedMedia.js');
      const hosted = await listHostedEntries();
      expect(Object.keys(hosted)).toHaveLength(count - 1);
      expect(hosted).toHaveProperty([`image:collection-${count - 2}.png`]);
      expect(hosted).not.toHaveProperty(['image:unrelated.png']);
    });

    it('invalid-payload when sourceInstanceId does not match the contacted peer', async () => {
      // We fetched from peer-a, but the payload claims to originate from someone
      // else — applying it would bind our reverse-subscription/asset-pull to a
      // peer we never contacted. Reject rather than trust the self-reported origin.
      vi.mocked(peerFetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ kind: 'universe', record: { id: 'u-pull' }, assetManifest: [], sourceInstanceId: 'peer-b' }),
      });
      expect(await pullRecordFromPeer('peer-a', 'universe', 'u-pull'))
        .toEqual({ pulled: false, reason: 'invalid-payload' });
    });

    it('payload-too-large when the peer declares a Content-Length over the cap', async () => {
      vi.mocked(peerFetch).mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(64 * 1024 * 1024) : null) },
        json: async () => ({ kind: 'universe', record: { id: 'u-pull' }, assetManifest: [], sourceInstanceId: 'peer-a' }),
      });
      expect(await pullRecordFromPeer('peer-a', 'universe', 'u-pull'))
        .toEqual({ pulled: false, reason: 'payload-too-large' });
    });

    it('payload-too-large when a chunked body with no Content-Length streams past the cap', async () => {
      vi.mocked(peerFetch).mockResolvedValue(endlessChunkedRes());
      expect(await pullRecordFromPeer('peer-a', 'universe', 'u-pull'))
        .toEqual({ pulled: false, reason: 'payload-too-large' });
    });

    it('payload-too-large (not peer-unreachable) when the HTTPS shim trips the maxBytes cap', async () => {
      // The shim rejects with a RESPONSE_TOO_LARGE-coded Error — must map to
      // payload-too-large, consistent with the Content-Length path, not be
      // misread as offline.
      vi.mocked(peerFetch).mockRejectedValue(
        Object.assign(new Error('Response body exceeded maxBytes 16777216 (got 99999999)'), { code: RESPONSE_TOO_LARGE })
      );
      expect(await pullRecordFromPeer('peer-a', 'universe', 'u-pull'))
        .toEqual({ pulled: false, reason: 'payload-too-large' });
    });

    it('peer-unreachable for an uncoded transport error that merely says "exceed"', async () => {
      // Discrimination is on err.code, not on message prose: an unrelated
      // transport failure whose text happens to contain "exceed" must stay
      // peer-unreachable rather than being reported as an oversize payload.
      vi.mocked(peerFetch).mockRejectedValue(new Error('socket hang up: retries exceeded'));
      expect(await pullRecordFromPeer('peer-a', 'universe', 'u-pull'))
        .toEqual({ pulled: false, reason: 'peer-unreachable' });
    });

    it('invalid-payload when the returned record is not the one we requested', async () => {
      // Asked for universe/u-pull but the peer returned a different record id —
      // applying it would merge unexpected data under the requested key.
      vi.mocked(peerFetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ kind: 'universe', record: { id: 'some-other-id' }, assetManifest: [], sourceInstanceId: 'peer-a' }),
      });
      expect(await pullRecordFromPeer('peer-a', 'universe', 'u-pull'))
        .toEqual({ pulled: false, reason: 'invalid-payload' });
    });
  });

  describe('syncNowForPeer', () => {
    it('returns {ok:false} when the peer has no instanceId', async () => {
      vi.mocked(getPeers).mockResolvedValue([
        { instanceId: null, name: 'No ID Peer', enabled: true, syncEnabled: true },
      ]);
      const result = await syncNowForPeer('no-such-peer');
      expect(result).toEqual({ ok: false });
    });

    it('returns {ok:false} when the peer is not found', async () => {
      const result = await syncNowForPeer('ghost-peer');
      expect(result).toEqual({ ok: false });
    });

    it('calls backfill+retry for a peer with enabled categories and returns {ok:true}', async () => {
      vi.mocked(getPeers).mockResolvedValue([
        {
          instanceId: 'peer-a', name: 'Peer A', host: null, address: '10.0.0.2', port: 5555,
          enabled: true, syncEnabled: true,
          directions: ['outbound', 'inbound'],
          syncCategories: { universe: true, pipeline: false, mediaCollections: false },
        },
      ]);
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1', name: 'Universe 1' }]);
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Universe 1', updatedAt: '2026-01-01T00:00:00Z' });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });

      const result = await syncNowForPeer('peer-a');
      expect(result).toEqual({ ok: true });
    });
  });

  describe('buildAssetManifest', () => {
    it('hashes direct image filenames via the sidecar cache', async () => {
      await writeFile(join(PATHS.images, 'asset-1.png'), Buffer.from('image bytes'));
      const record = {
        id: 'u1',
        characters: [{ imageRefs: ['asset-1.png'] }],
      };
      const manifest = await buildAssetManifest(record);
      expect(manifest).toHaveLength(1);
      expect(manifest[0].filename).toBe('asset-1.png');
      expect(manifest[0].kind).toBe('image');
      expect(manifest[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it('skips assets whose file is missing (sender cant ship bytes it doesnt have)', async () => {
      // Regression: a null-hash entry would make every receiver diff
      // report this as "missing" even though the sender cant fulfill the
      // pull, producing a permanent "asset pending" badge in the UI.
      const record = { id: 'u1', characters: [{ imageRefs: ['ghost.png'] }] };
      const manifest = await buildAssetManifest(record);
      expect(manifest).toEqual([]);
    });

    it('returns an empty manifest for records with no asset refs', async () => {
      const manifest = await buildAssetManifest({ id: 'u1', name: 'Bare' });
      expect(manifest).toEqual([]);
    });

    it('includes sidecarSha256 in the manifest entry when sidecar is present', async () => {
      await writeFile(join(PATHS.images, 'with-sidecar.png'), Buffer.from('image bytes'));
      await writeFile(join(PATHS.images, 'with-sidecar.metadata.json'), Buffer.from(JSON.stringify({ prompt: 'a cat' })));
      const record = { id: 'u1', characters: [{ imageRefs: ['with-sidecar.png'] }] };
      const manifest = await buildAssetManifest(record);
      expect(manifest).toHaveLength(1);
      expect(manifest[0].sidecarSha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it('omits sidecarSha256 from the manifest entry when no sidecar exists', async () => {
      await writeFile(join(PATHS.images, 'no-sidecar.png'), Buffer.from('image bytes'));
      const record = { id: 'u1', characters: [{ imageRefs: ['no-sidecar.png'] }] };
      const manifest = await buildAssetManifest(record);
      expect(manifest).toHaveLength(1);
      expect(manifest[0]).not.toHaveProperty('sidecarSha256');
    });

    it('summarizes missing image sidecars for integrity without another asset walk', async () => {
      await writeFile(join(PATHS.images, 'missing-meta.png'), Buffer.from('image bytes'));
      const record = { id: 'u1', characters: [{ imageRefs: ['missing-meta.png'] }] };
      const summary = await assetIntegrityForRecord('universe', record);
      expect(summary.assetHashes).toHaveLength(1);
      expect(summary.metadataMissing).toBe(true);
    });

    it('includes live child issue assets in a series integrity summary', async () => {
      await writeFile(join(PATHS.images, 'issue-panel.png'), Buffer.from('issue image bytes'));
      vi.mocked(listIssuesForSeries).mockResolvedValue([
        { id: 'i1', seriesId: 'ser-1', stages: { storyboards: { panels: [{ imageRefs: ['issue-panel.png'] }] } } },
      ]);
      const summary = await assetIntegrityForRecord('series', { id: 'ser-1', name: 'Series' });
      expect(summary.assetHashes).toHaveLength(1);
      expect(summary.metadataMissing).toBe(true);
    });
  });

  describe('diffAssetManifestAgainstLocal', () => {
    it('returns assets we dont have on disk', async () => {
      const missing = await diffAssetManifestAgainstLocal([
        { filename: 'ghost.png', kind: 'image', sha256: 'a'.repeat(64) },
      ]);
      expect(missing).toHaveLength(1);
      expect(missing[0].filename).toBe('ghost.png');
    });

    it('skips assets we already have with matching sha', async () => {
      await writeFile(join(PATHS.images, 'have.png'), Buffer.from('hello world'));
      // "hello world" sha256
      const local = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
      const missing = await diffAssetManifestAgainstLocal([
        { filename: 'have.png', kind: 'image', sha256: local },
      ]);
      expect(missing).toEqual([]);
    });

    it('reports assets with mismatched sha as missing (peer has newer bytes)', async () => {
      await writeFile(join(PATHS.images, 'stale.png'), Buffer.from('old bytes'));
      const missing = await diffAssetManifestAgainstLocal([
        { filename: 'stale.png', kind: 'image', sha256: 'b'.repeat(64) },
      ]);
      expect(missing).toHaveLength(1);
    });

    it('ignores malformed manifest entries silently', async () => {
      const missing = await diffAssetManifestAgainstLocal([
        null,
        'not-an-object',
        { filename: '', kind: 'image' },
        { filename: 'foo.png', kind: 'mystery' },
      ]);
      expect(missing).toEqual([]);
    });

    it('strips junk fields from echoed missingAssets entries (no untrusted round-trip)', async () => {
      // Regression: the diff originally pushed the raw peer-supplied entry
      // into the missing list, so a malicious peer could amplify response
      // size or smuggle prototype-pollution attempts by attaching extra
      // fields. The receiver MUST project to {filename, kind, sha256?} only.
      const evil = {
        filename: 'absent.png',
        kind: 'image',
        sha256: 'a'.repeat(64),
        __proto__: { polluted: true },
        gigantic: 'x'.repeat(10000),
        nested: { evil: true },
      };
      const missing = await diffAssetManifestAgainstLocal([evil]);
      expect(missing).toHaveLength(1);
      expect(Object.keys(missing[0]).sort()).toEqual(['filename', 'kind', 'sha256']);
      expect(missing[0].gigantic).toBeUndefined();
      expect(missing[0].nested).toBeUndefined();
    });

    it('rejects path-traversal filenames silently (cant be used to probe local FS)', async () => {
      // Regression: a malicious peer sending `../../etc/passwd` (or backslash
      // variants on Windows checkouts) would otherwise let us join arbitrary
      // paths and reveal whether they exist via the missing/present split.
      const missing = await diffAssetManifestAgainstLocal([
        { filename: '../../etc/passwd', kind: 'image', sha256: 'a'.repeat(64) },
        { filename: '..\\windows\\system32\\config', kind: 'image' },
        { filename: 'sub/dir/asset.png', kind: 'image' },
        { filename: '/etc/hosts', kind: 'image' },
      ]);
      expect(missing).toEqual([]);
    });

    it('reports sha-mismatched videos AND image-refs as missing (not just images)', async () => {
      // Regression: stage 2 originally only sha-checked the 'image' kind,
      // letting an image-ref / video drift silently when bytes diverged
      // under the same filename — the snapshot-sync fallback was the only
      // thing that would catch it 60s later.
      await mkdir(join(tmp, 'image-refs'), { recursive: true });
      await mkdir(join(tmp, 'videos'), { recursive: true });
      // Re-route PATHS by writing into the locations the resolver uses.
      const localImageRefBytes = Buffer.from('local image-ref bytes');
      const localVideoBytes = Buffer.from('local video bytes');
      const { PATHS: livePaths } = await import('../../lib/fileUtils.js');
      livePaths.imageRefs = join(tmp, 'image-refs');
      livePaths.videos = join(tmp, 'videos');
      const { writeFile: writeFileFs } = await import('fs/promises');
      await writeFileFs(join(livePaths.imageRefs, 'ref.png'), localImageRefBytes);
      await writeFileFs(join(livePaths.videos, 'clip.mp4'), localVideoBytes);
      const remoteFakeSha = 'f'.repeat(64);
      const missing = await diffAssetManifestAgainstLocal([
        { filename: 'ref.png', kind: 'image-ref', sha256: remoteFakeSha },
        { filename: 'clip.mp4', kind: 'video', sha256: remoteFakeSha },
      ]);
      expect(missing).toHaveLength(2);
      expect(missing.map((m) => m.filename).sort()).toEqual(['clip.mp4', 'ref.png']);
    });

    it('returns image entry as missing when image hash matches but sidecar is absent', async () => {
      // The image file is already present and hash-matches; BUT the sender
      // carries a sidecarSha256 and we have no local sidecar. The diff must
      // still include the entry so the worker pulls the sidecar.
      const imageBytes = Buffer.from('hello world');
      await writeFile(join(PATHS.images, 'nosidecar.png'), imageBytes);
      // Actual sha256 of "hello world"
      const imageHash = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
      const missing = await diffAssetManifestAgainstLocal([
        { filename: 'nosidecar.png', kind: 'image', sha256: imageHash, sidecarSha256: 'a'.repeat(64) },
      ]);
      expect(missing).toHaveLength(1);
      expect(missing[0].filename).toBe('nosidecar.png');
      expect(missing[0].sidecarSha256).toBe('a'.repeat(64));
    });

    it('does NOT return an image as missing when image hash matches and sidecar gen-params match', async () => {
      // Both image and sidecar are present; the gen-params are identical — no pull needed.
      const imageBytes = Buffer.from('hello world');
      await writeFile(join(PATHS.images, 'fullmatch.png'), imageBytes);
      await writeFile(join(PATHS.images, 'fullmatch.metadata.json'), Buffer.from(JSON.stringify({ prompt: 'cat' })));
      const imageHash = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
      const { sidecarGenParamsHash } = await import('../../lib/assetHash.js');
      // The sender advertises the gen-params hash (NOT the raw-file hash).
      const senderSidecarHash = sidecarGenParamsHash({ prompt: 'cat' });
      const missing = await diffAssetManifestAgainstLocal([
        { filename: 'fullmatch.png', kind: 'image', sha256: imageHash, sidecarSha256: senderSidecarHash },
      ]);
      expect(missing).toEqual([]);
    });

    it('CONVERGENCE: image NOT re-flagged when gen-params match but the sha256 cache block differs', async () => {
      // CRITICAL regression for the churn bug. Two machines with byte-identical
      // gen-params but different per-machine `sha256` cache blocks (mtimeMs/size
      // differ) must NOT perpetually re-pull. The sidecar hash is computed over
      // gen-params ONLY (sha256 cache stripped), so it converges regardless of
      // the local cache block.
      const imageBytes = Buffer.from('hello world');
      await writeFile(join(PATHS.images, 'converge.png'), imageBytes);
      // Local sidecar: SAME gen-params, but a DIFFERENT sha256 cache block than
      // whatever the sender stamped (simulates the receiver re-stamping its own
      // local image mtime+size after a prior pull).
      await writeFile(join(PATHS.images, 'converge.metadata.json'), Buffer.from(JSON.stringify({
        prompt: 'a wizard', model: 'flux', steps: 30,
        sha256: { value: 'c'.repeat(64), mtimeMs: 111111, size: 222 },
      })));
      const imageHash = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
      const { sidecarGenParamsHash } = await import('../../lib/assetHash.js');
      // The SENDER computes the gen-params hash over its OWN sidecar, which has
      // the SAME gen-params but a DIFFERENT sha256 cache block (different mtime/size).
      const senderSidecarHash = sidecarGenParamsHash({
        prompt: 'a wizard', model: 'flux', steps: 30,
        sha256: { value: 'd'.repeat(64), mtimeMs: 999999, size: 888 },
      });
      // The receiver computes its local gen-params hash the same way.
      const localSidecarHash = sidecarGenParamsHash({
        prompt: 'a wizard', model: 'flux', steps: 30,
        sha256: { value: 'c'.repeat(64), mtimeMs: 111111, size: 222 },
      });
      // The two MUST be equal despite differing cache blocks — proves convergence.
      expect(senderSidecarHash).toBe(localSidecarHash);
      // And the diff must NOT flag the image as missing (no re-pull churn).
      const missing = await diffAssetManifestAgainstLocal([
        { filename: 'converge.png', kind: 'image', sha256: imageHash, sidecarSha256: senderSidecarHash },
      ]);
      expect(missing).toEqual([]);
    });

    it('CONVERGENCE: key-order differences across machines do not break the gen-params hash', async () => {
      const { sidecarGenParamsHash } = await import('../../lib/assetHash.js');
      const a = sidecarGenParamsHash({ prompt: 'x', model: 'flux', steps: 30 });
      const b = sidecarGenParamsHash({ steps: 30, prompt: 'x', model: 'flux' });
      expect(a).toBe(b);
    });

    it('returns image entry as missing when sidecar hash differs (peer has updated metadata)', async () => {
      const imageBytes = Buffer.from('hello world');
      const sidecarBytes = Buffer.from(JSON.stringify({ prompt: 'old prompt' }));
      await writeFile(join(PATHS.images, 'staleside.png'), imageBytes);
      await writeFile(join(PATHS.images, 'staleside.metadata.json'), sidecarBytes);
      const imageHash = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
      const missing = await diffAssetManifestAgainstLocal([
        { filename: 'staleside.png', kind: 'image', sha256: imageHash, sidecarSha256: 'b'.repeat(64) },
      ]);
      expect(missing).toHaveLength(1);
      expect(missing[0].filename).toBe('staleside.png');
    });

    it('preserves sidecarSha256 in the sanitized missing entry (no untrusted round-trip loss)', async () => {
      const missing = await diffAssetManifestAgainstLocal([
        { filename: 'absent.png', kind: 'image', sha256: 'a'.repeat(64), sidecarSha256: 'b'.repeat(64) },
      ]);
      expect(missing).toHaveLength(1);
      expect(missing[0].sidecarSha256).toBe('b'.repeat(64));
      // Junk fields still stripped.
      expect(missing[0]).not.toHaveProperty('gigantic');
    });
  });

  describe('applyIncomingPush', () => {
    it('rejects payloads without a known kind', async () => {
      await expect(pushFromPairedPeer({ kind: 'mystery', record: { id: 'x' }, sourceInstanceId: 'peer-a' }))
        .rejects.toThrow(/unknown kind/);
    });

    it('rejects pushes from sourceInstanceId="unknown"', async () => {
      // The sender's instance id is the identity we hang the cursor on.
      // Accepting an "unknown" sourceInstanceId would poison the cursor
      // table with a synthetic key that never gets cleaned up.
      await expect(pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u1' },
        sourceInstanceId: 'unknown',
      })).rejects.toThrow(/sourceInstanceId required/);
    });

    it('rejects payloads with a missing/malformed record', async () => {
      await expect(pushFromPairedPeer({
        kind: 'universe',
        record: 'not-an-object',
        sourceInstanceId: 'peer-a',
      })).rejects.toThrow(/object with a string id/);
    });

    it('dispatches universe pushes through mergeUniversesFromSync', async () => {
      await pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u1', name: 'Foo', deleted: false, deletedAt: null },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeUniversesFromSync).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'u1' })],
        { source: { via: 'peer-push', peerId: 'peer-a' }, senderSchemaVersions: {} },
      );
    });

    it('dispatches FableLoom pushes through the story merge path', async () => {
      await pushFromPairedPeer({
        kind: 'fableLoom',
        record: { id: 'loom-1', name: 'Example Story', episodes: [] },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeLoomsFromSync).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'loom-1' })],
        { source: { via: 'peer-push', peerId: 'peer-a' }, senderSchemaVersions: {} },
      );
    });

    it('dispatches music pushes through their merge entry points', async () => {
      await pushFromPairedPeer({
        kind: 'artist',
        record: { id: 'artist-1', name: 'Nova', deleted: false, deletedAt: null },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      await pushFromPairedPeer({
        kind: 'album',
        record: { id: 'album-1', title: 'Debut', deleted: false, deletedAt: null },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      await pushFromPairedPeer({
        kind: 'track',
        record: { id: 'track-1', title: 'Intro', deleted: false, deletedAt: null },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });

      // The record-kind table (#6843) passes senderSchemaVersions to every
      // merger uniformly (harmless for these three, which ignore it) — assert
      // via objectContaining rather than pinning its full shape.
      expect(mergeArtistsFromSync).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'artist-1' })],
        expect.objectContaining({ source: { via: 'peer-push', peerId: 'peer-a' } }),
      );
      expect(mergeAlbumsFromSync).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'album-1' })],
        expect.objectContaining({ source: { via: 'peer-push', peerId: 'peer-a' } }),
      );
      expect(mergeTracksFromSync).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'track-1' })],
        expect.objectContaining({ source: { via: 'peer-push', peerId: 'peer-a' } }),
      );
    });

    it('routes a bundled linkedCollection through mergeMediaCollectionsFromSync', async () => {
      const linkedCollection = {
        id: 'col-1', name: 'Universe: U', universeId: 'u1', items: [
          { kind: 'image', ref: 'a.png', addedAt: '2026-05-22T01:00:00Z' },
        ],
      };
      await pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u1', name: 'Foo', deleted: false, deletedAt: null },
        linkedCollection,
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeMediaCollectionsFromSync).toHaveBeenCalledWith(
        [linkedCollection],
        { source: { via: 'peer-push', peerId: 'peer-a' } },
      );
    });

    it('skips mergeMediaCollectionsFromSync when no linkedCollection is bundled', async () => {
      await pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u1', deleted: false, deletedAt: null },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeMediaCollectionsFromSync).not.toHaveBeenCalled();
    });

    it('routes a bundled linkedTrack through mergeTracksFromSync on a music-video push (#1858)', async () => {
      const linkedTrack = {
        id: 'track-9', title: 'Anthem', audioFilename: 'linked.mp3',
        updatedAt: '2026-06-28T00:00:00Z', deleted: false, deletedAt: null,
      };
      await pushFromPairedPeer({
        kind: 'musicVideoProject',
        record: { id: 'mv-1', name: 'Linked', trackId: 'track-9', deleted: false, deletedAt: null },
        portosMeta: CURRENT_PORTOS_META,
        linkedTrack,
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      // The project's own merge goes through the record-kind table (#6843),
      // which passes senderSchemaVersions uniformly (harmless — ignored).
      expect(mergeMusicVideoProjectsFromSync).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'mv-1' })],
        expect.objectContaining({ source: { via: 'peer-push', peerId: 'peer-a' } }),
      );
      expect(mergeTracksFromSync).toHaveBeenCalledWith(
        [linkedTrack],
        { source: { via: 'peer-push', peerId: 'peer-a' }, bundledByPeerId: 'peer-a' },
      );
    });

    it('skips linkedTrack merge when none is bundled or the project is a tombstone', async () => {
      await pushFromPairedPeer({
        kind: 'musicVideoProject',
        record: { id: 'mv-2', trackId: 'track-9', deleted: false, deletedAt: null },
        portosMeta: CURRENT_PORTOS_META,
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeTracksFromSync).not.toHaveBeenCalled();
      await pushFromPairedPeer({
        kind: 'musicVideoProject',
        record: { id: 'mv-3', trackId: 'track-9', deleted: true, deletedAt: '2026-06-29T00:00:00Z' },
        linkedTrack: { id: 'track-9', audioFilename: 'linked.mp3' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeTracksFromSync).not.toHaveBeenCalled();
    });

    it('refuses a linkedTrack whose id does not match the project trackId (#1858)', async () => {
      await pushFromPairedPeer({
        kind: 'musicVideoProject',
        record: { id: 'mv-5', trackId: 'track-A', deleted: false, deletedAt: null },
        portosMeta: CURRENT_PORTOS_META,
        linkedTrack: { id: 'track-SMUGGLED', audioFilename: 'x.mp3' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeTracksFromSync).not.toHaveBeenCalled();
    });

    it('routes a bundled manuscriptReview through mergeReviewFromSync on a series push', async () => {
      const manuscriptReview = {
        schemaVersion: 1,
        comments: [{ id: 'mrc-1', problem: 'pacing', status: 'open', updatedAt: '2026-06-02T00:00:00Z' }],
      };
      await pushFromPairedPeer({
        kind: 'series',
        record: { id: 'ser-1', name: 'S', deleted: false, deletedAt: null },
        issues: [],
        manuscriptReview,
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeReviewFromSync).toHaveBeenCalledWith('ser-1', manuscriptReview);
    });

    it('skips mergeReviewFromSync when no manuscriptReview is bundled', async () => {
      await pushFromPairedPeer({
        kind: 'series',
        record: { id: 'ser-1', name: 'S', deleted: false, deletedAt: null },
        issues: [],
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeReviewFromSync).not.toHaveBeenCalled();
    });

    it('refuses to merge manuscriptReview when the incoming series record is a tombstone', async () => {
      await pushFromPairedPeer({
        kind: 'series',
        record: { id: 'ser-1', deleted: true, deletedAt: '2026-06-02T00:00:00Z', updatedAt: '2026-06-02T00:00:00Z' },
        issues: [],
        manuscriptReview: { schemaVersion: 1, comments: [{ id: 'mrc-1', problem: 'x', status: 'open', updatedAt: '2026-06-02T00:00:00Z' }] },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeReviewFromSync).not.toHaveBeenCalled();
    });

    it('skips mergeReviewFromSync when the LOCAL series is ephemeral', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', ephemeral: true });
      await pushFromPairedPeer({
        kind: 'series',
        record: { id: 'ser-1', name: 'S', deleted: false, deletedAt: null },
        issues: [],
        manuscriptReview: { schemaVersion: 1, comments: [{ id: 'mrc-1', problem: 'x', status: 'open', updatedAt: '2026-06-02T00:00:00Z' }] },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeReviewFromSync).not.toHaveBeenCalled();
    });

    it('routes a bundled reverseOutline through mergeOutlineFromSync on a series push', async () => {
      const reverseOutline = sampleOutline();
      await pushFromPairedPeer({
        kind: 'series',
        record: { id: 'ser-1', name: 'S', deleted: false, deletedAt: null },
        issues: [],
        reverseOutline,
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeOutlineFromSync).toHaveBeenCalledWith('ser-1', reverseOutline);
    });

    it('skips mergeOutlineFromSync when no reverseOutline is bundled', async () => {
      await pushFromPairedPeer({
        kind: 'series',
        record: { id: 'ser-1', name: 'S', deleted: false, deletedAt: null },
        issues: [],
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeOutlineFromSync).not.toHaveBeenCalled();
    });

    it('refuses to merge reverseOutline when the incoming series record is a tombstone', async () => {
      await pushFromPairedPeer({
        kind: 'series',
        record: { id: 'ser-1', deleted: true, deletedAt: '2026-06-02T00:00:00Z', updatedAt: '2026-06-02T00:00:00Z' },
        issues: [],
        reverseOutline: sampleOutline(),
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeOutlineFromSync).not.toHaveBeenCalled();
    });

    it('skips mergeOutlineFromSync when the LOCAL series is ephemeral', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', ephemeral: true });
      await pushFromPairedPeer({
        kind: 'series',
        record: { id: 'ser-1', name: 'S', deleted: false, deletedAt: null },
        issues: [],
        reverseOutline: sampleOutline(),
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeOutlineFromSync).not.toHaveBeenCalled();
    });

    it('skips mergeReviewFromSync without a retry flag when the series id is malformed (security: #8355)', async () => {
      // A series id containing `../` or not matching the required "ser-" prefix
      // must not trigger a merge that could write files outside the series directory.
      const manuscriptReview = { schemaVersion: 1, comments: [{ id: 'mrc-1', problem: 'x', status: 'open', updatedAt: '2026-06-02T00:00:00Z' }] };
      const result = await pushFromPairedPeer({
        kind: 'series',
        record: { id: '../../../etc/passwd', name: 'S', deleted: false, deletedAt: null },
        issues: [],
        manuscriptReview,
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeReviewFromSync).not.toHaveBeenCalled();
      // An invalid id can never become valid — a pending flag would make the
      // sender withhold its hash and resend forever.
      expect(result.reviewSyncPending).toBeUndefined();
    });

    it('skips mergeOutlineFromSync without a retry flag when the series id is malformed (security: #8355)', async () => {
      // A series id not matching the required "ser-" prefix pattern must not
      // trigger a merge that could write files outside the series directory.
      const reverseOutline = sampleOutline();
      const result = await pushFromPairedPeer({
        kind: 'series',
        record: { id: 'evil/../../etc/passwd', name: 'S', deleted: false, deletedAt: null },
        issues: [],
        reverseOutline,
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeOutlineFromSync).not.toHaveBeenCalled();
      expect(result.outlineSyncPending).toBeUndefined();
    });

    it('refuses to merge linkedCollection when the incoming record is a tombstone', async () => {
      // Defense in depth: the sender's buildPushPayload already skips the
      // bundle for tombstones, but a buggy or malicious peer could send
      // one anyway. Receiving a collection during a delete propagation
      // would resurrect collection state for a record being torn down.
      await pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u1', deleted: true, deletedAt: '2026-05-22T03:00:00Z' },
        linkedCollection: { id: 'col-1', name: 'Universe: U', items: [] },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeMediaCollectionsFromSync).not.toHaveBeenCalled();
    });

    it('refuses to merge linkedCollection when it is not a plain object (array, primitive)', async () => {
      // Wrapping a non-plain-object in `[...]` and passing to the merge
      // function would just produce a no-op (sanitizeCollection drops
      // non-objects), but skipping early keeps the trust posture clean
      // and the failure mode obvious.
      for (const bogus of [[], ['a'], 'string', 42, true]) {
        vi.mocked(mergeMediaCollectionsFromSync).mockClear();
        await pushFromPairedPeer({
          kind: 'universe',
          record: { id: 'u1', deleted: false, deletedAt: null },
          linkedCollection: bogus,
          assetManifest: [],
          sourceInstanceId: 'peer-a',
        });
        expect(mergeMediaCollectionsFromSync).not.toHaveBeenCalled();
      }
    });

    it('preserves a collection owned by another record through the registered store', async () => {
      const record = { id: 'u1' };
      const linkedCollection = { id: 'col-1', universeId: record.id, items: [] };
      vi.mocked(getCollection).mockResolvedValue({ ...linkedCollection, universeId: 'u-other' });

      await pushFromPairedPeer({ kind: 'universe', record, linkedCollection, sourceInstanceId: 'peer-a' });

      expect(getCollection).toHaveBeenCalledWith(linkedCollection.id, { includeDeleted: true });
      expect(mergeUniversesFromSync).toHaveBeenCalledWith([record], expect.anything());
      expect(mergeMediaCollectionsFromSync).not.toHaveBeenCalled();
    });

    it('preserves an existing track through the registered track store', async () => {
      enableMusicVideoPeer();
      const record = { id: 'mv-1', trackId: 'track-1' };
      const linkedTrack = { id: record.trackId, title: 'Incoming title' };
      vi.mocked(getTrack).mockResolvedValue({ ...linkedTrack, title: 'Local title' });

      await pushFromPairedPeer({
        kind: 'musicVideoProject', record, linkedTrack, sourceInstanceId: 'peer-a', portosMeta: CURRENT_PORTOS_META,
      });

      expect(getTrack).toHaveBeenCalledWith(linkedTrack.id, { includeDeleted: true });
      expect(mergeMusicVideoProjectsFromSync).toHaveBeenCalledWith([record], expect.anything());
      expect(mergeTracksFromSync).not.toHaveBeenCalled();
    });

    it('dispatches series pushes through mergeSeriesFromSync AND mergeIssuesFromSync for bundled issues', async () => {
      await pushFromPairedPeer({
        kind: 'series',
        record: { id: 'ser-1', deleted: false, deletedAt: null },
        issues: [{ id: 'i1', seriesId: 'ser-1', deleted: false, deletedAt: null }],
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      // Goes through the record-kind table (#6843), which passes
      // senderSchemaVersions uniformly (harmless for series — ignored).
      expect(mergeSeriesFromSync).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'ser-1' })],
        expect.objectContaining({ source: { via: 'peer-push', peerId: 'peer-a' } }),
      );
      expect(mergeIssuesFromSync).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'i1' })],
        { source: { via: 'peer-push', peerId: 'peer-a' }, senderSchemaVersions: {} },
      );
    });

    it('never pulls assets for an asset-less kind, even if the payload invents image references', async () => {
      await writeFile(join(PATHS.images, 'protected.png'), 'local image');
      const result = await pushFromPairedPeer({
        kind: 'commissionFeedback',
        record: { id: 'feedback-1', imageRefs: ['protected.png'] },
        assetManifest: [{ filename: 'protected.png', kind: 'image', sha256: 'a'.repeat(64) }],
        sourceInstanceId: 'peer-a',
      });
      expect(result.missingAssets).toEqual([]);
      expect(await readFile(join(PATHS.images, 'protected.png'), 'utf8')).toBe('local image');
    });

    it.each([false, true])('scopes a manifest to its record and replaces existing bytes only on an applied merge (%s)', async (applied) => {
      await writeFile(join(PATHS.images, 'existing.png'), 'local image');
      await writeFile(join(PATHS.images, 'existing.metadata.json'), '{"prompt":"local prompt"}');
      vi.mocked(mergeUniversesFromSync).mockResolvedValue({ applied, count: applied ? 1 : 0 });
      const manifest = ['missing.png', 'existing.png', 'unrelated.png'].map((filename) => ({
        filename, kind: 'image', sha256: 'a'.repeat(64), sidecarSha256: 'b'.repeat(64),
      }));
      const result = await pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u1', imageRefs: ['missing.png', 'existing.png'] },
        assetManifest: manifest,
        sourceInstanceId: 'peer-a',
      });
      expect(result.missingAssets).toEqual(applied ? manifest.slice(0, 2) : manifest.slice(0, 1));
      expect(await readFile(join(PATHS.images, 'existing.png'), 'utf8')).toBe('local image');
      if (!applied) {
        expect(await readFile(join(PATHS.images, 'existing.metadata.json'), 'utf8')).toBe('{"prompt":"local prompt"}');
      }
    });

    it('admits only referenced series, child-issue and linked-collection assets', async () => {
      const manifest = [
        { kind: 'image', filename: 'series.png' },
        { kind: 'image', filename: 'issue.png' },
        { kind: 'video', filename: 'collection-clip.mp4' },
        { kind: 'image', filename: 'private.png' },
        { kind: 'image', filename: 'deleted.png' },
        { kind: 'image', filename: 'unrelated.png' },
      ];
      const result = await pushFromPairedPeer({
        kind: 'series', record: { id: 'ser-1', imageRefs: ['series.png'] },
        issues: [
          { id: 'issue-1', seriesId: 'ser-1', imageRefs: ['issue.png'] },
          { id: 'issue-2', seriesId: 'ser-1', ephemeral: true, imageRefs: ['private.png'] },
          { id: 'issue-3', seriesId: 'ser-1', deleted: true, imageRefs: ['deleted.png'] },
        ],
        linkedCollection: { id: 'collection-1', seriesId: 'ser-1', items: [{ kind: 'video', ref: 'collection-clip' }] },
        assetManifest: manifest, sourceInstanceId: 'peer-a',
      });
      expect(result.missingAssets).toEqual(manifest.slice(0, 3));
    });

    it('admits track render history, deck and storyboard images but drops other asset kinds', async () => {
      for (const [kind, record, own] of [
        ['track', { id: 'track-1', audioFilename: 'active.mp3', renders: [{ audioFilename: 'older.mp3' }] },
          [{ kind: 'music', filename: 'active.mp3' }, { kind: 'music', filename: 'older.mp3' }]],
        ['deck', { id: 'deck-1', cards: [{ primaryImageRef: 'card.png', imageRefs: ['render.png'] }], samples: [{ imageRef: 'style.png' }] },
          ['card.png', 'render.png', 'style.png'].map((filename) => ({ kind: 'image', filename }))],
        ['storyboard', { id: 'sb-1', beats: [{ panels: [{ takes: [{ image: 'panel.png' }, { sketchKey: 'sketch:abc' }] }] }] },
          [{ kind: 'image', filename: 'panel.png' }]],
      ]) {
        const result = await pushFromPairedPeer({ kind, record, sourceInstanceId: 'peer-a',
          assetManifest: [...own, { kind: 'audio', filename: 'unrelated.mp3' }] });
        expect(result.missingAssets).toEqual(own);
      }
    });

    it("does not re-pull a held origin-less image's sidecar because the sender's copy names its origin", async () => {
      const { createHash } = await import('crypto');
      const { sidecarGenParamsHash } = await import('../../lib/assetHash.js');
      await writeFile(join(PATHS.images, 'legacy.png'), 'legacy bytes');
      await writeFile(join(PATHS.images, 'legacy.metadata.json'), '{"prompt":"a fox"}');
      vi.mocked(mergeUniversesFromSync).mockResolvedValue({ applied: true, count: 1 });
      const entry = {
        filename: 'legacy.png', kind: 'image', sha256: createHash('sha256').update('legacy bytes').digest('hex'),
        sidecarSha256: sidecarGenParamsHash({ prompt: 'a fox', originInstanceId: 'peer-a' }),
      };
      const result = await pushFromPairedPeer({ kind: 'universe', record: { id: 'u1', imageRefs: ['legacy.png'] }, assetManifest: [entry], sourceInstanceId: 'peer-a' });
      expect(result.missingAssets).toEqual([]);
    });

    it('reports missing assets in the response', async () => {
      const result = await pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u1', imageRefs: ['absent.png'] },
        assetManifest: [{ filename: 'absent.png', kind: 'image', sha256: 'a'.repeat(64) }],
        sourceInstanceId: 'peer-a',
      });
      expect(result.missingAssets).toHaveLength(1);
    });

    it('never schedules a navigable peer asset from an incoming push', async () => {
      const result = await pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u1', imageRefs: ['peer.html', 'peer.svg', 'peer.png'], videoPath: 'clip.ogv' },
        assetManifest: [
          { filename: 'peer.html', kind: 'image', sha256: 'a'.repeat(64) },
          { filename: 'peer.svg', kind: 'image', sha256: 'b'.repeat(64) },
          { filename: 'peer.png', kind: 'image', sha256: 'c'.repeat(64) },
            { filename: 'clip.ogv', kind: 'video', sha256: 'e'.repeat(64) },
        ],
        sourceInstanceId: 'peer-a',
      });
      expect(result.missingAssets).toEqual([
        { filename: 'peer.png', kind: 'image', sha256: 'c'.repeat(64) },
        { filename: 'clip.ogv', kind: 'video', sha256: 'e'.repeat(64) },
      ]);
      expect(await readFile(join(PATHS.images, 'peer.html')).catch(() => null)).toBeNull();
      expect(await readFile(join(PATHS.images, 'peer.svg')).catch(() => null)).toBeNull();
    });

    it('returns ackedDeletesUpTo for the sender (does NOT advance the local cursor on receive)', async () => {
      // Cursors track "what peer X has acked of OUR local deletions" so
      // tombstoneGc can prune our local tombstones once every subscribed
      // peer has confirmed receipt. Advancing the cursor for sourceInstanceId
      // on receive would mis-credit the sender's tombstones as our own pushed-
      // and-acked ones, letting GC prune local tombstones the sender never
      // saw — and resurrecting them on the sender's next push.
      const result = await pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u1', deleted: true, deletedAt: '2026-01-01T00:00:00Z' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(result.ackedDeletesUpTo).toBe(Date.parse('2026-01-01T00:00:00Z'));
      const cursors = await listCursors();
      expect(cursors['peer-a']).toBeUndefined();
    });

    it('returns the MAX deletedAt across record + bundled issues so the sender can ack all in one round-trip', async () => {
      // Regression: if only `record.deletedAt` is returned, a series push
      // bundling multiple tombstoned issues would only ack the series'
      // own deletion time — newer issue tombstones in the same push would
      // never be acknowledged until a separate push lands.
      const result = await pushFromPairedPeer({
        kind: 'series',
        record: { id: 'ser-1', deleted: true, deletedAt: '2026-01-01T00:00:00Z' },
        issues: [
          { id: 'i1', deleted: true, deletedAt: '2026-03-01T00:00:00Z' },
          { id: 'i2', deleted: false },
        ],
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(result.ackedDeletesUpTo).toBe(Date.parse('2026-03-01T00:00:00Z'));
    });

    it('folds a bundled linkedTrack tombstone into ackedDeletesUpTo (#1922)', async () => {
      // Regression: a musicVideoProjects-only peer has no independent `track`
      // subscription, so the bundled linkedTrack tombstone (#1858) was the
      // ONLY way it could ever ack a track delete. Before this fix,
      // computeAckedDeletesFromPayload ignored `linkedTrack` entirely, so the
      // sender's track-tombstone GC cohort never waited on this peer at all.
      const result = await pushFromPairedPeer({
        kind: 'musicVideoProject',
        record: { id: 'mv-12', trackId: 'track-12', deleted: false, deletedAt: null },
        portosMeta: CURRENT_PORTOS_META,
        linkedTrack: { id: 'track-12', deleted: true, deletedAt: '2026-04-01T00:00:00Z' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(result.ackedDeletesUpTo).toBe(Date.parse('2026-04-01T00:00:00Z'));
    });

    it('does NOT fold a LIVE bundled linkedTrack into ackedDeletesUpTo (only tombstones count)', async () => {
      const result = await pushFromPairedPeer({
        kind: 'musicVideoProject',
        record: { id: 'mv-13', trackId: 'track-13', deleted: false, deletedAt: null },
        portosMeta: CURRENT_PORTOS_META,
        linkedTrack: { id: 'track-13', deleted: false, deletedAt: null },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(result.ackedDeletesUpTo).toBe(0);
    });

    it('does NOT fold a mismatched-id linkedTrack tombstone into ackedDeletesUpTo (merge gate refused it, never applied)', async () => {
      // Regression (codex review round 3 on #1922): the merge gate refuses a
      // linkedTrack whose id doesn't match the project's trackId (anti-
      // smuggling guard), so mergeTracksFromSync never runs. Folding its
      // deletedAt into ackedDeletesUpTo anyway would tell the sender "applied"
      // for a tombstone this receiver never actually merged.
      const result = await pushFromPairedPeer({
        kind: 'musicVideoProject',
        record: { id: 'mv-14', trackId: 'track-A', deleted: false, deletedAt: null },
        portosMeta: CURRENT_PORTOS_META,
        linkedTrack: { id: 'track-SMUGGLED', deleted: true, deletedAt: '2026-04-02T00:00:00Z' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeTracksFromSync).not.toHaveBeenCalled();
      expect(result.ackedDeletesUpTo).toBe(0);
    });

    it('does NOT fold a bundled linkedTrack tombstone into ackedDeletesUpTo when its merge fails (trackSyncPending)', async () => {
      // Regression (codex review round 3 on #1922): a thrown merge means the
      // receiver did NOT actually apply the tombstone — acking it anyway would
      // let the sender's cursor advance past a deletion that still needs a
      // retry (the exact failure mode #1922 closes for the success path).
      vi.mocked(mergeTracksFromSync).mockRejectedValueOnce(new Error('disk full'));
      const result = await pushFromPairedPeer({
        kind: 'musicVideoProject',
        record: { id: 'mv-15', trackId: 'track-15', deleted: false, deletedAt: null },
        portosMeta: CURRENT_PORTOS_META,
        linkedTrack: { id: 'track-15', deleted: true, deletedAt: '2026-04-03T00:00:00Z' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(result.trackSyncPending).toBe(true);
      expect(result.ackedDeletesUpTo).toBe(0);
    });

    it('folds a bundled linkedTrack tombstone into ackedDeletesUpTo even when the local record LOOKS ephemeral-shaped (#6843: musicVideoProject has no ephemeral concept)', async () => {
      // Historical: applyIncomingPush used to probe getMusicVideoProject for a
      // local `ephemeral` flag (added by #1858) and skip the bundled track
      // merge when set. The store never actually sets that flag on this kind
      // (musicVideo/projectsLogic.js: "no ephemeral flag") — the check always
      // evaluated false in production, and classifyLocalRecord already
      // documented the kind as having no ephemeral concept. #6843 collapsed
      // the dead check via the record-kind table's `hasEphemeral: false` and
      // this asserts the fix: an `ephemeral: true`-shaped local record (which
      // could previously only be reached by a mock like this one, never by
      // real data) does NOT suppress the linkedTrack merge or its ack.
      vi.mocked(getMusicVideoProject).mockResolvedValueOnce({ id: 'mv-16', ephemeral: true });
      const result = await pushFromPairedPeer({
        kind: 'musicVideoProject',
        record: { id: 'mv-16', trackId: 'track-16', deleted: false, deletedAt: null },
        portosMeta: CURRENT_PORTOS_META,
        linkedTrack: { id: 'track-16', deleted: true, deletedAt: '2026-04-04T00:00:00Z' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeTracksFromSync).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'track-16' })],
        { source: { via: 'peer-push', peerId: 'peer-a' }, bundledByPeerId: 'peer-a' },
      );
      expect(result.ackedDeletesUpTo).toBe(Date.parse('2026-04-04T00:00:00Z'));
    });

    it('auto-creates a reverse subscription back to the sender', async () => {
      // The merge path actually landed the record locally, so the
      // classifyLocalRecord('universe', 'u1') call inside
      // maybeCreateReverseSubscription will find a syncable record on
      // disk. Mock the lookup explicitly — the tri-state gate refuses
      // 'missing' to avoid orphan reverse-subs (e.g. for records the
      // sanitizer dropped at the merge boundary).
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
      await pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u1' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      const sub = await findPeerSubscription('peer-a', 'universe', 'u1');
      expect(sub).not.toBeNull();
      expect(sub.adoptedFromReverse).toBe(true);
    });

    it('does NOT create a reverse subscription when the local record is missing (merge dropped it)', async () => {
      // Regression: classifyLocalRecord must hard-stop on 'missing'.
      // Previously the gate only checked `ephemeral === true`, so a
      // record the sanitizer dropped during merge (missing name, schema
      // mismatch, etc.) would still get an orphan reverse-sub that fires
      // pushes against a nonexistent local record forever.
      vi.mocked(getUniverse).mockResolvedValue(undefined);
      await pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u-dropped' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      const sub = await findPeerSubscription('peer-a', 'universe', 'u-dropped');
      expect(sub).toBeNull();
    });

    it('does NOT create a reverse subscription when the sender peer is configured as inbound-only', async () => {
      // peer-b-inbound-only has directions: ['inbound']. The user explicitly
      // told this instance not to push back to them — auto-creating a
      // reverse subscription would override that intent.
      const result = await pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u1' },
        assetManifest: [],
        sourceInstanceId: 'peer-b-inbound-only',
      });
      expect(result.reverseSubscriptionCreated).toBe(false);
      const sub = await findPeerSubscription('peer-b-inbound-only', 'universe', 'u1');
      expect(sub).toBeNull();
    });

    it('does NOT create a reverse subscription when the local record is ephemeral', async () => {
      // The user marked u1 local-only; the merge already refused the
      // inbound edit (see mergeUniversesFromSync local-ephemeral guard).
      // Creating a reverse sub here would accumulate an orphan row in
      // peer_subscriptions.json that burns asset-manifest sha-passes on
      // every future edit and never sends bytes.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', ephemeral: true });
      const result = await pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u1' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(result.reverseSubscriptionCreated).toBe(false);
      expect(await findPeerSubscription('peer-a', 'universe', 'u1')).toBeNull();
    });

    it('does NOT duplicate a reverse subscription on subsequent pushes', async () => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
      await pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u1' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      await pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u1', updatedAt: '2026-01-02T00:00:00Z' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      const all = await listPeerSubscriptions({ peerId: 'peer-a' });
      expect(all).toHaveLength(1);
    });

    it('emits peerSyncEvents "subscription-created" ONLY when a reverse sub is genuinely created', async () => {
      // The Instances UI listens on the relayed `peerSync:subscription:created`
      // socket event to re-fetch a peer's subs without a manual reload. It must
      // fire exactly once — on the first push that creates the reverse sub —
      // and NOT on every subsequent push to the same (already-subscribed) record.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
      const events = [];
      const handler = (payload) => events.push(payload);
      peerSyncEvents.on('subscription-created', handler);
      try {
        await pushFromPairedPeer({
          kind: 'universe',
          record: { id: 'u1' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
        });
        // Second push — sub already exists, so no new event.
        await pushFromPairedPeer({
          kind: 'universe',
          record: { id: 'u1', updatedAt: '2026-01-02T00:00:00Z' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
        });
      } finally {
        peerSyncEvents.off('subscription-created', handler);
      }
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        peerId: 'peer-a',
        recordKind: 'universe',
        recordId: 'u1',
      });
      expect(typeof events[0].subId).toBe('string');
    });

    it('does NOT emit "subscription-created" when the reverse-sub gate refuses (inbound-only peer)', async () => {
      // No reverse sub is created for an inbound-only peer, so the UI signal
      // must stay silent — emitting on every push would trigger needless
      // peerSubs refetches across all cards.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
      const events = [];
      const handler = (payload) => events.push(payload);
      peerSyncEvents.on('subscription-created', handler);
      try {
        await pushFromPairedPeer({
          kind: 'universe',
          record: { id: 'u1' },
          assetManifest: [],
          sourceInstanceId: 'peer-b-inbound-only',
        });
      } finally {
        peerSyncEvents.off('subscription-created', handler);
      }
      expect(events).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // CATALOG BUNDLE — universe push carries referenced catalog ingredients +
  // refs (catalog-bundled-universe-push). Assembly is gated on Postgres +
  // non-tombstone + non-empty; the receiver applies via catalogSync.
  // -------------------------------------------------------------------------
  describe('catalog bundle (universe push)', () => {
    const liveUniverse = { id: 'u1', name: 'Foo', updatedAt: '2026-01-01T00:00:00Z', deleted: false, deletedAt: null };

    it('bundles catalog ingredients + refs into a live universe push (Postgres)', async () => {
      vi.mocked(getBackendName).mockReturnValue('postgres');
      vi.mocked(getUniverse).mockResolvedValue(liveUniverse);
      vi.mocked(getCatalogBundleForRef).mockResolvedValue({
        ingredients: [{ id: 'cat-chr-1', type: 'character', name: 'Hero', updatedAt: '2026-01-02T00:00:00Z' }],
        refs: [{ ingredientId: 'cat-chr-1', refKind: 'universe', refId: 'u1', role: 'canon-character', createdAt: '2026-01-02T00:00:00Z' }],
      });

      const payload = await getRecordPayloadForPeer('universe', 'u1');

      expect(getCatalogBundleForRef).toHaveBeenCalledWith('universe', 'u1');
      expect(payload.catalogBundle).toBeDefined();
      expect(payload.catalogBundle.ingredients).toHaveLength(1);
      expect(payload.catalogBundle.ingredients[0].id).toBe('cat-chr-1');
      expect(payload.catalogBundle.refs[0].refId).toBe('u1');
    });

    it('omits the bundle on a non-Postgres install (nothing to bundle)', async () => {
      vi.mocked(getBackendName).mockReturnValue('file');
      vi.mocked(getUniverse).mockResolvedValue(liveUniverse);

      const payload = await getRecordPayloadForPeer('universe', 'u1');

      expect(getCatalogBundleForRef).not.toHaveBeenCalled();
      expect(payload.catalogBundle).toBeUndefined();
    });

    it('omits the bundle on a tombstone (deleted) universe push', async () => {
      vi.mocked(getBackendName).mockReturnValue('postgres');
      vi.mocked(getUniverse).mockResolvedValue({ ...liveUniverse, deleted: true, deletedAt: '2026-03-01T00:00:00Z' });

      const payload = await getRecordPayloadForPeer('universe', 'u1');

      expect(getCatalogBundleForRef).not.toHaveBeenCalled();
      expect(payload.catalogBundle).toBeUndefined();
    });

    it('omits the bundle key when the universe has no catalog rows', async () => {
      vi.mocked(getBackendName).mockReturnValue('postgres');
      vi.mocked(getUniverse).mockResolvedValue(liveUniverse);
      vi.mocked(getCatalogBundleForRef).mockResolvedValue({ ingredients: [], refs: [] });

      const payload = await getRecordPayloadForPeer('universe', 'u1');

      expect(payload.catalogBundle).toBeUndefined();
    });

    it('does NOT bundle catalog rows on a series push (only universe)', async () => {
      vi.mocked(getBackendName).mockReturnValue('postgres');
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Ser', updatedAt: '2026-01-01T00:00:00Z', deleted: false, deletedAt: null });
      vi.mocked(listIssues).mockResolvedValue([]);

      const payload = await getRecordPayloadForPeer('series', 'ser-1');

      expect(getCatalogBundleForRef).not.toHaveBeenCalled();
      expect(payload.catalogBundle).toBeUndefined();
    });

    it('receiver applies a bundled catalog payload via catalogSync', async () => {
      vi.mocked(getBackendName).mockReturnValue('postgres');
      const catalogBundle = {
        ingredients: [{ id: 'cat-chr-1', type: 'character', name: 'Hero', updatedAt: '2026-01-02T00:00:00Z' }],
        refs: [{ ingredientId: 'cat-chr-1', refKind: 'universe', refId: 'u1', role: 'canon-character', createdAt: '2026-01-02T00:00:00Z' }],
      };
      const portosMeta = { schemaVersions: { ...PORTOS_SCHEMA_VERSIONS } };

      await pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u1', name: 'Foo', deleted: false, deletedAt: null },
        assetManifest: [],
        catalogBundle,
        sourceInstanceId: 'peer-a',
        portosMeta,
      });

      expect(applyCatalogRemoteChanges).toHaveBeenCalledTimes(1);
      const arg = vi.mocked(applyCatalogRemoteChanges).mock.calls[0][0];
      expect(arg.ingredients).toEqual(catalogBundle.ingredients);
      expect(arg.refs).toEqual(catalogBundle.refs);
      // portosMeta forwarded so applyRemoteChanges can run its own gate.
      expect(arg.portosMeta).toEqual(portosMeta);
    });

    it('receiver skips the bundle on a tombstone universe push', async () => {
      vi.mocked(getBackendName).mockReturnValue('postgres');
      await pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u1', name: 'Foo', deleted: true, deletedAt: '2026-03-01T00:00:00Z' },
        assetManifest: [],
        catalogBundle: { ingredients: [{ id: 'cat-chr-1', type: 'character', name: 'Hero', updatedAt: '2026-01-02T00:00:00Z' }], refs: [] },
        sourceInstanceId: 'peer-a',
        portosMeta: { schemaVersions: { ...PORTOS_SCHEMA_VERSIONS } },
      });

      expect(applyCatalogRemoteChanges).not.toHaveBeenCalled();
    });

    it('receiver rejects a universe push whose bundle ingredient is schema-ahead on catalog', async () => {
      vi.mocked(getBackendName).mockReturnValue('postgres');
      await expect(pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u1', name: 'Foo', deleted: false, deletedAt: null },
        assetManifest: [],
        catalogBundle: { ingredients: [{ id: 'cat-chr-1', type: 'character', name: 'Hero', updatedAt: '2026-01-02T00:00:00Z' }], refs: [] },
        sourceInstanceId: 'peer-a',
        portosMeta: { schemaVersions: { ...PORTOS_SCHEMA_VERSIONS, catalog: PORTOS_SCHEMA_VERSIONS.catalog + 1 }, portosVersion: '99.0.0' },
      })).rejects.toThrow(/schema is ahead/);
      // Gated before merge — bundle apply never runs.
      expect(applyCatalogRemoteChanges).not.toHaveBeenCalled();
    });

    it.each([PORTOS_SCHEMA_VERSIONS.catalog - 1, undefined])(
      'rejects catalog version %s before merging the owning universe or its bundle', async (catalog) => {
        vi.mocked(getBackendName).mockReturnValue('postgres');
        vi.mocked(mergeUniversesFromSync).mockClear();
        const schemaVersions = { ...PORTOS_SCHEMA_VERSIONS, catalog };
        await expect(pushFromPairedPeer({
          kind: 'universe', record: liveUniverse, assetManifest: [], sourceInstanceId: 'peer-a',
          catalogBundle: { ingredients: [{ id: 'example-object', type: 'object', payload: { name: 'Edited on peer' } }] },
          portosMeta: { schemaVersions },
        })).rejects.toMatchObject({
          code: 'PEER_SYNC_SCHEMA_VERSION_AHEAD',
          details: { ahead: [], behind: [{ category: 'catalog', senderV: catalog ?? 0, receiverV: PORTOS_SCHEMA_VERSIONS.catalog }] },
        });
        expect(mergeUniversesFromSync).not.toHaveBeenCalled();
        expect(applyCatalogRemoteChanges).not.toHaveBeenCalled();
      },
    );

    // #3926: the gate used to key on `ingredients` alone, so any bundle whose
    // live rows sat in another block (`refs` today; `relations`/`tags`/`media`/
    // `catalogTypes` from catalog v4–v8) slipped past it and got applied on a
    // receiver that can't interpret the newer shape.
    it.each([
      ['relations', { ingredients: [], refs: [], relations: [{ fromIngredientId: 'cat-chr-1', toIngredientId: 'cat-chr-2', kind: 'ally-of', updatedAt: '2026-01-02T00:00:00Z' }] }],
      ['tags', { ingredients: [], refs: [], tags: [{ id: 'cat-tag-1', label: 'Protagonists', parentId: null, updatedAt: '2026-01-02T00:00:00Z' }] }],
      ['media', { ingredients: [], media: [{ ingredientId: 'cat-chr-1', mediaKey: 'img-1', mediaType: 'image', updatedAt: '2026-01-02T00:00:00Z' }] }],
      ['refs', { ingredients: [], refs: [{ ingredientId: 'cat-chr-1', refKind: 'universe', refId: 'u1', role: 'canon-character', createdAt: '2026-01-02T00:00:00Z' }] }],
      // A block this receiver's catalog version doesn't know about yet must
      // gate too — that is precisely the payload the gate protects against.
      ['an unknown future block', { ingredients: [], refs: [], someFutureBlock: [{ id: 'x1', updatedAt: '2026-01-02T00:00:00Z' }] }],
    ])('receiver rejects a bundle whose only live rows are %s when the sender is schema-ahead on catalog', async (_label, catalogBundle) => {
      vi.mocked(getBackendName).mockReturnValue('postgres');
      const rejection = await pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u1', name: 'Foo', deleted: false, deletedAt: null },
        assetManifest: [],
        catalogBundle,
        sourceInstanceId: 'peer-a',
        portosMeta: { schemaVersions: { ...PORTOS_SCHEMA_VERSIONS, catalog: PORTOS_SCHEMA_VERSIONS.catalog + 1 }, portosVersion: '99.0.0' },
      }).catch((err) => err);
      expect(rejection.code).toBe('PEER_SYNC_SCHEMA_VERSION_AHEAD');
      expect(rejection.details.ahead).toEqual([
        { category: 'catalog', senderV: PORTOS_SCHEMA_VERSIONS.catalog + 1, receiverV: PORTOS_SCHEMA_VERSIONS.catalog },
      ]);
      expect(applyCatalogRemoteChanges).not.toHaveBeenCalled();
    });

    it('receiver applies an ingredient-free bundle when the sender is NOT schema-ahead', async () => {
      // The widened gate must not turn into a blanket rejection: an
      // equal-version sender's relations-only bundle still applies.
      vi.mocked(getBackendName).mockReturnValue('postgres');
      await pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u1', name: 'Foo', deleted: false, deletedAt: null },
        assetManifest: [],
        catalogBundle: {
          ingredients: [],
          refs: [{ ingredientId: 'cat-chr-1', refKind: 'universe', refId: 'u1', role: 'canon-character', createdAt: '2026-01-02T00:00:00Z' }],
          relations: [{ fromIngredientId: 'cat-chr-1', toIngredientId: 'cat-chr-2', kind: 'ally-of', updatedAt: '2026-01-02T00:00:00Z' }],
        },
        sourceInstanceId: 'peer-a',
        portosMeta: { schemaVersions: { ...PORTOS_SCHEMA_VERSIONS } },
      });
      expect(applyCatalogRemoteChanges).toHaveBeenCalledTimes(1);
    });

    it.each([PORTOS_SCHEMA_VERSIONS.catalog + 1, PORTOS_SCHEMA_VERSIONS.catalog - 1, undefined])('receiver does NOT gate a tombstone-only bundle at catalog version %s', async (catalog) => {
      // Tombstone rows are id+deleted+deletedAt+updatedAt at every catalog
      // version, so they stay exempt — otherwise federated catalog deletes
      // would stall the moment one peer upgrades ahead.
      vi.mocked(getBackendName).mockReturnValue('postgres');
      await pushFromPairedPeer({
        kind: 'universe',
        record: { id: 'u1', name: 'Foo', deleted: false, deletedAt: null },
        assetManifest: [],
        catalogBundle: {
          ingredients: [{ id: 'cat-chr-1', deleted: true, deletedAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' }],
          refs: [{ ingredientId: 'cat-chr-1', refKind: 'universe', refId: 'u1', role: 'canon-character', deleted: true, deletedAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' }],
          relations: [{ id: 'cat-rel-1', deleted: true, deletedAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' }],
        },
        sourceInstanceId: 'peer-a',
        portosMeta: { schemaVersions: { ...PORTOS_SCHEMA_VERSIONS, catalog }, portosVersion: '99.0.0' },
      });
      expect(applyCatalogRemoteChanges).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // mediaCollection push + receiver
  // -------------------------------------------------------------------------
  describe('collectCollectionAssetReferences', () => {
    it('maps items to image/video refs with an empty directImageRefFilenames', () => {
      const refs = collectCollectionAssetReferences({ items: [
        { kind: 'image', ref: 'a.png' },
        { kind: 'video', ref: 'vid123' },
        { kind: 'image', ref: 'b.png' },
      ] });
      expect(refs.directImageFilenames).toEqual(['a.png', 'b.png']);
      expect(refs.directVideoFilenames).toEqual(['vid123']);
      expect(refs.directImageRefFilenames).toEqual([]);
    });

    it('returns empty arrays for a collection with no items', () => {
      const refs = collectCollectionAssetReferences({ items: [] });
      expect(refs.directImageFilenames).toEqual([]);
      expect(refs.directVideoFilenames).toEqual([]);
      expect(refs.directImageRefFilenames).toEqual([]);
    });

    it('returns empty arrays for null/undefined input', () => {
      expect(collectCollectionAssetReferences(null).directImageFilenames).toEqual([]);
      expect(collectCollectionAssetReferences(undefined).directImageFilenames).toEqual([]);
    });
  });

  describe('applyIncomingPush — mood-board media hosting', () => {
    const record = {
      id: 'mb-hosted', name: 'Hosted board', posterImageRef: 'board-poster.png', collageImageRef: 'board-collage.png',
      items: [{ type: 'image', imageUrl: '/data/images/board-pin.png' }, { type: 'video', mediaKey: 'video:board-clip.mp4' }],
      updatedAt: '2026-05-23T00:00:00.000Z',
    };
    const assets = ['board-poster.png', 'board-collage.png', 'board-pin.png', 'board-clip.mp4'].map(filename => ({
      kind: filename.endsWith('.mp4') ? 'video' : 'image', filename, sha256: 'a'.repeat(64),
    }));

    it('keeps absent poster, collage and pinned media on a host-mode peer without admitting unrelated files', async () => {
      vi.mocked(getPeers).mockResolvedValue([pairedPeer({ id: 'p-host', instanceId: 'peer-host', name: 'Host', mediaSyncMode: 'host' })]);
      const result = await pushFromPairedPeer({ kind: 'moodBoard', record, sourceInstanceId: 'peer-host',
        assetManifest: [...assets, { kind: 'image', filename: 'unrelated.png', sha256: 'b'.repeat(64) }],
      });
      expect(result.missingAssets).toEqual([]);
      const { resolveMediaLocations, listHostedEntries } = await import('../peerHostedMedia.js');
      const locations = await resolveMediaLocations(assets.map(({ kind, filename }) => ({ kind, ref: filename })));
      expect(locations).toHaveLength(4);
      for (const location of locations) expect(location).toMatchObject({ location: 'remote', hostPeerId: 'peer-host' });
      expect(await listHostedEntries()).not.toHaveProperty('image:unrelated.png');
      expect(peerFetch).not.toHaveBeenCalledWith(expect.stringContaining('/data/'), expect.anything(), expect.anything());
    });

    it('retains normal copying for a copy-mode peer', async () => {
      vi.mocked(getPeers).mockResolvedValue([pairedPeer({ id: 'p-copy', instanceId: 'peer-copy', name: 'Copy', mediaSyncMode: 'copy' })]);
      const result = await pushFromPairedPeer({ kind: 'moodBoard', record, sourceInstanceId: 'peer-copy', assetManifest: assets });
      expect(result.missingAssets).toEqual(assets);
    });
  });

  describe('applyIncomingPush — mediaCollection', () => {
    it.each(['copy', 'host'])('admits alternate video bytes in %s mode only for a history-bound collection ID', async (mediaSyncMode) => {
      PATHS.videos = join(tmp, 'videos');
      vi.mocked(getPeers).mockResolvedValue([pairedPeer({ host: 'peer.example.com', mediaSyncMode })]);
      const { resolveMediaLocations, listHostedEntries } = await import('../peerHostedMedia.js');
      const clip = { kind: 'video', filename: 'imported.webm', sha256: 'a'.repeat(64) };
      const record = { id: 'col-imported', name: 'Imported',
        items: [{ kind: 'video', ref: 'imported-id' }], updatedAt: '2026-05-23T00:00:00.000Z' };
      const envelope = { kind: 'mediaCollection', record, sourceInstanceId: 'peer-a', assetManifest: [
        clip, { ...clip, filename: 'unrelated.webm' },
      ] };

      expect((await pushFromPairedPeer(envelope)).missingAssets).toEqual([]);
      expect(peerFetch).not.toHaveBeenCalled();
      expect(await listHostedEntries()).toEqual({});

      await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify([
        { id: 'imported-id', filename: clip.filename }, { id: 'unrelated-id', filename: 'unrelated.webm' },
      ]));
      envelope.assetManifest.push({ ...clip, filename: 'imported-id.mp4' });
      const receipt = await pushFromPairedPeer(envelope);
      if (mediaSyncMode === 'host') {
        expect(receipt.missingAssets).toEqual([]);
        expect(peerFetch).not.toHaveBeenCalled();
        expect((await resolveMediaLocations(record.items))[0]).toMatchObject({ location: 'remote', hostPeerId: 'peer-a' });
        expect(Object.keys(await listHostedEntries())).toEqual(['video:imported.webm']);
      } else {
        expect(receipt.missingAssets).toEqual([clip]);
        await vi.waitFor(() => expect(peerFetch).toHaveBeenCalledTimes(1));
        expect(peerFetch).toHaveBeenCalledWith(expect.stringMatching(/\/data\/videos\/imported\.webm$/), expect.anything(), expect.anything());
      }
    });

    it('applies an incoming mediaCollection push into local collections', async () => {
      vi.mocked(getPeers).mockResolvedValue([pairedPeer({ instanceId: 'peer-abc' })]);
      // Use the real mergeMediaCollectionsFromSync via importActual so the
      // write lands in the tmpdir and listCollections can confirm persistence.
      const real = await vi.importActual('../mediaCollections.js');
      vi.mocked(mergeMediaCollectionsFromSync).mockImplementationOnce(real.mergeMediaCollectionsFromSync);
      vi.mocked(listCollections).mockImplementationOnce(real.listCollections);

      await pushFromPairedPeer({
        kind: 'mediaCollection',
        record: { id: 'col-x', name: 'Synced', items: [], updatedAt: '2026-05-23T00:00:00.000Z' },
        assetManifest: [],
        sourceInstanceId: 'peer-abc',
      });

      // Goes through the record-kind table (#6843), which passes
      // senderSchemaVersions uniformly (harmless for mediaCollection — ignored).
      expect(mergeMediaCollectionsFromSync).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'col-x', name: 'Synced' })],
        expect.objectContaining({ source: { via: 'peer-push', peerId: 'peer-abc' } }),
      );

      // Confirm the record landed on disk via the real listCollections.
      const all = await real.listCollections();
      const found = all.find((c) => c.id === 'col-x');
      expect(found).toBeDefined();
      expect(found.name).toBe('Synced');
    });

    it('host-mode peer: indexes collection bytes as peer-hosted instead of pulling them', async () => {
      vi.mocked(getPeers).mockResolvedValue([pairedPeer({ id: 'p-host', instanceId: 'peer-host', name: 'Host', mediaSyncMode: 'host' })]);
      const record = { id: 'col-h', name: 'Hosted', items: [{ kind: 'image', ref: 'hosted-only.png' }], updatedAt: '2026-05-23T00:00:00.000Z' };
      const result = await pushFromPairedPeer({
        kind: 'mediaCollection',
        record,
        assetManifest: [{ kind: 'image', filename: 'hosted-only.png', sha256: 'a'.repeat(64) }],
        sourceInstanceId: 'peer-host',
      });
      // Nothing left to copy → the sender is not told bytes are "still syncing".
      expect(result.missingAssets).toEqual([]);
      expect(peerFetch).not.toHaveBeenCalledWith(expect.stringContaining('/data/images/hosted-only.png'), expect.anything(), expect.anything());
      const { resolveMediaLocations } = await import('../peerHostedMedia.js');
      expect((await resolveMediaLocations([{ kind: 'image', ref: 'hosted-only.png' }]))[0])
        .toMatchObject({ location: 'remote', hostPeerId: 'peer-host' });
    });

    it('copy-mode peer (default): the same push still reports the asset as missing to copy', async () => {
      vi.mocked(getPeers).mockResolvedValue([pairedPeer({ id: 'p-copy', instanceId: 'peer-copy', name: 'Copy' })]);
      const result = await pushFromPairedPeer({
        kind: 'mediaCollection',
        record: { id: 'col-c', name: 'Copied', items: [{ kind: 'image', ref: 'copied.png' }], updatedAt: '2026-05-23T00:00:00.000Z' },
        assetManifest: [{ kind: 'image', filename: 'copied.png', sha256: 'b'.repeat(64) }],
        sourceInstanceId: 'peer-copy',
      });
      expect(result.missingAssets).toHaveLength(1);
    });

    it('routes a mediaCollection push through mergeMediaCollectionsFromSync (mock assertion)', async () => {
      vi.mocked(getPeers).mockResolvedValue([pairedPeer({ instanceId: 'peer-abc' })]);
      await pushFromPairedPeer({
        kind: 'mediaCollection',
        record: { id: 'col-y', name: 'Test', items: [], updatedAt: '2026-05-23T00:00:00.000Z' },
        assetManifest: [],
        sourceInstanceId: 'peer-abc',
      });
      expect(mergeMediaCollectionsFromSync).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'col-y' })],
        expect.objectContaining({ source: { via: 'peer-push', peerId: 'peer-abc' } }),
      );
    });

    it('auto-creates a reverse subscription back to the sender for a syncable local collection', async () => {
      // Regression (Bug 1): classifyLocalRecord had no mediaCollection branch,
      // so it returned 'missing' and maybeCreateReverseSubscription's
      // `localState !== 'syncable'` guard never bootstrapped bidirectional
      // collection sync. The merge landed the record locally, so the
      // classifyLocalRecord lookup must resolve it as 'syncable'.
      vi.mocked(getCollection).mockResolvedValue({
        id: 'col-rev', name: 'Synced', items: [], updatedAt: '2026-05-23T00:00:00.000Z',
        deleted: false, deletedAt: null,
      });
      const result = await pushFromPairedPeer({
        kind: 'mediaCollection',
        record: { id: 'col-rev', name: 'Synced', items: [] },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(result.reverseSubscriptionCreated).toBe(true);
      const sub = await findPeerSubscription('peer-a', 'mediaCollection', 'col-rev');
      expect(sub).not.toBeNull();
      expect(sub.adoptedFromReverse).toBe(true);
    });

    it('does NOT create a reverse subscription when the local collection is missing (merge dropped it)', async () => {
      // The default getCollection mock rejects (NOT_FOUND) → classifyLocalRecord
      // returns 'missing' → no orphan reverse-sub.
      const result = await pushFromPairedPeer({
        kind: 'mediaCollection',
        record: { id: 'col-gone', name: 'Gone', items: [] },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(result.reverseSubscriptionCreated).toBe(false);
      const sub = await findPeerSubscription('peer-a', 'mediaCollection', 'col-gone');
      expect(sub).toBeNull();
    });
  });

  describe('peerSyncPushSchema — mediaCollection validation', () => {
    it('accepts a valid mediaCollection push payload', async () => {
      const { peerSyncPushSchema } = await import('../../lib/peerSyncValidation.js');
      expect(() => peerSyncPushSchema.parse({
        kind: 'mediaCollection',
        record: { id: 'col-x', name: 'My Collection', items: [] },
        assetManifest: [],
        sourceInstanceId: 'peer-abc',
      })).not.toThrow();
    });

    it('rejects a mediaCollection push payload missing sourceInstanceId', async () => {
      const { peerSyncPushSchema } = await import('../../lib/peerSyncValidation.js');
      expect(() => peerSyncPushSchema.parse({
        kind: 'mediaCollection',
        record: { id: 'col-x' },
        assetManifest: [],
      })).toThrow();
    });

    it('accepts music push payloads and music asset manifests', async () => {
      const { peerSyncPushSchema } = await import('../../lib/peerSyncValidation.js');
      for (const kind of ['artist', 'album', 'track']) {
        expect(() => peerSyncPushSchema.parse({
          kind,
          record: { id: `${kind}-1` },
          assetManifest: [{ filename: 'song.mp3', kind: 'music', sha256: 'a'.repeat(64) }],
          sourceInstanceId: 'peer-abc',
        })).not.toThrow();
      }
    });
  });
});

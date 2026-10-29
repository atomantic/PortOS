/**
 * A copy this machine released to a Make-primary host (services/mediaHolders.js)
 * streams from that host on purpose, so the asset sweep must not copy it back.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { createTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let tempRoot;
vi.mock('../../lib/fileUtils.js', async importOriginal => makePathsProxy(await importOriginal(), { dataRoot: () => tempRoot }));
vi.mock('../../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), { dataRoot: () => tempRoot }));

tempRoot = createTempDataRoot('portos-asset-released-');
const { diffAssetManifestAgainstLocal } = await import('./peerSyncAssets.js');
const { hostFileOn, markHosted } = await import('../peerHostedMedia.js');

afterAll(() => { rmSync(tempRoot, { recursive: true, force: true }); });

describe('asset diff and released copies', () => {
  it('skips a file released to its primary, but still pulls one that is merely hosted or absent', async () => {
    await hostFileOn('video', 'released.mp4', 'peer-primary');
    await markHosted('peer-host', [{ kind: 'video', filename: 'hosted.mp4' }]);
    const manifest = ['released.mp4', 'hosted.mp4', 'absent.mp4'].map((filename) => ({ kind: 'video', filename }));

    const missing = await diffAssetManifestAgainstLocal(manifest);

    expect(missing.map((entry) => entry.filename)).toEqual(['hosted.mp4', 'absent.mp4']);
  });
});
